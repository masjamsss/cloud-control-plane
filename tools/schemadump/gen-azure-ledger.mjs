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

function getFamily(resourceType) {
  // Extract second token: azurerm_<X>_...
  const parts = resourceType.split('_');
  if (parts.length < 2) return 'other';

  const secondToken = parts[1];
  return familyMap[secondToken] || 'other';
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
