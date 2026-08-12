import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { open as fsOpen, rename, mkdir, rm, readdir } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { DurabilityError, type Item, type TransactWrite } from './configStore';
import { DataLock } from './dataLock';
import { MemoryStore } from './memoryStore';
import { parseSnapshotItems, serializeSnapshot } from './snapshot';
import { describeReport, validateMode, validateSnapshot } from './validate';

/**
 * Durable, single-file `ConfigStore` for real deployments. It reuses MemoryStore's
 * exact DynamoDB semantics for reads and conditional writes (the in-memory Map is
 * the read source of truth) and, after every APPLIED mutation, snapshots the full
 * state to a JSON file with a crash-safe atomic write (temp + fsync + rename).
 *
 * Why full-snapshot-per-write: this governance DB is small (accounts, sessions,
 * requests, a per-project audit chain) and correctness beats write-amplification.
 * A POSIX rename is atomic, so a `kill -9` at any instant leaves EITHER the prior
 * complete snapshot or the new complete snapshot on disk — never a torn file.
 *
 * Ordering + batching: disk writes run on a serialized chain, and every mutation
 * that arrives while a write is in flight joins the SAME next snapshot instead of
 * queueing a snapshot of its own. That is sound because the store never rolls a
 * mutation back: a snapshot taken after N mutations have landed necessarily
 * contains all N, so one write can honour all N durability promises. The contract
 * each caller gets is unchanged and still strict — `await store.put(x)` resolves
 * only once a snapshot CONTAINING x is durably on disk — but a burst of writes
 * now costs one fsync instead of one fsync each, which is the difference between
 * the durable path scaling with concurrency and serialising behind it.
 *
 * The DynamoDB implementation lands later behind the SAME ConfigStore seam.
 */
export class FileStore extends MemoryStore {
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * Set by the first failed snapshot write, and never cleared (DATA-3 / ERR-10).
   *
   * A mutation applies to the Map synchronously and THEN awaits the snapshot. When the
   * snapshot fails the caller gets its error — but the Map keeps the mutation, and
   * because every snapshot serializes the WHOLE Map, that "failed" write becomes durable
   * as a side effect of the next successful persist by any unrelated request. If the
   * process dies first, it vanishes instead — while other requests may already have read
   * it and acted on it. So a 500 stops meaning anything about durability.
   *
   * ROLLING THE MAP BACK IS NOT THE FIX, though the finding offers it first. Snapshots
   * are whole-state and serialized: if write A fails but a later write B succeeds, B's
   * snapshot already contains A, so A is durable no matter what memory says — undoing A
   * in memory would invert the divergence rather than end it. And any mutation between
   * A's apply and A's failure may have read A and built on it; discarding A silently
   * discards that too.
   *
   * What is knowable is only this: memory and disk have diverged by an unknown amount,
   * and nothing this process can do will tell it by how much. So the store stops
   * claiming to be authoritative. It is never cleared because a later successful write
   * proves nothing about the divergence already created — a store that healed itself
   * here would be guessing, which is precisely what `load()` already refuses to do with
   * a corrupt snapshot.
   */
  private fault: string | null = null;
  /** Callers awaiting durability who are not yet covered by a completed write. */
  private waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  /** True once a flush is queued on `writeChain` but has not yet claimed `waiters`. */
  private flushQueued = false;

  constructor(private readonly file: string) {
    super();
  }

  /** @see ConfigStore.durabilityFault */
  durabilityFault(): string | null {
    return this.fault;
  }

  /**
   * Refuse a mutation once durability is gone — fail CLOSED, before touching the Map.
   *
   * Without this the divergence compounds: every later write is accepted into memory,
   * served to readers, and reported as succeeding or failing on grounds that no longer
   * relate to what is on disk. Reads are deliberately still allowed: memory holds
   * exactly what has already been served, and refusing to answer would remove the
   * operator's ability to see the state they need to reconcile.
   */
  private assertDurable(): void {
    if (this.fault !== null) throw new DurabilityError(this.fault);
  }

  /**
   * The single-writer claim (CONC-7 / DATA-9). Held for the process's life; released on
   * {@link close}. Absent only when a caller explicitly opened unlocked.
   */
  private lock: DataLock | null = null;

  /**
   * Open a store at `file`, loading any existing snapshot (load-on-boot).
   *
   * CONC-7 / DATA-9: this CLAIMS the file first. Every mutation rewrites the whole
   * snapshot from this process's private map, so a second writer does not merely race —
   * it silently discards everything the first one has done, across accounts, sessions,
   * requests and both audit chains, with every in-process `ifEquals` guard evaluated
   * against a map that no longer describes the file. Refusing to boot is the only honest
   * response; see `dataLock.ts` for what counts as a stale lock and why.
   *
   * `{ lock: false }` exists for read-only tooling that opens a snapshot to inspect it
   * (and for tests that deliberately construct two stores on one path). It is never used
   * by the server.
   */
  static async open(file: string, opts?: { lock?: boolean }): Promise<FileStore> {
    const store = new FileStore(file);
    if (opts?.lock !== false) store.lock = DataLock.acquire(file);
    try {
      await sweepStaleTmp(file);
      await store.load();
    } catch (e) {
      // A store that failed to load never becomes the writer, and must not leave a lock
      // behind for the operator to clear before they can retry the fix.
      store.close();
      throw e;
    }
    return store;
  }

