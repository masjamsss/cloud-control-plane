import { beforeEach, describe, expect, it } from 'vitest';
import type { Inventory } from '@/types';
import { manifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';
import { getOperation, resolveEnum, validateParams } from '@/lib/interpreter';
import {
  getAllowlistOverride,
  narrowAllowlist,
  resetSettingsForTests,
  setAllowlistOverride,
} from '@/lib/settings';

const inventory = inventoryData as unknown as Inventory;

/**
 * R7 admin allowlist narrowing: a leader can restrict which manifest-allowed
 * values L1 may pick — enforced in the picker AND in validation — but can never
 * widen beyond what the Terraform supports.
 */
describe('allowlist override (R7 admin narrowing)', () => {
  const OP = 'ec2-resize';
  const PARAM = 'new_instance_type';
  // Derived from the live manifest so the fixture can never drift from the
  // catalog again (the 0034 D1 re-curation replaced the old hardcoded list).
  const BASE = getOperation(OP, manifests)!
    .params.find((p) => p.name === PARAM)!
    .bounds!.allowlist!.map(String);

  beforeEach(() => {
    resetSettingsForTests();
  });

  it('is unrestricted by default — narrowAllowlist returns the full base', () => {
    expect(narrowAllowlist(OP, PARAM, BASE)).toEqual(BASE);
    expect(getAllowlistOverride(OP, PARAM)).toBeNull();
  });

  it('narrows to the admin-chosen subset, preserving manifest order', () => {
    setAllowlistOverride(OP, PARAM, ['m5.xlarge', 'c5.large'], BASE);
    // Order follows BASE, not the input order (c5.large precedes m5.xlarge).
    expect(narrowAllowlist(OP, PARAM, BASE)).toEqual(['c5.large', 'm5.xlarge']);
  });

  it('can never widen — a value outside the manifest base is ignored', () => {
    setAllowlistOverride(OP, PARAM, ['c5.large', 'x9.mega-not-real'], BASE);
    expect(narrowAllowlist(OP, PARAM, BASE)).toEqual(['c5.large']);
  });

  it('resolveEnum narrows only when given the operation id', () => {
    setAllowlistOverride(OP, PARAM, ['c5.large'], BASE);
    const op = getOperation(OP, manifests)!;
    const param = op.params.find((p) => p.name === PARAM)!;
    expect(resolveEnum(param, inventory)).toEqual(BASE); // no opId → raw manifest list
    expect(resolveEnum(param, inventory, OP)).toEqual(['c5.large']); // narrowed
  });

  it('validateParams rejects a manifest-valid value the admin restricted', () => {
    setAllowlistOverride(OP, PARAM, ['c5.large', 'c5.xlarge'], BASE);
    const op = getOperation(OP, manifests)!;
    // m5.xlarge IS in the manifest allowlist but NOT in the admin subset.
    const res = validateParams(
      op,
      { instance: 'aws_instance.app01', new_instance_type: 'm5.xlarge' },
      inventory,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.new_instance_type).toContain('restricted by an admin');
  });

  it('validateParams accepts a value that is within the admin subset', () => {
    setAllowlistOverride(OP, PARAM, ['c5.large', 'c5.xlarge'], BASE);
    const op = getOperation(OP, manifests)!;
    const res = validateParams(
      op,
      { instance: 'aws_instance.app01', new_instance_type: 'c5.large' },
      inventory,
    );
    expect(res.ok).toBe(true);
  });

  it('selecting the full base clears the restriction (no soft-lock)', () => {
    setAllowlistOverride(OP, PARAM, [...BASE], BASE);
    expect(getAllowlistOverride(OP, PARAM)).toBeNull();
    expect(narrowAllowlist(OP, PARAM, BASE)).toEqual(BASE);
  });

  it('clearing with null removes the override', () => {
    setAllowlistOverride(OP, PARAM, ['c5.large'], BASE);
    expect(getAllowlistOverride(OP, PARAM)).not.toBeNull();
    setAllowlistOverride(OP, PARAM, null);
    expect(getAllowlistOverride(OP, PARAM)).toBeNull();
  });

  it('one param restriction does not leak to another', () => {
    setAllowlistOverride(OP, PARAM, ['c5.large'], BASE);
    expect(narrowAllowlist('some-other-op', 'other_param', ['a', 'b'])).toEqual(['a', 'b']);
  });
});
