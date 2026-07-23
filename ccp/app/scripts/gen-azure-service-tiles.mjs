#!/usr/bin/env node
// Derive per-named-service Azure tiles from the manifest ops. Each azurerm type
// maps to a portal-recognizable SERVICE (e.g. every azurerm_mssql_* → "Azure SQL"),
// so the catalog browses ~150 services (portal-parity) instead of 16 broad buckets,
// WITHOUT splitting the 16 manifest files — catalog.ts groups by namedService(type).
// Output: the namedService map + a serviceMeta fragment (display name + category +
// monogram) for every named service that has ops. Curated glyphs stay hand-authored
// in serviceIcons.ts for the common services; the rest fall back to their monogram.
import fs from 'node:fs';
import path from 'node:path';

const MDIR = 'src/data/manifests';
const azFiles = fs.readdirSync(MDIR).filter((f) => f.startsWith('azure-') && f.endsWith('.json'));

// type-prefix → { slug, name, category }. Longest prefix wins (checked in order).
// Curated so families collapse the portal way (linux/windows VM → one service).
const SERVICES = [
  // Compute
  ['azurerm_linux_virtual_machine', 'vm', 'Virtual Machines', 'Compute'],
  ['azurerm_windows_virtual_machine', 'vm', 'Virtual Machines', 'Compute'],
  ['azurerm_virtual_machine', 'vm', 'Virtual Machines', 'Compute'],
  ['azurerm_orchestrated_virtual_machine_scale_set', 'vmss', 'VM Scale Sets', 'Compute'],
  ['azurerm_managed_disk', 'disk', 'Managed Disks', 'Compute'],
  ['azurerm_snapshot', 'disk', 'Managed Disks', 'Compute'],
  ['azurerm_availability_set', 'availability-set', 'Availability Sets', 'Compute'],
  ['azurerm_dedicated_host', 'dedicated-host', 'Dedicated Hosts', 'Compute'],
  ['azurerm_shared_image', 'compute-gallery', 'Compute Gallery', 'Compute'],
  ['azurerm_gallery', 'compute-gallery', 'Compute Gallery', 'Compute'],
  ['azurerm_image', 'compute-gallery', 'Compute Gallery', 'Compute'],
  ['azurerm_capacity_reservation', 'capacity-reservation', 'Capacity Reservations', 'Compute'],
  ['azurerm_proximity_placement_group', 'ppg', 'Proximity Placement Groups', 'Compute'],
  ['azurerm_ssh_public_key', 'ssh-keys', 'SSH Keys', 'Compute'],
  ['azurerm_dev_test', 'devtest-labs', 'DevTest Labs', 'Compute'],
  ['azurerm_vmware', 'avs', 'Azure VMware Solution', 'Compute'],
  ['azurerm_restore_point', 'restore-point', 'Restore Points', 'Compute'],
  ['azurerm_virtual_desktop', 'avd', 'Virtual Desktop', 'Compute'],
  // Networking
  ['azurerm_virtual_network_gateway', 'vpn-gateway', 'VPN Gateway', 'Networking'],
  ['azurerm_virtual_network', 'vnet', 'Virtual Networks', 'Networking'],
  ['azurerm_subnet', 'vnet', 'Virtual Networks', 'Networking'],
  ['azurerm_network_security_group', 'nsg', 'Network Security Groups', 'Networking'],
  ['azurerm_network_security_rule', 'nsg', 'Network Security Groups', 'Networking'],
  ['azurerm_application_gateway', 'app-gateway', 'Application Gateway', 'Networking'],
  ['azurerm_public_ip', 'public-ip', 'Public IP Addresses', 'Networking'],
  ['azurerm_lb', 'load-balancer', 'Load Balancers', 'Networking'],
  ['azurerm_firewall', 'firewall', 'Azure Firewall', 'Networking'],
  // Slug is 'waf-policy' (not 'waf') on purpose: 'waf' is an aws-curated
  // REGISTRY slug (serviceMeta.ts), which wins first in getServiceMeta and would
  // shadow this azure identity. Azure's WAF ships as WAF *policies* on App
  // Gateway / Front Door (azurerm_web_application_firewall_policy), so the slug
  // is honest and stays collision-free.
  ['azurerm_web_application_firewall', 'waf-policy', 'Web Application Firewall', 'Networking'],
  ['azurerm_express_route', 'expressroute', 'ExpressRoute', 'Networking'],
  ['azurerm_vpn', 'vpn-gateway', 'VPN Gateway', 'Networking'],
  ['azurerm_virtual_wan', 'virtual-wan', 'Virtual WAN', 'Networking'],
  ['azurerm_virtual_hub', 'virtual-wan', 'Virtual WAN', 'Networking'],
  ['azurerm_nat_gateway', 'nat-gateway', 'NAT Gateway', 'Networking'],
  ['azurerm_route', 'route-table', 'Route Tables', 'Networking'],
  ['azurerm_private_endpoint', 'private-endpoint', 'Private Endpoints', 'Networking'],
  ['azurerm_private_dns', 'private-dns', 'Private DNS Zones', 'Networking'],
  ['azurerm_private_link', 'private-link', 'Private Link', 'Networking'],
  ['azurerm_dns', 'dns', 'DNS Zones', 'Networking'],
  ['azurerm_traffic_manager', 'traffic-manager', 'Traffic Manager', 'Networking'],
  ['azurerm_cdn_frontdoor', 'front-door', 'Front Door', 'Networking'],
  ['azurerm_frontdoor', 'front-door', 'Front Door', 'Networking'],
  ['azurerm_cdn', 'cdn', 'Content Delivery Network', 'Networking'],
  ['azurerm_bastion', 'bastion', 'Bastion', 'Networking'],
  ['azurerm_network_interface', 'nic', 'Network Interfaces', 'Networking'],
  ['azurerm_network_watcher', 'network-watcher', 'Network Watcher', 'Networking'],
  ['azurerm_network_manager', 'network-manager', 'Virtual Network Manager', 'Networking'],
  ['azurerm_ip_group', 'ip-group', 'IP Groups', 'Networking'],
  ['azurerm_local_network_gateway', 'local-gateway', 'Local Network Gateway', 'Networking'],
  ['azurerm_custom_ip_prefix', 'custom-ip', 'Custom IP Prefixes', 'Networking'],
  ['azurerm_palo_alto', 'palo-alto', 'Cloud NGFW (Palo Alto)', 'Networking'],
  ['azurerm_network_function', 'network-function', 'Network Function', 'Networking'],
  ['azurerm_network_profile', 'network-profile', 'Network Profiles', 'Networking'],
  // Storage
  ['azurerm_storage_account', 'storage-account', 'Storage Accounts', 'Storage'],
  ['azurerm_storage_share', 'files', 'Azure Files', 'Storage'],
  ['azurerm_storage_container', 'blob', 'Blob Storage', 'Storage'],
  ['azurerm_storage_blob', 'blob', 'Blob Storage', 'Storage'],
  ['azurerm_storage_queue', 'queues', 'Queue Storage', 'Storage'],
  ['azurerm_storage_table', 'tables', 'Table Storage', 'Storage'],
  ['azurerm_storage_sync', 'file-sync', 'Azure File Sync', 'Storage'],
  ['azurerm_storage', 'storage-account', 'Storage Accounts', 'Storage'],
  ['azurerm_netapp', 'netapp', 'Azure NetApp Files', 'Storage'],
  ['azurerm_managed_lustre', 'lustre', 'Managed Lustre', 'Storage'],
  ['azurerm_elastic_san', 'elastic-san', 'Elastic SAN', 'Storage'],
  ['azurerm_data_lake', 'data-lake', 'Data Lake Storage', 'Storage'],
  ['azurerm_hpc_cache', 'hpc-cache', 'HPC Cache', 'Storage'],
  // Databases
  ['azurerm_mssql', 'sql', 'Azure SQL', 'Databases'],
  ['azurerm_sql', 'sql', 'Azure SQL', 'Databases'],
  ['azurerm_postgresql', 'postgresql', 'PostgreSQL', 'Databases'],
  ['azurerm_mysql', 'mysql', 'MySQL', 'Databases'],
  ['azurerm_mariadb', 'mariadb', 'MariaDB', 'Databases'],
  ['azurerm_cosmosdb', 'cosmos', 'Cosmos DB', 'Databases'],
  ['azurerm_redis', 'redis', 'Azure Cache for Redis', 'Databases'],
  ['azurerm_managed_redis', 'redis', 'Azure Cache for Redis', 'Databases'],
  ['azurerm_mongo_cluster', 'mongo', 'Cosmos DB for MongoDB', 'Databases'],
  ['azurerm_kusto', 'data-explorer', 'Data Explorer', 'Databases'],
  ['azurerm_oracle', 'oracle', 'Oracle Database', 'Databases'],
  ['azurerm_database_migration', 'dms', 'Database Migration', 'Databases'],
  // Web & App
  ['azurerm_linux_web_app', 'app-service', 'App Service', 'Web & App'],
  ['azurerm_windows_web_app', 'app-service', 'App Service', 'Web & App'],
  ['azurerm_app_service', 'app-service', 'App Service', 'Web & App'],
  ['azurerm_service_plan', 'app-service-plan', 'App Service Plans', 'Web & App'],
  ['azurerm_app_service_plan', 'app-service-plan', 'App Service Plans', 'Web & App'],
  ['azurerm_linux_function_app', 'functions', 'Azure Functions', 'Web & App'],
  ['azurerm_windows_function_app', 'functions', 'Azure Functions', 'Web & App'],
  ['azurerm_function_app', 'functions', 'Azure Functions', 'Web & App'],
  ['azurerm_static_web_app', 'static-web-apps', 'Static Web Apps', 'Web & App'],
  ['azurerm_static_site', 'static-web-apps', 'Static Web Apps', 'Web & App'],
  ['azurerm_logic_app', 'logic-apps', 'Logic Apps', 'Web & App'],
  ['azurerm_api_management', 'apim', 'API Management', 'Web & App'],
  ['azurerm_api_connection', 'apim', 'API Management', 'Web & App'],
  ['azurerm_healthcare', 'health-data', 'Health Data Services', 'Web & App'],
  ['azurerm_spring_cloud', 'spring-apps', 'Spring Apps', 'Web & App'],
  ['azurerm_web_pubsub', 'web-pubsub', 'Web PubSub', 'Web & App'],
  ['azurerm_signalr', 'signalr', 'SignalR Service', 'Web & App'],
  ['azurerm_search_service', 'search', 'AI Search', 'Web & App'],
  ['azurerm_nginx', 'nginx', 'NGINXaaS', 'Web & App'],
  // Containers
  ['azurerm_kubernetes', 'aks', 'Kubernetes Service', 'Containers'],
  ['azurerm_container_registry', 'acr', 'Container Registry', 'Containers'],
  ['azurerm_container_app', 'container-apps', 'Container Apps', 'Containers'],
  ['azurerm_container_group', 'aci', 'Container Instances', 'Containers'],
  ['azurerm_container_connected', 'arc-k8s', 'Arc-enabled Kubernetes', 'Containers'],
  ['azurerm_batch', 'batch', 'Batch', 'Containers'],
  ['azurerm_service_fabric', 'service-fabric', 'Service Fabric', 'Containers'],
  ['azurerm_redhat_openshift', 'aro', 'Azure Red Hat OpenShift', 'Containers'],
  // Analytics
  ['azurerm_synapse', 'synapse', 'Synapse Analytics', 'Analytics'],
  ['azurerm_data_factory', 'data-factory', 'Data Factory', 'Analytics'],
  ['azurerm_databricks', 'databricks', 'Databricks', 'Analytics'],
  ['azurerm_eventhub', 'event-hubs', 'Event Hubs', 'Analytics'],
  ['azurerm_stream_analytics', 'stream-analytics', 'Stream Analytics', 'Analytics'],
  ['azurerm_hdinsight', 'hdinsight', 'HDInsight', 'Analytics'],
  ['azurerm_data_explorer', 'data-explorer', 'Data Explorer', 'Analytics'],
  ['azurerm_purview', 'purview', 'Microsoft Purview', 'Analytics'],
  ['azurerm_analysis_services', 'analysis-services', 'Analysis Services', 'Analytics'],
  ['azurerm_data_share', 'data-share', 'Data Share', 'Analytics'],
  ['azurerm_fabric', 'fabric', 'Microsoft Fabric', 'Analytics'],
  ['azurerm_powerbi', 'power-bi', 'Power BI Embedded', 'Analytics'],
  // AI & ML
  ['azurerm_cognitive', 'ai-services', 'Azure AI Services', 'AI & ML'],
  ['azurerm_ai_services', 'ai-services', 'Azure AI Services', 'AI & ML'],
  ['azurerm_ai_foundry', 'ai-foundry', 'AI Foundry', 'AI & ML'],
  ['azurerm_machine_learning', 'ml', 'Machine Learning', 'AI & ML'],
  ['azurerm_bot', 'bot-service', 'Bot Service', 'AI & ML'],
  ['azurerm_video_analyzer', 'video-analyzer', 'Video Analyzer', 'AI & ML'],
  ['azurerm_video_indexer', 'video-indexer', 'Video Indexer', 'AI & ML'],
  ['azurerm_healthbot', 'health-bot', 'Health Bot', 'AI & ML'],
  // Integration
  ['azurerm_servicebus', 'service-bus', 'Service Bus', 'Integration'],
  ['azurerm_eventgrid', 'event-grid', 'Event Grid', 'Integration'],
  ['azurerm_relay', 'relay', 'Relay', 'Integration'],
  ['azurerm_communication', 'communication', 'Communication Services', 'Integration'],
  ['azurerm_integration', 'integration-env', 'Integration Environments', 'Integration'],
  // IoT & Mobile
  ['azurerm_iothub', 'iot-hub', 'IoT Hub', 'IoT & Mobile'],
  ['azurerm_iotcentral', 'iot-central', 'IoT Central', 'IoT & Mobile'],
  ['azurerm_iot', 'iot-hub', 'IoT Hub', 'IoT & Mobile'],
  ['azurerm_digital_twins', 'digital-twins', 'Digital Twins', 'IoT & Mobile'],
  ['azurerm_maps', 'maps', 'Azure Maps', 'IoT & Mobile'],
  ['azurerm_notification_hub', 'notification-hubs', 'Notification Hubs', 'IoT & Mobile'],
  ['azurerm_orbital', 'orbital', 'Orbital Ground Station', 'IoT & Mobile'],
  ['azurerm_time_series', 'time-series', 'Time Series Insights', 'IoT & Mobile'],
  // Security
  ['azurerm_key_vault', 'key-vault', 'Key Vault', 'Security'],
  ['azurerm_dedicated_hardware_security', 'hsm', 'Dedicated HSM', 'Security'],
  ['azurerm_security', 'defender', 'Microsoft Defender for Cloud', 'Security'],
  ['azurerm_sentinel', 'sentinel', 'Microsoft Sentinel', 'Security'],
  ['azurerm_attestation', 'attestation', 'Attestation', 'Security'],
  ['azurerm_trusted_signing', 'trusted-signing', 'Trusted Signing', 'Security'],
  ['azurerm_chaos', 'chaos-studio', 'Chaos Studio', 'Security'],
  // Management & Governance
  ['azurerm_log_analytics', 'log-analytics', 'Log Analytics', 'Management & Governance'],
  ['azurerm_application_insights', 'app-insights', 'Application Insights', 'Management & Governance'],
  ['azurerm_monitor', 'monitor', 'Azure Monitor', 'Management & Governance'],
  ['azurerm_dashboard', 'dashboards', 'Dashboards', 'Management & Governance'],
  ['azurerm_automation', 'automation', 'Automation', 'Management & Governance'],
  ['azurerm_recovery_services', 'recovery-vault', 'Recovery Services Vault', 'Management & Governance'],
  ['azurerm_backup', 'backup', 'Azure Backup', 'Management & Governance'],
  ['azurerm_data_protection', 'backup-vault', 'Backup Vault', 'Management & Governance'],
  ['azurerm_maintenance', 'maintenance', 'Maintenance Configurations', 'Management & Governance'],
  ['azurerm_managed_grafana', 'grafana', 'Managed Grafana', 'Management & Governance'],
  ['azurerm_management_group', 'management-groups', 'Management Groups', 'Management & Governance'],
  ['azurerm_policy', 'policy', 'Azure Policy', 'Management & Governance'],
  ['azurerm_blueprint', 'blueprints', 'Blueprints', 'Management & Governance'],
  ['azurerm_lighthouse', 'lighthouse', 'Lighthouse', 'Management & Governance'],
  ['azurerm_consumption', 'cost-management', 'Cost Management', 'Management & Governance'],
  ['azurerm_cost', 'cost-management', 'Cost Management', 'Management & Governance'],
  ['azurerm_advisor', 'advisor', 'Advisor', 'Management & Governance'],
  ['azurerm_resource_group', 'resource-groups', 'Resource Groups', 'Management & Governance'],
  ['azurerm_resource', 'resource-manager', 'Resource Manager', 'Management & Governance'],
  ['azurerm_management_lock', 'resource-locks', 'Resource Locks', 'Management & Governance'],
  ['azurerm_managed_application', 'managed-apps', 'Managed Applications', 'Management & Governance'],
  ['azurerm_dev_center', 'dev-box', 'Microsoft Dev Box', 'Management & Governance'],
  ['azurerm_load_test', 'load-testing', 'Load Testing', 'Management & Governance'],
  ['azurerm_arc', 'azure-arc', 'Azure Arc', 'Management & Governance'],
  ['azurerm_stack_hci', 'stack-hci', 'Azure Stack HCI', 'Management & Governance'],
  ['azurerm_stack', 'azure-stack', 'Azure Stack', 'Management & Governance'],
  ['azurerm_databox', 'data-box', 'Data Box', 'Management & Governance'],
  ['azurerm_system', 'system', 'System', 'Management & Governance'],
  ['azurerm_portal', 'portal', 'Portal', 'Management & Governance'],
  ['azurerm_custom_provider', 'custom-providers', 'Custom Providers', 'Management & Governance'],
  ['azurerm_managed_devops', 'devops-pool', 'Managed DevOps Pools', 'Management & Governance'],
  // "Azure Workloads" (Virtual Instances) — deliberately NOT named after the
  // workload it hosts: the source-genericity gate bans that estate term, and the
  // slug/name must stay account-agnostic (verify-source-genericity.ts).
  ['azurerm_workloads', 'workloads', 'Azure Workloads', 'Management & Governance'],
  // Identity
  ['azurerm_user_assigned_identity', 'managed-identity', 'Managed Identities', 'Identity'],
  ['azurerm_federated_identity', 'managed-identity', 'Managed Identities', 'Identity'],
  ['azurerm_role', 'rbac', 'Azure RBAC', 'Identity'],
  ['azurerm_active_directory', 'entra-ds', 'Entra Domain Services', 'Identity'],
  ['azurerm_aadb2c', 'ad-b2c', 'Azure AD B2C', 'Identity'],
  // fall-through additions (previously unmapped)
  ['azurerm_app_configuration', 'app-config', 'App Configuration', 'Web & App'],
  ['azurerm_application_load_balancer', 'app-gateway-containers', 'App Gateway for Containers', 'Networking'],
  ['azurerm_automanage', 'automanage', 'Automanage', 'Management & Governance'],
  ['azurerm_confidential_ledger', 'confidential-ledger', 'Confidential Ledger', 'Security'],
  ['azurerm_datadog', 'datadog', 'Datadog', 'Management & Governance'],
  ['azurerm_dynatrace', 'dynatrace', 'Dynatrace', 'Management & Governance'],
  ['azurerm_elastic_cloud', 'elastic', 'Elastic Cloud', 'Analytics'],
  ['azurerm_disk_access', 'disk', 'Managed Disks', 'Compute'],
  ['azurerm_disk_encryption_set', 'disk', 'Managed Disks', 'Compute'],
  ['azurerm_email_communication', 'communication', 'Communication Services', 'Integration'],
  ['azurerm_fluid_relay', 'fluid-relay', 'Fluid Relay', 'Web & App'],
  ['azurerm_graph_services', 'graph-services', 'Graph Services', 'Management & Governance'],
  ['azurerm_network_connection_monitor', 'network-watcher', 'Network Watcher', 'Networking'],
  ['azurerm_network_ddos_protection_plan', 'ddos', 'DDoS Protection', 'Networking'],
  ['azurerm_qumulo', 'qumulo', 'Qumulo', 'Storage'],
  ['azurerm_subscription', 'subscriptions', 'Subscriptions', 'Management & Governance'],
  ['azurerm_tenant_template_deployment', 'resource-manager', 'Resource Manager', 'Management & Governance'],
  // Full-coverage additions — provisionable types with no curated op that fell
  // through the rules above (each is a distinct portal service, so it gets its
  // own tile rather than the generic prefix fallback below).
  ['azurerm_application_security_group', 'app-security-group', 'Application Security Groups', 'Networking'],
  ['azurerm_extended', 'custom-locations', 'Custom Locations', 'Management & Governance'],
  ['azurerm_network_security_perimeter', 'nsp', 'Network Security Perimeter', 'Networking'],
  ['azurerm_new_relic', 'new-relic', 'New Relic', 'Management & Governance'],
  ['azurerm_point_to_site_vpn_gateway', 'virtual-wan', 'Virtual WAN', 'Networking'],
  ['azurerm_site_recovery', 'recovery-vault', 'Recovery Services Vault', 'Management & Governance'],
];

