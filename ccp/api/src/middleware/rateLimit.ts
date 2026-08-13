import type { ConfigStore, Item, TransactWrite } from '../store/configStore';
import type { Key, RequestItem } from '../store/schema';
import {
  SUBMIT_QUOTA_SK_PREFIX,
  requestCollectionGsi,
  requestKey,
  submitQuotaKey,
  submitQuotaMarkerKey,
  submitQuotaPk,
} from '../store/schema';
import { rateLimits } from '../domain/config';
import { nowIso, nowMs } from '../clock';
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

/**
 * The per-(project, requester) SUBMIT GATE row. It holds one attribute, `seq`, and its
 * only job is to be the thing a concurrent submit by the same requester collides on
 * (CONC-12) — see the gate-bump write in {@link checkSubmitRateLimit}. Deliberately NOT
 * in `store/schema.ts` and NOT on any GSI: it is a limiter implementation detail with no
 * domain meaning, invisible to every collection query, and there is exactly one per
 * account per project, so it cannot grow with traffic.
 */
export function submitGateKey(projectId: string, requester: string): Key {
  return { PK: `P#${projectId}#SUBMITGATE#${requester}`, SK: 'META' };
}

/**
 * One pointer row in a requester's submit-quota partition
 * ({@link submitQuotaKey}). Deliberately tiny — the whole point of the index is
 * that reading it does not drag full request rows through a deep clone.
 */
export type SubmitQuotaPointer = Item & {
  requestId: string;
  /** The request's `createdAt`, copied so the hourly window needs no row read. */
  createdAt: string;
};

/**
 * What the caller must persist for the admitted submit, atomically WITH the
 * request row it is about to create.
 *
 * Returning writes rather than performing them is the load-bearing part. The
 * pointer has to land in the SAME transact as the request, or the two can
 * disagree: a separately-committed pointer can exist for a request that was
 * never created (over-counts, and the requester is locked out of a slot they
 * never used), and a request can exist with no pointer (under-counts — a
 * limiter that silently stops limiting, which is the failure that matters).
 * Making it one transact removes the window entirely rather than narrowing it.
 *
 * It also keeps the durable path honest: FileStore snapshots the whole store per
 * applied mutation, so a second write here would have doubled the cost of every
 * submit to save a scan.
 */
export type SubmitAdmission =
  | { ok: false }
  | {
      ok: true;
      /** Splice into the submit's existing transact — never commit separately. */
      writes: TransactWrite[];
    };

/**
 * PERF-10 — this used to read the project's ENTIRE request collection on every
 * submit (`queryGSI1(requestCollectionGsi)`), which clones every row in full,
 * to count the handful belonging to one requester. Measured: 0.009 ms with no
 * history, 28 ms at 5,000 requests, and the curve is the project's whole
 * lifetime history because nothing is ever removed from it.
 *
 * Now it reads the requester's OWN quota partition, and the request rows it
 * still has to open are bounded by `maxOpen` rather than by history — a pointer
 * whose request has gone terminal is deleted as it is discovered (settle-on-read,
 * the shape already used for scan-job leases, apply claims and bundle claims),
 * so the partition converges on "this requester's open work plus their last
 * hour" no matter how much history the project accumulates.
 *
 * Terminal is FOREVER — `occupiesQuotaSlot` is the complement of
 * `TERMINAL_STATUSES`, and no route moves a row out of one — so pruning a
 * terminal pointer can never lose a slot that later comes back. A `WINDOW_EXPIRED`
 * or halted row is NOT terminal and keeps both its pointer and its slot.
 *
 * `requestId` is the id the caller is ABOUT to create, so admission and the
 * request are one atomic fact; see {@link SubmitAdmission}.
 *
 * CONC-12 — counting the index and deciding admission is still read-then-write on
 * its own; what makes the WHOLE call atomic is the gate row bumped below, included
 * in the SAME `writes` batch as the pointer. The caller MUST re-invoke this function
 * fresh on every retry attempt (never reuse a prior call's `writes`) — see the gate
 * write's own doc comment for why, and `routes/requests.ts`'s submit loop for the
 * caller-side half of the contract.
 */
