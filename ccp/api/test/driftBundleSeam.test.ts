import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { DriftPointerItem, DriftProposalItem, DriftReportItem, RequestItem } from '../src/store/schema';
import { canonicalJson } from '../src/domain/audit';
import { driftPointerKey, driftProposalKey, driftVersionKey, requestKey } from '../src/store/schema';
import { __resetUploadRateLimitForTests } from '../src/middleware/rateLimit';
import { __resetKnownProjectsForTests } from '../src/projects';
import { __setNow } from '../src/clock';
import { DriftEnvelope, envelopeDigestOf, rerunDriftRedaction, summarizeReport, writeDriftReport } from '../src/domain/drift';
import { writeDriftProposalBody } from '../src/domain/driftProposals';
import type { DriftProposalDoc } from '../src/domain/driftProposals';
import { bundleRequestPayload } from '../src/routes/requests';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * F1(d) — the cross-layer seam proof (plan §2-F1, "the F1 failure mode
 * cannot recur"): two enforced layers.
 *
 * LAYER 1 (this file's first describe block): `bundleRequestPayload(...)`
 * over a request reconstructed from the SHARED seam fixtures
 * (`tools/catalogctl/testdata/driftpropose/seam/*.json`, deterministic
 * content pinned by Lane A) equals the fixture byte-for-byte (canonical-JSON
 * compare) — no Go toolchain needed, just the fixture files.
 *
 * LAYER 2 (the rest of this file): a REAL submit → REAL approve → REAL
 * apply, whose gate command builds and invokes the REAL catalogctl binary
 * running `drift-edit` + `plan-check` against a REAL git checkout (seeded
 * from `tools/catalogctl/testdata/driftpropose/checkout/`'s main.tf plus
 * the repo's OWN `scripts/drift/security-watchlist.json` — the fourth
 * screen's curated file) and a hand-authored canned no-op plan. Proves: an
 * adopt submitted from the portal passes the real gate; a BATCHED adopt set
 * gates EVERY item (the exact bug F1 found: pre-fix, `.bundle-request.json`
 * carried only `items[0]`'s params, so a batched change-set's later items
 * were never gated); a forged/tampered pinned verdict reds the gate even
 * though the api's own enforcement points already refuse it upstream (§8
 * enforcement point 3 — "even if 1-2 were somehow bypassed").
 *
 * Digests are obtained by REALLY running `catalogctl drift-propose` against
 * the fixture checkout — never hand-computed in TS — so this test never
 * needs to reproduce catalogctl's exact digest formula (ADR-0007 purity: the
 * same envelope + checkout tree always yields the same digest).
 *
 * LOUD SKIP, and ONLY for: no Go toolchain on PATH, or the build fails. CI
 * (ubuntu-latest) and gate.sh environments have a toolchain; the always-on
 * contract is the layer-1 fixtures.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)); // ccp/api/test -> repo root
const CATALOGCTL_DIR = join(REPO_ROOT, 'tools', 'catalogctl');
const CHECKOUT_MAIN_TF = join(CATALOGCTL_DIR, 'testdata', 'driftpropose', 'checkout', 'environments', 'prod', 'main.tf');
const WATCHLIST_JSON = join(REPO_ROOT, 'scripts', 'drift', 'security-watchlist.json');
const SEAM_FIXTURE_DIR = join(CATALOGCTL_DIR, 'testdata', 'driftpropose', 'seam');

/* ═══════════════════════════════════════════════════════════════════════
 * LAYER 1 — bundleRequestPayload canonical-JSON parity with the pinned seam
 * fixtures. No Go toolchain required — only the fixture FILES.
 * ═══════════════════════════════════════════════════════════════════════ */

type SeamFixtureRequest = {
  id: string;
  projectId: string;
  operationId: string;
  targetAddress: string;
  params: Record<string, unknown>;
  approvals: unknown[];
  status: string;
  items?: Array<{ operationId: string; service?: string; macd?: string; targetAddress: string; params: Record<string, unknown>; exposure?: string; reviewTier?: string }>;
};

/** Reconstruct a full RequestItem from a seam fixture's own fields (echo
 * pattern): the fields bundleRequestPayload reads (id/operationId/
 * targetAddress/params/approvals/status/items) come FROM the fixture; every
 * OTHER RequestItem-required field (requester, service, macd, ...) is
 * filled with an arbitrary valid placeholder — bundleRequestPayload never
 * reads them, so they cannot affect the comparison. This proves
 * bundleRequestPayload's FIELD SET/SHAPE matches what the fixture (and
 * therefore the Go-side ParseBundleRequest/BundleRequestItem) expects. */
function reconstructFromFixture(fx: SeamFixtureRequest): RequestItem {
  const now = '2026-07-20T03:17:04.000Z';
  return {
    ...requestKey(fx.projectId, fx.id),
    id: fx.id,
    requestUlid: fx.id,
    requester: 'seam-fixture-requester',
    projectId: fx.projectId,
    teamId: 'platform',
    service: 'drift',
    operationId: fx.operationId,
    macd: 'Change',
    targetAddress: fx.targetAddress,
    params: fx.params,
    justification: 'seam fixture placeholder — never read by bundleRequestPayload',
    exposure: 'l1_with_guardrails',
    reviewTier: 'guardrails',
    risk: 'LOW',
    status: fx.status,
    approvalsRequired: 2,
    approvals: fx.approvals as RequestItem['approvals'],
    schedule: { kind: 'now' },
    createdAt: now,
    updatedAt: now,
    events: [],
    policyVersion: 1,
    ...(fx.items ? { items: fx.items as RequestItem['items'] } : {}),
  };
}

const seamFixtureFiles = ['bundle-request-adopt.json', 'bundle-request-adopt-set.json', 'bundle-request-revert.json'];
const seamFixturesPresent = seamFixtureFiles.every((f) => {
  try {
    readFileSync(join(SEAM_FIXTURE_DIR, f));
    return true;
  } catch {
    return false;
  }
});

if (!seamFixturesPresent) {
  // eslint-disable-next-line no-console
  console.warn(`[driftBundleSeam layer 1] SKIPPING: ${SEAM_FIXTURE_DIR} does not exist yet (Lane A's A2) — the always-on layer-1 contract until then is eligibility-cases.json.`);
}

