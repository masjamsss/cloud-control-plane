import type { ManifestOperation } from '@/types';
import { ENGINEER_DECIDES } from '@/lib/hclSkeleton';

/**
 * Golden-test fixtures for lib/hclSkeleton.ts (0033 A2). Each op is authored
 * to the master plan's Part-2 normative baseline shapes — the SAME shapes the
 * W3 baseline manifests implement — so the goldens pin the renderer against
 * the contract the real ops will exercise:
 *
 *   #1 EC2 host    — single block, nested blocks via param.path, tags map via
 *                    dotted attrs, const guardrails, engineer-decides TODOs,
 *                    prevent_destroy idiom.
 *   #2 EBS volume  — the multi-block volume + attachment idiom (AZ derived
 *                    from the attach-to host; device name on the attachment).
 *   #3 S3 bucket   — the estate 20/20/20 idiom: bucket + public-access block
 *                    + encryption config + versioning-when-chosen, with a
 *                    dependsOn-gated KMS key param.
 *   #4 mechanics   — wrap:"list" references, sensitive-value redaction, and
 *                    literal escaping in one compact op.
 *
 * These are TEST fixtures, not catalog data — the real baselines land in W3
 * as manifest JSON and MUST match Part 2 the same way these do.
 */

const common = {
  service: 'test',
  macd: 'Add',
  codemodOp: 'instantiate_module',
  riskFloor: 'HIGH',
  reversible: true,
  downtime: 'none',
  exposure: 'engineer_only',
  forcesReplace: false,
  autoEligible: false,
  terraformCapability: '+ create (new resource)',
  group: 'create',
  draftSkeleton: true,
} as const;

/* ── #1 — EC2 host (0034 §2.1 / 0033 §1.3) ─────────────────────────────────── */

export const ec2Baseline: ManifestOperation = {
  ...common,
  id: 'fixture-ec2-provision-instance',
  title: 'Provision a new EC2 instance',
  description: 'Fixture for skeleton golden #1.',
  target: { resourceType: 'aws_instance' },
  decisions: [
    'AMI selection and validation',
    'Static IP or elastic IP strategy',
    'IAM instance profile',
    'Placement and tenancy review',
  ],
  params: [
    {
      name: 'host_name',
      label: 'Host name',
      type: 'string',
      source: 'user_input',
      required: true,
      role: 'key',
      group: 'identity',
      bounds: { pattern: '^[a-z][a-z0-9-]{2,40}$' },
    },
    {
      name: 'instance_type',
      label: 'Instance size',
      type: 'string',
      source: 'allowlist',
      required: true,
      attr: 'instance_type',
      group: 'compute',
      bounds: { allowlist: ['m6i.xlarge', 'r6i.large'] },
      default: 'm6i.xlarge',
    },
    {
      name: 'ami',
      label: 'Machine image',
      type: 'string',
      source: 'allowlist',
      required: true,
      attr: 'ami',
      group: 'compute',
      bounds: { allowlist: ['engineer-decides'] },
      default: 'engineer-decides',
    },
    {
      name: 'key_pair',
      label: 'Key pair',
      type: 'string',
      source: 'inventory',
      enumSource: 'inventory://aws_key_pair/address',
      required: true,
      role: 'reference',
      refAttr: 'key_name',
      attr: 'key_name',
      group: 'compute',
    },
    {
      name: 'subnet',
      label: 'Subnet',
      type: 'string',
      source: 'inventory',
      enumSource: 'inventory://aws_subnet/address',
      required: true,
      role: 'reference',
      refAttr: 'id',
      attr: 'subnet_id',
      group: 'network',
    },
    {
      name: 'security_groups',
      label: 'Security groups',
      type: 'list',
      source: 'inventory',
      enumSource: 'inventory://aws_security_group/address',
      required: true,
      role: 'reference',
      refAttr: 'id',
      attr: 'vpc_security_group_ids',
      group: 'network',
      bounds: { minItems: 1, maxItems: 5 },
    },
    {
      name: 'private_ip',
      label: 'Fixed private IP',
      type: 'string',
      source: 'user_input',
      required: false,
      attr: 'private_ip',
      group: 'network',
      tier: 'advanced',
    },
    {
      name: 'associate_public_ip',
      label: 'Public IP',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: false,
      attr: 'associate_public_ip_address',
      group: 'network',
    },
    {
      name: 'termination_protection',
      label: 'Termination protection',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: true,
      attr: 'disable_api_termination',
      group: 'iam-storage',
    },
    {
      name: 'root_volume_gib',
      label: 'Root volume size (GiB)',
      type: 'number',
      source: 'user_input',
      required: true,
      attr: 'volume_size',
      path: ['root_block_device'],
      group: 'iam-storage',
      bounds: { min: 30, max: 1024 },
      default: 100,
    },
    {
      name: 'root_volume_type',
      label: 'Root volume type',
      type: 'string',
      source: 'allowlist',
      required: true,
      attr: 'volume_type',
      path: ['root_block_device'],
      group: 'iam-storage',
      bounds: { allowlist: ['gp3'] },
      default: 'gp3',
    },
    {
      name: 'root_encrypted',
      label: 'Root volume encryption',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: true,
      attr: 'encrypted',
      path: ['root_block_device'],
      group: 'iam-storage',
    },
    {
      name: 'imds_tokens',
      label: 'Instance metadata protection',
      type: 'string',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: 'required',
      attr: 'http_tokens',
      path: ['metadata_options'],
      group: 'iam-storage',
    },
    {
      name: 'resource_name',
      label: 'Server name tag',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.Name',
      group: 'tags',
    },
    {
      name: 'description_tag',
      label: 'What runs here',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.Description',
      group: 'tags',
    },
    {
      name: 'pic',
      label: 'Person in charge',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.PIC',
      group: 'tags',
    },
  ],
};

