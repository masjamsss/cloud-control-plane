#!/usr/bin/env python3
"""statediff.py — diff a discovery-kit capture against Terraform's own prior
state to find live-but-unmanaged (out-of-band-provisioned) resources.

Spec: docs/superpowers/specs/2026-07-20-ccp-oob-provisioning-import.md
§2.2-§2.6 (WI-S1). Reuses the discovery manifest discover.py already builds
(``resources[]`` rows: type/id/name/service/stateful/label, each already
services.json-typed) and Terraform's own ``prior_state`` (the JSON
``terraform show -json tfplan`` already produces for the plan/drift steps).
A live ``(type, id)`` pair absent from prior_state, and not matched by a
curated ignore rule, is a **finding** — a resource console-created (or
otherwise never brought under Terraform) that ``terraform plan`` can never
see, because nothing in code or state references it (runbook D5).

Usage (the exact invocation the drift workflow runs, §2.2):

    python3 importer/kit/statediff.py \\
      --manifest work/sweep/discovery-manifest.json \\
      --plan     environments/prod/plan.json \\
      --services importer/kit/services.json \\
      --ignore   scripts/drift/sweep-ignore.json \\
      --out      work/sweep/unmanaged-findings.json \\
      [--candidates-out work/sweep/candidates-manifest.json]

Two outputs, one run:
  --out             every finding (§2.4 row shape), sorted by (arn or "",
                     tfType, liveId) for byte-stable output; plus the
                     ignored tally and the manifest's own coverage block
                     carried through verbatim.
  --candidates-out   optional. A SUBSET of findings shaped as a
                     discover.py-style manifest (schema `resources[]` with
                     type/id/label/disposition) so it feeds
                     ``gen-imports.py`` UNCHANGED — zero new HCL-emission
                     code (§2.6 step 1/2). Selection: known tfType (always
                     true here — every finding already came from a
                     services.json-typed manifest row), NOT in the
                     watchlist's advisory ``creation_security_types`` (best
                     effort — see load_watchlist_creation_types), capped at
                     the first 20 after sorting. Mechanical labels:
                     ``oob_`` + sanitized(name, else liveId); a collision or
                     an empty sanitized body appends ``_`` + the first 8 hex
                     digits of sha256(arn or "type:id") — deterministic and
                     HCL-valid by construction (gen-imports.py's own
                     LABEL_RE is the oracle).

Ignore rules (--ignore, default scripts/drift/sweep-ignore.json): a
reviewed, committed list (§2.3) of ``{kind, reason, ...}`` rows, matched in
file order (first match wins) against state-unmatched rows only — an
ignore-matched resource is never counted as "state-matched", it is a
DIFFERENT, curated reason to exclude it, and unlike a state match it is
COUNTED (ignoredCount + ignoredByRule) so suppression is visible, never
silent. Kinds:
  id        exact match on (type, liveId)
  arn       exact match on the finding's derived arn (see below)
  idPrefix  (type, liveId prefix)
  tagKey    the live resource carries this tag KEY (value irrelevant) —
            answered from the raw per-type capture file sibling to
            --manifest (discover.sh always writes captures and
            discovery-manifest.json into the same --out directory; the
            manifest itself only carries the resolved display `name`, not
            arbitrary tags). Missing/unreadable capture data degrades to
            "no tags known" — a tagKey rule simply does not fire, it never
            errors the sweep. Override the inferred directory with
            --capture-dir.

An arn is only ever set when it is TRIVIALLY derivable, never guessed:
services.json already returns a literal ARN as `id` for six types (
aws_iam_policy, aws_lb, aws_lb_target_group, aws_sns_topic,
aws_acm_certificate, aws_cloudtrail) — those ids already start with "arn:";
every other type's arn is left null (honest gap over a guessed shape,
matching discover.py's own arnHint doctrine).

``securityFamily`` on a finding, and candidate-manifest exclusion, are an
ADVISORY, best-effort copy of scripts/drift/security-watchlist.json's
additive ``creation_security_types`` key (§5.3) — read if present, empty
set if the file/key is absent (as it is until that lane lands; never a
refusal). The REAL enforcement is the three independent screens in the
generator/api/gate (§5.3); nothing here is trusted as a security gate.

Nothing here calls AWS or the system clock: capturedAt/account/region are
always passed through from --manifest, never generated. Same-input reruns
are byte-identical.

Stdlib only. Exit codes: 0 ok · 2 refusal (message starts with
"REFUSE <CODE>:").
"""
import argparse
import hashlib
import json
import os
import re
import sys