export async function checkSubmitRateLimit(
  store: ConfigStore,
  projectId: string,
  requester: string,
  requestId: string,
): Promise<SubmitAdmission> {
  const limits = await rateLimits(store, projectId);

  // A cap of zero admits NOTHING, and must be decided before the walk. `rate.limits`
  // is operator-set JSON with no value schema, so `{submissionsPerHour: 0}` is a
  // reachable way to freeze submissions — and a per-row early exit can never fire
  // for a requester who has no rows to walk. Deciding it here keeps a zero cap
  // fail-CLOSED instead of silently admitting the first submission.
  if (limits.submissionsPerHour <= 0 || limits.maxOpen <= 0) return { ok: false };

  // CONC-12: the gate is read before the index walk, same ordering discipline the
  // full-scan design this replaced used — every read this call makes must be fresh
  // for THIS attempt, because the gate-bump write below is guarded on this exact
  // `seq` and the caller re-invokes this whole function on every retry.
  const gk = submitGateKey(projectId, requester);
  const gate = (await store.get(gk.PK, gk.SK)) as { seq?: number } | null;

  const marker = submitQuotaMarkerKey(projectId, requester);
  const materialized = (await store.get(marker.PK, marker.SK)) !== null;

  const { candidates, backfill } = materialized
    ? { candidates: await readPointers(store, projectId, requester), backfill: [] as TransactWrite[] }
    : await materialize(store, projectId, requester);

  const hourAgo = nowMs() - 60 * 60 * 1000;
  let inHour = 0;
  let open = 0;
  const prune: TransactWrite[] = [];

  // Newest first: both caps are about recent work, so the entries that decide the
  // answer are at this end and the early exits fire without walking the rest.
  for (const cand of candidates) {
    const recent = Date.parse(cand.createdAt) >= hourAgo;
    // The hourly window is answered from the pointer alone — no request row is
    // opened for it, and it counts REGARDLESS of status: a request submitted and
    // immediately cancelled still consumed a submission.
    if (recent && ++inHour >= limits.submissionsPerHour) return { ok: false };

    // `status` is already in hand on the materialization path; on the steady-state
    // path it costs one point read of a single row, and only for entries that are
    // still candidates. This is the only place a full request row is opened, and
    // the loop exits at `maxOpen`, so it is bounded by the CAP and not by history.
    let status = cand.status;
    if (status === undefined) {
      const k = requestKey(projectId, cand.requestId);
      status = ((await store.get(k.PK, k.SK)) as RequestItem | null)?.status;
    }
    const holdsSlot = status !== undefined && occupiesQuotaSlot(status);

    // Prune only what can never matter again: outside the hourly window AND not
    // holding a slot. Terminal is forever (`occupiesQuotaSlot` is the complement
    // of TERMINAL_STATUSES and no route moves a row back out), so a pruned entry
    // cannot come back — but a terminal request inside the window still counts
    // toward `submissionsPerHour`, and dropping it there would under-count.
    if (!recent && !holdsSlot && cand.sk !== undefined) {
      prune.push({ kind: 'delete', pk: submitQuotaPk(projectId, requester), sk: cand.sk });
      continue;
    }
    if (holdsSlot && ++open >= limits.maxOpen) return { ok: false };
  }

  const pointer: SubmitQuotaPointer = {
    ...submitQuotaKey(projectId, requester, requestId),
    requestId,
    createdAt: nowIso(),
  };
  // CONC-12 — this is what makes the admission decision atomic, not just the index
  // fast. Two concurrent submits by the same requester can both read the same
  // candidates/gate snapshot and both compute "admit" here — their pointer writes
  // use DIFFERENT keys (this requester's two different requestIds) and so cannot
  // collide with each other directly, which is exactly the check-then-insert gap
  // the finding names. Guarding this write on the `seq` read above closes it: only
  // one of the two transacts can win the CAS, and TransactWrite items commit
  // all-or-nothing, so the loser's pointer write is rolled back with it — the
  // caller sees a plain ConditionError and must re-invoke this function fresh
  // (never reuse a prior attempt's admission), which re-counts against the
  // now-updated index and correctly refuses if the winner filled the last slot.
  // `ifNotExists` on a requester's first-ever submit; `ifEquals` on every one after.
  const gateWrite: TransactWrite =
    gate === null
      ? { kind: 'put', item: { ...gk, seq: 1 }, ifNotExists: true }
      : { kind: 'update', pk: gk.PK, sk: gk.SK, set: { seq: (gate.seq ?? 0) + 1 }, ifEquals: { attr: 'seq', value: gate.seq } };
  // The prunes and the backfill ride along with the admission. Both are pure index
  // maintenance over facts that are already settled, so they carry no conditions
  // and losing them (a refused submit, a lost contention retry) costs nothing but
  // repeating the work on the next attempt.
  return {
    ok: true,
    writes: [...backfill, ...prune, { kind: 'put', item: pointer, ifNotExists: true }, gateWrite],
  };
}

