import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AuditItem, ProjectUploadTokenItem } from '../src/store/schema';
import { uploadTokenKey } from '../src/store/schema';
import { canonicalJson, verifyChain } from '../src/domain/audit';
import { readAuditChronological, toAuditEntry } from '../src/domain/auditQuery';
import { UPLOAD_RATE_CAPACITY, __resetUploadRateLimitForTests } from '../src/middleware/rateLimit';
import { __resetKnownProjectsForTests, isKnownProject, isValidProjectBinding } from '../src/projects';
import { __setNow } from '../src/clock';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * The per-account DATA plane (upload tokens → token-authed CI upload → staged
 * versions → dual-controlled activation → serve-active-only), plus archive /
 * unarchive and the host-agnostic repo shape. Adversarial by construction, like
 * projects.test.ts: authz-denial per endpoint, the token lane's fail-closed
 * verification (expiry, revocation, wrong project, wrong secret), the digest
 * binding recomputed server-side, the server-side redaction re-run, the
 * staged-serves-nothing rule, and the stale-proposal drift guard on activation.
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const digest = (v: unknown): string => sha256(canonicalJson(v));

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — see projects.test.ts's identical
// note. Every call here always meant "act on the sample estate".
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

/** A well-formed upload bundle with SELF-CONSISTENT digests (the canonical-JSON
 * sha256 rule the endpoint documents). Overrides let each test break one part. */
