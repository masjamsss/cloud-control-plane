import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Inventory, ManifestParam } from '@/types';
import { deriveFormPlan, groupFields, legendFor } from '@/lib/catalog';
import { SchemaForm } from '@/components/SchemaForm/SchemaForm';
import { ec2Baseline, ec2Values } from './fixtures/skeletons/fixtureOps';

/**
 * 0033 A7 — param.group finally renders: named groups become <fieldset>s
 * with plain legends; ungrouped params render bare exactly as before; the
 * dead `layout:'stepped'` API is GONE (it was computed and consumed nowhere
 * — P7). SSR string renders, no jsdom (src/test/setup.ts).
 */

const emptyInventory: Inventory = { generatedAt: '2026-01-01T00:00:00.000Z', resources: [] };

function param(name: string, group?: string): ManifestParam {
  return { name, label: name, type: 'string', source: 'user_input', required: true, group };
}

describe('legendFor — group slug to operator legend', () => {
  it('humanizes with the shared acronym-aware word map', () => {
    expect(legendFor('identity')).toBe('Identity');
    expect(legendFor('compute')).toBe('Compute');
    expect(legendFor('iam-storage')).toBe('IAM storage');
    expect(legendFor('tags')).toBe('Tags');
  });
});

describe('groupFields — partition by param.group', () => {
  it('one anonymous group when nothing declares a group (pre-existing ops)', () => {
    const groups = groupFields([param('a'), param('b')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBeNull();
    expect(groups[0]!.legend).toBeNull();
    expect(groups[0]!.fields.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('named groups in first-appearance order, fields merged per group', () => {
    const groups = groupFields([
      param('h', 'identity'),
      param('w', 'identity'),
      param('t', 'compute'),
      param('n', 'network'),
    ]);
    expect(groups.map((g) => g.id)).toEqual(['identity', 'compute', 'network']);
    expect(groups[0]!.fields.map((f) => f.name)).toEqual(['h', 'w']);
  });

  it('a leading ungrouped run stays first, before the named groups', () => {
    const groups = groupFields([param('target'), param('a', 'compute')]);
    expect(groups.map((g) => g.id)).toEqual([null, 'compute']);
  });
});

describe('deriveFormPlan — the dead layout API is gone (P7)', () => {
  it('no consumer of layout remains because the field itself no longer exists', () => {
    const plan = deriveFormPlan(ec2Baseline);
    expect('layout' in plan).toBe(false);
  });
});

function renderForm(fields: ManifestParam[], values: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(SchemaForm, {
      operationId: 'fixture-op',
      sections: [{ id: 'change', title: 'Change', collapsed: false, fields }],
      inventory: emptyInventory,
      values,
      errors: {},
      touched: {},
      onChange: () => undefined,
      onBlur: () => undefined,
    }),
  );
}

describe('SchemaForm — grouped fieldsets (SSR)', () => {
  it('the EC2 baseline fixture renders its grouped sections as fieldsets with legends', () => {
    const plan = deriveFormPlan(ec2Baseline);
    const html = renderToStaticMarkup(
      createElement(SchemaForm, {
        operationId: ec2Baseline.id,
        sections: plan.sections,
        inventory: emptyInventory,
        values: ec2Values,
        errors: {},
        touched: {},
        onChange: () => undefined,
        onBlur: () => undefined,
      }),
    );
    for (const legend of ['Identity', 'Compute', 'Network', 'IAM storage', 'Tags']) {
      expect(html).toContain(`<legend class="sf-group__legend">${legend}</legend>`);
    }
    expect((html.match(/<fieldset/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('ungrouped params render bare — no fieldset wrapper at all (unchanged markup)', () => {
    const html = renderForm([param('a'), param('b')]);
    expect(html).not.toContain('<fieldset');
    expect(html).not.toContain('sf-group');
  });

  it('a dependsOn-hidden param does not render; it appears once its controller matches', () => {
    const fields: ManifestParam[] = [
      { ...param('throughput_mode'), source: 'allowlist', bounds: { allowlist: ['bursting', 'provisioned'] } },
      {
        ...param('provisioned_mibps'),
        type: 'number',
        dependsOn: { param: 'throughput_mode', equals: 'provisioned' },
      },
    ];
    const hidden = renderForm(fields, { throughput_mode: 'bursting' });
    expect(hidden).not.toContain('provisioned_mibps');
    const shown = renderForm(fields, { throughput_mode: 'provisioned' });
    expect(shown).toContain('provisioned_mibps');
  });

  it('a section whose every field is hidden disappears entirely', () => {
    const fields: ManifestParam[] = [
      {
        ...param('only_dependent'),
        dependsOn: { param: 'controller_elsewhere', equals: 'yes' },
      },
    ];
    const html = renderForm(fields, {});
    expect(html).not.toContain('sf-section');
  });
});