// classify() is deterministic and TOTAL: a curated SERVICES rule (longest prefix
// wins) when one matches, else a prefix-derived fallback so NO azurerm type is
// ever left unmapped (the aws twin has always been total; this makes azure match
// so "full coverage" can guarantee 0 unmapped). The fallback slug is the whole
// stripped type (unique per type → its own honest tile, never a wrong merge) —
// it only ever fires for a genuinely new type the curated rules don't yet name,
// which the generator prints so a human can add a rule.
function classify(type) {
  let best = null;
  for (const [prefix, slug, name, cat] of SERVICES) {
    if (type === prefix || type.startsWith(prefix + '_') || type.startsWith(prefix)) {
      if (!best || prefix.length > best[0].length) best = [prefix, slug, name, cat];
    }
  }
  if (best) return { slug: best[1], name: best[2], category: best[3], fallback: false };
  const stripped = type.replace(/^azurerm_/, '');
  const name = stripped.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { slug: stripped.replace(/_/g, '-'), name, category: 'Management & Governance', fallback: true };
}

/** The anchor prefix for a slug — the FIRST curated rule (array order) that
 * yields it, i.e. its most representative resource-type family. Used to pick a
 * service's primaryType (the type its "Provision" deep-link opens). */
function anchorFor(slug) {
  for (const [prefix, s] of SERVICES) if (s === slug) return prefix;
  return null;
}

