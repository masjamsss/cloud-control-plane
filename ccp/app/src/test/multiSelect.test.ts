import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Inventory, ManifestParam } from '@/types';
import { manifests } from '@/data/manifests';
import { getOperation, validateParams } from '@/lib/interpreter';
import { asListValue, isInventoryListParam, toggleListValue } from '@/lib/inventoryPicker';
import { checkBounds } from '@/lib/validation';
import { Field } from '@/components/SchemaForm/Field';

/**
 * 0033 A6 — the bounded multi-select InventoryPicker. Pure list logic +
 * routing predicate first (DOM-free, same split the picker's data layer
 * already uses), then SSR string renders (this app has no jsdom — see
 * src/test/setup.ts) pinning the chips markup and the Field routing.
 */

function fixtureParam(overrides: Partial<ManifestParam> = {}): ManifestParam {
  return {
    name: 'security_groups',
    label: 'Security groups',
    type: 'list',
    source: 'inventory',
    enumSource: 'inventory://aws_security_group/address',
    required: true,
    bounds: { minItems: 1, maxItems: 3 },
    ...overrides,
  };
}

const inventory: Inventory = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  resources: [
    {
      address: 'aws_security_group.app',
      resourceType: 'aws_security_group',
      service: 'security-groups',
      name: 'app tier',
      attributes: {},
    },
    {
      address: 'aws_security_group.db',
      resourceType: 'aws_security_group',
      service: 'security-groups',
      name: 'db tier',
      attributes: {},
    },
  ],
};

/* ── Pure list logic ─────────────────────────────────────────────────────── */

describe('asListValue — value normalization', () => {
  it('passes arrays through as strings and drops empties', () => {
    expect(asListValue(['a', 'b', ''])).toEqual(['a', 'b']);
  });
  it('treats empty as the empty list', () => {
    expect(asListValue(undefined)).toEqual([]);
    expect(asListValue(null)).toEqual([]);
    expect(asListValue('')).toEqual([]);
  });
  it('tolerates the pre-multi-select single-string shape', () => {
    expect(asListValue('sg-1')).toEqual(['sg-1']);
  });
});

