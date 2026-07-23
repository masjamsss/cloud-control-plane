import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { OP_GROUPS } from '@/types/manifestSchema';
import type { ManifestOperation } from '@/types';
import {
  actionHref,
  filterAction,
  GROUP_LABELS,
  groupScopedActions,
  isProvisionAdd,
  isResourceScopedAdd,
  isScopedAction,
  menuItemCount,
  PICKER_GROUPS,
  pinnedActions,
  presentGroups,
  RESOURCE_ACTION_GROUPS,
} from '@/lib/actionPicker';

/**
 * 0008 §2/§4 Task 3 — the scoped action picker's pure data layer. Fixtures
 * lean on the real catalog's two measured worst cases from the decision doc
 * (§1: "aws_dlm_lifecycle_policy 42" ops on a flat menu) and the one
 * resourceType carrying a Move op (§1: "the 2 Move ops are unreachable from
 * any console surface — orphaned"), so these tests are regression-proof
 * against the exact numbers the doc used to justify the picker.
 */

function opsFor(resourceType: string): ManifestOperation[] {
  return manifests
    .flatMap((m) => m.operations)
    .filter((op) => op.target.resourceType === resourceType);
}

const dlmOps = opsFor('aws_dlm_lifecycle_policy');
const dlmScoped = dlmOps.filter(isScopedAction);
const wafAclOps = opsFor('aws_wafv2_web_acl');
const wafAclScoped = wafAclOps.filter(isScopedAction);

describe('RESOURCE_ACTION_GROUPS — the 7 non-create groups, fixed 0008 §3 order', () => {
  it('is OP_GROUPS with "create" dropped, order preserved', () => {
    expect(RESOURCE_ACTION_GROUPS).toEqual(OP_GROUPS.filter((g) => g !== 'create'));
    expect(RESOURCE_ACTION_GROUPS).not.toContain('create');
    expect(RESOURCE_ACTION_GROUPS).toHaveLength(7);
  });

  it('every group has a display label', () => {
    for (const g of RESOURCE_ACTION_GROUPS) {
      expect(GROUP_LABELS[g], g).toBeTruthy();
    }
  });
});

describe('isScopedAction — everything except Create belongs on a resource menu/picker', () => {
  it('true for Change, Delete, and Move', () => {
    expect(isScopedAction({ macd: 'Change' })).toBe(true);
    expect(isScopedAction({ macd: 'Delete' })).toBe(true);
    expect(isScopedAction({ macd: 'Move' })).toBe(true);
  });
  it('false for Add — Create is service-scoped only, never per-resource', () => {
    expect(isScopedAction({ macd: 'Add' })).toBe(false);
  });
});

describe("groupScopedActions — aws_dlm_lifecycle_policy (0008 §1's worst case: 42 ops)", () => {
  it('every one of the 42 scoped ops is measured the same as the decision doc', () => {
    expect(dlmScoped).toHaveLength(42);
  });

  it('the picker shows all 42, grouped — none dropped, none duplicated', () => {
    const buckets = groupScopedActions(dlmScoped);
    const total = buckets.reduce((n, b) => n + b.ops.length, 0);
    expect(total).toBe(42);
    const allIds = buckets.flatMap((b) => b.ops.map((op) => op.id));
    expect(new Set(allIds).size).toBe(42);
  });

  it('buckets appear in the fixed 0008 §3 order, empty groups dropped', () => {
    const buckets = groupScopedActions(dlmScoped);
    const order = buckets.map((b) => b.group);
    // dlm only has ops in these 3 of the 7 groups — but they must appear in
    // the CANONICAL order (protection-backup, tags-naming, danger-zone),
    // not insertion/frequency order.
    expect(order).toEqual(['protection-backup', 'tags-naming', 'danger-zone']);
  });

  it('danger-zone ops are bucketed and labelled, not hidden or filtered out', () => {
    const buckets = groupScopedActions(dlmScoped);
    const dangerBucket = buckets.find((b) => b.group === 'danger-zone');
    expect(dangerBucket).toBeDefined();
    expect(dangerBucket!.label).toBe('Danger zone');
    expect(dangerBucket!.ops.length).toBeGreaterThan(0);
  });
});

