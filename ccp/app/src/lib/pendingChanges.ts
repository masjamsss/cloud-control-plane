import { scopedKey } from '@/lib/projectScope';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/session';

/**
 * The dual-control queue — render layer
 * only, per this plan's arming rule. A real ccp-api creates one of these
 * server-side when a second admin's acknowledgement is actually required before
 * a change takes effect; nothing today wires a write path (setters
 * still apply immediately — advisory, local, same as everything else in this
 * plan) into {@link proposePendingChange}. This store exists so the render
 * layer — the banner + the "Pending changes" tab — has a real, testable shape
 * to show ahead of the real state machine landing.
 *
 * Advisory (local store, same pattern as settings.ts/audit.ts): persisted
 * locally, project-scoped, with an in-memory fallback when storage is
 * unavailable. The ack/reject WRITE exists here but is only ever reachable
 * through the UI's <AdvisoryControl>-gated buttons (features/admin/PendingChanges.tsx).
 */
export interface PendingConfigChange {
  id: string;
  /** Account id of the admin who proposed the change. */
  proposedBy: string;
  /** Short domain tag, e.g. 'limits', 'notifications', 'maintenanceWindows'. */
  kind: string;
  before: unknown;
  after: unknown;
  /** Which specific setting/entity this change targets, e.g. 'limits.submissionsPerHour'. */
  targetKey: string;
  proposedAt: string; // ISO
  expiresAt: string; // ISO
  status: 'PENDING' | 'ACKED' | 'REJECTED';
}

const storeKey = (): string => scopedKey('pendingChanges');
const memory = new Map<string, string>();
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Hard cap on stored items — mirrors audit.ts's CAP=500.
 * Unlike audit.ts, this store previously had NO cap: acknowledge/reject only
 * flip `status` in place, nothing ever removed an item, so an active project could
 * grow this array forever. Past the localStorage quota, `writeRaw`'s try/catch
 * silently falls back to the in-memory Map — every subsequent propose stops
 * persisting across reloads with no visible error (silent data loss). Pruned
 * oldest-first on every propose, same as audit.ts.
 */
export const PENDING_CHANGES_CAP = 500;

function readRaw(): string | null {
  try {
    return localStorage.getItem(storeKey());
  } catch {
    return memory.get(storeKey()) ?? null;
  }
}
function writeRaw(value: string): void {
  try {
    localStorage.setItem(storeKey(), value);
  } catch {
    memory.set(storeKey(), value);
  }
}

function load(): PendingConfigChange[] {
  const raw = readRaw();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingConfigChange[]) : [];
  } catch {
    return [];
  }
}
function save(items: PendingConfigChange[]): void {
  writeRaw(JSON.stringify(items));
}

/** Newest-proposed first. */
export function listPendingChanges(): PendingConfigChange[] {
  return load()
    .slice()
    .sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : a.proposedAt > b.proposedAt ? -1 : 0));
}

export function getPendingChange(id: string): PendingConfigChange | undefined {
  return load().find((c) => c.id === id);
}

/** How many items are still awaiting a decision — what the banner counts. */
export function pendingCount(): number {
  return load().filter((c) => c.status === 'PENDING').length;
}

export interface ProposePendingChangeInput {
  proposedBy: string;
  kind: string;
  before: unknown;
  after: unknown;
  targetKey: string;
  /** Defaults to 7 days from now. */
  expiresAt?: string;
}

/** Record a proposed config change (status PENDING). See the module doc — this
 * is the render layer's fixture/seed path, not (yet) wired to a real write. */
export function proposePendingChange(input: ProposePendingChangeInput): PendingConfigChange {
  const items = load();
  const now = new Date();
  const item: PendingConfigChange = {
    id: crypto.randomUUID(),
    proposedBy: input.proposedBy,
    kind: input.kind,
    before: input.before,
    after: input.after,
    targetKey: input.targetKey,
    proposedAt: now.toISOString(),
    expiresAt: input.expiresAt ?? new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
    status: 'PENDING',
  };
  // Unshift (not push): newest-first by construction, so two proposals that
  // land in the same millisecond still order correctly (listPendingChanges'
  // sort is a stable tie-break on proposedAt, not the sole ordering signal).
  items.unshift(item);
  // Prune oldest-first so the store never exceeds PENDING_CHANGES_CAP.
  // Every item is always unshifted here and never reordered
  // elsewhere (ack/reject flip `status` in place, they don't move it), so array
  // position IS chronological order: index 0 is newest, the tail is oldest —
  // slicing to the cap keeps the newest items and drops the rest, exactly
  // mirroring audit.ts's `entries.slice(0, CAP)`.
  save(items.slice(0, PENDING_CHANGES_CAP));
  return item;
}

/** Advisory local transition PENDING → ACKED. A no-op (never throws) for an
 * unknown id or an item that already has a decision — a decision, once made,
 * doesn't flip again from this path (the real dual-control state machine is
 * api). */
export function acknowledgePendingChange(id: string): PendingConfigChange[] {
  const items = load();
  const item = items.find((c) => c.id === id);
  if (item && item.status === 'PENDING') {
    item.status = 'ACKED';
    save(items);
    recordAudit(
      getCurrentUser().id,
      'Acknowledged pending change',
      `${item.kind} · ${item.targetKey}`,
    );
  }
  return items;
}

/** Advisory local transition PENDING → REJECTED. Same no-op guarantees as
 * {@link acknowledgePendingChange}. */
export function rejectPendingChange(id: string): PendingConfigChange[] {
  const items = load();
  const item = items.find((c) => c.id === id);
  if (item && item.status === 'PENDING') {
    item.status = 'REJECTED';
    save(items);
    recordAudit(getCurrentUser().id, 'Rejected pending change', `${item.kind} · ${item.targetKey}`);
  }
  return items;
}

function formatValue(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Pure: a one-line before→after summary, e.g. "limits.submissionsPerHour: 50 → 80".
 * Structurally typed on the three fields it reads so ccp-api's
 * PendingConfigChange projection (features/admin/pendingChangesFlow.ts)
 * summarizes through the SAME line as the local store's items. */
export function summarizePending(
  item: Pick<PendingConfigChange, 'targetKey' | 'before' | 'after'>,
): string {
  return `${item.targetKey}: ${formatValue(item.before)} → ${formatValue(item.after)}`;
}

/** Test-only reset. */
export function resetPendingChangesForTests(): void {
  writeRaw('[]');
}