  /** Release the single-writer claim. Idempotent; safe from an exit handler. */
  close(): void {
    this.lock?.release();
    this.lock = null;
  }

  /**
   * Load the snapshot from disk. Only a truly ABSENT file is a fresh store; an
   * existing-but-empty/whitespace file is a corrupted or half-restored snapshot
   * and MUST fail closed (adversarial finding) — the store never writes
   * an empty file itself (min payload "[]"), so a present-but-empty file means a
   * bad backup restore / zeroed file / FS corruption. Booting it silently empty
   * would drop the entire governance DB (and, under bootstrap, reseed a fresh
   * admin over the vanished audit chain) behind a green health check.
   */
  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, 'utf8');
    if (raw.trim().length === 0) {
      throw new Error(
        `ccp data file ${this.file} exists but is empty/whitespace — refusing to boot a silently-empty store (corrupt or half-restored snapshot). Remove the file to start fresh, or restore a valid snapshot.`,
      );
    }
    // DATA-5 / DATA-16 — one parser for the file format, shared with backup/restore
    // (`snapshot.ts`), instead of a bare `JSON.parse(raw) as Item[]`. That cast is what
    // made a non-array payload surface as an incidental `items.map is not a function`
    // deep in the loader, and a `formatVersion` from a newer binary indistinguishable
    // from no marker at all. `importItems` then enforces the key invariants per row.
    const items = parseSnapshotItems(raw, `ccp data file ${this.file}`);
    this.importItems(items);
    this.reportValidation(items);
  }

  /**
   * DATA-5 — run every loaded row through its entity schema and say so, loudly, when one
   * does not match. `strict` refuses the boot instead; `off` skips the pass.
   *
   * Deliberately AFTER `importItems`: the structural check that decides whether the file
   * can be indexed at all belongs to the index, and running the schema pass over rows we
   * have already keyed means the report can name each one by its key.
   */
  private reportValidation(items: Item[]): void {
    const mode = validateMode();
    if (mode === 'off') return;
    const report = validateSnapshot(items);
    const lines = describeReport(report, `ccp data file ${this.file}`);
    if (lines.length === 0) return;
    if (mode === 'strict' && report.violations.length > 0) {
      throw new Error(
        `${lines.join('\n')}\n(CCP_STORE_VALIDATE=strict — refusing to boot on a store whose rows do not match their schemas.)`,
      );
    }
    for (const line of lines) console.error(line);
  }

  override async put(
    item: Item,
    opts?: { ifNotExists?: boolean; ifEquals?: { attr: string; value: unknown } },
  ): Promise<void> {
    this.assertDurable();
    await super.put(item, opts); // throws BEFORE we persist if the condition fails → no write
    await this.persist();
  }

  override async delete(pk: string, sk: string): Promise<void> {
    this.assertDurable();
    await super.delete(pk, sk);
    await this.persist();
  }

  override async transact(writes: TransactWrite[]): Promise<void> {
    this.assertDurable();
    await super.transact(writes); // all-or-nothing: a failed condition throws, nothing applied, nothing persisted
    await this.persist();
  }

  /**
   * Register this mutation's durability promise and make sure a write is coming.
   *
   * The caller's mutation has ALREADY landed in the in-memory index synchronously
   * (super.put/transact returned before we were called), so any snapshot taken
   * from here on contains it — which is why several callers can share one write.
   * The returned promise resolves once such a snapshot is on disk, and rejects
   * only if the write that was meant to cover it failed.
   */
  private persist(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (!this.flushQueued) {
      this.flushQueued = true;
      const run = this.writeChain.then(() => this.flush());
      // Keep the chain alive even if one write rejects; the error still reaches the
      // waiters that write was covering (below).
      this.writeChain = run.catch(() => undefined);
    }
    return done;
  }

  /**
   * Write one snapshot covering every waiter registered so far. Claiming `waiters`
   * and taking the VIEW happen in the SAME synchronous step, so no mutation can slip
   * between "these callers are covered" and "this is the state we are writing" —
   * a mutation that lands during the await simply queues the next flush.
   *
   * CONC-8: the view is an array of the stored row objects in snapshot order — pointers,
   * not copies, and taking it is O(rows) pointer work with no serialization at all. The
   * expensive half (turning ~N MB of state into JSON) then happens in bounded pieces
   * inside `writeAtomic`, which is what stops one durable write from occupying the event
   * loop for as long as the database is big.
   *
   * That is only sound because a stored row is never mutated in place — every write
   * REPLACES the object in the index (`MemoryStore.setItem`), and reads hand out clones.
   * So this array keeps describing the store as it was at this instant however long the
   * write takes, and a mutation landing mid-write is simply not in this snapshot, exactly
   * as one landing mid-fsync was never in it. `test/fileStoreSnapshotYield.test.ts` pins
   * that: it mutates the store DURING a flush and asserts the file matches the state at
   * flush start, byte for byte.
   */
  private async flush(): Promise<void> {
    this.flushQueued = false;
    const covered = this.waiters;
    this.waiters = [];
    if (covered.length === 0) return;
    const view = this.itemsInKeyOrder();
    try {
      await this.writeAtomic(view);
    } catch (e) {
      // DATA-3 — the batching makes this MORE important, not less: one failed snapshot
      // now covers every mutation that joined it, so a single failure can leave many
      // writes in memory and none on disk. The Map already holds all of them and cannot
      // be safely un-held (see `fault`), so the store stops claiming to be authoritative.
      // First failure wins: the original cause is what an operator needs.
      this.fault ??=
        `snapshot write to ${this.file} failed: ${e instanceof Error ? e.message : String(e)}. ` +
        'In-memory state has diverged from disk by an unknown amount; this instance is no longer authoritative.';
      for (const w of covered) w.reject(e);
      return;
    }
    for (const w of covered) w.resolve();
  }

  /**
   * CONC-8: writes `items` in the bounded chunks `serializeSnapshot` yields, handing
   * control back to the event loop between them, instead of handing the filesystem one
   * `O(store)` string built by a single synchronous `JSON.stringify`. The chunk COUNT is
   * what bounds the per-turn cost, not the store size — a 10-row store yields once, a
   * 400k-row store yields ~1,600 times, and every other queued turn gets a slice of each
   * of those gaps instead of waiting behind the whole write.
   */
  private async writeAtomic(items: Item[]): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    // ERR-10: the temp file used to leak on any failure after it was created. The cleanup
    // spans EVERY step from here to the rename, not just the write — a failing `rename`
    // (a directory sitting where the data file belongs, a cross-device target) leaks just
    // as surely as a failing write, and is the case a narrower catch misses. Under
    // sustained ENOSPC — the very condition that makes writes fail — one leaked file per
    // attempt fills the directory that recovery depends on.
    const fh = await fsOpen(tmp, 'w');
    try {
      try {
        for (const chunk of serializeSnapshot(items)) {
          await fh.write(chunk, null, 'utf8'); // current position — sequential, never a truncating re-open
          await yieldToEventLoop();
        }
        await fh.sync(); // flush file bytes to disk before we swap it in
      } finally {
        await fh.close();
      }
      await rename(tmp, this.file); // atomic swap: readers see old-or-new, never partial
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    // ERR-10: fsync the DIRECTORY too. The rename is atomic against a process kill
    // regardless, but the directory entry itself is not durable against power loss until
    // the directory's own metadata is flushed — so a crash could leave the OLD snapshot
    // even though the write was reported as complete. Best-effort: some filesystems
    // refuse a directory open-for-sync, and failing a landed write over that would be
    // worse than the narrow window it closes.
    await syncDir(dir);
  }
}