KIT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(KIT_DIR, "..", ".."))
DEFAULT_SERVICES = os.path.join(KIT_DIR, "services.json")
DEFAULT_IGNORE = os.path.join(REPO_ROOT, "scripts", "drift", "sweep-ignore.json")
DEFAULT_WATCHLIST = os.path.join(REPO_ROOT, "scripts", "drift", "security-watchlist.json")

FINDING_CLASS = "unmanaged_resource"
SWEEP_METHOD = "importer-kit discover: 43 per-type listers + resourcegroupstaggingapi family sweep"
CANDIDATE_CAP = 20
IGNORE_KINDS = ("id", "arn", "tagKey", "idPrefix")

_SANITIZE_RE = re.compile(r"[^a-z0-9_]+")
_COLLAPSE_RE = re.compile(r"_+")


def refuse(code, msg):
    print(f"REFUSE {code}: {msg}", file=sys.stderr)
    sys.exit(2)


def _load_json(path, code, what):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse(code, f"cannot read {what} ({path}): {e}")


# ── inputs ───────────────────────────────────────────────────────────────────

def load_manifest(path):
    doc = _load_json(path, "BAD_MANIFEST", "discovery manifest")
    if not isinstance(doc, dict) or not isinstance(doc.get("resources"), list):
        refuse("BAD_MANIFEST", f"{path} has no 'resources' list — not a discover.py discovery-manifest.json")
    return doc


def load_services(path):
    doc = _load_json(path, "BAD_SERVICES", "services allowlist")
    if not isinstance(doc, dict) or not isinstance(doc.get("types"), dict) or not doc["types"]:
        refuse("BAD_SERVICES", f"{path} has no 'types' mapping")
    return doc


def load_plan(path):
    doc = _load_json(path, "BAD_PLAN", "terraform plan JSON")
    if not isinstance(doc, dict):
        refuse("BAD_PLAN", f"{path} is not a JSON object — expected `terraform show -json` output")
    if not ({"prior_state", "planned_values", "resource_changes"} & set(doc)):
        refuse("BAD_PLAN", f"{path} has none of prior_state/planned_values/resource_changes — not a plan JSON")
    return doc


def load_ignore_rules(path):
    doc = _load_json(path, "BAD_IGNORE", "ignore rules")
    rules = doc.get("rules") if isinstance(doc, dict) else None
    if not isinstance(rules, list):
        refuse("BAD_IGNORE", f"{path} has no 'rules' list")
    for i, rule in enumerate(rules):
        if not isinstance(rule, dict):
            refuse("BAD_IGNORE", f"{path} rules[{i}] is not an object")
        kind = rule.get("kind")
        if kind not in IGNORE_KINDS:
            refuse("BAD_IGNORE", f"{path} rules[{i}] has unknown kind {kind!r} — must be one of {list(IGNORE_KINDS)}")
        if not isinstance(rule.get("reason"), str) or not rule["reason"].strip():
            refuse("BAD_IGNORE", f"{path} rules[{i}] (kind {kind}) has no 'reason' — every ignore rule must say why (§2.3)")
        if kind == "id" and not (isinstance(rule.get("type"), str) and isinstance(rule.get("id"), str) and rule["type"] and rule["id"]):
            refuse("BAD_IGNORE", f"{path} rules[{i}] kind 'id' needs non-empty 'type' and 'id'")
        if kind == "arn" and not (isinstance(rule.get("arn"), str) and rule["arn"]):
            refuse("BAD_IGNORE", f"{path} rules[{i}] kind 'arn' needs a non-empty 'arn'")
        if kind == "idPrefix" and not (isinstance(rule.get("type"), str) and isinstance(rule.get("idPrefix"), str) and rule["type"] and rule["idPrefix"]):
            refuse("BAD_IGNORE", f"{path} rules[{i}] kind 'idPrefix' needs non-empty 'type' and 'idPrefix'")
        if kind == "tagKey" and not (isinstance(rule.get("tagKey"), str) and rule["tagKey"]):
            refuse("BAD_IGNORE", f"{path} rules[{i}] kind 'tagKey' needs a non-empty 'tagKey'")
    return rules