export const ec2Values: Record<string, unknown> = {
  host_name: 'app-03',
  instance_type: 'm6i.xlarge',
  ami: 'engineer-decides',
  key_pair: 'aws_key_pair.admin',
  subnet: 'aws_subnet.app_a',
  security_groups: ['aws_security_group.app', 'aws_security_group.mgmt'],
  private_ip: '',
  root_volume_gib: 200,
  root_volume_type: 'gp3',
  resource_name: 'APP-03',
  description_tag: 'Application server for the reporting cluster',
  pic: 'Ops team',
};

/* ── #2 — EBS volume + attachment (0034 §2.2) ──────────────────────────────── */

export const ebsBaseline: ManifestOperation = {
  ...common,
  id: 'fixture-ebs-create-volume',
  title: 'Create a new volume',
  description: 'Fixture for skeleton golden #2.',
  target: { resourceType: 'aws_ebs_volume' },
  decisions: [
    'Confirm the device name is free on the host',
    'Confirm the KMS key choice if the workload is key-scoped',
  ],
  params: [
    {
      name: 'volume_name',
      label: 'Volume name',
      type: 'string',
      source: 'user_input',
      required: true,
      role: 'key',
      attr: 'tags.Name',
    },
    {
      name: 'attach_to',
      label: 'Attach to server',
      type: 'string',
      source: 'inventory',
      enumSource: 'inventory://aws_instance/address',
      required: true,
      role: 'reference',
      refAttr: 'id',
    },
    {
      name: 'device_name',
      label: 'Device name',
      type: 'string',
      source: 'user_input',
      required: true,
      bounds: { pattern: '^/dev/sd[b-p]$' },
    },
    {
      name: 'size_gib',
      label: 'Size (GiB)',
      type: 'number',
      source: 'user_input',
      required: true,
      attr: 'size',
      bounds: { min: 8, max: 16384 },
      default: 100,
    },
    {
      name: 'volume_type',
      label: 'Volume type',
      type: 'string',
      source: 'allowlist',
      required: true,
      attr: 'type',
      bounds: { allowlist: ['gp3'] },
      default: 'gp3',
    },
    {
      name: 'iops',
      label: 'Extra speed (IOPS)',
      type: 'number',
      source: 'user_input',
      required: false,
      attr: 'iops',
      tier: 'advanced',
      bounds: { min: 3000, max: 16000 },
      default: 3000,
    },
    {
      name: 'throughput_mibps',
      label: 'Throughput (MiB per second)',
      type: 'number',
      source: 'user_input',
      required: false,
      attr: 'throughput',
      tier: 'advanced',
      bounds: { min: 125, max: 1000 },
      default: 125,
    },
    {
      name: 'encrypted',
      label: 'Encryption',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: true,
      attr: 'encrypted',
    },
    {
      name: 'kms_key',
      label: 'Encryption key',
      type: 'string',
      source: 'inventory',
      enumSource: 'inventory://aws_kms_key/address',
      required: false,
      role: 'reference',
      refAttr: 'arn',
      attr: 'kms_key_id',
      tier: 'advanced',
    },
    {
      name: 'snapshot',
      label: 'Start from a snapshot',
      type: 'string',
      source: 'user_input',
      required: false,
      attr: 'snapshot_id',
      tier: 'advanced',
      bounds: { pattern: '^snap-[0-9a-f]{8,17}$' },
    },
    {
      name: 'description_tag',
      label: 'What this volume holds',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.Description',
    },
    {
      name: 'pic',
      label: 'Person in charge',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.PIC',
    },
  ],
};

