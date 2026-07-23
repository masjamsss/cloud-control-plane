import { describe, expect, it } from 'vitest';
// The parser is a zero-dependency .mjs run by CI's own node; here we import its
// pure core and assert its output against the shared contract it is pinned to.
import { summarizePlan } from '../../scripts/plan-summary.mjs';
import { actionLabel, isPlanSummary, planHeadline, type PlanSummary } from '@/lib/planSummary';
import { consequencesFor, nounForType } from '@/lib/replaceConsequences';
import { findDependents } from '@/lib/dependents';
import type { BlockSource } from '@/lib/blockSource';
import updateInPlace from './fixtures/plans/update-in-place.json';
import replaceForced from './fixtures/plans/replace-forced.json';
import createOnly from './fixtures/plans/create.json';
import mixed from './fixtures/plans/mixed.json';

/**
 * 0035 Docket B — the plan-summary parser + shared contract + the two panel
 * helper libs (replace consequences, committed-block dependents). Fixture-
 * driven against real `terraform show -json`-shaped input; no live AWS. The
 * fixtures are the three the docket calls for — an in-place update, a REPLACE
 * with a forcing attribute, a create — plus a mixed plan that exercises the
 * data-source skip, the no-op count, sensitive redaction, and sort order.
 */

describe('summarizePlan — terraform show -json → the structured summary', () => {
  it('in-place update: only changed attributes, sorted; unchanged ones dropped', () => {
    const summary = summarizePlan(updateInPlace) as PlanSummary;
    expect(summary.counts).toEqual({ create: 0, update: 1, replace: 0, delete: 0, noop: 0 });
    expect(summary.resourceChanges).toHaveLength(1);
    const rc = summary.resourceChanges[0]!;
    expect(rc.action).toBe('update');
    expect(rc.address).toBe('aws_instance.app01');
    expect(rc.type).toBe('aws_instance');
    expect(rc.forcedBy).toBeUndefined();
    // instance_type + monitoring changed; tags did not → dropped. Keys sorted.
    expect(rc.changed).toEqual([
      { attr: 'instance_type', before: 'r6i.large', after: 'r6i.xlarge' },
      { attr: 'monitoring', before: 'false', after: 'true' },
    ]);
  });

  it('REPLACE: forcedBy carries the forcing attr; a known-after-apply id renders honestly', () => {
    const summary = summarizePlan(replaceForced) as PlanSummary;
    expect(summary.counts).toEqual({ create: 0, update: 0, replace: 1, delete: 0, noop: 0 });
    const rc = summary.resourceChanges[0]!;
    expect(rc.action).toBe('replace');
    expect(rc.forcedBy).toEqual(['encrypted']);
    expect(rc.changed).toEqual([
      { attr: 'encrypted', before: 'false', after: 'true' },
      { attr: 'id', before: 'vol-0c0c0c0c0c0c0c002', after: '(known after apply)' },
    ]);
  });

  it('create: counted, listed with no attr diff (the whole resource is new)', () => {
    const summary = summarizePlan(createOnly) as PlanSummary;
    expect(summary.counts).toEqual({ create: 1, update: 0, replace: 0, delete: 0, noop: 0 });
    const rc = summary.resourceChanges[0]!;
    expect(rc.action).toBe('create');
    expect(rc.address).toBe('aws_cloudwatch_metric_alarm.new_cpu_high');
    expect(rc.changed).toBeUndefined();
    expect(rc.forcedBy).toBeUndefined();
  });

  it('mixed: data-source read skipped, no-op counted-not-listed, delete + sensitive update, sorted', () => {
    const summary = summarizePlan(mixed) as PlanSummary;
    expect(summary.counts).toEqual({ create: 0, update: 1, replace: 0, delete: 1, noop: 1 });
    // data source is neither counted nor listed; no-op is counted, never listed.
    expect(summary.resourceChanges.map((c) => c.address)).toEqual([
      'aws_db_instance.reporting',
      'aws_security_group.legacy',
    ]);
    const db = summary.resourceChanges.find((c) => c.type === 'aws_db_instance')!;
    // sensitive password redacted on both sides; allocated_storage shown; sorted.
    expect(db.changed).toEqual([
      { attr: 'allocated_storage', before: '100', after: '200' },
      { attr: 'password', before: '(sensitive)', after: '(sensitive)' },
    ]);
    const sg = summary.resourceChanges.find((c) => c.type === 'aws_security_group')!;
    expect(sg.action).toBe('delete');
    expect(sg.changed).toBeUndefined();
  });

  it('is deterministic: the same plan yields a byte-identical summary', () => {
    expect(JSON.stringify(summarizePlan(mixed))).toBe(JSON.stringify(summarizePlan(mixed)));
  });

  it('parser output always satisfies the shared contract (never refused by the api)', () => {
    for (const plan of [updateInPlace, replaceForced, createOnly, mixed]) {
      expect(isPlanSummary(summarizePlan(plan))).toBe(true);
    }
  });

  it('an empty / shapeless plan is a valid no-op summary', () => {
    expect(summarizePlan({})).toEqual({
      resourceChanges: [],
      counts: { create: 0, update: 0, replace: 0, delete: 0, noop: 0 },
    });
  });
});

