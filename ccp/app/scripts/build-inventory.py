#!/usr/bin/env python3
"""Deterministically build a Cloud Control Plane inventory.json from a Terraform root's
*.tf and *.tf.json files (defaults to environments/prod, account 123456789012).
Resources in generically-named files (main.tf, etc.) are scanned too — their
service comes from the manifests, since the filename carries none (B4: foreign
repos keep resources in main.tf; this estate names files per service). Values
come straight from HCL — nothing is invented. Only resource types the Cloud Control Plane
manifests manage are included; attribute KEYS match what the manifests/ops
expect (e.g. EBS `size` is surfaced as `size_gib` so grow-only validation
works).

Usage:  pip install python-hcl2  &&  python3 ccp/app/scripts/build-inventory.py
        [--root <dir>] [--out <file>] [--imports <file>] [--manifests <dir>]
        [--summary <file>]
Defaults reproduce the original hardcoded behavior exactly (environments/prod
-> ccp/app/src/data/inventory.json, importer/prod/imports.tf, this repo's
manifests dir), so the no-flags invocation is unchanged. --root points this at
any other Terraform root (e.g. an onboarded/foreign repo); --manifests points
it at another catalog's manifest set; --imports is optional — a root with no
matching imports.tf (the common case outside this estate) is handled
gracefully (a WARN, not a crash), just without the subnet->AZ join enrichment
that file feeds. --summary writes a machine-readable JSON run summary (counts,
warnings, provider pins) for upload metadata. 0014 fix#4 (docs/proposals/
0014-day2-readiness/5-reusability-onboarding.md): this script previously had
zero CLI surface, making it unusable for any repo but this one, including
onboarding's own `importer/bootstrap` second project.

Local modules (parity with extract-blocks.ts's 0014 dim-5 rule): a local
`module "<name>" { source = "./dir" }` called exactly once, with no
count/for_each on the call and no module blocks of its own, has its
resources emitted with the real `module.<name>.` address prefix; anything
ambiguous — the same dir called twice, count/for_each, nested module blocks,
or a dir outside --root — is EXCLUDED with a counted, loud warning naming the
directory and its call sites, never guessed. Previously module-sourced
resources were missing from the inventory entirely.

Re-run whenever the target root's *.tf changes. Live-AWS reads come later."""
import argparse, hcl2, glob, json, os, re, subprocess, sys
from collections import OrderedDict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Build a Cloud Control Plane inventory.json from a Terraform root's *.tf files.",
    )
    p.add_argument(
        "--root",
        default=os.path.join(ROOT, "environments/prod"),
        help="Terraform root to scan for *.tf / *.tf.json resources, main.tf included "
        "(default: environments/prod)",
    )
    p.add_argument(
        "--out",
        default=os.path.join(ROOT, "ccp/app/src/data/inventory.json"),
        help="Output inventory.json path (default: ccp/app/src/data/inventory.json)",
    )
    p.add_argument(
        "--imports",
        default=os.path.join(ROOT, "importer/prod/imports.tf"),
        help="Optional imports.tf enriching aws_subnet->AZ data (default: importer/prod/imports.tf; "
        "skipped with a warning, not an error, if the file does not exist)",
    )
    p.add_argument(
        "--manifests",
        default=os.path.join(ROOT, "ccp/app/src/data/manifests"),
        help="Manifest dir defining which resource types are managed and their service "
        "(default: ccp/app/src/data/manifests)",
    )
    p.add_argument(
        "--summary",
        default=None,
        help="Optional path for a machine-readable JSON run summary (resource counts, "
        "module inclusions/exclusions, warnings, provider pins)",
    )
    return p.parse_args(argv)


args = parse_args()
ENV = args.root
IMPORTS = args.imports
OUT = args.out
MANIFESTS = args.manifests

# Every WARN/PARSE-FAIL line of this run, in emission order — printed to stderr
# exactly as before AND collected for the --summary file's `warnings` list.
warnings = []


def warn(msg):
    warnings.append(msg)
    print(msg, file=sys.stderr)