export const ebsValues: Record<string, unknown> = {
  volume_name: 'APP02 sdd',
  attach_to: 'aws_instance.app02',
  device_name: '/dev/sdd',
  size_gib: 500,
  volume_type: 'gp3',
  iops: 3000,
  throughput_mibps: 125,
  kms_key: '',
  snapshot: '',
  description_tag: 'Application data volume',
  pic: 'Ops team',
};

/* ── #3 — S3 bucket idiom (0034 §2.4) ──────────────────────────────────────── */

export const s3Baseline: ManifestOperation = {
  ...common,
  id: 'fixture-s3-create-bucket',
  title: 'Create a new bucket',
  description: 'Fixture for skeleton golden #3.',
  target: { resourceType: 'aws_s3_bucket' },
  decisions: [
    'Public exposure is never self-service; any public need is a separate engineer review',
    'Confirm bucket region and replication needs',
  ],
  params: [
    {
      name: 'bucket_name',
      label: 'Bucket name',
      type: 'string',
      source: 'user_input',
      required: true,
      role: 'key',
      attr: 'bucket',
      bounds: { pattern: '^[a-z0-9][a-z0-9.-]{2,62}$' },
    },
    {
      name: 'versioning',
      label: 'Keep old versions of objects?',
      type: 'bool',
      source: 'user_input',
      required: true,
    },
    {
      name: 'block_public_acls',
      label: 'Block public ACLs',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: true,
      attr: 'block_public_acls',
    },
    {
      name: 'block_public_policy',
      label: 'Block public policies',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: true,
      attr: 'block_public_policy',
    },
    {
      name: 'ignore_public_acls',
      label: 'Ignore public ACLs',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: true,
      attr: 'ignore_public_acls',
    },
    {
      name: 'restrict_public_buckets',
      label: 'Restrict public buckets',
      type: 'bool',
      source: 'allowlist',
      required: false,
      role: 'const',
      const: true,
      attr: 'restrict_public_buckets',
    },
    {
      name: 'encryption',
      label: 'Encryption type',
      type: 'string',
      source: 'allowlist',
      required: true,
      bounds: { allowlist: ['aws:kms', 'AES256'] },
      default: 'aws:kms',
    },
    {
      name: 'kms_key',
      label: 'Encryption key',
      type: 'string',
      source: 'inventory',
      enumSource: 'inventory://aws_kms_key/address',
      required: false,
      role: 'reference',
      refAttr: 'arn',
      dependsOn: { param: 'encryption', equals: 'aws:kms' },
    },
    {
      name: 'resource_name',
      label: 'Bucket name tag',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.Name',
    },
    {
      name: 'description_tag',
      label: 'What this bucket holds',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.Description',
    },
    {
      name: 'pic',
      label: 'Person in charge',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.PIC',
    },
  ],
};

export const s3Values: Record<string, unknown> = {
  bucket_name: 'finance-interface',
  versioning: true,
  encryption: 'aws:kms',
  kms_key: 'aws_kms_key.estate',
  resource_name: 'finance-interface',
  description_tag: 'Finance interface drop bucket',
  pic: 'Ops team',
};

/* ── #4 — mechanics: wrap:"list", sensitive redaction, literal escaping ────── */

export const mechanicsOp: ManifestOperation = {
  ...common,
  id: 'fixture-mechanics',
  title: 'Create a notification hook',
  description: 'Fixture for skeleton golden #4.',
  target: { resourceType: 'aws_sns_topic' },
  params: [
    {
      name: 'topic_name',
      label: 'Topic name',
      type: 'string',
      source: 'user_input',
      required: true,
      role: 'key',
      attr: 'name',
    },
    {
      name: 'notify',
      label: 'Notify topic',
      type: 'string',
      source: 'inventory',
      enumSource: 'inventory://aws_sns_topic/address',
      required: true,
      role: 'reference',
      refAttr: 'arn',
      wrap: 'list',
      attr: 'alarm_actions',
    },
    {
      name: 'display_name',
      label: 'Display name',
      type: 'string',
      source: 'user_input',
      required: false,
      attr: 'display_name',
    },
    {
      name: 'auth_token',
      label: 'Delivery token name',
      type: 'string',
      source: 'user_input',
      required: false,
      sensitive: true,
      attr: 'delivery_token',
    },
  ],
};

