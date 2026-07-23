import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { seed, seedAccount, sessionCookieFor, setSetting } from './helpers/seed';
import { writeDriftProposalBody } from '../src/domain/driftProposals';
import type { DriftProposalDoc } from '../src/domain/driftProposals';

/**
 * C2 (owner refinement 3; spec addendum A6; plan §2-C2) — the legitimize
 * front door: `system-drift-legitimize` (engineer_only exposure) +
 * `POST /projects/:id/drift/security/:digest/legitimize`. From a
 * security-posture drift row the operator may REVERT (unchanged,
 * routes/drift.ts submit) or LEGITIMIZE — a justified emergency change
 * converged into code via a full-scrutiny engineer-tier request. Mirrors
 * driftProposals.test.ts's style (adversarial, mirrors drift.test.ts).
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const digestFor = (label: string): string => sha256(`legitimize-fixture-independent-test-digest:${label}`);

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

function reportText(): string {
  return `${JSON.stringify(
    { repo: 'terraform-acme', verdict: 'clean', findings: [], resourceBlocks: 12, moduleBlocks: 0, tfJsonFiles: 0, fmtDirtyFiles: 0, providerPins: { aws: '~> 6.0' } },
    null,
    2,
  )}\n`;
}

function securityVerdict(address = 'aws_security_group.sg1'): Record<string, unknown> {
  return {
    address,
    type: 'aws_security_group',
    actions: ['update'],
    actionReason: null,
    driftEvidence: true,
    class: 'security_posture',
    riskTier: 'high',
    changedAttrs: [{ path: 'ingress[0].cidr_blocks', live: '["0.0.0.0/0"]', code: '["10.0.0.0/16"]', sensitive: false, liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'] }],
    forceNewAttrs: [],
    securityHits: [{ path: 'ingress', why: 'network reachability' }],
    computedUnknown: [],
    notes: [],
    recommendation: 'revert to code (security posture) — never adopt',
    neverDo: 'never adopt a security-posture change',
    executor: 'gated apply, revert-only',
  };
}

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
  };
}

type DriftReportOverride = { meta?: Record<string, unknown>; counts?: Record<string, unknown>; verdicts?: unknown[]; absorbed?: unknown[]; invisible_to_plan?: string };

function defaultReport(): DriftReportOverride {
  return { meta: {}, counts: { security_posture: 1 }, verdicts: [securityVerdict()], absorbed: [], invisible_to_plan: 'out-of-band CREATED resources are invisible to this alarm' };
}

function envelope(
  over: { projectId?: string; environment?: string; capturedAt?: string; runId?: string; commit?: string; cadenceHours?: number; planExitCode?: 0 | 2; report?: DriftReportOverride } = {},
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
  };
}

/** Directly seed a REVERT proposal row + its on-disk body (bypasses
 * generation) — the shape `POST .../security/:digest/legitimize` expects
 * `:digest` to name. */
async function seedRevertProposal(
  store: ConfigStore,
  dataRoot: string,
  opts: { digest: string; address: string; path: string; liveJson: unknown; codeJson: unknown; reportVersion: number; status?: 'open' | 'submitted' | 'superseded' },
): Promise<void> {
  const id = 'acme';
  const attrs = [{ address: opts.address, path: opts.path, liveJson: opts.liveJson, codeJson: opts.codeJson }];
  const body: DriftProposalDoc = {
    digest: opts.digest,
    flavor: 'revert',
    addresses: [opts.address],
    attrs,
    diff: null,
    requestSkeleton: { items: [{ operationId: 'system-drift-revert', targetAddress: opts.address, params: { attrs, proposalDigest: opts.digest, reportVersion: 0 } }] },
    verdicts: [],
  };
  await writeDriftProposalBody(dataRoot, id, opts.digest, body);
  const key = driftProposalKey(id, opts.digest);
  const row: DriftProposalItem = {
    ...key,
    projectId: id,
    digest: opts.digest,
    flavor: 'revert',
    status: opts.status ?? 'open',
    addresses: [opts.address],
    attrCount: attrs.length,
    firstReportVersion: opts.reportVersion,
    lastSeenReportVersion: opts.reportVersion,
    baseCommit: 'deadbeefcafe',
    generatedAt: '2026-07-20T03:17:04Z',
  };
  await store.put(row as never);
}

