#!/usr/bin/env bash
# =============================================================================
# intranet-setup.sh — the ONE command for an intranet-only Cloud Control
# Plane host: an interactive wizard that fixes "Failed to fetch" by wiring up
# a same-origin HTTPS deploy reachable by BOTH a hostname AND the raw IP, with
# a small self-signed Certificate Authority you trust once.
#
# Guided wizard by DEFAULT on a terminal — EVERY deploy parameter can be
# customized, starting with the hostname: it comes FIRST and is fully
# free-form (name it ANYTHING — ccp.local.com, ccp.corp.internal,
# portal.acme, ... — the suggestion is only a suggestion). IP and TLS follow,
# then a single "Customize advanced settings?" gate covers everything else
# (app/api ports, same-origin vs split-origin topology, the API base URL,
# cookie posture) — say no (the default) and every advanced value gets a safe
# smart default exactly like today; say yes and each becomes its own prompt
# with that same default pre-filled, so Enter always reproduces the default
# and typing replaces it. A full preview of EVERY chosen value is shown before
# touching anything. Give it ANY flag (or --yes, or a non-interactive
# stdin/stdout) and it runs fully flag-driven instead, with a smart default
# for whatever you didn't pass — no prompts, safe for automation. --print
# renders the same preview and exits — it touches NOTHING and does not need
# root.
#
# What it does, in order (see ccp/docs/go-live.md → "Intranet access"):
#   1. detect this host's intranet IP (ip route get 1; falls back to hostname -I)
#   2. add "<IP> <HOST>" to /etc/hosts (idempotent, self-healing on IP drift)
#   3. generate (or accept) TLS: a 10y self-signed root CA + a <=397d leaf
#      under /data/ccp/config/tls/, SAN = DNS:<HOST>, IP:<IP>, DNS:localhost,
#      IP:127.0.0.1 (+ DNS:<API_HOST> too, for split-origin topology) — so
#      nothing name-mismatches — OR use a certificate you already have — OR
#      plain http (not recommended)
#   4. scaffold ccp/.env (via setup.sh env — generates the TOTP key if
#      unset; never touches an existing one) and set: VITE_API_BASE (default
#      /api same-origin, or https://<api-host> split-origin — overridable,
#      with a WARNING if an override breaks same-origin), the topology pair
#      (CCP_SAME_ORIGIN / CCP_CORS_ORIGIN), cookie posture
#      (CCP_COOKIE_SAMESITE / CCP_SECURE_COOKIES — Secure empty for
#      plain-http), and the app/api ports (APP_PORT / PORT) — every one of
#      these is now a prompt with a smart default, not a silent derivation
#   5. bring the app up (rebuild — VITE_API_BASE is baked in at build time)
#      and refresh the api (picks up the new ports/topology/cookie env)
#   6. install the nginx vhost: nginx-vhost.sh --host <HOST> --alias <IP>
#      --app-port <APP_PORT> --api-port <API_PORT> (+ --topology split
#      --api-host <API_HOST> when split) — additive-only / nginx -t
#      validated / rolls back on failure, unchanged
#   7. print the access URLs + the exact CA-import steps per OS
#
# Re-runnable and idempotent: on a re-run it pre-fills from the existing
# cert/.env and only changes what you change. A stale /etc/hosts mapping for
# the same hostname is corrected (old line commented, not deleted, so nothing
# is silently lost); an existing leaf that already covers the requested
# host+IP(+api-host) is kept (--renew forces a fresh leaf — the
# already-imported root is untouched, so clients never need to re-import
# anything after a renewal).
#
# Usage:
#   sudo ccp/scripts/intranet-setup.sh                   # guided wizard (TTY)
#   sudo ccp/scripts/intranet-setup.sh --yes              # wizard's own defaults, no prompts
#   ccp/scripts/intranet-setup.sh --print                 # preview only — touches nothing, no root needed
#   sudo ccp/scripts/intranet-setup.sh --host ccp.local.com --ip 192.168.1.50 --tls self-signed --yes
#   sudo ccp/scripts/intranet-setup.sh --tls ca --ca-cert /path/fullchain.pem --ca-key /path/privkey.pem --yes
#   sudo ccp/scripts/intranet-setup.sh --topology split --api-host api.ccp.local.com --yes
#   sudo ccp/scripts/intranet-setup.sh --app-port 9800 --api-port 9801 --cookie-samesite Strict --yes
#   sudo ccp/scripts/intranet-setup.sh --renew --yes       # rotate the leaf only (root cert untouched)
#
# Flags (mirror the wizard's prompts; giving ANY one of these switches the
# whole run to flag-driven/non-interactive — unset ones still get a smart
# default, exactly like accepting the wizard's own suggestion would):
#   --host FQDN          intranet hostname — ANY name you like   (default:
#                         ccp.local.com, or the existing leaf's CN on a re-run)
#   --ip ADDR            override the auto-detected intranet IP
#   --tls MODE           self-signed | ca | http                 (default: self-signed)
#   --ca-cert PATH       with --tls ca: your certificate (PEM)
#   --ca-key PATH        with --tls ca: your private key (PEM)
#   --app-port N         loopback port the app/SPA listens on    (default: 8800,
#                         or the existing .env's APP_PORT on a re-run)
#   --api-port N         loopback port the api listens on        (default: 8801,
#                         or the existing .env's PORT on a re-run)
#   --topology same|split   same-origin (default), or split-origin (the api on
#                         its own hostname)
#   --api-host FQDN      the api's own hostname, for --topology split  (default:
#                         api.<HOST>, or derived from the existing .env's
#                         VITE_API_BASE on a re-run)
#   --api-base URL       VITE_API_BASE override (default DERIVED from topology:
#                         /api for same-origin, https://<api-host> for split — a
#                         same-origin override that isn't a relative /api path
#                         prints a WARNING; it is not blocked)
#   --cookie-samesite V  CCP_COOKIE_SAMESITE: Lax | Strict | None (default
#                         per topology: Lax same-origin, None split-origin)
#   --secure-cookies 0|1   CCP_SECURE_COOKIES (default: 1, empty for --tls http)
#   --name NAME           instance display name (ADR-0023), shown on the sign-in
#                         screen and everywhere in the app (default: the generic
#                         "Cloud Control Plane", or the existing .env's name on a re-run)
#   --tagline TEXT        optional one-line tagline
#   --renew              force a fresh leaf even if the existing one already covers host+IP
#   --yes                skip prompts, use flags/defaults, proceed without asking
#   --print              render the preview and exit — touches NOTHING, no root needed
#   -h | --help
#
# Needs root for the real run (writes /etc/hosts, /data/ccp/config/tls, and
# the nginx vhost) — --print never does. Never runs terraform or touches AWS;
# never emits `docker compose down -v` or `docker volume rm` (AGENTS.md rules).
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TLS_DIR="/data/ccp/config/tls"

