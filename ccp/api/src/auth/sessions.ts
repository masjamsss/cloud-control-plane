import { createHash, randomBytes } from 'node:crypto';
import type { ConfigStore } from '../store/configStore';
import type { AccountItem, SessionItem } from '../store/schema';
import { accountKey, sessionKey, sessionUserGsi } from '../store/schema';
import { nowMs } from '../clock';
import type { SessionFail } from '../appEnv';

/** Session TTLs mirror the SPA exactly (auth.ts:14-15): 12h absolute, 30m idle. */
export const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const IDLE_MS = 30 * 60 * 1000;
/** Pre-session (TOTP step pending) lifetime, and the standing device-add
 * offer's own window (ADR-0024 §5 reuses this exact constant — "one clock,
 * not two"). */
export const TOTP_PENDING_MS = 5 * 60 * 1000;
/** Re-authentication elevation window (ADR-0026 clause 2) — a third sibling
 * constant beside the two above, not a setting (SPA "session limits" steppers
 * are already documented authority theater, SETTINGS-CATALOG §SPA-local). */
export const REAUTH_MS = 10 * 60 * 1000;

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Mint a 256-bit opaque session token; the server stores only sha256(token). */
export async function mintSession(
  store: ConfigStore,
  userId: string,
  sessionVersion: number,
  opts?: { pending?: 'totp' | 'enroll'; enrollSecretEnc?: string; ttlMs?: number },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const sha = sha256hex(token);
  const now = nowMs();
  const ttlMs = opts?.ttlMs ?? ABSOLUTE_MS;
  const absoluteExpiresAt = new Date(now + ttlMs).toISOString();
  const item: SessionItem = {
    ...sessionKey(sha),
    userId,
    issuedAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    absoluteExpiresAt,
    sessionVersion,
    ttl: Math.floor((now + ttlMs) / 1000),
    GSI1PK: sessionUserGsi(userId),
    GSI1SK: sha,
    ...(opts?.pending ? { pending: opts.pending } : {}),
    ...(opts?.enrollSecretEnc ? { enrollSecretEnc: opts.enrollSecretEnc } : {}),
  };
  await store.put(item);
  return token;
}

export type ResolveResult =
  | { ok: true; account: AccountItem; session: SessionItem }
  | { ok: false; reason: SessionFail };

/**
 * Resolve a raw token to its account + session, sliding the 30m idle window on
 * success. Fail-closed with a typed reason the edge maps to a 401 code.
 * `sessionVersion` mismatch = the account's password/role was reset → invalidated.
 */
export async function resolveSession(store: ConfigStore, token: string, now: number = nowMs()): Promise<ResolveResult> {
  const sha = sha256hex(token);
  const sKey = sessionKey(sha);
  const raw = await store.get(sKey.PK, sKey.SK);
  if (!raw) return { ok: false, reason: 'invalid' };
  const session = raw as SessionItem;

  const aKey = accountKey(session.userId);
  const accRaw = await store.get(aKey.PK, aKey.SK);
  if (!accRaw) return { ok: false, reason: 'invalid' };
  const account = accRaw as AccountItem;
  if (account.status !== 'active') return { ok: false, reason: 'invalid' };
  if (session.sessionVersion !== account.sessionVersion) return { ok: false, reason: 'version' };

  if (now > Date.parse(session.absoluteExpiresAt)) return { ok: false, reason: 'expired' };
  if (now - Date.parse(session.lastSeenAt) > IDLE_MS) return { ok: false, reason: 'idle' };

  // A pre-session (TOTP not completed) is not a full session.
  if (session.pending) return { ok: false, reason: 'totp' };

  // Slide the idle window forward on activity (session.ts parity).
  const slid: SessionItem = { ...session, lastSeenAt: new Date(now).toISOString() };
  await store.put(slid);
  return { ok: true, account, session: slid };
}

/** Kill every live session for a user (reset/disable/revoke). Returns the count revoked. */
export async function killAllSessions(store: ConfigStore, userId: string): Promise<number> {
  const sessions = await store.queryGSI1(sessionUserGsi(userId));
  for (const s of sessions) {
    await store.delete(s.PK, s.SK);
  }
  return sessions.length;
}

/**
 * Resolve ONE of `userId`'s own sessions by its `GSI1SK` (the id `GET
 * /auth/sessions` lists — a hash, never the token). Scoped to the OWNING
 * user by construction (queries that user's own GSI partition) — an id from
 * another account's session list can never resolve here, so
 * `DELETE /auth/sessions/:id` needs no separate ownership check to avoid
 * cross-user probing.
 */
export async function findUserSessionBySha(store: ConfigStore, userId: string, sha: string): Promise<SessionItem | null> {
  const sessions = (await store.queryGSI1(sessionUserGsi(userId))) as SessionItem[];
  return sessions.find((s) => s.GSI1SK === sha) ?? null;
}

/**
 * Self-service "sign out my other devices" (ADR-0026 clause 3 / the account
 * & security spec §8): deletes every one of `userId`'s sessions EXCEPT the
 * one whose token hashes to `keepSha` — deliberately WITHOUT a
 * `sessionVersion` bump (a bump would kill the keeper too). `killAllSessions`
 * stays the admin/reset tool for "kill absolutely everything." Returns the
 * count revoked.
 */
export async function killOtherSessions(store: ConfigStore, userId: string, keepSha: string): Promise<number> {
  const sessions = (await store.queryGSI1(sessionUserGsi(userId))) as SessionItem[];
  let revoked = 0;
  for (const s of sessions) {
    if (s.GSI1SK === keepSha) continue;
    await store.delete(s.PK, s.SK);
    revoked++;
  }
  return revoked;
}

/** One row of the caller's own active-sessions list (`GET /auth/sessions`). */
export type SessionListRow = { id: string; issuedAt: string; lastSeenAt: string; current: boolean };

/**
 * The caller's LIVE sessions (account & security spec §8) — expired and
 * pre-session (TOTP-pending) rows filtered out; `current` marks the session
 * resolved for THIS request. `id` is `GSI1SK` — the stored sha256 of the
 * token (never the token itself), the same value `killOtherSessions`'s
 * `keepSha` and `DELETE /auth/sessions/:id` both key on.
 */
export async function listLiveSessions(store: ConfigStore, userId: string, currentSha: string, now: number = nowMs()): Promise<SessionListRow[]> {
  const sessions = (await store.queryGSI1(sessionUserGsi(userId))) as SessionItem[];
  return sessions
    .filter((s) => !s.pending && now <= Date.parse(s.absoluteExpiresAt) && now - Date.parse(s.lastSeenAt) <= IDLE_MS)
    .map((s) => ({ id: s.GSI1SK ?? '', issuedAt: s.issuedAt, lastSeenAt: s.lastSeenAt, current: s.GSI1SK === currentSha }))
    .sort((a, b) => (a.current === b.current ? b.lastSeenAt.localeCompare(a.lastSeenAt) : a.current ? -1 : 1));
}
