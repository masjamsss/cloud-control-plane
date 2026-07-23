import { describe, expect, it } from 'vitest';
import {
  extractOpAttrs,
  resolveAttrPath,
  collectSuffixMatches,
  type DumpResource,
  type OpLike,
} from '../../scripts/lib/forcenewShared';
import {
  evaluateOps,
  evaluateOpsByProvider,
  evaluateMapPresence,
} from '../../scripts/verify-manifest-safety';

// ── extraction: which attribute path(s) an op writes ────────────────────────

const op = (o: Partial<OpLike> & { target?: OpLike['target'] }): OpLike => ({
  codemodOp: 'set_attribute',
  target: { resourceType: 'aws_x' },
  ...o,
});

const paths = (o: OpLike): string[] => {
  const ex = extractOpAttrs(o);
  return ex.kind === 'attrs' ? ex.attrs.map((a) => a.path) : [];
};

describe('extractOpAttrs — out-of-scope classes', () => {
  it('classifies "~ engineer-authored" ops (free-form escalations, no codemod attr)', () => {
    const ex = extractOpAttrs(
      op({
        terraformCapability: '~ engineer-authored',
        params: [{ name: 'purpose', source: 'user_input' }],
      }),
    );
    expect(ex.kind).toBe('engineer_authored');
  });
  it('classifies "+ create" ops (a new resource cannot replace an existing one)', () => {
    const ex = extractOpAttrs(
      op({ terraformCapability: '+ create (aws_lb_listener_certificate)' }),
    );
    expect(ex.kind).toBe('additive_create');
  });
});

describe('extractOpAttrs — capability parenthetical (tier 1)', () => {
  it('reads a single attr path from "~ update (attr.path)"', () => {
    expect(paths(op({ terraformCapability: '~ update (policy_details.copy_tags)' }))).toEqual([
      'policy_details.copy_tags',
    ]);
  });
  it('reads MULTIPLE comma-separated attrs (dynamodb-configure-streams shape)', () => {
    expect(
      paths(op({ terraformCapability: '~ update (stream_enabled, stream_view_type)' })),
    ).toEqual(['stream_enabled', 'stream_view_type']);
  });
  it('accepts a dotted first token with a trailing annotation (efs "→ ENABLED" shape)', () => {
    expect(paths(op({ terraformCapability: '~ update (backup_policy.status → ENABLED)' }))).toEqual(
      ['backup_policy.status'],
    );
  });
  it('accepts a bare word only when it IS the whole segment', () => {
    expect(paths(op({ terraformCapability: '~ update (instance)' }))).toEqual(['instance']);
  });
  it('rejects prose: "(in place)" must NOT yield the attr "in"', () => {
    // acm-swap-default-certificate: prose parenthetical, then the structural
    // tier takes over — new_certificate is a written inventory reference.
    const o = op({
      terraformCapability: '~ update (in place)',
      target: { resourceType: 'aws_lb_listener' },
      params: [
        {
          name: 'listener',
          source: 'inventory',
          enumSource: 'inventory://aws_lb_listener/address',
        },
        {
          name: 'new_certificate',
          source: 'inventory',
          enumSource: 'inventory://aws_acm_certificate/address',
        },
      ],
    });
    expect(paths(o)).toEqual(['certificate']);
  });
  it('rejects prose "(rule priority, in-place)" — structural path wins (waf-move shape)', () => {
    const o = op({
      terraformCapability: '~ update (rule priority, in-place)',
      target: { resourceType: 'aws_wafv2_web_acl', path: ['rule'] },
      params: [
        {
          name: 'web_acl',
          source: 'inventory',
          enumSource: 'inventory://aws_wafv2_web_acl/address',
        },
        { name: 'rule_name', source: 'user_input', role: 'selector' },
        { name: 'new_priority', source: 'user_input' },
      ],
    });
    expect(paths(o)).toEqual(['rule.priority']);
  });
});

