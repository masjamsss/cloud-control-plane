import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AccountItem, PolicyItem } from '../src/store/schema';
import { AccountItem as AccountItemSchema, PolicyItem as PolicyItemSchema, accountKey, accountsGsi, policyKey } from '../src/store/schema';
import { mintSession, resolveSession } from '../src/auth/sessions';
import { __setKnownProjects } from '../src/projects';
import { accountIdentityDrift, runAccountIdentityRepair } from '../src/domain/accountIdentityRepair';

/**
 * DATA-11 — the v1 import wrote rows by CAST, so nothing checked them against
 * the schemas the store actually enforces.
 *
 * Three defects, one shape: a document validated only against v1's own shapes
 * became store rows nobody validated. The test is written against the SHAPE —
 * "every row this route writes satisfies its store schema" — rather than against
 * the three fields the finding happened to name (L-25), so a future store-schema
 * constraint is covered here without anyone remembering to add a case.
 *
 * The `id !== username` arm is the one that matters most: it produces an account
 * that can log in and can never hold a session, which no admin verb can repair.
 */

const v1Fixture = JSON.parse(readFileSync(new URL('./fixtures/v1-export.json', import.meta.url), 'utf8')) as Record<string, unknown>;

/** A deep copy of the good fixture, so each case mutates only its own arm. */
function doc(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v1Fixture));
}

beforeEach(() => __setKnownProjects(['sample']));

async function seedBootstrapAdmin(store: ConfigStore): Promise<string> {
  await store.put({
    ...accountKey('putra'),
    id: 'putra',
    username: 'putra',
    displayName: 'Putra',
    role: 'lead',
    teamId: 'platform',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: true,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    GSI1PK: accountsGsi(),
    GSI1SK: 'putra',
  } satisfies AccountItem);
  return `ccp_session=${await mintSession(store, 'putra', 1)}`;
}

