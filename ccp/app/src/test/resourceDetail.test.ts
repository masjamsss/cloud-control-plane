import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Inventory, InventoryResource, ManifestOperation, ServiceManifest } from '@/types';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import { displayResourceLabel } from '@/lib/chipLabel';
import {
  attrForOp,
  buildCapability,
  buildResourceSections,
  currentValueForOp,
  displayCurrent,
  editableValueParams,
  humanizeResourceType,
  isInlineEditable,
  type Capability,
} from '@/lib/resourceDetail';
import {
  applyChoice,
  cartHasRebuild,
  editFor,
  editLine,
  removeEdit,
  upsertEdit,
} from '@/lib/resourceEdits';
import { ResourceDetailView } from '@/features/services/ResourceDetail';

/**
 * Coverage for the resource detail page (Phase A), in the repo's no-jsdom style
 * (pure functions + renderToStaticMarkup). Four concerns, matching the build:
 * the manifest→sections GENERATION, the op→current-value MAPPING (and its
 * honest limits), the client-side pending CART, and a full SSR render for a real
 * EC2 instance (its ~39 aws_instance capabilities).
 */

const inventory = inventoryData as unknown as Inventory;
const ec2: ServiceManifest = manifests.find((m) => m.service === 'ec2')!;
const opById = (id: string): ManifestOperation => ec2.operations.find((o) => o.id === id)!;

/** All ops targeting aws_instance — the resource type's full capability set. */
const instanceOps = ec2.operations.filter((o) => o.target.resourceType === 'aws_instance');

/** A real EC2 instance whose current type is a known, editable current value. */
const bastion: InventoryResource = inventory.resources.find(
  (r) => r.address === 'aws_instance.bastion',
)!;

describe('resource detail — the bundled catalog + estate loaded (sanity)', () => {
  it('aws_instance has its rich capability set and the fixture exists', () => {
    expect(ec2).toBeDefined();
    expect(instanceOps.length).toBeGreaterThanOrEqual(35);
    expect(bastion).toBeDefined();
    expect(typeof bastion.attributes.instance_type).toBe('string');
  });
});

/* ── 1. Manifest → tabbed sections generation ─────────────────────────────── */

describe('sections generation — buildResourceSections', () => {
  const sections = buildResourceSections(bastion, instanceOps);

  it('every op targeting the type becomes a capability (never hand-listed)', () => {
    expect(sections.capabilityCount).toBe(instanceOps.length);
    expect(sections.editableCount).toBeGreaterThan(0);
    expect(sections.editableCount).toBeLessThan(sections.capabilityCount);
  });

  it('leads with a read-only Details (context) tab, then one tab per present group', () => {
    const first = sections.tabs[0]!;
    expect(first.id).toBe('details');
    expect(first.kind).toBe('context');
    expect(first.contextRows.length).toBeGreaterThan(0);

    const groupTabs = sections.tabs.slice(1);
    expect(groupTabs.length).toBeGreaterThan(0);
    expect(groupTabs.every((t) => t.kind === 'capabilities')).toBe(true);
    // Only groups that actually have ops appear — every group tab is non-empty.
    expect(groupTabs.every((t) => t.capabilities.length > 0)).toBe(true);
    // Group tab ids are real OpGroups drawn from the ops present.
    const present = new Set(instanceOps.map((o) => o.group));
    expect(groupTabs.every((t) => present.has(t.id as never))).toBe(true);
  });

  it('every capability lands in exactly one tab; the total matches the op count', () => {
    const placed = sections.tabs.reduce((n, t) => n + t.capabilities.length, 0);
    expect(placed).toBe(instanceOps.length);
  });

  it('a context row is never also shown as an inline capability current value', () => {
    const claimedAttr = 'instance_type'; // the resize op owns this inline
    const details = sections.tabs.find((t) => t.id === 'details')!;
    expect(details.contextRows.some((r) => r.attr === claimedAttr)).toBe(false);
    // …but an attribute no op edits IS a context row (private_ip is not editable).
    expect(details.contextRows.some((r) => r.attr === 'private_ip')).toBe(true);
  });

  it('the summary strip carries id, humanized type, and significance-ordered facts', () => {
    expect(sections.summary.address).toBe('aws_instance.bastion');
    expect(sections.summary.rawType).toBe('aws_instance');
    expect(sections.summary.resourceType).toBe('Instance');
    expect(sections.summary.facts.length).toBeGreaterThan(0);
  });

  it('humanizeResourceType strips aws_ and restores acronyms', () => {
    expect(humanizeResourceType('aws_instance')).toBe('Instance');
    expect(humanizeResourceType('aws_db_instance')).toBe('DB instance');
    expect(humanizeResourceType('aws_vpc')).toBe('VPC');
  });
});

/* ── 2. Op → current-value mapping (and its limits) ───────────────────────── */

