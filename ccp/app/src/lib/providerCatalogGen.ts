/**
 * Provider-catalog generator core — PURE transforms from the Terraform AWS
 * provider's full schema dump (`terraform providers schema -json`) to the
 * compact, bundled provision catalog under `src/data/provider-catalog/`.
 *
 * This module has NO I/O so tests exercise every rule on small fixtures; the
 * CLI wrapper (scripts/gen-provider-catalog.ts) does the file reading/writing.
 * The app bundles only the small naming helpers (serviceForType / typeLabel /
 * serviceDisplayMeta, via src/lib/providerCatalog.ts) — the schema transform
 * itself runs at generation time and ships as JSON under
 * src/data/provider-catalog/.
 *
 * What the transform keeps and drops, per resource type:
 *   · KEEPS every fillable input: attributes that are required or optional
 *     (including optional+computed), with type, required and sensitive flags,
 *     plus nested block structure to a bounded depth.
 *   · DROPS computed-only attributes (they are outputs, not inputs),
 *     deprecated attributes, and the operational `timeouts` block.
 *   · Collapses anything deeper than {@link MAX_BLOCK_DEPTH} levels of nested
 *     blocks into a single JSON entry field (marked `json: 1`) so the giant
 *     recursive schemas (WAF rule statements, QuickSight dashboards) stay a
 *     few KB instead of megabytes.
 *
 * Service grouping rule (documented for reviewers):
 *   1. A resource type maps to a service by the LONGEST matching entry in
 *      {@link PREFIX_TO_SERVICE} (multi-word prefixes and console-truth
 *      merges, e.g. `api_gateway_*` + `apigatewayv2_*` → API Gateway,
 *      `db_*` → RDS, `cloudwatch_event_*` → EventBridge).
 *   2. Otherwise the first `_`-separated token after `aws_` is the service.
 *   3. Display name + category come from {@link SERVICE_META}; an unmapped
 *      slug falls back to a title-cased name in "Everything else".
 *
 * AZURE (0039): the same generator serves the azurerm provider. Grouping,
 * display names and categories for azure reuse the estate's already-curated
 * azure service map (lib/azureServiceMap.ts) and registry (lib/serviceMeta.ts)
 * — the single source of azure service truth the tile browse also uses — while
 * the schema compaction (attributes/blocks → CatalogResource) is shared. The
 * azurerm schemadump has a different on-disk shape than `terraform providers
 * schema -json`; {@link azurermSchemaToRaw} lifts it into the same
 * RawProviderSchemas the aws path consumes, so nothing downstream forks.
 */
import { azureServiceOf, AZURE_SERVICES } from './azureServiceMap';
import { getServiceMeta, CATEGORY_ORDER } from './serviceMeta';
import { stripProviderPrefix, type CloudProvider } from './providerDisplay';

/* ── Raw `terraform providers schema -json` shapes (the subset we read) ────── */

/** A cty type in the schema JSON: "string" | ["list","string"] | ["object",{…}] … */
export type RawCtyType = string | [string, RawCtyType] | [string, Record<string, unknown>];

export interface RawAttribute {
  type?: RawCtyType;
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  sensitive?: boolean;
  deprecated?: boolean;
  description?: string;
}

export interface RawBlock {
  attributes?: Record<string, RawAttribute>;
  block_types?: Record<string, RawBlockType>;
}

export interface RawBlockType {
  nesting_mode: 'single' | 'list' | 'set' | 'map' | 'group';
  block: RawBlock;
  min_items?: number;
  max_items?: number;
}

export interface RawResourceSchema {
  block: RawBlock;
}

export interface RawProviderSchemas {
  provider_schemas: Record<string, { resource_schemas: Record<string, RawResourceSchema> }>;
}

/* ── azurerm schemadump adapter (compile-and-reflect → RawProviderSchemas) ─── */

/** The synthetic provider key the azurerm dump lifts into — mirrors the aws
 * key shape so buildCatalog reads both the same way. */
export const AZURE_PROVIDER_KEY = 'registry.terraform.io/hashicorp/azurerm';

/** One attribute in the azurerm schemadump: a plain cty type as a STRING (with
 * `element_type` for collections), or — when it carries a `block` + a
 * `nesting_mode` — a nested block encoded inline. */
interface AzurermAttr {
  type?: string;
  element_type?: string;
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  sensitive?: boolean;
  deprecated?: boolean;
  nesting_mode?: string;
  single?: boolean;
  min_items?: number;
  max_items?: number;
  block?: { attributes?: Record<string, AzurermAttr> };
}

export interface AzurermSchemaDump {
  metadata?: { provider?: string; provider_version?: string; provider_tag?: string };
  resources: Record<string, { attributes?: Record<string, AzurermAttr> }>;
}

/** azurerm cty (plain string + element_type) → the tuple RawCtyType the aws
 * path uses. Collections of non-primitives (and object/dynamic) map to a
 * shape compactType folds to `json`, exactly as a deep aws type would. */
function azurermCty(a: AzurermAttr): RawCtyType {
  const t = a.type;
  if (t === 'string' || t === 'number' || t === 'bool') return t;
  if (t === 'list' || t === 'set' || t === 'map') {
    const et = a.element_type;
    if (et === 'string' || et === 'number' || et === 'bool') return [t, et];
    return [t, ['object', {}]];
  }
  return ['object', {}];
}

function azurermBlock(attrs: Record<string, AzurermAttr> | undefined): RawBlock {
  const attributes: Record<string, RawAttribute> = {};
  const block_types: Record<string, RawBlockType> = {};
  for (const [name, a] of Object.entries(attrs ?? {})) {
    if (a.block && a.nesting_mode) {
      const single = a.single === true || a.nesting_mode === 'single' || a.nesting_mode === 'group';
      const mode = (single ? 'single' : a.nesting_mode) as RawBlockType['nesting_mode'];
      block_types[name] = {
        nesting_mode: mode,
        block: azurermBlock(a.block.attributes),
        ...(a.min_items !== undefined ? { min_items: a.min_items } : {}),
        ...(a.max_items !== undefined ? { max_items: a.max_items } : {}),
      };
    } else {
      attributes[name] = {
        type: azurermCty(a),
        required: a.required,
        optional: a.optional,
        computed: a.computed,
        sensitive: a.sensitive,
        deprecated: a.deprecated,
      };
    }
  }
  return { attributes, block_types };
}