# ---- pretty output (degrades on a non-TTY) ----------------------------------
if [ -t 1 ]; then C_CY=$'\033[1;36m'; C_GR=$'\033[1;32m'; C_YE=$'\033[1;33m'; C_RE=$'\033[1;31m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
else C_CY=""; C_GR=""; C_YE=""; C_RE=""; C_DIM=""; C_0=""; fi
say()  { printf '%s▸ %s%s\n' "$C_CY" "$*" "$C_0"; }
ok()   { printf '%s✓ %s%s\n' "$C_GR" "$*" "$C_0"; }
warn() { printf '%s! %s%s\n' "$C_YE" "$*" "$C_0"; }
err()  { printf '%s✗ %s%s\n' "$C_RE" "$*" "$C_0" >&2; }
die()  { err "$*"; exit 1; }
usage() { sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; }

TMP_FILES=()
cleanup() { [ "${#TMP_FILES[@]}" -eq 0 ] || rm -f "${TMP_FILES[@]}"; }
trap cleanup EXIT

# ---- small helpers -----------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

is_valid_ipv4() {
  local ip="${1:-}" o
  case "$ip" in ''|*[!0-9.]*) return 1 ;; esac
  local IFS=.; set -- $ip
  [ "$#" -eq 4 ] || return 1
  for o in "$1" "$2" "$3" "$4"; do
    case "$o" in ''|*[!0-9]*) return 1 ;; esac
    [ "$o" -le 255 ] || return 1
  done
  return 0
}

is_valid_port() { # $1=port -> 0 if a usable TCP port number (1-65535)
  case "${1:-}" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# A plain "<prompt> [<default>]: " read for the advanced-settings prompts below,
# printed to stderr so it is never swallowed by the $(...) that captures the
# answer — Enter keeps the default, exactly like the wizard's other prompts.
# $1=prompt text  $2=default (may be legitimately empty, e.g. Secure cookies off)
# $3=optional display label to show in place of an empty $2
prompt_default() {
  local ans disp="${2:-${3:-<empty>}}"
  printf '%s [%s]: ' "$1" "$disp" >&2
  read -r ans || ans=""
  printf '%s' "${ans:-$2}"
}

# P1: ip route get 1's src field, falling back to hostname -I's first token.
# Validated (not just extracted) so a routeless/odd `ip route get` output
# doesn't silently hand back a garbage "IP".
detect_ip() {
  local ip
  ip="$(ip route get 1 2>/dev/null | awk '{print $7; exit}')"
  is_valid_ipv4 "$ip" || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  is_valid_ipv4 "$ip" && printf '%s' "$ip" || printf ''
}

resolve_env_path() { readlink -f "$CCP_DIR/.env" 2>/dev/null || printf '%s' "$CCP_DIR/.env"; }

# Idempotent KEY=VALUE upsert into an existing file (create the line if
# missing, replace it in place if present). Used only for the small, fixed
# set of derived keys — never touches CCP_TOTP_KEY.
env_set() {
  local file="$1" key="$2" val="$3" tmp
  tmp="$(mktemp)"; TMP_FILES+=("$tmp")
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    awk -v k="$key" -v v="$val" '$0 ~ "^" k "=" { print k "=" v; next } { print }' "$file" > "$tmp"
  else
    cp "$file" "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  cat "$tmp" > "$file"
}

# Read a KEY=VALUE out of an existing file, for pre-filling advanced-setting
# defaults from a previous run (same idempotent spirit as env_set — a missing
# file or an unset/commented-out key just yields "", so callers fall back to a
# hardcoded smart default).
env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -1
}

