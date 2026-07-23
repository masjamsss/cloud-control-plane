import { beforeEach, describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { getOperation } from '@/lib/interpreter';
import { approvalsRequiredFor } from '@/lib/permissions';
import { resetPolicyForTests } from '@/lib/policy';
import {
  clearRiskOverride,
  getRiskOverride,
  resetRiskOverridesForTests,
  resolveRisk,
  setRiskOverride,
} from '@/lib/riskOverrides';

beforeEach(() => {
  resetRiskOverridesForTests();
  resetPolicyForTests();
});

function op(id: string) {
  const found = getOperation(id, manifests);
  if (!found) throw new Error('missing op ' + id);
  return found;
}

describe('resolveRisk', () => {
  it('returns the manifest floor when no override', () => {
    const o = op('cloudwatch-alarm-threshold'); // LOW
    expect(resolveRisk(o)).toBe('LOW');
    expect(getRiskOverride(o.id)).toBeUndefined();
  });
  it('returns the override when set, and reverts on clear', () => {
    const o = op('cloudwatch-alarm-threshold');
    setRiskOverride(o.id, 'HIGH');
    expect(resolveRisk(o)).toBe('HIGH');
    clearRiskOverride(o.id);
    expect(resolveRisk(o)).toBe('LOW');
  });
});

describe('overrides drive approvals', () => {
  it('a LOW activity needs 1 approval; reclassified HIGH needs 2', () => {
    const o = op('cloudwatch-alarm-threshold');
    expect(approvalsRequiredFor(o)).toBe(1); // LOW default, policy default
    setRiskOverride(o.id, 'HIGH');
    expect(approvalsRequiredFor(o)).toBe(2); // HIGH → 2 under default policy
    clearRiskOverride(o.id);
    expect(approvalsRequiredFor(o)).toBe(1);
  });
});
