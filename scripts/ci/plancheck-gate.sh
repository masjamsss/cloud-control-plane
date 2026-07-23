#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# plancheck-gate.sh — the load-bearing ccp apply gate (plan-8 W2).
#
# Given a terraform plan JSON and the request that produced it, this script:
#   1. computes DIGEST = sha256(plan.json) and emits it (stdout + --digest-out),
#      the value the `ccp/plan-digest` commit status carries and that
#      approvals bind to (approve-this-exact-plan);
#   2. OPTIONALLY re-verifies that digest against an expected value
#      (--expect-digest) — the apply-time "the plan reviewed is the plan
#      applied" backstop: a mismatch (drift / racing merge / tampered plan)
#      is a HARD FAIL;
#   3. runs `catalogctl plan-check` (rules R1–R6) against the plan+request —
#      any VIOLATION is a HARD FAIL (the machine half of L2, proposal 0012).
#
# It is deterministic and offline (no AWS, no GitHub): the workflow produces
# plan.json with a real `terraform plan`; this script only hashes and checks.
# That is what makes it unit-testable against tools/catalogctl/testdata/plans
# fixtures (see plancheck_gate_test.go) — the workflow calls the exact script
# the test exercises.
#
# Usage:
#   scripts/ci/plancheck-gate.sh \
#       --plan PLAN.json --request REQ.yaml --manifests DIR \
#       [--catalogctl BIN] [--digest-out FILE] [--expect-digest HEX|@FILE]
#
# Exit codes:
#   0  digest ok (or unbound) AND plan-check clean  → merge/apply may proceed
#   2  plan-check VIOLATION                          → catalogctl exit 2, blocked
#   3  plan-check parse/resolution error             → catalogctl exit 3
#   4  digest mismatch (--expect-digest)             → plan is NOT the approved one
#   1  usage / internal error
# ---------------------------------------------------------------------------
set -euo pipefail

PLAN="" REQUEST="" MANIFESTS="" CATALOGCTL="" DIGEST_OUT="" EXPECT_DIGEST=""

die() { echo "plancheck-gate: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --plan)          PLAN="${2:-}"; shift 2 ;;
    --request)       REQUEST="${2:-}"; shift 2 ;;
    --manifests)     MANIFESTS="${2:-}"; shift 2 ;;
    --catalogctl)    CATALOGCTL="${2:-}"; shift 2 ;;
    --digest-out)    DIGEST_OUT="${2:-}"; shift 2 ;;
    --expect-digest) EXPECT_DIGEST="${2:-}"; shift 2 ;;
    -h|--help)       sed -n '2,40p' "$0"; exit 0 ;;
    *)               die "unknown flag: $1" ;;
  esac
done

[ -n "$PLAN" ]      || die "--plan is required"
[ -n "$REQUEST" ]   || die "--request is required"
[ -n "$MANIFESTS" ] || die "--manifests is required"
[ -f "$PLAN" ]      || die "plan file not found: $PLAN"
[ -f "$REQUEST" ]   || die "request file not found: $REQUEST"
[ -d "$MANIFESTS" ] || die "manifests dir not found: $MANIFESTS"

# --- 1. compute the plan digest (portable across macOS/Linux) ----------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "no sha256 tool (need sha256sum or shasum)"
  fi
}
DIGEST="$(sha256_of "$PLAN")"
echo "plan-digest: sha256:${DIGEST}" >&2
echo "$DIGEST"  # bare hex on stdout — the workflow captures this for the commit status
if [ -n "$DIGEST_OUT" ]; then printf '%s\n' "$DIGEST" > "$DIGEST_OUT"; fi

# --- 2. optional digest binding (approve-this-exact-plan) --------------------
if [ -n "$EXPECT_DIGEST" ]; then
  case "$EXPECT_DIGEST" in
    @*) ef="${EXPECT_DIGEST#@}"; [ -f "$ef" ] || die "expected-digest file not found: $ef"
        # accept either a bare hex line or a `digest: "<hex>"` field
        EXPECT_DIGEST="$(grep -oE '[0-9a-f]{64}' "$ef" | head -n1 || true)"
        [ -n "$EXPECT_DIGEST" ] || die "no sha256 hex found in $ef" ;;
  esac
  if [ "$DIGEST" != "$EXPECT_DIGEST" ]; then
    echo "::error::plan digest mismatch — expected ${EXPECT_DIGEST}, got ${DIGEST}. The plan is not the one that was approved (drift / racing merge / tampering); re-approval required." >&2
    exit 4
  fi
  echo "plan-digest bound: matches the approved digest" >&2
fi

# --- 3. resolve catalogctl -------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_plancheck() {
  if [ -n "$CATALOGCTL" ]; then
    "$CATALOGCTL" plan-check --plan "$PLAN" --request "$REQUEST" --manifests "$MANIFESTS"
  else
    ( cd "$ROOT/tools/catalogctl" && go run ./cmd/catalogctl plan-check \
        --plan "$PLAN" --request "$REQUEST" --manifests "$MANIFESTS" )
  fi
}

# --- 4. run plan-check — VIOLATION is a hard block ---------------------------
set +e
run_plancheck
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "::error::catalogctl plan-check failed (exit ${rc}) — the plan does more than the request authorises; merge blocked." >&2
  exit "$rc"
fi
echo "plancheck-gate: PASS — digest posted and plan-check clean" >&2
exit 0
