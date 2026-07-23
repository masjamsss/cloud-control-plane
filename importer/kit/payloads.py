#!/usr/bin/env python3
"""payloads.py — attach import-and-adopt payloads to candidate findings.

Spec: docs/superpowers/specs/2026-07-20-ccp-oob-provisioning-import.md
§2.6 steps 2-4 (WI-S2). Steps 2-3 (gen-imports.py over candidates-manifest.json
-> imports-probe.tf; a probe `terraform plan -generate-config-out=generated.tf`
in a throwaway copy of the initialized root) are orchestration run where the
read-only AWS credentials already live (the drift workflow, WI-S3) — this
script is the pure, offline step 4 that turns those two files into
`importPayload` (or a mechanical `payloadWithheldReason`) on each candidate's
finding row, in place, byte-stably.

Usage:

    python3 importer/kit/payloads.py \\
      --findings   work/sweep/unmanaged-findings.json \\   # statediff.py's output (updated)
      --candidates work/sweep/candidates-manifest.json \\   # statediff.py's other output
      --imports    work/sweep/imports-probe.tf \\           # gen-imports.py's output (optional)
      --generated  work/probe/generated.tf \\               # -generate-config-out output (optional)
      [--probe-error "$(tail -c 4000 work/probe/plan.log)"] \\
      --out        work/sweep/unmanaged-findings.json

Per candidate (address = "<type>.<label>"):
  1. `--imports`/`--generated` both absent or unreadable -> the WHOLE batch
     ships payload-less with a mechanical reason (--probe-error's text if
     given, else a generic one) — "findings still publish, detection is
     never hostage to generation" (§1.3). This is the normal shape of a
     failed/unarmed probe plan, never a refusal.
  2. Otherwise, `--generated` is split into per-address HCL blocks by a
     LINE-SCANNER (never a brace counter — terraform's own generated output
     can carry decoy braces inside quoted heredoc content; see
     testdata/generated/generated.tf.fixture). Any structural surprise
     (unterminated block, duplicate address) withholds THAT address only,
     never guessed at, never poisoning a neighboring clean candidate.
  3. Secret battery: every `name = "literal"` line in the skeleton is
     checked against catalog/redaction-rules.json's secretAttributeNames /
     valueAllowlistPrefixes — the SAME rules importer/kit/normalize.py's
     `check` subcommand enforces, over the same generated-config shape. ANY
     hit withholds the payload (masking would produce invalid config to
     apply, so refusal is the only option here, never rewriting). The
     canonical rules file is READ, never copied — it is already vendored in
     catalog/, tools/catalogctl/internal/hclops/, and ccp/app/src/data/
     (AGENTS.md rule 6); a fourth copy is forbidden.
  4. Stateful guard: services.json's `stateful` flag (passed straight
     through from statediff.py's candidates-manifest.json) appends the same
     `lifecycle { prevent_destroy = true }` block normalize.py's `guard`
     subcommand inserts — config-only, the resulting plan stays 0/0/0.
  5. The import block is NOT re-emitted here (zero new HCL-emission code,
     §2.6 step 2's own discipline extended to this step): it is parsed
     verbatim out of --imports, gen-imports.py's real output, by the exact
     shape its own tests pin (`import {\\n  to = T.L\\n  id = "ID"\\n}`).

`targetFile` is the constant "oob-adopted.tf" (§7.2 — constant in v1).

Stdlib only. No wall-clock, no AWS. Exit codes: 0 ok · 2 refusal (message
starts with "REFUSE <CODE>:") — reserved for unusable --findings/--candidates/
--rules input; a failed/absent probe plan is never a refusal, see point 1.
"""
import argparse
import json
import os
import re
import sys

KIT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(KIT_DIR, "..", ".."))
DEFAULT_RULES = os.path.join(REPO_ROOT, "catalog", "redaction-rules.json")

TARGET_FILE = "oob-adopted.tf"
GENERATION_NOT_AVAILABLE_REASON = "payload generation did not run for this sweep (no --generated/--imports provided)"
SECRET_REASON = (
    "generated config carries secret-shaped values — import via the kit runbook with secret "
    "handling (e.g. ignore_changes on the secret attribute), never through the portal"
)

RESOURCE_HEADER_RE = re.compile(r'^resource "([A-Za-z0-9_]+)" "([A-Za-z_][A-Za-z0-9_]*)" \{$')
IMPORT_BLOCK_RE = re.compile(r'^import \{\n  to = (\S+)\n  id = "([^"]*)"\n\}$', re.M)
ATTR_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$')

GUARD_LINES = [
    "",
    "  lifecycle {",
    "    # stateful resource — never destroyed via Terraform (importer/docs/strategy.md rule 2)",
    "    prevent_destroy = true",
    "  }",
]


def refuse(code, msg):
    print(f"REFUSE {code}: {msg}", file=sys.stderr)
    sys.exit(2)


