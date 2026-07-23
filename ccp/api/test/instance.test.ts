import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { seed, sessionCookieFor } from './helpers/seed';
import { seedInstanceIdentity } from '../scripts/bootstrap';
import { instanceKey, type InstanceItem } from '../src/store/schema';
import { CLIENT_VALUE } from '../src/middleware/session';
import { otpauthUri, resolveTotpIssuer } from '../src/auth/totp';
import { hashPassword } from '../src/auth/credentials';

const CLIENT_HEADERS = {
  'content-type': 'application/json',
  'x-ccp-client': CLIENT_VALUE,
};

describe('ADR-0023 — instance identity: GET /instance (unauthenticated)', () => {
  it('absent INSTANCE row -> {name: null, tagline: null}, no session needed', async () => {
    const app = createApp(new MemoryStore());
    const res = await app.request('/instance');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: null, tagline: null });
  });

  it('a seeded identity is served — name + tagline only, no version/updatedBy leak', async () => {
    const store = new MemoryStore();
    const k = instanceKey();
    const item: InstanceItem = {
      ...k,
      name: 'Acme Cloud Control Plane',
      tagline: 'Change control for Acme',
      version: 1,
      updatedBy: 'putra',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    await store.put(item);
    const app = createApp(store);
    const res = await app.request('/instance');
    const body = await res.json();
    expect(body).toEqual({
      name: 'Acme Cloud Control Plane',
      tagline: 'Change control for Acme',
    });
    expect(body.version).toBeUndefined();
    expect(body.updatedBy).toBeUndefined();
  });
});

