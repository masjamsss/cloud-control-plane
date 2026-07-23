import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, type AccountItem } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import { __setNow } from '../src/clock';

const T0 = Date.UTC(2026, 6, 11, 9, 0, 0);
const PW = 'correct-horse-battery';

async function seed(store: ConfigStore, over: Partial<AccountItem> = {}): Promise<AccountItem> {
  const hash = await hashPassword(PW);
  const item: AccountItem = {
    ...accountKey('sari'),
    id: 'sari',
    username: 'sari',
    displayName: 'Sari',
    role: 'requester',
    teamId: 'app-platform',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash },
    failedAttempts: 0,
    sessionVersion: 1,
    ...over,
  };
  await store.put(item);
  return item;
}

function post(app: Hono<AppEnv>, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function cookieFrom(res: Response): string {
  const sc = res.headers.get('set-cookie') ?? '';
  const m = /ccp_session=([^;]+)/.exec(sc);
  return m ? `ccp_session=${m[1]}` : '';
}

afterEach(() => __setNow(null));

describe('§4 AuthN acceptance', () => {
  it('(a) 5 bad passwords lock the account; the 6th is 429 LOGIN_BACKOFF; unlocks after the backoff', async () => {
    __setNow(() => T0);
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);

    for (let i = 0; i < 5; i++) {
      const r = await post(app, '/auth/login', { username: 'sari', password: 'wrong' });
      expect(r.status, `attempt ${i + 1}`).toBe(401);
      expect((await r.json()).code).toBe('BAD_CREDENTIALS');
    }
    const sixth = await post(app, '/auth/login', { username: 'sari', password: 'wrong' });
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).code).toBe('LOGIN_BACKOFF');
    expect(sixth.headers.get('Retry-After')).toBeTruthy();

    // even the correct password is refused while locked
    const lockedTry = await post(app, '/auth/login', { username: 'sari', password: PW });
    expect(lockedTry.status).toBe(429);

    // advance past the 1-minute backoff (2^(5-5) = 1 min) → correct password logs in
    __setNow(() => T0 + 61_000);
    const good = await post(app, '/auth/login', { username: 'sari', password: PW });
    expect(good.status).toBe(200);
    expect((await good.json()).user.username).toBe('sari');
  });

  it('(b) a session past 12h absolute and one past 30m idle both 401 SESSION_EXPIRED', async () => {
    __setNow(() => T0);
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);

    // idle expiry
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    expect((await app.request('/auth/me', { headers: { cookie } })).status).toBe(200);
    __setNow(() => T0 + 31 * 60_000);
    const idle = await app.request('/auth/me', { headers: { cookie } });
    expect(idle.status).toBe(401);
    expect((await idle.json()).code).toBe('SESSION_EXPIRED');

    // absolute expiry (keep idle fresh with activity every 25m up to the 12h wall,
    // so it is the ABSOLUTE lifetime — not idle — that expires the session)
    __setNow(() => T0);
    const login2 = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie2 = cookieFrom(login2);
    for (let mins = 25; mins < 12 * 60; mins += 25) {
      __setNow(() => T0 + mins * 60_000);
      expect((await app.request('/auth/me', { headers: { cookie: cookie2 } })).status, `keep-alive @${mins}m`).toBe(200);
    }
    __setNow(() => T0 + 12 * 60 * 60_000 + 1000); // 12h + 1s (idle is still fresh)
    const abs = await app.request('/auth/me', { headers: { cookie: cookie2 } });
    expect(abs.status).toBe(401);
    expect((await abs.json()).code).toBe('SESSION_EXPIRED');
  });

  it('(c) change-password bumps sessionVersion → the OLD cookie is SESSION_INVALIDATED', async () => {
    __setNow(() => T0);
    const store = new MemoryStore();
    await seed(store, { mustChangePassword: true });
    const app = createApp(store);

    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    expect(login.status).toBe(200);
    expect((await login.json()).mustChangePassword).toBe(true);
    const oldCookie = cookieFrom(login);

    const cp = await post(app, '/auth/change-password', { currentPassword: PW, newPassword: 'a-brand-new-pw-1' }, oldCookie);
    expect(cp.status).toBe(200);
    const newCookie = cookieFrom(cp);

    const meOld = await app.request('/auth/me', { headers: { cookie: oldCookie } });
    expect(meOld.status).toBe(401);
    expect((await meOld.json()).code).toBe('SESSION_INVALIDATED');

    const meNew = await app.request('/auth/me', { headers: { cookie: newCookie } });
    expect(meNew.status).toBe(200);
    expect((await meNew.json()).mustChangePassword).toBe(false);
  });

  it('(d) unknown username and wrong password are byte-for-byte indistinguishable', async () => {
    __setNow(() => T0);
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);

    const unknown = await post(app, '/auth/login', { username: 'ghost', password: 'whatever' });
    const wrong = await post(app, '/auth/login', { username: 'sari', password: 'wrong' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it('(e) mustChangePassword: /auth/me is allowed but any other route → 403 PASSWORD_CHANGE_REQUIRED', async () => {
    __setNow(() => T0);
    const store = new MemoryStore();
    await seed(store, { mustChangePassword: true });
    const app = createApp(store);
    app.get('/protected', (c) => c.json({ ok: true }));

    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);

    expect((await app.request('/auth/me', { headers: { cookie } })).status).toBe(200);

    const prot = await app.request('/protected', { headers: { cookie } });
    expect(prot.status).toBe(403);
    expect((await prot.json()).code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});
