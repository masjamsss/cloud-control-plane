#!/usr/bin/env bash
# =============================================================================
# run-local.sh — docker-free bring-up of the REAL (non-demo) Cloud Control Plane.
#
# Starts ccp-api on a TEMPORARY durable store (bootstrapping one admin) and
# builds + serves the SPA with VITE_API_BASE pointed at that api, so the app runs in
# REAL / authoritative mode — the same wiring as the Docker stack, minus the
# external TLS proxy. For a laptop trial or a CI smoke; NOT a production server.
#
#   scripts/run-local.sh          interactive: bring up, print the URLs + the one-time
#                                 admin password, and STAY UP (Ctrl-C stops). Uses a
#                                 DEV cookie posture so browser login works over http.
#
#   scripts/run-local.sh --smoke  automated proof: bring up in PRODUCTION posture (so
#                                 the fail-closed preflight is exercised for real),
#                                 assert /readyz == 200, that authorization is enforced,
#                                 that credentials are verified, that the bootstrap admin
#                                 can actually authenticate, and that the bundle was built
#                                 in api-mode, then tear down. Exit 0 = proven.
#
# Env overrides: API_PORT (default 8801), APP_PORT (default 8800).
# (CI-13: this line read "APP_PORT (default 4173)" while the code below has always
# defaulted to 8800 — a doc drift that sent readers to the wrong port.)
# =============================================================================
set -uo pipefail
set -m   # each background job gets its own process group, so cleanup can reap the tree

SMOKE=0
[ "${1:-}" = "--smoke" ] && SMOKE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$CCP_DIR/api"
APP_DIR="$CCP_DIR/app"
API_PORT="${API_PORT:-8801}"
APP_PORT="${APP_PORT:-8800}"
API_BASE="http://localhost:$API_PORT"
APP_BASE="http://localhost:$APP_PORT"

DATA_DIR=""
API_PID=""
APP_PID=""
cleanup() {
  for pid in "$APP_PID" "$API_PID"; do
    [ -n "$pid" ] && kill -- -"$pid" 2>/dev/null
  done
  wait 2>/dev/null
  [ -n "$DATA_DIR" ] && rm -rf "$DATA_DIR"
}
trap cleanup EXIT INT TERM

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node not found on PATH"
command -v curl >/dev/null || die "curl not found on PATH"

# A strong EPHEMERAL TOTP key — throwaway, local only. Never printed.
TOTP_KEY="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"

# ---- deps (frozen lockfiles) ------------------------------------------------
say "checking deps (npm ci if node_modules missing)"
[ -d "$API_DIR/node_modules" ] || ( cd "$API_DIR" && npm ci ) || die "api npm ci failed"
[ -d "$APP_DIR/node_modules" ] || ( cd "$APP_DIR" && npm ci ) || die "app npm ci failed"

# ---- build the SPA in REAL mode (VITE_API_BASE baked → authoritative HTTP client)
say "building the SPA with VITE_API_BASE=$API_BASE (real/authoritative mode)"
( cd "$APP_DIR" && VITE_API_BASE="$API_BASE" npm run build ) || die "app build failed"
# Prove the api base was INLINED into the bundle — i.e. this is NOT the mock build.
if grep -rq -- "$API_BASE" "$APP_DIR/dist/assets" 2>/dev/null; then
  ok "api base is baked into the bundle — real mode confirmed (not the demo/mock build)"
else
  die "VITE_API_BASE was not found in the built bundle — the app would run in MOCK mode"
fi

# ---- start the api on a temp durable store, bootstrapping an admin ----------
DATA_DIR="$(mktemp -d)"
say "starting ccp-api on $API_BASE (temp store: $DATA_DIR)"
if [ "$SMOKE" = "1" ]; then
  # PRODUCTION posture → the fail-closed preflight runs for real. /readyz is
  # unauthenticated, so Secure cookies do not impede the smoke.
  API_ENV=( "NODE_ENV=production" "CCP_SECURE_COOKIES=1" "CCP_SAME_ORIGIN=1" )
else
  # DEV posture → http-friendly cookies so a real browser login works on localhost.
  API_ENV=( "CCP_CORS_ORIGIN=$APP_BASE" )
fi
API_ENV+=( "PORT=$API_PORT" "CCP_DATA_DIR=$DATA_DIR" "CCP_TOTP_KEY=$TOTP_KEY" "CCP_BOOTSTRAP=1" )
( cd "$API_DIR" && exec env "${API_ENV[@]}" npm run start ) >"$DATA_DIR/api.log" 2>&1 &
API_PID=$!

# ---- wait for readiness (bootstrap seeds the admin → /readyz flips 503 → 200)
say "waiting for /readyz to go green"
READY=0
for _ in $(seq 1 60); do
  kill -0 "$API_PID" 2>/dev/null || { echo "--- api.log ---"; cat "$DATA_DIR/api.log"; die "api exited early"; }
  code="$(curl -s -o /dev/null -w '%{http_code}' "$API_BASE/readyz" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && { READY=1; break; }
  sleep 0.5
