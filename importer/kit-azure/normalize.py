#!/usr/bin/env python3
"""normalize.py — the post-generation cleanup a new Azure env root needs.

The Azure sibling of importer/kit/normalize.py. Whether HCL bodies come from aztfexport
--hcl-only or from `terraform plan -generate-config-out`, the generated config is correct but
raw: everything in one file, no lifecycle guards, occasionally a sensitive literal, no root
scaffolding. This script does the mechanical parts and REFUSES (never guesses) on the judgment
parts. Subcommands, in the order the runbook uses them:

  scaffold  --env-dir D --env-name N --location L --subscription-id S --tenant-id T
            [--owner O] [--state-storage-account A --state-container C --state-resource-group G]
      Copy templates/ (versions/providers/variables/main/backend/tfvars) into the new root.
      Pins are exact (azurerm + azapi) so the schemadump/ForceNew story holds for the new env.
      Idempotent: an identical existing file is left alone; a DIFFERENT existing file refuses.

  split     --generated F --env-dir D [--services azure-services.json] [--force]
      Split generated HCL into one file per service (network.tf, storage.tf, keyvault.tf ...)
      — the environments/prod layout. Block extents come from a REAL HCL parser (python-hcl2,
      heredoc-safe), source bytes are copied verbatim. A resource type azure-services.json does
      not map goes to unclassified.tf WITH a warning — never dropped (the silent-loss lesson).

  guard     --env-dir D [--services azure-services.json]
      Insert `lifecycle { prevent_destroy = true }` into every STATEFUL-type resource
      (azure-services.json stateful flag — strategy.md rule 2: guards go in BEFORE import).
      Refuse-don't-corrupt: a resource that already has a lifecycle block is WARNED and left
      for manual merge, and every modified file is re-parsed afterwards (parse failure ->
      original restored, refuse).

  check     --env-dir D [--rules catalog/azure-redaction-rules.json]
      The refusal battery before PR: Azure secret literals (canonical azure redaction rules,
      fail-closed) refuse with file:line + remediation; unclassified.tf and *.tf.json presence
      are warned loudly; `= null` generator noise is counted (informational).
      KNOWN LIMIT (documented in the rules file + proposal 0039 'Honest limits'): the check is
      line-oriented and matches an attribute NAME — it does not yet honor maskAllValuesInBlocks
      (secrets under arbitrary keys inside app_settings / Key Vault body blocks). Block-aware
      scanning is a named follow-up before importing Function Apps / Key Vaults.

Deliberately manual (unsafe to automate): rewriting a secret literal into a variable/Key Vault
reference, label curation, drift ignore_changes decisions, module extraction.

Requires python-hcl2 (already a repo dependency — build-inventory.py).
Exit codes: 0 ok · 2 refusal ("REFUSE <CODE>: ...").
"""
import argparse
import json
import os
import re
import sys

try:
    import hcl2
except ImportError:
    print("REFUSE MISSING_DEP: python-hcl2 is required (pip install python-hcl2)", file=sys.stderr)
    sys.exit(2)

KIT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(KIT_DIR, "..", ".."))
DEFAULT_SERVICES = os.path.join(KIT_DIR, "azure-services.json")
DEFAULT_RULES = os.path.join(REPO_ROOT, "catalog", "azure-redaction-rules.json")
TEMPLATES = os.path.join(KIT_DIR, "templates")

# template source name -> file written into the env root. The tfvars template carries a .tmpl
# suffix because the ROOT .gitignore ignores *.tfvars (sensitive-values policy) with per-env
# exceptions; the scaffolded environments/<env>-azure/terraform.tfvars needs its own `!`
# exception there too (runbook covers it).
SCAFFOLD_FILES = {
    "versions.tf": "versions.tf",
    "providers.tf": "providers.tf",
    "variables.tf": "variables.tf",
    "main.tf": "main.tf",
    "backend.tf": "backend.tf",
    "terraform.tfvars.tmpl": "terraform.tfvars",
}


def refuse(code, msg):
    print(f"REFUSE {code}: {msg}", file=sys.stderr)
    sys.exit(2)


