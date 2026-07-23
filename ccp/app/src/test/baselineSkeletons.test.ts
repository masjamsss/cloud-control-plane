import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import { generateDiff } from '@/lib/diff';
import { renderHclSkeleton } from '@/lib/hclSkeleton';
import { parseInventoryEnum, resolveEnum, validateParams } from '@/lib/interpreter';
import type { Inventory, ManifestOperation } from '@/types';
import { BASELINE_VALUES, BASELINE_VARIANTS } from './fixtures/skeletons/baselines/values';

/**
 * 0034 W3 — the core create baselines, pinned against the REAL catalog ops
 * (the hclSkeleton.test.ts fixtures prove the renderer; this file proves the
 * shipped manifests drive it to the normative Part-2 shapes):
 *
 *   1. GOLDENS — every baseline's rendered DRAFT skeleton is byte-pinned
 *      (fixtures/skeletons/baselines/<op-id>.golden.tf; regenerate
 *      consciously with scripts/dev-gen-baseline-goldens.ts).
 *   2. FIELD COUNTS + SECTIONS — the elaboration is real: a baseline carries
 *      its full Part-2 schema, not a free-text box.
 *   3. TIERS FROZEN — every new create baseline ships engineer_only (Phase-1
 *      rule: standalone-resource Adds sit with the engineer until the
 *      census-gated retiers; exposure never gates submission).
 *   4. PICKERS RESOLVE — every inventory source on a baseline fills from the
 *      committed inventory (or sits on a declared legitimately-empty type:
 *      the backup vault picker before the first vault is adopted).
 *   5. THE PIPELINE CARRIES IT — generateDiff (the exact function the review
 *      step renders and the submit path pins into pinnedDiff) returns the
 *      skeleton for draftSkeleton ops, never the fabricated one-attribute
 *      diff the owner rejected.
 */

const inventory = inventoryData as unknown as Inventory;
const GOLDEN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'skeletons',
  'baselines',
);