/** Lift the azurerm schemadump into the same RawProviderSchemas the aws path
 * consumes — the ONLY azure-shaped seam; everything after runs unchanged. */
export function azurermSchemaToRaw(dump: AzurermSchemaDump): RawProviderSchemas {
  const resource_schemas: Record<string, RawResourceSchema> = {};
  for (const [type, res] of Object.entries(dump.resources)) {
    resource_schemas[type] = { block: azurermBlock(res.attributes) };
  }
  return { provider_schemas: { [AZURE_PROVIDER_KEY]: { resource_schemas } } };
}

/* ── Compact catalog shapes (what ships in src/data/provider-catalog/) ─────── */

/** One fillable attribute, compact: n=name, t=type, r=required, s=sensitive,
 * et=element type for list/set when not string. */
export interface CatalogAttr {
  n: string;
  t: 'string' | 'number' | 'bool' | 'list' | 'map' | 'json';
  r?: 1;
  s?: 1;
  et?: 'number' | 'bool';
}

/** One nested block. m: how it repeats. `json: 1` marks a block collapsed to a
 * single JSON entry field (repeated blocks and anything past the depth cap). */
export interface CatalogBlock {
  n: string;
  m: 'single' | 'list' | 'set' | 'map';
  min?: number;
  max?: number;
  json?: 1;
  attrs: CatalogAttr[];
  blocks: CatalogBlock[];
}

export interface CatalogResource {
  attrs: CatalogAttr[];
  blocks: CatalogBlock[];
}

export interface CatalogServiceChunk {
  service: string;
  types: Record<string, CatalogResource>;
}

export interface CatalogTypeSummary {
  /** The Terraform resource type, e.g. "aws_sqs_queue". */
  t: string;
  /** Plain label for the thing this provisions, e.g. "Queue". */
  label: string;
  /** 1 marks the service's primary (default) resource type. */
  primary?: 1;
  /** Counts of fillable leaf settings (nested blocks included). */
  req: number;
  opt: number;
}

export interface CatalogServiceEntry {
  slug: string;
  name: string;
  category: string;
  types: CatalogTypeSummary[];
}

export interface CatalogIndex {
  provider: string;
  providerVersion: string;
  services: CatalogServiceEntry[];
}

export interface GeneratedCatalog {
  index: CatalogIndex;
  chunks: Map<string, CatalogServiceChunk>;
}

/* ── Grouping tables ───────────────────────────────────────────────────────── */

/** Nested blocks deeper than this collapse to one JSON entry field. */
export const MAX_BLOCK_DEPTH = 3;

/**
 * Longest-match prefix table (checked against the name AFTER `aws_`, each
 * entry ending in `_` or matching the whole remainder). Order does not matter
 * — the longest matching prefix wins. Everything not listed falls back to the
 * first token.
 */