export const mechanicsValues: Record<string, unknown> = {
  topic_name: 'On-Call Alerts',
  notify: 'aws_sns_topic.oncall',
  display_name: 'quote " backslash \\ and ${interpolation}',
  auth_token: 'SuperSecretTokenValue12345678',
};

/* ── #5 — REPEATED nested blocks (list/set): N instances per block ──────────── */

/**
 * The repeated-block foundation golden. A DynamoDB table proves the renderer
 * emits N `<block> { … }` instances from ONE `param.repeated` param (the #1
 * structural gap the flat form's single-block-per-path fold could not express):
 *
 *   · `attribute` (mode "set")  — TWO instances, each a name + type;
 *   · `global_secondary_index` (mode "list") — ONE instance whose projection is
 *     the engineer-decides sentinel, proving a TODO renders INSIDE an instance
 *     (the sentinel is folded per-instance, never hoisted out of the block);
 *   · top-level attrs + a dotted `tags` map render in the SAME order they always
 *     did (attrs, then map, then the repeated child blocks) — the single-block
 *     path is untouched.
 */
export const repeatedBaseline: ManifestOperation = {
  ...common,
  id: 'fixture-dynamodb-create-table',
  title: 'Provision a new DynamoDB table',
  description: 'Fixture for the repeated-block skeleton golden.',
  target: { resourceType: 'aws_dynamodb_table' },
  decisions: ['Capacity mode, autoscaling, and streams are an engineer decision'],
  params: [
    {
      name: 'table_name',
      label: 'Table name',
      type: 'string',
      source: 'user_input',
      required: true,
      role: 'key',
      attr: 'name',
    },
    {
      name: 'billing_mode',
      label: 'Billing mode',
      type: 'string',
      source: 'allowlist',
      required: true,
      attr: 'billing_mode',
      bounds: { allowlist: ['PAY_PER_REQUEST', 'PROVISIONED'] },
      default: 'PAY_PER_REQUEST',
    },
    {
      name: 'hash_key',
      label: 'Partition key',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'hash_key',
    },
    {
      name: 'attributes',
      label: 'Attribute',
      type: 'list',
      source: 'user_input',
      required: true,
      bounds: { minItems: 1, maxItems: 20 },
      repeated: {
        mode: 'set',
        block: 'attribute',
        fields: [
          {
            name: 'name',
            label: 'Attribute name',
            type: 'string',
            source: 'user_input',
            required: true,
            attr: 'name',
          },
          {
            name: 'type',
            label: 'Attribute type',
            type: 'string',
            source: 'allowlist',
            required: true,
            attr: 'type',
            bounds: { allowlist: ['S', 'N', 'B'] },
          },
        ],
      },
    },
    {
      name: 'global_secondary_indexes',
      label: 'Global secondary index',
      type: 'list',
      source: 'user_input',
      required: false,
      repeated: {
        mode: 'list',
        block: 'global_secondary_index',
        fields: [
          {
            name: 'name',
            label: 'Index name',
            type: 'string',
            source: 'user_input',
            required: true,
            attr: 'name',
          },
          {
            name: 'hash_key',
            label: 'Index partition key',
            type: 'string',
            source: 'user_input',
            required: true,
            attr: 'hash_key',
          },
          {
            name: 'projection_type',
            label: 'Projection',
            type: 'string',
            source: 'allowlist',
            required: true,
            attr: 'projection_type',
            bounds: { allowlist: [ENGINEER_DECIDES] },
            default: ENGINEER_DECIDES,
          },
        ],
      },
    },
    {
      name: 'resource_name',
      label: 'Name tag',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.Name',
    },
    {
      name: 'description_tag',
      label: 'What this table holds',
      type: 'string',
      source: 'user_input',
      required: true,
      attr: 'tags.Description',
    },
  ],
};

export const repeatedValues: Record<string, unknown> = {
  table_name: 'orders-lookup',
  billing_mode: 'PAY_PER_REQUEST',
  hash_key: 'order_id',
  attributes: [
    { name: 'order_id', type: 'S' },
    { name: 'created_at', type: 'N' },
  ],
  global_secondary_indexes: [
    { name: 'by_created', hash_key: 'created_at', projection_type: ENGINEER_DECIDES },
  ],
  resource_name: 'orders-lookup',
  description_tag: 'Order lookup table for the checkout service',
};
