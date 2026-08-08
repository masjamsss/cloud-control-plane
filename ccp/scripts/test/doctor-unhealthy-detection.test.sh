#!/usr/bin/env bash
# =============================================================================
# Regression test for OPS-13 — doctor.sh reporting an unhealthy container as OK.
#
# Docker reports an unhealthy container as `Up X minutes (unhealthy)` — a status
# STRING that still contains the substring "Up". The container classifier used a
# bare `case "$line" in *Up*)` pattern, so that status matched the healthy branch
# and printed a green checkmark; the aggregate FAIL flag was set only by `grep -qv
# Up` (any line NOT containing "Up"), which an unhealthy line does not trip either
# — so a wedged healthcheck was invisible to the one diagnostic operators are told
# to run, on both axes (per-line display AND the overall exit code).
#
# This runs the ACTUAL shipped doctor.sh (not a copy of just the logic) with
# `docker` stubbed to report one healthy and one unhealthy container, and asserts:
#
#   the unhealthy line prints with the FAIL marker (✗), not the OK marker (✓)
#   doctor.sh's own exit code is 1 (at least one FAIL)
#
# A second run with every container healthy asserts exit 0 — proving the fix
# doesn't just always fail (the over-tolerant-opposite mistake).
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

# Builds a sandbox: stub `docker` on PATH (no real Docker, no real /data touched —
# CCP_DIR is the sandbox's own ccp/, and doctor.sh's few literal /data checks are
# left to fall through to their (harmless, non-FAIL) "not present" warn branches on
# a host with no /data, which is true of the environment this test runs in).
run_doctor() {
  local up_lines="$1" work; work="$(mktemp -d)"
  mkdir -p "$work/bin" "$work/ccp/scripts"

  cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  info)   exit 0 ;;
  image)  exit 1 ;;   # ccp-toolbox:local "not built" -> warn, not FAIL
  volume) exit 1 ;;   # no legacy ccp_ccp-data volume -> silent
  compose)
    shift
    case "$*" in
      *--format*) cat "$STUB_UP_FILE" ;;   # the one call doctor.sh reads container status from
      *)          : ;;                      # every other compose ps/-q call: empty, harmless
    esac
    exit 0
    ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$work/bin/docker"

  # Stub `curl` too — a real curl on PATH would genuinely fail /healthz and
  # /readyz (nothing is listening), setting FAIL=1 for reasons that have
  # nothing to do with OPS-13 and swamping the exit-code assertion below.
  # Reporting everything else as healthy isolates the exit code to the
  # ONE thing this test varies: container status.
  cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *-w*)          printf '200' ;;
  *"/readyz"*)   printf '{"ready":true}' ;;
  *"/instance"*) printf '{"name":"stub"}' ;;
  *)             printf '' ;;
esac
exit 0
EOF
  chmod +x "$work/bin/curl"

  printf '%s\n' "$up_lines" >"$work/up.txt"
  cp "$DOCTOR_SH" "$work/ccp/scripts/doctor.sh"

  PATH="$work/bin:$PATH" STUB_UP_FILE="$work/up.txt" \
    bash "$work/ccp/scripts/doctor.sh" >"$work/out.log" 2>&1
  DOCTOR_RC=$?
  OUT="$(cat "$work/out.log")"
}

echo "OPS-13 — doctor.sh classifies an unhealthy container as a failure"

# --- one healthy, one unhealthy container -------------------------------------
run_doctor "$(printf 'api Up 10 minutes\nrunner Up 3 minutes (unhealthy)')"

unhealthy_line="$(printf '%s\n' "$OUT" | grep 'runner Up 3 minutes (unhealthy)')"
if printf '%s' "$unhealthy_line" | grep -q '✗'; then
  pass "unhealthy container line prints the FAIL marker (✗)"
else
  fail "unhealthy container line prints the FAIL marker (✗)" \
    "got: '$unhealthy_line' — this is the OPS-13 defect: *Up*) matches 'Up 3 minutes
     (unhealthy)' and green-lights it. Full output:
$OUT"
fi

healthy_line="$(printf '%s\n' "$OUT" | grep 'api Up 10 minutes')"
if printf '%s' "$healthy_line" | grep -q '✓'; then
  pass "the genuinely healthy container line still prints the OK marker (✓)"
else
  fail "the genuinely healthy container line still prints the OK marker (✓)" \
    "got: '$healthy_line' — the fix must not misclassify a healthy container either"
fi

if [ "$DOCTOR_RC" -eq 1 ]; then
  pass "doctor.sh exits 1 (FAIL) when a container is unhealthy"
else
  fail "doctor.sh exits 1 (FAIL) when a container is unhealthy" \
    "doctor.sh exited $DOCTOR_RC — an unhealthy container must not green-light the whole run.
     Full output:
$OUT"
fi

# --- baseline: every container healthy — must NOT fail on account of this check --
run_doctor "$(printf 'api Up 10 minutes\nrunner Up 3 minutes')"
if ! printf '%s\n' "$OUT" | grep -q 'container:.*✗'; then
  pass "an all-healthy container set prints no container FAIL lines"
else
  fail "an all-healthy container set prints no container FAIL lines" \
    "a healthy 'Up' status must not be misclassified as bad either. Output:
$OUT"
fi

if [ "$fails" -eq 0 ]; then
  echo "doctor-unhealthy-detection: PASS"
  exit 0
fi
echo "doctor-unhealthy-detection: FAIL — $fails assertion(s)"
exit 1
