import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { AppEnv } from '../appEnv';
import type { AccountItem, TotpDevice } from '../store/schema';
import { nextAccountVersion } from '../store/schema';
import { apiError } from '../errors';
import { requireSession, failCode } from '../middleware/session';
import {
  DEFAULT_DEVICE_NAME,
  MAX_TOTP_DEVICES,
  generateTotpSecret,
  getCipher,
  needsTotp,
  otpauthUri,
  resolveTotpIssuer,
  totpDevicesOf,
  verifyTotpCode,
  withDevices,
} from '../auth/totp';
import { generateRecoveryCodes, remainingRecoveryCodes } from '../auth/recovery';
import { REAUTH_MS, TOTP_PENDING_MS, findUserSessionBySha, killOtherSessions, listLiveSessions } from '../auth/sessions';
import { record } from '../domain/audit';
import { nowIso, nowMs } from '../clock';

/**
 * Self-service account & security routes (account & security center spec
 * §5–§8): multi-device TOTP add/name/remove, recovery-code counts/regenerate,
 * and the active-sessions list + revoke. Mounted at `/auth` beside
 * `authRoutes()` (index.ts) — a second Hono sub-app at the SAME prefix, one
 * per concern (login-step-machine routes vs standing self-service routes),
 * the same "two small groups over one big file" split `instance.ts` uses for
 * public-vs-admin.
 *
 * Every route requires a FULL session (`requireSession`); the ⚿-marked ones
 * in the spec table additionally require a FRESH (<=10m) re-auth elevation
 * (ADR-0026, {@link requireReauth} below) — a session cookie alone is never
 * enough to add/remove a 2FA device, regenerate recovery codes, or revoke a
 * session.
 */

const NO_CONTROL_CHARS = /^[^\x00-\x1F\x7F]*$/;
/** Device name: trimmed, single-line, 1–40 chars, no control characters
 * (the ADR-0023 name-validation pattern) — duplicate names allowed (ids
 * disambiguate), the UI nudges uniqueness. */
const DeviceName = z.string().trim().min(1).max(40).regex(NO_CONTROL_CHARS);
const ConfirmDeviceBody = z.object({ code: z.string().min(1), name: DeviceName });

/**
 * ADR-0026 clause 3: gate a sensitive self-service route on a FRESH re-auth
 * elevation stamped on the resolved session (`POST /auth/reauth`). Absent
 * `reauthAt` (never elevated, or a legacy/pre-existing session) fails closed
 * exactly like an expired one.
 */
const requireReauth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) {
    const fail = c.get('sessionFail');
    return apiError(c, fail ? failCode(fail) : 'NO_SESSION');
  }
  if (!session.reauthAt || nowMs() - Date.parse(session.reauthAt) > REAUTH_MS) {
    return apiError(c, 'REAUTH_REQUIRED');
  }
  await next();
};

