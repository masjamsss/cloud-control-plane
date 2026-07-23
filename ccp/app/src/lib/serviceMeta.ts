import { AZURE_SERVICES } from './azureServiceMap';
import { AWS_SERVICES } from './awsServiceMap';
import type { CloudProvider } from './providerDisplay';

/**
 * Deterministic service registry — display name, category, and monogram per
 * service slug. The 8 curated AWS categories mirror the AWS console taxonomy;
 * both the azure portal and the full AWS console name a wider set of top-level
 * groups, so the union below EXTENDS the enum with the provider categories that
 * don't already exist (each reuses an existing icon tint — see serviceIcons.ts's
 * CATEGORY_ICON_CLASS). A provider's services never render in the same catalog
 * view as the other's (deriveServiceCatalog filters by the active project's
 * provider), so the taxonomies never collide. A slug with no entry falls back to
 * a title-cased name under "Developer & Mgmt Tools".
 */
export type Category =
  | 'Compute'
  | 'Storage'
  | 'Database'
  | 'Networking'
  | 'Observability'
  | 'Security & Identity'
  | 'Integration & Messaging'
  | 'Developer & Mgmt Tools'
  // ── Azure portal categories (135-service tile parity) — added so each portal
  // group renders distinctly; every one reuses an existing tint below.
  | 'Analytics'
  | 'Web & App'
  | 'Containers'
  | 'AI & ML'
  | 'IoT & Mobile'
  | 'Management & Governance'
  | 'Identity'
  // ── AWS console categories (133-service tile parity) — the console names
  // several top-level groups the curated 8 don't; added here so each renders
  // distinctly, every one reusing an existing tint below. AWS labels that DO map
  // onto an existing group fold via AWS_PORTAL_CATEGORY ('Compute'→'Compute',
  // 'Developer Tools'→'Developer & Mgmt Tools', 'Application Integration'→
  // 'Integration & Messaging', …).
  | 'Networking & Content Delivery'
  | 'Security, Identity & Compliance'
  | 'Machine Learning'
  | 'Migration & Transfer'
  | 'Media Services'
  | 'Front-End Web & Mobile'
  | 'IoT'
  | 'End User Computing'
  | 'Cost Management'
  | 'Game Tech';

export const CATEGORY_ORDER: Category[] = [
  'Compute',
  'Web & App',
  'Containers',
  'Storage',
  'Database',
  'Analytics',
  'Networking',
  'Networking & Content Delivery',
  'AI & ML',
  'Machine Learning',
  'IoT & Mobile',
  'IoT',
  'Front-End Web & Mobile',
  'Media Services',
  'End User Computing',
  'Game Tech',
  'Migration & Transfer',
  'Observability',
  'Security & Identity',
  'Security, Identity & Compliance',
  'Identity',
  'Integration & Messaging',
  'Management & Governance',
  'Cost Management',
  'Developer & Mgmt Tools',
];

/**
 * The azure portal's grouping-label string → the app Category it maps to. The
 * generated AZURE_SERVICES table (azureServiceMap.ts) tags each service with a
 * portal label; this is the one place that reconciles those labels with the app
 * enum. Labels that match an existing app group fold into it ('Databases' →
 * 'Database', 'Security' → 'Security & Identity', 'Integration' → 'Integration
 * & Messaging'); the rest are first-class app categories of their own.
 */
const PORTAL_CATEGORY: Record<string, Category> = {
  Compute: 'Compute',
  Networking: 'Networking',
  Storage: 'Storage',
  Databases: 'Database',
  Analytics: 'Analytics',
  'Web & App': 'Web & App',
  Containers: 'Containers',
  'AI & ML': 'AI & ML',
  Integration: 'Integration & Messaging',
  'IoT & Mobile': 'IoT & Mobile',
  Security: 'Security & Identity',
  'Management & Governance': 'Management & Governance',
  Identity: 'Identity',
};