# ── which resource types the app can show/act on (union of manifest.resourceTypes)
# rtype_service: manifest-derived service per resource type, used when the
# FILENAME can't carry the service (foreign repos keep resources in main.tf;
# this estate names files per service, which stays authoritative when set).
managed = set()
rtype_service = {}
for f in glob.glob(os.path.join(MANIFESTS, "*.json")):
    m = json.load(open(f))
    managed.update(m.get("resourceTypes", []))
    for rt in m.get("resourceTypes", []):
        rtype_service.setdefault(rt, m.get("service"))

# ── rename: manifest expects a different key than the tf attr name
RENAME = {"aws_ebs_volume": {"size": "size_gib"}}

# ── surface these attrs first (real tf names) so the first-4 chips are meaningful
PRIORITY = {
    "aws_instance": ["instance_type", "az", "private_ip", "key_name", "ebs_optimized"],
    "aws_ebs_volume": ["size_gib", "type", "availability_zone", "iops", "throughput"],
    "aws_security_group": ["name", "description", "vpc_id"],
    "aws_db_instance": ["engine", "engine_version", "instance_class", "allocated_storage", "multi_az", "storage_type", "backup_retention_period", "parameter_group_name"],
    "aws_subnet": ["cidr_block", "availability_zone", "vpc_id", "map_public_ip_on_launch"],
    "aws_vpc": ["cidr_block", "enable_dns_hostnames", "region"],
    "aws_lb_target_group": ["name", "port", "protocol", "target_type"],
    "aws_lb_listener": ["port", "protocol", "load_balancer_arn"],
    "aws_lb": ["name", "internal", "load_balancer_type"],
    "aws_lambda_function": ["runtime", "memory_size", "timeout", "reserved_concurrent_executions", "role", "description"],
    "aws_s3_bucket": ["bucket", "object_lock_enabled"],
    "aws_cloudwatch_log_group": ["retention_in_days"],
    "aws_kms_key": ["description", "enable_key_rotation"],
    "aws_kms_alias": ["target_key_id"],
    "aws_sns_topic": ["display_name"],
    "aws_ssm_parameter": ["type", "description"],
    "aws_vpc_endpoint": ["service_name", "vpc_endpoint_type", "private_dns_enabled", "vpc_id"],
    "aws_route_table": ["vpc_id"],
    "aws_network_acl": ["vpc_id"],
    "aws_efs_file_system": ["performance_mode", "throughput_mode", "encrypted", "creation_token"],
    "aws_vpn_connection": ["customer_gateway_id", "vpn_gateway_id", "static_routes_only", "tunnel1_inside_cidr", "tunnel2_inside_cidr"],
    "aws_vpn_gateway": ["vpc_id", "amazon_side_asn"],
    "aws_customer_gateway": ["ip_address", "bgp_asn", "type"],
    "aws_iam_role": ["name", "path", "description"],
    "aws_dynamodb_table": ["name", "billing_mode", "hash_key"],
    "aws_cloudwatch_event_rule": ["name", "schedule_expression"],
    "aws_cloudwatch_event_target": ["rule", "target_id", "arn"],
    "aws_cloudfront_distribution": ["enabled", "price_class", "web_acl_id"],
    "aws_acm_certificate": ["domain_name"],
    "aws_wafv2_web_acl": ["name", "scope"],
    "aws_cloudtrail": ["name", "s3_bucket_name", "is_multi_region_trail"],
    "aws_sagemaker_domain": ["domain_name", "auth_mode", "vpc_id"],
    "aws_config_delivery_channel": ["name", "s3_bucket_name"],
    "aws_config_configuration_recorder": ["name", "role_arn"],
    "aws_licensemanager_license_configuration": ["name", "license_counting_type"],
    "aws_dlm_lifecycle_policy": ["description", "execution_role_arn"],
    # ── newly surfaced estate types (read-only in the console) ──
    "aws_volume_attachment": ["device_name", "volume_id", "instance_id"],
    "aws_db_subnet_group": ["description"],
    "aws_eip": ["domain"],
    "aws_internet_gateway": ["vpc_id"],
    "aws_nat_gateway": ["allocation_id", "subnet_id"],
    "aws_vpc_peering_connection": ["peer_vpc_id", "peer_region", "vpc_id"],
    "aws_vpc_dhcp_options": ["domain_name", "ntp_servers"],
    "aws_flow_log": ["traffic_type", "log_destination_type", "vpc_id", "log_destination"],
    "aws_default_network_acl": ["default_network_acl_id"],
    # ── azurerm (0039 S1 lane L) — real attribute names verified against
    # tools/schemadump/azurerm-v4.81.0-schema.json (every attr below is a
    # scalar string/bool/number, settable — never sensitive, never
    # computed-only). Sensitive credential attrs (admin_password,
    # administrator_login_password[_wo], administrator_password[_wo],
    # value/value_wo) are DELIBERATELY never listed here — see the matching
    # SKIP additions below, the actual gate that keeps them off the chip.
    "azurerm_resource_group": ["location", "managed_by"],
    "azurerm_linux_virtual_machine": ["size", "admin_username", "zone", "availability_set_id", "priority"],
    "azurerm_windows_virtual_machine": ["size", "admin_username", "zone", "timezone", "license_type"],
    "azurerm_managed_disk": ["storage_account_type", "create_option", "disk_size_gb", "os_type", "zone"],
    "azurerm_virtual_network": ["flow_timeout_in_minutes", "edge_zone", "bgp_community"],
    "azurerm_subnet": ["virtual_network_name", "default_outbound_access_enabled", "private_endpoint_network_policies"],
    "azurerm_network_security_rule": ["direction", "access", "priority", "protocol", "destination_port_range", "source_address_prefix"],
    "azurerm_network_interface": ["accelerated_networking_enabled", "ip_forwarding_enabled", "internal_dns_name_label", "auxiliary_mode"],
    "azurerm_public_ip": ["allocation_method", "sku", "ip_version", "domain_name_label", "idle_timeout_in_minutes"],
    "azurerm_lb": ["sku", "sku_tier", "edge_zone"],
    "azurerm_storage_account": ["account_tier", "account_replication_type", "account_kind", "access_tier", "min_tls_version", "https_traffic_only_enabled", "public_network_access_enabled", "is_hns_enabled"],
    "azurerm_storage_container": ["container_access_type", "storage_account_name"],
    "azurerm_storage_share": ["quota", "access_tier", "enabled_protocol", "storage_account_name"],
    "azurerm_storage_blob": ["type", "access_tier", "content_type", "storage_container_name"],
    "azurerm_mssql_server": ["version", "administrator_login", "minimum_tls_version", "public_network_access_enabled"],
    "azurerm_mssql_database": ["sku_name", "max_size_gb", "collation", "zone_redundant", "geo_backup_enabled"],
    "azurerm_postgresql_flexible_server": ["sku_name", "version", "storage_mb", "backup_retention_days", "zone", "geo_redundant_backup_enabled"],
    "azurerm_cosmosdb_account": ["offer_type", "kind", "free_tier_enabled", "public_network_access_enabled", "automatic_failover_enabled", "multiple_write_locations_enabled"],
    "azurerm_key_vault": ["sku_name", "tenant_id", "purge_protection_enabled", "soft_delete_retention_days", "enable_rbac_authorization", "public_network_access_enabled"],
    "azurerm_key_vault_secret": ["key_vault_id", "content_type", "expiration_date", "not_before_date"],
    "azurerm_key_vault_key": ["key_vault_id", "key_type", "key_size", "curve", "expiration_date"],
    "azurerm_linux_web_app": ["service_plan_id", "https_only", "client_affinity_enabled", "public_network_access_enabled", "enabled"],
    "azurerm_windows_web_app": ["service_plan_id", "https_only", "client_affinity_enabled", "public_network_access_enabled", "enabled"],
    "azurerm_service_plan": ["os_type", "sku_name", "worker_count", "zone_balancing_enabled", "per_site_scaling_enabled"],
    "azurerm_kubernetes_cluster": ["kubernetes_version", "sku_tier", "dns_prefix", "private_cluster_enabled", "role_based_access_control_enabled", "azure_policy_enabled"],
    "azurerm_container_group": ["os_type", "ip_address_type", "restart_policy", "sku", "dns_name_label"],
    "azurerm_container_registry": ["sku", "admin_enabled", "public_network_access_enabled", "zone_redundancy_enabled", "anonymous_pull_enabled"],
    "azurerm_monitor_diagnostic_setting": ["target_resource_id", "log_analytics_workspace_id", "storage_account_id", "eventhub_name"],
    "azurerm_log_analytics_workspace": ["sku", "retention_in_days", "daily_quota_gb", "internet_ingestion_enabled", "internet_query_enabled"],
    "azurerm_monitor_metric_alert": ["severity", "frequency", "window_size", "auto_mitigate", "enabled"],
}

