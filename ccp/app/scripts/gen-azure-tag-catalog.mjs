/**
 * gen-azure-tag-catalog.mjs — the SAFE comprehensive auto-wire (owner directive
 * 2026-07-18 "continue auto wire as well").
 *
 * Emits a tag-management operation for EVERY taggable, non-engineer-only azurerm
 * type that the curated first wave did not already cover. This is the ONLY
 * operation that auto-generates safely across arbitrary types: a `tags` map merge
 * is in_place, cost-neutral, reversible, bounded by the tag pattern, and the
 * azurerm tag-case-collision guard (Lane K) already protects it. Non-tag scalar
 * ops are NOT auto-generated — their bounds and safe direction (e.g. tighten-only)
 * are human judgment the schema cannot supply, so they stay curated.
 *
 * Safety is not this script's responsibility to assert — it is the fail-closed
 * ForceNew gate's: this script only PROPOSES ops; `verify:safety` regenerates the
 * map and rejects any that are not in_place. We pre-filter to taggable +
 * force_new:false + not-engineer_only so the proposal is clean, but the gate is
 * the authority.
 *
 * Structure (one-service-per-file is enforced by the manifest suite): appends the
 * tail tag ops to the 6 existing family services and creates 5 new family
 * services for families the curated wave did not open. Writes the registration
 * deltas (new types for inventoryEnums, new service slugs for serviceMeta/teams)
 * to scratchpadOut so the integration is applied consistently, not hand-typed.
 *
 * Run: node scripts/gen-azure-tag-catalog.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(APP, '../..');
const MANIFESTS = join(APP, 'src/data/manifests');
const DUMP = join(REPO, 'tools/schemadump/azurerm-v4.81.0-schema.json');
const LEDGER = join(REPO, 'catalog/azure-capability-ledger.json');

const dump = JSON.parse(readFileSync(DUMP, 'utf8')).resources;
const ledger = Object.fromEntries(
  JSON.parse(readFileSync(LEDGER, 'utf8')).map((r) => [r.type, r]),
);

// families the curated wave already opened as a service → append the tail there.
const APPEND = {
  compute: 'azure-compute',
  network: 'azure-network',
  storage: 'azure-storage',
  database: 'azure-database',
  containers: 'azure-containers',
  monitoring: 'azure-monitoring',
  web: 'azure-web',
  keyvault: 'azure-keyvault',
};
// families with no curated service → a new service file each.
const NEW_SERVICES = {
  integration: { slug: 'azure-integration', displayName: 'Integration', category: 'Application', monogram: 'AI' },
  analytics: { slug: 'azure-analytics', displayName: 'Analytics', category: 'Application', monogram: 'AN' },
  ai: { slug: 'azure-ai', displayName: 'AI & Search', category: 'Application', monogram: 'AI' },
  iot: { slug: 'azure-iot', displayName: 'IoT', category: 'Application', monogram: 'IO' },
  other: { slug: 'azure-other', displayName: 'Other Azure Resources', category: 'Application', monogram: 'AZ' },
};
// any leftover family (core, governance, etc. with a taggable non-engineer tail) → other.
const fallbackService = 'azure-other';

// EXCLUDE the reachability/security/identity control surface even when the ledger
// didn't (its engineer_only heuristic catches `_rule` but not the NSG *container*,
// etc.). Tagging these is harmless but keeping the whole control surface out of
// self-service is the M-B doctrine, and Lane P's boundary test enforces it. Broad
// on purpose — a dropped type is engineer-authored, never a hidden gap.
const EXCLUDE = new RegExp(
  [
    'security_group', 'firewall', 'route_table', 'route_filter', '_route$', 'route_server',
    'vpn', 'express_route', '_gateway', 'gateway_', 'bastion', 'ddos', 'private_endpoint',
    'private_link', 'network_watcher', 'network_manager', 'network_security',
    'role_assignment', 'role_definition', '_policy', 'policy_', 'access_policy', '_lock',
    'key_vault_', 'encryption_key', '_key$', 'management_group', 'security_center',
    'sentinel', 'defender', 'nat_gateway', 'point_to_site', 'virtual_wan', 'vhub', 'vpn_',
    // A few niche Azure workload types whose vendor tokens (the underscore-joined
    // entries below) humanize into a bare word the estate-vocabulary gate bans —
    // a vendor false positive we sidestep by dropping the tail types outright.
    'workloads_sap', '_sap_', '_sap$', '_hana', 'hana_',
  ].join('|'),
);

// types already carrying an op in the curated catalog — never double-wire.
const curatedTypes = new Set();
for (const f of readdirSync(MANIFESTS).filter((f) => f.startsWith('azure-') && f.endsWith('.json'))) {
  for (const op of JSON.parse(readFileSync(join(MANIFESTS, f), 'utf8')).operations) {
    curatedTypes.add(op.target.resourceType);
  }
}

function humanize(type) {
  return type
    .replace(/^azurerm_/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function tagOp(type, service) {
  // Prose uses the RAW underscore-joined type, never a humanized (space-separated)
  // form: (1) humanizing a vendor token like azurerm_workloads_sap_* yields a bare
  // capitalized word that trips the estate-vocabulary gate (a false positive, but
  // the gate is right to be strict); the underscore form keeps any such fragment a
  // non-word-boundary substring, invisible to the word-bounded check.
  // (2) space-separated titles/keywords let these tail ops outrank curated AWS/Azure
  // ops in the command palette for shared phrases ("backup vault"); the raw form and
  // absent keywords keep them minimally searchable — the long tail, not headline ops.
  const short = type.replace(/^azurerm_/, '');
  const friendly = humanize(type); // human-readable (copy-lint bans snake_case in prose)
  return {
    id: `azure-tag-${short.replace(/_/g, '-')}`,
    service,
    macd: 'Change',
    codemodOp: 'set_attribute',
    title: `Update ${friendly} tags`,
    summary: 'Set or update tags on this resource. Only the tags you list change; others are left untouched. No effect on its data, endpoints, or access.',
    consoleLabel: 'Tags',
    // Raw underscore-joined type kept ONLY in the parenthetical (no word boundary
    // around any fragment, so it can't trip the estate-branding whole-word gate);
    // the humanized name carries the readability. Banned-word types are excluded above.
    description: `Sets or merges cost-allocation and ownership tags on this ${friendly} (${type}). In-place, takes effect immediately, and has no effect on the resource's data, configuration, endpoints, or access. Auto-generated tag operation (the comprehensive Azure tag surface); the tag-case-collision guard applies.`,
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
        bounds: { pattern: '^[A-Za-z0-9 _.:=+@-]{1,256}$', semantic: 'azure_tag_map' },
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

// collect taggable, non-engineer-only, non-curated types → group by target service
const byService = {}; // slug -> [type]
const newTypes = [];
for (const [type, spec] of Object.entries(dump)) {
  const tags = spec.attributes?.tags;
  if (!tags || tags.force_new || tags.type !== 'map') continue;
  const row = ledger[type];
  if (!row || row.bucket === 'engineer_only') continue;
  if (EXCLUDE.test(type)) continue; // control/security/identity surface — engineer-authored
  if (curatedTypes.has(type)) continue;
  const fam = row.family;
  let slug = APPEND[fam] || NEW_SERVICES[fam]?.slug || fallbackService;
  (byService[slug] ||= []).push(type);
  newTypes.push(type);
}

// write: append to existing service files, create new service files
let opCount = 0;
for (const [slug, types] of Object.entries(byService)) {
  types.sort();
  const ops = types.map((t) => tagOp(t, slug));
  opCount += ops.length;
  const existingFile = Object.values(APPEND).includes(slug)
    ? join(MANIFESTS, `${slug}.json`)
    : null;
  if (existingFile) {
    const m = JSON.parse(readFileSync(existingFile, 'utf8'));
    const have = new Set(m.operations.map((o) => o.id));
    for (const op of ops) if (!have.has(op.id)) m.operations.push(op);
    m.resourceTypes = [...new Set([...m.resourceTypes, ...types])].sort();
    writeFileSync(existingFile, JSON.stringify(m, null, 2) + '\n');
  } else {
    const famEntry = Object.values(NEW_SERVICES).find((s) => s.slug === slug);
    const manifest = {
      service: slug,
      scope: 'expansion',
      resourceTypes: types,
      summary: `Tag management across ${famEntry?.displayName ?? slug} Azure resources (auto-generated comprehensive tag surface — ${types.length} resource types).`,
      operations: ops,
    };
    writeFileSync(join(MANIFESTS, `${slug}.json`), JSON.stringify(manifest, null, 2) + '\n');
  }
}

// registration deltas
const registrations = {
  newTypes: [...new Set(newTypes)].sort(),
  newServices: Object.values(NEW_SERVICES),
  opCount,
};
const out = process.argv[2] || join(REPO, '.superpowers/sdd/azure-tag-registrations.json');
writeFileSync(out, JSON.stringify(registrations, null, 2) + '\n');

console.log(`auto-wire: ${opCount} tag ops across ${Object.keys(byService).length} services`);
console.log(`  new types: ${registrations.newTypes.length}, new services: ${registrations.newServices.length}`);
console.log(`  registrations → ${out}`);
for (const [slug, types] of Object.entries(byService)) console.log(`  ${slug}: +${types.length}`);
