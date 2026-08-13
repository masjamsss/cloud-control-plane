import type { ConfigStore, Item, QueryOptions, TransactWrite, WriteGuard } from './configStore';
import {
  ConditionError,
  KEY_SEPARATOR,
  MAX_TRANSACT_WRITES,
  SeamViolationError,
  assertStorableKey,
} from './configStore';
import { cloneValue } from './clone';

/**
 * Composite-key separator. NUL is used deliberately: it is the one character that
 * cannot appear in a PK or SK, so `pk + SEP + sk` is unambiguous — with a printable
 * separator, `{PK:'A B', SK:'C'}` and `{PK:'A', SK:'B C'}` would collide on the same
 * composite key and silently overwrite each other. Written as an ESCAPE, never as a
 * literal control byte in the source: a raw NUL makes this file `data` rather than
 * text to git/grep/editors, and one well-meaning "strip the weird character" edit
 * would reintroduce exactly that collision.
 *
 * DATA-15: "cannot appear in a PK or SK" is now ENFORCED at every write
 * ({@link assertStorableKey}), not merely asserted here. It was a comment while
 * `idempotencyKey` was putting up to 200 client-chosen bytes into a PK — and an
 * invariant a client can violate is not an invariant. The character itself is defined
 * in `configStore.ts` beside the rule, so the encoding and its guard cannot drift.
 */
const SEP = '\u0000';
const keyOf = (pk: string, sk: string): string => `${pk}${SEP}${sk}`;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Structural equality for a stored attribute value — the seam's `ifEquals` comparison
 * (API-17 (a)).
 *
 * Store items are JSON values by contract (`clone.ts`), and every item a caller holds is
 * a CLONE of the stored one, so `!==` — reference identity for objects and arrays — made
 * an object-valued guard a condition that could never pass, whatever the data said.
 * DynamoDB's `=` compares the VALUE, and so does this: element-wise and order-sensitive
 * for lists (DynamoDB `L` is ordered), key-order-insensitive for maps (`M` is not).
 */
function attributeEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => attributeEquals(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && attributeEquals(ao[k], bo[k]));
}

/**
 * Reject an item DynamoDB would key or index differently than this store does. Called on
 * every write BEFORE anything is applied — in `transact` that means during the condition
 * phase, so a violating batch aborts whole instead of half-landing.
 */
function assertStorableItem(item: Item, where: string): void {
  assertStorableKey(item.PK, item.SK, where);
  const gsiPk = item.GSI1PK;
  const gsiSk = item.GSI1SK;
  // Membership in GSI1 is decided by GSI1PK alone: a row without it is not in the index
  // here and not in the index there, whatever GSI1SK says. (Dual-control's de-index
  // REMOVEs only GSI1PK and leaves the sort key behind — harmless in both worlds, and
  // the row is correctly re-indexed on that key if it ever rejoins.) The asymmetry is
  // deliberate: only the other direction diverges.
  if (gsiPk === undefined || gsiPk === null) return;
  const at = `${item.PK}/${item.SK}`;
  if (typeof gsiPk !== 'string') {
    throw new SeamViolationError(`${where}: ${at} GSI1PK must be a string, got ${typeof gsiPk}`);
  }
  if (gsiPk.length === 0) {
    throw new SeamViolationError(`${where}: ${at} GSI1PK must not be empty (DynamoDB rejects an empty key value)`);
  }
  // GSI1 is a COMPOSITE-key index: DynamoDB projects an item only when BOTH key
  // attributes are present. A row with GSI1PK and no GSI1SK is one this store serves
  // (sorted by its SK as a fallback) and the real table omits entirely — the exact shape
  // that makes a passing local test a false claim about production.
  if (typeof gsiSk !== 'string' || gsiSk.length === 0) {
    throw new SeamViolationError(
      `${where}: ${at} sets GSI1PK=${JSON.stringify(gsiPk)} with ${gsiSk === undefined ? 'no GSI1SK' : `GSI1SK=${JSON.stringify(gsiSk)}`} — GSI1 is a composite-key index, so DynamoDB would not project this row at all. Set a non-empty GSI1SK, or drop GSI1PK to leave the index.`,
    );
  }
}

/** The row an `update` write produces, so its shape can be checked before it lands. */
function applyUpdate(cur: Item, set: Record<string, unknown>, remove?: readonly string[]): Item {
  const next: Record<string, unknown> = { ...cur, ...set };
  for (const attr of remove ?? []) delete next[attr];
  return next as Item;
}

