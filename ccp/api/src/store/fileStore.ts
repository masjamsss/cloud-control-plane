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
 * Ordering: a mutation captures its snapshot string SYNCHRONOUSLY (right after the
 * synchronous Map apply) and enqueues the disk write on a serialized chain, so
 * snapshots land in mutation order and the last writer always reflects true state.
 * The DynamoDB implementation lands later behind the SAME ConfigStore seam.
 */
export class FileStore extends MemoryStore {
  private writeChain: Promise<void> = Promise.resolve();

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
   * Snapshot the current state and durably write it. The JSON is captured now
   * (synchronously) so the enqueued write reflects state at THIS mutation; writes
   * are serialized so they apply in order. The returned promise resolves once this
   * snapshot (or a later one) is on disk, so callers `await` real durability.
   */
  private persist(): Promise<void> {
    const json = JSON.stringify(this.exportItems());
    const done = this.writeChain.then(() => this.writeAtomic(json));
    // Keep the chain alive even if one write rejects, but surface the error to THIS caller.
    this.writeChain = done.catch(() => undefined);
    return done;
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