describe('op → current-value mapping', () => {
  it('a scalar Change joins target.attr to the inventory value', () => {
    const resize = opById('ec2-resize');
    expect(attrForOp(resize)).toBe('instance_type');
    expect(currentValueForOp(resize, bastion)).toBe(bastion.attributes.instance_type);
    expect(isInlineEditable(resize)).toBe(true);
    // editable via a single value param (the new size), not the inventory target.
    expect(editableValueParams(resize).map((p) => p.name)).toEqual(['new_instance_type']);
    const cap = buildCapability(resize, bastion);
    expect(cap.editable).toBe(true);
    expect(cap.currentValue).toBe(bastion.attributes.instance_type);
    expect(displayCurrent(cap)).toBe(String(bastion.attributes.instance_type));
  });

  it('LIMIT: an attribute absent from the curated snapshot has no current value', () => {
    const term = opById('ec2-toggle-termination-protection');
    expect(attrForOp(term)).toBe('disable_api_termination');
    // bastion's captured attributes do not include this one → undefined, not a default.
    expect(bastion.attributes.disable_api_termination).toBeUndefined();
    expect(currentValueForOp(term, bastion)).toBeUndefined();
    const cap = buildCapability(term, bastion);
    expect(cap.editable).toBe(true); // still editable — the control just isn't pre-filled
    expect(displayCurrent(cap)).toBe('—');
  });

  it('LIMIT: a block/tuple op (tags) has no scalar attr and is not inline-editable', () => {
    const addTag = opById('ec2-add-instance-tag');
    expect(attrForOp(addTag)).toBeUndefined();
    expect(isInlineEditable(addTag)).toBe(false); // it's an Add → an action, not an inline edit
    expect(buildCapability(addTag, bastion).editable).toBe(false);
  });

  it('a forcesReplace scalar toggle is editable and flagged as a rebuild', () => {
    const pub = opById('ec2-toggle-associate-public-ip');
    const cap = buildCapability(pub, bastion);
    expect(cap.editable).toBe(true);
    expect(cap.forcesReplace).toBe(true);
    expect(cap.control?.kind).toBe('toggle');
  });
});

/* ── 3. The pending-changes cart ──────────────────────────────────────────── */

describe('pending cart — resourceEdits', () => {
  const resizeCap: Capability = buildCapability(opById('ec2-resize'), bastion);
  const currentType = String(bastion.attributes.instance_type);
  const otherType = currentType === 't3.large' ? 't3.xlarge' : 't3.large';

  it('a real delta becomes an edit; a no-op (back to current) does not', () => {
    expect(editFor(resizeCap, bastion.address, otherType)).not.toBeNull();
    expect(editFor(resizeCap, bastion.address, currentType)).toBeNull();
    expect(editFor(resizeCap, bastion.address, '')).toBeNull();
  });

  it('an edit records the field, before→after, and the target', () => {
    const edit = editFor(resizeCap, bastion.address, otherType)!;
    expect(edit.opId).toBe('ec2-resize');
    expect(edit.targetAddress).toBe(bastion.address);
    expect(edit.fieldLabel).toBe('Type'); // chip label for instance_type
    expect(edit.paramName).toBe('new_instance_type');
    expect(edit.nextValue).toBe(otherType);
    expect(editLine(edit)).toBe(`Type: ${currentType} → ${otherType}`);
    expect(edit.forcesReplace).toBe(false);
  });

  it('applyChoice upserts a delta and drops it when the value returns to current', () => {
    let cart = applyChoice([], resizeCap, bastion.address, otherType);
    expect(cart).toHaveLength(1);
    // change again on the SAME capability → replace, not duplicate
    cart = applyChoice(cart, resizeCap, bastion.address, 't3.small');
    expect(cart).toHaveLength(1);
    expect(cart[0]!.nextValue).toBe('t3.small');
    // back to current → the edit clears itself
    cart = applyChoice(cart, resizeCap, bastion.address, currentType);
    expect(cart).toHaveLength(0);
  });

  it('upsert/remove are keyed by op id and edits from different tabs coexist', () => {
    const resizeEdit = editFor(resizeCap, bastion.address, otherType)!;
    const pubCap = buildCapability(opById('ec2-toggle-associate-public-ip'), bastion);
    const pubEdit = editFor(pubCap, bastion.address, 'true')!;
    let cart = upsertEdit([], resizeEdit);
    cart = upsertEdit(cart, pubEdit); // a danger-zone edit alongside a scale edit
    expect(cart).toHaveLength(2);
    expect(cartHasRebuild(cart)).toBe(true); // the public-IP toggle rebuilds
    cart = removeEdit(cart, 'ec2-toggle-associate-public-ip');
    expect(cart).toHaveLength(1);
    expect(cartHasRebuild(cart)).toBe(false);
  });
});

/* ── 4. Full SSR render for a real EC2 instance ───────────────────────────── */

describe('ResourceDetailView — renders a real aws_instance (SSR)', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ResourceDetailView, {
        serviceSlug: 'ec2',
        resource: bastion,
        ops: instanceOps,
      }),
    ),
  );

  it('shows the summary strip: display name, address, humanized type', () => {
    expect(html).toContain(`class="rd-summary__name">${displayResourceLabel(bastion)}`);
    expect(html).toContain('aws_instance.bastion');
    expect(html).toContain('>Instance<'); // humanized aws_instance
    expect(html).toContain(`${instanceOps.length.toLocaleString()} managed`);
  });

  it('renders accessible tabs (tablist/tab/tabpanel) including Details + group tabs', () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('Details');
    expect(html).toContain('Scale &amp; performance');
    expect(html).toContain('Danger zone');
  });

  it('fills the resize capability with the instance current value', () => {
    expect(html).toContain(String(bastion.attributes.instance_type));
  });

  it('flags a forcesReplace capability as a rebuild', () => {
    expect(html).toContain('Rebuilds');
  });

  it('shows the empty pending-changes cart ready to collect edits', () => {
    expect(html).toContain('Pending changes');
  });
});
