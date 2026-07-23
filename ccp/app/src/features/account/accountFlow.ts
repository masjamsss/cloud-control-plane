import type { HttpApiClient, OwnSessionRow, TotpEnrollmentOffer } from '@/lib/httpApi';
import { ApiRefusalError } from '@/lib/httpApi';
import {
  beginAddTotpDevice as mockBeginAddTotpDevice,
  changeOwnPassword as mockChangeOwnPassword,
  confirmAddTotpDevice as mockConfirmAddTotpDevice,
  getAccount,
  getRecoveryStatus,
  listTotpDevices as mockListTotpDevices,
  reauthWithPassword as mockReauthWithPassword,
  regenerateRecoveryCodes as mockRegenerateRecoveryCodes,
  removeTotpDevice as mockRemoveTotpDevice,
  revokeOwnOtherSessions as mockRevokeOwnOtherSessions,
  ReauthRequiredError,
} from '@/lib/accounts';
import { effectiveTotpRequired } from '@/features/admin/usersFlow';
import { completeChangePassword } from '@/features/auth/authFlow';

/**
 * The standing Account & security page's ADVISORY → AUTHORITATIVE branch.
 * Pure, React-free so every wired action is unit-testable without mounting
 * the page (this repo has no jsdom — see test/standalone.test.ts). Every
 * helper mirrors usersFlow.ts's `if (authoritative && client) {...} else
 * {...lib/accounts...}` shape. Unlike the admin surface, "authoritative"
 * here is never a permission gate (`can(...)`) — every signed-in account
 * manages its OWN identity regardless of role, so the caller always passes
 * whether this build is wired to a real server at all (api mode), nothing
 * more.
 */

/* ── multi-device authenticator management ──────────────────────────────── */

export interface DeviceRow {
  id: string;
  name: string;
  enrolledAt: string;
  lastUsedAt?: string;
}

export async function loadDevicesVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<DeviceRow[]> {
  if (authoritative && client) return client.listTotpDevices();
  return mockListTotpDevices(id).map((d) => ({ id: d.id, name: d.name, enrolledAt: d.enrolledAt }));
}

/** Begin adding a device: mints a fresh secret to render as a QR + setup key.
 * Re-auth-gated both ways (server 403, mock throws {@link ReauthRequiredError}). */
export async function beginAddDeviceVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<TotpEnrollmentOffer> {
  if (authoritative && client) return client.beginAddTotpDevice();
  return mockBeginAddTotpDevice(id);
}

export interface DeviceConfirmResult {
  id: string;
  name: string;
  enrolledAt: string;
  /** Present only when this was the account's very first device. */
  recoveryCodes?: string[];
}

export async function confirmAddDeviceVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  code: string,
  name: string,
): Promise<DeviceConfirmResult> {
  if (authoritative && client) return client.confirmAddTotpDevice(code, name);
  return mockConfirmAddTotpDevice(id, code, name);
}

/** Remove a device by id. Refused (server `LAST_FACTOR` / the mock's matching
 * message) when it is the account's last device AND 2FA is still required for
 * them — enforced by both backends, not merely a client-side disable, so this
 * never pre-computes a verdict; it just surfaces whichever refusal comes
 * back. The mock enforces the same rule locally via {@link effectiveTotpRequired},
 * the app's own mirror of the server's `needsTotp`. */
export async function removeDeviceVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  deviceId: string,
): Promise<void> {
  if (authoritative && client) {
    await client.removeTotpDevice(deviceId);
    return;
  }
  mockRemoveTotpDevice(id, deviceId, effectiveTotpRequired);
}

/* ── recovery codes ───────────────────────────────────────────────────────── */

export interface RecoveryStatusView {
  remaining: number;
  generatedAt?: string;
}

export async function loadRecoveryStatusVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<RecoveryStatusView> {
  if (authoritative && client) return client.getRecoveryCodesStatus();
  return getRecoveryStatus(id);
}

export interface RecoveryRegenerateView {
  codes: string[];
  generatedAt: string;
}

/** Replace the whole set. Re-auth-gated; refused when no device is enrolled —
 * codes exist only while 2FA is active, on both backends. */
export async function regenerateRecoveryCodesVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<RecoveryRegenerateView> {
  if (authoritative && client) return client.regenerateRecoveryCodes();
  return mockRegenerateRecoveryCodes(id);
}

/* ── active sessions ──────────────────────────────────────────────────────── */

/**
 * The two backends model "my sessions" differently and this is a NAMED,
 * deliberate parity gap (matching the class the design accepts for TOTP
 * secrets and enrolment): the server keeps a real per-session index, so api
 * mode gets an actual row-by-row list with per-row revoke; the mock store
 * keeps only a demo COUNT (`Account.activeSessions`, unchanged since long
 * before this feature), with no per-session identity to revoke individually.
 * The card renders whichever shape it's handed.
 */
export type SessionsView =
  { kind: 'rows'; rows: OwnSessionRow[] } | { kind: 'count'; otherSessions: number };

export async function loadSessionsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<SessionsView> {
  if (authoritative && client) {
    const rows = await client.listOwnSessions();
    return { kind: 'rows', rows };
  }
  const total = getAccount(id)?.activeSessions ?? 0;
  // The mock counter has no "this device" vs "others" distinction — treat one
  // of it as the tab looking at this page right now, same convention the
  // admin's users screen already renders ("this device + N others").
  return { kind: 'count', otherSessions: Math.max(0, total - 1) };
}

/** Revoke exactly one of the caller's own sessions — api mode only (the mock
 * has no per-session id to target; its card offers only the bulk action
 * below). */
export async function revokeSessionVia(client: HttpApiClient, sessionId: string): Promise<void> {
  await client.revokeOwnSession(sessionId);
}

export async function revokeOtherSessionsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<{ revoked: number }> {
  if (authoritative && client) return client.revokeOwnOtherSessions();
  const result = mockRevokeOwnOtherSessions(id);
  return { revoked: result.sessionsRevoked };
}

/* ── password ──────────────────────────────────────────────────────────────── */

export type ChangeOwnPasswordOutcome = { ok: true } | { ok: false; reason: string };

const GENERIC_PASSWORD_ERROR = 'That password could not be set.';

/**
 * The standing card's password change: verify-first on both backends. Api
 * mode reuses the SAME server call + session-mirroring the forced first-use
 * screen uses ({@link completeChangePassword}); `signOutOtherDevices` is this
 * card's own checkbox state, inverted here to the server's `keepOtherSessions`
 * flag (checked = sign the others out = `keepOtherSessions: false`).
 */
export async function changeOwnPasswordVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  currentPassword: string,
  newPassword: string,
  signOutOtherDevices: boolean,
): Promise<ChangeOwnPasswordOutcome> {
  if (authoritative && client) {
    const out = await completeChangePassword(
      client,
      currentPassword,
      newPassword,
      !signOutOtherDevices,
    );
    return out.ok ? { ok: true } : { ok: false, reason: out.reason };
  }
  try {
    await mockChangeOwnPassword(id, currentPassword, newPassword);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : GENERIC_PASSWORD_ERROR };
  }
}

/* ── the re-authentication gate ───────────────────────────────────────────── */

/** True when `err` is the specific "prove it's you again first" refusal —
 * the server's `403 REAUTH_REQUIRED` (carried as {@link ApiRefusalError}'s
 * `.code`) or the mock's matching {@link ReauthRequiredError}. Any other
 * failure is a genuine error the caller should show as-is, never treated as
 * an invitation to elevate. */
export function isReauthError(err: unknown): boolean {
  if (err instanceof ApiRefusalError) return err.code === 'REAUTH_REQUIRED';
  return err instanceof ReauthRequiredError;
}

/**
 * Prove it's you again: password on both backends, or a live authenticator
 * code — api mode only, since the mock holds no real TOTP secret to check a
 * code against (the same named parity gap as sessions above). Returns
 * false on a wrong password/code rather than throwing, so the dialog can
 * show a plain retry instead of an unhandled rejection.
 */
export async function reauthVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  input: { password: string } | { code: string },
): Promise<boolean> {
  if (authoritative && client) {
    try {
      await client.reauth(input);
      return true;
    } catch {
      return false;
    }
  }
  if ('password' in input) return mockReauthWithPassword(id, input.password);
  return false;
}
