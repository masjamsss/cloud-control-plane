import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { getOperation } from '@/lib/interpreter';
import { buildFullBlockDiff } from '@/lib/blockDiff';
import { isWholeResourceRemoveBlockOp } from '@/lib/diff';
import type { BlockSource } from '@/lib/blockSource';
import type { ManifestOperation } from '@/types';

/**
 * Review-truthfulness round 2 — lib/blockDiff.ts's own half of the same
 * fabricating-fallback bug #116 left out of scope for append_block/
 * remove_block: before this fix, EVERY remove_block op — whole-resource
 * teardown or a scoped sub-block edit alike — got `kind: 'remove'`, marking
 * the resource's ENTIRE committed block as deleted. For a sub-block op (a
 * tag, an ingress rule, a policy attachment) that read as "the whole
 * resource is gone" on the full-block review panel (FullBlockDiff.tsx's own
 * "whole block removed" tag), when really only one nested rule/entry was
 * being taken out and the resource persists. This suite proves
 * buildFullBlockDiff now returns null (honest degrade to the parameter diff)
 * for a sub-block op, and is unchanged for a genuine whole-resource one.
 */

function op(id: string): ManifestOperation {
  const found = getOperation(id, manifests);
  if (!found) throw new Error('missing op ' + id);
  return found;
}

const asgBlock: BlockSource = {
  file: 'environments/prod/autoscaling.tf',
  line: 12,
  source:
    'resource "aws_autoscaling_group" "app_web" {\n' +
    '  desired_capacity = 3\n' +
    '  max_size          = 6\n' +
    '  min_size          = 2\n' +
    '\n' +
    '  tag {\n' +
    '    key                 = "Temporary"\n' +
    '    value               = "true"\n' +
    '    propagate_at_launch = true\n' +
    '  }\n' +
    '}',
};

const sgBlock: BlockSource = {
  file: 'environments/prod/security-groups.tf',
  line: 30,
  source:
    'resource "aws_security_group" "allinternal_to_backupproxy" {\n' +
    '  name = "allinternal-to-backupproxy"\n' +
    '\n' +
    '  ingress {\n' +
    '    description = "legacy SSH bastion"\n' +
    '    from_port   = 22\n' +
    '    to_port     = 22\n' +
    '    protocol    = "tcp"\n' +
    '    cidr_blocks = ["10.0.0.0/16"]\n' +
    '  }\n' +
    '}',
};

const iamRoleBlock: BlockSource = {
  file: 'environments/prod/iam.tf',
  line: 8,
  source:
    'resource "aws_iam_role" "ec2_ssm" {\n' +
    '  name = "ec2-ssm"\n' +
    '\n' +
    '  policy_attachment {\n' +
    '    policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"\n' +
    '  }\n' +
    '}',
};

const wafAclBlock: BlockSource = {
  file: 'environments/prod/waf.tf',
  line: 4,
  source:
    'resource "aws_wafv2_web_acl" "edge" {\n' +
    '  name  = "edge"\n' +
    '  scope = "REGIONAL"\n' +
    '\n' +
    '  rule {\n' +
    '    name = "rate-limit-api"\n' +
    '  }\n' +
    '}',
};

const eventTargetBlock: BlockSource = {
  file: 'environments/prod/eventbridge.tf',
  line: 20,
  source:
    'resource "aws_cloudwatch_event_target" "orders_to_lambda" {\n' +
    '  rule = aws_cloudwatch_event_rule.orders.name\n' +
    '  arn  = aws_lambda_function.orders.arn\n' +
    '\n' +
    '  dead_letter_config {\n' +
    '    arn = aws_sqs_queue.orders_dlq.arn\n' +
    '  }\n' +
    '}',
};

const ebsVolumeBlock: BlockSource = {
  file: 'environments/prod/ebs.tf',
  line: 47,
  source:
    'resource "aws_ebs_volume" "app01_sdd" {\n' +
    '  availability_zone = "ap-southeast-5b"\n' +
    '  size              = 150\n' +
    '  type              = "gp2"\n' +
    '}',
};

const alarmBlock: BlockSource = {
  file: 'environments/prod/cloudwatch.tf',
  line: 5,
  source:
    'resource "aws_cloudwatch_metric_alarm" "legacy_host" {\n' +
    '  alarm_name = "legacy_host_cpu"\n' +
    '}',
};

const snsTopicBlock: BlockSource = {
  file: 'environments/prod/sns.tf',
  line: 2,
  source: 'resource "aws_sns_topic" "alerts" {\n  name = "alerts"\n}',
};

