#!/usr/bin/env python3
"""docs-error-codes-check.py — DOC-10: does ERROR-STATES.md's "every error code the API can
return" claim actually hold?

The finding this closes: 8 taxonomy codes added to `errors.ts` after the doc's measurement
commit (`SCANNER_KEY_INVALID`, `DRIFT_PROPOSAL_STALE`, `INSTANCE_STALE`,
`DRIFT_NOT_ADOPTABLE`, `DRIFT_PROPOSAL_REQUIRED`, `SCANNER_DISABLED`,
`FORGE_CREDENTIAL_REFUSED`, `SCAN_TARGET_REFUSED`) and 6 inline `c.json({code…})` literals
(`DRIFT_DISARMED`, `DRIFT_CHECK_FORBIDDEN`, `DRIFT_GENERATE_FORBIDDEN`, `BUNDLE_DISARMED`,
`BUNDLE_RUNNING`, `APPLY_FORBIDDEN`) were absent from the doc's tables — building this check
found two MORE undocumented inline literals the finding's own hand audit missed
(`BUNDLE_REPO_UNRESOLVED`, `DRIFT_REPO_UNRESOLVED`), which is exactly the case for a
generated check over a hand-maintained list: the list itself was the defect.

Two sources of truth, both derived from the real code, not copied from the doc:
  1. Every key in `errors.ts`'s `ERRORS` map (the taxonomy).
  2. Every inline `code: '<LITERAL>'` object-literal error response in `routes/*.ts` — the
     "emitted-but-undefined" class the doc has its own section for, whether or not the
     literal happens to also be a taxonomy key (some routes spell a taxonomy code inline,
     e.g. `STATE_CONFLICT`, which is legitimate and already documented — only a literal
     ABSENT from the doc entirely is a finding).

Each code must appear (backtick-quoted, word-bounded) somewhere in ERROR-STATES.md.

Exit codes: 0 every code is documented · 1 at least one is not.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ERRORS_TS = ROOT / "ccp" / "api" / "src" / "errors.ts"
ROUTES_DIR = ROOT / "ccp" / "api" / "src" / "routes"
DOC = ROOT / "ccp" / "docs" / "ERROR-STATES.md"

TAXONOMY_KEY_RE = re.compile(r"^\s{2}([A-Z][A-Z0-9_]+):\s*\{", re.MULTILINE)
INLINE_LITERAL_RE = re.compile(r"""code:\s*['"]([A-Z][A-Z0-9_]+)['"]""")


def taxonomy_codes() -> set[str]:
    text = ERRORS_TS.read_text(encoding="utf-8")
    return set(TAXONOMY_KEY_RE.findall(text))


def inline_literal_codes() -> set[str]:
    codes: set[str] = set()
    for path in ROUTES_DIR.rglob("*.ts"):
        if path.name.endswith(".test.ts"):
            continue
        codes |= set(INLINE_LITERAL_RE.findall(path.read_text(encoding="utf-8", errors="ignore")))
    return codes


def documented_codes() -> set[str]:
    text = DOC.read_text(encoding="utf-8")
    return set(re.findall(r"`([A-Z][A-Z0-9_]+)`", text))


def main() -> int:
    for path in (ERRORS_TS, ROUTES_DIR, DOC):
        if not path.exists():
            print(f"docs-error-codes-check: missing input {path} — cannot run", file=sys.stderr)
            return 1

    taxonomy = taxonomy_codes()
    inline = inline_literal_codes()
    if not taxonomy or not inline:
        print("docs-error-codes-check: found zero codes in one of the two sources — extraction is broken", file=sys.stderr)
        return 1
    documented = documented_codes()

    missing_taxonomy = sorted(taxonomy - documented)
    missing_inline = sorted(inline - documented)
    if missing_taxonomy or missing_inline:
        print("docs-error-codes-check: ERROR-STATES.md is missing code(s) it claims to enumerate completely:")
        for c in missing_taxonomy:
            print(f"  taxonomy (errors.ts): {c}")
        for c in missing_inline:
            print(f"  inline literal (routes/*.ts): {c}")
        return 1
    print(f"docs-error-codes-check: all {len(taxonomy)} taxonomy code(s) and {len(inline)} inline literal(s) are documented")
    return 0


if __name__ == "__main__":
    sys.exit(main())
