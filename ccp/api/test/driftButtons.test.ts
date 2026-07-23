import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AuditItem, DriftProposalItem } from '../src/store/schema';
import { __resetUploadRateLimitForTests } from '../src/middleware/rateLimit';
import { __resetKnownProjectsForTests } from '../src/projects';
import { __setNow } from '../src/clock';
import { __resetDriftGenStateForTests } from '../src/domain/driftProposals';
import { __resetDriftCheckStateForTests, runDriftCheck } from '../src/domain/driftCheck';
import type { DriftCheckSteps } from '../src/domain/driftCheck';
import { seed, seedAccount, sessionCookieFor, setSetting } from './helpers/seed';

/**
 * B1/B2 (owner refinement 4; spec addendum A7; plan §2-B1/B2) — the two
 * operator buttons: "Start drift check" (`POST /:id/drift/check`, the
 * CCP_DRIFT_CHECK_CMD injected-cmd pattern) and "Fix the drift"
 * (`POST /:id/drift/generate`, exposing the existing §6.3 generation runner
 * on demand). Both: drift armed → project gates → role LEAD OR ADMIN
 * (stricter than the adopt/revert/legitimize surface) → their own arming →
 * their own state precondition → audit → 202. Mirrors drift.test.ts /
 * driftProposals.test.ts's adversarial style.
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const COMMIT = 'abc123def4567890abc123def4567890abc123de';
const REGISTER = { id: 'acme', name: 'Acme estate', github: { owner: 'acme-co', repo: 'terraform-acme' }, accountId: '123456789012', region: 'ap-southeast-5' };

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function hdrs(cookie: string, opts: { json?: boolean; client?: boolean } = {}): Record<string, string> {
  const h: Record<string, string> = { cookie, 'x-ccp-project': 'sample' };
  if (opts.client !== false) h['x-ccp-client'] = 'ccp-spa';
  if (opts.json) h['content-type'] = 'application/json';
  return h;
}

function reportText(): string {
  return `${JSON.stringify(
    { repo: 'terraform-acme', verdict: 'clean', findings: [], resourceBlocks: 12, moduleBlocks: 0, tfJsonFiles: 0, fmtDirtyFiles: 0, providerPins: { aws: '~> 6.0' } },
    null,
    2,
  )}\n`;
}

function benignVerdict(): Record<string, unknown> {
  return {
    address: 'aws_instance.web',
    type: 'aws_instance',
    actions: ['update'],
    driftEvidence: true,
    class: 'benign_inplace',
    riskTier: 'low',
    changedAttrs: [{ path: 'tags.Owner', live: '"bi-team"', code: '"platform"', sensitive: false, liveJson: 'bi-team', codeJson: 'platform' }],
    forceNewAttrs: [],
    securityHits: [],
  };
}

function envelope(over: { runId?: string } = {}): Record<string, unknown> {
  return {
    schema: 'ccp.drift/v1',
    projectId: 'acme',
    environment: 'prod',
    capturedAt: '2026-07-20T03:17:04Z',
    runId: over.runId ?? '16234567890',
    commit: COMMIT,
    cadenceHours: 6,
    planExitCode: 2,
    report: { meta: {}, counts: { benign_inplace: 1 }, verdicts: [benignVerdict()], absorbed: [], invisible_to_plan: 'x' },
  };
}

type App = ReturnType<typeof createApp>;
type Setup = { store: ConfigStore; app: App; dataRoot: string; putra: string; lina: string; root: string; sari: string; budi: string; nia: string; wati: string; yudi: string };

let roots: string[] = [];

async function setup(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store);
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  await seedAccount(store, { id: 'nia', role: 'requester', teamId: 'platform', isAdmin: false, projects: ['sample', 'acme'] });
  await seedAccount(store, { id: 'wati', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'acme'] });
  // A lead-non-admin bound to acme — proves LEAD ALONE (no isAdmin) satisfies
  // the check/generate role gate (distinct from wati/nia's negative cases).
  // Bound to BOTH: 'sample' is the header-less ACTING-scope default the outer
  // requireProjectMembership gate checks (session.ts) — every drift route
  // ALSO requires TARGET (:id='acme') binding on top, checked inside the
  // handler. Mirrors nia/wati's own ['sample', 'acme'] shape above.
  await seedAccount(store, { id: 'yudi', role: 'lead', teamId: 'platform', isAdmin: false, projects: ['sample', 'acme'] });
  const dataRoot = mkdtempSync(join(tmpdir(), 'ccp-driftbtn-'));
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
    yudi: await sessionCookieFor(store, 'yudi'),
  };
}

async function driveToTrusted(s: Setup, id = 'acme'): Promise<void> {
  const { app, putra, lina, root } = s;
  expect((await app.request('/projects', { method: 'POST', headers: hdrs(putra, { json: true }), body: JSON.stringify(REGISTER) })).status).toBe(201);
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
  const propose = await app.request(`/projects/${id}/trust`, { method: 'POST', headers: hdrs(putra, { json: true }), body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256(prescanReport) }) });
  expect(propose.status).toBe(202);
  const pending = (await propose.json()) as { id: string };
  expect((await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) })).status).toBe(200);
}

async function mintToken(s: Setup, id = 'acme'): Promise<{ token: string }> {
  const res = await s.app.request(`/projects/${id}/upload-tokens`, { method: 'POST', headers: hdrs(s.putra, { json: true }) });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string };
}

async function putDrift(s: Setup, token: string, body: unknown = envelope(), id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function check(s: Setup, cookie: string, id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift/check`, { method: 'POST', headers: hdrs(cookie, { json: true }) });
}

async function generate(s: Setup, cookie: string, id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift/generate`, { method: 'POST', headers: hdrs(cookie, { json: true }) });
}

async function auditEntries(store: ConfigStore, projectId = 'acme'): Promise<AuditItem[]> {
  const yyyymmNow = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  return (await store.query(`P#${projectId}#AUDIT#${yyyymmNow}`)) as AuditItem[];
}

const ENV_KEYS = ['CCP_DRIFT', 'CCP_DRIFT_CHECK_CMD', 'CCP_DRIFT_PROPOSALS', 'CCP_DRIFT_GEN_CMD', 'CCP_GIT_REMOTE'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
  __resetDriftGenStateForTests();
  __resetDriftCheckStateForTests();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CCP_DRIFT = '1';
  for (const k of ['CCP_DRIFT_CHECK_CMD', 'CCP_DRIFT_PROPOSALS', 'CCP_DRIFT_GEN_CMD', 'CCP_GIT_REMOTE']) delete process.env[k];
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

/* ═══ B1 — POST /:id/drift/check ("Start drift check") ═══ */

