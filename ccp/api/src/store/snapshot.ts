import { randomBytes } from 'node:crypto';
import { cp, open as fsOpen, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Item } from './configStore';
import { verifyChain, type ChainEntry, type VerifyResult } from '../domain/audit';

/**
 * Operate on a store SNAPSHOT — the exact JSON array FileStore writes (`exportItems`).
 * Used by the backup/restore scripts to validate and verify a snapshot file WITHOUT
 * booting a full store: parse it, group the per-project audit chain, and re-verify
 * the hash linkage with the canonical `verifyChain`. The audit chain is the
 * evidence-of-record, so a restore can refuse to install an unverifiable snapshot.
 */

/** Audit month-partition PK: `P#<projectId>#AUDIT#<yyyymm>`. */
const AUDIT_MONTH = /^P#(.+)#AUDIT#\d{6}$/;
/** Chain-head PK: `P#<projectId>#AUDIT` (with SK `CHAINHEAD`). */
const AUDIT_HEAD = /^P#(.+)#AUDIT$/;

/**
 * The format version this binary WRITES, and the highest it can read (DATA-16).
 *
 * The snapshot used to be a bare JSON array with no marker at all. The migration story —
 * additive-optional fields plus read-time shims — is real, but it has no way to say
 * "this file's invariants are newer than you": an older binary read a newer file blind
 * and, because every write rewrites the whole store, rewrote it in its own image. One
 * integer fixes the direction that cannot be recovered from.
 *
 * Bump this ONLY for a change an older binary must not silently accept. Adding an
 * optional field is not one of those — that is what the additive discipline is for.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

/** The enveloped on-disk shape. The legacy bare array is still READ (see below). */
export type SnapshotEnvelope = { formatVersion: number; items: Item[] };

/**
 * Parse a snapshot file's contents. Fail closed — matching FileStore.load — on
 * empty/whitespace (a corrupt or half-written snapshot), on a payload that is neither
 * envelope nor array, and on a `formatVersion` this binary predates, so a restore never
 * silently installs a broken store nor a store it cannot correctly interpret.
 *
 * BOTH shapes load, forever: `{ formatVersion, items }` and the bare `[...]` array every
 * file written before DATA-16 carries. A legacy file is not an error and never will be —
 * treating "no marker" as version 0 is exactly what the marker exists to let us do.
 *
 * `source` names the file in the error. A snapshot that refuses to load is read by an
 * operator at 3am with a store that will not boot; "which file" is the first thing they
 * need and the hardest to reconstruct from a stack trace.
 */
export function parseSnapshotItems(raw: string, source = 'snapshot'): Item[] {
  if (raw.trim().length === 0) {
    throw new Error(`${source} is empty/whitespace — refusing to treat it as a valid store snapshot (corrupt or truncated file).`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as Item[]; // legacy: pre-DATA-16 bare array
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${source} is not a store snapshot: expected {formatVersion, items} or a JSON array of items, got ${parsed === null ? 'null' : typeof parsed}.`);
  }
  const env = parsed as Partial<SnapshotEnvelope>;
  const version = env.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`${source} has formatVersion=${JSON.stringify(version)} — expected a positive integer (or a legacy bare array).`);
  }
  if (version > SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `${source} was written in format version ${version}; this build reads at most ${SNAPSHOT_FORMAT_VERSION}. Refusing to load it — every write rewrites the WHOLE snapshot, so booting an unreadable file would rewrite it in an older format and lose whatever the newer one carried. Upgrade the binary, or restore a snapshot this version wrote.`,
    );
  }
  if (!Array.isArray(env.items)) {
    throw new Error(`${source} has formatVersion=${version} but its \`items\` is ${env.items === undefined ? 'missing' : 'not an array'}.`);
  }
  return env.items;
}

/**
 * Serialize a snapshot in bounded pieces — the exact bytes `FileStore` writes.
 *
 * CONC-8: the whole store used to be turned into one string by a single synchronous
 * `JSON.stringify`, which is O(store) work on the event loop for EVERY durable write.
 * Emitting it in chunks lets the writer hand a piece to the filesystem and yield, so the
 * per-turn cost is bounded by the chunk rather than by the size of the database.
 *
 * `items` MUST be a point-in-time view whose element objects are never mutated in place
 * (which is exactly what MemoryStore's index gives: a write REPLACES a row's object, it
 * never edits one). That is what makes it sound to finish serializing across an await —
 * the bytes describe the store as it was when the view was taken, so a mutation landing
 * mid-write is simply not in this snapshot, the same as one landing mid-fsync.
 */