async function migrate(app: ReturnType<typeof createApp>, cookie: string, body: unknown): Promise<Response> {
  return app.request('/admin/migrate/v1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}

async function setup(): Promise<{ store: ConfigStore; app: ReturnType<typeof createApp>; cookie: string }> {
  const store = new MemoryStore();
  const cookie = await seedBootstrapAdmin(store);
  return { store, app: createApp(store), cookie };
}

describe('DATA-11 — the v1 import cannot write a row its store schema rejects', () => {
  it('the good fixture still imports, and EVERY row it wrote parses as its store schema', async () => {
    // L-1 — the rule below is only evidence if the import actually wrote rows.
    const { store, app, cookie } = await setup();
    expect((await migrate(app, cookie, doc())).status).toBe(200);

    const accounts = (await store.queryGSI1(accountsGsi())).filter((a) => a.username !== 'putra');
    expect(accounts.length).toBeGreaterThan(0);
    for (const row of accounts) expect(AccountItemSchema.safeParse(row).success).toBe(true);

    const pk = policyKey('sample');
    const policy = await store.get(pk.PK, pk.SK);
    expect(policy).not.toBeNull();
    expect(PolicyItemSchema.safeParse(policy).success).toBe(true);
  });

  it('out-of-contract policy numbers are refused, and NOTHING is written', async () => {
    // PolicyItem requires integers 1..5; V1Policy accepted any number, so `high: 0`
    // and `deleteMin: 7.5` landed verbatim and drove approvalsRequired out of contract.
    for (const bad of [{ high: 0 }, { deleteMin: 7.5 }, { low: 99 }]) {
      const { store, app, cookie } = await setup();
      const body = doc();
      body['ccp.policy.v1'] = { ...(body['ccp.policy.v1'] as object), ...bad };

      const res = await migrate(app, cookie, body);
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');

      // The refusal is WHOLE-DOCUMENT: a partial import is not a state anyone can
      // reason about, and the operator's re-run is only available while the
      // backend still holds just the bootstrap account.
      const pk = policyKey('sample');
      expect(await store.get(pk.PK, pk.SK)).toBeNull();
      expect((await store.queryGSI1(accountsGsi())).length).toBe(1); // bootstrap only
    }
  });

  it('an account whose id does not equal its username is REFUSED, not silently rewritten', async () => {
    const { store, app, cookie } = await setup();
    const body = doc();
    const accounts = body['ccp.accounts.v1'] as Array<Record<string, unknown>>;
    accounts[0]!.id = 'some-other-identity';
    // L-1 — the arm under test really is the mismatch, not a coincidental reject.
    expect(accounts[0]!.id).not.toBe(accounts[0]!.username);

    const res = await migrate(app, cookie, body);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
    expect((await store.queryGSI1(accountsGsi())).length).toBe(1);
  });

  it('a username outside the enrolment grammar cannot reach a partition key', async () => {
    // accountKey() interpolates the username straight into a PK. Enrolment has
    // always constrained it; the import did not.
    for (const username of ['Bad Upper', 'has space', 'x', 'a'.repeat(33), 'sl/ash', '#hash']) {
      const { store, app, cookie } = await setup();
      const body = doc();
      (body['ccp.accounts.v1'] as Array<Record<string, unknown>>)[0] = {
        ...(body['ccp.accounts.v1'] as Array<Record<string, unknown>>)[0]!,
        id: username,
        username,
      };
      expect((await migrate(app, cookie, body)).status).toBe(422);
      expect((await store.queryGSI1(accountsGsi())).length).toBe(1);
    }
  });
});

describe('DATA-11 — the repair path for rows already written', () => {
  /** An account row in the exact broken shape the old import produced. */
  async function seedDriftedAccount(store: ConfigStore): Promise<void> {
    await store.put({
      ...accountKey('dewi'), // keyed by USERNAME…
      id: 'v1-legacy-id-9', // …but identified by something else
      username: 'dewi',
      displayName: 'Dewi',
      roles: { sample: { role: 'requester', teamId: 'platform' } },
      status: 'active',
      createdAt: '2026-07-11T00:00:00.000Z',
      createdBy: 'v1-import',
      mustChangePassword: false,
      isAdmin: false,
      credential: { algo: 'pbkdf2', hash: 'h', salt: 's', iterations: 100000 },
      failedAttempts: 0,
      sessionVersion: 3, // NOT 0 — read it back, never guess it
      GSI1PK: accountsGsi(),
      GSI1SK: 'dewi',
    });
  }

  it('a drifted row cannot hold a session BEFORE the repair, and can after it', async () => {
    const store = new MemoryStore();
    await seedDriftedAccount(store);
    const acct = (await store.get(accountKey('dewi').PK, accountKey('dewi').SK)) as AccountItem;

    // L-1 — pin the precondition: the session is minted with the row's OWN
    // sessionVersion and its OWN id, exactly as auth/login does.
    expect(acct.id).not.toBe(acct.username);
    const token = await mintSession(store, acct.id, acct.sessionVersion);
    const before = await resolveSession(store, token);
    expect(before.ok).toBe(false); // authenticates, can never hold a session
    expect(before.ok === false && before.reason).toBe('invalid');

    const tally = await runAccountIdentityRepair(store);
    expect(tally.repaired).toBe(1);
    expect(tally.usernames).toEqual(['dewi']);

    // A session minted after the repair resolves. (The pre-repair token stays
    // dead — it was never resolvable, so nothing regressed.)
    const healed = (await store.get(accountKey('dewi').PK, accountKey('dewi').SK)) as AccountItem;
    expect(healed.id).toBe('dewi');
    expect(healed.sessionVersion).toBe(3); // value-preserving apart from identity
    expect(healed.credential.algo).toBe('pbkdf2');
    const after = await resolveSession(store, await mintSession(store, healed.id, healed.sessionVersion));
    expect(after.ok).toBe(true);
  });

  it('is idempotent and leaves healthy rows completely untouched', async () => {
    const store = new MemoryStore();
    await seedBootstrapAdmin(store);
    await seedDriftedAccount(store);

    const healthyBefore = await store.get(accountKey('putra').PK, accountKey('putra').SK);
    expect(await runAccountIdentityRepair(store)).toMatchObject({ repaired: 1 });
    // Second run finds nothing — the invariant now holds everywhere.
    expect(await runAccountIdentityRepair(store)).toMatchObject({ repaired: 0, usernames: [] });
    expect(await store.get(accountKey('putra').PK, accountKey('putra').SK)).toEqual(healthyBefore);
  });

  it('the drift predicate is keyed on the KEY, which is what lookups address', () => {
    // Written as the rule so it also catches a row whose `username` field drifted
    // from its key — the same unresolvable shape from the other direction.
    expect(accountIdentityDrift({ PK: 'ACCOUNT#dewi', SK: 'META', id: 'dewi', username: 'dewi' })).toEqual([]);
    expect(accountIdentityDrift({ PK: 'ACCOUNT#dewi', SK: 'META', id: 'other', username: 'dewi' })).toEqual(['id']);
    expect(accountIdentityDrift({ PK: 'ACCOUNT#dewi', SK: 'META', id: 'dewi', username: 'other' })).toEqual(['username']);
    // Not an account row → not this pass's business.
    expect(accountIdentityDrift({ PK: 'PROJECT#acme', SK: 'META', id: 'acme' })).toEqual([]);
  });

  it('a blank store is a no-op', async () => {
    expect(await runAccountIdentityRepair(new MemoryStore())).toEqual({ repaired: 0, usernames: [] });
  });
});

/** Unused-import guard: PolicyItem is referenced as a type above. */
export type _PolicyItem = PolicyItem;
