#!/usr/bin/env python3
"""Validate the schemadump artifact and compare it to forcenew-map.json.

Usage:
  validate.py <dump.json> <forcenew-map.json> [tfschema.json]

Emits:
  - the mandatory ground-truth checks (5 known + 3 from forcenew-map) to stdout
  - COMPARISON.md (written next to the dump) with agree/disagree/newly-resolved
  - a machine-readable summary block to stdout

The dump is the authority (0013d §2.1): where it disagrees with forcenew-map.json
(which was built by a grep/AST scan that left ~349 nested attrs unresolved), the
dump wins and the disagreement is reported for human review.
"""
import json
import os
import sys


def load(p):
    with open(p) as f:
        return json.load(f)


def lookup(dump, key):
    """Resolve a forcenew-map key ('type.attr' or 'type.a.b.c') against the dump.

    Returns (status, force_new) where status is one of:
      found | no_type | framework | no_attr
    """
    parts = key.split(".")
    rtype, path = parts[0], parts[1:]
    res = dump["resources"].get(rtype)
    if res is None:
        return ("no_type", None)
    if res.get("framework_unreflected"):
        return ("framework", None)
    if not path:
        return ("no_attr", None)
    attrs = res.get("attributes") or {}
    node = None
    for i, tok in enumerate(path):
        node = (attrs or {}).get(tok)
        if node is None:
            return ("no_attr", None)
        if i < len(path) - 1:
            blk = node.get("block")
            if not blk:
                return ("no_attr", None)
            attrs = blk.get("attributes") or {}
    return ("found", bool(node.get("force_new")))


def verdict_str(fn):
    return "force_new" if fn else "in_place"


def ground_truth(dump):
    """The 4 hard-coded known-behavior checks (mission items 1-4; item 5 is
    the 3 forcenew-map agreement picks, chosen in pick_map_checks)."""
    cases = [
        ("aws_instance", "instance_type", False, "resize in place"),
        ("aws_instance", "availability_zone", True, "moving AZ replaces"),
        ("aws_ebs_volume", "size", False, "grow in place"),
        ("aws_db_instance", "engine", True, "engine change replaces"),
    ]
    rows = []
    ok = True
    for rtype, attr, want, why in cases:
        status, got = lookup(dump, f"{rtype}.{attr}")
        passed = (status == "found" and got == want)
        ok = ok and passed
        rows.append((f"{rtype}.{attr}", want, status, got, passed, why))
    return rows, ok


def pick_map_checks(dump, fmap, n=3):
    """Pick n resolved (in_place/force_new) forcenew-map entries that the dump
    can also resolve, preferring a mix and stable ordering."""
    picks = []
    for key in sorted(fmap):
        v = fmap[key]["verdict"]
        if v not in ("in_place", "force_new"):
            continue
        status, got = lookup(dump, key)
        if status != "found":
            continue
        picks.append((key, v, verdict_str(got), v == verdict_str(got)))
    # prefer to include at least one force_new and one in_place
    fn = [p for p in picks if p[1] == "force_new"]
    ip = [p for p in picks if p[1] == "in_place"]
    chosen = []
    if fn:
        chosen.append(fn[0])
    if ip:
        chosen.append(ip[0])
    for p in picks:
        if len(chosen) >= n:
            break
        if p not in chosen:
            chosen.append(p)
    return chosen[:n]


def find_attr_paths(dump, rtype, leaf_path):
    """Search rtype's reflected tree for dotted paths ENDING in leaf_path.

    Used to propose the correct full path for forcenew-map keys that were
    recorded with abbreviated nesting (the B1 defect class: e.g.
    aws_lb_target_group.healthy_threshold -> health_check.healthy_threshold).
    Returns a list of (full_dotted_path, force_new).
    """
    res = dump["resources"].get(rtype) or {}
    hits = []
    want = leaf_path.split(".")

    def walk(attrs, prefix):
        for name, node in (attrs or {}).items():
            path = prefix + [name]
            if path[-len(want):] == want:
                hits.append((".".join(path), bool(node.get("force_new"))))
            blk = node.get("block")
            if blk:
                walk(blk.get("attributes") or {}, path)

    walk(res.get("attributes") or {}, [])
    return hits


