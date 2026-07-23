import { describe, expect, it } from 'vitest';
import type { Inventory, ManifestOperation, ManifestParam } from '@/types';
import { manifests } from '@/data/manifests';
import { isParamActive, stripInactiveParams } from '@/lib/dependsOn';
import { buildRequestDraft, getOperation, validateParams } from '@/lib/interpreter';
import { parseManifests } from '@/types/manifestSchema';

/**
 * 0034 D14/G14 — dependsOn conditional visibility. One predicate
 * (lib/dependsOn.ts) drives the form's render gate, the client validator,
 * the submit strip AND ccp-api's validator (which imports the same
 * module via @app-lib) — these tests pin its semantics and the client-side
 * integration; ccp-api's own suite pins the server integration.
 */

const emptyInventory: Inventory = { generatedAt: '2026-01-01T00:00:00.000Z', resources: [] };

function param(overrides: Partial<ManifestParam> & { name: string }): ManifestParam {
  return {
    label: overrides.name,
    type: 'string',
    source: 'user_input',
    required: false,
    ...overrides,
  };
}

/** The EFS §S25 shape: MiB/s appears only for provisioned mode. */
const throughputOp = {
  id: 'fixture-efs-throughput',
  service: 'test',
  macd: 'Change',
  codemodOp: 'set_attribute',
  title: 'Change throughput mode',
  description: '',
  target: { resourceType: 'aws_efs_file_system' },
  params: [
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
  ],
  riskFloor: 'MEDIUM',
  reversible: true,
  downtime: 'none',
  exposure: 'l1_with_guardrails',
  forcesReplace: false,
  autoEligible: false,
  terraformCapability: '~ update',
  group: 'scale-performance',
} as unknown as ManifestOperation;

describe('isParamActive — the one visibility predicate', () => {
  const dependent = param({
    name: 'kms_key',
    dependsOn: { param: 'encryption', equals: 'aws:kms' },
  });

  it('no dependsOn ⇒ always active (pre-existing behavior exactly)', () => {
    expect(isParamActive(param({ name: 'plain' }), {})).toBe(true);
  });

  it('equals: active only on the exact value', () => {
    expect(isParamActive(dependent, { encryption: 'aws:kms' })).toBe(true);
    expect(isParamActive(dependent, { encryption: 'AES256' })).toBe(false);
  });

  it('an EMPTY controller deactivates under both operators (fail-closed to hidden)', () => {
    const notNone = param({
      name: 'from_port',
      dependsOn: { param: 'protocol', notEquals: 'none' },
    });
    for (const values of [{}, { encryption: '' }, { encryption: null }]) {
      expect(isParamActive(dependent, values as Record<string, unknown>)).toBe(false);
    }
    expect(isParamActive(notNone, {})).toBe(false);
    expect(isParamActive(notNone, { protocol: 'none' })).toBe(false);
    expect(isParamActive(notNone, { protocol: 'tcp' })).toBe(true);
  });

  it('compares by canonical string form (bool/number controllers work)', () => {
    const insideVpc = param({ name: 'subnets', dependsOn: { param: 'inside_vpc', equals: true } });
    expect(isParamActive(insideVpc, { inside_vpc: true })).toBe(true);
    expect(isParamActive(insideVpc, { inside_vpc: false })).toBe(false);
    expect(isParamActive(insideVpc, { inside_vpc: 'true' })).toBe(true);
  });
});

describe('client validateParams honors the gate', () => {
  it('a required dependent field is NOT required while its controller says hidden', () => {
    const res = validateParams(throughputOp, { throughput_mode: 'bursting' }, emptyInventory);
    expect(res.ok).toBe(true);
  });

  it('… and IS required (and bounded) while active', () => {
    const missing = validateParams(throughputOp, { throughput_mode: 'provisioned' }, emptyInventory);
    expect(missing.ok).toBe(false);
    expect(missing.errors.provisioned_mibps).toBeTruthy();

    const outOfBounds = validateParams(
      throughputOp,
      { throughput_mode: 'provisioned', provisioned_mibps: 4096 },
      emptyInventory,
    );
    expect(outOfBounds.ok).toBe(false);

    const good = validateParams(
      throughputOp,
      { throughput_mode: 'provisioned', provisioned_mibps: 512 },
      emptyInventory,
    );
    expect(good.ok).toBe(true);
  });

  it('a stale hidden-field value is ignored, not validated', () => {
    // 4096 violates max:1024 — but the field is hidden, so the value is inert.
    const res = validateParams(
      throughputOp,
      { throughput_mode: 'elastic', provisioned_mibps: 4096 },
      emptyInventory,
    );
    expect(res.ok).toBe(true);
  });
});

