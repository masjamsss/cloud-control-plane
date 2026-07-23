import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, TransactWrite } from '../src/store/configStore';
import { ConditionError } from '../src/store/configStore';
import type { AuditItem, DriftPointerItem, DriftReportItem } from '../src/store/schema';
import { driftPointerKey, driftVersionKey } from '../src/store/schema';
import { UPLOAD_RATE_CAPACITY, __resetUploadRateLimitForTests } from '../src/middleware/rateLimit';
import { __resetKnownProjectsForTests } from '../src/projects';
import { __setNow } from '../src/clock';
import { DriftEnvelope, envelopeDigestOf, rerunDriftRedaction } from '../src/domain/drift';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * WI-2 of docs/superpowers/specs/2026-07-20-ccp-drift-portal.md: token-lane
 * ingestion (`PUT /projects/:id/drift`), the versioned durable store + served
 * pointer (no separate activation, unlike project data), role-projected
 * `GET /projects/:id/drift`, and the `CCP_DRIFT` off-by-default arming.
 * Adversarial by construction, like projectData.test.ts: token-gate parity,
 * the redaction re-run, digest-keyed dedupe, retention, and least-disclosure
 * role projection.
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

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
    {
      repo: 'terraform-acme',
      verdict: 'clean',
      findings: [],
      resourceBlocks: 12,
      moduleBlocks: 0,
      tfJsonFiles: 0,
      fmtDirtyFiles: 0,
      providerPins: { aws: '~> 6.0' },
    },
    null,
    2,
  )}\n`;
}

const REGISTER = {
  id: 'acme',
  name: 'Acme estate',
  github: { owner: 'acme-co', repo: 'terraform-acme' },
  accountId: '123456789012',
  region: 'ap-southeast-5',
};

type DriftReportOverride = {
  meta?: Record<string, unknown>;
  counts?: Record<string, unknown>;
  verdicts?: unknown[];
  absorbed?: unknown[];
  invisible_to_plan?: string;
};

/** One well-formed benign verdict — the default fixture for most tests. */
function benignVerdict(): Record<string, unknown> {
  return {
    address: 'aws_instance.web',
    type: 'aws_instance',
    actions: ['update'],
    actionReason: null,
    driftEvidence: true,
    class: 'benign_inplace',
    riskTier: 'low',
    changedAttrs: [
      {
        path: 'tags.Owner',
        live: '"bi-team"',
        code: '"platform"',
        sensitive: false,
        liveJson: 'bi-team',
        codeJson: 'platform',
      },
    ],
    forceNewAttrs: [],
    securityHits: [],
    computedUnknown: [],
    notes: [],
    recommendation: 'adopt the live value into code (no-op PR)',
    neverDo: 'never adopt a value you have not read',
    executor: 'Claude-preparable PR',
  };
}

function defaultReport(): DriftReportOverride {
  return {
    meta: { format_version: '1.2', terraform_version: '1.9.0', provider_tag: 'v6.53.0' },
    counts: { benign_inplace: 1 },
    verdicts: [benignVerdict()],
    absorbed: [],
    invisible_to_plan: 'out-of-band CREATED resources are invisible to this alarm',
  };
}

/** A well-formed `ccp.drift/v1` envelope (publish_envelope.py's shape).
 * Overrides let each test break/vary one part. `sweep` is OMITTED entirely
 * (not sent as an explicit `undefined`) unless given — a legacy/un-upgraded
 * producer's exact wire shape (OOB provisioning spec §3.1). */
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

/** A clean-run envelope (planExitCode 0, empty verdicts) — "verified clean at
 * T" is a positive, dated record, distinct from "no signal" (§2.1). */
function cleanEnvelope(over: Parameters<typeof envelope>[0] = {}): Record<string, unknown> {
  return envelope({
    planExitCode: 0,
    report: { meta: {}, counts: {}, verdicts: [], absorbed: [], invisible_to_plan: 'nothing invisible on a clean run' },
    ...over,
  });
}

/**
 * One well-formed unmanaged-resource FINDING — the OOB provisioning spec
 * §2.4 shape, import-eligible by default (carries a clean, non-secret
 * importPayload per §2.6). Overrides let each test break/vary one part.
 */
function sweepFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    class: 'unmanaged_resource',
    arn: 'arn:aws:ec2:ap-southeast-5:123456789012:instance/i-0abc123def456789a',
    tfType: 'aws_instance',
    liveId: 'i-0abc123def456789a',
    name: 'bastion-2',
    service: 'ec2',
    stateful: false,
    region: 'ap-southeast-5',
    securityFamily: false,
    actor: {
      eventName: 'RunInstances',
      eventTime: '2026-07-19T10:00:00Z',
      who: 'arn:aws:sts::123456789012:assumed-role/dev/alice',
      sourceIp: '203.0.113.5',
    },
    importPayload: {
      address: 'aws_instance.oob_bastion_2',
      targetFile: 'oob-adopted.tf',
      importBlock: 'import {\n  to = aws_instance.oob_bastion_2\n  id = "i-0abc123def456789a"\n}\n',
      skeletonHcl: 'resource "aws_instance" "oob_bastion_2" {\n  ami           = "ami-0123456789abcdef0"\n  instance_type = "t3.micro"\n}\n',
    },
    payloadWithheldReason: null,
    ...over,
  };
}

/** The envelope's additive `sweep` section (§3.1) — one import-eligible
 * finding by default. */
function sweepSection(
  over: { findings?: Array<Record<string, unknown>>; totalFindings?: number; ignoredCount?: number } = {},
): Record<string, unknown> {
  const findings = over.findings ?? [sweepFinding()];
  return {
    method: 'importer-kit discover: 43 per-type listers + resourcegroupstaggingapi family sweep',
    capturedAt: '2026-07-20T03:00:00Z',
    region: 'ap-southeast-5',
    findings,
    totalFindings: over.totalFindings ?? findings.length,
    ignoredCount: over.ignoredCount ?? 0,
    coverage: { unrecognizedArnFamilies: {} },
  };
}

type App = ReturnType<typeof createApp>;

type Setup = {
  store: ConfigStore;
  app: App;
  dataRoot: string;
  putra: string;
  lina: string;
  root: string;
  sari: string;
  budi: string;
};

let roots: string[] = [];

async function setup(storeOverride?: ConfigStore): Promise<Setup> {
  const store = storeOverride ?? new MemoryStore();
  await seed(store); // sari (requester) / budi (approver) / putra (lead+admin) / lina (lead)
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  const dataRoot = mkdtempSync(join(tmpdir(), 'ccp-drift-'));
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
  };
}

/** register → upload trust artifacts → propose trust → second-admin ack. */
async function driveToTrusted(s: Setup, id = 'acme', register: Record<string, unknown> = REGISTER): Promise<void> {
  const { app, putra, lina, root } = s;
  const reg = await app.request('/projects', {
    method: 'POST',
    headers: hdrs(putra, { json: true }),
    body: JSON.stringify(register),
  });
  expect(reg.status).toBe(201);
  const prescanReport = reportText();
  const up = await app.request(`/projects/${id}/trust-request`, {
    method: 'PUT',
    headers: hdrs(lina, { json: true }),
    body: JSON.stringify({
      trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(prescanReport) },
      prescanReport,
    }),
  });
  expect(up.status).toBe(200);
  const propose = await app.request(`/projects/${id}/trust`, {
    method: 'POST',
    headers: hdrs(putra, { json: true }),
    body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256(prescanReport) }),
  });
  expect(propose.status).toBe(202);
  const pending = (await propose.json()) as { id: string };
  const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
  expect(ack.status).toBe(200);
}

async function mint(s: Setup, id = 'acme', body?: unknown): Promise<Response> {
  return s.app.request(`/projects/${id}/upload-tokens`, {
    method: 'POST',
    headers: hdrs(s.putra, { json: true }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function mintToken(s: Setup, id = 'acme'): Promise<{ tokenId: string; token: string; expiresAt: string }> {
  const res = await mint(s, id);
  expect(res.status).toBe(201);
  return (await res.json()) as { tokenId: string; token: string; expiresAt: string };
}

/** The CI drift upload: Bearer token only — NO cookie, NO CSRF client header. */
async function putDrift(s: Setup, token: string, body: unknown = envelope(), id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function getDrift(s: Setup, cookie: string, id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/drift`, { headers: hdrs(cookie) });
}

