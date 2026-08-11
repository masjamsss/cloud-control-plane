import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import {
  driftPointerKey,
  driftProposalKey,
  driftVersionKey,
  forgeCredentialKey,
  onboardTokenKey,
  projectDataVersionKey,
  projectKey,
  projectRetirementKey,
  scanJobKey,
  uploadTokenKey,
} from '../src/store/schema';
import { __resetKnownProjectsForTests } from '../src/projects';
import { __resetUploadRateLimitForTests } from '../src/middleware/rateLimit';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * API-9 — deregistering a project must not leave satellite rows behind, and a
 * deregistered project id must never be re-issued to a different tenant.
 *
 * THIS IS A CROSS-TENANT DATA-LEAK TEST, not a cleanup test. The rows that used
 * to survive a deregistration were not cosmetic: `FORGECRED` is the sealed
 * credential the scan-claim lane opens to clone a private repository, and it was
 * resolved by PARTITION (`PROJECT#<id>`), so whoever took the id next got the
 * previous operator's forge token pointed at their repository.
 *
 * The two assertions are written as RULES rather than as the four prefixes the
 * finding happened to enumerate (L-25):
 *
 *   1. after a deregister ack the ONLY row under `PROJECT#<id>` is the
 *      retirement tombstone — whatever was there before, and whatever satellite
 *      kind is invented next;
 *   2. `POST /projects` refuses any id whose partition is non-empty.
 *
 * A future satellite row type therefore fails this suite on the day it is added
 * without being deleted, instead of the day someone re-registers an id.
 */

// Every call here acts on the 'sample' estate, exactly like the real SPA (which
// always sends an explicit project header).
function hdrs(cookie: string, opts: { json?: boolean } = {}): Record<string, string> {
  const h: Record<string, string> = { cookie, 'x-ccp-client': 'ccp-spa', 'x-ccp-project': 'sample' };
  if (opts.json) h['content-type'] = 'application/json';
  return h;
}

const REGISTER = {
  id: 'acme',
  name: 'Acme estate',
  github: { owner: 'acme-co', repo: 'terraform-acme' },
  accountId: '123456789012',
  region: 'ap-southeast-5',
};

type App = ReturnType<typeof createApp>;

async function setup(): Promise<{ store: ConfigStore; app: App; putra: string; root: string }> {
  const store = new MemoryStore();
  await seed(store);
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  return {
    store,
    app: createApp(store),
    putra: await sessionCookieFor(store, 'putra'),
    root: await sessionCookieFor(store, 'root'),
  };
}

function register(app: App, cookie: string, over: Partial<typeof REGISTER> = {}): Promise<Response> {
  return app.request('/projects', { method: 'POST', headers: hdrs(cookie, { json: true }), body: JSON.stringify({ ...REGISTER, ...over }) });
}

/**
 * Seed one row of EVERY satellite kind the schema can place under a project's
 * registry partition. Keys come from the real key functions, never hand-typed —
 * a hand-typed key makes a sweep test pass by finding nothing (the fixture trap
 * the runbook names). Returns the SKs it wrote so the test can assert the setup
 * actually landed (L-1).
 */
async function seedSatellites(store: ConfigStore, id: string): Promise<string[]> {
  const rows = [
    { ...uploadTokenKey(id, '01J0UPLOAD0000000000000000'), projectId: id },
    { ...onboardTokenKey(id, '01J0ONBOARD000000000000000'), projectId: id },
    { ...projectDataVersionKey(id, 1), projectId: id, version: 1 },
    // The four the old hardcoded prefix list did not know about.
    { ...forgeCredentialKey(id), projectId: id, sealed: 'sealed-blob', username: 'ci-bot' },
    { ...scanJobKey(id, '01J0SCANJOB000000000000000'), projectId: id, status: 'uploaded' },
    { ...driftVersionKey(id, 1), projectId: id, version: 1 },
    { ...driftPointerKey(id), projectId: id, version: 1 },
    { ...driftProposalKey(id, 'a'.repeat(64)), projectId: id, status: 'open' },
  ];
  for (const row of rows) await store.put(row);
  return rows.map((r) => r.SK);
}

