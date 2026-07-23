import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { accountKey, accountsGsi, type AccountItem } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import { resolveSameSite, resolveSecureCookies, sessionCookieOptions } from '../src/deploy';

/**
 * Task 1 — env-aware secure-cookie posture for a real host. A production cookie must
 * carry Secure + SameSite + HttpOnly (behind external TLS); local dev/tests stay on
 * http (no Secure). Additive/config only — no change to how sessions are enforced.
 */

// Snapshot & restore the env knobs this test flips, so ordering never leaks state.
const KEYS = ['NODE_ENV', 'CCP_SECURE_COOKIES', 'CCP_COOKIE_SAMESITE'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('sessionCookieOptions resolves Secure/SameSite from env', () => {
  it('dev default: HttpOnly + SameSite=Lax, NOT Secure', () => {
    delete process.env.NODE_ENV;
    delete process.env.CCP_SECURE_COOKIES;
    delete process.env.CCP_COOKIE_SAMESITE;
    expect(sessionCookieOptions()).toEqual({ httpOnly: true, sameSite: 'Lax', secure: false, path: '/' });
  });

  it('production default: Secure ON', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CCP_SECURE_COOKIES;
    expect(resolveSecureCookies()).toBe(true);
    expect(sessionCookieOptions().secure).toBe(true);
  });

  it('CCP_SECURE_COOKIES overrides NODE_ENV in both directions', () => {
    process.env.NODE_ENV = 'development';
    process.env.CCP_SECURE_COOKIES = 'true';
    expect(resolveSecureCookies()).toBe(true); // forced ON in dev (e.g. dev-over-TLS)
    process.env.NODE_ENV = 'production';
    process.env.CCP_SECURE_COOKIES = 'false';
    expect(resolveSecureCookies()).toBe(false); // forced OFF (the preflight in Task 2 refuses this)
  });

  it('SameSite is env-selectable (None for a cross-origin SPA), default Lax', () => {
    process.env.CCP_COOKIE_SAMESITE = 'None';
    expect(resolveSameSite()).toBe('None');
    process.env.CCP_COOKIE_SAMESITE = 'strict';
    expect(resolveSameSite()).toBe('Strict');
    delete process.env.CCP_COOKIE_SAMESITE;
    expect(resolveSameSite()).toBe('Lax');
  });
});

/** Seed one requester with a REAL argon2 credential so /auth/login mints a full session cookie. */
async function seedRequester(store: MemoryStore, username: string, password: string): Promise<void> {
  const acc: AccountItem = {
    ...accountKey(username),
    id: username,
    username,
    displayName: 'Sari',
    role: 'requester', // no TOTP → login goes straight to a full session + Set-Cookie
    teamId: 'app-platform',
    status: 'active',
    createdAt: '2026-07-12T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash: await hashPassword(password) },
    failedAttempts: 0,
    sessionVersion: 1,
    GSI1PK: accountsGsi(),
    GSI1SK: username,
  };
  await store.put(acc);
}

async function login(store: MemoryStore): Promise<string> {
  const app = createApp(store);
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sari', password: 'sari-strong-pw-9' }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

describe('the real login Set-Cookie carries the resolved posture', () => {
  it('production mode: cookie is Secure + HttpOnly + SameSite', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CCP_TOTP_KEY = 'test-key'; // unrelated cipher requirement in prod
    const store = new MemoryStore();
    await seedRequester(store, 'sari', 'sari-strong-pw-9');
    const sc = await login(store);
    expect(sc).toMatch(/ccp_session=/);
    expect(sc).toMatch(/;\s*Secure/i);
    expect(sc).toMatch(/;\s*HttpOnly/i);
    expect(sc).toMatch(/;\s*SameSite=Lax/i);
  });

  it('dev mode: same cookie is HttpOnly + SameSite but NOT Secure (works over http)', async () => {
    delete process.env.NODE_ENV;
    delete process.env.CCP_SECURE_COOKIES;
    const store = new MemoryStore();
    await seedRequester(store, 'sari', 'sari-strong-pw-9');
    const sc = await login(store);
    expect(sc).toMatch(/ccp_session=/);
    expect(sc).not.toMatch(/;\s*Secure/i);
    expect(sc).toMatch(/;\s*HttpOnly/i);
    expect(sc).toMatch(/;\s*SameSite=Lax/i);
  });
});
