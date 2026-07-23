#!/usr/bin/env bash
# =============================================================================
# install.sh — one command from a fresh checkout to a running, sign-in-ready
# Cloud Control Plane. It composes the pieces that already work; it invents
# nothing and never runs terraform or touches AWS.
#
#   1. scripts/setup.sh data + scripts/setup.sh env --host …   → the /data
#      persistent-disk layout ready, then .env (TOTP key + VITE_API_BASE + topology)
#   2. (optional) scripts/nginx-vhost.sh --host … --cert … --key …   → the HTTPS proxy
#   3. docker compose up -d --build    → build + start the app + api containers
#   4. first boot ONCE                 → seed the admin, print its one-time password
#   5. re-up with first-boot OFF       → the normal steady state
#
# The WordPress-style first-run, terminal edition. It is idempotent: run it again
# and, finding an initialized store, it just rebuilds/updates and prints the URLs —
# it never re-bootstraps over a live audit chain, and CCP_BOOTSTRAP=1 is only ever
# an ephemeral process env for step 4, never written into .env.
#
# Requires a persistent disk mounted at /data (the api's durable store binds
# /data/ccp/store — see docs/go-live.md → Prerequisites). Laptop/trial runs
# should use run-local.sh instead, not this script.
#
# Usage:
#   ccp/scripts/install.sh --host ccp.example.com
#   ccp/scripts/install.sh --host ccp.example.com --topology split --api-host api.ccp.example.com
#   ccp/scripts/install.sh --host ccp.example.com --name "Acme Cloud Control Plane"
#   sudo ccp/scripts/install.sh --host ccp.example.com --cert /etc/letsencrypt/live/…/fullchain.pem \
#                                  --key /etc/letsencrypt/live/…/privkey.pem   # also sets up nginx
#   FORCE=1 …   overwrite an existing .env (otherwise it is kept)
#
# --name NAME / --tagline TEXT (ADR-0023): the instance display name/tagline —
# forwarded verbatim to `setup.sh env`, which writes CCP_INSTANCE_NAME/
# CCP_INSTANCE_TAGLINE into .env (empty/omitted -> the generic default
# "Cloud Control Plane"). Renaming later never needs a redeploy — Admin ->
# Settings, or the first-run identity card, both write straight through the
# api with no rebuild.
#
# TLS is still terminated by the reverse proxy (nginx-vhost.sh, or your own) — the
# containers speak plain HTTP on loopback (127.0.0.1). AGENTS.md rules 1–2 hold:
# no terraform apply/destroy, no AWS writes.
# =============================================================================
set -uo pipefail

HOST="" API_HOST="" TOPOLOGY="same" CERT="" KEY="" NAME="" TAGLINE=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -t 1 ]; then C_CY=$'\033[1;36m'; C_GR=$'\033[1;32m'; C_YE=$'\033[1;33m'; C_RE=$'\033[1;31m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
else C_CY=""; C_GR=""; C_YE=""; C_RE=""; C_DIM=""; C_0=""; fi
say()  { printf '%s▸ %s%s\n' "$C_CY" "$*" "$C_0"; }
ok()   { printf '%s✓ %s%s\n' "$C_GR" "$*" "$C_0"; }
warn() { printf '%s! %s%s\n' "$C_YE" "$*" "$C_0"; }
die()  { printf '%s✗ %s%s\n' "$C_RE" "$*" "$C_0" >&2; exit 1; }
usage() { sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --api-host) API_HOST="${2:?}"; shift 2 ;;
    --topology) TOPOLOGY="${2:?}"; shift 2 ;;
    --cert) CERT="${2:?}"; shift 2 ;;
    --key) KEY="${2:?}"; shift 2 ;;
    --name) NAME="${2:?}"; shift 2 ;;
    --tagline) TAGLINE="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1  (see --help)" ;;
  esac
done
[ -n "$HOST" ] || die "--host is required (the portal's public FQDN, e.g. ccp.example.com)"
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker (scripts/setup.sh check reports it)"
docker compose version >/dev/null 2>&1 || die "'docker compose' v2 not found — needed for docker-compose.yml"
# Production path requires /data: without it, the compose bind would be
# auto-created root-owned by dockerd on first `up` and the api would 503.
[ -d /data ] || die "mount a persistent disk at /data — laptop trials: run-local.sh (see docs/go-live.md → Prerequisites)"