function bundle(over: {
  inventory?: Record<string, unknown>;
  blocks?: Record<string, unknown>;
  manifests?: unknown[];
  digests?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  blockSource?: string;
} = {}): Record<string, unknown> {
  const inventory = over.inventory ?? {
    generatedAt: '2026-07-17T00:00:00.000Z',
    sourceCommit: COMMIT,
    source: 'scan of terraform-acme environments/prod',
    resources: [
      {
        address: 'aws_instance.web',
        resourceType: 'aws_instance',
        name: 'web',
        service: 'ec2',
        attributes: { instance_type: 't3.micro', tags_name: 'WEB01' },
      },
    ],
  };
  const source =
    over.blockSource ?? 'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}';
  const blocks = over.blocks ?? {
    index: { 'aws_instance.web': 'main' },
    chunks: { main: { 'aws_instance.web': { file: 'main.tf', line: 3, source } } },
  };
  const manifests = over.manifests ?? [
    {
      service: 'ec2',
      scope: 'estate',
      resourceTypes: ['aws_instance'],
      summary: 'Day-two EC2 operations.',
      operations: [{ id: 'ec2-resize', service: 'ec2', macd: 'Change' }],
    },
  ];
  return {
    digests: over.digests ?? {
      inventorySha256: digest(inventory),
      blocksSha256: digest(blocks),
      manifestsSha256: digest(manifests),
    },
    inventory,
    blocks,
    manifests,
    summary: over.summary ?? { providerPins: { aws: '~> 6.0' } },
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

async function setup(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store); // sari (requester) / budi (approver) / putra (lead+admin) / lina (lead)
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  const dataRoot = mkdtempSync(join(tmpdir(), 'ccp-projdata-'));
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
async function driveToTrusted(s: Setup): Promise<void> {
  const { app, putra, lina, root } = s;
  const reg = await app.request('/projects', {
    method: 'POST',
    headers: hdrs(putra, { json: true }),
    body: JSON.stringify(REGISTER),
  });
  expect(reg.status).toBe(201);
  const prescanReport = reportText();
  const up = await app.request('/projects/acme/trust-request', {
    method: 'PUT',
    headers: hdrs(lina, { json: true }),
    body: JSON.stringify({
      trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(prescanReport) },
      prescanReport,
    }),
  });
  expect(up.status).toBe(200);
  const propose = await app.request('/projects/acme/trust', {
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

async function mintToken(s: Setup): Promise<{ tokenId: string; token: string; expiresAt: string }> {
  const res = await mint(s);
  expect(res.status).toBe(201);
  return (await res.json()) as { tokenId: string; token: string; expiresAt: string };
}

/** The CI upload: Bearer token only — NO cookie, NO CSRF client header. */
async function upload(s: Setup, token: string, body: unknown = bundle(), id = 'acme'): Promise<Response> {
  return s.app.request(`/projects/${id}/data`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function activateViaTwoAdmins(s: Setup, version: number): Promise<void> {
  const res = await s.app.request(`/projects/acme/data/${version}/activate`, {
    method: 'POST',
    headers: hdrs(s.putra, { json: true }),
  });
  expect(res.status).toBe(202);
  const pending = (await res.json()) as { id: string };
  const ack = await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) });
  expect(ack.status).toBe(200);
}

async function auditActions(store: ConfigStore, projectId = 'sample'): Promise<string[]> {
  const yyyymmNow = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const items = (await store.query(`P#${projectId}#AUDIT#${yyyymmNow}`)) as AuditItem[];
  return items.map((i) => i.action);
}

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
});
afterEach(() => {
  __setNow(null);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/* ═══ upload tokens ═══════════════════════════════════════════════════════ */

describe('POST /projects/:id/upload-tokens — mint (lead+isAdmin, trusted/ready only)', () => {
  it('mints once trusted: 201 {tokenId, token, expiresAt}; the secret is shown once and only its hash is stored; audited', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await mint(s);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tokenId: string; token: string; expiresAt: string };
    expect(body.token.startsWith(`${body.tokenId}.`)).toBe(true);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    // At rest: argon2id hash only — the clear secret never persists.
    const k = uploadTokenKey('acme', body.tokenId);
    const row = (await s.store.get(k.PK, k.SK)) as ProjectUploadTokenItem;
    expect(row.secretHash.startsWith('$argon2id$')).toBe(true);
    const secret = body.token.split('.')[1]!;
    expect(JSON.stringify(row)).not.toContain(secret);
    // Data-plane audit lands on the TARGET project's chain, not the acting scope's.
    expect(await auditActions(s.store, 'acme')).toContain('upload-token-mint');
  });

  it('refuses the wrong caller: requester/approver 403 FORBIDDEN_ROLE, non-admin lead 403 NOT_ADMIN', async () => {
    const s = await setup();
    await driveToTrusted(s);
    for (const [cookie, code] of [
      [s.sari, 'FORBIDDEN_ROLE'],
      [s.budi, 'FORBIDDEN_ROLE'],
      [s.lina, 'NOT_ADMIN'],
    ] as const) {
      const res = await s.app.request('/projects/acme/upload-tokens', { method: 'POST', headers: hdrs(cookie, { json: true }) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(code);
    }
  });

  it('refuses a draft project (409) and an unknown one (404): no trusted repo, no CI credential', async () => {
    const s = await setup();
    expect((await mint(s, 'ghost')).status).toBe(404);
    const reg = await s.app.request('/projects', { method: 'POST', headers: hdrs(s.putra, { json: true }), body: JSON.stringify(REGISTER) });
    expect(reg.status).toBe(201);
    const res = await mint(s);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STATE_CONFLICT');
  });

  it('validates ttlMinutes bounds strictly (below 5 / above 7 days / junk key → 422)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    for (const body of [{ ttlMinutes: 1 }, { ttlMinutes: 999999 }, { evil: true }]) {
      const res = await mint(s, 'acme', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('DELETE /projects/:id/upload-tokens/:tokenId — revoke', () => {
  it('revokes: the row is deleted, the token stops working, audited; unknown token → 404', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { tokenId, token } = await mintToken(s);

    const revoke = await s.app.request(`/projects/acme/upload-tokens/${tokenId}`, { method: 'DELETE', headers: hdrs(s.putra) });
    expect(revoke.status).toBe(200);
    expect(await auditActions(s.store, 'acme')).toContain('upload-token-revoke');

    const res = await upload(s, token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UPLOAD_TOKEN_INVALID');

    const again = await s.app.request(`/projects/acme/upload-tokens/${tokenId}`, { method: 'DELETE', headers: hdrs(s.putra) });
    expect(again.status).toBe(404);
  });
});

/* ═══ the token-authed upload ═════════════════════════════════════════════ */

describe('PUT /projects/:id/data — token verification (fail closed, no enumeration)', () => {
  it('accepts a live token WITHOUT any session cookie or CSRF header (the CI lane)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await upload(s, token);
    expect(res.status).toBe(201);
  });

  it('refuses: no Authorization (session rules apply), malformed, unknown id, wrong secret, wrong project', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { tokenId, token } = await mintToken(s);

    // No Bearer header → the normal session gate answers (this lane never opens).
    const anon = await s.app.request('/projects/acme/data', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' },
      body: JSON.stringify(bundle()),
    });
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { code: string }).code).toBe('NO_SESSION');

    for (const bad of [
      'not-even-a-token',
      `${tokenId}`, // missing secret half
      `${tokenId}.wrong-secret-wrong-secret`, // wrong secret
      `01ARZ3NDEKTSV4RRFFQ69G5FAV.${token.split('.')[1]}`, // unknown tokenId, real secret
    ]) {
      const res = await upload(s, bad);
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
    const cross = await upload(s, token, bundle(), 'beta');
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
    const res = await upload(s, token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UPLOAD_TOKEN_INVALID');
  });

  it('a valid token cannot bypass the project state gate (defense in depth: draft project → 409)', async () => {
    const s = await setup();
    // Register a DRAFT project and hand-plant a token row for it (mint refuses
    // drafts, so an attacker would need store access — verify the gate anyway).
    const reg = await s.app.request('/projects', { method: 'POST', headers: hdrs(s.putra, { json: true }), body: JSON.stringify(REGISTER) });
    expect(reg.status).toBe(201);
    await driveToTrustedOther(s); // trusted 'beta' so we can mint a REAL token there
    const { token } = await mintTokenFor(s, 'beta');
    // Re-point the beta token's row at acme? No — simpler and stricter: plant a
    // fresh acme row with a KNOWN hash by minting on beta and copying the row.
    const [tokenId, secret] = token.split('.') as [string, string];
    const bKey = uploadTokenKey('beta', tokenId);
    const row = (await s.store.get(bKey.PK, bKey.SK)) as ProjectUploadTokenItem;
    await s.store.put({ ...row, ...uploadTokenKey('acme', tokenId), projectId: 'acme' });
    const res = await upload(s, `${tokenId}.${secret}`, bundle(), 'acme');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STATE_CONFLICT');
  });
});

describe('PUT /projects/:id/data — the upload-lane rate limit (DoS hardening, security review F3)', () => {
  it('throttles per tokenId BEFORE the argon2 verify: a wrong-secret flood gets a burst of 401s then 429s; other tokens unaffected; refills over time', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { tokenId, token } = await mintToken(s);
    // Well-formed but WRONG secret — exactly the flood the finding describes:
    // tokenId is semi-public, and each of these used to cost a full argon2id run.
    const wrong = `${tokenId}.${'A'.repeat(43)}`;
    for (let i = 0; i < UPLOAD_RATE_CAPACITY; i++) {
      const res = await upload(s, wrong);
      expect(res.status, `burst attempt ${i}`).toBe(401); // reached the verifier
    }
    // Burst exhausted → 429 with Retry-After, and NOT another verification:
    // even the CORRECT secret is refused, proving the gate sits BEFORE verify.
    const over = await upload(s, wrong);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await upload(s, token)).status).toBe(429);

    // The buckets are PER TOKEN: a different live token is not collateral damage.
    const second = await mintToken(s);
    expect((await upload(s, second.token)).status).toBe(201);

    // Slow refill: a minute later the throttled token's CI can upload again.
    __setNow(() => Date.now() + 61_000);
    expect((await upload(s, token)).status).toBe(201);
  });
});

/** Second project for cross-project fixtures. */
async function driveToTrustedOther(s: Setup): Promise<void> {
  const { app, putra, lina, root } = s;
  const reg = await app.request('/projects', {
    method: 'POST',
    headers: hdrs(putra, { json: true }),
    body: JSON.stringify({ ...REGISTER, id: 'beta', name: 'Beta estate' }),
  });
  expect(reg.status).toBe(201);
  const prescanReport = reportText();
  const up = await app.request('/projects/beta/trust-request', {
    method: 'PUT',
    headers: hdrs(lina, { json: true }),
    body: JSON.stringify({
      trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(prescanReport) },
      prescanReport,
    }),
  });
  expect(up.status).toBe(200);
  const propose = await app.request('/projects/beta/trust', {
    method: 'POST',
    headers: hdrs(putra, { json: true }),
    body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256(prescanReport) }),
  });
  const pending = (await propose.json()) as { id: string };
  await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
}

