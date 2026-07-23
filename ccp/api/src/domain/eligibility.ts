import type { ConfigStore } from '../store/configStore';
import type { AccountItem, RoleName } from '../store/schema';
import { loadAccounts } from './config';
import { roleFor } from '../projects';
import { totpDevicesOf } from '../auth/totp';
import type { LadderStep } from './exposure';

/**
 * Per-step signing eligibility — the ladder's WHO (0037 Feature B). Each ladder step
 * names the MINIMUM role that may sign it:
 *   L2 (first approver) → `approver` OR `lead`
 *   L3 (final approver) → `lead` only
 * `isAdmin` is deliberately never consulted (ADR-0011: admin is a capability, not an
 * approval seniority). This is the single source of truth the approve handler gates the
 * NEXT step on; there is no separate tier→role rule anymore.
 */
export function canSignStep(step: LadderStep, role: RoleName | undefined): boolean {
  return step === 'L3' ? role === 'lead' : role === 'approver' || role === 'lead';
}

/**
 * 0021 F2/G2 — "eligible approver" counted too broadly. `requests.ts` used to filter
 * the GLOBAL directory (`config.ts:loadAccounts`) by role, `status==='active'`, and
 * `≠ requester` only — NOT by project binding (enforced everywhere else,
 * `projects.ts:isBoundToProject`) and NOT by activation (`mustChangePassword`, `totp`
 * unset). This is the single shared source of truth for "does this account count as a
 * candidate signer for this request", used ONLY by G5 feasibility surfacing now (0037
 * removed the interim single-approver profile that also read it).
 *
 * Tier-INDEPENDENT by design (0037): a candidate signer is any project-bound, activated
 * approver-or-lead who isn't the requester — because every ladder's L2 step admits
 * approver-or-lead. WHETHER the ladder can actually COMPLETE (its L3 step needs a lead)
 * is `computeFeasibility`'s job, which splits this set by role.
 *
 * PER-PROJECT (0014 dim-5): the role is now the caller's role ON `projectId`
 * (`roleFor`). A defined approver/lead result IS proof of membership, so the separate
 * `isBoundToProject` call is gone — an account senior on project A but only a requester
 * (or a non-member) on B cannot sign B's requests.
 */
export function isEligibleApprover(a: AccountItem, projectId: string, requesterId: string): boolean {
  const r = roleFor(a, projectId);
  return (
    (r === 'approver' || r === 'lead') &&
    a.status === 'active' &&
    a.id !== requesterId &&
    a.mustChangePassword === false &&
    // ADR-0024 shim — same truth value as `a.totp !== undefined` pre-migration.
    totpDevicesOf(a).length > 0
  );
}

/**
 * The candidate-signer set for a request: an active, project-bound, ACTIVATED (password
 * changed + TOTP enrolled) approver-or-lead who isn't the requester. Returns the
 * accounts (not just a count) so `computeFeasibility` can split leads from approvers for
 * the ladder's L3-needs-a-lead check.
 */
export async function eligibleApprovers(
  store: ConfigStore,
  projectId: string,
  requesterId: string,
): Promise<AccountItem[]> {
  const accounts = await loadAccounts(store);
  return accounts.filter((a) => isEligibleApprover(a, projectId, requesterId));
}
