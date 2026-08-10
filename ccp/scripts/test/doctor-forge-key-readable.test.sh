#!/usr/bin/env bash
# =============================================================================
# Regression test for OPS-15 — doctor.sh never checked that a configured
# GitHub App private key is actually readable by the api container's user.
#
# CCP_GITHUB_APP_KEY_FILE is a CONTAINER path (read inside the api via
# readFileSync); the HOST file setup.sh/dockerd manages lives under
# CCP_GITHUB_APP_KEY_HOST_DIR (default /data/ccp/forge), same basename. A
# root-owned 0600 PEM dropped in by an operator used to fail only at claim
# time, per scan job, with no diagnostic surfacing WHY.
#
# This runs the ACTUAL shipped doctor.sh against a sandboxed CCP_DIR (so
# ENVF=<sandbox>/ccp/.env is read, never a real host's .env) with `docker`
# unavailable (skips the container section entirely, keeping this test
# focused) and asserts:
#
#   key file owned by root, mode 0600  -> FAIL, names uid 1000
#   key file owned by uid 1000         -> OK
#   key file missing on the host       -> FAIL, names the resolved host path
#   CCP_GITHUB_APP_KEY_FILE unset      -> no forge-key line at all (opt-in)
#
# Exit codes: 0 all assertions pass · 1 an assertion failed.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR_SH="$(cd "$SCRIPT_DIR/.." && pwd)/doctor.sh"
[ -f "$DOCTOR_SH" ] || { echo "cannot find doctor.sh at $DOCTOR_SH" >&2; exit 1; }

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; fails=$((fails + 1)); }

# $1 = .env body (may reference $FORGE_DIR, expanded by the caller)
run_doctor() {
  local env_body="$1" work; work="$(mktemp -d)"
  mkdir -p "$work/ccp/scripts" "$work/forge"
  cp "$DOCTOR_SH" "$work/ccp/scripts/doctor.sh"
  printf '%s\n' "$env_body" >"$work/ccp/.env"
  chmod 600 "$work/ccp/.env"

  # No `docker` on PATH at all -> "docker unavailable — skipping container
  # checks", isolating this test from OPS-13's concerns entirely. No `curl`
  # either -> "curl missing — skipping endpoint probes". Both warn, not FAIL.
  PATH="/usr/bin:/bin" bash "$work/ccp/scripts/doctor.sh" >"$work/out.log" 2>&1
  DOCTOR_RC=$?
  OUT="$(cat "$work/out.log")"
  WORKDIR="$work"
}

echo "OPS-15 — doctor.sh checks the GitHub App key is readable by uid 1000"

# --- root-owned, mode 0600 (the exact failure the finding describes) ---------
work="$(mktemp -d)"
mkdir -p "$work/forge"
printf 'fake pem\n' >"$work/forge/app.pem"
chmod 600 "$work/forge/app.pem"   # already root:root as this test runs as root
run_doctor "CCP_GITHUB_APP_KEY_FILE=/run/secrets/forge/app.pem
CCP_GITHUB_APP_KEY_HOST_DIR=$work/forge"
line="$(printf '%s\n' "$OUT" | grep 'GitHub App key')"
if printf '%s' "$line" | grep -q '✗' && printf '%s' "$line" | grep -q 'uid 1000'; then
  pass "a root-owned 0600 key fails loudly and names uid 1000 as the fix"
else
  fail "a root-owned 0600 key fails loudly and names uid 1000 as the fix" \
    "got: '$line'. Full output:
$OUT"
fi
if [ "$DOCTOR_RC" -eq 1 ]; then
  pass "doctor.sh exits 1 when the key is unreadable by uid 1000"
else
  fail "doctor.sh exits 1 when the key is unreadable by uid 1000" "exited $DOCTOR_RC"
fi
rm -rf "$work"

# --- owned by uid 1000 — the fixed state -------------------------------------
work="$(mktemp -d)"
mkdir -p "$work/forge"
printf 'fake pem\n' >"$work/forge/app.pem"
chown 1000:1000 "$work/forge/app.pem" 2>/dev/null
chmod 600 "$work/forge/app.pem"
run_doctor "CCP_GITHUB_APP_KEY_FILE=/run/secrets/forge/app.pem
CCP_GITHUB_APP_KEY_HOST_DIR=$work/forge"
line="$(printf '%s\n' "$OUT" | grep 'GitHub App key')"
if printf '%s' "$line" | grep -q '✓'; then
  pass "a uid-1000-owned key is reported OK"
else
  fail "a uid-1000-owned key is reported OK" "got: '$line'. Full output:
$OUT"
fi
rm -rf "$work"

# --- CCP_GITHUB_APP_KEY_FILE set, but the host file is simply missing --------
work="$(mktemp -d)"
mkdir -p "$work/forge"
run_doctor "CCP_GITHUB_APP_KEY_FILE=/run/secrets/forge/app.pem
CCP_GITHUB_APP_KEY_HOST_DIR=$work/forge"
if printf '%s\n' "$OUT" | grep -q "✗.*$work/forge/app.pem does not exist"; then
  pass "a missing host key file is reported, with the resolved host path"
else
  fail "a missing host key file is reported, with the resolved host path" "Full output:
$OUT"
fi
rm -rf "$work"

# --- opt-in: CCP_GITHUB_APP_KEY_FILE unset -> no forge-key line at all -------
run_doctor "CCP_BOOTSTRAP="
if ! printf '%s\n' "$OUT" | grep -q 'GitHub App key'; then
  pass "no CCP_GITHUB_APP_KEY_FILE -> no forge-key line (opt-in, not required)"
else
  fail "no CCP_GITHUB_APP_KEY_FILE -> no forge-key line (opt-in, not required)" "Full output:
$OUT"
fi

if [ "$fails" -eq 0 ]; then
  echo "doctor-forge-key-readable: PASS"
  exit 0
fi
echo "doctor-forge-key-readable: FAIL — $fails assertion(s)"
exit 1
