import type { ConfigStore } from '../store/configStore';
import type { AuditItem, ChainHeadItem } from '../store/schema';
import { auditKey, chainHead } from '../store/schema';
import { verifyChain, type ChainEntry, type VerifyResult } from './audit';

/**
 * Read-side of the audit chain for the admin surface. The chain is partitioned
 * by month (`P#<project>#AUDIT#<yyyymm>`), so to gather the whole chain we walk
 * month partitions BACKWARD from now, accumulating until we have exactly the
 * CHAINHEAD `count` entries — a deterministic, bounded traversal that needs no
 * table scan (staying within the DynamoDB-shaped ConfigStore seam).
 */

/** The `AuditEntry` projection served to clients (drops PK/SK/projectId storage keys). */
export type AuditEntry = ChainEntry;

export function toAuditEntry(item: AuditItem): AuditEntry {
  const e: AuditEntry = {
    id: item.id,
    at: item.at,
    actor: item.actor,
    action: item.action,
    targetType: item.targetType,
    targetId: item.targetId,
    prevHash: item.prevHash,
    hash: item.hash,
  };
  if (item.before !== undefined) e.before = item.before;
  if (item.after !== undefined) e.after = item.after;
  if (item.requestId !== undefined) e.requestId = item.requestId;
  if (item.interimProfile !== undefined) e.interimProfile = item.interimProfile;
  return e;
}

/** All chain entries oldest→newest, plus the current head (or null at genesis). */
export async function readAuditChronological(
  store: ConfigStore,
  projectId: string,
): Promise<{ entries: AuditItem[]; head: ChainHeadItem | null }> {
  const hKey = chainHead(projectId);
  const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
  const total = head?.count ?? 0;
  if (total === 0) return { entries: [], head };

  const monthPk = (d: Date): string => auditKey(projectId, `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`, '').PK;
  const chunks: AuditItem[][] = [];
  let collected = 0;
  const d = new Date();
  for (let i = 0; i < 120 && collected < total; i++) {
    const chunk = (await store.query(monthPk(d))) as AuditItem[]; // SK-ascending within a month
    if (chunk.length > 0) {
      chunks.push(chunk);
      collected += chunk.length;
    }
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  // chunks are newest-month-first; reverse → oldest-month-first, each already SK-ascending.
  return { entries: chunks.reverse().flat(), head };
}

export type AuditExport = {
  projectId: string;
  head: string;
  count: number;
  verified: boolean;
  verification: VerifyResult;
  entries: AuditEntry[];
};

/** The full chain as a self-verifying evidence document (chronological, head-checked). */
export async function exportAuditChain(store: ConfigStore, projectId: string): Promise<AuditExport> {
  const { entries, head } = await readAuditChronological(store, projectId);
  const verification = verifyChain(entries as unknown as ChainEntry[], head ? { head: head.hash } : undefined);
  return {
    projectId,
    head: head?.hash ?? '',
    count: head?.count ?? 0,
    verified: verification.code === 0,
    verification,
    entries: entries.map(toAuditEntry),
  };
}