describe('pinnedActions — the ≤5 "Common" shortlist (0008 §4 Task 3 ResourceRow swap)', () => {
  it('a type with 42 scoped ops renders a menu of ≤6 items (≤5 pinned + "All actions…")', () => {
    const pinned = pinnedActions(dlmScoped);
    expect(pinned.length).toBeLessThanOrEqual(5);
    const menuItemCount = pinned.length + 1; // + the "All actions… (N)" item
    expect(menuItemCount).toBeLessThanOrEqual(6);
    // Concretely, for the real dlm data today:
    expect(pinned).toHaveLength(5);
  });

  it('pinned ops are ordered by their pinned rank, ascending', () => {
    const pinned = pinnedActions(dlmScoped);
    expect(pinned.map((op) => op.id)).toEqual([
      'dlm-set-retention-count',
      'dlm-set-schedule-time',
      'dlm-set-description',
      'dlm-set-create-interval',
      'dlm-set-default-copy-tags',
    ]);
  });

  it('never includes a Move op — dangerous ops are never one-click (0008 §3)', () => {
    const pinned = pinnedActions(wafAclScoped);
    expect(pinned.every((op) => op.macd !== 'Move')).toBe(true);
    expect(pinned.some((op) => op.id === 'waf-move-rule-priority')).toBe(false);
  });

  it('caps at 5 even given a hypothetical longer pinned list (defensive slice)', () => {
    const base = dlmScoped.find((op) => op.pinned === 1)!;
    const synthetic: ManifestOperation[] = Array.from({ length: 8 }, (_, i) => ({
      ...base,
      id: `${base.id}-synthetic-${i}`,
      pinned: (i % 5) + 1,
    }));
    expect(pinnedActions(synthetic).length).toBeLessThanOrEqual(5);
  });
});

describe('presentGroups — empty-search state teaches only the categories that exist here', () => {
  it('dlm: protection-backup, tags-naming, danger-zone, in canonical order', () => {
    expect(presentGroups(dlmScoped)).toEqual(['protection-backup', 'tags-naming', 'danger-zone']);
  });

  it('a Change/Delete/Move-only set has no "create" bucket (dlmScoped carries no Add)', () => {
    // presentGroups CAN surface "create" now — but only for resource-scoped
    // Add ops (isResourceScopedAdd). dlmScoped is the isScopedAction subset
    // (no Add), so its picker still shows no "create". The combined set's
    // "create" bucket is covered in the isResourceScopedAdd suite below.
    expect(presentGroups(dlmScoped)).not.toContain('create');
  });

  it('empty input yields no groups to browse', () => {
    expect(presentGroups([])).toEqual([]);
  });
});

describe('the 2 Move ops — orphan-menu bug (0008 §1) fixed by construction', () => {
  it("aws_wafv2_web_acl's Move op is reachable via the scoped picker, in Danger zone", () => {
    const moveOp = wafAclScoped.find((op) => op.id === 'waf-move-rule-priority');
    expect(moveOp).toBeDefined();
    expect(moveOp!.group).toBe('danger-zone');
    const buckets = groupScopedActions(wafAclScoped);
    const dangerBucket = buckets.find((b) => b.group === 'danger-zone');
    expect(dangerBucket!.ops.map((op) => op.id)).toContain('waf-move-rule-priority');
  });

  it("aws_route_table_association's Move op is likewise reachable", () => {
    const ops = opsFor('aws_route_table_association').filter(isScopedAction);
    const moveOp = ops.find((op) => op.id === 'routing-move-subnet-association');
    expect(moveOp).toBeDefined();
    const buckets = groupScopedActions(ops);
    expect(buckets.find((b) => b.group === 'danger-zone')?.ops.map((op) => op.id)).toContain(
      'routing-move-subnet-association',
    );
  });
});

