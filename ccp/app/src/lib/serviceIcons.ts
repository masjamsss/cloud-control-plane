import type { Category } from '@/lib/serviceMeta';

/**
 * Per-service icon glyphs — a cohesive, license-safe AWS-style line set. Each
 * value is the inner markup of a 24×24 SVG (stroke inherits currentColor from
 * the tinted tile; see ServiceIcon). A slug with no glyph falls back to its
 * monogram, so coverage can grow without breaking anything.
 */

/** Category → the CSS modifier that tints the icon tile (see svc-icon.css / tokens).
 * EVERY Category must have an entry or ServiceIcon renders an untinted tile — the
 * added azure portal + aws console categories reuse the existing eight tints (no
 * new CSS). */
export const CATEGORY_ICON_CLASS: Record<Category, string> = {
  Compute: 'compute',
  Storage: 'storage',
  Database: 'database',
  Networking: 'networking',
  Observability: 'observability',
  'Security & Identity': 'security',
  'Integration & Messaging': 'integration',
  'Developer & Mgmt Tools': 'devtools',
  // ── Azure portal categories — reuse an existing tint each (see serviceMeta.ts).
  Analytics: 'database',
  'Web & App': 'compute',
  Containers: 'compute',
  'AI & ML': 'devtools',
  'IoT & Mobile': 'integration',
  'Management & Governance': 'devtools',
  Identity: 'security',
  // ── AWS console categories — reuse an existing tint each (see serviceMeta.ts).
  'Networking & Content Delivery': 'networking',
  'Security, Identity & Compliance': 'security',
  'Machine Learning': 'devtools',
  'Migration & Transfer': 'storage',
  'Media Services': 'compute',
  'Front-End Web & Mobile': 'compute',
  IoT: 'integration',
  'End User Computing': 'compute',
  'Cost Management': 'devtools',
  'Game Tech': 'compute',
};

/* Style contract for every glyph: viewBox 0 0 24 24, no fill, stroke inherited,
   stroke-width 1.7, round caps/joins, ~2–5 primitives, recognizable motif. */