async function mintTokenFor(s: Setup, id: string): Promise<{ tokenId: string; token: string }> {
  const res = await s.app.request(`/projects/${id}/upload-tokens`, { method: 'POST', headers: hdrs(s.putra, { json: true }) });
  expect(res.status).toBe(201);
  return (await res.json()) as { tokenId: string; token: string };
}

describe('PUT /projects/:id/data — the bundle pipeline (size cap → schema → digests → redaction → stage)', () => {
  it('happy path: 201 staged v1 with digests + empty warnings; files land on disk; audited; NOT served yet', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const b = bundle();
    const res = await upload(s, token, b);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      version: number;
      status: string;
      digests: Record<string, string>;
      uploadDigests: Record<string, string>;
      warnings: string[];
    };
    expect(body.version).toBe(1);
    expect(body.status).toBe('staged');
    expect(body.warnings).toEqual([]);
    // A clean upload passes through byte-identical: stored digests == claimed.
    expect(body.digests).toEqual(b.digests);
    expect(body.uploadDigests).toEqual(b.digests);

    // Files are on DISK (never inside the store JSON).
    const dir = join(s.dataRoot, 'acme', 'v1');
    for (const f of ['inventory.json', 'manifests.json', join('blocks', 'index.json'), join('blocks', 'main.json')]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(await auditActions(s.store, 'acme')).toContain('project-data-upload');

    // Staged serves NOTHING (activation is the separate human step).
    const serve = await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) });
    expect(serve.status).toBe(404);
  });

  it('a second upload stages v2 (versions are immutable, never overwritten)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);
    const res = await upload(s, token);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { version: number }).version).toBe(2);
    expect(existsSync(join(s.dataRoot, 'acme', 'v2', 'inventory.json'))).toBe(true);
  });

  it('SIZE CAP: an oversized body is refused 413 before parsing, nothing stored', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const res = await upload(s, token, 'x'.repeat(16 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe('UPLOAD_TOO_LARGE');
    expect(existsSync(join(s.dataRoot, 'acme'))).toBe(false);
  });

  it('DIGEST BINDING: a bundle that does not hash to its claim → 422 DATA_DIGEST_MISMATCH, nothing stored', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const b = bundle();
    (b.digests as Record<string, string>).inventorySha256 = 'f'.repeat(64);
    const res = await upload(s, token, b);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DATA_DIGEST_MISMATCH');
    expect(existsSync(join(s.dataRoot, 'acme'))).toBe(false);

    // manifests present without manifestsSha256 (and vice versa) also refuse.
    const b2 = bundle();
    delete (b2.digests as Record<string, unknown>).manifestsSha256;
    const res2 = await upload(s, token, b2);
    expect(res2.status).toBe(422);
    expect(((await res2.json()) as { code: string }).code).toBe('DATA_DIGEST_MISMATCH');
  });

  it('strict schema: junk shapes, smuggled keys, unsafe chunk names, and index↔chunks mismatches all 422', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);

    // not JSON at all
    const notJson = await upload(s, token, '{nope');
    expect(notJson.status).toBe(422);

    // smuggled top-level key (strict refusal)
    const smuggled = bundle();
    (smuggled as Record<string, unknown>).extra = true;
    expect((await upload(s, token, smuggled)).status).toBe(422);

    // unsafe chunk names: path traversal shapes and the reserved 'index'
    for (const name of ['../evil', '.hidden', 'index']) {
      const blocks = {
        index: { 'aws_instance.web': name },
        chunks: { [name]: { 'aws_instance.web': { file: 'main.tf', line: 1, source: 'resource {}' } } },
      };
      const res = await upload(s, token, bundle({ blocks }));
      expect(res.status, name).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    }

    // index naming a chunk the bundle does not carry
    const dangling = bundle({
      blocks: {
        index: { 'aws_instance.web': 'main', 'aws_instance.ghost': 'other' },
        chunks: { main: { 'aws_instance.web': { file: 'main.tf', line: 1, source: 'resource {}' } } },
      },
    });
    expect((await upload(s, token, dangling)).status).toBe(422);

    // a chunk address the index does not point at that chunk
    const unindexed = bundle({
      blocks: {
        index: { 'aws_instance.web': 'main' },
        chunks: {
          main: { 'aws_instance.web': { file: 'main.tf', line: 1, source: 'resource {}' } },
          stray: { 'aws_instance.stray': { file: 's.tf', line: 1, source: 'resource {}' } },
        },
      },
    });
    expect((await upload(s, token, unindexed)).status).toBe(422);

    // manifests failing the envelope (no service)
    const badManifest = bundle({ manifests: [{ scope: 'estate', resourceTypes: [], summary: 'x', operations: [] }] });
    expect((await upload(s, token, badManifest)).status).toBe(422);
  });

  it('REDACTION RE-RUN: an unmasked secret in a block is masked server-side, warned, and never served verbatim', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const leaky = bundle({
      blockSource: 'resource "aws_db_instance" "db" {\n  password = "SuperSecret12345"\n}',
    });
    const res = await upload(s, token, leaky);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { version: number; digests: Record<string, string>; uploadDigests: Record<string, string>; warnings: string[] };
    expect(body.warnings.length).toBe(1);
    expect(body.warnings[0]).toContain('masked');
    // Stored digests now differ from the (verified) upload claim — the server's
    // own redaction output is what is stored and served.
    expect(body.digests.blocksSha256).not.toBe(body.uploadDigests.blocksSha256);

    const onDisk = readFileSync(join(s.dataRoot, 'acme', 'v1', 'blocks', 'main.json'), 'utf8');
    expect(onDisk).not.toContain('SuperSecret12345');
    expect(onDisk).toContain('«redacted:');

    // And once activated, the SERVED bytes are the masked ones.
    await activateViaTwoAdmins(s, body.version);
    const served = await (await s.app.request('/projects/acme/blocks/main', { headers: hdrs(s.root) })).text();
    expect(served).not.toContain('SuperSecret12345');
    expect(served).toContain('«redacted:');
  });

  it('REDACTION RE-RUN covers MANIFESTS (security review F4): a secret in an uploaded manifest is masked on disk and in the served bytes, warned, digest recomputed', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    // The manifest envelope is `.passthrough()` — op internals ride along
    // unvalidated, so a leaked credential can hide anywhere inside them.
    const leaky = bundle({
      manifests: [
        {
          service: 'rds',
          scope: 'estate',
          resourceTypes: ['aws_db_instance'],
          summary: 'Day-two RDS operations.',
          operations: [
            { id: 'rds-rotate-master', service: 'rds', defaults: { master_password: 'SuperSecret12345' } },
          ],
        },
      ],
    });
    const res = await upload(s, token, leaky);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      version: number;
      digests: Record<string, string>;
      uploadDigests: Record<string, string>;
      warnings: string[];
    };
    expect(body.warnings.some((w) => w.includes('manifest'))).toBe(true);
    // The manifests digest is recomputed over the MASKED copy; the untouched
    // parts keep their verified upload digests.
    expect(body.digests.manifestsSha256).not.toBe(body.uploadDigests.manifestsSha256);
    expect(body.digests.blocksSha256).toBe(body.uploadDigests.blocksSha256);
    expect(body.digests.inventorySha256).toBe(body.uploadDigests.inventorySha256);

    // Masked AT REST…
    const onDisk = readFileSync(join(s.dataRoot, 'acme', 'v1', 'manifests.json'), 'utf8');
    expect(onDisk).not.toContain('SuperSecret12345');
    expect(onDisk).toContain('«redacted:');
    // …and the envelope survives masking (only string VALUES change).
    const parsed = JSON.parse(onDisk) as Array<{ service: string; operations: Array<{ id: string }> }>;
    expect(parsed[0]!.service).toBe('rds');
    expect(parsed[0]!.operations[0]!.id).toBe('rds-rotate-master');

    // …and masked in the SERVED bytes once activated.
    await activateViaTwoAdmins(s, body.version);
    const served = await (await s.app.request('/projects/acme/manifests', { headers: hdrs(s.root) })).text();
    expect(served).not.toContain('SuperSecret12345');
    expect(served).toContain('«redacted:');
  });
});