def warn(msg):
    print(f"WARN: {msg}", file=sys.stderr)


def load_services(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse("BAD_SERVICES", f"cannot read {path}: {e}")


def parse_resources(path):
    """(type, label, start_line, end_line) per resource, 1-based inclusive, via python-hcl2 —
    a real HCL parser, so heredocs/comments/one-liners are style-proof. Refuses .tf.json."""
    if path.endswith(".tf.json"):
        refuse("TF_JSON_UNSUPPORTED", f"{path}: the kit reads/writes native HCL syntax only")
    try:
        with open(path) as fh:
            # with_meta=True attaches __start_line__/__end_line__ per block — required on the
            # repo-pinned python-hcl2 5.1.1 (terraform.yml), where a plain load() omits them.
            doc = hcl2.load(fh, with_meta=True)
    except Exception as e:  # lark raises its own exception types
        refuse("UNPARSEABLE", f"{path} does not parse as HCL: {e}")
    out = []
    for block in doc.get("resource", []):
        for rtype, bodies in block.items():
            for label, body in bodies.items():
                out.append({
                    "type": rtype,
                    "label": label,
                    "start": body["__start_line__"],
                    "end": body["__end_line__"],
                    "body": body,
                })
    return out


def leading_comments(lines, start_idx):
    """Contiguous comment lines directly above a block (0-based end-exclusive slice start).
    Keeps a '# __generated__ from "<id>"' provenance comment attached."""
    i = start_idx
    while i > 0 and lines[i - 1].lstrip().startswith(("#", "//")):
        i -= 1
    return i


# ── scaffold ──────────────────────────────────────────────────────────────────

def cmd_scaffold(args):
    os.makedirs(args.env_dir, exist_ok=True)
    replacements = {
        "REPLACE_ENV": args.env_name,
        "REPLACE_LOCATION": args.location,
        "REPLACE_SUBSCRIPTION_ID": args.subscription_id,
        "REPLACE_TENANT_ID": args.tenant_id,
        "REPLACE_OWNER": args.owner,
        "REPLACE_STATE_STORAGE_ACCOUNT": args.state_storage_account or "REPLACE_STATE_STORAGE_ACCOUNT",
        "REPLACE_STATE_CONTAINER": args.state_container or "REPLACE_STATE_CONTAINER",
        "REPLACE_STATE_RESOURCE_GROUP": args.state_resource_group or "REPLACE_STATE_RESOURCE_GROUP",
    }
    written, unchanged = [], []
    for src_name, dst_name in SCAFFOLD_FILES.items():
        src = os.path.join(TEMPLATES, src_name)
        if not os.path.exists(src):
            refuse("BAD_TEMPLATE", f"template {src} is missing")
        with open(src) as fh:
            content = fh.read()
        for token, value in replacements.items():
            content = content.replace(token, value)
        dst = os.path.join(args.env_dir, dst_name)
        if os.path.exists(dst):
            with open(dst) as fh:
                if fh.read() == content:
                    unchanged.append(dst_name)
                    continue
            refuse("EXISTS", f"{dst} exists with different content — refusing to overwrite "
                             "(delete it or reconcile by hand)")
        with open(dst, "w") as fh:
            fh.write(content)
        written.append(dst_name)
    print(f"scaffolded {args.env_dir}: wrote {len(written)} file(s) {written}, unchanged {unchanged}")
    if not args.state_storage_account:
        print("NOTE: backend.tf still has REPLACE_STATE_STORAGE_ACCOUNT — fill it (or re-run with "
              "--state-storage-account/--state-container/--state-resource-group) before `terraform init`")
    return 0


# ── split ─────────────────────────────────────────────────────────────────────

def cmd_split(args):
    services = load_services(args.services)
    type_service = {t: s["service"] for t, s in services["types"].items()}

    resources = parse_resources(args.generated)
    with open(args.generated) as fh:
        lines = fh.read().splitlines()
    if not resources:
        refuse("EMPTY_GENERATED", f"{args.generated} parsed but contains 0 resource blocks — "
                                  "refusing a silent-empty split (wrong file?)")

    groups = {}
    unknown_types = set()
    for res in resources:
        svc = type_service.get(res["type"])
        if svc is None:
            svc = "unclassified"
            unknown_types.add(res["type"])
        start0 = leading_comments(lines, res["start"] - 1)
        chunk = "\n".join(lines[start0:res["end"]])
        groups.setdefault(svc, []).append((res["type"], res["label"], chunk))

    os.makedirs(args.env_dir, exist_ok=True)
    written = []
    for svc in sorted(groups):
        blocks = sorted(groups[svc], key=lambda b: (b[0], b[1]))
        header = [
            f"# {svc} — split from {os.path.basename(args.generated)} by importer/kit-azure/normalize.py;",
            "# blocks are verbatim generator output (refactor freely, then `terraform fmt`).",
        ]
        if svc == "unclassified":
            header = [
                "# UNCLASSIFIED — resource types azure-services.json does not map to a service file.",
                "# NOT an error but NEVER to be merged as-is: move each block into the right",
                "# <service>.tf (and extend azure-services.json so the next environment classifies it).",
            ]
        content = "\n".join(header) + "\n\n" + "\n\n".join(c for _, _, c in blocks) + "\n"
        dst = os.path.join(args.env_dir, f"{svc}.tf")
        if os.path.exists(dst) and not args.force:
            with open(dst) as fh:
                if fh.read() == content:
                    written.append((svc, len(blocks), "unchanged"))
                    continue
            refuse("EXISTS", f"{dst} exists with different content — refusing to overwrite "
                             "(re-run with --force only if you intend to regenerate it)")
        with open(dst, "w") as fh:
            fh.write(content)
        written.append((svc, len(blocks), "written"))

    total = sum(n for _, n, _ in written)
    print(f"split {total} resource block(s) into {len(written)} service file(s):")
    for svc, n, state in written:
        print(f"  {svc}.tf: {n} block(s) [{state}]")
    if unknown_types:
        warn(f"{len(unknown_types)} resource type(s) not mapped by azure-services.json went to "
             f"unclassified.tf (NOT dropped): {sorted(unknown_types)}")
    print("next: delete the generated file after review, then normalize.py guard "
          "(docs/runbooks/azure-subscription-import.md)")
    return 0


# ── guard ─────────────────────────────────────────────────────────────────────

GUARD_LINES = [
    "",
    "  lifecycle {",
    "    # stateful resource — never destroyed via Terraform (importer/kit-azure/docs/strategy.md rule 2)",
    "    prevent_destroy = true",
    "  }",
]


def cmd_guard(args):
    services = load_services(args.services)
    stateful = {t for t, s in services["types"].items() if s.get("stateful")}

    added, skipped_manual = 0, []
    for fname in sorted(os.listdir(args.env_dir)):
        if not fname.endswith(".tf"):
            continue
        path = os.path.join(args.env_dir, fname)
        resources = [r for r in parse_resources(path) if r["type"] in stateful]
        if not resources:
            continue
        with open(path) as fh:
            original = fh.read()
        lines = original.splitlines()
        changed = False
        for res in sorted(resources, key=lambda r: -r["start"]):  # bottom-up: line numbers stay valid
            body = res["body"]
            existing = body.get("lifecycle")
            if existing:
                if any(isinstance(b, dict) and "prevent_destroy" in b for b in existing):
                    continue  # already guarded — idempotent re-run
                skipped_manual.append(f"{res['type']}.{res['label']} ({fname}): has a lifecycle "
                                      "block without prevent_destroy — merge by hand (refuse-don't-corrupt)")
                continue
            insert_at = res["end"] - 1  # before the closing-brace line
            lines[insert_at:insert_at] = GUARD_LINES
            changed = True
            added += 1
        if changed:
            candidate = "\n".join(lines) + ("\n" if original.endswith("\n") else "")
            with open(path, "w") as fh:
                fh.write(candidate)
            try:
                with open(path) as fh:
                    hcl2.load(fh)
            except Exception as e:
                with open(path, "w") as fh:
                    fh.write(original)
                refuse("CORRUPTION_DETECTED", f"{path} no longer parsed after guard insertion "
                                              f"({e}) — original restored, nothing lost")

    print(f"guard: added prevent_destroy to {added} stateful resource(s)")
    for note in skipped_manual:
        warn(note)
    return 0


# ── check ─────────────────────────────────────────────────────────────────────

ATTR_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$')


def cmd_check(args):
    try:
        with open(args.rules) as fh:
            rules = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        # fail-closed: no rules file ⇒ no check ⇒ refuse (absence of rules must never mean
        # "no redaction").
        refuse("BAD_RULES", f"cannot read redaction rules {args.rules}: {e}")
    secret_names = {n.lower() for n in rules.get("secretAttributeNames", [])}
    allow_prefixes = tuple(rules.get("valueAllowlistPrefixes", []))
    if not secret_names:
        refuse("BAD_RULES", f"{args.rules} has no secretAttributeNames — fail-closed")

    findings, null_count, tf_json = [], 0, []
    tf_files = sorted(f for f in os.listdir(args.env_dir) if f.endswith(".tf"))
    for fname in sorted(os.listdir(args.env_dir)):
        if fname.endswith(".tf.json"):
            tf_json.append(fname)
    for fname in tf_files:
        path = os.path.join(args.env_dir, fname)
        with open(path) as fh:
            for lineno, line in enumerate(fh, 1):
                if re.match(r"^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*null\s*$", line):
                    null_count += 1
                m = ATTR_RE.match(line)
                if not m:
                    continue
                name, value = m.group(1).lower(), m.group(2)
                if name in secret_names and value and not value.startswith(allow_prefixes):
                    findings.append(f"{fname}:{lineno}: attribute '{m.group(1)}' holds a string literal")

    if "unclassified.tf" in tf_files:
        warn("unclassified.tf present — reclassify its blocks before PR (split's loud-not-lost output)")
    if tf_json:
        warn(f"*.tf.json present ({tf_json}) — unexpected in a kit-produced root; the kit and "
             "catalogctl edit treat JSON-syntax files as read-only")
    if null_count:
        print(f"info: {null_count} `= null` generator-noise line(s) — optional manual trim, "
              "they are semantically 'unset'")

    if findings:
        for f in findings:
            print(f"  {f}", file=sys.stderr)
        refuse("SECRET_LITERAL",
               f"{len(findings)} sensitive literal(s) found (rules: {os.path.relpath(args.rules, REPO_ROOT)}). "
               "Replace each with a variable (value in a gitignored *.auto.tfvars) or an "
               "azurerm_key_vault_secret data source, then re-run. Import can proceed only when this "
               "check passes — nothing sensitive may enter git history")
    print(f"check: clean — no secret literals in {len(tf_files)} .tf file(s)")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scaffold", help="templates -> new env root (versions/providers/backend/...)")
    s.add_argument("--env-dir", required=True)
    s.add_argument("--env-name", required=True)
    s.add_argument("--location", required=True)
    s.add_argument("--subscription-id", required=True)
    s.add_argument("--tenant-id", required=True)
    s.add_argument("--owner", default="platform-team")
    s.add_argument("--state-storage-account", default="")
    s.add_argument("--state-container", default="")
    s.add_argument("--state-resource-group", default="")
    s.set_defaults(func=cmd_scaffold)

    s = sub.add_parser("split", help="generated HCL -> per-service files (prod layout)")
    s.add_argument("--generated", required=True)
    s.add_argument("--env-dir", required=True)
    s.add_argument("--services", default=DEFAULT_SERVICES)
    s.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_split)

    s = sub.add_parser("guard", help="prevent_destroy on stateful resources")
    s.add_argument("--env-dir", required=True)
    s.add_argument("--services", default=DEFAULT_SERVICES)
    s.set_defaults(func=cmd_guard)

    s = sub.add_parser("check", help="secret-literal + hygiene refusal battery")
    s.add_argument("--env-dir", required=True)
    s.add_argument("--rules", default=DEFAULT_RULES)
    s.set_defaults(func=cmd_check)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
