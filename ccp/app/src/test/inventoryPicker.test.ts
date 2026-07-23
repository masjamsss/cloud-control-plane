import { describe, expect, it } from 'vitest';
import type { Inventory, InventoryResource, ManifestParam } from '@/types';
import { manifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';
import { getOperation } from '@/lib/interpreter';
import {
  buildPickerOptions,
  estimateMountedOptionCount,
  PICKER_OVERSCAN,
  PICKER_PANEL_PX,
  PICKER_ROW_PX,
  resourceTypeOf,
  type PickerOption,
} from '@/lib/inventoryPicker';

const inventory = inventoryData as unknown as Inventory;

/**
 * 0025 RX-2 — "InventoryPicker at estate scale". Pure data-layer tests for
 * the split that mirrors lib/palette.ts's DOM-free approach (this app has no
 * jsdom/RTL — see src/test/setup.ts): the O(n) options build (was O(n·m):
 * `.find()` per resolved address against the whole inventory) and the
 * windowing bound the virtualized panel relies on.
 */

function fixtureParam(overrides: Partial<ManifestParam> = {}): ManifestParam {
  return {
    name: 'volume',
    label: 'Volume',
    type: 'string',
    source: 'inventory',
    enumSource: 'inventory://aws_ebs_volume/address',
    required: true,
    ...overrides,
  };
}

function fixtureResource(overrides: Partial<InventoryResource> = {}): InventoryResource {
  return {
    address: 'aws_ebs_volume.x',
    resourceType: 'aws_ebs_volume',
    service: 'ebs',
    attributes: {},
    ...overrides,
  };
}

describe('buildPickerOptions — the picker option list, address-keyed (0025 RX-2)', () => {
  it('maps each resolved address to its resource name and address', () => {
    const inv: Inventory = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [
        fixtureResource({ address: 'aws_ebs_volume.a', name: 'Volume A' }),
        fixtureResource({ address: 'aws_ebs_volume.b', name: 'Volume B' }),
      ],
    };
    const options = buildPickerOptions(fixtureParam(), inv);
    expect(options.map((o) => [o.address, o.name])).toEqual([
      ['aws_ebs_volume.a', 'Volume A'],
      ['aws_ebs_volume.b', 'Volume B'],
    ]);
  });

  it('falls back to the address as the name when the resource has none', () => {
    const inv: Inventory = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [fixtureResource({ address: 'aws_ebs_volume.unnamed', name: undefined })],
    };
    const [opt] = buildPickerOptions(fixtureParam(), inv);
    expect(opt!.name).toBe('aws_ebs_volume.unnamed');
  });

  it('preserves resolveEnum order (filter order over inventory.resources)', () => {
    const inv: Inventory = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [
        fixtureResource({ address: 'aws_ebs_volume.z' }),
        fixtureResource({ address: 'aws_ebs_volume.a' }),
        fixtureResource({ address: 'aws_ebs_volume.m' }),
      ],
    };
    const options = buildPickerOptions(fixtureParam(), inv);
    expect(options.map((o) => o.address)).toEqual([
      'aws_ebs_volume.z',
      'aws_ebs_volume.a',
      'aws_ebs_volume.m',
    ]);
  });

  it('current value: prefers CURRENT_KEYS in priority order over an arbitrary attribute', () => {
    const inv: Inventory = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [
        fixtureResource({
          address: 'aws_ebs_volume.a',
          attributes: { zzz_other: 'nope', volume_size: '250', size: '999' },
        }),
      ],
    };
    // 'size' outranks 'volume_size' in CURRENT_KEYS priority order.
    const [opt] = buildPickerOptions(fixtureParam(), inv);
    expect(opt!.current).toBe('999');
  });

  it('current value: falls back to the first attribute when no CURRENT_KEYS match', () => {
    const inv: Inventory = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [fixtureResource({ address: 'aws_ebs_volume.a', attributes: { odd_field: 'v1' } })],
    };
    const [opt] = buildPickerOptions(fixtureParam(), inv);
    expect(opt!.current).toBe('v1');
  });

  it('current value: null when the resource has no attributes at all', () => {
    const inv: Inventory = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [fixtureResource({ address: 'aws_ebs_volume.a', attributes: {} })],
    };
    const [opt] = buildPickerOptions(fixtureParam(), inv);
    expect(opt!.current).toBeNull();
  });

  it('a resolved value with no matching resource (non-address enumSource field) still yields an option — behaviorally identical to the pre-RX-2 .find() version', () => {
    const inv: Inventory = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [
        fixtureResource({ address: 'aws_ebs_volume.a', attributes: { tag: 'orphan-tag-value' } }),
      ],
    };
    // enumSource's field is an attribute, not 'address' — resolveEnum returns
    // attribute VALUES here, which never match any resource.address.
    const options = buildPickerOptions(fixtureParam({ enumSource: 'inventory://aws_ebs_volume/tag' }), inv);
    expect(options).toEqual<PickerOption[]>([
      { address: 'orphan-tag-value', name: 'orphan-tag-value', current: null },
    ]);
  });

  it('empty inventory yields no options, not an error', () => {
    const inv: Inventory = { generatedAt: '2026-01-01T00:00:00.000Z', resources: [] };
    expect(buildPickerOptions(fixtureParam(), inv)).toEqual([]);
  });

  it('holds against the real catalog: ec2-resize\'s instance param resolves real aws_instance addresses', () => {
    const op = getOperation('ec2-resize', manifests)!;
    const param = op.params.find((p) => p.source === 'inventory')!;
    const options = buildPickerOptions(param, inventory);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.address === 'aws_instance.app01')).toBe(true);
    // O(n) correctness check: every option's address round-trips to a real
    // resource of the target type (proves the Map-based lookup, not just a
    // count) for a meaningful slice of the estate.
    for (const opt of options.slice(0, 25)) {
      const r = inventory.resources.find((res) => res.address === opt.address);
      expect(r).toBeDefined();
      expect(opt.name).toBe(r!.name ?? opt.address);
    }
  });
});