export const PREFIX_TO_SERVICE: ReadonlyArray<readonly [string, string]> = [
  // API Gateway (v1 + v2 share one console)
  ['api_gateway', 'api-gateway'],
  ['apigatewayv2', 'api-gateway'],
  // EC2 family — instances and their launch/imaging plumbing
  ['instance', 'ec2'],
  ['ami', 'ec2'],
  ['key_pair', 'ec2'],
  ['launch_configuration', 'ec2'],
  ['launch_template', 'ec2'],
  ['placement_group', 'ec2'],
  ['spot', 'ec2'],
  ['network_interface', 'ec2'],
  // …but transit gateways and Client VPN live in their own consoles
  ['ec2_transit_gateway', 'transit-gateway'],
  ['ec2_client_vpn', 'vpn'],
  // EBS
  ['volume_attachment', 'ebs'],
  ['snapshot_create_volume_permission', 'ebs'],
  // VPC family
  ['subnet', 'vpc'],
  ['nat_gateway', 'vpc'],
  ['internet_gateway', 'vpc'],
  ['egress_only_internet_gateway', 'vpc'],
  ['flow_log', 'vpc'],
  ['network_acl', 'vpc'],
  ['default', 'vpc'],
  ['eip', 'vpc'],
  // Security groups (the estate's own service slug)
  ['security_group', 'security-groups'],
  ['vpc_security_group', 'security-groups'],
  // Routing (the estate's own service slug)
  ['route_table', 'routing'],
  ['route', 'routing'],
  ['main_route_table_association', 'routing'],
  // …Route 53 would otherwise be swallowed by the `route` prefix
  ['route53recoveryreadiness', 'route53-recovery'],
  ['route53recoverycontrolconfig', 'route53-recovery'],
  ['route53profiles', 'route53'],
  ['route53domains', 'route53'],
  ['route53', 'route53'],
  // VPN
  ['vpn', 'vpn'],
  ['customer_gateway', 'vpn'],
  // Load balancing (ALB/NLB/classic share the EC2 console section)
  ['lb', 'alb'],
  ['alb', 'alb'],
  ['elb', 'alb'],
  ['load_balancer', 'alb'],
  ['app_cookie_stickiness_policy', 'alb'],
  ['lb_cookie_stickiness_policy', 'alb'],
  ['proxy_protocol_policy', 'alb'],
  // RDS
  ['db', 'rds'],
  ['rds', 'rds'],
  // EventBridge (rules/targets/buses + schemas, pipes, scheduler)
  ['cloudwatch_event', 'eventbridge'],
  ['schemas', 'eventbridge'],
  ['pipes', 'eventbridge'],
  ['scheduler', 'eventbridge'],
  // CloudWatch keeps logs/alarms/dashboards + its sub-products
  ['cloudwatch', 'cloudwatch'],
  ['oam', 'cloudwatch'],
  ['observabilityadmin', 'cloudwatch'],
  ['synthetics', 'cloudwatch'],
  ['evidently', 'cloudwatch'],
  ['rum', 'cloudwatch'],
  ['applicationinsights', 'cloudwatch'],
  ['internetmonitor', 'cloudwatch'],
  // Simple mergers — the same console, several provider prefixes
  ['sesv2', 'ses'],
  ['wafregional', 'waf-classic'],
  ['waf', 'waf-classic'],
  ['wafv2', 'waf'],
  ['redshiftserverless', 'redshift'],
  ['redshiftdata', 'redshift'],
  ['opensearchserverless', 'opensearch'],
  ['elasticsearch', 'opensearch'],
  ['ssoadmin', 'iam-identity-center'],
  ['identitystore', 'iam-identity-center'],
  ['lexv2models', 'lex'],
  ['lex', 'lex'],
  ['chimesdkvoice', 'chime'],
  ['chimesdkmediapipelines', 'chime'],
  ['chime', 'chime'],
  ['pinpointsmsvoicev2', 'pinpoint'],
  ['pinpoint', 'pinpoint'],
  ['kinesis_firehose', 'firehose'],
  ['kinesis_video', 'kinesis-video'],
  ['kinesis_analytics', 'kinesis-analytics'],
  ['kinesisanalyticsv2', 'kinesis-analytics'],
  ['kinesis', 'kinesis'],
  ['emrcontainers', 'emr'],
  ['emrserverless', 'emr'],
  ['emr', 'emr'],
  ['inspector2', 'inspector'],
  ['inspector', 'inspector'],
  ['macie2', 'macie'],
  ['codestarconnections', 'codeconnections'],
  ['codeconnections', 'codeconnections'],
  ['codestarnotifications', 'codestar-notifications'],
  ['codegurureviewer', 'codeguru'],
  ['codeguruprofiler', 'codeguru'],
  ['dx', 'direct-connect'],
  ['directory_service', 'directory-service'],
  ['service_discovery', 'cloud-map'],
  ['servicecatalogappregistry', 'servicecatalog'],
  ['media_convert', 'mediaconvert'],
  ['media_package', 'mediapackage'],
  ['media_packagev2', 'mediapackage'],
  ['media_store', 'mediastore'],
  ['ivschat', 'ivs'],
  ['ivs', 'ivs'],
  ['mskconnect', 'msk'],
  ['msk', 'msk'],
  ['ecrpublic', 'ecr'],
  ['ecr', 'ecr'],
  ['workspacesweb', 'workspaces'],
  ['workspaces', 'workspaces'],
  ['customerprofiles', 'connect'],
  ['appautoscaling', 'application-autoscaling'],
  ['autoscalingplans', 'autoscaling'],
  ['autoscaling', 'autoscaling'],
  ['timestreamwrite', 'timestream'],
  ['timestreamquery', 'timestream'],
  ['timestreaminfluxdb', 'timestream'],
  ['cloudfrontkeyvaluestore', 'cloudfront'],
  ['cloudfront', 'cloudfront'],
  ['acmpca', 'acm-pca'],
  ['acm', 'acm'],
  ['s3control', 's3-control'],
  ['s3outposts', 's3-outposts'],
  ['s3tables', 's3-tables'],
  ['s3vectors', 's3-vectors'],
  ['s3files', 's3-files'],
  ['s3', 's3'],
  ['sfn', 'step-functions'],
  ['docdbelastic', 'docdb'],
  ['docdb', 'docdb'],
  ['neptunegraph', 'neptune-analytics'],
  ['neptune', 'neptune'],
  ['prometheus', 'managed-prometheus'],
  ['grafana', 'managed-grafana'],
  ['bedrockagentcore', 'bedrock-agentcore'],
  ['bedrockagent', 'bedrock'],
  ['bedrock', 'bedrock'],
  ['elastic_beanstalk', 'elastic-beanstalk'],
  ['elastictranscoder', 'elastic-transcoder'],
  ['globalaccelerator', 'global-accelerator'],
  ['networkfirewall', 'network-firewall'],
  ['networkmanager', 'network-manager'],
  ['networkmonitor', 'network-monitor'],
  ['networkflowmonitor', 'network-monitor'],
  ['resourceexplorer2', 'resource-explorer'],
  ['resourcegroups', 'resource-groups'],
  ['serverlessapplicationrepository', 'serverless-repo'],
  ['licensemanager', 'licensemanager'],
  ['accessanalyzer', 'access-analyzer'],
  ['vpclattice', 'vpc-lattice'],
  ['vpc_ipam', 'vpc-ipam'],
  ['vpc', 'vpc'],
] as const;

/** Display name + category for the curated services; the fallback is a
 * title-cased slug under "Everything else". Categories are plain words. */
