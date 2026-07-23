import type { ConfigStore } from '../store/configStore';
import type { RequestItem } from '../store/schema';
import { requestCollectionGsi } from '../store/schema';
import { rateLimits } from '../domain/config';
import { nowMs } from '../clock';

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
 * Statuses that OCCUPY a maxOpen slot. This is deliberately a DIFFERENT list from
 * requests.ts's OPEN_STATUSES (which gates approve/reject eligibility): a request
 * stops being approvable long before it stops consuming requester quota.
 * `APPROVED_COOLING` (interim quorum met, parked until `earliestApplyAt`)
 * counts — it is approved but NOT yet applied, so without it here a requester could
 * queue unbounded cooling requests. Terminal statuses (`APPLIED`, `REJECTED`,
 * `CANCELLED`) deliberately do NOT count: they release the slot.
 */
const OPEN_STATUSES = new Set(['AWAITING_CODE_REVIEW', 'AWAITING_DEPLOY_APPROVAL', 'CHANGES_REQUESTED', 'NEEDS_ENGINEER', 'APPROVED_COOLING']);

export async function checkSubmitRateLimit(
  store: ConfigStore,
  projectId: string,
  requester: string,
): Promise<{ ok: true } | { ok: false }> {
  const limits = await rateLimits(store, projectId);
  const all = (await store.queryGSI1(requestCollectionGsi(projectId))) as RequestItem[];
  const mine = all.filter((r) => r.requester === requester);

  const hourAgo = nowMs() - 60 * 60 * 1000;
  const inHour = mine.filter((r) => Date.parse(r.createdAt) >= hourAgo).length;
  if (inHour >= limits.submissionsPerHour) return { ok: false };

  const open = mine.filter((r) => OPEN_STATUSES.has(r.status)).length;
  if (open >= limits.maxOpen) return { ok: false };

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
