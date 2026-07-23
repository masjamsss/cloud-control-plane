import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  compactResource,
  compactType,
  countLeaves,
  primaryTypeFor,
  serviceDisplayMeta,
  serviceForType,
  typeLabel,
  MAX_BLOCK_DEPTH,
  type RawProviderSchemas,
  type RawResourceSchema,
} from '@/lib/providerCatalogGen';

/**
 * The schema→catalog transform, pinned on small fixtures shaped exactly like
 * `terraform providers schema -json` output: grouping rules, computed-only
 * exclusion, deprecated exclusion, the `id` rule, nested-block compaction and
 * the depth cap that keeps the giant recursive schemas small.
 */

describe('serviceForType — the grouping rule', () => {
  it('multi-word curated prefixes win over the first token', () => {
    expect(serviceForType('aws_api_gateway_rest_api')).toBe('api-gateway');
    expect(serviceForType('aws_apigatewayv2_api')).toBe('api-gateway');
    expect(serviceForType('aws_elastic_beanstalk_environment')).toBe('elastic-beanstalk');
    expect(serviceForType('aws_cloudwatch_event_rule')).toBe('eventbridge');
  });

  it('console-truth merges: db → RDS, lb → Load Balancing, wafv2 → WAF', () => {
    expect(serviceForType('aws_db_instance')).toBe('rds');
    expect(serviceForType('aws_lb_listener')).toBe('alb');
    expect(serviceForType('aws_wafv2_web_acl')).toBe('waf');
    expect(serviceForType('aws_waf_rule')).toBe('waf-classic');
  });

  it('the estate service slugs hold: security groups and routing', () => {
    expect(serviceForType('aws_security_group')).toBe('security-groups');
    expect(serviceForType('aws_vpc_security_group_ingress_rule')).toBe('security-groups');
    expect(serviceForType('aws_route_table')).toBe('routing');
    expect(serviceForType('aws_route')).toBe('routing');
    expect(serviceForType('aws_route53_record')).toBe('route53');
  });

  it('falls back to the first token for everything unlisted', () => {
    expect(serviceForType('aws_sqs_queue')).toBe('sqs');
    expect(serviceForType('aws_glue_job')).toBe('glue');
  });
});

describe('typeLabel — the plain per-type label', () => {
  it('strips the matched service prefix', () => {
    expect(typeLabel('aws_sqs_queue')).toBe('Queue');
    expect(typeLabel('aws_dynamodb_table')).toBe('Table');
    expect(typeLabel('aws_db_instance')).toBe('Instance');
  });

  it('a type that IS the prefix keeps its last word', () => {
    expect(typeLabel('aws_instance')).toBe('Instance');
    expect(typeLabel('aws_vpc')).toBe('Vpc');
  });
});

describe('serviceDisplayMeta', () => {
  it('curated slugs carry a name and a plain category', () => {
    expect(serviceDisplayMeta('sqs')).toEqual({ name: 'SQS', category: 'Integration & Messaging' });
  });
  it('unknown slugs fall back to a title-cased name in Everything else', () => {
    expect(serviceDisplayMeta('somenewthing')).toEqual({
      name: 'Somenewthing',
      category: 'Everything else',
    });
  });
});

describe('compactType — cty → form vocabulary', () => {
  it('scalars map straight through', () => {
    expect(compactType('string')).toEqual({ t: 'string' });
    expect(compactType('number')).toEqual({ t: 'number' });
    expect(compactType('bool')).toEqual({ t: 'bool' });
  });
  it('string collections stay simple; object-bearing types become json', () => {
    expect(compactType(['list', 'string'])).toEqual({ t: 'list' });
    expect(compactType(['set', 'number'])).toEqual({ t: 'list', et: 'number' });
    expect(compactType(['map', 'string'])).toEqual({ t: 'map' });
    expect(compactType(['set', ['object', { a: 'string' }]] as never)).toEqual({ t: 'json' });
  });
});