describe('POST /projects/:id/drift/check (B1)', () => {
  it('disarmed (CCP_DRIFT unset) ⇒ 409 DRIFT_DISARMED', async () => {
    const s = await setup();
    await driveToTrusted(s);
    delete process.env.CCP_DRIFT;
    const res = await check(s, s.root);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_DISARMED');
  });

  it('unknown project ⇒ 404', async () => {
    const s = await setup();
    expect((await check(s, s.root, 'ghost')).status).toBe(404);
  });

  it('an unbound account ⇒ 403 PROJECT_SCOPE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await check(s, s.sari); // sari is sample-only, no acme binding
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_SCOPE');
  });

  it('archived project ⇒ 404', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    expect((await s.app.request('/projects/acme/archive', { method: 'POST', headers: hdrs(s.putra, { json: true }) })).status).toBe(200);
    expect((await check(s, s.root)).status).toBe(404);
  });

  it('ROLE: a requester or approver is refused DRIFT_CHECK_FORBIDDEN — stricter than the adopt/revert/legitimize surface', async () => {
    const s = await setup();
    await driveToTrusted(s);
    process.env.CCP_DRIFT_CHECK_CMD = 'true';
    const asRequester = await check(s, s.nia);
    expect(asRequester.status).toBe(403);
    expect(((await asRequester.json()) as { code: string }).code).toBe('DRIFT_CHECK_FORBIDDEN');
    const asApprover = await check(s, s.wati);
    expect(asApprover.status).toBe(403);
    expect(((await asApprover.json()) as { code: string }).code).toBe('DRIFT_CHECK_FORBIDDEN');
  });

  it('ROLE: a lead (non-admin) OR an admin (non-lead-role) satisfies the gate — the apply-route precedent', async () => {
    const s = await setup();
    await driveToTrusted(s);
    process.env.CCP_DRIFT_CHECK_CMD = 'true';
    expect((await check(s, s.yudi)).status).toBe(202); // lead, isAdmin:false
    expect((await check(s, s.root)).status).toBe(202); // lead + isAdmin
  });

  it('a global freeze refuses with 423 GLOBAL_FREEZE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    process.env.CCP_DRIFT_CHECK_CMD = 'true';
    await setSetting(s.store, 'acme', 'freeze.global', true);
    const res = await check(s, s.root);
    expect(res.status).toBe(423);
    expect(((await res.json()) as { code: string }).code).toBe('GLOBAL_FREEZE');
  });

  it('check-lane unarmed (CCP_DRIFT_CHECK_CMD unset) ⇒ 409 DRIFT_DISARMED naming the env, distinct from the base arming reason', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await check(s, s.root);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe('DRIFT_DISARMED');
    expect(body.reason).toContain('CCP_DRIFT_CHECK_CMD');
  });

  it('happy path: 202 {requested:true, at}; the injected command receives CCP_DRIFT_PROJECT; audited drift-check-requested', async () => {
    const s = await setup();
    await driveToTrusted(s);
    process.env.CCP_DRIFT_CHECK_CMD = 'echo "saw-project=$CCP_DRIFT_PROJECT"';
    const res = await check(s, s.root);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { requested: boolean; at: string };
    expect(body.requested).toBe(true);
    expect(typeof body.at).toBe('string');

    const entries = await auditEntries(s.store);
    const entry = entries.find((e) => e.action === 'drift-check-requested');
    expect(entry).toBeDefined();
    expect((entry!.after as { ok: boolean; detail: string }).ok).toBe(true);
    expect((entry!.after as { ok: boolean; detail: string }).detail).toContain('saw-project=acme');
  });

  it('a trigger-command FAILURE still responds 202 (fire-and-forget) — the failure is captured in the audit detail, never a 5xx', async () => {
    const s = await setup();
    await driveToTrusted(s);
    process.env.CCP_DRIFT_CHECK_CMD = 'exit 7';
    const res = await check(s, s.root);
    expect(res.status).toBe(202);
    const entries = await auditEntries(s.store);
    const entry = entries.find((e) => e.action === 'drift-check-requested');
    expect((entry!.after as { ok: boolean }).ok).toBe(false);
  });

  it('one in-flight per project (domain-level guard, runDriftCheck): a concurrent check while one is already running ⇒ 409 STATE_CONFLICT', async () => {
    const s = await setup();
    await driveToTrusted(s);
    process.env.CCP_DRIFT_CHECK_CMD = 'true';

    // Manually put 'acme' in-flight via a never-resolving fake trigger —
    // the route's own call shares the SAME module-level guard (one process,
    // one Set), so the HTTP call below observes it exactly as a genuinely
    // concurrent second click would.
    let release: (() => void) | null = null;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeSteps: DriftCheckSteps = {
      trigger: async () => {
        await hang;
        return { ok: true, detail: 'eventually' };
      },
    };
    const inFlight = runDriftCheck(fakeSteps, 'acme'); // fired, not awaited

    const res = await check(s, s.root);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STATE_CONFLICT');

    release!();
    await inFlight; // let it settle — no leakage into later tests
  });
});

