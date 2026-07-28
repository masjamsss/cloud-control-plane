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
  /** Query by exact PK, optional SK prefix, returned in SK-ascending order. */
  query(pk: string, skPrefix?: string): Promise<Item[]>;
  /** Query the single GSI1 by exact GSI1PK, returned in GSI1SK-ascending order. */
  queryGSI1(gsi1pk: string): Promise<Item[]>;
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