/**
 * A handful of marquee services where the generic anchor heuristic below would
 * pick a secondary resource (e.g. sql → a database before its server). Curated
 * so the "Provision <service>" deep-link lands on the type a requester expects.
 * Each MUST be a provisionable type for its service (asserted at emit time).
 */
const PRIMARY_OVERRIDE = {
  'storage-account': 'azurerm_storage_account',
  sql: 'azurerm_mssql_server',
  cosmos: 'azurerm_cosmosdb_account',
  postgresql: 'azurerm_postgresql_flexible_server',
};

/** The representative provisionable type for a service — the type its Provision
 * deep-link opens. Prefer the curated override, else the provisionable type
 * closest to the service anchor (exact match, then anchor-prefixed), tie-broken
 * toward the most top-level (fewest segments), then shortest, then alphabetical.
 * Undefined when the service has NO provisionable type (an ops-only service —
 * it keeps its ops and simply shows no Provision action). */
function pickPrimaryType(slug, provTypes) {
  if (PRIMARY_OVERRIDE[slug] && provTypes.includes(PRIMARY_OVERRIDE[slug])) return PRIMARY_OVERRIDE[slug];
  if (provTypes.length === 0) return undefined;
  const anchor = anchorFor(slug);
  const rank = (t) => {
    if (!anchor) return 3;
    if (t === anchor) return 0;
    if (t.startsWith(anchor + '_')) return 1;
    if (t.startsWith(anchor)) return 2;
    return 3;
  };
  return provTypes.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const sa = a.split('_').length, sb = b.split('_').length;
    if (sa !== sb) return sa - sb;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : 1;
  })[0];
}

