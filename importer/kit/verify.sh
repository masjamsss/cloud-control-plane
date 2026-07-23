#!/usr/bin/env bash
# verify.sh — acceptance harness for a new environment root.
#
# The bar is EXACTLY the one the prod import met (importer/README.md):
#   1. terraform fmt -check -recursive   -> clean
#   2. terraform validate                -> clean (after offline init)
#   3. the plan gate, per phase:
#        --phase import   plan must be "N to import, 0 to add, 0 to change,
#                         0 to destroy" — imports only, zero mutations
#        --phase steady   plan -detailed-exitcode must exit 0 (a true no-op;
#                         run after the apply + imports.tf archival)
#
# Usage:
#   verify.sh --env-dir <dir> [--phase import|steady] [--no-init] [--skip-plan]
#
# Notes
#   - fmt/validate run with `init -backend=false` (offline). The PLAN step is
#     the only one that needs the real backend + READ-ONLY AWS credentials —
#     run `terraform init` with the backend configured first (runbook phase 3);
#     verify.sh itself never runs a backend init and NEVER applies anything.
#   - TF_BIN overrides the terraform binary — tests point it at a stub, so this
#     script's logic is fixture-testable with zero AWS/terraform (tests/test_scripts.py).
#   - Exit: 0 = all gates green · 2 = a gate failed (message says which).
set -uo pipefail

TF_BIN="${TF_BIN:-terraform}"
ENV_DIR="" PHASE="import" DO_INIT=1 DO_PLAN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --env-dir)  ENV_DIR="$2"; shift 2 ;;
    --phase)    PHASE="$2"; shift 2 ;;
    --no-init)  DO_INIT=0; shift ;;
    --skip-plan) DO_PLAN=0; shift ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "REFUSE BAD_ARG: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done

[ -n "$ENV_DIR" ] || { echo "REFUSE BAD_ARG: --env-dir is required" >&2; exit 2; }
[ -d "$ENV_DIR" ] || { echo "REFUSE BAD_ARG: $ENV_DIR is not a directory" >&2; exit 2; }
case "$PHASE" in import|steady) ;; *) echo "REFUSE BAD_ARG: --phase must be import or steady" >&2; exit 2 ;; esac
command -v "$TF_BIN" >/dev/null 2>&1 || { echo "REFUSE MISSING_DEP: $TF_BIN not found" >&2; exit 2; }
# later steps `cd` into the env root — a relative TF_BIN must survive that
case "$TF_BIN" in
  */*) TF_BIN="$(cd "$(dirname "$TF_BIN")" && pwd)/$(basename "$TF_BIN")" ;;
esac

fail() { echo "VERIFY FAIL [$1]: $2" >&2; exit 2; }

echo "── gate 1: terraform fmt ──"
"$TF_BIN" fmt -check -recursive "$ENV_DIR" \
  || fail fmt "run 'terraform fmt -recursive $ENV_DIR' and re-verify"

echo "── gate 2: terraform validate ──"
if [ "$DO_INIT" -eq 1 ]; then
  ( cd "$ENV_DIR" && "$TF_BIN" init -backend=false -input=false >/dev/null ) \
    || fail init "offline init failed (provider download needs network or a plugin mirror)"
fi
( cd "$ENV_DIR" && "$TF_BIN" validate ) || fail validate "fix the reported errors and re-verify"

if [ "$DO_PLAN" -eq 0 ]; then
  echo "── gate 3: plan SKIPPED (--skip-plan) — fmt+validate only, NOT the full acceptance bar ──"
  exit 0
fi

echo "── gate 3: plan gate (phase: $PHASE) ──"
PLAN_OUT="$(mktemp "${TMPDIR:-/tmp}/kit-verify-plan.XXXXXX")"
trap 'rm -f "$PLAN_OUT"' EXIT

if [ "$PHASE" = "steady" ]; then
  ( cd "$ENV_DIR" && "$TF_BIN" plan -detailed-exitcode -input=false -no-color ) >"$PLAN_OUT" 2>&1
  RC=$?
  tail -5 "$PLAN_OUT"
  [ "$RC" -eq 0 ] || fail plan-steady "plan is not a no-op (exit $RC) — see output above; triage per docs/runbooks/drift-detection.md"
  echo "VERIFY PASS: fmt clean, validate clean, steady-state plan is a no-op"
  exit 0
fi

# import phase: the plan may (must) import, but may not add/change/destroy.
( cd "$ENV_DIR" && "$TF_BIN" plan -input=false -no-color ) >"$PLAN_OUT" 2>&1
RC=$?
[ "$RC" -eq 0 ] || { tail -20 "$PLAN_OUT"; fail plan-import "terraform plan errored (exit $RC)"; }

SUMMARY="$(grep -E '^Plan: ' "$PLAN_OUT" | tail -1)"
if [ -z "$SUMMARY" ]; then
  if grep -q 'No changes' "$PLAN_OUT"; then
    fail plan-import "plan shows no changes at all — the import blocks are missing (imports.tf not in the root?)"
  fi
  fail plan-import "could not find a 'Plan:' summary in the plan output"
fi
echo "$SUMMARY"
echo "$SUMMARY" | grep -Eq 'Plan: [0-9]+ to import, 0 to add, 0 to change, 0 to destroy' \
  || fail plan-import "plan is NOT import-only — align the config to live values until add/change/destroy are all 0 (importer/docs/import-plan.md step 4)"

echo "VERIFY PASS: fmt clean, validate clean, plan is import-only ($SUMMARY)"
