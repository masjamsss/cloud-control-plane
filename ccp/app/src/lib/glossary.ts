/**
 * A small static glossary of HCL / Terraform / AWS terms so an L1 learns the
 * language of the change, not just the change. Deterministic, no network, no AI.
 * Used by the review surface to explain the keywords that appear in a diff.
 */
export const GLOSSARY: Record<string, string> = {
  resource:
    'A managed piece of infrastructure Terraform creates and tracks (e.g. an EC2 instance).',
  data: 'A read-only lookup of something that already exists — Terraform reads it but never changes it.',
  variable: 'A named input to a module, often with a type and validation bounds.',
  output: 'A value a module exposes to its callers or to other modules.',
  lifecycle: 'A block that changes how Terraform creates, updates, or destroys a resource.',
  prevent_destroy:
    'A lifecycle guard that makes Terraform refuse to delete this resource — a safety catch on stateful things.',
  ignore_changes:
    'Tells Terraform to leave certain attributes alone even if they drift from the code.',
  create_before_destroy:
    'Replace a resource by building the new one before removing the old, to avoid downtime.',
  tags: 'Key/value metadata on a resource. Tags never affect how the resource runs. On Azure, tag NAMES are case-insensitive — Department and department are the same tag (unlike AWS).',
  for_each: 'Creates one copy of a resource per entry in a map or set, each with its own key.',
  count: 'Creates N numbered copies of a resource.',
  moved:
    'Records that a resource was renamed in the code so Terraform moves it in state instead of destroying and recreating it.',
  depends_on: 'Forces Terraform to create one resource only after another exists.',
  provider:
    'The plugin that talks to a platform (e.g. the AWS provider) — it defines every resource type.',
  instance_type: 'The EC2 size class that fixes a host’s vCPU and memory (e.g. r6i.xlarge).',
  ami: 'Amazon Machine Image — the disk image an EC2 instance boots from.',
  subnet_id: 'The subnet (a slice of a VPC in one Availability Zone) a resource lives in.',
  security_groups: 'Virtual firewalls attached to a resource that allow or deny network traffic.',
  vpc_security_group_ids:
    'The security groups (by id) attached to an instance’s network interface.',
  iam_instance_profile: 'The IAM role an EC2 instance assumes to get AWS permissions.',
  root_block_device: 'The boot disk of an EC2 instance.',
  ebs_block_device: 'An extra EBS data disk attached to an EC2 instance.',
  volume_size: 'The size of an EBS disk in GiB. EBS volumes can grow but never shrink in place.',
  volume_type: 'The EBS disk class (e.g. gp3, gp2) that fixes its baseline performance.',
  size: 'The size of an EBS volume in GiB — grow-only.',
  encrypted: 'Whether the disk is encrypted at rest with a KMS key.',
  kms_key_id: 'The KMS key used to encrypt this resource’s data at rest.',
  cidr_block:
    'An IP range in CIDR notation (e.g. 10.0.0.0/16) — the address space of a network or rule.',
  ingress: 'An inbound firewall rule — traffic allowed INTO a resource.',
  egress: 'An outbound firewall rule — traffic allowed OUT of a resource.',
  from_port: 'The low end of the port range a firewall rule covers.',
  to_port: 'The high end of the port range a firewall rule covers.',
  protocol: 'The network protocol a firewall rule matches (tcp, udp, icmp, or -1 for all).',

  // ── Azure-core vocabulary (0039 S1 lane L) ──
  resource_group:
    'The container Azure organizes related resources into — every resource lives in exactly one, and deleting a resource group deletes everything inside it.',
  location:
    'The Azure region a resource lives in (e.g. southeastasia) — Azure’s name for what AWS calls a region.',
  tenant:
    'The Microsoft Entra ID (Azure AD) organization identity lives in — one tenant can hold many subscriptions.',
  subscription:
    'The billing and access boundary for a set of Azure resources — roughly what an AWS account is to AWS.',
  managed_disk:
    'An Azure virtual machine’s disk, managed by Azure itself — roughly what an EBS volume is to an EC2 instance.',
  storage_account:
    'The Azure container for blob, file, queue, and table storage — everything inside it shares one name and one set of access keys.',
  key_vault:
    'Azure’s managed store for secrets, keys, and certificates — roughly what AWS Secrets Manager and KMS are together.',
  sku: 'The pricing and performance tier of an Azure resource (e.g. Standard_LRS) — it fixes capabilities and cost.',
  vm_size:
    'The Azure virtual machine size class that fixes its vCPU and memory (e.g. Standard_D2s_v5) — roughly what an EC2 instance type is to an EC2 instance.',

  // ── Azure attribute vocabulary an operator meets in curated-service diffs ──
  network_security_group:
    'An Azure firewall rule set attached to a subnet or network interface — roughly what an AWS security group is, but it lives as its own resource.',
  address_space:
    'The IP range in CIDR notation a virtual network owns (e.g. 10.0.0.0/16) — the Azure equivalent of a VPC’s address block.',
  address_prefixes:
    'The IP range in CIDR notation a subnet carves out of its virtual network’s address space.',
  account_tier:
    'The Azure storage account performance tier (Standard or Premium) — it fixes cost and capability and cannot change in place.',
  account_replication_type:
    'How many copies Azure keeps of storage data and where (LRS, GRS, ZRS…) — the durability and redundancy setting.',
  admin_username: 'The initial administrator login created on an Azure VM when it is built.',
  os_disk:
    'The boot disk of an Azure virtual machine — roughly what root_block_device is on an EC2 instance.',
  source_image_reference:
    'The marketplace or custom image an Azure VM boots from — the Azure equivalent of an AMI.',
  service_plan:
    'The compute tier that hosts Azure App Service web apps — it fixes the size and cost of the hosting.',
  public_network_access_enabled:
    'Whether a resource is reachable from the public internet — turning it off forces private-only access.',
  min_tls_version:
    'The lowest TLS version a resource will accept — raising it refuses older, weaker clients.',
  soft_delete_retention_days:
    'How long Azure keeps a deleted Key Vault secret recoverable before it is purged — a safety window.',
  purge_protection_enabled:
    'When on, Azure refuses to permanently delete a Key Vault or its secrets until the retention window elapses — a hard delete guard.',
  management_group:
    'A container above subscriptions that applies Azure policy and access rules to many subscriptions at once — the top of the governance hierarchy.',
  private_endpoint:
    'A private IP inside your virtual network that connects to an Azure service, keeping that traffic off the public internet.',
};

/** The glossary terms that appear as whole words in a piece of HCL text. */
export function termsInText(text: string): string[] {
  const found: string[] = [];
  for (const term of Object.keys(GLOSSARY)) {
    const re = new RegExp(`\\b${term}\\b`);
    if (re.test(text)) found.push(term);
  }
  return found;
}