export const SERVICE_META: Readonly<Record<string, { name: string; category: string }>> = {
  // Compute
  ec2: { name: 'EC2', category: 'Compute' },
  autoscaling: { name: 'Auto Scaling', category: 'Compute' },
  'application-autoscaling': { name: 'Application Auto Scaling', category: 'Compute' },
  lambda: { name: 'Lambda', category: 'Compute' },
  ecs: { name: 'ECS', category: 'Compute' },
  eks: { name: 'EKS', category: 'Compute' },
  ecr: { name: 'ECR', category: 'Compute' },
  batch: { name: 'Batch', category: 'Compute' },
  lightsail: { name: 'Lightsail', category: 'Compute' },
  'elastic-beanstalk': { name: 'Elastic Beanstalk', category: 'Compute' },
  apprunner: { name: 'App Runner', category: 'Compute' },
  imagebuilder: { name: 'Image Builder', category: 'Compute' },
  outposts: { name: 'Outposts', category: 'Compute' },
  // Storage
  s3: { name: 'S3', category: 'Storage' },
  's3-control': { name: 'S3 Control', category: 'Storage' },
  's3-outposts': { name: 'S3 on Outposts', category: 'Storage' },
  's3-tables': { name: 'S3 Tables', category: 'Storage' },
  's3-vectors': { name: 'S3 Vectors', category: 'Storage' },
  's3-files': { name: 'S3 File Gateway', category: 'Storage' },
  ebs: { name: 'EBS', category: 'Storage' },
  efs: { name: 'EFS', category: 'Storage' },
  fsx: { name: 'FSx', category: 'Storage' },
  backup: { name: 'AWS Backup', category: 'Storage' },
  glacier: { name: 'S3 Glacier', category: 'Storage' },
  storagegateway: { name: 'Storage Gateway', category: 'Storage' },
  dlm: { name: 'Data Lifecycle Mgr', category: 'Storage' },
  rbin: { name: 'Recycle Bin', category: 'Storage' },
  drs: { name: 'Elastic Disaster Recovery', category: 'Storage' },
  // Database
  rds: { name: 'RDS', category: 'Database' },
  dynamodb: { name: 'DynamoDB', category: 'Database' },
  dax: { name: 'DynamoDB Accelerator (DAX)', category: 'Database' },
  elasticache: { name: 'ElastiCache', category: 'Database' },
  memorydb: { name: 'MemoryDB', category: 'Database' },
  docdb: { name: 'DocumentDB', category: 'Database' },
  neptune: { name: 'Neptune', category: 'Database' },
  'neptune-analytics': { name: 'Neptune Analytics', category: 'Database' },
  keyspaces: { name: 'Keyspaces', category: 'Database' },
  qldb: { name: 'QLDB', category: 'Database' },
  timestream: { name: 'Timestream', category: 'Database' },
  dsql: { name: 'Aurora DSQL', category: 'Database' },
  // Networking
  vpc: { name: 'VPC', category: 'Networking' },
  'vpc-ipam': { name: 'VPC IP Address Manager', category: 'Networking' },
  'vpc-lattice': { name: 'VPC Lattice', category: 'Networking' },
  'security-groups': { name: 'Security Groups', category: 'Networking' },
  routing: { name: 'Routing', category: 'Networking' },
  alb: { name: 'Load Balancing', category: 'Networking' },
  route53: { name: 'Route 53', category: 'Networking' },
  'route53-recovery': { name: 'Route 53 Recovery', category: 'Networking' },
  vpn: { name: 'VPN', category: 'Networking' },
  cloudfront: { name: 'CloudFront', category: 'Networking' },
  'direct-connect': { name: 'Direct Connect', category: 'Networking' },
  'transit-gateway': { name: 'Transit Gateway', category: 'Networking' },
  'global-accelerator': { name: 'Global Accelerator', category: 'Networking' },
  'network-firewall': { name: 'Network Firewall', category: 'Networking' },
  'network-manager': { name: 'Network Manager', category: 'Networking' },
  'network-monitor': { name: 'Network Monitoring', category: 'Networking' },
  'cloud-map': { name: 'Cloud Map', category: 'Networking' },
  appmesh: { name: 'App Mesh', category: 'Networking' },
  'api-gateway': { name: 'API Gateway', category: 'Networking' },
  // Observability
  cloudwatch: { name: 'CloudWatch', category: 'Observability' },
  cloudtrail: { name: 'CloudTrail', category: 'Observability' },
  config: { name: 'Config', category: 'Observability' },
  xray: { name: 'X-Ray', category: 'Observability' },
  'managed-grafana': { name: 'Managed Grafana', category: 'Observability' },
  'managed-prometheus': { name: 'Managed Prometheus', category: 'Observability' },
  devopsguru: { name: 'DevOps Guru', category: 'Observability' },
  // Security & Identity
  iam: { name: 'IAM', category: 'Security & Identity' },
  'iam-identity-center': { name: 'IAM Identity Center', category: 'Security & Identity' },
  'access-analyzer': { name: 'IAM Access Analyzer', category: 'Security & Identity' },
  cognito: { name: 'Cognito', category: 'Security & Identity' },
  kms: { name: 'KMS', category: 'Security & Identity' },
  cloudhsm: { name: 'CloudHSM', category: 'Security & Identity' },
  acm: { name: 'Certificate Manager', category: 'Security & Identity' },
  'acm-pca': { name: 'Private Certificate Authority', category: 'Security & Identity' },
  secretsmanager: { name: 'Secrets Manager', category: 'Security & Identity' },
  waf: { name: 'WAF', category: 'Security & Identity' },
  'waf-classic': { name: 'WAF Classic', category: 'Security & Identity' },
  shield: { name: 'Shield', category: 'Security & Identity' },
  fms: { name: 'Firewall Manager', category: 'Security & Identity' },
  guardduty: { name: 'GuardDuty', category: 'Security & Identity' },
  securityhub: { name: 'Security Hub', category: 'Security & Identity' },
  securitylake: { name: 'Security Lake', category: 'Security & Identity' },
  detective: { name: 'Detective', category: 'Security & Identity' },
  macie: { name: 'Macie', category: 'Security & Identity' },
  inspector: { name: 'Inspector', category: 'Security & Identity' },
  verifiedaccess: { name: 'Verified Access', category: 'Security & Identity' },
  verifiedpermissions: { name: 'Verified Permissions', category: 'Security & Identity' },
  rolesanywhere: { name: 'Roles Anywhere', category: 'Security & Identity' },
  paymentcryptography: { name: 'Payment Cryptography', category: 'Security & Identity' },
  signer: { name: 'Signer', category: 'Security & Identity' },
  'directory-service': { name: 'Directory Service', category: 'Security & Identity' },
  auditmanager: { name: 'Audit Manager', category: 'Security & Identity' },
  // Integration & Messaging
  sns: { name: 'SNS', category: 'Integration & Messaging' },
  sqs: { name: 'SQS', category: 'Integration & Messaging' },
  eventbridge: { name: 'EventBridge', category: 'Integration & Messaging' },
  mq: { name: 'MQ', category: 'Integration & Messaging' },
  'step-functions': { name: 'Step Functions', category: 'Integration & Messaging' },
  swf: { name: 'SWF', category: 'Integration & Messaging' },
  appsync: { name: 'AppSync', category: 'Integration & Messaging' },
  appflow: { name: 'AppFlow', category: 'Integration & Messaging' },
  appintegrations: { name: 'AppIntegrations', category: 'Integration & Messaging' },
  mwaa: { name: 'Managed Airflow', category: 'Integration & Messaging' },
  // Analytics
  athena: { name: 'Athena', category: 'Analytics' },
  glue: { name: 'Glue', category: 'Analytics' },
  emr: { name: 'EMR', category: 'Analytics' },
  kinesis: { name: 'Kinesis Data Streams', category: 'Analytics' },
  'kinesis-analytics': { name: 'Kinesis Analytics', category: 'Analytics' },
  'kinesis-video': { name: 'Kinesis Video Streams', category: 'Analytics' },
  firehose: { name: 'Data Firehose', category: 'Analytics' },
  redshift: { name: 'Redshift', category: 'Analytics' },
  quicksight: { name: 'QuickSight', category: 'Analytics' },
  opensearch: { name: 'OpenSearch', category: 'Analytics' },
  msk: { name: 'Managed Kafka (MSK)', category: 'Analytics' },
  lakeformation: { name: 'Lake Formation', category: 'Analytics' },
  datazone: { name: 'DataZone', category: 'Analytics' },
  dataexchange: { name: 'Data Exchange', category: 'Analytics' },
  datapipeline: { name: 'Data Pipeline', category: 'Analytics' },
  finspace: { name: 'FinSpace', category: 'Analytics' },
  cleanrooms: { name: 'Clean Rooms', category: 'Analytics' },
  // Machine learning & AI
  sagemaker: { name: 'SageMaker', category: 'Machine learning & AI' },
  bedrock: { name: 'Bedrock', category: 'Machine learning & AI' },
  'bedrock-agentcore': { name: 'Bedrock AgentCore', category: 'Machine learning & AI' },
  comprehend: { name: 'Comprehend', category: 'Machine learning & AI' },
  kendra: { name: 'Kendra', category: 'Machine learning & AI' },
  lex: { name: 'Lex', category: 'Machine learning & AI' },
  polly: { name: 'Polly', category: 'Machine learning & AI' },
  transcribe: { name: 'Transcribe', category: 'Machine learning & AI' },
  rekognition: { name: 'Rekognition', category: 'Machine learning & AI' },
  qbusiness: { name: 'Q Business', category: 'Machine learning & AI' },
  // Media & Gaming
  medialive: { name: 'MediaLive', category: 'Media & Gaming' },
  mediaconvert: { name: 'MediaConvert', category: 'Media & Gaming' },
  mediapackage: { name: 'MediaPackage', category: 'Media & Gaming' },
  mediastore: { name: 'MediaStore', category: 'Media & Gaming' },
  'elastic-transcoder': { name: 'Elastic Transcoder', category: 'Media & Gaming' },
  ivs: { name: 'Interactive Video (IVS)', category: 'Media & Gaming' },
  gamelift: { name: 'GameLift', category: 'Media & Gaming' },
  // Business & end-user apps
  connect: { name: 'Connect', category: 'Business & end-user apps' },
  chime: { name: 'Chime', category: 'Business & end-user apps' },
  pinpoint: { name: 'Pinpoint', category: 'Business & end-user apps' },
  ses: { name: 'Simple Email Service', category: 'Business & end-user apps' },
  workspaces: { name: 'WorkSpaces', category: 'Business & end-user apps' },
  workmail: { name: 'WorkMail', category: 'Business & end-user apps' },
  worklink: { name: 'WorkLink', category: 'Business & end-user apps' },
  appstream: { name: 'AppStream', category: 'Business & end-user apps' },
  // Migration & Transfer
  transfer: { name: 'Transfer Family', category: 'Migration & Transfer' },
  datasync: { name: 'DataSync', category: 'Migration & Transfer' },
  dms: { name: 'Database Migration (DMS)', category: 'Migration & Transfer' },
  mgn: { name: 'Application Migration (MGN)', category: 'Migration & Transfer' },
  // IoT & Edge
  iot: { name: 'IoT Core', category: 'IoT & Edge' },
  greengrass: { name: 'Greengrass', category: 'IoT & Edge' },
  // Developer & Mgmt Tools
  ssm: { name: 'Systems Manager', category: 'Developer & Mgmt Tools' },
  ssmcontacts: { name: 'Incident Manager Contacts', category: 'Developer & Mgmt Tools' },
  ssmincidents: { name: 'Incident Manager', category: 'Developer & Mgmt Tools' },
  ssmquicksetup: { name: 'Systems Manager Quick Setup', category: 'Developer & Mgmt Tools' },
  cloudformation: { name: 'CloudFormation', category: 'Developer & Mgmt Tools' },
  codebuild: { name: 'CodeBuild', category: 'Developer & Mgmt Tools' },
  codecommit: { name: 'CodeCommit', category: 'Developer & Mgmt Tools' },
  codedeploy: { name: 'CodeDeploy', category: 'Developer & Mgmt Tools' },
  codepipeline: { name: 'CodePipeline', category: 'Developer & Mgmt Tools' },
  codeartifact: { name: 'CodeArtifact', category: 'Developer & Mgmt Tools' },
  codecatalyst: { name: 'CodeCatalyst', category: 'Developer & Mgmt Tools' },
  codeconnections: { name: 'CodeConnections', category: 'Developer & Mgmt Tools' },
  'codestar-notifications': { name: 'CodeStar Notifications', category: 'Developer & Mgmt Tools' },
  codeguru: { name: 'CodeGuru', category: 'Developer & Mgmt Tools' },
  amplify: { name: 'Amplify', category: 'Developer & Mgmt Tools' },
  cloud9: { name: 'Cloud9', category: 'Developer & Mgmt Tools' },
  devicefarm: { name: 'Device Farm', category: 'Developer & Mgmt Tools' },
  servicecatalog: { name: 'Service Catalog', category: 'Developer & Mgmt Tools' },
  servicequotas: { name: 'Service Quotas', category: 'Developer & Mgmt Tools' },
  organizations: { name: 'Organizations', category: 'Developer & Mgmt Tools' },
  account: { name: 'Account Management', category: 'Developer & Mgmt Tools' },
  controltower: { name: 'Control Tower', category: 'Developer & Mgmt Tools' },
  ram: { name: 'Resource Access Manager', category: 'Developer & Mgmt Tools' },
  'resource-groups': { name: 'Resource Groups', category: 'Developer & Mgmt Tools' },
  'resource-explorer': { name: 'Resource Explorer', category: 'Developer & Mgmt Tools' },
  licensemanager: { name: 'License Manager', category: 'Developer & Mgmt Tools' },
  chatbot: { name: 'Chatbot', category: 'Developer & Mgmt Tools' },
  notifications: { name: 'User Notifications', category: 'Developer & Mgmt Tools' },
  notificationscontacts: { name: 'User Notifications Contacts', category: 'Developer & Mgmt Tools' },
  budgets: { name: 'Budgets', category: 'Developer & Mgmt Tools' },
  ce: { name: 'Cost Explorer', category: 'Developer & Mgmt Tools' },
  cur: { name: 'Cost and Usage Reports', category: 'Developer & Mgmt Tools' },
  billing: { name: 'Billing', category: 'Developer & Mgmt Tools' },
  invoicing: { name: 'Invoicing', category: 'Developer & Mgmt Tools' },
  savingsplans: { name: 'Savings Plans', category: 'Developer & Mgmt Tools' },
  costoptimizationhub: { name: 'Cost Optimization Hub', category: 'Developer & Mgmt Tools' },
  computeoptimizer: { name: 'Compute Optimizer', category: 'Developer & Mgmt Tools' },
  bcmdataexports: { name: 'Billing Data Exports', category: 'Developer & Mgmt Tools' },
  cloudcontrolapi: { name: 'Cloud Control API', category: 'Developer & Mgmt Tools' },
  'serverless-repo': { name: 'Serverless Application Repository', category: 'Developer & Mgmt Tools' },
  appconfig: { name: 'AppConfig', category: 'Developer & Mgmt Tools' },
  fis: { name: 'Fault Injection Service', category: 'Developer & Mgmt Tools' },
  resiliencehub: { name: 'Resilience Hub', category: 'Developer & Mgmt Tools' },
  uxc: { name: 'Account Customizations (UXC)', category: 'Developer & Mgmt Tools' },
  // Stragglers the prefix fallback finds but the title-caser would mangle
  appfabric: { name: 'AppFabric', category: 'Business & end-user apps' },
  location: { name: 'Location Service', category: 'Business & end-user apps' },
  arcregionswitch: { name: 'ARC Region Switch', category: 'Networking' },
  arczonalshift: { name: 'ARC Zonal Shift', category: 'Networking' },
  cloudsearch: { name: 'CloudSearch', category: 'Analytics' },
  osis: { name: 'OpenSearch Ingestion', category: 'Analytics' },
  m2: { name: 'Mainframe Modernization (M2)', category: 'Migration & Transfer' },
  odb: { name: 'Oracle Database@AWS', category: 'Database' },
};

