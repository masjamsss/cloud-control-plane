import { randomBytes } from 'node:crypto';
import { open as fsOpen, mkdir, rename, rm } from 'node:fs/promises';
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
 * The highest snapshot `formatVersion` this binary understands (DATA-16).
 *
 * The on-disk snapshot has always been a bare JSON array with no producer stamp and no
 * version, so an older binary handed a file whose invariants it predates could not DETECT
 * that — it read it and rewrote it blind, which is the failure mode a format marker
 * exists to prevent. There was also nowhere to hang a future breaking migration.
 *
 * The envelope is `{ formatVersion: <n>, items: [...] }`. This release READS both shapes
 * and refuses a version above this constant; it deliberately still WRITES the bare array
 * (see R-49) so that a rollback to the previous binary cannot be bricked by a file it
 * cannot parse. Teaching every reader to detect comes first; changing what is written is
 * the second half of an expand/contract migration, not the same step.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

/**
 * Parse a snapshot file's contents. Fail closed — matching FileStore.load — on
 * empty/whitespace (a corrupt or half-written snapshot) or a non-array payload,
 * so a restore never silently installs a broken store.
 *
 * DATA-16: accepts the versioned envelope as well as the legacy bare array, and refuses a
 * `formatVersion` this binary does not know rather than reading a newer file's items with
 * older assumptions.
 *
 * DATA-5: every row is checked for a string `PK` and `SK` before it reaches the store, and
 * a violation names the ROW INDEX and what it actually found. This is the structural
 * minimum, not schema validation: an item missing `PK`/`SK` used to key as
 * `"undefined\u0000undefined"`, so a whole corrupt file could collapse into one row that
 * silently overwrote itself — parseable, accepted, and unrecoverable. Deliberately NOT a
 * full per-row zod pass (see R-50): a shim guessed at rather than designed against real
 * stored shapes fails a BOOT, not a test.
 */
export function parseSnapshotItems(raw: string): Item[] {
  if (raw.trim().length === 0) {
    throw new Error('snapshot is empty/whitespace — refusing to treat it as a valid store snapshot (corrupt or truncated file).');
  }
  const parsed: unknown = JSON.parse(raw);

  let items: unknown;
  if (Array.isArray(parsed)) {
    items = parsed; // legacy bare array — every snapshot written to date
  } else if (parsed !== null && typeof parsed === 'object' && 'formatVersion' in parsed) {
    const env = parsed as { formatVersion: unknown; items?: unknown };
    if (typeof env.formatVersion !== 'number' || !Number.isInteger(env.formatVersion) || env.formatVersion < 1) {
      throw new Error(`snapshot has an unreadable formatVersion (${JSON.stringify(env.formatVersion)}) — refusing to guess at its shape.`);
    }
    if (env.formatVersion > SNAPSHOT_FORMAT_VERSION) {
      throw new Error(
        `snapshot formatVersion ${env.formatVersion} is newer than this build understands (max ${SNAPSHOT_FORMAT_VERSION}) — ` +
          'refusing to read it with older assumptions. Upgrade the binary, or restore a snapshot this version wrote.',
      );
    }
    if (!Array.isArray(env.items)) throw new Error(`snapshot formatVersion ${env.formatVersion} has no \`items\` array.`);
    items = env.items;
  } else {
    throw new Error('snapshot is not a JSON array of items.');
  }

  const rows = items as unknown[];
  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    if (it === null || typeof it !== 'object' || Array.isArray(it)) {
      throw new Error(`snapshot row ${i} is not an object (found ${it === null ? 'null' : Array.isArray(it) ? 'an array' : typeof it}) — refusing to load a corrupt store.`);
    }
    const r = it as Record<string, unknown>;
    if (typeof r.PK !== 'string' || typeof r.SK !== 'string') {
      // Name the row AND enough of it to find by hand: an operator staring at a refused
      // boot needs to know which line of a 50 MB file to look at.
      const hint = typeof r.PK === 'string' ? `PK ${JSON.stringify(r.PK)}` : typeof r.SK === 'string' ? `SK ${JSON.stringify(r.SK)}` : `keys [${Object.keys(r).slice(0, 6).join(', ')}]`;
      throw new Error(
        `snapshot row ${i} has no string PK/SK (${hint}) — refusing to load. Such a row keys as "undefined/undefined", ` +
          'so every one of them would collapse onto a single entry and silently overwrite the others.',
      );
    }
  }
  return rows as Item[];
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
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  // DATA-6 / DATA-13 — same discipline as FileStore.writeAtomic (ERR-10): the temp file
  // must not leak on ANY failure from here to the rename (not just a failing write/sync —
  // a failing rename itself, e.g. a directory sitting where the target belongs, leaks
  // just as surely), and the directory entry for the rename must be fsync'd so it survives
  // a power loss, not just a process kill. This standalone copy had drifted from that
  // fix — backup/restore ran with neither guarantee.
  const fh = await fsOpen(tmp, 'w');
  try {
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
 * (Same shape as FileStore's private `syncDir` — kept as its own copy here because this
 * module is deliberately standalone, see the module doc comment.)
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
