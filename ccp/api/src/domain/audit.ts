import { createHash } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import type { ConfigStore, TransactWrite } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import type { AuditItem, ChainHeadItem } from '../store/schema';
import { auditKey, chainHead, yyyymm } from '../store/schema';
import { ApiError } from '../errors';
import { nowIso, nowMs } from '../clock';

/**
 * Hash-chained, tamper-evident audit. Every entry links to the previous
 * via `hash = sha256(prevHash + "\n" + canonicalJson(entryWithoutHashFields))`,
 * written in the SAME transaction as the CHAINHEAD conditional update so the chain
 * cannot fork. Per the frozen multi-project keying, the chain is PER-PROJECT
 * (projectId is an explicit arg); projectId is NOT part of the hashed content —
 * the algorithm defines the entry shape without it, and the per-project chain
 * partition + prevHash linkage already prevent cross-chain reuse.
 */

export type AuditEntryInput = {
  action: string;
  actor: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  interimProfile?: boolean;
};

export type RecordOpts = { idFn?: () => string; nowFn?: () => string };

/**
 * MONOTONIC ulid — the audit chain's SK order MUST match creation order (verify
 * walks entries by SK). Plain ulid() can reorder within the same millisecond.
 */
const ulid = monotonicFactory();

/** Crockford base32, the ULID alphabet — a character's index in this string IS its value. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** ULID layout: 10 timestamp characters, then 16 of randomness. */
const ULID_TIME_LEN = 10;
const ULID_LEN = 26;

/**
 * The millisecond timestamp encoded in a ULID's first 10 characters, or `null`
 * when the string is not a well-formed ULID.
 *
 * Every id this system mints for a durable row — audit entries, requests — is a
 * ULID, which means each of those rows already carries its own creation time in
 * its key. Reading it costs no storage, no schema change and no extra row: it is
 * the difference between "when was this written?" being a lookup and being an
 * unanswerable question. Both the audit reader (to find a cursor's month
 * partition without scanning for it) and the retention policy (to age a marker
 * that stores no timestamp of its own) rely on exactly this.
 */
export function ulidTimeMs(id: string): number | null {
  if (id.length !== ULID_LEN) return null;
  let ms = 0;
  // Validate ALL 26 characters, not just the 10 that carry the timestamp. Only the
  // first 10 affect the answer, so stopping there is tempting and wrong: it would
  // accept a string that is not a ULID, hand back a confident timestamp, and let a
  // malformed cursor look like a well-formed one. The callers use this to decide
  // WHERE to look, and "somewhere plausible" is the answer that costs a scan.
  for (let i = 0; i < ULID_LEN; i++) {
    const digit = CROCKFORD.indexOf(id[i]!.toUpperCase());
    if (digit < 0) return null;
    if (i < ULID_TIME_LEN) ms = ms * 32 + digit;
  }
  return Number.isFinite(ms) ? ms : null;
}

/** Recursive key-sorted, no-whitespace JSON. Arrays keep order; only objects sort. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The exact fields the hash covers (excludes PK/SK/GSI/projectId/prevHash/hash; omits undefined). */
export function entryForHash(item: {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  interimProfile?: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    at: item.at,
    actor: item.actor,
    action: item.action,
    targetType: item.targetType,
    targetId: item.targetId,
  };
  if (item.before !== undefined) out.before = item.before;
  if (item.after !== undefined) out.after = item.after;
  if (item.requestId !== undefined) out.requestId = item.requestId;
  if (item.interimProfile !== undefined) out.interimProfile = item.interimProfile;
  return out;
}

/** The hash of an entry given its predecessor's hash (genesis prevHash = ''). */
export function auditEntryHash(prevHash: string, item: Parameters<typeof entryForHash>[0]): string {
  return createHash('sha256')
    .update(`${prevHash}\n${canonicalJson(entryForHash(item))}`)
    .digest('hex');
}

/** The verify-time shape of a chain entry (a superset-tolerant AuditItem projection). */
export type ChainEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  interimProfile?: boolean;
  prevHash: string;
  hash: string;
};

export type VerifyResult = { code: 0 | 1 | 2; badUlid?: string; message: string };

/**
 * Walk entries oldest→newest, recompute every hash + prevHash linkage, and
 * (given a head) compare the tail to the chain head. 0 intact · 1 broken (names
 * the first bad ulid) · 2 head mismatch. Canonical impl — the offline CLI and the
 * admin export endpoint both call THIS, so on-disk and served verdicts can't diverge.
 */
