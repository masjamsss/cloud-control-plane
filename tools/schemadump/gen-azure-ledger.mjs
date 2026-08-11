#!/usr/bin/env node
//
// gen-azure-ledger.mjs — derive catalog/azure-capability-ledger.json (+ its summary)
// from the committed azurerm schemadump.
//
// Two modes:
//   node gen-azure-ledger.mjs            regenerate and write
//   node gen-azure-ledger.mjs --check    regenerate IN MEMORY and compare against the
//                                        committed files; exit 1 on any difference
//
// IMP-8 — --check is what makes staleness MECHANICAL. Before it, nothing anywhere
// compared these committed artifacts to the dump they claim to be derived from: a stale
// ledger, a hand-edit, or a regeneration from a different dump were all undetectable
// except by a human remembering to look. IMP-4 is the proof that mattered — a dead
// lookup shipped 662 wrongly-classified rows, valid JSON, consumed downstream, for as
// long as it took an audit to notice.
//
// The output must therefore be a pure function of the dump. It was not: the summary
// stamped `new Date()` into every regeneration, so a regenerate-and-diff check could
// never have been green two seconds running. That timestamp is now replaced by the
// dump's OWN provenance (tag + commit sha + its generated_at), which is both
// deterministic and strictly better provenance — it names the input rather than the run.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, 'azurerm-v4.81.0-schema.json');
// Env seams so the selftest can drive the REAL --check against deliberately
// staled copies instead of a re-implementation of it (the same reason
// findings-gate-selftest.sh takes FINDINGS_GATE). Unset in every real run.
const ledgerPath =
  process.env.CCP_AZURE_LEDGER || path.join(__dirname, '../../catalog/azure-capability-ledger.json');
const summaryPath =
  process.env.CCP_AZURE_LEDGER_SUMMARY ||
  path.join(__dirname, '../../catalog/azure-capability-ledger-summary.md');

const CHECK_ONLY = process.argv.includes('--check');

// Ensure output directory exists
const catalogDir = path.dirname(ledgerPath);
if (!CHECK_ONLY && !fs.existsSync(catalogDir)) {
  fs.mkdirSync(catalogDir, { recursive: true });
}

// Family mapping: second token (azurerm_<X>_...) to curated family
const familyMap = {
  // Compute
  virtual_machine: 'compute',
  managed_disk: 'compute',
  vm: 'compute',
  availability: 'compute',
  dedicated_host: 'compute',
  image: 'compute',
  gallery: 'compute',
  shared_image: 'compute',

  // Network
  network: 'network',
  virtual_network: 'network',
  subnet: 'network',
  public_ip: 'network',
  nat: 'network',
  route: 'network',
  vpn: 'network',
  express_route: 'network',
  private_dns: 'network',
  dns: 'network',
  lb: 'network',
  application_gateway: 'network',
  nic: 'network',

  // Storage
  storage: 'storage',
  netapp: 'storage',
  data_lake: 'storage',

  // Database
  mssql: 'database',
  mysql: 'database',
  postgresql: 'database',
  cosmosdb: 'database',
  mariadb: 'database',
  redis: 'database',
  sql: 'database',

  // Key Vault
  key_vault: 'keyvault',

  // Containers
  kubernetes: 'containers',
  container: 'containers',
  aks: 'containers',

  // Web
  app_service: 'web',
  linux_web: 'web',
  windows_web: 'web',
  function_app: 'web',
  service_plan: 'web',
  static_site: 'web',

  // Monitoring
  monitor: 'monitoring',
  log_analytics: 'monitoring',
  application_insights: 'monitoring',
  log: 'monitoring',

  // Identity
  role: 'identity',
  user_assigned: 'identity',
  federated: 'identity',
  managed_identity: 'identity',

  // Security
  security: 'security',
  sentinel: 'security',
  firewall: 'security',
  ddos: 'security',
  bastion: 'security',
  waf: 'security',
  defender: 'security',

  // Integration
  logic: 'integration',
  servicebus: 'integration',
  eventhub: 'integration',
  eventgrid: 'integration',
  api_management: 'integration',
  relay: 'integration',

  // Analytics
  synapse: 'analytics',
  stream_analytics: 'analytics',
  databricks: 'analytics',
  data_factory: 'analytics',
  hdinsight: 'analytics',
  kusto: 'analytics',

  // AI
  cognitive: 'ai',
  machine_learning: 'ai',
  search: 'ai',
  bot: 'ai',

  // IoT
  iothub: 'iot',
  iot: 'iot',
  digital_twins: 'iot',

  // Governance
  policy: 'governance',
  management_group: 'governance',
  resource_group: 'governance',
  consumption: 'governance',
  cost: 'governance',
  blueprint: 'governance',
  lock: 'governance',
};

