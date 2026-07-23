import type { InventoryResource } from '@/types';
import { isCloudResourceId, cloudIdTail } from '@/lib/providerDisplay';

/**
 * Humanized resource rendering. The resource cards used
 * to render raw Terraform: `alarm_action_sdp` as a display name, `memory_size
 * 256` as a chip, a full IAM role ARN across the card. The owner's verdict
 * (2026-07-14 Lambda screenshot): the default card state shows operator
 * words — the exact Terraform identifiers stay one layer down (the mono
 * address line, and hover on shortened values).
 *
 * Everything here is a pure lookup/format over inventory data
 * (deterministic, no model anywhere): a shared per-attribute label map with
 * units where known, an acronym-aware humanizer as the fallback, and
 * ARN-tail shortening with the full value preserved for hover. copyLint
 * holds the label side mechanically against every bundled inventory key.
 */

/** How many current-setting chips to surface before the row gets noisy. */
export const MAX_CHIPS = 4;

/** A snake_case-ish token — one underscore between word characters. Same
 * pattern copyLint bans from operator-facing labels. */
const SNAKE_TOKEN = /[A-Za-z0-9]_[A-Za-z0-9]/;

/**
 * Words the plain humanizer would mangle ("Az", "Iops", "Cidr"). Applied
 * per-word after splitting on underscores, so the fallback for an unmapped
 * attribute still reads right: `vpc_endpoint_type` → "VPC endpoint type".
 */
const ACRONYM_WORDS: Record<string, string> = {
  acl: 'ACL',
  acls: 'ACLs',
  ami: 'AMI',
  api: 'API',
  arn: 'ARN',
  asn: 'ASN',
  az: 'AZ',
  bgp: 'BGP',
  cidr: 'CIDR',
  db: 'DB',
  dns: 'DNS',
  ebs: 'EBS',
  efs: 'EFS',
  http: 'HTTP',
  https: 'HTTPS',
  iam: 'IAM',
  id: 'ID',
  iops: 'IOPS',
  ip: 'IP',
  ipv4: 'IPv4',
  ipv6: 'IPv6',
  kms: 'KMS',
  nfs: 'NFS',
  ntp: 'NTP',
  s3: 'S3',
  sns: 'SNS',
  ssl: 'SSL',
  tls: 'TLS',
  vpc: 'VPC',
  vpn: 'VPN',
};

interface ChipSpec {
  /** The operator-facing label for the chip ("Memory", never "memory_size"). */
  label: string;
  /** Unit suffix appended to numeric values ("256 MB", "60 s"). */
  unit?: string;
}

/**
 * The shared per-attribute label map (one map for every service's cards).
 * Curated where the humanized fallback would be wrong or where a unit is
 * known; everything else falls back to {@link humanizeAttr}. Labels here are
 * display copy and must pass copyLint's chip-label rule (no snake_case).
 */
export const CHIP_LABELS: Record<string, ChipSpec> = {
  // The owner's named examples (Lambda service page).
  memory_size: { label: 'Memory', unit: 'MB' },
  timeout: { label: 'Timeout', unit: 's' },
  reserved_concurrent_executions: { label: 'Reserved concurrency' },

  // Sizing and performance.
  size_gib: { label: 'Size', unit: 'GiB' },
  allocated_storage: { label: 'Storage', unit: 'GiB' },
  iops: { label: 'IOPS' },
  throughput: { label: 'Throughput', unit: 'MiB/s' },
  instance_type: { label: 'Type' },
  instance_class: { label: 'Class' },

  // Time and retention.
  retention_in_days: { label: 'Retention', unit: 'days' },
  backup_retention_period: { label: 'Backup retention', unit: 'days' },
  period: { label: 'Period', unit: 's' },

  // Identity and placement.
  az: { label: 'Availability zone' },
  availability_zone: { label: 'Availability zone' },
  ami: { label: 'AMI' },
  private_ip: { label: 'Private IP' },
  iam_instance_profile: { label: 'Instance profile' },
  key_name: { label: 'Key pair' },
  kms_key_id: { label: 'KMS key' },
  vpc_id: { label: 'VPC' },
  subnet_id: { label: 'Subnet' },
  cidr_block: { label: 'CIDR range' },
  ssl_policy: { label: 'TLS policy' },
  snapshot_id: { label: 'From snapshot' },
  multi_az: { label: 'Multi-AZ' },

  // ARN-bearing references — the value renders as its tail (see chipValue).
  role: { label: 'Role' },
  role_arn: { label: 'Role' },
  execution_role_arn: { label: 'Execution role' },
  listener_arn: { label: 'Listener' },
  policy_arn: { label: 'Policy' },
  web_acl_id: { label: 'Web ACL' },
  s3_bucket_name: { label: 'S3 bucket' },
};

