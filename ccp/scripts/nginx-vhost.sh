#!/usr/bin/env bash
# =============================================================================
# nginx-vhost.sh — add ONE nginx server block (virtual host) that reverse-proxies
# the Cloud Control Plane web service, WITHOUT disturbing any other vhost/env
# already served by the same nginx.
#
# How it stays non-disruptive (by construction):
#   • ADDITIVE ONLY — it writes a brand-new vhost file (+ a sites-enabled symlink
#     on Debian layouts). It never edits nginx.conf or any existing vhost.
#   • COLLISION-GUARDED — it refuses if a vhost file for this name already exists,
#     or if the server_name is already served by another enabled vhost (--force
#     overrides). nginx only WARNS on a duplicate server_name, so this is the real gate.
#   • VALIDATE-THEN-ROLLBACK — after writing it runs `nginx -t`; if the full config
#     no longer validates, it REMOVES the file it just added and reloads nothing, so
#     the running config is exactly as it was.
#   • GRACEFUL RELOAD — `systemctl reload nginx` (or `nginx -s reload`), never a
#     restart, so existing sites and live connections are not dropped.
#
# TLS still terminates HERE and the app/api speak plain HTTP on loopback — the same
# posture ccp/docs/go-live.md documents. This script does NOT obtain certificates.
#
# Usage:
#   sudo ccp/scripts/nginx-vhost.sh --host ccp.example.com \
#        --cert /etc/letsencrypt/live/ccp.example.com/fullchain.pem \
#        --key  /etc/letsencrypt/live/ccp.example.com/privkey.pem
#
#   ccp/scripts/nginx-vhost.sh --host ccp.example.com --print   # dry-run to stdout
#
# Flags:
#   --host FQDN         server_name for the SPA (required)
#   --alias "names/ips"   extra server_name tokens for the SPA host, space-joined
#                          (e.g. --alias "192.168.1.50" or --alias "10.0.0.5 ccp")
#                          — so one vhost answers to a hostname AND a raw IP alike.
#   --topology same|split   same-origin (default: SPA at / and API at /api/ on one host)
#                           or split-origin (API on its own host — needs --api-host)
#   --api-host FQDN     server_name for the API (split topology only)
#   --app-port N        loopback port the SPA/static server listens on (default 8800)
#   --api-port N        loopback port the ccp-api listens on       (default 8801)
#   --cert PATH --key PATH   TLS cert + key (default: /etc/letsencrypt/live/<host>/…)
#   --no-tls            emit an HTTP-only vhost (for when an upstream LB terminates TLS)
#   --ipv6 | --no-ipv6  force IPv6 listen lines on/off (default: auto-detect the host)
#   --sites-dir DIR     override auto-detection of the nginx config dir
#   --file NAME         vhost filename (default <host>.conf)
#   --print             generate + print the vhost, write NOTHING, touch nothing
#   --no-reload         install + validate but do not reload nginx
#   --force             overwrite an existing vhost file / bypass the server_name guard
#   -h | --help
#
# Never runs as part of a normal `setup.sh` — bringing up nginx is a deliberate,
# root-level step. It touches only nginx config; no AWS, no terraform.
# =============================================================================
set -uo pipefail

HOST="" API_HOST="" ALIAS="" TOPOLOGY="same" APP_PORT="8800" API_PORT="8801"
CERT="" KEY="" NO_TLS=0 SITES_DIR="" FILE="" PRINT=0 RELOAD=1 FORCE=0 IPV6="auto"

if [ -t 1 ]; then C_CY=$'\033[1;36m'; C_GR=$'\033[1;32m'; C_YE=$'\033[1;33m'; C_RE=$'\033[1;31m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
else C_CY=""; C_GR=""; C_YE=""; C_RE=""; C_DIM=""; C_0=""; fi
say()  { printf '%s▸ %s%s\n' "$C_CY" "$*" "$C_0"; }
ok()   { printf '%s✓ %s%s\n' "$C_GR" "$*" "$C_0"; }
warn() { printf '%s! %s%s\n' "$C_YE" "$*" "$C_0"; }
die()  { printf '%s✗ %s%s\n' "$C_RE" "$*" "$C_0" >&2; exit 1; }
usage() { sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --alias) ALIAS="${2:?}"; shift 2 ;;
    --api-host) API_HOST="${2:?}"; shift 2 ;;
    --topology) TOPOLOGY="${2:?}"; shift 2 ;;
    --app-port) APP_PORT="${2:?}"; shift 2 ;;
    --api-port) API_PORT="${2:?}"; shift 2 ;;
    --cert) CERT="${2:?}"; shift 2 ;;
    --key) KEY="${2:?}"; shift 2 ;;
    --no-tls) NO_TLS=1; shift ;;
    --ipv6) IPV6=1; shift ;;
    --no-ipv6) IPV6=0; shift ;;
    --sites-dir) SITES_DIR="${2:?}"; shift 2 ;;
    --file) FILE="${2:?}"; shift 2 ;;
    --print) PRINT=1; shift ;;
    --no-reload) RELOAD=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1  (see --help)" ;;
  esac