done
[ "$READY" = "1" ] || { echo "--- api.log ---"; cat "$DATA_DIR/api.log"; die "/readyz did not reach 200"; }
ok "/readyz answered 200"
printf '   '; curl -s "$API_BASE/readyz"; echo

# The one-time password bootstrap printed (interactive mode surfaces it below).
OTP="$(grep -oE 'one-time password: .*' "$DATA_DIR/api.log" | sed 's/one-time password: //' | head -1)"

# ---- CI-13: prove the portal FUNCTIONS, not just that it booted -------------
#
# What this smoke proved was: /readyz is 200, and the served bundle is not the mock.
# Both are real, and neither distinguishes "the control plane is up" from "a process
# is answering two health endpoints". A regression that broke every route except the
# health pair, or one that stopped verifying credentials entirely, smoked GREEN.
#
# WHAT IT SHOULD ASSERT — the design question the finding leaves open. The smoke's job
# is the install journey: a fresh checkout comes up as the REAL portal. Three properties
# are what make it a control plane rather than a web server, and all three are reachable
# without any estate, cloud credential, or fixture:
#
#   1. authorization is WIRED      — a protected read refuses an anonymous caller
#   2. credentials are VERIFIED    — a wrong password is refused, not rubber-stamped
#   3. the real credential path WORKS — the bootstrap admin can actually authenticate
#
# Exact status codes, never ranges: a 500 from a broken route must not read as a pass
# just because it isn't 200 (L-1's shape — "not the success code" is not "the refusal
# I asserted"). The finding also suggested `GET /catalog`; there is no such route in
# ccp/api/src — it is one of the phantom paths DOC-1 deleted from the contract for
# exactly that reason. `GET /requests` is the real project-scoped protected read.
api_code() { # api_code METHOD PATH [json-body]
  if [ -n "${3:-}" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X "$1" -H 'content-type: application/json' -d "$3" "$API_BASE$2" 2>/dev/null || echo 000
  else
    curl -s -o /dev/null -w '%{http_code}' -X "$1" "$API_BASE$2" 2>/dev/null || echo 000
  fi
}

code="$(api_code GET /requests)"
[ "$code" = "401" ] || die "GET /requests answered $code unauthenticated, expected 401 — the session guard is not enforcing"
ok "authorization is enforced (anonymous GET /requests → 401)"

code="$(api_code POST /auth/login '{"username":"putra","password":"definitely-not-the-otp"}')"
[ "$code" = "401" ] || die "login with a wrong password answered $code, expected 401 — credentials are not being verified"
ok "credentials are verified (wrong password → 401)"

[ -n "$OTP" ] || die "no bootstrap one-time password in api.log — cannot prove the credential path end to end"
LOGIN_BODY="$(curl -s -X POST -H 'content-type: application/json' \
  -d "{\"username\":\"putra\",\"password\":$(node -p 'JSON.stringify(process.argv[1])' "$OTP")}" \
  "$API_BASE/auth/login" 2>/dev/null || echo '')"
case "$LOGIN_BODY" in
  *'"mustChangePassword":true'*) ok "the bootstrap admin authenticates, and is held at the password gate" ;;
  *) echo "--- login response ---"; printf '%s\n' "$LOGIN_BODY"
     die "the bootstrap admin could not authenticate, or the first-run password gate is gone" ;;
esac

# ---- serve the SPA (vite preview provides the SPA deep-link fallback) --------
say "serving the SPA on $APP_BASE"
( cd "$APP_DIR" && exec npm run preview -- --port "$APP_PORT" --strictPort ) >"$DATA_DIR/app.log" 2>&1 &
APP_PID=$!
SERVED=0
for _ in $(seq 1 40); do
  kill -0 "$APP_PID" 2>/dev/null || { echo "--- app.log ---"; cat "$DATA_DIR/app.log"; die "app server exited early"; }
  code="$(curl -s -o /dev/null -w '%{http_code}' "$APP_BASE/" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && { SERVED=1; break; }
  sleep 0.25
done
[ "$SERVED" = "1" ] || { echo "--- app.log ---"; cat "$DATA_DIR/app.log"; die "app did not serve on $APP_BASE"; }
if curl -s "$APP_BASE/" | grep -q '<div id="root">'; then
  ok "SPA is served (index.html with #root) at $APP_BASE"
else
  die "the served page is not the SPA index.html"
fi

if [ "$SMOKE" = "1" ]; then
  echo
  ok "SMOKE PASSED — /readyz 200, authz enforced, credentials verified, bootstrap admin authenticates, SPA served in api-mode"
  exit 0
fi

# ---- interactive: leave it running ------------------------------------------
cat <<EOF

────────────────────────────────────────────────────────────────────────────
 Cloud Control Plane is up — REAL mode, docker-free (local http only; no TLS proxy)

   App:  $APP_BASE
   API:  $API_BASE   (health: /healthz, readiness: /readyz)

   Sign in as the bootstrap admin:
     username:            putra
     one-time password:   ${OTP:-<see $DATA_DIR/api.log>}
   Change the password on first sign-in, then enrol 2FA in an authenticator app.

 Throwaway store: $DATA_DIR   (deleted on exit)
 Press Ctrl-C to stop.
────────────────────────────────────────────────────────────────────────────
EOF
wait "$API_PID"