export function* serializeSnapshot(items: readonly Item[], itemsPerChunk = 256): Generator<string> {
  yield `{"formatVersion":${SNAPSHOT_FORMAT_VERSION},"items":[`;
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    parts.push(i === 0 ? JSON.stringify(items[i]) : `,${JSON.stringify(items[i])}`);
    if (parts.length >= itemsPerChunk) {
      yield parts.join('');
      parts.length = 0;
    }
  }
  if (parts.length > 0) yield parts.join('');
  yield ']}';
}

export type SnapshotChain = {
  projectId: string;
  count: number;
  head: string | null;
  verified: boolean;
  verification: VerifyResult;
};

export type SnapshotSummary = {
  itemCount: number;
  accountCount: number;
  chains: SnapshotChain[];
  /** Every per-project audit chain verifies (hash linkage intact + head matches). */
  allVerified: boolean;
};

/**
 * Summarise a parsed snapshot: count the GLOBAL account rows and verify every
 * per-project audit chain against its CHAINHEAD. Entries are ordered by their ulid
 * SK (== creation order) exactly as `readAuditChronological` does, so the on-disk
 * and served verdicts cannot diverge — both call `verifyChain`.
 */
export function summarizeSnapshot(items: Item[]): SnapshotSummary {
  const accountCount = items.filter(
    (it) => typeof it.PK === 'string' && it.PK.startsWith('ACCOUNT#') && it.SK === 'META',
  ).length;

  const byProject = new Map<string, ChainEntry[]>();
  const heads = new Map<string, string>();
  for (const it of items) {
    if (typeof it.PK !== 'string') continue;
    const month = AUDIT_MONTH.exec(it.PK);
    if (month) {
      const pid = month[1]!;
      const arr = byProject.get(pid) ?? [];
      arr.push(it as unknown as ChainEntry);
      byProject.set(pid, arr);
      continue;
    }
    const head = AUDIT_HEAD.exec(it.PK);
    if (head && it.SK === 'CHAINHEAD') heads.set(head[1]!, String((it as { hash?: unknown }).hash ?? ''));
  }

  const projectIds = [...new Set([...byProject.keys(), ...heads.keys()])].sort();
  const chains: SnapshotChain[] = projectIds.map((projectId) => {
    const entries = (byProject.get(projectId) ?? [])
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // ulid == SK == chronological
    const head = heads.has(projectId) ? heads.get(projectId)! : null;
    const verification = verifyChain(entries, head !== null ? { head } : undefined);
    return { projectId, count: entries.length, head, verified: verification.code === 0, verification };
  });

  return { itemCount: items.length, accountCount, chains, allVerified: chains.every((c) => c.verified) };
}

/**
 * Crash-safe write: temp file + fsync + atomic rename (same discipline as
 * FileStore.writeAtomic, kept standalone so the scripts never touch the durable
 * store's code path). A reader mid-write sees the OLD or the NEW file, never a torn one.
 *
 * DATA-6/DATA-13 — this used to skip both of FileStore.writeAtomic's ERR-10
 * hardening steps: a failing `writeFile`/`sync`/`rename` leaked the temp file (no
 * cleanup path), and even a successful rename was not durable against power loss
 * (no directory fsync — a POSIX rename is a directory operation, and without
 * flushing the directory's own metadata a crash shortly after could resurrect the
 * OLD file on recovery). Both fixed here, matching FileStore.writeAtomic exactly
 * (duplicated, not imported, per this function's own "kept standalone" doc above).
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const fh = await fsOpen(tmp, 'w');
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  await syncDir(dir);
}

/**
 * fsync a directory so a rename into it survives power loss. Best-effort by design: some
 * filesystems and platforms refuse to open a directory for sync, and failing a write that
 * has already landed — over a durability nicety — would be a worse bug than the narrow
 * window this closes. Process-kill safety never depended on it; the rename is atomic.
 * (Same helper as FileStore.writeAtomic's — duplicated, see the doc comment above.)
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
 * DATA-10 — {@link writeFileAtomic}'s temp+rename discipline, extended to a whole
 * directory TREE: copy `src` into a temp sibling of `dest`, then swap it in with one
 * rename, so a killed backup/restore never leaves a half-copied `dest` where a later
 * read could find it. `dest`, if it already exists, is replaced wholesale (never
 * merged) — the point is that the result is byte-for-byte `src`, not `src` layered
 * over whatever `dest` happened to hold. Shared by scripts/backup.ts (root → the
 * backup's companion `.projects` dir) and scripts/restore.ts (that dir → the live
 * project-data root) so the one atomic-tree-copy implementation is exercised both
 * directions rather than duplicated per script. Returns the number of entries
 * (files + directories) copied, for the caller's own log line.
 */
export async function copyTreeAtomic(src: string, dest: string): Promise<number> {
  const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await rm(tmp, { recursive: true, force: true });
  let count = 0;
  await cp(src, tmp, {
    recursive: true,
    filter: () => {
      count += 1;
      return true;
    },
  });
  try {
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  await syncDir(dirname(dest));
  return count;
}