def load_watchlist_creation_types(path):
    """Best-effort, advisory only — §5.3's real screens live in the
    generator/api/gate, none of which is this script. A missing file,
    unreadable JSON, or an absent key all degrade to "nothing is
    security-family yet" rather than a refusal: this is the same additive
    key discipline the rest of the audit-fix watchlist machinery already
    uses (classify.py tolerates unrecognized watchlist keys)."""
    try:
        with open(path) as fh:
            doc = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return frozenset()
    types = doc.get("creation_security_types") if isinstance(doc, dict) else None
    if not isinstance(types, list):
        return frozenset()
    return frozenset(t for t in types if isinstance(t, str))


# ── prior_state walk ─────────────────────────────────────────────────────────

def state_keys_from_plan(plan_doc):
    """(type, id) pairs for every MANAGED resource in prior_state, root
    module plus child modules recursed (this estate is single-root per
    ADR-0004, but the walk costs nothing and is honest about the shape
    `terraform show -json` can produce). `mode: "data"` entries (data
    sources also live in prior_state) are deliberately excluded — a data
    source reads a live resource, it does not manage it."""
    prior = plan_doc.get("prior_state")
    if not isinstance(prior, dict):
        return set()
    root = ((prior.get("values") or {}).get("root_module")) or {}
    keys = set()
    stack = [root]
    while stack:
        module = stack.pop()
        if not isinstance(module, dict):
            continue
        for res in module.get("resources") or []:
            if not isinstance(res, dict) or res.get("mode") != "managed":
                continue
            rtype = res.get("type")
            rid = (res.get("values") or {}).get("id")
            if isinstance(rtype, str) and isinstance(rid, str) and rid:
                keys.add((rtype, rid))
        children = module.get("child_modules")
        if isinstance(children, list):
            stack.extend(children)
    return keys


# ── raw-capture tag lookup (tagKey ignore rules only) ───────────────────────

class TagLookup:
    """Best-effort reader of the raw per-type captures sibling to
    --manifest, for `tagKey` ignore rules only. discover.sh always writes
    `<capture>.json` files and discovery-manifest.json into the SAME --out
    directory (importer/kit/discover.sh); the built manifest itself keeps
    only the resolved display `name`, never arbitrary tags. This re-opens
    exactly the one capture a given (type, id) needs, via services.json's
    own capture/records/id fields (a narrow, read-only echo of
    discover.py's walk_records()/field(), scoped to tag extraction only).
    Anything unavailable — no capture dir, capture file absent, record not
    found — degrades to "no tags known": the tagKey rule simply does not
    fire for that resource. It never raises."""

    def __init__(self, capture_dir, services):
        self.capture_dir = capture_dir
        self.types = services.get("types", {})
        self._docs = {}  # capture name -> parsed JSON, or None if unreadable/absent

    def _capture_doc(self, capture_name):
        if capture_name not in self._docs:
            path = os.path.join(self.capture_dir, capture_name + ".json") if self.capture_dir else ""
            try:
                with open(path) as fh:
                    self._docs[capture_name] = json.load(fh)
            except (OSError, json.JSONDecodeError, TypeError):
                self._docs[capture_name] = None
        return self._docs[capture_name]

    def tag_keys_for(self, rtype, rid):
        spec = self.types.get(rtype)
        if not spec:
            return frozenset()
        doc = self._capture_doc(spec["capture"])
        if doc is None:
            return frozenset()
        for record in _walk_records(doc, spec["records"]):
            if _extract_id(record, spec) == rid:
                return _extract_tag_keys(record)
        return frozenset()


def _walk_records(doc, path):
    """Resolve a dotted record path exactly like discover.py's
    walk_records(): a trailing [] flattens a list, '.' is the document
    itself, a missing key yields []."""
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


def _extract_id(record, spec):
    if "id_format" in spec:
        if not isinstance(record, dict):
            return None
        try:
            return spec["id_format"].format(**record)
        except (KeyError, IndexError):
            return None
    path = spec.get("id", ".")
    if path == ".":
        return record if isinstance(record, str) else None
    value = record
    for seg in path.split("."):
        if not isinstance(value, dict) or seg not in value:
            return None
        value = value[seg]
    return value