/** Fixed category order for the provision page (plain names). */
export const PROVIDER_CATEGORY_ORDER: readonly string[] = [
  'Compute',
  'Storage',
  'Database',
  'Networking',
  'Observability',
  'Security & Identity',
  'Integration & Messaging',
  'Analytics',
  'Machine learning & AI',
  'Media & Gaming',
  'Business & end-user apps',
  'Migration & Transfer',
  'IoT & Edge',
  'Developer & Mgmt Tools',
  'Everything else',
];

/** Curated primary (default) resource type per service, where the shortest-name
 * heuristic would pick the wrong front door. */
const PRIMARY_TYPE: Readonly<Record<string, string>> = {
  ec2: 'aws_instance',
  rds: 'aws_db_instance',
  alb: 'aws_lb',
  vpc: 'aws_vpc',
  s3: 'aws_s3_bucket',
  lambda: 'aws_lambda_function',
  dynamodb: 'aws_dynamodb_table',
  sqs: 'aws_sqs_queue',
  sns: 'aws_sns_topic',
  ecs: 'aws_ecs_service',
  eks: 'aws_eks_cluster',
  efs: 'aws_efs_file_system',
  iam: 'aws_iam_role',
  kms: 'aws_kms_key',
  route53: 'aws_route53_zone',
  cloudwatch: 'aws_cloudwatch_metric_alarm',
  eventbridge: 'aws_cloudwatch_event_rule',
  'api-gateway': 'aws_api_gateway_rest_api',
  cloudfront: 'aws_cloudfront_distribution',
  elasticache: 'aws_elasticache_cluster',
  redshift: 'aws_redshift_cluster',
  secretsmanager: 'aws_secretsmanager_secret',
  autoscaling: 'aws_autoscaling_group',
  backup: 'aws_backup_plan',
  'security-groups': 'aws_security_group',
  routing: 'aws_route_table',
  opensearch: 'aws_opensearch_domain',
};

