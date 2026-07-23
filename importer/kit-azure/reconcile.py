#!/usr/bin/env python3
"""reconcile.py — turn aztfexport's silent best-effort into the kit's loud-gaps doctrine.

NEW component with no AWS analog: it exists because the kit delegates HCL-body generation to
Microsoft's aztfexport, whose default behavior is best-effort and SILENT — with --continue it
simply drops resources it cannot map, and it never fails on partial coverage. That is the exact
opposite of this repo's "gaps are loud, never silent" rule. reconcile.py restores the rule by
set-diffing the discovery manifest (the Azure Resource Graph GROUND TRUTH — what actually
exists) against aztfexport's machine-readable mapping file (what the engine actually handled).

Every Azure resource id whose disposition is "import" in the manifest MUST appear in
aztfexport's mapping (so a body gets generated for it). Any that does not is a resource
aztfexport silently skipped or errored on — surfaced here as a loud array (and, with --strict,
a hard REFUSE COVERAGE_GAP) instead of quietly missing from the generated config.

Comparison is CASE-INSENSITIVE on the ARM id: ARG and aztfexport can disagree on resource-id
segment casing, and a spurious case delta must not read as a coverage gap.

  --manifest MANIFEST   discovery-manifest.json from discover.py build (ground truth)
  --mapping  MAPPING    aztfexportResourceMapping.json emitted by
                        `aztfexport ... --generate-mapping-file` (or the --hcl-only run)
  --out      REPORT     optional reconcile-report.json
  --strict              a non-empty unmapped_by_engine becomes REFUSE COVERAGE_GAP (exit 2)

Refusals: BAD_MANIFEST · BAD_MAPPING · COVERAGE_GAP (only with --strict).
Stdlib only. Exit codes: 0 ok · 2 refusal.
"""
import argparse
import json
import sys


def refuse(code, msg):
    print(f"REFUSE {code}: {msg}", file=sys.stderr)
    sys.exit(2)


def _looks_like_arm_id(s):
    return isinstance(s, str) and s.lower().startswith("/subscriptions/")


def load_mapping_ids(path):
    """The set of Azure resource ids aztfexport mapped, lowercased. Tolerant of the mapping
    file shape across aztfexport versions: a dict whose VALUES carry a 'resource_id' (newer),
    or whose KEYS are the resource ids (older/simple)."""
    try:
        with open(path) as fh:
            doc = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse("BAD_MAPPING", f"cannot read aztfexport mapping {path}: {e}")
    if not isinstance(doc, dict):
        refuse("BAD_MAPPING", f"{path} is not a JSON object (aztfexportResourceMapping.json shape)")
    ids = set()
    for key, value in doc.items():
        rid = None
        if isinstance(value, dict) and _looks_like_arm_id(value.get("resource_id")):
            rid = value["resource_id"]
        elif _looks_like_arm_id(key):
            rid = key
        if rid:
            ids.add(rid.lower())
    return ids


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--manifest", required=True)
    p.add_argument("--mapping", required=True)
    p.add_argument("--out", default="")
    p.add_argument("--strict", action="store_true")
    args = p.parse_args(argv)

    try:
        with open(args.manifest) as fh:
            manifest = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse("BAD_MANIFEST", f"cannot read {args.manifest}: {e}")
    rows = manifest.get("resources")
    if not isinstance(rows, list):
        refuse("BAD_MANIFEST", "manifest.resources is not a list")

    ground_truth = {}  # lower(id) -> row (import-disposition only)
    for row in rows:
        if row.get("disposition", "import") != "import":
            continue
        rid = row.get("id")
        if isinstance(rid, str) and rid:
            ground_truth[rid.lower()] = row

    mapped = load_mapping_ids(args.mapping)

    unmapped = [
        {"id": ground_truth[lid]["id"], "type": ground_truth[lid].get("type", "?")}
        for lid in sorted(ground_truth) if lid not in mapped
    ]
    engine_extra = sorted(mapped - set(ground_truth))

    report = {
        "generator": "importer/kit-azure/reconcile.py",
        "groundTruthImportCount": len(ground_truth),
        "mappedCount": len(mapped),
        "unmapped_by_engine": unmapped,
        "engine_extra": engine_extra,
        "ok": not unmapped,
    }
    if args.out:
        with open(args.out, "w") as fh:
            json.dump(report, fh, indent=2)
            fh.write("\n")

    print(f"reconcile: {len(ground_truth)} import-disposition resource(s) in the manifest, "
          f"{len(mapped)} mapped by aztfexport")
    if engine_extra:
        print(f"  info: aztfexport mapped {len(engine_extra)} id(s) ARG did not surface as top-level "
              "rows (expected for expanded child resources)")
    if unmapped:
        print(f"  UNMAPPED BY ENGINE ({len(unmapped)}) — aztfexport did not generate a body for these "
              "import-disposition resources:", file=sys.stderr)
        for u in unmapped:
            print(f"    {u['type']}  {u['id']}", file=sys.stderr)
        if args.strict:
            refuse("COVERAGE_GAP",
                   f"{len(unmapped)} import-disposition resource(s) were not mapped by aztfexport — "
                   "generate their bodies with `terraform plan -generate-config-out` (the guaranteed-safe "
                   "fallback), or classify them into azure-services.json manual[] with a reason, then re-run")
        print("  (not --strict: reported, not refused — regenerate the missing bodies via the "
              "-generate-config-out fallback before verify.sh --phase import)")
    else:
        print("  OK: every import-disposition resource was mapped by aztfexport (no silent gaps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