/* ═══ activation (dual control) + serve-active-only ═══════════════════════ */

describe('POST /projects/:id/data/:version/activate — 2-admin envelope', () => {
  it('never single-keystroke: 202 PENDING, self-ack 403, second admin ack activates; named audit event lands', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);

    const propose = await s.app.request('/projects/acme/data/1/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    expect(propose.status).toBe(202);
    const pending = (await propose.json()) as { id: string; kind: string; status: string; apply?: unknown };
    expect(pending.kind).toBe('project-data-activate');
    expect(pending.status).toBe('PENDING');
    expect(pending.apply).toBeUndefined();

    // still not served
    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).status).toBe(404);

    const selfAck = await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.putra) });
    expect(selfAck.status).toBe(403);

    const ack = await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) });
    expect(ack.status).toBe(200);

    const list = (await (await s.app.request('/projects', { headers: hdrs(s.putra) })).json()) as Array<Record<string, unknown>>;
    const acme = list.find((p) => p.id === 'acme')!;
    expect((acme.dataActive as { version: number; activatedBy: string }).version).toBe(1);
    expect((acme.dataActive as { activatedBy: string }).activatedBy).toBe('putra');

    // Loosening writes audit as the generic propose/apply pair PLUS the named
    // event the lifecycle hook appends (same trail shape as project-trust) —
    // ALL on the TARGET project's chain (data-plane rule), never the acting scope's.
    const actions = await auditActions(s.store, 'acme');
    expect(actions).toContain('config-propose');
    expect(actions).toContain('config-apply');
    expect(actions).toContain('Activated project data for serving');

    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).status).toBe(200);
  });

  it('activating an unknown version → 404; re-activating the active version → 409', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);
    expect((await s.app.request('/projects/acme/data/9/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) })).status).toBe(404);
    await activateViaTwoAdmins(s, 1);
    const again = await s.app.request('/projects/acme/data/1/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    expect(again.status).toBe(409);
  });

  it('DRIFT GUARD: a registry write between propose and ack fails the ack with STALE_PROPOSAL', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);

    const propose = await s.app.request('/projects/acme/data/1/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    const pending = (await propose.json()) as { id: string };

    // interleaved registry write (archive bumps the version guard)
    expect((await s.app.request('/projects/acme/archive', { method: 'POST', headers: hdrs(s.putra, { json: true }) })).status).toBe(200);

    const ack = await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) });
    expect(ack.status).toBe(409);
    expect(((await ack.json()) as { code: string }).code).toBe('STALE_PROPOSAL');
  });

  it('a fresher upload does NOT invalidate activating an older version (versions are immutable)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);
    const propose = await s.app.request('/projects/acme/data/1/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    const pending = (await propose.json()) as { id: string };
    expect((await upload(s, token)).status).toBe(201); // v2 staged meanwhile
    const ack = await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) });
    expect(ack.status).toBe(200); // v1's bytes were reviewed; v1 is what activates
  });
});

