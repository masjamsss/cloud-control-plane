import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { open as fsOpen, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Item, TransactWrite } from './configStore';
import { MemoryStore } from './memoryStore';

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
  /** Callers awaiting durability who are not yet covered by a completed write. */
  private waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  /** True once a flush is queued on `writeChain` but has not yet claimed `waiters`. */
  private flushQueued = false;

  constructor(private readonly file: string) {
    super();
  }

  /** Open a store at `file`, loading any existing snapshot (load-on-boot). */
  static async open(file: string): Promise<FileStore> {
    const store = new FileStore(file);
    await store.load();
    return store;
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
    this.importItems(JSON.parse(raw) as Item[]);
  }

  override async put(item: Item, opts?: { ifNotExists?: boolean }): Promise<void> {
    await super.put(item, opts); // throws BEFORE we persist if the condition fails → no write
    await this.persist();
  }

  override async delete(pk: string, sk: string): Promise<void> {
    await super.delete(pk, sk);
    await this.persist();
  }

  override async transact(writes: TransactWrite[]): Promise<void> {
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
   * and serializing happen in the SAME synchronous step, so no mutation can slip
   * between "these callers are covered" and "this is the state we are writing" —
   * a mutation that lands during the await simply queues the next flush.
   */
  private async flush(): Promise<void> {
    this.flushQueued = false;
    const covered = this.waiters;
    this.waiters = [];
    if (covered.length === 0) return;
    const json = this.serializeItems();
    try {
      await this.writeAtomic(json);
    } catch (e) {
      for (const w of covered) w.reject(e);
      return;
    }
    for (const w of covered) w.resolve();
  }

  private async writeAtomic(json: string): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    const fh = await fsOpen(tmp, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync(); // flush file bytes to disk before we swap it in
    } finally {
      await fh.close();
    }
    await rename(tmp, this.file); // atomic swap: readers see old-or-new, never partial
  }
}

/** Ensure a data directory exists (used by the server entrypoint before first write). */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
