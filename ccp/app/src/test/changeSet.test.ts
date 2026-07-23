import { describe, expect, it } from 'vitest';
import type { ChangeRequest, ChangeSetItem, Inventory, InventoryResource } from '@/types';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import { buildCapability } from '@/lib/resourceDetail';
import { editFor, type PendingEdit } from '@/lib/resourceEdits';
import {
  allSelected,
  bulkRequirement,
  bulkToChangeSet,
  cartRequirement,
  cartToChangeSet,
  changeSetRequirement,
  combinedRequirement,
  deselectAll,
  exposureForTier,
  isBulkableAction,
  isChangeSet,
  itemCountOf,
  itemsOf,
  ladderForTier,
  requirementSummary,
  reviewTierForExposure,
  selectAll,
  strictestTier,
  toggleSelection,
} from '@/lib/changeSet';
import { bulkHref, parseBulkTargets } from '@/lib/bulkRoute';

/**
 * The CLIENT half of the multi-operation change set (Phase B). Pure builders + the combined
 * requirement preview + the multi-select reducers, in the repo's no-jsdom style. The server
 * is the authority (see ccp/api/test/changeSet.test.ts); these lock the client mirror
 * and the two change-set builders (cart = N ops × 1 target, bulk = 1 op × N targets).
 */

const inventory = inventoryData as unknown as Inventory;
const ec2 = manifests.find((m) => m.service === 'ec2')!;
const opById = (id: string) => ec2.operations.find((o) => o.id === id)!;
const bastion: InventoryResource = inventory.resources.find((r) => r.address === 'aws_instance.bastion')!;

/* ── the combined requirement is the STRICTEST across items (client mirror) ─────────────── */

describe('combinedRequirement — the strictest tier + ladder across items', () => {
  it('reviewTierForExposure mirrors the server (unknown fails closed to engineer)', () => {
    expect(reviewTierForExposure('l1_self_service')).toBe('self_service');
    expect(reviewTierForExposure('l1_with_guardrails')).toBe('guardrails');
    expect(reviewTierForExposure('engineer_only')).toBe('engineer');
    expect(reviewTierForExposure('something_unknown')).toBe('engineer');
  });

  it('strictestTier + ladderForTier match the server ladders', () => {
    expect(strictestTier('self_service', 'guardrails')).toBe('guardrails');
    expect(strictestTier('guardrails', 'engineer')).toBe('engineer');
    expect(ladderForTier('self_service', false)).toEqual(['L2']);
    expect(ladderForTier('guardrails', false)).toEqual(['L2', 'L3']);
    expect(ladderForTier('self_service', true)).toEqual(['L2', 'L3']); // forces-replace floors it
  });

  it('two self-service items → [L2], required 1', () => {
    const r = combinedRequirement([{ exposure: 'l1_self_service' }, { exposure: 'l1_self_service' }]);
    expect(r.tier).toBe('self_service');
    expect(r.approvalsRequired).toBe(1);
  });

  it('self-service + guardrails → the guardrails ladder wins ([L2, L3], required 2)', () => {
    const r = combinedRequirement([{ exposure: 'l1_self_service' }, { exposure: 'l1_with_guardrails' }]);
    expect(r.tier).toBe('guardrails');
    expect(r.ladder).toEqual(['L2', 'L3']);
    expect(r.approvalsRequired).toBe(2);
  });

  it('any forces-replace item floors the whole set to engineer + [L2, L3]', () => {
    const r = combinedRequirement([{ exposure: 'l1_self_service' }, { exposure: 'engineer_only', forcesReplace: true }]);
    expect(r.tier).toBe('engineer');
    expect(r.forcesReplace).toBe(true);
    expect(r.approvalsRequired).toBe(2);
  });

  it('requirementSummary reads as a plain line', () => {
    expect(requirementSummary(combinedRequirement([{ exposure: 'l1_self_service' }]))).toContain('1 approval');
    expect(requirementSummary(combinedRequirement([{ exposure: 'l1_with_guardrails' }]))).toContain('2 approvals');
  });
});

/* ── itemsOf: the canonical item list — single-op is a strict special case of a set ─────── */

