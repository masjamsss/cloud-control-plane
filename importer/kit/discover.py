#!/usr/bin/env python3
"""discover.py — turn recorded AWS CLI captures into a discovery manifest.

Offline by construction: this script NEVER calls AWS. The only thing that ever
talks to AWS is discover.sh's live mode (a thin `aws` CLI loop); everything
here reads JSON files from a --capture-dir, so the whole pipeline is testable
against the recorded fixtures under testdata/ (and a real capture directory is
processed identically — same code path, no divergence to trust).

Subcommands
  plan-commands  --services F --region R
      Print one "capture<TAB>aws-cli-command" line per unique capture in the
      allowlist. discover.sh's live mode consumes this; --dry-run prints it.
  build          --capture-dir D --services F --out MANIFEST
                 [--require-account A] [--classify OVERRIDES]
      Read every capture, extract resources per the services.json allowlist,
      and write the machine-readable discovery manifest.

Nothing is ever silently dropped (0007's silent-loss lesson, applied at every
layer):
  - a record matching a `skips` rule        -> manifest.ignored[] with the reason
  - a duplicate (type,id)                   -> manifest.ignored[] ("duplicate of ...")
  - a capture file no allowlist entry names -> manifest.unmapped_captures[] (loud)
  - an allowlisted capture that is absent   -> manifest.missing_captures[] (loud)
  - types the kit cannot list (services.json `manual`) -> manifest.manual_followup[]
  - a resource type OUTSIDE services.json entirely  -> manifest.coverage.unrecognizedArnFamilies[]
    (WARN on stderr; from discover.sh's account-wide resourcegroupstaggingapi
    sweep — a report, never a build-failing gate; README.md "coverage sweep")
  - a record whose id cannot be extracted   -> REFUSE MALFORMED_RECORD, exit 2
  - an unreadable/invalid JSON capture      -> REFUSE BAD_CAPTURE, exit 2
  - a wrong-account capture (--require-account) -> REFUSE ACCOUNT_MISMATCH, exit 2

Stdlib only (json/argparse) — runs on a bare python3, no pip install.
Deterministic: capturedAt comes from capture-meta.json, never from the clock,
so re-running build on the same captures is byte-identical.

Exit codes: 0 ok · 2 refusal (message starts with "REFUSE <CODE>:").
"""
import argparse
import hashlib
import json
import os
import re
import sys

KIT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SERVICES = os.path.join(KIT_DIR, "services.json")

# Account-wide coverage sweep (Gap 1): discover.sh additionally records one
# `aws resourcegroupstaggingapi get-resources` capture, independent of
# services.json's per-type allowlist (it has no single resource type of its
# own — it is every taggable resource, in one call). It is therefore NOT a
# services.json `types` entry: excluded from the unmapped_captures diff in
# cmd_build below, and consumed on its own into manifest["coverage"] instead.
COVERAGE_CAPTURE = "coverage-resources"
ARN_RE = re.compile(r"^arn:([^:]*):([^:]*):([^:]*):([^:]*):(.+)$")


def refuse(code, msg):
    print(f"REFUSE {code}: {msg}", file=sys.stderr)
    sys.exit(2)