def _load_json(path, code, what):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        refuse(code, f"cannot read {what} ({path}): {e}")


def write_json(path, doc):
    out_dir = os.path.dirname(os.path.abspath(path))
    os.makedirs(out_dir, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")


# ── the skeleton splitter (§2.6 step 4, the line-scanner) ──────────────────

def split_generated(text):
    """-> (blocks, ambiguous).
    blocks     {address: block_text}   well-formed, trustworthy, verbatim bytes
    ambiguous  {address: reason}       structurally suspect — withheld, never guessed

    A resource block starts at a line matching RESOURCE_HEADER_RE (column
    0) and ends at the next line that is EXACTLY "}" (column 0 —
    terraform fmt's own closing-brace convention for a top-level block).
    This is deliberately NOT a brace-counter: `-generate-config-out` can
    legally emit a quoted string containing an unmatched '{' (a heredoc
    body, for instance), which would desynchronize a naive counter. Any
    ambiguity — an unterminated block, or two blocks resolving to the same
    address — withholds THAT address only; it never poisons a
    well-formed neighbor in the same file.
    """
    lines = text.splitlines()
    blocks = {}
    ambiguous = {}
    n = len(lines)
    i = 0
    while i < n:
        m = RESOURCE_HEADER_RE.match(lines[i])
        if not m:
            i += 1
            continue
        address = f"{m.group(1)}.{m.group(2)}"
        start = i
        j = i + 1
        end = None
        while j < n:
            if lines[j] == "}":
                end = j
                break
            if RESOURCE_HEADER_RE.match(lines[j]):
                break  # a new header before this one closed — unterminated, not nested HCL
            j += 1
        if end is None:
            ambiguous[address] = (
                f"unterminated resource block for {address} starting at generated.tf line "
                f"{start + 1} (no matching top-level '}}' before EOF or the next resource "
                "header) — regenerate"
            )
            i = start + 1
            continue
        block_text = "\n".join(lines[start:end + 1]) + "\n"
        if address in blocks or address in ambiguous:
            ambiguous[address] = (
                f"duplicate resource block for {address} in generated.tf — untrustworthy "
                "(which copy is live?), regenerate"
            )
            blocks.pop(address, None)
        else:
            blocks[address] = block_text
        i = end + 1
    return blocks, ambiguous


# ── the import-block reader (verbatim reuse of gen-imports.py's output) ────

def parse_import_blocks(text):
    """address -> the exact import-block bytes gen-imports.py wrote for it
    (`import {\\n  to = T.L\\n  id = "ID"\\n}\\n`) — parsed, never
    re-emitted, so this stays zero new HCL-emission code (§2.6 step 2's own
    discipline). A duplicate address (should never happen; gen-imports.py
    itself refuses DUPLICATE_ADDRESS upstream) is dropped from the result
    rather than trusted — the caller reports it as "missing" for that
    candidate, same as if gen-imports.py had refused it outright."""
    blocks = {}
    seen_twice = set()
    for m in IMPORT_BLOCK_RE.finditer(text):
        address = m.group(1)
        if address in blocks:
            seen_twice.add(address)
            continue
        blocks[address] = m.group(0) + "\n"
    for address in seen_twice:
        blocks.pop(address, None)
    return blocks


# ── secret battery (the same rules normalize.py's `check` enforces) ────────

def load_redaction_rules(path):
    doc = _load_json(path, "BAD_RULES", "redaction rules")
    secret_names = {n.lower() for n in doc.get("secretAttributeNames", [])} if isinstance(doc, dict) else set()
    allow_prefixes = tuple(doc.get("valueAllowlistPrefixes", [])) if isinstance(doc, dict) else ()
    if not secret_names:
        # fail-closed: no rules -> no check -> refuse (0007 C2 — absence of
        # rules must never mean "no redaction"), same standard as
        # normalize.py's cmd_check.
        refuse("BAD_RULES", f"{path} has no secretAttributeNames — fail-closed")
    return secret_names, allow_prefixes


def secret_battery_hit(skeleton_text, secret_names, allow_prefixes):
    for line in skeleton_text.splitlines():
        m = ATTR_RE.match(line)
        if not m:
            continue
        name, value = m.group(1).lower(), m.group(2)
        if name in secret_names and value and not value.startswith(allow_prefixes):
            return True
    return False


# ── stateful guard (the same block normalize.py's `guard` inserts) ─────────

def apply_stateful_guard(skeleton_text):
    lines = skeleton_text.splitlines()
    if not lines or lines[-1] != "}":
        return None  # defensive: split_generated() always yields this shape; never guess otherwise
    new_lines = lines[:-1] + GUARD_LINES + ["}"]
    return "\n".join(new_lines) + "\n"


# ── main ─────────────────────────────────────────────────────────────────

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--findings", required=True, help="statediff.py unmanaged-findings.json (findings updated in place)")
    p.add_argument("--candidates", required=True, help="statediff.py candidates-manifest.json")
    p.add_argument("--imports", default="", help="gen-imports.py output over --candidates (imports-probe.tf)")
    p.add_argument("--generated", default="", help="terraform plan -generate-config-out output (generated.tf)")
    p.add_argument("--probe-error", default="", help="probe-plan error tail, used as the withheld reason when --generated/--imports are absent")
    p.add_argument("--rules", default=DEFAULT_RULES, help="canonical secret-battery rules (read-only; never copy this file — AGENTS.md rule 6)")
    p.add_argument("--out", required=True)
    args = p.parse_args(argv)

    findings_doc = _load_json(args.findings, "BAD_FINDINGS", "unmanaged findings")
    if not isinstance(findings_doc, dict) or not isinstance(findings_doc.get("findings"), list):
        refuse("BAD_FINDINGS", f"{args.findings} has no 'findings' list — not a statediff.py unmanaged-findings.json")

    candidates_doc = _load_json(args.candidates, "BAD_CANDIDATES", "candidates manifest")
    if not isinstance(candidates_doc, dict) or not isinstance(candidates_doc.get("resources"), list):
        refuse("BAD_CANDIDATES", f"{args.candidates} has no 'resources' list — not a statediff.py candidates-manifest.json")

    secret_names, allow_prefixes = load_redaction_rules(args.rules)

    finding_by_key = {}
    for f in findings_doc["findings"]:
        finding_by_key[(f.get("tfType"), f.get("liveId"))] = f

    generation_available = (
        bool(args.imports) and os.path.isfile(args.imports)
        and bool(args.generated) and os.path.isfile(args.generated)
    )

    import_blocks, skeletons, ambiguous = {}, {}, {}
    if generation_available:
        with open(args.imports) as fh:
            import_blocks = parse_import_blocks(fh.read())
        with open(args.generated) as fh:
            skeletons, ambiguous = split_generated(fh.read())

    fallback_reason = args.probe_error.strip() or GENERATION_NOT_AVAILABLE_REASON

    attached = 0
    withheld_tally = {}

    def withhold(finding, reason, tally_key):
        finding["importPayload"] = None
        finding["payloadWithheldReason"] = reason
        withheld_tally[tally_key] = withheld_tally.get(tally_key, 0) + 1

    for cand in candidates_doc["resources"]:
        for key_field in ("type", "id", "label"):
            if not isinstance(cand.get(key_field), str) or not cand[key_field]:
                refuse("MALFORMED_CANDIDATE", f"candidate is missing '{key_field}': {cand!r}")
        key = (cand["type"], cand["id"])
        finding = finding_by_key.get(key)
        if finding is None:
            print(f"WARN: candidate {cand['type']}.{cand['label']} ({cand['id']}) has no matching "
                  f"row in --findings — skipped (stale candidates-manifest.json?)", file=sys.stderr)
            continue
        address = f"{cand['type']}.{cand['label']}"

        if not generation_available:
            withhold(finding, fallback_reason, "generation not available")
            continue

        if address in ambiguous:
            withhold(finding, ambiguous[address], "ambiguous generated.tf block")
            continue

        import_block = import_blocks.get(address)
        if import_block is None:
            withhold(
                finding,
                f"no import block for {address} in {args.imports} — gen-imports.py did not emit "
                "it (a label/address refusal upstream?); regenerate",
                "missing import block",
            )
            continue

        skeleton = skeletons.get(address)
        if skeleton is None:
            withhold(
                finding,
                f"no generated skeleton for {address} — the resource may have been removed live "
                "since detection, or the probe plan did not include it; regenerate",
                "missing generated skeleton",
            )
            continue

        if secret_battery_hit(skeleton, secret_names, allow_prefixes):
            withhold(finding, SECRET_REASON, "secret battery")
            continue

        final_skeleton = skeleton
        if cand.get("stateful"):
            guarded = apply_stateful_guard(skeleton)
            if guarded is None:
                withhold(
                    finding,
                    f"internal: {address}'s generated skeleton did not end with a plain '}}' — "
                    "refusing to guess where prevent_destroy belongs",
                    "guard insertion failed",
                )
                continue
            final_skeleton = guarded

        finding["importPayload"] = {
            "address": address,
            "targetFile": TARGET_FILE,
            "importBlock": import_block,
            "skeletonHcl": final_skeleton,
        }
        finding["payloadWithheldReason"] = None
        attached += 1

    write_json(args.out, findings_doc)

    withheld = sum(withheld_tally.values())
    print(f"payloads: {attached} attached, {withheld} withheld -> {args.out}")
    for tally_key in sorted(withheld_tally):
        print(f"  withheld ({withheld_tally[tally_key]}): {tally_key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
