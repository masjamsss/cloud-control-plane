import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AuditItem, DriftProposalItem } from '../src/store/schema';
import { driftProposalKey } from '../src/store/schema';
import { __resetUploadRateLimitForTests } from '../src/middleware/rateLimit';
import { __resetKnownProjectsForTests } from '../src/projects';
import { __setNow } from '../src/clock';
import { canonicalJson } from '../src/domain/audit';
import { seed, seedAccount, sessionCookieFor, setSetting } from './helpers/seed';
import {
  __resetDriftGenStateForTests,
  addressEligibleFor,
  classifyByFields,
  classifyFinding,
  foldVerdictsByAddress,
  generateDriftProposalsOnce,
  readDriftProposalBody,
  scheduleDriftGeneration,
  writeDriftProposalBody,
} from '../src/domain/driftProposals';
import type { ClassifiableFinding, ClassifiableVerdict, DriftGenSteps, DriftProposalDoc } from '../src/domain/driftProposals';

/**
 * WI-6 of docs/superpowers/specs/2026-07-20-ccp-drift-portal.md: the
 * durable proposal store + the async generation seam (DriftGenSteps, a
 * bundle-style injected command), submit-from-proposal as the ONLY door
 * into a drift request, the two system ops, and the new error codes.
 *
 * Layout: (1) classifyByFields against the shared cross-language fixture
 * (tools/catalogctl/testdata/driftpropose/eligibility-cases.json) — the "one
 * table, three implementations, one fixture" doctrine, §6.2; (2) the
 * generation seam with FAKE DriftGenSteps (no network, no real catalogctl);
 * (3) the submit route, adversarially, mirroring drift.test.ts's style for
 * WI-2; (4) the direct-lane refusal on POST /requests; (5) one end-to-end
 * proof the created request rides the EXISTING request lifecycle (approve
 * ladder, then the ADR-0016 apply lane) unmodified.
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const digestFor = (label: string): string => sha256(`eligibility-fixture-independent-test-digest:${label}`);

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

function reportText(): string {
  return `${JSON.stringify(
    { repo: 'terraform-acme', verdict: 'clean', findings: [], resourceBlocks: 12, moduleBlocks: 0, tfJsonFiles: 0, fmtDirtyFiles: 0, providerPins: { aws: '~> 6.0' } },
    null,
    2,
  )}\n`;
}

const REGISTER = { id: 'acme', name: 'Acme estate', github: { owner: 'acme-co', repo: 'terraform-acme' }, accountId: '123456789012', region: 'ap-southeast-5' };

/** One benign, adopt-eligible verdict (mirrors eligibility-cases.json's
 * "adopt-eligible-single-attr" case). */
function benignVerdict(address = 'aws_instance.web'): Record<string, unknown> {
  return {
    address,
    type: 'aws_instance',
    actions: ['update'],
    actionReason: null,
    driftEvidence: true,
    class: 'benign_inplace',
    riskTier: 'low',
    changedAttrs: [{ path: 'tags.Owner', live: '"bi-team"', code: '"platform"', sensitive: false, liveJson: 'bi-team', codeJson: 'platform' }],
    forceNewAttrs: [],
    securityHits: [],
    computedUnknown: [],
    notes: [],
    recommendation: 'adopt the live value into code (no-op PR)',
    neverDo: 'never adopt a value you have not read',
    executor: 'Claude-preparable PR',
  };
}

/** One security-posture, revert-eligible verdict (mirrors eligibility-cases.json's
 * "security-by-class-revert-eligible" case). */
function securityVerdict(address = 'aws_security_group.sg1'): Record<string, unknown> {
  return {
    address,
    type: 'aws_security_group',
    actions: ['update'],
    actionReason: null,
    driftEvidence: true,
    class: 'security_posture',
    riskTier: 'high',
    changedAttrs: [
      { path: 'ingress[0].cidr_blocks', live: '["0.0.0.0/0"]', code: '["10.0.0.0/16"]', sensitive: false, liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'] },
    ],
    forceNewAttrs: [],
    securityHits: [{ path: 'ingress', why: 'network reachability' }],
    computedUnknown: [],
    notes: [],
    recommendation: 'revert to code (security posture) — never adopt',
    neverDo: 'never adopt a security-posture change',
    executor: 'gated apply, revert-only',
  };
}

/** One out-of-band-deletion, restore-eligible verdict (L29, register 0009,
 * 2026-07-20-drift-restore-tranche.md §2.1 — mirrors what
 * eligibility-cases.json's "oob-deletion-restore-eligible" case becomes once
 * the Go lane's fixture rename lands: taxonomy D4, actions ["create"],
 * driftEvidence true, no changedAttrs — a restore proposal carries no edit). */
function oobDeletionVerdict(address = 'aws_flow_log.vpc1'): Record<string, unknown> {
  return {
    address,
    type: 'aws_flow_log',
    actions: ['create'],
    actionReason: null,
    driftEvidence: true,
    class: 'oob_deletion',
    riskTier: 'high',
    changedAttrs: [],
    forceNewAttrs: [],
    securityHits: [],
    computedUnknown: [],
    notes: [],
    recommendation: 'restore = re-assert code by hand per runbook D4 + docs/runbooks/state-recovery.md',
    neverDo: 'never restore without capturing the CloudTrail Delete* evidence first',
    executor: 'gated apply, restore-only (scoped create)',
  };
}

type DriftReportOverride = { meta?: Record<string, unknown>; counts?: Record<string, unknown>; verdicts?: unknown[]; absorbed?: unknown[]; invisible_to_plan?: string };

function defaultReport(): DriftReportOverride {
  return {
    meta: { format_version: '1.2', terraform_version: '1.9.0', provider_tag: 'v6.53.0' },
    counts: { benign_inplace: 1, security_posture: 1 },
    verdicts: [benignVerdict(), securityVerdict()],
    absorbed: [],
    invisible_to_plan: 'out-of-band CREATED resources are invisible to this alarm',
  };
}

function envelope(
  over: {
    projectId?: string;
    environment?: string;
    capturedAt?: string;
    runId?: string;
    commit?: string;
    cadenceHours?: number;
    planExitCode?: 0 | 2;
    report?: DriftReportOverride;
    /** OOB provisioning-import spec §3.1 — additive, optional; every
     * existing call site omits this (byte-identical to before this field
     * existed, the same "absent ⇒ no sweep section" contract §3.1 itself
     * documents). */
    sweep?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    schema: 'ccp.drift/v1',
    projectId: over.projectId ?? 'acme',
    environment: over.environment ?? 'prod',
    capturedAt: over.capturedAt ?? '2026-07-20T03:17:04Z',
    runId: over.runId ?? '16234567890',
    commit: over.commit ?? COMMIT,
    cadenceHours: over.cadenceHours ?? 6,
    planExitCode: over.planExitCode ?? 2,
    report: over.report ?? defaultReport(),
    ...(over.sweep !== undefined ? { sweep: over.sweep } : {}),
  };
}

/** One import-eligible sweep finding (mirrors unmanaged-cases.json's
 * "import-eligible-plain" case) — a plain out-of-band `aws_instance`, no
 * ARN, a complete importPayload. */
function importFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    class: 'unmanaged_resource',
    arn: null,
    tfType: 'aws_instance',
    liveId: 'i-0oobtest0000001',
    name: 'oob-test-01',
    service: 'ec2',
    stateful: false,
    region: 'ap-southeast-5',
    securityFamily: false,
    actor: null,
    importPayload: {
      address: 'aws_instance.oob_test01',
      targetFile: 'oob-adopted.tf',
      importBlock: 'import {\n  to = aws_instance.oob_test01\n  id = "i-0oobtest0000001"\n}\n',
      skeletonHcl: 'resource "aws_instance" "oob_test01" {\n  ami           = "ami-0123456789abcdef0"\n  instance_type = "m5.large"\n}\n',
    },
    payloadWithheldReason: null,
    ...overrides,
  };
}

/** The envelope's additive `sweep` section (§3.1) wrapping `findings`. */
function sweepWith(findings: Record<string, unknown>[]): Record<string, unknown> {
  return {
    method: 'importer-kit discover: test fixture',
    capturedAt: '2026-07-20T03:17:04Z',
    region: 'ap-southeast-5',
    findings,
    totalFindings: findings.length,
    ignoredCount: 0,
    coverage: {},
  };
}

/* ── proposals.json (catalogctl drift-propose output) builders ─────────── */

function attrRow(address: string, path: string, liveJson: unknown, codeJson: unknown) {
  return { address, path, liveJson, codeJson };
}

function adoptProposal(digest: string, address: string, path: string, liveJson: unknown, codeJson: unknown) {
  const attrs = [attrRow(address, path, liveJson, codeJson)];
  return {
    digest,
    flavor: 'adopt' as const,
    addresses: [address],
    attrs,
    diff: `--- a/environments/prod/main.tf\n+++ b/environments/prod/main.tf\n@@ -1 +1 @@\n-old\n+new\n`,
    requestSkeleton: { items: [{ operationId: 'system-drift-adopt', targetAddress: address, params: { attrs, proposalDigest: digest, reportVersion: 0 } }] },
  };
}

function revertProposal(digest: string, address: string, path: string, liveJson: unknown, codeJson: unknown) {
  const attrs = [attrRow(address, path, liveJson, codeJson)];
  return {
    digest,
    flavor: 'revert' as const,
    addresses: [address],
    attrs,
    diff: null,
    requestSkeleton: { items: [{ operationId: 'system-drift-revert', targetAddress: address, params: { attrs, proposalDigest: digest, reportVersion: 0 } }] },
  };
}

/** OOB provisioning-import spec §5.1 — the import flavor's own generated-
 * proposal shape: `attrs: []` (a payload, not attribute edits), the 6-field
 * `importPayload` (identity + reviewed bytes), `diff: null`. */
