import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { AppEnv } from '../appEnv';
import type { AccountItem, TotpDevice } from '../store/schema';
import { accountKey, nextAccountVersion, sessionKey } from '../store/schema';
import { apiError } from '../errors';
import { hashPassword, MIN_PASSWORD, verifyPassword, verifyPbkdf2 } from '../auth/credentials';
import { mintSession, sha256hex, TOTP_PENDING_MS } from '../auth/sessions';
import { publicAccount } from '../auth/account';
import { failCode, SESSION_COOKIE } from '../middleware/session';
import { sessionCookieOptions } from '../deploy';
import {
  DEFAULT_DEVICE_NAME,
  generateTotpSecret,
  getCipher,
  needsTotp,
  otpauthUri,
  resolveTotpIssuer,
  totpDevicesOf,
  verifyAnyTotpDevice,
  verifyTotpCode,
  withDeviceUseStamped,
  withDevices,
} from '../auth/totp';
import { findUnusedRecoveryCode, generateRecoveryCodes, remainingRecoveryCodes } from '../auth/recovery';
import { record } from '../domain/audit';
import { nowIso, nowMs } from '../clock';
import type { ConfigStore } from '../store/configStore';
import type { SessionItem } from '../store/schema';

const LoginBody = z.object({ username: z.string().min(1), password: z.string().min(1) });
const ChangePwBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(MIN_PASSWORD),
  /** §4 — default false (today's behavior verbatim): invalidate every other
   * session. `true` keeps other sessions alive (credential swap only). */
  keepOtherSessions: z.boolean().optional(),
});
const TotpBody = z.object({ code: z.string().min(1) });
/** `POST /auth/reauth` — exactly one of password OR a live TOTP code
 * (ADR-0026 clause 1; recovery codes are never accepted here). */
const ReauthBody = z.union([
  z.object({ password: z.string().min(1) }).strict(),
  z.object({ code: z.string().min(1) }).strict(),
]);

/** Resolve a pre-session cookie (TOTP not yet completed) for the /auth/totp* routes. */
async function getPreSession(
  store: ConfigStore,
  token: string,
): Promise<{ session: SessionItem; account: AccountItem } | null> {
  const sKey = sessionKey(sha256hex(token));
  const session = (await store.get(sKey.PK, sKey.SK)) as SessionItem | null;
  if (!session) return null;
  const aKey = accountKey(session.userId);
  const account = (await store.get(aKey.PK, aKey.SK)) as AccountItem | null;
  if (!account || account.status !== 'active') return null;
  if (session.sessionVersion !== account.sessionVersion) return null;
  if (nowMs() > Date.parse(session.absoluteExpiresAt)) return null;
  return { session, account };
}

/**
 * Set the session cookie with the env-aware posture (deploy.ts): HttpOnly always,
 * plus Secure + SameSite resolved from env — Secure ON by default in production
 * (behind external TLS), OFF for local http dev/tests.
 */
function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions());
}

/** Verify a plaintext against a stored credential; reports whether pbkdf2 was used (→ re-hash). */
async function verifyCredential(account: AccountItem, password: string): Promise<{ ok: boolean; pbkdf2: boolean }> {
  if (account.credential.algo === 'argon2id') {
    return { ok: await verifyPassword(account.credential.hash, password), pbkdf2: false };
  }
  const ok = verifyPbkdf2(account.credential, password);
  return { ok, pbkdf2: ok };
}