describe('extractOpAttrs — structural derivation (tier 2)', () => {
  it('joins target.path with the param attr override (efs-toggle shape)', () => {
    const o = op({
      terraformCapability: '~ update',
      target: { resourceType: 'aws_efs_backup_policy', path: ['backup_policy'] },
      params: [
        { name: 'file_system', source: 'inventory' },
        { name: 'new_backup_policy_status', source: 'allowlist', attr: 'status' },
      ],
    });
    expect(paths(o)).toEqual(['backup_policy.status']);
  });
  it('excludes selector params and strips new_ (dlm-set-retention-count shape)', () => {
    const o = op({
      terraformCapability: '~ update',
      target: {
        resourceType: 'aws_dlm_lifecycle_policy',
        path: ['policy_details', 'schedule', 'retain_rule'],
      },
      params: [
        { name: 'policy', source: 'inventory' },
        { name: 'schedule_name', source: 'user_input', role: 'selector' },
        { name: 'new_count', source: 'user_input' },
      ],
    });
    expect(paths(o)).toEqual(['policy_details.schedule.retain_rule.count']);
  });
  it('fans a {param:X} discriminator segment out over its CLOSED segments set', () => {
    const o = op({
      terraformCapability: '~ update',
      target: {
        resourceType: 'aws_sagemaker_domain',
        path: ['default_user_settings', '{param:app_type}'],
      },
      params: [
        { name: 'domain', source: 'inventory' },
        {
          name: 'app_type',
          source: 'allowlist',
          role: 'discriminator',
          segments: {
            JupyterServer: 'jupyter_server_app_settings',
            KernelGateway: 'kernel_gateway_app_settings',
          },
        },
        { name: 'lifecycle_config_arn', source: 'user_input', attr: 'lifecycle_config_arns' },
      ],
    });
    expect(paths(o)).toEqual([
      'default_user_settings.jupyter_server_app_settings.lifecycle_config_arns',
      'default_user_settings.kernel_gateway_app_settings.lifecycle_config_arns',
    ]);
  });
  it('is unextractable when a discriminator has no segments map (never guesses)', () => {
    const o = op({
      terraformCapability: '~ update',
      target: { resourceType: 'aws_x', path: ['{param:app_type}'] },
      params: [
        { name: 'x', source: 'inventory' },
        { name: 'app_type', source: 'allowlist', role: 'discriminator' },
        { name: 'new_v', source: 'user_input' },
      ],
    });
    expect(extractOpAttrs(o).kind).toBe('unextractable');
  });
  it('writes reference-role params (their value is an address; the attr is still written)', () => {
    const o = op({
      terraformCapability: '~ update',
      target: { resourceType: 'aws_cloudwatch_event_target' },
      params: [
        {
          name: 'target',
          source: 'inventory',
          enumSource: 'inventory://aws_cloudwatch_event_target/address',
        },
        {
          name: 'role_arn',
          source: 'inventory',
          enumSource: 'inventory://aws_iam_role/arn',
          role: 'reference',
          refAttr: 'arn',
        },
      ],
    });
    expect(paths(o)).toEqual(['role_arn']);
  });
  it('includes new_-prefixed inventory params but not bare inventory selectors (routing/s3 shapes)', () => {
    const routing = op({
      codemodOp: 'set_association_attribute',
      terraformCapability: '~ update',
      target: { resourceType: 'aws_route_table_association' },
      params: [
        {
          name: 'association',
          source: 'inventory',
          enumSource: 'inventory://aws_route_table_association/address',
        },
        {
          name: 'new_route_table_id',
          source: 'inventory',
          enumSource: 'inventory://aws_route_table/address',
        },
      ],
    });
    expect(paths(routing)).toEqual(['route_table_id']);
    const s3 = op({
      terraformCapability: '~ rule[*].transition.date',
      target: { resourceType: 'aws_s3_bucket_lifecycle_configuration' },
      params: [
        {
          name: 'lifecycle_config',
          source: 'inventory',
          enumSource: 'inventory://aws_s3_bucket_lifecycle_configuration/address',
        },
        { name: 'rule_id', source: 'inventory' }, // bare inventory selector — not written
        { name: 'transition_date', source: 'user_input' },
      ],
    });
    expect(paths(s3)).toEqual(['transition_date']);
  });
  it('mirrors the catalogctl renameTable exactly (size_gib → size)', () => {
    const o = op({
      terraformCapability: 'nope',
      target: { resourceType: 'aws_ebs_volume' },
      params: [
        { name: 'volume', source: 'inventory' },
        { name: 'new_size_gib', source: 'user_input' },
      ],
    });
    expect(paths(o)).toEqual(['size']);
  });
  it('emits multiple keys when multiple params are written (vpn-rotate shape)', () => {
    const o = op({
      terraformCapability: '~ update',
      target: { resourceType: 'aws_vpn_connection' },
      params: [
        {
          name: 'vpn_connection',
          source: 'inventory',
          enumSource: 'inventory://aws_vpn_connection/address',
        },
        { name: 'tunnel_number', source: 'allowlist' },
        { name: 'psk_secret_name', source: 'user_input' },
      ],
    });
    expect(paths(o)).toEqual(['tunnel_number', 'psk_secret_name']);
  });
  it('returns unextractable when nothing is written', () => {
    expect(extractOpAttrs(op({ params: [] })).kind).toBe('unextractable');
  });
});