async function auditActions(store: ConfigStore, projectId = 'sample'): Promise<string[]> {
  const yyyymmNow = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const items = (await store.query(`P#${projectId}#AUDIT#${yyyymmNow}`)) as AuditItem[];
  return items.map((i) => i.action);
}

const ENV_KEYS = ['CCP_DRIFT', 'CCP_DRIFT_KEEP'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Armed by default — individual tests that need the disarmed posture unset it.
  process.env.CCP_DRIFT = '1';
  delete process.env.CCP_DRIFT_KEEP;
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

/* ═══ arming (off by default) ══════════════════════════════════════════ */

describe('PUT /projects/:id/drift — arming (off by default, the loop.ts/bundle.ts invariant)', () => {
  it('CCP_DRIFT unset ⇒ 409 DRIFT_DISARMED, refused before any token work', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    delete process.env.CCP_DRIFT;
    const res = await putDrift(s, token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DRIFT_DISARMED');
    // nothing was staged
    expect(await s.store.query('PROJECT#acme', 'DRIFT#v')).toEqual([]);
  });
});

/* ═══ token gate (byte-for-byte the projectData discipline) ═══════════════ */

describe('PUT /projects/:id/drift — token verification (fail closed, no enumeration)', () => {
  it('accepts a live token WITHOUT any session cookie or CSRF header (the CI lane)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await putDrift(s, token);
    expect(res.status).toBe(201);
  });

  it('refuses: no Authorization (session rules apply), malformed, unknown id, wrong secret, wrong project', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { tokenId, token } = await mintToken(s);

    const anon = await s.app.request('/projects/acme/drift', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' },
      body: JSON.stringify(envelope()),
    });
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { code: string }).code).toBe('NO_SESSION');

    for (const bad of [
      'not-even-a-token',
      `${tokenId}`, // missing secret half
      `${tokenId}.wrong-secret-wrong-secret`, // wrong secret
      `01ARZ3NDEKTSV4RRFFQ69G5FAV.${token.split('.')[1]}`, // unknown tokenId, real secret
    ]) {
      const res = await putDrift(s, bad);
      expect(res.status, bad).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('UPLOAD_TOKEN_INVALID');
    }

    // A token minted for acme opens nothing on another project.
    const reg2 = await s.app.request('/projects', {
      method: 'POST',
      headers: hdrs(s.putra, { json: true }),
      body: JSON.stringify({ ...REGISTER, id: 'beta', name: 'Beta estate' }),
    });
    expect(reg2.status).toBe(201);
    const cross = await putDrift(s, token, envelope({ projectId: 'beta' }), 'beta');
    expect(cross.status).toBe(401);
    expect(((await cross.json()) as { code: string }).code).toBe('UPLOAD_TOKEN_INVALID');
  });

  it('refuses an EXPIRED token (401) — expiry is enforced at verify time', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const minted = await mint(s, 'acme', { ttlMinutes: 5 });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    __setNow(() => Date.now() + 6 * 60_000); // 6 minutes later
    const res = await putDrift(s, token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UPLOAD_TOKEN_INVALID');
  });

  it('throttles per tokenId BEFORE the argon2 verify: a wrong-secret flood gets a burst of 401s then 429s', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { tokenId, token } = await mintToken(s);
    const wrong = `${tokenId}.${'A'.repeat(43)}`;
    for (let i = 0; i < UPLOAD_RATE_CAPACITY; i++) {
      expect((await putDrift(s, wrong)).status, `burst attempt ${i}`).toBe(401);
    }
    const over = await putDrift(s, wrong);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // Even the CORRECT secret is refused now — proves the gate sits BEFORE verify.
    expect((await putDrift(s, token)).status).toBe(429);
  });
});

