#!/usr/bin/env bash
# =============================================================================
# CI-4 — a gate script with no consumer is a gate that does not run, and a doc
# pointing at a workflow that does not exist is worse than no pointer.
#
# `plancheck-gate.sh` and `apply-window-gate.sh` both state that "the workflow
# invokes the exact script the test exercises" — and no workflow anywhere invoked
# either. Zero consumers across every *.yml in the repo. Meanwhile four shipped
# scripts and docs anchored the Terraform pin to a workflow that does not exist here;
# one of them was a `self-update.sh` grep watching that path for toolchain changes, so
# the warning could never fire.
#
# Both halves are the same defect: a claim about a file, with nothing checking the
# file is there. This is what checks it.
#
# Exit codes: 0 every claim holds · 1 a gate lost its consumer or a stale
# workflow reference came back.
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; fails=$((fails + 1)); }

# --- the check must be able to fail -------------------------------------------
# If the scripts were renamed, every "no consumer" test below would pass by
# finding nothing to check. Assert the subjects exist first (L-1).
for f in scripts/ci/plancheck-gate.sh scripts/ci/apply-window-gate.sh; do
  [ -f "$f" ] || { echo "missing input: $f — this check cannot run, which is not passing" >&2; exit 1; }
done

# --- every apply-lane gate script has at least one workflow consumer ----------
for script in plancheck-gate.sh apply-window-gate.sh; do
  # Search workflows only — a mention in a doc or a test is not a pipeline.
  hits=$(grep -rl "scripts/ci/$script" .github/workflows .gitlab 2>/dev/null | wc -l | tr -d ' ')
  if [ "$hits" -gt 0 ]; then
    pass "scripts/ci/$script is invoked by $hits workflow(s)"
  else
    fail "scripts/ci/$script is invoked by NO workflow" \
         "its own header says the workflow runs the exact script the test exercises; an adopting estate gets the gate and no pipeline that runs it"
  fi
done

# --- the ccp/plan-digest commit status has a publisher -------------------------
# plancheck-gate.sh names this status as the value approvals bind to. A status
# nothing posts cannot be required, reviewed, or trusted.
if grep -rq 'ccp/plan-digest' .github/workflows 2>/dev/null; then
  pass "the ccp/plan-digest commit status is published by a workflow"
else
  fail "nothing publishes the ccp/plan-digest commit status" \
       "plancheck-gate.sh names it as what approve-this-exact-plan binds to"
fi

# --- no shipped file may reference a workflow that does not exist --------------
# The stale-reference class, checked generally rather than by listing the four
# known offenders — a new one would otherwise go unnoticed exactly as these did.
# docs/audit/ is excluded: the audit reports QUOTE the broken references as their
# evidence, and rewriting the record to satisfy a checker would be the wrong fix.
missing=0
while IFS=: read -r file ref; do
  [ -n "$ref" ] || continue
  [ -f "$ref" ] && continue
  printf '     %s -> %s (does not exist)\n' "$file" "$ref"
  missing=$((missing + 1))
done < <(
  # Scanned by CONTENT, not by extension. The first version of this check listed
  # *.sh/*.md/*.mjs/*.ts and missed ccp/toolbox/Dockerfile — a file with no extension at
  # all, carrying one of the four references the finding explicitly names. A rule with an
  # arbitrary scope limit is a list wearing a rule's clothes (L-25).
  grep -rnoE '\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml' \
    --binary-files=without-match \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    . 2>/dev/null \
    | grep -v node_modules | grep -v '/docs/audit/' \
    | sed 's/^\.\///' | awk -F: '{print $1":"$3}' | sort -u
)
if [ "$missing" -eq 0 ]; then
  pass "every .github/workflows/*.yml reference in shipped files resolves"
else
  fail "$missing reference(s) point at a workflow that does not exist" \
       "a pin anchored to a missing file cannot be verified, and a grep watching one can never fire"
fi

echo
if [ "$fails" -eq 0 ]; then echo "check-shipped-lanes: gates have consumers and every workflow reference resolves"; exit 0; fi
echo "check-shipped-lanes: $fails problem(s)"; exit 1