describe('itemsOf / itemCountOf / isChangeSet — the client canonicalization seam', () => {
  function req(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
    return {
      id: 'req-1',
      requester: 'dewi',
      service: 'ec2',
      operationId: 'ec2-resize',
      macd: 'Change',
      targetAddress: 'aws_instance.bastion',
      params: { new_instance_type: 't3.large', instance: 'aws_instance.bastion' },
      justification: 'grow the bastion for the migration window',
      exposure: 'l1_with_guardrails',
      risk: 'MEDIUM',
      status: 'AWAITING_CODE_REVIEW',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      events: [],
      ...overrides,
    };
  }

  it('a single-op request (no items) synthesizes ONE item from the top-level fields', () => {
    const r = req();
    expect(itemsOf(r)).toEqual([
      {
        operationId: 'ec2-resize',
        service: 'ec2',
        macd: 'Change',
        targetAddress: 'aws_instance.bastion',
        params: { new_instance_type: 't3.large', instance: 'aws_instance.bastion' },
        exposure: 'l1_with_guardrails',
      },
    ]);
    expect(itemCountOf(r)).toBe(1);
    expect(isChangeSet(r)).toBe(false);
  });

  it('a single-op forces-replace request carries its top-level replaceConfirmation onto the one item', () => {
    const r = req({ replaceConfirmation: 'aws_instance.bastion' });
    expect(itemsOf(r)[0]!.replaceConfirmation).toBe('aws_instance.bastion');
    expect(itemsOf(r)).toHaveLength(1);
  });

  it('a true set returns its items VERBATIM (top-level fields, which mirror items[0], are ignored)', () => {
    const items: ChangeSetItem[] = [
      { operationId: 'ec2-add-instance-tag', service: 'ec2', macd: 'Add', targetAddress: 'aws_instance.bastion', params: {}, exposure: 'l1_self_service' },
      { operationId: 'ec2-resize', service: 'ec2', macd: 'Change', targetAddress: 'aws_instance.bastion_firewall', params: {}, exposure: 'l1_with_guardrails' },
    ];
    const r = req({ items });
    expect(itemsOf(r)).toBe(items); // same reference — returned as-is
    expect(itemCountOf(r)).toBe(2);
    expect(isChangeSet(r)).toBe(true);
  });
});

/* ── the read-side combined requirement + tier→exposure inverse ──────────────────────────── */

describe('changeSetRequirement + exposureForTier — what the approver is shown matches the server', () => {
  it('a stored item forces-replace via its PINNED replaceConfirmation, floring the ladder to [L2,L3]', () => {
    const items: ChangeSetItem[] = [
      { operationId: 'a', targetAddress: 'x', params: {}, exposure: 'l1_self_service' },
      // a self-service item that still forces a destroy+recreate (its confirmation is pinned)
      { operationId: 'b', targetAddress: 'y', params: {}, exposure: 'l1_self_service', replaceConfirmation: 'y' },
    ];
    const r = changeSetRequirement(items);
    expect(r.tier).toBe('self_service'); // tier is strictest EXPOSURE (unchanged by replace)
    expect(r.forcesReplace).toBe(true);
    expect(r.ladder).toEqual(['L2', 'L3']); // …but forces-replace floors the ladder
    expect(r.approvalsRequired).toBe(2);
  });

  it('the combined tier is the STRICTEST exposure across items', () => {
    const items: ChangeSetItem[] = [
      { operationId: 'a', targetAddress: 'x', params: {}, exposure: 'l1_self_service' },
      { operationId: 'b', targetAddress: 'y', params: {}, exposure: 'engineer_only' },
    ];
    expect(changeSetRequirement(items).tier).toBe('engineer');
  });

  it('exposureForTier is the exact inverse of reviewTierForExposure', () => {
    for (const e of ['l1_self_service', 'l1_with_guardrails', 'engineer_only'] as const) {
      expect(exposureForTier(reviewTierForExposure(e))).toBe(e);
    }
  });
});

/* ── editFor prebuilds the full submittable params (value coerced + target bound) ───────── */

describe('editFor — the cart edit carries submittable params', () => {
  it('binds the value param (coerced) and the inventory target for a scalar change', () => {
    const resize = opById('ec2-resize');
    const cap = buildCapability(resize, bastion);
    const cur = String(bastion.attributes.instance_type);
    const other = cur === 't3.large' ? 't3.xlarge' : 't3.large';
    const edit = editFor(cap, bastion.address, other)!;
    expect(edit.params).toEqual({ new_instance_type: other, instance: bastion.address });
    expect(edit.exposure).toBe('l1_with_guardrails');
  });

  it('coerces a boolean toggle to a real boolean in params', () => {
    const pub = opById('ec2-toggle-associate-public-ip'); // forcesReplace bool toggle
    const cap = buildCapability(pub, bastion);
    const edit = editFor(cap, bastion.address, 'true');
    expect(edit).not.toBeNull();
    expect(edit!.params.enabled).toBe(true); // boolean, not the string 'true'
    expect(edit!.forcesReplace).toBe(true);
  });
});

/* ── cartToChangeSet: several settings on ONE resource → one change set (N ops × 1 target) ── */