/**
 * CONC-8 — hand control back to the event loop. `setImmediate` (not a zero-delay
 * `setTimeout`, which the timer wheel can coalesce and delay under load) runs after I/O
 * callbacks and before the next timer phase, so a chunked write actually interleaves with
 * other pending work instead of just changing which microtask queue the whole write sits in.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * fsync a directory so a rename into it survives power loss. Best-effort by design: some
 * filesystems and platforms refuse to open a directory for sync, and failing a write that
 * has already landed — over a durability nicety — would be a worse bug than the narrow
 * window this closes. Process-kill safety never depended on it; the rename is atomic.
 */
async function syncDir(dir: string): Promise<void> {
  let dh;
  try {
    dh = await fsOpen(dir, 'r');
    await dh.sync();
  } catch {
    // see above — deliberately swallowed
  } finally {
    await dh?.close().catch(() => undefined);
  }
}

/**
 * DATA-13 — the catch block above only cleans up a temp file for a write THIS
 * process's own try/catch got to run for; a `kill -9` (or a host power loss)
 * mid-`writeFile`/`sync`/`close` leaves one behind that no catch ever sees, and
 * under sustained ENOSPC every failed attempt strands another partial multi-MB
 * snapshot — worsening the very condition that caused the failure. Swept once,
 * best-effort, at `open()` (before `load()`, so a fresh boot never has to look at
 * them again): remove every `<file>.tmp-*` in the data directory. Never a
 * FAIL — an unreadable directory or a permission miss must not block boot over a
 * cleanup nicety; the store's OWN file is read/validated separately by `load()`.
 */
async function sweepStaleTmp(file: string): Promise<void> {
  const dir = dirname(file);
  const prefix = `${basename(file)}.tmp-`;
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (name.startsWith(prefix)) {
        await rm(`${dir}/${name}`, { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // directory unreadable/absent — nothing to sweep, and not this function's job to fail boot over
  }
}

/** Ensure a data directory exists (used by the server entrypoint before first write). */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