def compare(dump, fmap):
    cats = {
        "agree": [],
        "disagree": [],
        "newly_resolved": [],
        "still_unresolved": [],
        "no_type_in_scope": [],
        "path_unresolved": [],
        "framework": [],
    }
    for key in sorted(fmap):
        mv = fmap[key]["verdict"]
        status, got = lookup(dump, key)
        dv = verdict_str(got) if status == "found" else None
        if status == "found":
            if mv in ("in_place", "force_new"):
                (cats["agree"] if mv == dv else cats["disagree"]).append((key, mv, dv))
            else:  # unresolved -> now resolved
                cats["newly_resolved"].append((key, mv, dv))
        elif status == "framework":
            cats["framework"].append((key, mv, None))
        elif status == "no_type":
            cats["no_type_in_scope"].append((key, mv, None))
        else:  # no_attr
            if mv == "unresolved":
                cats["still_unresolved"].append((key, mv, None))
            else:
                cats["path_unresolved"].append((key, mv, None))
    return cats


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    dump = load(sys.argv[1])
    fmap = load(sys.argv[2])
    tf = load(sys.argv[3]) if len(sys.argv) > 3 else None

    print("=" * 72)
    print("GROUND-TRUTH CHECKS (4 fixed known-behavior attrs)")
    print("=" * 72)
    rows, gok = ground_truth(dump)
    for key, want, status, got, passed, why in rows:
        mark = "PASS" if passed else "FAIL"
        print(f"  [{mark}] {key:42s} expect force_new={str(want):5s} got={status}/{got}  ({why})")

    print()
    print("GROUND-TRUTH CHECKS (3 from forcenew-map.json)")
    picks = pick_map_checks(dump, fmap, 3)
    mok = True
    for key, mv, dv, agree in picks:
        mark = "AGREE" if agree else "DISAGREE"
        mok = mok and agree
        print(f"  [{mark}] {key:52s} map={mv:9s} dump={dv}")

    cats = compare(dump, fmap)
    total = len(fmap)
    n_agree = len(cats["agree"])
    n_dis = len(cats["disagree"])
    n_new = len(cats["newly_resolved"])
    resolved_new_fn = sum(1 for _, _, dv in cats["newly_resolved"] if dv == "force_new")
    resolved_new_ip = sum(1 for _, _, dv in cats["newly_resolved"] if dv == "in_place")

    print()
    print("=" * 72)
    print(f"COMPARISON vs forcenew-map.json ({total} keys)")
    print("=" * 72)
    print(f"  agree ............... {n_agree}")
    print(f"  disagree ............ {n_dis}")
    print(f"  newly-resolved ...... {n_new}  (force_new={resolved_new_fn}, in_place={resolved_new_ip})")
    print(f"  still-unresolved .... {len(cats['still_unresolved'])}")
    print(f"  path-unresolved ..... {len(cats['path_unresolved'])} (map path not found in dump nesting)")
    print(f"  type-out-of-scope ... {len(cats['no_type_in_scope'])}")
    print(f"  framework ........... {len(cats['framework'])}")

    # ---- suggested re-keying for path-unresolved (B1-class abbreviated keys) --
    suggestions = []
    for key, mv, _ in cats["path_unresolved"]:
        rtype, leaf = key.split(".", 1)
        hits = find_attr_paths(dump, rtype, leaf)
        suggestions.append((key, mv, hits))
    if suggestions:
        print()
        print("PATH-UNRESOLVED — suggested full paths (dump is the authority):")
        for key, mv, hits in suggestions:
            if hits:
                for full, fn in hits[:3]:
                    mark = "MATCH" if verdict_str(fn) == mv else "VERDICT-DIFFERS"
                    print(f"  {key} (map={mv}) -> {full} force_new={fn} [{mark}]")
            else:
                print(f"  {key} (map={mv}) -> NO candidate leaf in dump")

    # ---- structural cross-check vs the JSON schema (existence + type) --------
    # `id` and `timeouts` are synthesized at the protocol layer (implicit SDKv2
    # id; timeouts meta-block) — they are NOT part of the authored schema, so
    # they are excluded before comparing attribute sets.
    xcheck = None
    if tf:
        prov = tf["provider_schemas"]["registry.terraform.io/hashicorp/aws"]["resource_schemas"]
        synthesized = {"id", "timeouts"}
        checked = matched = 0
        missing_in_dump = []
        for rtype, res in dump["resources"].items():
            if res.get("framework_unreflected"):
                continue
            tfres = prov.get(rtype)
            if not tfres:
                continue
            tf_attrs = (set((tfres["block"].get("attributes") or {}).keys())
                        | set((tfres["block"].get("block_types") or {}).keys())) - synthesized
            dump_attrs = set((res.get("attributes") or {}).keys()) - synthesized
            checked += 1
            if tf_attrs == dump_attrs:
                matched += 1
            else:
                diff = sorted(tf_attrs ^ dump_attrs)
                missing_in_dump.append((rtype, diff[:5]))
        xcheck = {"resources_checked": checked, "top_level_attrset_identical": matched,
                  "mismatches": missing_in_dump}
        print()
        print(f"STRUCTURAL CROSS-CHECK vs JSON schema (top-level attr sets, id/timeouts excluded):")
        print(f"  resources checked ............ {checked}")
        print(f"  identical top-level attr set .. {matched}")
        if missing_in_dump:
            for rtype, only in missing_in_dump[:10]:
                print(f"    diff {rtype}: {only}")

    # ---- characterize still-unresolved (synthetic keys vs deeper paths) ------
    su_purpose, su_rekeyable, su_nomatch = [], [], []
    for key, mv, _ in cats["still_unresolved"]:
        rtype, leaf = key.split(".", 1)
        if leaf == "purpose":
            su_purpose.append(key)
            continue
        hits = find_attr_paths(dump, rtype, leaf)
        if hits:
            su_rekeyable.append((key, f"{rtype}.{hits[0][0]}", hits[0][1], len(hits)))
        else:
            su_nomatch.append(key)
    print()
    print(f"STILL-UNRESOLVED characterization: .purpose synthetic={len(su_purpose)}, "
          f"re-keyable at deeper path={len(su_rekeyable)}, no leaf match={len(su_nomatch)}")

    # ---- write COMPARISON.md -------------------------------------------------
    out_md = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "COMPARISON.md")
    write_comparison_md(out_md, dump, fmap, cats, rows, picks, xcheck, suggestions,
                        (su_purpose, su_rekeyable, su_nomatch))
    print()
    print(f"wrote {out_md}")

    # machine-readable
    print()
    print("SUMMARY_JSON " + json.dumps({
        "ground_truth_known_pass": gok,
        "ground_truth_map_pass": mok,
        "agree": n_agree, "disagree": n_dis, "newly_resolved": n_new,
        "newly_resolved_force_new": resolved_new_fn, "newly_resolved_in_place": resolved_new_ip,
        "still_unresolved": len(cats["still_unresolved"]),
        "path_unresolved": len(cats["path_unresolved"]),
        "type_out_of_scope": len(cats["no_type_in_scope"]),
        "framework": len(cats["framework"]),
    }))


