import { createHash, randomBytes } from 'node:crypto';
import type { ConfigStore } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import type { AccountItem, SessionItem } from '../store/schema';
import { accountKey, sessionKey, sessionUserGsi } from '../store/schema';
import { nowMs } from '../clock';
import type { SessionFail } from '../appEnv';
import { sweepUserSessions } from '../domain/retention';

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

/**
 * How stale `lastSeenAt` must be before a successful resolve WRITES the slid idle
 * window back to the store.
 *
 * The idle window is 30 minutes; persisting the slide on literally every request
 * bought no accuracy and cost a durable write per request — on the FileStore that
 * is a full-snapshot fsync, so an unauthenticated-shaped read like `GET /healthz`
 * was paying to rewrite the entire governance database because a session cookie
 * happened to ride along. Coalescing to a one-minute granularity removes ~99% of
 * those writes on any real traffic pattern.
 *
 * The direction is deliberately fail-CLOSED: within the coalescing window the
 * stored `lastSeenAt` lags reality by at most `SLIDE_GRANULARITY_MS`, so a session
 * can idle out up to a minute EARLY, never a moment late — the security property
 * ("30 minutes of inactivity ends the session") is preserved and, at the margin,
 * enforced slightly more strictly. The resolved session handed to the request
 * always carries the true current `lastSeenAt`, so nothing downstream observes the
 * lag within a request.
 */
export const SLIDE_GRANULARITY_MS = 60 * 1000;

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
  // PERF-7 — retention, opportunistically and only for THIS user. A session row
  // carries a `ttl` that nothing enforced, so every closed tab left one behind
  // forever. Minting is the natural moment: the user is provably present, their
  // partition is already the one being written, and the sweep costs their own
  // session count rather than a scan. Deliberately AFTER the put and deliberately
  // not awaited into the result — a retention failure must never fail a login.
  try {
    await sweepUserSessions(store, userId, now);
  } catch {
    /* retention is best-effort; the new session is what this call promised */
  }
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

  // Slide the idle window forward on activity (session.ts parity). The slid value is
  // always what this request sees; the WRITE is coalesced to SLIDE_GRANULARITY_MS so a
  // burst of requests on one session costs one durable write, not one per request.
  const slid: SessionItem = { ...session, lastSeenAt: new Date(now).toISOString() };
  if (now - Date.parse(session.lastSeenAt) >= SLIDE_GRANULARITY_MS) {
    const survived = await slideIdleWindow(store, sKey, session.lastSeenAt, slid.lastSeenAt);
    if (!survived) return { ok: false, reason: 'invalid' };
  }
  return { ok: true, account, session: slid };
}

/**
 * Write the slid `lastSeenAt`, GUARDED (API-10 / CONC-4). Returns false when the session
 * row is gone — the caller must then fail the request closed.
 *
 * The slide used to be an unconditional whole-item `store.put(slid)` after two awaited
 * reads. `killAllSessions`, `killOtherSessions` and `DELETE /auth/sessions/:id` revoke by
 * DELETING rows without bumping `sessionVersion` — deliberately, so the caller's own
 * session survives "sign out my other devices". So an in-flight request on the session
 * being revoked would `get` the row, watch the delete land, and then RECREATE it with the
 * put. The revocation was silently undone, and the resurrected session kept sliding its
 * own idle window on every subsequent request, so it lived until absolute expiry.
 *
 * That is the common case, not a corner: the reason to revoke a session is that it is
 * active, a polling SPA has a request in flight essentially always, and
 * `killOtherSessions` deletes row-by-row, holding the window open across every row.
 * The `sessionVersion`-bumping paths (password reset, admin revoke) were immune —
 * a resurrected row fails the version check — which is exactly why the self-service
 * paths' failure never showed up next to them.
 *
 * A guarded `update` fixes it because the store fails an `ifEquals` against a MISSING item
 * (DynamoDB-faithful, `memoryStore.ts`): a row that was deleted cannot be conditioned back
 * into existence. It also narrows the write to the one attribute that changed, so the
 * slide can no longer clobber a concurrent mutation to any other field.
 *
 * A LOST CONDITION IS NOT AUTOMATICALLY A DEAD SESSION, and treating it as one would trade
 * this bug for a worse one. Two different things lose the guard: the row was revoked, or
 * another in-flight request on the same session slid it first — which is precisely what
 * `SLIDE_GRANULARITY_MS` coalescing makes likely under a burst. Logging the user out
 * because two of their own tabs raced would be a self-inflicted denial of service. So the
 * loser re-reads and lets presence decide: gone means revoked, present means someone else
 * did the work. One extra read, only on the contended path.
 */
async function slideIdleWindow(
  store: ConfigStore,
  sKey: { PK: string; SK: string },
  expected: string,
  next: string,
): Promise<boolean> {
  try {
    await store.transact([
      {
        kind: 'update',
        pk: sKey.PK,
        sk: sKey.SK,
        set: { lastSeenAt: next },
        ifEquals: { attr: 'lastSeenAt', value: expected },
      },
    ]);
    return true;
  } catch (e) {
    if (!(e instanceof ConditionError)) throw e;
    return (await store.get(sKey.PK, sKey.SK)) !== null;
  }
}

/**
 * REM-2 — the general-purpose version of {@link slideIdleWindow}'s shape, for the
 * other session-row writers CONC-3 left uncovered (the reauth stamp, the
 * multi-device TOTP enrollment offer's mint + clear). Narrowed to an `update`
 * guarded on ONE attribute's captured OLD value — never a whole-row `put` — so a
 * write here can no longer clobber a concurrent mutation to any OTHER field on the
 * same session row, and a revoked (deleted) row cannot be conditioned back into
 * existence (the store's `ifEquals` fails closed against a missing item).
 *
 * `set` may still carry more than one field (an enrollment offer's secret and its
 * timestamp always change together) — `guardAttr`/`guardValue` only need to be ONE
 * of them, since a mismatch on any single field the read captured proves the row
 * moved under this request.
 *
 * DELIBERATELY DOES NOT DECIDE what a lost condition means, unlike
 * `slideIdleWindow` (whose one caller always treats "row present" as "fine, someone
 * else did the work"). The three REM-2 call sites disagree on that: a lost reauth
 * stamp is harmless if the row still exists (a racing tab's fresher stamp is
 * equally valid proof of elevation), a lost enrollment-offer MINT must refuse
 * outright (the secret/QR this call is about to hand back would not be what
 * `confirm` later checks against), and a lost enrollment-offer CLEAR is best-effort
 * (the device it is cleaning up after was already committed via the account's own
 * guarded write). Each caller reads `current` and decides for itself — the same
 * division of labor `resolveSession` already has with `slideIdleWindow`.
 */
export async function putSessionFieldGuarded(
  store: ConfigStore,
  sKey: { PK: string; SK: string },
  guardAttr: string,
  guardValue: unknown,
  set: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; current: SessionItem | null }> {
  try {
    await store.transact([
      { kind: 'update', pk: sKey.PK, sk: sKey.SK, set, ifEquals: { attr: guardAttr, value: guardValue } },
    ]);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ConditionError)) throw e;
    const current = (await store.get(sKey.PK, sKey.SK)) as SessionItem | null;
    return { ok: false, current };
  }
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
