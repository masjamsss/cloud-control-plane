#!/usr/bin/env bash
# gen-project-data-selftest.sh — does ERR-16's unreachable-control-plane
# handling in scripts/gen-project-data.sh actually do what its comments claim?
#
# Curl exits 5/6/7/28/35/52/55/56 are the "could not reach the control plane at
# all" class (air-gapped estate, DNS, firewall) — the script exits 0 on that
# path by design (docs/runbooks/account-data-ci.md §Manual fallback), which
# means a week-long outage used to be invisible: an unbroken row of green
# `ccp-data` runs while the portal served ever-staler data, discoverable only
# by opening a run's artifact and reading upload-status.json (ERR-16). This
# drives the REAL script (not a reimplementation of its logic) through that
# exact path against `http://127.0.0.1:1` — a loopback port nothing binds, so
# curl fails with exit 7 deterministically and with no dependency on outbound
# network access — and checks what a human or a notifications digest actually
# sees.
#
# Why the real script and not a unit test of an extracted function: the
# behavior under test — a `::warning::` annotation, a $GITHUB_STEP_SUMMARY
# block, and an opt-in hard-fail — is glued together with the real generator
# pipeline's exit codes and env, and a mock of that glue is exactly the kind
# of thing that passes while the real wiring has quietly drifted.
#
# Four scenarios:
#   1. plain run (no GITHUB_ACTIONS): exits 0, ordinary WARN only, no ::warning::
#   2. GITHUB_ACTIONS=true + GITHUB_STEP_SUMMARY set: exits 0, ::warning:: emitted,
#      the step-summary file gets the "control plane unreachable" section
#   3. CCP_DATA_REQUIRE_UPLOAD=1: the SAME unreachable condition now hard-fails
#      (exit 1) instead of exiting 0
#   4. CCP_DATA_REQUIRE_UPLOAD=1 with no --url at all (the separate
#      "not configured yet" path): still exits 0 — the opt-in only reaches the
#      unreachable-control-plane branch, not every exit-0 path in the script
#
# Exit codes: 0 every scenario behaved · 1 a scenario did not · 2 setup/internal error.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${GEN_PROJECT_DATA:-$ROOT/scripts/gen-project-data.sh}"
[ -f "$SCRIPT" ] || { echo "selftest: no script at $SCRIPT" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "selftest: python3 is required" >&2; exit 2; }
command -v node    >/dev/null 2>&1 || { echo "selftest: node is required" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

# A single real (if minimal) Terraform root — the generators are exercised for
# real, not stubbed, same as scenario design elsewhere in this repo's selftests.
TF_ROOT="$TMP/tfroot"
mkdir -p "$TF_ROOT"
cat >"$TF_ROOT/main.tf" <<'TF'
resource "aws_s3_bucket" "selftest" {
  bucket = "gen-project-data-selftest-bucket"
}
TF

UNREACHABLE_URL="http://127.0.0.1:1"   # nothing binds port 1 on loopback — curl exit 7, always, no network needed
TOKEN="selftest-upload-token-0123456789"

# Toolchain pins are exact in real CI (setup-python/setup-node read them off
# --print-pins, same as the ccp-data.yml job this script backs) but a bare local
# checkout can easily be off-pin — that is a DIFFERENT thing than what this
# selftest checks, so skip the pin gate rather than let it mask the result.
PIN_FLAG=""
eval "$("$SCRIPT" --print-pins | sed 's/^/PIN_/')"
PY_SERIES="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$PY_SERIES" != "$PIN_python_series" ] || [ "$NODE_MAJOR" != "$PIN_node_major" ]; then
  echo "selftest: local toolchain (python $PY_SERIES, node $NODE_MAJOR) differs from the pin (python $PIN_python_series, node $PIN_node_major) — running with --unsafe-skip-pin-check; real CI matches the pin exactly via --print-pins"
  PIN_FLAG="--unsafe-skip-pin-check"
fi

# Only install deps if they aren't already there. Real CI never has them (a
# fresh checkout, every run) so --install-deps fires there every time, same as
# the production ccp-data.yml step; a repeat local run of this selftest skips
# the network round-trip instead of re-running `npm ci` for nothing.
INSTALL_FLAG=""
if [ ! -d "$ROOT/ccp/app/node_modules" ] || ! python3 -c 'import hcl2' >/dev/null 2>&1; then
  INSTALL_FLAG="--install-deps"
fi

# run <name> <out-dir> <extra env...> -- -- <extra script args...>
# Runs the real script once; leaves stdout+stderr in $OUT, exit code in $rc.
run() {
  local name="$1" out="$2"; shift 2
  local envs=() ; while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  OUT="$TMP/$name.out"
  rc=0
  ( cd "$ROOT" && env "${envs[@]}" bash "$SCRIPT" \
      --project-id selftest --root "$TF_ROOT" --out "$out" \
      --url "$UNREACHABLE_URL" $PIN_FLAG "$@" \
  ) >"$OUT" 2>&1 || rc=$?
}

