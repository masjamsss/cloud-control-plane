import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ManifestOperation } from '@/types';
import { ENGINEER_DECIDES, renderHclSkeleton, tfLocalName } from '@/lib/hclSkeleton';
import {
  ebsBaseline,
  ebsValues,
  ec2Baseline,
  ec2Values,
  mechanicsOp,
  mechanicsValues,
  repeatedBaseline,
  repeatedValues,
  s3Baseline,
  s3Values,
} from './fixtures/skeletons/fixtureOps';

/**
 * 0033 A2 — golden tests for the DRAFT skeleton renderer. The fixture ops are
 * authored to the master plan's Part-2 normative baseline shapes; each golden
 * pins the FULL rendered output byte-for-byte, so any renderer change is a
 * conscious golden update, never drift — the same discipline the catalogctl
 * edit-verb golden corpus uses, and the parity anchor the Phase-2 create verb
 * will be tested against.
 */

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skeletons');

function golden(name: string): string {
  // Goldens are committed with a trailing newline (POSIX text files); the
  // renderer's output has none — normalize exactly that one difference.
  return readFileSync(join(GOLDEN_DIR, `${name}.golden.tf`), 'utf8').replace(/\n$/, '');
}

describe('hclSkeleton — golden shapes (byte-stable)', () => {
  it('#1 EC2 host: single block, nested blocks, tags map, const guardrails, TODOs', () => {
    expect(renderHclSkeleton(ec2Baseline, ec2Values, { requestId: 'REQ-0100' })).toBe(
      golden('ec2-instance'),
    );
  });

  it('#2 EBS volume: multi-block volume + attachment idiom, AZ derived from the host', () => {
    expect(renderHclSkeleton(ebsBaseline, ebsValues, { requestId: 'REQ-0200' })).toBe(
      golden('ebs-volume'),
    );
  });

  it('#3 S3 bucket: the estate idiom — bucket + public-access block + encryption + versioning', () => {
    expect(renderHclSkeleton(s3Baseline, s3Values, { requestId: 'REQ-0300' })).toBe(
      golden('s3-bucket'),
    );
  });

  it('#3b AES256 + versioning off: kms key inactive via dependsOn, versioning block omitted', () => {
    const rendered = renderHclSkeleton(
      s3Baseline,
      { ...s3Values, encryption: 'AES256', versioning: false },
      { requestId: 'REQ-0301' },
    );
    expect(rendered).toBe(golden('s3-bucket-aes256'));
    // The stale kms_key value present in the submitted params never renders —
    // the dependsOn gate the form and both validators share applies here too.
    expect(rendered).not.toContain('kms_master_key_id');
    expect(rendered).not.toContain('aws_s3_bucket_versioning');
  });

  it('#4 mechanics: wrap:"list" reference, literal escaping, sensitive redaction', () => {
    expect(renderHclSkeleton(mechanicsOp, mechanicsValues, {})).toBe(golden('mechanics'));
  });

  it('#5 repeated blocks: N instances from one param (2 attribute + 1 GSI, set + list)', () => {
    expect(renderHclSkeleton(repeatedBaseline, repeatedValues, { requestId: 'REQ-RPT' })).toBe(
      golden('dynamodb-repeated'),
    );
  });
});