/* ═══ first activation = go-live (trusted → ready rides the 2-admin ack) ══ */

describe('the FIRST activation is the go-live: ready + routability arrive with the ack', () => {
  it('acked first activation → ready: artifacts = the version’s SERVER digests, the id becomes routable/bindable, data serves; NOTHING moves before the ack', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const up = await upload(s, token);
    expect(up.status).toBe(201);
    const staged = (await up.json()) as { version: number; digests: Record<string, string> };

    const propose = await s.app.request('/projects/acme/data/1/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    expect(propose.status).toBe(202);
    const pending = (await propose.json()) as {
      id: string;
      before: { status?: string };
      after: { status?: string; artifacts?: Record<string, string> };
    };
    // The second admin's disclosure carries the WHOLE effect: this ack takes
    // the project live, not merely a data swap.
    expect(pending.before.status).toBe('trusted');
    expect(pending.after.status).toBe('ready');
    expect(pending.after.artifacts).toMatchObject({
      inventorySha256: staged.digests.inventorySha256,
      blocksSha256: staged.digests.blocksSha256,
      manifestsSha256: staged.digests.manifestsSha256,
      recordedBy: 'putra',
    });

    // ONE admin changes nothing: still trusted, unrouted, unbindable, unserved.
    expect(isKnownProject('acme')).toBe(false);
    expect(isValidProjectBinding('acme')).toBe(false);
    expect((await s.app.request('/requests?scope=all', { headers: hdrs(s.root, { project: 'acme' }) })).status).toBe(422);
    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).status).toBe(404);
    const midList = (await (await s.app.request('/projects', { headers: hdrs(s.putra) })).json()) as Array<Record<string, unknown>>;
    expect(midList.find((p) => p.id === 'acme')!.status).toBe('trusted');

    const ack = await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) });
    expect(ack.status).toBe(200);

    // Ready, artifacts recorded from the activated version's server-computed
    // digests (recordedBy = the proposer; the acker is the audit actor).
    const list = (await (await s.app.request('/projects', { headers: hdrs(s.putra) })).json()) as Array<Record<string, unknown>>;
    const acme = list.find((p) => p.id === 'acme')!;
    expect(acme.status).toBe('ready');
    expect(acme.artifacts).toMatchObject({
      inventorySha256: staged.digests.inventorySha256,
      blocksSha256: staged.digests.blocksSha256,
      manifestsSha256: staged.digests.manifestsSha256,
      recordedBy: 'putra',
    });
    expect((acme.dataActive as { version: number }).version).toBe(1);

    // ROUTABLE and BINDABLE now — the known-projects cache resynced at ack time…
    expect(isKnownProject('acme')).toBe(true);
    expect(isValidProjectBinding('acme')).toBe(true);
    expect((await s.app.request('/requests?scope=all', { headers: hdrs(s.root, { project: 'acme' }) })).status).toBe(200);
    // …and the activated data serves.
    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).status).toBe(200);
  });

  it('a REJECTED first activation leaves the project trusted and unrouted (no half go-live)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);
    const propose = await s.app.request('/projects/acme/data/1/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    const pending = (await propose.json()) as { id: string };
    expect((await s.app.request(`/admin/config-changes/${pending.id}/reject`, { method: 'POST', headers: hdrs(s.root) })).status).toBe(200);

    const list = (await (await s.app.request('/projects', { headers: hdrs(s.putra) })).json()) as Array<Record<string, unknown>>;
    expect(list.find((p) => p.id === 'acme')!.status).toBe('trusted');
    expect(isKnownProject('acme')).toBe(false);
    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).status).toBe(404);
  });

  it('re-activating on an already-ready project swaps dataActive ONLY: status stays ready, the go-live artifacts record is untouched', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const first = await upload(s, token);
    expect(first.status).toBe(201);
    const v1 = (await first.json()) as { digests: Record<string, string> };
    await activateViaTwoAdmins(s, 1); // the go-live

    // A CHANGED second upload — its blocks digest differs from v1's.
    const v2body = bundle({ blockSource: 'resource "aws_instance" "web" {\n  instance_type = "t3.small"\n}' });
    const second = await upload(s, token, v2body);
    expect(second.status).toBe(201);
    const v2 = (await second.json()) as { digests: Record<string, string> };
    expect(v2.digests.blocksSha256).not.toBe(v1.digests.blocksSha256);

    const propose = await s.app.request('/projects/acme/data/2/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    expect(propose.status).toBe(202);
    const pending = (await propose.json()) as { id: string; after: { status?: string; artifacts?: unknown } };
    // No go-live in this disclosure — it is exactly the data swap it was before.
    expect(pending.after.status).toBeUndefined();
    expect(pending.after.artifacts).toBeUndefined();
    expect((await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) })).status).toBe(200);

    const list = (await (await s.app.request('/projects', { headers: hdrs(s.putra) })).json()) as Array<Record<string, unknown>>;
    const acme = list.find((p) => p.id === 'acme')!;
    expect(acme.status).toBe('ready');
    expect((acme.dataActive as { version: number }).version).toBe(2);
    // The artifacts record still names the GO-LIVE version's digests — it is
    // the completion record, not a rolling pointer (dataActive + the version
    // rows carry what is currently served).
    expect((acme.artifacts as { blocksSha256: string }).blocksSha256).toBe(v1.digests.blocksSha256);
    expect(isKnownProject('acme')).toBe(true);
  });

  it('a version WITHOUT manifests goes live cleanly: artifacts omit manifestsSha256, inventory serves, manifests 404', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    const b = bundle();
    delete (b as Record<string, unknown>).manifests;
    delete (b.digests as Record<string, unknown>).manifestsSha256;
    const up = await upload(s, token, b);
    expect(up.status).toBe(201);
    const staged = (await up.json()) as { digests: Record<string, string | undefined> };
    expect(staged.digests.manifestsSha256).toBeUndefined();

    await activateViaTwoAdmins(s, 1);

    const list = (await (await s.app.request('/projects', { headers: hdrs(s.putra) })).json()) as Array<Record<string, unknown>>;
    const acme = list.find((p) => p.id === 'acme')!;
    expect(acme.status).toBe('ready');
    const artifacts = acme.artifacts as Record<string, string>;
    expect(artifacts.inventorySha256).toBe(staged.digests.inventorySha256);
    expect(artifacts.blocksSha256).toBe(staged.digests.blocksSha256);
    expect('manifestsSha256' in artifacts).toBe(false);

    expect(isKnownProject('acme')).toBe(true);
    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).status).toBe(200);
    // Manifests are optional per version — absent serves a fail-closed 404.
    expect((await s.app.request('/projects/acme/manifests', { headers: hdrs(s.root) })).status).toBe(404);
  });

});

