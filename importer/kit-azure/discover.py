#!/usr/bin/env python3
"""discover.py — turn recorded Azure Resource Graph (ARG) captures into a discovery manifest.

The Azure sibling of importer/kit/discover.py. Offline by construction: this script
NEVER calls Azure. The only thing that ever talks to Azure is discover.sh's live mode
(a thin `az graph query` loop); everything here reads JSON files from a --capture-dir,
so the whole pipeline is testable against the recorded fixtures under testdata/ (and a
real capture directory is processed identically — same code path, no divergence).

Subcommands
  plan-commands  --services F
      Print one "capture<TAB>kql" line per fixed ARG capture in the allowlist
      (graphCaptures). discover.sh wraps each kql in a FIXED read-only
      `az graph query -q <kql> --first 1000 --output json --subscriptions <sub>` call
      (so the driver only ever runs the read-only graph-query verb — a stronger safety
      property than the AWS kit's data-driven service/action). --dry-run prints the plan.
  next-token     --page PAGEFILE
      Print the ARG continuation token (skip_token / skipToken) of one captured page,
      or nothing if the page is the last. discover.sh's paging loop consumes this so that
      ALL JSON parsing stays in Python — discover.sh never parses JSON (mirrors the AWS
      kit, where bash only ever ran `az ... --query` server-side extraction).
  build          --capture-dir D --services F --out MANIFEST
                 [--require-subscription S] [--require-tenant T] [--classify OVERRIDES]
      Merge every capture's pages, extract resources per the azure-services.json allowlist,
      classify the whole sweep at full Microsoft.Provider/type granularity, and write the
      machine-readable discovery manifest.

Nothing is ever silently dropped (0007's silent-loss lesson, applied at every layer):
  - a row matching a `skips` rule           -> manifest.ignored[] with the reason
  - a duplicate (type,id)                    -> manifest.ignored[] ("duplicate of ...")
  - a capture file no graphCapture names     -> manifest.unmapped_captures[] (loud)
  - an allowlisted type's capture is absent  -> manifest.missing_captures[] (loud)
  - types the kit cannot enumerate (manual)  -> manifest.manual_followup[]
  - a resource type OUTSIDE the allowlist    -> manifest.coverage.unrecognizedResourceTypes[]
    (WARN on stderr; a report, never a build-failing gate)
  - a swept row with no 'type'               -> REFUSE BAD_CAPTURE, exit 2
  - an allowlisted row whose id is missing    -> REFUSE MALFORMED_RECORD, exit 2
  - an unreadable/invalid JSON capture       -> REFUSE BAD_CAPTURE, exit 2
  - a wrong-subscription/-tenant capture      -> REFUSE SUBSCRIPTION_MISMATCH / TENANT_MISMATCH

Stdlib only (json/argparse) — runs on a bare python3, no pip install.
Deterministic: capturedAt/subscription/tenant come from capture-meta.json, never from the
clock or ambient env, so re-running build on the same captures is byte-identical.

Exit codes: 0 ok · 2 refusal (message starts with "REFUSE <CODE>:").
"""
import argparse
import hashlib
import json
import os
import re
import sys

KIT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SERVICES = os.path.join(KIT_DIR, "azure-services.json")

# A well-formed Azure resource id: /subscriptions/<guid>/... — used only to redact the
# subscription guid + resource-group name out of a coverage sample id (the manifest must
# not casually carry a live subscription id / RG name in the clear). Case-insensitive
# because ARM ids are returned with inconsistent segment casing.
SUBSCRIPTION_SEG = re.compile(r"/subscriptions/[^/]+", re.IGNORECASE)
RG_SEG = re.compile(r"/resourceGroups/[^/]+", re.IGNORECASE)
# KQL clauses that suppress ARG's skip-token and silently cap a query at its page size —
# forbidden in a graphCapture kql (silent-truncation foot-gun; README "coverage sweep").
BANNED_KQL = re.compile(r"\b(limit|take|sample|sample-distinct)\b", re.IGNORECASE)


def refuse(code, msg):
    print(f"REFUSE {code}: {msg}", file=sys.stderr)
    sys.exit(2)