/* ═══ the ingestion pipeline (size → schema → binding → redact → dedupe → stage) ═══ */

describe('PUT /projects/:id/drift — the ingestion pipeline', () => {
  it('SIZE CAP: an oversized body is refused 413 before parsing, nothing stored', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await putDrift(s, token, 'x'.repeat(4 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe('UPLOAD_TOO_LARGE');
    expect(existsSync(join(s.dataRoot, 'acme', 'drift'))).toBe(false);
  });

  it('malformed / non-envelope bodies refuse 422 (not JSON, wrong schema literal, missing required fields)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token, '{nope')).status).toBe(422);
    expect((await putDrift(s, token, { ...envelope(), schema: 'ccp.drift/v2' })).status).toBe(422);
    const withoutSchema = envelope();
    delete (withoutSchema as Record<string, unknown>).schema;
    expect((await putDrift(s, token, withoutSchema)).status).toBe(422);
  });

  it('projectId in the envelope must equal :id in the path — else 422 VALIDATION_FAILED (bound like a digest)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await putDrift(s, token, envelope({ projectId: 'someone-else' }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await s.store.query('PROJECT#acme', 'DRIFT#v')).toEqual([]);
  });

  it('happy path: 201 {version:1}; version row + pointer row + file all land; audited', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { tokenId, token } = await mintToken(s);
    const res = await putDrift(s, token);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ version: 1 });

    const vKey = driftVersionKey('acme', 1);
    const row = (await s.store.get(vKey.PK, vKey.SK)) as DriftReportItem;
    expect(row).not.toBeNull();
    expect(row.uploadedVia).toBe(`upload-token:${tokenId}`);
    expect(row.planExitCode).toBe(2);
    expect(row.commit).toBe(COMMIT);
    // OOB provisioning spec §3.2 rule 4: counts gains `unmanaged` (0 when
    // the envelope carries no sweep section) — additive on every row from
    // here on, present even for this sweep-less envelope.
    expect(row.counts).toEqual({ byClass: { benign_inplace: 1 }, drifted: 1, security: 0, unmanaged: 0 });

    const pKey = driftPointerKey('acme');
    const pointer = (await s.store.get(pKey.PK, pKey.SK)) as DriftPointerItem;
    expect(pointer.version).toBe(1);
    expect(pointer.driftedCount).toBe(1);
    expect(pointer.securityCount).toBe(0);
    expect(pointer.unmanagedCount).toBe(0);
    expect(pointer.planExitCode).toBe(2);

    expect(existsSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'))).toBe(true);
    expect(await auditActions(s.store, 'acme')).toContain('drift-report-upload');
    // Data-plane audit lands on the TARGET project's chain, not the acting scope's.
    expect(await auditActions(s.store)).not.toContain('drift-report-upload');
  });

  it('a SECOND, DIFFERENT upload stages v2 (versions are immutable, never overwritten)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const res = await putDrift(s, token, envelope({ runId: 'run-2' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ version: 2 });
    expect(existsSync(join(s.dataRoot, 'acme', 'drift', 'v2.json'))).toBe(true);
  });

  it('DEDUPE: an identical re-upload (CI retry) is a no-op — 200 {version, deduplicated:true}, no new row', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const first = await putDrift(s, token);
    expect(first.status).toBe(201);
    const second = await putDrift(s, token); // byte-identical body
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ version: 1, deduplicated: true });
    const rows = await s.store.query('PROJECT#acme', 'DRIFT#v');
    expect(rows.length).toBe(1);
  });

  it('retention prunes past CCP_DRIFT_KEEP: rows + files removed, newest N survive, pointer untouched', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    process.env.CCP_DRIFT_KEEP = '3';
    for (let i = 1; i <= 5; i++) {
      const res = await putDrift(s, token, envelope({ runId: `run-${i}` }));
      expect(res.status, `upload ${i}`).toBe(201);
    }
    const rows = await s.store.query('PROJECT#acme', 'DRIFT#v');
    expect(rows.map((r) => (r as DriftReportItem).version)).toEqual([3, 4, 5]);
    expect(existsSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'))).toBe(false);
    expect(existsSync(join(s.dataRoot, 'acme', 'drift', 'v2.json'))).toBe(false);
    expect(existsSync(join(s.dataRoot, 'acme', 'drift', 'v5.json'))).toBe(true);
    const pKey = driftPointerKey('acme');
    const pointer = (await s.store.get(pKey.PK, pKey.SK)) as DriftPointerItem;
    expect(pointer.version).toBe(5);
  });

  it('a clean run (planExitCode:0, empty verdicts) stores and serves as a dated positive, not "no signal"', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await putDrift(s, token, cleanEnvelope());
    expect(res.status).toBe(201);

    const vKey = driftVersionKey('acme', 1);
    const row = (await s.store.get(vKey.PK, vKey.SK)) as DriftReportItem;
    expect(row.planExitCode).toBe(0);
    expect(row.counts).toEqual({ byClass: {}, drifted: 0, security: 0, unmanaged: 0 });

    const get = await getDrift(s, s.root);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { connected: boolean; report: { planExitCode: number; counts: { drifted: number } } };
    expect(body.connected).toBe(true);
    expect(body.report.planExitCode).toBe(0);
    expect(body.report.counts.drifted).toBe(0);
  });
});

