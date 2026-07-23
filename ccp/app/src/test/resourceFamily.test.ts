import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { InventoryResource } from '@/types';
import { manifests } from '@/data/manifests';
import type { BlockSource } from '@/lib/blockSource';
import {
  buildResourceFamilies,
  childTypeLabel,
  childTypeVerdicts,
  extractAddressTokens,
  groupChildren,
  summarizeChildren,
} from '@/lib/resourceFamily';
import { ResourceDetailView } from '@/features/services/ResourceDetail';

/**
 * The console-style rollup rule (lib/resourceFamily.ts), proven against small,
 * fully-controlled synthetic fixtures — the bundled sample estate is a
 * deliberately small, generic demo dataset (not a large real estate with
 * incidental full type coverage across every config sub-type), so these
 * proofs build their own minimal resources + block sources per behavior
 * instead of leaning on the bundled inventory's specific shape.
 */

/** A minimal InventoryResource for these fixtures — same shape convention as
 * the "orphan and ambiguity honesty" fixtures below. */
function res(resourceType: string, name: string, service?: string): InventoryResource {
  return { address: `${resourceType}.${name}`, resourceType, name, service, attributes: {} };
}
function blk(source: string): BlockSource {
  return { file: 'x.tf', line: 1, source };
}

describe('extractAddressTokens', () => {
  it('catches a real HCL traversal, including one with an attribute access', () => {
    const tokens = extractAddressTokens(
      'resource "aws_lb_listener" "x" {\n  load_balancer_arn = aws_lb.app.arn\n}',
    );
    expect(tokens.has('aws_lb.app')).toBe(true);
  });

  it("catches the importer's literal-plus-address-comment style", () => {
    const tokens = extractAddressTokens('volume_id = "vol-07eded" # aws_ebs_volume.app01_sdb');
    expect(tokens.has('aws_ebs_volume.app01_sdb')).toBe(true);
  });

  it('never yields a name-prefix substring (maximal munch)', () => {
    const tokens = extractAddressTokens('target = aws_lb.app_https_443.arn');
    expect(tokens.has('aws_lb.app_https_443')).toBe(true);
    expect(tokens.has('aws_lb.app')).toBe(false);
  });

  it('rejects module-scoped and data-source homonyms', () => {
    const tokens = extractAddressTokens(
      'a = module.m.aws_s3_bucket.logs.id\nb = data.aws_s3_bucket.logs.arn',
    );
    expect(tokens.has('aws_s3_bucket.logs')).toBe(false);
  });

  it('a plain human comment matches nothing address-shaped in the estate', () => {
    const tokens = extractAddressTokens('vpc_id = "vpc-0e9541" # vpc-note (region)');
    expect([...tokens].some((t) => t.startsWith('aws_'))).toBe(false);
  });
});