export function verifyChain(entries: ChainEntry[], opts?: { head?: string }): VerifyResult {
  let prevHash = '';
  for (const e of entries) {
    const recomputed = auditEntryHash(prevHash, e);
    if (e.prevHash !== prevHash || e.hash !== recomputed) {
      return { code: 1, badUlid: e.id, message: `chain broken at ${e.id}` };
    }
    prevHash = e.hash;
  }
  if (opts?.head !== undefined && prevHash !== opts.head) {
    return { code: 2, message: `head mismatch: computed ${prevHash || '(empty)'} != ${opts.head}` };
  }
  return { code: 0, message: `ok: ${entries.length} entries intact` };
}

/* ── chain-head contention policy (PERF-11) ───────────────────────────────── */

/**
 * How many times a chain-head CAS may be attempted before the caller is told the
 * write did not land.
 *
 * Every mutation in a project CASes the SAME `CHAINHEAD` row — that is the
 * integrity choice that stops the hash chain forking, and it is not negotiable.
 * What IS negotiable is the budget. Every site used to attempt exactly twice, so
 * a writer that lost two coin-flips surfaced `CHAIN_CONTENTION` (HTTP 409) on an
 * ordinary approve click. With N writers live on one project, one writer wins each
 * round, so the LAST of them needs N attempts to get through: a two-attempt budget
 * starts failing real users at N=3, which the finding measured and this repo's own
 * repro reproduces (4 concurrent appends → 2 × 409).
 *
 * The budget therefore has to exceed the plausible number of concurrent writers on
 * a single project, not the plausible number of collisions. Eight covers a lead, a
 * couple of approvers, the settle loop of someone's `GET /requests`, the scheduler
 * tick and a scanner callback all landing in the same window, with room over.
 *
 * WHAT THIS DELIBERATELY IS NOT: a fix that drops or defers entries under load.
 * The chain is the product's evidence store, so "shed the audit append and keep
 * the domain write" is strictly worse than the 409 it would hide — every retry
 * here replays the FULL transaction (domain writes + audit append) against a
 * freshly read head, or reports failure. Nothing is written without its evidence.
 */
export const CHAIN_WRITE_ATTEMPTS = 8;

/** First back-off ceiling, doubling per lost round up to {@link CHAIN_BACKOFF_CAP_MS}. */
const CHAIN_BACKOFF_BASE_MS = 2;
/** Ceiling on one back-off wait, so a long-lived queue cannot stall a request for seconds. */
const CHAIN_BACKOFF_CAP_MS = 64;

let chainSleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Test hook: replace the back-off wait (pass `null` to restore real timers).
 * Kept local rather than added to `clock.ts` because this is a *delay*, not a
 * reading of the clock — `nowMs()` is frozen by tests that must not also freeze
 * their own back-off into an infinite wait.
 */
export function __setChainSleep(fn: ((ms: number) => Promise<void>) | null): void {
  chainSleep = fn ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
}

/**
 * Wait out one lost chain-head CAS. Returns `true` when another attempt remains
 * (the caller should re-read the head and retry), `false` when the budget is spent
 * (the caller should surface `CHAIN_CONTENTION`).
 *
 * The wait is FULL JITTER — a uniform draw from `[0, ceiling)` rather than the
 * ceiling itself. Fixed back-off re-synchronises the very writers that just
 * collided: they lose together, sleep the same duration, and collide again on the
 * same millisecond. Randomising the whole interval is what actually spreads them,
 * and it is why the budget can be small.
 */
export async function chainBackoff(attempt: number, attempts: number = CHAIN_WRITE_ATTEMPTS): Promise<boolean> {
  if (attempt + 1 >= attempts) return false;
  const ceiling = Math.min(CHAIN_BACKOFF_CAP_MS, CHAIN_BACKOFF_BASE_MS * 2 ** attempt);
  await chainSleep(Math.random() * ceiling);
  return true;
}

function buildAuditItem(
  projectId: string,
  id: string,
  at: string,
  entry: AuditEntryInput,
  prevHash: string,
  hash: string,
): AuditItem {
  return {
    ...auditKey(projectId, yyyymm(new Date(at)), id),
    id,
    projectId,
    at,
    action: entry.action,
    actor: entry.actor,
    targetType: entry.targetType,
    targetId: entry.targetId,
    ...(entry.before !== undefined ? { before: entry.before } : {}),
    ...(entry.after !== undefined ? { after: entry.after } : {}),
    ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
    ...(entry.interimProfile !== undefined ? { interimProfile: entry.interimProfile } : {}),
    prevHash,
    hash,
  };
}

/**
 * Pure variant: fold an audit append (audit put + CHAINHEAD conditional update)
 * into the CALLER's domain transaction. Callers concat `writes` with their own and
 * run ONE transact. `head` is the current CHAINHEAD (or null at genesis).
 */
