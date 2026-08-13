/**
 * The store seam. One in-memory implementation today (MemoryStore); a DynamoDB
 * implementation lands in a later AWS-gated plan behind this SAME interface.
 * `transact` mirrors DynamoDB `TransactWriteItems`: all-or-nothing, with every
 * condition evaluated against the pre-transaction snapshot (a failed condition
 * aborts the WHOLE batch). This is what makes the audit chain and approval dedupe
 * byte-for-byte identical between local and deployed.
 */

export type Item = { PK: string; SK: string; GSI1PK?: string; GSI1SK?: string } & Record<string, unknown>;

/** Thrown when a conditional write (ifNotExists / ifEquals) fails — aborts the batch. */
export class ConditionError extends Error {
  constructor(message = 'Condition check failed') {
    super(message);
    this.name = 'ConditionError';
  }
}

/**
 * Thrown when a write is not REPRESENTABLE on the backend this seam mirrors —
 * DynamoDB would reject it (or index it differently), so the local store must too.
 *
 * API-17 / DATA-14: the seam's whole value is that a test passing locally predicts
 * production. Every behaviour this error guards was previously accepted here and
 * would have failed — or silently differed — against DynamoDB, which makes the local
 * pass a lie rather than evidence. It is deliberately NOT a {@link ConditionError}:
 * a condition failure means this write lost a race and the caller may retry, while
 * this means the caller built a write that no backend will ever accept. Retrying it
 * is pointless, so it must reach the operator as a 500/crash, not a 409.
 */
export class SeamViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeamViolationError';
  }
}

/**
 * DynamoDB `TransactWriteItems` accepts at most 100 actions per call, and this store
 * mirrors that bound so a batch that grows past it fails HERE — in a local test — and
 * not on the first deployed call (DATA-14 (1)). Every batch in this codebase is a
 * handful of writes; a loop that starts appending to one is the shape this catches.
 */
export const MAX_TRANSACT_WRITES = 100;

/**
 * The one character a PK or SK may never contain (DATA-15).
 *
 * The in-memory store keys its maps and its GSI by the composite string
 * `PK + KEY_SEPARATOR + SK`, and that encoding is unambiguous only while no key can
 * contain the separator itself. DynamoDB keys are native tuples and would never
 * alias, so an aliasing pair here is BOTH a corruption (two distinct rows sharing one
 * slot, last write silently winning) and a seam divergence. The invariant used to be
 * a comment; it is now enforced at every write, because `idempotencyKey` puts up to
 * 200 client-chosen bytes into a PK and "no key contains this byte" is not a property
 * a client can be trusted to preserve.
 */
export const KEY_SEPARATOR = '\u0000';

/**
 * Reject a key component DynamoDB would reject, or that this store cannot encode
 * unambiguously. Called on every write path (never on reads — a read with a bad key
 * simply misses, and refusing to answer it would help nobody).
 *
 * - empty string: DynamoDB rejects an empty partition/sort key value outright.
 * - non-string: the `Item` type says string; a row keyed `undefined` used to store
 *   itself under the literal composite `"undefined\0undefined"` (DATA-5).
 * - contains {@link KEY_SEPARATOR}: see above.
 */
export function assertStorableKey(pk: unknown, sk: unknown, where: string): void {
  for (const [name, v] of [
    ['PK', pk],
    ['SK', sk],
  ] as const) {
    if (typeof v !== 'string') {
      throw new SeamViolationError(`${where}: ${name} must be a string, got ${v === null ? 'null' : typeof v}`);
    }
    if (v.length === 0) {
      throw new SeamViolationError(`${where}: ${name} must not be empty (DynamoDB rejects an empty key value)`);
    }
    if (v.includes(KEY_SEPARATOR)) {
      throw new SeamViolationError(
        `${where}: ${name} contains the reserved composite-key separator (U+0000) — two distinct rows could alias onto one stored key. Offending ${name}: ${JSON.stringify(v)}`,
      );
    }
  }
}