// ── dump resolution ──────────────────────────────────────────────────────────

// Miniature reflected tree in the exact schemadump artifact shape. The
// private_dns_name_options block mirrors the REAL aws_instance defect class:
// ForceNew on the BLOCK, force_new:false on the leaves inside it.
const RES: DumpResource = {
  has_customize_diff: true,
  attributes: {
    instance_type: { force_new: false },
    availability_zone: { force_new: true },
    private_dns_name_options: {
      force_new: true,
      block: {
        attributes: {
          hostname_type: { force_new: false },
          enable_resource_name_dns_a_record: { force_new: false },
        },
      },
    },
    policy_details: {
      force_new: false,
      block: {
        attributes: {
          schedule: {
            force_new: false,
            block: {
              attributes: {
                cross_region_copy_rule: {
                  force_new: false,
                  block: { attributes: { cmk_arn: { force_new: false } } },
                },
              },
            },
          },
        },
      },
    },
    replicated_thing: {
      force_new: true,
      block: { attributes: { cmk_arn: { force_new: false } } },
    },
  },
};

describe('resolveAttrPath (exact walk, chain-OR verdict)', () => {
  it('resolves flat attributes', () => {
    expect(resolveAttrPath(RES, 'instance_type')).toEqual({
      forceNew: false,
      nodePath: 'instance_type',
    });
    expect(resolveAttrPath(RES, 'availability_zone')?.forceNew).toBe(true);
  });
  it('ORs force_new down the chain — a ForceNew PARENT block poisons innocent leaves', () => {
    // The exact defect the old leaf-scope text parser missed (ec2 private DNS ops).
    const r = resolveAttrPath(RES, 'private_dns_name_options.hostname_type');
    expect(r).toEqual({ forceNew: true, nodePath: 'private_dns_name_options.hostname_type' });
  });
  it('keeps genuinely in-place nested chains in place', () => {
    expect(
      resolveAttrPath(RES, 'policy_details.schedule.cross_region_copy_rule.cmk_arn')?.forceNew,
    ).toBe(false);
  });
  it('returns null for unknown paths (never guesses)', () => {
    expect(resolveAttrPath(RES, 'nonexistent')).toBeNull();
    expect(resolveAttrPath(RES, 'policy_details.nonexistent')).toBeNull();
  });
});

describe('collectSuffixMatches (flattened-key rescue)', () => {
  it('finds a flattened key at its full nested path', () => {
    const m = collectSuffixMatches(RES, 'cross_region_copy_rule.cmk_arn');
    expect(m).toEqual([
      { forceNew: false, nodePath: 'policy_details.schedule.cross_region_copy_rule.cmk_arn' },
    ]);
  });
  it('returns EVERY match with its chain verdict so consumers can OR (fail-closed)', () => {
    const m = collectSuffixMatches(RES, 'cmk_arn');
    expect(m.map((x) => x.nodePath)).toEqual([
      'policy_details.schedule.cross_region_copy_rule.cmk_arn',
      'replicated_thing.cmk_arn',
    ]);
    expect(m.map((x) => x.forceNew)).toEqual([false, true]); // replicated_thing is ForceNew
  });
  it('matches whole segments only — no substring false positives', () => {
    expect(collectSuffixMatches(RES, 'arn')).toEqual([]);
    expect(collectSuffixMatches(RES, 'schedule.cmk_arn')).toEqual([]);
  });
});

// ── gate logic ───────────────────────────────────────────────────────────────