def load_services(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse("BAD_SERVICES", f"cannot read allowlist {path}: {e}")

    captures = data.get("graphCaptures")
    if not isinstance(captures, list) or not captures:
        refuse("BAD_SERVICES", f"{path} has no 'graphCaptures' list")
    capture_names = set()
    for cap in captures:
        for key in ("capture", "kql"):
            if key not in cap:
                refuse("BAD_SERVICES", f"graphCaptures entry is missing required key '{key}': {cap}")
        if BANNED_KQL.search(cap["kql"]):
            refuse(
                "BAD_SERVICES",
                f"graphCapture '{cap['capture']}' kql contains a paging-suppressing clause "
                "(limit/take/sample) — it would silently cap results at one page; remove it",
            )
        capture_names.add(cap["capture"])

    types = data.get("types")
    if not isinstance(types, dict) or not types:
        refuse("BAD_SERVICES", f"{path} has no 'types' mapping")
    seen_hints = {}
    for rtype, spec in types.items():
        for key in ("typeHint", "capture", "service", "phase", "stateful", "providerHint"):
            if key not in spec:
                refuse("BAD_SERVICES", f"types.{rtype} is missing required key '{key}'")
        hint = spec["typeHint"].lower()
        if hint in seen_hints:
            refuse(
                "BAD_SERVICES",
                f"typeHint {hint!r} is claimed by two types ({seen_hints[hint]} and {rtype}); "
                "an ARM type must map to exactly one Terraform type here (put ambiguous ones "
                "— e.g. Linux/Windows VMs — in manual[] instead)",
            )
        seen_hints[hint] = rtype
        if spec["capture"] not in capture_names:
            refuse("BAD_SERVICES", f"types.{rtype} capture {spec['capture']!r} is not a declared graphCapture")
        if spec["providerHint"] not in ("azurerm", "azapi"):
            refuse("BAD_SERVICES", f"types.{rtype} providerHint must be azurerm or azapi, got {spec['providerHint']!r}")
    return data


def merge_pages(capture_dir, capture):
    """All rows for one logical capture, merging ARG pages written by discover.sh's
    skip-token loop (<capture>.page0.json, .page1.json, ...) OR a single <capture>.json
    (a one-page fixture). Returns None when NO file exists (the capture is absent — a loud
    gap), or a list of row dicts (possibly empty — an empty estate is legal ARG output).

    Each page is an ARG envelope {"data": [...], "count": N, "skip_token": ...}; a bare list
    is also accepted defensively."""
    pages = []
    single = os.path.join(capture_dir, f"{capture}.json")
    paged = sorted(
        f for f in os.listdir(capture_dir)
        if re.fullmatch(re.escape(capture) + r"\.page\d+\.json", f)
    )
    if os.path.exists(single):
        pages.append(single)
    pages.extend(os.path.join(capture_dir, f) for f in paged)
    if not pages:
        return None
    rows = []
    for p in pages:
        try:
            with open(p) as fh:
                doc = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            refuse("BAD_CAPTURE", f"{os.path.basename(p)} is not readable JSON ({e}) — a corrupt "
                                  "capture must not silently produce fewer resources")
        data = doc if isinstance(doc, list) else doc.get("data")
        if data is None:
            data = []
        if not isinstance(data, list):
            refuse("BAD_CAPTURE", f"{os.path.basename(p)} 'data' is not a list")
        rows.extend(data)
    return rows


def field(row, path):
    """Field lookup on one ARG row. '.' = the row itself (string rows); 'tag:Key' looks in
    the ARG tags object (a {key:value} map) or a [{name,value}] list; 'A.B' walks nested dicts."""
    if path == ".":
        return row if isinstance(row, str) else None
    if not isinstance(row, dict):
        return None
    if path.startswith("tag:"):
        want = path[4:]
        tags = row.get("tags") or {}
        if isinstance(tags, dict):
            return tags.get(want)
        if isinstance(tags, list):
            for t in tags:
                if isinstance(t, dict) and t.get("name") == want:
                    return t.get("value")
        return None
    value = row
    for seg in path.split("."):
        if not isinstance(value, dict) or seg not in value:
            return None
        value = value[seg]
    return value


def resolve_name(row, spec, rid):
    candidates = spec.get("name", "name")
    if isinstance(candidates, str):
        candidates = [candidates]
    for cand in candidates:
        value = field(row, cand)
        if isinstance(value, str) and value.strip():
            return value
    return rid


def match_skip(row, skips):
    for rule in skips or []:
        value = field(row, rule["field"])
        if value is None:
            continue
        if "equals" in rule and value == rule["equals"]:
            return rule["reason"]
        if "prefix" in rule and isinstance(value, str) and value.startswith(rule["prefix"]):
            return rule["reason"]
    return None


def to_label(name):
    """Mechanical HCL-safe label from a display name (curate nicer ones in the manifest
    before gen-imports if you want them). snake_case, non-alnum -> _, digit-leading -> x_."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        s = "unnamed"
    if s[0].isdigit():
        s = "x_" + s  # HCL labels must not start with a digit; x_ marks "curate me"
    return s


def _row_type(row):
    t = row.get("type") if isinstance(row, dict) else None
    return t.lower() if isinstance(t, str) and t else None


def _redact_id(rid):
    if not isinstance(rid, str):
        return None
    rid = SUBSCRIPTION_SEG.sub("/subscriptions/REDACTED", rid)
    rid = RG_SEG.sub("/resourceGroups/REDACTED", rid)
    return rid


def _known_type_sets(services):
    covered = {spec["typeHint"].lower() for spec in services["types"].values()}
    manual = set()
    for group in services.get("manual", []):
        manual.update(h.lower() for h in group.get("typeHints", []))
    return covered, manual


def _compute_coverage(services, all_rows, primary_captured):
    """Bucket every swept ARG row's full type (Microsoft.Provider/type) into
    covered / manual / unrecognized against the allowlist. A REPORT, not a gate:
    unrecognized types never refuse the build — cmd_build prints them as a loud WARN.
    A swept row with NO 'type' DOES refuse (BAD_CAPTURE): a row the sweep cannot even
    classify is the capture being untrustworthy, the same bar as unreadable JSON."""
    covered_types, manual_types = _known_type_sets(services)
    by_type = {}
    for idx, row in enumerate(all_rows):
        t = _row_type(row)
        if t is None:
            refuse(
                "BAD_CAPTURE",
                f"a swept row (index {idx}) has no 'type' field — cannot classify it for the "
                "coverage sweep, refusing rather than silently dropping it",
            )
        bucket = by_type.setdefault(t, {"count": 0, "sample": row.get("id") if isinstance(row, dict) else None})
        bucket["count"] += 1

    covered_out, manual_out, unrecognized_out = [], [], []
    for t in sorted(by_type):
        info = by_type[t]
        if t in covered_types:
            covered_out.append({"type": t, "count": info["count"]})
        elif t in manual_types:
            manual_out.append({"type": t, "count": info["count"]})
        else:
            unrecognized_out.append({"type": t, "count": info["count"], "sampleId": _redact_id(info["sample"])})

    return {
        "method": "azure resource graph (ARM control-plane, Reader-scoped)",
        "captured": primary_captured,
        "totalSwept": sum(v["count"] for v in by_type.values()),
        "coveredTypes": covered_out,
        "manualTypes": manual_out,
        "unrecognizedResourceTypes": unrecognized_out,
    }


def cmd_plan_commands(args):
    services = load_services(args.services)
    # Emit capture<TAB>kql. discover.sh builds the fixed `az graph query` call around each
    # kql (properly quoting it — a KQL contains spaces and pipes) and adds --subscriptions
    # scoping and skip-token paging itself.
    for cap in services["graphCaptures"]:
        print(f'{cap["capture"]}\t{cap["kql"]}')
    return 0


def cmd_next_token(args):
    try:
        with open(args.page) as fh:
            doc = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse("BAD_CAPTURE", f"cannot read page {args.page}: {e}")
    if isinstance(doc, dict):
        token = doc.get("skip_token") or doc.get("skipToken") or ""
        if token:
            print(token)
    return 0


def cmd_list_subscriptions(args):
    """Format an ARG ResourceContainers capture (subscriptions) into the per-subscription
    iteration list. A tenant/estate almost always spans MANY subscriptions — often under one
    management group — and the kit imports ONE subscription per run, so this enumerates every
    subscription the Reader can see (with its management-group chain) so estate-level coverage
    is loud: a subscription NOT listed here is a Reader-RBAC gap, and a subscription listed but
    never imported is an obvious hole in the per-subscription loop. Offline; reads the capture."""
    try:
        with open(args.capture) as fh:
            doc = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse("BAD_CAPTURE", f"cannot read subscriptions capture {args.capture}: {e}")
    data = doc if isinstance(doc, list) else (doc.get("data") or [])
    if not isinstance(data, list):
        refuse("BAD_CAPTURE", f"{args.capture} 'data' is not a list")

    subs = []
    for row in data:
        if not isinstance(row, dict):
            continue
        if args.tenant and row.get("tenantId") and row.get("tenantId") != args.tenant:
            continue  # defensive: only this tenant's subscriptions
        sid = row.get("subscriptionId") or row.get("id")
        if not isinstance(sid, str) or not sid:
            continue
        name = row.get("name") if isinstance(row.get("name"), str) else sid
        mg = ""
        chain = row.get("mgChain")
        if isinstance(chain, list) and chain:
            names = [c.get("displayName") or c.get("name") for c in chain if isinstance(c, dict)]
            mg = " / ".join(n for n in names if isinstance(n, str) and n)
        subs.append((name, sid, mg))
    subs.sort(key=lambda s: (str(s[0]).lower(), str(s[1])))

    print(f"subscriptions visible under tenant {args.tenant or '(any)'}: {len(subs)}")
    for name, sid, mg in subs:
        line = f"  {sid}  {name}"
        if mg:
            line += f"   [mgmt group: {mg}]"
        print(line)

    if len(data) >= 1000 and (doc.get("skip_token") or doc.get("skipToken")):
        print("WARN: subscription list hit the 1000-row page and a continuation token is present "
              "— the list may be truncated (an unusually large tenant); page it before trusting "
              "completeness", file=sys.stderr)
    if not subs:
        print("WARN: 0 subscriptions visible — you likely lack Reader on any subscription in this "
              "tenant (or on the management group); grant read access before importing", file=sys.stderr)

    print("")
    print("Import ONCE PER SUBSCRIPTION — a distinct environments/<env>-azure root and a distinct")
    print("backend state key each (discover.sh --subscription <id> --tenant <id> per subscription).")
    print("A subscription NOT listed above is a Reader-RBAC gap; the per-subscription guard refuses a")
    print("wrong-subscription capture, so nothing crosses subscription boundaries. Track each")
    print("subscription to done — an unlisted or un-imported subscription is the estate-level gap.")
    return 0


def cmd_build(args):
    services = load_services(args.services)
    types = services["types"]

    if not os.path.isdir(args.capture_dir):
        refuse("BAD_CAPTURE", f"capture dir {args.capture_dir} does not exist")

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

    subscription = meta.get("subscription", "unknown")
    tenant = meta.get("tenant", "unknown")
    if args.require_subscription and subscription != args.require_subscription:
        refuse(
            "SUBSCRIPTION_MISMATCH",
            f"capture-meta.json says subscription {subscription!r} but --require-subscription is "
            f"{args.require_subscription!r} — refusing to build a manifest for the wrong subscription",
        )
    if args.require_tenant and tenant != args.require_tenant:
        refuse(
            "TENANT_MISMATCH",
            f"capture-meta.json says tenant {tenant!r} but --require-tenant is "
            f"{args.require_tenant!r} — refusing to build a manifest for the wrong tenant",
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

    # Merge every declared capture's pages up front so a corrupt page refuses before any output.
    declared = {cap["capture"] for cap in services["graphCaptures"]}
    primary_name = next((c["capture"] for c in services["graphCaptures"] if c.get("primary")), None)
    captures = {}
    for cap in declared:
        rows = merge_pages(args.capture_dir, cap)
        if rows is not None:
            captures[cap] = rows

    # Any *.json capture file present that no graphCapture declares -> loud (not imported).
    present = set()
    for fname in os.listdir(args.capture_dir):
        m = re.fullmatch(r"(.+?)(?:\.page\d+)?\.json", fname)
        if m and fname != "capture-meta.json":
            present.add(m.group(1))
    unmapped = [
        {"capture": name, "reason": "no graphCaptures entry declares this capture — rows in it are NOT imported"}
        for name in sorted(present - declared)
    ]

    resources, ignored, missing = [], [], []
    seen_ids = {}

    for rtype in sorted(types):
        spec = types[rtype]
        hint = spec["typeHint"].lower()
        rows = captures.get(spec["capture"])
        if rows is None:
            missing.append(
                {"capture": spec["capture"], "type": rtype, "typeHint": spec["typeHint"],
                 "note": "capture file absent — this type was NOT discovered; record it or accept the gap knowingly"}
            )
            continue
        for idx, row in enumerate(rows):
            if _row_type(row) != hint:
                continue
            reason = match_skip(row, spec.get("skips"))
            if reason is not None:
                rid = field(row, spec.get("id", "id"))
                ignored.append({"type": rtype, "id": rid if isinstance(rid, str) else f"{spec['capture']}[{idx}]", "reason": reason})
                continue
            rid = field(row, spec.get("id", "id"))
            if not (isinstance(rid, str) and rid):
                refuse(
                    "MALFORMED_RECORD",
                    f"{spec['capture']} row {idx} for {rtype} (type {hint}): cannot extract an id via "
                    f"{spec.get('id', 'id')!r} — refusing rather than dropping the record",
                )
            if (rtype, rid) in seen_ids:
                ignored.append({"type": rtype, "id": rid, "reason": f"duplicate of {seen_ids[(rtype, rid)]}"})
                continue
            name = resolve_name(row, spec, rid)
            disposition = overrides.get(rid, "import")
            resources.append({
                "type": rtype,
                "id": rid,
                "name": name,
                "service": spec["service"],
                "phase": spec["phase"],
                "stateful": bool(spec["stateful"]),
                "providerHint": spec["providerHint"],
                "disposition": disposition,
            })
            seen_ids[(rtype, rid)] = f"{rtype} (name {name!r})"

    # Deterministic labels: sort within type by (name, id), then dedupe with numeric suffixes.
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

    all_rows = [r for rows in captures.values() for r in rows]
    coverage = _compute_coverage(services, all_rows, primary_name in captures)

    manifest = {
        "schema": 1,
        "generator": "importer/kit-azure/discover.py",
        "subscription": subscription,
        "tenant": tenant,
        "location": meta.get("location", "unknown"),
        "capturedAt": meta.get("capturedAt", "unknown"),
        "servicesSha256": _sha256_file(args.services),
        "resources": resources,
        "ignored": sorted(ignored, key=lambda r: (r["type"], str(r["id"]))),
        "unmapped_captures": unmapped,
        "missing_captures": sorted(missing, key=lambda r: (r["capture"], r["type"])),
        "manual_followup": services.get("manual", []),
        "coverage": coverage,
        "errors": [],
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
    print("  by phase: " + ", ".join(f"P{p}={n}" for p, n in sorted(by_phase.items())))
    if ignored:
        print(f"  ignored (with reasons, see manifest): {len(ignored)}")
    if unmapped:
        print(f"  UNMAPPED capture files (NOT imported): {len(unmapped)}", file=sys.stderr)
        for u in unmapped:
            print(f"    {u['capture']}", file=sys.stderr)
    if missing:
        print(f"  MISSING captures (types not discovered): {len(missing)}", file=sys.stderr)
        for m in missing:
            print(f"    {m['capture']} ({m['type']})", file=sys.stderr)
    print(f"  manual follow-up type groups (cannot be auto-discovered): {len(manifest['manual_followup'])}")
    if coverage["captured"]:
        print(
            f"  coverage sweep ({coverage['method']}): {coverage['totalSwept']} resource(s) — "
            f"{len(coverage['coveredTypes'])} recognized types, {len(coverage['manualTypes'])} manual, "
            f"{len(coverage['unrecognizedResourceTypes'])} unrecognized"
        )
    else:
        print(f"  coverage sweep: not captured (no primary '{primary_name}' capture in the dir)")
    if coverage["unrecognizedResourceTypes"]:
        total = sum(f["count"] for f in coverage["unrecognizedResourceTypes"])
        print(
            f"WARN: {total} resource(s) in {len(coverage['unrecognizedResourceTypes'])} "
            "unrecognized resource type(s) — NOT imported, extend azure-services.json",
            file=sys.stderr,
        )
        for fam in coverage["unrecognizedResourceTypes"]:
            print(f"    {fam['type']}: {fam['count']} resource(s), e.g. {fam['sampleId']}", file=sys.stderr)
    print("next: review labels/dispositions in the manifest, then run aztfexport --generate-mapping-file "
          "+ reconcile.py, then gen-imports.py (docs/runbooks/azure-subscription-import.md, phase 1)")
    return 0


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("plan-commands", help="print capture<TAB>az-graph-query lines for the live driver")
    p1.add_argument("--services", default=DEFAULT_SERVICES)
    p1.set_defaults(func=cmd_plan_commands)

    p2 = sub.add_parser("next-token", help="print the ARG skip-token of a captured page (empty if last)")
    p2.add_argument("--page", required=True)
    p2.set_defaults(func=cmd_next_token)

    p4 = sub.add_parser("list-subscriptions", help="format an ARG ResourceContainers capture into the per-subscription iteration list")
    p4.add_argument("--capture", required=True)
    p4.add_argument("--tenant", default="")
    p4.set_defaults(func=cmd_list_subscriptions)

    p3 = sub.add_parser("build", help="captures -> discovery-manifest.json")
    p3.add_argument("--capture-dir", required=True)
    p3.add_argument("--services", default=DEFAULT_SERVICES)
    p3.add_argument("--out", required=True)
    p3.add_argument("--require-subscription", default="", help="refuse unless capture-meta.json subscription matches")
    p3.add_argument("--require-tenant", default="", help="refuse unless capture-meta.json tenant matches")
    p3.add_argument("--classify", default="", help="JSON {'by_id': {'<id>': 'import|replace|deprecate|ignore'}}")
    p3.set_defaults(func=cmd_build)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
