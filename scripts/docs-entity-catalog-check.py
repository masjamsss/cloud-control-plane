#!/usr/bin/env python3
"""docs-entity-catalog-check.py — DOC-12: does DOMAIN-MODEL.md's entity catalog have a row
for every exported `*Item` shape in the store schema?

The finding this closes: the entity catalog (§2) had no row for 8 of the 24 exported item
shapes — `InstanceItem`, `ProjectDataVersionItem`, `ProjectUploadTokenItem`,
`ProjectScanJobItem`, `DriftReportItem`, `DriftPointerItem`, `DriftProposalItem`,
`ProjectForgeCredentialItem` — silently missing the drift-telemetry, scanner,
data-plane-version, and instance-identity persistence entirely, the newest and
least-understood parts of the store. Building this check found a 9th gap the finding's own
hand audit missed: `RequestSetItem` (embedded on `RequestItem.items[]`, never independently
catalogued).

Extraction is structural, not a copied list: every `export const XxxItem = z.object(` in
schema.ts is a store item shape by this codebase's own naming convention (confirmed by every
existing catalog row already following it). A shape is "documented" if its name appears
backtick-quoted anywhere in DOMAIN-MODEL.md — deliberately not requiring a specific table or
section, since some shapes are catalogued in §2.1 (top-level rows) and others in §2.2
(project-scoped) or noted as embedded-only (this file's own convention for sub-records).

DOC-17 — the SAME pass also checks the one citation shape every entity row carries by
convention, `` `XxxItem`, schema.ts:A-B) ``: does A match XxxItem's REAL declaration line?
DOMAIN-MODEL.md pinned its measurement commit and warned edits shift line numbers (the
`ProjectItem` row alone had drifted from :536-555 to :842-928 by the time this check was
written) — this is the narrow, mechanically-verifiable slice of that drift: the entity
table's own headline citation, not every `file:line` in the document's prose (which stays
"disciplined staleness," the doc's own term, re-verified by hand rather than by this script).

Exit codes: 0 every item shape has a row and its headline citation is accurate · 1 otherwise.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "ccp" / "api" / "src" / "store" / "schema.ts"
DOC = ROOT / "ccp" / "docs" / "DOMAIN-MODEL.md"

ITEM_DECL_RE = re.compile(r"^export const (\w+Item) = z\.object\(", re.MULTILINE)
ROW_CITATION_RE = re.compile(r"`(\w+Item)`, schema\.ts:(\d+)(?:-\d+)?\)")


def schema_item_lines() -> dict[str, int]:
    """name -> 1-indexed line of its `export const Xxx = z.object(` declaration."""
    text = SCHEMA.read_text(encoding="utf-8")
    lines = {}
    for m in ITEM_DECL_RE.finditer(text):
        lines[m.group(1)] = text.count("\n", 0, m.start()) + 1
    return lines


def documented_items(text: str) -> set[str]:
    return set(re.findall(r"`(\w+Item)`", text))


def main() -> int:
    for path in (SCHEMA, DOC):
        if not path.is_file():
            print(f"docs-entity-catalog-check: missing input {path}", file=sys.stderr)
            return 1

    real_lines = schema_item_lines()
    if not real_lines:
        print("docs-entity-catalog-check: found zero `export const XxxItem = z.object(` declarations — extraction is broken, not a clean repo", file=sys.stderr)
        return 1
    items = set(real_lines)

    doc_text = DOC.read_text(encoding="utf-8")
    documented = documented_items(doc_text)
    missing = sorted(items - documented)

    stale: list[str] = []
    for name, cited_line in ROW_CITATION_RE.findall(doc_text):
        if name not in real_lines:
            continue  # not a schema item (e.g. a client-side type) — out of scope
        real = real_lines[name]
        if int(cited_line) != real:
            stale.append(f"  {name}: row cites schema.ts:{cited_line}, real declaration is schema.ts:{real}")

    if missing or stale:
        if missing:
            print(f"docs-entity-catalog-check: {len(missing)} store item shape(s) with no DOMAIN-MODEL.md row:")
            for name in missing:
                print(f"  {name}")
            print("Add a row to the entity catalog (schema.ts's own doc comments have most of the needed prose).")
        if stale:
            print(f"docs-entity-catalog-check: {len(stale)} entity row(s) cite a stale schema.ts line (DOC-17):")
            for line in stale:
                print(line)
        return 1
    print(f"docs-entity-catalog-check: all {len(items)} store item shape(s) have a DOMAIN-MODEL.md row with an accurate line citation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
