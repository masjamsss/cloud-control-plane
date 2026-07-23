import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyFinding, type ClassifiableFinding } from '@/lib/driftEligibility';

/**
 * Parity proof for the app's own port of the out-of-band provisioning
 * spec's FINDING-partition table ("one table, three implementations, one
 * fixture") against the SAME shared cross-language fixture the Go
 * generator (tools/catalogctl/internal/driftpropose/finding.go's
 * ClassifyFinding) and the api's TS re-check both consume:
 * tools/catalogctl/testdata/driftpropose/unmanaged-cases.json. A case added
 * there fails every implementation that disagrees — this file is this
 * app's copy of that proof, and lib/driftEligibility.ts's classifyFinding
 * is the app's copy of the partition itself. Sibling to
 * driftEligibilityParity.test.ts (the VERDICT partition's own copy of this
 * proof, against eligibility-cases.json — a SEPARATE fixture, deliberately,
 * per that file's own doc comment).
 */

const fixtureUrl = new URL(
  '../../../../tools/catalogctl/testdata/driftpropose/unmanaged-cases.json',
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as {
  cases: Array<{
    name: string;
    finding: unknown;
    bucket: 'import' | 'creation_security' | 'type_unmapped' | 'payload_withheld' | 'ungenerable';
    reason: string;
  }>;
};

describe('classifyFinding — parity with tools/catalogctl/testdata/driftpropose/unmanaged-cases.json ("one table, three implementations, one fixture")', () => {
  it('the fixture itself is non-empty (a silently-empty fixture would make every case below vacuous)', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(`${c.name} → ${c.bucket}`, () => {
      const result = classifyFinding(c.finding as ClassifiableFinding);
      expect(result.bucket, c.name).toBe(c.bucket);
      expect(result.reason, c.name).toBe(c.reason);
    });
  }

  it('enforcement point 1, re-asserted client-side: a security-family finding relabeled with a complete import payload still cannot reach import', () => {
    const forged: ClassifiableFinding = {
      class: 'unmanaged_resource',
      tfType: 'aws_iam_role',
      securityFamily: true,
      importPayload: {
        address: 'aws_iam_role.oob_forged',
        targetFile: 'oob-adopted.tf',
        importBlock: 'import {\n  to = aws_iam_role.oob_forged\n  id = "oob-forged"\n}\n',
        skeletonHcl: 'resource "aws_iam_role" "oob_forged" {\n}\n',
      },
      payloadWithheldReason: null,
    };
    expect(classifyFinding(forged).bucket).toBe('creation_security');
  });

  it('an unknown finding class is always ungenerable, even with every other field import-shaped', () => {
    const f: ClassifiableFinding = {
      class: 'some_future_finding_class',
      tfType: 'aws_instance',
      securityFamily: false,
      importPayload: {
        address: 'aws_instance.oob_future',
        targetFile: 'oob-adopted.tf',
        importBlock: 'import {\n  to = aws_instance.oob_future\n  id = "i-future"\n}\n',
        skeletonHcl: 'resource "aws_instance" "oob_future" {\n}\n',
      },
      payloadWithheldReason: null,
    };
    expect(classifyFinding(f).bucket).toBe('ungenerable');
  });

  it("securityFamily MISSING (not just false) is treated as not-security-family — byte parity with the Go struct's zero-value-on-absence, never a client-only stricter default", () => {
    const f: ClassifiableFinding = {
      class: 'unmanaged_resource',
      tfType: 'aws_instance',
      importPayload: {
        address: 'aws_instance.oob_noflag',
        targetFile: 'oob-adopted.tf',
        importBlock: 'import {\n  to = aws_instance.oob_noflag\n  id = "i-noflag"\n}\n',
        skeletonHcl: 'resource "aws_instance" "oob_noflag" {\n}\n',
      },
      payloadWithheldReason: null,
    };
    expect(classifyFinding(f).bucket).toBe('import');
  });

  it('an incomplete import payload (any one sub-field empty) is payload_withheld, never import', () => {
    const base = {
      class: 'unmanaged_resource' as const,
      tfType: 'aws_instance',
      securityFamily: false,
      payloadWithheldReason: null,
    };
    const fields = ['address', 'targetFile', 'importBlock', 'skeletonHcl'] as const;
    for (const missing of fields) {
      const payload = {
        address: 'aws_instance.oob_x',
        targetFile: 'oob-adopted.tf',
        importBlock: 'import {\n  to = aws_instance.oob_x\n  id = "i-x"\n}\n',
        skeletonHcl: 'resource "aws_instance" "oob_x" {\n}\n',
        [missing]: '',
      };
      const f: ClassifiableFinding = { ...base, importPayload: payload };
      expect(classifyFinding(f).bucket, `missing ${missing}`).toBe('payload_withheld');
    }
  });
});