/* ═══ server-side redaction re-run ═══════════════════════════════════════ */

describe('PUT /projects/:id/drift — server-side redaction re-run', () => {
  it('masks a secret-shaped value the classifier had not flagged sensitive; never served or stored verbatim', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const SECRET = 'hunter2Hunter2Hunter2AB12';
    const leaky = envelope({
      report: {
        meta: {},
        counts: { benign_inplace: 1 },
        absorbed: [],
        invisible_to_plan: 'x',
        verdicts: [
          {
            address: 'aws_db_instance.db',
            type: 'aws_db_instance',
            actions: ['update'],
            class: 'benign_inplace',
            riskTier: 'low',
            driftEvidence: true,
            changedAttrs: [
              {
                path: 'master_password',
                live: `"${SECRET}"`,
                code: '"platformPlatform12AB34"',
                sensitive: false,
                liveJson: SECRET,
                codeJson: 'platformPlatform12AB34',
              },
            ],
            forceNewAttrs: [],
            securityHits: [],
            computedUnknown: [],
            notes: [],
          },
        ],
      },
    });
    const res = await putDrift(s, token, leaky);
    expect(res.status).toBe(201);

    const onDisk = readFileSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'), 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain('«redacted:');

    await seedAccount(s.store, { id: 'wati', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'acme'] });
    const wati = await sessionCookieFor(s.store, 'wati');
    const served = await (await getDrift(s, wati)).text();
    expect(served).not.toContain(SECRET);
    expect(served).toContain('«redacted:');
  });
});

/* ═══ GET — role-projected serve (§4.2 field-tier table) ══════════════════ */

