import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyDrift, type ClassifiableVerdict } from '@/lib/driftEligibility';

/**
 * Parity proof for the app's own port of the drift-proposal eligibility
 * partition (§6.2 "one table, three implementations, one fixture") against
 * the SAME shared cross-language fixture the Go generator
 * (tools/catalogctl/internal/driftpropose) and the api's TS re-check
 * (ccp/api/src/domain/driftProposals.ts) both consume:
 * tools/catalogctl/testdata/driftpropose/eligibility-cases.json. A case
 * added there fails every implementation that disagrees — this file is this
 * app's copy of that proof, and lib/driftEligibility.ts is the app's copy
 * of the partition itself.
 */

const fixtureUrl = new URL(
  '../../../../tools/catalogctl/testdata/driftpropose/eligibility-cases.json',
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as {
  cases: Array<{ name: string; verdict: unknown; bucket: 'adopt' | 'revert' | 'ungenerable'; reason: string }>;
};

describe('classifyDrift — parity with tools/catalogctl/testdata/driftpropose/eligibility-cases.json (§6.2 "one table, three implementations, one fixture")', () => {
  it('the fixture itself is non-empty (a silently-empty fixture would make every case below vacuous)', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(`${c.name} → ${c.bucket}`, () => {
      const result = classifyDrift(c.verdict as ClassifiableVerdict);
      expect(result.bucket, c.name).toBe(c.bucket);
      expect(result.reason, c.name).toBe(c.reason);
    });
  }

  it('enforcement point 1, re-asserted client-side: a watchlisted verdict relabeled benign_inplace with securityHits present still cannot reach adopt', () => {
    const forged: ClassifiableVerdict = {
      class: 'benign_inplace',
      riskTier: 'low',
      actions: ['update'],
      forceNewAttrs: [],
      driftEvidence: true,
      changedAttrs: [],
      securityHits: [{ path: 'x', why: 'y' }],
    };
    expect(classifyDrift(forged).bucket).toBe('revert');
  });

  it('an unknown class is always ungenerable, even with every other field adopt-shaped', () => {
    const v: ClassifiableVerdict = {
      class: 'some_future_class_z',
      riskTier: 'low',
      actions: ['update'],
      forceNewAttrs: [],
      driftEvidence: true,
      changedAttrs: [],
      securityHits: [],
    };
    expect(classifyDrift(v).bucket).toBe('ungenerable');
  });
});
