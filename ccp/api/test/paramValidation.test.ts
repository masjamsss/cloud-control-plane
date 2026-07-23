import { describe, expect, it } from 'vitest';
import type { ManifestOperation, ManifestParam } from '@/types';
import { validateParams } from '../src/manifests';

/**
 * Server-side param validation — the twins the SPA mirrors:
 *
 *   - dependsOn (0034 D14): an INACTIVE conditional param is ignored — never
 *     required, bounds never applied — via the SAME @app-lib/dependsOn
 *     predicate the form renders by ("server validator ignores hidden-field
 *     values"). Active params validate exactly as before: nothing weakened.
 *   - list values (0033 A6): the multi-select submits real arrays —
 *     minItems/maxItems on the array, scalar bounds per item, and a required
 *     list refuses an empty array.
 */

function param(overrides: Partial<ManifestParam> & { name: string }): ManifestParam {
  return {
    label: overrides.name,
    type: 'string',
    source: 'user_input',
    required: false,
    ...overrides,
  };
}

function op(params: ManifestParam[]): ManifestOperation {
  return {
    id: 'fixture-op',
    service: 'test',
    macd: 'Change',
    codemodOp: 'set_attribute',
    title: 'Fixture',
    description: '',
    target: { resourceType: 'aws_efs_file_system' },
    params,
    riskFloor: 'MEDIUM',
    reversible: true,
    downtime: 'none',
    exposure: 'l1_with_guardrails',
    forcesReplace: false,
    autoEligible: false,
    terraformCapability: '~ update',
    group: 'scale-performance',
  };
}

const throughputOp = op([
  param({
    name: 'throughput_mode',
    required: true,
    source: 'allowlist',
    bounds: { allowlist: ['bursting', 'provisioned', 'elastic'] },
  }),
  param({
    name: 'provisioned_mibps',
    type: 'number',
    required: true,
    bounds: { min: 1, max: 1024 },
    dependsOn: { param: 'throughput_mode', equals: 'provisioned' },
  }),
]);