done

# ---- validate inputs --------------------------------------------------------
[ -n "$HOST" ] || die "--host is required (the SPA's server_name, e.g. ccp.example.com)"
case "$TOPOLOGY" in same|split) ;; *) die "--topology must be 'same' or 'split'";; esac
[ "$TOPOLOGY" = "split" ] && [ -z "$API_HOST" ] && die "--topology split needs --api-host (the API's own FQDN)"
case "$APP_PORT$API_PORT" in *[!0-9]*) die "--app-port/--api-port must be numeric";; esac
[ -z "$CERT" ] && CERT="/etc/letsencrypt/live/${HOST}/fullchain.pem"
[ -z "$KEY"  ] && KEY="/etc/letsencrypt/live/${HOST}/privkey.pem"
[ -z "$FILE" ] && FILE="${HOST}.conf"
case "$FILE" in */*) die "--file must be a bare filename, not a path";; esac
# Auto-detect IPv6 so the vhost validates on IPv6-less hosts too (a hardcoded
# `listen [::]:…` fails nginx -t where IPv6 is absent). --ipv6/--no-ipv6 override.
if [ "$IPV6" = "auto" ]; then [ -e /proc/net/if_inet6 ] && IPV6=1 || IPV6=0; fi

# ---- emit one TLS-terminating (or --no-tls plain) server block --------------
listen_lines() { # $1=port  $2=1 for ssl
  # `listen … ssl http2` (not the newer `http2 on;` directive) so the vhost validates
  # on nginx 1.9.5–1.24 too; on 1.25.1+ it still works (deprecation warning only).
  local sfx=""; [ "${2:-0}" = "1" ] && sfx=" ssl http2"
  printf '    listen %s%s;\n' "$1" "$sfx"
  [ "$IPV6" = "1" ] && printf '    listen [::]:%s%s;\n' "$1" "$sfx"
}
# $1 = server_name, $2 = "root"(SPA, has /api/ when same-origin) | "api"(→ api only)
emit_server() {
  local name="$1" role="$2"
  # --alias tokens (extra names/IPs, space-joined) only apply to the primary
  # SPA/root host — a split-topology --api-host block stays exactly itself.
  local sn="$name"
  [ "$role" != "api" ] && [ -n "$ALIAS" ] && sn="$name $ALIAS"
  if [ "$NO_TLS" = "1" ]; then
    printf 'server {\n'; listen_lines 80; printf '    server_name %s;\n\n' "$sn"
  else
    # http:80 → redirect to https (a plain, self-contained redirect vhost)
    printf 'server {\n'; listen_lines 80
    printf '    server_name %s;\n    location / { return 301 https://$host$request_uri; }\n}\n\n' "$sn"
    printf 'server {\n'; listen_lines 443 1; printf '    server_name %s;\n\n' "$sn"
    printf '    ssl_certificate     %s;\n    ssl_certificate_key %s;\n\n' "$CERT" "$KEY"
  fi
  printf '    # generated by ccp/scripts/nginx-vhost.sh — safe to re-generate; do not hand-merge other vhosts here\n'
  if [ "$role" = "api" ]; then
    # split-origin API host: proxy the whole host to the api, preserve Origin for credentialed CORS
    printf '    location / {\n        proxy_pass http://127.0.0.1:%s;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-Proto https;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header Origin $http_origin;\n    }\n' "$API_PORT"
  else
    # SPA (static app container)
    printf '    location / {\n        proxy_pass http://127.0.0.1:%s;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-Proto https;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    }\n' "$APP_PORT"
    if [ "$TOPOLOGY" = "same" ]; then
      # same-origin: /api/ → the api, stripping the /api prefix (trailing slash on proxy_pass)
      printf '\n    # same-origin API: strip the /api prefix; preserve Origin so credentialed CORS works\n'
      printf '    location /api/ {\n        proxy_pass http://127.0.0.1:%s/;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-Proto https;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header Origin $http_origin;\n    }\n' "$API_PORT"
    fi
  fi
  printf '}\n'
}

build_vhost() {
  printf '# Cloud Control Plane reverse-proxy vhost — GENERATED by ccp/scripts/nginx-vhost.sh\n'
  printf '# Topology: %s. TLS terminates here; app/api speak plain HTTP on loopback.\n' "$TOPOLOGY"
  printf '# See ccp/docs/go-live.md. Regenerate rather than hand-editing.\n\n'
  emit_server "$HOST" "root"
  if [ "$TOPOLOGY" = "split" ]; then
    printf '\n'
    emit_server "$API_HOST" "api"
  fi
}

# ---- dry-run: print and exit, touching nothing ------------------------------
if [ "$PRINT" = "1" ]; then
  build_vhost
  exit 0
fi

# ---- real install: needs root + nginx ---------------------------------------
command -v nginx >/dev/null 2>&1 || die "nginx not found on PATH — install nginx first (or use --print to preview)"
[ "$(id -u)" = "0" ] || die "writing nginx config needs root — re-run with sudo (or use --print to preview)"

# Detect the config dir + whether it's the Debian sites-available/enabled layout.
DEBIAN=0
if [ -n "$SITES_DIR" ]; then
  TARGET_DIR="$SITES_DIR"
elif [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
  TARGET_DIR="/etc/nginx/sites-available"; DEBIAN=1
elif [ -d /etc/nginx/conf.d ]; then
  TARGET_DIR="/etc/nginx/conf.d"
else
  die "could not find an nginx config dir (sites-available or conf.d) — pass --sites-dir"
fi
TARGET="$TARGET_DIR/$FILE"
LINK="/etc/nginx/sites-enabled/$FILE"

# ---- collision guards: do not shadow another env ----------------------------
if [ -e "$TARGET" ] && [ "$FORCE" != "1" ]; then
  die "$TARGET already exists — refusing to overwrite. Use --force, or --file <name> to add a distinct vhost."
fi
# server_name already served elsewhere? nginx only warns on this, so we gate it here.
# -R (not -r) so the sites-enabled symlinks are followed to the real vhost files.
# Checked for --host AND every --alias token (an alias IP already claimed by
# another vhost would silently be shadowed otherwise).
check_collision() { # $1 = one server_name token (host or alias)
  local tok="$1" esc existing
  esc="${tok//./\\.}"
  existing="$(grep -RlE "server_name[[:space:]]+([^;]*[[:space:]])?${esc}([[:space:]]|;)" \
               /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -vxF "$TARGET" | grep -vxF "$LINK" || true)"
  if [ -n "$existing" ] && [ "$FORCE" != "1" ]; then
    die "server_name '$tok' is already served by: $existing — refusing to add a duplicate (that would shadow it). Use --force if intended."
  fi
}
check_collision "$HOST"
for a in $ALIAS; do check_collision "$a"; done

# ---- write the new file (+ enable on Debian) --------------------------------
say "writing vhost → $TARGET"
umask 022
build_vhost > "$TARGET" || die "failed to write $TARGET"
CREATED_LINK=0
if [ "$DEBIAN" = "1" ]; then
  if [ ! -e "$LINK" ]; then ln -s "$TARGET" "$LINK" && CREATED_LINK=1; fi
fi

# ---- validate the WHOLE config; roll back on any failure --------------------
say "validating with nginx -t (rolls back on failure — running config stays untouched)"
if ! nginx -t; then
  warn "nginx -t failed — removing the vhost just added and leaving nginx as it was"
  [ "$CREATED_LINK" = "1" ] && rm -f "$LINK"
  rm -f "$TARGET"
  die "aborted: config invalid (likely the cert/key path, or a conflict). Nothing was reloaded; other vhosts are untouched."
fi
ok "nginx -t passed — the added vhost is valid and other vhosts still parse"

# ---- graceful reload (never a restart) --------------------------------------
if [ "$RELOAD" = "1" ]; then
  say "reloading nginx gracefully (existing connections/vhosts preserved)"
  if command -v systemctl >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null; then ok "systemctl reload nginx"
  elif nginx -s reload; then ok "nginx -s reload"
  else die "reload failed — the vhost is written and valid; reload nginx manually to activate it"; fi
else
  warn "--no-reload: vhost written + validated but NOT active yet. Activate with: systemctl reload nginx"
fi

cat <<EOF

${C_GR}✓ vhost added without touching any other env${C_0}
   file:        $TARGET$([ "$DEBIAN" = "1" ] && echo "  (enabled via $LINK)")
   server_name: $HOST${ALIAS:+ $ALIAS}$([ "$TOPOLOGY" = "split" ] && echo " + $API_HOST")
   proxies:     https://$HOST/ → 127.0.0.1:$APP_PORT (SPA)$([ "$TOPOLOGY" = "same" ] && echo ", https://$HOST/api/ → 127.0.0.1:$API_PORT (API)")$([ "$TOPOLOGY" = "split" ] && echo ", https://$API_HOST/ → 127.0.0.1:$API_PORT (API)")${ALIAS:+ — the same block also answers on: $ALIAS}

 Next:
   • point DNS (A/AAAA) for $HOST$([ "$TOPOLOGY" = "split" ] && echo " and $API_HOST") at this host
   • ensure the cert exists: $CERT (e.g. certbot --nginx -d $HOST)
   • bring the app/api up (docker compose) and check: curl -sSf https://$HOST/api/readyz
   • set VITE_API_BASE + topology in ccp/.env to match — see ccp/docs/go-live.md
EOF