# /etc/hosts: idempotent add of "<ip> <host>". A stale mapping for the same
# host (different IP) is commented out — never silently deleted — and a fresh
# correct line appended, so re-running after a DHCP/network change self-heals.
ensure_hosts_line() {
  local ip="$1" host="$2" hosts="/etc/hosts"
  local existing_ip
  existing_ip="$(awk -v h="$host" '
    /^[[:space:]]*#/ { next }
    { for (i=2; i<=NF; i++) if ($i == h) { print $1; exit } }
  ' "$hosts" 2>/dev/null)"
  if [ "$existing_ip" = "$ip" ]; then
    ok "/etc/hosts: ${ip} ${host} (already present)"
    return 0
  fi
  if [ -n "$existing_ip" ]; then
    warn "/etc/hosts: ${host} currently maps to ${existing_ip} — correcting to ${ip}"
    local tmp; tmp="$(mktemp)"; TMP_FILES+=("$tmp")
    awk -v h="$host" '
      { keep = 1
        if ($0 !~ /^[[:space:]]*#/) { for (i=2; i<=NF; i++) if ($i == h) { keep = 0; break } }
        if (keep) print; else print "# " $0 "  # superseded by ccp/scripts/intranet-setup.sh"
      }' "$hosts" > "$tmp"
    cat "$tmp" > "$hosts"
  fi
  printf '%s\t%s\t# added by ccp/scripts/intranet-setup.sh\n' "$ip" "$host" >> "$hosts"
  ok "/etc/hosts: appended '${ip} ${host}'"
}

# ---- TLS: mini-CA + leaf ------------------------------------------------------
# `openssl req -help` is queried directly for `-addext` support instead of
# parsing the version string — a capability probe is correct across OpenSSL
# AND LibreSSL/distro forks, where version numbering schemes differ.
have_addext() { openssl req -help 2>&1 | grep -q -- '-addext'; }

# One shared temp config covering BOTH the CA's extensions (v3_ca) and the
# leaf's (v3_req + alt_names) — used only on openssl builds without -addext.
# $3=extra (optional) — one more DNS SAN entry, e.g. the split-origin api host,
# folded into the SAME leaf so one cert covers the app host AND the api host.
gen_openssl_cnf() {
  local host="$1" ip="$2" extra="${3:-}" f
  f="$(mktemp)"; TMP_FILES+=("$f")
  {
    cat <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = CCP Intranet CA
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = ${host}
IP.1  = ${ip}
DNS.2 = localhost
IP.2  = 127.0.0.1
CNF
    [ -n "$extra" ] && printf 'DNS.3 = %s\n' "$extra"
  } > "$f"
  printf '%s' "$f"
}

# $1=ca_key $2=ca_crt $3=host $4=ip (host/ip only needed for the shared temp cnf)
gen_ca() {
  local key="$1" crt="$2" host="$3" ip="$4"
  if have_addext; then
    openssl req -x509 -newkey rsa:4096 -nodes -keyout "$key" -sha256 -days 3650 \
      -subj "/CN=CCP Intranet CA" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -out "$crt"
  else
    local cnf; cnf="$(gen_openssl_cnf "$host" "$ip")"
    openssl req -x509 -new -newkey rsa:4096 -nodes -keyout "$key" -sha256 -days 3650 \
      -subj "/CN=CCP Intranet CA" -config "$cnf" -extensions v3_ca -out "$crt"
  fi
}

# $1=ca_crt $2=ca_key $3=leaf_key $4=leaf_crt $5=host $6=ip $7=extra_san
# (optional — the split-origin api host; folded into the SAME leaf so one
# cert covers both the app host and the api host)
# Modern path co-signs in ONE step (req -x509 -CA, added alongside -addext in
# OpenSSL 1.1.1) — no CSR round-trip, so there is no risk of the classic
# "x509 -req silently drops the CSR's requested extensions" gotcha. The older
# path can't use -CA on `req`, so it goes CSR -> sign-with-extfile instead;
# `-extfile` on `x509 -req` has worked since long before 1.1.1, so the SAN
# lands correctly either way.
gen_leaf() {
  local ca_crt="$1" ca_key="$2" key="$3" crt="$4" host="$5" ip="$6" extra="${7:-}"
  local san="DNS:${host},IP:${ip},DNS:localhost,IP:127.0.0.1"
  [ -n "$extra" ] && san="${san},DNS:${extra}"
  if have_addext; then
    # NOTE: -CAcreateserial is an `x509` option, not a `req` one — `req -x509
    # -CA` assigns its own (random) serial with nothing extra needed.
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$key" -sha256 -days 397 \
      -subj "/CN=${host}" \
      -CA "$ca_crt" -CAkey "$ca_key" \
      -addext "subjectAltName=${san}" \
      -addext "basicConstraints=CA:FALSE" \
      -addext "extendedKeyUsage=serverAuth" \
      -out "$crt"
  else
    local cnf csr; cnf="$(gen_openssl_cnf "$host" "$ip" "$extra")"; csr="$(mktemp)"; TMP_FILES+=("$csr")
    openssl req -new -newkey rsa:2048 -nodes -keyout "$key" -subj "/CN=${host}" \
      -config "$cnf" -reqexts v3_req -out "$csr" \
      && openssl x509 -req -in "$csr" -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
           -out "$crt" -days 397 -sha256 -extfile "$cnf" -extensions v3_req
  fi
}

leaf_covers() { # $1=leaf_crt $2=host $3=ip $4=extra_san(optional) -> 0 if the
                # cert's SAN already has host+ip, and extra_san too when given
  local crt="$1" host="$2" ip="$3" extra="${4:-}" text
  text="$(openssl x509 -in "$crt" -noout -text 2>/dev/null)" || return 1
  printf '%s' "$text" | grep -q "DNS:${host}\b" || return 1
  printf '%s' "$text" | grep -q "IP Address:${ip}\b" || return 1
  [ -z "$extra" ] || printf '%s' "$text" | grep -q "DNS:${extra}\b"
}

# ---- flags --------------------------------------------------------------------
HOST_FLAG="" IP_FLAG="" TLS_FLAG="" CACERT_FLAG="" CAKEY_FLAG=""
APP_PORT_FLAG="" API_PORT_FLAG="" TOPOLOGY_FLAG="" API_HOST_FLAG="" API_BASE_FLAG=""
SAMESITE_FLAG="" SECURE_FLAG="" NAME_FLAG="" TAGLINE_FLAG=""
YES=0 PRINT=0 RENEW=0 ANY_FLAG_GIVEN=0
while [ "$#" -gt 0 ]; do
  ANY_FLAG_GIVEN=1
  case "$1" in
    --host) HOST_FLAG="${2:?--host needs a value}"; shift 2 ;;
    --ip) IP_FLAG="${2:?--ip needs a value}"; shift 2 ;;
    --tls) TLS_FLAG="${2:?--tls needs a value}"; shift 2 ;;
    --ca-cert) CACERT_FLAG="${2:?--ca-cert needs a value}"; shift 2 ;;
    --ca-key) CAKEY_FLAG="${2:?--ca-key needs a value}"; shift 2 ;;
    --app-port) APP_PORT_FLAG="${2:?--app-port needs a value}"; shift 2 ;;
    --api-port) API_PORT_FLAG="${2:?--api-port needs a value}"; shift 2 ;;
    --topology) TOPOLOGY_FLAG="${2:?--topology needs a value}"; shift 2 ;;
    --api-host) API_HOST_FLAG="${2:?--api-host needs a value}"; shift 2 ;;
    --api-base) API_BASE_FLAG="${2:?--api-base needs a value}"; shift 2 ;;
    --cookie-samesite) SAMESITE_FLAG="${2:?--cookie-samesite needs a value}"; shift 2 ;;
    --secure-cookies) SECURE_FLAG="${2:?--secure-cookies needs a value}"; shift 2 ;;
    --name) NAME_FLAG="${2:?--name needs a value}"; shift 2 ;;
    --tagline) TAGLINE_FLAG="${2:?--tagline needs a value}"; shift 2 ;;
    --renew) RENEW=1; shift ;;
    --yes) YES=1; shift ;;
    --print) PRINT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown argument: $1"; echo; usage; exit 2 ;;
  esac