describe('planHeadline — the plain-language top line', () => {
  it('a single resource is named with its human noun', () => {
    const summary = summarizePlan(replaceForced) as PlanSummary;
    expect(planHeadline(summary, nounForType)).toBe('This plan will replace one volume.');
  });

  it('a no-op plan says so honestly', () => {
    const noop: PlanSummary = {
      resourceChanges: [],
      counts: { create: 0, update: 0, replace: 0, delete: 0, noop: 3 },
    };
    expect(planHeadline(noop, nounForType)).toBe(
      'No changes — this plan leaves the live environment exactly as it is.',
    );
  });

  it('a multi-resource plan lists verbs destructive-first with a total', () => {
    const many: PlanSummary = {
      resourceChanges: [
        { address: 'aws_ebs_volume.a', type: 'aws_ebs_volume', action: 'replace' },
        { address: 'aws_instance.b', type: 'aws_instance', action: 'update' },
        { address: 'aws_instance.c', type: 'aws_instance', action: 'update' },
        { address: 'aws_s3_bucket.d', type: 'aws_s3_bucket', action: 'create' },
      ],
      counts: { create: 1, update: 2, replace: 1, delete: 0, noop: 0 },
    };
    expect(planHeadline(many, nounForType)).toBe(
      'This plan will replace 1, update 2, and create 1 — 4 resources in all.',
    );
  });
});

describe('actionLabel + isPlanSummary — contract helpers', () => {
  it('actionLabel maps every verb to a short badge word', () => {
    expect(actionLabel('create')).toBe('Create');
    expect(actionLabel('update')).toBe('Update');
    expect(actionLabel('replace')).toBe('Replace');
    expect(actionLabel('delete')).toBe('Destroy');
  });

  it('isPlanSummary rejects the legacy string and other non-summaries', () => {
    expect(isPlanSummary('1 to change, 0 to add, 0 to destroy.')).toBe(false);
    expect(isPlanSummary(null)).toBe(false);
    expect(isPlanSummary({ resourceChanges: [] })).toBe(false); // missing counts
    expect(isPlanSummary({ resourceChanges: 'x', counts: {} })).toBe(false);
  });

  it('isPlanSummary refuses a non-https runUrl (rendered as an href)', () => {
    const base = {
      resourceChanges: [],
      counts: { create: 0, update: 0, replace: 0, delete: 0, noop: 0 },
    };
    expect(isPlanSummary({ ...base, runUrl: 'https://github.com/x/y/actions/runs/1' })).toBe(true);
    expect(isPlanSummary({ ...base, runUrl: 'javascript:alert(1)' })).toBe(false);
    expect(isPlanSummary({ ...base, runUrl: 'http://insecure/run' })).toBe(false);
  });
});

describe('replaceConsequences — the curated "what a replace costs" table', () => {
  it('a data-bearing type carries the destroysData flag, a headline, and consequences', () => {
    const c = consequencesFor('aws_ebs_volume');
    expect(c?.destroysData).toBe(true);
    expect(c?.headline).toMatch(/destroys the disk/i);
    expect(c?.consequences.length).toBeGreaterThan(0);
  });

  it('an uncurated type has no consequence entry but still gets a readable noun', () => {
    expect(consequencesFor('aws_nat_gateway')).toBeUndefined();
    expect(nounForType('aws_nat_gateway')).toBe('nat gateway');
    expect(nounForType('aws_ebs_volume')).toBe('volume');
  });
});

describe('findDependents — committed-Terraform references to a doomed address', () => {
  const blocks: Record<string, BlockSource> = {
    'aws_ebs_volume.app01_sdb': {
      file: 'ebs.tf',
      line: 1,
      source: 'resource "aws_ebs_volume" "app01_sdb" {\n  size = 100\n}',
    },
    'aws_volume_attachment.app01_sdb': {
      file: 'ebs.tf',
      line: 9,
      source:
        'resource "aws_volume_attachment" "app01_sdb" {\n  volume_id = aws_ebs_volume.app01_sdb.id\n}',
    },
    'aws_instance.app01': {
      file: 'ec2.tf',
      line: 1,
      source: 'resource "aws_instance" "app01" {\n  # data disk: aws_ebs_volume.app01_sdb\n}',
    },
    // A NAME that has the target as a prefix — must NOT be a false positive.
    'aws_ebs_volume.app01_sdb_backup': {
      file: 'ebs.tf',
      line: 20,
      source: 'resource "aws_ebs_volume" "app01_sdb_backup" {\n  size = 100\n}',
    },
  };

  it('finds every referencing address, excludes the target itself, and sorts', () => {
    expect(findDependents('aws_ebs_volume.app01_sdb', blocks)).toEqual([
      'aws_instance.app01',
      'aws_volume_attachment.app01_sdb',
    ]);
  });

  it('a NAME whose prefix matches is not a dependent (whole-token match only)', () => {
    // app01_sdb_backup references nothing; and searching FOR the backup finds
    // no one, proving app01_sdb.id did not leak a partial match.
    expect(findDependents('aws_ebs_volume.app01_sdb_backup', blocks)).toEqual([]);
  });

  it('an address nothing references has no dependents', () => {
    expect(findDependents('aws_instance.app01', blocks)).toEqual([]);
  });
});