// familyMap keys sorted LONGEST-FIRST, so `virtual_machine` is tried before `virtual`
// and `application_gateway` before `application`. Computed once, not per call.
const familyKeysByLength = Object.keys(familyMap).sort((a, b) => b.length - a.length);

/**
 * Classify a resource type into a family (IMP-4).
 *
 * This used to read the SECOND UNDERSCORE TOKEN only — `resourceType.split('_')[1]` —
 * while familyMap is keyed by multi-token names: virtual_machine, key_vault,
 * managed_disk, resource_group, user_assigned, app_service, application_gateway,
 * log_analytics, express_route, private_dns, data_factory, machine_learning,
 * management_group and more. A second token can never contain an underscore, so every
 * one of those keys was DEAD CODE and its types fell through to 'other'.
 *
 * That silently corrupted committed data: 662 of 1141 types landed in 'other', including
 * azurerm_key_vault, azurerm_linux_virtual_machine, azurerm_resource_group and
 * azurerm_managed_disk. Two gates downstream read the family, so both were wrong —
 * `resize` requires family 'compute' and was emitted ZERO times across 1141 types, and
 * the engineer_only family gate never fired for the identity/governance types the map was
 * written to catch, so azurerm_user_assigned_identity and azurerm_resource_group shipped
 * as catalog_candidate.
 *
 * Matching is on a contiguous TOKEN SUBSEQUENCE, longest key first — not a prefix.
 * Prefix matching alone still misses the qualifier-prefixed types the finding names:
 * `azurerm_linux_virtual_machine` and `azurerm_windows_web_app` carry the family key in
 * the middle, not at the front. Token-boundary matching (rather than a bare substring)
 * keeps `virtual_network` from being claimed by a hypothetical `virtual_net` key.
 *
 * Longest-first is load-bearing: `linux_web` must be tried before `web`, and
 * `virtual_machine` before `virtual`, or the shorter key wins and the classification is
 * wrong in a way that still looks plausible.
 */
function getFamily(resourceType) {
  const rest = resourceType.startsWith('azurerm_') ? resourceType.slice('azurerm_'.length) : resourceType;
  const tokens = rest.split('_');
  for (const key of familyKeysByLength) {
    const kt = key.split('_');
    for (let i = 0; i + kt.length <= tokens.length; i++) {
      let hit = true;
      for (let j = 0; j < kt.length; j++) {
        if (tokens[i + j] !== kt[j]) { hit = false; break; }
      }
      if (hit) return familyMap[key];
    }
  }
  return 'other';
}

function countForceNew(attributes) {
  if (!attributes) return 0;
  return Object.values(attributes).filter(attr => attr.force_new === true).length;
}

function hasTags(attributes) {
  if (!attributes) return false;
  const tagsAttr = attributes.tags;
  if (!tagsAttr) return false;
  // Tags must exist and NOT be force_new
  return tagsAttr.force_new !== true;
}