/**
 * A conditional-write guard, and the exact ConditionExpression a backend adapter owes it
 * (API-17 / DATA-14 (2)). Two things here are conventions rather than plain equality, and
 * both are now part of the CONTRACT instead of being facts about one implementation:
 *
 * 1. **Comparison is by VALUE, structurally.** `ifEquals: { attr: 'roles', value: {...} }`
 *    holds when the stored attribute is deeply equal to the captured one. The store used
 *    to compare with `!==`, which is reference identity for objects and arrays — and every
 *    item handed to a caller is a CLONE, so the first guard on a map or list would have
 *    been a condition that could never pass. DynamoDB's `=` compares the attribute value,
 *    so structural equality is the faithful reading, not a convenience.
 * 2. **`value: undefined` means "the attribute is absent".** DynamoDB cannot express
 *    `attr = undefined`; an adapter MUST translate this guard to
 *    `attribute_not_exists(<attr>) AND attribute_exists(PK)`. The second half is not
 *    decoration: `attribute_not_exists` alone SUCCEEDS against a missing item (and an
 *    Update would then create it), whereas this seam fails a guard against a missing item
 *    on purpose — a deleted row must never be conditioned back into existence (CONC-1,
 *    and the session-revoke race in `auth/sessions.ts`).
 */
export type WriteGuard = { attr: string; value: unknown };

export type TransactWrite =
  /**
   * `ifEquals` guards a whole-row put the same way it guards an update: the write lands
   * only if the named attribute still holds the captured value. DynamoDB's transactional
   * `Put` takes a ConditionExpression, so this is the seam being faithful rather than
   * generous — without it, "read, compute a new row, write it back" had no way to say
   * "…only if nobody moved it", and the read-modify-write races in CONC-1/2/3/14 and
   * DATA-1 had no primitive to fix them with.
   */
  | { kind: 'put'; item: Item; ifNotExists?: boolean; ifEquals?: WriteGuard }
  | {
      kind: 'update';
      pk: string;
      sk: string;
      /**
       * Attributes to write. Every value must be DEFINED: DynamoDB's `SET` has no way to
       * assign "nothing", so `set: { GSI1PK: undefined }` — the idiom this codebase used
       * to drop a row out of the index — is a `ValidationException` there, not a removal
       * (DATA-14 (3)). Use {@link remove} for that; passing `undefined` here throws
       * {@link SeamViolationError}, which also catches the accidental case where an
       * optional variable is `undefined` and the write silently persists nothing.
       */
      set: Record<string, unknown>;
      /** Attributes to delete from the row — DynamoDB `REMOVE`. Clearing `GSI1PK` this
       *  way is what takes a row OUT of GSI1 (dual-control ack/reject/expire). */
      remove?: string[];
      ifEquals?: WriteGuard;
    }
  | { kind: 'delete'; pk: string; sk: string; ifEquals?: WriteGuard };

/**
 * The two DynamoDB `Query` parameters this codebase needs, spelled the way
 * DynamoDB spells them. Both are optional, so every existing call site keeps its
 * exact behaviour (all matching items, SK-ascending).
 *
 * They exist because a reader that only wants the newest page of a partition
 * should not have to materialize the whole partition to get it — which is what
 * the audit reader was doing to serve a 50-row page of a chain with thousands of
 * entries. `ScanIndexForward: false` + `Limit` is how DynamoDB answers that, and
 * modelling it here keeps the seam honest: the local store cannot make a read
 * look cheap that the real table would charge for.
 */
export type QueryOptions = {
  /** Stop after this many items (DynamoDB `Limit`). */
  limit?: number;
  /** SK-ascending (default, DynamoDB `ScanIndexForward: true`) or descending. */
  forward?: boolean;
  /**
   * Resume STRICTLY AFTER this sort-key value, in whichever direction `forward`
   * selects — the seam's spelling of DynamoDB `ExclusiveStartKey`, reduced to the
   * one component that varies within a partition. This is what lets a paged
   * endpoint fetch page N without re-reading pages 1..N-1.
   */
  after?: string;
};