describe('GET /projects/:id/drift — role-projected serve', () => {
  it('unbound account ⇒ 403 PROJECT_SCOPE (bound to the acting scope, not the target)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    // sari is bound to sample only; the acting scope (sample) passes the group
    // gate, but the TARGET (acme) binding check refuses the read.
    const res = await getDrift(s, s.sari);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_SCOPE');
  });

  it('unknown project ⇒ 404; no report ever staged (but armed + bound) ⇒ 200 connected:false', async () => {
    const s = await setup();
    expect((await getDrift(s, s.root, 'ghost')).status).toBe(404);
    await driveToTrusted(s);
    const res = await getDrift(s, s.root);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it('disarmed ⇒ connected:false even when a report WAS previously staged (never leaks stale data)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    delete process.env.CCP_DRIFT;
    const res = await getDrift(s, s.root);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it('requester tier sees presence + taxonomy + attribute PATHS only — never values, securityHits, or prose', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    await seedAccount(s.store, { id: 'nia', role: 'requester', teamId: 'platform', isAdmin: false, projects: ['sample', 'acme'] });
    const nia = await sessionCookieFor(s.store, 'nia');

    const res = await getDrift(s, nia);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      report: { counts: unknown; verdicts: Array<Record<string, unknown>>; invisibleToPlan: string };
    };
    expect(body.connected).toBe(true);
    expect(body.report.counts).toEqual({ byClass: { benign_inplace: 1 }, drifted: 1, security: 0, unmanaged: 0 });
    expect(body.report.invisibleToPlan).toBe('out-of-band CREATED resources are invisible to this alarm');
    expect(body.report.verdicts).toEqual([
      {
        address: 'aws_instance.web',
        type: 'aws_instance',
        class: 'benign_inplace',
        riskTier: 'low',
        actions: ['update'],
        changedAttrs: [{ path: 'tags.Owner' }],
      },
    ]);
  });

  it('approver tier sees the full post-redaction row: attribute values, liveJson/codeJson, and prose', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    await seedAccount(s.store, { id: 'wati', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'acme'] });
    const wati = await sessionCookieFor(s.store, 'wati');

    const res = await getDrift(s, wati);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { verdicts: Array<Record<string, unknown>> } };
    const v = body.report.verdicts[0]!;
    expect(v.recommendation).toBe('adopt the live value into code (no-op PR)');
    expect((v.changedAttrs as Array<Record<string, unknown>>)[0]).toMatchObject({
      path: 'tags.Owner',
      live: '"bi-team"',
      code: '"platform"',
      liveJson: 'bi-team',
      codeJson: 'platform',
    });
  });

  it('lead tier sees the same full row as approver', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    // root is role 'lead', bound to '*'.
    const res = await getDrift(s, s.root);
    const body = (await res.json()) as { report: { verdicts: Array<Record<string, unknown>> } };
    expect((body.report.verdicts[0] as Record<string, unknown>).recommendation).toBeDefined();
  });

  it('archived project ⇒ 404 (drift goes with the rest of the project surface)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    const arch = await s.app.request('/projects/acme/archive', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    expect(arch.status).toBe(200);
    expect((await getDrift(s, s.root)).status).toBe(404);
  });

  it('a corrupt/invalid stored file fails closed: connected:true, report:null (never a partial render)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    writeFileSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'), '{not valid json');
    const res = await getDrift(s, s.root);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true, report: null });
  });

  it('a missing stored file (row present, file gone) also fails closed: connected:true, report:null', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201);
    rmSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'), { force: true });
    const res = await getDrift(s, s.root);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true, report: null });
  });
});

/* ═══ F5/A8 — sensitive rows never carry machine values, at EVERY parse ═══ */

describe('F5/A8 — sensitive changedAttrs rows never carry liveJson/codeJson', () => {
  /** A verdict whose one changedAttrs row is HOSTILE: sensitive:true but
   * still carries liveJson/codeJson — the crafted-envelope attack F5 closes. */
  function sensitiveVerdictCarryingValues(liveJson: string, codeJson: string): Record<string, unknown> {
    return {
      address: 'aws_db_instance.db',
      type: 'aws_db_instance',
      actions: ['update'],
      class: 'benign_inplace',
      riskTier: 'low',
      driftEvidence: true,
      changedAttrs: [
        {
          path: 'master_password',
          live: '(sensitive)',
          code: '(sensitive)',
          sensitive: true,
          liveJson,
          codeJson,
        },
      ],
      forceNewAttrs: [],
      securityHits: [],
      computedUnknown: [],
      notes: [],
    };
  }

  it('ingest: a crafted envelope carrying liveJson/codeJson on a sensitive:true row is stripped before anything is stored', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const hostile = envelope({
      report: { meta: {}, counts: { benign_inplace: 1 }, absorbed: [], invisible_to_plan: 'x', verdicts: [sensitiveVerdictCarryingValues('hunter2Hunter2Hunter2AB12', 'platformPlatform12AB34')] },
    });
    const res = await putDrift(s, token, hostile);
    expect(res.status).toBe(201);

    const onDisk = readFileSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'), 'utf8');
    expect(onDisk).not.toContain('hunter2Hunter2Hunter2AB12');
    expect(onDisk).not.toContain('platformPlatform12AB34');
    expect(onDisk).not.toContain('liveJson');
    expect(onDisk).not.toContain('codeJson');

    await seedAccount(s.store, { id: 'wati', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'acme'] });
    const wati = await sessionCookieFor(s.store, 'wati');
    const body = (await (await getDrift(s, wati)).json()) as { report: { verdicts: Array<{ changedAttrs: Array<Record<string, unknown>> }> } };
    const attr = body.report.verdicts[0]!.changedAttrs[0]!;
    expect('liveJson' in attr).toBe(false);
    expect('codeJson' in attr).toBe(false);
  });

  it('read-back: an already-stored (pre-fix) file with a sensitive row carrying liveJson/codeJson is served stripped, with no re-upload', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token)).status).toBe(201); // establishes v1 + the pointer

    // Hand-write a PRE-FIX stored file directly (simulates a version staged
    // before this fix landed) — the store row/pointer already point at v1,
    // so GET reads exactly this file, through parseStoredEnvelope's schema
    // (which now strips at EVERY parse, not just ingest).
    const preFix = envelope({
      report: { meta: {}, counts: { benign_inplace: 1 }, absorbed: [], invisible_to_plan: 'x', verdicts: [sensitiveVerdictCarryingValues('leaked-secret-value', 'leaked-code-value')] },
    });
    writeFileSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'), `${JSON.stringify(preFix, null, 2)}\n`);

    await seedAccount(s.store, { id: 'wati', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'acme'] });
    const wati = await sessionCookieFor(s.store, 'wati');
    const body = (await (await getDrift(s, wati)).json()) as { report: { verdicts: Array<{ changedAttrs: Array<Record<string, unknown>> }> } };
    const attr = body.report.verdicts[0]!.changedAttrs[0]!;
    expect('liveJson' in attr).toBe(false);
    expect('codeJson' in attr).toBe(false);
    expect(JSON.stringify(body)).not.toContain('leaked-secret-value');
    expect(JSON.stringify(body)).not.toContain('leaked-code-value');
  });
});

