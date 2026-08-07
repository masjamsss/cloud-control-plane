import { describe, expect, it } from 'vitest';
import type { Inventory } from '@/types';
import { manifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';
import {
  availableOperations,
  getOperation,
  parseInventoryEnum,
  resolveEnum,
  validateParams,
} from '@/lib/interpreter';
import { resetSettingsForTests, setAllowlistOverride } from '@/lib/settings';

const inventory = inventoryData as unknown as Inventory;

describe('interpreter — deterministic, no LLM', () => {
  it('lists the operations available for a resource type', () => {
    const ids = availableOperations('aws_ebs_volume', manifests, inventory).map((o) => o.id);
    expect(ids).toContain('ebs-grow');
    expect(ids).toContain('ebs-gp2-to-gp3');
    expect(ids).not.toContain('ec2-resize');
  });

  it('resolves an inventory-driven enum to real addresses', () => {
    const op = getOperation('ec2-resize', manifests);
    expect(op).toBeDefined();
    const target = op!.params.find((p) => p.source === 'inventory');
    expect(target).toBeDefined();
    expect(resolveEnum(target!, inventory)).toContain('aws_instance.app01');
  });

  it('rejects an instance type outside the allowlist', () => {
    const op = getOperation('ec2-resize', manifests)!;
    const res = validateParams(
      op,
      { instance: 'aws_instance.app01', new_instance_type: 'x9.mega' },
      inventory,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.new_instance_type).toBeTruthy();
  });

  it('rejects a shrink on a grow-only volume', () => {
    const op = getOperation('ebs-grow', manifests)!;
    const res = validateParams(
      op,
      { volume: 'aws_ebs_volume.app01_data', new_size_gib: 100 },
      inventory,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.new_size_gib).toBeTruthy();
  });

  it('accepts a valid grow', () => {
    const op = getOperation('ebs-grow', manifests)!;
    const res = validateParams(
      op,
      { volume: 'aws_ebs_volume.app01_data', new_size_gib: 300 },
      inventory,
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a public CIDR on an internal SG ingress rule', () => {
    const op = getOperation('sg-add-internal-ingress-rule', manifests)!;
    const res = validateParams(
      op,
      {
        security_group: 'aws_security_group.apm_agents',
        protocol: 'tcp',
        from_port: 443,
        to_port: 443,
        cidr_block: '0.0.0.0/0',
      },
      inventory,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.cidr_block).toBeTruthy();
  });

  it('accepts an internal RFC1918 CIDR', () => {
    const op = getOperation('sg-add-internal-ingress-rule', manifests)!;
    const res = validateParams(
      op,
      {
        security_group: 'aws_security_group.apm_agents',
        protocol: 'tcp',
        from_port: 443,
        to_port: 443,
        cidr_block: '10.0.0.0/16',
      },
      inventory,
    );
    expect(res.ok).toBe(true);
  });

  it('flags a missing required parameter', () => {
    const op = getOperation('cloudwatch-alarm-threshold', manifests)!;
    const res = validateParams(op, { alarm: 'aws_cloudwatch_metric_alarm.legacy_host' }, inventory);
    expect(res.ok).toBe(false);
    expect(res.errors.new_threshold).toBeTruthy();
  });
});

describe('resolveEnum — attribute-mode dedupe (0033 A10/P9)', () => {
  const attrParam = (enumSource: string): Parameters<typeof resolveEnum>[0] => ({
    name: 'x',
    label: 'X',
    type: 'string',
    source: 'inventory',
    enumSource,
    required: true,
  });

  it('an attribute enum yields one row per DISTINCT estate value, not one per resource', () => {
    const rows = resolveEnum(attrParam('inventory://aws_instance/iam_instance_profile'), inventory);
    // app01 and app02 share the same profile (bastion carries none) — the
    // picker offers the one distinct value, not two.
    expect(rows.length).toBe(1);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it('dedupe preserves first-occurrence order', () => {
    const first = inventory.resources.find(
      (r) => r.resourceType === 'aws_instance' && (r.attributes['iam_instance_profile'] ?? '') !== '',
    )!;
    const rows = resolveEnum(attrParam('inventory://aws_instance/iam_instance_profile'), inventory);
    expect(rows[0]).toBe(String(first.attributes['iam_instance_profile']));
  });

  it('address mode is untouched — one row per resource, existing option order', () => {
    const rows = resolveEnum(attrParam('inventory://aws_instance/address'), inventory);
    const instances = inventory.resources.filter((r) => r.resourceType === 'aws_instance');
    expect(rows.length).toBe(instances.length);
  });

  it('parseInventoryEnum is the one URI decoder (picker + interpreter agree)', () => {
    expect(parseInventoryEnum('inventory://aws_subnet/id')).toEqual({
      type: 'aws_subnet',
      field: 'id',
    });
    expect(parseInventoryEnum('inventory://aws_subnet')).toEqual({
      type: 'aws_subnet',
      field: 'address',
    });
    expect(parseInventoryEnum('not-an-inventory-source')).toBeNull();
    expect(parseInventoryEnum(undefined)).toBeNull();
  });
});

/**
 * PERF-13 — the inventory scan inside `resolveEnum` is memoized per
 * `(inventory, resourceType, field)`, not re-run on every call. `SchemaForm` calls it
 * inline in render for every inventory-sourced param on every keystroke (any field's
 * `onChange` lifts state to the parent and re-renders the whole form) — before this,
 * every one of those calls re-scanned the full `inventory.resources` array from scratch.
 *
 * Reference identity is the signal: the memoized path returns the SAME array object on a
 * cache hit, which an unmemoized re-scan could never do (a fresh `.filter().map()` always
 * allocates a new array, even when its contents are equal). `toBe` (identity), not
 * `toEqual` (structural), is therefore the assertion that actually distinguishes "cached"
 * from "recomputed but coincidentally equal."
 */
describe('resolveEnum — memoized inventory scan (PERF-13)', () => {
  const op = getOperation('ec2-resize', manifests)!;
  const target = op.params.find((p) => p.source === 'inventory')!;
  // A different op, sharing the SAME enumSource (inventory://aws_instance/address) —
  // real manifest data, not a synthetic fixture: dozens of ec2-* ops reference the same
  // instance-address enum.
  const sibling = getOperation('ec2-add-instance-tag', manifests)!;
  const siblingTarget = sibling.params.find((p) => p.source === 'inventory' && p.enumSource === target.enumSource)!;

  it('two calls with the SAME inventory return the identical array — the second is a cache hit', () => {
    const first = resolveEnum(target, inventory);
    const second = resolveEnum(target, inventory);
    expect(second).toBe(first);
  });

  it('two DIFFERENT params sharing one enumSource share the cached scan', () => {
    expect(siblingTarget.enumSource).toBe(target.enumSource); // the fixture's own premise
    const a = resolveEnum(target, inventory);
    const b = resolveEnum(siblingTarget, inventory);
    expect(b).toBe(a);
    expect(a).toContain('aws_instance.app01'); // still the real, correct data
  });

  it('a DIFFERENT inventory object does not share the cache, even with equal content', () => {
    const clone: Inventory = { ...inventory, resources: [...inventory.resources] };
    const original = resolveEnum(target, inventory);
    const fromClone = resolveEnum(target, clone);
    expect(fromClone).not.toBe(original); // no cross-inventory leak…
    expect(fromClone).toEqual(original); // …but the VALUES still agree
  });

  it('the allowlist branch stays live — NOT cached — because it reads a mutable admin override', () => {
    // The property a naive "cache the whole function" fix would have broken: the SAME
    // (param, inventory, operationId) triple, called twice, must reflect an override
    // applied BETWEEN the two calls rather than freezing at the first call's answer.
    resetSettingsForTests();
    const OP = 'ec2-resize';
    const allowlistOp = getOperation(OP, manifests)!;
    const instanceType = allowlistOp.params.find((p) => p.name === 'new_instance_type')!;
    expect(instanceType.source).toBe('allowlist');
    const base = instanceType.bounds!.allowlist!.map(String);

    const before = resolveEnum(instanceType, inventory, OP);
    expect(before).toEqual(base); // unrestricted — no override set yet

    setAllowlistOverride(OP, 'new_instance_type', ['c5.large'], base);
    const after = resolveEnum(instanceType, inventory, OP); // same triple as `before`
    expect(after).toEqual(['c5.large']); // reflects the override — a cache would have returned `before` again
    resetSettingsForTests();
  });
});