describe("actionHref — one function, identical URL shape for the pinned Link and the picker's navigate", () => {
  it('matches the pre-existing ResourceRow href format: /services/<slug>/<opId>?target=<address>', () => {
    const href = actionHref(
      'dlm',
      { id: 'dlm-set-retention-count' },
      { address: 'aws_dlm_lifecycle_policy.x' },
    );
    expect(href).toBe('/services/dlm/dlm-set-retention-count?target=aws_dlm_lifecycle_policy.x');
  });

  it('encodes special characters in the resource address', () => {
    const href = actionHref('ec2', { id: 'ec2-resize' }, { address: 'aws_instance.foo[0]' });
    expect(href).toBe(
      '/services/ec2/ec2-resize?target=' + encodeURIComponent('aws_instance.foo[0]'),
    );
    expect(href).toContain('aws_instance.foo%5B0%5D');
  });

  it('a pinned op navigates identically to before ResourceRow.tsx routed the full flat list', () => {
    // The OLD ResourceRow.tsx literally built this string inline for every
    // action in the flat list: '/services/' + serviceSlug + '/' + op.id +
    // '?target=' + encodeURIComponent(resource.address). Reproduced here
    // verbatim (not re-imported — it no longer exists in the component) so a
    // pinned op's href is byte-for-byte proven unchanged post-swap.
    const serviceSlug = 'dlm';
    const op = dlmScoped.find((o) => o.id === 'dlm-set-retention-count')!;
    const resource = { address: 'aws_dlm_lifecycle_policy.nightly' };
    const oldFormat =
      '/services/' + serviceSlug + '/' + op.id + '?target=' + encodeURIComponent(resource.address);
    expect(actionHref(serviceSlug, op, resource)).toBe(oldFormat);
  });
});

describe('menuItemCount — ResourceRow\'s ≤6-item menu (0008 §4 Task 3)', () => {
  it('aws_dlm_lifecycle_policy (42 scoped ops) renders exactly 6: 5 pinned + "All actions…"', () => {
    expect(menuItemCount(dlmScoped)).toBe(6);
  });

  it('never exceeds 6, however many ops a resource type has', () => {
    expect(menuItemCount(dlmScoped)).toBeLessThanOrEqual(6);
    expect(menuItemCount(wafAclScoped)).toBeLessThanOrEqual(6);
  });

  it('a resource type with zero pinned ops still renders 1 item — "All actions…" alone, never empty', () => {
    // aws_wafv2_ip_set has scoped ops in the real catalog but none pinned —
    // the menu degrades to just the browse-everything entry, never a blank menu.
    const ipSetOps = manifests
      .flatMap((m) => m.operations)
      .filter((op) => op.target.resourceType === 'aws_wafv2_ip_set')
      .filter(isScopedAction);
    expect(ipSetOps.length).toBeGreaterThan(0);
    expect(pinnedActions(ipSetOps)).toHaveLength(0);
    expect(menuItemCount(ipSetOps)).toBe(1);
  });
});

/**
 * 0034 A8 / 0033 P3 — the "Add new" split. An Add op provisions when it
 * stands up a NEW top-level resource; it attaches/annotates when it writes
 * into an existing one. The acceptance the wave names: tag-adds no longer
 * render beside provisioning as equal cards. Driven against the real catalog
 * so a future Add op is auto-classified and these pins catch a rule change.
 */
