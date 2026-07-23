import { describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, accountsGsi, type AccountItem } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import { requireSession } from '../src/middleware/session';

const PW = 'correct-horse-battery';

async function seed(store: ConfigStore, over: Partial<AccountItem> & { id: string; role: AccountItem['role'] }): Promise<void> {
  const hash = await hashPassword(PW);
  await store.put({
    ...accountKey(over.id),
    username: over.id,
    displayName: over.id,
    teamId: 'platform',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash },
    failedAttempts: 0,
    sessionVersion: 1,
    // GSI1PK/GSI1SK: without these, this row is invisible to accountsGsi() —
    // login itself uses a direct key get, so this was never needed before, but
    // the one-time legacy settlement (domain/settlement.ts) enumerates ALL
    // accounts via the GSI to materialize bare legacy rows into an explicit
    // `roles` map, and needs to actually find this one.
    GSI1PK: accountsGsi(),
    GSI1SK: over.id,
    ...over,
  });
}

function appWithProtected(store: ConfigStore): Hono<AppEnv> {
  const app = createApp(store);
  app.get('/protected', requireSession, (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono<AppEnv>, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}
function cookieFrom(res: Response): string {
  const m = /ccp_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return m ? `ccp_session=${m[1]}` : '';
}

describe('§4 TOTP for approver/lead/admin', () => {
  it('(a) a lead logging in un-enrolled gets an enrollment URI; the pre-session 401s protected routes', async () => {
    const store = new MemoryStore();
    await seed(store, { id: 'putra', role: 'lead' });
    const app = appWithProtected(store);

    const login = await post(app, '/auth/login', { username: 'putra', password: PW });
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.totpRequired).toBe(true);
    expect(body.totpEnrollment.otpauthUri).toContain('otpauth://totp/');
    const preCookie = cookieFrom(login);

    const prot = await app.request('/protected', { headers: { cookie: preCookie } });
    expect(prot.status).toBe(401);
    expect((await prot.json()).code).toBe('TOTP_REQUIRED');
  });

  it('(b) confirming enrollment with a valid code upgrades to a full session', async () => {
    const store = new MemoryStore();
    await seed(store, { id: 'putra', role: 'lead' });
    const app = appWithProtected(store);

    const login = await post(app, '/auth/login', { username: 'putra', password: PW });
    const { totpEnrollment } = await login.json();
    const preCookie = cookieFrom(login);

    const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(totpEnrollment.secret) }, preCookie);
    expect(enroll.status).toBe(200);
    const fullCookie = cookieFrom(enroll);

    const prot = await app.request('/protected', { headers: { cookie: fullCookie } });
    expect(prot.status).toBe(200);
  });

  it('(c) a subsequent login requires the TOTP step: wrong code 401, right code sets the session', async () => {
    const store = new MemoryStore();
    await seed(store, { id: 'putra', role: 'lead' });
    const app = appWithProtected(store);

    // enroll first
    const first = await post(app, '/auth/login', { username: 'putra', password: PW });
    const { totpEnrollment } = await first.json();
    await post(app, '/auth/totp/enroll', { code: authenticator.generate(totpEnrollment.secret) }, cookieFrom(first));

    // re-login → totpRequired pre-session
    const relogin = await post(app, '/auth/login', { username: 'putra', password: PW });
    expect((await relogin.json()).totpRequired).toBe(true);
    const preCookie = cookieFrom(relogin);

    const wrong = await post(app, '/auth/totp', { code: '000000' }, preCookie);
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).code).toBe('TOTP_REQUIRED');

    const right = await post(app, '/auth/totp', { code: authenticator.generate(totpEnrollment.secret) }, preCookie);
    expect(right.status).toBe(200);
    const fullCookie = cookieFrom(right);
    expect((await app.request('/protected', { headers: { cookie: fullCookie } })).status).toBe(200);
  });

  it('(d) a requester never sees the TOTP step', async () => {
    const store = new MemoryStore();
    await seed(store, { id: 'sari', role: 'requester', teamId: 'app-platform' });
    const app = appWithProtected(store);

    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.totpRequired).toBeUndefined();
    const cookie = cookieFrom(login);
    expect((await app.request('/protected', { headers: { cookie } })).status).toBe(200);
  });
});