describe('child-type verdicts (synthetic fixtures — the two-arm rule)', () => {
  it('S3: every bucket-config type rolls under aws_s3_bucket (arm 1)', () => {
    const types = ['aws_s3_bucket', 'aws_s3_bucket_versioning', 'aws_s3_bucket_policy'];
    const resources = [
      res('aws_s3_bucket', 'app_data'),
      res('aws_s3_bucket_versioning', 'app_data'),
      res('aws_s3_bucket_policy', 'app_data'),
    ];
    const blocks = {
      'aws_s3_bucket_versioning.app_data': blk('bucket = aws_s3_bucket.app_data.id'),
      'aws_s3_bucket_policy.app_data': blk('bucket = aws_s3_bucket.app_data.id'),
    };
    const verdicts = childTypeVerdicts(types, resources, blocks);
    expect(verdicts.get('aws_s3_bucket_versioning')).toBe('aws_s3_bucket');
    expect(verdicts.get('aws_s3_bucket_policy')).toBe('aws_s3_bucket');
    expect(verdicts.has('aws_s3_bucket')).toBe(false);
  });

  it('EBS: aws_volume_attachment rolls under aws_ebs_volume (arm 2 — no type-name hint)', () => {
    const types = ['aws_ebs_volume', 'aws_volume_attachment'];
    const resources = [res('aws_ebs_volume', 'app01_data'), res('aws_volume_attachment', 'app01_data')];
    const blocks = {
      'aws_volume_attachment.app01_data': blk(
        'volume_id = aws_ebs_volume.app01_data.id\ninstance_id = aws_instance.app01.id',
      ),
    };
    const verdicts = childTypeVerdicts(types, resources, blocks);
    expect(verdicts.get('aws_volume_attachment')).toBe('aws_ebs_volume');
  });

  it('KMS: aws_kms_alias rolls under aws_kms_key (arm 2)', () => {
    const types = ['aws_kms_key', 'aws_kms_alias'];
    const resources = [res('aws_kms_key', 'app_key'), res('aws_kms_alias', 'app_key')];
    const blocks = { 'aws_kms_alias.app_key': blk('target_key_id = aws_kms_key.app_key.key_id') };
    const verdicts = childTypeVerdicts(types, resources, blocks);
    expect(verdicts.get('aws_kms_alias')).toBe('aws_kms_key');
  });

  it('EventBridge: targets roll under rules by reference — one name-matching instance is the type-level canary, then a DIFFERENTLY-named instance still qualifies by reference alone', () => {
    const types = ['aws_cloudwatch_event_rule', 'aws_cloudwatch_event_target'];
    const resources = [
      res('aws_cloudwatch_event_rule', 'nightly'),
      res('aws_cloudwatch_event_target', 'nightly'), // name matches its rule — the canary
      res('aws_cloudwatch_event_target', 'nightly_lambda_alt'), // differently named
    ];
    const blocks = {
      'aws_cloudwatch_event_target.nightly': blk('rule = aws_cloudwatch_event_rule.nightly.name'),
      'aws_cloudwatch_event_target.nightly_lambda_alt': blk(
        'rule = aws_cloudwatch_event_rule.nightly.name',
      ),
    };
    const verdicts = childTypeVerdicts(types, resources, blocks);
    expect(verdicts.get('aws_cloudwatch_event_target')).toBe('aws_cloudwatch_event_rule');
  });

  it('ALB: listeners under the LB, rules under listeners — target groups stay top-level (arm 1, longest prefix)', () => {
    const types = ['aws_lb', 'aws_lb_listener', 'aws_lb_listener_rule', 'aws_lb_target_group'];
    const resources = [
      res('aws_lb', 'app'),
      res('aws_lb_listener', 'https'),
      res('aws_lb_listener_rule', 'api'),
      res('aws_lb_target_group', 'app'),
    ];
    const blocks = {
      'aws_lb_listener.https': blk('load_balancer_arn = aws_lb.app.arn'),
      'aws_lb_listener_rule.api': blk('listener_arn = aws_lb_listener.https.arn'),
      // the target group never references the LB — a name-adjacent PEER,
      // never a child, same as aws_vpc_endpoint would be.
    };
    const verdicts = childTypeVerdicts(types, resources, blocks);
    expect(verdicts.get('aws_lb_listener')).toBe('aws_lb');
    expect(verdicts.get('aws_lb_listener_rule')).toBe('aws_lb_listener');
    expect(verdicts.has('aws_lb_target_group')).toBe(false);
  });

  it('IAM: inline policies and attachments roll under role/user/group — the attachment resolves to the LONGEST prefix parent it actually references', () => {
    const types = [
      'aws_iam_role',
      'aws_iam_role_policy',
      'aws_iam_role_policy_attachment',
      'aws_iam_user',
      'aws_iam_user_policy',
      'aws_iam_group',
      'aws_iam_group_policy',
      'aws_iam_policy',
    ];
    const resources = [
      res('aws_iam_role', 'app'),
      res('aws_iam_role_policy', 'app'),
      res('aws_iam_role_policy_attachment', 'app'),
      res('aws_iam_user', 'alice'),
      res('aws_iam_user_policy', 'alice'),
      res('aws_iam_group', 'ops'),
      res('aws_iam_group_policy', 'ops'),
      res('aws_iam_policy', 'shared'),
    ];
    const blocks = {
      'aws_iam_role_policy.app': blk('role = aws_iam_role.app.name'),
      // aws_iam_role_policy is the longer prefix candidate, but this
      // attachment references a role and a managed policy, never an inline
      // policy — the longest REFERENCED prefix wins (aws_iam_role).
      'aws_iam_role_policy_attachment.app': blk(
        'role = aws_iam_role.app.name\npolicy_arn = aws_iam_policy.shared.arn',
      ),
      'aws_iam_user_policy.alice': blk('user = aws_iam_user.alice.name'),
      'aws_iam_group_policy.ops': blk('group = aws_iam_group.ops.name'),
    };
    const verdicts = childTypeVerdicts(types, resources, blocks);
    expect(verdicts.get('aws_iam_role_policy')).toBe('aws_iam_role');
    expect(verdicts.get('aws_iam_role_policy_attachment')).toBe('aws_iam_role');
    expect(verdicts.get('aws_iam_user_policy')).toBe('aws_iam_user');
    expect(verdicts.get('aws_iam_group_policy')).toBe('aws_iam_group');
    // A managed policy is its own console listing — never a child.
    expect(verdicts.has('aws_iam_policy')).toBe(false);
  });

  it('VPC-shaped types stay flat: no name-prefix relationship and no references between them', () => {
    const types = ['aws_vpc', 'aws_subnet', 'aws_internet_gateway'];
    const resources = [res('aws_vpc', 'main'), res('aws_subnet', 'a'), res('aws_internet_gateway', 'main')];
    const verdicts = childTypeVerdicts(types, resources, {});
    expect([...verdicts.entries()]).toEqual([]);
  });

  it('EC2 stays flat — an instance referencing a key pair is never treated as that key pair’s child', () => {
    const types = ['aws_instance', 'aws_key_pair'];
    const resources = [res('aws_instance', 'app01'), res('aws_key_pair', 'admin')];
    const blocks = { 'aws_instance.app01': blk('key_name = aws_key_pair.admin.key_name') };
    const verdicts = childTypeVerdicts(types, resources, blocks);
    expect([...verdicts.entries()]).toEqual([]);
  });

  it('arm 2 requires FULL reference coverage — one unlinked instance keeps the whole type flat', () => {
    // Mirrors network-ACL↔subnet: an optional association must not become
    // containment because some instances happen to reference one.
    const types2 = ['aws_thing', 'aws_other'];
    const thing = (n: string): InventoryResource => res('aws_thing', n);
    const other = (n: string): InventoryResource => res('aws_other', n);
    const resources = [thing('a'), other('a'), other('b')];
    const fixtureBlocks = {
      'aws_other.a': blk('ref = aws_thing.a.id'),
      'aws_other.b': blk('standalone = true'),
    };
    const verdicts = childTypeVerdicts(types2, resources, fixtureBlocks);
    expect([...verdicts.entries()]).toEqual([]);
  });

  it('an empty block corpus yields no verdicts (graceful flat fallback)', () => {
    const types = ['aws_s3_bucket', 'aws_s3_bucket_versioning'];
    const resources = [res('aws_s3_bucket', 'app_data'), res('aws_s3_bucket_versioning', 'app_data')];
    const verdicts = childTypeVerdicts(types, resources, {});
    expect([...verdicts.entries()]).toEqual([]);
  });
});

