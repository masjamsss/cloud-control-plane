import type { AuthResult, HttpApiClient, LoginResult } from '@/lib/httpApi';
import { markRecoveryLogin, setApiSessionAccount } from '@/lib/apiSession';

/**
 * The app side of the authoritative auth bridge. Pure, React-
 * free orchestration over the {@link HttpApiClient} identity methods so LoginPage
 * stays a thin view and the branching logic is unit-testable without a DOM (this
 * repo has no jsdom — see test/standalone.test.ts). Every helper that establishes
 * a full session mirrors the server account into the api-session bridge so the
 * app's synchronous currentUser() reflects it immediately.
 */

/**
 * The mandatory interstitial a server login demands before a full session opens.
 * Ordered by precedence: a not-yet-enrolled privileged account must ENROLL a
 * second factor; an enrolled one must pass the TOTP challenge; a temporary
 * password must be replaced; otherwise the login itself is the full session.
 */
export type AuthStep = 'enroll-totp' | 'verify-totp' | 'change-password' | 'done';

export function nextAuthStep(result: LoginResult): AuthStep {
  if (result.totpEnrollment) return 'enroll-totp';
  if (result.totpRequired) return 'verify-totp';
  if (result.mustChangePassword) return 'change-password';
  return 'done';
}

/** A TOTP code is exactly six digits (RFC 6238 default; otplib authenticator). */
export function isValidTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

/**
 * Pull the base32 `secret` out of an `otpauth://` enrolment URI, for the "type it
 * in by hand" fallback next to the QR data. Null when the URI carries no secret.
 */
export function parseOtpauthSecret(uri: string): string | null {
  const m = /[?&]secret=([^&]+)/i.exec(uri);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

export type ApiLoginOutcome =
  | { ok: true; step: AuthStep; result: LoginResult }
  | { ok: false; reason: string };

/** Generic sign-in failure — never reveals which of user/password/status was wrong. */
const GENERIC_LOGIN = 'Wrong username or password.';

/**
 * Step 1: exchange credentials for a session (or a short-lived pre-session that a
 * TOTP step upgrades). A login that needs no interstitial (`step==='done'`)
 * establishes the full session here; the TOTP steps defer that to
 * {@link completeEnrollTotp}/{@link completeVerifyTotp}.
 */
export async function apiLogin(
  client: HttpApiClient,
  username: string,
  password: string,
): Promise<ApiLoginOutcome> {
  try {
    const result = await client.login(username, password);
    const step = nextAuthStep(result);
    if (step === 'done') setApiSessionAccount(result.user);
    return { ok: true, step, result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : GENERIC_LOGIN };
  }
}

export type TotpOutcome = { ok: true; result: AuthResult } | { ok: false; reason: string };

const BAD_CODE = 'Enter the 6-digit code from your authenticator app.';
const REJECTED = 'That code was not accepted. Check your authenticator and try again.';
const CHANGE_REJECTED = 'That password could not be set. Check your current password and try again.';

/**
 * Step 2a (first sign-in): submit the first valid TOTP code, which BINDS the
 * shown secret and swaps the pre-session cookie for a full session.
 */
export async function completeEnrollTotp(
  client: HttpApiClient,
  code: string,
): Promise<TotpOutcome> {
  if (!isValidTotpCode(code)) return { ok: false, reason: BAD_CODE };
  try {
    const result = await client.enrollTotp(code.trim());
    setApiSessionAccount(result.user);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : REJECTED };
  }
}

/**
 * Step 2b (subsequent sign-ins): submit the TOTP challenge for an already-enrolled
 * account, upgrading the pre-session cookie to a full session.
 */
export async function completeVerifyTotp(
  client: HttpApiClient,
  code: string,
): Promise<TotpOutcome> {
  if (!isValidTotpCode(code)) return { ok: false, reason: BAD_CODE };
  try {
    const result = await client.completeTotp(code.trim());
    setApiSessionAccount(result.user);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : REJECTED };
  }
}

/**
 * Step 3 (forced first-use / admin-reset) — and, with `keepOtherSessions` set,
 * the standing Account page's own password card too: replace the current
 * password against the server (POST /auth/change-password). ccp-api
 * verifies the current password, clears `mustChangePassword`, and re-mints the
 * session at a new version (the old cookie 401s unless `keepOtherSessions` was
 * passed true, in which case only OTHER sessions die) — we mirror the
 * now-unblocked account into the bridge so `currentUser()` opens the full
 * session and RequireAuth stops bouncing. Failure (wrong current password)
 * leaves the bridge untouched so the caller stays on their screen to retry.
 * `keepOtherSessions` is omitted (server default: false, sign everyone else
 * out) by the forced first-use call site, which never offers the choice — a
 * temporary password was known to someone else, so it always invalidates.
 */
export async function completeChangePassword(
  client: HttpApiClient,
  currentPassword: string,
  newPassword: string,
  keepOtherSessions?: boolean,
): Promise<TotpOutcome> {
  try {
    // Preserve the exact 2-arg call shape when the caller doesn't care about
    // `keepOtherSessions` (the forced first-use screen never passes it) — only
    // the standing card's explicit choice adds the third argument.
    const result =
      keepOtherSessions === undefined
        ? await client.changePassword(currentPassword, newPassword)
        : await client.changePassword(currentPassword, newPassword, keepOtherSessions);
    setApiSessionAccount(result.user);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : CHANGE_REJECTED };
  }
}

/**
 * Step 2c: a second way to satisfy the very same `pending:'totp'` pre-session
 * `completeVerifyTotp` upgrades — for someone who has lost every enrolled
 * device. Burns one one-time recovery code and upgrades to a full session
 * exactly like a code-verified login; the account's `recoveryLogin` flag comes
 * back true so the caller can offer a "review your devices" nudge afterward.
 */
export async function completeRecoveryLogin(
  client: HttpApiClient,
  code: string,
): Promise<TotpOutcome> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: 'Enter one of your recovery codes.' };
  try {
    const result = await client.completeTotpRecovery(trimmed);
    setApiSessionAccount(result.user);
    if (result.recoveryLogin) markRecoveryLogin();
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : REJECTED };
  }
}

/**
 * The outcome of re-establishing identity from an existing server cookie: either
 * no live session (show the login form), or a live one plus the SAME
 * {@link nextAuthStep} the login path uses — so a hydrated session still pinned
 * to a temporary password routes to `change-password`, not straight home (which
 * RequireAuth would bounce back to /login, looping). `me()` carries no TOTP
 * fields, so the only steps hydrate can yield are `change-password` or `done`.
 */
export type HydrateOutcome =
  | { live: false }
  | { live: true; step: AuthStep; result: AuthResult };

/**
 * Re-establish the app's current user from an existing server cookie (page load /
 * refresh). Mirrors a found session into the bridge and reports the next auth
 * step; reports `{live:false}` when there is none.
 */
export async function hydrateApiSession(client: HttpApiClient): Promise<HydrateOutcome> {
  try {
    const me = await client.me();
    if (!me) {
      setApiSessionAccount(null);
      return { live: false };
    }
    setApiSessionAccount(me.user);
    return { live: true, step: nextAuthStep(me), result: me };
  } catch {
    setApiSessionAccount(null);
    return { live: false };
  }
}