export function recordIn(
  projectId: string,
  head: ChainHeadItem | null,
  entry: AuditEntryInput,
  opts?: RecordOpts,
): { writes: TransactWrite[]; newHash: string; id: string } {
  const at = (opts?.nowFn ?? (() => nowIso()))();
  // SEED THE ULID FROM THE SAME CLOCK READING AS `at` (PERF-8). The id and the
  // month partition are two encodings of one instant: the partition is
  // `yyyymm(at)`, and the id's leading 10 characters are that same timestamp in
  // Crockford base32. Minting the id from `Date.now()` while stamping `at` from
  // the injected clock made the two disagree by however far a test (or a stepped
  // system clock) had moved time — which is exactly the invariant the paged read
  // now relies on to find a cursor's partition without scanning for it. Same
  // reading for both, so `monthOfAuditId(id)` is the partition, by construction.
  const atMs = Date.parse(at);
  const seed = Number.isFinite(atMs) ? atMs : nowMs();
  const id = (opts?.idFn ?? (() => ulid(seed)))();
  const prevHash = head?.hash ?? '';
  const count = head?.count ?? 0;
  const hash = auditEntryHash(prevHash, { id, at, ...entry });
  const auditItem = buildAuditItem(projectId, id, at, entry, prevHash, hash);
  const hKey = chainHead(projectId);
  const headWrite: TransactWrite = head
    ? { kind: 'update', pk: hKey.PK, sk: hKey.SK, set: { hash, lastUlid: id, count: count + 1 }, ifEquals: { attr: 'hash', value: prevHash } }
    : { kind: 'put', item: { ...hKey, hash, lastUlid: id, count: 1 } satisfies ChainHeadItem, ifNotExists: true };
  return { writes: [{ kind: 'put', item: auditItem, ifNotExists: true }, headWrite], newHash: hash, id };
}

/**
 * Standalone append (login and other single-mutation callers). Reads CHAINHEAD,
 * appends in one transact; a chain-contention ConditionError re-reads the head and
 * retries within {@link CHAIN_WRITE_ATTEMPTS}, then throws 409 CHAIN_CONTENTION.
 * Signature is unchanged from the Task-4 placeholder.
 */
