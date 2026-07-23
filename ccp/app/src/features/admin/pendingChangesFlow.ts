import type { HttpApiClient, ServerPendingChange } from '@/lib/httpApi';
import {
  acknowledgePendingChange,
  listPendingChanges,
  pendingCount,
  rejectPendingChange,
  summarizePending,
  type PendingConfigChange,
} from '@/lib/pendingChanges';

/**
 * The dual-control queue's ADVISORY → AUTHORITATIVE branch (pattern;
 * see teamsFlow.ts). `can('pendingChanges')` flips true the instant
 * ccp-api serves GET /admin/config-changes + ack/reject — the REAL
 * state machine: a second DISTINCT admin applies a proposal (the server
 * refuses a self-ack), reject withdraws it, and a decision replays the
 * captured write with its drift guard. The non-authoritative branch is the
 * exact pre-existing lib/pendingChanges local behavior (only ever reachable
 * through armed controls).
 *
 * Server list semantics: GET /admin/config-changes returns PENDING items only
 * (a decided item leaves the pending GSI; its disposition lives in the audit
 * chain). Ack/reject return the decided item so the UI can show the outcome
 * without pretending the list still holds it.
 */

export type PendingRowStatus =
  | 'PENDING'
  | 'ACKED' // local store's name for an applied decision
  | 'APPLIED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SUPERSEDED';

export interface PendingRow {
  id: string;
  kind: string;
  proposedBy: string;
  proposedAt: string;
  expiresAt: string;
  status: PendingRowStatus;
  /** One-line before→after, e.g. "SETTING#freeze.global: true → false". */
  summary: string;
}

function serverRow(item: ServerPendingChange): PendingRow {
  return {
    id: item.id,
    kind: item.kind,
    proposedBy: item.proposedBy,
    proposedAt: item.proposedAt,
    expiresAt: item.expiresAt,
    status: item.status,
    summary: summarizePending(item),
  };
}

function localRow(item: PendingConfigChange): PendingRow {
  return {
    id: item.id,
    kind: item.kind,
    proposedBy: item.proposedBy,
    proposedAt: item.proposedAt,
    expiresAt: item.expiresAt,
    status: item.status,
    summary: summarizePending(item),
  };
}

/** The local store's snapshot — synchronous, so a mock build (and a server
 * render) lists the queue on first paint, exactly as it always has. */
export function localPendingRows(): PendingRow[] {
  return listPendingChanges().map(localRow);
}

export async function loadPendingRowsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
): Promise<PendingRow[]> {
  if (authoritative && client) {
    const items = await client.listAdminConfigChanges();
    // The GSI returns ulid-ascending (oldest first) — the queue reads newest-first.
    return items.map(serverRow).reverse();
  }
  return localPendingRows();
}

/** How many proposals await a second admin — what PendingChangesBanner counts. */
export async function loadPendingCountVia(
  authoritative: boolean,
  client: HttpApiClient | null,
): Promise<number> {
  if (authoritative && client) {
    const items = await client.listAdminConfigChanges();
    return items.filter((i) => i.status === 'PENDING').length;
  }
  return pendingCount();
}

/** Apply a proposal as the second admin. Throws with the server's reason
 * when refused (SELF_ACK, STALE_PROPOSAL, STATE_CONFLICT…). Returns the
 * decided row so the caller can show the outcome honestly. */
export async function ackPendingVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<PendingRow | undefined> {
  if (authoritative && client) {
    return serverRow(await client.ackAdminConfigChange(id));
  }
  const items = acknowledgePendingChange(id);
  const item = items.find((c) => c.id === id);
  return item ? localRow(item) : undefined;
}

export async function rejectPendingVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<PendingRow | undefined> {
  if (authoritative && client) {
    return serverRow(await client.rejectAdminConfigChange(id));
  }
  const items = rejectPendingChange(id);
  const item = items.find((c) => c.id === id);
  return item ? localRow(item) : undefined;
}
