#!/usr/bin/env python3
"""docs-env-vars-check.py — DOC-9: is every CCP_* env var the api reads mentioned in at
least one operator-facing doc surface?

The finding this closes: `CCP_APPLY_FROZEN` (the auto-apply scheduler's operator emergency
stop) and `CCP_APPLY_AUTO_REVERT` were mentioned in *zero* markdown/env-example/compose
files — only in code comments; `CCP_DRIFT_IMPORT` and `CCP_DRIFT_CHECK_CMD` were each
documented in ONE place (an OpenAPI YAML / prose docs) but absent from `ccp/api/README.md`,
which `ccp/README.md` itself designates as "the place every environment variable is
documented". An operator had no way to discover the emergency-stop knob they'd need in an
incident.

Extracts every `CCP_*` token the api's source actually reads or names as an env var —
`process.env.CCP_X`, the injected-`env`-parameter convention this codebase's domain layer
uses (`env.CCP_X`), and a quoted string literal (`'CCP_X'`/`"CCP_X"`, catching indirect
reads through a named constant, e.g. `store/dataLock.ts`'s `const TAKEOVER_ENV =
'CCP_DATA_LOCK_TAKEOVER'`) — and checks each appears (word-bounded) in at least one of the
doc surfaces DOC-9 named. A var mentioned in ANY one of them counts as documented: this
codebase deliberately splits documentation across `ccp/api/README.md` (the canonical,
exhaustive reference) and `ccp/.env.example`/`docker-compose.yml` (a curated deploy
template covering the common case) — DOC-9's own text confirms the scanner/forge/instance
families are "thoroughly covered" in the latter without needing a README.md row too.

Deliberately narrow (mirrors check-path-filters.sh's "not a general walker" philosophy): a
var read only through a MORE indirect pattern than the three above (e.g. built from string
concatenation) would not be caught. That is a known gap, not a silent one — the exact
extraction patterns are named in this header, so a gap is visible to anyone reading it.

Exit codes: 0 every var is documented somewhere · 1 at least one is not.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_SRC = ROOT / "ccp" / "api" / "src"

DOC_SURFACES = [
    ROOT / "ccp" / "api" / "README.md",
    ROOT / "ccp" / "api" / ".env.example",
    ROOT / "ccp" / ".env.example",
    ROOT / "ccp" / "docker-compose.yml",
    ROOT / "ccp" / "docs" / "go-live.md",
]

VAR_RE = re.compile(r"""process\.env\.(CCP_[A-Z0-9_]+)|\benv\.(CCP_[A-Z0-9_]+)|['"](CCP_[A-Z0-9_]+)['"]""")


def used_vars() -> set[str]:
    found: set[str] = set()
    for path in API_SRC.rglob("*.ts"):
        if path.name.endswith(".test.ts"):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for m in VAR_RE.finditer(text):
            found.add(next(g for g in m.groups() if g))
    return found


def documented_vars() -> set[str]:
    documented: set[str] = set()
    text = ""
    for surface in DOC_SURFACES:
        if surface.is_file():
            text += "\n" + surface.read_text(encoding="utf-8", errors="ignore")
    for var in re.findall(r"CCP_[A-Z0-9_]+", text):
        documented.add(var)
    return documented


def main() -> int:
    if not API_SRC.is_dir():
        print(f"docs-env-vars-check: missing input {API_SRC}", file=sys.stderr)
        return 1
    missing_surfaces = [s for s in DOC_SURFACES if not s.is_file()]
    if missing_surfaces:
        print("docs-env-vars-check: missing doc surface(s) — cannot run, which is not passing:", file=sys.stderr)
        for s in missing_surfaces:
            print(f"  {s}", file=sys.stderr)
        return 1

    used = used_vars()
    if not used:
        print("docs-env-vars-check: found zero CCP_* var usages — extraction is broken, not a clean repo", file=sys.stderr)
        return 1
    documented = documented_vars()

    undocumented = sorted(used - documented)
    if undocumented:
        print(f"docs-env-vars-check: {len(undocumented)} CCP_* var(s) read by the api but documented nowhere:")
        for v in undocumented:
            print(f"  {v}")
        print("Add each to ccp/api/README.md's env table (the canonical, exhaustive reference).")
        return 1
    print(f"docs-env-vars-check: all {len(used)} CCP_* var(s) the api reads are documented in at least one surface")
    return 0


if __name__ == "__main__":
    sys.exit(main())