describe('ADR-0023 — instance identity: PUT /admin/instance', () => {
  it('refuses with no session', async () => {
    const app = createApp(new MemoryStore());
    const res = await app.request('/admin/instance', {
      method: 'PUT',
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ name: 'Acme' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses a non-admin session (NOT_ADMIN)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const cookie = await sessionCookieFor(store, 'lina'); // lead, isAdmin:false
    const app = createApp(store);
    const res = await app.request('/admin/instance', {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, cookie },
      body: JSON.stringify({ name: 'Acme' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });

  it('an admin renames it immediately (no dual-control), audited, version increments', async () => {
    const store = new MemoryStore();
    await seed(store);
    const cookie = await sessionCookieFor(store, 'putra'); // lead + isAdmin
    const app = createApp(store);

    const put1 = await app.request('/admin/instance', {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, cookie },
      body: JSON.stringify({
        name: 'Acme Cloud Control Plane',
        tagline: 'Change control for Acme',
      }),
    });
    expect(put1.status).toBe(200);
    expect(await put1.json()).toEqual({
      name: 'Acme Cloud Control Plane',
      tagline: 'Change control for Acme',
      version: 1,
    });

    const read1 = await app.request('/instance');
    expect(await read1.json()).toEqual({
      name: 'Acme Cloud Control Plane',
      tagline: 'Change control for Acme',
    });

    // Rename again — version increments, no dual-control 202 ever returned.
    const put2 = await app.request('/admin/instance', {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, cookie },
      body: JSON.stringify({ name: 'Acme Control Plane' }),
    });
    expect(put2.status).toBe(200);
    expect(await put2.json()).toEqual({
      name: 'Acme Control Plane',
      tagline: '',
      version: 2,
    });

    // Audited on the control-plane chain.
    const k = instanceKey();
    const item = (await store.get(k.PK, k.SK)) as InstanceItem;
    expect(item.updatedBy).toBe('putra');
    expect(item.version).toBe(2);
  });

  it('is GLOBAL — never gated by requireProjectMembership (works with no x-ccp-project header at all, i.e. the reserved @control scope)', async () => {
    const store = new MemoryStore();
    await seed(store); // putra: legacy shape, bound only to the default project — NOT '*'
    const cookie = await sessionCookieFor(store, 'putra');
    const app = createApp(store);
    // Deliberately no x-ccp-project header -> resolves to '@control', which
    // putra is NOT bound to under the legacy shape. If this route inherited
    // adminRoutes' requireProjectMembership it would 403 PROJECT_SCOPE here.
    const res = await app.request('/admin/instance', {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, cookie },
      body: JSON.stringify({ name: 'Global Rename' }),
    });
    expect(res.status).toBe(200);
  });

  it('validates: empty name, oversize name/tagline, and embedded control characters all 422', async () => {
    const store = new MemoryStore();
    await seed(store);
    const cookie = await sessionCookieFor(store, 'putra');
    const app = createApp(store);
    const cases: Record<string, unknown>[] = [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(65) },
      { name: 'ok', tagline: 'x'.repeat(141) },
      { name: 'line1\nline2' },
      { name: 'tab\tinside' },
    ];
    for (const body of cases) {
      const res = await app.request('/admin/instance', {
        method: 'PUT',
        headers: { ...CLIENT_HEADERS, cookie },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('trims whitespace and accepts the boundary lengths (64 / 140)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const cookie = await sessionCookieFor(store, 'putra');
    const app = createApp(store);
    const res = await app.request('/admin/instance', {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, cookie },
      body: JSON.stringify({
        name: `  ${'a'.repeat(64)}  `,
        tagline: 'b'.repeat(140),
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('a'.repeat(64));
    expect(body.tagline).toBe('b'.repeat(140));
  });
});

describe('ADR-0023 — first-boot seed (scripts/bootstrap.ts#seedInstanceIdentity)', () => {
  it('no-op when CCP_INSTANCE_NAME is unset', async () => {
    const store = new MemoryStore();
    await seedInstanceIdentity(store, {}, { print: () => {} });
    const k = instanceKey();
    expect(await store.get(k.PK, k.SK)).toBeNull();
  });

  it('seeds from CCP_INSTANCE_NAME/CCP_INSTANCE_TAGLINE', async () => {
    const store = new MemoryStore();
    await seedInstanceIdentity(
      store,
      {
        CCP_INSTANCE_NAME: 'Acme Cloud Control Plane',
        CCP_INSTANCE_TAGLINE: 'Change control for Acme',
      },
      { print: () => {} },
    );
    const k = instanceKey();
    const item = (await store.get(k.PK, k.SK)) as InstanceItem;
    expect(item.name).toBe('Acme Cloud Control Plane');
    expect(item.tagline).toBe('Change control for Acme');
    expect(item.version).toBe(1);
    expect(item.updatedBy).toBe('system');
  });

  it('never overwrites an existing item (idempotent install.sh re-runs)', async () => {
    const store = new MemoryStore();
    await seedInstanceIdentity(store, { CCP_INSTANCE_NAME: 'First' }, { print: () => {} });
    await seedInstanceIdentity(store, { CCP_INSTANCE_NAME: 'Second' }, { print: () => {} });
    const k = instanceKey();
    const item = (await store.get(k.PK, k.SK)) as InstanceItem;
    expect(item.name).toBe('First');
  });

  it('an invalid env value is skipped, not thrown — the baked-generic default stands', async () => {
    const store = new MemoryStore();
    const lines: string[] = [];
    await seedInstanceIdentity(
      store,
      { CCP_INSTANCE_NAME: 'bad\nname' },
      { print: (s) => lines.push(s) },
    );
    const k = instanceKey();
    expect(await store.get(k.PK, k.SK)).toBeNull();
    expect(lines.join('\n')).toContain('skipping the instance-identity seed');
  });
});

describe('ADR-0023 — TOTP issuer resolves from the instance identity at enrollment time', () => {
  it('falls back to the baked-generic default with no INSTANCE row', async () => {
    const store = new MemoryStore();
    expect(await resolveTotpIssuer(store)).toBe('Cloud Control Plane');
  });

  it('resolves the seeded/renamed name', async () => {
    const store = new MemoryStore();
    await seedInstanceIdentity(
      store,
      { CCP_INSTANCE_NAME: 'Acme Cloud Control Plane' },
      { print: () => {} },
    );
    expect(await resolveTotpIssuer(store)).toBe('Acme Cloud Control Plane');
  });

  it('otpauthUri composes the resolved issuer into the provisioning URI (auth.ts:140 call shape)', async () => {
    const store = new MemoryStore();
    await seedInstanceIdentity(
      store,
      { CCP_INSTANCE_NAME: 'Acme Cloud Control Plane' },
      { print: () => {} },
    );
    const issuer = await resolveTotpIssuer(store);
    const uri = otpauthUri('fresh-admin', 'SECRETSECRETSECRET', issuer);
    expect(uri).toContain(encodeURIComponent('Acme Cloud Control Plane'));
  });

  it('end-to-end: a not-yet-enrolled privileged login gets an enrollment URI carrying the renamed instance', async () => {
    const store = new MemoryStore();
    await seed(store);
    const cookie = await sessionCookieFor(store, 'putra');
    const app = createApp(store);
    await app.request('/admin/instance', {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, cookie },
      body: JSON.stringify({ name: 'Acme Cloud Control Plane' }),
    });

    // The standard seed()'s senior accounts are pre-enrolled (placeholder
    // credential hashes never meant to verify) — seed a fresh not-yet-
    // enrolled senior account with a KNOWN password to drive the real
    // first-login enrollment branch end to end. Explicit `projects` (rather
    // than a bare legacy row) so `rolesOf` resolves a real `lead` binding
    // immediately (arm 2) — a bare row only gets materialized by the
    // one-time boot settlement, which already ran against this store on the
    // PUT /admin/instance call above and never re-runs.
    await store.put({
      PK: 'ACCOUNT#fresh-lead',
      SK: 'META',
      id: 'fresh-lead',
      username: 'fresh-lead',
      displayName: 'Fresh Lead',
      role: 'lead',
      teamId: 'platform',
      projects: ['sample'],
      status: 'active',
      createdAt: '2026-07-22T00:00:00.000Z',
      createdBy: 'system',
      mustChangePassword: false,
      isAdmin: false,
      credential: {
        algo: 'argon2id',
        hash: await hashPassword('correct-horse-battery-staple'),
      },
      failedAttempts: 0,
      sessionVersion: 1,
      GSI1PK: 'ACCOUNTS',
      GSI1SK: 'fresh-lead',
    });
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: CLIENT_HEADERS,
      body: JSON.stringify({
        username: 'fresh-lead',
        password: 'correct-horse-battery-staple',
      }),
    });
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.totpEnrollment.otpauthUri).toContain(
      encodeURIComponent('Acme Cloud Control Plane'),
    );
  });
});
