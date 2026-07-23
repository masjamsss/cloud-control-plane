import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ChangeRequest, ChangeSetItem, Inventory, ServiceManifest } from '@/types';
import inventoryData from '@/data/inventory.json';
import { manifests as bundledManifests } from '@/data/manifests';
import { ChangeSetView } from '@/components/ChangeSetView';
import { ReviewCard } from '@/features/approvals/ApprovalsQueue';

/**
 * Phase B review-integrity fix — the disclosure proof. The defect was that an approver saw
 * only the PRIMARY operation of a change set (items[0], via the request's top-level fields) and
 * could approve N operations while shown one. These render-shape tests lock the remedy: the
 * shared {@link ChangeSetView} renders EVERY item + the strictest-combined requirement, and a
 * set on the approvals queue's {@link ReviewCard} reads as an N-operation change — while a
 * single-op card stays byte-for-byte what it was. No jsdom in this repo (src/test/setup.ts) —
 * renderToStaticMarkup needs none; useFullBlockDiff's effect doesn't run under it, so each item
 * falls back to its generated-Terraform diff exactly as a mock-mode client does.
 */

const inventory = inventoryData as unknown as Inventory;
const manifests = bundledManifests as ServiceManifest[];

/** A real 3-operation set: a self-service tag, a guardrailed resize, a self-service toggle —
 * so the strictest-combined tier is guardrails (2 approvals) and every op title/target differs. */
const SET_ITEMS: ChangeSetItem[] = [
  { operationId: 'ec2-add-instance-tag', service: 'ec2', macd: 'Add', targetAddress: 'aws_instance.bastion', params: { instance: 'aws_instance.bastion', key: 'team', value: 'platform' }, exposure: 'l1_self_service' },
  { operationId: 'ec2-resize', service: 'ec2', macd: 'Change', targetAddress: 'aws_instance.bastion_firewall', params: { instance: 'aws_instance.bastion_firewall', new_instance_type: 't3.large' }, exposure: 'l1_with_guardrails' },
  { operationId: 'ec2-toggle-detailed-monitoring', service: 'ec2', macd: 'Change', targetAddress: 'aws_instance.app01', params: { instance: 'aws_instance.app01', enabled: true }, exposure: 'l1_self_service' },
];

/** A set where one item forces a destroy+recreate (its confirmation is pinned) — the combined
 * bar floors to the engineer tier + the [L2,L3] replace ladder. */
const REPLACE_SET_ITEMS: ChangeSetItem[] = [
  { operationId: 'ec2-add-instance-tag', service: 'ec2', macd: 'Add', targetAddress: 'aws_instance.bastion', params: { instance: 'aws_instance.bastion', key: 'team', value: 'platform' }, exposure: 'l1_self_service' },
  { operationId: 'ec2-toggle-associate-public-ip', service: 'ec2', macd: 'Change', targetAddress: 'aws_instance.bastion_firewall', params: { instance: 'aws_instance.bastion_firewall', enabled: true }, exposure: 'engineer_only', replaceConfirmation: 'aws_instance.bastion_firewall' },
];

function renderView(items: ChangeSetItem[]): string {
  return renderToStaticMarkup(
    React.createElement(ChangeSetView, { items, manifests, inventory }),
  );
}

describe('ChangeSetView — renders the WHOLE set + the combined requirement', () => {
  it('renders every operation title in the set (not just the primary)', () => {
    const html = renderView(SET_ITEMS);
    expect(html).toContain('Add a tag to an instance');
    expect(html).toContain('Resize an EC2 instance');
    expect(html).toContain('Toggle detailed monitoring');
  });

  it('renders every item’s own target address', () => {
    const html = renderView(SET_ITEMS);
    expect(html).toContain('aws_instance.bastion');
    expect(html).toContain('aws_instance.bastion_firewall');
    expect(html).toContain('aws_instance.app01');
  });

  it('shows the STRICTEST-combined requirement (self-service + guardrails ⇒ guardrails, 2 approvals)', () => {
    const html = renderView(SET_ITEMS);
    expect(html).toContain('Combined review');
    expect(html).toContain('Guardrailed review — 2 approvals');
  });

  it('a forces-replace item floors the combined bar to engineer + flags the destroy&recreate', () => {
    const html = renderView(REPLACE_SET_ITEMS);
    expect(html).toContain('Engineer-authored review — 2 approvals');
    expect(html).toContain('destroy'); // the replace flag ("destroy & recreate")
  });

  it('renders one generated-Terraform diff panel per item (all diffs disclosed, open)', () => {
    const html = renderView(SET_ITEMS);
    const diffPanels = html.match(/cs-item__diff-summary/g) ?? [];
    expect(diffPanels).toHaveLength(3);
  });
});

/* ── the approvals queue card: a set reads as N operations; single-op is unchanged ───────── */

function baseRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'req-set-1',
    requester: 'dewi',
    service: 'ec2',
    operationId: 'ec2-add-instance-tag',
    macd: 'Add',
    targetAddress: 'aws_instance.bastion',
    params: { instance: 'aws_instance.bastion', key: 'team', value: 'platform' },
    justification: 'one reviewed change, several settings',
    exposure: 'l1_self_service',
    risk: 'LOW',
    status: 'AWAITING_CODE_REVIEW',
    approvalsRequired: 2,
    approvals: [],
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

const noop = (): void => {};

function renderCard(request: ChangeRequest): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ReviewCard, {
        request,
        manifests,
        inventory,
        onApprove: noop,
        rejecting: false,
        onStartReject: noop,
        onCancelReject: noop,
        onConfirmReject: noop,
        busy: false,
      }),
    ),
  );
}

describe('ReviewCard — a change set reads as an N-operation set, never a single op', () => {
  it('a set shows the operation count in the title and every item’s operation', () => {
    const html = renderCard(baseRequest({ items: SET_ITEMS }));
    expect(html).toContain('Change set — 3 operations');
    expect(html).toContain('Add a tag to an instance');
    expect(html).toContain('Resize an EC2 instance');
    expect(html).toContain('Toggle detailed monitoring');
  });

  it('a set shows the combined requirement + the strictest access tier, not items[0]’s', () => {
    const html = renderCard(baseRequest({ items: SET_ITEMS }));
    expect(html).toContain('Guardrailed review — 2 approvals'); // combined bar
    expect(html).toContain('Guardrailed'); // combined AccessBadge label in the header tags
    expect(html).toContain('3 ops'); // the count chip
  });

  it('a single-op request is unchanged — its one op title + target, and no change-set chrome', () => {
    const html = renderCard(baseRequest());
    expect(html).toContain('Add a tag to an instance');
    expect(html).toContain('aws_instance.bastion');
    expect(html).not.toContain('Change set —');
    expect(html).not.toContain('Combined review');
  });
});