done

INTERACTIVE=1
{ [ "$ANY_FLAG_GIVEN" = 1 ] || [ ! -t 0 ] || [ ! -t 1 ]; } && INTERACTIVE=0

# ---- smart defaults, pre-filled from a previous run when present -------------
DEFAULT_HOST="ccp.local.com"
if [ -f "$TLS_DIR/ccp.crt" ] && have openssl; then
  cn="$(openssl x509 -in "$TLS_DIR/ccp.crt" -noout -subject 2>/dev/null | sed -n 's/.*CN[ ]*=[ ]*//p')"
  [ -n "$cn" ] && DEFAULT_HOST="$cn"
fi
DETECTED_IP="$(detect_ip)"

REAL_ENV_GUESS="$(resolve_env_path)"
TOTP_STATUS="will be generated"
if [ -f "$REAL_ENV_GUESS" ] && grep -qE '^CCP_TOTP_KEY=.+' "$REAL_ENV_GUESS" 2>/dev/null \
   && ! grep -qE '^CCP_TOTP_KEY=(REPLACE|change-me)?$' "$REAL_ENV_GUESS" 2>/dev/null; then
  TOTP_STATUS="already set (kept)"
fi

# Advanced-setting defaults: pre-filled from an existing .env on a re-run
# (same idempotent spirit as DEFAULT_HOST above), else the smart out-of-the-box
# default. API base / cookie SameSite / Secure are deliberately NOT pre-filled
# from an old .env here — they are derived fresh below from whatever topology
# and TLS mode are chosen THIS run, so changing topology never leaves a stale,
# mismatched cookie setting in place.
EXIST_APP_PORT="$(env_get "$REAL_ENV_GUESS" APP_PORT)"
EXIST_API_PORT="$(env_get "$REAL_ENV_GUESS" PORT)"
EXIST_VITE_BASE="$(env_get "$REAL_ENV_GUESS" VITE_API_BASE)"
EXIST_SAME_ORIGIN="$(env_get "$REAL_ENV_GUESS" CCP_SAME_ORIGIN)"
EXIST_CORS_ORIGIN="$(env_get "$REAL_ENV_GUESS" CCP_CORS_ORIGIN)"
DEFAULT_APP_PORT="${EXIST_APP_PORT:-8800}"
DEFAULT_API_PORT="${EXIST_API_PORT:-8801}"
# ADR-0023 — instance identity: pre-filled from a previous run (same
# idempotent spirit as DEFAULT_HOST), else the generic default.
DEFAULT_INSTANCE_NAME="$(env_get "$REAL_ENV_GUESS" CCP_INSTANCE_NAME)"
DEFAULT_INSTANCE_NAME="${DEFAULT_INSTANCE_NAME:-Cloud Control Plane}"
DEFAULT_INSTANCE_TAGLINE="$(env_get "$REAL_ENV_GUESS" CCP_INSTANCE_TAGLINE)"
if [ "$EXIST_SAME_ORIGIN" = "1" ]; then DEFAULT_TOPOLOGY=same
elif [ -n "$EXIST_CORS_ORIGIN" ]; then DEFAULT_TOPOLOGY=split
else DEFAULT_TOPOLOGY=same
fi

# ---- P1/P2/P3: prompt on a TTY with no flags; otherwise flags + defaults -----
HOST="" IP="" TLS_MODE="" CA_CERT_PATH="" CA_KEY_PATH="" ADVANCED=0
APP_PORT="" API_PORT="" TOPOLOGY="" API_HOST="" API_BASE="" COOKIE_SAMESITE="" SECURE_COOKIES_VAL=""
INSTANCE_NAME="" INSTANCE_TAGLINE=""

