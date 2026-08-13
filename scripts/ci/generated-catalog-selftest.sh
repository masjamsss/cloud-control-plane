#!/usr/bin/env bash
# generated-catalog-selftest.sh — does the generated-catalog staleness check actually
# catch a stale artifact?
#
# IMP-8 added `gen-azure-ledger.mjs --check`: regenerate the committed catalog artifacts
# from the committed schemadump and fail on any difference. That check is itself a piece
# of evidence, and the rule this repo runs on is that a reference nobody dereferences is
# not evidence (L-28's second half) — which applies to a checker as much as to the thing
# checked. So this drives the REAL check against artifacts whose correct verdict is known
# before it runs.
#
# The scenario that matters most is D. The dangerous failure of a regenerate-and-compare
# check is not a wrong verdict, it is a VACUOUS pass: a run that compared nothing, or
# skipped a missing file as "not applicable", reports success just as confidently as a run
# that verified everything. That is the shape IMP-4's own self-check nearly shipped with
# (a field-name typo produced a uniform zero that read as an answer) and the shape L-1 is
# about. A deleted artifact is the MOST stale an artifact can be, so it must fail, not skip.
#
# Written as rules rather than as today's offenders (L-25): each scenario states a property
# the check must have — detects an edited row, detects an edited summary, detects a missing
# file, detects an empty file, passes a pristine tree and says what it compared — so a
# future rewrite is held to the same five however it is implemented.
#
#   LEDGER_GEN=<path>  run a different copy of the generator (used to prove these scenarios
#                      fail against the unfixed script — see FIXES.md, IMP-8).
#
# Exit codes: 0 every scenario behaved · 1 a scenario did not · 2 setup/internal error.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="${LEDGER_GEN:-$ROOT/tools/schemadump/gen-azure-ledger.mjs}"
LEDGER="$ROOT/catalog/azure-capability-ledger.json"
SUMMARY="$ROOT/catalog/azure-capability-ledger-summary.md"

[[ -f "$GEN" ]] || { echo "selftest: no generator at $GEN" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "selftest: node is required" >&2; exit 2; }
for f in "$LEDGER" "$SUMMARY"; do
  [[ -s "$f" ]] || { echo "selftest: committed artifact missing or empty: $f" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0
OUT="$TMP/out.txt"

# Run the real check with its outputs pointed at the scenario's copies.
run_check() { # run_check <ledger> <summary>
  CCP_AZURE_LEDGER="$1" CCP_AZURE_LEDGER_SUMMARY="$2" \
    node "$GEN" --check >"$OUT" 2>&1
}

fresh() { # fresh <dir> — a pristine copy of both committed artifacts
  mkdir -p "$1"
  cp "$LEDGER" "$1/ledger.json"
  cp "$SUMMARY" "$1/summary.md"
}

expect_fail() { # expect_fail <name> <needle>
  local name="$1" needle="$2"
  if [[ $rc -eq 0 ]]; then
    printf '  FAIL %s\n     the check PASSED on an artifact that is stale\n' "$name"
    failures=$((failures + 1))
    return
  fi
  if ! grep -qF -- "$needle" "$OUT"; then
    printf '  FAIL %s\n     failed, but never said %q. Output:\n' "$name" "$needle"
    sed 's/^/       /' "$OUT"
    failures=$((failures + 1))
    return
  fi
  printf '  ok   %s\n' "$name"
}

echo "generated-catalog selftest — driving $GEN"

# ── A · a pristine tree passes, and SAYS WHAT IT COMPARED ───────────────────
# The second half is the point: a check that passes without reporting a
# non-zero comparison count is indistinguishable from one that did nothing.
fresh "$TMP/a"
run_check "$TMP/a/ledger.json" "$TMP/a/summary.md"
rc=$?
if [[ $rc -ne 0 ]]; then
  printf '  FAIL A pristine artifacts must pass. Output:\n'
  sed 's/^/       /' "$OUT"
  failures=$((failures + 1))
elif ! grep -qE 'ledger rows compared' "$OUT"; then
  printf '  FAIL A passed without reporting what it compared — a silent pass is not a pass\n'
  failures=$((failures + 1))
elif grep -qE '· 0 ledger rows compared' "$OUT"; then
  printf '  FAIL A reported comparing ZERO rows and still passed\n'
  failures=$((failures + 1))
else
  printf '  ok   A pristine artifacts pass, and the check reports its comparison count\n'
fi

# ── B · a hand-edited ledger row is detected ────────────────────────────────
# The IMP-4 shape: a derived file edited in place rather than regenerated. The
# edit is a plausible one (a family reclassified), not corrupt JSON.
fresh "$TMP/b"
python3 - "$TMP/b/ledger.json" <<'PY'
import json, sys
p = sys.argv[1]
rows = json.load(open(p))
target = next(r for r in rows if r["type"] == "azurerm_linux_virtual_machine")
assert target["family"] == "compute", f"precondition: expected compute, got {target['family']}"
target["family"] = "other"          # exactly IMP-4's defect, hand-applied
json.dump(rows, open(p, "w"), indent=2)
PY
[[ $? -eq 0 ]] || { echo "selftest: could not stale the ledger" >&2; exit 2; }
run_check "$TMP/b/ledger.json" "$TMP/b/summary.md"
rc=$?
expect_fail "B an edited ledger row is detected" "azure-capability-ledger.json is STALE"

# ── C · an edited summary is detected ───────────────────────────────────────
fresh "$TMP/c"
printf '\nA line nobody generated.\n' >> "$TMP/c/summary.md"
run_check "$TMP/c/ledger.json" "$TMP/c/summary.md"
rc=$?
expect_fail "C an edited summary is detected" "summary.md is STALE"

# ── D · a MISSING artifact fails rather than being skipped ──────────────────
# The vacuous-pass case. "The file is not there" must never be answered with
# "then there is nothing to compare, so this passes".
fresh "$TMP/d"
rm -f "$TMP/d/summary.md"
run_check "$TMP/d/ledger.json" "$TMP/d/summary.md"
rc=$?
expect_fail "D a missing artifact fails, it is not skipped" "is MISSING"

# ── E · an EMPTY artifact fails ─────────────────────────────────────────────
# A truncated write (out of disk, killed process) leaves a file that exists and
# compares as "not equal" — but only if emptiness is checked before content.
fresh "$TMP/e"
: > "$TMP/e/summary.md"
run_check "$TMP/e/ledger.json" "$TMP/e/summary.md"
rc=$?
expect_fail "E an empty artifact fails" "is EMPTY"

echo
if [[ $failures -gt 0 ]]; then
  echo "generated-catalog selftest: $failures scenario(s) did not behave — FAIL"
  exit 1
fi
echo "generated-catalog selftest: 5/5 scenarios behaved — PASS"