/** Refuse `set: { x: undefined }` — DynamoDB `SET` cannot assign nothing; use `remove`. */
function assertSettable(set: Record<string, unknown>, at: string, where: string): void {
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) {
      throw new SeamViolationError(
        `${where}: ${at} set.${k} is undefined — DynamoDB SET cannot assign an absent value. Use remove: ['${k}'] to delete the attribute (that is how a row leaves GSI1).`,
      );
    }
  }
}

/**
 * One PK partition (or one GSI1PK partition): the rows plus a lazily-rebuilt sort
 * order. `sorted` is the cache; `null` means "re-sort on next read". Splitting the
 * table into partitions is what turns `query`/`queryGSI1` from a full-table scan
 * into a partition read — the single most important property of this store, because
 * every list endpoint in the API is one `query` and the API's whole latency profile
 * tracked table SIZE rather than result size before it existed.
 */
type Partition<K> = { rows: Map<K, Item>; sorted: K[] | null };

function partitionInsert<K>(index: Map<string, Partition<K>>, pkey: string, k: K, item: Item): void {
  let p = index.get(pkey);
  if (!p) {
    p = { rows: new Map(), sorted: null };
    index.set(pkey, p);
  }
  if (!p.rows.has(k)) p.sorted = null; // a NEW key changes the order; a value swap may too (GSI)
  p.rows.set(k, item);
}

function partitionRemove<K>(index: Map<string, Partition<K>>, pkey: string, k: K): void {
  const p = index.get(pkey);
  if (!p) return;
  if (p.rows.delete(k)) {
    p.sorted = null;
    if (p.rows.size === 0) index.delete(pkey); // never leak empty partitions
  }
}

function partitionKeys<K>(p: Partition<K>, order: (a: K, b: K) => number): K[] {
  if (p.sorted === null) p.sorted = [...p.rows.keys()].sort(order);
  return p.sorted;
}

/**
 * The GSI1 sort key.
 *
 * Every WRITE now carries both GSI1 key attributes or neither ({@link assertStorableItem}),
 * so the `SK` fallback is reachable only for a row that was already on disk when that rule
 * arrived — a hand-edited or pre-rule snapshot. It is kept for exactly that case: a
 * loaded row is served in SK order rather than vanishing out of the index mid-boot, and
 * the snapshot validator (`validateSnapshot`) reports it by key so the divergence is
 * loud instead of silent. Nothing this code writes can produce one (DATA-14 (4)).
 */
const gsiSortKey = (it: Item): string => (typeof it.GSI1SK === 'string' ? it.GSI1SK : it.SK);

/**
 * Process-bound `ConfigStore` for local dev and tests. `transact` reproduces
 * DynamoDB `TransactWriteItems` exactly: every condition is checked against the
 * pre-transaction snapshot FIRST; if any fails the whole batch throws
 * ConditionError and NOTHING is applied.
 *
 * Storage is a PARTITIONED index, mirroring the DynamoDB table it stands in for:
 * a primary index keyed by PK (rows keyed by SK) and one global secondary index
 * keyed by GSI1PK. `get` is two map lookups, `query`/`queryGSI1` read exactly one
 * partition, and neither touches a row outside the partition asked for — so a
 * ten-row `GET /admin/teams` costs ten rows whether the table holds a hundred
 * items or a hundred thousand. (It previously filtered the entire table on every
 * call, which made every read O(table).)
 *
 * FileStore extends this to add durability: the in-memory index stays the read
 * source of truth (so DynamoDB semantics are byte-identical), and every applied
 * mutation is snapshotted to disk. Mutators are marked `protected` so the subclass
 * can persist AFTER the (all-or-nothing) apply lands.
 */
export class MemoryStore implements ConfigStore {
  /** PK -> (SK -> item). The item objects here are the single stored copy; every
   *  entry in `gsi1` is a reference to the SAME object, never a second copy. */
  private primary = new Map<string, Partition<string>>();
  /** GSI1PK -> (composite primary key -> item). */
  private gsi1 = new Map<string, Partition<string>>();
  /** Cached composite keys in snapshot order. Invalidated on insert/delete ONLY:
   *  the order is a function of (PK, SK), so replacing a row's VALUE — the common
   *  write by far, every session slide and status update — cannot reorder it. The
   *  sort is the expensive half of building a snapshot, so keeping it across value
   *  writes is what makes the durable path pay for the write and not the store. */
  private exportOrder: string[] | null = null;
  private count = 0;

  /* ── index maintenance ─────────────────────────────────────────────────── */

  private lookup(pk: string, sk: string): Item | undefined {
    return this.primary.get(pk)?.rows.get(sk);
  }

