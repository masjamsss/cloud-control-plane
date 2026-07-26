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
  | { kind: 'put'; item: Item; ifNotExists?: boolean }
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
  /** Put an item; with `{ ifNotExists: true }` throws ConditionError if the key exists. */
  put(item: Item, opts?: { ifNotExists?: boolean }): Promise<void>;
  /** Query by exact PK, optional SK prefix. SK-ascending unless `opts` says otherwise. */
  query(pk: string, skPrefix?: string, opts?: QueryOptions): Promise<Item[]>;
  /** Query the single GSI1 by exact GSI1PK. GSI1SK-ascending unless `opts` says otherwise. */
  queryGSI1(gsi1pk: string, opts?: QueryOptions): Promise<Item[]>;
  /** All-or-nothing batch. A failed condition throws ConditionError and applies NOTHING. */
  transact(writes: TransactWrite[]): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
}