describe('validateParams — dependsOn (0034 D14)', () => {
  it('a required dependent param is ignored while its controller hides it', () => {
    expect(validateParams(throughputOp, { throughput_mode: 'bursting' })).toEqual({ ok: true });
  });

  it('a stale hidden-field value is ignored, not bounds-checked', () => {
    expect(
      validateParams(throughputOp, { throughput_mode: 'elastic', provisioned_mibps: 99999 }),
    ).toEqual({ ok: true });
  });

  it('while ACTIVE the param validates exactly as before — required and bounded', () => {
    expect(validateParams(throughputOp, { throughput_mode: 'provisioned' })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(
      validateParams(throughputOp, { throughput_mode: 'provisioned', provisioned_mibps: 99999 }),
    ).toEqual({ ok: false, code: 'PARAM_OUT_OF_BOUNDS' });
    expect(
      validateParams(throughputOp, { throughput_mode: 'provisioned', provisioned_mibps: 512 }),
    ).toEqual({ ok: true });
  });
});

describe('validateParams — list values (0033 A6)', () => {
  const listOp = op([
    param({
      name: 'security_groups',
      type: 'list',
      source: 'inventory',
      enumSource: 'inventory://aws_security_group/id',
      required: true,
      bounds: { minItems: 1, maxItems: 3, pattern: '^sg-[0-9a-f]{8}$' },
    }),
  ]);

  it('a required list refuses an empty array', () => {
    expect(validateParams(listOp, { security_groups: [] })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
  });

  it('enforces item-count bounds on the array', () => {
    expect(
      validateParams(listOp, { security_groups: ['sg-deadbeef', 'sg-cafef00d', 'sg-baadf00d', 'sg-feedface'] }),
    ).toEqual({ ok: false, code: 'PARAM_OUT_OF_BOUNDS' });
  });

  it('applies scalar bounds per item', () => {
    expect(validateParams(listOp, { security_groups: ['sg-deadbeef', 'not-an-sg'] })).toEqual({
      ok: false,
      code: 'PARAM_OUT_OF_BOUNDS',
    });
    expect(validateParams(listOp, { security_groups: ['sg-deadbeef', 'sg-cafef00d'] })).toEqual({
      ok: true,
    });
  });

  it('an OPTIONAL empty list never trips its minItems bound', () => {
    const optional = op([
      param({
        name: 'topics',
        type: 'list',
        required: false,
        bounds: { minItems: 1, maxItems: 5 },
      }),
    ]);
    expect(validateParams(optional, { topics: [] })).toEqual({ ok: true });
  });

  it('array items are checked against an allowlist per item', () => {
    const allow = op([
      param({
        name: 'processes',
        type: 'list',
        source: 'allowlist',
        required: true,
        bounds: { allowlist: ['Launch', 'Terminate'] },
      }),
    ]);
    expect(validateParams(allow, { processes: ['Launch', 'Terminate'] })).toEqual({ ok: true });
    expect(validateParams(allow, { processes: ['Launch', 'Reboot'] })).toEqual({
      ok: false,
      code: 'PARAM_OUT_OF_BOUNDS',
    });
  });
});

describe('validateParams — map values (tag maps)', () => {
  const tagOp = op([
    param({
      name: 'tags',
      type: 'map',
      source: 'user_input',
      required: true,
      bounds: { pattern: '^[A-Za-z0-9 _.:=+@-]{1,256}$', semantic: 'azure_tag_map' },
    }),
  ]);

  it('accepts a valid tag map — the server twin of checkBounds map handling', () => {
    // Without the map branch, a map skipped the string-guarded pattern check and
    // was accepted UNVALIDATED (illegal chars would pass). Now keys+values bound.
    expect(validateParams(tagOp, { tags: { Department: 'Finance', CostCenter: 'CC-100' } })).toEqual(
      { ok: true },
    );
  });

  it('rejects an illegal key or value (no longer silently accepted)', () => {
    expect(validateParams(tagOp, { tags: { 'Bad<Key>': 'ok' } })).toEqual({
      ok: false,
      code: 'PARAM_OUT_OF_BOUNDS',
    });
    expect(validateParams(tagOp, { tags: { Env: 'no\ttabs' } })).toEqual({
      ok: false,
      code: 'PARAM_OUT_OF_BOUNDS',
    });
  });

  it('rejects two keys that case-fold to the same Azure tag (Owner/owner)', () => {
    // Azure tag names are case-insensitive — the catalogctl executor refuses this
    // collision, so the server validator must too; a distinct second key is fine.
    expect(validateParams(tagOp, { tags: { Owner: 'a', owner: 'b' } })).toEqual({
      ok: false,
      code: 'PARAM_OUT_OF_BOUNDS',
    });
    expect(validateParams(tagOp, { tags: { Owner: 'a', Team: 'b' } })).toEqual({ ok: true });
  });
});

describe('validateParams — repeated (list/set) block params', () => {
  // A repeated block param submits an ARRAY OF INSTANCE RECORDS. Its instance COUNT is
  // bounded by minItems/maxItems; each instance's sub-fields validate by THEIR OWN bounds.
  const ingressParam = (overrides: Partial<ManifestParam> = {}): ManifestParam =>
    param({
      name: 'ingress',
      type: 'list',
      bounds: { minItems: 1, maxItems: 3 },
      repeated: {
        mode: 'list',
        block: 'ingress',
        fields: [
          param({ name: 'from_port', type: 'number', required: true, bounds: { min: 0, max: 65535 } }),
          param({
            name: 'protocol',
            required: true,
            source: 'allowlist',
            bounds: { allowlist: ['tcp', 'udp'] },
          }),
        ],
      },
      ...overrides,
    });

  it('accepts N valid instance records within the instance-count bounds', () => {
    expect(
      validateParams(op([ingressParam()]), {
        ingress: [
          { from_port: 443, protocol: 'tcp' },
          { from_port: 53, protocol: 'udp' },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it('rejects more instances than maxItems (count bound on the array of records)', () => {
    expect(
      validateParams(op([ingressParam()]), {
        ingress: [
          { from_port: 1, protocol: 'tcp' },
          { from_port: 2, protocol: 'tcp' },
          { from_port: 3, protocol: 'tcp' },
          { from_port: 4, protocol: 'tcp' },
        ],
      }),
    ).toEqual({ ok: false, code: 'PARAM_OUT_OF_BOUNDS' });
  });

  it('rejects an instance whose sub-field violates its OWN bounds', () => {
    expect(
      validateParams(op([ingressParam()]), { ingress: [{ from_port: 99999, protocol: 'tcp' }] }),
    ).toEqual({ ok: false, code: 'PARAM_OUT_OF_BOUNDS' });
    expect(
      validateParams(op([ingressParam()]), { ingress: [{ from_port: 443, protocol: 'icmp' }] }),
    ).toEqual({ ok: false, code: 'PARAM_OUT_OF_BOUNDS' });
  });

  it('rejects a missing required sub-field in an instance', () => {
    expect(validateParams(op([ingressParam()]), { ingress: [{ from_port: 443 }] })).toEqual({
      ok: false,
      code: 'PARAM_OUT_OF_BOUNDS',
    });
  });

  it('REGRESSION: an instance with more sub-fields than the param maxItems is NOT false-rejected', () => {
    // The bug: an array-of-records fell into paramOutOfBounds' object branch, which read
    // the param's maxItems (=1 instance) as each record's entry-count bound — so a
    // 3-field record false-rejected. One 3-field instance under maxItems:1 must pass.
    const wide = param({
      name: 'ingress',
      type: 'list',
      bounds: { maxItems: 1 },
      repeated: { mode: 'list', fields: [param({ name: 'a' }), param({ name: 'b' }), param({ name: 'c' })] },
    });
    expect(validateParams(op([wide]), { ingress: [{ a: 'x', b: 'y', c: 'z' }] })).toEqual({ ok: true });
  });

  it('a required repeated param with no instances is VALIDATION_FAILED', () => {
    expect(validateParams(op([ingressParam({ required: true })]), { ingress: [] })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
  });
});