function getSafeOpClasses(resourceType, attributes) {
  const classes = [];
  if (!attributes) return classes;

  // tag_update: add if hasTags is true
  if (hasTags(attributes)) {
    classes.push('tag_update');
  }

  // grow_disk: disk_size_gb, storage_mb, max_size_gb (not force_new)
  const diskAttrs = ['disk_size_gb', 'storage_mb', 'max_size_gb'];
  for (const attr of diskAttrs) {
    if (attributes[attr] && attributes[attr].force_new !== true) {
      classes.push('grow_disk');
      break;
    }
  }

  // resize: size, sku, sku_name, vm_size (not force_new, compute family only)
  const sizeAttrs = ['size', 'sku', 'sku_name', 'vm_size'];
  const family = getFamily(resourceType);
  if (family === 'compute') {
    for (const attr of sizeAttrs) {
      if (attributes[attr] && attributes[attr].force_new !== true) {
        classes.push('resize');
        break;
      }
    }
  }

  // tighten_tls: min_tls_version (not force_new)
  if (attributes.min_tls_version && attributes.min_tls_version.force_new !== true) {
    classes.push('tighten_tls');
  }

  // Remove duplicates and sort for consistency
  return [...new Set(classes)].sort();
}

function getBucket(resourceType, family, safeOpClasses) {
  // engineer_only patterns
  const engineerOnlyFamilies = ['security', 'identity', 'governance'];
  if (engineerOnlyFamilies.includes(family)) {
    return 'engineer_only';
  }

  const engineerOnlyPatterns = [
    'role_assignment',
    'role_definition',
    'policy',
    '_rule',
    'route',
    'peering',
    'access_policy',
    'lock',
    // key_vault SUB-resources (key/secret/certificate/access_policy/managed_*) are
    // key material or access control = engineer-only; the vault CONTAINER itself
    // (azurerm_key_vault) is NOT matched by this (no trailing "_") and stays a
    // catalog candidate for tags + purge-protection. (Fixes the earlier "_key"
    // substring bug that caught "azurerm_key_vault" via "…_key_vault".)
    'key_vault_',
    'encryption_key',
    'firewall',
    'private_endpoint',
    'vpn_gateway',
    'express_route',
  ];

  for (const pattern of engineerOnlyPatterns) {
    if (resourceType.includes(pattern)) {
      return 'engineer_only';
    }
  }

  // catalog_candidate: non-empty safeOpClasses and not engineer_only
  if (safeOpClasses.length > 0) {
    return 'catalog_candidate';
  }

  // review_needed: empty safeOpClasses and not engineer_only
  return 'review_needed';
}

function generateWhy(resourceType, family, safeOpClasses, bucket) {
  if (bucket === 'engineer_only') {
    return 'Access/reachability gate — requires curation.';
  }
  if (safeOpClasses.length === 0) {
    return 'No obvious safe operations — needs human review.';
  }
  if (safeOpClasses.includes('tag_update') && safeOpClasses.length === 1) {
    return 'Tags only — baseline entry point.';
  }
  if (safeOpClasses.includes('grow_disk')) {
    return 'Storage growth available.';
  }
  if (safeOpClasses.includes('resize')) {
    return 'In-place sizing available.';
  }
  return 'Safe operations available.';
}

// Read schema
const schemaRaw = fs.readFileSync(schemaPath, 'utf-8');
const schema = JSON.parse(schemaRaw);
const resources = schema.resources;

// Generate ledger
const ledger = [];
let totalTypes = 0;

for (const [resourceType, resourceDef] of Object.entries(resources)) {
  totalTypes++;
  const attributes = resourceDef.attributes || {};
  const family = getFamily(resourceType);
  const attrCount = Object.keys(attributes).length;
  const forceNewCount = countForceNew(attributes);
  const tags = hasTags(attributes);
  const safeOpClasses = getSafeOpClasses(resourceType, attributes);
  const bucket = getBucket(resourceType, family, safeOpClasses);
  const why = generateWhy(resourceType, family, safeOpClasses, bucket);

  ledger.push({
    type: resourceType,
    family,
    attrCount,
    forceNewCount,
    hasTags: tags,
    safeOpClasses,
    bucket,
    why,
  });
}