  /** Insert or replace one row, keeping both indexes and the export order consistent. */
  private setItem(item: Item): void {
    const prev = this.lookup(item.PK, item.SK);
    if (prev) {
      // A replacement can move the row to a DIFFERENT GSI1 partition (or out of the
      // index entirely) — drop the old placement before adding the new one.
      const prevGsi = prev.GSI1PK;
      if (typeof prevGsi === 'string') partitionRemove(this.gsi1, prevGsi, keyOf(prev.PK, prev.SK));
    } else {
      this.count++;
      this.exportOrder = null; // a NEW key changes the snapshot order
    }
    partitionInsert(this.primary, item.PK, item.SK, item);
    const gsi = item.GSI1PK;
    if (typeof gsi === 'string') {
      const gk = keyOf(item.PK, item.SK);
      partitionInsert(this.gsi1, gsi, gk, item);
      // The GSI sort key lives in the VALUE, so a same-key replacement can reorder
      // the partition even though its key set is unchanged.
      const p = this.gsi1.get(gsi);
      if (p) p.sorted = null;
    }
  }

  private deleteItem(pk: string, sk: string): boolean {
    const prev = this.lookup(pk, sk);
    if (!prev) return false;
    partitionRemove(this.primary, pk, sk);
    const gsi = prev.GSI1PK;
    if (typeof gsi === 'string') partitionRemove(this.gsi1, gsi, keyOf(pk, sk));
    this.count--;
    this.exportOrder = null;
    return true;
  }

  /** Live item references in stable key order — the snapshot layout, WITHOUT cloning. */
  protected itemsInKeyOrder(): Item[] {
    if (this.exportOrder === null) {
      const keys: string[] = new Array(this.count);
      let i = 0;
      for (const [pk, part] of this.primary) for (const sk of part.rows.keys()) keys[i++] = keyOf(pk, sk);
      keys.length = i;
      this.exportOrder = keys.sort(cmp);
    }
    const out: Item[] = new Array(this.exportOrder.length);
    let n = 0;
    for (const k of this.exportOrder) {
      const idx = k.indexOf(SEP);
      const it = this.lookup(k.slice(0, idx), k.slice(idx + 1));
      if (it) out[n++] = it;
    }
    out.length = n;
    return out;
  }

  /* ── snapshot surface ──────────────────────────────────────────────────── */

  /** Full snapshot for durable persistence — one clone per item, key-sorted for a stable file. */
  exportItems(): Item[] {
    return this.itemsInKeyOrder().map((it) => cloneValue(it));
  }

  /** ARCH-9 — the private row counter every put/delete already maintains, exposed
   * read-only. O(1): no traversal, no clone — cheap enough to read on every
   * `/readyz` probe, unlike `exportItems()`. FileStore inherits this unchanged
   * (it IS a MemoryStore plus a snapshot-on-write). */
  approxItemCount(): number {
    return this.count;
  }

  /**
   * The snapshot as JSON, key-sorted — byte-identical to
   * `JSON.stringify(exportItems())` but WITHOUT the intermediate deep copy.
   * `JSON.stringify` only reads its input, so cloning first just doubles the work
   * on the hottest durable-write path there is.
   */
  serializeItems(): string {
    return JSON.stringify(this.itemsInKeyOrder());
  }