describe('GET /projects/:id/data — the versions list (lead+isAdmin)', () => {
  it('lists staged + active with the pointer; requester/approver/non-admin-lead are refused', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    await upload(s, token);
    await upload(s, token);
    await activateViaTwoAdmins(s, 1);

    const res = await s.app.request('/projects/acme/data', { headers: hdrs(s.putra) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activeVersion: number; versions: Array<Record<string, unknown>> };
    expect(body.activeVersion).toBe(1);
    expect(body.versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'active'],
      [2, 'staged'],
    ]);
    // metadata, not content: counts + digests + provenance are all there
    expect(body.versions[0]!.counts).toEqual({ resources: 1, blockAddresses: 1, blockChunks: 1, manifests: 1 });
    expect(body.versions[0]!.providerPins).toEqual({ aws: '~> 6.0' });
    expect(JSON.stringify(body)).not.toContain('"PK"');

    for (const cookie of [s.sari, s.budi, s.lina]) {
      expect((await s.app.request('/projects/acme/data', { headers: hdrs(cookie) })).status).toBe(403);
    }
  });
});

describe('the serve endpoints — active-only, target-bound (least disclosure)', () => {
  async function serveReady(s: Setup): Promise<void> {
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);
    await activateViaTwoAdmins(s, 1);
  }

  it('serves the ACTIVE version byte-for-byte: manifests, inventory, blocks index, and a chunk', async () => {
    const s = await setup();
    await serveReady(s);

    const manifests = await s.app.request('/projects/acme/manifests', { headers: hdrs(s.root) });
    expect(manifests.status).toBe(200);
    expect(manifests.headers.get('content-type')).toContain('application/json');
    const mBody = (await manifests.json()) as Array<{ service: string }>;
    expect(mBody[0]!.service).toBe('ec2');

    const inventory = (await (await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).json()) as {
      resources: Array<{ address: string }>;
    };
    expect(inventory.resources[0]!.address).toBe('aws_instance.web');

    const index = (await (await s.app.request('/projects/acme/blocks/index', { headers: hdrs(s.root) })).json()) as Record<string, string>;
    expect(index).toEqual({ 'aws_instance.web': 'main' });

    const chunk = (await (await s.app.request('/projects/acme/blocks/main', { headers: hdrs(s.root) })).json()) as Record<
      string,
      { source: string }
    >;
    expect(chunk['aws_instance.web']!.source).toContain('aws_instance');
  });

  it('LEAST DISCLOSURE: a session not bound to the TARGET project is refused (403 PROJECT_SCOPE) even though it is bound to the acting scope', async () => {
    const s = await setup();
    await serveReady(s);
    // sari is bound to sample only; the acting scope (sample) passes the group gate,
    // but the TARGET (acme) binding check refuses the read.
    for (const path of ['/projects/acme/manifests', '/projects/acme/inventory', '/projects/acme/blocks/index']) {
      const res = await s.app.request(path, { headers: hdrs(s.sari) });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('PROJECT_SCOPE');
    }
    // An acme-bound (non-wildcard) account CAN read.
    await seedAccount(s.store, { id: 'tia', role: 'requester', teamId: 'platform', isAdmin: false, projects: ['sample', 'acme'] });
    const tia = await sessionCookieFor(s.store, 'tia');
    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(tia) })).status).toBe(200);
  });

  it('unknown chunk names 404 via the STORED allowlist (path shapes never reach the filesystem)', async () => {
    const s = await setup();
    await serveReady(s);
    for (const chunk of ['ghost', '..%2F..%2Fsecrets', 'index.json']) {
      const res = await s.app.request(`/projects/acme/blocks/${chunk}`, { headers: hdrs(s.root) });
      expect(res.status, chunk).toBe(404);
    }
  });

  it('no active data → 404 for every read (fail closed), including unknown projects', async () => {
    const s = await setup();
    await driveToTrusted(s);
    for (const path of ['/projects/acme/manifests', '/projects/acme/inventory', '/projects/acme/blocks/index', '/projects/ghost/inventory']) {
      expect((await s.app.request(path, { headers: hdrs(s.root) })).status, path).toBe(404);
    }
  });
});

