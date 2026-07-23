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

export interface ConfigStore {
  get(pk: string, sk: string): Promise<Item | null>;
  /** Put an item; with `{ ifNotExists: true }` throws ConditionError if the key exists. */
  put(item: Item, opts?: { ifNotExists?: boolean }): Promise<void>;
  /** Query by exact PK, optional SK prefix, returned in SK-ascending order. */
  query(pk: string, skPrefix?: string): Promise<Item[]>;
  /** Query the single GSI1 by exact GSI1PK, returned in GSI1SK-ascending order. */
  queryGSI1(gsi1pk: string): Promise<Item[]>;
  /** All-or-nothing batch. A failed condition throws ConditionError and applies NOTHING. */
  transact(writes: TransactWrite[]): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
}