/**
 * The AWS console's grouping-label string → the app Category it maps to — the
 * aws analogue of {@link PORTAL_CATEGORY}. The generated AWS_SERVICES table
 * (awsServiceMap.ts) tags each service with a console label; this reconciles
 * those labels with the app enum. Labels that match an existing app group fold
 * into it ('Compute'→'Compute', 'Developer Tools'→'Developer & Mgmt Tools',
 * 'Application Integration'→'Integration & Messaging'); the rest are first-class
 * app categories of their own. Anything unlisted (e.g. 'Business Applications',
 * 'Other AWS Services') falls back to 'Developer & Mgmt Tools', exactly as an
 * unlisted azure label does below.
 */
const AWS_PORTAL_CATEGORY: Record<string, Category> = {
  Compute: 'Compute',
  Storage: 'Storage',
  Database: 'Database',
  Analytics: 'Analytics',
  Containers: 'Containers',
  'Developer Tools': 'Developer & Mgmt Tools',
  'Management & Governance': 'Management & Governance',
  'Application Integration': 'Integration & Messaging',
  'Networking & Content Delivery': 'Networking & Content Delivery',
  'Security, Identity & Compliance': 'Security, Identity & Compliance',
  'Machine Learning': 'Machine Learning',
  'Migration & Transfer': 'Migration & Transfer',
  'Media Services': 'Media Services',
  'Front-End Web & Mobile': 'Front-End Web & Mobile',
  'Internet of Things': 'IoT',
  'End User Computing': 'End User Computing',
  'Cost Management': 'Cost Management',
  'Game Tech': 'Game Tech',
};

export interface ServiceMeta {
  slug: string;
  displayName: string;
  category: Category;
  monogram: string;
}