# For types with no tags.Name, the display name comes from this attribute (kept
# out of the chips so it isn't shown twice). Scoped to the newly surfaced types
# so already-verified types keep their existing names.
NAME_ATTR = {
    "aws_iam_user": "name", "aws_iam_policy": "name", "aws_iam_group": "name",
    "aws_iam_role_policy": "name", "aws_iam_user_policy": "name", "aws_iam_group_policy": "name",
    "aws_key_pair": "key_name", "aws_db_subnet_group": "name",
    "aws_cloudwatch_dashboard": "dashboard_name",
    "aws_s3_bucket_policy": "bucket",
    "aws_s3_bucket_server_side_encryption_configuration": "bucket",
    "aws_s3_bucket_ownership_controls": "bucket",
    "aws_s3_bucket_cors_configuration": "bucket",
    # ── azurerm (0039 S1 lane L): unlike AWS, Azure has no tags.Name display
    # convention — every azurerm resource's real identity is its own `name`
    # attribute (ARM requires one on virtually every resource type), so every
    # PRIORITY-listed azurerm type below gets the same NAME_ATTR mapping.
    "azurerm_resource_group": "name",
    "azurerm_linux_virtual_machine": "name",
    "azurerm_windows_virtual_machine": "name",
    "azurerm_managed_disk": "name",
    "azurerm_virtual_network": "name",
    "azurerm_subnet": "name",
    "azurerm_network_security_rule": "name",
    "azurerm_network_interface": "name",
    "azurerm_public_ip": "name",
    "azurerm_lb": "name",
    "azurerm_storage_account": "name",
    "azurerm_storage_container": "name",
    "azurerm_storage_share": "name",
    "azurerm_storage_blob": "name",
    "azurerm_mssql_server": "name",
    "azurerm_mssql_database": "name",
    "azurerm_postgresql_flexible_server": "name",
    "azurerm_cosmosdb_account": "name",
    "azurerm_key_vault": "name",
    "azurerm_key_vault_secret": "name",
    "azurerm_key_vault_key": "name",
    "azurerm_linux_web_app": "name",
    "azurerm_windows_web_app": "name",
    "azurerm_service_plan": "name",
    "azurerm_kubernetes_cluster": "name",
    "azurerm_container_group": "name",
    "azurerm_container_registry": "name",
    "azurerm_monitor_diagnostic_setting": "name",
    "azurerm_log_analytics_workspace": "name",
    "azurerm_monitor_metric_alert": "name",
}

