import { ulid } from 'ulid';
import type { ConfigStore, TransactWrite } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import type { ApplySpec, ChainHeadItem, PendingConfigChangeItem } from '../store/schema';
import { configChangeKey, pendingConfigGsi } from '../store/schema';
import { ApiError } from '../errors';
import { recordIn, transactWithAudit, type AuditEntryInput } from '../domain/audit';
import { nowIso, nowMs } from '../clock';
import { loadAccounts } from './config';
import { roleFor } from '../projects';

/**
 * Dual-control for privilege-affecting config. TIGHTENING applies
 * immediately (single admin). LOOSENING/PRIVILEGE creates a PendingConfigChange that a
 * SECOND distinct active admin must ack. The classification table is transcribed
 * verbatim.
 */

export type Classification = 'tightening' | 'loosening';
export type Role = 'requester' | 'approver' | 'lead';

const RISK_ORDER: Record<'LOW' | 'MEDIUM' | 'HIGH', number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const isSenior = (r: Role): boolean => r === 'approver' || r === 'lead';

type PolicyShape = { low: number; medium: number; high: number; deleteMin: number };

export type ClassifyInput =
  | { target: 'policy'; before: PolicyShape; after: PolicyShape }
  | { target: 'risk'; before: 'LOW' | 'MEDIUM' | 'HIGH'; after: 'LOW' | 'MEDIUM' | 'HIGH' }
  | { target: 'catalog'; enabledBefore: boolean; enabledAfter: boolean }
  | { target: 'freeze'; before: boolean; after: boolean }
  | { target: 'allowlist'; before: string[]; after: string[] }
  | { target: 'role'; before: Role; after: Role }
  | { target: 'admin'; before: boolean; after: boolean }
  | { target: 'projects'; before: string[]; after: string[] }
  | { target: 'account-status'; before: 'active' | 'disabled'; after: 'active' | 'disabled' }
  | { target: 'password-reset'; role: Role }
  | { target: 'enroll'; role: Role; isAdmin: boolean };

/** The classification table. Anything not strictly tightening is loosening. */
export function classify(input: ClassifyInput): Classification {
  switch (input.target) {
    case 'policy': {
      // Any tier or deleteMin DECREASE → loosening; else (all ≥, i.e. increase/no-op) → tightening.
      const ks: Array<keyof PolicyShape> = ['low', 'medium', 'high', 'deleteMin'];
      return ks.some((k) => input.after[k] < input.before[k]) ? 'loosening' : 'tightening';
    }
    case 'risk':
      return RISK_ORDER[input.after] < RISK_ORDER[input.before] ? 'loosening' : 'tightening';
    case 'catalog':
      // disable (enabled true→false) tightens; re-enable (false→true) loosens.
      return input.enabledAfter && !input.enabledBefore ? 'loosening' : 'tightening';
    case 'freeze':
      // freeze ON tightens; freeze OFF loosens.
      return input.after ? 'tightening' : 'loosening';
    case 'allowlist':
      // widen (any new allowed entry) loosens; narrow/equal tightens.
      return input.after.some((x) => !input.before.includes(x)) ? 'loosening' : 'tightening';
    case 'role':
      // grant/revoke touching a senior role loosens; requester↔requester tightens.
      return isSenior(input.before) || isSenior(input.after) ? 'loosening' : 'tightening';
    case 'admin':
      // isAdmin grant OR revoke → loosening (privilege-affecting either way).
      return input.before !== input.after ? 'loosening' : 'tightening';
    case 'projects': {
      // Account↔project binding: WIDENING access (any new project, or granting the
      // all-projects wildcard) loosens; narrowing — including '*' → concrete list —
      // tightens and applies immediately.
      const wasAll = input.before.includes('*');
      const isAll = input.after.includes('*');
      if (isAll) return wasAll ? 'tightening' : 'loosening'; // '*'→'*' is a no-op
      if (wasAll) return 'tightening'; // '*' → a concrete subset narrows
      return input.after.some((x) => !input.before.includes(x)) ? 'loosening' : 'tightening';
    }
    case 'account-status':
      // disable tightens; re-enable (restores access) loosens.
      return input.after === 'disabled' ? 'tightening' : input.before === 'disabled' ? 'loosening' : 'tightening';
    case 'password-reset':
      // requester reset tightens; approver/lead reset loosens.
      return isSenior(input.role) ? 'loosening' : 'tightening';
    case 'enroll':
      // enrolling a senior or admin loosens; a basic requester tightens.
      return isSenior(input.role) || input.isAdmin ? 'loosening' : 'tightening';
  }
}