export interface ConfigStore {
  get(pk: string, sk: string): Promise<Item | null>;
  /**
   * Put an item; with `{ ifNotExists: true }` throws ConditionError if the key exists,
   * with `{ ifEquals }` only if the named attribute still holds the captured value.
   * The guard is what makes a read-modify-write safe outside a transaction — see CONC-3,
   * where a login's blind put of a stale account row could restore `status:'active'`
   * over an admin's disable.
   */
  put(
    item: Item,
    opts?: { ifNotExists?: boolean; ifEquals?: WriteGuard },
  ): Promise<void>;
  /** Query by exact PK, optional SK prefix. SK-ascending unless `opts` says otherwise. */
  query(pk: string, skPrefix?: string, opts?: QueryOptions): Promise<Item[]>;
  /**
   * Query the single GSI1 by exact GSI1PK. GSI1SK-ascending unless `opts` says otherwise.
   *
   * GSI1 is a COMPOSITE-key index: a row is a member only while it carries BOTH `GSI1PK`
   * and `GSI1SK`. DynamoDB simply does not project an item that is missing either — so a
   * writer that sets `GSI1PK` and forgets `GSI1SK` gets a row that this store returned
   * (sorted by its `SK` as a fallback) and the real table would not. Writes carrying one
   * without the other are refused with {@link SeamViolationError} rather than indexed on
   * different terms than production would (DATA-14 (4)).
   */
  queryGSI1(gsi1pk: string, opts?: QueryOptions): Promise<Item[]>;
  /**
   * Fold over one GSI1 partition WITHOUT materializing it (PERF-10).
   *
   * `queryGSI1` deep-clones every matching row before returning it, which is
   * correct — a caller that gets a row can keep it, and the returned object must
   * not be a live handle into the store. But a caller that only wants to COUNT
   * something pays that clone for every row and then throws them all away: the
   * submit path cloned the entire global account directory on every submission
   * to answer "how many of these could sign this request" (measured 7.1 ms at
   * 5,000 accounts, on the request's critical path, twice per submit).
   *
   * `visit` receives a READ-ONLY view of the stored row and must not retain or
   * mutate it — nothing but the accumulated result may escape this call. That
   * restriction is what makes skipping the clone safe, and it is why this is a
   * fold rather than a `queryProjected` returning references.
   *
   * OPTIONAL: a store that cannot do better than a full read simply omits it and
   * callers fall back to `queryGSI1`, with identical semantics and the old cost.
   * A DynamoDB implementation would express it as a projection expression.
   */
  foldGSI1?<T>(gsi1pk: string, initial: T, visit: (acc: T, item: Readonly<Item>) => T): Promise<T>;
  /**
   * All-or-nothing batch. A failed condition throws ConditionError and applies NOTHING.
   *
   * Two DynamoDB limits are enforced, because a batch that violates either is accepted
   * locally and rejected in production: at most {@link MAX_TRANSACT_WRITES} actions, and
   * at most ONE action per (PK, SK). The duplicate-key rule is the dangerous one — this
   * store used to apply both writes last-wins, so a handler that queued the same key
   * twice (two code paths both amending the same row) passed every local test and would
   * fail every deployed call.
   */
  transact(writes: TransactWrite[]): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
  /**
   * Has this store irrecoverably lost the ability to make writes durable? Returns a
   * human-readable reason, or `null` when writes are landing (DATA-3 / ERR-10).
   *
   * OPTIONAL, so an in-memory store — which has no disk to diverge from — implements
   * nothing. Only a store with durable backing can answer this, and only such a store
   * can develop the fault: memory accepted a mutation that disk refused, so what the
   * server SERVES and what a restart would RESURRECT have diverged by an unknown amount.
   *
   * Callers must not treat a fault as "the last write failed" — that error was already
   * returned to its own caller. It means the store is no longer authoritative at all,
   * which is a readiness fact, not a request-level one.
   */
  durabilityFault?(): string | null;
  /**
   * ARCH-9 — how many rows this store currently holds, or `undefined` when a backend
   * has no cheap way to answer (e.g. a future DynamoDB implementation would read this
   * from CloudWatch table metrics, not count on every call). Every write accretes here
   * forever — accounts, sessions, requests, both audit chains, per-project drift/audit
   * history — with no compaction or archival, so this is the one number that tells an
   * operator "we are approaching the point where write-amplification (a full-store
   * fsync per mutation, see FileStore's own doc comment) starts to matter" BEFORE
   * write latency actually degrades. Surfaced read-only in `/readyz`'s `storeItemCount`
   * — informational telemetry, never a readiness gate: a large store is a growth trend
   * to alert on, not itself a fault.
   */
  approxItemCount?(): number;
}

/**
 * Thrown by a durable store that can no longer persist (DATA-3 / ERR-10). Distinct from
 * {@link ConditionError}: a condition failure means *this* write lost a race and the
 * caller may sensibly retry, whereas this means the store itself has stopped being
 * authoritative and no retry against it can succeed.
 */
export class DurabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurabilityError';
  }
}
