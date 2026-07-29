#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, 'azurerm-v4.81.0-schema.json');
const ledgerPath = path.join(__dirname, '../../catalog/azure-capability-ledger.json');
const summaryPath = path.join(__dirname, '../../catalog/azure-capability-ledger-summary.md');

// Ensure output directory exists
const catalogDir = path.dirname(ledgerPath);
if (!fs.existsSync(catalogDir)) {
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

fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
console.log(`✓ Ledger written to ${ledgerPath}`);

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
let summary = `# Azure Capability Coverage Ledger

Generated: ${new Date().toISOString()}

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

fs.writeFileSync(summaryPath, summary);
console.log(`✓ Summary written to ${summaryPath}`);

// Print summary to stdout
console.log('\n' + summary);