# attrs never worth surfacing (noise, nested, huge, or provider plumbing).
# Kept where a type's PRIORITY lists them (e.g. lambda.role, config.role_arn).
SKIP = {
    "__start_line__", "__end_line__", "for_each", "count", "provider", "lifecycle",
    "tags", "policy", "assume_role_policy", "event_pattern", "source_code_hash",
    "filename", "region", "handler", "layers", "username", "port",  # port kept via PRIORITY where wanted
    # join refs / principals / huge documents
    "role", "user", "group", "role_arn",
    "dashboard_body", "public_key",
    "pipeline_definition", "pipeline_display_name", "pipeline_description",
    # ── azurerm (0039 S1 lane L) — credential/secret-material attrs. Unlike
    # the noise/plumbing attrs above, these are NEVER worth surfacing under
    # any circumstance: a hardcoded literal here is the secret itself, and
    # inventory attribute chips reach the UI with no downstream redaction
    # pass (lib/redact.ts masks generated HCL DIFFS, not inventory.json).
    # Bare `value` is deliberately NOT here: it collides with
    # aws_ssm_parameter's real, legitimately-surfaced, non-secret String
    # config document (checked against the committed inventory.json) — a
    # global skip would silently drop that real data. A hardcoded (never
    # referenced) key_vault_secret.value is a pre-existing gap this script
    # has always had for every type (nothing name-scopes SKIP today); a
    # value authored the way Terraform requires in practice — from a
    # generated/fetched reference, e.g. `random_password.x.result` — is
    # already excluded by the is_expr() check below, same as any other
    # resource's reference, no SKIP entry needed.
    "admin_password", "administrator_login_password", "administrator_login_password_wo",
    "administrator_password", "administrator_password_wo", "value_wo",
}
# list-semantic attrs to drop even when hcl2/unwrap collapses a 1-element list to
# a scalar (e.g. an instance with a single SG) — keeps inclusion consistent.
LIST_ATTRS = {
    "vpc_security_group_ids", "security_group_ids", "security_groups", "subnet_ids",
    "subnets", "addresses", "propagating_vgws", "alarm_actions",
    "subject_alternative_names", "aliases", "suspended_processes",
}
MAX_ATTRS = 8