function importProposalDoc(digest: string, address: string, arn: string | null, tfType: string, liveId: string, targetFile: string, importBlock: string, skeletonHcl: string) {
  const importPayload = { arn, tfType, liveId, targetFile, importBlock, skeletonHcl };
  return {
    digest,
    flavor: 'import' as const,
    addresses: [address],
    attrs: [],
    diff: null,
    importPayload,
    requestSkeleton: { items: [{ operationId: 'system-drift-import', targetAddress: address, params: { importPayload, proposalDigest: digest, reportVersion: 0 } }] },
  };
}

function proposalsDoc(proposals: ReturnType<typeof adoptProposal>[], ungenerable: Array<{ address: string; class: string; reason: string }> = [], baseCommit = 'deadbeefcafe'): Record<string, unknown> {
  return { schema: 'ccp.drift-proposals/v1', baseCommit, proposals, ungenerable };
}

/** A DriftGenSteps fake that always returns `doc`, using a real (throwaway)
 * scratch dir so runDriftGen's writeFileSync has somewhere to land. */
function fakeStepsReturning(doc: unknown): { steps: DriftGenSteps; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'driftgen-fake-'));
  return {
    dir,
    steps: {
      prepare: () => ({ dir }),
      generate: () => ({ ok: true, detail: 'fake green', out: JSON.stringify(doc) }),
      cleanup: (d) => rmSync(d, { recursive: true, force: true }),
    },
  };
}

/** Directly seed a proposal row + its on-disk body — bypasses the generation
 * engine entirely, for deterministic control over exactly what the submit
 * route sees (used to construct forged/stale/batch scenarios). */
async function seedProposal(
  store: ConfigStore,
  dataRoot: string,
  opts: {
    id?: string;
    digest: string;
    flavor: 'adopt' | 'revert';
    address: string;
    path: string;
    liveJson: unknown;
    codeJson: unknown;
    reportVersion: number;
    status?: 'open' | 'submitted' | 'superseded';
    requestId?: string;
  },
): Promise<void> {
  const id = opts.id ?? 'acme';
  const attrs = [attrRow(opts.address, opts.path, opts.liveJson, opts.codeJson)];
  const opId = opts.flavor === 'adopt' ? 'system-drift-adopt' : 'system-drift-revert';
  const body: DriftProposalDoc = {
    digest: opts.digest,
    flavor: opts.flavor,
    addresses: [opts.address],
    attrs,
    diff: opts.flavor === 'adopt' ? '--- a/x\n+++ b/x\n' : null,
    requestSkeleton: { items: [{ operationId: opId, targetAddress: opts.address, params: { attrs, proposalDigest: opts.digest, reportVersion: 0 } }] },
    verdicts: [],
  };
  await writeDriftProposalBody(dataRoot, id, opts.digest, body);
  const key = driftProposalKey(id, opts.digest);
  const row: DriftProposalItem = {
    ...key,
    projectId: id,
    digest: opts.digest,
    flavor: opts.flavor,
    status: opts.status ?? 'open',
    addresses: [opts.address],
    attrCount: attrs.length,
    firstReportVersion: opts.reportVersion,
    lastSeenReportVersion: opts.reportVersion,
    baseCommit: 'deadbeefcafe',
    generatedAt: '2026-07-20T03:17:04Z',
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  };
  await store.put(row as never);
}

/** Directly seed an IMPORT proposal row + its on-disk body — the import
 * twin of {@link seedProposal}, bypassing generation for deterministic
 * control over exactly what the submit route sees. `arn`/`tfType`/`liveId`
 * are the finding identity `findCurrentFinding` looks up BY at submit time —
 * pass the SAME identity as the finding seeded into the current report via
 * {@link importFinding}/{@link sweepWith} for the happy path, or a
 * deliberately different one to construct a "finding vanished" scenario. */
async function seedImportProposal(
  store: ConfigStore,
  dataRoot: string,
  opts: {
    id?: string;
    digest: string;
    address: string;
    arn: string | null;
    tfType: string;
    liveId: string;
    targetFile: string;
    importBlock: string;
    skeletonHcl: string;
    reportVersion: number;
    status?: 'open' | 'submitted' | 'superseded';
    requestId?: string;
  },
): Promise<void> {
  const id = opts.id ?? 'acme';
  const importPayload = { arn: opts.arn, tfType: opts.tfType, liveId: opts.liveId, targetFile: opts.targetFile, importBlock: opts.importBlock, skeletonHcl: opts.skeletonHcl };
  const body: DriftProposalDoc = {
    digest: opts.digest,
    flavor: 'import',
    addresses: [opts.address],
    attrs: [],
    diff: null,
    importPayload,
    requestSkeleton: { items: [{ operationId: 'system-drift-import', targetAddress: opts.address, params: { importPayload, proposalDigest: opts.digest, reportVersion: 0 } }] },
    verdicts: [],
  };
  await writeDriftProposalBody(dataRoot, id, opts.digest, body);
  const key = driftProposalKey(id, opts.digest);
  const row: DriftProposalItem = {
    ...key,
    projectId: id,
    digest: opts.digest,
    flavor: 'import',
    status: opts.status ?? 'open',
    addresses: [opts.address],
    attrCount: 0,
    firstReportVersion: opts.reportVersion,
    lastSeenReportVersion: opts.reportVersion,
    baseCommit: 'deadbeefcafe',
    generatedAt: '2026-07-20T03:17:04Z',
    arn: opts.arn,
    tfType: opts.tfType,
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  };
  await store.put(row as never);
}

/** Directly seed a RESTORE proposal row + its on-disk body — the restore
 * twin of {@link seedProposal}/{@link seedImportProposal}, bypassing
 * generation for deterministic control over exactly what the submit route
 * sees. L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2.2): attrs
 * is ALWAYS `[]` (empty, non-nil) and diff is ALWAYS `null` — a restore
 * proposal carries no edit, only the pinned address to re-assert; the
 * skeleton's own params carry no `attrs` key at all (§2.2: "params
 * {proposalDigest} only", mirroring import's own no-`attrs`-key precedent). */
async function seedRestoreProposal(
  store: ConfigStore,
  dataRoot: string,
  opts: {
    id?: string;
    digest: string;
    address: string;
    reportVersion: number;
    status?: 'open' | 'submitted' | 'superseded';
    requestId?: string;
  },
): Promise<void> {
  const id = opts.id ?? 'acme';
  const body: DriftProposalDoc = {
    digest: opts.digest,
    flavor: 'restore',
    addresses: [opts.address],
    attrs: [],
    diff: null,
    requestSkeleton: { items: [{ operationId: 'system-drift-restore', targetAddress: opts.address, params: { proposalDigest: opts.digest, reportVersion: 0 } }] },
    verdicts: [],
  };
  await writeDriftProposalBody(dataRoot, id, opts.digest, body);
  const key = driftProposalKey(id, opts.digest);
  const row: DriftProposalItem = {
    ...key,
    projectId: id,
    digest: opts.digest,
    flavor: 'restore',
    status: opts.status ?? 'open',
    addresses: [opts.address],
    attrCount: 0,
    firstReportVersion: opts.reportVersion,
    lastSeenReportVersion: opts.reportVersion,
    baseCommit: 'deadbeefcafe',
    generatedAt: '2026-07-20T03:17:04Z',
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  };
  await store.put(row as never);
}

type App = ReturnType<typeof createApp>;
type Setup = { store: ConfigStore; app: App; dataRoot: string; putra: string; lina: string; root: string; sari: string; budi: string; nia: string; wati: string };

let roots: string[] = [];

async function setup(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store); // sari (requester) / budi (approver) / putra (lead+admin) / lina (lead) — all sample-only
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  // acme-bound accounts (drift.test.ts's own pattern): a requester and an
  // approver explicitly bound to 'acme', since the base seed() accounts are
  // legacy rows fail-closed to 'sample' only.
  await seedAccount(store, { id: 'nia', role: 'requester', teamId: 'platform', isAdmin: false, projects: ['sample', 'acme'] });
  await seedAccount(store, { id: 'wati', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'acme'] });
  const dataRoot = mkdtempSync(join(tmpdir(), 'ccp-driftprop-'));
  roots.push(dataRoot);
  const app = createApp(store, { projectDataRoot: dataRoot });
  return {
    store,
    app,
    dataRoot,
    putra: await sessionCookieFor(store, 'putra'),
    lina: await sessionCookieFor(store, 'lina'),
    root: await sessionCookieFor(store, 'root'),
    sari: await sessionCookieFor(store, 'sari'),
    budi: await sessionCookieFor(store, 'budi'),
    nia: await sessionCookieFor(store, 'nia'),
    wati: await sessionCookieFor(store, 'wati'),
  };
}

/** register → upload trust artifacts → propose trust → second-admin ack (byte-for-byte drift.test.ts's helper). */
async function driveToTrusted(s: Setup, id = 'acme', register: Record<string, unknown> = REGISTER): Promise<void> {
  const { app, putra, lina, root } = s;
  expect((await app.request('/projects', { method: 'POST', headers: hdrs(putra, { json: true }), body: JSON.stringify(register) })).status).toBe(201);
  const prescanReport = reportText();
  expect(
    (
      await app.request(`/projects/${id}/trust-request`, {
        method: 'PUT',
        headers: hdrs(lina, { json: true }),
        body: JSON.stringify({ trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(prescanReport) }, prescanReport }),
      })
    ).status,
  ).toBe(200);
  const propose = await app.request(`/projects/${id}/trust`, {
    method: 'POST',
    headers: hdrs(putra, { json: true }),
    body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256(prescanReport) }),
  });
  expect(propose.status).toBe(202);
  const pending = (await propose.json()) as { id: string };
  expect((await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) })).status).toBe(200);
}