def load_services(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse("BAD_SERVICES", f"cannot read allowlist {path}: {e}")
    types = data.get("types")
    if not isinstance(types, dict) or not types:
        refuse("BAD_SERVICES", f"{path} has no 'types' mapping")
    # Consistency: every entry needs the required keys; two types naming the
    # same capture must agree on the CLI command that produces it.
    capture_cli = {}
    for rtype, spec in types.items():
        for key in ("service", "capture", "cli", "records", "phase", "stateful", "arnHint"):
            if key not in spec:
                refuse("BAD_SERVICES", f"types.{rtype} is missing required key '{key}'")
        if ("id" in spec) == ("id_format" in spec):
            refuse("BAD_SERVICES", f"types.{rtype} must have exactly one of 'id' / 'id_format'")
        if not spec["cli"].startswith("aws "):
            refuse("BAD_SERVICES", f"types.{rtype} cli must be an `aws ...` read-only call, got: {spec['cli']!r}")
        cap = spec["capture"]
        if cap in capture_cli and capture_cli[cap] != spec["cli"]:
            refuse(
                "BAD_SERVICES",
                f"capture '{cap}' is declared with two different cli commands "
                f"({capture_cli[cap]!r} vs {spec['cli']!r})",
            )
        capture_cli[cap] = spec["cli"]
    return data


def walk_records(doc, path):
    """Resolve a dotted record path; a trailing [] on a segment flattens a
    list; '.' means the document itself. Missing keys yield [] (an empty
    listing is legal AWS output — absence of the KEY is how e.g. CloudFront
    omits DistributionList.Items on an empty account)."""
    if path == ".":
        return [doc]
    current = [doc]
    for seg in path.split("."):
        flatten = seg.endswith("[]")
        key = seg[:-2] if flatten else seg
        nxt = []
        for item in current:
            if not isinstance(item, dict) or key not in item:
                continue
            value = item[key]
            if flatten:
                if isinstance(value, list):
                    nxt.extend(value)
            else:
                nxt.append(value)
        current = nxt
    return current


def field(record, path):
    """Field lookup on one record. '.' = the record itself; 'tag:Key' looks in
    a Tags list ([{Key,Value}]) or map; 'A.B' walks nested dicts."""
    if path == ".":
        return record if isinstance(record, str) else None
    if not isinstance(record, dict):
        return None
    if path.startswith("tag:"):
        want = path[4:]
        tags = record.get("Tags") or record.get("TagSet") or []
        if isinstance(tags, dict):
            return tags.get(want)
        if isinstance(tags, list):
            for t in tags:
                if isinstance(t, dict) and t.get("Key") == want:
                    return t.get("Value")
        return None
    value = record
    for seg in path.split("."):
        if not isinstance(value, dict) or seg not in value:
            return None
        value = value[seg]
    return value


def resolve_name(record, spec, rid):
    candidates = spec.get("name", [])
    if isinstance(candidates, str):
        candidates = [candidates]
    for cand in candidates:
        value = field(record, cand)
        if isinstance(value, str) and value.strip():
            return value
    return rid


def match_skip(record, skips):
    """First matching skip rule's reason, else None."""
    for rule in skips or []:
        value = field(record, rule["field"])
        if value is None:
            continue
        if "equals" in rule and value == rule["equals"]:
            return rule["reason"]
        if "prefix" in rule and isinstance(value, str) and value.startswith(rule["prefix"]):
            return rule["reason"]
    return None


def to_label(name):
    """Mechanical HCL-safe label from a display name (the prod archive's
    labels were hand-curated on top of exactly this shape — snake_case,
    e.g. AlarmActionSDP -> alarm_action_sdp; curate in the manifest before
    gen-imports if you want nicer ones)."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        s = "unnamed"
    if s[0].isdigit():
        s = "x_" + s  # HCL labels must not start with a digit; x_ marks "curate me"
    return s


def _arn_family(arn):
    """The ARN 'family' bucket the coverage sweep classifies by: the ARN's
    service-namespace segment (arn:partition:SERVICE:region:account:resource).
    None if `arn` does not even have ARN shape (5 colon-separated fields).
    Coarser than a Terraform resource type on purpose — see services.json
    $comment (`arnHint`) and README "coverage sweep" for why: an ARN's
    resource-type token uses inconsistent delimiters across services ('/' for
    most, ':' for e.g. lambda/rds) and isn't always present at all (bare S3
    bucket/SNS-topic names), so parsing it further would trade a simple,
    always-correct rule for a fragile, sometimes-wrong one."""
    m = ARN_RE.match(arn)
    return m.group(2) if m else None


def _redact_arn_account(arn):
    """`arn` with its account-id field replaced — coverage.unrecognizedArnFamilies
    carries one sample ARN per family to help a human find the real resource,
    but the manifest must not casually carry a live account id in the clear."""
    m = ARN_RE.match(arn)
    if not m:
        return arn
    partition, service, region, _account, resource = m.groups()
    return f"arn:{partition}:{service}:{region}:REDACTED:{resource}"


def _known_arn_families(services):
    """(covered, manual) — the sets of ARN families services.json already
    accounts for: `types[*].arnHint` (auto-discoverable) and
    `manual[*].arnHints` (documented long-tail gaps). Anything swept that
    lands in neither set is genuinely new to the kit."""
    covered = {spec["arnHint"] for spec in services["types"].values() if spec.get("arnHint")}
    manual = set()
    for group in services.get("manual", []):
        manual.update(group.get("arnHints", []))
    return covered, manual


def _compute_coverage(services, coverage_doc):
    """coverage-resources.json (a captured `aws resourcegroupstaggingapi
    get-resources` response, or None when that capture is absent — an old
    capture dir, or the live sweep itself failed) -> manifest["coverage"].

    Buckets every swept ARN's family into covered / manual / unrecognized
    against services.json (see _known_arn_families). This is a REPORT, not a
    gate: unrecognized families never refuse the build (a resource type this
    kit does not know about yet must not block discovery of the ones it
    does) — cmd_build prints them as a loud WARN instead. A ResourceARN this
    cannot even parse as an ARN DOES refuse (BAD_CAPTURE): that is the capture
    itself being untrustworthy, the same standard applied to unreadable JSON
    everywhere else in this file, not a coverage gap to report around.
    """
    covered_families, manual_families = _known_arn_families(services)
    captured = coverage_doc is not None
    items = []
    if captured:
        items = coverage_doc.get("ResourceTagMappingList") or []
        if not isinstance(items, list):
            refuse("BAD_CAPTURE", f"{COVERAGE_CAPTURE}.json ResourceTagMappingList is not a list")

    by_family = {}
    for idx, item in enumerate(items):
        arn = item.get("ResourceARN") if isinstance(item, dict) else None
        if not isinstance(arn, str) or not arn:
            refuse(
                "BAD_CAPTURE",
                f"{COVERAGE_CAPTURE}.json[{idx}] has no ResourceARN — cannot classify a swept "
                "resource, refusing rather than silently dropping it from the coverage sweep",
            )
        family = _arn_family(arn)
        if family is None:
            refuse("BAD_CAPTURE", f"{COVERAGE_CAPTURE}.json[{idx}] ResourceARN is not a well-formed ARN: {arn!r}")
        bucket = by_family.setdefault(family, {"count": 0, "sample": arn})
        bucket["count"] += 1

    covered_out, manual_out, unrecognized_out = [], [], []
    for family in sorted(by_family):
        info = by_family[family]
        if family in covered_families:
            covered_out.append({"family": family, "count": info["count"]})
        elif family in manual_families:
            manual_out.append({"family": family, "count": info["count"]})
        else:
            unrecognized_out.append(
                {"family": family, "count": info["count"], "sampleArn": _redact_arn_account(info["sample"])}
            )

    return {
        "method": "resourcegroupstaggingapi (taggable resources only)",
        "captured": captured,
        "totalSwept": sum(v["count"] for v in by_family.values()),
        "coveredTypes": covered_out,
        "manualTypes": manual_out,
        "unrecognizedArnFamilies": unrecognized_out,
    }


def cmd_plan_commands(args):
    services = load_services(args.services)
    seen = {}
    for spec in services["types"].values():
        seen.setdefault(spec["capture"], spec["cli"])
    for capture in sorted(seen):
        cli = seen[capture]
        if args.region:
            cli += f" --region {args.region}"
        print(f"{capture}\t{cli}")
    return 0


def cmd_build(args):
    services = load_services(args.services)
    types = services["types"]

    if not os.path.isdir(args.capture_dir):
        refuse("BAD_CAPTURE", f"capture dir {args.capture_dir} does not exist")

    # capture-meta.json: provenance written by discover.sh (or authored with a
    # fixture). Determinism: capturedAt comes from here, never from the clock.
    meta_path = os.path.join(args.capture_dir, "capture-meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as fh:
                meta = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            refuse("BAD_CAPTURE", f"unreadable capture-meta.json: {e}")
    else:
        print("WARN: no capture-meta.json in capture dir — provenance fields will be 'unknown'", file=sys.stderr)

    account = meta.get("account", "unknown")
    if args.require_account and account != args.require_account:
        refuse(
            "ACCOUNT_MISMATCH",
            f"capture-meta.json says account {account!r} but --require-account is "
            f"{args.require_account!r} — refusing to build a manifest for the wrong account",
        )

    overrides = {}
    if args.classify:
        try:
            with open(args.classify) as fh:
                overrides = json.load(fh).get("by_id", {})
        except (OSError, json.JSONDecodeError) as e:
            refuse("BAD_CLASSIFY", f"cannot read classification overrides {args.classify}: {e}")
        bad = sorted(set(overrides.values()) - {"import", "replace", "deprecate", "ignore"})
        if bad:
            refuse("BAD_CLASSIFY", f"unknown disposition(s) {bad} — use import/replace/deprecate/ignore")

    # Load every capture file up front so a corrupt one refuses before any output.
    captures = {}
    for fname in sorted(os.listdir(args.capture_dir)):
        if not fname.endswith(".json") or fname == "capture-meta.json":
            continue
        fpath = os.path.join(args.capture_dir, fname)
        try:
            with open(fpath) as fh:
                captures[fname[: -len(".json")]] = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            refuse("BAD_CAPTURE", f"{fname} is not readable JSON ({e}) — a corrupt capture must not silently produce fewer resources")

    resources, ignored, errors = [], [], []
    seen_ids = {}  # (type, id) -> address-ish, for duplicate reporting
    referenced = set()
    missing = []

    for rtype in sorted(types):
        spec = types[rtype]
        referenced.add(spec["capture"])
        doc = captures.get(spec["capture"])
        if doc is None:
            missing.append(
                {"capture": spec["capture"], "type": rtype, "cli": spec["cli"],
                 "note": "capture file absent — this type was NOT discovered; record it or accept the gap knowingly"}
            )
            continue
        records = walk_records(doc, spec["records"])
        for idx, record in enumerate(records):
            reason = match_skip(record, spec.get("skips"))
            if reason is not None:
                rid = _try_id(record, spec)
                ignored.append({"type": rtype, "id": rid or f"{spec['capture']}[{idx}]", "reason": reason})
                continue
            rid = _try_id(record, spec)
            if not rid:
                refuse(
                    "MALFORMED_RECORD",
                    f"capture {spec['capture']}[{idx}] for {rtype}: cannot extract an id via "
                    f"{spec.get('id') or spec.get('id_format')!r} — refusing rather than dropping the record",
                )
            if (rtype, rid) in seen_ids:
                ignored.append({"type": rtype, "id": rid, "reason": f"duplicate of {seen_ids[(rtype, rid)]}"})
                continue
            name = resolve_name(record, spec, rid)
            disposition = overrides.get(rid, "import")
            row = {
                "type": rtype,
                "id": rid,
                "name": name,
                "service": spec["service"],
                "phase": spec["phase"],
                "stateful": bool(spec["stateful"]),
                "disposition": disposition,
            }
            resources.append(row)
            seen_ids[(rtype, rid)] = f"{rtype} (name {name!r})"

    # Deterministic labels: sort within type by (name, id), then dedupe with
    # numeric suffixes (the prod archive numbers collisions the same way, e.g.
    # aws_security_group.app_http / app_http_https_2).
    resources.sort(key=lambda r: (r["type"], str(r["name"]).lower(), r["id"]))
    used = set()
    for row in resources:
        base = to_label(str(row["name"]))
        label = base
        n = 1
        while (row["type"], label) in used:
            n += 1
            label = f"{base}_{n}"
        used.add((row["type"], label))
        row["label"] = label

    # coverage-resources.json is a recognized capture on its own (Gap 1's
    # account-wide sweep), not a services.json type — exclude it from the
    # "nobody claims this capture" diff; _compute_coverage consumes it below.
    unmapped = [
        {"capture": name + ".json",
         "reason": "no services.json entry references this capture — resources in it are NOT imported"}
        for name in sorted(set(captures) - referenced - {COVERAGE_CAPTURE})
    ]

    coverage = _compute_coverage(services, captures.get(COVERAGE_CAPTURE))

    manifest = {
        "schema": 1,
        "generator": "importer/kit/discover.py",
        "account": account,
        "region": meta.get("region", "unknown"),
        "capturedAt": meta.get("capturedAt", "unknown"),
        "servicesSha256": _sha256_file(args.services),
        "resources": resources,
        "ignored": sorted(ignored, key=lambda r: (r["type"], str(r["id"]))),
        "unmapped_captures": unmapped,
        "missing_captures": sorted(missing, key=lambda r: (r["capture"], r["type"])),
        "manual_followup": services.get("manual", []),
        "coverage": coverage,
        "errors": errors,
    }
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    by_phase = {}
    for row in resources:
        by_phase[row["phase"]] = by_phase.get(row["phase"], 0) + 1
    print(f"WROTE {len(resources)} resources to {args.out}")
    print(f"  by phase: " + ", ".join(f"P{p}={n}" for p, n in sorted(by_phase.items())))
    if ignored:
        print(f"  ignored (with reasons, see manifest): {len(ignored)}")
    if unmapped:
        print(f"  UNMAPPED capture files (NOT imported — extend services.json or drop them): {len(unmapped)}", file=sys.stderr)
        for u in unmapped:
            print(f"    {u['capture']}", file=sys.stderr)
    if missing:
        print(f"  MISSING captures (types not discovered): {len(missing)}", file=sys.stderr)
        for m in missing:
            print(f"    {m['capture']} ({m['type']})", file=sys.stderr)
    print(f"  manual follow-up type groups (cannot be auto-discovered): {len(manifest['manual_followup'])}")
    if coverage["captured"]:
        print(
            f"  coverage sweep ({coverage['method']}): {coverage['totalSwept']} taggable resource(s) — "
            f"{len(coverage['coveredTypes'])} recognized families, {len(coverage['manualTypes'])} manual, "
            f"{len(coverage['unrecognizedArnFamilies'])} unrecognized"
        )
    else:
        print(f"  coverage sweep: not captured (no {COVERAGE_CAPTURE}.json in the capture dir)")
    if coverage["unrecognizedArnFamilies"]:
        total_unrecognized = sum(f["count"] for f in coverage["unrecognizedArnFamilies"])
        print(
            f"WARN: {total_unrecognized} resource(s) in {len(coverage['unrecognizedArnFamilies'])} "
            "unrecognized ARN families — NOT imported, extend services.json",
            file=sys.stderr,
        )
        for fam in coverage["unrecognizedArnFamilies"]:
            print(f"    {fam['family']}: {fam['count']} resource(s), e.g. {fam['sampleArn']}", file=sys.stderr)
    print("next: review labels/dispositions in the manifest, then gen-imports.py "
          "(docs/runbooks/new-env-import.md, phase 2)")
    return 0


def _try_id(record, spec):
    if "id_format" in spec:
        if not isinstance(record, dict):
            return None
        try:
            return spec["id_format"].format(**record)
        except (KeyError, IndexError):
            return None
    value = field(record, spec["id"])
    return value if isinstance(value, str) and value else None


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("plan-commands", help="print capture<TAB>cli lines for the live driver")
    p1.add_argument("--services", default=DEFAULT_SERVICES)
    p1.add_argument("--region", default="")
    p1.set_defaults(func=cmd_plan_commands)

    p2 = sub.add_parser("build", help="captures -> discovery-manifest.json")
    p2.add_argument("--capture-dir", required=True)
    p2.add_argument("--services", default=DEFAULT_SERVICES)
    p2.add_argument("--out", required=True)
    p2.add_argument("--require-account", default="", help="refuse unless capture-meta.json account matches")
    p2.add_argument("--classify", default="", help="JSON {'by_id': {'<id>': 'import|replace|deprecate|ignore'}}")
    p2.set_defaults(func=cmd_build)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
