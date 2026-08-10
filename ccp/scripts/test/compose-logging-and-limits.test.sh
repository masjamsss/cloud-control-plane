#!/usr/bin/env bash
# =============================================================================
# Regression test for OPS-10 — no log rotation and no resource limits on any
# compose service.
#
# All services relied on Docker's default json-file logging driver with no
# max-size/max-file (container logs — the runner in particular relays entire CI
# job logs — could grow the host's /docker partition without bound), and no
# service had a memory ceiling (a spike in any one container could OOM the host
# that also holds the governance store).
#
# This checks the ACTUAL shipped docker-compose.yml (not a copy):
#   - a shared x-logging anchor exists with a json-file driver + both a
#     max-size and a max-file option
#   - EVERY service block references it (`logging: *default-logging`)
#   - api and runner (the two named in the finding's own recommendation) each
#     carry a mem_limit
#
# Then, best-effort (skipped if docker/compose isn't available here — this
# stays the source-of-truth check, docker-build.yml's `docker compose config`
# already covers the "does it actually resolve" half in CI): actually resolves
# the compose config and confirms the SAME facts survive real interpolation.
#
# Exit codes: 0 all assertions pass · 1 an assertion failed.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$CCP_DIR/docker-compose.yml"
[ -f "$COMPOSE_FILE" ] || { echo "cannot find docker-compose.yml at $COMPOSE_FILE" >&2; exit 1; }

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; fails=$((fails + 1)); }

# Prints the lines of one top-level `services:` entry (from "  <name>:" up to,
# but not including, the next 2-space-indented top-level key).
service_block() {
  awk -v svc="  $1:" '
    $0 == svc { found=1; print; next }
    found && /^  [A-Za-z_][A-Za-z0-9_]*:/ { found=0 }
    found { print }
  ' "$COMPOSE_FILE"
}

echo "OPS-10 — docker-compose.yml has log rotation and resource limits"

# --- shared logging anchor -----------------------------------------------------
ANCHOR="$(awk '/^x-logging:/{f=1} f{print} f && /max-file/{exit}' "$COMPOSE_FILE")"
if printf '%s' "$ANCHOR" | grep -q 'driver: json-file' \
   && printf '%s' "$ANCHOR" | grep -q 'max-size' \
   && printf '%s' "$ANCHOR" | grep -q 'max-file'; then
  pass "x-logging anchor defines a json-file driver with max-size and max-file"
else
  fail "x-logging anchor defines a json-file driver with max-size and max-file" \
    "got:
$ANCHOR"
fi

# --- every service references it -----------------------------------------------
for svc in api app runner scanner toolbox; do
  block="$(service_block "$svc")"
  if [ -z "$block" ]; then
    fail "service '$svc' exists in docker-compose.yml" "service_block() found nothing — has the file been restructured?"
    continue
  fi
  if printf '%s\n' "$block" | grep -q 'logging: \*default-logging'; then
    pass "service '$svc' has logging: *default-logging"
  else
    fail "service '$svc' has logging: *default-logging" "block was:
$block"
  fi
done

# --- api and runner have a memory ceiling ---------------------------------------
for svc in api runner; do
  block="$(service_block "$svc")"
  if printf '%s\n' "$block" | grep -q 'mem_limit:'; then
    pass "service '$svc' has a mem_limit"
  else
    fail "service '$svc' has a mem_limit" "block was:
$block"
  fi
done

# --- best-effort: real interpolation, mirroring docker-build.yml's own check ---
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  RESOLVED="$(cd "$CCP_DIR" && CCP_UPLOAD_TOKEN=not-a-real-secret CCP_TOTP_KEY=not-a-real-secret \
    VITE_API_BASE=http://localhost:8787 CCP_SCANNER_KEY=not-a-real-secret RUNNER_TOKEN=not-a-real-secret \
    docker compose --profile scanner --profile runner --profile toolbox config 2>&1)"
  RC=$?
  if [ "$RC" -eq 0 ]; then
    pass "docker compose config resolves cleanly with the new keys present"
  else
    fail "docker compose config resolves cleanly with the new keys present" "$RESOLVED"
  fi
  if printf '%s\n' "$RESOLVED" | grep -q 'max-size: 10m' \
     && printf '%s\n' "$RESOLVED" | grep -qE 'mem_limit: "?1073741824"?|mem_limit: "?1g"?'; then
    pass "resolved config: api's logging + mem_limit survive real interpolation"
  else
    fail "resolved config: api's logging + mem_limit survive real interpolation" "grep found neither in the resolved output"
  fi
else
  echo "  (docker/compose not available here — skipping the real-interpolation check; source-text checks above still ran)"
fi

if [ "$fails" -eq 0 ]; then
  echo "compose-logging-and-limits: PASS"
  exit 0
fi
echo "compose-logging-and-limits: FAIL — $fails assertion(s)"
exit 1