describe('buildResourceFamilies (synthetic fixtures)', () => {
  it('S3 lists each bucket ONCE, its config rolled up underneath', () => {
    const types = [
      'aws_s3_bucket',
      'aws_s3_bucket_versioning',
      'aws_s3_bucket_cors_configuration',
      'aws_s3control_storage_lens_configuration',
    ];
    const resources = [
      res('aws_s3_bucket', 'app_data'),
      res('aws_s3_bucket', 'logs'),
      res('aws_s3_bucket_versioning', 'app_data'),
      res('aws_s3_bucket_cors_configuration', 'app_data'),
    ];
    const blocks = {
      'aws_s3_bucket_versioning.app_data': blk('bucket = aws_s3_bucket.app_data.id'),
      'aws_s3_bucket_cors_configuration.app_data': blk('bucket = aws_s3_bucket.app_data.id'),
    };
    const fam = buildResourceFamilies(types, resources, blocks);
    // Two top-level groups: the buckets, and a greenfield catalog type with
    // zero instances yet — same shape any brand-new catalog addition renders
    // as (no evidence to roll it up, so it lists flat and empty).
    expect(fam.groups.map((g) => g.resourceType)).toEqual([
      'aws_s3_bucket',
      'aws_s3control_storage_lens_configuration',
    ]);
    expect(fam.groups[0]!.rows).toHaveLength(2);
    expect(fam.rolledUpCount).toBe(2);

    const appData = fam.groups[0]!.rows.find((r) => r.resource.address === 'aws_s3_bucket.app_data')!;
    const childTypes = appData.children.map((c) => c.resourceType).sort();
    expect(childTypes).toEqual(['aws_s3_bucket_cors_configuration', 'aws_s3_bucket_versioning']);
  });

  it('EBS lists each volume once, each carrying its own attachment — never a shared or duplicated row', () => {
    const types = ['aws_ebs_volume', 'aws_volume_attachment'];
    const resources = [
      res('aws_ebs_volume', 'app01_data'),
      res('aws_ebs_volume', 'app02_data'),
      res('aws_volume_attachment', 'app01_data'),
      res('aws_volume_attachment', 'app02_data'),
    ];
    const blocks = {
      'aws_volume_attachment.app01_data': blk('volume_id = aws_ebs_volume.app01_data.id'),
      'aws_volume_attachment.app02_data': blk('volume_id = aws_ebs_volume.app02_data.id'),
    };
    const fam = buildResourceFamilies(types, resources, blocks);
    expect(fam.groups.map((g) => g.resourceType)).toEqual(['aws_ebs_volume']);
    expect(fam.groups[0]!.rows).toHaveLength(2);
    expect(fam.rolledUpCount).toBe(2);
    const withAttachment = fam.groups[0]!.rows.filter((r) =>
      r.children.some((c) => c.resourceType === 'aws_volume_attachment'),
    );
    expect(withAttachment).toHaveLength(2);
  });

  it('ALB: the LB row rolls up its listeners AND their rules; target groups list as peers', () => {
    const types = ['aws_lb', 'aws_lb_listener', 'aws_lb_listener_rule', 'aws_lb_target_group'];
    const resources = [
      res('aws_lb', 'app'),
      res('aws_lb_listener', 'https'),
      res('aws_lb_listener', 'http'),
      res('aws_lb_listener_rule', 'api'),
      res('aws_lb_listener_rule', 'health'),
      res('aws_lb_target_group', 'app'),
    ];
    const blocks = {
      'aws_lb_listener.https': blk('load_balancer_arn = aws_lb.app.arn'),
      'aws_lb_listener.http': blk('load_balancer_arn = aws_lb.app.arn'),
      'aws_lb_listener_rule.api': blk('listener_arn = aws_lb_listener.https.arn'),
      'aws_lb_listener_rule.health': blk('listener_arn = aws_lb_listener.https.arn'),
    };
    const fam = buildResourceFamilies(types, resources, blocks);
    expect(fam.groups.map((g) => g.resourceType)).toEqual(['aws_lb', 'aws_lb_target_group']);
    const lb = fam.groups[0]!.rows[0]!;
    expect(lb.children.filter((c) => c.resourceType === 'aws_lb_listener')).toHaveLength(2);
    expect(lb.children.filter((c) => c.resourceType === 'aws_lb_listener_rule')).toHaveLength(2);
    // Detail-page indexes: a listener's DIRECT children are its rules only.
    const listener = 'aws_lb_listener.https';
    const direct = fam.childrenOf.get(listener) ?? [];
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.every((c) => c.resourceType === 'aws_lb_listener_rule')).toBe(true);
    expect(fam.parentOf.get(listener)?.address).toBe('aws_lb.app');
  });

  it('EventBridge: the differently-named target still nests (reference is the join, name only vouches for the type)', () => {
    const types = ['aws_cloudwatch_event_rule', 'aws_cloudwatch_event_target'];
    const resources = [
      res('aws_cloudwatch_event_rule', 'nightly'),
      res('aws_cloudwatch_event_target', 'nightly'),
      res('aws_cloudwatch_event_target', 'nightly_lambda_alt'),
    ];
    const blocks = {
      'aws_cloudwatch_event_target.nightly': blk('rule = aws_cloudwatch_event_rule.nightly.name'),
      'aws_cloudwatch_event_target.nightly_lambda_alt': blk(
        'rule = aws_cloudwatch_event_rule.nightly.name',
      ),
    };
    const fam = buildResourceFamilies(types, resources, blocks);
    expect(fam.parentOf.get('aws_cloudwatch_event_target.nightly_lambda_alt')?.address).toBe(
      'aws_cloudwatch_event_rule.nightly',
    );
  });

  it('VPC-shaped types render identically to the old flat grouping (regression guard)', () => {
    const types = ['aws_vpc', 'aws_subnet', 'aws_internet_gateway'];
    const resources = [res('aws_vpc', 'main'), res('aws_subnet', 'a'), res('aws_internet_gateway', 'main')];
    const fam = buildResourceFamilies(types, resources, {});
    expect(fam.groups.map((g) => g.resourceType)).toEqual(types);
    expect(fam.rolledUpCount).toBe(0);
    expect(fam.groups.every((g) => !g.childType)).toBe(true);
    expect(fam.groups.every((g) => g.rows.every((r) => r.children.length === 0))).toBe(true);
  });
});