export async function record(
  store: ConfigStore,
  projectId: string,
  entry: AuditEntryInput,
  opts?: RecordOpts,
): Promise<{ id: string; hash: string }> {
  const hKey = chainHead(projectId);
  for (let attempt = 0; attempt < CHAIN_WRITE_ATTEMPTS; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes, newHash, id } = recordIn(projectId, head, entry, opts);
    try {
      await store.transact(writes);
      return { id, hash: newHash };
    } catch (e) {
      if (e instanceof ConditionError) {
        // The whole append is recomputed against the FRESH head on the next pass —
        // a lost round replays nothing stale, so retrying is safe here for as long
        // as the budget allows.
        if (await chainBackoff(attempt)) continue;
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  // unreachable
  throw new ApiError('CHAIN_CONTENTION');
}

/**
 * Thrown by {@link transactWithAudit} when the CALLER's OWN domain condition — not the
 * audit chain head — is what refused the batch (CONC-15 / API-14 / R-10).
 *
 * The store reports a refused batch as one undifferentiated `ConditionError`: it says the
 * transaction did not apply, never by which condition. This helper used to guess from the
 * SHAPE of the domain writes — a value guard meant `STATE_CONFLICT`, anything else meant
 * `CHAIN_CONTENTION` — and the guess was wrong in both directions. A caller whose
 * `ifNotExists` genuinely collided (a duplicate username, a lost version-row race) was
 * told "the audit chain is busy; please retry" about something no retry can fix, and a
 * value-guarded caller that merely lost the chain head was told its state was stale when
 * it was not.
 *
 * `failed` is the caller's write whose condition is false against the store, so a caller
 * carrying several conditional writes can map the domain-accurate 409 for the one that
 * actually lost (`DUPLICATE_USERNAME`, `DUPLICATE_TEAM`, `INSTANCE_STALE`, …). The code
 * is `STATE_CONFLICT` for callers that do not care to distinguish — "conflicting state,
 * re-read" is at least true of every domain-condition failure, which "chain busy" never
 * was.
 */
export class DomainConditionError extends ApiError {
  constructor(public readonly failed: TransactWrite) {
    super('STATE_CONFLICT');
    this.name = 'DomainConditionError';
  }
}

/** Every key on a `TransactWrite` that names a CONDITION, derived FROM the union rather
 *  than listed — see `_everyConditionIsEvaluated` below. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ConditionKey = Extract<KeysOfUnion<TransactWrite>, `if${string}`>;

/**
 * Compile-time exhaustiveness for {@link failedDomainCondition}: `ifNotExists` and
 * `ifEquals` are ALL the condition primitives the store seam has. Add a third to
 * `TransactWrite` and this line stops compiling until the evaluator below is taught it —
 * because the failure mode of forgetting is silent (an unevaluated condition reads as
 * "still holds", and its failure gets reported as chain contention all over again, which
 * is the exact defect this file just fixed).
 */
type _EveryConditionIsEvaluated = Exclude<ConditionKey, 'ifNotExists' | 'ifEquals'> extends never ? true : never;
const _everyConditionIsEvaluated: _EveryConditionIsEvaluated = true;

/**
 * Which of the CALLER's own conditions is false against the store RIGHT NOW — or `null`
 * if every one of them still holds, which leaves the chain head as the only thing that
 * can have refused the batch.
 *
 * Mirrors `ConfigStore.transact`'s phase-1 evaluation exactly, INCLUDING its fail-closed
 * rule for an `ifEquals` against a missing item (a guarded write must never resurrect a
 * deleted row). This is the check `ackPending` hand-rolls at the one call site that could
 * not live with the guess; making it general is what closes CONC-15 for the rest.
 *
 * It is a re-read AFTER the fact, so it is a diagnosis and not a proof: state can move
 * again between the refused transact and this walk. That only ever costs precision in the
 * direction of "looks like chain contention", which is the retryable answer, and the
 * caller re-reads either way.
 */
async function failedDomainCondition(store: ConfigStore, writes: TransactWrite[]): Promise<TransactWrite | null> {
  for (const w of writes) {
    const pk = w.kind === 'put' ? w.item.PK : w.pk;
    const sk = w.kind === 'put' ? w.item.SK : w.sk;
    const ifNotExists = w.kind === 'put' && w.ifNotExists === true;
    if (!ifNotExists && w.ifEquals === undefined) continue; // unconditional — cannot be the refusal
    const cur = await store.get(pk, sk);
    if (ifNotExists && cur !== null) return w;
    if (w.ifEquals !== undefined && (cur === null || cur[w.ifEquals.attr] !== w.ifEquals.value)) return w;
  }
  return null;
}

/**
 * Fold an audit append into the CALLER's domain writes and run ONE transact.
 *
 * On a refused batch the helper asks the store WHICH condition failed instead of guessing
 * from the write shapes (CONC-15): a caller's own failed condition becomes a
 * {@link DomainConditionError} carrying that write, and only a genuinely moved chain head
 * is reported as `CHAIN_CONTENTION`. So the docstring's old warning — "callers that carry
 * their OWN dedupe condition must NOT use this" — no longer holds, which matters because
 * scanJobs, settlement, drift staging, enroll and team-create all used it anyway, each
 * with local compensation of varying completeness.
 *
 * What has NOT changed, and must not: a domain write is never REPLAYED. `domainWrites`
 * was computed by the caller from a read it did BEFORE this call, so replaying a value-
 * guarded write verbatim writes exactly the lost update the guard just prevented (CONC-1
 * showed the same retry doing that in the approve handler; CONC-9's pending-change CAS
 * leans on the refusal). Only the unguarded `ifNotExists`-on-a-fresh-key shape — what
 * this helper was originally built for — is replayed against a fresh head.
 */
export async function transactWithAudit(
  store: ConfigStore,
  projectId: string,
  domainWrites: TransactWrite[],
  entry: AuditEntryInput,
  opts?: RecordOpts,
): Promise<{ id: string; hash: string }> {
  const hKey = chainHead(projectId);
  const guarded = domainWrites.some((w) => 'ifEquals' in w && w.ifEquals !== undefined);
  // PERF-11: the wider, shared chain-write budget with full-jitter backoff (below) — CONC-15's
  // diagnostic (failedDomainCondition) still decides case-by-case whether a given attempt is
  // safe to retry at all; this only widens how many times it gets to ask.
  for (let attempt = 0; attempt < CHAIN_WRITE_ATTEMPTS; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes, newHash, id } = recordIn(projectId, head, entry, opts);
    try {
      await store.transact([...domainWrites, ...writes]);
      return { id, hash: newHash };
    } catch (e) {
      if (e instanceof ConditionError) {
        const failed = await failedDomainCondition(store, domainWrites);
        // The caller's own condition lost. Permanent for these writes: no retry of THIS
        // batch can succeed, and the caller — not this helper — knows what the collision
        // means in its domain.
        if (failed !== null) throw new DomainConditionError(failed);
        // Every domain condition still holds, so the chain head is what moved. Transient,
        // and the caller may sensibly retry — but we can only replay the writes ourselves
        // when none of them carries a value guard: `domainWrites` was computed by the
        // caller from a read it did BEFORE this call, and replaying a value-guarded write
        // verbatim against a fresh head writes exactly the lost update the guard just
        // prevented (CONC-1 showed the same retry doing exactly that in the approve
        // handler). `ifNotExists` on a fresh key is different and safe to replay — that is
        // what this helper was originally built for.
        if (guarded) throw new ApiError('CHAIN_CONTENTION');
        if (await chainBackoff(attempt)) continue;
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  throw new ApiError('CHAIN_CONTENTION');
}