/** Below this many active senior accounts, the interim
 * single-approver profile is in play for the general requester population (the
 * same "2 active seniors = real quorum for R's request" threshold the whole doc
 * uses). Deliberately a LOCAL constant, conceptually distinct from the 0037
 * approval ladder in exposure.ts (this one is audit-trail context for senior
 * grants, not an approval-count enforcement), so the two stay free to diverge
 * without a hidden coupling between an audit heuristic and the ladder rule. */
const INTERIM_RETIREMENT_THRESHOLD = 2;

/**
 * Does `change` hand an account NEW approval capacity —
 * i.e. its role becomes senior (approver/lead) where it was not already? Scoped
 * to the two account-mutation kinds admin.ts ever proposes for accounts
 * (`role-grant-senior` for enrol, `admin-grant` for PATCH — the same pair
 * Q3 query already treats as "the grants worth watching"). isAdmin-only changes
 * and role DEMOTIONS/revokes are deliberately excluded: isAdmin never affects
 * approval eligibility (ADR-0011; `canSignStep` never reads it), and a
 * demotion is not a "grant". `before`/`after` are the opaque per-target blobs
 * admin.ts hands `commitOrPropose`/stores on the pending change — enrol's
 * `after` is a full `publicAccount` (role always present), patch's is only the
 * CHANGED fields (`set`), so an absent `.role` key correctly reads as "role did
 * not change in this particular mutation".
 */
function grantsApprovalCapacity(change: { kind: string; before?: unknown; after?: unknown }): boolean {
  if (change.kind !== 'role-grant-senior' && change.kind !== 'admin-grant') return false;
  const afterRole = (change.after as { role?: Role } | null | undefined)?.role;
  if (afterRole === undefined || !isSenior(afterRole)) return false;
  const beforeRole = (change.before as { role?: Role } | null | undefined)?.role;
  return beforeRole === undefined || !isSenior(beforeRole);
}

/**
 * Live "is the interim profile currently in play" read, for audit-trail context
 * ONLY — this never gates or enforces anything (requests.ts's own per-tier
 * eligibility check at approval time remains the sole enforcement copy; G2 will
 * refine ITS filter independently). It only decides whether a senior grant's
 * audit entry carries `interimProfile:true`, mirroring the ALREADY-shipped flag
 * on interim approvals (`requests.ts:257`).
 */
async function interimProfileHolds(store: ConfigStore, projectId: string): Promise<boolean> {
  const accounts = await loadAccounts(store);
  // "Active senior" is now PER PROJECT — an approver/lead ON `projectId` (read through
  // the roles shim so new-shape rows count, not just legacy `role`). The interim signal
  // is per-project because the request population it contextualizes is per-project.
  const activeSeniors = accounts.filter((a) => {
    const r = roleFor(a, projectId);
    return (r === 'approver' || r === 'lead') && a.status === 'active';
  }).length;
  return activeSeniors < INTERIM_RETIREMENT_THRESHOLD;
}

export function applyToWrite(apply: ApplySpec): TransactWrite {
  const guard = apply.guardAttr !== undefined ? { attr: apply.guardAttr, value: apply.guardValue } : undefined;
  if (apply.op === 'put') return { kind: 'put', item: apply.item as never, ifNotExists: apply.ifNotExists };
  if (apply.op === 'delete') return { kind: 'delete', pk: apply.pk, sk: apply.sk, ifEquals: guard };
  return { kind: 'update', pk: apply.pk, sk: apply.sk, set: apply.set ?? {}, ifEquals: guard };
}

export type CommitInput = {
  classification: Classification;
  kind: string; // PendingConfigChange.kind (display)
  targetKey: string;
  before: unknown;
  after: unknown;
  apply: ApplySpec;
  audit: AuditEntryInput;
  /**
   * Which project's AUDIT CHAIN the entries land on, when it is not the acting
   * scope. The data-plane project verbs (activate/archive/unarchive in
   * routes/projectData.ts) set this to the TARGET project (security review):
   * the tenant reviewing THEIR chain must see actions performed against them.
   * The pending-change RECORD itself deliberately stays in the acting scope —
   * that is the admin control-plane lane the second admin lists and acks from
   * (the target may not even be routable yet: activation legitimately precedes
   * `complete`). Absent → the acting scope, exactly the old behavior.
   */
  auditProjectId?: string;
};

export type CommitResult =
  | { status: 200; applied: true }
  | { status: 202; pending: PendingConfigChangeItem };

