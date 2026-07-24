import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AuditItem, ProjectOnboardTokenItem } from '../src/store/schema';
import { onboardTokenKey } from '../src/store/schema';
import { __resetKnownProjectsForTests, isKnownProject } from '../src/projects';
import { __setNow } from '../src/clock';
import { UPLOAD_RATE_CAPACITY, __resetUploadRateLimitForTests } from '../src/middleware/rateLimit';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * The projects registry + onboarding trust surface (0033 §3.2). THE SECURITY
 * POSTURE IS THE POINT, so this suite is adversarial by construction:
 * authz-denial per endpoint, mass-assignment refusal (strict zod), the sha
 * binding recomputed server-side, the fail-closed verdict rule (a reject can
 * NEVER be trusted), dual-control on trust/deregister (never single-keystroke),
 * stale-proposal drift, and rawReport never serializing. Ready — and the
 * routability that arrives with it — comes ONLY from the first data
 * activation's 2-admin ack; that go-live (before/after, fail closed) is
 * covered in projectData.test.ts.
 */

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE). This suite predates that concept
// entirely and is unconcerned with it (that's controlScope.test.ts's job) — every
// call here always meant "act on the sample estate", so the default below preserves
// that, exactly like the real SPA (which always sends an explicit project header).
function hdrs(cookie: string, opts: { json?: boolean; client?: boolean; project?: string } = {}): Record<string, string> {
  const h: Record<string, string> = { cookie };
  if (opts.client !== false) h['x-ccp-client'] = 'ccp-spa';
  if (opts.json) h['content-type'] = 'application/json';
  h['x-ccp-project'] = opts.project ?? 'sample';
  return h;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** A byte-faithful stand-in for the Go-marshaled prescan-report.json (2-space
 * indent + trailing newline — the exact bytes onboard.go hashes and writes). */
function reportText(over: Partial<Record<string, unknown>> = {}): string {
  const rep = {
    repo: 'terraform-acme',
    verdict: 'clean',
    findings: [] as unknown[],
    resourceBlocks: 12,
    moduleBlocks: 0,
    tfJsonFiles: 0,
    fmtDirtyFiles: 2,
    providerPins: { aws: '~> 6.0' },
    ...over,
  };
  return `${JSON.stringify(rep, null, 2)}\n`;
}

const COMMIT = 'abc123def4567890abc123def4567890abc123de';

/** The artifact pair a real `catalogctl onboard` run leaves in --out. */
function artifacts(reportOver: Partial<Record<string, unknown>> = {}, trustOver: Partial<Record<string, string>> = {}): {
  trustRequest: { repo: string; commitSha: string; prescanSha256: string };
  prescanReport: string;
} {
  const prescanReport = reportText(reportOver);
  return {
    trustRequest: {
      repo: 'terraform-acme',
      commitSha: COMMIT,
      prescanSha256: sha256(prescanReport),
      ...trustOver,
    },
    prescanReport,
  };
}

const REGISTER = {
  id: 'acme',
  name: 'Acme estate',
  github: { owner: 'acme-co', repo: 'terraform-acme' },
  accountId: '123456789012',
  region: 'ap-southeast-5',
};

type App = ReturnType<typeof createApp>;

async function setup(): Promise<{ store: ConfigStore; app: App; putra: string; lina: string; root: string; sari: string; budi: string }> {
  const store = new MemoryStore();
  await seed(store); // sari (requester) / budi (approver) / putra (lead+admin) / lina (lead)
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  const app = createApp(store);
  return {
    store,
    app,
    putra: await sessionCookieFor(store, 'putra'),
    lina: await sessionCookieFor(store, 'lina'),
    root: await sessionCookieFor(store, 'root'),
    sari: await sessionCookieFor(store, 'sari'),
    budi: await sessionCookieFor(store, 'budi'),
  };
}

async function register(app: App, cookie: string, over: Partial<typeof REGISTER> = {}): Promise<Response> {
  return app.request('/projects', { method: 'POST', headers: hdrs(cookie, { json: true }), body: JSON.stringify({ ...REGISTER, ...over }) });
}

async function upload(app: App, cookie: string, body: unknown = artifacts(), id = 'acme'): Promise<Response> {
  return app.request(`/projects/${id}/trust-request`, { method: 'PUT', headers: hdrs(cookie, { json: true }), body: JSON.stringify(body) });
}

async function proposeTrust(app: App, cookie: string, id = 'acme', body?: { commitSha: string; prescanSha256: string }): Promise<Response> {
  const a = artifacts();
  return app.request(`/projects/${id}/trust`, {
    method: 'POST',
    headers: hdrs(cookie, { json: true }),
    body: JSON.stringify(body ?? { commitSha: a.trustRequest.commitSha, prescanSha256: a.trustRequest.prescanSha256 }),
  });
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
afterEach(() => __setNow(null));

describe('authz — every endpoint refuses the wrong caller (fail closed)', () => {
  it('GET /projects: no session → 401; any bound session → 200', async () => {
    const { app, sari } = await setup();
    const anon = await app.request('/projects');
    expect(anon.status).toBe(401);
    expect((await anon.json()).code).toBe('NO_SESSION');

    const asRequester = await app.request('/projects', { headers: hdrs(sari) });
    expect(asRequester.status).toBe(200);
  });

  it('POST /projects: requester and approver → 403 FORBIDDEN_ROLE; non-admin lead → 403 NOT_ADMIN', async () => {
    const { app, sari, budi, lina } = await setup();
    for (const [cookie, code] of [
      [sari, 'FORBIDDEN_ROLE'],
      [budi, 'FORBIDDEN_ROLE'],
      [lina, 'NOT_ADMIN'],
    ] as const) {
      const res = await register(app, cookie);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe(code);
    }
  });

  it('writes without the CSRF client header → 403 MISSING_CLIENT_HEADER', async () => {
    const { app, putra } = await setup();
    const res = await app.request('/projects', {
      method: 'POST',
      headers: { ...hdrs(putra, { json: true, client: false }) },
      body: JSON.stringify(REGISTER),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MISSING_CLIENT_HEADER');
  });

  it('trust/upload/delete each enforce their own gate (0033 §3.2 authz column)', async () => {
    const { app, store, sari, budi, lina, putra } = await setup();
    expect((await register(app, putra)).status).toBe(201);

    // upload: lead-only — requester/approver refused
    for (const cookie of [sari, budi]) {
      const res = await upload(app, cookie);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('FORBIDDEN_ROLE');
    }
    // a lead WITHOUT isAdmin may upload (the table's one lead-only write)
    expect((await upload(app, lina)).status).toBe(200);

    // trust: lead+isAdmin — a plain lead is refused
    const trustAsLina = await proposeTrust(app, lina);
    expect(trustAsLina.status).toBe(403);
    expect((await trustAsLina.json()).code).toBe('NOT_ADMIN');

    // delete: lead+isAdmin — a plain lead is refused
    const delAsLina = await app.request('/projects/acme', { method: 'DELETE', headers: hdrs(lina) });
    expect(delAsLina.status).toBe(403);
    expect((await delAsLina.json()).code).toBe('NOT_ADMIN');

    // an account not bound to the acting project is denied EVERYTHING here
    await seedAccount(store, { id: 'ghazi', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['bootstrap'] });
    const ghazi = await sessionCookieFor(store, 'ghazi');
    const scoped = await app.request('/projects', { headers: hdrs(ghazi) });
    expect(scoped.status).toBe(403);
    expect((await scoped.json()).code).toBe('PROJECT_SCOPE');
  });
});

describe('GET /projects — two-tier response (security review: cross-tenant report leak closed)', () => {
  // Seed acme with an uploaded REJECT report so there is genuinely sensitive
  // review data (findings with file+line, uploader) to (not) leak.
  async function seedAcmeWithReport(app: App, putra: string, lina: string): Promise<void> {
    expect((await register(app, putra)).status).toBe(201);
    const rejectReport = reportText({
      verdict: 'reject',
      findings: [{ code: 'PROVISIONER', file: 'main.tf', line: 12 }],
    });
    const res = await upload(app, lina, {
      trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(rejectReport) },
      prescanReport: rejectReport,
    });
    expect(res.status).toBe(200);
  }

  it('a plain requester sees the THIN summary only — no trustRequest/report/findings/uploadedBy/createdBy/createdAt/artifacts (the PoC, now closed)', async () => {
    const { app, putra, lina, sari } = await setup();
    await seedAcmeWithReport(app, putra, lina);

    // sari: a requester bound only to ['sample'] — the exact PoC caller
    const res = await app.request('/projects', { headers: hdrs(sari) });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    const acme = list.find((p) => p.id === 'acme')!;
    expect(acme).toBeDefined();

    // the documented any-session fields ARE present (0033 §3.2 line 409)
    expect(acme).toMatchObject({
      id: 'acme',
      name: 'Acme estate',
      accountId: '123456789012',
      region: 'ap-southeast-5',
      status: 'pending-trust',
    });
    expect(acme.github).toEqual({ owner: 'acme-co', repo: 'terraform-acme' });

    // the sensitive fields are STRUCTURALLY ABSENT — the leak is closed
    for (const leaked of ['trustRequest', 'createdBy', 'createdAt', 'artifacts']) {
      expect(acme[leaked], `requester must not see ${leaked}`).toBeUndefined();
    }
    // …and nothing report/findings/uploader-shaped survives serialization anywhere
    const text = JSON.stringify(list);
    for (const needle of ['PROVISIONER', 'main.tf', 'findings', 'uploadedBy', 'rawReport']) {
      expect(text, `requester response must not contain ${needle}`).not.toContain(needle);
    }
  });

  it('a lead+admin still sees the RICH projection (trustRequest + parsed report + findings + createdBy)', async () => {
    const { app, putra, lina, root } = await setup();
    await seedAcmeWithReport(app, putra, lina);

    const res = await app.request('/projects', { headers: hdrs(root) });
    expect(res.status).toBe(200);
    const acme = ((await res.json()) as Array<Record<string, unknown>>).find((p) => p.id === 'acme')!;
    const tr = acme.trustRequest as { report: { verdict: string; findings: unknown[] }; uploadedBy: string };
    expect(tr.report.verdict).toBe('reject');
    expect(tr.report.findings).toHaveLength(1);
    expect(tr.uploadedBy).toBe('lina');
    expect(acme.createdBy).toBe('putra');
    // even the rich tier never leaks the raw uploaded bytes
    expect(JSON.stringify(acme)).not.toContain('rawReport');
  });

  it('a non-admin lead also gets the THIN summary (the gate is the manage tier: lead AND isAdmin)', async () => {
    const { app, putra, lina } = await setup();
    await seedAcmeWithReport(app, putra, lina);
    // lina is a lead but NOT isAdmin — she can upload, but the rich READ is
    // reserved for the register/trust/deregister tier (lead+isAdmin).
    const acme = ((await (await app.request('/projects', { headers: hdrs(lina) })).json()) as Array<Record<string, unknown>>).find((p) => p.id === 'acme')!;
    expect(acme.trustRequest).toBeUndefined();
    expect(acme.createdBy).toBeUndefined();
  });
});

describe('POST /projects — register a draft', () => {
  it('happy path: 201 draft, listed in the registry, audited', async () => {
    const { app, store, putra } = await setup();
    const res = await register(app, putra);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'acme', status: 'draft', accountId: '123456789012', region: 'ap-southeast-5' });
    expect(body.PK).toBeUndefined();

    const list = await app.request('/projects', { headers: hdrs(putra) });
    // 'sample' is ALSO listed: the very first request against this legacy-shaped
    // store (setup()'s seed()) lazily settled it (domain/settlement.ts) — retro-
    // registering 'sample' as a normal ready row, exactly like 'acme' just registered
    // as a normal draft row. Neither is baked; both are real registry entries now.
    expect((await list.json()).map((p: { id: string }) => p.id)).toEqual(['acme', 'sample']);
    expect(await auditActions(store)).toContain('project-register');
    // registering grants NOTHING: a draft is not routable
    expect(isKnownProject('acme')).toBe(false);
  });

  it('duplicate ids refuse: an existing store row and the bundled default both 409', async () => {
    const { app, putra } = await setup();
    expect((await register(app, putra)).status).toBe(201);
    const dup = await register(app, putra);
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('DUPLICATE_PROJECT');

    const sample = await register(app, putra, { id: 'sample' });
    expect(sample.status).toBe(409);
    expect((await sample.json()).code).toBe('DUPLICATE_PROJECT');
  });

  it('validation is strict: bad account id, off-allowlist region, bad slug all 422', async () => {
    const { app, putra } = await setup();
    for (const over of [
      { accountId: '123' },
      { accountId: '12345678901x' },
      { region: 'mars-central-1' },
      { id: 'Bad_Slug' },
      { id: '*' },
    ]) {
      const res = await register(app, putra, over as Partial<typeof REGISTER>);
      expect(res.status, JSON.stringify(over)).toBe(422);
    }
  });

  it('NO MASS ASSIGNMENT: a body smuggling status/trust/artifacts is refused whole (strict zod)', async () => {
    const { app, putra } = await setup();
    for (const extra of [
      { status: 'ready' },
      { trust: { trustedBy: 'me', trustedAt: 'now', preScanReportSha256: 'x', commitSha: 'y' } },
      { artifacts: { inventorySha256: 'a'.repeat(64) } },
      { version: 99 },
    ]) {
      const res = await register(app, putra, extra as never);
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('POST /projects — register an AZURE subscription (0039 S1, provider-discriminated)', () => {
  const AZURE_REGISTER = {
    id: 'contoso',
    name: 'Contoso Azure estate',
    provider: 'azure',
    github: { owner: 'contoso', repo: 'terraform-contoso' },
    subscriptionId: '11111111-2222-3333-4444-555555555555',
    tenantId: '66666666-7777-8888-9999-000000000000',
    location: 'southeastasia',
  };

  async function registerAzure(app: App, cookie: string, over: Record<string, unknown> = {}): Promise<Response> {
    return app.request('/projects', { method: 'POST', headers: hdrs(cookie, { json: true }), body: JSON.stringify({ ...AZURE_REGISTER, ...over }) });
  }

  it('happy path: 201 draft carrying provider:azure + subscription/tenant/location, and NO accountId/region', async () => {
    const { app, store, putra } = await setup();
    const res = await registerAzure(app, putra);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'contoso',
      status: 'draft',
      provider: 'azure',
      subscriptionId: '11111111-2222-3333-4444-555555555555',
      tenantId: '66666666-7777-8888-9999-000000000000',
      location: 'southeastasia',
    });
    // an azure row carries NO aws identity
    expect(body.accountId).toBeUndefined();
    expect(body.region).toBeUndefined();
    expect(await auditActions(store)).toContain('project-register');
    // registering grants NOTHING — a draft is not routable, aws or azure
    expect(isKnownProject('contoso')).toBe(false);
  });

  it('the azure identity survives the registry list read (both tiers project it)', async () => {
    const { app, putra, sari } = await setup();
    expect((await registerAzure(app, putra)).status).toBe(201);
    // rich tier (lead+admin)
    const rich = (await (await app.request('/projects', { headers: hdrs(putra) })).json()).find((p: { id: string }) => p.id === 'contoso');
    expect(rich).toMatchObject({ provider: 'azure', subscriptionId: AZURE_REGISTER.subscriptionId, location: 'southeastasia' });
    // thin tier (a plain requester) still sees the identity (it is a documented any-session field)
    const thin = (await (await app.request('/projects', { headers: hdrs(sari) })).json()).find((p: { id: string }) => p.id === 'contoso');
    expect(thin).toMatchObject({ provider: 'azure', subscriptionId: AZURE_REGISTER.subscriptionId, location: 'southeastasia' });
    expect(thin.accountId).toBeUndefined();
  });

  it('azure validation is strict: bad subscription/tenant GUID, off-allowlist location all 422', async () => {
    const { app, putra } = await setup();
    for (const over of [
      { subscriptionId: 'not-a-guid' },
      { tenantId: '66666666-7777-8888-9999' },
      { location: 'mars-base-1' },
      { location: 'us-east-1' }, // an AWS region is not an Azure location
    ]) {
      const res = await registerAzure(app, putra, over);
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('NO PROVIDER MIXING: an azure body carrying accountId/region, or an aws body carrying azure fields, is refused 422', async () => {
    const { app, putra } = await setup();
    // azure body must not carry aws identity
    const azMixed = await registerAzure(app, putra, { accountId: '123456789012' });
    expect(azMixed.status).toBe(422);
    // aws body (provider absent) must not carry azure identity
    const awsMixed = await register(app, putra, { subscriptionId: '11111111-2222-3333-4444-555555555555' } as never);
    expect(awsMixed.status).toBe(422);
    // an azure body MISSING part of its triple is refused
    const azShort = await app.request('/projects', {
      method: 'POST',
      headers: hdrs(putra, { json: true }),
      body: JSON.stringify({ id: 'contoso', name: 'Contoso', provider: 'azure', github: { owner: 'contoso', repo: 'terraform-contoso' }, subscriptionId: AZURE_REGISTER.subscriptionId }),
    });
    expect(azShort.status).toBe(422);
  });

  it('an azure subscription walks the SAME ladder to trusted (provider persists through the trust ack)', async () => {
    const { app, putra, lina, root } = await setup();
    expect((await registerAzure(app, putra)).status).toBe(201);
    // the prescan report is provider-agnostic — only the repo must match
    const azureReport = reportText({ repo: 'terraform-contoso', providerPins: { azurerm: '~> 4.0' } });
    const up = await app.request('/projects/contoso/trust-request', {
      method: 'PUT',
      headers: hdrs(lina, { json: true }),
      body: JSON.stringify({ trustRequest: { repo: 'terraform-contoso', commitSha: COMMIT, prescanSha256: sha256(azureReport) }, prescanReport: azureReport }),
    });
    expect(up.status).toBe(200);
    const propose = await app.request('/projects/contoso/trust', {
      method: 'POST',
      headers: hdrs(putra, { json: true }),
      body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256(azureReport) }),
    });
    expect(propose.status).toBe(202);
    const pending = await propose.json();
    const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
    expect(ack.status).toBe(200);
    const after = (await (await app.request('/projects', { headers: hdrs(putra) })).json()).find((p: { id: string }) => p.id === 'contoso');
    expect(after.status).toBe('trusted');
    expect(after.provider).toBe('azure');
    expect(after.location).toBe('southeastasia');
  });
});

describe('PUT /projects/:id/trust-request — the artifact upload + sha binding', () => {
  it('happy path: both artifacts land, status pending-trust, report served back (never rawReport)', async () => {
    const { app, store, putra, lina } = await setup();
    await register(app, putra);
    const res = await upload(app, lina);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('pending-trust');
    expect(body.trustRequest.report.verdict).toBe('clean');
    expect(body.trustRequest.report.fmtDirtyFiles).toBe(2);
    expect(body.trustRequest.uploadedBy).toBe('lina');
    expect(JSON.stringify(body)).not.toContain('rawReport');
    expect(await auditActions(store)).toContain('project-trust-request');
  });

  it('THE BINDING: report bytes that do not hash to prescanSha256 → 422 PRESCAN_SHA_MISMATCH', async () => {
    const { app, putra, lina } = await setup();
    await register(app, putra);
    const a = artifacts();
    // one byte of drift in the uploaded report
    const res = await upload(app, lina, { ...a, prescanReport: a.prescanReport.replace('12', '13') });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('PRESCAN_SHA_MISMATCH');
  });

  it('a syntactically-valid but wrong-shaped report is refused (strict schema, unknown keys, bad verdict)', async () => {
    const { app, putra, lina } = await setup();
    await register(app, putra);
    for (const raw of [
      'not json at all',
      `${JSON.stringify({ repo: 'terraform-acme', verdict: 'clean' }, null, 2)}\n`, // missing census fields
      reportText({ extraKey: true }), // unknown key → strict refusal
      reportText({ verdict: 'maybe' }), // off-enum verdict
      reportText({ verdict: 'clean', findings: [{ code: 'PROVISIONER', file: 'main.tf', line: 3 }] }), // clean+findings contradiction
      reportText({ findings: [{ code: 'PROVISIONER', file: 'main.tf', line: 3, note: 'x' }] }), // unknown finding key
    ]) {
      const res = await upload(app, lina, { trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(raw) }, prescanReport: raw });
      expect(res.status, raw.slice(0, 40)).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('the two artifacts must describe the same scan: repo mismatch → 422', async () => {
    const { app, putra, lina } = await setup();
    await register(app, putra);
    const raw = reportText({ repo: 'some-other-repo' });
    const res = await upload(app, lina, { trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(raw) }, prescanReport: raw });
    expect(res.status).toBe(422);
  });

  it('a REJECT report uploads fine (findings must persist for review) — it just can never be trusted', async () => {
    const { app, putra, lina } = await setup();
    await register(app, putra);
    const rejectReport = reportText({ verdict: 'reject', findings: [{ code: 'PROVISIONER', file: 'main.tf', line: 12 }, { code: 'DATA_EXTERNAL', file: 'data.tf', line: 3 }] });
    const res = await upload(app, lina, { trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(rejectReport) }, prescanReport: rejectReport });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('pending-trust');
    expect(body.trustRequest.report.verdict).toBe('reject');
    expect(body.trustRequest.report.findings).toHaveLength(2);
  });

  it('unknown project → 404; a trusted/ready project refuses re-aiming → 409', async () => {
    const { app, putra, lina, root } = await setup();
    expect((await upload(app, lina, artifacts(), 'ghost')).status).toBe(404);

    // drive acme to trusted, then try to re-upload
    await register(app, putra);
    await upload(app, lina);
    const pending = await (await proposeTrust(app, putra)).json();
    await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
    const res = await upload(app, lina);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });
});

/* ═══ pre-trust onboarding tokens (easy-first-import spec §3 A-ii/A-iii) ══
 * A SEPARATE credential from the CI upload token (projectData.test.ts):
 * separate key namespace, EXACT INVERSE status gate (draft/pending-trust
 * only), and it authorizes exactly one verb — the Bearer lane grafted onto
 * PUT /:id/trust-request below. */

async function mintOnboard(app: App, cookie: string, id = 'acme', body?: unknown): Promise<Response> {
  return app.request(`/projects/${id}/onboard-tokens`, {
    method: 'POST',
    headers: hdrs(cookie, { json: true }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function mintOnboardToken(app: App, cookie: string, id = 'acme'): Promise<{ tokenId: string; token: string; expiresAt: string }> {
  const res = await mintOnboard(app, cookie, id);
  expect(res.status).toBe(201);
  return (await res.json()) as { tokenId: string; token: string; expiresAt: string };
}

/** The onboard-token Bearer lane: NO cookie, NO CSRF client header — a CI
 * flow, mirrors projectData.test.ts's `upload` helper for PUT /:id/data. */
async function uploadViaOnboardToken(app: App, token: string, body: unknown = artifacts(), id = 'acme'): Promise<Response> {
  return app.request(`/projects/${id}/trust-request`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** register → upload trust artifacts (session) → propose → second-admin ack. */
async function driveToTrusted(app: App, putra: string, lina: string, root: string, id = 'acme'): Promise<void> {
  await register(app, putra, { id, name: id, github: { owner: 'acme-co', repo: 'terraform-acme' } });
  await upload(app, lina, artifacts(), id);
  const pending = await (await proposeTrust(app, putra, id)).json();
  const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
  expect(ack.status).toBe(200);
}

describe('POST /projects/:id/onboard-tokens — mint (lead+isAdmin, draft/pending-trust only)', () => {
  it('mints at draft: 201 {tokenId, token, expiresAt}; the secret is shown once, only its argon2id hash is stored, revokedAt absent, audited to the TARGET chain (not the acting scope)', async () => {
    const { app, store, putra } = await setup();
    expect((await register(app, putra)).status).toBe(201); // draft

    const res = await mintOnboard(app, putra);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tokenId: string; token: string; expiresAt: string };
    expect(body.token.startsWith(`${body.tokenId}.`)).toBe(true);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    const k = onboardTokenKey('acme', body.tokenId);
    const row = (await store.get(k.PK, k.SK)) as ProjectOnboardTokenItem;
    expect(row.secretHash.startsWith('$argon2id$')).toBe(true);
    expect(row.revokedAt).toBeUndefined();
    const secret = body.token.split('.')[1]!;
    expect(JSON.stringify(row)).not.toContain(secret);

    expect(await auditActions(store, 'acme')).toContain('onboard-token-mint');
    // Registry lifecycle (register) stays on the acting scope's chain; the
    // credential mint against 'acme' must NOT also hide there.
    expect(await auditActions(store)).not.toContain('onboard-token-mint');
  });

  it('mints at pending-trust too (the other half of the allowed window)', async () => {
    const { app, putra, lina } = await setup();
    await register(app, putra);
    expect((await upload(app, lina)).status).toBe(200); // -> pending-trust
    expect((await mintOnboard(app, putra)).status).toBe(201);
  });

  it('refuses once trusted (409) and once archived (409) — the EXACT INVERSE of the upload token gate; unknown project → 404', async () => {
    const { app, putra, lina, root } = await setup();
    expect((await mintOnboard(app, putra, 'ghost')).status).toBe(404);

    await driveToTrusted(app, putra, lina, root);
    const trusted = await mintOnboard(app, putra);
    expect(trusted.status).toBe(409);
    expect((await trusted.json()).code).toBe('STATE_CONFLICT');
    // 'ready' takes the SAME `ONBOARDABLE.has(status)` false branch as
    // 'trusted' above — not re-driven through data upload/activation here
    // (that whole ladder is projectData.test.ts's job) to keep this file
    // filesystem-free; both are equally excluded from {draft, pending-trust}.

    // A fresh DRAFT project can be archived directly (archive has no status
    // precondition of its own) — proves the archived branch independently
    // of the trusted branch above.
    const reg2 = await register(app, putra, { id: 'beta', name: 'Beta estate' });
    expect(reg2.status).toBe(201);
    const archive = await app.request('/projects/beta/archive', { method: 'POST', headers: hdrs(putra, { json: true }) });
    expect(archive.status).toBe(200);
    const archived = await mintOnboard(app, putra, 'beta');
    expect(archived.status).toBe(409);
    expect((await archived.json()).code).toBe('STATE_CONFLICT');
  });

  it('refuses the wrong caller: requester/approver 403 FORBIDDEN_ROLE, non-admin lead 403 NOT_ADMIN', async () => {
    const { app, putra, sari, budi, lina } = await setup();
    await register(app, putra);
    for (const [cookie, code] of [
      [sari, 'FORBIDDEN_ROLE'],
      [budi, 'FORBIDDEN_ROLE'],
      [lina, 'NOT_ADMIN'],
    ] as const) {
      const res = await mintOnboard(app, cookie);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(code);
    }
  });

  it('validates ttlMinutes bounds strictly (below 5 / above 7 days / junk key → 422)', async () => {
    const { app, putra } = await setup();
    await register(app, putra);
    for (const body of [{ ttlMinutes: 1 }, { ttlMinutes: 999999 }, { evil: true }]) {
      const res = await mintOnboard(app, putra, 'acme', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('DELETE /projects/:id/onboard-tokens/:tokenId — revoke (soft: revokedAt stamped, row survives)', () => {
  it('revokes: revokedAt is stamped, the token stops working on the Bearer lane, audited; already-revoked/unknown → 404', async () => {
    const { app, store, putra } = await setup();
    await register(app, putra);
    const { tokenId, token } = await mintOnboardToken(app, putra);

    const revoke = await app.request(`/projects/acme/onboard-tokens/${tokenId}`, { method: 'DELETE', headers: hdrs(putra) });
    expect(revoke.status).toBe(200);
    expect(await auditActions(store, 'acme')).toContain('onboard-token-revoke');

    // The row SURVIVES (unlike the upload token's hard delete) — tombstoned.
    const k = onboardTokenKey('acme', tokenId);
    const row = (await store.get(k.PK, k.SK)) as ProjectOnboardTokenItem;
    expect(row).not.toBeNull();
    expect(typeof row.revokedAt).toBe('string');

    const res = await uploadViaOnboardToken(app, token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('ONBOARD_TOKEN_INVALID');

    const again = await app.request(`/projects/acme/onboard-tokens/${tokenId}`, { method: 'DELETE', headers: hdrs(putra) });
    expect(again.status).toBe(404);
  });

  it('refuses the wrong caller and an unknown token', async () => {
    const { app, putra, sari } = await setup();
    await register(app, putra);
    const { tokenId } = await mintOnboardToken(app, putra);
    const res = await app.request(`/projects/acme/onboard-tokens/${tokenId}`, { method: 'DELETE', headers: hdrs(sari) });
    expect(res.status).toBe(403);
    const ghost = await app.request('/projects/acme/onboard-tokens/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE', headers: hdrs(putra) });
    expect(ghost.status).toBe(404);
  });
});

describe('PUT /projects/:id/trust-request — the onboard-token Bearer lane (easy-first-import spec §3 A-iii)', () => {
  it('accepts a live token WITHOUT any session cookie or CSRF header, runs the SAME validation pipeline, records uploadedBy onboard-token:<id> + optional ci provenance, and audits to the TARGET chain (not the acting/sample scope)', async () => {
    const { app, store, putra, root } = await setup();
    await register(app, putra);
    const { tokenId, token } = await mintOnboardToken(app, putra);

    const ci = { host: 'github' as const, runUrl: 'https://github.com/acme-co/terraform-acme/actions/runs/123456' };
    const res = await uploadViaOnboardToken(app, token, { ...artifacts(), ci });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; trustRequest: { uploadedBy: string; ci?: typeof ci } };
    expect(body.status).toBe('pending-trust');
    expect(body.trustRequest.uploadedBy).toBe(`onboard-token:${tokenId}`);
    expect(body.trustRequest.ci).toEqual(ci);

    // The rich (lead+isAdmin) GET projection carries it too.
    const list = (await (await app.request('/projects', { headers: hdrs(root) })).json()) as Array<Record<string, unknown>>;
    const acme = list.find((p) => p.id === 'acme') as { trustRequest: { uploadedBy: string; ci?: typeof ci } };
    expect(acme.trustRequest.uploadedBy).toBe(`onboard-token:${tokenId}`);
    expect(acme.trustRequest.ci).toEqual(ci);

    // Audits to the TARGET ('acme') chain — a Bearer token has no acting
    // scope, exactly the upload-token lane's own reasoning — NOT 'sample'
    // (the default acting scope every OTHER call in this suite writes to).
    expect(await auditActions(store, 'acme')).toContain('project-trust-request');
    expect(await auditActions(store)).not.toContain('project-trust-request');

    // The two-admin trust ceremony downstream is completely unaffected by
    // which lane produced the pending-trust record.
    const propose = await proposeTrust(app, putra);
    expect(propose.status).toBe(202);
    const pending = (await propose.json()) as { id: string };
    const selfAck = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(putra) });
    expect(selfAck.status).toBe(403);
    const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
    expect(ack.status).toBe(200);
    const after = (await (await app.request('/projects', { headers: hdrs(putra) })).json()) as Array<Record<string, unknown>>;
    expect(after.find((p) => p.id === 'acme')!.status).toBe('trusted');
  });

  it('a malformed ci block is refused whole (422); an absent ci block is fine (byte-identical to before this field existed)', async () => {
    const { app, putra } = await setup();
    await register(app, putra);
    const { token } = await mintOnboardToken(app, putra);
    for (const bad of [
      { ...artifacts(), ci: { host: 'bitbucket', runUrl: 'https://example.com/run/1' } },
      { ...artifacts(), ci: { host: 'github', runUrl: 'http://not-https.example/run/1' } },
      { ...artifacts(), ci: { host: 'github' } },
      { ...artifacts(), ci: { host: 'github', runUrl: 'https://x/y', extra: true } },
    ]) {
      const res = await uploadViaOnboardToken(app, token, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    // fresh token (the project is still pending-trust-eligible; re-mint since
    // none of the above consumed the project's draft/pending-trust window)
    const clean = await uploadViaOnboardToken(app, token, artifacts());
    expect(clean.status).toBe(200);
    expect(((await clean.json()) as { trustRequest: { ci?: unknown } }).trustRequest.ci).toBeUndefined();
  });

  it('runs the IDENTICAL validation as the session lane: sha mismatch, malformed report, and repo disagreement all refuse the same way', async () => {
    const { app, putra } = await setup();
    await register(app, putra);
    const { token } = await mintOnboardToken(app, putra);

    const a = artifacts();
    const shaMismatch = await uploadViaOnboardToken(app, token, { ...a, prescanReport: a.prescanReport.replace('12', '13') });
    expect(shaMismatch.status).toBe(422);
    expect(((await shaMismatch.json()) as { code: string }).code).toBe('PRESCAN_SHA_MISMATCH');

    const raw = reportText({ repo: 'some-other-repo' });
    const repoMismatch = await uploadViaOnboardToken(app, token, {
      trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(raw) },
      prescanReport: raw,
    });
    expect(repoMismatch.status).toBe(422);

    // A reject verdict uploads fine (findings must persist for review) —
    // exactly like the session lane — it just can never be trusted.
    const rejectReport = reportText({ verdict: 'reject', findings: [{ code: 'PROVISIONER', file: 'main.tf', line: 12 }] });
    const reject = await uploadViaOnboardToken(app, token, {
      trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(rejectReport) },
      prescanReport: rejectReport,
    });
    expect(reject.status).toBe(200);
    const trustReject = await app.request('/projects/acme/trust', {
      method: 'POST',
      headers: hdrs(putra, { json: true }),
      body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256(rejectReport) }),
    });
    expect(trustReject.status).toBe(422);
    expect(((await trustReject.json()) as { code: string }).code).toBe('TRUST_VERDICT_NOT_CLEAN');
  });

  it('fail-closes (401 ONBOARD_TOKEN_INVALID, no enumeration): malformed bearer, unknown tokenId, wrong secret, wrong project, expired, revoked; a request with no Authorization at all stays under the normal session gate', async () => {
    const { app, putra } = await setup();
    await register(app, putra);
    const { tokenId, token } = await mintOnboardToken(app, putra);

    // No Authorization header → the normal session gate answers (this lane never opens).
    const anon = await app.request('/projects/acme/trust-request', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' },
      body: JSON.stringify(artifacts()),
    });
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { code: string }).code).toBe('NO_SESSION');

    for (const bad of [
      'not-even-a-token',
      `${tokenId}`, // missing secret half
      `${tokenId}.wrong-secret-wrong-secret`, // wrong secret
      `01ARZ3NDEKTSV4RRFFQ69G5FAV.${token.split('.')[1]}`, // unknown tokenId, real secret
    ]) {
      const res = await uploadViaOnboardToken(app, bad);
      expect(res.status, bad).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('ONBOARD_TOKEN_INVALID');
    }

    // A token minted for acme opens nothing on another project.
    const reg2 = await app.request('/projects', {
      method: 'POST',
      headers: hdrs(putra, { json: true }),
      body: JSON.stringify({ ...REGISTER, id: 'beta', name: 'Beta estate' }),
    });
    expect(reg2.status).toBe(201);
    const cross = await uploadViaOnboardToken(app, token, artifacts(), 'beta');
    expect(cross.status).toBe(401);
    expect(((await cross.json()) as { code: string }).code).toBe('ONBOARD_TOKEN_INVALID');

    // Expired.
    const minted = await mintOnboard(app, putra, 'beta', { ttlMinutes: 5 });
    expect(minted.status).toBe(201);
    const short = (await minted.json()) as { token: string };
    __setNow(() => Date.now() + 6 * 60_000);
    const expired = await uploadViaOnboardToken(app, short.token, artifacts(), 'beta');
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { code: string }).code).toBe('ONBOARD_TOKEN_INVALID');
    __setNow(null);

    // Revoked.
    await app.request(`/projects/acme/onboard-tokens/${tokenId}`, { method: 'DELETE', headers: hdrs(putra) });
    const revoked = await uploadViaOnboardToken(app, token);
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { code: string }).code).toBe('ONBOARD_TOKEN_INVALID');
  });

  it('a valid token cannot bypass the project state gate (defense in depth, mirrors the upload lane): a trusted project → 409 even with a hand-planted token row', async () => {
    const { app, store, putra, lina, root } = await setup();
    await driveToTrusted(app, putra, lina, root); // acme is now trusted — mint refuses it (tested above)
    // Mint on a second, still-draft project, then re-point a copy of that row
    // at 'acme' with a KNOWN hash — the only way to get a "valid" token onto
    // a trusted project, since mint itself refuses it (proving the handler's
    // OWN status re-check, not just the mint-time gate, is what is fail-closed).
    await register(app, putra, { id: 'beta', name: 'Beta estate' });
    const { token } = await mintOnboardToken(app, putra, 'beta');
    const [tokenId, secret] = token.split('.') as [string, string];
    const bKey = onboardTokenKey('beta', tokenId);
    const row = (await store.get(bKey.PK, bKey.SK)) as ProjectOnboardTokenItem;
    await store.put({ ...row, ...onboardTokenKey('acme', tokenId), projectId: 'acme' });
    const res = await uploadViaOnboardToken(app, `${tokenId}.${secret}`, artifacts(), 'acme');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STATE_CONFLICT');
  });

  it('throttles per tokenId BEFORE the argon2 verify (mirrors the upload lane exactly): a wrong-secret flood gets a burst of 401s then 429s; other tokens unaffected; refills over time', async () => {
    const { app, putra } = await setup();
    await register(app, putra);
    const { tokenId, token } = await mintOnboardToken(app, putra);
    const wrong = `${tokenId}.${'A'.repeat(43)}`;
    for (let i = 0; i < UPLOAD_RATE_CAPACITY; i++) {
      const res = await uploadViaOnboardToken(app, wrong);
      expect(res.status, `burst attempt ${i}`).toBe(401);
    }
    const over = await uploadViaOnboardToken(app, wrong);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // Even the CORRECT secret is refused — the gate sits BEFORE verify.
    expect((await uploadViaOnboardToken(app, token)).status).toBe(429);

    __setNow(() => Date.now() + 61_000);
    expect((await uploadViaOnboardToken(app, token)).status).toBe(200);
  });

  it('the token authorizes EXACTLY ONE verb: unusable as a Bearer on PUT /:id/data (wrong namespace); an upload token is equally unusable on THIS lane (cross-direction)', async () => {
    const { app, store, putra, lina, root } = await setup();
    await register(app, putra);
    const { token: onboardToken } = await mintOnboardToken(app, putra);

    // The onboard token on the CI upload-data route: looked up in the
    // UPLOADTOKEN# namespace, where it does not exist — refused, and by the
    // OTHER lane's own code (UPLOAD_TOKEN_INVALID, not ONBOARD_TOKEN_INVALID).
    const onData = await app.request('/projects/acme/data', {
      method: 'PUT',
      headers: { authorization: `Bearer ${onboardToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(onData.status).toBe(401);
    expect(((await onData.json()) as { code: string }).code).toBe('UPLOAD_TOKEN_INVALID');

    // A plain Bearer header on an unrelated route (not a recognized lane at
    // all) stays under the ordinary session gate.
    const onList = await app.request('/projects', { headers: { authorization: `Bearer ${onboardToken}` } });
    expect(onList.status).toBe(401);
    expect(((await onList.json()) as { code: string }).code).toBe('NO_SESSION');

    // Cross-direction: a REAL upload token (minted post-trust) cannot drive
    // the onboard-token Bearer lane either — it is looked up in the
    // ONBOARDTOKEN# namespace, where IT does not exist.
    await driveToTrusted(app, putra, lina, root, 'beta');
    const upToken = await app.request('/projects/beta/upload-tokens', { method: 'POST', headers: hdrs(putra, { json: true }) });
    expect(upToken.status).toBe(201);
    const { token: uploadToken } = (await upToken.json()) as { token: string };
    // 'beta' is already trusted, so this also independently proves the
    // status gate refuses it — but the token itself is looked up first and
    // is simply not found in the onboard-token namespace.
    const crossLane = await uploadViaOnboardToken(app, uploadToken, artifacts(), 'beta');
    expect(crossLane.status).toBe(401);
    expect(((await crossLane.json()) as { code: string }).code).toBe('ONBOARD_TOKEN_INVALID');
    const missing = onboardTokenKey('beta', uploadToken.split('.')[0]!);
    expect(await store.get(missing.PK, missing.SK)).toBeNull();
  });
});

describe('POST /projects/:id/trust — dual-controlled, sha-bound, verdict-fail-closed', () => {
  it('the trust decision is NEVER single-keystroke: propose → 202 PENDING, self-ack → 403, second admin ack applies', async () => {
    const { app, store, putra, lina, root } = await setup();
    await register(app, putra);
    await upload(app, lina);

    const propose = await proposeTrust(app, putra);
    expect(propose.status).toBe(202); // never 200
    const pending = await propose.json();
    expect(pending.kind).toBe('project-trust');
    expect(pending.status).toBe('PENDING');
    expect(pending.apply).toBeUndefined(); // internal replay mechanics never serialize

    // still pending-trust until the SECOND admin acks
    const mid = (await (await app.request('/projects', { headers: hdrs(putra) })).json())[0];
    expect(mid.status).toBe('pending-trust');

    const selfAck = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(putra) });
    expect(selfAck.status).toBe(403);
    expect((await selfAck.json()).code).toBe('SELF_ACK');

    const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
    expect(ack.status).toBe(200);

    const after = (await (await app.request('/projects', { headers: hdrs(putra) })).json())[0];
    expect(after.status).toBe('trusted');
    // R3 §6.4's exact trust block; trustedBy is the PROPOSING lead who read the findings
    const a = artifacts();
    expect(after.trust).toMatchObject({ trustedBy: 'putra', preScanReportSha256: a.trustRequest.prescanSha256, commitSha: COMMIT });
    expect(typeof after.trust.trustedAt).toBe('string');

    const actions = await auditActions(store);
    expect(actions).toContain('config-propose');
    expect(actions).toContain('config-apply');
    expect(actions).toContain('Trusted repo for onboarding');
  });

  it('FAIL-CLOSED VERDICT RULE: a reject verdict can never be trusted (422, no pending change created)', async () => {
    const { app, putra, lina } = await setup();
    await register(app, putra);
    const rejectReport = reportText({ verdict: 'reject', findings: [{ code: 'PROVISIONER', file: 'main.tf', line: 12 }] });
    await upload(app, lina, { trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: sha256(rejectReport) }, prescanReport: rejectReport });

    const res = await app.request('/projects/acme/trust', {
      method: 'POST',
      headers: hdrs(putra, { json: true }),
      body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256(rejectReport) }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('TRUST_VERDICT_NOT_CLEAN');

    const queue = await (await app.request('/admin/config-changes', { headers: hdrs(putra) })).json();
    expect(queue).toHaveLength(0);
  });

  it('the confirmer must echo the stored binding: a different commitSha or sha256 → 422', async () => {
    const { app, putra, lina } = await setup();
    await register(app, putra);
    await upload(app, lina);
    for (const body of [
      { commitSha: 'f'.repeat(40), prescanSha256: artifacts().trustRequest.prescanSha256 },
      { commitSha: COMMIT, prescanSha256: 'f'.repeat(64) },
    ]) {
      const res = await app.request('/projects/acme/trust', { method: 'POST', headers: hdrs(putra, { json: true }), body: JSON.stringify(body) });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('trust requires pending-trust: a draft project → 409', async () => {
    const { app, putra } = await setup();
    await register(app, putra);
    const res = await proposeTrust(app, putra);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('DRIFT GUARD: a re-upload between propose and ack makes the ack refuse STALE_PROPOSAL', async () => {
    const { app, putra, lina, root } = await setup();
    await register(app, putra);
    await upload(app, lina);
    const pending = await (await proposeTrust(app, putra)).json();

    // the trust request is replaced (version bump) while the proposal is pending
    expect((await upload(app, lina)).status).toBe(200);

    const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
    expect(ack.status).toBe(409);
    expect((await ack.json()).code).toBe('STALE_PROPOSAL');

    // and the project was NOT trusted
    const after = (await (await app.request('/projects', { headers: hdrs(putra) })).json())[0];
    expect(after.status).toBe('pending-trust');
  });
});

describe('DELETE /projects/:id — deregister is always a two-admin envelope', () => {
  // (Deregistering a LIVE project — routability and served data dying with the
  // ack — is covered in projectData.test.ts, where the go-live lane lives.)
  it('202 → second admin ack removes the project', async () => {
    const { app, putra, lina, root } = await setup();
    await register(app, putra);
    await upload(app, lina);
    const trustPending = await (await proposeTrust(app, putra)).json();
    await app.request(`/admin/config-changes/${trustPending.id}/ack`, { method: 'POST', headers: hdrs(root) });

    const del = await app.request('/projects/acme', { method: 'DELETE', headers: hdrs(putra) });
    expect(del.status).toBe(202); // never immediate
    const pending = await del.json();
    expect(pending.kind).toBe('project-deregister');

    // still present until the ack — 2, not 1: 'sample' is ALSO a real registry row now
    // (this store's setup() legacy-settled it on the very first request above).
    expect(((await (await app.request('/projects', { headers: hdrs(putra) })).json()) as unknown[]).length).toBe(2);

    const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(root) });
    expect(ack.status).toBe(200);
    // acme is gone; sample (never touched by this test) remains.
    expect(((await (await app.request('/projects', { headers: hdrs(putra) })).json()) as unknown[]).length).toBe(1);
  });

  it('deleting an unknown project → 404', async () => {
    const { app, putra } = await setup();
    const res = await app.request('/projects/ghost', { method: 'DELETE', headers: hdrs(putra) });
    expect(res.status).toBe(404);
  });
});

describe('serialization hygiene', () => {
  it('the registry response never leaks rawReport, keys, or credential-bearing internals', async () => {
    const { app, putra, lina } = await setup();
    await register(app, putra);
    await upload(app, lina);
    const text = await (await app.request('/projects', { headers: hdrs(putra) })).text();
    for (const needle of ['rawReport', '"PK"', '"SK"', 'GSI1PK', 'credential']) {
      expect(text).not.toContain(needle);
    }
  });
});