const REGISTRY: Record<string, Omit<ServiceMeta, 'slug'>> = {
  ec2: { displayName: 'EC2', category: 'Compute', monogram: 'EC' },
  autoscaling: { displayName: 'Auto Scaling', category: 'Compute', monogram: 'AS' },
  lambda: { displayName: 'Lambda', category: 'Compute', monogram: 'λ' },
  ecs: { displayName: 'ECS', category: 'Compute', monogram: 'CS' },
  eks: { displayName: 'EKS', category: 'Compute', monogram: 'K8' },

  ebs: { displayName: 'EBS', category: 'Storage', monogram: 'EB' },
  s3: { displayName: 'S3', category: 'Storage', monogram: 'S3' },
  efs: { displayName: 'EFS', category: 'Storage', monogram: 'EF' },
  fsx: { displayName: 'FSx', category: 'Storage', monogram: 'FX' },
  backup: { displayName: 'AWS Backup', category: 'Storage', monogram: 'BK' },

  rds: { displayName: 'RDS', category: 'Database', monogram: 'DB' },
  dynamodb: { displayName: 'DynamoDB', category: 'Database', monogram: 'DY' },
  aurora: { displayName: 'Aurora', category: 'Database', monogram: 'AU' },
  elasticache: { displayName: 'ElastiCache', category: 'Database', monogram: 'EC' },

  vpc: { displayName: 'VPC', category: 'Networking', monogram: 'VP' },
  'security-groups': { displayName: 'Security Groups', category: 'Networking', monogram: 'SG' },
  routing: { displayName: 'Routing', category: 'Networking', monogram: 'RT' },
  alb: { displayName: 'Load Balancing', category: 'Networking', monogram: 'LB' },
  route53: { displayName: 'Route 53', category: 'Networking', monogram: 'R5' },
  vpn: { displayName: 'VPN', category: 'Networking', monogram: 'VN' },
  cloudfront: { displayName: 'CloudFront', category: 'Networking', monogram: 'CF' },

  cloudwatch: { displayName: 'CloudWatch', category: 'Observability', monogram: 'CW' },
  cloudtrail: { displayName: 'CloudTrail', category: 'Observability', monogram: 'CT' },
  config: { displayName: 'Config', category: 'Observability', monogram: 'CG' },

  iam: { displayName: 'IAM', category: 'Security & Identity', monogram: 'IA' },
  kms: { displayName: 'KMS', category: 'Security & Identity', monogram: 'KM' },
  acm: { displayName: 'Certificate Manager', category: 'Security & Identity', monogram: 'CM' },
  waf: { displayName: 'WAF', category: 'Security & Identity', monogram: 'WF' },
  secretsmanager: {
    displayName: 'Secrets Manager',
    category: 'Security & Identity',
    monogram: 'SM',
  },
  guardduty: { displayName: 'GuardDuty', category: 'Security & Identity', monogram: 'GD' },

  sns: { displayName: 'SNS', category: 'Integration & Messaging', monogram: 'SN' },
  sqs: { displayName: 'SQS', category: 'Integration & Messaging', monogram: 'SQ' },
  eventbridge: { displayName: 'EventBridge', category: 'Integration & Messaging', monogram: 'EB' },

  ssm: { displayName: 'Systems Manager', category: 'Developer & Mgmt Tools', monogram: 'SS' },
  dlm: { displayName: 'Data Lifecycle Mgr', category: 'Developer & Mgmt Tools', monogram: 'DL' },
  licensemanager: {
    displayName: 'License Manager',
    category: 'Developer & Mgmt Tools',
    monogram: 'LM',
  },
  sagemaker: { displayName: 'SageMaker', category: 'Developer & Mgmt Tools', monogram: 'SG' },

  // ── Azure (0039 S1 lane L) ── the 9 azure-* service slugs the azure
  // manifest contract names (ccp/app/src/lib/providerDisplay.ts's
  // providerOfType). Grouped within the SAME ≤8-category set above — no new
  // category was added. A provider's services never render in the same
  // catalog view as the other's (lib/catalog.ts's deriveServiceCatalog
  // filters by the active project's own provider), so an azure slug sharing
  // a category — or even a monogram — with an aws slug is never a display
  // collision in practice.
  'azure-compute': { displayName: 'Virtual Machines', category: 'Compute', monogram: 'VM' },
  'azure-web': { displayName: 'App Service', category: 'Compute', monogram: 'AS' },
  'azure-containers': {
    displayName: 'Kubernetes & Containers',
    category: 'Compute',
    monogram: 'K8',
  },
  'azure-storage': { displayName: 'Storage Accounts', category: 'Storage', monogram: 'SA' },
  'azure-database': { displayName: 'SQL & Databases', category: 'Database', monogram: 'DB' },
  'azure-network': { displayName: 'Virtual Network', category: 'Networking', monogram: 'VN' },
  'azure-monitoring': { displayName: 'Monitoring', category: 'Observability', monogram: 'MN' },
  'azure-keyvault': { displayName: 'Key Vault', category: 'Security & Identity', monogram: 'KV' },
  'azure-core': {
    displayName: 'Resource Groups',
    category: 'Developer & Mgmt Tools',
    monogram: 'RG',
  },
  // ── Azure comprehensive tag surface (2026-07-18 auto-wire) — the long tail of
  // taggable, non-engineer-only azurerm types, grouped by family. Tag management
  // only; richer ops stay in the curated services above.
  'azure-integration': {
    displayName: 'Integration',
    category: 'Integration & Messaging',
    monogram: 'IN',
  },
  'azure-analytics': { displayName: 'Analytics', category: 'Database', monogram: 'AN' },
  'azure-ai': { displayName: 'AI & Search', category: 'Developer & Mgmt Tools', monogram: 'AI' },
  'azure-iot': { displayName: 'IoT', category: 'Integration & Messaging', monogram: 'IO' },
  'azure-other': {
    displayName: 'Other Azure Resources',
    category: 'Developer & Mgmt Tools',
    monogram: 'AZ',
  },
  // ── Azure CAF landing-zone (platform) services — engineer-gated first-class
  // constructs (governance + connectivity). These carry the platform's
  // policy/RBAC/lock/diagnostic and hub/firewall/gateway/DNS surfaces so the
  // portal recognizes and routes them to engineers, never blind self-service.
  'azure-governance': {
    displayName: 'Governance',
    category: 'Security & Identity',
    monogram: 'GV',
  },
  'azure-connectivity': { displayName: 'Connectivity', category: 'Networking', monogram: 'CN' },
};

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** The 135 named azure services (portal parity) resolve from the generated tile
 * map, with their portal label mapped onto the app Category enum. */
