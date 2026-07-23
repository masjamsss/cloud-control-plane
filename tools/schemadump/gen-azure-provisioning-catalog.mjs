#!/usr/bin/env node
// Generate the comprehensive Azure provisioning catalog from the azurerm schema
// dump: every operator-provisionable service (a top-level resource that requires
// both a resource group AND a location — sub-resources/config inherit both), with
// its portal "Basics" parameters and its dependencies (the existing resources an
// operator must select first). Regenerate: node gen-azure-provisioning-catalog.mjs
//   <schema.json> <out.md>
import fs from 'node:fs';

const [, , SCHEMA, OUT] = process.argv;
const S = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));

// A required attribute is a "dependency" (select-an-existing-resource) when it
// references another resource. `_id`/`_ids` are reliable references. `_name` is
// ambiguous — a reference only for known cross-resource names (server_name,
// virtual_network_name…), NOT value-names (sku_name, display_name, host_name).
const ID_REF = /_(id|ids)$/;
const NAME_REF = /(resource_group|virtual_network|subnet|server|cluster|storage_account|workspace|key_vault|registry|namespace|zone|hub|vault|service_plan|parent)_name$/;
const NAME_VALUE = /(sku_name|display_name|dns_name|host_name|_login_name|node_name|_setting_name|database_name|collection_name|share_name|table_name|queue_name|topic_name)$/;
function isDep(attr) {
  if (ID_REF.test(attr)) return true;
  if (NAME_REF.test(attr) && !NAME_VALUE.test(attr)) return true;
  return false;
}
function human(s) {
  return s
    .replace(/^azurerm_/, '')
    .replace(/_(id|ids|name)$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// portal category by type family (order matters — first match wins)
const CAT = [
  [/virtual_machine|managed_disk|availability|dedicated_host|capacity_reservation|proximity|snapshot|_image|orchestrated|ssh_public|_gallery|shared_image|disk_|restore_point|vmware/, 'Compute'],
  [/virtual_network|subnet|network_security|public_ip|_lb|load_balancer|application_gateway|firewall|vpn|express_route|virtual_wan|nat_gateway|route|private_endpoint|private_dns|traffic_manager|frontdoor|front_door|_cdn|bastion|network_interface|network_watcher|ip_group|virtual_hub|point_to_site|_dns_|web_application_firewall|custom_ip_prefix|local_network_gateway|ddos|network_manager|network_profile|private_link_service|palo_alto|network_function/, 'Networking'],
  [/storage_account|storage_share|storage_container|netapp|storage_sync|data_lake|storage_blob|storage_queue|storage_table|managed_lustre|_storage_|elastic_san|hpc_cache|qumulo/, 'Storage'],
  [/mssql|sql_|postgresql|mysql|mariadb|cosmosdb|redis|database_|_database|kusto|oracle_|managed_redis|mongo_cluster/, 'Databases'],
  [/service_plan|_web_app|function_app|static_web|static_site|logic_app|api_management|app_service|healthcare|spring_cloud|_web_pubsub|signalr|_api_|search_service|nginx/, 'Web & App'],
  [/kubernetes|container_registry|container_group|container_app|_batch|service_fabric|_redis_enterprise|container_connected|openshift/, 'Containers'],
  [/synapse|data_factory|databricks|eventhub|event_hub|stream_analytics|hdinsight|data_explorer|purview|analysis_services|powerbi|_fabric|data_share/, 'Analytics'],
  [/cognitive|machine_learning|_search|bot_|_openai|video_analyzer|_ai_|healthbot|video_indexer/, 'AI & ML'],
  [/servicebus|service_bus|eventgrid|event_grid|relay|_communication|integration_|_logic|api_connection/, 'Integration'],
  [/iothub|iot_|digital_twins|_maps|time_series|notification_hub|_mobile|orbital/, 'IoT & Mobile'],
  [/key_vault|_security|sentinel|dedicated_hardware|attestation|_confidential|_defender|trusted_signing|chaos/, 'Security'],
  [/log_analytics|application_insights|_monitor|automation|recovery_services|_backup|dashboard|portal_|maintenance|_consumption|_advisor|managed_grafana|data_protection|dev_test|dev_center|_management_|resource_group_|_policy|_blueprint|_lighthouse|_cost|load_test|managed_application|arc_|stack_hci|databox|managed_devops/, 'Management & Governance'],
  [/user_assigned_identity|_role_|federated_identity|_managed_identity|active_directory/, 'Identity'],
];
const cat = (t) => (CAT.find(([re]) => re.test(t)) || [, 'Other'])[1];

// the wave-1 headliners already being built (mark them)
const WAVE1 = new Set([
  'azurerm_linux_virtual_machine', 'azurerm_windows_virtual_machine', 'azurerm_managed_disk',
  'azurerm_resource_group', 'azurerm_virtual_network', 'azurerm_subnet',
  'azurerm_network_security_group', 'azurerm_public_ip', 'azurerm_lb', 'azurerm_storage_account',
  'azurerm_key_vault', 'azurerm_mssql_server', 'azurerm_mssql_database',
  'azurerm_postgresql_flexible_server', 'azurerm_mysql_flexible_server', 'azurerm_cosmosdb_account',
  'azurerm_redis_cache', 'azurerm_kubernetes_cluster', 'azurerm_container_registry',
  'azurerm_service_plan', 'azurerm_linux_web_app', 'azurerm_linux_function_app',
  'azurerm_log_analytics_workspace', 'azurerm_container_group',
]);

const services = [];
for (const [type, def] of Object.entries(S.resources)) {
  const attrs = def.attributes || {};
  const req = Object.entries(attrs).filter(([, ad]) => ad && ad.required && !ad.computed).map(([a]) => a);
  const hasRG = 'resource_group_name' in attrs && attrs.resource_group_name?.required;
  const hasLoc = 'location' in attrs && attrs.location?.required;
  if (!hasRG || !hasLoc) continue; // top-level provisionable service only
  const deps = req.filter(isDep);
  const params = req.filter((a) => !isDep(a) && a !== 'resource_group_name' && a !== 'location');
  services.push({ type, cat: cat(type), name: human(type), params, deps });
}
services.sort((a, b) => a.name.localeCompare(b.name));

const byCat = {};
for (const s of services) (byCat[s.cat] ??= []).push(s);
const order = ['Compute', 'Networking', 'Storage', 'Databases', 'Web & App', 'Containers',
  'Analytics', 'AI & ML', 'Integration', 'IoT & Mobile', 'Security', 'Management & Governance',
  'Identity', 'Other'];

let md = `# Azure provisioning catalog — every operator-provisionable service

**Derived** from \`tools/schemadump/azurerm-v4.81.0-schema.json\` (regenerate:
\`node tools/schemadump/gen-azure-provisioning-catalog.mjs <schema.json> <out.md>\`). A row is a
**top-level provisionable service** — an azurerm resource that requires *both* a resource group
*and* a location, which is what the Azure Portal's "Create a resource" catalog exposes.
Sub-resources, rules, associations, and config blocks (which inherit RG + location from a parent)
are intentionally excluded.

For each service: **Portal parameters** are the required fill-in fields (the portal "Basics"
essentials); **Depends on** are the existing resources an operator must select first (the
dependency graph — these become \`inventory://\` pickers in the form). Every service also takes a
resource group + location (universal, not repeated per row). ✅ = a curated provisioning form is
already being built (wave 1).

**Total: ${services.length} provisionable services.** Build strategy: wave 1 is the ${WAVE1.size}
core headliners (✅). Subsequent waves curate the common services per category. The specialized
tail (e.g. Orbital ground stations, Chaos Studio, VMware, ERP workloads) is covered by this
catalog + the engineer "provision any type" path rather than a hand-curated form.

`;
for (const c of order) {
  const list = byCat[c];
  if (!list) continue;
  md += `\n## ${c} (${list.length})\n\n`;
  md += `| Service | azurerm type | Portal parameters | Depends on |\n|---|---|---|---|\n`;
  for (const s of list) {
    const built = WAVE1.has(s.type) ? '✅ ' : '';
    const params = s.params.length ? s.params.join(', ') : '—';
    const deps = s.deps.length ? [...new Set(s.deps.map(human))].join(', ') : '—';
    md += `| ${built}${s.name} | \`${s.type}\` | ${params} | ${deps} |\n`;
  }
}
fs.writeFileSync(OUT, md);
console.log(`wrote ${services.length} services across ${Object.keys(byCat).length} categories → ${OUT}`);
for (const c of order) if (byCat[c]) console.log(`  ${c}: ${byCat[c].length}`);