if [ "$INTERACTIVE" = 1 ]; then
  printf '\n%s%s%s\n' "$C_CY" "── CCP intranet setup ──" "$C_0"

  printf 'Step 1/3 — hostname (the URL your team will type into a browser)\n'
  printf '  Name it ANYTHING — this is not fixed to any pattern, it is only a\n'
  printf '  suggestion below. Examples: ccp.local.com · ccp.corp.internal · portal.acme\n'
  HOST="$(prompt_default 'Hostname' "$DEFAULT_HOST")"

  printf '\n%s(ADR-0023) instance name — shown on the sign-in screen and everywhere in the app%s\n' "$C_DIM" "$C_0"
  INSTANCE_NAME="$(prompt_default 'Instance name' "$DEFAULT_INSTANCE_NAME")"
  # Tagline has no interactive prompt of its own (keeps the wizard to one new
  # question) — a re-run keeps whatever an earlier --tagline run set; use
  # --tagline to change it non-interactively.
  INSTANCE_TAGLINE="$DEFAULT_INSTANCE_TAGLINE"

  if [ -n "$DETECTED_IP" ]; then
    printf '\nStep 2/3 — intranet IP\nDetected: %s%s%s — correct? [Y/n, or type another IP]: ' "$C_GR" "$DETECTED_IP" "$C_0"
  else
    printf '\nStep 2/3 — intranet IP\nCould not auto-detect one. Enter it: '
  fi
  read -r ans || ans=""
  case "$ans" in
    ''|y|Y|yes|Yes) IP="$DETECTED_IP" ;;
    n|N|no|No) printf 'Enter the intranet IP: '; read -r IP || IP="" ;;
    *) IP="$ans" ;;
  esac
  is_valid_ipv4 "$IP" || die "not a usable IPv4 address: '${IP:-empty}'"

  printf '\nStep 3/3 — TLS\nself-signed mini-CA (generate) / provide CA cert / plain-http? [self-signed]: '
  read -r ans || ans=""
  case "$ans" in
    ''|s|self|self-signed) TLS_MODE=self-signed ;;
    c|ca) TLS_MODE=ca ;;
    h|http|plain-http) TLS_MODE=http ;;
    *) die "unrecognised TLS choice '$ans' (expected self-signed / ca / http)" ;;
  esac
  if [ "$TLS_MODE" = ca ]; then
    printf 'Path to the certificate (PEM): '; read -r CA_CERT_PATH || CA_CERT_PATH=""
    printf 'Path to the private key (PEM): '; read -r CA_KEY_PATH || CA_KEY_PATH=""
  fi

  printf '\n%sTOTP key:%s %s\n' "$C_DIM" "$C_0" "$TOTP_STATUS"

  printf '\nCustomize advanced settings — ports, topology, API base URL, cookie posture? [y/N]: '
  read -r ans || ans=""
  case "$ans" in y|Y|yes|Yes) ADVANCED=1 ;; *) ADVANCED=0 ;; esac
else
  IP="${IP_FLAG:-$DETECTED_IP}"
  is_valid_ipv4 "$IP" || die "could not determine a usable intranet IP (got '${IP:-empty}') — pass --ip <address>"
  HOST="${HOST_FLAG:-$DEFAULT_HOST}"
  TLS_MODE="${TLS_FLAG:-self-signed}"
  CA_CERT_PATH="$CACERT_FLAG"
  CA_KEY_PATH="$CAKEY_FLAG"
  INSTANCE_NAME="${NAME_FLAG:-$DEFAULT_INSTANCE_NAME}"
  INSTANCE_TAGLINE="${TAGLINE_FLAG:-$DEFAULT_INSTANCE_TAGLINE}"
fi

case "$TLS_MODE" in
  self-signed|ca|http) ;;
  *) die "--tls must be self-signed, ca, or http (got '$TLS_MODE')" ;;
esac
if [ "$TLS_MODE" = ca ]; then
  [ -n "$CA_CERT_PATH" ] && [ -n "$CA_KEY_PATH" ] || die "--tls ca needs --ca-cert PATH and --ca-key PATH"
  [ -f "$CA_CERT_PATH" ] || die "--ca-cert not found: $CA_CERT_PATH"
  [ -f "$CA_KEY_PATH" ]  || die "--ca-key not found: $CA_KEY_PATH"
fi
if [ "$TLS_MODE" = self-signed ]; then
  have openssl || die "openssl not found — required to generate the self-signed mini-CA (or pass --tls ca / --tls http)"
fi

# ---- advanced settings: ports, topology, API base, cookie posture -----------
# Interactive + "yes" to the gate above => one prompt each, the smart default
# pre-filled (Enter keeps it). Interactive+"no" (the common path), or fully
# flag-driven, resolves the very same defaults with zero prompts — so nothing
# gets harder and a bare --yes still produces a working config, as before.
default_api_host() { # $1=HOST -> "api.<HOST>", or a previous split-origin
                      # VITE_API_BASE's own host when an earlier run set one
                      # (re-run idempotency — same spirit as DEFAULT_HOST)
  local stripped="${EXIST_VITE_BASE#https://}"; stripped="${stripped#http://}"
  if [ -n "$stripped" ] && [ "$stripped" != "$EXIST_VITE_BASE" ]; then printf '%s' "$stripped"
  else printf 'api.%s' "$1"; fi
}
derive_api_base() { [ "$1" = split ] && printf 'https://%s' "$2" || printf '/api'; }  # $1=topology $2=api_host
derive_samesite() { [ "$1" = split ] && printf 'None' || printf 'Lax'; }             # $1=topology
derive_secure()   { [ "$1" = http ]  && printf ''     || printf '1'; }               # $1=tls_mode

