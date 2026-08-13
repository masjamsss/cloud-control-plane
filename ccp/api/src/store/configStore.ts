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

export type TransactWrite =
  /**
   * `ifEquals` guards a whole-row put the same way it guards an update: the write lands
   * only if the named attribute still holds the captured value. DynamoDB's transactional
   * `Put` takes a ConditionExpression, so this is the seam being faithful rather than
   * generous — without it, "read, compute a new row, write it back" had no way to say
   * "…only if nobody moved it", and the read-modify-write races in CONC-1/2/3/14 and
   * DATA-1 had no primitive to fix them with.
   */
  | { kind: 'put'; item: Item; ifNotExists?: boolean; ifEquals?: { attr: string; value: unknown } }
  | {
      kind: 'update';
      pk: string;
      sk: string;
      set: Record<string, unknown>;
      ifEquals?: { attr: string; value: unknown };
    }
  | { kind: 'delete'; pk: string; sk: string; ifEquals?: { attr: string; value: unknown } };

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
    opts?: { ifNotExists?: boolean; ifEquals?: { attr: string; value: unknown } },
  ): Promise<void>;
  /** Query by exact PK, optional SK prefix. SK-ascending unless `opts` says otherwise. */
  query(pk: string, skPrefix?: string, opts?: QueryOptions): Promise<Item[]>;
  /** Query the single GSI1 by exact GSI1PK. GSI1SK-ascending unless `opts` says otherwise. */
  queryGSI1(gsi1pk: string, opts?: QueryOptions): Promise<Item[]>;
  /** All-or-nothing batch. A failed condition throws ConditionError and applies NOTHING. */
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
