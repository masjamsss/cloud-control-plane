import { listAccounts } from '@/lib/accounts';

/**
 * Quorum feasibility (single-approver interim). The tool must be honest
 * when a policy can't actually be met: if a request needs N approvals but fewer
 * than N eligible approvers exist, it can never reach APPLIED — show that instead
 * of silently letting it sit or under-approving.
 *
 * A request needs N DISTINCT approvers who are not the requester. Worst case the
 * requester is themselves an approver/lead, so satisfying N needs N+1 eligible
 * approvers in the pool. Hence maxSatisfiable = eligible - 1 (never below 0).
 *
 * MOCK-MODE ONLY: this estimates feasibility from the local account
 * directory, which is legitimate ground truth only because the mock IS that
 * directory. Against ccp-api, the real eligibility filter also
 * requires project-binding and activation this local count knows nothing
 * about — so api-mode surfaces feasibility from the server's own fields
 * instead (see lib/requestFeasibility.ts) and never calls into this module.
 */

/** Active accounts that may approve (approver or lead). */
export function eligibleApproverCount(accounts = listAccounts()): number {
  return accounts.filter(
    (a) => a.status === 'active' && (a.role === 'approver' || a.role === 'lead'),
  ).length;
}

/** The largest approval count any single request can actually reach right now. */
export function maxSatisfiableApprovals(eligible = eligibleApproverCount()): number {
  return Math.max(0, eligible - 1);
}

/** A human warning when `required` approvals can't be met, or null when feasible. */
export function quorumWarning(required: number, max = maxSatisfiableApprovals()): string | null {
  if (required <= max) return null;
  const eligible = max + 1;
  return (
    `This needs ${required} approval${required > 1 ? 's' : ''}, but only ${eligible} ` +
    `eligible approver${eligible === 1 ? '' : 's'} ${eligible === 1 ? 'exists' : 'exist'} — ` +
    `a request can reach at most ${max}. Enrol another Approver under Admin → Users.`
  );
}
