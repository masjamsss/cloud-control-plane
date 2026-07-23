import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Inventory, ManifestParam, RepeatedBlockSpec } from '@/types';
import {
  addRepeatedInstance,
  deriveFormPlan,
  readRepeatedInstances,
  removeRepeatedInstance,
  repeatedBlockValid,
  repeatedInstanceErrors,
  seedRepeatedInstance,
  updateRepeatedInstance,
} from '@/lib/catalog';
import { validateParams } from '@/lib/interpreter';
import { SchemaForm } from '@/components/SchemaForm/SchemaForm';
import { RepeatedBlockField } from '@/components/SchemaForm/RepeatedBlockField';
import { repeatedBaseline, repeatedValues } from './fixtures/skeletons/fixtureOps';

/**
 * The FORM half of the repeated-block foundation (the renderer half lives in
 * hclSkeleton.test.ts). Two layers:
 *   1. the PURE state helpers (lib/catalog) that shape the array of instance
 *      records — unit-tested with no DOM;
 *   2. the RepeatedBlockField component (SSR markup) + its SchemaForm wiring +
 *      the validateParams submit gate.
 */

const emptyInventory: Inventory = { generatedAt: '2026-01-01T00:00:00.000Z', resources: [] };

const spec: RepeatedBlockSpec = {
  mode: 'list',
  block: 'rule',
  fields: [
    {
      name: 'port',
      label: 'Port',
      type: 'number',
      source: 'user_input',
      required: true,
      attr: 'from_port',
    },
    {
      name: 'proto',
      label: 'Protocol',
      type: 'string',
      source: 'allowlist',
      required: true,
      attr: 'protocol',
      bounds: { allowlist: ['tcp', 'udp'] },
      default: 'tcp',
    },
    {
      name: 'locked',
      label: 'Locked',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: true,
      attr: 'locked',
    },
  ],
};

const rulesParam: ManifestParam = {
  name: 'rules',
  label: 'Rule',
  type: 'list',
  source: 'user_input',
  required: true,
  bounds: { minItems: 1, maxItems: 2 },
  repeated: spec,
};

