import { MemoryStore } from '../../src/store/memoryStore';
import type { AuditItem } from '../../src/store/schema';
import { record, type AuditEntryInput } from '../../src/domain/audit';

/**
 * Single source of truth for the golden audit chain. The committed
 * `audit-chain-golden.json` is produced FROM this; the test regenerates from here
 * and byte-compares, so any drift in the hash algorithm fails loudly.
 */
export const GOLDEN_IDS = ['u0', 'u1', 'u2', 'u3', 'u4'];
export const goldenAt = (i: number): string => `2026-07-11T09:00:0${i}.000Z`;

export const GOLDEN_ENTRIES: AuditEntryInput[] = [
  { action: 'login-success', actor: 'putra', targetType: 'session', targetId: 'putra' },
  { action: 'submit', actor: 'sari', targetType: 'request', targetId: 'REQ1', requestId: 'REQ1', after: { status: 'AWAITING_CODE_REVIEW' } },
  { action: 'approve', actor: 'budi', targetType: 'request', targetId: 'REQ1', requestId: 'REQ1', before: { approvals: 0 }, after: { approvals: 1 } },
  { action: 'policy-change', actor: 'putra', targetType: 'policy', targetId: 'POLICY', before: { high: 2 }, after: { high: 1 }, interimProfile: true },
  { action: 'role-grant', actor: 'putra', targetType: 'account', targetId: 'sari', after: { role: 'approver' } },
];

export async function generateGoldenItems(): Promise<AuditItem[]> {
  const store = new MemoryStore();
  for (let i = 0; i < GOLDEN_ENTRIES.length; i++) {
    await record(store, 'sample', GOLDEN_ENTRIES[i]!, { idFn: () => GOLDEN_IDS[i]!, nowFn: () => goldenAt(i) });
  }
  return (await store.query('P#sample#AUDIT#202607')) as AuditItem[];
}
