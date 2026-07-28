import type { ConfigStore } from '../store/configStore';
import type { RequestItem } from '../store/schema';
import { requestCollectionGsi } from '../store/schema';
import { rateLimits } from '../domain/config';
import { nowMs } from '../clock';
import { occupiesQuotaSlot } from '@app-lib/requestStatus';

/**
 * Per-account rate limits: 50 submissions/hour and max 20 open
 * requests per requester, both settings-tunable via SETTING#rate.limits. Over →
 * 429 RATE_LIMITED.
 *
 * Plus the UPLOAD LANE's token bucket (below): `PUT /projects/:id/data` pays a
 * full argon2id verify per attempt, so it is throttled per tokenId BEFORE any
 * hash work — see {@link checkUploadRateLimit}.
 */

/**
 * Does this request still occupy a `maxOpen` slot? ARCH-7 — derived from the ONE closed
 * status vocabulary (`@app-lib/requestStatus`) as *not terminal*, rather than restated
 * here as a hand-maintained list of the open ones.
 *
 * The hand-maintained version enumerated five statuses and the vocabulary grew underneath
 * it: `APPLYING` and both halt statuses arrived with the scheduler, `WINDOW_EXPIRED` with
 * maintenance windows. None was added. Every one of them is non-terminal — mid-apply,
 * waiting on a human, or parked with two exits — and every one silently RELEASED the
 * slot, so a requester could hold unbounded open work simply by letting requests halt or
 * park. That is the "must be hand-audited against a vocabulary that exists nowhere as a
 * closed set" failure the finding names, in its most concrete form.
 *
 * Inverting the list is the fix, not just relocating it: a status added tomorrow occupies
 * a slot until someone decides it should not, instead of being invisible to the limiter
 * until someone notices.
 *
 * Still deliberately DIFFERENT from requests.ts's `OPEN_STATUSES`, which gates
 * approve/reject eligibility — a request stops being approvable long before it stops
 * consuming requester quota.
 */

export async function checkSubmitRateLimit(
  store: ConfigStore,
  projectId: string,
  requester: string,
): Promise<{ ok: true } | { ok: false }> {
  const limits = await rateLimits(store, projectId);

  // A cap of zero admits NOTHING, and must be decided before the walk. `rate.limits`
  // is operator-set JSON with no value schema, so `{submissionsPerHour: 0}` is a
  // reachable way to freeze submissions — and a per-row early exit can never fire
  // for a requester who has no rows to walk. Deciding it here keeps a zero cap
  // fail-CLOSED instead of silently admitting the first submission.
  if (limits.submissionsPerHour <= 0 || limits.maxOpen <= 0) return { ok: false };

  const all = (await store.queryGSI1(requestCollectionGsi(projectId))) as RequestItem[];

  // One pass, two counters, and an early exit the moment either limit is reached.
  // This runs on every submit against the project's WHOLE request history, so the
  // three chained `.filter()`s it replaces were three full traversals plus two
  // intermediate arrays to answer a question that is just "have we hit a cap yet".
  const hourAgo = nowMs() - 60 * 60 * 1000;
  let inHour = 0;
  let open = 0;
  for (const r of all) {
    if (r.requester !== requester) continue;
    if (Date.parse(r.createdAt) >= hourAgo && ++inHour >= limits.submissionsPerHour) return { ok: false };
    if (occupiesQuotaSlot(r.status) && ++open >= limits.maxOpen) return { ok: false };
  }

  return { ok: true };
}

/* ── the upload lane's token bucket (DoS hardening, security review F3) ────── */

/**
 * `PUT /projects/:id/data` verifies its Bearer secret with argon2id (19 MiB
 * memoryCost, timeCost 2) and the tokenId half is semi-public, so a flood of
 * well-formed wrong-secret requests is a CPU/memory saturation vector. This
 * in-memory token bucket runs BEFORE any store read or hash work: a small
 * burst, then a slow refill, per KEY (the tokenId — the expensive path
 * structurally requires one; callers without it fail the cheap shape check and
 * never reach the verifier, so a source-IP fallback key is accepted but only
 * ever needed defensively). Over → 429 RATE_LIMITED with Retry-After.
 *
 * Deliberately in-memory (per process): the cost being defended is THIS
 * process's argon2 work, and a restart forgetting counters merely re-grants
 * one burst. The map is bounded — junk keys (fabricated tokenIds fail the
 * store lookup cheaply but still occupy a bucket) are swept once idle.
 */
export const UPLOAD_RATE_CAPACITY = 10; // burst: max attempts back-to-back
export const UPLOAD_RATE_REFILL_PER_SEC = 1 / 6; // sustained: 10 attempts/minute
const MAX_UPLOAD_BUCKETS = 10_000;

type Bucket = { tokens: number; refilledAtMs: number };
const uploadBuckets = new Map<string, Bucket>();

export function checkUploadRateLimit(
  key: string,
  now: number = nowMs(),
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  let b = uploadBuckets.get(key);
  if (!b) {
    if (uploadBuckets.size >= MAX_UPLOAD_BUCKETS) evictUploadBuckets(now);
    b = { tokens: UPLOAD_RATE_CAPACITY, refilledAtMs: now };
  } else {
    // Refill on read; clamp a backwards clock (tests travel in time) to 0.
    const elapsedMs = Math.max(0, now - b.refilledAtMs);
    b.tokens = Math.min(UPLOAD_RATE_CAPACITY, b.tokens + (elapsedMs / 1000) * UPLOAD_RATE_REFILL_PER_SEC);
    b.refilledAtMs = now;
  }
  // Delete+set keeps Map insertion order ≈ recency, so eviction drops the coldest.
  uploadBuckets.delete(key);
  uploadBuckets.set(key, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true };
  }
  return { ok: false, retryAfterSeconds: Math.ceil((1 - b.tokens) / UPLOAD_RATE_REFILL_PER_SEC) };
}

/** Drop idle (fully refilled) buckets; if none were, drop the coldest tenth —
 * the map must never grow unbounded on attacker-minted junk tokenIds. */
function evictUploadBuckets(now: number): void {
  for (const [k, b] of uploadBuckets) {
    const elapsedMs = Math.max(0, now - b.refilledAtMs);
    if (b.tokens + (elapsedMs / 1000) * UPLOAD_RATE_REFILL_PER_SEC >= UPLOAD_RATE_CAPACITY) uploadBuckets.delete(k);
  }
  if (uploadBuckets.size >= MAX_UPLOAD_BUCKETS) {
    let toDrop = Math.ceil(MAX_UPLOAD_BUCKETS / 10);
    for (const k of uploadBuckets.keys()) {
      if (toDrop-- <= 0) break;
      uploadBuckets.delete(k);
    }
  }
}

/** Test-only: forget every upload bucket (deterministic starts). */
export function __resetUploadRateLimitForTests(): void {
  uploadBuckets.clear();
}
