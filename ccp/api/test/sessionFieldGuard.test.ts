import { afterEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, Item, TransactWrite } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, accountsGsi, sessionKey, type AccountItem, type SessionItem } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import { sha256hex } from '../src/auth/sessions';
import { __setNow } from '../src/clock';

/**
 * REM-2 — `SessionItem` rows written with blind whole-row `store.put`s, the
 * same shape CONC-3 already closed for the account row and API-10/CONC-4 for
 * the idle slide: the reauth stamp (`auth.ts`) and the multi-device TOTP
 * enrollment offer's mint + clear (`account.ts`) are the three remaining
 * writers. Each is proven here against a REAL race — a concurrent write
 * landing between this request's session read and its own write — not just a
 * unit test of the guard helper in isolation, since the three call sites
 * disagree on what a LOST race should mean for the caller (CONC-4's own rule:
 * a lost condition is not automatically a failure).
 */

const PW = 'correct-horse-battery-staple';
const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' };

async function seedAccount(store: ConfigStore, over: { id: string; role: AccountItem['role'] } & Partial<AccountItem>): Promise<AccountItem> {
  const hash = await hashPassword(PW);
  const item: AccountItem = {
    username: over.id,
    displayName: over.id[0]!.toUpperCase() + over.id.slice(1),
    teamId: 'platform',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash },
    failedAttempts: 0,
    sessionVersion: 1,
    ...over,
    ...accountKey(over.id),
    GSI1PK: accountsGsi(),
    GSI1SK: over.id,
  };
  await store.put(item);
  return item;
}

function post(app: Hono<AppEnv>, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { ...CH };
  if (cookie) headers.cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}
function cookieFrom(res: Response): string {
  const m = /ccp_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return m ? `ccp_session=${m[1]}` : '';
}
function tokenFromCookie(cookie: string): string {
  return /ccp_session=([^;]+)/.exec(cookie)![1]!;
}
async function storedSession(store: ConfigStore, cookie: string): Promise<SessionItem> {
  const k = sessionKey(sha256hex(tokenFromCookie(cookie)));
  return (await store.get(k.PK, k.SK)) as SessionItem;
}

/** Log a seeded account in fully (completing first-login TOTP enrollment if the
 * account has none yet) and stamp a fresh reauth elevation, returning the
 * FULL-session, ⚿-elevated cookie. Same shape as totpDevices.test.ts's own
 * `loginAndElevate`. */
async function loginAndElevate(app: Hono<AppEnv>, username: string, password = PW): Promise<string> {
  const login = await post(app, '/auth/login', { username, password });
  let cookie = cookieFrom(login);
  const body = (await login.json()) as { totpEnrollment?: { secret: string }; totpRequired?: boolean };
  if (body.totpEnrollment) {
    const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(body.totpEnrollment.secret) }, cookie);
    cookie = cookieFrom(enroll);
  } else if (body.totpRequired) {
    throw new Error('loginAndElevate: account already enrolled — use a dedicated flow');
  }
  const reauth = await post(app, '/auth/reauth', { password }, cookie);
  expect(reauth.status, 'setup: reauth').toBe(200);
  return cookieFrom(reauth) || cookie;
}

/** A store that runs `onGet` once, right after the FIRST `get` matching `target`
 * — the exact interleave a concurrent request landing mid-await produces. Same
 * shape as sessionRevokeRace.test.ts's own `racingStore`. */
function racingStore(inner: ConfigStore, target: { PK: string; SK: string }, onGet: () => Promise<void>): ConfigStore {
  let fired = false;
  return {
    async get(pk: string, sk: string): Promise<Item | null> {
      const v = await inner.get(pk, sk);
      if (!fired && pk === target.PK && sk === target.SK) {
        fired = true;
        await onGet();
      }
      return v;
    },
    put: (item, opts) => inner.put(item, opts),
    query: (pk, prefix, opts) => inner.query(pk, prefix, opts),
    queryGSI1: (gsi1pk, opts) => inner.queryGSI1(gsi1pk, opts),
    transact: (writes: TransactWrite[]) => inner.transact(writes),
    delete: (pk, sk) => inner.delete(pk, sk),
  };
}

afterEach(() => __setNow(null));

describe('REM-2 — POST /auth/reauth: the reauth stamp is guarded, narrowly', () => {
  it('a lost race between two live reauth calls is not a clobber, and not a failure (CONC-4\'s rule)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const login = await post(createApp(store), '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    const sKey = sessionKey(sha256hex(tokenFromCookie(cookie)));

    // Another tab's /auth/reauth lands its OWN stamp between this request's
    // session read and its guarded write.
    const racedReauthAt = '2026-07-11T00:00:01.000Z';
    let raced = false;
    const racing = racingStore(store, sKey, async () => {
      raced = true;
      await store.transact([{ kind: 'update', pk: sKey.PK, sk: sKey.SK, set: { reauthAt: racedReauthAt } }]);
    });

    const res = await post(createApp(racing), '/auth/reauth', { password: PW }, cookie);
    expect(raced, 'the interleave must actually have fired, or this test proves nothing').toBe(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reauthAt: string };
    // Reports the value ACTUALLY stored (the racer's), not this request's own
    // attempted stamp, and — the point of the fix — did not overwrite it.
    expect(body.reauthAt).toBe(racedReauthAt);
    expect((await storedSession(store, cookie)).reauthAt).toBe(racedReauthAt);
  });

  it('a session revoked mid-reauth fails closed (401 NO_SESSION), not a resurrected row', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const login = await post(createApp(store), '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    const sKey = sessionKey(sha256hex(tokenFromCookie(cookie)));

    let raced = false;
    const racing = racingStore(store, sKey, async () => {
      raced = true;
      await store.delete(sKey.PK, sKey.SK);
    });

    const res = await post(createApp(racing), '/auth/reauth', { password: PW }, cookie);
    expect(raced).toBe(true);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('NO_SESSION');
    expect(await store.get(sKey.PK, sKey.SK), 'the guarded write must not have recreated the revoked row').toBeNull();
  });

  it('CONTROL: an uncontended reauth still stamps — the guard is not just refusing everything', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    const res = await post(app, '/auth/reauth', { password: PW }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reauthAt: string };
    expect((await storedSession(store, cookie)).reauthAt).toBe(body.reauthAt);
  });
});