/* ═══ archive / unarchive ═════════════════════════════════════════════════ */

describe('archive (tightening, immediate) / unarchive (loosening, 2-admin)', () => {
  /** trusted → CI upload → FIRST activation (2-admin ack). Activation IS the
   * go-live: 'ready' + routability arrive with the ack — there is no other
   * transition to ready. */
  async function driveToReadyActive(s: Setup): Promise<void> {
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);
    await activateViaTwoAdmins(s, 1);
    expect(isKnownProject('acme')).toBe(true);
  }

  it('archive applies immediately (one admin): routability, serving, uploads, and mints all stop; audited', async () => {
    const s = await setup();
    await driveToReadyActive(s);
    const { token } = await mintToken(s); // minted BEFORE the archive

    const res = await s.app.request('/projects/acme/archive', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archived: { archivedBy: string } }).archived.archivedBy).toBe('putra');
    expect(await auditActions(s.store, 'acme')).toContain('project-archive');

    // routability is gone NOW (fail closed)
    expect(isKnownProject('acme')).toBe(false);
    const scoped = await s.app.request('/requests?scope=all', { headers: hdrs(s.root, { project: 'acme' }) });
    expect(scoped.status).toBe(422);

    // serving is gone
    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).status).toBe(404);

    // uploads and mints refuse
    expect((await upload(s, token)).status).toBe(409);
    expect((await mint(s)).status).toBe(409);

    // archiving twice conflicts
    expect((await s.app.request('/projects/acme/archive', { method: 'POST', headers: hdrs(s.putra, { json: true }) })).status).toBe(409);

    // the registry still lists it, flagged, on BOTH tiers
    const asRequester = (await (await s.app.request('/projects', { headers: hdrs(s.sari) })).json()) as Array<Record<string, unknown>>;
    expect((asRequester.find((p) => p.id === 'acme')!.archived as { archivedBy: string }).archivedBy).toBe('putra');
  });

  it('unarchive is NEVER single-keystroke: 202 → second admin ack restores routability and serving', async () => {
    const s = await setup();
    await driveToReadyActive(s);
    await s.app.request('/projects/acme/archive', { method: 'POST', headers: hdrs(s.putra, { json: true }) });

    const propose = await s.app.request('/projects/acme/unarchive', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    expect(propose.status).toBe(202);
    const pending = (await propose.json()) as { id: string; kind: string };
    expect(pending.kind).toBe('project-unarchive');

    // still archived until the ack
    expect(isKnownProject('acme')).toBe(false);

    const ack = await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) });
    expect(ack.status).toBe(200);

    expect(isKnownProject('acme')).toBe(true);
    expect((await s.app.request('/projects/acme/inventory', { headers: hdrs(s.root) })).status).toBe(200);
    expect((await s.app.request('/requests?scope=all', { headers: hdrs(s.root, { project: 'acme' }) })).status).toBe(200);

    // unarchiving a non-archived project conflicts
    expect((await s.app.request('/projects/acme/unarchive', { method: 'POST', headers: hdrs(s.putra, { json: true }) })).status).toBe(409);
  });
});

