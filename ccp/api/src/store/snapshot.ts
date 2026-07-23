import { randomBytes } from 'node:crypto';
import { open as fsOpen, mkdir, rename } from 'node:fs/promises';
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
 * Parse a snapshot file's contents. Fail closed — matching FileStore.load — on
 * empty/whitespace (a corrupt or half-written snapshot) or a non-array payload,
 * so a restore never silently installs a broken store.
 */
export function parseSnapshotItems(raw: string): Item[] {
  if (raw.trim().length === 0) {
    throw new Error('snapshot is empty/whitespace — refusing to treat it as a valid store snapshot (corrupt or truncated file).');
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('snapshot is not a JSON array of items.');
  return parsed as Item[];
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
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fh = await fsOpen(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}