check_exit() { # check_exit <name> <expected 0|nonzero>
  local name="$1" expect="$2"
  if [ "$expect" = "0" ] && [ "$rc" -ne 0 ]; then
    echo "SELFTEST FAIL — $name: expected exit 0, got $rc" >&2; sed 's/^/    | /' "$OUT" >&2
    failures=$((failures + 1)); return 1
  fi
  if [ "$expect" = "nonzero" ] && [ "$rc" -eq 0 ]; then
    echo "SELFTEST FAIL — $name: expected a nonzero exit, got 0" >&2; sed 's/^/    | /' "$OUT" >&2
    failures=$((failures + 1)); return 1
  fi
  return 0
}

check_contains() { # check_contains <name> <file> <needle>...
  local name="$1" file="$2"; shift 2
  local needle
  for needle in "$@"; do
    if ! grep -qF -- "$needle" "$file"; then
      echo "SELFTEST FAIL — $name: expected to find \"$needle\" in $file, did not." >&2
      sed 's/^/    | /' "$file" >&2
      failures=$((failures + 1)); return 1
    fi
  done
  return 0
}

check_not_contains() { # check_not_contains <name> <file> <needle>
  local name="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$file"; then
    echo "SELFTEST FAIL — $name: expected NOT to find \"$needle\" in $file, but did." >&2
    sed 's/^/    | /' "$file" >&2
    failures=$((failures + 1)); return 1
  fi
  return 0
}

# ── 1 · plain run — no GITHUB_ACTIONS ────────────────────────────────────────
run scenario1 "$TMP/out1" \
  CCP_UPLOAD_TOKEN="$TOKEN" GITHUB_ACTIONS= GITHUB_STEP_SUMMARY= -- $INSTALL_FLAG
if check_exit "plain unreachable exits 0" 0; then
  check_contains "plain unreachable warns" "$OUT" \
    "control plane unreachable (curl exit 7)"
  check_not_contains "plain unreachable emits no ::warning:: outside Actions" "$OUT" \
    "::warning::"
  check_contains "plain unreachable records status" "$TMP/out1/upload-status.json" \
    '"status": "unreachable"'
fi
echo "selftest: scenario 1 done ($([ "$failures" -eq 0 ] && echo ok || echo "failures so far: $failures"))"

# ── 2 · GITHUB_ACTIONS=true + GITHUB_STEP_SUMMARY ────────────────────────────
SUMMARY="$TMP/step-summary.md"
: >"$SUMMARY"
run scenario2 "$TMP/out2" \
  CCP_UPLOAD_TOKEN="$TOKEN" GITHUB_ACTIONS=true GITHUB_STEP_SUMMARY="$SUMMARY" --
if check_exit "unreachable-in-Actions exits 0" 0; then
  check_contains "unreachable-in-Actions emits ::warning::" "$OUT" \
    "::warning::gen-project-data: control plane unreachable"
  check_contains "step summary gets the unreachable section" "$SUMMARY" \
    "control plane unreachable (curl exit 7)" "127.0.0.1:1"
fi
echo "selftest: scenario 2 done ($([ "$failures" -eq 0 ] && echo ok || echo "failures so far: $failures"))"

# ── 3 · CCP_DATA_REQUIRE_UPLOAD=1 opts OUT of the exit-0 fallback ───────────
run scenario3 "$TMP/out3" \
  CCP_UPLOAD_TOKEN="$TOKEN" CCP_DATA_REQUIRE_UPLOAD=1 GITHUB_ACTIONS= GITHUB_STEP_SUMMARY= --
if check_exit "opt-in hard-fail reddens the run" nonzero; then
  check_contains "opt-in hard-fail names the variable" "$OUT" \
    "CCP_DATA_REQUIRE_UPLOAD=1" "hard failure"
fi
echo "selftest: scenario 3 done ($([ "$failures" -eq 0 ] && echo ok || echo "failures so far: $failures"))"

# ── 4 · CCP_DATA_REQUIRE_UPLOAD=1 does not leak into the no-URL path ────────
# Same flag, but no --url configured at all — a different exit-0 branch
# (write_status "skipped-no-url") that ERR-16's opt-in was never meant to touch.
rc=0
( cd "$ROOT" && env CCP_DATA_REQUIRE_UPLOAD=1 bash "$SCRIPT" \
    --project-id selftest --root "$TF_ROOT" --out "$TMP/out4" $PIN_FLAG \
) >"$TMP/scenario4.out" 2>&1 || rc=$?
OUT="$TMP/scenario4.out"
check_exit "opt-in flag does not affect the no-URL-configured path" 0
echo "selftest: scenario 4 done ($([ "$failures" -eq 0 ] && echo ok || echo "failures so far: $failures"))"

if [ "$failures" -ne 0 ]; then
  echo "gen-project-data-selftest: $failures check(s) FAILED"
  exit 1
fi
echo "gen-project-data-selftest: PASS — 4 scenarios"