// The authoritative provisionable-type set (schema-derived) — the union with the
// op-target types below is what "full coverage" classifies. Each provisionable
// type is what the generic /provision form can actually stand up.
const CATALOG = JSON.parse(fs.readFileSync('src/data/provision-catalog.json', 'utf8'));
const provTypes = new Set(CATALOG.azure.map((e) => e.resourceType));

// walk the UNION of op-target types and provisionable types → the named service.
// svc[slug] tracks whether the service has any op (ops>0) and which of its types
// are provisionable (for primaryType). typeMap covers the whole union so
// azureServiceOf resolves every azurerm type the app can browse OR provision.
const svcOps = {};
const typeMap = {};
const fellBack = new Set();
const opTypes = new Set();
for (const f of azFiles) {
  const m = JSON.parse(fs.readFileSync(path.join(MDIR, f), 'utf8'));
  for (const op of m.operations) opTypes.add(op.target.resourceType);
}
for (const t of new Set([...opTypes, ...provTypes])) {
  const c = classify(t);
  if (c.fallback) fellBack.add(t);
  const s = (svcOps[c.slug] ??= { name: c.name, category: c.category, types: new Set(), provTypes: [], ops: 0 });
  s.types.add(t);
  if (opTypes.has(t)) s.ops++;
  if (provTypes.has(t)) s.provTypes.push(t);
  typeMap[t] = c.slug;
}
// primaryType per service (from its provisionable types)
for (const s of Object.keys(svcOps)) svcOps[s].primaryType = pickPrimaryType(s, svcOps[s].provTypes);