/** ONLY the drift-portal surface (PUT/GET/POST-submit under /projects/:id/drift*)
 * needs the project merely `trusted` — those routes bind by the URL's `:id`
 * directly, exactly like GET /:id/drift already does (drift.test.ts). The
 * normal request routes (/requests/:id/approve, /:id/apply) know NOTHING of
 * a `:id` path param — they resolve `projectId` purely from the
 * `x-ccp-project` header, which `withProject` refuses unless the project
 * is `ready` (routable/bindable — projects.ts#hydrateKnownProjects). So the
 * end-to-end test (which DOES call approve/apply) needs the full
 * data-activation dance projectData.test.ts's own driveToReady-equivalent
 * uses — the drift-only tests above deliberately do NOT pay this cost. */
async function driveToReady(s: Setup, id = 'acme'): Promise<void> {
  await driveToTrusted(s, id);
  const { token } = await mintToken(s, id);
  const inventory = { generatedAt: '2026-07-17T00:00:00.000Z', sourceCommit: COMMIT, source: 'scan', resources: [] };
  const blocks = { index: {}, chunks: {} };
  const manifests: unknown[] = [];
  const dataBundle = {
    digests: { inventorySha256: sha256(canonicalJson(inventory)), blocksSha256: sha256(canonicalJson(blocks)), manifestsSha256: sha256(canonicalJson(manifests)) },
    inventory,
    blocks,
    manifests,
    summary: { providerPins: { aws: '~> 6.0' } },
  };
  const up = await s.app.request(`/projects/${id}/data`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(dataBundle) });
  expect(up.status).toBe(201);
  const uploaded = (await up.json()) as { version: number };
  const propose = await s.app.request(`/projects/${id}/data/${uploaded.version}/activate`, { method: 'POST', headers: hdrs(s.putra, { json: true }) });
  expect(propose.status).toBe(202);
  const pending = (await propose.json()) as { id: string };
  expect((await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) })).status).toBe(200);
}

async function mintToken(s: Setup, id = 'acme'): Promise<{ tokenId: string; token: string; expiresAt: string }> {
  const res = await s.app.request(`/projects/${id}/upload-tokens`, { method: 'POST', headers: hdrs(s.putra, { json: true }) });
  expect(res.status).toBe(201);
  return (await res.json()) as { tokenId: string; token: string; expiresAt: string };
}