/** One entry the caps are counted over, from either source. */
type Candidate = {
  requestId: string;
  createdAt: string;
  /** The pointer row's SK — absent for a candidate read straight from a request row. */
  sk?: string;
  /** Known upfront on the materialization path; read lazily otherwise. */
  status?: string;
};

/** Steady state: the requester's own partition, newest first. */
async function readPointers(store: ConfigStore, projectId: string, requester: string): Promise<Candidate[]> {
  const rows = (await store.query(submitQuotaPk(projectId, requester), SUBMIT_QUOTA_SK_PREFIX, {
    forward: false,
  })) as SubmitQuotaPointer[];
  return rows.map((p) => ({ requestId: p.requestId, createdAt: p.createdAt, sk: p.SK }));
}

/**
 * Once per requester, ever: build the index from the request collection that
 * already exists.
 *
 * This is the old full scan, and it is deliberately still here — on an existing
 * deployment every request predates the index, and an index that cannot tell
 * "nothing indexed yet" from "nothing open" would silently stop enforcing
 * `maxOpen` for exactly the requesters who already had open work. Paying one
 * scan per requester buys the guarantee; every later submit reads the partition.
 *
 * Only entries that can still matter are written: anything holding a quota slot,
 * plus anything inside the hourly window whatever its status.
 */
async function materialize(
  store: ConfigStore,
  projectId: string,
  requester: string,
): Promise<{ candidates: Candidate[]; backfill: TransactWrite[] }> {
  const all = (await store.queryGSI1(requestCollectionGsi(projectId))) as RequestItem[];
  const hourAgo = nowMs() - 60 * 60 * 1000;
  const candidates: Candidate[] = [];
  const backfill: TransactWrite[] = [];
  for (const r of all) {
    if (r.requester !== requester) continue;
    if (!occupiesQuotaSlot(r.status) && Date.parse(r.createdAt) < hourAgo) continue;
    const key = submitQuotaKey(projectId, requester, r.requestUlid || r.id);
    candidates.push({ requestId: r.id, createdAt: r.createdAt, sk: key.SK, status: r.status });
    const pointer: SubmitQuotaPointer = { ...key, requestId: r.id, createdAt: r.createdAt };
    // Unconditional: two concurrent submits by the same requester both
    // materialize, and writing the same pointer twice must not abort either
    // transact. Same value both times, so the result is identical either way.
    backfill.push({ kind: 'put', item: pointer });
  }
  // GSI1SK order is the request ulid, so the collection arrives oldest-first;
  // the counting loop wants newest-first like the pointer read gives it.
  candidates.reverse();
  backfill.push({ kind: 'put', item: { ...submitQuotaMarkerKey(projectId, requester), materializedAt: nowIso() } });
  return { candidates, backfill };
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