describe('submit strips hidden-field values (client side of the parity contract)', () => {
  it('stripInactiveParams drops inactive values and keeps everything else', () => {
    const out = stripInactiveParams(throughputOp.params, {
      throughput_mode: 'bursting',
      provisioned_mibps: 512,
      justification_adjacent_key: 'kept',
    });
    expect(out).toEqual({ throughput_mode: 'bursting', justification_adjacent_key: 'kept' });
  });

  it('buildRequestDraft never carries an inactive value into the stored request', () => {
    const draft = buildRequestDraft(
      throughputOp,
      '',
      { throughput_mode: 'elastic', provisioned_mibps: 4096 },
      'a justification',
      'user-1',
    );
    expect(draft.params).toEqual({ throughput_mode: 'elastic' });
  });

  it('… and passes params through untouched when everything is active', () => {
    const values = { throughput_mode: 'provisioned', provisioned_mibps: 512 };
    const draft = buildRequestDraft(throughputOp, '', values, 'a justification', 'user-1');
    expect(draft.params).toEqual(values);
  });
});

describe('the shipped EFS throughput op (F23 closed — the W2 acceptance line)', () => {
  const efs = getOperation('efs-change-throughput-mode', manifests)!;
  const mibps = efs.params.find((p) => p.name === 'new_provisioned_throughput_in_mibps')!;

  it('the MiB/s field is active only for provisioned mode', () => {
    expect(mibps.dependsOn).toEqual({ param: 'new_throughput_mode', equals: 'provisioned' });
    expect(isParamActive(mibps, { new_throughput_mode: 'provisioned' })).toBe(true);
    expect(isParamActive(mibps, { new_throughput_mode: 'bursting' })).toBe(false);
    expect(isParamActive(mibps, { new_throughput_mode: 'elastic' })).toBe(false);
    expect(isParamActive(mibps, {})).toBe(false);
  });

  it('a stale MiB/s value on a bursting submit is ignored and stripped', () => {
    const values = {
      file_system: 'aws_efs_file_system.erp_interface',
      new_throughput_mode: 'bursting',
      new_provisioned_throughput_in_mibps: 4096, // out of bounds AND hidden
    };
    expect(validateParams(efs, values, emptyInventory).ok).toBe(true);
    const draft = buildRequestDraft(efs, values.file_system, values, 'a justification', 'user-1');
    expect(draft.params).not.toHaveProperty('new_provisioned_throughput_in_mibps');
  });
});

describe('manifest schema — dependsOn shape', () => {
  const baseManifest = {
    service: 'test',
    scope: 'estate',
    resourceTypes: ['aws_efs_file_system'],
    summary: 'Test manifest.',
    operations: [JSON.parse(JSON.stringify(throughputOp)) as unknown],
  };

  function withCondition(cond: Record<string, unknown>): unknown {
    const m = JSON.parse(JSON.stringify(baseManifest)) as {
      operations: { params: { name: string; dependsOn?: unknown }[] }[];
    };
    m.operations[0]!.params[1]!.dependsOn = cond;
    return m;
  }

  it('accepts exactly one of equals / notEquals', () => {
    expect(() => parseManifests([withCondition({ param: 'throughput_mode', equals: 'provisioned' })])).not.toThrow();
    expect(() => parseManifests([withCondition({ param: 'throughput_mode', notEquals: 'none' })])).not.toThrow();
  });

  it('refuses zero or two operators, unknown keys, and a missing param', () => {
    expect(() => parseManifests([withCondition({ param: 'throughput_mode' })])).toThrow();
    expect(() =>
      parseManifests([withCondition({ param: 'throughput_mode', equals: 'a', notEquals: 'b' })]),
    ).toThrow();
    expect(() =>
      parseManifests([withCondition({ param: 'throughput_mode', equals: 'a', when: 'x' })]),
    ).toThrow();
    expect(() => parseManifests([withCondition({ equals: 'a' })])).toThrow();
  });
});