def _extract_tag_keys(record):
    if not isinstance(record, dict):
        return frozenset()
    tags = record.get("Tags")
    if tags is None:
        tags = record.get("TagSet")
    if isinstance(tags, dict):
        return frozenset(tags.keys())
    if isinstance(tags, list):
        return frozenset(t.get("Key") for t in tags if isinstance(t, dict) and isinstance(t.get("Key"), str))
    return frozenset()


# ── ignore-rule matching ─────────────────────────────────────────────────────

def match_ignore_rule(row, arn, rules, tag_lookup):
    """First matching rule (index, rule), else None. Matched in file order —
    a deliberate, reviewed-data property, not an unordered set lookup."""
    for idx, rule in enumerate(rules):
        kind = rule["kind"]
        if kind == "id":
            if row["type"] == rule["type"] and row["id"] == rule["id"]:
                return idx, rule
        elif kind == "arn":
            if arn is not None and arn == rule["arn"]:
                return idx, rule
        elif kind == "idPrefix":
            if row["type"] == rule["type"] and row["id"].startswith(rule["idPrefix"]):
                return idx, rule
        elif kind == "tagKey":
            if rule.get("type") and rule["type"] != row["type"]:
                continue
            if rule["tagKey"] in tag_lookup.tag_keys_for(row["type"], row["id"]):
                return idx, rule
    return None


def rule_signature(rule):
    return {k: v for k, v in rule.items() if k not in ("kind", "reason")}


# ── findings ─────────────────────────────────────────────────────────────────

def arn_if_derivable(row):
    """An arn only when it is TRIVIALLY already the id — six services.json
    types (aws_iam_policy, aws_lb, aws_lb_target_group, aws_sns_topic,
    aws_acm_certificate, aws_cloudtrail) extract a literal ARN as `id`.
    Every other type is left null rather than guessing a resource-type ARN
    segment services.json does not carry (the same honest-gap-over-a-guess
    doctrine as services.json's own arnHint comment)."""
    rid = row.get("id")
    return rid if isinstance(rid, str) and rid.startswith("arn:") else None


def build_finding(row, arn, region, security_family):
    return {
        "class": FINDING_CLASS,
        "arn": arn,
        "tfType": row["type"],
        "liveId": row["id"],
        "name": row.get("name", row["id"]),
        "service": row.get("service"),
        "stateful": bool(row.get("stateful")),
        "region": region,
        "securityFamily": security_family,
        "actor": None,               # §2.5 CloudTrail enrichment — a later, separate step
        "importPayload": None,       # §2.6 attachment — payloads.py, a later, separate step
        "payloadWithheldReason": None,
    }


def finding_sort_key(finding):
    return (finding["arn"] or "", finding["tfType"], finding["liveId"])


# ── candidate labeling (§2.6 step 1) ────────────────────────────────────────

def sanitize_label_part(value):
    s = str(value).lower()
    s = _SANITIZE_RE.sub("_", s)
    s = _COLLAPSE_RE.sub("_", s)
    return s.strip("_")


def oob_label(finding, used):
    """`oob_` + sanitized(name, else liveId); on collision OR an empty
    sanitized body, append `_` + the first 8 hex digits of
    sha256(arn or "type:id") — deterministic, and unique by construction
    since (type, liveId) is already the finding's own dedup key. `used` is
    scoped to (tfType, label) pairs, exactly like discover.py's own
    dedup — two different types may legally share a label."""
    base = "oob_" + sanitize_label_part(finding["name"] or finding["liveId"])
    label = base
    if label == "oob_" or (finding["tfType"], label) in used:
        digest_src = finding["arn"] or f"{finding['tfType']}:{finding['liveId']}"
        suffix = hashlib.sha256(digest_src.encode("utf-8")).hexdigest()[:8]
        label = f"{base}_{suffix}"
    used.add((finding["tfType"], label))
    return label


# ── output ───────────────────────────────────────────────────────────────────

