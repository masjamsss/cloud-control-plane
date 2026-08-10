#!/usr/bin/env bash
# =============================================================================
# CI-3 — a workflow's path filter must mirror the IMPORT GRAPH, not the directory tree.
#
# The api is not a self-contained path. It VALUE-IMPORTS `ccp/app/src/lib/*` through the
# `@app-lib` alias — approval-authority predicates (canApprove/canRequest), policy
# defaults, the shared redactor, the dependsOn predicate — i.e. server-side AUTHORIZATION
# decisions. Its parity suites run against the catalogctl binary and its fixtures. And
# catalogctl's own tests EXECUTE `scripts/ci/*.sh` and check a Go-embedded copy of
# `catalog/redaction-rules.json` that carries a byte-identical sync obligation.
#
# None of that was in the filters. A PR editing `ccp/app/src/lib/permissions.ts` ran the
# app and smoke lanes but never the api's typecheck or tests — the suite that actually
# consumes those files — so a break landed on main and surfaced later, on an unrelated PR.
#
# WHY THIS SCRIPT EXISTS RATHER THAN JUST WIDER FILTERS. Widening them fixes today; the
# filters and the import graph drift apart again the moment someone adds an import. This
# derives the dependency FROM THE SOURCE each run and fails when a filter stops covering
# it, so the recurrence is a build failure rather than a future audit finding.
#
# Deliberately NOT a general import-graph walker: it checks the specific cross-component
# edges the finding names, each with the evidence that it is real. A vague check nobody
# trusts gets deleted; a specific one that names the file and the alias gets fixed.
#
# CI-10 ADDS ONE GENERAL CHECK, on purpose, as the one exception to that rule: every
# path-filtered workflow must include its OWN file in both its pull_request and push
# lists, or a push-only edit to the workflow stops re-triggering it post-merge
# (ccp-api.yml and ccp-smoke.yml both had exactly this — present on the pull_request
# side, missing on push). This one earns the general form the edges above deliberately
# avoid: it is a syntactic property of the trigger block itself, not a claim about what
# imports what, so it needs no "is this edge still real" judgment call per workflow —
# unlike edges 1-4, a NINTH filtered workflow is covered automatically, no new section
# required here.
#
# Exit codes: 0 every dependency is covered · 1 a filter is missing one.
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; fails=$((fails + 1)); }

# `wf_has <workflow> <path-glob>` — is the glob present in BOTH the pull_request and
# push filters? Parsed, not grepped: a grep over the file passes when the glob appears in
# EITHER list, so dropping it from one event would go unnoticed — which is exactly what
# happened when this check was first written, and what its own negative test caught.
# (`on:` is bare YAML 1.1, so PyYAML gives it the key True, not "on".)
wf_has() {
  python3 - "$1" "$2" <<'PYEOF'
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1]))
on = doc.get(True, doc.get("on"))
for ev in ("pull_request", "push"):
    node = (on or {}).get(ev)
    if not isinstance(node, dict) or sys.argv[2] not in (node.get("paths") or []):
        sys.exit(1)
sys.exit(0)
PYEOF
}

# --- the check must be able to fail --------------------------------------------
# A workflow file that vanished or was renamed would make every grep below succeed
# vacuously. Assert the inputs exist before believing any result (L-1).
for f in .github/workflows/ccp-api.yml .github/workflows/catalogctl.yml \
         ccp/api/tsconfig.json tools/catalogctl/plancheck_gate_test.go \
         tools/catalogctl/internal/hclops/redact.go catalog/redaction-rules.json; do
  [ -f "$f" ] || { echo "missing input: $f — this check cannot run, which is not the same as passing" >&2; exit 1; }
done