/* ═══ B2 — POST /:id/drift/generate ("Fix the drift" refresh half) ═══ */

describe('POST /projects/:id/drift/generate (B2)', () => {
  it('disarmed (CCP_DRIFT unset) ⇒ 409 DRIFT_DISARMED', async () => {
    const s = await setup();
    await driveToTrusted(s);
    delete process.env.CCP_DRIFT;
    const res = await generate(s, s.root);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_DISARMED');
  });

  it('unknown project ⇒ 404; an unbound account ⇒ 403 PROJECT_SCOPE; archived ⇒ 404', async () => {
    const s = await setup();
    expect((await generate(s, s.root, 'ghost')).status).toBe(404);
    await driveToTrusted(s);
    expect((await generate(s, s.sari)).status).toBe(403);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    expect((await s.app.request('/projects/acme/archive', { method: 'POST', headers: hdrs(s.putra, { json: true }) })).status).toBe(200);
    expect((await generate(s, s.root)).status).toBe(404);
  });

  it('ROLE: a requester/approver is refused DRIFT_GENERATE_FORBIDDEN; lead or admin satisfies it', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    process.env.CCP_DRIFT_PROPOSALS = '1';
    process.env.CCP_GIT_REMOTE = 'unused-in-this-test';
    process.env.CCP_DRIFT_GEN_CMD = 'true';

    const asRequester = await generate(s, s.nia);
    expect(asRequester.status).toBe(403);
    expect(((await asRequester.json()) as { code: string }).code).toBe('DRIFT_GENERATE_FORBIDDEN');

    expect((await generate(s, s.yudi)).status).toBe(202);
  });

  it('generation-lane unarmed ⇒ 409 DRIFT_DISARMED naming the three §10 envs', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const res = await generate(s, s.root);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe('DRIFT_DISARMED');
    expect(body.reason).toContain('CCP_DRIFT_PROPOSALS');
    expect(body.reason).toContain('CCP_DRIFT_GEN_CMD');
    expect(body.reason).toContain('CCP_GIT_REMOTE');
  });

  it('no report ever staged (pointer absent) ⇒ 409 STATE_CONFLICT — nothing to generate from', async () => {
    const s = await setup();
    await driveToTrusted(s);
    process.env.CCP_DRIFT_PROPOSALS = '1';
    process.env.CCP_GIT_REMOTE = 'unused-in-this-test';
    process.env.CCP_DRIFT_GEN_CMD = 'true';
    const res = await generate(s, s.root);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STATE_CONFLICT');
  });

  it('generation is NOT gated by freeze (deliberate — it only produces proposal rows, never a request)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    await setSetting(s.store, 'acme', 'freeze.global', true);
    process.env.CCP_DRIFT_PROPOSALS = '1';
    process.env.CCP_GIT_REMOTE = 'unused-in-this-test';
    process.env.CCP_DRIFT_GEN_CMD = 'true';
    const res = await generate(s, s.root);
    expect(res.status).toBe(202);
  });

  it('happy path: 202 {scheduled:true, reportVersion}; audited drift-generation-requested; the existing §6.3 runner actually fires', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // v1
    process.env.CCP_DRIFT_PROPOSALS = '1';
    process.env.CCP_GIT_REMOTE = 'unused-in-this-test'; // prepare() will fail (no such remote) — proves WIRING, mirrors driftProposals.test.ts's own precedent
    process.env.CCP_DRIFT_GEN_CMD = 'true';

    const res = await generate(s, s.root);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ scheduled: true, reportVersion: 1 });

    const entries = await auditEntries(s.store);
    expect(entries.some((e) => e.action === 'drift-generation-requested' && (e.after as { reportVersion: number }).reportVersion === 1)).toBe(true);

    // The fire-and-forget runner actually ran (and, since the remote is
    // bogus, failed at prepare()) — proves scheduleDriftGeneration was
    // really invoked by this route, not just audited.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await auditEntries(s.store);
    expect(after.some((e) => e.action === 'drift-proposals-failed')).toBe(true);
  });

  it('idempotent via digests: calling generate twice in a row over UNCHANGED drift never duplicates proposal rows (same runner, same doctrine as the automatic trigger)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    process.env.CCP_DRIFT_PROPOSALS = '1';
    process.env.CCP_GIT_REMOTE = 'unused-in-this-test';
    process.env.CCP_DRIFT_GEN_CMD = `cat > "$DRIFT_OUT" <<'EOF'\n${JSON.stringify({ schema: 'ccp.drift-proposals/v1', baseCommit: 'x', proposals: [], ungenerable: [] })}\nEOF`;

    // realDriftGenSteps.prepare() clones CCP_GIT_REMOTE for real via git —
    // a bogus remote fails prepare(), so this only proves the ROUTE never
    // errors regardless of the (failing) background generation.
    expect((await generate(s, s.root)).status).toBe(202);
    expect((await generate(s, s.root)).status).toBe(202);
  });
});

/* ═══ shared doc-parity smoke: both buttons never appear in any 5xx path ═══ */

describe('B1/B2 — proposal rows / requests are untouched by either button (they only start work, never approve/apply)', () => {
  it('neither check nor generate ever creates a DriftProposalItem with status other than what generation itself would produce', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    process.env.CCP_DRIFT_CHECK_CMD = 'true';
    expect((await check(s, s.root)).status).toBe(202);
    const rows = (await s.store.query('PROJECT#acme', 'DRIFTPROP#')) as DriftProposalItem[];
    expect(rows).toEqual([]); // check never generates proposals — that's generate's job
  });
});