  /**
   * Replace the whole store from a snapshot (load-on-boot).
   *
   * DATA-5: the KEYS are checked here and nowhere else can they be. This used to trust
   * whatever the file said, so a row with no `PK`/`SK` keyed itself under the literal
   * composite `"undefined<sep>undefined"` — one slot shared by every such row, last one
   * winning, and every read for the real key missing. Refusing names the row INDEX,
   * because a row that has no key cannot be named by its key.
   *
   * Only the structural invariants the index itself depends on are enforced here. Whether
   * a row satisfies its own entity schema is a separate, tunable question — see
   * `validateSnapshot` — precisely because getting THAT wrong fails a boot rather than a
   * test, and a store that refuses to open is worse than one that says loudly what is
   * wrong with it.
   */
  importItems(items: Item[]): void {
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it === null || typeof it !== 'object' || Array.isArray(it)) {
        throw new SeamViolationError(`snapshot row ${i} is ${Array.isArray(it) ? 'an array' : String(it)}, not an item object`);
      }
      assertStorableKey(it.PK, it.SK, `snapshot row ${i}`);
      const k = keyOf(it.PK, it.SK);
      if (seen.has(k)) {
        throw new SeamViolationError(
          `snapshot row ${i} repeats the key ${it.PK}/${it.SK} — a store cannot hold two rows with one key, and loading it would silently keep whichever came last`,
        );
      }
      seen.add(k);
    }
    this.primary = new Map();
    this.gsi1 = new Map();
    this.exportOrder = null;
    this.count = 0;
    for (const it of items) this.setItem(cloneValue(it));
  }

  /* ── reads ─────────────────────────────────────────────────────────────── */

  async get(pk: string, sk: string): Promise<Item | null> {
    const it = this.lookup(pk, sk);
    return it ? cloneValue(it) : null;
  }

  async query(pk: string, skPrefix?: string, opts?: QueryOptions): Promise<Item[]> {
    const part = this.primary.get(pk);
    if (!part) return [];
    const keys = partitionKeys(part, cmp);
    const limit = opts?.limit;
    if (limit !== undefined && limit <= 0) return [];
    const descending = opts?.forward === false;
    const after = opts?.after;
    const out: Item[] = [];
    // Walk the sorted keys from whichever end the caller asked for and stop at the
    // limit, so a descending page read costs the page and not the partition.
    for (let i = 0; i < keys.length; i++) {
      const sk = keys[descending ? keys.length - 1 - i : i]!;
      if (skPrefix !== undefined && !sk.startsWith(skPrefix)) continue;
      // `after` is EXCLUSIVE and direction-aware, exactly as in `queryGSI1` below.
      // It was declared on the SEAM (`QueryOptions.after`, "the one component that
      // varies within a partition") and honoured only on the GSI — so a primary-index
      // caller that passed it got every row from the top of the partition and no
      // error, which is the worst of the three possible behaviours: a resume that
      // silently replays. A seam option the seam ignores is a lie about what the
      // real table would do, and the audit reader is the caller that needs it.
      if (after !== undefined && (descending ? sk >= after : sk <= after)) continue;
      const it = part.rows.get(sk);
      if (!it) continue;
      out.push(cloneValue(it));
      if (limit !== undefined && out.length >= limit) break;
    }
    return out;
  }

  async queryGSI1(gsi1pk: string, opts?: QueryOptions): Promise<Item[]> {
    const part = this.gsi1.get(gsi1pk);
    if (!part) return [];
    const rows = part.rows;
    const keys = partitionKeys(part, (a, b) => {
      const ia = rows.get(a);
      const ib = rows.get(b);
      return cmp(ia ? gsiSortKey(ia) : a, ib ? gsiSortKey(ib) : b);
    });
    const limit = opts?.limit;
    if (limit !== undefined && limit <= 0) return [];
    const descending = opts?.forward === false;
    const after = opts?.after;
    const out: Item[] = [];
    for (let i = 0; i < keys.length; i++) {
      const it = rows.get(keys[descending ? keys.length - 1 - i : i]!);
      if (!it) continue;
      // `after` is EXCLUSIVE and direction-aware: resuming a descending page means
      // "strictly smaller", an ascending one "strictly larger".
      if (after !== undefined) {
        const sk = gsiSortKey(it);
        if (descending ? sk >= after : sk <= after) continue;
      }
      out.push(cloneValue(it));
      if (limit !== undefined && out.length >= limit) break;
    }
    return out;
  }

  /**
   * Fold one GSI1 partition without cloning (PERF-10 — see the seam's doc).
   * Partition order is the same order `queryGSI1` would return, so a fold and a
   * query see the same rows in the same sequence; the only difference is that
   * nothing is copied and nothing escapes but the accumulator.
   */
  async foldGSI1<T>(gsi1pk: string, initial: T, visit: (acc: T, item: Readonly<Item>) => T): Promise<T> {
    const part = this.gsi1.get(gsi1pk);
    if (!part) return initial;
    const rows = part.rows;
    const keys = partitionKeys(part, (a, b) => {
      const ia = rows.get(a);
      const ib = rows.get(b);
      return cmp(ia ? gsiSortKey(ia) : a, ib ? gsiSortKey(ib) : b);
    });
    let acc = initial;
    for (const k of keys) {
      const it = rows.get(k);
      if (it) acc = visit(acc, it);
    }
    return acc;
  }

  /* ── writes ────────────────────────────────────────────────────────────── */

  async put(item: Item, opts?: { ifNotExists?: boolean; ifEquals?: WriteGuard }): Promise<void> {
    assertStorableItem(item, 'put');
    if (opts?.ifNotExists && this.lookup(item.PK, item.SK) !== undefined) {
      throw new ConditionError(`Item ${item.PK}/${item.SK} already exists`);
    }
    if (opts?.ifEquals) {
      const cur = this.lookup(item.PK, item.SK);
      // Fail closed against a missing item, exactly as DynamoDB does and as `transact`
      // already does below — a guarded put must never resurrect a deleted row.
      if (!cur) {
        throw new ConditionError(`ifEquals failed on ${item.PK}/${item.SK}.${opts.ifEquals.attr} (item missing)`);
      }
      if (!attributeEquals(cur[opts.ifEquals.attr], opts.ifEquals.value)) {
        throw new ConditionError(`ifEquals failed on ${item.PK}/${item.SK}.${opts.ifEquals.attr}`);
      }
    }
    this.setItem(cloneValue(item));
  }

  async delete(pk: string, sk: string): Promise<void> {
    this.deleteItem(pk, sk);
  }

  async transact(writes: TransactWrite[]): Promise<void> {
    // Phase 0: reject a batch DynamoDB would reject outright, before any condition is
    // evaluated — these are programming errors, not lost races (API-17 (b), DATA-14 (1)).
    if (writes.length > MAX_TRANSACT_WRITES) {
      throw new SeamViolationError(
        `transact: ${writes.length} writes exceeds the ${MAX_TRANSACT_WRITES}-action limit of a DynamoDB TransactWriteItems call`,
      );
    }
    const seen = new Set<string>();
    for (const w of writes) {
      const pk = w.kind === 'put' ? w.item.PK : w.pk;
      const sk = w.kind === 'put' ? w.item.SK : w.sk;
      const where = `transact[${w.kind}]`;
      if (w.kind === 'put') assertStorableItem(w.item, where);
      else assertStorableKey(pk, sk, where);
      if (w.kind === 'update') assertSettable(w.set, `${pk}/${sk}`, where);
      const k = keyOf(pk, sk);
      if (seen.has(k)) {
        throw new SeamViolationError(
          `transact: two writes target ${pk}/${sk} — DynamoDB rejects a transaction with more than one action on the same item. Merge them into one write.`,
        );
      }
      seen.add(k);
    }
    // Phase 1: validate ALL conditions against the pre-transaction snapshot.
    for (const w of writes) {
      if (w.kind === 'put') {
        if (w.ifNotExists && this.lookup(w.item.PK, w.item.SK) !== undefined) {
          throw new ConditionError(`Item ${w.item.PK}/${w.item.SK} already exists`);
        }
        if (w.ifEquals) {
          const cur = this.lookup(w.item.PK, w.item.SK);
          // Same fail-closed rule as update/delete below: a guarded put can never
          // resurrect a row deleted between the read and the write.
          if (!cur) {
            throw new ConditionError(
              `ifEquals failed on ${w.item.PK}/${w.item.SK}.${w.ifEquals.attr} (item missing)`,
            );
          }
          if (!attributeEquals(cur[w.ifEquals.attr], w.ifEquals.value)) {
            throw new ConditionError(`ifEquals failed on ${w.item.PK}/${w.item.SK}.${w.ifEquals.attr}`);
          }
        }
      } else if (w.ifEquals) {
        const cur = this.lookup(w.pk, w.sk);
        // DynamoDB-faithful fail-closed: a ConditionExpression against a MISSING item
        // fails. Without this, an ifEquals whose captured value is `undefined` (a legacy
        // row that predates the guarded attribute, e.g. `accountVersion`) would "pass"
        // against a deleted row and the update would resurrect a ghost item.
        if (!cur) throw new ConditionError(`ifEquals failed on ${w.pk}/${w.sk}.${w.ifEquals.attr} (item missing)`);
        if (!attributeEquals(cur[w.ifEquals.attr], w.ifEquals.value)) {
          throw new ConditionError(`ifEquals failed on ${w.pk}/${w.sk}.${w.ifEquals.attr}`);
        }
      }
    }
    // Phase 1b: the ROWS the updates produce must be storable too — checked here, before
    // phase 2, because a throw once writes have started applying would leave the batch
    // half-landed and this store's one hard promise is that it never does.
    for (const w of writes) {
      if (w.kind !== 'update') continue;
      const cur = this.lookup(w.pk, w.sk) ?? ({ PK: w.pk, SK: w.sk } as Item);
      assertStorableItem(applyUpdate(cur, w.set, w.remove), 'transact[update]');
    }
    // Phase 2: all conditions passed → apply atomically.
    for (const w of writes) {
      if (w.kind === 'put') {
        this.setItem(cloneValue(w.item));
      } else if (w.kind === 'delete') {
        this.deleteItem(w.pk, w.sk);
      } else {
        const cur = this.lookup(w.pk, w.sk) ?? ({ PK: w.pk, SK: w.sk } as Item);
        this.setItem(cloneValue(applyUpdate(cur, w.set, w.remove)));
      }
    }
  }
}
