import type { ConfigStore } from '../store/configStore';
import type { LadderStep } from './exposure';
import { eligibleApprovers } from './eligibility';
import { roleFor } from '../projects';

/**
 * 0021 F5/G5 — quorum-infeasibility surfacing, re-expressed for the 0037 ladder.
 * Submit computes the ladder but never the eligible count: a request that could never
 * complete (no bound/activated signer besides the requester, or no lead for the L3 step)
 * would sit open forever with no signal. This is server truth, computed with the
 * G2-corrected filter and the ladder's role requirements:
 *   - `feasible`: enough DISTINCT candidate signers exist to fill every ladder step, AND
 *     (when the ladder has an L3 step) at least one of them is a lead.
 *   - `eligibleApprovers`: the count of candidate signers (approver-or-lead, bound,
 *     activated, ≠ requester) — a lead for L3 is drawn from this same set.
 *
 * ADR-0008 preserved: infeasibility NEVER blocks submission — it only informs; this
 * module never gates anything.
 *
 * `interimProfileWillApply` is retained on the wire shape for compatibility but is now
 * ALWAYS false: 0037 disabled the single-approver interim profile at its entry point, so
 * no request ever completes on fewer distinct signers than its ladder has steps.
 */
export type Feasibility = {
  eligibleApprovers: number;
  feasible: boolean;
  interimProfileWillApply: boolean;
};

export async function computeFeasibility(
  store: ConfigStore,
  projectId: string,
  ladder: LadderStep[],
  requesterId: string,
): Promise<Feasibility> {
  const signers = await eligibleApprovers(store, projectId, requesterId);
  const total = signers.length;
  // Per-project: a lead for the L3 step is one whose role ON THIS project is 'lead'.
  const leads = signers.filter((a) => roleFor(a, projectId) === 'lead').length;
  const needsLead = ladder.includes('L3');
  const feasible = total >= ladder.length && (!needsLead || leads >= 1);
  return { eligibleApprovers: total, feasible, interimProfileWillApply: false };
}