export const SERVICE_GLYPHS: Record<string, string> = {
  // Compute
  ec2: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.2"/><rect x="9.7" y="9.7" width="4.6" height="4.6" rx=".6"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/>',
  lambda: '<path d="M7 5h2.3l7 14"/><path d="M14.6 5 7 19"/>',
  autoscaling: '<path d="M5 19v-3M10 19v-7M15 19v-10"/><path d="M16.8 8.8 19.3 6.3l2.5 2.5"/>',
  // Storage
  s3: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6l1.3 12.2a1 1 0 0 0 1 .9h9.4a1 1 0 0 0 1-.9L19 6"/>',
  ebs: '<rect x="4" y="6.5" width="16" height="4.5" rx="1"/><rect x="4" y="13" width="16" height="4.5" rx="1"/><path d="M7 8.75h.01M7 15.25h.01"/>',
  efs: '<rect x="7" y="3.5" width="10" height="12" rx="1"/><path d="M7 7.5H4.5v13h12v-2.5"/>',
  backup:
    '<rect x="4" y="6" width="16" height="13" rx="1.5"/><path d="M4 10h16"/><circle cx="12" cy="14.5" r="2.6"/><path d="M12 13v1.6l1.1.8"/>',
  // Database
  rds: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  dynamodb:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M12.8 9.2 10 13.2h3.2L10.8 17"/>',
  // Networking
  vpc: '<path d="M7.2 18a4 4 0 0 1-.6-8 5 5 0 0 1 9.7-1.3A3.6 3.6 0 0 1 16.8 18Z"/>',
  'security-groups':
    '<path d="M12 3 5.2 5.8v5.1c0 4.4 2.9 7.8 6.8 9.6 3.9-1.8 6.8-5.2 6.8-9.6V5.8Z"/>',
  alb: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="18.5" r="2"/><circle cx="12" cy="18.5" r="2"/><circle cx="19" cy="18.5" r="2"/><path d="M12 7v2.5m0 0-6 6.5m6-6.5v6.5m0-6.5 6 6.5"/>',
  route53:
    '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="3.4" ry="8"/><path d="M4 12h16"/>',
  cloudfront:
    '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6"/><path d="M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3"/>',
  vpn: '<rect x="9.5" y="10.2" width="5" height="4" rx="1"/><path d="M10.6 10.2V9.1a1.4 1.4 0 0 1 2.8 0v1.1"/><circle cx="4.6" cy="12.2" r="1.7"/><circle cx="19.4" cy="12.2" r="1.7"/><path d="M6.3 12.2h3.2M14.5 12.2H17.7"/>',
  routing:
    '<circle cx="6" cy="6.5" r="2"/><path d="M8 6.5h5.5a3.5 3.5 0 0 1 3.5 3.5v6"/><path d="M15 14l2 2.2 2-2.2"/>',
  // Observability
  cloudwatch:
    '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l3.8-3.8"/><circle cx="12" cy="16" r="1.1"/>',
  config:
    '<rect x="5" y="4.5" width="14" height="15" rx="1.5"/><path d="M9 3.5h6v3H9z"/><path d="M8.5 11l1.4 1.4 3-3M8.5 16l1.4 1.4 3-3"/>',
  cloudtrail:
    '<path d="M5.5 6.5h13M5.5 10.5h13M5.5 14.5h7"/><circle cx="15.8" cy="16" r="3"/><path d="M18 18.2 20.5 20.7"/>',
  // Security & Identity
  iam: '<circle cx="12" cy="8" r="3.2"/><path d="M5.6 19a6.4 6.4 0 0 1 12.8 0"/>',
  kms: '<circle cx="8.2" cy="12" r="3.4"/><path d="M11.6 12H21l-2.2 2.2M16.4 12v3.4"/>',
  waf: '<path d="M12 3 5.2 5.8v5.1c0 4.4 2.9 7.8 6.8 9.6 3.9-1.8 6.8-5.2 6.8-9.6V5.8Z"/><path d="M8.8 11.8 11 14l4.2-4.4"/>',
  secretsmanager:
    '<rect x="6" y="10.8" width="12" height="8.4" rx="1.6"/><path d="M8.8 10.8V8a3.2 3.2 0 0 1 6.4 0v2.8"/><circle cx="12" cy="14.6" r="1.1"/><path d="M12 15.7v1.6"/>',
  acm: '<rect x="4" y="4.5" width="16" height="11" rx="1.2"/><path d="M7 8.5h10M7 11.5h6"/><circle cx="15.5" cy="17" r="2.4"/><path d="M13.8 18.6 13.2 21.5l2.3-1.2 2.3 1.2-.6-2.9"/>',
  // Integration & Messaging
  eventbridge:
    '<circle cx="12" cy="12" r="2.4"/><circle cx="5" cy="6" r="1.7"/><circle cx="19" cy="6" r="1.7"/><circle cx="12" cy="20" r="1.7"/><path d="M10.4 10.4 6.3 7.3M13.6 10.4l4.1-3.1M12 14.4v3.8"/>',
  sns: '<circle cx="12" cy="12" r="2"/><path d="M8.6 8.6a5 5 0 0 0 0 6.8M15.4 8.6a5 5 0 0 1 0 6.8M6.2 6.2a8.5 8.5 0 0 0 0 11.6M17.8 6.2a8.5 8.5 0 0 1 0 11.6"/>',
  // Developer & Mgmt Tools
  ssm: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M5.9 5.9l2.1 2.1M16 16l2.1 2.1M18.1 5.9 16 8M8 16l-2.1 2.1"/>',
  dlm: '<path d="M6 8.5a7 7 0 0 1 12.2 1"/><path d="M18.4 5v4.5h-4.5"/><path d="M18 15.5a7 7 0 0 1-12.2-1"/><path d="M5.6 19v-4.5h4.5"/>',
  sagemaker:
    '<circle cx="7" cy="8" r="1.7"/><circle cx="7" cy="16" r="1.7"/><circle cx="13.5" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/><path d="M8.5 8.7 12 11.2M8.5 15.3 12 12.8M15.2 12H17.3"/>',
  licensemanager:
    '<rect x="5" y="4" width="14" height="16" rx="1.5"/><path d="M8 9h8M8 12h5"/><circle cx="15" cy="15.5" r="2.2"/><path d="M13.9 15.7 15 16.8l1.5-1.6"/>',

  // ── Azure (0039) — same style contract (24×24, stroke, 1.7, round, 2–5
  // primitives, recognizable motif). Category tint comes from serviceMeta.
  // Compute — a VM screen with an inner window + stand.
  'azure-compute':
    '<rect x="4" y="5.5" width="16" height="11" rx="1.5"/><rect x="7" y="8.3" width="6" height="5" rx=".6"/><path d="M9 20h6M12 16.5V20"/>',
  // Resource Groups — corner brackets around a grouped box (a resource boundary).
  'azure-core':
    '<path d="M8 4.5H5.5A1.5 1.5 0 0 0 4 6v2M16 4.5h2.5A1.5 1.5 0 0 1 20 6v2M8 19.5H5.5A1.5 1.5 0 0 1 4 18v-2M16 19.5h2.5a1.5 1.5 0 0 0 1.5-1.5v-2"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>',
  // Virtual Network — three connected nodes (a private network).
  'azure-network':
    '<circle cx="12" cy="5.6" r="2"/><circle cx="5.6" cy="17" r="2"/><circle cx="18.4" cy="17" r="2"/><path d="M12 7.6 6.7 15M12 7.6 17.3 15M7.6 17h8.8"/>',
  // Storage Accounts — a layered storage box (blades of storage).
  'azure-storage':
    '<rect x="4.5" y="6" width="15" height="12" rx="1.5"/><path d="M4.5 10h15M4.5 14h15"/><path d="M7.6 8h.01M7.6 12h.01M7.6 16h.01"/>',
  // SQL & Databases — the database cylinder.
  'azure-database':
    '<ellipse cx="12" cy="6" rx="6.5" ry="2.6"/><path d="M5.5 6v12c0 1.5 2.9 2.6 6.5 2.6s6.5-1.1 6.5-2.6V6"/><path d="M5.5 12c0 1.5 2.9 2.6 6.5 2.6s6.5-1.1 6.5-2.6"/>',
  // Key Vault — a vault box with a keyhole + key shaft.
  'azure-keyvault':
    '<rect x="4.5" y="5.5" width="15" height="13" rx="1.5"/><circle cx="10" cy="12" r="2.5"/><path d="M12.4 12H16.5M15 12v2M16.5 12v2"/>',
  // App Service — a browser window with an app play-mark.
  'azure-web':
    '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 9h16"/><path d="M6.5 7h.01M8.4 7h.01"/><path d="M10 15l2.4-2.8L14.8 15"/>',
  // Kubernetes & Containers — a hexagon helm with a hub + spokes.
  'azure-containers':
    '<path d="M12 3.5 18.9 7.5v9L12 20.5 5.1 16.5v-9Z"/><circle cx="12" cy="12" r="2.3"/><path d="M12 7.2v2.5M9.3 13.4l2.1-1.2M14.7 13.4l-2.1-1.2"/>',
  // Monitoring — a dashboard screen with a pulse line + stand.
  'azure-monitoring':
    '<rect x="3.5" y="5.5" width="17" height="11" rx="1.5"/><path d="M6 12l2.4-3 2 4 2.4-5 2 4H18"/><path d="M9 20h6M12 16.5V20"/>',
  // Governance — a policy shield with an enforcement check (management groups, Policy, RBAC).
  'azure-governance':
    '<path d="M12 3.5 19 6v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z"/><path d="M9 11.5l2 2 4-4"/>',
  // Connectivity — a central hub wired to four spokes (hub-and-spoke reachability).
  'azure-connectivity':
    '<circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="4.5" r="1.6"/><circle cx="12" cy="19.5" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="19.5" cy="12" r="1.6"/><path d="M12 6.1v3.5M12 14.4v3.5M6.1 12h3.5M14.4 12h3.5"/>',
  // Integration — two components linked by a flow arrow (logic/integration).
  'azure-integration':
    '<rect x="4" y="4.5" width="7" height="7" rx="1"/><rect x="13" y="12.5" width="7" height="7" rx="1"/><path d="M11 8h3.5a2 2 0 0 1 2 2v2.5"/><path d="M15 11.5 16.5 13l1.5-1.5"/>',
  // Analytics — ascending bars on a baseline.
  'azure-analytics':
    '<path d="M4 19.5h16"/><rect x="5.5" y="12" width="3" height="6" rx=".4"/><rect x="10.5" y="8" width="3" height="10" rx=".4"/><rect x="15.5" y="4.5" width="3" height="13.5" rx=".4"/>',
  // AI & Search — a large + small sparkle (the modern AI motif).
  'azure-ai':
    '<path d="M11 3.5l1.5 3.9 3.9 1.5-3.9 1.5L11 14.3 9.5 10.4 5.6 8.9l3.9-1.5z"/><path d="M17.5 13.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  // IoT — a central hub with three connected devices.
  'azure-iot':
    '<circle cx="12" cy="12" r="2.2"/><rect x="3.5" y="4" width="4.5" height="3.4" rx=".6"/><rect x="16" y="4" width="4.5" height="3.4" rx=".6"/><rect x="9.75" y="17" width="4.5" height="3.4" rx=".6"/><path d="M6.4 7.4 10.5 10.5M17.6 7.4 13.5 10.5M12 14.2v2.8"/>',
  // Other Azure Resources — a 3-D cube (a generic resource).
  'azure-other':
    '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8Z"/><path d="M4 8l8 4.5M20 8l-8 4.5M12 12.5v8"/>',
};

/**
 * Headline named-azure services (135-service tile parity) reuse the glyph of
 * their azure family so the most-recognized tiles look rich instead of falling
 * back to a monogram. The long tail keeps its monogram — an acceptable, already
 * supported render for glyph-less slugs. Aliased here (rather than duplicating
 * the SVG) so a family glyph edit flows through automatically.
 */
const AZURE_GLYPH_ALIASES: Record<string, string> = {
  vm: 'azure-compute',
  sql: 'azure-database',
  cosmos: 'azure-database',
  redis: 'azure-database',
  'storage-account': 'azure-storage',
  'key-vault': 'azure-keyvault',
  aks: 'azure-containers',
  acr: 'azure-containers',
  'app-service': 'azure-web',
  functions: 'azure-web',
  vnet: 'azure-network',
  'load-balancer': 'azure-network',
  'event-hubs': 'azure-analytics',
  'service-bus': 'azure-integration',
  'log-analytics': 'azure-monitoring',
};

for (const [named, family] of Object.entries(AZURE_GLYPH_ALIASES)) {
  const glyph = SERVICE_GLYPHS[family];
  if (glyph) SERVICE_GLYPHS[named] = glyph;
}