describe('REM-2 — POST /auth/totp-devices: the enrollment offer mint is guarded', () => {
  async function elevatedSetup(): Promise<{ store: MemoryStore; cookie: string }> {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const cookie = await loginAndElevate(createApp(store), 'putra');
    return { store, cookie };
  }

  it('a lost race refuses (409 STATE_CONFLICT) rather than handing back a secret/QR that confirm can never accept', async () => {
    const { store, cookie } = await elevatedSetup();
    const sKey = sessionKey(sha256hex(tokenFromCookie(cookie)));

    // Another tab's OWN totp-devices begin-add wins the race and mints a
    // DIFFERENT offer between this request's session read and its write.
    const racedSecretEnc = 'racer-secret-enc';
    let raced = false;
    const racing = racingStore(store, sKey, async () => {
      raced = true;
      await store.transact([
        { kind: 'update', pk: sKey.PK, sk: sKey.SK, set: { enrollSecretEnc: racedSecretEnc, enrollOfferedAt: '2026-07-11T00:00:01.000Z' } },
      ]);
    });

    const res = await post(createApp(racing), '/auth/totp-devices', {}, cookie);
    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
    // The racer's offer is untouched — this request's secret was never written.
    expect((await storedSession(store, cookie)).enrollSecretEnc).toBe(racedSecretEnc);
  });

  it('a session revoked mid-request fails closed (401 NO_SESSION)', async () => {
    const { store, cookie } = await elevatedSetup();
    const sKey = sessionKey(sha256hex(tokenFromCookie(cookie)));
    let raced = false;
    const racing = racingStore(store, sKey, async () => {
      raced = true;
      await store.delete(sKey.PK, sKey.SK);
    });
    const res = await post(createApp(racing), '/auth/totp-devices', {}, cookie);
    expect(raced).toBe(true);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('NO_SESSION');
  });

  it('CONTROL: an uncontended begin-add still mints the offer', async () => {
    const { store, cookie } = await elevatedSetup();
    const app = createApp(store);
    const res = await post(app, '/auth/totp-devices', {}, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret: string };
    expect((await storedSession(store, cookie)).enrollSecretEnc).toBeTruthy();
    expect(body.secret).toBeTruthy();
  });
});

describe("REM-2 — POST /auth/totp-devices/confirm: clearing the offer is guarded and best-effort", () => {
  it('a NEWER concurrent offer is not clobbered by this confirm\'s cleanup — but the device is still added', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');

    const begin = await post(app, '/auth/totp-devices', {}, cookie);
    const { secret } = (await begin.json()) as { secret: string };
    const code = authenticator.generate(secret);

    const sKey = sessionKey(sha256hex(tokenFromCookie(cookie)));
    // A SECOND tab starts its OWN, newer offer while this confirm is in
    // flight — landing between the confirm request's session read (via
    // requireSession, at request start) and its cleanup write at the end.
    const racedSecretEnc = 'a-newer-unrelated-offer';
    const racedOfferedAt = '2026-07-11T00:05:00.000Z';
    let raced = false;
    const racing = racingStore(store, sKey, async () => {
      raced = true;
      await store.transact([
        { kind: 'update', pk: sKey.PK, sk: sKey.SK, set: { enrollSecretEnc: racedSecretEnc, enrollOfferedAt: racedOfferedAt } },
      ]);
    });

    const res = await post(createApp(racing), '/auth/totp-devices/confirm', { name: 'phone', code }, cookie);
    expect(raced).toBe(true);
    // The confirm itself still succeeds — the device was already committed via
    // the account's own guarded write, independent of this session cleanup.
    expect(res.status).toBe(200);
    const account = (await store.get(accountKey('putra').PK, 'META')) as AccountItem;
    expect((account.totpDevices ?? []).some((d) => d.name === 'phone')).toBe(true);
    // The newer, unrelated offer survives untouched — cleanup declined to
    // overwrite it rather than erasing a concurrent enrollment in progress.
    const session = await storedSession(store, cookie);
    expect(session.enrollSecretEnc).toBe(racedSecretEnc);
    expect(session.enrollOfferedAt).toBe(racedOfferedAt);
  });

  it('CONTROL: an uncontended confirm clears the offer fields', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');

    const begin = await post(app, '/auth/totp-devices', {}, cookie);
    const { secret } = (await begin.json()) as { secret: string };
    const code = authenticator.generate(secret);
    const res = await post(app, '/auth/totp-devices/confirm', { name: 'phone', code }, cookie);
    expect(res.status).toBe(200);
    const session = await storedSession(store, cookie);
    expect(session.enrollSecretEnc).toBeUndefined();
    expect(session.enrollOfferedAt).toBeUndefined();
  });
});
