#!/usr/bin/env python3
"""Fail if any relative markdown link in the published tree resolves to nothing.

DOC-5: a mechanical scan once found 122 relative `.md` links pointing at files that do
not exist — private ADRs that were deliberately never published, runbooks that were
promised and never written, and citations into a planning archive this repo does not
ship. Readers following the docs' own navigation hit dead ends constantly, and several
"see X for the full contract" statements were unfulfillable.

Nothing was watching, so nothing stopped it accumulating. This is that watcher.

WHAT IT CHECKS
  Every `[text](target)` in every tracked `.md` file, where `target` is relative.
  Absolute URLs, `mailto:`, and pure `#anchor` links are out of scope (this checker
  makes no network calls — a link checker that needs the network is a link checker
  that gets disabled). A `path#anchor` target is checked for the path only.

WHY IT IS NOT SILENT ABOUT ITS OWN SCOPE
  It prints how many links it checked, not just how many broke. A scan that silently
  checks zero links must never be indistinguishable from a clean tree (CI-2, L-10) —
  so `--min-links` asserts a floor, and the run fails if the corpus vanishes.

USAGE
    python3 scripts/docs-link-check.py            # check, exit 1 on any breakage
    python3 scripts/docs-link-check.py --list     # print every broken link and exit 0
"""
from __future__ import annotations

import argparse
import os
import re
import sys

LINK = re.compile(r'\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
SKIP_DIRS = {'.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__', 'work'}
EXTERNAL = re.compile(r'^(https?:|mailto:|tel:|#|<)')

# The audit ledger is integrated centrally and cites paths that intentionally do not
# resolve (findings quote the very links they are reporting as broken). Excluded so
# this gate never fights the record of what it was built to fix.
EXCLUDE_PREFIXES = ('docs/audit/',)

# A floor, not a target: if the tree really does shrink below this, that is a
# deliberate change and this number moves with it in the same commit.
DEFAULT_MIN_LINKS = 250


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def scan(root: str) -> tuple[int, list[tuple[str, int, str]]]:
    checked = 0
    broken: list[tuple[str, int, str]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for filename in sorted(filenames):
            if not filename.endswith('.md'):
                continue
            path = os.path.join(dirpath, filename)
            rel = os.path.relpath(path, root)
            if rel.startswith(EXCLUDE_PREFIXES):
                continue
            try:
                text = open(path, encoding='utf-8').read()
            except (OSError, UnicodeDecodeError):
                continue
            for match in LINK.finditer(text):
                target = match.group(1)
                if EXTERNAL.match(target):
                    continue
                path_part = target.split('#')[0]
                if not path_part:
                    continue
                checked += 1
                resolved = os.path.normpath(os.path.join(dirpath, path_part))
                if not os.path.exists(resolved):
                    line = text[: match.start()].count('\n') + 1
                    broken.append((rel, line, target))
    return checked, sorted(broken)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--list', action='store_true', help='report without failing')
    parser.add_argument('--min-links', type=int, default=DEFAULT_MIN_LINKS)
    args = parser.parse_args()

    root = repo_root()
    checked, broken = scan(root)
    print(f'checked {checked} relative markdown links across the tree; {len(broken)} broken')

    for rel, line, target in broken:
        print(f'  {rel}:{line}  ->  {target}')

    if args.list:
        return 0

    # The self-check: a scan that found almost nothing did not pass, it failed to run.
    if checked < args.min_links:
        print(
            f'\nFAIL: only {checked} links checked, expected at least {args.min_links}.\n'
            'This is not a clean tree — it is a scan that did not run. Either the docs\n'
            'corpus moved, or this script is walking the wrong root.',
            file=sys.stderr,
        )
        return 2

    if broken:
        print(
            f'\nFAIL: {len(broken)} broken relative markdown link(s).\n'
            'Fix the link if the target moved. If the target genuinely does not exist,\n'
            'say so in the prose — de-link it to a code-formatted path — rather than\n'
            'pointing the reader somewhere merely plausible.',
            file=sys.stderr,
        )
        return 1

    print('OK: every relative markdown link resolves.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