describe('isProvisionAdd — the Add-new Provision vs Attach & annotate split (0034 A8)', () => {
  const allOps = manifests.flatMap((m) => m.operations);
  const byId = new Map(allOps.map((op) => [op.id, op] as const));
  const op = (id: string): ManifestOperation => {
    const found = byId.get(id);
    expect(found, `op ${id} missing`).toBeDefined();
    return found!;
  };

  it('provision: every create baseline (create_resource + the instantiate_module vpn route)', () => {
    for (const id of [
      'ec2-provision-instance',
      'ebs-create-volume',
      's3-create-bucket',
      'sg-create-security-group',
      'alb-add-target-group',
      'efs-create-filesystem',
      'rds-provision-instance',
      'backup-create-vault',
      'backup-create-plan',
      'vpn-add-static-route',
    ]) {
      expect(isProvisionAdd(op(id)), id).toBe(true);
    }
  });

  it('provision: sibling-resource creates (snapshots) and per-entry resources (mount targets)', () => {
    expect(isProvisionAdd(op('ebs-create-snapshot'))).toBe(true);
    expect(isProvisionAdd(op('rds-create-manual-snapshot'))).toBe(true);
    expect(isProvisionAdd(op('efs-add-mount-target'))).toBe(true);
    expect(isProvisionAdd(op('sns-add-subscription'))).toBe(true);
  });

  it('attach & annotate: rule/entry adds into existing resources', () => {
    expect(isProvisionAdd(op('sg-add-internal-ingress-rule'))).toBe(false);
    expect(isProvisionAdd(op('s3-add-lifecycle-rule'))).toBe(false);
    expect(isProvisionAdd(op('backup-add-plan-rule'))).toBe(false);
    expect(isProvisionAdd(op('routing-add-route'))).toBe(false);
    expect(isProvisionAdd(op('acm-attach-sni-certificate'))).toBe(false);
    expect(isProvisionAdd(op('vpc-associate-subnet-default-network-acl'))).toBe(false);
  });

  it('attach & annotate: EVERY tag-add in the catalog (the P3 acceptance)', () => {
    const tagAdds = allOps.filter((o) => o.macd === 'Add' && o.target.block === 'tags');
    expect(tagAdds.length).toBeGreaterThanOrEqual(25);
    for (const o of tagAdds) {
      expect(isProvisionAdd(o), `${o.id} must not render beside provisioning`).toBe(false);
    }
  });

  it('non-Add ops are never provision cards', () => {
    expect(isProvisionAdd(op('ec2-resize'))).toBe(false);
  });
});

/**
 * 0034 go-live drill papercut #3 — the Add ops that OPERATE ON an existing
 * resource must be findable from that resource's Actions menu, pre-scoped to
 * it (before this, isScopedAction excluded every Add). Driven against the real
 * catalog so the classification is proven on the actual ops, and a future Add
 * op is auto-sorted the moment it lands.
 */
