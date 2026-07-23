import { beforeEach, describe, expect, it } from 'vitest';
import { approvalsFor, getPolicy, resetPolicyForTests, setPolicy } from '@/lib/policy';

beforeEach(() => resetPolicyForTests());

describe('defaults', () => {
  it('is 1 low / 1 medium / 2 high, delete floor 2', () => {
    expect(getPolicy()).toEqual({ low: 1, medium: 1, high: 2, deleteMin: 2 });
  });
});

describe('approvalsFor', () => {
  it('uses the risk tier for non-deletes', () => {
    expect(approvalsFor('LOW', 'Change')).toBe(1);
    expect(approvalsFor('MEDIUM', 'Change')).toBe(1);
    expect(approvalsFor('HIGH', 'Change')).toBe(2);
    expect(approvalsFor('LOW', 'Add')).toBe(1);
  });
  it('raises a delete to at least the delete floor', () => {
    expect(approvalsFor('LOW', 'Delete')).toBe(2); // max(1, 2)
    expect(approvalsFor('HIGH', 'Delete')).toBe(2); // max(2, 2)
  });
});

describe('editing the policy', () => {
  it('persists and takes effect', () => {
    setPolicy({ high: 3 });
    expect(getPolicy().high).toBe(3);
    expect(approvalsFor('HIGH', 'Change')).toBe(3);
  });
  it('clamps to [1, 5] — never 0 (nothing auto-applies)', () => {
    expect(setPolicy({ low: 0 }).low).toBe(1);
    expect(setPolicy({ high: 99 }).high).toBe(5);
  });
  it('a lowered delete floor lets a low-risk delete need just 1', () => {
    setPolicy({ deleteMin: 1 });
    expect(approvalsFor('LOW', 'Delete')).toBe(1);
  });
});