def unwrap(v):
    """python-hcl2 wraps every attribute value in a 1-element list."""
    while isinstance(v, list) and len(v) == 1:
        v = v[0]
    return v


def unwrap_attrs(attrs):
    return {k: unwrap(v) for k, v in attrs.items()}


def is_expr(v):
    return isinstance(v, str) and "${" in v


def coerce(v):
    # Only integers are coerced. Decimal strings are left as strings: Terraform
    # attrs like aws_db_instance.engine_version = "16.13" are STRINGS, and float
    # coercion is lossy ("16.10" -> 16.1) and no longer matches the .tf literal.
    if isinstance(v, str):
        if v.lower() in ("true", "false"):
            return v.lower() == "true"
        if re.fullmatch(r"-?\d+", v):
            return int(v)
    return v


def scalar_attrs(rtype, attrs):
    """Ordered dict of surfaceable SCALAR attrs for a resource. List-valued attrs
    (e.g. vpc_security_group_ids) are intentionally dropped: they are never chips
    nor operation inputs, and capping them silently loses real associations."""
    rn = RENAME.get(rtype, {})
    name_key = NAME_ATTR.get(rtype)
    clean = OrderedDict()
    for k, v in attrs.items():
        if k == name_key:  # it's the row title, not a chip
            continue
        if k in SKIP and k not in PRIORITY.get(rtype, []):
            continue
        if k.endswith("_ids") or k in LIST_ATTRS:
            continue
        if is_expr(v):
            continue
        if isinstance(v, bool) or isinstance(v, (int, float)):
            clean[rn.get(k, k)] = v
        elif isinstance(v, str):
            clean[rn.get(k, k)] = coerce(v)
        # list (nested blocks or id lists) and dict skipped — see docstring
    return clean


def order(rtype, clean):
    pri = [RENAME.get(rtype, {}).get(k, k) for k in PRIORITY.get(rtype, [])]
    out = OrderedDict()
    for k in pri:
        if k in clean:
            out[k] = clean[k]
    for k, v in clean.items():
        if k not in out:
            out[k] = v
    # cap
    return OrderedDict(list(out.items())[:MAX_ATTRS])


def humanize(label):
    return label


