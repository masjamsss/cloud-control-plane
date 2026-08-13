import type { ConfigStore } from '../store/configStore';
import type { SessionItem } from '../store/schema';
import { sessionUserGsi } from '../store/schema';
import { IDLE_MS } from '../auth/sessions';
import { ulidTimeMs } from './audit';

/**
 * THE RETENTION POLICY (PERF-7).
 *
 * Nothing in this store was ever purged: sessions, submit idempotency markers and
 * the audit chain all grew forever. "Add a cleanup job" is the wrong framing —
 * retention in a governance product is a POLICY question whose answer differs per
 * class of data, and answering it silently in a sweep function is how an evidence
 * store loses evidence. So the policy is stated here, once, in the code that
 * enforces it, and each class gets the answer that class actually warrants.
 *
 * ── Sessions: DELETE ONCE UNRESOLVABLE ────────────────────────────────────────
 * A session row carries `absoluteExpiresAt` and an idle window. Past either, no
 * code path in this system can ever resolve it again — `resolveSession` rejects
 * it and `listLiveSessions` already hides it. The row is therefore pure residue,
 * and deleting it removes NO information anyone can act on. It is also not
 * evidence: the audit chain records the login that minted the session, and that
 * entry is permanent (below). Sweeping is per-user and opportunistic, on mint.
 *
 * ── Idempotency markers: AGE OUT AFTER THE CLIENT RETRY HORIZON ───────────────
 * A `requestIdempotencyKey` marker exists to make a resubmit of the SAME client
 * key resolve to the first request instead of creating a duplicate. Its whole
 * purpose is to outlive a client's retry, which is a horizon measured in minutes
 * to days — not in years. Keeping it forever does not make submits safer; it makes
 * an idempotency key permanently unusable, which is its own defect (API-15 is the
 * dangling-marker sibling of this). Seven days is far beyond any retry any client
 * of this API performs, and short enough that the row set stays bounded.
 *
 * ── The audit chain: PERMANENT. NOT PRUNED. NOT ARCHIVED-AND-TRUNCATED. ───────
 * This is a product decision, and it is the one this file exists to write down.
 *
 * The options were:
 *
 *   (a) time-based retention — drop entries older than N months;
 *   (b) count-based retention — keep the newest N entries per project;
 *   (c) archive-then-prune — export a verifiable document, then truncate the live
 *       chain to an anchor entry, as the finding's own recommendation suggests;
 *   (d) NO retention — the chain is append-only and permanent, by design.
 *
 * The answer is (d), and the reasoning is not "it is easiest". This product's
 * pitch is a tamper-evident record of who approved what change to which estate.
 * Under (a) or (b) the answer to "who approved this?" becomes "that depends how
 * busy the estate has been since", which is not an answer a compliance reader can
 * use — and the deletion is UNAUDITABLE by construction, because the only place it
 * could be recorded is the thing being deleted.
 *
 * (c) is the serious alternative and it is still wrong here, for a reason worth
 * stating: truncating to an anchor keeps the chain VERIFIABLE but no longer
 * SELF-CONTAINED. Verification then depends on an exported file living somewhere
 * outside the system's own integrity guarantees — and the moment the evidence of
 * record is "this database plus a JSON file someone hopefully still has", the
 * tamper-evidence argument is gone. A hash chain whose prefix is off-site is a
 * hash chain you cannot check.
 *
 * The cost of (d) is growth, and growth is exactly what the rest of this batch
 * removed the sting from: the chain is no longer re-serialized per request
 * (PERF-1), no longer re-hashed per readiness probe (PERF-4), and no longer
 * materialized per admin page (PERF-8). Chain SIZE no longer drives per-request
 * cost, so "keep everything" stops being the expensive answer and is simply the
 * correct one. What remains is disk, which is the cheapest thing a governance
 * product can spend to keep its promise.
 *
 * Operators who must delete audit history (a legal erasure order, say) have
 * `GET /admin/audit/export` for the evidence and the store file itself for the
 * deletion — a deliberate, manual, out-of-band act, which is the correct shape
 * for something that breaks a tamper-evidence guarantee on purpose.
 *
 * {@link AUDIT_CHAIN_RETENTION} states this as a value so it can be asserted
 * rather than merely believed, and `retention.test.ts` pins the property: the
 * chain is untouched by every sweep in this file.
 */

