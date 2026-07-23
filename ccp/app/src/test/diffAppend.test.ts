import { describe, expect, it } from 'vitest';
import type { Inventory, ManifestOperation } from '@/types';
import { manifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';
import { getOperation } from '@/lib/interpreter';
import { generateDiff } from '@/lib/diff';
import { isAppendOp } from '@/lib/hclSkeleton';

/**
 * 0034 papercut #2 — the review artifact must show the REAL addition for every
 * append-class Add op (append_block / append_foreach_entry / append_list_entry /
 * set_association_attribute), driven through the SAME generateDiff the review step
 * renders and the submit path pins. Before this, these ops fell to a fabricating
 * fallback: a snapshot rendered as `resource "aws_db_instance"` (re-creating the
 * DB), an SG rule as `resource "aws_security_group"` (redefining the whole group),
 * a mount target / listener-certificate as an empty `{ }` (picked subnet / SG /
 * cert dropped). These tests bind the honest shapes over the REAL catalog.
 */

const inventory = inventoryData as unknown as Inventory;

function op(id: string): ManifestOperation {
  const found = getOperation(id, manifests);
  if (!found) throw new Error('missing op ' + id);
  return found;
}

describe('generateDiff — honest append delta (0034 papercut #2)', () => {
  it('S3/S1 · ebs-create-snapshot → a NEW aws_ebs_snapshot referencing the volume', () => {
    const diff = generateDiff(
      op('ebs-create-snapshot'),
      {
        volume: 'aws_ebs_volume.app01_sdb',
        snapshot_name: 'pre kernel patch APP01 sdb',
        description_tag: 'before tonight’s kernel patch',
      },
      inventory,
    );
    expect(diff).toContain('resource "aws_ebs_snapshot"');
    expect(diff).toContain('volume_id = aws_ebs_volume.app01_sdb.id');
    expect(diff).toContain('description = "before tonight’s kernel patch"');
    expect(diff).toContain('Name = "pre kernel patch APP01 sdb"');
    // NOT re-creating the volume, and no raw param names presented as attributes.
    expect(diff).not.toContain('resource "aws_ebs_volume"');
    expect(diff).not.toContain('snapshot_name =');
    expect(diff).not.toContain('description_tag =');
  });

  it('S24 · rds-create-manual-snapshot → a NEW aws_db_snapshot, NOT re-creating the DB', () => {
    const diff = generateDiff(
      op('rds-create-manual-snapshot'),
      { db: 'aws_db_instance.app_db01_postgresql', snapshot_identifier: 'pre-release-app-db01' },
      inventory,
    );
    expect(diff).toContain('resource "aws_db_snapshot"');
    expect(diff).toContain('db_instance_identifier = aws_db_instance.app_db01_postgresql.identifier');
    expect(diff).toContain('db_snapshot_identifier = "pre-release-app-db01"');
    // The exact drill lie: a snapshot rendered as re-creating the production DB.
    expect(diff).not.toContain('resource "aws_db_instance"');
  });

  it('S33 · sg-add-internal-ingress-rule → an appended ingress block, NOT the whole SG', () => {
    const diff = generateDiff(
      op('sg-add-internal-ingress-rule'),
      {
        security_group: 'aws_security_group.allinternal_to_backupproxy',
        protocol: 'tcp',
        from_port: 8443,
        to_port: 8443,
        cidr_block: '10.0.1.0/24',
      },
      inventory,
    );
    expect(diff).toContain('ingress {');
    expect(diff).toContain('protocol = "tcp"');
    expect(diff).toContain('from_port = 8443');
    expect(diff).toContain('to_port = 8443');
    expect(diff).toContain('cidr_blocks = ["10.0.1.0/24"]');
    // Header names the parent it appends to; body is the rule, not a redefinition.
    expect(diff).toContain('aws_security_group.allinternal_to_backupproxy');
    expect(diff).not.toContain('resource "aws_security_group"');
  });

  it('S29 · s3-add-lifecycle-rule → an appended rule {} with the picked transition/expiry', () => {
    const diff = generateDiff(
      op('s3-add-lifecycle-rule'),
      {
        lifecycle_config: 'aws_s3_bucket_lifecycle_configuration.cloudwatch_auto_alarm_lambda_deployment',
        rule_id: 'expire-logs',
        prefix: 'logs/',
        transition_days: 90,
        storage_class: 'GLACIER',
        expiration_days: 365,
      },
      inventory,
    );
    expect(diff).toContain('rule {');
    expect(diff).toContain('id = "expire-logs"');
    expect(diff).toContain('status = "Enabled"');
    expect(diff).toContain('storage_class = "GLACIER"');
    expect(diff).toContain('expiration {');
    expect(diff).not.toContain('resource "aws_s3_bucket_lifecycle_configuration"');
  });

  it('S38 · acm-attach-sni-certificate → the picked cert + listener, not an empty body', () => {
    const diff = generateDiff(
      op('acm-attach-sni-certificate'),
      {
        listener: 'aws_lb_listener.app_https_8443',
        certificate: 'aws_acm_certificate.acmeland_wildcard',
      },
      inventory,
    );
    expect(diff).toContain('resource "aws_lb_listener_certificate"');
    expect(diff).toContain('listener_arn = aws_lb_listener.app_https_8443.arn');
    expect(diff).toContain('certificate_arn = aws_acm_certificate.acmeland_wildcard.arn');
    // The whole point of the ticket must appear on the review screen.
    expect(diff).not.toMatch(/\{\s*\}/);
  });

  it('S27 · efs-add-mount-target → the picked subnet + security groups, not an empty body', () => {
    const diff = generateDiff(
      op('efs-add-mount-target'),
      {
        file_system: 'aws_efs_file_system.sagemaker_d_example0000001',
        subnet_id: 'aws_subnet.backup',
        security_group_ids: ['aws_security_group.allinternal_to_backupproxy'],
      },
      inventory,
    );
    expect(diff).toContain('resource "aws_efs_mount_target"');
    expect(diff).toContain('file_system_id = aws_efs_file_system.sagemaker_d_example0000001.id');
    expect(diff).toContain('subnet_id = aws_subnet.backup.id');
    expect(diff).toContain('security_groups = [aws_security_group.allinternal_to_backupproxy.id]');
    expect(diff).not.toMatch(/\{\s*\}/);
  });
});

describe('append-op invariant over the whole catalog', () => {
  const appendOps = manifests.flatMap((m) => m.operations).filter((o) => isAppendOp(o));

  it('there ARE append Add ops (guard against a silent classification regression)', () => {
    expect(appendOps.length).toBeGreaterThan(20);
  });

  it('no append Add op renders as re-creating the resource it targets when it appends INTO one', () => {
    // For a sub-block / map / list append (target.block is a nested name, not a
    // resource type, and there is an inventory parent), the diff must never render
    // `resource "<target.resourceType>"` — that was the fabrication the drill hit.
    for (const o of appendOps) {
      const block = o.target.block;
      const isNestedAppend = !!block && !/^aws_[a-z0-9_]+$/.test(block);
      if (!isNestedAppend) continue;
      // Feed each param a shape-valid placeholder so the renderer runs.
      const values: Record<string, unknown> = {};
      for (const p of o.params) {
        if (p.source === 'inventory') {
          values[p.name] = p.type === 'list' ? [`${o.target.resourceType}.placeholder`] : `${o.target.resourceType}.placeholder`;
        } else if (p.type === 'number') values[p.name] = 1;
        else if (p.type === 'list') values[p.name] = ['x'];
        else values[p.name] = 'x';
      }
      const diff = generateDiff(o, values, inventory);
      expect(diff, `${o.id} must not fabricate a full ${o.target.resourceType} block`).not.toContain(
        `resource "${o.target.resourceType}"`,
      );
    }
  });
});