/* ═══ audit chain targeting (security review F2) ══════════════════════════ */

describe('data-plane actions audit to the TARGET project’s chain, not the acting scope’s', () => {
  it('mint / upload / activate (propose + apply + named event) all land on acme’s chain — and NOT on sample’s; the registry lifecycle stays on the acting scope', async () => {
    const s = await setup();
    await driveToTrusted(s); // register + trust: the acting scope's (sample) record
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);
    await activateViaTwoAdmins(s, 1);

    // The tenant reviewing THEIR OWN chain sees everything done against them…
    const acme = await auditActions(s.store, 'acme');
    for (const action of [
      'upload-token-mint',
      'project-data-upload',
      'config-propose',
      'config-apply',
      'Activated project data for serving',
    ]) {
      expect(acme, action).toContain(action);
    }
    // …and none of it hides on the operator's default (sample) chain any more.
    const sample = await auditActions(s.store);
    for (const action of ['upload-token-mint', 'project-data-upload', 'Activated project data for serving']) {
      expect(sample, action).not.toContain(action);
    }
    // Registry lifecycle is UNCHANGED: register/trust remain the acting scope's record.
    expect(sample).toContain('project-register');
    expect(sample).toContain('Trusted repo for onboarding');

    // The target chain is a REAL tamper-evident chain: genesis, linkage, and
    // head all verify on the fresh per-tenant partition.
    const { entries, head } = await readAuditChronological(s.store, 'acme');
    expect(head).not.toBeNull();
    expect(verifyChain(entries.map(toAuditEntry), { head: head!.hash }).code).toBe(0);
  });

  it('a rejected data-plane proposal resolves on the SAME target chain as its propose (no stranded config-propose)', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);

    const propose = await s.app.request('/projects/acme/data/1/activate', { method: 'POST', headers: hdrs(s.putra, { json: true }) });
    expect(propose.status).toBe(202);
    const pending = (await propose.json()) as { id: string };
    const reject = await s.app.request(`/admin/config-changes/${pending.id}/reject`, { method: 'POST', headers: hdrs(s.root) });
    expect(reject.status).toBe(200);

    const acme = await auditActions(s.store, 'acme');
    expect(acme).toContain('config-propose');
    expect(acme).toContain('config-reject');
    expect(await auditActions(s.store)).not.toContain('config-reject');
  });
});

/* ═══ deregister cleanup ══════════════════════════════════════════════════ */

describe('deregister-ack cleanup — no credential or data outlives its project', () => {
  it('acked deregister of a LIVE project removes routability, token rows, version rows, and the on-disk files', async () => {
    const s = await setup();
    await driveToTrusted(s);
    const { token, tokenId } = await mintToken(s);
    expect((await upload(s, token)).status).toBe(201);
    expect(existsSync(join(s.dataRoot, 'acme', 'v1'))).toBe(true);
    await activateViaTwoAdmins(s, 1); // the go-live: ready + routable
    expect(isKnownProject('acme')).toBe(true);

    const del = await s.app.request('/projects/acme', { method: 'DELETE', headers: hdrs(s.putra) });
    expect(del.status).toBe(202);
    const pending = (await del.json()) as { id: string };
    const ack = await s.app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(s.root) });
    expect(ack.status).toBe(200);

    // the scope died with it (fail closed): unrouted, unbindable
    expect(isKnownProject('acme')).toBe(false);
    expect((await s.app.request('/requests?scope=all', { headers: hdrs(s.root, { project: 'acme' }) })).status).toBe(422);

    const tKey = uploadTokenKey('acme', tokenId);
    expect(await s.store.get(tKey.PK, tKey.SK)).toBeNull();
    expect(await s.store.query('PROJECT#acme', 'DATA#v')).toEqual([]);
    expect(existsSync(join(s.dataRoot, 'acme'))).toBe(false);
  });
});