/** How long a submit idempotency marker stays authoritative. */
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The audit chain's retention policy, as a value. `'permanent'` is the whole
 * statement: no sweep in this codebase may delete an audit entry or the chain
 * head. See the block comment above for why this is (d) and not (c).
 */
export const AUDIT_CHAIN_RETENTION = 'permanent' as const;

/**
 * Can `s` still be resolved into an authenticated request as of `now`?
 *
 * Mirrors `resolveSession`'s own two time checks EXACTLY — same comparisons, same
 * boundary directions. That equivalence is the safety argument for deleting the
 * row: the sweep may only remove sessions that the resolver would refuse anyway,
 * so sweeping can never log anyone out. It deliberately does NOT consider
 * `sessionVersion` or account status, which would make retention depend on a
 * second row and could delete a session that a version rollback would revive.
 */
export function sessionUnresolvable(s: SessionItem, now: number): boolean {
  return now > Date.parse(s.absoluteExpiresAt) || now - Date.parse(s.lastSeenAt) > IDLE_MS;
}

/**
 * Delete `userId`'s sessions that can no longer be resolved. Returns the count.
 *
 * Scoped to ONE user's GSI partition, so it costs that user's session count and
 * never a table scan — which is what makes it safe to run opportunistically on
 * every mint rather than needing a timer nobody arms. A user who closes the tab
 * leaves a dead row behind; their next login clears it.
 */
export async function sweepUserSessions(store: ConfigStore, userId: string, now: number): Promise<number> {
  const rows = (await store.queryGSI1(sessionUserGsi(userId))) as SessionItem[];
  let swept = 0;
  for (const s of rows) {
    if (!sessionUnresolvable(s, now)) continue;
    await store.delete(s.PK, s.SK);
    swept++;
  }
  return swept;
}

/**
 * Has this marker outlived the retry horizon as of `now`?
 *
 * The marker stores no timestamp of its own — but it stores the `requestId` it
 * resolves to, and that is a ULID, which carries its creation millisecond in its
 * first 10 characters. So the age is derivable from what is already written, with
 * no schema change and no migration for markers already on disk. A marker whose
 * `requestId` is missing or unparseable is treated as NOT expired: failing closed
 * here means an unreadable marker keeps deduplicating submits, which is the safe
 * direction — the unsafe direction creates a duplicate change request.
 */
export function idempotencyMarkerExpired(marker: Record<string, unknown>, now: number): boolean {
  if (typeof marker.requestId !== 'string') return false;
  const mintedMs = ulidTimeMs(marker.requestId);
  if (mintedMs === null) return false;
  return now - mintedMs > IDEMPOTENCY_RETENTION_MS;
}

/**
 * Read a submit idempotency marker, enforcing its retention horizon on the way
 * past: an expired marker is deleted and reported as absent.
 *
 * Settle-on-read rather than a sweep, because the markers are keyed by
 * `(project, actor, client key)` with no collection partition — enumerating them
 * would need the full-store scan this whole finding is about avoiding. Reading is
 * also the only moment the answer matters: a marker nobody reads again has no
 * behaviour to get wrong, only bytes, and those go with the DynamoDB `ttl`
 * attribute on the deployed path.
 */
export async function readLiveIdempotencyMarker(
  store: ConfigStore,
  key: { PK: string; SK: string },
  now: number,
): Promise<Record<string, unknown> | null> {
  const marker = await store.get(key.PK, key.SK);
  if (!marker) return null;
  if (!idempotencyMarkerExpired(marker, now)) return marker;
  await store.delete(key.PK, key.SK);
  return null;
}