/** Directly seed an ADOPT proposal row (wrong flavor for legitimize). */
async function seedAdoptProposal(store: ConfigStore, dataRoot: string, opts: { digest: string; address: string; reportVersion: number }): Promise<void> {
  const id = 'acme';
  const attrs = [{ address: opts.address, path: 'tags.Owner', liveJson: 'a', codeJson: 'b' }];
  const body: DriftProposalDoc = {
    digest: opts.digest,
    flavor: 'adopt',
    addresses: [opts.address],
    attrs,
    diff: '--- a/x\n+++ b/x\n',
    requestSkeleton: { items: [{ operationId: 'system-drift-adopt', targetAddress: opts.address, params: { attrs, proposalDigest: opts.digest, reportVersion: 0 } }] },
    verdicts: [],
  };
  await writeDriftProposalBody(dataRoot, id, opts.digest, body);
  const key = driftProposalKey(id, opts.digest);
  const row: DriftProposalItem = {
    ...key,
    projectId: id,
    digest: opts.digest,
    flavor: 'adopt',
    status: 'open',
    addresses: [opts.address],
    attrCount: attrs.length,
    firstReportVersion: opts.reportVersion,
    lastSeenReportVersion: opts.reportVersion,
    baseCommit: 'deadbeefcafe',
    generatedAt: '2026-07-20T03:17:04Z',
  };
  await store.put(row as never);
}

type App = ReturnType<typeof createApp>;
type Setup = { store: ConfigStore; app: App; dataRoot: string; putra: string; lina: string; root: string; sari: string; budi: string; nia: string; wati: string };

let roots: string[] = [];

async function setup(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store);
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  await seedAccount(store, { id: 'nia', role: 'requester', teamId: 'platform', isAdmin: false, projects: ['sample', 'acme'] });
  await seedAccount(store, { id: 'wati', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'acme'] });
  const dataRoot = mkdtempSync(join(tmpdir(), 'ccp-driftlegit-'));
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

async function mintToken(s: Setup, id = 'acme'): Promise<{ tokenId: string; token: string; expiresAt: string }> {
  const res = await s.app.request(`/projects/${id}/upload-tokens`, { method: 'POST', headers: hdrs(s.putra, { json: true }) });
  expect(res.status).toBe(201);
  return (await res.json()) as { tokenId: string; token: string; expiresAt: string };
}