describe('evaluateOps (gate logic)', () => {
  const baseOp = {
    id: 'x-set-attr',
    codemodOp: 'set_attribute',
    forcesReplace: false,
    exposure: 'l1_self_service',
    terraformCapability: '~ update (device_name)',
    target: { resourceType: 'aws_customer_gateway' },
    params: [],
  };

  it('FAILs a forcesReplace:false op whose attribute is force_new in the map', () => {
    const r = evaluateOps(
      [baseOp],
      { 'aws_customer_gateway.device_name': { verdict: 'force_new', file: 'f', tag: 'v6.53.0' } },
      {},
    );
    expect(r.fails).toHaveLength(1);
    expect(r.fails[0]).toContain('x-set-attr');
    expect(r.passes).toBe(0);
  });

  it('adjudication forceNew:true also FAILs; forceNew:false passes', () => {
    const fail = evaluateOps(
      [baseOp],
      {},
      {
        'aws_customer_gateway.device_name': {
          forceNew: true,
          verifiedBy: 't',
          date: 'd',
          evidence: 'e',
        },
      },
    );
    expect(fail.fails).toHaveLength(1);
    const pass = evaluateOps(
      [baseOp],
      {},
      {
        'aws_customer_gateway.device_name': {
          forceNew: false,
          verifiedBy: 't',
          date: 'd',
          evidence: 'e',
        },
      },
    );
    expect(pass.fails).toHaveLength(0);
    expect(pass.passes).toBe(1);
  });

  it('adjudications override the map', () => {
    const r = evaluateOps(
      [baseOp],
      { 'aws_customer_gateway.device_name': { verdict: 'force_new', file: 'f', tag: 'v6.53.0' } },
      {
        'aws_customer_gateway.device_name': {
          forceNew: false,
          verifiedBy: 't',
          date: 'd',
          evidence: 'e',
        },
      },
    );
    expect(r.fails).toHaveLength(0);
  });

  it('unknown attribute → WARN, not fail — and the op does not count as a pass', () => {
    const r = evaluateOps([baseOp], {}, {});
    expect(r.fails).toHaveLength(0);
    expect(r.warns).toHaveLength(1);
    expect(r.passes).toBe(0);
  });

  it('checks EVERY written attribute of a multi-attr op', () => {
    const multi = {
      ...baseOp,
      id: 'x-multi',
      terraformCapability: '~ update (stream_enabled, stream_view_type)',
      target: { resourceType: 'aws_dynamodb_table' },
    };
    const r = evaluateOps(
      [multi],
      {
        'aws_dynamodb_table.stream_enabled': { verdict: 'in_place', file: 'f', tag: 'v6.53.0' },
        'aws_dynamodb_table.stream_view_type': { verdict: 'force_new', file: 'f', tag: 'v6.53.0' },
      },
      {},
    );
    expect(r.fails).toHaveLength(1);
    expect(r.fails[0]).toContain('stream_view_type');
    expect(r.passes).toBe(0);
  });

  it('counts engineer-authored and create-class ops separately — never warned, never passed', () => {
    const r = evaluateOps(
      [
        {
          ...baseOp,
          id: 'x-eng',
          terraformCapability: '~ engineer-authored',
          params: [{ name: 'purpose', source: 'user_input' }],
        },
        { ...baseOp, id: 'x-create', terraformCapability: '+ create (aws_thing)' },
      ],
      {},
      {},
    );
    expect(r.engineerAuthored).toBe(1);
    expect(r.additiveCreate).toBe(1);
    expect(r.warns).toHaveLength(0);
    expect(r.fails).toHaveLength(0);
    expect(r.passes).toBe(0);
  });

  it('skips ops outside the v1 scope but counts them', () => {
    const r = evaluateOps(
      [
        { ...baseOp, codemodOp: 'append_block' },
        { ...baseOp, forcesReplace: true },
      ],
      {},
      {},
    );
    expect(r.fails).toHaveLength(0);
    expect(r.warns).toHaveLength(0);
    expect(r.skipped).toBe(2);
  });

  it('warns UNEXTRACTABLE when no attribute path can be derived', () => {
    const r = evaluateOps([{ ...baseOp, terraformCapability: '~ update', params: [] }], {}, {});
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]).toContain('UNEXTRACTABLE');
  });
});

// ── per-provider dispatch (0039 F2c) ─────────────────────────────────────────
// verify-manifest-safety.ts's map-loading section routes each op to ITS OWN
// provider's map/adjudications table, selected by target.resourceType's
// prefix (providerOfType) — never a union search across both. A provider
// whose file is absent on disk loads as {} (main()'s existsSync guard), so
// these fixtures model "azure map absent" as an empty azure table and "azure
// map resolves it" as a table carrying the one needed entry — exactly what
// main() hands to evaluateOpsByProvider either way.