describe('isResourceScopedAdd — Add ops that operate on an existing resource (0034 papercut #3)', () => {
  const allOps = manifests.flatMap((m) => m.operations);
  const byId = new Map(allOps.map((o) => [o.id, o] as const));
  const op = (id: string): ManifestOperation => {
    const found = byId.get(id);
    expect(found, `op ${id} missing`).toBeDefined();
    return found!;
  };

  it('the drill examples surface, each anchored on the resource it operates on', () => {
    // rds-create-manual-snapshot is the drill S24 op: it must appear on the
    // RDS *instance*, not on a snapshot the operator is not viewing.
    expect(isResourceScopedAdd(op('rds-create-manual-snapshot'))).toBe(true);
    expect(op('rds-create-manual-snapshot').target.resourceType).toBe('aws_db_instance');
    expect(isResourceScopedAdd(op('ebs-create-snapshot'))).toBe(true);
    expect(op('ebs-create-snapshot').target.resourceType).toBe('aws_ebs_volume');
    // an SG add-rule, on each security group
    expect(isResourceScopedAdd(op('sg-add-internal-ingress-rule'))).toBe(true);
    expect(op('sg-add-internal-ingress-rule').target.resourceType).toBe('aws_security_group');
    // listener / cert attach, on the listener it attaches to
    expect(isResourceScopedAdd(op('acm-attach-sni-certificate'))).toBe(true);
    expect(isResourceScopedAdd(op('acm-lb-listener-add-tag'))).toBe(true);
    expect(op('acm-lb-listener-add-tag').target.resourceType).toBe('aws_lb_listener');
  });

  it('the sibling-resource creates (snapshot pattern) are scoped, not provisions', () => {
    // These are isProvisionAdd=true (append_block synthesizing an aws_ block) —
    // the carve-out that makes the W3 split alone insufficient: they anchor on
    // an EXISTING resource of a DIFFERENT type than the block they create.
    for (const id of [
      'ebs-create-snapshot',
      'rds-create-manual-snapshot',
      's3-enable-replication',
      'sagemaker-add-studio-user-profile',
    ]) {
      expect(isProvisionAdd(op(id)), `${id} is provision-shaped`).toBe(true);
      expect(isResourceScopedAdd(op(id)), `${id} still operates on an existing resource`).toBe(
        true,
      );
      const t = op(id).target;
      expect(t.block!.split('.')[0], `${id} block type differs from the anchor`).not.toBe(
        t.resourceType,
      );
    }
  });

  it('attach & annotate adds (tags, rules, list entries, associations) are all scoped', () => {
    for (const id of [
      'sg-add-internal-ingress-rule',
      'security-groups-add-egress-rule-self',
      's3-add-lifecycle-rule',
      'routing-add-route',
      'rds-instance-add-tag',
      'ec2-add-key-pair-tag',
      'cloudfront-add-alternate-domain',
      'vpc-associate-subnet-default-network-acl',
      'acm-attach-sni-certificate',
    ]) {
      expect(isResourceScopedAdd(op(id)), id).toBe(true);
    }
  });

  it('NO provision create leaks in — every create_resource / instantiate_module is excluded', () => {
    const provisions = allOps.filter(
      (o) => o.codemodOp === 'create_resource' || o.codemodOp === 'instantiate_module',
    );
    // sanity: the catalog really does have both provision families
    expect(provisions.some((o) => o.codemodOp === 'create_resource')).toBe(true);
    expect(provisions.some((o) => o.codemodOp === 'instantiate_module')).toBe(true);
    const leaked = provisions.filter((o) => isResourceScopedAdd(o)).map((o) => o.id);
    expect(leaked, leaked.join('\n')).toEqual([]);
  });

  it('same-type / block-less / per-entry creates are provisions, not scoped', () => {
    // Creates a NEW instance of its own target type, or a wholly new top-level
    // resource — nothing existing to scope to. These stay in the "Add new" grid.
    for (const id of [
      'sns-add-subscription', // block === target type
      'secretsmanager-enable-rotation', // block "aws_…_rotation.<name>" === target type
      'efs-add-mount-target', // per-entry resource, block-less foreach
      'alb-add-listener-rule', // block-less append_block, own type
      'kms-add-alias',
      'route53-add-record',
      'ec2-provision-instance', // create_resource
      'iam-create-role', // instantiate_module
    ]) {
      expect(isResourceScopedAdd(op(id)), id).toBe(false);
    }
  });

  it('is false for every non-Add op (Change/Delete/Move are isScopedAction, not this)', () => {
    for (const o of allOps.filter((x) => x.macd !== 'Add')) {
      expect(isResourceScopedAdd(o), o.id).toBe(false);
    }
  });

  it('every resource-scoped Add carries a source:"inventory" param — so ?target= pre-fills', () => {
    // The pre-fill contract: actionHref threads ?target=<address>, and
    // RequestForm.seedValues writes it into the op's inventory-sourced param.
    // An op with none would render on the menu but pre-fill nothing.
    const scopedAdds = allOps.filter((o) => o.macd === 'Add' && isResourceScopedAdd(o));
    expect(scopedAdds.length).toBeGreaterThan(40);
    const noInvParam = scopedAdds
      .filter((o) => !o.params.some((p) => p.source === 'inventory'))
      .map((o) => o.id);
    expect(noInvParam, noInvParam.join('\n')).toEqual([]);
  });
});

/**
 * The combined resource menu (ServiceConsole.actionsFor): a resource type's
 * Change/Delete/Move ops PLUS the Add ops scoped to it — the exact predicate
 * the console filters by — exercised over the real manifests.
 */