describe('orphan and ambiguity honesty (synthetic fixtures)', () => {
  const types = ['aws_s3_bucket', 'aws_s3_bucket_policy'];
  const bucket = (name: string): InventoryResource => ({
    address: `aws_s3_bucket.${name}`,
    resourceType: 'aws_s3_bucket',
    name,
    attributes: {},
  });
  const policy = (name: string): InventoryResource => ({
    address: `aws_s3_bucket_policy.${name}`,
    resourceType: 'aws_s3_bucket_policy',
    name,
    attributes: {},
  });
  const block = (source: string): BlockSource => ({ file: 'x.tf', line: 1, source });

  it('a config entry whose parent is not in the baseline stays listed, flagged, never dropped', () => {
    const resources = [bucket('a'), policy('a'), policy('gone')];
    const fixtureBlocks = {
      'aws_s3_bucket_policy.a': block('bucket = "a" # aws_s3_bucket.a'),
      'aws_s3_bucket_policy.gone': block('bucket = "gone" # aws_s3_bucket.vanished'),
    };
    const fam = buildResourceFamilies(types, resources, fixtureBlocks);
    expect(fam.parentOf.get('aws_s3_bucket_policy.a')?.address).toBe('aws_s3_bucket.a');
    const orphanGroup = fam.groups.find((g) => g.resourceType === 'aws_s3_bucket_policy')!;
    expect(orphanGroup.childType).toBe(true);
    expect(orphanGroup.rows).toHaveLength(1);
    expect(orphanGroup.rows[0]!.resource.address).toBe('aws_s3_bucket_policy.gone');
    expect(orphanGroup.rows[0]!.orphan).toBe('no-parent');
  });

  it('a config entry referencing TWO parents is never guessed into one of them', () => {
    const resources = [bucket('a'), bucket('b'), policy('a')];
    const fixtureBlocks = {
      'aws_s3_bucket_policy.a': block('x = aws_s3_bucket.a.id\ny = aws_s3_bucket.b.id'),
    };
    const fam = buildResourceFamilies(types, resources, fixtureBlocks);
    expect(fam.parentOf.has('aws_s3_bucket_policy.a')).toBe(false);
    const orphanGroup = fam.groups.find((g) => g.resourceType === 'aws_s3_bucket_policy')!;
    expect(orphanGroup.rows[0]!.orphan).toBe('many-parents');
  });

  it('arm 2 requires FULL reference coverage — one unlinked instance keeps the whole type flat', () => {
    // Mirrors network-ACL↔subnet (3/6): an optional association must not
    // become containment because some instances happen to reference one.
    const types2 = ['aws_thing', 'aws_other'];
    const thing = (n: string): InventoryResource => ({
      address: `aws_thing.${n}`,
      resourceType: 'aws_thing',
      name: n,
      attributes: {},
    });
    const other = (n: string): InventoryResource => ({
      address: `aws_other.${n}`,
      resourceType: 'aws_other',
      name: n,
      attributes: {},
    });
    const resources = [thing('a'), other('a'), other('b')];
    const fixtureBlocks = {
      'aws_other.a': block('ref = aws_thing.a.id'),
      'aws_other.b': block('standalone = true'),
    };
    const verdicts = childTypeVerdicts(types2, resources, fixtureBlocks);
    expect([...verdicts.entries()]).toEqual([]);
  });
});

