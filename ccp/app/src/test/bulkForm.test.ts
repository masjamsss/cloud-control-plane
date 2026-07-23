import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Inventory, ManifestOperation } from '@/types';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import { BulkActionBar } from '@/features/services/BulkActionBar';
import { BulkRequestFormView } from '@/features/request/BulkRequestForm';

/**
 * SSR render coverage (no jsdom) for the bulk change UI (Phase B): the bulk-action bar in
 * the console, and the bulk request form's pure view. The pure change-set builders +
 * requirement preview are proven in changeSet.test.ts; here we pin the rendered structure.
 */

const inventory = inventoryData as unknown as Inventory;
const ec2 = manifests.find((m) => m.service === 'ec2')!;
const resize: ManifestOperation = ec2.operations.find((o) => o.id === 'ec2-resize')!;

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, node));
}

describe('BulkActionBar', () => {
  it('states the count and offers the bulk actions for a single-type selection', () => {
    const html = render(
      React.createElement(BulkActionBar, {
        serviceSlug: 'ec2',
        selectedAddresses: ['aws_instance.a', 'aws_instance.b'],
        selectedTypes: ['aws_instance'],
        actions: [resize],
        onClear: () => undefined,
      }),
    );
    expect(html).toContain('selected');
    expect(html).toContain('>2<'); // the count
    expect(html).toContain('bulkbar__select');
    expect(html).toContain(resize.title);
    expect(html).toContain('Review bulk change');
  });

  it('a mixed-type selection shows an honest note instead of a broken action list', () => {
    const html = render(
      React.createElement(BulkActionBar, {
        serviceSlug: 'ec2',
        selectedAddresses: ['aws_instance.a', 'aws_ebs_volume.b'],
        selectedTypes: ['aws_instance', 'aws_ebs_volume'],
        actions: [],
        onClear: () => undefined,
      }),
    );
    expect(html).toContain('more than one type');
    expect(html).not.toContain('bulkbar__select');
  });

  it('renders nothing when nothing is selected', () => {
    const html = render(
      React.createElement(BulkActionBar, {
        serviceSlug: 'ec2',
        selectedAddresses: [],
        selectedTypes: [],
        actions: [],
        onClear: () => undefined,
      }),
    );
    expect(html).toBe('');
  });
});

describe('BulkRequestFormView', () => {
  const targets = ['aws_instance.bastion', 'aws_instance.jump'];
  const html = render(
    React.createElement(BulkRequestFormView, { serviceSlug: 'ec2', op: resize, targets, inventory }),
  );

  it('names the action and the count of resources it applies to', () => {
    expect(html).toContain(resize.title);
    expect(html).toContain('2 resources');
    expect(html).toContain('Submit for 2 resources');
  });

  it('shows the combined review requirement (guardrails → 2 approvals)', () => {
    expect(html).toContain('2 approvals');
  });

  it('lists every selected target address', () => {
    for (const t of targets) expect(html).toContain(t);
  });

  it('renders the shared value field and the justification input', () => {
    expect(html).toContain('new_instance_type'); // the shared field's control
    expect(html).toContain('bulk-justification');
  });
});
