import { describe, expect, it } from 'vitest';
import type { Account } from '@/lib/accounts';
import { eligibleApproverCount, maxSatisfiableApprovals, quorumWarning } from '@/lib/quorum';

function acct(role: Account['role'], status: Account['status'] = 'active'): Account {
  return {
    id: 'x', username: 'x', displayName: 'X', role, teamId: 't',
    passwordHash: '', salt: '', iterations: 1, status, createdAt: '', createdBy: 's',
  };
}

describe('quorum feasibility (ADR-0009 interim)', () => {
  it('counts only active approvers and leads', () => {
    const accounts = [acct('lead'), acct('approver'), acct('requester'), acct('approver', 'disabled')];
    expect(eligibleApproverCount(accounts)).toBe(2);
  });

  it('max satisfiable is eligible minus one (requester may be an approver)', () => {
    expect(maxSatisfiableApprovals(1)).toBe(0);
    expect(maxSatisfiableApprovals(2)).toBe(1);
    expect(maxSatisfiableApprovals(3)).toBe(2);
  });

  it('warns when the required count cannot be met', () => {
    // Only the seed Lead exists → max satisfiable 0 → even 1 approval is infeasible.
    expect(quorumWarning(1, 0)).toMatch(/only 1 eligible approver exists/);
    // Two eligible → 1 achievable, so a 2-approval Delete is infeasible.
    expect(quorumWarning(2, 1)).toMatch(/at most 1/);
  });

  it('is silent when the policy is satisfiable', () => {
    expect(quorumWarning(1, 1)).toBeNull();
    expect(quorumWarning(2, 2)).toBeNull();
  });
});