describe('cartToChangeSet — multi-edit projection', () => {
  const editA: PendingEdit = {
    opId: 'ec2-resize',
    service: 'ec2',
    targetAddress: bastion.address,
    fieldLabel: 'Type',
    opHeadline: 'Resize',
    paramName: 'new_instance_type',
    nextValue: 't3.large',
    params: { new_instance_type: 't3.large', instance: bastion.address },
    currentDisplay: 't3.small',
    nextDisplay: 't3.large',
    forcesReplace: false,
    exposure: 'l1_with_guardrails',
  };
  const editReplace: PendingEdit = {
    ...editA,
    opId: 'ec2-toggle-associate-public-ip',
    paramName: 'enabled',
    nextValue: 'true',
    params: { enabled: true, instance: bastion.address },
    forcesReplace: true,
    exposure: 'engineer_only',
  };

  it('projects each edit to {operationId, targetAddress, params}, sharing justification + schedule', () => {
    const draft = cartToChangeSet([editA], 'grow the bastion for the migration window', { kind: 'now' });
    expect(draft.items).toEqual([
      { operationId: 'ec2-resize', targetAddress: bastion.address, params: { new_instance_type: 't3.large', instance: bastion.address } },
    ]);
    expect(draft.justification).toContain('migration');
    expect(draft.schedule).toEqual({ kind: 'now' });
  });

  it('attaches the shared replaceConfirmation ONLY to forces-replace items', () => {
    const draft = cartToChangeSet([editA, editReplace], 'justification long enough to pass', { kind: 'now' }, bastion.address);
    const plain = draft.items.find((i) => i.operationId === 'ec2-resize')!;
    const rebuild = draft.items.find((i) => i.operationId === 'ec2-toggle-associate-public-ip')!;
    expect(plain.replaceConfirmation).toBeUndefined();
    expect(rebuild.replaceConfirmation).toBe(bastion.address);
  });

  it('the combined cart requirement is the strictest across the edits', () => {
    expect(cartRequirement([editA]).approvalsRequired).toBe(2); // guardrails
    expect(cartRequirement([editA, editReplace]).tier).toBe('engineer'); // forces-replace floors it
  });
});

/* ── bulkToChangeSet: one action fanned across N targets (1 op × N targets) ─────────────── */

describe('bulkToChangeSet — one op × N targets', () => {
  it('builds one item per target with the shared params + each item’s own target bound', () => {
    const resize = opById('ec2-resize');
    const targets = ['aws_instance.a', 'aws_instance.b', 'aws_instance.c'];
    const draft = bulkToChangeSet(resize, targets, { new_instance_type: 't3.large' }, 'rightsize the fleet for month end', { kind: 'now' });
    expect(draft.items).toHaveLength(3);
    expect(draft.items.map((i) => i.targetAddress)).toEqual(targets);
    expect(draft.items.every((i) => i.operationId === 'ec2-resize')).toBe(true);
    // each item carries the shared value AND its own inventory target
    expect(draft.items[0]!.params).toEqual({ new_instance_type: 't3.large', instance: 'aws_instance.a' });
    expect(draft.items[2]!.params).toEqual({ new_instance_type: 't3.large', instance: 'aws_instance.c' });
  });

  it('bulkRequirement is that op’s tier (guardrails → required 2)', () => {
    expect(bulkRequirement(opById('ec2-resize'), 5).approvalsRequired).toBe(2);
  });

  it('isBulkableAction excludes forces-replace ops (they keep the single-resource path)', () => {
    expect(isBulkableAction(opById('ec2-resize'))).toBe(true);
    expect(isBulkableAction(opById('ec2-toggle-associate-public-ip'))).toBe(false);
  });
});

/* ── the bulk multi-select reducers + route round-trip ──────────────────────────────────── */

describe('multi-select reducers (pure)', () => {
  it('toggleSelection adds an absent address and removes a present one', () => {
    let s: ReadonlySet<string> = new Set();
    s = toggleSelection(s, 'a');
    expect([...s]).toEqual(['a']);
    s = toggleSelection(s, 'b');
    expect(s.has('a') && s.has('b')).toBe(true);
    s = toggleSelection(s, 'a');
    expect([...s]).toEqual(['b']);
  });

  it('selectAll / deselectAll / allSelected operate over a group of addresses', () => {
    const group = ['a', 'b', 'c'];
    let s = selectAll(new Set(['z']), group);
    expect(allSelected(s, group)).toBe(true);
    expect(s.has('z')).toBe(true); // leaves others untouched
    s = deselectAll(s, group);
    expect(allSelected(s, group)).toBe(false);
    expect(s.has('z')).toBe(true);
    expect(allSelected(new Set(), [])).toBe(false); // empty group is never "all selected"
  });
});

describe('bulk route helpers', () => {
  it('bulkHref + parseBulkTargets round-trip the selected addresses', () => {
    const targets = ['aws_instance.a', 'aws_instance.b'];
    const href = bulkHref('ec2', 'ec2-resize', targets);
    expect(href).toContain('/services/ec2/bulk/ec2-resize?targets=');
    const query = new URL('http://x' + href).searchParams.get('targets');
    expect(parseBulkTargets(query)).toEqual(targets);
  });

  it('parseBulkTargets de-duplicates and drops blanks', () => {
    expect(parseBulkTargets('a,a,,b, c ')).toEqual(['a', 'b', 'c']);
    expect(parseBulkTargets(null)).toEqual([]);
  });
});
