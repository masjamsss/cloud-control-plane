/**
 * gen-aws-tag-catalog.mjs — the SAFE comprehensive AWS auto-wire, the AWS twin
 * of gen-azure-tag-catalog.mjs (owner directive: expand the AWS catalog to
 * console parity with the Azure side by auto-wiring TAG operations across the
 * taggable AWS surface).
 *
 * Emits a tag-management operation for EVERY taggable aws_* type the curated
 * first wave (the 30 existing services) did not already cover AND that is not
 * part of the control / security / identity surface. A `tags` map merge is the
 * ONLY operation that auto-generates safely across arbitrary types: it is
 * in_place, cost-neutral, reversible, bounded by the tag pattern. Non-tag
 * scalar ops are NOT auto-generated — their bounds and safe direction are human
 * judgment the schema cannot supply, so they stay curated.
 *
 * AWS tag semantics DIFFER from Azure and are reflected here:
 *   · CASE-SENSITIVE keys — there is NO tag-case-collision guard (the azurerm
 *     Lane-K guard is Azure-only; AWS keys `Env` and `env` are two real tags).
 *   · key <= 128 chars, value <= 256 chars; the shared client validator applies
 *     the param `pattern` to every key AND value, so `{1,128}` enforces the
 *     tighter (key) bound; the charset is AWS's `[\w\s.:/=+@-]` written out as
 *     `[A-Za-z0-9 _.:/=+@-]` (identical set), matching the existing curated AWS
 *     tag ops (s3-update-tags, licensemanager-update-tags, …) exactly.
 *
 * Safety is not this script's to assert — it is the fail-closed ForceNew gate's
 * (verify-manifest-safety.ts): this script only PROPOSES ops; the gate
 * regenerates the per-provider map and rejects any op that is not in_place. We
 * pre-filter to taggable + force_new:false + not-control-surface so the proposal
 * is clean, but the gate is the authority.
 *
 * Control-surface EXCLUDE (fail-closed, broad on purpose — a dropped type is
 * engineer-authored, never a hidden self-service gap): IAM, KMS keys, security
 * groups + rules, network ACLs, VPC endpoints/peering/gateways/routes/route
 * tables, WAF/Shield/GuardDuty/Config/CloudTrail/Inspector/Macie/Detective/
 * Security Hub, Organizations/SCP, Secrets Manager, ACM/PCA certs, Cognito,
 * SSO/Identity Center, Directory Service, RAM, and any *_policy / *_rule /
 * *_association / *_attachment / *_membership / *_permission control-plane type.
 * When unsure, EXCLUDE (a missed control type is a safety bug; an over-exclusion
 * is just a smaller catalog).
 *
 * Run: node scripts/gen-aws-tag-catalog.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { familyOf, FAMILY_LABEL } from './lib/awsServices.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(APP, '../..');
const MANIFESTS = join(APP, 'src/data/manifests');
const DUMP = join(REPO, 'tools/schemadump/aws-v6.53.0-schema.json');

// The full aws dump is 93MB; the repo commits it gzipped (2MB). Read the raw
// .json if present (local regen), else gunzip the committed .gz (fresh clone/CI).
const dumpRaw = existsSync(DUMP)
  ? readFileSync(DUMP, 'utf8')
  : gunzipSync(readFileSync(`${DUMP}.gz`)).toString('utf8');
const dump = JSON.parse(dumpRaw).resources;

// The control / reachability / security / identity surface. Matched against the
// raw aws_* type name. Anchored where a bare token would over-match a legit app
// service (e.g. `^aws_config_` so AppConfig / *_configuration app resources
// survive; explicit network-gateway names so API Gateway survives; `route_table`
// / `^aws_route$` / `_route$` but never route53). Fail-closed: broad.
const EXCLUDE = new RegExp(
  [
    // ── Identity & access management ──
    '^aws_iam_', '_iam_', '^aws_iam$',
    'cognito', '^aws_ssoadmin', 'identitystore', 'identity_store',
    '^aws_ds_', 'directory_service', 'organizations', '^aws_ram_', '_resource_share',
    'verifiedaccess', 'verified_access', 'verifiedpermissions', 'verified_permissions',
    'rolesanywhere',
    // ── Secrets, keys & certificates ──
    'kms', 'secretsmanager', '_secret$', '_secret_', 'secret_',
    '^aws_acm', 'acmpca', 'certificate', 'cloudhsm', 'paymentcryptography', 'signer',
    // ── Threat detection / posture / audit ──
    '^aws_waf', 'wafv2', 'wafregional', '^aws_shield', '^aws_guardduty', '^aws_securityhub',
    '^aws_inspector', '^aws_macie', '^aws_detective', 'accessanalyzer', 'access_analyzer',
    'securitylake', 'security_lake', '^aws_fms', '^aws_config_', 'conformance_pack',
    'configuration_recorder', 'configuration_aggregator', 'cloudtrail', 'audit_manager',
    'auditmanager',
    // ── Network reachability / control plane ──
    'security_group', 'network_acl', 'route_table', '^aws_route$', '_route$',
    'internet_gateway', 'nat_gateway', 'vpn_gateway', 'customer_gateway', 'local_gateway',
    'transit_gateway', 'egress_only', 'carrier_gateway', 'dx_gateway',
    'vpc_endpoint', 'vpc_peering', 'vpc_dhcp', 'vpc_ipam', 'vpc_network_performance',
    'vpn', '^aws_dx_', 'direct_connect', 'network_interface', 'flow_log',
    'network_insights', 'traffic_mirror', 'networkmanager', 'network_manager',
    'core_network', 'global_network', 'networkfirewall', 'network_firewall',
    'prefix_list', '_peering', 'default_network_acl', 'default_route_table',
    'default_security_group',
    // ── Account / governance control plane ──
    '^aws_account_', 'controltower', 'control_tower',
    // ── Generic control-plane suffixes (task rule: exclude any of these) ──
    '_policy$', '_policy_', '_rule$', '_rule_', '_association$', '_association_',
    '_attachment$', '_attachment_', '_membership$', '_membership_',
    '_permission$', '_permissions$', '_permission_', '_permissions_',
    '_grant', '_assignment', '_authorization', '_lock', '_acl$', '_baseline',
    '_delegated_administrator',
  ].join('|'),
);

// types already covered by a curated service — never double-wire. "Covered"
// means claimed by an existing manifest: either targeted by an op OR listed in
// its resourceTypes (some curated services list a type they scope but have no
// op for yet, e.g. sagemaker → aws_sagemaker_pipeline; that type is still theirs
// to own, not ours to auto-tag). Reading both fields keeps this lane strictly
// ADDITIVE to the curated catalog.
const curatedTypes = new Set();
for (const f of readdirSync(MANIFESTS).filter((f) => f.endsWith('.json'))) {
  const m = JSON.parse(readFileSync(join(MANIFESTS, f), 'utf8'));
  for (const t of m.resourceTypes ?? []) curatedTypes.add(t);
  for (const op of m.operations ?? []) curatedTypes.add(op.target.resourceType);
}

function humanize(type) {
  return type
    .replace(/^aws_/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function tagOp(type, service) {
  // Prose uses the RAW underscore-joined type only in the parenthetical (no word
  // boundary around any fragment, so it can never trip the estate-branding
  // whole-word gate); the humanized name carries the readability. No `keywords`:
  // space-separated titles/keywords would let these tail ops outrank curated ops
  // in the command palette for shared phrases — the raw form + absent keywords
  // keep them minimally searchable (the long tail, not headline ops).
  const short = type.replace(/^aws_/, '');
  const friendly = humanize(type);
  return {
    id: `aws-tag-${short.replace(/_/g, '-')}`,
    service,
    macd: 'Change',
    codemodOp: 'set_attribute',
    title: `Update ${friendly} tags`,
    summary:
      'Set or update tags on this resource. Only the tags you list change; others are left untouched. No effect on its data, endpoints, or access.',
    consoleLabel: 'Tags',
    description: `Sets or merges cost-allocation and ownership tags on this ${friendly} (${type}). In-place, takes effect immediately, and has no effect on the resource's data, configuration, endpoints, or access. Auto-generated tag operation (the comprehensive AWS tag surface). AWS tag keys are case-sensitive.`,
    target: { resourceType: type, block: 'tags' },
    params: [
      {
        name: 'target',
        label: friendly,
        type: 'string',
        source: 'inventory',
        required: true,
        enumSource: `inventory://${type}/address`,
        help: `The ${friendly} to tag.`,
      },
      {
        name: 'tags',
        label: 'Tags',
        type: 'map',
        source: 'user_input',
        required: true,
        default: {},
        bounds: { pattern: '^[A-Za-z0-9 _.:/=+@-]{1,128}$', semantic: 'aws_tag_map' },
        help: 'Key/value tags to set; existing keys not listed here are left untouched.',
      },
    ],
    riskFloor: 'LOW',
    reversible: true,
    downtime: 'none',
    exposure: 'l1_self_service',
    forcesReplace: false,
    autoEligible: false,
    terraformCapability: '~ update',
    group: 'tags-naming',
  };
}

// collect taggable, non-control, non-curated types → group by family manifest
const byFamily = {}; // family -> [type]
const newTypes = [];
const excludedSample = [];
for (const [type, spec] of Object.entries(dump)) {
  const tags = spec.attributes?.tags;
  if (!tags || tags.force_new || tags.type !== 'map') continue; // not taggable / ForceNew
  if (curatedTypes.has(type)) continue; // already curated
  if (EXCLUDE.test(type)) {
    excludedSample.push(type);
    continue; // control / security / identity surface — engineer-authored
  }
  const fam = familyOf(type);
  (byFamily[fam] ||= []).push(type);
  newTypes.push(type);
}

// write one aws-<family>.json manifest per family that gained types
let opCount = 0;
const familiesWritten = [];
for (const [family, types] of Object.entries(byFamily)) {
  types.sort();
  const slug = `aws-${family}`;
  const ops = types.map((t) => tagOp(t, slug));
  opCount += ops.length;
  const label = FAMILY_LABEL[family] ?? family;
  const manifest = {
    service: slug,
    scope: 'expansion',
    resourceTypes: types,
    summary: `Tag management across ${label} AWS resources (auto-generated comprehensive tag surface — ${types.length} resource types).`,
    operations: ops,
  };
  writeFileSync(join(MANIFESTS, `${slug}.json`), JSON.stringify(manifest, null, 2) + '\n');
  familiesWritten.push([slug, types.length]);
}

// registration deltas (new inventory:// enum types, new service slugs) for the
// controller's central serviceMeta / inventoryEnums / teams wiring.
const registrations = {
  newTypes: [...new Set(newTypes)].sort(),
  newServices: familiesWritten.map(([slug, n]) => ({ slug, resourceTypes: n })),
  opCount,
  excludedCount: excludedSample.length,
  excludedSample: excludedSample.sort(),
};
const out = process.argv[2] || join(REPO, '.superpowers/sdd/aws-tag-registrations.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(registrations, null, 2) + '\n');

console.log(`auto-wire: ${opCount} tag ops across ${familiesWritten.length} family manifests`);
console.log(`  new types: ${registrations.newTypes.length}, excluded control-surface (taggable): ${excludedSample.length}`);
console.log(`  registrations → ${out}`);
for (const [slug, n] of familiesWritten.sort()) console.log(`  ${slug}: +${n}`);