describe('evaluateOpsByProvider — per-provider ForceNew dispatch (0039 F2c)', () => {
  const baseOp = {
    id: 'x-set-attr',
    codemodOp: 'set_attribute',
    forcesReplace: false,
    exposure: 'l1_self_service',
    terraformCapability: '~ update (device_name)',
    target: { resourceType: 'aws_customer_gateway' },
    params: [],
  };

  // azurerm_storage_account.tags / .name are the two F1c-verified attributes
  // (tags: force_new=false, name: force_new=true) — real, not synthetic, keys.
  const azureTagsOp = {
    id: 'az-set-tags',
    codemodOp: 'set_attribute',
    forcesReplace: false,
    exposure: 'l1_self_service',
    terraformCapability: '~ update (tags)',
    target: { resourceType: 'azurerm_storage_account' },
    params: [],
  };
  const azureNameOp = { ...azureTagsOp, id: 'az-set-name', terraformCapability: '~ update (name)' };

  it('an azurerm op does NOT pass when the azure map is absent (empty table) — fail-closed, not a silent guess', () => {
    const r = evaluateOpsByProvider(
      [azureTagsOp],
      { aws: {}, azure: {} }, // azure file absent on disk -> main() loads {}
      { aws: {}, azure: {} },
    );
    expect(r.passes).toBe(0);
    expect(r.fails).toHaveLength(0);
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]).toContain('azurerm_storage_account.tags');
  });

  it('PASSES once the azure map resolves the attribute in_place', () => {
    const r = evaluateOpsByProvider(
      [azureTagsOp],
      {
        aws: {},
        azure: {
          'azurerm_storage_account.tags': {
            verdict: 'in_place',
            file: 'tools/schemadump/azurerm-v4.81.0-schema.json',
            tag: 'v4.81.0',
          },
        },
      },
      { aws: {}, azure: {} },
    );
    expect(r.passes).toBe(1);
    expect(r.fails).toHaveLength(0);
    expect(r.warns).toHaveLength(0);
  });

  it('FAILs an azurerm op whose attribute is force_new in the azure map', () => {
    const r = evaluateOpsByProvider(
      [azureNameOp],
      {
        aws: {},
        azure: {
          'azurerm_storage_account.name': {
            verdict: 'force_new',
            file: 'tools/schemadump/azurerm-v4.81.0-schema.json',
            tag: 'v4.81.0',
          },
        },
      },
      { aws: {}, azure: {} },
    );
    expect(r.fails).toHaveLength(1);
    expect(r.fails[0]).toContain('azurerm_storage_account.name');
    expect(r.passes).toBe(0);
  });

  it('never resolves an azurerm op against the aws table, even if a same-keyed entry lives there', () => {
    // A misplaced entry (wrong provider's file) must not leak through — proof
    // that dispatch is a real per-op selection, not a merged/union lookup.
    const r = evaluateOpsByProvider(
      [azureTagsOp],
      {
        aws: {
          'azurerm_storage_account.tags': { verdict: 'in_place', file: 'wrong-table', tag: 'x' },
        },
        azure: {},
      },
      { aws: {}, azure: {} },
    );
    expect(r.passes).toBe(0);
    expect(r.warns).toHaveLength(1);
  });

  it('with zero azure ops, reduces to plain evaluateOps(ops, maps.aws, adjudications.aws) — AWS behavior is unchanged', () => {
    const awsMap = {
      'aws_customer_gateway.device_name': {
        verdict: 'force_new' as const,
        file: 'f',
        tag: 'v6.53.0',
      },
    };
    const byProvider = evaluateOpsByProvider(
      [baseOp],
      { aws: awsMap, azure: {} },
      { aws: {}, azure: {} },
    );
    const direct = evaluateOps([baseOp], awsMap, {});
    expect(byProvider).toEqual(direct);
  });
});

// ── map-presence hard-fail (Lane K — the F2-review hardening, plan §8) ──────
// A provider's map/adjudications FILE is allowed to be absent — that's the
// documented fail-closed default (see loadMap above), and it degenerates to
// the per-op WARN path when the provider genuinely has nothing to check.
// But "provider has in-scope ops AND its map file was never generated" is a
// distinct, worse state: the WARN-per-key path would bury it under a wall of
// unresolved-key WARNs indistinguishable from "map exists but this one key is
// missing". evaluateMapPresence is the single function that tells the two
// disk states apart (absent vs. present-but-empty `{}`) and hard-FAILs only
// the former — main() feeds it the same fileExisted flag loadMap now threads
// through (loadMap: existsSync ⇒ { table, fileExisted }).