async function putDrift(s: Setup, token: string, body: unknown = envelope(), id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function legitimize(s: Setup, cookie: string, digest: string, body: Record<string, unknown>, id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift/security/${digest}/legitimize`, { method: 'POST', headers: hdrs(cookie, { json: true }), body: JSON.stringify(body) });
}

async function auditActions(store: ConfigStore, projectId = 'acme'): Promise<string[]> {
  const yyyymmNow = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const items = (await store.query(`P#${projectId}#AUDIT#${yyyymmNow}`)) as AuditItem[];
  return items.map((i) => i.action);
}

const JUSTIFICATION = 'Emergency SG rule opened 2026-07-20 03:00 UTC to restore connectivity during the incident; CloudTrail capture attached, actor sri-oncall.';

const ENV_KEYS = ['CCP_DRIFT'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CCP_DRIFT = '1';
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

describe('POST /projects/:id/drift/security/:digest/legitimize (C2)', () => {
  it('disarmed (CCP_DRIFT unset) ⇒ 409 DRIFT_DISARMED', async () => {
    const s = await setup();
    await driveToTrusted(s);
    delete process.env.CCP_DRIFT;
    const res = await legitimize(s, s.wati, digestFor('irrelevant'), { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_DISARMED');
  });

  it('an unbound account (not a member of the target project) ⇒ 403 PROJECT_SCOPE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    // sari is sample-only (legacy row, no acme binding).
    const res = await legitimize(s, s.sari, digestFor('irrelevant'), { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_SCOPE');
  });

  it('a plain requester is refused 403 FORBIDDEN_ROLE — the same tier as revert submit', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await legitimize(s, s.nia, digestFor('irrelevant'), { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN_ROLE');
  });

  it('unknown digest ⇒ 404', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await legitimize(s, s.wati, digestFor('never-generated'), { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(404);
  });

  it('a digest naming an ADOPT-flavored proposal (wrong flavor for this door) ⇒ 404', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token, envelope({ report: { ...defaultReport(), verdicts: [benignVerdict()] } }))).status).toBe(201);
    const digest = digestFor('wrong-flavor');
    await seedAdoptProposal(s.store, s.dataRoot, { digest, address: 'aws_instance.web', reportVersion: 1 });
    const res = await legitimize(s, s.wati, digest, { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(404);
  });

  it('a justification under 40 chars ⇒ 422 VALIDATION_FAILED', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('short-justification');
    await seedRevertProposal(s.store, s.dataRoot, { digest, address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });
    const res = await legitimize(s, s.wati, digest, { justification: 'too short to cite the emergency', schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('stale: lastSeenReportVersion lagging the served pointer ⇒ 409 DRIFT_PROPOSAL_STALE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // v1
    const digest = digestFor('stale-pointer');
    await seedRevertProposal(s.store, s.dataRoot, { digest, address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });
    expect((await putDrift(s, token, envelope({ runId: 'run-2' }))).status).toBe(201); // v2 moves the pointer

    const res = await legitimize(s, s.wati, digest, { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_STALE');
  });

  it('a superseded (not open) proposal ⇒ 409 DRIFT_PROPOSAL_STALE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('superseded');
    await seedRevertProposal(s.store, s.dataRoot, { digest, address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1, status: 'superseded' });
    const res = await legitimize(s, s.wati, digest, { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_STALE');
  });

  it('§4.5-generalized enforcement: eligibility RE-DERIVED — an address that is no longer security-posture in the STORED report ⇒ 422 DRIFT_NOT_ADOPTABLE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    // The CURRENT stored report's verdict at sg1 is now BENIGN (drift
    // resolved differently since the revert proposal was generated) — a
    // forged/stale legitimize attempt must be refused, never trust the
    // proposal row's own frozen claim.
    expect((await putDrift(s, token, envelope({ report: { ...defaultReport(), verdicts: [benignVerdict('aws_security_group.sg1')] } }))).status).toBe(201);
    const digest = digestFor('no-longer-security');
    await seedRevertProposal(s.store, s.dataRoot, { digest, address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });
    const res = await legitimize(s, s.wati, digest, { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_NOT_ADOPTABLE');
  });

  it('a global freeze refuses with 423 GLOBAL_FREEZE', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('frozen');
    await seedRevertProposal(s.store, s.dataRoot, { digest, address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });
    await setSetting(s.store, 'acme', 'freeze.global', true);
    const res = await legitimize(s, s.wati, digest, { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(423);
    expect(((await res.json()) as { code: string }).code).toBe('GLOBAL_FREEZE');
  });

  it('happy path (approver): creates an engineer-tier request on the [L2,L3] ladder with pinned F1(a) params; audits drift-legitimize-requested; the revert proposal row is NOT consumed (stays open)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // v1: security@sg1
    const digest = digestFor('happy-legitimize');
    await seedRevertProposal(s.store, s.dataRoot, { digest, address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });

    const res = await legitimize(s, s.wati, digest, { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.operationId).toBe('system-drift-legitimize');
    expect(body.service).toBe('drift');
    expect(body.targetAddress).toBe('aws_security_group.sg1');
    expect(body.reviewTier).toBe('engineer');
    expect(body.status).toBe('NEEDS_ENGINEER');
    expect(body.approvalLadder).toEqual(['L2', 'L3']);
    expect(body.justification).toBe(JUSTIFICATION);
    expect(body.params).toEqual({
      attrs: [{ address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'] }],
      verdicts: [securityVerdict()],
      diff: null,
      proposalDigest: digest,
      reportVersion: 1,
    });
    expect((body.events as Array<{ type: string; label: string }>).some((e) => e.type === 'origin' && e.label.includes(digest))).toBe(true);
    expect((body.events as Array<{ type: string; label: string }>).some((e) => e.type === 'needs_engineer')).toBe(true);

    // The revert proposal row is NOT consumed — stays 'open', no requestId.
    const k = driftProposalKey('acme', digest);
    const row = (await s.store.get(k.PK, k.SK)) as DriftProposalItem;
    expect(row.status).toBe('open');
    expect(row.requestId).toBeUndefined();

    expect(await auditActions(s.store)).toContain('drift-legitimize-requested');
  });

  it('a lead may also legitimize (approver/lead tier, not approver-only)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('lead-legitimize');
    await seedRevertProposal(s.store, s.dataRoot, { digest, address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });
    const res = await legitimize(s, s.root, digest, { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(res.status).toBe(201);
  });

  it('both C1 (revert submit) and C2 (legitimize) stay available on the SAME digest — neither consumes the other', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const digest = digestFor('both-paths-open');
    await seedRevertProposal(s.store, s.dataRoot, { digest, address: 'aws_security_group.sg1', path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'], reportVersion: 1 });

    const legit = await legitimize(s, s.wati, digest, { justification: JUSTIFICATION, schedule: { kind: 'now' } });
    expect(legit.status).toBe(201);

    // C1 (the ordinary revert submit) is STILL usable on the same digest.
    const revertRes = await s.app.request(`/projects/acme/drift/proposals/${digest}/submit`, {
      method: 'POST',
      headers: hdrs(s.wati, { json: true }),
      body: JSON.stringify({ justification: 'reverting the console change as well', schedule: { kind: 'now' } }),
    });
    expect(revertRes.status).toBe(201);
    expect(((await revertRes.json()) as { operationId: string }).operationId).toBe('system-drift-revert');
  });
});

describe('POST /requests — the direct lane refuses system-drift-legitimize too (isSystemDriftOp widened)', () => {
  it('operationId system-drift-legitimize ⇒ 422 DRIFT_PROPOSAL_REQUIRED', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/requests', {
      method: 'POST',
      headers: hdrs(await sessionCookieFor(store, 'budi'), { json: true }),
      body: JSON.stringify({ operationId: 'system-drift-legitimize', targetAddress: 'aws_security_group.sg1', params: {}, justification: JUSTIFICATION, schedule: { kind: 'now' } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_PROPOSAL_REQUIRED');
  });
});