/** Take a registered draft through the two-admin deregister envelope. */
async function deregister(app: App, proposer: string, acker: string, id = 'acme'): Promise<Response> {
  const del = await app.request(`/projects/${id}`, { method: 'DELETE', headers: hdrs(proposer) });
  expect(del.status).toBe(202); // deregistration is NEVER single-keystroke
  const pending = await del.json();
  return app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(acker) });
}

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
});

describe('API-9 — deregistration sweeps the whole registry partition', () => {
  it('leaves NOTHING under PROJECT#<id> except the retirement tombstone', async () => {
    const { app, store, putra, root } = await setup();
    expect((await register(app, putra)).status).toBe(201);
    const seeded = await seedSatellites(store, 'acme');

    // L-1 — assert the setup fired. A sweep test whose partition was empty
    // passes for the wrong reason, and the rows that matter most here are the
    // ones the old prefix list missed, so pin them by name.
    const before = await store.query(projectKey('acme').PK);
    expect(before.length).toBe(seeded.length + 1); // + the META row register wrote
    for (const sk of ['FORGECRED', 'DRIFT#latest']) {
      expect(before.map((r) => r.SK)).toContain(sk);
    }

    expect((await deregister(app, putra, root)).status).toBe(200);

    // THE RULE: one row survives, and it is the tombstone. Not "the four
    // prefixes the finding listed are gone" — everything is gone.
    const after = await store.query(projectKey('acme').PK);
    expect(after.map((r) => r.SK)).toEqual([projectRetirementKey('acme').SK]);

    // The sealed forge credential in particular — the row that made this a
    // credential leak rather than a tidiness problem.
    const cred = forgeCredentialKey('acme');
    expect(await store.get(cred.PK, cred.SK)).toBeNull();

    // The tombstone records that the sweep ran, and how much it removed. The
    // count is the satellites only: the META row was the dual-controlled delete
    // the ack itself applied, so it is already gone when the hook runs.
    const tomb = after[0]!;
    expect(tomb.retiredBy).toBe('root'); // the ACKER, the second control
    expect(tomb.sweptRows).toBe(seeded.length);
  });

  it('retires the id: re-registering it is refused, so no new tenant can inherit it', async () => {
    const { app, store, putra, root } = await setup();
    expect((await register(app, putra)).status).toBe(201);
    await seedSatellites(store, 'acme');
    expect((await deregister(app, putra, root)).status).toBe(200);

    const reuse = await register(app, putra, { name: 'Different tenant entirely' });
    expect(reuse.status).toBe(409);
    expect((await reuse.json()).code).toBe('PROJECT_ID_RETIRED');

    // And the registry really is empty of it — the refusal is not hiding a
    // half-registered row.
    const list = (await (await app.request('/projects', { headers: hdrs(putra) })).json()) as Array<{ id: string }>;
    expect(list.map((p) => p.id)).not.toContain('acme');
  });

  it('refuses a claim on ANY non-empty partition, not just a tombstoned one', async () => {
    // The rule is "the partition is empty", so an id carrying a leftover
    // satellite with no META row — a half-completed cleanup, or a row kind this
    // build has never heard of — is refused too. Registering used to check only
    // the META row, which is exactly how the leak became reachable.
    const { app, store, putra } = await setup();
    await store.put({ ...forgeCredentialKey('acme'), projectId: 'acme', sealed: 'previous-tenants-token', username: 'ci-bot' });

    const res = await register(app, putra);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DUPLICATE_PROJECT');

    // The credential was NOT adopted by a new registration.
    const cred = forgeCredentialKey('acme');
    expect((await store.get(cred.PK, cred.SK))?.sealed).toBe('previous-tenants-token');
  });

  it('a plain duplicate (live project) still reports DUPLICATE_PROJECT, not the retirement code', async () => {
    const { app, putra } = await setup();
    expect((await register(app, putra)).status).toBe(201);
    const dup = await register(app, putra);
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('DUPLICATE_PROJECT');
  });
});