describe('hclSkeleton — repeated (list/set) nested blocks', () => {
  const blockCount = (text: string, name: string): number =>
    (text.match(new RegExp(`^  ${name} \\{`, 'gm')) ?? []).length;

  it('emits exactly one `<block> {` per submitted instance — N in, N out', () => {
    const count = (attributes: unknown[]): number =>
      blockCount(
        renderHclSkeleton(repeatedBaseline, { ...repeatedValues, attributes }, {}),
        'attribute',
      );
    expect(count([{ name: 'a', type: 'S' }])).toBe(1);
    expect(count(repeatedValues.attributes as unknown[])).toBe(2);
    expect(
      count([
        { name: 'a', type: 'S' },
        { name: 'b', type: 'N' },
        { name: 'c', type: 'B' },
      ]),
    ).toBe(3);
  });

  it('an empty (or absent) repeated value renders NO block — omitted like an empty optional', () => {
    const emptied = renderHclSkeleton(
      repeatedBaseline,
      { ...repeatedValues, global_secondary_indexes: [] },
      {},
    );
    expect(emptied).not.toContain('global_secondary_index');
    const { global_secondary_indexes: _omit, ...absent } = repeatedValues;
    expect(renderHclSkeleton(repeatedBaseline, absent, {})).not.toContain('global_secondary_index');
  });

  it('a blank instance (every sub-field empty) never emits a hollow `block {}`', () => {
    const rendered = renderHclSkeleton(
      repeatedBaseline,
      {
        ...repeatedValues,
        global_secondary_indexes: [{ name: '', hash_key: '', projection_type: '' }],
      },
      {},
    );
    expect(rendered).not.toContain('global_secondary_index {');
  });

  it('every param convention folds INSIDE each instance — engineer-decides TODO, not hoisted out', () => {
    const rendered = renderHclSkeleton(repeatedBaseline, repeatedValues, {});
    const gsi = rendered.slice(rendered.indexOf('global_secondary_index {'));
    expect(gsi).toContain('# TODO: projection_type — engineer decides');
    // The TODO sits INSIDE the block (before it closes), never at the top level.
    expect(gsi.indexOf('# TODO: projection_type')).toBeLessThan(gsi.indexOf('\n  }'));
    expect(rendered).not.toContain(`projection_type = "${ENGINEER_DECIDES}"`);
  });

  it('set and list modes both render as a plain repeated `block { … }`', () => {
    const rendered = renderHclSkeleton(repeatedBaseline, repeatedValues, {});
    expect(rendered).toMatch(/^ {2}attribute \{/m); // mode: set
    expect(rendered).toMatch(/^ {2}global_secondary_index \{/m); // mode: list
  });

  it('single (non-repeated) nested blocks stay one instance each — the fold is untouched', () => {
    const ec2 = renderHclSkeleton(ec2Baseline, ec2Values, { requestId: 'REQ-0100' });
    expect(blockCount(ec2, 'metadata_options')).toBe(1);
    expect(blockCount(ec2, 'root_block_device')).toBe(1);
  });

  it('references, list tuples, and sensitive masking all work inside a repeated instance', () => {
    const op: ManifestOperation = {
      ...repeatedBaseline,
      id: 'fixture-repeated-mechanics',
      target: { resourceType: 'aws_fixture_ruleset' }, // no idiom → mechanical
      decisions: [],
      params: [
        {
          name: 'name',
          label: 'Name',
          type: 'string',
          source: 'user_input',
          required: true,
          role: 'key',
          attr: 'name',
        },
        {
          name: 'rules',
          label: 'Rule',
          type: 'list',
          source: 'user_input',
          required: true,
          repeated: {
            mode: 'list',
            block: 'rule',
            fields: [
              {
                name: 'target',
                label: 'Target group',
                type: 'string',
                source: 'inventory',
                enumSource: 'inventory://aws_security_group/address',
                required: true,
                role: 'reference',
                refAttr: 'id',
                attr: 'security_group_id',
              },
              {
                name: 'cidrs',
                label: 'CIDRs',
                type: 'list',
                source: 'user_input',
                required: true,
                attr: 'cidr_blocks',
              },
              {
                name: 'shared_secret',
                label: 'Shared secret',
                type: 'string',
                source: 'user_input',
                required: false,
                sensitive: true,
                attr: 'shared_secret',
              },
            ],
          },
        },
      ],
    };
    const rendered = renderHclSkeleton(
      op,
      {
        name: 'edge',
        rules: [
          {
            target: 'aws_security_group.app',
            cidrs: ['10.0.0.0/8', '10.1.0.0/16'],
            shared_secret: 'TopSecretValue9999',
          },
        ],
      },
      {},
    );
    // reference expression off the picked address (never a quoted literal)
    expect(rendered).toContain('security_group_id = aws_security_group.app.id');
    // a list sub-field renders as an HCL tuple
    expect(rendered).toContain('cidr_blocks = ["10.0.0.0/8", "10.1.0.0/16"]');
    // a sensitive sub-field INSIDE the block is still masked (flattenParams reach)
    expect(rendered).toContain('shared_secret = "«redacted:');
    expect(rendered).not.toContain('TopSecretValue9999');
  });

  it('a non-address reference inside an instance fails closed to a quoted literal', () => {
    const op: ManifestOperation = {
      ...repeatedBaseline,
      id: 'fixture-repeated-injection',
      target: { resourceType: 'aws_fixture_ruleset' },
      decisions: [],
      params: [
        {
          name: 'name',
          label: 'Name',
          type: 'string',
          source: 'user_input',
          required: true,
          role: 'key',
          attr: 'name',
        },
        {
          name: 'rules',
          label: 'Rule',
          type: 'list',
          source: 'user_input',
          required: true,
          repeated: {
            mode: 'list',
            block: 'rule',
            fields: [
              {
                name: 'target',
                label: 'Target',
                type: 'string',
                source: 'inventory',
                required: true,
                role: 'reference',
                refAttr: 'id',
                attr: 'security_group_id',
              },
            ],
          },
        },
      ],
    };
    const rendered = renderHclSkeleton(
      op,
      { name: 'edge', rules: [{ target: 'evil; } resource "boom" "x" {' }] },
      {},
    );
    expect(rendered).toContain('security_group_id = "evil; } resource \\"boom\\" \\"x\\" {"');
    expect(rendered).not.toContain('security_group_id = evil');
  });
});

describe('hclSkeleton — the properties the goldens encode', () => {
  const ec2 = renderHclSkeleton(ec2Baseline, ec2Values, { requestId: 'REQ-0100' });

  it('the banner leads and makes un-reviewed status unmistakable', () => {
    expect(ec2.startsWith('# DRAFT — generated from request REQ-0100')).toBe(true);
    expect(ec2).toContain('an engineer must review');
    expect(ec2).toContain('NOT applied by any pipeline');
  });

  it('every decisions[] entry renders as a TODO line', () => {
    for (const d of ec2Baseline.decisions ?? []) {
      expect(ec2).toContain(`# TODO: ${d}`);
    }
  });

  it('the engineer-decides sentinel renders a TODO, never a bogus assignment', () => {
    expect(ec2).toContain('# TODO: ami — engineer decides');
    expect(ec2).not.toContain(`ami = "${ENGINEER_DECIDES}"`);
  });

  it('const guardrails are written and VISIBLE (never masked, never inputs)', () => {
    expect(ec2).toContain('http_tokens = "required"');
    expect(ec2).toContain('associate_public_ip_address = false');
    expect(ec2).toContain('disable_api_termination = true');
  });

  it('reference params render expressions off the picked address, lists as tuples', () => {
    expect(ec2).toContain('subnet_id = aws_subnet.app_a.id');
    expect(ec2).toContain(
      'vpc_security_group_ids = [aws_security_group.app.id, aws_security_group.mgmt.id]',
    );
  });

  it('omitted optional params are omitted', () => {
    expect(ec2).not.toContain('private_ip');
  });

  it('a non-address value in a reference param NEVER becomes an expression', () => {
    const rendered = renderHclSkeleton(
      ec2Baseline,
      { ...ec2Values, subnet: 'evil; } resource "boom" "x" {' },
      {},
    );
    // Fail-closed to a quoted literal — no request byte becomes syntax.
    expect(rendered).toContain('subnet_id = "evil; } resource \\"boom\\" \\"x\\" {"');
    expect(rendered).not.toContain('subnet_id = evil');
  });

  it('an azurerm resource address renders as an unquoted expression (mirrors the Go golden fixture u4-reference-azurerm)', () => {
    // Same shape as tools/catalogctl/testdata/golden/u4-reference-azurerm/
    // create-with-rg-reference: a create op whose reference param picks an
    // azurerm_resource_group address and writes resource_group_name off it.
    const azureStorageOp: ManifestOperation = {
      ...mechanicsOp,
      id: 'fixture-azurerm-storage-with-rg-ref',
      target: { resourceType: 'azurerm_storage_account' },
      params: [
        {
          name: 'storage_account_name',
          label: 'Storage account name',
          type: 'string',
          source: 'user_input',
          required: true,
          role: 'key',
          attr: 'name',
        },
        {
          name: 'resource_group',
          label: 'Resource group',
          type: 'string',
          source: 'inventory',
          enumSource: 'inventory://azurerm_resource_group/name',
          required: true,
          role: 'reference',
          refAttr: 'name',
          attr: 'resource_group_name',
        },
      ],
    };
    const rendered = renderHclSkeleton(
      azureStorageOp,
      { storage_account_name: 'appdata002', resource_group: 'azurerm_resource_group.main' },
      {},
    );
    // ADDRESS_SHAPE now accepts azurerm_* the same as aws_* — an unquoted
    // expression, never a literal (the widened regex is behavior-inert for aws).
    expect(rendered).toContain('resource_group_name = azurerm_resource_group.main.name');
    expect(rendered).not.toContain('resource_group_name = "azurerm_resource_group.main"');
  });

  it('interpolation in a pasted value is escaped', () => {
    const rendered = renderHclSkeleton(mechanicsOp, mechanicsValues, {});
    expect(rendered).toContain('$${interpolation}');
    expect(rendered).not.toContain(' ${interpolation}');
  });

  it('sensitive-flagged values are redacted (redactHcl reuse)', () => {
    const rendered = renderHclSkeleton(mechanicsOp, mechanicsValues, {});
    expect(rendered).toContain('delivery_token = "«redacted:');
    expect(rendered).not.toContain('SuperSecretTokenValue12345678');
  });

  it('the banner request id is sanitized to id-safe characters', () => {
    const rendered = renderHclSkeleton(mechanicsOp, mechanicsValues, {
      requestId: 'x\n# owned',
    });
    expect(rendered.startsWith('# DRAFT — generated from request xowned;')).toBe(true);
  });

  it('renders deterministically (same input, same bytes)', () => {
    expect(renderHclSkeleton(ebsBaseline, ebsValues, { requestId: 'R' })).toBe(
      renderHclSkeleton(ebsBaseline, ebsValues, { requestId: 'R' }),
    );
  });
});

describe('tfLocalName — request identity to Terraform-safe local name', () => {
  it('sanitizes to lower-case identifier characters', () => {
    expect(tfLocalName('APP01 sdd')).toBe('app01_sdd');
    expect(tfLocalName('sample-finance-interface')).toBe('sample_finance_interface');
    expect(tfLocalName('  weird---name!! ')).toBe('weird_name');
  });

  it('never emits an empty or digit-leading name', () => {
    expect(tfLocalName('')).toBe('new_resource');
    expect(tfLocalName(undefined)).toBe('new_resource');
    expect(tfLocalName('42east')).toBe('r_42east');
  });
});

describe('hclSkeleton — map param renders as an HCL block', () => {
  it('a type:map value drafts as a nested map, never "[object Object]"', () => {
    // Regression: scalarValue had no map case, so a tags map param drafted as
    // `tags = "[object Object]"`. Matters for the schema-driven provision form,
    // which renders arbitrary types whose tags are a single map param.
    const op = {
      id: 'map-op',
      service: 'x',
      macd: 'Add',
      codemodOp: 'create_resource',
      title: 't',
      description: '',
      target: { resourceType: 'azurerm_storage_account' },
      riskFloor: 'HIGH',
      reversible: true,
      downtime: 'none',
      exposure: 'engineer_only',
      forcesReplace: false,
      autoEligible: false,
      terraformCapability: '+ create',
      group: 'create',
      draftSkeleton: true,
      params: [
        {
          name: 'tags',
          label: 'Tags',
          type: 'map',
          source: 'user_input',
          required: true,
          bounds: { pattern: '.*' },
        },
      ],
    } as unknown as ManifestOperation;
    const out = renderHclSkeleton(op, { tags: { Environment: 'prod', Owner: 'team' } }, {});
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('Environment = "prod"');
    expect(out).toContain('Owner = "team"');
  });
});
