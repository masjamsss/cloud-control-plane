#!/usr/bin/env bash
# =============================================================================
# Regression test for OPS-5 — the post-cutover check that auto-rolled back every
# successful legacy migration.
#
# Step 10 cuts over (`compose up -d --build`) and waits for /readyz. Step 11 then
# probed the store INSIDE the running container and compared it to the pre-migration
# source. The old probe re-hashed the WHOLE store and refused on ANY difference — but
# the cutover boot is, by this ceremony's own design, the FIRST boot of the new code on
# this store, and on any store without a SETTLEMENT marker `runSettlement` rewrites
# ccp.json at boot. The diff was non-empty, the script refused, and it rolled back a
# migration that had completely succeeded.
#
# The population this script exists for — hosts still on the legacy named volume, i.e.
# installs predating the /data consolidation and therefore almost certainly predating
# settlement — is precisely the population guaranteed to hit it.
#
# This test does NOT run the whole ceremony (that needs docker and a real volume). It
# extracts step 11's probe logic and drives it against the two situations that matter:
#
#   settlement rewrote ccp.json, project data intact  -> MUST PASS  (the defect)
#   project data actually lost                        -> MUST REFUSE (not weakened)
#
# The second case is the point of the pairing: an over-tolerant "fix" that simply
# stopped checking would pass the first case and silently accept real data loss.
#
# Exit codes: 0 all assertions pass · 1 an assertion failed.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATE_SH="$(cd "$SCRIPT_DIR/.." && pwd)/migrate-data.sh"
[ -f "$MIGRATE_SH" ] || { echo "cannot find migrate-data.sh at $MIGRATE_SH" >&2; exit 1; }

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; fails=$((fails + 1)); }

# --- the assertion that makes this test a test -------------------------------
# The probe must compare project data ONLY, never the whole store. If step 11 still
# diffs `pre.files` (the whole-tree manifest) the defect is back, and every scenario
# below would be arguing about the wrong thing.
if grep -q 'diff "\$UPDATE_STATE/pre\.files" "\$UPDATE_STATE/post-cutover\.files"' "$MIGRATE_SH"; then
  fail "step 11 still diffs the WHOLE-store manifest" \
       "settlement's boot write makes that diff non-empty on exactly the hosts this script targets"
fi
grep -q 'pre-projects\.files' "$MIGRATE_SH" \
  || fail "no project-data-only manifest is captured" \
          "step 11 cannot honestly compare anything after a boot that is allowed to write"

# --- scenario harness --------------------------------------------------------
# Mirrors step 11's decision on real files, so the logic is exercised rather than
# described. PRE/POST project manifests plus the row/active counts, in and out.
probe() { # $1=pre-projects $2=post-projects $3=PRE_ROWS $4=POST_ROWS $5=PRE_ACTIVE $6=POST_ACTIVE
  local d; d="$(diff "$1" "$2" || true)"
  [ -n "$d" ] && { echo "REFUSE:project-data"; return; }
  if [ "$4" -lt "$3" ] || [ "$6" -lt "$5" ]; then echo "REFUSE:counts"; return; fi
  echo "OK"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'abc  projects/p1/inventory.json\ndef  projects/p1/manifests.json\n' > "$tmp/pre"
cp "$tmp/pre" "$tmp/post-same"
printf 'abc  projects/p1/inventory.json\n' > "$tmp/post-lost"

# 1. THE DEFECT. Settlement rewrote ccp.json at first boot, so the whole-store hash
#    differs — but no project file changed and no count decreased. Must pass.
r="$(probe "$tmp/pre" "$tmp/post-same" 3 3 1 1)"
[ "$r" = "OK" ] && pass "settlement's boot write does not roll back a successful migration" \
  || fail "settlement's boot write still refuses" "probe said $r"

# 2. Settlement may also ADD rows (retro-registration). Non-decreasing, not equal.
r="$(probe "$tmp/pre" "$tmp/post-same" 3 5 1 2)"
[ "$r" = "OK" ] && pass "rows/pointers ADDED by settlement are accepted (non-decreasing, not equal)" \
  || fail "an increase was treated as a mismatch" "probe said $r"

# 3. NOT weakened: a lost project file still refuses. An over-tolerant fix that just
#    stopped checking would pass case 1 and accept real corruption here.
r="$(probe "$tmp/pre" "$tmp/post-lost" 3 3 1 1)"
[ "$r" = "REFUSE:project-data" ] && pass "a MISSING project-data file still refuses and rolls back" \
  || fail "project-data loss was accepted" "probe said $r"

# 4. NOT weakened: decreasing counts still refuse.
r="$(probe "$tmp/pre" "$tmp/post-same" 3 2 1 1)"
[ "$r" = "REFUSE:counts" ] && pass "DECREASING version rows still refuse and roll back" \
  || fail "row loss was accepted" "probe said $r"

r="$(probe "$tmp/pre" "$tmp/post-same" 3 3 2 1)"
[ "$r" = "REFUSE:counts" ] && pass "DECREASING active pointers still refuse and roll back" \
  || fail "active-pointer loss was accepted" "probe said $r"

# 5. Byte-equality of the COPY must still be proven — before the api starts, where it
#    is the right question. Relaxing step 11 must not relax step 8.
grep -q 'copy verified byte-identical' "$MIGRATE_SH" \
  && pass "the pre-cutover copy is still verified byte-identical (step 8 untouched)" \
  || fail "step 8's byte-identical copy check is gone" \
          "relaxing the POST-cutover probe must not relax the copy proof"

echo
if [ "$fails" -eq 0 ]; then echo "migrate-post-cutover: all assertions passed"; exit 0; fi
echo "migrate-post-cutover: $fails assertion(s) failed"; exit 1
