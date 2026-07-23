import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, accountsGsi, yyyymm, type AccountItem, type AuditItem } from '../src/store/schema';
import { mintSession } from '../src/auth/sessions';
import { __setKnownProjects } from '../src/projects';
import { verifyChain, type ChainEntry } from '../scripts/verify-audit-chain';

const v1 = JSON.parse(readFileSync(new URL('./fixtures/v1-export.json', import.meta.url), 'utf8'));

// v1 was single-project (sample only): the import writes teams/policy/risk/audit onto
// the ACTING project (routes/migrate.ts `projectId`), so 'sample' must be a real,
// known target scope. This fixture's fresh store carries no other 'sample' footprint
// (just the one bootstrap account, by design — migrate.ts requires exactly one
// account) for data-birth's settlement (domain/settlement.ts) to retro-register it
// from organically, so it's pinned explicitly — the same test hook
// perProjectAuthz.test.ts / projects.test.ts use for a non-default project.
beforeEach(() => __setKnownProjects(['sample']));

/** A single already-provisioned admin (post-first-login: mustChangePassword cleared). */
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
  const token = await mintSession(store, 'putra', 1);
  return `ccp_session=${token}`;
}

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function migrate(app: Hono<AppEnv>, cookie: string, body: unknown) {
  return app.request('/admin/migrate/v1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}

describe('§9 v1 → v2 migration', () => {
  it('(a) importing the fixture reports per-store counts', async () => {
    const store = new MemoryStore();
    const cookie = await seedBootstrapAdmin(store);
    const app = createApp(store);
    const res = await migrate(app, cookie, v1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: 2, teams: 1, policy: 1, riskOverrides: 1, audit: 2 });
  });

  it('(b) an imported account logs in with its v1 password, then holds an argon2id hash', async () => {
    const store = new MemoryStore();
    const cookie = await seedBootstrapAdmin(store);
    const app = createApp(store);
    await migrate(app, cookie, v1);

    // before login: imported credential is still pbkdf2
    const before = (await store.get(accountKey('dewi').PK, accountKey('dewi').SK)) as AccountItem;
    expect(before.credential.algo).toBe('pbkdf2');

    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dewi', password: 'test-password-1' }),
    });
    expect(login.status).toBe(200);

    const after = (await store.get(accountKey('dewi').PK, accountKey('dewi').SK)) as AccountItem;
    expect(after.credential.algo).toBe('argon2id'); // transparently re-hashed on first login
  });

  it('(c) a second import → 409 BACKEND_NOT_EMPTY', async () => {
    const store = new MemoryStore();
    const cookie = await seedBootstrapAdmin(store);
    const app = createApp(store);
    expect((await migrate(app, cookie, v1)).status).toBe(200);
    const second = await migrate(app, cookie, v1);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('BACKEND_NOT_EMPTY');
  });

  it('(d) the audit chain verifies (import wrappers chained correctly)', async () => {
    const store = new MemoryStore();
    const cookie = await seedBootstrapAdmin(store);
    const app = createApp(store);
    await migrate(app, cookie, v1);

    const entries = (await store.query(`P#sample#AUDIT#${yyyymm(new Date())}`)) as AuditItem[];
    expect(entries.length).toBeGreaterThanOrEqual(3); // 2 v1-import + 1 v1-migrate
    expect(entries.some((e) => e.action === 'v1-import')).toBe(true);
    expect(verifyChain(entries as unknown as ChainEntry[]).code).toBe(0);
  });
});