/* ── Grouping ──────────────────────────────────────────────────────────────── */

const sortedPrefixes = [...PREFIX_TO_SERVICE].sort((a, b) => b[0].length - a[0].length);

/** The service slug a resource type belongs to (see the module-header rule).
 * azurerm types defer to the estate's curated azure map (azureServiceOf), the
 * same grouping the tile browse uses; an unmapped azure type falls back to its
 * first token, exactly as an unmapped aws type does.
 *
 * Why the provision catalog groups azure into MORE services than the ~155-tile
 * browse: the browse tiles are curated from the azure MANIFEST ops + a curated
 * type-prefix table (scripts/gen-azure-service-tiles.mjs) — a portal-parity
 * shortlist of the services an operator recognizes. The provision catalog is
 * deliberately EXHAUSTIVE instead: it stands up ANY of the ~1141 provider-
 * supported azurerm types (the aws catalog is exhaustive the same way), so the
 * ~740 child sub-resources the curated map doesn't name (azurerm_storage_blob,
 * azurerm_api_management_api, …) fall back to a first-token slug rather than
 * being dropped. Those fall-back services render with a clean title-cased name
 * under "Everything else" (serviceDisplayMeta) — never a junk or cross-cloud
 * label — so the fuller set stays legible. The two views are intentionally
 * different scopes (curated browse vs exhaustive provision), not a drift. */