async function putDrift(s: Setup, token: string, body: unknown = envelope(), id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function submitProposal(s: Setup, cookie: string, digest: string, body: Record<string, unknown>, id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift/proposals/${digest}/submit`, { method: 'POST', headers: hdrs(cookie, { json: true }), body: JSON.stringify(body) });
}

async function auditActions(store: ConfigStore, projectId = 'sample'): Promise<string[]> {
  const yyyymmNow = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const items = (await store.query(`P#${projectId}#AUDIT#${yyyymmNow}`)) as AuditItem[];
  return items.map((i) => i.action);
}

const ENV_KEYS = [
  'CCP_DRIFT',
  'CCP_DRIFT_IMPORT',
  'CCP_DRIFT_RESTORE',
  'CCP_DRIFT_KEEP',
  'CCP_DRIFT_PROPOSALS',
  'CCP_DRIFT_GEN_CMD',
  'CCP_GIT_REMOTE',
  'CCP_BUNDLE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
  __resetDriftGenStateForTests();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CCP_DRIFT = '1'; // armed by default — individual tests override
  for (const k of ['CCP_DRIFT_IMPORT', 'CCP_DRIFT_RESTORE', 'CCP_DRIFT_KEEP', 'CCP_DRIFT_PROPOSALS', 'CCP_DRIFT_GEN_CMD', 'CCP_GIT_REMOTE', 'CCP_BUNDLE']) delete process.env[k];
});
afterEach(() => {
  __setNow(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/* ═══ §6.2 — the eligibility partition, against the shared cross-language fixture ═══ */

describe('classifyByFields — parity with tools/catalogctl/testdata/driftpropose/eligibility-cases.json (§6.2 "one table, three implementations, one fixture")', () => {
  const fixtureUrl = new URL('../../../tools/catalogctl/testdata/driftpropose/eligibility-cases.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as {
    cases: Array<{ name: string; verdict: unknown; bucket: 'adopt' | 'revert' | 'ungenerable'; reason: string }>;
  };

  it('the fixture itself is non-empty (a silently-empty fixture would make every case below vacuous)', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(`${c.name} → ${c.bucket}`, () => {
      const result = classifyByFields(c.verdict as ClassifiableVerdict);
      expect(result.bucket, c.name).toBe(c.bucket);
      expect(result.reason, c.name).toBe(c.reason);
    });
  }

  it('enforcement point 1, re-asserted server-side: a watchlisted verdict relabeled benign_inplace with securityHits present still cannot reach adopt', () => {
    const forged = { class: 'benign_inplace', riskTier: 'low', actions: ['update'], forceNewAttrs: [], driftEvidence: true, changedAttrs: [], securityHits: [{ path: 'x', why: 'y' }] };
    expect(classifyByFields(forged).bucket).toBe('revert');
  });

  it('an unknown class is always ungenerable, even with every other field adopt-shaped', () => {
    const v = { class: 'some_future_class_z', riskTier: 'low', actions: ['update'], forceNewAttrs: [], driftEvidence: true, changedAttrs: [], securityHits: [] };
    expect(classifyByFields(v).bucket).toBe('ungenerable');
  });
});

/* ═══ L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2.1) — the
 * restore bucket, direct unit tests against the byte-pinned §2.1 table.
 * Independent of the shared fixture (which still carries the PRE-L29 case
 * until the Go lane's own commit lands — see the plan's §5 authorized-oracle
 * table: eligibility-cases.json is Go-lane-owned, api/app lanes only
 * consume). These hand-built cases pin the exact same strings §2.1
 * specifies, so this port is provably correct against the SPEC now, and the
 * parity block above will cover the SAME ground generically, for free, the
 * moment the fixture rename lands and this branch is rebased in. ═══ */

describe('L29 — classifyByFields restore bucket (direct, independent of the shared fixture)', () => {
  function oobDeletionShaped(overrides: Partial<ClassifiableVerdict> = {}): ClassifiableVerdict {
    return {
      class: 'oob_deletion',
      riskTier: 'high',
      actions: ['create'],
      forceNewAttrs: [],
      driftEvidence: true,
      changedAttrs: [],
      securityHits: [],
      ...overrides,
    } as ClassifiableVerdict;
  }

  it('actions ["create"] + driftEvidence ⇒ restore, the §2.1-pinned reason', () => {
    const result = classifyByFields(oobDeletionShaped());
    expect(result.bucket).toBe('restore');
    expect(result.reason).toBe('out-of-band deletion — restore-eligible (re-assert code; the plan re-creates the deleted resource)');
  });

  it('actions other than ["create"] (e.g. ["update"]) ⇒ ungenerable, the §2.1-pinned D4 not-a-pure-create reason', () => {
    const result = classifyByFields(oobDeletionShaped({ actions: ['update'] }));
    expect(result.bucket).toBe('ungenerable');
    expect(result.reason).toBe('oob_deletion drift with actions [update] (not a pure create) — not mechanically restorable, human decision required (runbook D4)');
  });

  it('actions ["create", "delete"] (a partial-recreation shape) ⇒ ungenerable, the same D4 reason with the multi-action %v rendering', () => {
    const result = classifyByFields(oobDeletionShaped({ actions: ['create', 'delete'] }));
    expect(result.bucket).toBe('ungenerable');
    expect(result.reason).toBe('oob_deletion drift with actions [create delete] (not a pure create) — not mechanically restorable, human decision required (runbook D4)');
  });

  it('actions [] (absent/empty) ⇒ ungenerable, the D4 reason renders the Go %v-style empty-slice "[]"', () => {
    const result = classifyByFields(oobDeletionShaped({ actions: [] }));
    expect(result.bucket).toBe('ungenerable');
    expect(result.reason).toBe('oob_deletion drift with actions [] (not a pure create) — not mechanically restorable, human decision required (runbook D4)');
  });

  it('no drift evidence ⇒ ungenerable, REUSING the existing byte-pinned D10 reason verbatim (no bespoke restore-flavored string)', () => {
    const result = classifyByFields(oobDeletionShaped({ driftEvidence: false }));
    expect(result.bucket).toBe('ungenerable');
    expect(result.reason).toBe('no drift evidence — unapplied config, not drift (see runbook D10)');
  });

  it('a forged securityHits row on a deletion still wins via isSecurityPosture (§8 enforcement point 1) — restore is never reachable, the existing D2 string fires', () => {
    const result = classifyByFields(oobDeletionShaped({ securityHits: [{ path: 'x', why: 'forged' }] }));
    expect(result.bucket).toBe('ungenerable');
    expect(result.reason).toBe('security-posture drift with actions [create] (not a pure in-place update) — not mechanically revertible, human decision required (runbook D2)');
  });

  it('a class other than oob_deletion is unaffected by the restore branch — benign_inplace still adopts normally', () => {
    const v: ClassifiableVerdict = {
      class: 'benign_inplace',
      riskTier: 'low',
      actions: ['update'],
      forceNewAttrs: [],
      driftEvidence: true,
      changedAttrs: [{ path: 'tags.Owner', sensitive: false, liveJson: 'x' } as never],
      securityHits: [],
    };
    expect(classifyByFields(v).bucket).toBe('adopt');
  });

  it('addressEligibleFor/foldVerdictsByAddress (F6/A8) already generalize to the restore bucket — no code change needed there beyond the DriftBucket type widening', () => {
    const byAddress = foldVerdictsByAddress([oobDeletionVerdict('aws_flow_log.vpc1')] as never);
    expect(addressEligibleFor(byAddress, 'aws_flow_log.vpc1', 'restore')).toBe(true);
    expect(addressEligibleFor(byAddress, 'aws_flow_log.vpc1', 'adopt')).toBe(false);
  });
});

/* ═══ OOB provisioning-import spec §5.2 — the finding partition, against the
 * shared cross-language fixture (the same "one table, three implementations,
 * one fixture" doctrine §6.2 states for classifyByFields, above) ═══ */

describe('classifyFinding — parity with tools/catalogctl/testdata/driftpropose/unmanaged-cases.json (§5.2 "one finding-partition table, three implementations, one fixture")', () => {
  const fixtureUrl = new URL('../../../tools/catalogctl/testdata/driftpropose/unmanaged-cases.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as {
    cases: Array<{ name: string; finding: unknown; bucket: 'import' | 'creation_security' | 'type_unmapped' | 'payload_withheld' | 'ungenerable'; reason: string }>;
  };

  it('the fixture itself is non-empty (a silently-empty fixture would make every case below vacuous)', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(`${c.name} → ${c.bucket}`, () => {
      const result = classifyFinding(c.finding as ClassifiableFinding);
      expect(result.bucket, c.name).toBe(c.bucket);
      expect(result.reason, c.name).toBe(c.reason);
    });
  }

  it('a finding class other than unmanaged_resource is always ungenerable, even with every other field import-shaped', () => {
    const f = { class: 'some_future_finding_class', tfType: 'aws_instance', securityFamily: false, importPayload: { address: 'a', targetFile: 'oob-adopted.tf', importBlock: 'x', skeletonHcl: 'y' }, payloadWithheldReason: null };
    expect(classifyFinding(f as ClassifiableFinding).bucket).toBe('ungenerable');
  });

  it('class __proto__ is unknown-and-ungenerable, not silently treated as a known class via prototype lookup (F7-style prototype safety)', () => {
    const f = { class: '__proto__', tfType: 'aws_instance', securityFamily: false, importPayload: null, payloadWithheldReason: null };
    const result = classifyFinding(f as ClassifiableFinding);
    expect(result.bucket).toBe('ungenerable');
    expect(result.reason).toContain('finding class "__proto__" is not "unmanaged_resource"');
  });
});

/* ═══ §6.3 — the generation seam (fake steps; no network, no real catalogctl) ═══ */

describe('generation seam — reconcile: ingest ⇒ store ⇒ reconcile (digest idempotency, supersede sweep, audits)', () => {
  it('the SAME digest generated across two report versions ⇒ zero new rows, lastSeenReportVersion bumps, audited', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // v1
    expect((await putDrift(s, token, envelope({ runId: 'run-2' }))).status).toBe(201); // v2 — different envelope, same verdict content

    const digest = digestFor('reused');
    const doc = proposalsDoc([adoptProposal(digest, 'aws_instance.web', 'tags.Owner', 'bi-team', 'platform')]);

    const r1 = await generateDriftProposalsOnce({ store: s.store, dataRoot: s.dataRoot, steps: fakeStepsReturning(doc).steps }, 'acme', 1);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.tally).toMatchObject({ open: 1, reused: 0, superseded: 0 });

    const r2 = await generateDriftProposalsOnce({ store: s.store, dataRoot: s.dataRoot, steps: fakeStepsReturning(doc).steps }, 'acme', 2);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.tally).toMatchObject({ open: 0, reused: 1, superseded: 0 });

    const rows = (await s.store.query('PROJECT#acme', 'DRIFTPROP#')) as DriftProposalItem[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastSeenReportVersion).toBe(2);
    expect(rows[0]!.firstReportVersion).toBe(1);
    expect(await auditActions(s.store, 'acme')).toContain('drift-proposals-generated');
  });

  it('CHANGED drift ⇒ a new row for the new digest + the old row superseded, both audited', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // v1

    const digestA = digestFor('changed-a');
    const digestB = digestFor('changed-b');
    const docA = proposalsDoc([adoptProposal(digestA, 'aws_instance.web', 'tags.Owner', 'bi-team', 'platform')]);
    const r1 = await generateDriftProposalsOnce({ store: s.store, dataRoot: s.dataRoot, steps: fakeStepsReturning(docA).steps }, 'acme', 1);
    expect(r1.ok).toBe(true);

    expect((await putDrift(s, token, envelope({ runId: 'run-2' }))).status).toBe(201); // v2
    const docB = proposalsDoc([adoptProposal(digestB, 'aws_instance.web', 'tags.Owner', 'sre-team', 'platform')]);
    const r2 = await generateDriftProposalsOnce({ store: s.store, dataRoot: s.dataRoot, steps: fakeStepsReturning(docB).steps }, 'acme', 2);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.tally).toMatchObject({ open: 1, reused: 0, superseded: 1 });

    const kA = driftProposalKey('acme', digestA);
    const rowA = (await s.store.get(kA.PK, kA.SK)) as DriftProposalItem;
    expect(rowA.status).toBe('superseded');
    const kB = driftProposalKey('acme', digestB);
    const rowB = (await s.store.get(kB.PK, kB.SK)) as DriftProposalItem;
    expect(rowB.status).toBe('open');

    expect(await auditActions(s.store, 'acme')).toEqual(expect.arrayContaining(['drift-proposals-generated', 'drift-proposals-generated']));
  });

  it('a submitted proposal is left completely alone even if its digest keeps reappearing', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('submitted-stable');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1, status: 'submitted', requestId: 'req-123' });

    const doc = proposalsDoc([adoptProposal(digest, 'aws_instance.web', 'tags.Owner', 'bi-team', 'platform')]);
    const r = await generateDriftProposalsOnce({ store: s.store, dataRoot: s.dataRoot, steps: fakeStepsReturning(doc).steps }, 'acme', 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tally).toMatchObject({ open: 0, reused: 0 }); // untouched, neither bucket

    const k = driftProposalKey('acme', digest);
    const row = (await s.store.get(k.PK, k.SK)) as DriftProposalItem;
    expect(row.status).toBe('submitted');
    expect(row.requestId).toBe('req-123');
  });

  it('a malformed generator output is a refusal, audited as drift-proposals-failed — never a crash', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);

    const { steps, dir } = fakeStepsReturning('{not valid json');
    const r = await generateDriftProposalsOnce({ store: s.store, dataRoot: s.dataRoot, steps }, 'acme', 1);
    expect(r.ok).toBe(false);
    expect(await auditActions(s.store, 'acme')).toContain('drift-proposals-failed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('non-reentrant per project: scheduleDriftGeneration called back-to-back for v1/v2/v3 runs v1 then v3 — v2 collapses', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    for (const runId of ['r1', 'r2', 'r3']) expect((await putDrift(s, token, envelope({ runId }))).status).toBe(201);

    const dir = mkdtempSync(join(tmpdir(), 'driftgen-reentrant-'));
    const seenRunIds: string[] = [];
    const steps: DriftGenSteps = {
      prepare: () => ({ dir }),
      generate: (_d, envPath) => {
        const env = JSON.parse(readFileSync(envPath, 'utf8')) as { runId: string };
        seenRunIds.push(env.runId);
        return { ok: true, detail: 'fake green', out: JSON.stringify(proposalsDoc([])) };
      },
      cleanup: () => undefined, // dir is reused across calls in this test; removed manually below
    };
    const deps = { store: s.store, dataRoot: s.dataRoot, steps };
    scheduleDriftGeneration(deps, 'acme', 1);
    scheduleDriftGeneration(deps, 'acme', 2);
    scheduleDriftGeneration(deps, 'acme', 3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seenRunIds).toEqual(['r1', 'r3']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('PUT /:id/drift — the generation TRIGGER (§6.3), off by default', () => {
  it('CCP_DRIFT_PROPOSALS unset ⇒ report still stages 201 (fail-open) and NO proposal rows are ever created', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await putDrift(s, token);
    expect(res.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let any erroneous background task tick
    expect(await s.store.query('PROJECT#acme', 'DRIFTPROP#')).toEqual([]);
  });

  it('armed (CCP_DRIFT_PROPOSALS + CCP_DRIFT_GEN_CMD + CCP_GIT_REMOTE) schedules generation after responding — 201 is not blocked by it', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    // A trivial, always-green command that writes an empty proposals doc to
    // $DRIFT_OUT — proves the wiring end-to-end without a real catalogctl.
    process.env.CCP_DRIFT_PROPOSALS = '1';
    process.env.CCP_GIT_REMOTE = 'unused-in-this-test';
    process.env.CCP_DRIFT_GEN_CMD = `cat > "$DRIFT_OUT" <<'EOF'\n${JSON.stringify(proposalsDoc([]))}\nEOF`;
    // realDriftGenSteps still clones $CCP_GIT_REMOTE for real via git — a
    // fake remote fails prepare(), so this test only proves the PUT response
    // itself is never blocked/broken by an armed-but-failing generation.
    const res = await putDrift(s, token);
    expect(res.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Fire-and-forget: the response already returned above regardless of
    // whether the (failing, fake-remote) background generation ever finishes.
  });
});

/* ═══ §4.3 — POST /:id/drift/proposals/:digest/submit: the only door into a drift request ═══ */

describe('POST /projects/:id/drift/proposals/:digest/submit', () => {
  it('disarmed (CCP_DRIFT unset) ⇒ 409 DRIFT_DISARMED', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    delete process.env.CCP_DRIFT;
    const res = await submitProposal(s, s.nia, digestFor('irrelevant'), { justification: 'x'.repeat(20), schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_DISARMED');
  });

  it('unknown digest ⇒ 404', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await submitProposal(s, s.nia, digestFor('never-generated'), { justification: 'x'.repeat(20), schedule: { kind: 'now' } });
    expect(res.status).toBe(404);
  });

  it('happy adopt path: any bound member (requester tier up) can submit; creates a request on the [L2,L3] ladder with server-pinned params; proposal → submitted{requestId}; timeline gains an origin event', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // v1: benign@aws_instance.web + security@aws_security_group.sg1
    const digest = digestFor('happy-adopt');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });

    const res = await submitProposal(s, s.nia, digest, { justification: 'adopting the observed live value into code', schedule: { kind: 'now' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.operationId).toBe('system-drift-adopt');
    expect(body.service).toBe('drift');
    expect(body.targetAddress).toBe('aws_instance.web');
    expect(body.approvalLadder).toEqual(['L2', 'L3']);
    expect(body.status).toBe('AWAITING_CODE_REVIEW');
    // F1(a)/A2 pinned params contract: {attrs, verdicts, diff, proposalDigest,
    // reportVersion} — `verdicts` is the CURRENT stored-report row(s) for this
    // item's address (the step-7 re-check's own data, never the proposal
    // body's frozen copy — seedProposal's body carries `verdicts: []`, proving
    // this isn't just echoed back); `diff` is the reviewed edit bytes
    // seedProposal pinned on the body.
    expect(body.params).toEqual({
      attrs: [{ address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform' }],
      verdicts: [benignVerdict('aws_instance.web')],
      diff: '--- a/x\n+++ b/x\n',
      proposalDigest: digest,
      reportVersion: 1,
    });
    expect((body.events as Array<{ type: string; label: string }>).some((e) => e.type === 'origin' && e.label.includes(digest))).toBe(true);

    const k = driftProposalKey('acme', digest);
    const row = (await s.store.get(k.PK, k.SK)) as DriftProposalItem;
    expect(row.status).toBe('submitted');
    expect(row.requestId).toBe(body.id);

    expect(await auditActions(s.store, 'acme')).toEqual(expect.arrayContaining(['request-submit', 'drift-proposal-submitted']));
  });

  it('batch: alsoDigests folds additional ADOPT proposals into ONE change-set request; every row is marked submitted', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect(
      (
        await putDrift(
          s,
          token,
          envelope({ report: { ...defaultReport(), verdicts: [benignVerdict('aws_instance.web'), benignVerdict('aws_instance.web2'), securityVerdict()] } }),
        )
      ).status,
    ).toBe(201);
    const digestA = digestFor('batch-a');
    const digestB = digestFor('batch-b');
    await seedProposal(s.store, s.dataRoot, { digest: digestA, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });
    await seedProposal(s.store, s.dataRoot, { digest: digestB, flavor: 'adopt', address: 'aws_instance.web2', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });

    const res = await submitProposal(s, s.nia, digestA, { justification: 'adopting both drifted resources together', schedule: { kind: 'now' }, alsoDigests: [digestB] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: Array<{ targetAddress: string }>; id: string };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.targetAddress).sort()).toEqual(['aws_instance.web', 'aws_instance.web2']);

    for (const digest of [digestA, digestB]) {
      const k = driftProposalKey('acme', digest);
      const row = (await s.store.get(k.PK, k.SK)) as DriftProposalItem;
      expect(row.status).toBe('submitted');
      expect(row.requestId).toBe(body.id);
    }
  });

  it('revert requires approver/lead: a requester is refused 403 FORBIDDEN_ROLE; an approver succeeds 201', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('revert-role-gate');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'revert', address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });

    const asRequester = await submitProposal(s, s.nia, digest, { justification: 'trying to revert security drift', schedule: { kind: 'now' } });
    expect(asRequester.status).toBe(403);
    expect(((await asRequester.json()) as { code: string }).code).toBe('FORBIDDEN_ROLE');

    const asApprover = await submitProposal(s, s.wati, digest, { justification: 'reverting the console change on the SG', schedule: { kind: 'now' } });
    expect(asApprover.status).toBe(201);
    expect(((await asApprover.json()) as { operationId: string }).operationId).toBe('system-drift-revert');
  });

  it('a revert submit carrying alsoDigests is refused — revert always submits alone', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('revert-alone');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'revert', address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });
    const res = await submitProposal(s, s.wati, digest, { justification: 'reverting with a bogus batch', schedule: { kind: 'now' }, alsoDigests: [digestFor('anything')] });
    expect(res.status).toBe(422);
  });

  it('§8 enforcement point 2: a forged/relabeled ADOPT proposal whose STORED verdict is security-posture ⇒ 422 DRIFT_NOT_ADOPTABLE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // the report's REAL verdict at sg1 is security_posture
    const digest = digestFor('forged-adopt-over-security');
    // Claims 'adopt' over the security-posture address — a forged/stale row.
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });

    const res = await submitProposal(s, s.wati, digest, { justification: 'trying to sneak an adopt over security drift', schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_NOT_ADOPTABLE');
  });

  it('a proposal for an address no longer present in the stored report ⇒ 422 DRIFT_NOT_ADOPTABLE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('address-vanished');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.ghost', path: 'tags.Owner', liveJson: 'a', codeJson: 'b', reportVersion: 1 });
    const res = await submitProposal(s, s.nia, digest, { justification: 'adopting a since-vanished address', schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_NOT_ADOPTABLE');
  });

  it('stale: lastSeenReportVersion lagging the served pointer ⇒ 409 DRIFT_PROPOSAL_STALE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // v1
    const digest = digestFor('stale-pointer');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });
    // A new report stages (v2) WITHOUT regenerating proposals (disarmed by default) — pointer moves to 2.
    expect((await putDrift(s, token, envelope({ runId: 'run-2' }))).status).toBe(201);

    const res = await submitProposal(s, s.nia, digest, { justification: 'adopting now-stale drift', schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_STALE');
  });

  it('an already-submitted proposal cannot be submitted again ⇒ 409 DRIFT_PROPOSAL_STALE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('double-submit');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1, status: 'submitted', requestId: 'req-already' });
    const res = await submitProposal(s, s.nia, digest, { justification: 'trying to resubmit an already-submitted proposal', schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_STALE');
  });

  it('a global freeze refuses with 423 GLOBAL_FREEZE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('frozen-submit');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });
    await setSetting(s.store, 'acme', 'freeze.global', true);

    const res = await submitProposal(s, s.nia, digest, { justification: 'trying to submit during a freeze', schedule: { kind: 'now' } });
    expect(res.status).toBe(423);
    expect(((await res.json()) as { code: string }).code).toBe('GLOBAL_FREEZE');
  });

  it('an unbound account (not a member of the target project) ⇒ 403 PROJECT_SCOPE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('unbound');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });
    // sari is sample-only (legacy row, no acme binding).
    const res = await submitProposal(s, s.sari, digest, { justification: 'unbound account trying to submit', schedule: { kind: 'now' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_SCOPE');
  });
});