describe('buildFullBlockDiff — sub-block vs whole-resource (review-truthfulness round 2)', () => {
  it('autoscaling-remove-tag returns null — never marks the whole ASG as removed', () => {
    const diff = buildFullBlockDiff(
      op('autoscaling-remove-tag'),
      { asg: 'aws_autoscaling_group.app_web', key: 'Temporary' },
      asgBlock,
    );
    expect(diff).toBeNull();
  });

  it('sg-remove-ingress-rule returns null — never marks the whole security group as removed', () => {
    const diff = buildFullBlockDiff(
      op('sg-remove-ingress-rule'),
      {
        security_group: 'aws_security_group.allinternal_to_backupproxy',
        rule_id: 'legacy SSH bastion',
      },
      sgBlock,
    );
    expect(diff).toBeNull();
  });

  it('waf-delete-rule returns null — never marks the whole Web ACL as removed', () => {
    const diff = buildFullBlockDiff(
      op('waf-delete-rule'),
      {
        web_acl: 'aws_wafv2_web_acl.edge',
        rule_name: 'rate-limit-api',
        confirm_rule_name: 'rate-limit-api',
      },
      wafAclBlock,
    );
    expect(diff).toBeNull();
  });

  it('iam-detach-managed-policy returns null — never marks the whole role as removed', () => {
    const diff = buildFullBlockDiff(
      op('iam-detach-managed-policy'),
      { role: 'aws_iam_role.ec2_ssm', policy_arn: 'arn:aws:iam::aws:policy/ReadOnlyAccess' },
      iamRoleBlock,
    );
    expect(diff).toBeNull();
  });

  it('eventbridge-remove-target-dead-letter-queue (macd "Change") returns null — never marks the whole target as removed', () => {
    const diff = buildFullBlockDiff(
      op('eventbridge-remove-target-dead-letter-queue'),
      { target: 'aws_cloudwatch_event_target.orders_to_lambda' },
      eventTargetBlock,
    );
    expect(diff).toBeNull();
  });

  it('ebs-delete-volume (genuine whole-resource) still returns kind:remove, whole block marked', () => {
    const diff = buildFullBlockDiff(
      op('ebs-delete-volume'),
      { volume: 'aws_ebs_volume.app01_sdd' },
      ebsVolumeBlock,
    );
    expect(diff).not.toBeNull();
    expect(diff!.kind).toBe('remove');
    expect(diff!.after).toBe('');
    expect(diff!.changedBefore.length).toBe(ebsVolumeBlock.source.split('\n').length);
  });

  it('cloudwatch-delete-alarm (genuine whole-resource) still returns kind:remove', () => {
    const diff = buildFullBlockDiff(
      op('cloudwatch-delete-alarm'),
      { alarm: 'aws_cloudwatch_metric_alarm.legacy_host' },
      alarmBlock,
    );
    expect(diff).not.toBeNull();
    expect(diff!.kind).toBe('remove');
    expect(diff!.after).toBe('');
  });

  it('sns-delete-topic (target.block is SET, but still genuinely whole-resource) still returns kind:remove', () => {
    // The tricky case: target.block === "aws_sns_topic" (the resource type
    // itself, not a nested block name) — a naive "block is set ⇒ sub-block"
    // rule would wrongly null this out. isWholeResourceRemoveBlockOp must
    // still say true, and buildFullBlockDiff must still mark the whole block.
    expect(isWholeResourceRemoveBlockOp(op('sns-delete-topic'))).toBe(true);
    const diff = buildFullBlockDiff(
      op('sns-delete-topic'),
      { topic: 'aws_sns_topic.alerts' },
      snsTopicBlock,
    );
    expect(diff).not.toBeNull();
    expect(diff!.kind).toBe('remove');
    expect(diff!.after).toBe('');
  });

  it('every remove_block op in the whole catalog agrees with isWholeResourceRemoveBlockOp: null for a sub-block, kind:remove for a whole resource', () => {
    const removeBlockOps = manifests
      .flatMap((m) => m.operations)
      .filter((o) => o.codemodOp === 'remove_block');
    expect(removeBlockOps.length).toBeGreaterThanOrEqual(40); // 40 measured today
    for (const o of removeBlockOps) {
      const placeholder: BlockSource = {
        file: 'environments/prod/placeholder.tf',
        line: 1,
        source: `resource "${o.target.resourceType}" "placeholder" {\n  name = "x"\n}`,
      };
      const values: Record<string, unknown> = {};
      for (const p of o.params) {
        values[p.name] = p.source === 'inventory' ? `${o.target.resourceType}.placeholder` : 'x';
      }
      const diff = buildFullBlockDiff(o, values, placeholder);
      if (isWholeResourceRemoveBlockOp(o)) {
        expect(diff, `${o.id}: expected kind:remove (genuine whole-resource)`).not.toBeNull();
        expect(diff!.kind, o.id).toBe('remove');
        expect(diff!.after, o.id).toBe('');
      } else {
        expect(
          diff,
          `${o.id}: expected null (sub-block — must honest-degrade, never mark the whole resource removed)`,
        ).toBeNull();
      }
    }
  });
});