export function serviceForType(resourceType: string): string {
  if (resourceType.startsWith('azurerm_')) {
    const rest = stripProviderPrefix(resourceType);
    return azureServiceOf(resourceType) ?? (rest.split('_')[0] ?? rest);
  }
  const rest = resourceType.replace(/^aws_/, '');
  for (const [prefix, slug] of sortedPrefixes) {
    if (rest === prefix || rest.startsWith(prefix + '_')) return slug;
  }
  return rest.split('_')[0] ?? rest;
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function serviceDisplayMeta(
  slug: string,
  provider: CloudProvider = 'aws',
): { name: string; category: string } {
  if (provider === 'azure') {
    // A CURATED azure service (one of the tile browse's ~155 in AZURE_SERVICES)
    // keeps its portal display name + category. An UNMAPPED slug is the first
    // token of an azurerm child sub-resource the curated map doesn't name
    // (azurerm_storage_blob → "storage", azurerm_api_management_api → "api") —
    // one of the long tail the exhaustive provision catalog covers BEYOND the
    // browse (see serviceForType). It must NOT resolve through getServiceMeta,
    // whose REGISTRY is consulted first and would stamp an AWS identity on it
    // (slug "backup" → "AWS Backup"). Instead it gets a clean title-cased name
    // under "Everything else" — the SAME long-tail discipline the aws branch
    // below applies to an unmapped aws slug.
    if (slug in AZURE_SERVICES) {
      const meta = getServiceMeta(slug, 'azure');
      return { name: meta.displayName, category: meta.category };
    }
    return { name: titleCase(slug), category: 'Everything else' };
  }
  return SERVICE_META[slug] ?? { name: titleCase(slug), category: 'Everything else' };
}

/** The plain label for a resource type within its service: the humanized
 * remainder after the matched service prefix ("aws_sqs_queue" → "Queue"). An
 * azurerm type title-cases its whole name-after-prefix ("azurerm_container_
 * registry" → "Container Registry") — azure service slugs are short codes
 * (acr, aks), not type prefixes, so there is nothing to strip. */
export function typeLabel(resourceType: string): string {
  if (resourceType.startsWith('azurerm_')) {
    const words = stripProviderPrefix(resourceType).split('_').filter((w) => w.length > 0);
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  const rest = resourceType.replace(/^aws_/, '');
  let remainder = rest;
  for (const [prefix] of sortedPrefixes) {
    if (rest === prefix) {
      remainder = prefix.split('_').pop() ?? prefix;
      break;
    }
    if (rest.startsWith(prefix + '_')) {
      remainder = rest.slice(prefix.length + 1);
      break;
    }
  }
  if (remainder === rest) {
    const afterToken = rest.split('_').slice(1).join('_');
    remainder = afterToken.length > 0 ? afterToken : rest;
  }
  const words = remainder.split('_').filter((w) => w.length > 0);
  const first = words[0] ?? remainder;
  const label = [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
  return label;
}

/* ── Attribute + block compaction ──────────────────────────────────────────── */

function isObjectType(t: RawCtyType | undefined): boolean {
  if (t === undefined) return false;
  if (typeof t === 'string') return t === 'object' || t === 'dynamic';
  const [kind, inner] = t;
  if (kind === 'object' || kind === 'tuple') return true;
  return isObjectType(inner as RawCtyType);
}

/** Map a raw cty type onto the compact vocabulary (see CatalogAttr). */
export function compactType(t: RawCtyType | undefined): Pick<CatalogAttr, 't' | 'et'> {
  if (t === undefined) return { t: 'string' };
  if (typeof t === 'string') {
    if (t === 'string') return { t: 'string' };
    if (t === 'number') return { t: 'number' };
    if (t === 'bool') return { t: 'bool' };
    return { t: 'json' };
  }
  if (isObjectType(t)) return { t: 'json' };
  const [kind, inner] = t;
  if (kind === 'list' || kind === 'set') {
    if (inner === 'number' || inner === 'bool') return { t: 'list', et: inner };
    if (inner === 'string') return { t: 'list' };
    return { t: 'json' };
  }
  if (kind === 'map') {
    return inner === 'string' || inner === 'number' || inner === 'bool' ? { t: 'map' } : { t: 'json' };
  }
  return { t: 'json' };
}

/** A fillable input: required, or optional (optional+computed counts). */
function isFillable(a: RawAttribute): boolean {
  if (a.deprecated) return false;
  return a.required === true || a.optional === true;
}

function compactAttrs(raw: Record<string, RawAttribute> | undefined, topLevel = false): CatalogAttr[] {
  const out: CatalogAttr[] = [];
  for (const [name, a] of Object.entries(raw ?? {})) {
    if (!isFillable(a)) continue;
    // A resource's own `id` is its identifier, never a provisioning input —
    // the provider marks it optional+computed on nearly every type. Same for
    // `tags_all` (the provider-merged tag map; `tags` is the real input).
    if (topLevel && (name === 'id' || name === 'tags_all') && !a.required) continue;
    const attr: CatalogAttr = { n: name, ...compactType(a.type) };
    if (a.required) attr.r = 1;
    if (a.sensitive) attr.s = 1;
    out.push(attr);
  }
  out.sort((a, b) => (b.r ?? 0) - (a.r ?? 0) || a.n.localeCompare(b.n));
  return out;
}

function compactBlock(name: string, raw: RawBlockType, depth: number): CatalogBlock | null {
  // `timeouts` is operational tuning, not a provisioning parameter.
  if (name === 'timeouts') return null;
  const single = raw.nesting_mode === 'single' || raw.nesting_mode === 'group' || raw.max_items === 1;
  const m: CatalogBlock['m'] = single
    ? 'single'
    : raw.nesting_mode === 'set'
      ? 'set'
      : raw.nesting_mode === 'map'
        ? 'map'
        : 'list';
  const block: CatalogBlock = { n: name, m, attrs: [], blocks: [] };
  if (raw.min_items !== undefined && raw.min_items > 0) block.min = raw.min_items;
  if (raw.max_items !== undefined && raw.max_items > 0 && !single) block.max = raw.max_items;

  if (depth >= MAX_BLOCK_DEPTH) {
    // Past the cap the whole subtree becomes one JSON entry field.
    block.json = 1;
    return block;
  }
  block.attrs = compactAttrs(raw.block.attributes);
  for (const [childName, child] of Object.entries(raw.block.block_types ?? {})) {
    const compact = compactBlock(childName, child, depth + 1);
    if (compact) block.blocks.push(compact);
  }
  block.blocks.sort((a, b) => a.n.localeCompare(b.n));
  return block;
}

export function compactResource(raw: RawResourceSchema): CatalogResource {
  const attrs = compactAttrs(raw.block.attributes, true);
  const blocks: CatalogBlock[] = [];
  for (const [name, bt] of Object.entries(raw.block.block_types ?? {})) {
    const compact = compactBlock(name, bt, 1);
    if (compact) blocks.push(compact);
  }
  blocks.sort((a, b) => a.n.localeCompare(b.n));
  return { attrs, blocks };
}

/** Count fillable leaf settings (block subtrees collapsed to JSON count as 1). */
export function countLeaves(res: CatalogResource): { req: number; opt: number } {
  let req = 0;
  let opt = 0;
  const walkAttrs = (attrs: CatalogAttr[]): void => {
    for (const a of attrs) {
      if (a.r) req += 1;
      else opt += 1;
    }
  };
  const walkBlocks = (blocks: CatalogBlock[]): void => {
    for (const b of blocks) {
      if (b.json || b.m !== 'single') {
        // One entry field stands for the whole repeated/deep subtree.
        if (b.min && b.min > 0) req += 1;
        else opt += 1;
        continue;
      }
      walkAttrs(b.attrs);
      walkBlocks(b.blocks);
    }
  };
  walkAttrs(res.attrs);
  walkBlocks(res.blocks);
  return { req, opt };
}

/* ── The whole-catalog build ───────────────────────────────────────────────── */

/** Pick the service's default type: curated override, else shortest name.
 * The azure override is the estate's own primaryType (AZURE_SERVICES), the
 * same front door the tile browse deep-links. */
export function primaryTypeFor(
  slug: string,
  types: string[],
  provider: CloudProvider = 'aws',
): string {
  const curated = provider === 'azure' ? AZURE_SERVICES[slug]?.primaryType : PRIMARY_TYPE[slug];
  if (curated && types.includes(curated)) return curated;
  return [...types].sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? '';
}

export function buildCatalog(
  raw: RawProviderSchemas,
  provider: CloudProvider = 'aws',
): GeneratedCatalog {
  const providerKey =
    provider === 'azure' ? AZURE_PROVIDER_KEY : 'registry.terraform.io/hashicorp/aws';
  const providerName = provider === 'azure' ? 'hashicorp/azurerm' : 'hashicorp/aws';
  const providerVersion = provider === 'azure' ? '4.81.0' : '6.53.0';
  const categoryOrder = provider === 'azure' ? CATEGORY_ORDER : PROVIDER_CATEGORY_ORDER;

  const schemas = raw.provider_schemas[providerKey]?.resource_schemas;
  if (!schemas) throw new Error(`no resource_schemas under provider key ${providerKey}`);

  const byService = new Map<string, string[]>();
  for (const type of Object.keys(schemas).sort()) {
    const slug = serviceForType(type);
    const list = byService.get(slug);
    if (list) list.push(type);
    else byService.set(slug, [type]);
  }

  const chunks = new Map<string, CatalogServiceChunk>();
  const entries: CatalogServiceEntry[] = [];
  for (const [slug, types] of byService) {
    const meta = serviceDisplayMeta(slug, provider);
    const chunk: CatalogServiceChunk = { service: slug, types: {} };
    const primary = primaryTypeFor(slug, types, provider);
    const summaries: CatalogTypeSummary[] = [];
    for (const type of types) {
      const res = compactResource(schemas[type]!);
      chunk.types[type] = res;
      const { req, opt } = countLeaves(res);
      const summary: CatalogTypeSummary = { t: type, label: typeLabel(type), req, opt };
      if (type === primary) summary.primary = 1;
      summaries.push(summary);
    }
    summaries.sort((a, b) => (b.primary ?? 0) - (a.primary ?? 0) || a.label.localeCompare(b.label));
    chunks.set(slug, chunk);
    entries.push({ slug, name: meta.name, category: meta.category, types: summaries });
  }

  const catOrder = new Map(categoryOrder.map((c, i) => [c, i]));
  entries.sort((a, b) => {
    const ca = catOrder.get(a.category) ?? categoryOrder.length;
    const cb = catOrder.get(b.category) ?? categoryOrder.length;
    return ca - cb || a.name.localeCompare(b.name);
  });

  return {
    index: { provider: providerName, providerVersion, services: entries },
    chunks,
  };
}
