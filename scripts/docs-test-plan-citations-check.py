#!/usr/bin/env python3
"""docs-test-plan-citations-check.py — TEST-10: does every test-file citation in
docs/FUNCTIONAL-TEST-PLAN.md's "Automated?" column actually resolve to a real file?

The finding this closes: ADMIN-01 cited "`ccp/api/test/teams` coverage" and ADMIN-04
"`ccp/api/test/settings` coverage" — plausible-looking paths that name no file that has
ever existed under those names; the behaviors ARE covered, but the pointer cannot be
followed. A reader (or a future editor deciding whether a row still needs work) has no
way to tell a dead citation from a live one without grepping the whole test tree by
hand, which is exactly what let these two go unnoticed.

Three citation shapes are checked, each narrow on purpose — a broad "every backtick
span starting with ccp/ must exist" walker flags legitimate non-file references
(directories, ccp/app/src/data/project.json) as false positives, which is worse than
missing a case, because a noisy check gets ignored:

  1. A repo-relative path ending in a real test-file extension, e.g.
     `ccp/api/test/cooling.test.ts` — the exact path must exist.
  2. A bare filename, e.g. `adminSurface.test.ts` — a file with that exact basename
     must exist SOMEWHERE under one of the test roots (the plan doesn't commit to a
     full path for these, so neither does this check).
  3. The EXACT shape of the two dead citations that motivated this check: a test-root
     path with no further subdirectory and no extension, e.g. `ccp/api/test/teams` —
     always broken by construction (a bare identifier under a test root is never a
     real file), called out by name so this class can never recur silently.

A backtick span that matches none of these (prose, a route path, a directory
reference with a trailing slash, a non-test file) is silently ignored.

Exit codes: 0 every citation resolved · 1 at least one did not.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAN = ROOT / "docs" / "FUNCTIONAL-TEST-PLAN.md"

TEST_ROOTS = [
    ROOT / "ccp" / "api" / "test",
    ROOT / "ccp" / "api" / "src",
    ROOT / "ccp" / "app" / "src" / "test",
    ROOT / "tools" / "catalogctl",
]

TEST_FILE_RE = r"\.(test\.tsx?|go)$"
# Shape 1: a full path under a known root, ending in a real test-file extension.
FULL_PATH_RE = re.compile(r"^(?:ccp/(?:api/test|api/src|app/src/test)|tools/catalogctl)/[\w./-]+" + TEST_FILE_RE)
# Shape 2: a bare filename with no directory component.
BARE_FILE_RE = re.compile(r"^[\w.-]+" + TEST_FILE_RE)
# Shape 3: the dead-citation shape — a test root plus exactly one bare, extensionless
# segment (ADMIN-01/04's "ccp/api/test/teams", "ccp/api/test/settings").
DEAD_SHAPE_RE = re.compile(r"^(?:ccp/api/test|ccp/app/src/test)/[\w-]+$")


def basename_exists(name: str) -> bool:
    return any(any(root.rglob(name)) for root in TEST_ROOTS)


def check_citation(raw: str) -> str | None:
    """Returns None if `raw` is not a citation this check covers, or resolves fine;
    otherwise a one-line reason it is broken."""
    token = raw.split("#", 1)[0]  # strip a `#TestFunctionName` anchor before resolving
    if FULL_PATH_RE.match(token):
        return None if (ROOT / token).is_file() else f"'{raw}' does not exist at that path"
    if DEAD_SHAPE_RE.match(token):
        return f"'{raw}' is a test-root path with no file extension — not a real file (this is the ADMIN-01/04 shape)"
    if BARE_FILE_RE.match(token):
        return None if basename_exists(token) else f"'{raw}' — no file with that name exists under any test root"
    return None


def main() -> int:
    if not PLAN.is_file():
        print(f"docs-test-plan-citations-check: missing input {PLAN}", file=sys.stderr)
        return 1
    text = PLAN.read_text(encoding="utf-8")

    problems: list[str] = []
    checked = 0
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not line.startswith("|"):
            continue
        for span in re.findall(r"`([^`]+)`", line):
            reason = check_citation(span)
            token = span.split("#", 1)[0]
            if FULL_PATH_RE.match(token) or DEAD_SHAPE_RE.match(token) or BARE_FILE_RE.match(token):
                checked += 1
            if reason is not None:
                problems.append(f"  line {lineno}: {reason}")

    if problems:
        print(f"docs-test-plan-citations-check: {len(problems)} broken citation(s) in {PLAN.relative_to(ROOT)}:")
        print("\n".join(problems))
        return 1
    print(f"docs-test-plan-citations-check: {checked} file citation(s) in {PLAN.relative_to(ROOT)} all resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