function golden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.golden.tf`), 'utf8').replace(/\n$/, '');
}

function op(id: string): ManifestOperation {
  const found = manifests.flatMap((m) => m.operations).find((o) => o.id === id);
  expect(found, `op ${id} missing from catalog`).toBeDefined();
  return found!;
}

/** id → [params, non-const params, named param groups] per 0034 Part 2. */
const BASELINE_SHAPE: Record<string, [number, number, number]> = {
  'ec2-provision-instance': [17, 13, 5],
  'ebs-create-volume': [12, 11, 4],
  's3-create-bucket': [12, 8, 3],
  's3-create-lifecycle-setup': [7, 6, 0],
  's3-start-versioning-setup': [2, 1, 0],
  'sg-create-security-group': [10, 10, 3],
  'alb-add-target-group': [14, 14, 4],
  'efs-create-filesystem': [11, 10, 4],
  'rds-provision-instance': [15, 14, 6],
  'backup-create-vault': [5, 5, 2],
  'backup-create-plan': [11, 11, 3],
  'vpn-add-static-route': [2, 2, 0],
  'sns-create-topic': [6, 6, 2],
  'lambda-create-function': [11, 11, 4],
  // 0039 S1 — the 6 curated AWS creates for types the generic form collapsed
  // deep/polymorphic sub-blocks (step/target-tracking policy, cache behaviors,
  // policy_details, default_action auth blocks, GSI/import) to raw JSON on.
  'autoscaling-create-group': [12, 10, 6],
  'autoscaling-create-policy': [7, 6, 2],
  'acm-lb-listener-create': [11, 10, 5],
  'dlm-create-policy': [15, 14, 4],
  'dynamodb-create-table': [14, 13, 5],
  'cloudfront-create-distribution': [24, 13, 5],
  // lane-aws-compute (0039 S4) — the 17 curated AWS Compute & Containers
  // creates: ECS/EKS/Batch (3 each), ECR, CodeArtifact, Elastic Beanstalk,
  // Image Builder, Lightsail, Application Auto Scaling (2), DRS.
  'ecs-cluster-create': [7, 6, 3],
  'ecs-task-definition-create': [11, 11, 5],
  'ecs-service-create': [15, 15, 5],
  'eks-cluster-create': [13, 13, 5],
  'eks-node-group-create': [14, 14, 5],
  'eks-fargate-profile-create': [9, 9, 4],
  'batch-compute-environment-create': [11, 10, 4],
  'batch-job-queue-create': [8, 7, 3],
  'batch-job-definition-create': [9, 8, 5],
  'ecr-repository-create': [9, 8, 4],
  'codeartifact-domain-create': [5, 5, 3],
  'elastic-beanstalk-application-create': [8, 8, 3],
  'imagebuilder-image-pipeline-create': [10, 10, 5],
  'lightsail-instance-create': [8, 8, 4],
  'appautoscaling-target-create': [10, 8, 3],
  'appautoscaling-policy-create': [10, 7, 2],
  'drs-replication-template-create': [20, 19, 6],
};

const BASELINE_IDS = Object.keys(BASELINE_SHAPE);

describe('W3 baselines — golden skeletons (byte-stable)', () => {
  it.each(BASELINE_IDS)('%s renders its pinned DRAFT skeleton', (id) => {
    const values = BASELINE_VALUES[id];
    expect(values, `no fixture values for ${id}`).toBeDefined();
    expect(renderHclSkeleton(op(id), values!, { requestId: 'REQ-W3' })).toBe(golden(id));
  });

  it.each(Object.keys(BASELINE_VARIANTS))('variant %s renders its pinned shape', (name) => {
    const id = name.split('--')[0]!;
    expect(renderHclSkeleton(op(id), BASELINE_VARIANTS[name]!, { requestId: 'REQ-W3' })).toBe(
      golden(name),
    );
  });

  it('the no-rule security group renders NO ingress block (never a partial rule)', () => {
    expect(golden('sg-create-security-group--no-rule')).not.toContain('ingress');
  });

  it('the backups-off share renders the in-block TODO and no backup-policy resource', () => {
    const text = golden('efs-create-filesystem--no-backup');
    expect(text).toContain('# TODO: automatic backups are off for this share');
    expect(text).not.toContain('aws_efs_backup_policy');
    expect(text).not.toContain('lifecycle_policy');
  });

  it('0036 §5.3 — the backups-ON share is SINGLE-block: the filesystem only, no aws_efs_backup_policy resource, plus the follow-up TODO', () => {
    const text = golden('efs-create-filesystem');
    expect(text).toContain('# TODO: automatic backups are on for this share');
    // No co-emitted backup-policy RESOURCE (the string may appear in the TODO prose only).
    expect(text).not.toContain('resource "aws_efs_backup_policy"');
    // Exactly one resource block: the filesystem itself (the reconciliation's whole point).
    expect(text.match(/^resource /gm)?.length).toBe(1);
  });

  it('0036 §2 freeze-confirm — the S3 create bucket carries the estate lifecycle { prevent_destroy = true }', () => {
    const text = golden('s3-create-bucket');
    // Present on the bucket block, matching all 20 estate buckets (environments/prod/s3.tf).
    expect(text).toContain('  lifecycle {\n    prevent_destroy = true\n  }');
  });
});

describe('W3 baselines — the elaboration is real (0034 Part 2 shapes)', () => {
  it.each(BASELINE_IDS)('%s carries its full Part-2 schema', (id) => {
    const o = op(id);
    const [params, nonConst, groups] = BASELINE_SHAPE[id]!;
    expect(o.params, `${id} param count`).toHaveLength(params);
    expect(o.params.filter((p) => p.role !== 'const'), `${id} non-const params`).toHaveLength(
      nonConst,
    );
    expect(
      new Set(o.params.map((p) => p.group).filter(Boolean)).size,
      `${id} named param groups`,
    ).toBe(groups);
    expect(o.draftSkeleton, `${id} draftSkeleton`).toBe(true);
    expect(o.decisions?.length ?? 0, `${id} decisions[]`).toBeGreaterThan(0);
    expect(o.group).toBe('create');
    expect(o.macd).toBe('Add');
  });

  it('the flagship: ec2-provision-instance went from one free-text box to a real baseline', () => {
    const o = op('ec2-provision-instance');
    expect(o.params.length).toBeGreaterThanOrEqual(12); // the A3 acceptance floor
    expect(o.params.find((p) => p.name === 'purpose')).toBeUndefined();
    // The five grouped sections of the normative schema.
    expect(new Set(o.params.map((p) => p.group).filter(Boolean))).toEqual(
      new Set(['identity', 'compute', 'network', 'iam-storage', 'tags']),
    );
    // Machine-checkable guardrails ride as const params, never inputs.
    const consts = o.params.filter((p) => p.role === 'const').map((p) => p.attr);
    expect(consts).toContain('http_tokens');
    expect(consts).toContain('associate_public_ip_address');
    expect(consts).toContain('disable_api_termination');
    // Δ1 — one list, two ops: the size allowlist is ec2-resize's, verbatim.
    const resize = op('ec2-resize').params.find((p) => p.name === 'new_instance_type')!;
    const size = o.params.find((p) => p.name === 'instance_type')!;
    expect(size.bounds?.allowlist).toEqual(resize.bounds?.allowlist);
  });

  it('every baseline stays engineer-routed (Phase-1 exposure frozen; retiers are a later human gate)', () => {
    for (const id of BASELINE_IDS) {
      expect(op(id).exposure, id).toBe('engineer_only');
    }
  });

  it('estate tag convention: every standalone baseline carries Description and person-in-charge tags', () => {
    for (const id of BASELINE_IDS) {
      if (
        [
          's3-create-lifecycle-setup',
          's3-start-versioning-setup',
          'vpn-add-static-route',
          // 0039 S1 — aws_autoscaling_group tags via a repeated `tag` block
          // (key/value/propagate_at_launch), not a `tags` map: the dotted
          // tags.Description/tags.PIC convention has no attribute to land on,
          // so only a Name tag is seeded (decisions[] routes the rest through
          // the existing autoscaling-add-tag op after creation).
          'autoscaling-create-group',
          // aws_autoscaling_policy carries no tags/tag argument at all in the
          // provider schema (it is a scaling policy, not a taggable resource).
          'autoscaling-create-policy',
          // lane-aws-compute — aws_appautoscaling_policy carries no tags/tag
          // argument at all in the provider schema either (same as the ASG
          // policy above): it is a scaling policy, not a taggable resource.
          'appautoscaling-policy-create',
        ].includes(id)
      )
        continue; // config-resource creates annotate their parent; the vpn route has no tags argument
      const attrs = op(id).params.map((p) => p.attr);
      expect(attrs, `${id} description tag`).toContain('tags.Description');
      expect(attrs, `${id} person-in-charge tag`).toContain('tags.PIC');
    }
  });

  it('every baseline picker resolves from the committed inventory (or sits on the declared-empty backup/ASG type)', () => {
    for (const id of BASELINE_IDS) {
      for (const p of op(id).params) {
        const src = parseInventoryEnum(p.enumSource);
        if (!src) continue;
        const rows = resolveEnum(p, inventory).length;
        if (src.type === 'aws_backup_vault') {
          // The adoption path: the plan's vault picker is empty until the
          // first vault lands — and its help says exactly that.
          expect(rows).toBe(0);
          expect(p.help).toContain('Create a vault first');
        } else if (src.type === 'aws_autoscaling_group') {
          // 0039 S1 — same adoption path: autoscaling is scope:"greenfield"
          // (no ASG exists in this estate yet), so the new policy's group
          // picker is empty until autoscaling-create-group's first group
          // lands — its help says exactly that.
          expect(rows).toBe(0);
          expect(p.help).toContain('Create the group first');
        } else if (src.type === 'aws_ecs_cluster') {
          // lane-aws-compute — same adoption path: ecs is scope:"greenfield"
          // (no cluster exists in this estate yet), so ecs-service-create's
          // cluster picker is empty until ecs-cluster-create's first cluster
          // lands — its help says exactly that.
          expect(rows).toBe(0);
          expect(p.help).toContain('Create the cluster first');
        } else if (src.type === 'aws_ecs_task_definition') {
          // Same adoption path: no task definition exists yet either.
          expect(rows).toBe(0);
          expect(p.help).toContain('Create the task definition first');
        } else if (src.type === 'aws_eks_cluster') {
          // Same adoption path, for eks-node-group-create and
          // eks-fargate-profile-create's cluster picker.
          expect(rows).toBe(0);
          expect(p.help).toContain('Create the cluster first');
        } else if (src.type === 'aws_batch_compute_environment') {
          // Same adoption path: batch-job-queue-create's compute environment
          // picker is empty until batch-compute-environment-create's first
          // environment lands.
          expect(rows).toBe(0);
          expect(p.help).toContain('Create the compute environment first');
        } else {
          expect(rows, `${id}/${p.name} (${p.enumSource})`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('every baseline validates its golden fixture values (submittable as authored)', () => {
    for (const id of BASELINE_IDS) {
      const result = validateParams(op(id), BASELINE_VALUES[id]!, inventory);
      expect(result.errors, id).toEqual({});
    }
  });
});

describe('W3 baselines — the request carries the bootstrap', () => {
  it('generateDiff (review render + submit-time pin) returns the DRAFT skeleton for baseline ops', () => {
    const o = op('ec2-provision-instance');
    const diff = generateDiff(o, BASELINE_VALUES['ec2-provision-instance']!, inventory);
    expect(diff.startsWith('# DRAFT — generated from a portal request')).toBe(true);
    expect(diff).toContain('resource "aws_instance" "app_02"');
    expect(diff).not.toContain('purpose');
  });

  it('the re-authored vpn route produces an aws_vpn_connection_route skeleton (0019 WONTFIX closed)', () => {
    const o = op('vpn-add-static-route');
    expect(o.target.resourceType).toBe('aws_vpn_connection_route');
    expect(o.codemodOp).toBe('instantiate_module');
    const diff = generateDiff(o, BASELINE_VALUES['vpn-add-static-route']!, inventory);
    expect(diff).toContain('resource "aws_vpn_connection_route"');
    expect(diff).toContain(
      'vpn_connection_id = aws_vpn_connection.prod_onprem_dc1.id',
    );
    // The 0019 adjudication's broken shape is gone for good.
    expect(o.target.block).toBeUndefined();
    expect(diff).not.toContain('static_routes');
  });

  it('B12 refined: the existing selection op gains the skeleton flag and its engineer decision, params untouched', () => {
    const o = op('backup-add-resource-selection');
    expect(o.draftSkeleton).toBe(true);
    expect(o.decisions?.length).toBe(1);
    expect(o.params).toHaveLength(5); // "refine, don't duplicate" — no schema change
    expect(o.exposure).toBe('l1_with_guardrails'); // pre-existing tier untouched (frozen)
  });

  it('the backup service teaches the adoption chain in its summary', () => {
    const backup = manifests.find((m) => m.service === 'backup')!;
    expect(backup.summary).toContain('Start with');
    expect(backup.summary).toContain('vault');
    expect(backup.summary).toContain('plan');
  });
});

// ── Full-population coverage: EVERY aws create_resource op renders its committed golden ──
// The BASELINE_SHAPE tests above pin the hand-curated headline forms with exact field/
// section counts. This asserts the WHOLE aws create population — all lanes
// (compute/database/networking/security + the prior curated set) — renders byte-for-byte
// to its committed golden, so no form ships un-pinned. The golden is the byte-pin
// (generated by scripts/dev-gen-baseline-goldens.ts from BASELINE_VALUES with the same
// REQ-W3); this proves the shipped manifest still drives the renderer to it, and catches
// a renderer regression on any form that lacks a hand-authored BASELINE_SHAPE entry.
const ALL_AWS_CREATE_IDS = manifests
  .flatMap((m) => m.operations)
  .filter((o) => o.codemodOp === 'create_resource' && o.target.resourceType.startsWith('aws_'))
  .map((o) => o.id)
  .sort();

describe('every aws create_resource op renders its committed golden', () => {
  it('the full aws create population is covered (no form ships un-pinned)', () => {
    expect(ALL_AWS_CREATE_IDS.length).toBeGreaterThanOrEqual(94);
  });

  it.each(ALL_AWS_CREATE_IDS)('%s renders its committed golden', (id) => {
    const values = BASELINE_VALUES[id];
    expect(values, `${id} has no BASELINE_VALUES fixture`).toBeDefined();
    expect(renderHclSkeleton(op(id), values!, { requestId: 'REQ-W3' })).toBe(golden(id));
  });
});