const slugs = Object.keys(svcOps).sort();
const withOps = slugs.filter((s) => svcOps[s].ops > 0);
const opless = slugs.filter((s) => svcOps[s].ops === 0);
const noPrimary = slugs.filter((s) => !svcOps[s].primaryType);
console.log(`NAMED SERVICES: ${slugs.length}  (full provisionable coverage — union of ops + provision catalog)`);
console.log(`  with ops: ${withOps.length}   op-less (Provision-only): ${opless.length}`);
console.log(`  services with no provisionable type (no Provision action): ${noPrimary.length}  [${noPrimary.join(', ')}]`);
const byCat = {};
for (const s of slugs) (byCat[svcOps[s].category] ??= []).push(s);
for (const [cat, list] of Object.entries(byCat).sort()) console.log(`  ${cat}: ${list.length}`);
console.log(`\nGENERIC-FALLBACK types (should be 0 — add a curated rule): ${fellBack.size}`);
[...fellBack].sort().forEach((t) => console.log('   ' + t));

// Assert every override actually points at a provisionable type of its service.
for (const [slug, type] of Object.entries(PRIMARY_OVERRIDE)) {
  if (svcOps[slug] && svcOps[slug].primaryType !== type) {
    throw new Error(`PRIMARY_OVERRIDE[${slug}]=${type} is not a provisionable type of that service`);
  }
}