def write_json(path, doc):
    out_dir = os.path.dirname(os.path.abspath(path))
    os.makedirs(out_dir, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--manifest", required=True, help="discover.py discovery-manifest.json")
    p.add_argument("--plan", required=True, help="terraform show -json tfplan output (reads prior_state)")
    p.add_argument("--services", default=DEFAULT_SERVICES)
    p.add_argument("--ignore", default=DEFAULT_IGNORE)
    p.add_argument("--out", required=True, help="unmanaged-findings.json to write")
    p.add_argument("--candidates-out", default="", help="optional: candidates-manifest.json (gen-imports.py-ready) to write")
    p.add_argument("--watchlist", default=DEFAULT_WATCHLIST, help="advisory creation_security_types source (§5.3)")
    p.add_argument("--capture-dir", default="", help="raw per-type captures for tagKey rules (default: --manifest's own directory)")
    args = p.parse_args(argv)

    manifest = load_manifest(args.manifest)
    services = load_services(args.services)
    ignore_rules = load_ignore_rules(args.ignore)
    plan_doc = load_plan(args.plan)
    creation_security_types = load_watchlist_creation_types(args.watchlist)

    capture_dir = args.capture_dir or os.path.dirname(os.path.abspath(args.manifest))
    tag_lookup = TagLookup(capture_dir, services)
    state_keys = state_keys_from_plan(plan_doc)
    region = manifest.get("region", "unknown")

    findings = []
    ignored_tally = {}  # rule index -> count
    for row in manifest["resources"]:
        for key in ("type", "id"):
            if not isinstance(row.get(key), str) or not row[key]:
                refuse("MALFORMED_ROW", f"manifest resource is missing '{key}': {row!r}")
        # A human classification override (discover.py --classify) is a
        # curated decision with its own provenance, distinct from both
        # "managed" and "ignored" — never surfaced as an unmanaged finding.
        if row.get("disposition", "import") != "import":
            continue
        if (row["type"], row["id"]) in state_keys:
            continue  # genuinely managed (a different Terraform root, or this one) — not a finding
        arn = arn_if_derivable(row)
        match = match_ignore_rule(row, arn, ignore_rules, tag_lookup)
        if match is not None:
            idx, _rule = match
            ignored_tally[idx] = ignored_tally.get(idx, 0) + 1
            continue
        security_family = row["type"] in creation_security_types
        findings.append(build_finding(row, arn, region, security_family))

    findings.sort(key=finding_sort_key)

    ignored_by_rule = [
        {
            "kind": ignore_rules[idx]["kind"],
            "match": rule_signature(ignore_rules[idx]),
            "reason": ignore_rules[idx]["reason"],
            "count": count,
        }
        for idx, count in sorted(ignored_tally.items())
    ]
    ignored_count = sum(ignored_tally.values())

    out_doc = {
        "schema": 1,
        "generator": "importer/kit/statediff.py",
        "method": SWEEP_METHOD,
        "account": manifest.get("account", "unknown"),
        "region": region,
        "capturedAt": manifest.get("capturedAt", "unknown"),
        "findings": findings,
        "totalFindings": len(findings),
        "ignoredCount": ignored_count,
        "ignoredByRule": ignored_by_rule,
        "coverage": manifest.get("coverage", {}),
    }
    write_json(args.out, out_doc)

    candidates = [f for f in findings if not f["securityFamily"]][:CANDIDATE_CAP]
    if args.candidates_out:
        row_by_key = {(r["type"], r["id"]): r for r in manifest["resources"]}
        used_labels = set()
        resources = []
        for f in candidates:
            row = row_by_key.get((f["tfType"], f["liveId"]), {})
            resources.append({
                "type": f["tfType"],
                "id": f["liveId"],
                "label": oob_label(f, used_labels),
                "name": f["name"],
                "service": f["service"],
                "phase": row.get("phase"),
                "stateful": f["stateful"],
                "disposition": "import",
            })
        write_json(args.candidates_out, {
            "schema": 1,
            "generator": "importer/kit/statediff.py",
            "account": manifest.get("account", "unknown"),
            "region": region,
            "capturedAt": manifest.get("capturedAt", "unknown"),
            "resources": resources,
        })

    print(
        f"WROTE {len(findings)} finding(s) to {args.out} "
        f"({ignored_count} ignored, {len(candidates)} import-candidate(s))"
    )
    if args.candidates_out:
        print(f"WROTE {len(candidates)} candidate(s) to {args.candidates_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