// Assert total == 1141
if (totalTypes !== 1141) {
  throw new Error(`Expected 1141 resource types, got ${totalTypes}`);
}
console.log(`✓ Ledger generated: ${totalTypes} resource types`);

// Sort by type for consistency
ledger.sort((a, b) => a.type.localeCompare(b.type));

// Write ledger JSON
// IMP-4 SELF-CHECK — refuse to write rather than ship a silently-dead family map.
//
// The original defect produced a perfectly well-formed ledger: valid JSON, every row
// present, 662 of 1141 types quietly classified 'other'. Nothing downstream could tell,
// and the corrupted data was committed and consumed. So the generator now proves the map
// is REACHABLE before it writes anything.
//
// Anchors are types whose family is not a matter of opinion. `resize > 0` is the
// consequence check: that safe-op class requires family 'compute', and the dead map
// emitted it ZERO times across 1141 types — a uniform result, which is the same tell as a
// grep against a missing file (L-10). A count of zero here means the gate is unreachable
// again, whatever the anchors say.
{
  const anchors = {
    azurerm_linux_virtual_machine: 'compute',
    azurerm_windows_virtual_machine: 'compute',
    azurerm_managed_disk: 'compute',
    azurerm_key_vault: 'keyvault',
    azurerm_resource_group: 'governance',
    azurerm_user_assigned_identity: 'identity',
    azurerm_application_gateway: 'network',
    azurerm_virtual_network: 'network',
  };
  const wrong = Object.entries(anchors)
    .map(([t, want]) => [t, want, getFamily(t)])
    .filter(([, want, got]) => want !== got);
  if (wrong.length > 0) {
    console.error('✗ family classification is broken — refusing to write the ledger (IMP-4):');
    for (const [t, want, got] of wrong) console.error(`    ${t}: got '${got}', want '${want}'`);
    process.exit(1);
  }

  const unreachable = Object.keys(familyMap).filter((k) => getFamily('azurerm_' + k) !== familyMap[k]);
  if (unreachable.length > 0) {
    console.error(`✗ ${unreachable.length} familyMap key(s) are UNREACHABLE — refusing to write (IMP-4):`);
    console.error('    ' + unreachable.join(', '));
    process.exit(1);
  }

  const resizeCount = ledger.filter((r) => (r.safeOpClasses || []).includes('resize')).length;
  if (resizeCount === 0) {
    console.error("✗ zero types carry the 'resize' safe-op class — it requires family 'compute',");
    console.error('  so a count of zero means the family gate is unreachable again (IMP-4).');
    process.exit(1);
  }
  const otherCount = ledger.filter((r) => r.family === 'other').length;
  console.log(`✓ family map verified: ${Object.keys(familyMap).length} keys all reachable · ${resizeCount} resize · ${otherCount}/${ledger.length} 'other'`);
}

const ledgerText = JSON.stringify(ledger, null, 2);
if (!CHECK_ONLY) {
  fs.writeFileSync(ledgerPath, ledgerText);
  console.log(`✓ Ledger written to ${ledgerPath}`);
}

// Generate summary statistics
const familyCounts = {};
const bucketCounts = {};
const safeOpClassCounts = {};

for (const entry of ledger) {
  // Count by family × bucket
  const key = `${entry.family}|${entry.bucket}`;
  if (!familyCounts[key]) {
    familyCounts[key] = 0;
  }
  familyCounts[key]++;

  // Count by bucket
  if (!bucketCounts[entry.bucket]) {
    bucketCounts[entry.bucket] = 0;
  }
  bucketCounts[entry.bucket]++;

  // Count by safeOpClass
  for (const cls of entry.safeOpClasses) {
    if (!safeOpClassCounts[cls]) {
      safeOpClassCounts[cls] = 0;
    }
    safeOpClassCounts[cls]++;
  }
}