export function accountRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireSession);

  /* ── multi-device TOTP (ADR-0024 §5) ─────────────────────────────────── */

  // GET /auth/totp-devices — never secretEnc.
  r.get('/totp-devices', (c) => {
    const account = c.get('account')!;
    const devices = totpDevicesOf(account).map((d) => ({
      id: d.id,
      name: d.name,
      enrolledAt: d.enrolledAt,
      ...(d.lastUsedAt ? { lastUsedAt: d.lastUsedAt } : {}),
    }));
    return c.json(devices);
  });

  // POST /auth/totp-devices — begin add: mint a secret, hold it on the
  // CALLER'S FULL session (the pre-session pattern, now legal on a full
  // session), return the QR/setup-key material. Offer expires after
  // TOTP_PENDING_MS (the same 5-minute clock the login pre-session uses).
  r.post('/totp-devices', requireReauth, async (c) => {
    const account = c.get('account')!;
    const session = c.get('session')!;
    const store = c.get('store');
    if (totpDevicesOf(account).length >= MAX_TOTP_DEVICES) return apiError(c, 'DEVICE_LIMIT');

    const secret = generateTotpSecret();
    const secretEnc = getCipher().enc(secret);
    await store.put({ ...session, enrollSecretEnc: secretEnc, enrollOfferedAt: nowIso() });

    const issuer = await resolveTotpIssuer(store);
    return c.json({ secret, otpauthUri: otpauthUri(account.username, secret, issuer) });
  });

  // POST /auth/totp-devices/confirm — verify the held secret with a live
  // code, append the named device (materializing totpDevices + deleting the
  // legacy `totp`, ADR-0024 clause 2). The account's FIRST device also
  // auto-issues recovery codes (ADR-0025 clause 2), returned once.
  r.post('/totp-devices/confirm', requireReauth, async (c) => {
    const account = c.get('account')!;
    const session = c.get('session')!;
    const store = c.get('store');
    const projectId = c.get('projectId');
    const parsed = ConfirmDeviceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    if (!session.enrollSecretEnc || !session.enrollOfferedAt) return apiError(c, 'TOTP_REQUIRED');
    if (nowMs() - Date.parse(session.enrollOfferedAt) > TOTP_PENDING_MS) return apiError(c, 'TOTP_REQUIRED');
    const secret = getCipher().dec(session.enrollSecretEnc);
    if (!verifyTotpCode(secret, parsed.data.code)) return apiError(c, 'TOTP_REQUIRED');

    const existingDevices = totpDevicesOf(account);
    if (existingDevices.length >= MAX_TOTP_DEVICES) return apiError(c, 'DEVICE_LIMIT');
    const device: TotpDevice = { id: ulid(), name: parsed.data.name, secretEnc: session.enrollSecretEnc, enrolledAt: nowIso() };
    let updated = withDevices({ ...account, accountVersion: nextAccountVersion(account) }, [...existingDevices, device]);

    const isFirstDevice = existingDevices.length === 0;
    let recoveryCodes: string[] | undefined;
    if (isFirstDevice) {
      const generated = generateRecoveryCodes();
      recoveryCodes = generated.plaintext;
      updated = { ...updated, recoveryCodes: { codes: generated.hashed, generatedAt: nowIso() } };
    }
    await store.put(updated);

    // Clear the offer holding fields — the session moves on from "mid-enrollment".
    const clearedSession = { ...session };
    delete clearedSession.enrollSecretEnc;
    delete clearedSession.enrollOfferedAt;
    await store.put(clearedSession);

    await record(store, projectId, {
      action: 'totp-device-add',
      actor: account.id,
      targetType: 'account',
      targetId: account.id,
      after: { deviceId: device.id, name: device.name },
    });
    if (isFirstDevice) {
      await record(store, projectId, {
        action: 'recovery-codes-generate',
        actor: account.id,
        targetType: 'account',
        targetId: account.id,
        after: { count: recoveryCodes!.length },
      });
    }

    return c.json({
      id: device.id,
      name: device.name,
      enrolledAt: device.enrolledAt,
      ...(recoveryCodes ? { recoveryCodes } : {}),
    });
  });

  // DELETE /auth/totp-devices/:id — refuse LAST_FACTOR while needsTotp is
  // true; otherwise remove (and, if it was the last device, delete the
  // recovery codes with it — ADR-0024 clause 5 / ADR-0025 clause 4).
  r.delete('/totp-devices/:id', requireReauth, async (c) => {
    const account = c.get('account')!;
    const store = c.get('store');
    const projectId = c.get('projectId');
    const id = c.req.param('id');

    const devices = totpDevicesOf(account);
    const target = devices.find((d) => d.id === id);
    if (!target) return c.json({ code: 'NOT_FOUND', reason: 'No such device.' }, 404);

    const remaining = devices.filter((d) => d.id !== id);
    if (remaining.length === 0 && needsTotp(account)) return apiError(c, 'LAST_FACTOR');

    let updated = withDevices({ ...account, accountVersion: nextAccountVersion(account) }, remaining);
    const hadCodes = remaining.length === 0 && account.recoveryCodes !== undefined;
    if (hadCodes) delete updated.recoveryCodes;
    await store.put(updated);

    await record(store, projectId, {
      action: 'totp-device-remove',
      actor: account.id,
      targetType: 'account',
      targetId: account.id,
      before: { deviceId: target.id, name: target.name },
      after: { totpEnrolled: remaining.length > 0 },
    });
    if (hadCodes) {
      await record(store, projectId, {
        action: 'recovery-codes-clear',
        actor: account.id,
        targetType: 'account',
        targetId: account.id,
        before: { count: remainingRecoveryCodes(account.recoveryCodes!.codes) },
      });
    }
    return c.json({ ok: true });
  });

  /* ── recovery codes (ADR-0025) ───────────────────────────────────────── */

  // GET /auth/recovery-codes — counts only, ever.
  r.get('/recovery-codes', (c) => {
    const account = c.get('account')!;
    const rc = account.recoveryCodes;
    return c.json({ remaining: remainingRecoveryCodes(rc?.codes), ...(rc ? { generatedAt: rc.generatedAt } : {}) });
  });

  // POST /auth/recovery-codes/regenerate — replaces the WHOLE set; refused
  // when no device is enrolled (codes exist only while 2FA is active).
  r.post('/recovery-codes/regenerate', requireReauth, async (c) => {
    const account = c.get('account')!;
    const store = c.get('store');
    const projectId = c.get('projectId');
    if (totpDevicesOf(account).length === 0) return apiError(c, 'TOTP_REQUIRED');

    const generated = generateRecoveryCodes();
    const generatedAt = nowIso();
    const updated: AccountItem = {
      ...account,
      recoveryCodes: { codes: generated.hashed, generatedAt },
      accountVersion: nextAccountVersion(account),
    };
    await store.put(updated);
    await record(store, projectId, {
      action: 'recovery-codes-generate',
      actor: account.id,
      targetType: 'account',
      targetId: account.id,
      after: { count: generated.plaintext.length },
    });
    return c.json({ codes: generated.plaintext, generatedAt });
  });

  /* ── active sessions (the session model made visible, §8) ───────────── */

  // GET /auth/sessions — the caller's own live sessions.
  r.get('/sessions', async (c) => {
    const account = c.get('account')!;
    const session = c.get('session')!;
    const store = c.get('store');
    const sessions = await listLiveSessions(store, account.id, session.GSI1SK ?? '');
    return c.json(sessions);
  });

  // DELETE /auth/sessions/:id — revoke ONE of the caller's OWN sessions
  // (404 on any id not in their own GSI list — no cross-user probing).
  // Deleting the current session IS sign-out (the cookie then resolves
  // to nothing on the next request).
  r.delete('/sessions/:id', requireReauth, async (c) => {
    const account = c.get('account')!;
    const store = c.get('store');
    const projectId = c.get('projectId');
    const id = c.req.param('id');
    // Scoped to the CALLER's own GSI partition — an id from another
    // account's session list can never resolve here (no cross-user probing).
    const target = await findUserSessionBySha(store, account.id, id);
    if (!target) return c.json({ code: 'NOT_FOUND', reason: 'No such session.' }, 404);
    await store.delete(target.PK, target.SK);

    await record(store, projectId, { action: 'session-revoke-self', actor: account.id, targetType: 'session', targetId: account.id, after: { revoked: 1 } });
    return c.json({ ok: true, revoked: 1 });
  });

  // POST /auth/sessions/revoke-others — kills every session but the caller's,
  // WITHOUT a sessionVersion bump (that would kill the keeper too).
  r.post('/sessions/revoke-others', requireReauth, async (c) => {
    const account = c.get('account')!;
    const session = c.get('session')!;
    const store = c.get('store');
    const projectId = c.get('projectId');
    const keepSha = session.GSI1SK ?? '';
    const revoked = await killOtherSessions(store, account.id, keepSha);
    await record(store, projectId, { action: 'session-revoke-self', actor: account.id, targetType: 'session', targetId: account.id, after: { revoked } });
    return c.json({ ok: true, revoked });
  });

  return r;
}