describe('actionsFor combined set — Change/Delete/Move + resource-scoped Adds', () => {
  const all = manifests.flatMap((m) => m.operations);
  const combinedFor = (rt: string): ManifestOperation[] =>
    all.filter(
      (op) => op.target.resourceType === rt && (isScopedAction(op) || isResourceScopedAdd(op)),
    );
  const changeOnlyFor = (rt: string): ManifestOperation[] =>
    all.filter((op) => op.target.resourceType === rt && isScopedAction(op));

  it('PICKER_GROUPS leads with "create", then the 7 change groups in canonical order', () => {
    expect(PICKER_GROUPS).toEqual(['create', ...RESOURCE_ACTION_GROUPS]);
    expect(PICKER_GROUPS).toHaveLength(8);
    expect(PICKER_GROUPS[0]).toBe('create');
  });

  it('aws_db_instance now lists the manual snapshot (drill S24), pre-scoped', () => {
    const before = changeOnlyFor('aws_db_instance');
    const after = combinedFor('aws_db_instance');
    expect(before.some((o) => o.id === 'rds-create-manual-snapshot')).toBe(false);
    expect(after.some((o) => o.id === 'rds-create-manual-snapshot')).toBe(true);
    expect(after.some((o) => o.id === 'rds-instance-add-tag')).toBe(true);
    expect(after.length).toBe(before.length + 2);
    // pre-fill: the pinned/picker href threads ?target=<the instance address>
    const snap = after.find((o) => o.id === 'rds-create-manual-snapshot')!;
    expect(actionHref('rds', snap, { address: 'aws_db_instance.erp_db' })).toContain(
      '?target=aws_db_instance.erp_db',
    );
  });

  it('aws_security_group gains all five add-rule ops (2 → 7)', () => {
    const before = changeOnlyFor('aws_security_group');
    const after = combinedFor('aws_security_group');
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(7);
    for (const id of [
      'sg-add-internal-ingress-rule',
      'security-groups-add-ingress-rule-from-security-group',
      'security-groups-add-ingress-rule-self',
      'security-groups-add-egress-rule-to-security-group',
      'security-groups-add-egress-rule-self',
    ]) {
      expect(after.some((o) => o.id === id), id).toBe(true);
    }
  });

  it('aws_ebs_volume gains snapshot-this-volume', () => {
    expect(combinedFor('aws_ebs_volume').some((o) => o.id === 'ebs-create-snapshot')).toBe(true);
  });

  it('every resource-scoped Add is reachable from its own target type', () => {
    const scopedAdds = all.filter((o) => o.macd === 'Add' && isResourceScopedAdd(o));
    const unreachable = scopedAdds
      .filter((o) => !combinedFor(o.target.resourceType).some((x) => x.id === o.id))
      .map((o) => o.id);
    expect(unreachable, unreachable.join('\n')).toEqual([]);
  });

  it('NO provision create leaks into any resource menu (across every target type)', () => {
    const provisions = all.filter(
      (o) => o.codemodOp === 'create_resource' || o.codemodOp === 'instantiate_module',
    );
    const leaked = provisions
      .filter((o) => combinedFor(o.target.resourceType).some((x) => x.id === o.id))
      .map((o) => `${o.id} → ${o.target.resourceType}`);
    expect(leaked, leaked.join('\n')).toEqual([]);
  });

  it('the picker buckets the scoped Adds under a leading "Create" group; provisions absent', () => {
    const buckets = groupScopedActions(combinedFor('aws_security_group'));
    expect(buckets[0]!.group).toBe('create');
    expect(buckets[0]!.label).toBe(GROUP_LABELS.create);
    const createIds = buckets[0]!.ops.map((o) => o.id);
    expect(createIds).toContain('sg-add-internal-ingress-rule');
    // sg-create-security-group is a create_resource provision — never here
    expect(createIds).not.toContain('sg-create-security-group');
    expect(presentGroups(combinedFor('aws_security_group'))[0]).toBe('create');
  });

  it('adding scoped Adds never grows the one-click shortlist — no Add is pinnable', () => {
    // pinnedActions still ≤5 and menuItemCount still ≤6: no Add op carries a
    // `pinned` rank, so scoped Adds are reachable only via "All actions…".
    for (const rt of ['aws_db_instance', 'aws_security_group', 'aws_ebs_volume']) {
      const combined = combinedFor(rt);
      expect(pinnedActions(combined).every((o) => o.macd !== 'Add')).toBe(true);
      expect(menuItemCount(combined)).toBeLessThanOrEqual(6);
    }
  });
});