compose() { ( cd "$CCP_DIR" && docker compose "$@" ); }
api_port() { grep -E '^PORT=' "$CCP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]'; }
app_port() { grep -E '^APP_PORT=' "$CCP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]'; }
readyz_code() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/readyz" 2>/dev/null || echo 000; }
readyz_body() { curl -s "http://127.0.0.1:$1/readyz" 2>/dev/null || echo '{}'; }

# ---- 1. prepare /data + write .env (via setup.sh) ----------------------------
say "1/5  preparing /data + writing .env for ${HOST} (${TOPOLOGY}-origin)"
"$SCRIPT_DIR/setup.sh" data \
  || die "setup.sh data failed — see the message above (it names the exact sudo re-run if this needs root)"
env_args=( env --host "$HOST" --topology "$TOPOLOGY" )
[ -n "$API_HOST" ] && env_args+=( --api-host "$API_HOST" )
[ -n "$NAME" ] && env_args+=( --name "$NAME" )
[ -n "$TAGLINE" ] && env_args+=( --tagline "$TAGLINE" )
"$SCRIPT_DIR/setup.sh" "${env_args[@]}" || die "setup.sh env failed"
AP="$(api_port)"; AP="${AP:-8801}"
APPP="$(app_port)"; APPP="${APPP:-8800}"

# ---- 2. reverse proxy (optional) --------------------------------------------
if [ -n "$CERT" ] || [ -n "$KEY" ]; then
  [ -n "$CERT" ] && [ -n "$KEY" ] || die "--cert and --key must be given together"
  say "2/5  installing the nginx vhost for ${HOST}"
  vh=( --host "$HOST" --topology "$TOPOLOGY" --cert "$CERT" --key "$KEY" )
  [ -n "$API_HOST" ] && vh+=( --api-host "$API_HOST" )
  "$SCRIPT_DIR/nginx-vhost.sh" "${vh[@]}" || die "nginx-vhost.sh failed"
else
  say "2/5  skipping nginx (no --cert/--key) — put your own HTTPS proxy in front of :$APPP / :$AP"
fi

# ---- 3. build + start --------------------------------------------------------
say "3/5  building images + starting containers (docker compose up -d --build)"
compose up -d --build || die "docker compose up failed"

# ---- 4. initialize if the store is empty (idempotent) -----------------------
say "4/5  checking readiness on http://127.0.0.1:$AP/readyz"
already=0
for _ in $(seq 1 60); do
  code="$(readyz_code "$AP")"
  if [ "$code" = "200" ]; then already=1; break; fi
  # 503 = up but store empty/0 accounts (a fresh install) — stop waiting, go bootstrap
  echo "$(readyz_body "$AP")" | grep -q '"accounts":0' && break
  sleep 1
done

OTP=""
if [ "$already" = "1" ]; then
  ok "store already initialized — this is a rebuild/update, not a first install (no re-bootstrap)"
else
  say "      fresh store — running first-boot ONCE (CCP_BOOTSTRAP=1, ephemeral env only)"
  ( cd "$CCP_DIR" && CCP_BOOTSTRAP=1 docker compose up -d --build ) || die "first-boot up failed"
  ready=0
  for _ in $(seq 1 90); do
    [ "$(readyz_code "$AP")" = "200" ] && { ready=1; break; }
    sleep 1
  done
  if [ "$ready" != "1" ]; then compose logs --tail=40 api; die "/readyz never went green after first boot"; fi
  OTP="$(compose logs api 2>/dev/null | grep -oE 'one-time password: .*' | tail -1 | sed 's/one-time password: //' | tr -d '\r')"
  ok "admin seeded; /readyz is green"
  # ---- 5. turn first-boot OFF (recreate without the bootstrap env) ----------
  say "5/5  disabling first-boot (recreate with CCP_BOOTSTRAP unset)"
  compose up -d || warn "re-up without bootstrap failed — run 'docker compose up -d' in ccp/ to clear it"
fi
[ "$already" = "1" ] && say "5/5  (nothing to disable — was already initialized)"

# ---- done -------------------------------------------------------------------
cat <<EOF

${C_GR}✓ Cloud Control Plane is up${C_0}
   Sign in at:   ${C_CY}https://${HOST}${C_0}   (through your HTTPS proxy)
   Health:       http://127.0.0.1:${AP}/readyz  ·  app on http://127.0.0.1:${APPP}
EOF
if [ -n "$OTP" ]; then
  cat <<EOF
   ${C_YE}First admin — shown ONCE:${C_0}
     username:            putra
     one-time password:   ${OTP}
   Change it on first sign-in, then enrol 2FA in an authenticator app.
EOF
elif [ "$already" != "1" ]; then
  warn "couldn't parse the one-time password — read it from:  cd ccp && docker compose logs api | grep -A3 bootstrap"
fi
cat <<EOF
   Back up regularly — the one directory that matters:
     tar czf backup-\$(date +%Y%m%d).tar.gz -C /data ccp
   Bring the self-hosted CI runner online any time:
     cd ccp && docker compose --profile runner up -d --build runner
   Know the day-1 steps — see ${C_DIM}ccp/docs/go-live.md${C_0}.
EOF