describe('labels and grouping helpers', () => {
  it('childTypeLabel strips the parent-type prefix in context, and stays plain-words otherwise', () => {
    expect(childTypeLabel('aws_s3_bucket_versioning', 'aws_s3_bucket')).toBe('Versioning');
    expect(
      childTypeLabel('aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket'),
    ).toBe('Server side encryption configuration');
    expect(childTypeLabel('aws_volume_attachment', 'aws_ebs_volume')).toBe('Volume attachment');
    expect(childTypeLabel('aws_kms_alias', 'aws_kms_key')).toBe('KMS alias');
  });

  it('summarizeChildren aggregates per type with counts, first-seen order', () => {
    const types = ['aws_lb', 'aws_lb_listener', 'aws_lb_listener_rule'];
    const resources = [
      res('aws_lb', 'app'),
      res('aws_lb_listener', 'https'),
      res('aws_lb_listener_rule', 'api'),
      res('aws_lb_listener_rule', 'health'),
    ];
    const blocks = {
      'aws_lb_listener.https': blk('load_balancer_arn = aws_lb.app.arn'),
      'aws_lb_listener_rule.api': blk('listener_arn = aws_lb_listener.https.arn'),
      'aws_lb_listener_rule.health': blk('listener_arn = aws_lb_listener.https.arn'),
    };
    const fam = buildResourceFamilies(types, resources, blocks);
    const lb = fam.groups[0]!.rows[0]!;
    const summary = summarizeChildren(lb.children, 'aws_lb');
    expect(summary).toEqual([
      { resourceType: 'aws_lb_listener', label: 'Listener', count: 1 },
      { resourceType: 'aws_lb_listener_rule', label: 'Listener rule', count: 2 },
    ]);
  });

  it('groupChildren shapes the detail sections per type', () => {
    const types = [
      'aws_s3_bucket',
      'aws_s3_bucket_versioning',
      'aws_s3_bucket_cors_configuration',
      'aws_s3_bucket_public_access_block',
    ];
    const resources = [
      res('aws_s3_bucket', 'app_data'),
      res('aws_s3_bucket_versioning', 'app_data'),
      res('aws_s3_bucket_cors_configuration', 'app_data'),
      res('aws_s3_bucket_public_access_block', 'app_data'),
    ];
    const blocks = {
      'aws_s3_bucket_versioning.app_data': blk('bucket = aws_s3_bucket.app_data.id'),
      'aws_s3_bucket_cors_configuration.app_data': blk('bucket = aws_s3_bucket.app_data.id'),
      'aws_s3_bucket_public_access_block.app_data': blk('bucket = aws_s3_bucket.app_data.id'),
    };
    const fam = buildResourceFamilies(types, resources, blocks);
    const children = fam.childrenOf.get('aws_s3_bucket.app_data') ?? [];
    const groups = groupChildren(children, 'aws_s3_bucket');
    expect(groups.length).toBeGreaterThanOrEqual(3);
    for (const g of groups) expect(g.label).not.toMatch(/[a-z0-9]_[a-z0-9]/i);
  });
});