/**
 * LD-3 (2026-07-21 journey sim) — the picker's search barely narrowed a real
 * query: cmdk's default scorer concatenates title + the full prose
 * description into one blob and scores it as a whole, so a long paragraph's
 * incidental letter overlap kept most of a resource type's ~38 ops
 * "matched" (a verbatim-substring query left 28 of ~38 visible, the real hit
 * buried). Driven against the exact resource type (aws_instance, the
 * picker's real combined set) and query ("remove a tag") the finding
 * reproduced with.
 */
describe('filterAction — cmdk search filter (LD-3: real queries must narrow)', () => {
  const ec2InstanceOps = opsFor('aws_instance').filter(
    (op) => isScopedAction(op) || isResourceScopedAdd(op),
  );

  // Mirrors ActionPicker.tsx's Command.Item exactly: value=op.id,
  // keywords=[title, description, summary?] in that fixed order.
  function scoreOp(op: ManifestOperation, search: string): number {
    const keywords = [op.title, op.description, ...(op.summary ? [op.summary] : [])];
    return filterAction(op.id, search, keywords);
  }
  function visibleFor(search: string): ManifestOperation[] {
    return ec2InstanceOps.filter((op) => scoreOp(op, search) > 0);
  }

  it('has enough real ops to be a meaningful fixture (the ~38-op picker LD-3 measured)', () => {
    expect(ec2InstanceOps.length).toBeGreaterThan(35);
  });

  it('a real multi-word substring narrows to (near-)exactly the matching op, not most of the list', () => {
    const visible = visibleFor('remove a tag');
    expect(visible.map((op) => op.id)).toContain('ec2-remove-instance-tag');
    // LD-3 measured 28 of ~38 left visible for this exact query; narrowing to
    // a small handful (not dozens) is the acceptance bar.
    expect(visible.length).toBeLessThanOrEqual(3);
  });

  it('the real match sorts first among whatever else passes', () => {
    const scored = ec2InstanceOps
      .map((op) => ({ id: op.id, score: scoreOp(op, 'remove a tag') }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    expect(scored[0]?.id).toBe('ec2-remove-instance-tag');
  });

  it('a short, common single word narrows to its real title/id matches, not almost everything', () => {
    // Every op in this set shares enough prose vocabulary that cmdk's raw
    // default filter left the vast majority "matched" for a word this common.
    const visible = visibleFor('toggle');
    const byTitleOrId = visible.filter((op) => /toggle/i.test(op.title) || /toggle/i.test(op.id));
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(ec2InstanceOps.length - 15);
    // Full recall of the ops that are actually "Toggle …"-titled (id carries
    // the verb even where the title itself reads "Set …", e.g.
    // ec2-toggle-root-encrypted → "Set root volume encryption").
    expect(byTitleOrId.length).toBeGreaterThanOrEqual(14);
    // The rest, if any, must clear the same bar every other match does — a
    // real description-level hit (e.g. "toggling the IPv6 IMDS endpoint"),
    // never the whole remaining pool.
    expect(visible.length - byTitleOrId.length).toBeLessThanOrEqual(2);
  });

  it('a nonsense query still yields no matches at all — the pre-existing "No actions match" state', () => {
    expect(visibleFor('xkqzjw')).toHaveLength(0);
    expect(visibleFor('zzqxxvnnbbmm')).toHaveLength(0);
  });

  it('an empty search never zeroes out (cmdk itself skips calling filter when search is falsy)', () => {
    expect(filterAction('any-op-id', '', ['Any title'])).toBeGreaterThan(0);
  });

  it('a description/summary-only term (absent from the title) can still surface its op', () => {
    const op = ec2InstanceOps.find((o) => o.id === 'ec2-remove-instance-tag')!;
    expect(op.title.toLowerCase()).not.toContain('governance');
    expect(`${op.description} ${op.summary ?? ''}`.toLowerCase()).toContain('governance');
    expect(scoreOp(op, 'governance')).toBeGreaterThan(0);
  });

  it('scores a real title match highly regardless of field order', () => {
    const op = ec2InstanceOps.find((o) => o.id === 'ec2-resize')!;
    expect(scoreOp(op, op.title)).toBeGreaterThan(0.5);
  });
});
