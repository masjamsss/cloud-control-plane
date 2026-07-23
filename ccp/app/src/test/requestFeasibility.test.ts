import { describe, expect, it } from 'vitest';
import { feasibilityNotice, hasFeasibility } from '@/lib/requestFeasibility';

/**
 * 0021 G5 feasibility-honesty coverage: `hasFeasibility` is the presence-
 * based guard that decides "did this come from the server" (mock-mode
 * objects never carry these keys at all — the mock has no eligibility
 * directory to compute them from); `feasibilityNotice` is the exact copy
 * for the two notices, which must never appear when quorum is comfortably
 * satisfiable.
 */

describe('hasFeasibility — presence guard (the honest way to know "server-computed")', () => {
  it('true when all three fields are present', () => {
    expect(hasFeasibility({ eligibleApprovers: 3, feasible: true, interimProfileWillApply: false })).toBe(true);
  });

  it('false when any field is missing (a mock-mode ChangeRequest, or a partial object)', () => {
    expect(hasFeasibility({})).toBe(false);
    expect(hasFeasibility({ eligibleApprovers: 3 })).toBe(false);
    expect(hasFeasibility({ eligibleApprovers: 3, feasible: true })).toBe(false);
  });

  it('false for undefined/null', () => {
    expect(hasFeasibility(undefined)).toBe(false);
    expect(hasFeasibility(null)).toBe(false);
  });

  it('false when a field has the wrong type (defensive against a malformed payload)', () => {
    expect(
      hasFeasibility({ eligibleApprovers: '3' as unknown as number, feasible: true, interimProfileWillApply: false }),
    ).toBe(false);
  });
});

describe('feasibilityNotice — the 0021 G5 infeasibility notice (0037 ladder), never a submission gate', () => {
  it('feasible: no notice at all — the ladder can be completed', () => {
    expect(feasibilityNotice({ eligibleApprovers: 3, feasible: true, interimProfileWillApply: false })).toBeNull();
  });

  it('infeasible: tone "infeasible", names the missing lead for the final approval, and reassures nothing was blocked (ADR-0008)', () => {
    const notice = feasibilityNotice({ eligibleApprovers: 1, feasible: false, interimProfileWillApply: false });
    expect(notice?.tone).toBe('infeasible');
    expect(notice?.text).toMatch(/eligible approver/i);
    expect(notice?.text).toMatch(/lead for the final approval/i);
    expect(notice?.text).toMatch(/nothing was blocked/i);
  });

  it('no "interim" notice exists anymore (0037 disabled the single-approver interim profile)', () => {
    // Even a stale interimProfileWillApply:true never produces an interim notice: the
    // function keys only on `feasible`. A feasible request → null; an infeasible one →
    // the single infeasible notice.
    expect(feasibilityNotice({ eligibleApprovers: 1, feasible: true, interimProfileWillApply: true })).toBeNull();
    expect(feasibilityNotice({ eligibleApprovers: 0, feasible: false, interimProfileWillApply: true })?.tone).toBe('infeasible');
  });
});
