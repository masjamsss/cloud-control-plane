import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { FileStore } from '../src/store/fileStore';
import { accountKey, accountsGsi, type AccountItem } from '../src/store/schema';
import { bootstrap } from '../scripts/bootstrap';
import { exportAuditChain } from '../src/domain/auditQuery';
import { CONTROL_SCOPE } from '../src/projects';
import { sessionCookieFor } from './helpers/seed';
import { main, runGrantAdmin } from '../scripts/grant-admin';

/**
 * G6 (proposal 0021 §3.3): the offline "second admin" bootstrap script. Day-0
 * `scripts/bootstrap.ts` seeds exactly ONE admin; minting a second one in-app is
 * itself a `loosening` isAdmin grant that needs a second DISTINCT active admin to
 * ack — infeasible with exactly one. This script is the sanctioned escape hatch
 * (ADR-0011 Consequences), run from a reviewed PR, through the SAME store + audit
 * code paths the API uses (no hand-rolled JSON writes).
 */

const silent = { log: () => {}, error: () => {} };

function account(overrides: Partial<AccountItem> & Pick<AccountItem, 'id'>): AccountItem {
  const id = overrides.id;
  return {
    ...accountKey(id),
    username: id,
    displayName: id,
    role: 'requester',
    teamId: 'platform',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    GSI1PK: accountsGsi(),
    GSI1SK: id,
    ...overrides,
  };
}

describe('runGrantAdmin — happy path and refusals (MemoryStore, unit-level)', () => {
  it('grants isAdmin to an activated requester, bumps sessionVersion, and audits it', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true })); // sole bootstrap admin
    await store.put(account({ id: 'budi' })); // activated requester (Phase 2 of the runbook)

    const staleCookie = await sessionCookieFor(store, 'budi');
    const app = createApp(store);
    expect((await app.request('/auth/me', { headers: { cookie: staleCookie } })).status).toBe(200);

    const res = await runGrantAdmin({ store, username: 'budi', pr: 'pr#42', io: silent });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.username).toBe('budi');
    expect(res.sessionsRevoked).toBeGreaterThanOrEqual(1);

    const after = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    expect(after.isAdmin).toBe(true);
    expect(after.sessionVersion).toBe(2);

    // the SAME vulnerability class F3/G3 closes in-app (a live 1FA session gaining
    // rights without ever proving a second factor) — this script must close it too.
    // NO_SESSION (not SESSION_INVALIDATED) because killAllSessions eagerly DELETES
    // the row after the sessionVersion bump — matching admin.ts's reset-totp/
    // revoke-sessions precedent (adminSurface.test.ts asserts the same 401 shape).
    const stale = await app.request('/auth/me', { headers: { cookie: staleCookie } });
    expect(stale.status).toBe(401);
    expect((await stale.json()).code).toBe('NO_SESSION');

    // data-birth: granting isAdmin is a GLOBAL control-plane action — it audits
    // onto the reserved `@control` chain by default now, not a baked estate.
    const exp = await exportAuditChain(store, CONTROL_SCOPE);
    expect(exp.verified).toBe(true);
    const entry = exp.entries.find((e) => e.targetId === 'budi' && e.action === 'account-update');
    expect(entry).toBeDefined();
    expect(entry?.actor.startsWith('maintenance:')).toBe(true);
    expect(entry?.actor).toContain('pr#42');
    expect(entry?.interimProfile).toBe(true);
    expect(entry?.before).toEqual({ isAdmin: false });
    expect(entry?.after).toEqual({ isAdmin: true });
  });

  it('goes through the SAME store + audit code paths — chain links onto whatever came before, not a fork', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true }));
    await store.put(account({ id: 'budi' }));
    const before = await exportAuditChain(store, CONTROL_SCOPE);
    expect(before.count).toBe(0);

    await runGrantAdmin({ store, username: 'budi', pr: 'pr#7', io: silent });
    const after = await exportAuditChain(store, CONTROL_SCOPE);
    expect(after.count).toBe(1);
    expect(after.verified).toBe(true);
  });

  it('refuses: target account does not exist', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true }));
    const res = await runGrantAdmin({ store, username: 'ghost', pr: 'pr#1', io: silent });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/no such account/i);
    const accounts = (await store.queryGSI1(accountsGsi())) as AccountItem[];
    expect(accounts).toHaveLength(1); // nothing created
  });

  it('refuses: target account is already admin', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true })); // sole active admin AND the target
    const res = await runGrantAdmin({ store, username: 'putra', pr: 'pr#2', io: silent });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/already admin/i);
  });

  it('refuses: target account has not completed onboarding (still on its one-time password)', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true }));
    await store.put(account({ id: 'budi', mustChangePassword: true }));
    const res = await runGrantAdmin({ store, username: 'budi', pr: 'pr#3', io: silent });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/onboarding|one-time password/i);
    const acc = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    expect(acc.isAdmin).toBe(false);
  });

  it('refuses: target account is disabled', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true }));
    await store.put(account({ id: 'budi', status: 'disabled' }));
    const res = await runGrantAdmin({ store, username: 'budi', pr: 'pr#4', io: silent });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/not active|disabled/i);
  });

  it('refuses: 2 or more active admins already exist — beyond the single-admin bootstrap gap this script is for', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true }));
    await store.put(account({ id: 'gita', role: 'lead', isAdmin: true }));
    await store.put(account({ id: 'budi' }));
    const res = await runGrantAdmin({ store, username: 'budi', pr: 'pr#5', io: silent });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/active admins already exist/i);
    const acc = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    expect(acc.isAdmin).toBe(false);
  });

  it('a DISABLED admin does not count toward the ≥2-active-admins refusal', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true }));
    await store.put(account({ id: 'retired-admin', role: 'lead', isAdmin: true, status: 'disabled' }));
    await store.put(account({ id: 'budi' }));
    const res = await runGrantAdmin({ store, username: 'budi', pr: 'pr#6', io: silent });
    expect(res.ok).toBe(true); // only 1 ACTIVE admin (putra) — still the bootstrap gap
  });

  it('username matching is case-insensitive (mirrors admin.ts enrolment lowercasing)', async () => {
    const store = new MemoryStore();
    await store.put(account({ id: 'putra', role: 'lead', isAdmin: true }));
    await store.put(account({ id: 'budi' }));
    const res = await runGrantAdmin({ store, username: 'BUDI', pr: 'pr#8', io: silent });
    expect(res.ok).toBe(true);
  });
});