/** A fixture resource exercising every compaction rule at once. */
const FIXTURE: RawResourceSchema = {
  block: {
    attributes: {
      id: { type: 'string', optional: true, computed: true },
      arn: { type: 'string', computed: true },
      name: { type: 'string', required: true },
      description: { type: 'string', optional: true },
      old_thing: { type: 'string', optional: true, deprecated: true },
      password: { type: 'string', optional: true, sensitive: true },
      port: { type: 'number', optional: true, computed: true },
      tags: { type: ['map', 'string'], optional: true },
    },
    block_types: {
      timeouts: { nesting_mode: 'single', block: { attributes: { create: { type: 'string', optional: true } } } },
      settings: {
        nesting_mode: 'list',
        max_items: 1,
        block: {
          attributes: {
            enabled: { type: 'bool', optional: true },
            inner_id: { type: 'string', optional: true, computed: false },
          },
          block_types: {
            deep: {
              nesting_mode: 'list',
              block: {
                attributes: { level: { type: 'number', optional: true } },
                block_types: {
                  deeper: {
                    nesting_mode: 'list',
                    block: {
                      attributes: { bottom: { type: 'string', optional: true } },
                      block_types: {
                        beyond: { nesting_mode: 'list', block: { attributes: { x: { type: 'string', optional: true } } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      rule: {
        nesting_mode: 'set',
        min_items: 1,
        block: { attributes: { action: { type: 'string', required: true } } },
      },
    },
  },
};

describe('compactResource — what ships and what is dropped', () => {
  const res = compactResource(FIXTURE);

  it('drops computed-only attributes, deprecated attributes, and top-level id', () => {
    const names = res.attrs.map((a) => a.n);
    expect(names).not.toContain('arn'); // computed-only output
    expect(names).not.toContain('id'); // resource identifier
    expect(names).not.toContain('old_thing'); // deprecated
    expect(names).toContain('port'); // optional+computed IS fillable
  });

  it('orders required attributes first, then alphabetically', () => {
    expect(res.attrs[0]).toMatchObject({ n: 'name', r: 1 });
  });

  it('carries the sensitive flag', () => {
    expect(res.attrs.find((a) => a.n === 'password')).toMatchObject({ s: 1 });
  });

  it('drops the timeouts block, keeps real blocks, marks max_items:1 as single', () => {
    const names = res.blocks.map((b) => b.n);
    expect(names).not.toContain('timeouts');
    expect(res.blocks.find((b) => b.n === 'settings')).toMatchObject({ m: 'single' });
    expect(res.blocks.find((b) => b.n === 'rule')).toMatchObject({ m: 'set', min: 1 });
  });

  it(`collapses blocks past depth ${MAX_BLOCK_DEPTH} into a JSON entry`, () => {
    const settings = res.blocks.find((b) => b.n === 'settings');
    const deep = settings?.blocks.find((b) => b.n === 'deep');
    const deeper = deep?.blocks.find((b) => b.n === 'deeper');
    expect(deeper?.json).toBe(1);
    expect(deeper?.attrs).toEqual([]);
  });

  it('counts leaves with collapsed subtrees as one field each', () => {
    const { req, opt } = countLeaves(res);
    expect(req).toBeGreaterThanOrEqual(2); // name + required rule block
    expect(opt).toBeGreaterThan(0);
  });
});

describe('buildCatalog — the whole-catalog assembly', () => {
  const raw: RawProviderSchemas = {
    provider_schemas: {
      'registry.terraform.io/hashicorp/aws': {
        resource_schemas: {
          aws_sqs_queue: FIXTURE,
          aws_sqs_queue_policy: FIXTURE,
          aws_instance: FIXTURE,
        },
      },
    },
  };
  const { index, chunks } = buildCatalog(raw);

  it('groups types into services with one chunk per service', () => {
    expect(index.services.map((s) => s.slug).sort()).toEqual(['ec2', 'sqs']);
    expect([...chunks.keys()].sort()).toEqual(['ec2', 'sqs']);
    expect(Object.keys(chunks.get('sqs')!.types).sort()).toEqual([
      'aws_sqs_queue',
      'aws_sqs_queue_policy',
    ]);
  });

  it('marks the primary type and sorts it first', () => {
    const sqs = index.services.find((s) => s.slug === 'sqs')!;
    expect(sqs.types[0]).toMatchObject({ t: 'aws_sqs_queue', primary: 1 });
  });

  it('primaryTypeFor prefers the curated front door, else the shortest name', () => {
    expect(primaryTypeFor('sqs', ['aws_sqs_queue_policy', 'aws_sqs_queue'])).toBe('aws_sqs_queue');
    expect(primaryTypeFor('zzz', ['aws_zzz_bbb', 'aws_zzz_a'])).toBe('aws_zzz_a');
  });
});