/* ═══ F6/A8 — ingest hardening: duplicate verdict addresses refused ═══ */

describe('PUT /projects/:id/drift — F6/A8 duplicate-address ingest refusal', () => {
  it('an envelope whose report.verdicts repeat an address ⇒ 422 VALIDATION_FAILED, nothing stored', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const dup = envelope({
      report: {
        meta: {},
        counts: {},
        absorbed: [],
        invisible_to_plan: 'x',
        // Same address twice: an honest benign row, then a security twin —
        // exactly the shape a last-wins fold would have hidden (F6).
        verdicts: [benignVerdict(), { ...benignVerdict(), class: 'security_posture', securityHits: [{ path: 'sg', why: 'network reachability' }] }],
      },
    });
    const res = await putDrift(s, token, dup);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; details?: Record<string, unknown> };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details).toMatchObject({ field: 'report.verdicts', problem: 'duplicate address' });
    expect(await s.store.query('PROJECT#acme', 'DRIFT#v')).toEqual([]);
    expect(existsSync(join(s.dataRoot, 'acme', 'drift'))).toBe(false);
  });

  it('distinct addresses (no duplicate) are unaffected', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const ok = envelope({
      report: {
        meta: {},
        counts: {},
        absorbed: [],
        invisible_to_plan: 'x',
        verdicts: [benignVerdict(), { ...benignVerdict(), address: 'aws_instance.web2' }],
      },
    });
    const res = await putDrift(s, token, ok);
    expect(res.status).toBe(201);
  });
});

/* ═══ F10 — concurrent identical PUT dedupe race (the retry-loop fix) ═══ */

describe('PUT /projects/:id/drift — F10 concurrent-upload dedupe race', () => {
  /** A store whose FIRST `transact` call — once armed — lands a CONCURRENT
   * "winner" write (simulating another identical upload that raced ahead
   * and staged first) and then fails with ConditionError, exactly as a
   * real lost `ifNotExists` race on the version row would. Mirrors the
   * `FlakyStore` pattern in test/audit.test.ts. Armed only after setup +
   * token minting (which also call `transact`) have already completed, so
   * only the PUT /:id/drift call under test is affected. */
  class ConcurrentUploadStore extends MemoryStore {
    armed = false;
    private intercepted = false;
    landConcurrentWrite: (() => Promise<void>) | null = null;
    override async transact(writes: TransactWrite[]): Promise<void> {
      if (this.armed && !this.intercepted) {
        this.intercepted = true;
        await this.landConcurrentWrite!();
        throw new ConditionError('simulated concurrent identical upload');
      }
      return super.transact(writes);
    }
  }

  /** Directly stage version 1 (bypassing the route/transact entirely) with
   * the envelopeDigest an upload of `rawEnvelope` would ACTUALLY produce —
   * reproducing the same redact+digest pipeline the route runs, so the
   * "concurrent winner" is byte-for-byte what our own request would have
   * staged. */
  async function landPhantomVersion(store: ConfigStore, projectId: string, rawEnvelope: Record<string, unknown>): Promise<void> {
    const parsed = DriftEnvelope.parse(rawEnvelope);
    const { envelope: stored } = rerunDriftRedaction(parsed);
    const envelopeDigest = envelopeDigestOf(stored);
    const versionItem: DriftReportItem = {
      ...driftVersionKey(projectId, 1),
      projectId,
      version: 1,
      uploadedAt: '2026-07-20T00:00:00.000Z',
      uploadedVia: 'upload-token:concurrent-winner',
      envelopeDigest,
      capturedAt: stored.capturedAt,
      runId: stored.runId,
      commit: stored.commit,
      cadenceHours: stored.cadenceHours,
      planExitCode: stored.planExitCode,
      counts: { byClass: {}, drifted: 0, security: 0 },
    };
    const pointerItem: DriftPointerItem = {
      ...driftPointerKey(projectId),
      version: 1,
      capturedAt: stored.capturedAt,
      planExitCode: stored.planExitCode,
      driftedCount: 0,
      securityCount: 0,
    };
    await store.put(versionItem as never);
    await store.put(pointerItem as never);
  }

  it('a CHAIN_CONTENTION retry that discovers a concurrent IDENTICAL upload dedupes instead of staging a duplicate version', async () => {
    const raceStore = new ConcurrentUploadStore();
    const s = await setup(raceStore); // seed/driveToTrusted/mintToken all use `transact` — unarmed, so unaffected
    await driveToTrusted(s);
    const { token } = await mintToken(s);

    const body = envelope(); // the exact envelope putDrift below will send
    raceStore.armed = true;
    raceStore.landConcurrentWrite = () => landPhantomVersion(raceStore, 'acme', body);

    const res = await putDrift(s, token, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, deduplicated: true });

    // Exactly ONE version row exists — the phantom's — never a duplicate v2.
    const rows = await s.store.query('PROJECT#acme', 'DRIFT#v');
    expect(rows).toHaveLength(1);
    expect((rows[0] as DriftReportItem).version).toBe(1);
  });

  it('a CHAIN_CONTENTION retry that discovers a concurrent DIFFERENT upload does NOT dedupe — stages its own next version instead', async () => {
    const raceStore = new ConcurrentUploadStore();
    const s = await setup(raceStore);
    await driveToTrusted(s);
    const { token } = await mintToken(s);

    // The "concurrent winner" staged a DIFFERENT envelope (runId differs,
    // so its digest differs) — our own upload must NOT be told it's a dup;
    // it re-derives a fresh version number on the retry and stages as v2.
    raceStore.armed = true;
    raceStore.landConcurrentWrite = () => landPhantomVersion(raceStore, 'acme', envelope({ runId: 'concurrent-run' }));

    const res = await putDrift(s, token, envelope({ runId: 'our-run' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ version: 2 });

    const rows = await s.store.query('PROJECT#acme', 'DRIFT#v');
    expect(rows.map((r) => (r as DriftReportItem).version)).toEqual([1, 2]);
  });
});

