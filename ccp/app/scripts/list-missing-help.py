#!/usr/bin/env python3
"""Report manifest params that lack help text — the R5 teaching layer (0005 LEARN-5).

Every form field an L1 sees should explain what the attribute is. This gate lists
params whose `help` is missing/empty and exits non-zero if any remain, so CI can
enforce that the catalog stays fully documented.

Usage: python3 ccp/app/scripts/list-missing-help.py  (run from the repo root)
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFESTS = os.path.join(HERE, "..", "src", "data", "manifests")


def main() -> int:
    missing = []
    total = 0
    for path in sorted(glob.glob(os.path.join(MANIFESTS, "*.json"))):
        manifest = json.load(open(path))
        for op in manifest.get("operations", []):
            for param in op.get("params", []):
                total += 1
                if not str(param.get("help", "")).strip():
                    missing.append(f'{manifest["service"]} / {op["id"]} / {param["name"]}')
    for m in missing:
        print("MISSING HELP:", m)
    print(f"\n{len(missing)} of {total} params lack help text.")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