if [ "$INTERACTIVE" = 1 ] && [ "$ADVANCED" = 1 ]; then
  printf '\n%s%s%s\n' "$C_CY" "── advanced settings ──" "$C_0"

  APP_PORT="$(prompt_default 'App port (loopback, published to your reverse proxy)' "$DEFAULT_APP_PORT")"
  API_PORT="$(prompt_default 'API port (loopback, published to your reverse proxy)' "$DEFAULT_API_PORT")"

  printf 'Topology — same-origin (one host serves the app AND /api/*) or split-origin\n(the api on its own hostname)? [%s]: ' "$DEFAULT_TOPOLOGY"
  read -r ans || ans=""
  case "$ans" in
    '') TOPOLOGY="$DEFAULT_TOPOLOGY" ;;
    same|s) TOPOLOGY=same ;;
    split|sp) TOPOLOGY=split ;;
    *) die "unrecognised topology '$ans' (expected same or split)" ;;
  esac

  if [ "$TOPOLOGY" = split ]; then
    API_HOST="$(prompt_default 'API hostname (split-origin — its own name, separate from the app)' "$(default_api_host "$HOST")")"
  fi

  API_BASE="$(prompt_default 'API base URL the BROWSER will use (VITE_API_BASE)' "$(derive_api_base "$TOPOLOGY" "$API_HOST")")"
  COOKIE_SAMESITE="$(prompt_default 'Cookie SameSite (CCP_COOKIE_SAMESITE)' "$(derive_samesite "$TOPOLOGY")")"
  SECURE_COOKIES_VAL="$(prompt_default 'Secure cookies (CCP_SECURE_COOKIES)' "$(derive_secure "$TLS_MODE")" '<empty — off, plain-http only>')"
else
  APP_PORT="${APP_PORT_FLAG:-$DEFAULT_APP_PORT}"
  API_PORT="${API_PORT_FLAG:-$DEFAULT_API_PORT}"
  TOPOLOGY="${TOPOLOGY_FLAG:-$DEFAULT_TOPOLOGY}"

  [ "$TOPOLOGY" = split ] && API_HOST="${API_HOST_FLAG:-$(default_api_host "$HOST")}"

  API_BASE="${API_BASE_FLAG:-$(derive_api_base "$TOPOLOGY" "$API_HOST")}"
  COOKIE_SAMESITE="${SAMESITE_FLAG:-$(derive_samesite "$TOPOLOGY")}"
  if [ -n "$SECURE_FLAG" ]; then
    case "$SECURE_FLAG" in 0|off|false|no) SECURE_COOKIES_VAL="" ;; *) SECURE_COOKIES_VAL="1" ;; esac
  else
    SECURE_COOKIES_VAL="$(derive_secure "$TLS_MODE")"
  fi
fi

# ---- shared validation for the advanced settings (both paths converge here) --
is_valid_port "$APP_PORT" || die "app port must be a number 1-65535 (got '$APP_PORT')"
is_valid_port "$API_PORT" || die "api port must be a number 1-65535 (got '$API_PORT')"
[ "$APP_PORT" != "$API_PORT" ] || die "the app port and api port must differ (both are '$APP_PORT')"
case "$TOPOLOGY" in same|split) ;; *) die "topology must be 'same' or 'split' (got '$TOPOLOGY')" ;; esac
if [ "$TOPOLOGY" = split ]; then
  [ -n "$API_HOST" ] || die "split topology needs an API hostname (--api-host, or answer the prompt)"
fi
case "$COOKIE_SAMESITE" in
  [Ll]ax) COOKIE_SAMESITE=Lax ;;
  [Ss]trict) COOKIE_SAMESITE=Strict ;;
  [Nn]one) COOKIE_SAMESITE=None ;;
  *) die "cookie SameSite must be Lax, Strict, or None (got '$COOKIE_SAMESITE')" ;;
esac

