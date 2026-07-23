import { describe, expect, it } from 'vitest';
import type { Inventory, ManifestOperation } from '@/types';
import { manifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';
import { getOperation } from '@/lib/interpreter';
import {
  generateDiff,
  isAttributeLevelOp,
  isRemoveOp,
  isSubBlockOp,
  isWholeResourceRemoveBlockOp,
  plainSummary,
} from '@/lib/diff';

const inventory = inventoryData as unknown as Inventory;

function op(id: string): ManifestOperation {
  const found = getOperation(id, manifests);
  if (!found) throw new Error('missing op ' + id);
  return found;
}

describe('generateDiff — deterministic Terraform mock', () => {
  const resize = op('ec2-resize');
  // a real instance from the sample estate baseline (t3.large)
  const values = { instance: 'aws_instance.app01', new_instance_type: 'r6i.2xlarge' };

  it('renders an in-place OLD -> NEW change against the live inventory value', () => {
    const diff = generateDiff(resize, values, inventory);
    expect(diff).toContain('resource "aws_instance" "app01"');
    expect(diff).toContain('"t3.large" -> "r6i.2xlarge"'); // current pulled from real inventory
    expect(diff).toContain('(Change)');
  });

  it('renders a Delete as removal lines, never a fabricated whole-resource destroy', () => {
    const del = op('ec2-remove-instance-tag');
    const diff = generateDiff(
      del,
      { instance: 'aws_instance.app01', tag_key: 'Temporary' },
      inventory,
    );
    expect(diff).toContain('(Delete)');
    expect(diff).toContain('- tag_key = "Temporary"');
    // LD-1: the exact drill lie — a tag removal must never read as destroying
    // the instance it's a metadata edit on.
    expect(diff).not.toContain('- resource "aws_instance"');
    expect(diff).not.toMatch(/^-\s*resource/m);
  });

  it('omits empty optional params', () => {
    const diff = generateDiff(
      resize,
      { instance: 'aws_instance.app01', new_instance_type: '' },
      inventory,
    );
    expect(diff).not.toContain('instance_type =');
  });
});

/**
 * LD-1 — the review artifact's other lie: a tag/entry REMOVAL (Delete +
 * remove_foreach_entry) rendered as `- resource "<target>" { … }`, read by a
 * reviewer as destroying the whole host. generateDiff() had a real-delta
 * branch for the Add-direction append_foreach_entry (renderAppendDelta) but
 * none for the mirror Delete-direction codemod; this is the companion of
 * diffAppend.test.ts's "honest append delta" suite for the opposite MACD.
 */
describe('generateDiff — honest remove delta (LD-1)', () => {
  it('isRemoveOp is true only for the genuine MACD "Delete" removals', () => {
    expect(isRemoveOp(op('ec2-remove-instance-tag'))).toBe(true);
    // Same codemod, MACD "Change" — already rendered correctly through the
    // generic fallback before this fix and deliberately left alone.
    expect(isRemoveOp(op('dynamodb-remove-tag'))).toBe(false);
    // A different codemod entirely (Add direction) is never a remove op.
    expect(isRemoveOp(op('ec2-add-instance-tag'))).toBe(false);
    // A genuine whole-resource Delete (remove_block) is not this class either.
    expect(isRemoveOp(op('ebs-delete-volume'))).toBe(false);
  });

  it('a single-key tag removal names the key, not the whole aws_instance', () => {
    const diff = generateDiff(
      op('ec2-remove-instance-tag'),
      { instance: 'aws_instance.app01', tag_key: 'Temporary' },
      inventory,
    );
    expect(diff).toContain('(Delete)');
    expect(diff).toContain('removes a tags entry from aws_instance.app01');
    expect(diff).toContain('- tag_key = "Temporary"');
    expect(diff).not.toContain('resource "aws_instance"');
    expect(diff).not.toContain('⚠');
  });

  it('a multi-param removal (an NACL rule, identified by direction + rule number) lists both, not the whole ACL', () => {
    const diff = generateDiff(
      op('vpc-remove-nacl-rule'),
      { nacl: 'aws_network_acl.isolated', direction: 'ingress', rule_no: 100 },
      inventory,
    );
    expect(diff).toContain('(Delete)');
    expect(diff).toContain('removes a ingress/egress entry from aws_network_acl.isolated');
    expect(diff).toContain('- direction = "ingress"');
    expect(diff).toContain('- rule_no = 100');
    expect(diff).not.toContain('resource "aws_network_acl"');
  });

  it('the Change-MACD sibling of the same codemod is untouched by this fix (already correct)', () => {
    const diff = generateDiff(
      op('dynamodb-remove-tag'),
      { table: 'aws_dynamodb_table.pending_alarms', key: 'Temporary' },
      inventory,
    );
    // Falls through to the generic fallback: `~` (update), not `-` (destroy) —
    // correct before this change and unaffected by it.
    expect(diff).toContain('(Change)');
    expect(diff).toContain('~ resource "aws_dynamodb_table" "pending_alarms" {');
  });

  it('every remove_foreach_entry Delete op in the whole catalog never fabricates a whole-resource line', () => {
    const removeOps = manifests.flatMap((m) => m.operations).filter((o) => isRemoveOp(o));
    // Guard against a silent classification regression (the catalog carries
    // 20+ tag/entry-removal ops across services).
    expect(removeOps.length).toBeGreaterThan(20);
    for (const o of removeOps) {
      const values: Record<string, unknown> = {};
      for (const p of o.params) {
        if (p.source === 'inventory') values[p.name] = `${o.target.resourceType}.placeholder`;
        else if (p.type === 'number') values[p.name] = 1;
        else values[p.name] = 'x';
      }
      const diff = generateDiff(o, values, inventory);
      expect(
        diff,
        `${o.id} must not fabricate a whole ${o.target.resourceType} block`,
      ).not.toContain(`resource "${o.target.resourceType}"`);
      expect(diff, `${o.id} must not open with a destroy-sigil line`).not.toMatch(/^-\s*resource/m);
    }
  });
});

/**
 * Review-truthfulness round 2 — the SAME fabricating-fallback class remained
 * for SUB-BLOCK-scoped remove_block / append_block ops: a tag, an ingress
 * rule, a WAF rule, a policy attachment, a dead-letter-queue config. #116
 * deliberately left append_block/remove_block MACD-keyed (its own
 * isAttributeLevelOp docstring: "disambiguating those two shapes is out of
 * scope here") because those two codemods can ALSO be a genuine
 * whole-resource create/destroy (ebs-delete-volume). This suite proves the
 * disambiguation: sub-block ops get the honest small delta named by the op's
 * own params; genuine whole-resource ops — including the ones whose
 * target.block happens to be SET (sns-delete-topic, secretsmanager-schedule-
 * deletion, secretsmanager-disable-rotation, config-remove-managed-rule,
 * autoscaling-delete-scaling-policy) — still render as a real destroy.
 */
describe('generateDiff — honest sub-block delta (review-truthfulness round 2)', () => {
  it('isWholeResourceRemoveBlockOp is true only for a genuine whole-resource remove_block Delete', () => {
    // Bare resourceType target — the plain whole-resource case.
    expect(isWholeResourceRemoveBlockOp(op('ebs-delete-volume'))).toBe(true);
    expect(isWholeResourceRemoveBlockOp(op('cloudwatch-delete-alarm'))).toBe(true);
    // target.block IS set on these, but it names the resource type itself (or
    // a `.tf` file target) rather than a fragment of the picked resource's
    // body — still genuinely whole-resource despite `block` being non-empty.
    expect(isWholeResourceRemoveBlockOp(op('sns-delete-topic'))).toBe(true);
    expect(isWholeResourceRemoveBlockOp(op('sns-remove-subscription'))).toBe(true);
    expect(isWholeResourceRemoveBlockOp(op('secretsmanager-schedule-deletion'))).toBe(true);
    expect(isWholeResourceRemoveBlockOp(op('secretsmanager-disable-rotation'))).toBe(true);
    expect(isWholeResourceRemoveBlockOp(op('config-remove-managed-rule'))).toBe(true);
    expect(isWholeResourceRemoveBlockOp(op('autoscaling-delete-scaling-policy'))).toBe(true);
    // The 5 named sub-block ops: NOT whole-resource.
    expect(isWholeResourceRemoveBlockOp(op('autoscaling-remove-tag'))).toBe(false);
    expect(isWholeResourceRemoveBlockOp(op('sg-remove-ingress-rule'))).toBe(false);
    expect(isWholeResourceRemoveBlockOp(op('waf-delete-rule'))).toBe(false);
    expect(isWholeResourceRemoveBlockOp(op('iam-detach-managed-policy'))).toBe(false);
    // macd "Change" — can never be whole-resource, regardless of target shape.
    expect(isWholeResourceRemoveBlockOp(op('eventbridge-remove-target-dead-letter-queue'))).toBe(
      false,
    );
    // A non-remove_block codemod is never this class either.
    expect(isWholeResourceRemoveBlockOp(op('ec2-remove-instance-tag'))).toBe(false);
  });

  it('isSubBlockOp is true for the 5 named sub-block ops and their append_block "Change" siblings', () => {
    expect(isSubBlockOp(op('autoscaling-remove-tag'))).toBe(true);
    expect(isSubBlockOp(op('sg-remove-ingress-rule'))).toBe(true);
    expect(isSubBlockOp(op('waf-delete-rule'))).toBe(true);
    expect(isSubBlockOp(op('iam-detach-managed-policy'))).toBe(true);
    expect(isSubBlockOp(op('eventbridge-remove-target-dead-letter-queue'))).toBe(true);
    // append_block, macd "Change" — isAppendOp's macd:"Add" gate leaves these open.
    expect(isSubBlockOp(op('autoscaling-start-instance-refresh'))).toBe(true);
    // No target.block AND no target.path at all — still never whole-resource,
    // because macd is "Change", not "Add".
    expect(isSubBlockOp(op('eventbridge-set-target-dead-letter-queue'))).toBe(true);
    // Genuine whole-resource ops are NOT sub-block.
    expect(isSubBlockOp(op('ebs-delete-volume'))).toBe(false);
    expect(isSubBlockOp(op('sns-delete-topic'))).toBe(false);
    // A macd:"Add" append_block is already fully handled upstream by isAppendOp.
    expect(isSubBlockOp(op('ebs-create-snapshot'))).toBe(false);
  });

  it('autoscaling-remove-tag names the tag key, not the whole Auto Scaling group', () => {
    const diff = generateDiff(
      op('autoscaling-remove-tag'),
      { asg: 'aws_autoscaling_group.app_web', key: 'Temporary' },
      inventory,
    );
    expect(diff).toContain('(Delete)');
    expect(diff).toContain('removes the tag block from aws_autoscaling_group.app_web');
    expect(diff).toContain('- key = "Temporary"');
    expect(diff).not.toContain('resource "aws_autoscaling_group"');
    expect(diff).not.toMatch(/^[-~+]\s*resource/m);
  });

  it('sg-remove-ingress-rule names the rule, not the whole security group', () => {
    const diff = generateDiff(
      op('sg-remove-ingress-rule'),
      {
        security_group: 'aws_security_group.allinternal_to_backupproxy',
        rule_id: 'legacy SSH bastion',
      },
      inventory,
    );
    expect(diff).toContain('(Delete)');
    expect(diff).toContain(
      'removes the ingress block from aws_security_group.allinternal_to_backupproxy',
    );
    expect(diff).toContain('- rule_id = "legacy SSH bastion"');
    // The exact drill lie this round targets: closing one inbound rule must
    // never read as tearing down the whole security group.
    expect(diff).not.toContain('resource "aws_security_group"');
    expect(diff).not.toMatch(/^[-~+]\s*resource/m);
    expect(diff).not.toContain('⚠');
  });

  it('waf-delete-rule names the rule, not the whole Web ACL', () => {
    const diff = generateDiff(
      op('waf-delete-rule'),
      {
        web_acl: 'aws_wafv2_web_acl.edge',
        rule_name: 'rate-limit-api',
        confirm_rule_name: 'rate-limit-api',
      },
      inventory,
    );
    expect(diff).toContain('(Delete)');
    expect(diff).toContain('removes the rule block from aws_wafv2_web_acl.edge');
    expect(diff).toContain('- rule_name = "rate-limit-api"');
    expect(diff).toContain('- confirm_rule_name = "rate-limit-api"');
    expect(diff).not.toContain('resource "aws_wafv2_web_acl"');
    expect(diff).not.toMatch(/^[-~+]\s*resource/m);
  });

  it('iam-detach-managed-policy names the policy attachment, not the whole role', () => {
    const diff = generateDiff(
      op('iam-detach-managed-policy'),
      { role: 'aws_iam_role.ec2_ssm', policy_arn: 'arn:aws:iam::aws:policy/ReadOnlyAccess' },
      inventory,
    );
    expect(diff).toContain('(Delete)');
    expect(diff).toContain('removes the policy_attachment block from aws_iam_role.ec2_ssm');
    expect(diff).toContain('- policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"');
    expect(diff).not.toContain('resource "aws_iam_role"');
    expect(diff).not.toMatch(/^[-~+]\s*resource/m);
  });

  it('eventbridge-remove-target-dead-letter-queue (macd "Change") names the sub-block, not a fabricated resource update', () => {
    const diff = generateDiff(
      op('eventbridge-remove-target-dead-letter-queue'),
      { target: 'aws_cloudwatch_event_target.orders_to_lambda' },
      inventory,
    );
    expect(diff).toContain('(Change)');
    expect(diff).toContain(
      'removes the dead_letter_config block from aws_cloudwatch_event_target.orders_to_lambda',
    );
    expect(diff).not.toContain('resource "aws_cloudwatch_event_target"');
    expect(diff).not.toMatch(/^[-~+]\s*resource/m);
  });

  it('eventbridge-set-target-dead-letter-queue (append_block, macd "Change", no block/path hint) still never fabricates the whole resource', () => {
    const diff = generateDiff(
      op('eventbridge-set-target-dead-letter-queue'),
      {
        target: 'aws_cloudwatch_event_target.orders_to_lambda',
        dlq_arn: 'arn:aws:sqs:ap-southeast-5:111111111111:orders-dlq',
      },
      inventory,
    );
    expect(diff).toContain('(Change)');
    expect(diff).toContain('+ dlq_arn = "arn:aws:sqs:ap-southeast-5:111111111111:orders-dlq"');
    expect(diff).not.toContain('resource "aws_cloudwatch_event_target"');
    expect(diff).not.toMatch(/^[-~+]\s*resource/m);
  });

  it('genuine whole-resource remove_block ops still render as destroy — even when target.block is set', () => {
    const wholeResourceButBlockIsSet = [
      'sns-delete-topic',
      'sns-remove-subscription',
      'secretsmanager-schedule-deletion',
      'secretsmanager-disable-rotation',
      'config-remove-managed-rule',
      'autoscaling-delete-scaling-policy', // target.block is a `.tf` file path
    ];
    for (const id of [
      'ebs-delete-volume',
      'cloudwatch-delete-alarm',
      ...wholeResourceButBlockIsSet,
    ]) {
      const o = op(id);
      const values: Record<string, unknown> = {};
      for (const p of o.params) {
        if (p.source === 'inventory') values[p.name] = `${o.target.resourceType}.placeholder`;
        else if (p.type === 'number') values[p.name] = 1;
        else values[p.name] = 'x';
      }
      const diff = generateDiff(o, values, inventory);
      expect(diff, `${id} must still render as a whole-resource destroy`).toMatch(
        /^-\s*resource "/m,
      );
      expect(diff, `${id} must still name the real target resource type`).toContain(
        `resource "${o.target.resourceType}"`,
      );
    }
  });

  it('every sub-block-scoped remove_block/append_block op in the whole catalog never fabricates a whole-resource line', () => {
    const subBlockOps = manifests.flatMap((m) => m.operations).filter((o) => isSubBlockOp(o));
    // Guard against a silent classification regression: autoscaling-remove-tag,
    // sg-remove-ingress-rule, waf-delete-rule, iam-detach-managed-policy,
    // eventbridge-remove-target-dead-letter-queue, backup-remove-selection-tag,
    // backup-remove-selection-condition, autoscaling-start-instance-refresh,
    // eventbridge-set-target-dead-letter-queue — 9 measured today.
    expect(subBlockOps.length).toBeGreaterThanOrEqual(9);
    for (const o of subBlockOps) {
      const values: Record<string, unknown> = {};
      for (const p of o.params) {
        if (p.source === 'inventory') values[p.name] = `${o.target.resourceType}.placeholder`;
        else if (p.type === 'number') values[p.name] = 1;
        else values[p.name] = 'x';
      }
      const diff = generateDiff(o, values, inventory);
      expect(
        diff,
        `${o.id} must not fabricate a whole ${o.target.resourceType} block`,
      ).not.toContain(`resource "${o.target.resourceType}"`);
      expect(diff, `${o.id} must not open with a destroy/change-sigil resource line`).not.toMatch(
        /^[-~+]\s*resource/m,
      );
    }
  });

  it('every genuine whole-resource remove_block op in the whole catalog still opens with a destroy line', () => {
    const wholeOps = manifests
      .flatMap((m) => m.operations)
      .filter((o) => isWholeResourceRemoveBlockOp(o));
    // 33 measured today across the catalog.
    expect(wholeOps.length).toBeGreaterThanOrEqual(30);
    for (const o of wholeOps) {
      const values: Record<string, unknown> = {};
      for (const p of o.params) {
        if (p.source === 'inventory') values[p.name] = `${o.target.resourceType}.placeholder`;
        else if (p.type === 'number') values[p.name] = 1;
        else values[p.name] = 'x';
      }
      const diff = generateDiff(o, values, inventory);
      expect(diff, `${o.id} must still render as a whole-resource destroy`).toMatch(
        /^-\s*resource "/m,
      );
    }
  });
});

/**
 * OP-3 / LD-1, the plan-action half: `mockPlanSummaryFor` (lib/api.ts) keys
 * the "create"/"update"/"delete" plan action off this classifier instead of
 * MACD alone. Verified here against every (codemodOp, macd) pair the real
 * catalog actually uses (api-enforcement-style exhaustiveness), so a new
 * manifest op can't silently reintroduce the bug.
 */
describe('isAttributeLevelOp — whole-resource-vs-attribute, not MACD alone', () => {
  it('an Add tag/entry op is attribute-level (must render plan action "update", not "create")', () => {
    expect(isAttributeLevelOp(op('ec2-add-instance-tag'))).toBe(true);
  });

  it('a Delete tag/entry op is attribute-level (must render plan action "update", not "delete")', () => {
    expect(isAttributeLevelOp(op('ec2-remove-instance-tag'))).toBe(true);
  });

  it('a genuine whole-resource create/destroy is NOT attribute-level', () => {
    expect(isAttributeLevelOp(op('ebs-delete-volume'))).toBe(false); // remove_block, bare resourceType target
  });

  it('every op in the whole catalog agrees: attribute-level codemods never claim create/delete for real provisioning/teardown ops', () => {
    // create_resource / instantiate_module (always whole-resource Add) and
    // remove_block (the family that includes every genuine whole-resource
    // Delete) must never be classified attribute-level.
    const wholeResourceCodemods = new Set(['create_resource', 'instantiate_module']);
    const allOps = manifests.flatMap((m) => m.operations);
    expect(allOps.length).toBeGreaterThan(1000);
    for (const o of allOps) {
      if (wholeResourceCodemods.has(o.codemodOp)) {
        expect(isAttributeLevelOp(o), o.id).toBe(false);
      }
    }
  });
});

describe('plainSummary — one line a reviewer can read', () => {
  it('names the verb and the friendly resource name', () => {
    const s = plainSummary(
      op('ec2-resize'),
      { instance: 'aws_instance.app01', new_instance_type: 'r6i.2xlarge' },
      inventory,
    );
    expect(s).toBe('Change: resize an ec2 instance on APP01_NewInstall.');
  });

  it('uses the Delete verb for delete ops', () => {
    const s = plainSummary(
      op('ec2-remove-instance-tag'),
      { instance: 'aws_instance.app01', tag_key: 'Temporary' },
      inventory,
    );
    expect(s.startsWith('Delete:')).toBe(true);
  });
});