/* ═══ OOB provisioning spec (2026-07-20-ccp-oob-provisioning-import.md)
 * §3.2-§3.3, WI-S4 — the additive `sweep` section: ingest, dedupe, the
 * drop-don't-mask payload rule, and role-projected serve ═══════════════ */

describe('PUT/GET /projects/:id/drift — sweep (unmanaged-resource findings, §3.2-§3.3)', () => {
  it('sweep-section-stores-and-serves: an envelope carrying a sweep section stages counts.unmanaged/pointer.unmanagedCount and serves the full row to lead/approver', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await putDrift(s, token, envelope({ sweep: sweepSection() }));
    expect(res.status).toBe(201);

    const vKey = driftVersionKey('acme', 1);
    const row = (await s.store.get(vKey.PK, vKey.SK)) as DriftReportItem;
    expect(row.counts).toEqual({ byClass: { benign_inplace: 1 }, drifted: 1, security: 0, unmanaged: 1 });

    const pKey = driftPointerKey('acme');
    const pointer = (await s.store.get(pKey.PK, pKey.SK)) as DriftPointerItem;
    expect(pointer.unmanagedCount).toBe(1);

    // root is role 'lead' — the rich (approver+) tier.
    const get = await getDrift(s, s.root);
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      report: { counts: { unmanaged: number }; sweep: { totalFindings: number; ignoredCount: number; findings: Array<Record<string, unknown>> } };
    };
    expect(body.report.counts.unmanaged).toBe(1);
    expect(body.report.sweep.totalFindings).toBe(1);
    expect(body.report.sweep.ignoredCount).toBe(0);
    expect(body.report.sweep.findings).toHaveLength(1);
    const finding = body.report.sweep.findings[0]!;
    expect(finding).toMatchObject({
      class: 'unmanaged_resource',
      arn: 'arn:aws:ec2:ap-southeast-5:123456789012:instance/i-0abc123def456789a',
      tfType: 'aws_instance',
      liveId: 'i-0abc123def456789a',
      name: 'bastion-2',
      service: 'ec2',
      securityFamily: false,
    });
    expect((finding.actor as Record<string, unknown>).who).toBe('arn:aws:sts::123456789012:assumed-role/dev/alice');
    expect((finding.importPayload as Record<string, unknown>).address).toBe('aws_instance.oob_bastion_2');
  });

  it('duplicate-finding-key-422: two findings sharing an arn are refused, nothing stored', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const dup = envelope({ sweep: sweepSection({ findings: [sweepFinding(), sweepFinding({ name: 'bastion-2-twin' })], totalFindings: 2 }) });
    const res = await putDrift(s, token, dup);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; details?: Record<string, unknown> };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details).toMatchObject({ field: 'sweep.findings', problem: 'duplicate finding key' });
    expect(await s.store.query('PROJECT#acme', 'DRIFT#v')).toEqual([]);
    expect(existsSync(join(s.dataRoot, 'acme', 'drift'))).toBe(false);
  });

  it('duplicate-finding-key-422: falls back to tfType+liveId when arn is null on both (the same finding, twice)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const dup = envelope({
      sweep: sweepSection({
        findings: [sweepFinding({ arn: null }), sweepFinding({ arn: null, name: 'twin' })],
        totalFindings: 2,
      }),
    });
    const res = await putDrift(s, token, dup);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('distinct finding keys (no duplicate) are unaffected', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const ok = envelope({
      sweep: sweepSection({
        findings: [sweepFinding(), sweepFinding({ arn: 'arn:aws:ec2:ap-southeast-5:123456789012:instance/i-0other', liveId: 'i-0other', name: 'bastion-3' })],
        totalFindings: 2,
      }),
    });
    const res = await putDrift(s, token, ok);
    expect(res.status).toBe(201);
  });

  it('secret-payload-stripped-server-side: a secret-shaped value in the generated HCL drops the WHOLE payload server-side, never masks it in place', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const SECRET = 'hunter2Hunter2Hunter2AB12';
    const leaky = envelope({
      sweep: sweepSection({
        findings: [
          sweepFinding({
            importPayload: {
              address: 'aws_instance.oob_bastion_2',
              targetFile: 'oob-adopted.tf',
              importBlock: 'import {\n  to = aws_instance.oob_bastion_2\n  id = "i-0abc123def456789a"\n}\n',
              skeletonHcl: `resource "aws_instance" "oob_bastion_2" {\n  ami            = "ami-0123456789abcdef0"\n  admin_password = "${SECRET}"\n}\n`,
            },
          }),
        ],
      }),
    });
    const res = await putDrift(s, token, leaky);
    expect(res.status).toBe(201); // the finding still publishes — detection is never hostage to generation (§2.6 step 3)

    const onDisk = readFileSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'), 'utf8');
    expect(onDisk).not.toContain(SECRET);

    const get = await getDrift(s, s.root);
    const body = (await get.json()) as { report: { sweep: { findings: Array<Record<string, unknown>> } } };
    const finding = body.report.sweep.findings[0]!;
    expect(finding.importPayload).toBeNull();
    expect(finding.payloadWithheldReason).toBe(
      'generated config carries secret-shaped values — import via the kit runbook with secret handling (e.g. ignore_changes on the secret attribute), never through the portal',
    );
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('requester-sees-presence-not-arn/actor/payload: requester tier gets taxonomy + payload PRESENCE only, never identifiers or evidence', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await putDrift(s, token, envelope({ sweep: sweepSection() }))).status).toBe(201);
    await seedAccount(s.store, { id: 'nia', role: 'requester', teamId: 'platform', isAdmin: false, projects: ['sample', 'acme'] });
    const nia = await sessionCookieFor(s.store, 'nia');

    const res = await getDrift(s, nia);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { sweep: { totalFindings: number; findings: Array<Record<string, unknown>> } } };
    // Summary-tier fields (presence/counts) are visible to every role.
    expect(body.report.sweep.totalFindings).toBe(1);
    const finding = body.report.sweep.findings[0]!;
    expect(finding).toEqual({
      class: 'unmanaged_resource',
      tfType: 'aws_instance',
      name: 'bastion-2',
      service: 'ec2',
      securityFamily: false,
      importPayloadPresent: true,
    });
    expect('arn' in finding).toBe(false);
    expect('liveId' in finding).toBe(false);
    expect('actor' in finding).toBe(false);
    expect('importPayload' in finding).toBe(false);
    expect('payloadWithheldReason' in finding).toBe(false);
    const rawBody = JSON.stringify(body);
    expect(rawBody).not.toContain('arn:aws:ec2');
    expect(rawBody).not.toContain('assumed-role');
    expect(rawBody).not.toContain('i-0abc123def456789a');
    expect(rawBody).not.toContain('oob_bastion_2');
  });

  it('legacy-envelope-unchanged: an envelope with no sweep section stages/serves unmanaged:0 and sweep:null, never injecting a stored "sweep" key', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await putDrift(s, token); // default envelope() — no sweep override at all
    expect(res.status).toBe(201);

    // The stored file is byte-for-byte what a pre-WI-S4 upload would have
    // produced, plus the additive `unmanaged:0` count — no `sweep` key rides
    // along implicitly (canonicalJson's Object.keys walk would otherwise
    // fold a present-but-undefined key into the digest).
    const onDisk = readFileSync(join(s.dataRoot, 'acme', 'drift', 'v1.json'), 'utf8');
    expect(onDisk).not.toContain('"sweep"');

    const vKey = driftVersionKey('acme', 1);
    const row = (await s.store.get(vKey.PK, vKey.SK)) as DriftReportItem;
    expect(row.counts).toEqual({ byClass: { benign_inplace: 1 }, drifted: 1, security: 0, unmanaged: 0 });

    const pKey = driftPointerKey('acme');
    const pointer = (await s.store.get(pKey.PK, pKey.SK)) as DriftPointerItem;
    expect(pointer.unmanagedCount).toBe(0);

    const get = await getDrift(s, s.root);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { report: { counts: { unmanaged: number }; sweep: unknown } };
    expect(body.report.counts.unmanaged).toBe(0);
    expect(body.report.sweep).toBeNull();
  });
});
