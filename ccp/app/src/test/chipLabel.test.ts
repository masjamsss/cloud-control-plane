import { describe, expect, it } from 'vitest';
import type { InventoryResource } from '@/types';
import {
  arnTail,
  chipLabelFor,
  displayResourceLabel,
  humanizeAttr,
  isArn,
  MAX_CHIPS,
  resourceChips,
} from '@/lib/chipLabel';

/**
 * 0034 Addendum D17 — humanized resource rendering. The shared chipLabel map
 * is the single place attribute keys become operator words (with units where
 * known); the fallback humanizer covers every uncurated key; ARN values
 * shorten to their meaningful tail with the full value preserved. The owner's
 * Lambda-page examples are pinned verbatim.
 */

function resource(overrides: Partial<InventoryResource> = {}): InventoryResource {
  return {
    address: 'aws_lambda_function.alarm_action_sdp',
    resourceType: 'aws_lambda_function',
    name: 'alarm_action_sdp',
    service: 'lambda',
    attributes: {},
    ...overrides,
  };
}

describe('chipLabelFor — the owner-named examples, verbatim', () => {
  it('memory_size → Memory (MB)', () => {
    expect(chipLabelFor('memory_size')).toBe('Memory');
  });
  it('timeout → Timeout (s)', () => {
    expect(chipLabelFor('timeout')).toBe('Timeout');
  });
  it('reserved_concurrent_executions → Reserved concurrency', () => {
    expect(chipLabelFor('reserved_concurrent_executions')).toBe('Reserved concurrency');
  });
  it('size_gib → Size (GiB)', () => {
    expect(chipLabelFor('size_gib')).toBe('Size');
  });
  it('instance_type → Type', () => {
    expect(chipLabelFor('instance_type')).toBe('Type');
  });
});

describe('humanizeAttr — the fallback for uncurated keys', () => {
  it('splits underscores and restores acronyms', () => {
    expect(humanizeAttr('block_public_acls')).toBe('Block public ACLs');
    expect(humanizeAttr('vpc_endpoint_type')).toBe('VPC endpoint type');
    expect(humanizeAttr('enable_key_rotation')).toBe('Enable key rotation');
    expect(humanizeAttr('local_ipv4_network_cidr')).toBe('Local IPv4 network CIDR');
  });

  it('single words just get their first letter up', () => {
    expect(humanizeAttr('bucket')).toBe('Bucket');
    expect(humanizeAttr('description')).toBe('Description');
  });

  it('never emits a snake_case token, whatever the input key', () => {
    expect(humanizeAttr('transition_default_minimum_object_size')).not.toMatch(
      /[A-Za-z0-9]_[A-Za-z0-9]/,
    );
  });
});

describe('ARN shortening — meaningful tail visible, full value preserved', () => {
  const roleArn = 'arn:aws:iam::000000000000:role/service-role/AlarmHandler-role-ywzgc5x5';

  it('isArn detects ARN-shaped values only', () => {
    expect(isArn(roleArn)).toBe(true);
    expect(isArn('nodejs22.x')).toBe(false);
  });

  it('arnTail is the last path segment (the owner example: the role name)', () => {
    expect(arnTail(roleArn)).toBe('AlarmHandler-role-ywzgc5x5');
  });

  it('arnTail falls back to the last colon segment when the ARN has no path', () => {
    expect(arnTail('arn:aws:sns:eu-west-1:000000000000:oncall-topic')).toBe('oncall-topic');
  });
});

describe('resourceChips — label + unit + shortened value per chip', () => {
  it('the Lambda card chips: Memory 256 MB, Timeout 60 s, Role as its tail', () => {
    const chips = resourceChips(
      resource({
        attributes: {
          runtime: 'nodejs22.x',
          memory_size: 256,
          timeout: 60,
          role: 'arn:aws:iam::000000000000:role/service-role/AlarmHandler-role-ywzgc5x5',
        },
      }),
    );
    expect(chips.map((c) => [c.label, c.value])).toEqual([
      ['Runtime', 'nodejs22.x'],
      ['Memory', '256 MB'],
      ['Timeout', '60 s'],
      ['Role', 'AlarmHandler-role-ywzgc5x5'],
    ]);
    // The full ARN is not lost — it rides the chip for hover display.
    expect(chips[3]!.full).toBe(
      'arn:aws:iam::000000000000:role/service-role/AlarmHandler-role-ywzgc5x5',
    );
    // Values that were not shortened carry no hover duplicate.
    expect(chips[0]!.full).toBeUndefined();
  });

  it('size_gib renders "Size 350 GiB" and reserved concurrency stays unitless', () => {
    const chips = resourceChips(
      resource({ attributes: { size_gib: 350, reserved_concurrent_executions: 1 } }),
    );
    expect(chips.map((c) => [c.label, c.value])).toEqual([
      ['Size', '350 GiB'],
      ['Reserved concurrency', '1'],
    ]);
  });

  it('booleans read Yes/No, not true/false', () => {
    const chips = resourceChips(resource({ attributes: { encrypted: true, multi_az: false } }));
    expect(chips.map((c) => [c.label, c.value])).toEqual([
      ['Encrypted', 'Yes'],
      ['Multi-AZ', 'No'],
    ]);
  });

  it('string values that are estate data render verbatim — display never falsifies an identifier', () => {
    const chips = resourceChips(resource({ attributes: { description: 'AZURE_TO_AWS_SG' } }));
    expect(chips[0]!.value).toBe('AZURE_TO_AWS_SG');
  });

  it(`caps at ${MAX_CHIPS} chips (unchanged pre-D17 selection rule)`, () => {
    const chips = resourceChips(
      resource({ attributes: { a: 1, b: 2, c: 3, d: 4, e: 5 } }),
    );
    expect(chips).toHaveLength(MAX_CHIPS);
  });
});

describe('displayResourceLabel — the primary label prefers friendly names (D17a)', () => {
  it('a friendly Name tag renders untouched', () => {
    expect(displayResourceLabel(resource({ name: 'APP01 - ERP Dev Live' }))).toBe(
      'APP01 - ERP Dev Live',
    );
  });

  it('a raw tf-label name is humanized — the owner example', () => {
    expect(displayResourceLabel(resource({ name: 'alarm_action_sdp' }))).toBe('Alarm action sdp');
  });

  it('a missing name falls back to the humanized address label, never the full address', () => {
    expect(
      displayResourceLabel(resource({ name: undefined, address: 'aws_ebs_volume.app01_sdb' })),
    ).toBe('App01 sdb');
  });

  it('acronym words inside tf labels are restored', () => {
    expect(displayResourceLabel(resource({ name: 'web_https_443' }))).toBe('Web HTTPS 443');
  });

  it('never yields a snake_case token', () => {
    expect(displayResourceLabel(resource({ name: 'a_b_c_d' }))).not.toMatch(
      /[A-Za-z0-9]_[A-Za-z0-9]/,
    );
  });
});