/* ═══ OOB provisioning-import spec §6 — the import flavor's submit deltas ═══ */

describe('POST /projects/:id/drift/proposals/:digest/submit — flavor "import" (OOB provisioning spec §6)', () => {
  const IMPORT_BLOCK = 'import {\n  to = aws_instance.oob_test01\n  id = "i-0oobtest0000001"\n}\n';
  const SKELETON_HCL = 'resource "aws_instance" "oob_test01" {\n  ami           = "ami-0123456789abcdef0"\n  instance_type = "m5.large"\n}\n';

  it('disarmed (CCP_DRIFT_IMPORT unset, even though CCP_DRIFT is armed) ⇒ 409 DRIFT_DISARMED naming the import flag', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token, envelope({ sweep: sweepWith([importFinding()]) }))).status).toBe(201);
    const digest = digestFor('import-disarmed');
    await seedImportProposal(s.store, s.dataRoot, {
      digest,
      address: 'aws_instance.oob_test01',
      arn: null,
      tfType: 'aws_instance',
      liveId: 'i-0oobtest0000001',
      targetFile: 'oob-adopted.tf',
      importBlock: IMPORT_BLOCK,
      skeletonHcl: SKELETON_HCL,
      reportVersion: 1,
    });
    // CCP_DRIFT_IMPORT is deliberately left unset — beforeEach deletes it,
    // even though CCP_DRIFT itself stays armed by default.
    const res = await submitProposal(s, s.wati, digest, { justification: 'trying to import while the import lane is disarmed', schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe('DRIFT_DISARMED');
    expect(body.reason).toContain('CCP_DRIFT_IMPORT');
  });

  it('role: a requester is refused 403 FORBIDDEN_ROLE; an approver succeeds 201 with the pinned {finding, importPayload, diff:null, proposalDigest, reportVersion} params', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const finding = importFinding();
    expect((await putDrift(s, token, envelope({ sweep: sweepWith([finding]) }))).status).toBe(201);
    const digest = digestFor('import-happy');
    await seedImportProposal(s.store, s.dataRoot, {
      digest,
      address: 'aws_instance.oob_test01',
      arn: null,
      tfType: 'aws_instance',
      liveId: 'i-0oobtest0000001',
      targetFile: 'oob-adopted.tf',
      importBlock: IMPORT_BLOCK,
      skeletonHcl: SKELETON_HCL,
      reportVersion: 1,
    });
    process.env.CCP_DRIFT_IMPORT = '1';

    const asRequester = await submitProposal(s, s.nia, digest, { justification: 'a requester trying to import an out-of-band resource', schedule: { kind: 'now' } });
    expect(asRequester.status).toBe(403);
    expect(((await asRequester.json()) as { code: string }).code).toBe('FORBIDDEN_ROLE');

    const res = await submitProposal(s, s.wati, digest, { justification: 'importing the reviewed out-of-band resource', schedule: { kind: 'now' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.operationId).toBe('system-drift-import');
    expect(body.service).toBe('drift');
    expect(body.macd).toBe('Add');
    expect(body.targetAddress).toBe('aws_instance.oob_test01');
    expect(body.approvalLadder).toEqual(['L2', 'L3']);
    expect(body.status).toBe('AWAITING_CODE_REVIEW');
    // The audit-F1(a) pinned params contract, import member (§6): `finding`
    // is the CURRENT stored sweep row for this identity (never a client
    // value); `importPayload` is the ORIGINAL, digest-pinned reviewed bytes
    // from the stored proposal body.
    expect(body.params).toEqual({
      finding,
      importPayload: { address: 'aws_instance.oob_test01', targetFile: 'oob-adopted.tf', importBlock: IMPORT_BLOCK, skeletonHcl: SKELETON_HCL },
      diff: null,
      proposalDigest: digest,
      reportVersion: 1,
    });
    expect((body.events as Array<{ type: string; label: string }>).some((e) => e.type === 'origin' && e.label.includes(digest))).toBe(true);

    const k = driftProposalKey('acme', digest);
    const row = (await s.store.get(k.PK, k.SK)) as DriftProposalItem;
    expect(row.status).toBe('submitted');
    expect(row.requestId).toBe(body.id);
    expect(await auditActions(s.store, 'acme')).toEqual(expect.arrayContaining(['request-submit', 'drift-proposal-submitted']));
  });

  it('batch: alsoDigests folds additional IMPORT proposals into ONE change-set; every row is marked submitted (import-only batching)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const IMPORT_BLOCK_B = 'import {\n  to = aws_instance.oob_test02\n  id = "i-0oobtest0000002"\n}\n';
    const SKELETON_HCL_B = 'resource "aws_instance" "oob_test02" {\n  ami           = "ami-0123456789abcdef0"\n  instance_type = "m5.large"\n}\n';
    const findingA = importFinding();
    const findingB = importFinding({
      liveId: 'i-0oobtest0000002',
      importPayload: { address: 'aws_instance.oob_test02', targetFile: 'oob-adopted.tf', importBlock: IMPORT_BLOCK_B, skeletonHcl: SKELETON_HCL_B },
    });
    expect((await putDrift(s, token, envelope({ sweep: sweepWith([findingA, findingB]) }))).status).toBe(201);
    const digestA = digestFor('import-batch-a');
    const digestB = digestFor('import-batch-b');
    await seedImportProposal(s.store, s.dataRoot, {
      digest: digestA,
      address: 'aws_instance.oob_test01',
      arn: null,
      tfType: 'aws_instance',
      liveId: 'i-0oobtest0000001',
      targetFile: 'oob-adopted.tf',
      importBlock: IMPORT_BLOCK,
      skeletonHcl: SKELETON_HCL,
      reportVersion: 1,
    });
    await seedImportProposal(s.store, s.dataRoot, {
      digest: digestB,
      address: 'aws_instance.oob_test02',
      arn: null,
      tfType: 'aws_instance',
      liveId: 'i-0oobtest0000002',
      targetFile: 'oob-adopted.tf',
      importBlock: IMPORT_BLOCK_B,
      skeletonHcl: SKELETON_HCL_B,
      reportVersion: 1,
    });
    process.env.CCP_DRIFT_IMPORT = '1';

    const res = await submitProposal(s, s.wati, digestA, { justification: 'importing two out-of-band resources together', schedule: { kind: 'now' }, alsoDigests: [digestB] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: Array<{ targetAddress: string }>; id: string };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.targetAddress).sort()).toEqual(['aws_instance.oob_test01', 'aws_instance.oob_test02']);

    for (const digest of [digestA, digestB]) {
      const k = driftProposalKey('acme', digest);
      const row = (await s.store.get(k.PK, k.SK)) as DriftProposalItem;
      expect(row.status).toBe('submitted');
      expect(row.requestId).toBe(body.id);
    }
  });

  it('a mixed-flavor batch (import primary + adopt alsoDigest) is refused — the every-item-same-op rule extends to import', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect(
      (await putDrift(s, token, envelope({ report: { ...defaultReport(), verdicts: [benignVerdict('aws_instance.web')] }, sweep: sweepWith([importFinding()]) })))
        .status,
    ).toBe(201);
    const importDigest = digestFor('import-mix-primary');
    const adoptDigest = digestFor('import-mix-adopt');
    await seedImportProposal(s.store, s.dataRoot, {
      digest: importDigest,
      address: 'aws_instance.oob_test01',
      arn: null,
      tfType: 'aws_instance',
      liveId: 'i-0oobtest0000001',
      targetFile: 'oob-adopted.tf',
      importBlock: IMPORT_BLOCK,
      skeletonHcl: SKELETON_HCL,
      reportVersion: 1,
    });
    await seedProposal(s.store, s.dataRoot, { digest: adoptDigest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });
    process.env.CCP_DRIFT_IMPORT = '1';

    const res = await submitProposal(s, s.wati, importDigest, { justification: 'trying to smuggle an adopt into an import batch', schedule: { kind: 'now' }, alsoDigests: [adoptDigest] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('§5.3 screen 2: a finding no longer present in the CURRENT stored sweep ⇒ 422 DRIFT_NOT_ADOPTABLE (mirrors the adopt "address vanished" rule)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    // v1's sweep carries NO findings at all — the proposal below claims an
    // identity that was never (or no longer) there.
    expect((await putDrift(s, token, envelope({ sweep: sweepWith([]) }))).status).toBe(201);
    const digest = digestFor('import-vanished');
    await seedImportProposal(s.store, s.dataRoot, {
      digest,
      address: 'aws_instance.oob_ghost',
      arn: null,
      tfType: 'aws_instance',
      liveId: 'i-0ghost00000001',
      targetFile: 'oob-adopted.tf',
      importBlock: IMPORT_BLOCK,
      skeletonHcl: SKELETON_HCL,
      reportVersion: 1,
    });
    process.env.CCP_DRIFT_IMPORT = '1';

    const res = await submitProposal(s, s.wati, digest, { justification: 'importing a since-vanished finding', schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_NOT_ADOPTABLE');
  });

  it('§8 enforcement point 2: a finding re-flagged securityFamily in the CURRENT stored sweep ⇒ 422 DRIFT_NOT_ADOPTABLE, even though the pinned proposal still claims import', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    // The CURRENT report's finding is creation-security — re-derivation
    // (never the proposal's own frozen 'import' claim) must catch this.
    expect((await putDrift(s, token, envelope({ sweep: sweepWith([importFinding({ securityFamily: true })]) }))).status).toBe(201);
    const digest = digestFor('import-security-family');
    await seedImportProposal(s.store, s.dataRoot, {
      digest,
      address: 'aws_instance.oob_test01',
      arn: null,
      tfType: 'aws_instance',
      liveId: 'i-0oobtest0000001',
      targetFile: 'oob-adopted.tf',
      importBlock: IMPORT_BLOCK,
      skeletonHcl: SKELETON_HCL,
      reportVersion: 1,
    });
    process.env.CCP_DRIFT_IMPORT = '1';

    const res = await submitProposal(s, s.wati, digest, { justification: 'trying to import a since-flagged creation-security resource', schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_NOT_ADOPTABLE');
  });

  it('stale: lastSeenReportVersion lagging the served pointer ⇒ 409 DRIFT_PROPOSAL_STALE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token, envelope({ sweep: sweepWith([importFinding()]) }))).status).toBe(201); // v1
    const digest = digestFor('import-stale');
    await seedImportProposal(s.store, s.dataRoot, {
      digest,
      address: 'aws_instance.oob_test01',
      arn: null,
      tfType: 'aws_instance',
      liveId: 'i-0oobtest0000001',
      targetFile: 'oob-adopted.tf',
      importBlock: IMPORT_BLOCK,
      skeletonHcl: SKELETON_HCL,
      reportVersion: 1,
    });
    // A new report stages (v2) WITHOUT regenerating proposals (disarmed by default) — pointer moves to 2.
    expect((await putDrift(s, token, envelope({ runId: 'run-2', sweep: sweepWith([importFinding()]) }))).status).toBe(201);
    process.env.CCP_DRIFT_IMPORT = '1';

    const res = await submitProposal(s, s.wati, digest, { justification: 'importing now-stale drift', schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_STALE');
  });
});

/* ═══ L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2.5) — the
 * restore flavor's submit deltas: arming, role, batching, eligibility
 * re-derivation, pinned params — mirrors the import describe block above. ═══ */

describe('POST /projects/:id/drift/proposals/:digest/submit — flavor "restore" (L29, register 0009)', () => {
  it('disarmed (CCP_DRIFT_RESTORE unset, even though CCP_DRIFT is armed) ⇒ 409 DRIFT_DISARMED naming the restore flag', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token, envelope({ report: { ...defaultReport(), verdicts: [oobDeletionVerdict()] } }))).status).toBe(201);
    const digest = digestFor('restore-disarmed');
    await seedRestoreProposal(s.store, s.dataRoot, { digest, address: 'aws_flow_log.vpc1', reportVersion: 1 });
    // CCP_DRIFT_RESTORE is deliberately left unset — beforeEach deletes
    // it, even though CCP_DRIFT itself stays armed by default.
    const res = await submitProposal(s, s.wati, digest, { justification: 'trying to restore while the restore lane is disarmed', schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe('DRIFT_DISARMED');
    expect(body.reason).toContain('CCP_DRIFT_RESTORE');
  });

  it('role: a requester is refused 403 FORBIDDEN_ROLE; an approver succeeds 201 with the pinned {attrs:[], verdicts, diff:null, proposalDigest, reportVersion} params', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const verdict = oobDeletionVerdict('aws_flow_log.vpc1');
    expect((await putDrift(s, token, envelope({ report: { ...defaultReport(), verdicts: [verdict] } }))).status).toBe(201); // v1
    const digest = digestFor('restore-happy');
    await seedRestoreProposal(s.store, s.dataRoot, { digest, address: 'aws_flow_log.vpc1', reportVersion: 1 });
    process.env.CCP_DRIFT_RESTORE = '1';

    const asRequester = await submitProposal(s, s.nia, digest, { justification: 'a requester trying to restore a deleted resource', schedule: { kind: 'now' } });
    expect(asRequester.status).toBe(403);
    expect(((await asRequester.json()) as { code: string }).code).toBe('FORBIDDEN_ROLE');

    const res = await submitProposal(s, s.wati, digest, { justification: 'restoring the out-of-band-deleted flow log', schedule: { kind: 'now' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.operationId).toBe('system-drift-restore');
    expect(body.service).toBe('drift');
    expect(body.macd).toBe('Add');
    expect(body.targetAddress).toBe('aws_flow_log.vpc1');
    expect(body.approvalLadder).toEqual(['L2', 'L3']);
    expect(body.status).toBe('AWAITING_CODE_REVIEW');
    // F1(a)/A2 pinned params contract, restore member (L29 §2.5 — the SAME
    // shape as adopt/revert verbatim): `verdicts` is the CURRENT
    // stored-report row for this address (never the proposal body's frozen
    // copy — seedRestoreProposal's body carries `verdicts: []`, proving this
    // isn't just echoed back); `attrs` is always `[]`, `diff` always `null`.
    expect(body.params).toEqual({
      attrs: [],
      verdicts: [verdict],
      diff: null,
      proposalDigest: digest,
      reportVersion: 1,
    });
    expect((body.events as Array<{ type: string; label: string }>).some((e) => e.type === 'origin' && e.label.includes(digest))).toBe(true);

    const k = driftProposalKey('acme', digest);
    const row = (await s.store.get(k.PK, k.SK)) as DriftProposalItem;
    expect(row.status).toBe('submitted');
    expect(row.requestId).toBe(body.id);
    expect(await auditActions(s.store, 'acme')).toEqual(expect.arrayContaining(['request-submit', 'drift-proposal-submitted']));
  });

  it('batch: alsoDigests folds additional RESTORE proposals into ONE change-set; every row is marked submitted (restore-only batching)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect(
      (
        await putDrift(
          s,
          token,
          envelope({ report: { ...defaultReport(), verdicts: [oobDeletionVerdict('aws_flow_log.vpc1'), oobDeletionVerdict('aws_flow_log.vpc2')] } }),
        )
      ).status,
    ).toBe(201);
    const digestA = digestFor('restore-batch-a');
    const digestB = digestFor('restore-batch-b');
    await seedRestoreProposal(s.store, s.dataRoot, { digest: digestA, address: 'aws_flow_log.vpc1', reportVersion: 1 });
    await seedRestoreProposal(s.store, s.dataRoot, { digest: digestB, address: 'aws_flow_log.vpc2', reportVersion: 1 });
    process.env.CCP_DRIFT_RESTORE = '1';

    const res = await submitProposal(s, s.wati, digestA, { justification: 'restoring two out-of-band-deleted flow logs together', schedule: { kind: 'now' }, alsoDigests: [digestB] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: Array<{ targetAddress: string }>; id: string };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.targetAddress).sort()).toEqual(['aws_flow_log.vpc1', 'aws_flow_log.vpc2']);

    for (const digest of [digestA, digestB]) {
      const k = driftProposalKey('acme', digest);
      const row = (await s.store.get(k.PK, k.SK)) as DriftProposalItem;
      expect(row.status).toBe('submitted');
      expect(row.requestId).toBe(body.id);
    }
  });

  it('a mixed-flavor batch (restore primary + adopt alsoDigest) is refused — the every-item-same-op rule extends to restore', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect(
      (
        await putDrift(
          s,
          token,
          envelope({ report: { ...defaultReport(), verdicts: [oobDeletionVerdict('aws_flow_log.vpc1'), benignVerdict('aws_instance.web')] } }),
        )
      ).status,
    ).toBe(201);
    const restoreDigest = digestFor('restore-mix-primary');
    const adoptDigest = digestFor('restore-mix-adopt');
    await seedRestoreProposal(s.store, s.dataRoot, { digest: restoreDigest, address: 'aws_flow_log.vpc1', reportVersion: 1 });
    await seedProposal(s.store, s.dataRoot, { digest: adoptDigest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });
    process.env.CCP_DRIFT_RESTORE = '1';

    const res = await submitProposal(s, s.wati, restoreDigest, { justification: 'trying to smuggle an adopt into a restore batch', schedule: { kind: 'now' }, alsoDigests: [adoptDigest] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('§8 enforcement point 2: an address whose CURRENT stored verdict no longer classifies restore (e.g. resolved to benign_inplace) ⇒ 422 DRIFT_NOT_ADOPTABLE, even though the pinned proposal still claims restore', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    // The CURRENT report's verdict at vpc1 is now benign_inplace (drift
    // resolved differently since the restore proposal was generated) — a
    // forged/stale restore attempt must be refused, never trust the
    // proposal row's own frozen claim.
    expect((await putDrift(s, token, envelope({ report: { ...defaultReport(), verdicts: [benignVerdict('aws_flow_log.vpc1')] } }))).status).toBe(201);
    const digest = digestFor('restore-no-longer-eligible');
    await seedRestoreProposal(s.store, s.dataRoot, { digest, address: 'aws_flow_log.vpc1', reportVersion: 1 });
    process.env.CCP_DRIFT_RESTORE = '1';

    const res = await submitProposal(s, s.wati, digest, { justification: 'trying to restore an address that is no longer a deletion', schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_NOT_ADOPTABLE');
  });

  it('stale: lastSeenReportVersion lagging the served pointer ⇒ 409 DRIFT_PROPOSAL_STALE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token, envelope({ report: { ...defaultReport(), verdicts: [oobDeletionVerdict('aws_flow_log.vpc1')] } }))).status).toBe(201); // v1
    const digest = digestFor('restore-stale');
    await seedRestoreProposal(s.store, s.dataRoot, { digest, address: 'aws_flow_log.vpc1', reportVersion: 1 });
    // A new report stages (v2) WITHOUT regenerating proposals (disarmed by default) — pointer moves to 2.
    expect((await putDrift(s, token, envelope({ runId: 'run-2', report: { ...defaultReport(), verdicts: [oobDeletionVerdict('aws_flow_log.vpc1')] } }))).status).toBe(201);
    process.env.CCP_DRIFT_RESTORE = '1';

    const res = await submitProposal(s, s.wati, digest, { justification: 'restoring now-stale drift', schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_STALE');
  });
});

/* ═══ §4.3/§8 enforcement point 2b — the direct lane is closed ═══ */

describe('POST /requests — the direct lane refuses system-drift-* (§4.3/§8 enforcement point 2b)', () => {
  it('single-op: operationId system-drift-adopt ⇒ 422 DRIFT_PROPOSAL_REQUIRED', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/requests', {
      method: 'POST',
      headers: hdrs(await sessionCookieFor(store, 'sari'), { json: true }),
      body: JSON.stringify({ operationId: 'system-drift-adopt', targetAddress: 'aws_instance.web', params: {}, justification: 'x'.repeat(20), schedule: { kind: 'now' } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_REQUIRED');
  });

  it('single-op: operationId system-drift-revert ⇒ 422 DRIFT_PROPOSAL_REQUIRED', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/requests', {
      method: 'POST',
      headers: hdrs(await sessionCookieFor(store, 'budi'), { json: true }),
      body: JSON.stringify({ operationId: 'system-drift-revert', targetAddress: 'aws_security_group.sg1', params: {}, justification: 'x'.repeat(20), schedule: { kind: 'now' } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_REQUIRED');
  });

  it('single-op: operationId system-drift-import ⇒ 422 DRIFT_PROPOSAL_REQUIRED (OOB provisioning spec §6 — the direct lane stays closed for the fourth op too)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/requests', {
      method: 'POST',
      headers: hdrs(await sessionCookieFor(store, 'budi'), { json: true }),
      body: JSON.stringify({ operationId: 'system-drift-import', targetAddress: 'aws_instance.oob_test01', params: {}, justification: 'x'.repeat(20), schedule: { kind: 'now' } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_REQUIRED');
  });

  it('single-op: operationId system-drift-restore ⇒ 422 DRIFT_PROPOSAL_REQUIRED (L29, register 0009 — the direct lane stays closed for the fifth op too)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/requests', {
      method: 'POST',
      headers: hdrs(await sessionCookieFor(store, 'budi'), { json: true }),
      body: JSON.stringify({ operationId: 'system-drift-restore', targetAddress: 'aws_flow_log.vpc1', params: {}, justification: 'x'.repeat(20), schedule: { kind: 'now' } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_REQUIRED');
  });

  it('change-set: a drift op smuggled in among ordinary items ⇒ the WHOLE set is refused (atomic)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/requests', {
      method: 'POST',
      headers: hdrs(await sessionCookieFor(store, 'sari'), { json: true }),
      body: JSON.stringify({
        // The drift op is checked FIRST (per-item, in order) — proves the
        // refusal fires before any other item's validation even runs, i.e.
        // the whole set never partially validates around it.
        items: [
          { operationId: 'system-drift-adopt', targetAddress: 'aws_instance.web', params: {} },
          { operationId: 'cloudwatch-alarm-threshold', targetAddress: 'aws_cloudwatch_metric_alarm.x', params: { alarm: 'aws_cloudwatch_metric_alarm.x', new_threshold: 5 } },
        ],
        justification: 'x'.repeat(20),
        schedule: { kind: 'now' },
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_REQUIRED');
  });
});

/* ═══ end-to-end: the created request rides the EXISTING lifecycle unmodified ═══ */

describe('end-to-end: submit → approve (L2) → approve (L3) → POST /:id/apply', () => {
  it('the apply lane is intact: with the ADR-0016 bundle disarmed, apply refuses BUNDLE_DISARMED exactly like any other request', async () => {
    const s = await setup();
    await driveToReady(s); // approve/apply resolve projectId from the header, which requires 'acme' routable (ready)
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('e2e-adopt');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });

    const submitRes = await submitProposal(s, s.nia, digest, { justification: 'adopting observed drift into code, end to end', schedule: { kind: 'now' } });
    expect(submitRes.status).toBe(201);
    const req = (await submitRes.json()) as { id: string };

    // L2 — wati (approver, distinct from the requester nia).
    const a1 = await s.app.request(`/requests/${req.id}/approve`, { method: 'POST', headers: hdrs(s.wati, { json: true, project: 'acme' }) });
    expect(a1.status).toBe(200);
    expect(((await a1.json()) as { status: string }).status).not.toBe('APPLIED'); // one of two signatures in

    // L3 — root (lead, distinct from both nia and wati).
    const a2 = await s.app.request(`/requests/${req.id}/approve`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
    expect(a2.status).toBe(200);

    // CCP_BUNDLE deliberately left unset in this suite.
    const applyRes = await s.app.request(`/requests/${req.id}/apply`, { method: 'POST', headers: hdrs(s.root, { json: true, project: 'acme' }) });
    expect(applyRes.status).toBe(409);
    expect(((await applyRes.json()) as { code: string }).code).toBe('BUNDLE_DISARMED');
  });
});

/* ═══ F7 (LOW) — prototype-safe class lookups, independent of the shared fixture ═══ */

describe('F7 (LOW) — classifyByFields uses Object.hasOwn, never the `in` operator', () => {
  const shapeless = { riskTier: 'low', actions: ['update'], forceNewAttrs: [], driftEvidence: true, changedAttrs: [], securityHits: [] };

  it('class "__proto__" is unknown-and-ungenerable, not silently treated as a known class via prototype lookup', () => {
    const result = classifyByFields({ ...shapeless, class: '__proto__' });
    expect(result.bucket).toBe('ungenerable');
    expect(result.reason).toBe('unknown class "__proto__" — fail-closed, needs-human (the eleven-class D1-D11 enum is closed)');
  });

  it('other Object.prototype-inherited names (constructor, toString, hasOwnProperty, __defineGetter__) are ALSO unknown', () => {
    for (const hostile of ['constructor', 'toString', 'hasOwnProperty', '__defineGetter__', 'valueOf']) {
      const result = classifyByFields({ ...shapeless, class: hostile });
      expect(result.bucket, hostile).toBe('ungenerable');
      expect(result.reason, hostile).toContain(`unknown class ${JSON.stringify(hostile)}`);
    }
  });

  it('a REAL known class (benign_inplace) is unaffected by the Object.hasOwn switch', () => {
    const v = { ...shapeless, class: 'benign_inplace', changedAttrs: [{ path: 'tags.Owner', sensitive: false, liveJson: 'x' }] };
    expect(classifyByFields(v).bucket).toBe('adopt');
  });
});

/* ═══ F8/A4 — structured path segments (direct unit tests; the shared fixture
 * already covers the pinned examples once Lane A's A1 lands) ═══ */

describe('F8/A4 — classifyByFields is pathSegments-aware (direct, independent of the shared fixture)', () => {
  function adoptableVerdict(changedAttrs: Array<Record<string, unknown>>): ClassifiableVerdict {
    return { class: 'benign_inplace', riskTier: 'low', actions: ['update'], forceNewAttrs: [], driftEvidence: true, securityHits: [], changedAttrs } as unknown as ClassifiableVerdict;
  }

  it('a dotted/slashed tag key (pathSegments: [tags, "kubernetes.io/role/elb"]) is adopt-expressible — unlocked by F8', () => {
    const v = adoptableVerdict([{ path: 'tags.kubernetes.io/role/elb', sensitive: false, liveJson: 'owned', pathSegments: ['tags', 'kubernetes.io/role/elb'] }]);
    expect(classifyByFields(v).bucket).toBe('adopt');
  });

  it('a single-instance nested-block leaf (pathSegments: [root_block_device, 0, volume_size]) is adopt-expressible — W1', () => {
    const v = adoptableVerdict([{ path: 'root_block_device[0].volume_size', sensitive: false, liveJson: 100, pathSegments: ['root_block_device', 0, 'volume_size'] }]);
    expect(classifyByFields(v).bucket).toBe('adopt');
  });

  it('the SAME nested-block leaf at a non-zero index is refused — ambiguous, never guessed', () => {
    const v = adoptableVerdict([{ path: 'root_block_device[1].volume_size', sensitive: false, liveJson: 100, pathSegments: ['root_block_device', 1, 'volume_size'] }]);
    expect(classifyByFields(v).bucket).toBe('ungenerable');
  });

  it('an empty pathSegments array is MALFORMED — never expressible, regardless of what the display path alone would allow', () => {
    const v = adoptableVerdict([{ path: 'tags.Owner', sensitive: false, liveJson: 'x', pathSegments: [] }]);
    expect(classifyByFields(v).bucket).toBe('ungenerable');
  });

  it('pathSegments: null is treated the SAME as absent (legacy fallback) — matches Go NormalizeSegments([]any), whose nil slice cannot tell "absent" from "explicit null" apart', () => {
    const withNull = adoptableVerdict([{ path: 'tags.Owner', sensitive: false, liveJson: 'x', pathSegments: null }]);
    const withoutKey = adoptableVerdict([{ path: 'tags.Owner', sensitive: false, liveJson: 'x' }]);
    expect(classifyByFields(withNull)).toEqual(classifyByFields(withoutKey));
    expect(classifyByFields(withNull).bucket).toBe('adopt');
  });

  it('absent pathSegments (legacy envelope) falls back to the pre-F8 <=2-part, no-bracket rule unchanged', () => {
    const plainTag = adoptableVerdict([{ path: 'tags.Owner', sensitive: false, liveJson: 'x' }]);
    expect(classifyByFields(plainTag).bucket).toBe('adopt');
    const bracketed = adoptableVerdict([{ path: 'ingress[0].cidr_blocks', sensitive: false, liveJson: ['x'] }]);
    expect(classifyByFields(bracketed).bucket).toBe('ungenerable');
  });
});

/* ═══ F6/A8 — submit RE-CHECK folds ALL verdicts per address (no last-wins map) ═══ */

describe('F6/A8 — foldVerdictsByAddress / addressEligibleFor (unit) + the submit route end-to-end', () => {
  it('foldVerdictsByAddress preserves every row for a repeated address (never last-wins)', () => {
    const v1 = benignVerdict('aws_instance.web');
    const v2 = securityVerdict('aws_instance.web'); // SAME address, a security twin
    const byAddress = foldVerdictsByAddress([v1, v2] as never);
    expect(byAddress.get('aws_instance.web')).toHaveLength(2);
  });

  it('addressEligibleFor: an address is adopt-eligible ONLY if EVERY verdict for it classifies adopt — a security twin refuses the whole address', () => {
    const byAddress = foldVerdictsByAddress([benignVerdict('aws_instance.web'), securityVerdict('aws_instance.web')] as never);
    expect(addressEligibleFor(byAddress, 'aws_instance.web', 'adopt')).toBe(false);
    expect(addressEligibleFor(byAddress, 'aws_instance.web', 'revert')).toBe(false); // the benign twin blocks revert too
  });

  it('addressEligibleFor: an address with NO verdicts is never eligible for anything', () => {
    const byAddress = foldVerdictsByAddress([]);
    expect(addressEligibleFor(byAddress, 'aws_instance.ghost', 'adopt')).toBe(false);
  });

  it('end-to-end: a duplicate-address STORED report (pre-fix shape — ingest now refuses new ones) refuses adopt submit for the whole address, 422 DRIFT_NOT_ADOPTABLE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // v1, establishes the pointer

    // Hand-write a duplicate-address stored report directly — simulates a
    // report staged before the F6/A8 ingest refusal existed (or ANY other
    // path that could produce one); the submit-time fold is the
    // belt-and-braces defense this proves.
    const dupReport = envelope({
      report: { ...defaultReport(), verdicts: [benignVerdict('aws_instance.web'), securityVerdict('aws_instance.web')] },
    });
    writeFileSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'), `${JSON.stringify(dupReport, null, 2)}\n`);

    const digest = digestFor('fold-security-twin');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });

    const res = await submitProposal(s, s.nia, digest, { justification: 'trying to adopt an address that also carries a security twin', schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_NOT_ADOPTABLE');
  });
});

/* ═══ F10 (LOW) — readDriftProposalBody schema-validates; corrupt body ⇒ fail-closed, never a 500 ═══ */

describe('F10 (LOW) — readDriftProposalBody validation', () => {
  it('a well-formed body round-trips; a corrupt one on disk returns null (never throws)', async () => {
    const s = await setup();
    const digest = digestFor('read-proposal-body-direct');
    await writeDriftProposalBody(s.dataRoot, 'acme', digest, {
      digest,
      flavor: 'adopt',
      addresses: ['aws_instance.web'],
      attrs: [{ address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'a', codeJson: 'b' }],
      diff: '--- a/x\n+++ b/x\n',
      requestSkeleton: { items: [{ operationId: 'system-drift-adopt', targetAddress: 'aws_instance.web', params: { attrs: [], proposalDigest: digest, reportVersion: 1 } }] },
      verdicts: [],
    });
    expect(readDriftProposalBody(s.dataRoot, 'acme', digest)).not.toBeNull();

    const bodyPath = join(s.dataRoot, 'acme', 'drift', 'proposals', `${digest}.json`);
    writeFileSync(bodyPath, JSON.stringify({ not: 'a valid proposal doc' }));
    expect(readDriftProposalBody(s.dataRoot, 'acme', digest)).toBeNull();

    writeFileSync(bodyPath, '{not even valid json');
    expect(readDriftProposalBody(s.dataRoot, 'acme', digest)).toBeNull();
  });

  it('end-to-end: a corrupt stored proposal body ⇒ submit refuses 422 DRIFT_NOT_ADOPTABLE, never a 500', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('corrupt-body-submit');
    await seedProposal(s.store, s.dataRoot, { digest, flavor: 'adopt', address: 'aws_instance.web', path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform', reportVersion: 1 });

    // Corrupt the on-disk body: `diff` becomes a number, which the schema
    // requires be `string | null` — a stand-in for a truncated/hand-edited
    // file. The row's own metadata (status/lastSeenReportVersion) is
    // untouched — only the BODY is corrupt.
    const bodyPath = join(s.dataRoot, 'acme', 'drift', 'proposals', `${digest}.json`);
    const raw = JSON.parse(readFileSync(bodyPath, 'utf8')) as Record<string, unknown>;
    raw.diff = 12345;
    writeFileSync(bodyPath, JSON.stringify(raw));

    const res = await submitProposal(s, s.nia, digest, { justification: 'submitting over a corrupt stored proposal body', schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_NOT_ADOPTABLE');
  });
});