describe('resourceTypeOf — parses the inventory:// enumSource prefix', () => {
  it('extracts the type before the slash', () => {
    expect(resourceTypeOf(fixtureParam({ enumSource: 'inventory://aws_instance/address' }))).toBe(
      'aws_instance',
    );
  });

  it('extracts the whole spec as the type when there is no field segment', () => {
    expect(resourceTypeOf(fixtureParam({ enumSource: 'inventory://aws_instance' }))).toBe(
      'aws_instance',
    );
  });

  it('returns null for a non-inventory enumSource', () => {
    expect(resourceTypeOf(fixtureParam({ source: 'allowlist', enumSource: undefined }))).toBeNull();
  });

  it('returns null when enumSource is absent entirely', () => {
    expect(resourceTypeOf(fixtureParam({ enumSource: undefined }))).toBeNull();
  });
});

describe('estimateMountedOptionCount — picker DOM node count stays bounded (0025 RX-2)', () => {
  it("mirrors react-virtual's windowing formula: visible rows + overscan on both sides, clamped to total", () => {
    expect(estimateMountedOptionCount(1000, 320, 40, 8)).toBe(24); // ceil(320/40)=8, +2*8=24
    expect(estimateMountedOptionCount(5, 320, 40, 8)).toBe(5); // fewer options than fit — clamped
  });

  it('stays at or under ~20 mounted options for the broadest resource type in the bundled sample', () => {
    // The bundled sample estate is a small, deliberately generic demo dataset
    // (not a large real estate with hundreds of rows on one type) — the
    // windowing formula's estate-size independence is what the follow-up
    // "hypothetical 10,000-resource type" test below proves at real scale;
    // this test just wires the same formula through the ACTUAL bundled data.
    const byType = new Map<string, number>();
    for (const r of inventory.resources) byType.set(r.resourceType, (byType.get(r.resourceType) ?? 0) + 1);
    const broadest = Math.max(...byType.values());
    expect(broadest).toBeGreaterThan(0);

    const mounted = estimateMountedOptionCount(broadest, PICKER_PANEL_PX, PICKER_ROW_PX, PICKER_OVERSCAN);
    expect(mounted).toBeLessThanOrEqual(20);
  });

  it('stays bounded even for a hypothetical 10,000-resource type — mounted count is independent of estate size', () => {
    const mounted = estimateMountedOptionCount(10_000, PICKER_PANEL_PX, PICKER_ROW_PX, PICKER_OVERSCAN);
    expect(mounted).toBeLessThanOrEqual(20);
  });
});
