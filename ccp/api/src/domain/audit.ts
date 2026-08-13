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
 * Fold an audit append into the CALLER's domain writes and run ONE transact.
 * Use when the ONLY conditional writes are the domain puts on fresh keys + the
 * chain head (submit, admin apply). A ConditionError retries once against the
 * fresh head, then 409 CHAIN_CONTENTION. Callers that carry their OWN dedupe
 * condition (e.g. approve's ifNotExists) must NOT use this — they need to tell a
 * dedupe failure apart from chain contention.
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
  for (let attempt = 0; attempt < CHAIN_WRITE_ATTEMPTS; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes, newHash, id } = recordIn(projectId, head, entry, opts);
    try {
      await store.transact([...domainWrites, ...writes]);
      return { id, hash: newHash };
    } catch (e) {
      if (e instanceof ConditionError) {
        // Only chain contention is safe to replay. `domainWrites` was computed by the
        // caller from a read it did BEFORE this call, so if one of its own `ifEquals`
        // guards is what failed, the row moved and these writes are stale — replaying
        // them verbatim writes exactly the lost update the guard just prevented (CONC-1
        // showed the same retry doing exactly that in the approve handler). We cannot
        // tell which condition failed, so when the caller carries a value guard we do not
        // guess: refuse and let it re-read.
        //
        // `ifNotExists` on a fresh key is different and still retries — that is what this
        // helper was built for, and if the key now exists it is a genuine duplicate that
        // the second attempt reports correctly.
        if (guarded) throw new ApiError('STATE_CONFLICT');
        if (await chainBackoff(attempt)) continue;
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  throw new ApiError('CHAIN_CONTENTION');
}