def git_vintage(root):
    """Deterministic (sourceCommit, generatedAt) vintage stamp for --root: the
    full SHA + committer date (ISO 8601) of the last commit to touch that
    path (0027 §2.5). Deliberately NOT wall-clock (`datetime.now()` would
    make every rerun diff, breaking byte-stable regen) and deliberately NOT
    bare repo HEAD (that moves on every commit anywhere in the tree, even
    ones that never touch `root` — violating "moves exactly when the inputs
    move"). Path-scoped via `git -C <root> log -- .` instead.
    Returns (None, None) + a stderr WARN when root isn't inside a git work
    tree (a bare test fixture dir, or a --root outside any repo) — the same
    graceful-degradation style as the --imports handling below, and the same
    direction of dishonesty a missing value is always allowed to have: never
    claim a vintage that isn't real.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", root, "log", "-1", "--format=%H%x1f%cI", "--", "."],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as e:
        warn(f"WARN: git lookup failed for {root} ({e}) — generatedAt/sourceCommit will be null")
        return None, None
    if proc.returncode != 0 or "\x1f" not in proc.stdout:
        warn(f"WARN: {root} is not inside a git work tree (or has no commits touching it) — generatedAt/sourceCommit will be null")
        return None, None
    sha, _, date = proc.stdout.strip().partition("\x1f")
    return sha, date


# ── parse imports.tf → address -> aws id (strip @region). Optional: a root
# with no matching imports.tf (any repo but this one, by default) still
# builds a full inventory — it just skips the subnet->AZ join enrichment
# below, rather than crashing (0014 fix#4).
addr_id = {}
try:
    txt = open(IMPORTS).read()
except FileNotFoundError:
    warn(f"WARN: imports file not found ({IMPORTS}) — skipping subnet->AZ join enrichment")
    txt = ""
for m in re.finditer(r"to\s*=\s*([\w.\[\]\"-]+)\s*\n\s*id\s*=\s*\"([^\"]+)\"", txt):
    addr_id[m.group(1)] = m.group(2).split("@")[0]

# ── first pass: collect all resources; build subnetRealId -> az map
# Foreign-repo reality (B4): resources routinely live in main.tf, and CDK-TF /
# generated roots use *.tf.json. Generic filenames don't carry a service, so
# those resources take their service from the manifests instead; this estate's
# per-service filenames still win for every non-generic file, keeping the
# default-root output byte-identical (its generic files hold no resources).
GENERIC_FILES = ("main", "versions", "providers", "variables", "backend")


def scan_tf_files(files):
    """Parse each *.tf / *.tf.json and return (resource_entries, module_calls,
    provider_pins): entries as (service, rtype, label, attrs) with the same
    filename-vs-manifest service rule as ever; module_calls as (instance,
    source_literal_or_None, has_count_or_for_each); provider_pins as
    {name: {"source": ..., "version": ...}} from any terraform.required_providers."""
    entries = []
    calls = []
    pins = OrderedDict()
    for f in files:
        base = os.path.basename(f)
        is_json = base.endswith(".tf.json")
        file_svc = base[: -len(".tf.json")] if is_json else base[: -len(".tf")]
        try:
            d = json.load(open(f)) if is_json else hcl2.load(open(f))
        except Exception as e:
            warn(f"PARSE FAIL {f} {e}")
            continue
        blocks = d.get("resource", [])
        if isinstance(blocks, dict):  # JSON syntax: one mapping, not hcl2's list-of-blocks
            blocks = [blocks]
        for block in blocks:
            for rtype, body in block.items():
                svc = (
                    rtype_service.get(rtype, file_svc)
                    if file_svc in GENERIC_FILES
                    else file_svc
                )
                for label, attrs in body.items():
                    entries.append((svc, rtype, label, attrs))
        mblocks = d.get("module", [])
        if isinstance(mblocks, dict):  # JSON syntax again
            mblocks = [mblocks]
        for block in mblocks:
            if not isinstance(block, dict):
                continue
            for name, body in block.items():
                bodies = body if isinstance(body, list) else [body]
                for b in bodies:
                    if not isinstance(b, dict):
                        continue
                    src = unwrap(b.get("source"))
                    literal = src if isinstance(src, str) and not is_expr(src) else None
                    calls.append((name, literal, "count" in b or "for_each" in b))
        tblocks = d.get("terraform", [])
        if isinstance(tblocks, dict):
            tblocks = [tblocks]
        for tb in tblocks:
            if not isinstance(tb, dict):
                continue
            rps = unwrap(tb.get("required_providers", []))
            if isinstance(rps, dict):
                rps = [rps]
            if not isinstance(rps, list):
                rps = []
            for rp in rps:
                if not isinstance(rp, dict):
                    continue
                for pname, pbody in rp.items():
                    pbody = unwrap(pbody)
                    if isinstance(pbody, dict):
                        psrc = unwrap(pbody.get("source"))
                        pver = unwrap(pbody.get("version"))
                        pins[pname] = OrderedDict([
                            ("source", psrc if isinstance(psrc, str) else None),
                            ("version", pver if isinstance(pver, str) else None),
                        ])
                    elif isinstance(pbody, str):  # legacy `aws = "~> 6.0"` shorthand
                        pins[pname] = OrderedDict([("source", None), ("version", pbody)])
    return entries, calls, pins


def is_local_module_source(src):
    """Same convention as extract-blocks.ts / prescan's moduleSourceAllowed: a
    bare "." or a "./" / "../"-prefixed path. Anything else (registry, git,
    http(s), interpolated) has no local dir under --root to resolve."""
    return src == "." or src.startswith("./") or src.startswith("../")


env_files = sorted(
    glob.glob(os.path.join(ENV, "*.tf")) + glob.glob(os.path.join(ENV, "*.tf.json"))
)
root_entries, root_module_calls, provider_pins = scan_tf_files(env_files)
# parsed rows carry an address prefix: "" for root resources (bare address,
# exactly as before), "module.<instance>." for uniquely-resolved local modules.
parsed = [(svc, rtype, label, attrs, "") for (svc, rtype, label, attrs) in root_entries]

# ── local modules (parity with extract-blocks.ts's unique-resolution rule) ──
env_abs = os.path.abspath(ENV)
module_dirs = OrderedDict()  # abs dir -> {"instances": [names...], "meta": count/for_each seen}
for name, literal, has_meta in root_module_calls:
    if literal is None or not is_local_module_source(literal):
        continue  # never mapped — no local dir to resolve (same as extract-blocks)
    d_abs = os.path.abspath(os.path.join(ENV, literal))
    info = module_dirs.setdefault(d_abs, {"instances": [], "meta": False})
    info["instances"].append(name)
    info["meta"] = info["meta"] or has_meta

modules_included = []
modules_excluded = []
module_file_count = 0
for d_abs in sorted(module_dirs):
    info = module_dirs[d_abs]
    called_as = ", ".join(f'"{n}"' for n in info["instances"])
    rel_dir = os.path.relpath(d_abs, ENV)
    # A local source can point above --root; its files would then disagree with
    # every other root-scoped scan (extract-blocks never even walks them), so
    # it is excluded loudly rather than half-included.
    if not (d_abs == env_abs or d_abs.startswith(env_abs + os.sep)):
        warn(
            f"WARN: module dir {rel_dir} EXCLUDED from inventory: outside the scanned root (called as {called_as})"
        )
        modules_excluded.append(OrderedDict([
            ("dir", rel_dir), ("calledAs", info["instances"]),
            ("reason", "outside the scanned root"), ("resources", None),
        ]))
        continue
    mod_files = sorted(
        glob.glob(os.path.join(d_abs, "*.tf")) + glob.glob(os.path.join(d_abs, "*.tf.json"))
    )
    module_file_count += len(mod_files)
    entries, nested_calls, _ = scan_tf_files(mod_files)
    ambiguous = len(info["instances"]) > 1 or info["meta"] or len(nested_calls) > 0
    if ambiguous:
        warn(
            f"WARN: module dir {rel_dir} EXCLUDED from inventory ({len(entries)} resource(s)): "
            f"ambiguous instantiation (called as {called_as})"
        )
        modules_excluded.append(OrderedDict([
            ("dir", rel_dir), ("calledAs", info["instances"]),
            ("reason", "ambiguous instantiation"), ("resources", len(entries)),
        ]))
        continue
    instance = info["instances"][0]
    prefix = f"module.{instance}."
    parsed.extend((svc, rtype, label, attrs, prefix) for (svc, rtype, label, attrs) in entries)
    modules_included.append(OrderedDict([
        ("instance", instance), ("dir", rel_dir), ("resources", len(entries)),
    ]))

subnet_az = {}
for svc, rtype, label, attrs, prefix in parsed:
    if rtype == "aws_subnet":
        rid = addr_id.get(f"{prefix}aws_subnet.{label}")
        az = unwrap(attrs.get("availability_zone"))
        if rid and isinstance(az, str) and not is_expr(az):
            subnet_az[rid] = az

# ── second pass: build inventory entries for managed types
resources = []
for svc, rtype, label, attrs, prefix in parsed:
    if rtype not in managed:
        continue
    attrs = unwrap_attrs(attrs)
    address = f"{prefix}{rtype}.{label}"
    tags = attrs.get("tags") if isinstance(attrs.get("tags"), dict) else {}
    name = tags.get("Name") if isinstance(tags, dict) else None
    if not name or is_expr(str(name)):
        cand = attrs.get(NAME_ATTR.get(rtype, ""))
        name = cand if isinstance(cand, str) and cand and not is_expr(cand) else humanize(label)

    clean = scalar_attrs(rtype, attrs)
    # derive az for instances via subnet join
    if rtype == "aws_instance":
        sid = attrs.get("subnet_id")
        if isinstance(sid, str) and sid in subnet_az:
            clean = OrderedDict([("az", subnet_az[sid])] + [(k, v) for k, v in clean.items() if k != "az"])
    ordered = order(rtype, clean)

    resources.append(OrderedDict([
        ("address", address),
        ("resourceType", rtype),
        ("name", name),
        ("service", svc),
        ("attributes", ordered),
    ]))

# stable sort: service, type, name
resources.sort(key=lambda r: (r["service"], r["resourceType"], str(r["name"]).lower()))

# "source" describes provenance accurately for whatever --root was actually
# scanned. Preserved byte-for-byte for the default root (environments/prod)
# so a no-flags rerun never diffs the checked-in inventory.json; a non-default
# --root gets an accurate, root-relative description instead of falsely
# claiming this estate's account (0014 fix#4 — a foreign-repo inventory.json
# should never say "account 123456789012" when it isn't).
DEFAULT_ENV = os.path.join(ROOT, "environments/prod")
if os.path.abspath(ENV) == DEFAULT_ENV:
    source_desc = "environments/prod/*.tf (baseline capture, account 123456789012)"
else:
    source_desc = f"{os.path.relpath(ENV, ROOT)}/*.tf (baseline capture)"

# generatedAt/sourceCommit: git-derived, not wall-clock (0027 §2.5 — the
# previous "generatedAt" was a hardcoded constant that a five-day-stale
# inventory carried unchanged; these two fields are the fix). They are
# EXCLUDED from the portal-data-freshness CI diff and from this script's own
# byte-stable-rerun test (test_build_inventory.py) — both by the same rule
# (`del(.generatedAt, .source, .sourceCommit)`) — because they legitimately
# differ between "committed at commit A" and "regenerated while checked out
# at commit B" even when the scanned *.tf content hasn't changed a byte.
source_commit, generated_at = git_vintage(ENV)

out = OrderedDict([
    ("generatedAt", generated_at),
    ("sourceCommit", source_commit),
    ("source", source_desc),
    ("resources", resources),
])
with open(OUT, "w") as fh:
    json.dump(out, fh, indent=1)
    fh.write("\n")

# ── report
from collections import Counter
by_type = Counter(r["resourceType"] for r in resources)
by_svc = Counter(r["service"] for r in resources)
print(f"WROTE {len(resources)} resources to inventory.json")
if not resources:
    warn(
        f"WARN: 0 resources written — the root either has no resources or none of "
        f"their types are covered by the {len(managed)} manifest-managed types "
        f"(scanned {len(env_files)} *.tf/*.tf.json file(s) in {ENV})"
    )

# ── machine-readable run summary (--summary): counts, module resolution,
# warnings, provider pins — upload metadata for whoever consumes this
# inventory next. Deterministic given the same inputs (maps sorted; warnings
# in emission order; the same git-derived vintage as the inventory itself).
if args.summary:
    run_summary = OrderedDict([
        ("root", os.path.abspath(ENV)),
        ("out", os.path.abspath(OUT)),
        ("generatedAt", generated_at),
        ("sourceCommit", source_commit),
        ("resourceCount", len(resources)),
        ("byService", OrderedDict(sorted(by_svc.items()))),
        ("byType", OrderedDict(sorted(by_type.items()))),
        ("scannedFiles", OrderedDict([("root", len(env_files)), ("modules", module_file_count)])),
        ("modulesIncluded", modules_included),
        ("modulesExcluded", modules_excluded),
        ("providerPins", OrderedDict(sorted(provider_pins.items()))),
        ("warnings", warnings),
    ])
    with open(args.summary, "w") as fh:
        json.dump(run_summary, fh, indent=1)
        fh.write("\n")
    print(f"WROTE run summary to {args.summary}")
print("\nby service:")
for s, n in sorted(by_svc.items(), key=lambda x: -x[1]):
    print(f"  {s:16} {n}")
print("\ntop types:")
for t, n in by_type.most_common(12):
    print(f"  {t:34} {n}")