describe('toggleListValue — bounded toggle semantics', () => {
  it('adds an absent option and removes a present one, preserving order', () => {
    expect(toggleListValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleListValue(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
  it('refuses an add at maxItems but always allows removal', () => {
    expect(toggleListValue(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
    expect(toggleListValue(['a', 'b'], 'b', 2)).toEqual(['a']);
  });
});

describe('isInventoryListParam — the Field routing predicate', () => {
  it('matches inventory-sourced list params with an inventory enum', () => {
    expect(isInventoryListParam(fixtureParam())).toBe(true);
  });
  it('does not match scalar inventory params, enum-less lists, or typed lists', () => {
    expect(isInventoryListParam(fixtureParam({ type: 'string' }))).toBe(false);
    expect(isInventoryListParam(fixtureParam({ enumSource: undefined }))).toBe(false);
    // A user_input list with an inventory enum stays a TEXT input on purpose:
    // the picker route is for params whose source declares the inventory.
    expect(isInventoryListParam(fixtureParam({ source: 'user_input' }))).toBe(false);
  });
  it('the shipped inventory list params route to it (incl. the W3-repointed rds subnet set)', () => {
    // Both once dead-ended on inventory://…/id enums the HCL-derived
    // inventory never carries (0 rows); the W3 re-point to /address makes
    // them real multi-select pickers, so both must route to the widget.
    const efs = getOperation('efs-mt-update-security-groups', manifests)!;
    const rds = getOperation('rds-change-subnet-group-subnets', manifests)!;
    expect(isInventoryListParam(efs.params.find((p) => p.name === 'security_groups')!)).toBe(true);
    expect(isInventoryListParam(rds.params.find((p) => p.name === 'subnet_ids')!)).toBe(true);
  });
});

/* ── List bounds validation (client half of the server twin) ─────────────── */

describe('checkBounds — array values', () => {
  it('enforces minItems/maxItems', () => {
    const p = fixtureParam();
    expect(checkBounds(p, [])).toMatch(/at least 1/);
    expect(checkBounds(p, ['a'])).toBeNull();
    expect(checkBounds(p, ['a', 'b', 'c', 'd'])).toMatch(/at most 3/);
  });

  it('applies scalar bounds per item (pattern, allowlist)', () => {
    const patterned = fixtureParam({
      source: 'user_input',
      enumSource: undefined,
      bounds: { pattern: '^sg-[0-9a-f]{8}$' },
    });
    expect(checkBounds(patterned, ['sg-deadbeef', 'sg-cafef00d'])).toBeNull();
    expect(checkBounds(patterned, ['sg-deadbeef', 'not-an-sg'])).toMatch(/invalid format/);
  });

  it('a required list param treats [] as missing (validateParams)', () => {
    const op = getOperation('efs-mt-update-security-groups', manifests)!;
    const targetParam = op.params.find((p) => p.source === 'inventory' && p.type !== 'list')!;
    const res = validateParams(
      op,
      { [targetParam.name]: 'aws_efs_mount_target.x', security_groups: [] },
      inventory,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.security_groups).toMatch(/required/);
  });
});

describe('checkBounds — map values (tag maps)', () => {
  const tagParam = (): ManifestParam =>
    fixtureParam({
      name: 'tags',
      label: 'Tags',
      type: 'map',
      source: 'user_input',
      enumSource: undefined,
      required: true,
      bounds: { pattern: '^[A-Za-z0-9 _.:=+@-]{1,256}$', semantic: 'azure_tag_map' },
    });

  it('accepts a valid tag map — regression: was rejected as "[object Object]"', () => {
    // Before the map branch, checkBounds ran the pattern on String(object) and
    // every Azure *-update-tags op (and AWS s3-update-tags, secretsmanager…)
    // rejected all input. This is the exact shape the tag picker submits.
    expect(checkBounds(tagParam(), { Department: 'Finance', CostCenter: 'CC-100' })).toBeNull();
    expect(checkBounds(tagParam(), {})).toBeNull();
  });

  it('bounds every key and value independently', () => {
    expect(checkBounds(tagParam(), { 'Bad<Key>': 'ok' })).toMatch(/key .* invalid format/);
    expect(checkBounds(tagParam(), { Env: 'no\ttabs' })).toMatch(/value for .* invalid format/);
  });

  it('rejects two keys that case-fold to the same Azure tag (names are case-insensitive)', () => {
    // Owner and owner are the same tag in Azure — the catalogctl executor refuses this
    // (TAG_KEY_CASE_COLLISION), so the form validator must catch it before submit. A
    // genuinely distinct second key is fine.
    expect(checkBounds(tagParam(), { Owner: 'a', owner: 'b' })).toMatch(/same Azure tag/);
    expect(checkBounds(tagParam(), { Owner: 'a', Team: 'b' })).toBeNull();
  });
});

/* ── SSR string renders (no jsdom) ───────────────────────────────────────── */

function renderField(param: ManifestParam, value: unknown): string {
  return renderToStaticMarkup(
    createElement(Field, {
      param,
      value,
      inventory,
      onChange: () => undefined,
      onBlur: () => undefined,
    }),
  );
}

describe('Field — multi-select rendering (SSR)', () => {
  it('renders chosen entries as removable chips with the resource name', () => {
    const html = renderField(fixtureParam(), ['aws_security_group.app', 'aws_security_group.db']);
    expect(html).toContain('sf-combo__chips');
    expect(html).toContain('app tier');
    expect(html).toContain('db tier');
    expect(html).toContain('aria-label="Remove app tier"');
    expect(html).toContain('role="combobox"');
  });

  it('tolerates the legacy single-string value shape', () => {
    const html = renderField(fixtureParam(), 'aws_security_group.app');
    expect(html).toContain('sf-chip');
    expect(html).toContain('app tier');
  });

  it('shows the item-count bound as the persistent hint', () => {
    const html = renderField(fixtureParam(), []);
    expect(html).toContain('Choose 1 to 3');
  });

  it('a scalar inventory param still renders the classic single-select (no chips)', () => {
    const html = renderField(
      fixtureParam({
        type: 'string',
        name: 'security_group',
        label: 'Security group',
        bounds: undefined,
      }),
      'aws_security_group.app',
    );
    expect(html).not.toContain('sf-combo__chips');
    expect(html).toContain('app tier · aws_security_group.app');
  });

  it('an enum-less user-input list still renders the plain text input (unchanged)', () => {
    const html = renderField(
      fixtureParam({ source: 'user_input', enumSource: undefined, bounds: undefined }),
      '',
    );
    expect(html).toContain('type="text"');
    expect(html).not.toContain('role="combobox"');
  });

  it('a user-input list with an inventory enum also keeps its text input (no dead-end picker)', () => {
    const html = renderField(fixtureParam({ source: 'user_input' }), '');
    expect(html).toContain('type="text"');
    expect(html).not.toContain('role="combobox"');
  });
});