// Build summary markdown
// IMP-8: provenance of the INPUT, not the wall-clock of the run. A `Generated:
// <now>` line made every regeneration differ from the committed file, which is
// exactly the diff noise that made a regenerate-and-compare check impossible —
// and it dated the run rather than identifying what the run consumed, so it was
// never the more useful of the two anyway.
const meta = schema.metadata || {};
const prov = meta.source_provenance || {};

// Never interpolate a field that is not there. The first draft of this header
// read `prov.commit_sha` and rendered the literal string "undefined" into a
// committed artifact — the azurerm dump, unlike the aws one, carries NO
// source_provenance block at all. That is precisely the shape IMP-4's own fix
// tripped over (`r.safe_op_classes` for `r.safeOpClasses`, a uniform zero that
// read as an answer) and precisely what L-22 is about: a miss path that is
// indistinguishable from a legitimate value. So a required field that is absent
// stops the run instead of being printed, and an optional one is omitted rather
// than rendered empty.
function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    console.error(`✗ the schemadump metadata has no ${label} — refusing to stamp a missing`);
    console.error('  value into a committed artifact rather than writing "undefined" (IMP-8).');
    process.exit(1);
  }
  return value;
}
const commitClause =
  typeof prov.commit_sha === 'string' && prov.commit_sha.trim()
    ? `, commit \`${prov.commit_sha}\``
    : '';
let summary = `# Azure Capability Coverage Ledger

Generated from \`tools/schemadump/azurerm-v${required(meta.provider_version, 'provider_version')}-schema.json\`
(${required(meta.provider, 'provider')} ${required(meta.provider_tag, 'provider_tag')}${commitClause}, dumped ${required(meta.generated_at, 'generated_at')}).
Regenerate with \`node tools/schemadump/gen-azure-ledger.mjs\`; verify with \`--check\`.
Do not hand-edit — this file and the ledger JSON are derived, and CI diffs them.

**Total resource types: ${totalTypes}** (all 1,141 Azure resource types accounted for)

This ledger is the coverage backbone for wiring Azure into the Cloud Control Plane catalog. Every type is classified; catalog waves consume the \`catalog_candidate\` rows; \`engineer_only\` and \`review_needed\` are the recorded not-blindly-wired surface (fail-closed doctrine per ADR-0039).

## Classification Summary

### By Family × Bucket

| Family | Catalog Candidate | Engineer Only | Review Needed | Total |
|--------|-------------------|---------------|---------------|-------|
`;

// Collect all families
const allFamilies = [...new Set(ledger.map(e => e.family))].sort();

for (const family of allFamilies) {
  const candidate = familyCounts[`${family}|catalog_candidate`] || 0;
  const engineer = familyCounts[`${family}|engineer_only`] || 0;
  const review = familyCounts[`${family}|review_needed`] || 0;
  const total = candidate + engineer + review;
  summary += `| ${family} | ${candidate} | ${engineer} | ${review} | ${total} |\n`;
}

const totalCandidates = bucketCounts['catalog_candidate'] || 0;
const totalEngineer = bucketCounts['engineer_only'] || 0;
const totalReview = bucketCounts['review_needed'] || 0;

summary += `| **TOTAL** | **${totalCandidates}** | **${totalEngineer}** | **${totalReview}** | **${totalTypes}** |\n`;

summary += `\n## Safe Operation Class Coverage\n\n`;
summary += `| Safe Op Class | Types Offering | Percentage |\n`;
summary += `|---------------|----------------|------------|\n`;

for (const cls of ['tag_update', 'grow_disk', 'resize', 'tighten_tls'].sort()) {
  const count = safeOpClassCounts[cls] || 0;
  const pct = ((count / totalTypes) * 100).toFixed(1);
  summary += `| \`${cls}\` | ${count} | ${pct}% |\n`;
}

