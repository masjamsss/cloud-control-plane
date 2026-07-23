import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { getOperation } from '@/lib/interpreter';
import { resetRiskOverridesForTests, setRiskOverride } from '@/lib/riskOverrides';
import { opChipData } from '@/components/ui/OpChips';

/**
 * 0008 §3 Task 1 — the shared chip row renders risk (colored axis) and
 * exposure (steel axis) independently. Proof: the real catalog has exactly 8
 * ops whose risk/exposure combination falls off the LOW/self · MEDIUM/guard ·
 * HIGH/engineer "diagonal" (opTaxonomy.test.ts covers the taxonomy itself;
 * this covers the chip data derived from it) — one chip literally cannot
 * encode both axes, because neither axis predicts the other for these ops.
 * Two are used as fixtures here, picked so each op contradicts a DIFFERENT
 * half of the naive "risk implies exposure" assumption.
 */

function op(id: string) {
  const found = getOperation(id, manifests);
  if (!found) throw new Error(`fixture op not found: ${id}`);
  return found;
}

describe('opChipData — risk and exposure are derived independently (0008 §3 off-diagonal ops)', () => {
  it('acm-delete-certificate: HIGH risk does NOT imply engineer_only exposure', () => {
    const fixture = op('acm-delete-certificate');
    expect(fixture.riskFloor).toBe('HIGH');
    expect(fixture.exposure).toBe('l1_with_guardrails');

    const chips = opChipData(fixture);
    expect(chips.risk).toBe('HIGH');
    expect(chips.exposure).toBe('l1_with_guardrails');
  });

  it('cloudwatch-dashboard-update-body: engineer_only exposure does NOT imply HIGH risk', () => {
    const fixture = op('cloudwatch-dashboard-update-body');
    expect(fixture.riskFloor).toBe('MEDIUM');
    expect(fixture.exposure).toBe('engineer_only');

    const chips = opChipData(fixture);
    expect(chips.risk).toBe('MEDIUM');
    expect(chips.exposure).toBe('engineer_only');
  });

  it('the two fixtures together prove one axis cannot be inferred from the other', () => {
    const a = opChipData(op('acm-delete-certificate')); // HIGH risk, guardrailed
    const b = opChipData(op('cloudwatch-dashboard-update-body')); // MEDIUM risk, engineer-only
    // Higher risk (a) does NOT carry the stricter exposure that lower risk (b) has —
    // so a single chip encoding only one axis would misrepresent the other for both.
    expect(a.risk).toBe('HIGH');
    expect(a.exposure).not.toBe('engineer_only');
    expect(b.risk).not.toBe('HIGH');
    expect(b.exposure).toBe('engineer_only');
  });

  it('risk reflects a Lead override (resolveRisk), exposure never does — there is no exposure override', () => {
    resetRiskOverridesForTests();
    const fixture = op('acm-delete-certificate');
    try {
      setRiskOverride(fixture.id, 'LOW');
      const chips = opChipData(fixture);
      expect(chips.risk).toBe('LOW'); // overridden
      expect(chips.exposure).toBe('l1_with_guardrails'); // unchanged — manifest value, no override concept
    } finally {
      resetRiskOverridesForTests();
    }
  });
});