/** Underscore-separated words → plain words, acronyms restored, first letter up. */
function humanizeWords(words: string[]): string {
  const mapped = words.map((w) => ACRONYM_WORDS[w.toLowerCase()] ?? w).join(' ');
  return mapped.length > 0 ? mapped.charAt(0).toUpperCase() + mapped.slice(1) : mapped;
}

/** Fallback label for an attribute with no curated entry: `block_public_acls` → "Block public ACLs". */
export function humanizeAttr(attr: string): string {
  return humanizeWords(attr.split('_').filter((w) => w.length > 0));
}

/** The operator-facing chip label for an inventory attribute key. */
export function chipLabelFor(attr: string): string {
  return CHIP_LABELS[attr]?.label ?? humanizeAttr(attr);
}

/** True for a cloud resource id — AWS ARN or Azure ARM path (name kept for call-site stability). */
export function isArn(value: string): boolean {
  return isCloudResourceId(value);
}

/**
 * The meaningful tail of a cloud resource id — an ARN's last path segment (or
 * last colon segment when the ARN has no path), or an ARM path's resource
 * name: a role ARN ends in the role's name, a KMS key ARN in the key id, an
 * ARM virtual network path in the vnet's name. The full value stays available
 * on hover. (Name kept for call-site stability.)
 */
export function arnTail(value: string): string {
  return cloudIdTail(value);
}

export interface ResourceChip {
  /** The raw attribute key — stable identity (React key), never displayed. */
  attr: string;
  /** Operator-facing label ("Memory"). */
  label: string;
  /** Display value, unit-suffixed / ARN-shortened ("256 MB"). */
  value: string;
  /** The full raw value when `value` was shortened — rendered as hover title. */
  full?: string;
}

/**
 * Format one inventory attribute value for display: booleans read Yes/No,
 * numbers carry their known unit, and ARNs shorten to their meaningful tail
 * with the full value preserved for a hover title. The SINGLE value-formatting
 * rule shared by the resource card's chips, the resource detail page's context
 * rows, and its capability "current value" readouts — so a value renders the
 * same everywhere it appears. Pure; string estate data renders verbatim.
 */
export function formatAttrValue(
  attr: string,
  raw: string | number | boolean,
): { value: string; full?: string } {
  if (typeof raw === 'boolean') return { value: raw ? 'Yes' : 'No' };
  if (typeof raw === 'number') {
    const unit = CHIP_LABELS[attr]?.unit;
    const n = raw.toLocaleString('en-US');
    return { value: unit ? `${n} ${unit}` : n };
  }
  if (isArn(raw)) {
    const tail = arnTail(raw);
    return tail === raw ? { value: raw } : { value: tail, full: raw };
  }
  return { value: raw };
}

/**
 * Every inventory attribute of a resource, in the builder's significance order,
 * as a labelled + formatted fact (no cap). The resource detail page reads the
 * whole set (summary strip + context rows); the resource card takes the first
 * {@link MAX_CHIPS} of it ({@link resourceChips}). One shared shaping so both
 * surfaces speak the same operator words and formats.
 */
export function resourceFacts(resource: InventoryResource): ResourceChip[] {
  return Object.entries(resource.attributes).map(([attr, raw]) => ({
    attr,
    label: chipLabelFor(attr),
    ...formatAttrValue(attr, raw),
  }));
}

/**
 * The current-setting chips for one resource card: the first {@link MAX_CHIPS}
 * inventory attributes (same selection as before D17 — the inventory builder
 * orders per-type attributes by significance), each with its humanized label
 * and formatted value. String values that are estate data (a security group's
 * description, a bucket name) render verbatim — display never falsifies what
 * an operator may need to search for; only labels, units, and ARN tails are
 * this module's to shape.
 */
export function resourceChips(resource: InventoryResource): ResourceChip[] {
  return resourceFacts(resource).slice(0, MAX_CHIPS);
}

/**
 * The card's primary label (D17a): prefer the friendly name (the estate's
 * Name-tag convention, carried as `resource.name`); when only a raw
 * Terraform label exists — `name` missing, or the builder fell back to the
 * address's label part, or a name that is itself a snake_case identifier —
 * humanize it. The exact Terraform address always stays as the card's
 * secondary mono line, so no truth is lost by prettifying this one.
 */
export function displayResourceLabel(resource: InventoryResource): string {
  const raw = resource.name ?? resource.address.split('.').pop() ?? resource.address;
  if (!SNAKE_TOKEN.test(raw)) return raw;
  return humanizeWords(raw.split('_').filter((w) => w.length > 0));
}