describe('grant-admin CLI (main) against a real durable FileStore', () => {
  let dir: string;
  let dataFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccp-grant-admin-'));
    dataFile = join(dir, 'ccp.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('grants admin, persists durably, and a FRESH process re-reading the file sees it', async () => {
    const store = await FileStore.open(dataFile);
    await bootstrap(store, { print: () => {} }); // seeds 'putra'
    await store.put(account({ id: 'budi' }));

    const code = await main(['--username', 'budi', '--pr', 'pr#42', '--data', dataFile], silent);
    expect(code).toBe(0);

    const reopened = await FileStore.open(dataFile);
    const budi = (await reopened.get(accountKey('budi').PK, 'META')) as AccountItem;
    expect(budi.isAdmin).toBe(true);
    const exp = await exportAuditChain(reopened, CONTROL_SCOPE);
    expect(exp.verified).toBe(true);
    expect(exp.entries.some((e) => e.targetId === 'budi' && e.actor.includes('pr#42'))).toBe(true);
  });

  it('usage error: missing --username or --pr → exit 2, nothing written', async () => {
    const code1 = await main(['--pr', 'pr#1', '--data', dataFile], silent);
    expect(code1).toBe(2);
    const code2 = await main(['--username', 'budi', '--data', dataFile], silent);
    expect(code2).toBe(2);
  });

  it('refuses an unknown --project', async () => {
    const store = await FileStore.open(dataFile);
    await bootstrap(store, { print: () => {} });
    const code = await main(['--username', 'putra', '--pr', 'pr#1', '--data', dataFile, '--project', 'nope'], silent);
    expect(code).toBe(2);
  });

  it('a failing grant (e.g. unknown account) exits 1 and logs the reason', async () => {
    const store = await FileStore.open(dataFile);
    await bootstrap(store, { print: () => {} });
    let logged = '';
    const io = { log: () => {}, error: (s: string) => { logged += s; } };
    const code = await main(['--username', 'ghost', '--pr', 'pr#1', '--data', dataFile], io);
    expect(code).toBe(1);
    expect(logged).toMatch(/no such account/i);
  });

  it('refuses CCP_STORE=memory (no --data, no durable file) rather than silently discarding the grant', async () => {
    const prevStore = process.env.CCP_STORE;
    const prevDir = process.env.CCP_DATA_DIR;
    process.env.CCP_STORE = 'memory';
    delete process.env.CCP_DATA_DIR;
    try {
      const code = await main(['--username', 'budi', '--pr', 'pr#1'], silent);
      expect(code).toBe(2);
    } finally {
      if (prevStore === undefined) delete process.env.CCP_STORE;
      else process.env.CCP_STORE = prevStore;
      if (prevDir !== undefined) process.env.CCP_DATA_DIR = prevDir;
    }
  });
});
