#!/usr/bin/env bash
# =============================================================================
# Regression test for OPS-15 — the GitHub App key directory was never prepared
# by any tooling.
#
# docker-compose.yml bind-mounts ${CCP_GITHUB_APP_KEY_HOST_DIR:-/data/ccp/forge}
# read-only into the api container, but `setup.sh data`'s layout list omitted it
# — dockerd auto-creates it root:root on the first `up` instead, so a key the
# operator drops in later inherits whatever ownership/mode they happened to use,
# undetected until the first scan job's claim fails with an opaque credential
# error.
#
# This runs the ACTUAL shipped setup.sh (`setup.sh data`) as root against a REAL
# (but disposable) /data — same convention as install-bootstrap-decision.test.sh,
# which already establishes that do_data()'s hardcoded /data paths cannot be
# sandboxed into a temp dir — and asserts /data/ccp/forge ends up 1000:1000 700,
# alongside the pre-existing store/config/update/scratch/runner rows.
#
# Exit codes: 0 all assertions pass (or a clean SKIP) · 1 an assertion failed.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SH="$(cd "$SCRIPT_DIR/.." && pwd)/setup.sh"
[ -f "$SETUP_SH" ] || { echo "cannot find setup.sh at $SETUP_SH" >&2; exit 1; }

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; fails=$((fails + 1)); }

# do_data() needs root to chown, and operates on the literal /data path (not
# relocatable) — same prerequisite the OPS-1 bootstrap-decision test already
# established. Skip cleanly rather than fail when neither is available.
if [ "$(id -u)" != "0" ]; then
  echo "setup-forge-layout: SKIP — do_data() needs root to chown /data/ccp/*"
  exit 0
fi
CREATED_DATA=0
if [ ! -d /data ]; then
  mkdir -p /data || { echo "setup-forge-layout: SKIP — /data is absent and not creatable here" >&2; exit 0; }
  CREATED_DATA=1
fi
cleanup() { [ "$CREATED_DATA" = "1" ] && rm -rf /data; }
trap cleanup EXIT

echo "OPS-15 — setup.sh data prepares the GitHub App key directory"

OUT="$(bash "$SETUP_SH" data 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "setup.sh data exits 0"
else
  fail "setup.sh data exits 0" "exited $RC. Output:
$OUT"
fi

if [ -d /data/ccp/forge ]; then
  pass "/data/ccp/forge was created"
else
  fail "/data/ccp/forge was created" \
    "the directory does not exist after 'setup.sh data' — this is the OPS-15 defect:
     the layout list never mentioned it, so dockerd would auto-create it root:root
     on the first \`up\` instead. Output:
$OUT"
fi

if [ -d /data/ccp/forge ]; then
  UID_GOT="$(stat -c %u /data/ccp/forge 2>/dev/null || stat -f %u /data/ccp/forge 2>/dev/null)"
  GID_GOT="$(stat -c %g /data/ccp/forge 2>/dev/null || stat -f %g /data/ccp/forge 2>/dev/null)"
  MODE_GOT="$(stat -c %a /data/ccp/forge 2>/dev/null || stat -f %Lp /data/ccp/forge 2>/dev/null)"
  if [ "$UID_GOT" = "1000" ] && [ "$GID_GOT" = "1000" ] && [ "$MODE_GOT" = "700" ]; then
    pass "/data/ccp/forge is 1000:1000 700 (uid-1000-readable, matching the api container's user)"
  else
    fail "/data/ccp/forge is 1000:1000 700" \
      "got ${UID_GOT:-?}:${GID_GOT:-?} ${MODE_GOT:-?} — a root-owned dir (dockerd's
       auto-create default) is NOT readable by the api container's uid 1000"
  fi
fi

# idempotency: a second run must be a clean no-op (doc'd "check-first" contract).
OUT2="$(bash "$SETUP_SH" data 2>&1)"; RC2=$?
if [ "$RC2" -eq 0 ] && printf '%s\n' "$OUT2" | grep -q 'GitHub App key dir:.*already'; then
  pass "re-running setup.sh data is a no-op for the forge dir"
else
  fail "re-running setup.sh data is a no-op for the forge dir" "Output:
$OUT2"
fi

if [ "$fails" -eq 0 ]; then
  echo "setup-forge-layout: PASS"
  exit 0
fi
echo "setup-forge-layout: FAIL — $fails assertion(s)"
exit 1