describe('detail page renders the rollup (SSR, no jsdom)', () => {
  const types = ['aws_s3_bucket', 'aws_s3_bucket_cors_configuration'];
  const resources = [res('aws_s3_bucket', 'app_data', 's3'), res('aws_s3_bucket_cors_configuration', 'app_data', 's3')];
  const blocks = { 'aws_s3_bucket_cors_configuration.app_data': blk('bucket = aws_s3_bucket.app_data.id') };

  it('shows attached configuration as sections and links each entry to its own page', () => {
    const fam = buildResourceFamilies(types, resources, blocks);
    const resource = resources[0]!;
    const s3 = manifests.find((m) => m.service === 's3')!;
    const ops = s3.operations.filter((o) => o.target.resourceType === 'aws_s3_bucket');
    const attachedConfig = groupChildren(fam.childrenOf.get(resource.address) ?? [], resource.resourceType);
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(ResourceDetailView, {
          serviceSlug: 's3',
          resource,
          ops,
          attachedConfig,
        }),
      ),
    );
    expect(html).toContain('Configuration attached to this resource');
    expect(html).toContain('Cors configuration');
    expect(html).toContain('/services/s3/resources/aws_s3_bucket_cors_configuration.app_data');
  });

  it('a config entry page names the resource it belongs to', () => {
    const fam = buildResourceFamilies(types, resources, blocks);
    const child = resources[1]!;
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(ResourceDetailView, {
          serviceSlug: 's3',
          resource: child,
          ops: [],
          parentResource: fam.parentOf.get(child.address),
        }),
      ),
    );
    expect(html).toContain('Part of');
    expect(html).toContain('/services/s3/resources/aws_s3_bucket.app_data');
  });
});
