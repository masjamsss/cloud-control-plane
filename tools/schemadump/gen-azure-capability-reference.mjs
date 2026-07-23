#!/usr/bin/env node
/**
 * Azure Capability Reference Generator
 * Transforms azurerm-v4.81.0-schema.json into markdown documentation
 * organized by service family.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Family mapping: azurerm_<prefix> -> family name
const FAMILY_MAP = {
  aadb2c: 'identity',
  app: 'web',
  application: 'integration',
  appservice: 'web',
  arc: 'compute',
  attestation: 'security',
  automanage: 'compute',
  automation: 'governance',
  backup: 'governance',
  batch: 'compute',
  billing: 'governance',
  bot: 'ai',
  cdn: 'network',
  cognitive: 'ai',
  container: 'containers',
  containerapp: 'containers',
  containerregistry: 'containers',
  cosmosdb: 'database',
  dashboard: 'monitoring',
  databox: 'storage',
  databricks: 'analytics',
  datacatalog: 'analytics',
  datadog: 'monitoring',
  datafactory: 'analytics',
  datalake: 'storage',
  datamigration: 'database',
  dataprotection: 'governance',
  datashare: 'analytics',
  dedicated: 'compute',
  deployment: 'governance',
  desktopvirtualization: 'compute',
  deviceprovisioningservice: 'iot',
  digitaltwins: 'iot',
  disk: 'storage',
  diskencryptionset: 'storage',
  distributedtracing: 'monitoring',
  dns: 'network',
  edge: 'compute',
  elasticloud: 'analytics',
  elasticsearch: 'analytics',
  eventgrid: 'integration',
  eventhub: 'integration',
  express: 'network',
  firewall: 'network',
  frontdoor: 'network',
  functionapp: 'web',
  gallery: 'compute',
  guestconfiguration: 'governance',
  hdinsight: 'analytics',
  health: 'governance',
  healthbot: 'ai',
  hpc: 'compute',
  image: 'compute',
  iotcentral: 'iot',
  iothub: 'iot',
  ipgroup: 'network',
  keyvault: 'keyvault',
  kubernetes: 'containers',
  kusto: 'analytics',
  lb: 'network',
  loadtestservice: 'monitoring',
  loganalytics: 'monitoring',
  logic: 'integration',
  logstash: 'analytics',
  machine: 'compute',
  machinelearning: 'ai',
  managedapplication: 'governance',
  managedidentity: 'identity',
  managementgroup: 'governance',
  maps: 'ai',
  mariadb: 'database',
  media: 'ai',
  mediaservices: 'ai',
  migrate: 'governance',
  monitor: 'monitoring',
  mongodbatlas: 'database',
  mssql: 'database',
  mysql: 'database',
  netapp: 'storage',
  network: 'network',
  networkfunction: 'network',
  networkwatcher: 'network',
  newrelic: 'monitoring',
  notebook: 'analytics',
  notification: 'integration',
  officeintegration: 'integration',
  orbital: 'compute',
  paloalto: 'security',
  peering: 'network',
  pim: 'identity',
  policyinsights: 'governance',
  portal: 'web',
  postgresql: 'database',
  powerbi: 'analytics',
  privatedns: 'network',
  purview: 'analytics',
  policyinsight: 'governance',
  quantum: 'compute',
  quota: 'governance',
  recoveryservices: 'governance',
  redis: 'database',
  redisenterprise: 'database',
  relay: 'integration',
  resourcegroup: 'governance',
  resourcemanagement: 'governance',
  role: 'identity',
  routes: 'network',
  routeserver: 'network',
  runbook: 'governance',
  saas: 'web',
  scheduler: 'integration',
  search: 'analytics',
  securitycenter: 'security',
  securityinsight: 'security',
  sentinel: 'security',
  servicebus: 'integration',
  servicefabric: 'containers',
  servicefabricmanaged: 'containers',
  servicelinker: 'integration',
  signalr: 'web',
  site: 'web',
  snapshot: 'storage',
  spatialanchors: 'ai',
  spring: 'containers',
  sql: 'database',
  sqlvirtualmachine: 'database',
  storage: 'storage',
  storagecache: 'storage',
  storagesync: 'storage',
  stream: 'analytics',
  streamanalytics: 'analytics',
  subnet: 'network',
  subscription: 'governance',
  synapse: 'analytics',
  time: 'monitoring',
  traffic: 'network',
  trafficmanager: 'network',
  virtualdesktop: 'compute',
  virtualmachine: 'compute',
  virtualmachinescaleset: 'compute',
  virtualnetwork: 'network',
  virtualwan: 'network',
  visualization: 'ai',
  vmware: 'compute',
  voiceservices: 'integration',
  web: 'web',
  windows: 'security',
  workload: 'governance',
  workloads: 'compute',
};

function getFamily(resourceType) {
  // Extract prefix from azurerm_<prefix>_<rest>
  const match = resourceType.match(/^azurerm_([a-z]+)/);
  if (!match) return 'other';

  const prefix = match[1];
  return FAMILY_MAP[prefix] || 'other';
}

function escapeMarkdown(text) {
  return String(text || '').replace(/[|`\\]/g, '\\$&');
}

function renderType(attrDef) {
  let type = attrDef.type || 'unknown';
  if (attrDef.nesting_mode) {
    type += ` (${attrDef.nesting_mode})`;
  }
  return type;
}

function formatAttribute(name, attrDef, blockPrefix = '') {
  const displayName = blockPrefix ? `${blockPrefix}.${name}` : name;
  const required = attrDef.required ? 'Yes' : 'No';
  const forceNew = attrDef.force_new ? '✓' : '·';

  return {
    name: displayName,
    required,
    forceNew,
    type: renderType(attrDef),
  };
}

function processResource(resourceType, resourceDef) {
  const attributes = [];

  // Process top-level attributes
  for (const [name, attrDef] of Object.entries(resourceDef.attributes || {})) {
    attributes.push(formatAttribute(name, attrDef));

    // Process nested block attributes (one level deep)
    if (attrDef.block && attrDef.block.attributes) {
      for (const [blockAttrName, blockAttrDef] of Object.entries(attrDef.block.attributes)) {
        attributes.push(formatAttribute(blockAttrName, blockAttrDef, name));
      }
    }
  }

  return attributes;
}

function generateResourceSection(resourceType, resourceDef) {
  const attributes = processResource(resourceType, resourceDef);

  let markdown = `## ${resourceType}\n\n`;

  if (attributes.length === 0) {
    markdown += 'No attributes.\n\n';
    return markdown;
  }

  markdown += '| attribute | type | ForceNew | required |\n';
  markdown += '|---|---|---|---|\n';

  for (const attr of attributes) {
    const row = `| \`${escapeMarkdown(attr.name)}\` | ${escapeMarkdown(attr.type)} | ${attr.forceNew} | ${attr.required} |`;
    markdown += row + '\n';
  }

  markdown += '\n';
  return markdown;
}

function generateFamilyFile(family, resources) {
  const familyResources = resources.filter(r => getFamily(r) === family);
  if (familyResources.length === 0) return null;

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'azurerm-v4.81.0-schema.json')));

  let markdown = `# ${family} -- Terraform Azure Capability Reference\n\n`;
  markdown += `${familyResources.length} resource type(s)\n\n`;

  for (const resourceType of familyResources.sort()) {
    const resourceDef = data.resources[resourceType];
    if (resourceDef) {
      markdown += generateResourceSection(resourceType, resourceDef);
    }
  }

  return markdown;
}

function main() {
  const schemaPath = path.join(__dirname, 'azurerm-v4.81.0-schema.json');
  const outDir = path.join(__dirname, '..', '..', 'docs', 'operations', 'terraform-capability-reference-azure');

  // Read schema
  const data = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const allResources = Object.keys(data.resources);

  console.log(`Processing ${allResources.length} resources...`);

  // Create output directory
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Group by family
  const familyGroups = {};
  for (const resourceType of allResources) {
    const family = getFamily(resourceType);
    if (!familyGroups[family]) {
      familyGroups[family] = [];
    }
    familyGroups[family].push(resourceType);
  }

  // Generate per-family markdown files
  const familiesWritten = [];
  for (const [family, resources] of Object.entries(familyGroups)) {
    const markdown = generateFamilyFile(family, allResources);
    if (markdown) {
      const filename = path.join(outDir, `${family}.md`);
      fs.writeFileSync(filename, markdown, 'utf8');
      familiesWritten.push(family);
      console.log(`  ✓ ${family}.md (${resources.length} types)`);
    }
  }

  // Generate INDEX.md
  let indexMarkdown = `# Terraform Azure Provider Capability Reference

This reference is the human-readable full scan of azurerm v4.81.0 (owner directive: scan every capability). It is generated from \`tools/schemadump/azurerm-v4.81.0-schema.json\` by \`gen-azure-capability-reference.mjs\` and regenerated, never hand-edited. It documents what EXISTS, not what the catalog exposes (the catalog is a curated fail-closed subset — see \`catalog/azure-capability-ledger.json\`).

## Coverage by family

| Family | Resource count |
|---|---|
`;

  let totalCount = 0;
  for (const family of familiesWritten.sort()) {
    const count = familyGroups[family].length;
    totalCount += count;
    indexMarkdown += `| **${family}** | ${count} |\n`;
  }

  indexMarkdown += `| **TOTAL** | **${totalCount}** |\n\n`;

  if (totalCount !== 1141) {
    console.error(`ERROR: Expected 1141 resources, got ${totalCount}`);
    process.exit(1);
  }

  // List families
  indexMarkdown += '## Resource families\n\n';
  for (const family of familiesWritten.sort()) {
    const count = familyGroups[family].length;
    indexMarkdown += `- [${family}](./${family}.md) — ${count} type(s)\n`;
  }

  const indexPath = path.join(outDir, 'INDEX.md');
  fs.writeFileSync(indexPath, indexMarkdown, 'utf8');

  // Verify spot checks
  const sa = data.resources['azurerm_storage_account'];
  const nameForceNew = sa?.attributes?.name?.force_new;
  const tagsForceNew = sa?.attributes?.tags?.force_new;

  console.log('\nSpot checks:');
  console.log(`  azurerm_storage_account.name.force_new = ${nameForceNew} (expected: true) ${nameForceNew === true ? '✓' : '✗'}`);
  console.log(`  azurerm_storage_account.tags.force_new = ${tagsForceNew} (expected: false) ${tagsForceNew === false ? '✓' : '✗'}`);

  console.log(`\nGenerated ${familiesWritten.length} family files and INDEX.md`);
  console.log(`Total resources: ${totalCount}`);
  console.log(`Output: ${outDir}`);
}

main();