describe.skipIf(!seamFixturesPresent)('F1(d) layer 1 — bundleRequestPayload canonical-JSON parity with tools/catalogctl/testdata/driftpropose/seam/*.json', () => {
  for (const file of seamFixtureFiles) {
    it(`${file} — bundleRequestPayload(reconstructed) === the fixture, byte-for-byte`, () => {
      const fixture = JSON.parse(readFileSync(join(SEAM_FIXTURE_DIR, file), 'utf8')) as SeamFixtureRequest;
      const reconstructed = reconstructFromFixture(fixture);
      const result = bundleRequestPayload(reconstructed, fixture.projectId);
      expect(canonicalJson(result)).toBe(canonicalJson(fixture));
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * L29/L32 (register 0009, 2026-07-20-drift-restore-tranche.md §5) — the two
 * new gate paths' OWN seam fixtures: `bundle-request-restore.json` (R9) and
 * `bundle-request-legitimize.json` (R11). A SEPARATE presence-gated block
 * from the layer-1 one above (never folded into `seamFixtureFiles`) so the
 * three already-landed fixtures keep passing REGARDLESS of whether the Go
 * lane (R-A) has landed these two yet — this block turns on by itself, no
 * further api-lane change needed, the moment that commit is rebased in. The
 * plan's own words: "Go tests drive them; the api seam test consumes the
 * same fixtures after the Go lane lands" — this IS that consumption, the
 * exact `reconstructFromFixture`/`bundleRequestPayload` layer-1 proof above,
 * extended to the two new op ids. (`plan-restore-clean.json`/
 * `plan-legitimize-clean.json` are Go-only — driven by
 * `tools/catalogctl/driftedit_seam_test.go`, never read from TS.) ═══ */

const l29FixtureFiles = ['bundle-request-restore.json', 'bundle-request-legitimize.json'];
const l29FixturesPresent = l29FixtureFiles.every((f) => {
  try {
    readFileSync(join(SEAM_FIXTURE_DIR, f));
    return true;
  } catch {
    return false;
  }
});

if (!l29FixturesPresent) {
  // eslint-disable-next-line no-console
  console.warn(
    `[driftBundleSeam L29/L32] SKIPPING: ${SEAM_FIXTURE_DIR} does not yet carry bundle-request-restore.json/bundle-request-legitimize.json (2026-07-20-drift-restore-tranche.md's R-A lane) — the always-on contract until then is eligibility-cases.json plus the L29 direct unit tests in driftProposals.test.ts.`,
  );
}

describe.skipIf(!l29FixturesPresent)('L29/L32 — bundleRequestPayload canonical-JSON parity with the restore/legitimize seam fixtures', () => {
  for (const file of l29FixtureFiles) {
    it(`${file} — bundleRequestPayload(reconstructed) === the fixture, byte-for-byte`, () => {
      const fixture = JSON.parse(readFileSync(join(SEAM_FIXTURE_DIR, file), 'utf8')) as SeamFixtureRequest;
      const reconstructed = reconstructFromFixture(fixture);
      const result = bundleRequestPayload(reconstructed, fixture.projectId);
      expect(canonicalJson(result)).toBe(canonicalJson(fixture));
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * LAYER 2 — the real end-to-end proof
 * ═══════════════════════════════════════════════════════════════════════ */

let goAvailable = true;
let buildDir = '';
let catalogctlBin = '';

function hasGoToolchain(): boolean {
  const r = spawnSync('go', ['version'], { encoding: 'utf8' });
  return r.status === 0;
}

beforeAll(() => {
  goAvailable = hasGoToolchain();
  if (!goAvailable) {
    // eslint-disable-next-line no-console
    console.warn('[driftBundleSeam layer 2] SKIPPING: no Go toolchain on PATH. The layer-1 fixture contract above remains the always-on proof; CI (ubuntu-latest) and gate.sh have a toolchain.');
    return;
  }
  buildDir = mkdtempSync(join(tmpdir(), 'catalogctl-bin-'));
  catalogctlBin = join(buildDir, 'catalogctl');
  const build = spawnSync('go', ['build', '-o', catalogctlBin, './cmd/catalogctl'], { cwd: CATALOGCTL_DIR, encoding: 'utf8' });
  if (build.status !== 0) {
    // eslint-disable-next-line no-console
    console.warn(`[driftBundleSeam layer 2] SKIPPING: go build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`);
    goAvailable = false;
  }
}, 120_000);

afterAll(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A bare origin seeded with the checkout fixture's main.tf + the repo's
 * REAL security-watchlist.json (the fourth screen's curated file) — mirrors
 * bundle.test.ts's makeOrigin(), extended with drift-specific content. */
function makeSeamOrigin(): { bare: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'seam-origin-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' });
  mkdirSync(join(work, 'environments', 'prod'), { recursive: true });
  mkdirSync(join(work, 'scripts', 'drift'), { recursive: true });
  cpSync(CHECKOUT_MAIN_TF, join(work, 'environments', 'prod', 'main.tf'));
  cpSync(WATCHLIST_JSON, join(work, 'scripts', 'drift', 'security-watchlist.json'));
  g(work, 'add', '-A');
  g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed');
  g(work, 'push', 'origin', 'HEAD:refs/heads/main');
  return { bare, work };
}

type RealProposal = { digest: string; address: string; attrs: Array<{ address: string; path: string; liveJson: unknown; codeJson: unknown }>; diff: string };

/** Run the REAL `catalogctl drift-propose` against a scratch copy of the
 * checkout fixture, over `envelope` — returns the authentic digest/attrs/
 * diff catalogctl itself computed (never hand-computed in TS). */
function realGenerate(envelope: Record<string, unknown>): RealProposal[] {
  const scratch = mkdtempSync(join(tmpdir(), 'seam-gen-'));
  try {
    mkdirSync(join(scratch, 'repo', 'environments', 'prod'), { recursive: true });
    mkdirSync(join(scratch, 'repo', 'scripts', 'drift'), { recursive: true });
    cpSync(CHECKOUT_MAIN_TF, join(scratch, 'repo', 'environments', 'prod', 'main.tf'));
    // F4's fourth screen (A1, already landed): the generator loads
    // <repo>/scripts/drift/security-watchlist.json from the checkout being
    // scanned — missing/unparseable fails the WHOLE adopt bucket closed
    // (every proposal ungenerable), never just silently skips the screen.
    cpSync(WATCHLIST_JSON, join(scratch, 'repo', 'scripts', 'drift', 'security-watchlist.json'));
    const envPath = join(scratch, 'envelope.json');
    writeFileSync(envPath, JSON.stringify(envelope));
    const outPath = join(scratch, 'proposals.json');
    const r = spawnSync(catalogctlBin, ['drift-propose', '--envelope', envPath, '--repo', join(scratch, 'repo'), '--root', 'environments/prod', '--out', outPath], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`drift-propose failed (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
    const doc = JSON.parse(readFileSync(outPath, 'utf8')) as {
      proposals: Array<{ digest: string; addresses: string[]; attrs: RealProposal['attrs']; diff: string }> | null;
      ungenerable: Array<{ address: string; class: string; reason: string }> | null;
    };
    if (!doc.proposals || doc.proposals.length === 0) {
      throw new Error(`drift-propose produced zero proposals — ungenerable: ${JSON.stringify(doc.ungenerable)}`);
    }
    return doc.proposals.map((p) => ({ digest: p.digest, address: p.addresses[0]!, attrs: p.attrs, diff: p.diff }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** OOB provisioning-import spec §5.1's own proposal shape (6-field identity +
 * reviewed bytes — see `domain/driftProposals.ts#DriftImportProposalPayload`). */
type RealImportProposal = { digest: string; address: string; importPayload: { arn: string | null; tfType: string; liveId: string; targetFile: string; importBlock: string; skeletonHcl: string } };

/** Run the REAL `catalogctl drift-propose --enable-import` against a scratch
 * copy of the checkout fixture, over `envelope` (which must carry a `sweep`
 * section) — returns the authentic digest/importPayload catalogctl itself
 * computed for every `flavor:"import"` proposal (never hand-computed in TS),
 * the import twin of {@link realGenerate}. */
function realGenerateImport(envelope: Record<string, unknown>): RealImportProposal[] {
  const scratch = mkdtempSync(join(tmpdir(), 'seam-gen-import-'));
  try {
    mkdirSync(join(scratch, 'repo', 'environments', 'prod'), { recursive: true });
    mkdirSync(join(scratch, 'repo', 'scripts', 'drift'), { recursive: true });
    cpSync(CHECKOUT_MAIN_TF, join(scratch, 'repo', 'environments', 'prod', 'main.tf'));
    // §5.3 screen 1: the generator loads <repo>/scripts/drift/security-
    // watchlist.json's creation_security_types key from the checkout being
    // scanned — missing/unparseable/key-absent fails the WHOLE import bucket
    // closed, mirroring the adopt bucket's own fourth-screen doctrine above.
    cpSync(WATCHLIST_JSON, join(scratch, 'repo', 'scripts', 'drift', 'security-watchlist.json'));
    const envPath = join(scratch, 'envelope.json');
    writeFileSync(envPath, JSON.stringify(envelope));
    const outPath = join(scratch, 'proposals.json');
    const r = spawnSync(
      catalogctlBin,
      ['drift-propose', '--envelope', envPath, '--repo', join(scratch, 'repo'), '--root', 'environments/prod', '--out', outPath, '--enable-import'],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`drift-propose --enable-import failed (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
    const doc = JSON.parse(readFileSync(outPath, 'utf8')) as {
      proposals: Array<{ digest: string; flavor: string; addresses: string[]; importPayload?: RealImportProposal['importPayload'] }> | null;
      ungenerable: Array<{ address: string; class: string; reason: string }> | null;
    };
    const importProposals = (doc.proposals ?? []).filter((p) => p.flavor === 'import');
    if (importProposals.length === 0) {
      throw new Error(`drift-propose --enable-import produced zero import proposals — proposals: ${JSON.stringify(doc.proposals)}, ungenerable: ${JSON.stringify(doc.ungenerable)}`);
    }
    return importProposals.map((p) => ({ digest: p.digest, address: p.addresses[0]!, importPayload: p.importPayload! }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function benignEnvelope(rows: Array<{ address: string; type: string; path: string; live: string; code: string; liveJson: unknown; codeJson: unknown }>): Record<string, unknown> {
  return {
    schema: 'ccp.drift/v1',
    projectId: 'acme',
    environment: 'prod',
    capturedAt: '2026-07-20T03:17:04Z',
    runId: '16234567890',
    commit: 'abc123def4567890abc123def4567890abc123de',
    cadenceHours: 6,
    planExitCode: 2,
    report: {
      meta: {},
      counts: {},
      absorbed: [],
      invisible_to_plan: 'out-of-band CREATED resources are invisible to this alarm',
      verdicts: rows.map((r) => ({
        address: r.address,
        type: r.type,
        actions: ['update'],
        actionReason: null,
        driftEvidence: true,
        class: 'benign_inplace',
        riskTier: 'low',
        changedAttrs: [{ path: r.path, live: r.live, code: r.code, sensitive: false, liveJson: r.liveJson, codeJson: r.codeJson }],
        forceNewAttrs: [],
        securityHits: [],
        computedUnknown: [],
        notes: [],
      })),
    },
  };
}

/** A canned `terraform show -json`-shaped no-op plan — R7 (adopt-zero-delta)
 * requires zero changes ANYWHERE in resource_changes; omitting an address
 * entirely (as Terraform does for genuinely unchanged resources) is exactly
 * as valid as listing it with actions:["no-op"] (plancheck.go#changed). */
function cannedNoOpPlan(addresses: string[]): Record<string, unknown> {
  return {
    format_version: '1.2',
    resource_changes: addresses.map((address) => ({ address, change: { actions: ['no-op'], before: {}, after: {} } })),
  };
}

/** A canned `terraform show -json`-shaped plan showing EACH `{address, id}`
 * pair as satisfying an `import` block (R10 — import-exact, OOB spec §7.2):
 * `actions:["no-op"]` PLUS `change.importing:{id}` — the exact shape a real
 * `terraform plan` produces the run after `drift-edit` appends the pinned
 * import{}+resource{} blocks and the resource already exists live. */
function cannedImportPlan(items: Array<{ address: string; id: string }>): Record<string, unknown> {
  return {
    format_version: '1.2',
    resource_changes: items.map(({ address, id }) => ({ address, change: { actions: ['no-op'], before: {}, after: {}, importing: { id } } })),
  };
}

/** One import-eligible sweep finding + its envelope (OOB provisioning spec
 * §2.4/§3.1) — the import twin of {@link benignEnvelope}. The importPayload
 * is hand-authored HERE (mirroring what the kit's payloads.py would have
 * already attached upstream, §2.6) — catalogctl's `--enable-import` only
 * PARTITIONS + WRAPS an already-complete payload, never generates the HCL
 * itself (see `internal/driftpropose/importgen.go`). `address` must be
 * ABSENT from the checkout fixture's main.tf (import's own "address already
 * resolves" collision screen) — `oob_seamtest01` is not one of
 * sample01/sg1/db1. */
function importEnvelope(findings: Array<{ arn: string | null; tfType: string; liveId: string; address: string; importBlock: string; skeletonHcl: string; securityFamily?: boolean }>): Record<string, unknown> {
  return {
    schema: 'ccp.drift/v1',
    projectId: 'acme',
    environment: 'prod',
    capturedAt: '2026-07-20T03:17:04Z',
    runId: '16234567890',
    commit: COMMIT,
    cadenceHours: 6,
    planExitCode: 2,
    report: { meta: {}, counts: {}, absorbed: [], invisible_to_plan: 'out-of-band CREATED resources are invisible to this alarm', verdicts: [] },
    sweep: {
      method: 'importer-kit discover: seam test fixture',
      capturedAt: '2026-07-20T03:17:04Z',
      region: 'ap-southeast-5',
      findings: findings.map((f) => ({
        class: 'unmanaged_resource',
        arn: f.arn,
        tfType: f.tfType,
        liveId: f.liveId,
        name: f.address,
        service: 'ec2',
        stateful: false,
        region: 'ap-southeast-5',
        securityFamily: f.securityFamily ?? false,
        actor: null,
        importPayload: { address: f.address, targetFile: 'oob-adopted.tf', importBlock: f.importBlock, skeletonHcl: f.skeletonHcl },
        payloadWithheldReason: null,
      })),
      totalFindings: findings.length,
      ignoredCount: 0,
      coverage: {},
    },
  };
}

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function hdrs(cookie: string, opts: { json?: boolean; client?: boolean; project?: string } = {}): Record<string, string> {
  const h: Record<string, string> = { cookie };
  if (opts.client !== false) h['x-ccp-client'] = 'ccp-spa';
  if (opts.json) h['content-type'] = 'application/json';
  h['x-ccp-project'] = opts.project ?? 'sample';
  return h;
}

const COMMIT = 'abc123def4567890abc123def4567890abc123de';
const REGISTER = { id: 'acme', name: 'Acme estate', github: { owner: 'acme-co', repo: 'terraform-acme' }, accountId: '123456789012', region: 'ap-southeast-5' };
const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function reportText(): string {
  return `${JSON.stringify(
    { repo: 'terraform-acme', verdict: 'clean', findings: [], resourceBlocks: 12, moduleBlocks: 0, tfJsonFiles: 0, fmtDirtyFiles: 0, providerPins: { aws: '~> 6.0' } },
    null,
    2,
  )}\n`;
}

type App = ReturnType<typeof createApp>;
type Setup = { store: ConfigStore; app: App; dataRoot: string; putra: string; lina: string; root: string; nia: string; wati: string };
let roots: string[] = [];

async function setupReady(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store);
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  await seedAccount(store, { id: 'nia', role: 'requester', teamId: 'platform', isAdmin: false, projects: ['sample', 'acme'] });
  // wati: approver bound to BOTH sample (the header-less acting-scope default
  // the outer requireProjectMembership gate checks) and acme (this test's
  // project) — lina (the base seed()'s lead) is sample-ONLY, so she cannot
  // sign an L2 approval acting on acme; wati mirrors driftProposals.test.ts's
  // own working e2e pattern.
  await seedAccount(store, { id: 'wati', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'acme'] });
  const dataRoot = mkdtempSync(join(tmpdir(), 'ccp-seam-'));
  roots.push(dataRoot);
  const app = createApp(store, { projectDataRoot: dataRoot });
  const s: Setup = {
    store,
    app,
    dataRoot,
    putra: await sessionCookieFor(store, 'putra'),
    lina: await sessionCookieFor(store, 'lina'),
    root: await sessionCookieFor(store, 'root'),
    nia: await sessionCookieFor(store, 'nia'),
    wati: await sessionCookieFor(store, 'wati'),
  };

  // register -> trust -> data-activate (routable/ready), mirrors driftProposals.test.ts#driveToReady.
  expect((await app.request('/projects', { method: 'POST', headers: hdrs(s.putra, { json: true }), body: JSON.stringify(REGISTER) })).status).toBe(201);
  const prescanReport = reportText();
  expect(
    (
      await app.request('/projects/acme/trust-request', {
        method: 'PUT',
        headers: hdrs(s.lina, { json: true }),
        body: JSON.stringify({ trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256hex(prescanReport) }, prescanReport }),
      })
    ).status,
  ).toBe(200);
  const propose = await app.request('/projects/acme/trust', { method: 'POST', headers: hdrs(s.putra, { json: true }), body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256hex(prescanReport) }) });
  expect(propose.status).toBe(202);
  const pending = (await propose.json()) as { id: string };
  expect((await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) })).status).toBe(200);

  const tokenRes = await app.request('/projects/acme/upload-tokens', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
  expect(tokenRes.status).toBe(201);
  const { token } = (await tokenRes.json()) as { token: string };
  const inventory = { generatedAt: '2026-07-17T00:00:00.000Z', sourceCommit: COMMIT, source: 'scan', resources: [] };
  const blocks = { index: {}, chunks: {} };
  const manifests: unknown[] = [];
  const dataBundle = {
    digests: { inventorySha256: sha256hex(canonicalJson(inventory)), blocksSha256: sha256hex(canonicalJson(blocks)), manifestsSha256: sha256hex(canonicalJson(manifests)) },
    inventory,
    blocks,
    manifests,
    summary: { providerPins: { aws: '~> 6.0' } },
  };
  const up = await app.request('/projects/acme/data', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(dataBundle) });
  expect(up.status).toBe(201);
  const uploaded = (await up.json()) as { version: number };
  const actPropose = await app.request(`/projects/acme/data/${uploaded.version}/activate`, { method: 'POST', headers: hdrs(s.putra, { json: true }) });
  expect(actPropose.status).toBe(202);
  const actPending = (await actPropose.json()) as { id: string };
  expect((await app.request(`/admin/config-changes/${actPending.id}/ack`, { method: 'POST', headers: hdrs(s.root) })).status).toBe(200);

  return s;
}

/** Seed a drift REPORT (so the submit route's step-7 re-check finds matching
 * verdicts) + the matching PROPOSAL row/body (digest/attrs/diff from the
 * REAL drift-propose run) — bypasses the async generation seam (already
 * covered elsewhere) so this test controls exactly what reaches the gate. */
async function seedReportAndProposal(s: Setup, envelope: Record<string, unknown>, proposals: RealProposal[]): Promise<void> {
  const { driftPointerKey, driftVersionKey } = await import('../src/store/schema');
  const { rerunDriftRedaction, envelopeDigestOf, summarizeReport, writeDriftReport, DriftEnvelope } = await import('../src/domain/drift');
  const parsed = DriftEnvelope.parse(envelope);
  const { envelope: stored } = rerunDriftRedaction(parsed);
  const counts = summarizeReport(stored.report);
  const versionKey = driftVersionKey('acme', 1);
  const pointerKey = driftPointerKey('acme');
  await s.store.put({
    ...versionKey,
    projectId: 'acme',
    version: 1,
    uploadedAt: '2026-07-20T00:00:00.000Z',
    uploadedVia: 'upload-token:seam-test',
    envelopeDigest: envelopeDigestOf(stored),
    capturedAt: stored.capturedAt,
    runId: stored.runId,
    commit: stored.commit,
    cadenceHours: stored.cadenceHours,
    planExitCode: stored.planExitCode,
    counts,
  } as never);
  await s.store.put({ ...pointerKey, version: 1, capturedAt: stored.capturedAt, planExitCode: stored.planExitCode, driftedCount: counts.drifted, securityCount: counts.security } as never);
  await writeDriftReport(s.dataRoot, 'acme', 1, stored);

  for (const p of proposals) {
    const body: DriftProposalDoc = {
      digest: p.digest,
      flavor: 'adopt',
      addresses: [p.address],
      attrs: p.attrs,
      diff: p.diff,
      requestSkeleton: { items: [{ operationId: 'system-drift-adopt', targetAddress: p.address, params: { attrs: p.attrs, proposalDigest: p.digest, reportVersion: 1 } }] },
      verdicts: [],
    };
    await writeDriftProposalBody(s.dataRoot, 'acme', p.digest, body);
    const key = driftProposalKey('acme', p.digest);
    const row: DriftProposalItem = {
      ...key,
      projectId: 'acme',
      digest: p.digest,
      flavor: 'adopt',
      status: 'open',
      addresses: [p.address],
      attrCount: p.attrs.length,
      firstReportVersion: 1,
      lastSeenReportVersion: 1,
      baseCommit: 'deadbeefcafe',
      generatedAt: '2026-07-20T03:17:04Z',
    };
    await s.store.put(row as never);
  }
}

/** Seed a drift REPORT carrying a `sweep` section (so the submit route's
 * §5.3 screen 2 re-check finds the matching CURRENT finding) + the matching
 * IMPORT proposal row/body (digest/importPayload from the REAL
 * `drift-propose --enable-import` run) — the import twin of
 * {@link seedReportAndProposal}, same bypass-generation discipline. */
async function seedImportReportAndProposal(s: Setup, envelope: Record<string, unknown>, proposals: RealImportProposal[]): Promise<void> {
  const parsed = DriftEnvelope.parse(envelope);
  const { envelope: stored } = rerunDriftRedaction(parsed);
  const counts = summarizeReport(stored.report, stored.sweep);
  const versionKey = driftVersionKey('acme', 1);
  const pointerKey = driftPointerKey('acme');
  await s.store.put({
    ...versionKey,
    projectId: 'acme',
    version: 1,
    uploadedAt: '2026-07-20T00:00:00.000Z',
    uploadedVia: 'upload-token:seam-test',
    envelopeDigest: envelopeDigestOf(stored),
    capturedAt: stored.capturedAt,
    runId: stored.runId,
    commit: stored.commit,
    cadenceHours: stored.cadenceHours,
    planExitCode: stored.planExitCode,
    counts,
  } as never);
  await s.store.put({
    ...pointerKey,
    version: 1,
    capturedAt: stored.capturedAt,
    planExitCode: stored.planExitCode,
    driftedCount: counts.drifted,
    securityCount: counts.security,
    unmanagedCount: counts.unmanaged,
  } as never);
  await writeDriftReport(s.dataRoot, 'acme', 1, stored);

  for (const p of proposals) {
    const body: DriftProposalDoc = {
      digest: p.digest,
      flavor: 'import',
      addresses: [p.address],
      attrs: [],
      diff: null,
      importPayload: p.importPayload,
      requestSkeleton: { items: [{ operationId: 'system-drift-import', targetAddress: p.address, params: { importPayload: p.importPayload, proposalDigest: p.digest, reportVersion: 1 } }] },
      verdicts: [],
    };
    await writeDriftProposalBody(s.dataRoot, 'acme', p.digest, body);
    const key = driftProposalKey('acme', p.digest);
    const row: DriftProposalItem = {
      ...key,
      projectId: 'acme',
      digest: p.digest,
      flavor: 'import',
      status: 'open',
      addresses: [p.address],
      attrCount: 0,
      firstReportVersion: 1,
      lastSeenReportVersion: 1,
      baseCommit: 'deadbeefcafe',
      generatedAt: '2026-07-20T03:17:04Z',
      arn: p.importPayload.arn,
      tfType: p.importPayload.tfType,
    };
    await s.store.put(row as never);
  }
}

/** submit -> approve(L2) -> approve(L3) -> the request id. */
async function submitAndApprove(s: Setup, digest: string, alsoDigests?: string[]): Promise<string> {
  const submitRes = await s.app.request(`/projects/acme/drift/proposals/${digest}/submit`, {
    method: 'POST',
    headers: hdrs(s.nia, { json: true }),
    body: JSON.stringify({
      justification: 'adopting observed drift into code, seam e2e',
      // schedule.kind:'now' terminates a fully-approved 2-signature ladder directly at
      // APPLIED (no interim/cooling entry point remains — see routes/requests.ts ~L620,
      // proposal 0037). APPLIED is not in the apply route's BUNDLE_ELIGIBLE set, so the
      // seam's bundle-apply step needs the window path, which lands on
      // AWAITING_DEPLOY_APPROVAL instead.
      schedule: { kind: 'window', at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
      ...(alsoDigests ? { alsoDigests } : {}),
    }),
  });
  expect(submitRes.status).toBe(201);
  const req = (await submitRes.json()) as { id: string };
  const a1 = await s.app.request(`/requests/${req.id}/approve`, { method: 'POST', headers: hdrs(s.wati, { json: true, project: 'acme' }) });
  expect(a1.status).toBe(200);
  const a2 = await s.app.request(`/requests/${req.id}/approve`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
  expect(a2.status).toBe(200);
  return req.id;
}

/** Seed a THIRD acme-bound senior account (a lead) beyond `setupReady()`'s
 * own wati (approver) + root (lead) pair. Import's submitter role (§6:
 * approver/lead only, never a plain requester) means the submitter is
 * ALWAYS senior, so a full submit→approve(L2)→approve(L3) chain needs THREE
 * distinct senior people, not two — nia (the adopt tests' submitter) cannot
 * submit an import at all. */
async function seedExtraLead(s: Setup, id = 'agus'): Promise<string> {
  await seedAccount(s.store, { id, role: 'lead', teamId: 'platform', isAdmin: false, projects: ['acme'] });
  return sessionCookieFor(s.store, id);
}

/** submit (as wati, approver) -> approve L2 (a second distinct senior,
 * `l2Cookie`) -> approve L3 (root, lead) -> the request id — the import
 * twin of {@link submitAndApprove}. */
async function submitAndApproveImport(s: Setup, digest: string, l2Cookie: string, alsoDigests?: string[]): Promise<string> {
  const submitRes = await s.app.request(`/projects/acme/drift/proposals/${digest}/submit`, {
    method: 'POST',
    headers: hdrs(s.wati, { json: true }),
    body: JSON.stringify({
      justification: 'importing an out-of-band resource, seam e2e',
      // schedule.kind:'window', same reasoning as submitAndApprove above.
      schedule: { kind: 'window', at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
      ...(alsoDigests ? { alsoDigests } : {}),
    }),
  });
  expect(submitRes.status).toBe(201);
  const req = (await submitRes.json()) as { id: string };
  const a1 = await s.app.request(`/requests/${req.id}/approve`, { method: 'POST', headers: hdrs(l2Cookie, { json: true, project: 'acme' }) });
  expect(a1.status).toBe(200);
  const a2 = await s.app.request(`/requests/${req.id}/approve`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
  expect(a2.status).toBe(200);
  return req.id;
}

const ENV_KEYS = ['CCP_DRIFT', 'CCP_DRIFT_IMPORT', 'CCP_BUNDLE', 'CCP_GIT_REMOTE', 'CCP_GIT_BRANCH', 'CCP_BUNDLE_GATE_CMD', 'CCP_BUNDLE_TRIGGER_CMD'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCP_DRIFT = '1';
});
afterEach(() => {
  __setNow(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe.runIf(goAvailable)('F1(d) layer 2 — real submit -> real approve -> real apply, gate = real catalogctl drift-edit + plan-check', () => {
  it('SKIP GUARD (always runs): reports the toolchain/build state loudly', () => {
    if (!goAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[driftBundleSeam layer 2] no Go toolchain / build failed — every other test in this describe block is skipped by describe.runIf.');
    }
    expect(true).toBe(true);
  });

  it('GREEN: a single adopt submitted from the portal passes the REAL gate end-to-end', async () => {
    const s = await setupReady();
    const envelope = benignEnvelope([{ address: 'aws_instance.sample01', type: 'aws_instance', path: 'tags.Owner', live: '"bi-team"', code: '"platform"', liveJson: 'bi-team', codeJson: 'platform' }]);
    const [proposal] = realGenerate(envelope);
    await seedReportAndProposal(s, envelope, [proposal!]);
    const reqId = await submitAndApprove(s, proposal!.digest);

    const { bare } = makeSeamOrigin();
    const planPath = join(mkdtempSync(join(tmpdir(), 'seam-plan-')), 'plan.json');
    writeFileSync(planPath, JSON.stringify(cannedNoOpPlan(['aws_instance.sample01'])));
    Object.assign(process.env, {
      CCP_BUNDLE: '1',
      CCP_GIT_REMOTE: bare,
      CCP_BUNDLE_GATE_CMD: `"${catalogctlBin}" drift-edit --request "$BUNDLE_REQUEST" --repo "$BUNDLE_CHECKOUT" --root environments/prod && "${catalogctlBin}" plan-check --plan "${planPath}" --request "$BUNDLE_REQUEST"`,
      CCP_BUNDLE_TRIGGER_CMD: 'true',
    });

    const applyRes = await s.app.request(`/requests/${reqId}/apply`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
    const body = (await applyRes.json()) as { ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }>; code?: string; reason?: string };
    expect(body.ok, `status=${applyRes.status} body=${JSON.stringify(body)}`).toBe(true);
    expect(applyRes.status).toBe(200);
    // the edit really landed: the checkout's main.tf now reads Owner = "bi-team"
    expect(g(bare, 'show', 'main:environments/prod/main.tf')).toContain('Owner = "bi-team"');
  });

  it('GREEN, BATCHED: a two-item adopt SET gates EVERY item — the exact F1 bug this program fixed (pre-fix, only items[0] reached the gate)', async () => {
    const s = await setupReady();
    const envelope = benignEnvelope([
      { address: 'aws_instance.sample01', type: 'aws_instance', path: 'tags.Owner', live: '"bi-team"', code: '"platform"', liveJson: 'bi-team', codeJson: 'platform' },
      { address: 'aws_db_instance.db1', type: 'aws_db_instance', path: 'instance_class', live: '"db.m5.2xlarge"', code: '"db.m5.large"', liveJson: 'db.m5.2xlarge', codeJson: 'db.m5.large' },
    ]);
    const proposals = realGenerate(envelope);
    expect(proposals).toHaveLength(2);
    await seedReportAndProposal(s, envelope, proposals);
    const primary = proposals.find((p) => p.address === 'aws_instance.sample01')!;
    const secondary = proposals.find((p) => p.address === 'aws_db_instance.db1')!;
    const reqId = await submitAndApprove(s, primary.digest, [secondary.digest]);

    // Confirm this really is a batched change-set (>=2 items) before applying
    // — otherwise this test would prove nothing about the F1 batch bug.
    const rk = requestKey('acme', reqId);
    const stored = (await s.store.get(rk.PK, rk.SK)) as RequestItem;
    expect(stored.items).toHaveLength(2);

    const { bare } = makeSeamOrigin();
    const planPath = join(mkdtempSync(join(tmpdir(), 'seam-plan-')), 'plan.json');
    writeFileSync(planPath, JSON.stringify(cannedNoOpPlan(['aws_instance.sample01', 'aws_db_instance.db1'])));
    Object.assign(process.env, {
      CCP_BUNDLE: '1',
      CCP_GIT_REMOTE: bare,
      CCP_BUNDLE_GATE_CMD: `"${catalogctlBin}" drift-edit --request "$BUNDLE_REQUEST" --repo "$BUNDLE_CHECKOUT" --root environments/prod && "${catalogctlBin}" plan-check --plan "${planPath}" --request "$BUNDLE_REQUEST"`,
      CCP_BUNDLE_TRIGGER_CMD: 'true',
    });

    const applyRes = await s.app.request(`/requests/${reqId}/apply`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
    const body = (await applyRes.json()) as { ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }> };
    expect(body.ok, JSON.stringify(body.steps)).toBe(true);
    // BOTH edits really landed — proves the gate replayed BOTH items, not just items[0].
    const tf = g(bare, 'show', 'main:environments/prod/main.tf');
    expect(tf).toContain('Owner = "bi-team"');
    expect(tf).toContain('instance_class = "db.m5.2xlarge"');
  });

  it('RED: a forged/tampered pinned verdict (security hit injected after submit) reds the gate — §8 enforcement point 3', async () => {
    const s = await setupReady();
    const envelope = benignEnvelope([{ address: 'aws_instance.sample01', type: 'aws_instance', path: 'tags.Owner', live: '"bi-team"', code: '"platform"', liveJson: 'bi-team', codeJson: 'platform' }]);
    const [proposal] = realGenerate(envelope);
    await seedReportAndProposal(s, envelope, [proposal!]);
    const reqId = await submitAndApprove(s, proposal!.digest);

    // Simulate tampering BETWEEN approval and apply: directly corrupt the
    // stored request's pinned params.verdicts to claim a security hit —
    // exactly the "forged/relabeled" attack §8 names. The api's own
    // enforcement points (1: generator, 2: submit re-check) already ran
    // and passed for the HONEST data; this proves point 3 (the gate) is
    // independently effective even when 1-2 are bypassed by direct tampering.
    const rk = requestKey('acme', reqId);
    const stored = (await s.store.get(rk.PK, rk.SK)) as RequestItem;
    const tamperedParams = {
      ...(stored.params as Record<string, unknown>),
      verdicts: [{ address: 'aws_instance.sample01', class: 'benign_inplace', riskTier: 'low', actions: ['update'], forceNewAttrs: [], driftEvidence: true, changedAttrs: [], securityHits: [{ path: 'tags', why: 'forged' }] }],
    };
    await s.store.put({ ...stored, params: tamperedParams } as never);

    const { bare } = makeSeamOrigin();
    const planPath = join(mkdtempSync(join(tmpdir(), 'seam-plan-')), 'plan.json');
    writeFileSync(planPath, JSON.stringify(cannedNoOpPlan(['aws_instance.sample01'])));
    Object.assign(process.env, {
      CCP_BUNDLE: '1',
      CCP_GIT_REMOTE: bare,
      CCP_BUNDLE_GATE_CMD: `"${catalogctlBin}" drift-edit --request "$BUNDLE_REQUEST" --repo "$BUNDLE_CHECKOUT" --root environments/prod && "${catalogctlBin}" plan-check --plan "${planPath}" --request "$BUNDLE_REQUEST"`,
      CCP_BUNDLE_TRIGGER_CMD: 'true',
    });

    const applyRes = await s.app.request(`/requests/${reqId}/apply`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
    const body = (await applyRes.json()) as { ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }> };
    expect(body.ok, JSON.stringify(body.steps)).toBe(false);
    expect(applyRes.status).toBe(502);
    const gateStep = body.steps.find((st) => st.step === 'gate');
    expect(gateStep?.ok).toBe(false);
    // the checkout was NEVER edited — the refusal happened before any write landed.
    expect(g(bare, 'show', 'main:environments/prod/main.tf')).toContain('Owner = "platform"');
  });

  /* ── OOB provisioning-import spec §6/§7 — the import flavor's own real
   * gate proof, layer-2 pattern: a REAL submit → REAL approve → REAL apply,
   * whose gate command builds and invokes the SAME real catalogctl binary
   * running `drift-edit` (§7.1, appends the pinned import{}+resource{}
   * blocks to environments/prod/oob-adopted.tf) + `plan-check` (R10 —
   * import-exact, §7.2) against the SAME real git checkout. ── */

  const OOB_ADDRESS = 'aws_instance.oob_seamtest01';
  const OOB_LIVE_ID = 'i-0seamtest0000001';
  const OOB_IMPORT_BLOCK = `import {\n  to = ${OOB_ADDRESS}\n  id = "${OOB_LIVE_ID}"\n}\n`;
  const OOB_SKELETON_HCL = `resource "aws_instance" "oob_seamtest01" {\n  ami           = "ami-0123456789abcdef0"\n  instance_type = "m5.large"\n}\n`;

  it('GREEN: a single import submitted from the portal passes the REAL gate end-to-end (drift-edit writes oob-adopted.tf; R10 confirms exactly one import, zero add/change/destroy)', async () => {
    const s = await setupReady();
    const l2 = await seedExtraLead(s); // import's submitter (wati) is senior, so a third distinct senior signs L2
    const envelope = importEnvelope([{ arn: null, tfType: 'aws_instance', liveId: OOB_LIVE_ID, address: OOB_ADDRESS, importBlock: OOB_IMPORT_BLOCK, skeletonHcl: OOB_SKELETON_HCL }]);
    const [proposal] = realGenerateImport(envelope);
    await seedImportReportAndProposal(s, envelope, [proposal!]);
    process.env.CCP_DRIFT_IMPORT = '1'; // §6/§9 — import-flavor submit's own, narrower arming
    const reqId = await submitAndApproveImport(s, proposal!.digest, l2);

    const { bare } = makeSeamOrigin();
    const planPath = join(mkdtempSync(join(tmpdir(), 'seam-plan-')), 'plan.json');
    writeFileSync(planPath, JSON.stringify(cannedImportPlan([{ address: OOB_ADDRESS, id: OOB_LIVE_ID }])));
    Object.assign(process.env, {
      CCP_BUNDLE: '1',
      CCP_GIT_REMOTE: bare,
      CCP_BUNDLE_GATE_CMD: `"${catalogctlBin}" drift-edit --request "$BUNDLE_REQUEST" --repo "$BUNDLE_CHECKOUT" --root environments/prod && "${catalogctlBin}" plan-check --plan "${planPath}" --request "$BUNDLE_REQUEST"`,
      CCP_BUNDLE_TRIGGER_CMD: 'true',
    });

    const applyRes = await s.app.request(`/requests/${reqId}/apply`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
    const body = (await applyRes.json()) as { ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }>; code?: string; reason?: string };
    expect(body.ok, `status=${applyRes.status} body=${JSON.stringify(body)}`).toBe(true);
    expect(applyRes.status).toBe(200);
    // the import really landed: a fresh oob-adopted.tf carries the pinned
    // import{} block then the resource{} skeleton, exactly the reviewed bytes.
    const oobFile = g(bare, 'show', 'main:environments/prod/oob-adopted.tf');
    expect(oobFile).toContain(`to = ${OOB_ADDRESS}`);
    expect(oobFile).toContain(`id = "${OOB_LIVE_ID}"`);
    expect(oobFile).toContain(`resource "aws_instance" "oob_seamtest01"`);
    // the pre-existing checkout content is untouched (R10's zero-add/change/destroy bar).
    expect(g(bare, 'show', 'main:environments/prod/main.tf')).toContain('resource "aws_instance" "sample01"');
  });

  it('RED: a finding tampered to securityFamily:true AFTER approval reds the gate — §5.3 screen 3 / §8 enforcement point 3, independent of the api\'s own submit-time re-check', async () => {
    const s = await setupReady();
    const l2 = await seedExtraLead(s);
    const envelope = importEnvelope([{ arn: null, tfType: 'aws_instance', liveId: OOB_LIVE_ID, address: OOB_ADDRESS, importBlock: OOB_IMPORT_BLOCK, skeletonHcl: OOB_SKELETON_HCL }]);
    const [proposal] = realGenerateImport(envelope);
    await seedImportReportAndProposal(s, envelope, [proposal!]);
    process.env.CCP_DRIFT_IMPORT = '1'; // §6/§9 — import-flavor submit's own, narrower arming
    const reqId = await submitAndApproveImport(s, proposal!.digest, l2);

    // Simulate tampering BETWEEN approval and apply: directly flip the
    // stored request's pinned params.finding.securityFamily to true — the
    // "since-flagged creation-security" attack §5.3/§8 name. The api's own
    // enforcement points (1: generator, 2: submit re-check) already ran and
    // passed for the HONEST data; this proves point 3 (drift-edit's own
    // ClassifyFinding re-derivation) is independently effective even when
    // 1-2 are bypassed by direct tampering.
    const rk = requestKey('acme', reqId);
    const stored = (await s.store.get(rk.PK, rk.SK)) as RequestItem;
    const storedParams = stored.params as { finding: Record<string, unknown> };
    const tamperedParams = { ...storedParams, finding: { ...storedParams.finding, securityFamily: true } };
    await s.store.put({ ...stored, params: tamperedParams } as never);

    const { bare } = makeSeamOrigin();
    const planPath = join(mkdtempSync(join(tmpdir(), 'seam-plan-')), 'plan.json');
    writeFileSync(planPath, JSON.stringify(cannedImportPlan([{ address: OOB_ADDRESS, id: OOB_LIVE_ID }])));
    Object.assign(process.env, {
      CCP_BUNDLE: '1',
      CCP_GIT_REMOTE: bare,
      CCP_BUNDLE_GATE_CMD: `"${catalogctlBin}" drift-edit --request "$BUNDLE_REQUEST" --repo "$BUNDLE_CHECKOUT" --root environments/prod && "${catalogctlBin}" plan-check --plan "${planPath}" --request "$BUNDLE_REQUEST"`,
      CCP_BUNDLE_TRIGGER_CMD: 'true',
    });

    const applyRes = await s.app.request(`/requests/${reqId}/apply`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
    const body = (await applyRes.json()) as { ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }> };
    expect(body.ok, JSON.stringify(body.steps)).toBe(false);
    expect(applyRes.status).toBe(502);
    const gateStep = body.steps.find((st) => st.step === 'gate');
    expect(gateStep?.ok).toBe(false);
    // the checkout was NEVER edited — refused before any write landed, so
    // oob-adopted.tf was never even created on the pushed branch.
    expect(() => g(bare, 'show', 'main:environments/prod/oob-adopted.tf')).toThrow();
  });
});