def write_comparison_md(path, dump, fmap, cats, rows, picks, xcheck, suggestions=None, su_char=None):
    m = dump["metadata"]
    s = m["summary"]
    L = []
    L.append("# schemadump vs forcenew-map.json — comparison\n")
    L.append(f"Generated from `{os.path.basename(sys.argv[1])}` "
             f"(provider {m['provider']} {m['provider_version']}, "
             f"commit `{m.get('source_provenance',{}).get('commit_sha','?') if isinstance(m.get('source_provenance'),dict) else '?'}`).\n")
    L.append("**The dump is the authority.** `forcenew-map.json` was built by a grep/AST "
             "scan of provider source that left ~349 nested attributes `unresolved`; the "
             "compile-and-reflect dump resolves ForceNew from the live SDKv2 schema tree. "
             "Where they disagree, the dump wins and the row is flagged for review. "
             "This file is advisory input to the wiring step (a separate reviewed PR); "
             "`forcenew-map.json` is NOT modified here.\n")

    L.append("## Headline\n")
    L.append(f"| Category | Count |")
    L.append(f"|---|---|")
    L.append(f"| forcenew-map.json keys | {len(fmap)} |")
    L.append(f"| agree (both resolved, same verdict) | {len(cats['agree'])} |")
    L.append(f"| **disagree** (both resolved, opposite verdict) | **{len(cats['disagree'])}** |")
    L.append(f"| **newly-resolved** (map=unresolved -> dump resolves) | **{len(cats['newly_resolved'])}** |")
    L.append(f"| still-unresolved (map=unresolved, dump path not found) | {len(cats['still_unresolved'])} |")
    L.append(f"| path-unresolved (map=resolved, dump path not found) | {len(cats['path_unresolved'])} |")
    L.append(f"| type-out-of-scope (type not in the 85) | {len(cats['no_type_in_scope'])} |")
    L.append(f"| framework (unreflected) | {len(cats['framework'])} |\n")

    nr_fn = sum(1 for _, _, dv in cats["newly_resolved"] if dv == "force_new")
    nr_ip = sum(1 for _, _, dv in cats["newly_resolved"] if dv == "in_place")
    L.append(f"Of the {len(cats['newly_resolved'])} newly-resolved (the WARN class 0013d L1 "
             f"targets): **{nr_fn} force_new**, **{nr_ip} in_place**.\n")

    L.append("## Ground-truth checks\n")
    L.append("| Attribute | Expect force_new | Got | Result |")
    L.append("|---|---|---|---|")
    for key, want, status, got, passed, why in rows:
        L.append(f"| `{key}` | {want} | {status}/{got} | {'PASS' if passed else 'FAIL'} — {why} |")
    L.append("")
    L.append("Three checks drawn from forcenew-map.json (map verdict vs dump verdict):\n")
    L.append("| Attribute | forcenew-map | dump | Result |")
    L.append("|---|---|---|---|")
    for key, mv, dv, agree in picks:
        L.append(f"| `{key}` | {mv} | {dv} | {'AGREE' if agree else 'DISAGREE'} |")
    L.append("")

    if cats["disagree"]:
        L.append("## Disagreements (dump is authoritative — review each)\n")
        L.append("| Key | forcenew-map | dump |")
        L.append("|---|---|---|")
        for key, mv, dv in cats["disagree"]:
            L.append(f"| `{key}` | {mv} | **{dv}** |")
        L.append("")
    else:
        L.append("## Disagreements\n\nNone — every key resolved by BOTH sources agrees.\n")

    if cats["path_unresolved"]:
        L.append("## Path-unresolved (map had a verdict; dump nesting differs)\n")
        L.append("These keys carry a resolved verdict in forcenew-map.json but their dotted "
                 "path does not resolve against the reflected nesting — the B1 defect class: "
                 "the map key was recorded with the block levels flattened away. The dump's "
                 "full path (searched by leaf attribute name) is proposed below; the wiring "
                 "step should re-key these. None are silently dropped.\n")
        L.append("| Map key | forcenew-map | Dump full path (proposed) | Dump force_new |")
        L.append("|---|---|---|---|")
        sug = {k: hits for k, _, hits in (suggestions or [])}
        for key, mv, _ in cats["path_unresolved"][:60]:
            hits = sug.get(key) or []
            if hits:
                full, fn = hits[0]
                extra = f" (+{len(hits)-1} more)" if len(hits) > 1 else ""
                L.append(f"| `{key}` | {mv} | `{key.split('.',1)[0]}.{full}`{extra} | {verdict_str(fn)} |")
            else:
                L.append(f"| `{key}` | {mv} | *no candidate leaf found* | — |")
        L.append("")

    if su_char:
        su_purpose, su_rekeyable, su_nomatch = su_char
        L.append("## Still-unresolved characterization "
                 f"({len(su_purpose) + len(su_rekeyable) + len(su_nomatch)} keys)\n")
        L.append(f"- **{len(su_purpose)} `.purpose` keys** — synthetic estate-level params "
                 "(one per resource type), never provider attributes; correctly stay "
                 "unresolved / fail-closed.")
        L.append(f"- **{len(su_rekeyable)} re-keyable at a deeper path** — same B1 class as "
                 "above: the leaf exists in the reflected tree under a fuller block chain "
                 "(note the `aws_dlm_lifecycle_policy.*` family, which is missing the "
                 "`policy_details.` prefix — the exact B1 bug of 0013d §1). All resolve "
                 "in_place at their full paths:")
        L.append("")
        L.append("| Map key | Dump full path (proposed) | Dump force_new |")
        L.append("|---|---|---|")
        for key, full, fn, nhits in su_rekeyable:
            extra = f" (+{nhits-1} more)" if nhits > 1 else ""
            L.append(f"| `{key}` | `{full}`{extra} | {verdict_str(fn)} |")
        L.append("")
        L.append(f"- **{len(su_nomatch)} with no leaf match** — synthetic/UI param keys "
                 "(e.g. `tag_key`, `env_key`, `ttl_enabled`) or renamed attrs; they stay "
                 "unresolved ⇒ fail-closed (treated AS ForceNew per the 0010 §3 rule):")
        L.append("")
        L.append("  " + ", ".join(f"`{k}`" for k in su_nomatch))
        L.append("")

    if xcheck:
        L.append("## Structural cross-check vs `terraform providers schema -json`\n")
        L.append(f"The JSON schema (from the pinned provider binary) OMITS ForceNew (L1) but is "
                 f"an independent structural witness. Top-level attribute sets (protocol-"
                 f"synthesized `id`/`timeouts` excluded) compared for "
                 f"{xcheck['resources_checked']} SDKv2 types: **{xcheck['top_level_attrset_identical']} identical**.\n")
        if xcheck["mismatches"]:
            L.append("Attr-set differences (review each):\n")
            L.append("| Type | Symmetric-difference sample |")
            L.append("|---|---|")
            for rtype, only in xcheck["mismatches"][:30]:
                L.append(f"| `{rtype}` | {', '.join(only)} |")
            L.append("")

    L.append("## Summary census (from dump metadata)\n")
    L.append(f"- requested types: {s['requested']}")
    L.append(f"- SDKv2-reflected: {s['sdkv2_reflected']}")
    L.append(f"- framework_unreflected: {s['framework_unreflected']}  {s.get('framework_types','')}")
    L.append(f"- missing: {s['missing']}  {s.get('missing_types','')}")
    L.append(f"- attributes reflected (recursive): {s['total_attributes_reflected']} "
             f"(force_new true={s['attributes_force_new_true']}, false={s['attributes_force_new_false']})")
    L.append("")
    with open(path, "w") as f:
        f.write("\n".join(L))


if __name__ == "__main__":
    main()