describe('evaluateMapPresence — absent-file hard-fail (Lane K)', () => {
  const azureTagsOp = {
    id: 'az-set-tags',
    codemodOp: 'set_attribute',
    forcesReplace: false,
    exposure: 'l1_self_service',
    terraformCapability: '~ update (tags)',
    target: { resourceType: 'azurerm_storage_account' },
    params: [],
  };

  it('direction 1: absent file + in-scope ops present -> FAIL naming the provider, op count, and expected path', () => {
    const fails = evaluateMapPresence([azureTagsOp], {
      aws: { fileExisted: true, path: 'src/data/forcenew-map.json' },
      azure: { fileExisted: false, path: 'src/data/forcenew-map-azure.json' },
    });
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain('azure');
    expect(fails[0]).toContain('1');
    expect(fails[0]).toContain('src/data/forcenew-map-azure.json');
  });

  it('direction 2: present-but-empty file + in-scope ops -> no new FAIL (stays the existing per-key WARN path)', () => {
    const fails = evaluateMapPresence([azureTagsOp], {
      aws: { fileExisted: true, path: 'src/data/forcenew-map.json' },
      azure: { fileExisted: true, path: 'src/data/forcenew-map-azure.json' },
    });
    expect(fails).toHaveLength(0);
    // and the pre-existing WARN behavior for a present-but-empty map is
    // unaffected — evaluateOpsByProvider still warns per unresolved key
    // exactly as the "does NOT pass when the azure map is absent" test above
    // already proves for the {} table itself.
    const r = evaluateOpsByProvider([azureTagsOp], { aws: {}, azure: {} }, { aws: {}, azure: {} });
    expect(r.warns).toHaveLength(1);
    expect(r.fails).toHaveLength(0);
  });

  it('direction 3: absent file + zero ops for that provider -> green', () => {
    const fails = evaluateMapPresence([], {
      aws: { fileExisted: true, path: 'src/data/forcenew-map.json' },
      azure: { fileExisted: false, path: 'src/data/forcenew-map-azure.json' },
    });
    expect(fails).toHaveLength(0);
  });

  it('a provider with only out-of-scope ops (create / engineer-authored) does not trip the absent-file FAIL', () => {
    // Same op count as direction 1, but NOT in-scope (± forcesReplace/codemodOp)
    // — proves the trigger is in-scope ops specifically, not raw op presence.
    const createOp = {
      ...azureTagsOp,
      id: 'az-create',
      terraformCapability: '+ create (azurerm_storage_account)',
    };
    const engineerOp = {
      ...azureTagsOp,
      id: 'az-engineer',
      terraformCapability: '~ engineer-authored',
    };
    const outOfScopeReplace = { ...azureTagsOp, id: 'az-replace', forcesReplace: true };
    const fails = evaluateMapPresence([createOp, engineerOp, outOfScopeReplace], {
      aws: { fileExisted: true, path: 'src/data/forcenew-map.json' },
      azure: { fileExisted: false, path: 'src/data/forcenew-map-azure.json' },
    });
    expect(fails).toHaveLength(0);
  });

  it('a provider whose file EXISTS never FAILs regardless of in-scope op count (aws today: file present, unaffected)', () => {
    const awsOp = {
      id: 'aws-set-attr',
      codemodOp: 'set_attribute',
      forcesReplace: false,
      exposure: 'l1_self_service',
      terraformCapability: '~ update (device_name)',
      target: { resourceType: 'aws_customer_gateway' },
      params: [],
    };
    const fails = evaluateMapPresence([awsOp], {
      aws: { fileExisted: true, path: 'src/data/forcenew-map.json' },
      azure: { fileExisted: true, path: 'src/data/forcenew-map-azure.json' },
    });
    expect(fails).toHaveLength(0);
  });

  it('reports independently per provider — one absent, one present, both with in-scope ops', () => {
    const awsOp = {
      id: 'aws-set-attr',
      codemodOp: 'set_attribute',
      forcesReplace: false,
      exposure: 'l1_self_service',
      terraformCapability: '~ update (device_name)',
      target: { resourceType: 'aws_customer_gateway' },
      params: [],
    };
    const fails = evaluateMapPresence([awsOp, azureTagsOp], {
      aws: { fileExisted: true, path: 'src/data/forcenew-map.json' },
      azure: { fileExisted: false, path: 'src/data/forcenew-map-azure.json' },
    });
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain('azure');
  });
});