function azureMeta(slug: string): ServiceMeta | undefined {
  const az = AZURE_SERVICES[slug];
  if (!az) return undefined;
  return {
    slug,
    displayName: az.displayName,
    category: PORTAL_CATEGORY[az.category] ?? 'Developer & Mgmt Tools',
    monogram: az.monogram,
  };
}

/** The 133 named aws services (console parity) resolve the same way from their
 * generated tile map. REGISTRY is consulted FIRST in getServiceMeta, so the ~30
 * curated AWS slugs (ec2, s3, rds, …) keep their hand-tuned display/category
 * even though they are also AWS_SERVICES keys; only the long tail resolves here. */
function awsMeta(slug: string): ServiceMeta | undefined {
  const aw = AWS_SERVICES[slug];
  if (!aw) return undefined;
  return {
    slug,
    displayName: aw.displayName,
    category: AWS_PORTAL_CATEGORY[aw.category] ?? 'Developer & Mgmt Tools',
    monogram: aw.monogram,
  };
}

/**
 * Metadata (display name, category, monogram) for a service slug. Curated
 * REGISTRY entries win first; then the named-service tile maps. Exactly three
 * slugs live in BOTH tile maps — 'batch', 'dms', 'resource-groups', services
 * both clouds independently name — so `provider` (the active project's, which
 * the browse surfaces already know) decides which identity a shared slug shows:
 * an aws project sees aws DMS ("Database Migration Service", Migration & Transfer)
 * and an azure project sees azure DMS ("Database Migration", Database). Without a
 * hint azure wins (the unchanged pre-aws behavior); every NON-shared slug — 130
 * of the 133 aws and 132 of the 135 azure — resolves identically either way, so
 * the hint only ever disambiguates those three.
 */
export function getServiceMeta(slug: string, provider?: CloudProvider): ServiceMeta {
  const entry = REGISTRY[slug];
  if (entry) return { slug, ...entry };
  const first = provider === 'aws' ? awsMeta(slug) : azureMeta(slug);
  if (first) return first;
  const second = provider === 'aws' ? azureMeta(slug) : awsMeta(slug);
  if (second) return second;
  return {
    slug,
    displayName: titleCase(slug),
    category: 'Developer & Mgmt Tools',
    monogram: slug.slice(0, 2).toUpperCase(),
  };
}

/** True when a slug has polished metadata (vs. rendering via the fallback). */
export function hasServiceMeta(slug: string): boolean {
  return slug in REGISTRY || slug in AZURE_SERVICES || slug in AWS_SERVICES;
}

/**
 * The representative provisionable type a service's "Provision" action deep-links
 * to (/provision/<service>?type=…), or undefined when the service has no provisionable type
 * (an ops-only service — it shows no Provision action). Provider-scoped, so the
 * three slugs both clouds name resolve to the active project's own cloud type.
 */
export function primaryTypeFor(slug: string, provider?: CloudProvider): string | undefined {
  const first = provider === 'aws' ? AWS_SERVICES[slug] : AZURE_SERVICES[slug];
  if (first) return first.primaryType;
  const second = provider === 'aws' ? AZURE_SERVICES[slug] : AWS_SERVICES[slug];
  return second?.primaryType;
}