# --- edge 1: api -> ccp/app/src/lib (the @app-lib alias) -----------------------
if grep -q '"@app-lib/\*"' ccp/api/tsconfig.json; then
  n=$(grep -rl '@app-lib' ccp/api/src | wc -l | tr -d ' ')
  if wf_has .github/workflows/ccp-api.yml 'ccp/app/src/lib/**'; then
    pass "ccp-api.yml covers ccp/app/src/lib/** ($n api source files import through @app-lib)"
  else
    fail "ccp-api.yml does not trigger on ccp/app/src/lib/**" \
         "$n api files value-import it via the @app-lib alias, including authorization predicates"
  fi
else
  pass "the @app-lib alias is gone — nothing to cover"
fi

# --- edge 2: api parity suites -> catalogctl ----------------------------------
if grep -rq 'catalogctl' ccp/api/test; then
  if wf_has .github/workflows/ccp-api.yml 'tools/catalogctl/**'; then
    pass "ccp-api.yml covers tools/catalogctl/** (the api's parity suites run against it)"
  else
    fail "ccp-api.yml does not trigger on tools/catalogctl/**" \
         "the cross-layer parity suites compare the api against the catalogctl binary and its fixtures"
  fi
fi

# --- edge 3: catalogctl tests -> scripts/ci ------------------------------------
if grep -rq 'scripts/ci/' tools/catalogctl --include='*_test.go'; then
  if wf_has .github/workflows/catalogctl.yml 'scripts/ci/**'; then
    pass "catalogctl.yml covers scripts/ci/** (its tests execute those scripts)"
  else
    fail "catalogctl.yml does not trigger on scripts/ci/**" \
         "windowgate_test.go / plancheck_gate_test.go execute ../../scripts/ci/*.sh — editing a gate script would run none of the tests that validate it"
  fi
fi

# --- edge 4: the embedded redaction rules -------------------------------------
if grep -q 'SYNC OBLIGATION' tools/catalogctl/internal/hclops/redact.go; then
  if wf_has .github/workflows/catalogctl.yml 'catalog/**'; then
    pass "catalogctl.yml covers catalog/** (the Go embed must stay byte-identical to it)"
  else
    fail "catalogctl.yml does not trigger on catalog/**" \
         "redact.go embeds a copy of catalog/redaction-rules.json under a byte-identical sync obligation, and only its own drift test checks it"
  fi
fi

# --- self-inclusion: every path-filtered workflow must trigger on its own edits ---
self_check_out="$(python3 - <<'PYEOF'
import glob, yaml

for path in sorted(glob.glob(".github/workflows/*.yml")):
    doc = yaml.safe_load(open(path)) or {}
    on = doc.get(True, doc.get("on")) or {}
    pr = on.get("pull_request")
    push = on.get("push")
    pr_paths = pr.get("paths") if isinstance(pr, dict) else None
    push_paths = push.get("paths") if isinstance(push, dict) else None
    # Only a workflow that filters BOTH events by path is in scope — one with no
    # filter (or only one side filtered) already triggers on everything, self
    # included, so there is nothing to check.
    if pr_paths is None or push_paths is None:
        continue
    missing = [ev for ev, paths in (("pull_request", pr_paths), ("push", push_paths)) if path not in paths]
    if missing:
        print(f"FAIL\t{path}\tmissing from {' and '.join(missing)} paths — an edit to this file alone would not re-trigger it there")
    else:
        print(f"OK\t{path}")
PYEOF
)"
# fails is bumped by fail() itself (same shape as edges 1-4 above) — the python side
# only reports, it does not count, so there is exactly one place that increments it.
while IFS=$'\t' read -r kind a b; do
  case "$kind" in
    OK) pass "$a triggers on its own edits (both pull_request and push)" ;;
    FAIL) fail "$a does not include itself in both path filters" "$b" ;;
  esac
done <<< "$self_check_out"

echo
if [ "$fails" -eq 0 ]; then echo "check-path-filters: every cross-component dependency is covered"; exit 0; fi
echo "check-path-filters: $fails filter(s) no longer mirror the import graph"; exit 1