/**
 * The client-safe projection of a pending change — `apply` is the internal
 * re-apply mechanism (op/pk/sk/item/set) and is NOT part of the documented
 * PendingConfigChange contract (openapi/ccp-api.yaml's schema has no `apply`
 * property). For most kinds `apply` is inert, but password-reset-senior and
 * role-grant-senior (enroll into a senior role or `isAdmin:true`) stash a freshly
 * argon2id-hashed `credential` inside `apply.item`/`apply.set` so the SAME write
 * can be replayed verbatim on ack — that hash must never round-trip into a
 * response body (auth/account.ts's `publicAccount` doctrine: "credential material
 * NEVER serializes"). Every handler that serializes a `PendingConfigChangeItem`
 * (commitOrPropose's 202 body, GET /config-changes, ack/reject) must go through
 * this, not `c.json(item)` directly.
 */
export type PublicPendingChange = Omit<PendingConfigChangeItem, 'apply' | 'auditProjectId'>;

export function publicPendingChange(p: PendingConfigChangeItem): PublicPendingChange {
  const { apply: _apply, auditProjectId: _auditProjectId, ...rest } = p;
  return rest;
}

/** Apply immediately (tightening) or create a PendingConfigChange (loosening). */
export async function commitOrPropose(
  store: ConfigStore,
  projectId: string,
  proposedBy: string,
  input: CommitInput,
): Promise<CommitResult> {
  // The chain the trail lands on; the pending RECORD stays in `projectId`.
  const auditChain = input.auditProjectId ?? projectId;
  if (input.classification === 'tightening') {
    await transactWithAudit(store, auditChain, [applyToWrite(input.apply)], input.audit);
    return { status: 200, applied: true };
  }
  const id = ulid();
  const now = nowIso();
  const pending: PendingConfigChangeItem = {
    ...configChangeKey(projectId, id),
    id,
    kind: input.kind,
    before: input.before,
    after: input.after,
    targetKey: input.targetKey,
    apply: input.apply,
    proposedBy,
    proposedAt: now,
    status: 'PENDING',
    expiresAt: new Date(nowMs() + 72 * 60 * 60 * 1000).toISOString(),
    GSI1PK: pendingConfigGsi(projectId),
    GSI1SK: id,
    // Persisted so ack/reject route their config-apply/config-reject entries
    // (and the lifecycle hook its named events) to the SAME chain as propose.
    ...(input.auditProjectId !== undefined ? { auditProjectId: input.auditProjectId } : {}),
  };
  // Flag senior/admin grants proposed while the interim
  // single-approver profile holds (fewer than INTERIM_RETIREMENT_THRESHOLD active
  // seniors) — cheap (one extra store read) and only ever runs for account-mutation
  // kinds, so policy/settings/risk/catalog proposals pay nothing extra.
  const flagInterim = grantsApprovalCapacity(input) && (await interimProfileHolds(store, projectId));
  await transactWithAudit(store, auditChain, [{ kind: 'put', item: pending, ifNotExists: true }], {
    action: 'config-propose',
    actor: proposedBy,
    targetType: 'config-change',
    targetId: id,
    after: { kind: input.kind, targetKey: input.targetKey, kindOfChange: 'loosening' },
    ...(flagInterim ? { interimProfile: true } : {}),
  });
  return { status: 202, pending };
}