fs.writeFileSync(process.argv[2] || '/tmp/azure-service-tiles.json',
  JSON.stringify({ services: Object.fromEntries(slugs.map((s) => [s, { ...svcOps[s], types: [...svcOps[s].types] }])), typeMap }, null, 1));
console.log(`\nwrote service+typeMap → ${process.argv[2] || '/tmp/azure-service-tiles.json'}`);

// a 2–3 char monogram for the icon-tile fallback (used when no curated glyph)
function monogram(name) {
  const words = name.replace(/[()]/g, '').split(/\s+/).filter((w) => !/^(for|the|of|and|&)$/i.test(w));
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}
// emit the committed TS data module the catalog + serviceMeta import from.
// primaryType is the type the service's "Provision" deep-link opens; it is
// omitted for the few services with no provisionable type (they keep their ops).
const entries = slugs.map((s) => {
  const v = svcOps[s];
  const primary = v.primaryType ? `, primaryType: '${v.primaryType}'` : '';
  return `  '${s}': { displayName: ${JSON.stringify(v.name)}, category: ${JSON.stringify(v.category)}, monogram: '${monogram(v.name)}'${primary} },`;
});
const typeEntries = Object.keys(typeMap).sort().map((t) => `  '${t}': '${typeMap[t]}',`);
const ts = `// GENERATED by scripts/gen-azure-service-tiles.mjs — do not hand-edit.
// Maps every provisionable azurerm type (the union of catalog-op targets AND the
// schema-derived provision catalog) to a portal-recognizable SERVICE, so the
// catalog browses all ${slugs.length} Azure services (full provisionable coverage:
// ${withOps.length} with ops + ${opless.length} Provision-only) rather than the 16 manifest files.
// Regenerate when Azure ops or the provision catalog change:
//   node scripts/gen-azure-service-tiles.mjs
// \`category\` is the portal grouping label; serviceMeta maps it to the app Category.
// \`primaryType\` is the representative provisionable type a service's Provision
// deep-link opens (/provision?type=…); absent when the service has no
// provisionable type (an ops-only service shows no Provision action).

export interface AzureServiceDef { displayName: string; category: string; monogram: string; primaryType?: string; }

/** Named Azure service → its display metadata (${slugs.length} services). */
export const AZURE_SERVICES: Record<string, AzureServiceDef> = {
${entries.join('\n')}
};

/** azurerm resource type → the named Azure service it belongs to. */
export const AZURE_TYPE_SERVICE: Record<string, string> = {
${typeEntries.join('\n')}
};

/** The named Azure service for a resource type, or undefined for a non-azure type. */
export function azureServiceOf(resourceType: string): string | undefined {
  return AZURE_TYPE_SERVICE[resourceType];
}
`;
fs.writeFileSync('src/lib/azureServiceMap.ts', ts);
console.log(`wrote src/lib/azureServiceMap.ts (${slugs.length} services, ${Object.keys(typeMap).length} type mappings)`);
