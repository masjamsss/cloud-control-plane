import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { open as fsOpen, rename, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DurabilityError, type Item, type TransactWrite } from './configStore';
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
 * Ordering: a mutation captures its snapshot string SYNCHRONOUSLY (right after the
 * synchronous Map apply) and enqueues the disk write on a serialized chain, so
 * snapshots land in mutation order and the last writer always reflects true state.
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
   * Snapshot the current state and durably write it. The JSON is captured now
   * (synchronously) so the enqueued write reflects state at THIS mutation; writes
   * are serialized so they apply in order. The returned promise resolves once this
   * snapshot (or a later one) is on disk, so callers `await` real durability.
   */
  private persist(): Promise<void> {
    const json = JSON.stringify(this.exportItems());
    const done = this.writeChain.then(() => this.writeAtomic(json)).catch((e: unknown) => {
      // The Map already holds this mutation and cannot be safely un-held (see `fault`).
      // Record that the store is no longer authoritative, then rethrow so THIS caller
      // still learns its own write failed. First failure wins: the original cause is the
      // useful one for an operator, and later failures are just its consequences.
      this.fault ??= `snapshot write to ${this.file} failed: ${e instanceof Error ? e.message : String(e)}. In-memory state has diverged from disk by an unknown amount; this instance is no longer authoritative.`;
      throw e;
    });
    // Keep the chain alive even if one write rejects, but surface the error to THIS caller.
    this.writeChain = done.catch(() => undefined);
    return done;
  }

  private async writeAtomic(json: string): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    // ERR-10: the temp file used to leak on any failure after it was created. The cleanup
    // spans EVERY step from here to the rename, not just the write — a failing `rename`
    // (a directory sitting where the data file belongs, a cross-device target) leaks just
    // as surely as a failing `writeFile`, and is the case a narrower catch misses. Under
    // sustained ENOSPC — the very condition that makes writes fail — one leaked file per
    // attempt fills the directory that recovery depends on.
    const fh = await fsOpen(tmp, 'w');
    try {
      try {
        await fh.writeFile(json, 'utf8');
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

/** Ensure a data directory exists (used by the server entrypoint before first write). */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