export function authRoutes(): Hono<AppEnv> {
  const auth = new Hono<AppEnv>();

  // POST /auth/login — generic failure, lockout backoff, transparent pbkdf2 re-hash.
  auth.post('/login', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const username = parsed.data.username.trim().toLowerCase();
    const { password } = parsed.data;

    const aKey = accountKey(username);
    const account = (await store.get(aKey.PK, aKey.SK)) as AccountItem | null;

    // Any attempt during an active backoff window → 429 (no enumeration of correctness).
    if (account?.status === 'active' && account.lockedUntil && nowMs() < Date.parse(account.lockedUntil)) {
      return apiError(c, 'LOGIN_BACKOFF', { until: account.lockedUntil });
    }

    const verdict = account?.status === 'active' ? await verifyCredential(account, password) : { ok: false, pbkdf2: false };

    if (!verdict.ok || !account || account.status !== 'active') {
      // Failure: bump lockout on an active account; audit; generic 401 (never distinguishable).
      if (account?.status === 'active') {
        const failedAttempts = (account.failedAttempts ?? 0) + 1;
        const patch: AccountItem = { ...account, failedAttempts };
        let lockedNow = false;
        if (failedAttempts >= 5) {
          const mins = Math.min(60, 2 ** (failedAttempts - 5));
          patch.lockedUntil = new Date(nowMs() + mins * 60_000).toISOString();
          lockedNow = true;
        }
        await store.put(patch);
        await record(store, projectId, {
          action: lockedNow ? 'login-lockout' : 'login-failure',
          actor: account.id,
          targetType: 'session',
          targetId: account.id,
        });
      } else {
        await record(store, projectId, {
          action: 'login-failure',
          actor: username || '(unknown)',
          targetType: 'session',
          targetId: username || '(unknown)',
        });
      }
      return apiError(c, 'BAD_CREDENTIALS');
    }

    // 1FA passed: reset lockout; transparently re-hash pbkdf2 → argon2id.
    const updated: AccountItem = { ...account, failedAttempts: 0 };
    delete updated.lockedUntil;
    if (verdict.pbkdf2) updated.credential = { algo: 'argon2id', hash: await hashPassword(password) };
    await store.put(updated);

    // TOTP step. Challenge condition widened (ADR-0024 clause 4): an ENROLLED
    // factor is ALWAYS challenged, even when `needsTotp` alone would say no
    // (an admin totpRequired:false pin no longer silently stops challenging an
    // already-enrolled account — an exempted user who wants no challenge
    // removes their devices in self-service instead, an explicit audited act).
    // Login returns 200 with totpRequired=true and a SHORT-LIVED PRE-SESSION
    // cookie; the full session is minted only once /auth/totp, /auth/totp/enroll,
    // or /auth/totp/recovery completes.
    const devicesAtLogin = totpDevicesOf(updated);
    if (needsTotp(updated) || devicesAtLogin.length > 0) {
      if (devicesAtLogin.length > 0) {
        const pre = await mintSession(store, updated.id, updated.sessionVersion, { pending: 'totp', ttlMs: TOTP_PENDING_MS });
        setSessionCookie(c, pre);
        await record(store, projectId, { action: 'login-1fa', actor: updated.id, targetType: 'session', targetId: updated.id });
        return c.json({ user: publicAccount(updated, projectId), mustChangePassword: updated.mustChangePassword, totpRequired: true });
      }
      // needsTotp true, zero devices yet → first-login enrollment via provisioning URI.
      // Becomes device #1 ("Authenticator") on a correct code (/auth/totp/enroll below).
      const secret = generateTotpSecret();
      const secretEnc = getCipher().enc(secret);
      const pre = await mintSession(store, updated.id, updated.sessionVersion, {
        pending: 'enroll',
        enrollSecretEnc: secretEnc,
        ttlMs: TOTP_PENDING_MS,
      });
      setSessionCookie(c, pre);
      await record(store, projectId, { action: 'login-1fa', actor: updated.id, targetType: 'session', targetId: updated.id });
      const issuer = await resolveTotpIssuer(store);
      return c.json({
        user: publicAccount(updated, projectId),
        mustChangePassword: updated.mustChangePassword,
        totpRequired: true,
        totpEnrollment: { secret, otpauthUri: otpauthUri(updated.username, secret, issuer) },
      });
    }

    // Requester (no second factor) → straight to a full session.
    const token = await mintSession(store, updated.id, updated.sessionVersion);
    setSessionCookie(c, token);
    await record(store, projectId, { action: 'login-success', actor: updated.id, targetType: 'session', targetId: updated.id });
    return c.json({ user: publicAccount(updated, projectId), mustChangePassword: updated.mustChangePassword });
  });

  // POST /auth/totp — complete the TOTP step (pre-session cookie + code). ADR-0024
  // clause 3: verified against EACH enrolled device (any device satisfies a challenge).
  auth.post('/totp', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const parsed = TotpBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const token = getCookie(c, SESSION_COOKIE);
    const pre = token ? await getPreSession(store, token) : null;
    if (!pre || pre.session.pending !== 'totp') return apiError(c, 'TOTP_REQUIRED');

    const matched = verifyAnyTotpDevice(totpDevicesOf(pre.account), parsed.data.code);
    if (!matched) return apiError(c, 'TOTP_REQUIRED');

    // Stamp lastUsedAt on the matching device — this write also materializes
    // `totpDevices` (idempotent lazy migration, ADR-0024 clause 2) the first
    // time a legacy single-secret account ever verifies.
    const updatedAccount = withDeviceUseStamped(pre.account, matched.id, nowIso());
    await store.put(updatedAccount);
    await store.delete(pre.session.PK, pre.session.SK);
    const full = await mintSession(store, updatedAccount.id, updatedAccount.sessionVersion);
    setSessionCookie(c, full);
    await record(store, projectId, {
      action: 'login-success',
      actor: updatedAccount.id,
      targetType: 'session',
      targetId: updatedAccount.id,
      after: { deviceId: matched.id },
    });
    return c.json({ user: publicAccount(updatedAccount, projectId), mustChangePassword: updatedAccount.mustChangePassword });
  });

  // POST /auth/totp/enroll — confirm first-login TOTP enrollment (pre-session cookie
  // + code). Becomes device #1, named "Authenticator" (ADR-0024 clause 3); the
  // account's FIRST device auto-issues recovery codes (ADR-0025 clause 2), carried
  // once in this response.
  auth.post('/totp/enroll', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const parsed = TotpBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const token = getCookie(c, SESSION_COOKIE);
    const pre = token ? await getPreSession(store, token) : null;
    if (!pre || pre.session.pending !== 'enroll' || !pre.session.enrollSecretEnc) return apiError(c, 'TOTP_REQUIRED');

    const secret = getCipher().dec(pre.session.enrollSecretEnc);
    if (!verifyTotpCode(secret, parsed.data.code)) return apiError(c, 'TOTP_REQUIRED');

    const existingDevices = totpDevicesOf(pre.account);
    const device: TotpDevice = { id: ulid(), name: DEFAULT_DEVICE_NAME, secretEnc: pre.session.enrollSecretEnc, enrolledAt: nowIso() };
    let enrolled = withDevices({ ...pre.account, accountVersion: nextAccountVersion(pre.account) }, [...existingDevices, device]);

    const isFirstDevice = existingDevices.length === 0;
    let recoveryCodes: string[] | undefined;
    if (isFirstDevice) {
      const generated = generateRecoveryCodes();
      recoveryCodes = generated.plaintext;
      enrolled = { ...enrolled, recoveryCodes: { codes: generated.hashed, generatedAt: nowIso() } };
    }

    await store.put(enrolled);
    await store.delete(pre.session.PK, pre.session.SK);
    const full = await mintSession(store, enrolled.id, enrolled.sessionVersion);
    setSessionCookie(c, full);
    await record(store, projectId, { action: 'totp-enroll', actor: enrolled.id, targetType: 'account', targetId: enrolled.id });
    if (isFirstDevice) {
      await record(store, projectId, {
        action: 'recovery-codes-generate',
        actor: enrolled.id,
        targetType: 'account',
        targetId: enrolled.id,
        after: { count: recoveryCodes!.length },
      });
    }
    return c.json({
      user: publicAccount(enrolled, projectId),
      mustChangePassword: enrolled.mustChangePassword,
      ...(recoveryCodes ? { recoveryCodes } : {}),
    });
  });

  // POST /auth/totp/recovery — recovery-code login (ADR-0025 clause 3): another
  // way to satisfy the SAME pending:'totp' pre-session, not a new door. Success
  // burns exactly one code and mints a full session; failure is generic
  // TOTP_REQUIRED and feeds the same lockout backoff as a password guess.
  auth.post('/totp/recovery', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const parsed = TotpBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const token = getCookie(c, SESSION_COOKIE);
    const pre = token ? await getPreSession(store, token) : null;
    if (!pre || pre.session.pending !== 'totp') return apiError(c, 'TOTP_REQUIRED');

    const account = pre.account;
    const codes = account.recoveryCodes?.codes ?? [];
    const idx = findUnusedRecoveryCode(codes, parsed.data.code);

    if (idx === -1) {
      // Same lockout coupling as a bad password (routes/auth.ts login branch above).
      const failedAttempts = (account.failedAttempts ?? 0) + 1;
      const patch: AccountItem = { ...account, failedAttempts };
      if (failedAttempts >= 5) {
        const mins = Math.min(60, 2 ** (failedAttempts - 5));
        patch.lockedUntil = new Date(nowMs() + mins * 60_000).toISOString();
      }
      await store.put(patch);
      await record(store, projectId, { action: 'login-failure', actor: account.id, targetType: 'session', targetId: account.id });
      return apiError(c, 'TOTP_REQUIRED');
    }

    const nextCodes = codes.map((code, i) => (i === idx ? { ...code, usedAt: nowIso() } : code));
    const remaining = remainingRecoveryCodes(nextCodes);
    const updated: AccountItem = {
      ...account,
      recoveryCodes: { ...account.recoveryCodes!, codes: nextCodes },
      failedAttempts: 0,
      accountVersion: nextAccountVersion(account),
    };
    delete updated.lockedUntil;
    await store.put(updated);
    await store.delete(pre.session.PK, pre.session.SK);
    const full = await mintSession(store, updated.id, updated.sessionVersion);
    setSessionCookie(c, full);
    await record(store, projectId, { action: 'recovery-code-used', actor: updated.id, targetType: 'account', targetId: updated.id, after: { remaining } });
    // recoveryLogin:true — the Account page banners "you signed in with a
    // recovery code, review your devices" (ADR-0025 clause 3).
    return c.json({ user: publicAccount(updated, projectId), mustChangePassword: updated.mustChangePassword, recoveryLogin: true });
  });

  // POST /auth/logout — delete the server session, clear the cookie.
  auth.post('/logout', async (c) => {
    const store = c.get('store');
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const k = sessionKey(sha256hex(token));
      await store.delete(k.PK, k.SK);
    }
    deleteCookie(c, SESSION_COOKIE, sessionCookieOptions());
    return c.body(null, 204);
  });

  // GET /auth/me — session probe (idle window already slid by withSession).
  auth.get('/me', (c) => {
    const account = c.get('account');
    if (!account) {
      const fail = c.get('sessionFail');
      return apiError(c, fail ? failCode(fail) : 'NO_SESSION');
    }
    const session = c.get('session');
    return c.json({
      user: publicAccount(account, c.get('projectId')),
      mustChangePassword: account.mustChangePassword,
      sessionExpiresAt: session?.absoluteExpiresAt,
    });
  });

  // POST /auth/change-password — actor changes OWN password. `keepOtherSessions`
  // (§4, default false) — false is today's behavior verbatim (invalidate every
  // other session, re-mint the caller's); true keeps other sessions alive
  // (credential swap only, sessionVersion untouched). The current-password
  // field IS the re-authentication here (ADR-0026 clause 3) — no separate gate.
  auth.post('/change-password', async (c) => {
    const account = c.get('account');
    if (!account) {
      const fail = c.get('sessionFail');
      return apiError(c, fail ? failCode(fail) : 'NO_SESSION');
    }
    const store = c.get('store');
    const projectId = c.get('projectId');
    const parsed = ChangePwBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const cur = await verifyCredential(account, parsed.data.currentPassword);
    if (!cur.ok) return apiError(c, 'BAD_CREDENTIALS');

    const keepOtherSessions = parsed.data.keepOtherSessions === true;
    const updated: AccountItem = {
      ...account,
      credential: { algo: 'argon2id', hash: await hashPassword(parsed.data.newPassword) },
      mustChangePassword: false,
      failedAttempts: 0,
      // Every sessionVersion move MUST move accountVersion too: the admin dual-control
      // replays guard on accountVersion (store/schema.ts), and a self password-change has
      // to stale any pending proposal captured against the old account state — otherwise
      // a later ack could replay a stale sessionVersion over the one minted just below.
      ...(keepOtherSessions ? {} : { sessionVersion: account.sessionVersion + 1 }), // invalidates every existing session
      accountVersion: nextAccountVersion(account),
    };
    delete updated.lockedUntil;
    await store.put(updated);

    if (!keepOtherSessions) {
      // Re-mint the caller's session at the new version so the OLD cookie 401s (SESSION_INVALIDATED).
      const token = await mintSession(store, updated.id, updated.sessionVersion);
      setSessionCookie(c, token);
    }
    await record(store, projectId, {
      action: 'password-change',
      actor: updated.id,
      targetType: 'account',
      targetId: updated.id,
      ...(keepOtherSessions ? { after: { otherSessionsKept: true } } : {}),
    });
    return c.json({ user: publicAccount(updated, projectId), mustChangePassword: false });
  });

  // POST /auth/reauth — ADR-0026: password OR a live TOTP code (exactly one;
  // recovery codes never accepted here) stamps `reauthAt` on the CURRENT
  // session item. Failures feed the same lockout counter as login and a
  // locked account is refused LOGIN_BACKOFF before the body is even checked.
  auth.post('/reauth', async (c) => {
    const account = c.get('account');
    const session = c.get('session');
    if (!account || !session) {
      const fail = c.get('sessionFail');
      return apiError(c, fail ? failCode(fail) : 'NO_SESSION');
    }
    const store = c.get('store');
    const projectId = c.get('projectId');

    if (account.lockedUntil && nowMs() < Date.parse(account.lockedUntil)) {
      return apiError(c, 'LOGIN_BACKOFF', { until: account.lockedUntil });
    }

    const parsed = ReauthBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const byPassword = 'password' in parsed.data;

    let ok: boolean;
    if ('password' in parsed.data) {
      ok = (await verifyCredential(account, parsed.data.password)).ok;
    } else {
      ok = verifyAnyTotpDevice(totpDevicesOf(account), parsed.data.code) !== null;
    }

    if (!ok) {
      const failedAttempts = (account.failedAttempts ?? 0) + 1;
      const patch: AccountItem = { ...account, failedAttempts };
      if (failedAttempts >= 5) {
        const mins = Math.min(60, 2 ** (failedAttempts - 5));
        patch.lockedUntil = new Date(nowMs() + mins * 60_000).toISOString();
      }
      await store.put(patch);
      await record(store, projectId, { action: 'reauth-failure', actor: account.id, targetType: 'session', targetId: account.id });
      return apiError(c, byPassword ? 'BAD_CREDENTIALS' : 'TOTP_REQUIRED');
    }

    // Success mirrors login's own reset-on-success (same counter, same rule).
    const updatedAccount: AccountItem = { ...account, failedAttempts: 0 };
    delete updatedAccount.lockedUntil;
    await store.put(updatedAccount);

    const reauthAt = nowIso();
    const updatedSession: SessionItem = { ...session, reauthAt };
    await store.put(updatedSession);

    await record(store, projectId, { action: 'reauth-success', actor: account.id, targetType: 'session', targetId: account.id });
    return c.json({ ok: true, reauthAt });
  });

  return auth;
}