/** Second DISTINCT active admin applies the change. */
export async function ackPending(
  store: ConfigStore,
  projectId: string,
  ackerId: string,
  pendingId: string,
): Promise<PendingConfigChangeItem> {
  const k = configChangeKey(projectId, pendingId);
  const pending = (await store.get(k.PK, k.SK)) as PendingConfigChangeItem | null;
  if (!pending) throw new ApiError('STATE_CONFLICT');
  if (pending.status !== 'PENDING') throw new ApiError('STATE_CONFLICT');
  if (pending.proposedBy === ackerId) throw new ApiError('SELF_ACK');
  const apply = pending.apply;
  if (!apply) throw new ApiError('STATE_CONFLICT');

  // Drift check: the target must still match the captured before-guard. A guarded
  // update/delete whose target row no longer EXISTS is definitionally stale too —
  // without the explicit existence check, a captured guard value of `undefined`
  // (a legacy row that predates the guarded attribute) would "match" a deleted row
  // and the replay would resurrect a ghost item. (The store's ifEquals also fails
  // closed on a missing row, so the transact below backstops this race-free.)
  if (apply.guardAttr !== undefined) {
    const cur = await store.get(apply.pk, apply.sk);
    if (!cur && apply.op !== 'put') throw new ApiError('STALE_PROPOSAL');
    const actual = cur ? (cur as Record<string, unknown>)[apply.guardAttr] : undefined;
    if (actual !== apply.guardValue) throw new ApiError('STALE_PROPOSAL');
  }
  if (apply.op === 'put' && apply.ifNotExists) {
    if (await store.get(apply.pk, apply.sk)) throw new ApiError('STALE_PROPOSAL');
  }

  const now = nowIso();
  const applied: PendingConfigChangeItem = { ...pending, status: 'APPLIED', ackBy: ackerId, ackAt: now };
  const domain: TransactWrite[] = [
    applyToWrite(apply),
    { kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'APPLIED', ackBy: ackerId, ackAt: now, GSI1PK: undefined } },
  ];
  // Carry the target account/setting onto config-apply itself
  // (previously it lived ONLY on the paired config-propose entry, joined by targetId
  // — a reviewer scanning just the applies had to cross-reference) and flag
  // interim-era senior grants. Recomputed fresh HERE rather than reusing the
  // propose-time flag: ack can land long after propose (a different admin, hours or
  // days later per the 72h window), and the estate's active-senior count may have
  // changed in between — the flag should describe the state at which the grant
  // actually took effect, not a stale snapshot from proposal time.
  const flagInterim = grantsApprovalCapacity(pending) && (await interimProfileHolds(store, projectId));
  const audit: AuditEntryInput = {
    action: 'config-apply',
    actor: ackerId,
    targetType: 'config-change',
    targetId: pending.id,
    before: { proposedBy: pending.proposedBy, before: pending.before },
    after: { ackBy: ackerId, after: pending.after, kind: pending.kind, targetKey: pending.targetKey },
    ...(flagInterim ? { interimProfile: true } : {}),
  };

  // The apply entry must land on the SAME chain as its propose (the target
  // project's, when the proposal carried one — data-plane verbs do).
  const auditChain = pending.auditProjectId ?? projectId;
  const hKey = { PK: `P#${auditChain}#AUDIT`, SK: 'CHAINHEAD' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes } = recordIn(auditChain, head, audit);
    try {
      await store.transact([...domain, ...writes]);
      return applied;
    } catch (e) {
      if (e instanceof ConditionError) {
        // distinguish drift from chain contention
        if (apply.guardAttr !== undefined) {
          const cur = await store.get(apply.pk, apply.sk);
          if (!cur && apply.op !== 'put') throw new ApiError('STALE_PROPOSAL');
          const actual = cur ? (cur as Record<string, unknown>)[apply.guardAttr] : undefined;
          if (actual !== apply.guardValue) throw new ApiError('STALE_PROPOSAL');
        }
        if (attempt === 0) continue;
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  throw new ApiError('CHAIN_CONTENTION');
}

export async function rejectPending(
  store: ConfigStore,
  projectId: string,
  actorId: string,
  pendingId: string,
): Promise<PendingConfigChangeItem> {
  const k = configChangeKey(projectId, pendingId);
  const pending = (await store.get(k.PK, k.SK)) as PendingConfigChangeItem | null;
  if (!pending) throw new ApiError('STATE_CONFLICT');
  if (pending.status !== 'PENDING') throw new ApiError('STATE_CONFLICT');
  const now = nowIso();
  const rejected: PendingConfigChangeItem = { ...pending, status: 'REJECTED', ackBy: actorId, ackAt: now };
  await transactWithAudit(
    store,
    // Same chain as the propose entry — a target-chained proposal's resolution
    // must not strand its config-propose without a paired outcome.
    pending.auditProjectId ?? projectId,
    [{ kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'REJECTED', ackBy: actorId, ackAt: now, GSI1PK: undefined } }],
    { action: 'config-reject', actor: actorId, targetType: 'config-change', targetId: pending.id },
  );
  return rejected;
}

/** Flip PENDING items past their 72h TTL to EXPIRED. Returns the count swept. */
export async function sweepExpired(store: ConfigStore, projectId: string, now: number = nowMs()): Promise<number> {
  const pending = (await store.queryGSI1(pendingConfigGsi(projectId))) as PendingConfigChangeItem[];
  let swept = 0;
  for (const p of pending) {
    if (p.status === 'PENDING' && Date.parse(p.expiresAt) < now) {
      const k = configChangeKey(projectId, p.id);
      await store.put({ ...p, status: 'EXPIRED', GSI1PK: undefined });
      swept++;
    }
  }
  return swept;
}