describe('repeated-block state helpers (pure)', () => {
  it('readRepeatedInstances coerces anything non-array-of-objects to a clean list', () => {
    expect(readRepeatedInstances(undefined)).toEqual([]);
    expect(readRepeatedInstances('nope')).toEqual([]);
    expect(readRepeatedInstances([{ a: 1 }, 'x', null, [1], { b: 2 }])).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it('seedRepeatedInstance seeds non-const defaults only (const is executor-written)', () => {
    expect(seedRepeatedInstance(spec)).toEqual({ proto: 'tcp' });
  });

  it('addRepeatedInstance appends a seeded row (undefined starts a fresh list)', () => {
    expect(addRepeatedInstance(undefined, spec)).toEqual([{ proto: 'tcp' }]);
    expect(addRepeatedInstance([{ port: 80, proto: 'tcp' }], spec)).toEqual([
      { port: 80, proto: 'tcp' },
      { proto: 'tcp' },
    ]);
  });

  it('removeRepeatedInstance drops one row; an out-of-range index is a no-op', () => {
    expect(removeRepeatedInstance([{ a: 1 }, { b: 2 }], 0)).toEqual([{ b: 2 }]);
    expect(removeRepeatedInstance([{ a: 1 }], 9)).toEqual([{ a: 1 }]);
  });

  it('updateRepeatedInstance sets one sub-field without mutating the input', () => {
    const before = [{ port: 80 }, { port: 443 }];
    const after = updateRepeatedInstance(before, 1, 'port', 8443);
    expect(after).toEqual([{ port: 80 }, { port: 8443 }]);
    expect(before[1]).toEqual({ port: 443 }); // input untouched (referential honesty)
  });

  it('repeatedInstanceErrors runs the required-then-bounds law per instance', () => {
    // A bare record is missing both required sub-fields (the default is applied
    // on SEED, not to a raw record — same as the top-level form's seed → values).
    expect(repeatedInstanceErrors(spec, {})).toEqual({
      port: 'Port is required',
      proto: 'Protocol is required',
    });
    expect(repeatedInstanceErrors(spec, { port: 80, proto: 'sctp' })).toEqual({
      proto: 'Protocol must be one of: tcp, udp',
    });
    expect(repeatedInstanceErrors(spec, { port: 80, proto: 'tcp' })).toEqual({});
  });

  it('repeatedBlockValid is true only when every instance validates', () => {
    expect(repeatedBlockValid(spec, [{ port: 80, proto: 'tcp' }])).toBe(true);
    expect(repeatedBlockValid(spec, [{ port: 80, proto: 'tcp' }, { proto: 'tcp' }])).toBe(false);
  });
});

function renderRepeated(value: unknown, param: ManifestParam = rulesParam): string {
  return renderToStaticMarkup(
    createElement(RepeatedBlockField, {
      operationId: 'op',
      param,
      value,
      inventory: emptyInventory,
      onChange: () => undefined,
      onBlur: () => undefined,
    }),
  );
}

describe('RepeatedBlockField (SSR markup)', () => {
  it('an empty block shows the empty note and an enabled Add, no Remove', () => {
    const html = renderRepeated([]);
    expect(html).toContain('No rule added yet.');
    expect(html).toContain('+ Add rule');
    expect(html).not.toContain('>Remove<');
    expect(html).not.toMatch(/sf-repeat__add"[^>]*disabled/);
  });

  it('renders one sub-form per instance, numbered, each with a Remove', () => {
    const html = renderRepeated([
      { port: 80, proto: 'tcp' },
      { port: 443, proto: 'udp' },
    ]);
    expect(html).toContain('Rule 1');
    expect(html).toContain('Rule 2');
    expect((html.match(/>Remove</g) ?? []).length).toBe(2);
    // sub-fields render through the shared Field (a number input carries its value)
    expect(html).toContain('value="80"');
    expect(html).toContain('value="443"');
    // a const sub-field is never rendered as an input
    expect(html).not.toContain('Locked');
  });

  it('honors instance-count bounds: Remove disabled at min, Add disabled at max', () => {
    const atMin = renderRepeated([{ port: 80, proto: 'tcp' }]); // minItems 1
    expect(atMin).toMatch(/sf-repeat__remove"[^>]*disabled/);
    expect(atMin).not.toMatch(/sf-repeat__add"[^>]*disabled/);
    const atMax = renderRepeated([
      { port: 80, proto: 'tcp' },
      { port: 443, proto: 'udp' },
    ]); // maxItems 2
    expect(atMax).toMatch(/sf-repeat__add"[^>]*disabled/);
  });

  it('SchemaForm routes a repeated param to the RepeatedBlockField (not a flat Field)', () => {
    const html = renderToStaticMarkup(
      createElement(SchemaForm, {
        operationId: 'op',
        sections: [{ id: 'change', title: 'Change', collapsed: false, fields: [rulesParam] }],
        inventory: emptyInventory,
        values: { rules: [{ port: 80, proto: 'tcp' }] },
        errors: {},
        touched: {},
        onChange: () => undefined,
        onBlur: () => undefined,
      }),
    );
    expect(html).toContain('sf-repeat');
    expect(html).toContain('+ Add rule');
  });
});

describe('validateParams — repeated block submit gate', () => {
  it('a required repeated block with zero instances is required-empty', () => {
    const res = validateParams(
      repeatedBaseline,
      { ...repeatedValues, attributes: [] },
      emptyInventory,
    );
    expect(res.errors.attributes).toBeDefined();
  });

  it('an instance whose sub-field is out of bounds aggregates one error onto the param', () => {
    const res = validateParams(
      repeatedBaseline,
      { ...repeatedValues, attributes: [{ name: 'order_id', type: 'BAD' }] },
      emptyInventory,
    );
    expect(res.errors.attributes).toContain('need attention');
  });

  it('exceeding maxItems is caught by instance COUNT (bounds reused, never per-item)', () => {
    const rules = Array.from({ length: 3 }, () => ({ port: 80, proto: 'tcp' }));
    const op = { ...repeatedBaseline, params: [rulesParam] };
    const res = validateParams(op, { rules }, emptyInventory);
    expect(res.errors.rules).toContain('at most 2');
  });

  it('the fully-filled repeated fixture validates clean (submittable as authored)', () => {
    expect(validateParams(repeatedBaseline, repeatedValues, emptyInventory).errors).toEqual({});
  });
});

describe('deriveFormPlan — a repeated param buckets like any other', () => {
  it('a required repeated param lands in the Change section', () => {
    const plan = deriveFormPlan({ ...repeatedBaseline, params: [rulesParam] });
    const change = plan.sections.find((s) => s.id === 'change');
    expect(change?.fields.map((f) => f.name)).toContain('rules');
  });
});