# The classic "Failed to fetch" trap: an absolute or mismatched API base under
# same-origin topology pins the browser's api calls to ONE host, so loading the
# page via the OTHER name (the hostname vs the raw IP, or a re-run under a new
# hostname) becomes cross-origin and fails. Warn loudly; do not block — an
# operator with, say, a rewriting proxy in front may want exactly this.
if [ "$TOPOLOGY" = same ]; then
  case "$API_BASE" in
    /api|/api/) : ;;
    /*) warn "VITE_API_BASE='$API_BASE' is a relative path, but the nginx vhost this installer writes only proxies /api/ same-origin — the api would 404 under this path. Use /api (the default), or switch to --topology split." ;;
    *) warn "VITE_API_BASE='$API_BASE' is an ABSOLUTE URL under same-origin topology — the browser's api calls will be pinned to that ONE host. Loading the page via the OTHER name (the hostname vs the raw IP) becomes cross-origin and fails with 'Failed to fetch' — the exact trap this installer exists to avoid. A relative path (/api, the default) is what lets one build serve every name this host answers to." ;;
  esac
fi
if [ "$COOKIE_SAMESITE" = None ] && [ -z "$SECURE_COOKIES_VAL" ]; then
  warn "CCP_COOKIE_SAMESITE=None with CCP_SECURE_COOKIES empty — browsers silently reject a SameSite=None cookie without Secure, and the api's production preflight refuses to boot on this combination. Use --tls self-signed/ca (or --secure-cookies 1) to fix it."
fi
if [ "$TLS_MODE" = http ] && [ -n "$SECURE_COOKIES_VAL" ]; then
  warn "CCP_SECURE_COOKIES is ON but --tls http has no TLS — browsers never send a Secure cookie back over plain http, so sign-in would silently fail. Use --secure-cookies 0 (the default for --tls http), or turn TLS on."
fi

# ---- P5/P6: preview (always shown; --print stops here, nothing mutated) -----
render_preview() {
  printf '\n%s%s%s\n' "$C_CY" "── preview — nothing has changed yet ──" "$C_0"
  printf '  instance name:   %s%s   (ADR-0023 — shown on the sign-in screen and everywhere in the app; rename anytime later under Admin -> Settings)\n' "$INSTANCE_NAME" "$([ -n "$INSTANCE_TAGLINE" ] && printf ' — %s' "$INSTANCE_TAGLINE")"
  printf '  hostname:        %s   (free-form — this can be ANYTHING; nothing is fixed)\n' "$HOST"
  printf '  /etc/hosts:      %s  %s   (idempotent add/correct — never duplicated)\n' "$IP" "$HOST"
  case "$TLS_MODE" in
    self-signed)
      printf '  TLS:             generate a mini-CA + leaf under %s\n' "$TLS_DIR"
      printf '                   SAN: DNS:%s, IP:%s, DNS:localhost, IP:127.0.0.1%s\n' "$HOST" "$IP" "$([ "$TOPOLOGY" = split ] && printf ', DNS:%s' "$API_HOST")"
      printf '                   root: %s/ca.crt   (10y — import into clients ONCE)\n' "$TLS_DIR"
      printf '                   leaf: %s/ccp.crt (397d, renewable with --renew)\n' "$TLS_DIR"
      ;;
    ca)
      printf '  TLS:             use the certificate you provided\n'
      printf '                   cert: %s\n' "$CA_CERT_PATH"
      printf '                   key:  %s\n' "$CA_KEY_PATH"
      ;;
    http)
      printf '  TLS:             %sNONE — plain http:// only (not recommended)%s\n' "$C_YE" "$C_0"
      ;;
  esac
  printf '  topology:        %s-origin%s\n' "$TOPOLOGY" "$([ "$TOPOLOGY" = split ] && printf ' (api host: %s)' "$API_HOST")"
  printf '  ports:           app=%s  api=%s   (loopback, published to your reverse proxy)\n' "$APP_PORT" "$API_PORT"
  printf '  .env (derived):  VITE_API_BASE=%s\n' "$API_BASE"
  printf '                   CCP_SAME_ORIGIN=%s\n' "$([ "$TOPOLOGY" = same ] && printf 1)"
  printf '                   CCP_CORS_ORIGIN=%s\n' "$([ "$TOPOLOGY" = split ] && printf 'https://%s' "$HOST" || printf '(empty)')"
  printf '                   CCP_COOKIE_SAMESITE=%s\n' "$COOKIE_SAMESITE"
  printf '                   CCP_SECURE_COOKIES=%s%s\n' "${SECURE_COOKIES_VAL:-<empty>}" "$([ -z "$SECURE_COOKIES_VAL" ] && printf ' — no Secure cookie; only safe when the browser never reaches this over plain http' || true)"
  printf '                   APP_PORT=%s\n' "$APP_PORT"
  printf '                   PORT=%s   (the api'"'"'s port)\n' "$API_PORT"
  printf '  TOTP key:        %s\n' "$TOTP_STATUS"
  if [ "$TOPOLOGY" = split ]; then
    printf '  nginx vhost:     server_name %s %s;  +  server_name %s;  (nginx-vhost.sh --alias/--topology split, additive/validated/rollback-safe)\n' "$HOST" "$IP" "$API_HOST"
  else
    printf '  nginx vhost:     server_name %s %s;  (nginx-vhost.sh --alias, additive/validated/rollback-safe)\n' "$HOST" "$IP"
  fi
  printf '  containers:      docker compose up -d --build app  (+ refresh api)   (in %s)\n' "$CCP_DIR"
  echo
}
render_preview

if [ "$PRINT" = 1 ]; then
  ok "preview only (--print) — nothing was changed"
  exit 0
fi

if [ "$INTERACTIVE" = 1 ]; then
  printf 'Proceed? [Y/n]: '
  read -r ans || ans=""
  case "$ans" in n|N|no|No) echo "Aborted — nothing was changed."; exit 0 ;; esac
fi

[ "$(id -u)" = 0 ] || die "writing /etc/hosts, /data/ccp/config, and the nginx vhost needs root — re-run with sudo (or preview first with --print)"
have docker || die "docker not found — see: ccp/scripts/setup.sh check"

# ---- execute ------------------------------------------------------------------
say "1/6  preparing /data/ccp/config"
"$SCRIPT_DIR/setup.sh" data \
  || die "setup.sh data failed — mount a persistent disk at /data first (see ccp/docs/go-live.md → Prerequisites)"

say "2/6  /etc/hosts"
ensure_hosts_line "$IP" "$HOST"

say "3/6  TLS ($TLS_MODE)"
VHOST_CERT="" VHOST_KEY=""
case "$TLS_MODE" in
  self-signed)
    mkdir -p "$TLS_DIR" || die "cannot create $TLS_DIR"
    CA_KEY_F="$TLS_DIR/ca.key" CA_CRT_F="$TLS_DIR/ca.crt"
    LEAF_KEY_F="$TLS_DIR/ccp.key" LEAF_CRT_F="$TLS_DIR/ccp.crt"
    if [ -f "$CA_KEY_F" ] && [ -f "$CA_CRT_F" ]; then
      ok "mini-CA already present — keeping it ($CA_CRT_F)"
    else
      say "   generating the mini-CA (10y root)"
      gen_ca "$CA_KEY_F" "$CA_CRT_F" "$HOST" "$IP" || die "CA generation failed"
      chmod 600 "$CA_KEY_F"; chmod 644 "$CA_CRT_F"
    fi
    if [ "$RENEW" != 1 ] && [ -f "$LEAF_CRT_F" ] && [ -f "$LEAF_KEY_F" ] && leaf_covers "$LEAF_CRT_F" "$HOST" "$IP" "$API_HOST"; then
      ok "leaf cert already covers ${HOST} + ${IP}$([ "$TOPOLOGY" = split ] && printf ' + %s' "$API_HOST") — keeping it (--renew to force a fresh one)"
    else
      say "   generating the leaf cert (397d) for ${HOST} + ${IP}$([ "$TOPOLOGY" = split ] && printf ' + %s' "$API_HOST")"
      gen_leaf "$CA_CRT_F" "$CA_KEY_F" "$LEAF_KEY_F" "$LEAF_CRT_F" "$HOST" "$IP" "$API_HOST" || die "leaf generation failed"
    fi
    chmod 600 "$LEAF_KEY_F"; chmod 644 "$LEAF_CRT_F"
    OWNER="${SUDO_USER:-$(id -un)}"
    chown "$OWNER" "$CA_KEY_F" "$CA_CRT_F" "$LEAF_KEY_F" "$LEAF_CRT_F" 2>/dev/null || true
    VHOST_CERT="$LEAF_CRT_F"; VHOST_KEY="$LEAF_KEY_F"
    ok "TLS ready: $LEAF_CRT_F"
    ;;
  ca)
    VHOST_CERT="$CA_CERT_PATH"; VHOST_KEY="$CA_KEY_PATH"
    ok "using the provided certificate"
    ;;
  http)
    warn "no TLS — plain http only; sign-in cookies will not be Secure"
    ;;
esac

say "4/6  .env"
"$SCRIPT_DIR/setup.sh" env < /dev/null || die "setup.sh env failed"
REAL_ENV="$(resolve_env_path)"
[ -f "$REAL_ENV" ] || die "expected $REAL_ENV after setup.sh env"
env_set "$REAL_ENV" VITE_API_BASE "$API_BASE"
env_set "$REAL_ENV" CCP_SAME_ORIGIN "$([ "$TOPOLOGY" = same ] && printf 1)"
env_set "$REAL_ENV" CCP_CORS_ORIGIN "$([ "$TOPOLOGY" = split ] && printf 'https://%s' "$HOST")"
env_set "$REAL_ENV" CCP_COOKIE_SAMESITE "$COOKIE_SAMESITE"
env_set "$REAL_ENV" CCP_SECURE_COOKIES "$SECURE_COOKIES_VAL"
env_set "$REAL_ENV" APP_PORT "$APP_PORT"
env_set "$REAL_ENV" PORT "$API_PORT"
env_set "$REAL_ENV" CCP_INSTANCE_NAME "$INSTANCE_NAME"
env_set "$REAL_ENV" CCP_INSTANCE_TAGLINE "$INSTANCE_TAGLINE"
chmod 600 "$REAL_ENV" 2>/dev/null || true
ok "$REAL_ENV: instance=\"$INSTANCE_NAME\", VITE_API_BASE=$API_BASE, ${TOPOLOGY}-origin, SameSite=$COOKIE_SAMESITE, Secure=${SECURE_COOKIES_VAL:-<empty>}, ports app=$APP_PORT api=$API_PORT"

say "5/6  app: rebuild (bakes in VITE_API_BASE) · api: refresh (picks up ports/topology/cookies)"
( cd "$CCP_DIR" && docker compose up -d --build app ) || die "docker compose up failed (app)"
( cd "$CCP_DIR" && docker compose up -d api )         || die "docker compose up failed (api)"

say "6/6  nginx vhost"
VHOST_ARGS=(--host "$HOST" --alias "$IP" --app-port "$APP_PORT" --api-port "$API_PORT" --force)
[ "$TOPOLOGY" = split ] && VHOST_ARGS+=(--topology split --api-host "$API_HOST")
if [ "$TLS_MODE" = http ]; then VHOST_ARGS+=(--no-tls)
else VHOST_ARGS+=(--cert "$VHOST_CERT" --key "$VHOST_KEY")
fi
"$SCRIPT_DIR/nginx-vhost.sh" "${VHOST_ARGS[@]}" || die "nginx-vhost.sh failed"

# ---- done -----------------------------------------------------------------
cat <<SUMMARY

${C_GR}✓ intranet access is wired up${C_0}
   https://${HOST}          (needs the /etc/hosts line — or intranet DNS — on each client)
   https://${IP}            (works from anywhere on the intranet, no extra client setup)
SUMMARY

if [ "$TOPOLOGY" = split ]; then
  cat <<SPLITSUMMARY
   https://${API_HOST}      (the api, split-origin — needs its own /etc/hosts/DNS entry
                              on each client too; it is a separate name from ${HOST})
SPLITSUMMARY
fi

if [ "$TLS_MODE" = self-signed ]; then
  cat <<TRUST

   ${C_YE}Browsers will warn until each client trusts the root — once:${C_0}
     root cert:  ${TLS_DIR}/ca.crt
     Linux:      sudo cp ca.crt /usr/local/share/ca-certificates/ccp-intranet.crt && sudo update-ca-certificates
     macOS:      Keychain Access → File → Import Items → ca.crt → double-click it → Trust → Always Trust (SSL)
     Windows:    double-click ca.crt → Install Certificate → Local Machine → Trusted Root Certification Authorities
     Firefox:    Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import
   Renewing the leaf later (--renew) never needs re-importing the root.
TRUST
fi

cat <<NEXT

   Other machines on this intranet: add the same '${IP}  ${HOST}' line to their own
   /etc/hosts (or your intranet DNS) to use the hostname — the raw IP always works
   with no client setup at all.
   Check it:  ccp/scripts/doctor.sh --host ${HOST}
NEXT