summary += `\n## Notes\n\n`;
summary += `- **Catalog Candidate**: Safe self-service operations available. These types enter the catalog pipeline for curation and wiring.\n`;
summary += `- **Engineer Only**: Gates access, reachability, identity, or policy. Require human judgment. (Tag ops may exist but are curation decisions.)\n`;
summary += `- **Review Needed**: No obvious safe operations. Require human review for any catalog inclusion.\n`;

if (!CHECK_ONLY) {
  fs.writeFileSync(summaryPath, summary);
  console.log(`✓ Summary written to ${summaryPath}`);
  console.log('\n' + summary);
  process.exit(0);
}

// ── IMP-8: --check — mechanical staleness detection ─────────────────────────
//
// Regenerate in memory, compare against what is committed, fail on any difference.
// The shape to be careful about is NOT a wrong answer, it is a VACUOUS pass: a
// comparison that read no files, or compared a value that is undefined on both
// sides, reports "all good" just as confidently. IMP-4's own fix nearly shipped
// on exactly that — a self-check reading `r.safe_op_classes` when the field is
// `r.safeOpClasses`, which produced a uniform zero that looked like an answer.
//
// So this refuses on: a missing artifact (a deleted output is the most stale an
// output can be, not something to skip), an empty one, a comparison set that
// somehow ended up empty, and a row count that does not match the dump. Then it
// prints the counts it actually compared, so a future reader can see the check
// did work rather than inferring it from a green tick.
{
  const expected = [
    { label: 'catalog/azure-capability-ledger.json', file: ledgerPath, want: ledgerText },
    { label: 'catalog/azure-capability-ledger-summary.md', file: summaryPath, want: summary },
  ];
  if (expected.length === 0) {
    console.error('✗ --check compared nothing — the artifact list is empty (IMP-8)');
    process.exit(1);
  }
  if (ledger.length !== totalTypes || totalTypes === 0) {
    console.error(`✗ --check regenerated ${ledger.length} row(s) for ${totalTypes} dump type(s) —`);
    console.error('  refusing to compare against a ledger this run did not really rebuild (IMP-8)');
    process.exit(1);
  }

  let failed = 0;
  for (const { label, file, want } of expected) {
    if (!fs.existsSync(file)) {
      console.error(`✗ ${label} is MISSING — regenerate: node tools/schemadump/gen-azure-ledger.mjs`);
      failed++;
      continue;
    }
    const got = fs.readFileSync(file, 'utf-8');
    if (got.length === 0) {
      console.error(`✗ ${label} is EMPTY — regenerate: node tools/schemadump/gen-azure-ledger.mjs`);
      failed++;
      continue;
    }
    if (got === want) {
      console.log(`✓ ${label} matches a fresh generation (${got.length} bytes)`);
      continue;
    }
    failed++;
    const gotLines = got.split('\n');
    const wantLines = want.split('\n');
    const at = gotLines.findIndex((l, i) => l !== wantLines[i]);
    console.error(`✗ ${label} is STALE — it differs from what the committed dump produces.`);
    console.error(`    first difference at line ${at + 1}:`);
    console.error(`      committed: ${JSON.stringify((gotLines[at] ?? '').slice(0, 160))}`);
    console.error(`      regenerated: ${JSON.stringify((wantLines[at] ?? '').slice(0, 160))}`);
    console.error('    fix: node tools/schemadump/gen-azure-ledger.mjs (never hand-edit a derived file)');
  }

  if (failed > 0) {
    console.error(`✗ ${failed} of ${expected.length} generated catalog artifact(s) are stale (IMP-8)`);
    process.exit(1);
  }
  console.log(
    `✓ ${expected.length} generated catalog artifact(s) reproduce from ` +
      `${path.basename(schemaPath)} · ${ledger.length} ledger rows compared`,
  );
}
// (write mode echoes the summary to stdout above; --check must not, or its
// verdict scrolls off the top of a CI log behind 40 lines of markdown)
