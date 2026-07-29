/**
 * The store seam. One in-memory implementation today (MemoryStore); a DynamoDB
 * implementation lands in a later AWS-gated plan behind this SAME interface.
 * `transact` mirrors DynamoDB `TransactWriteItems`: all-or-nothing, with every
 * condition evaluated against the pre-transaction snapshot (a failed condition
 * aborts the WHOLE batch). This is what makes the audit chain and approval dedupe
 * byte-for-byte identical between local and deployed.
 *
 * ## Where this seam KNOWINGLY differs from DynamoDB (API-17 / DATA-14)
 *
 * "Byte-identical semantics" is the promise, and an undocumented gap in it makes every
 * local test a claim about production that production does not honour. The gaps below are
 * DELIBERATE and load-bearing: each is a convention this codebase already depends on, so a
 * DynamoDB adapter MUST implement them, not merely permit them. They are written here —
 * on the interface an adapter author reads — rather than in the in-memory implementation,
 * which is the one place such an author will never look.
 *
 * 1. **`ifEquals: { value: undefined }` means "the attribute is ABSENT."** DynamoDB has no
 *    equality against nothing; the adapter must emit `attribute_not_exists(<attr>)` for
 *    this case, not `<attr> = :v`. Used by `domain/settlement.ts` to bind a legacy account
 *    row only while it still has no `roles` map — the whole point is that the guard must
 *    fail once somebody else has written one.
 *
 * 2. **`undefined` inside `set` means REMOVE the attribute.** DynamoDB's `SET` cannot take
 *    undefined; the adapter must route those keys into a `REMOVE` clause of the same update
 *    expression. `domain/dualControl.ts` uses `set: { GSI1PK: undefined }` to take a row
 *    OUT of the pending index when a proposal reaches a terminal state — implemented as a
 *    `SET` of a null, the row would stay in the index forever and every sweep would keep
 *    finding it.
 *
 * 3. **`GSI1SK` falls back to the item's own `SK` when absent.** A real composite-key GSI
 *    OMITS items that lack the sort key entirely, so an adapter must project a `GSI1SK` for
 *    every indexed row (writing `SK`'s value when the domain sets none) rather than rely on
 *    a read-time fallback. Rows written without one are indexed and returned here; on a
 *    composite GSI they would silently vanish from every list that reads the index.
 *
 * Two OTHER divergences named by those findings were closed rather than documented, because
 * they were traps rather than conventions: `ifEquals` now compares VALUES deep-equal (a
 * guard on an object could never pass, since the store hands out clones), and `transact`
 * now rejects duplicate keys in one batch and batches over 100 actions — both of which
 * DynamoDB rejects outright and this store used to accept.
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
  /**
   * Narrow the partition to items whose `attr` is one of `in`, evaluated by the STORE and
   * applied BEFORE the item is copied out — DynamoDB's `FilterExpression`, reduced to the
   * one shape the callers need.
   *
   * PERF-14 — the point is what it AVOIDS, not what it returns. A caller that reads a
   * partition and filters afterwards has already paid to deep-copy every row it is about
   * to throw away, and the seam's isolation copy is the expensive part: the scheduler's
   * per-minute scan of a project with 5,000 historical requests measured **91 ms**, on the
   * single-threaded event loop, to find a due set that is almost always empty. Filtering
   * here makes that cost proportional to the ANSWER rather than to the history.
   *
   * Declarative on purpose — an `attr`/`in` pair rather than a predicate callback. A
   * callback would have to be handed the store's own item to be worth anything (copying it
   * first is the cost being avoided), which hands callers a mutable reference to live
   * state; the store would be trusting every future call site not to write through it.
   *
   * ORDERING NOTE for a real backend: `limit` here counts MATCHING items, whereas
   * DynamoDB's `Limit` counts items EXAMINED and applies `FilterExpression` after. A
   * DynamoDB implementation must therefore page internally until it has `limit` matches,
   * not pass both through in one request.
   */
  where?: { attr: string; in: readonly string[] };
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
