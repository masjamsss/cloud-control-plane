import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { ServiceManifestSchema, parseManifests } from '@/types/manifestSchema';

/**
 * Proves the self-registering catalog loads and that every bundled manifest
 * conforms to the schema — the guard that replaces the old blind cast (SCAL-2).
 */

describe('bundled manifests', () => {
  it('load via the glob and cover the estate (114 manifests: 98 aws + 16 azure)', () => {
    expect(manifests.length).toBe(114);
    const slugs = new Set(manifests.map((m) => m.service));
    expect(slugs.has('ec2')).toBe(true);
    expect(slugs.has('s3')).toBe(true);
  });

  it('every manifest validates against the schema', () => {
    for (const m of manifests) {
      const res = ServiceManifestSchema.safeParse(m);
      expect(res.success, `${m.service} failed: ${res.success ? '' : res.error.message}`).toBe(
        true,
      );
    }
  });

  it('every operation id is unique across the whole catalog', () => {
    const ids = manifests.flatMap((m) => m.operations.map((o) => o.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('schema rejects malformed manifests', () => {
  it('rejects an unknown codemodOp', () => {
    const bad = {
      service: 'x',
      scope: 'estate',
      resourceTypes: ['aws_x'],
      summary: 's',
      operations: [
        {
          id: 'x-1',
          service: 'x',
          macd: 'Change',
          codemodOp: 'teleport_block',
          title: 't',
          description: 'd',
          target: { resourceType: 'aws_x' },
          params: [],
          riskFloor: 'LOW',
          reversible: true,
          downtime: 'none',
          exposure: 'l1_self_service',
          forcesReplace: false,
          autoEligible: false,
          terraformCapability: 'x',
        },
      ],
    };
    expect(() => parseManifests([bad])).toThrow();
  });

  it('rejects a missing riskFloor', () => {
    const bad = {
      service: 'x',
      scope: 'estate',
      resourceTypes: ['aws_x'],
      summary: 's',
      operations: [
        {
          id: 'x-1',
          service: 'x',
          macd: 'Change',
          codemodOp: 'set_attribute',
          title: 't',
          description: 'd',
          target: { resourceType: 'aws_x' },
          params: [],
          reversible: true,
          downtime: 'none',
          exposure: 'l1_self_service',
          forcesReplace: false,
          autoEligible: false,
          terraformCapability: 'x',
        },
      ],
    };
    expect(() => parseManifests([bad])).toThrow();
  });

  // 0008 §3 — group went optional -> backfilled -> required (never a broken
  // intermediate state); this proves the required flip actually took.
  it('rejects a missing group', () => {
    const bad = {
      service: 'x',
      scope: 'estate',
      resourceTypes: ['aws_x'],
      summary: 's',
      operations: [
        {
          id: 'x-1',
          service: 'x',
          macd: 'Change',
          codemodOp: 'set_attribute',
          title: 't',
          description: 'd',
          target: { resourceType: 'aws_x' },
          params: [],
          riskFloor: 'LOW',
          reversible: true,
          downtime: 'none',
          exposure: 'l1_self_service',
          forcesReplace: false,
          autoEligible: false,
          terraformCapability: 'x',
        },
      ],
    };
    expect(() => parseManifests([bad])).toThrow();
  });

  it('rejects an invalid group value', () => {
    const bad = {
      service: 'x',
      scope: 'estate',
      resourceTypes: ['aws_x'],
      summary: 's',
      operations: [
        {
          id: 'x-1',
          service: 'x',
          macd: 'Change',
          codemodOp: 'set_attribute',
          title: 't',
          description: 'd',
          target: { resourceType: 'aws_x' },
          params: [],
          riskFloor: 'LOW',
          reversible: true,
          downtime: 'none',
          exposure: 'l1_self_service',
          forcesReplace: false,
          autoEligible: false,
          terraformCapability: 'x',
          group: 'not-a-real-group',
        },
      ],
    };
    expect(() => parseManifests([bad])).toThrow();
  });
});
