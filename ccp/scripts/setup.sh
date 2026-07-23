#!/usr/bin/env bash
# =============================================================================
# setup.sh — get a fresh checkout ready to run the Cloud Control Plane web
# service (the ccp-api backend + the ccp-app SPA) and its dependencies.
#
# This is the ONE step before you run anything. It does five things, in order:
#   1. check     — verify every CCP toolchain is present (Node/Go/Python/Docker/
#                  Terraform), with an install hint for anything missing or too old.
#   2. install   — `npm ci` for api + app, and `go build ./...` for catalogctl.
#   3. data      — production hosts only: prepare the /data persistent-disk layout
#                  (store/config/update/scratch/runner — owners+modes per
#                  docs/go-live.md → the /data layout). Silently skipped when /data
#                  doesn't exist (the laptop/trial flow is unaffected).
#   4. env       — scaffold ccp/.env from .env.example with a freshly generated
#                  CCP_TOTP_KEY, so no secret placeholder is left in place. When
#                  /data/ccp/config is writable, the real file is written there
#                  and ccp/.env becomes a symlink to it (an existing plain-file
#                  .env is relocated there too, content untouched).
#   5. terraform — install the pinned Terraform CLI (the estate + plan-check use it).
# Then it prints how to actually run the service (trial / dev / production).
#
# Usage (run from anywhere; paths resolve to this repo):
#   ccp/scripts/setup.sh            check + install + data + env + terraform (full)
#   ccp/scripts/setup.sh check      prerequisites report only
#   ccp/scripts/setup.sh install    dependencies only (npm ci + go build)
#   ccp/scripts/setup.sh data       prepare the /data persistent-disk layout (needs root)
#   ccp/scripts/setup.sh env        scaffold ccp/.env only
#   ccp/scripts/setup.sh terraform  install the pinned Terraform CLI on this server
#   ccp/scripts/setup.sh --help
#
# Flags (for `env` and the full run — derive .env from a hostname, no hand-editing):
#   --host FQDN            sets VITE_API_BASE + the topology block for that host
#   --topology same|split  same-origin (default) or split-origin (needs --api-host)
#   --api-host FQDN        the API's own host, for --topology split
#   --name NAME             instance display name (ADR-0023) — sets CCP_INSTANCE_NAME;
#                           empty/omitted -> the generic default "Cloud Control Plane"
#   --tagline TEXT          optional one-line tagline — sets CCP_INSTANCE_TAGLINE
#
# Env knobs:
#   FORCE=1            re-run npm ci and overwrite an existing .env (content only —
#                      relocating a plain .env into /data is never gated on FORCE)
#   SKIP_TERRAFORM=1   skip the Terraform install during the full setup
#   TF_VERSION=x.y.z   Terraform to install (default 1.15.7 — matches CI's pin)
#   TF_INSTALL_DIR=…   where the terraform binary lands (default: /usr/local/bin
#                      if writable, else ~/.local/bin)
#
# It is idempotent: existing node_modules, an existing .env, an already-correct
# /data tree, and an already-pinned Terraform are kept unless FORCE=1 (FORCE never
# gates the /data layout or the .env relocation — only content regeneration). It
# NEVER touches AWS and NEVER runs 'terraform apply'/'destroy' (AGENTS.md hard
# rules 1–2) — it installs the Terraform CLI but only ever runs read-only
# 'terraform version'.
# =============================================================================
set -uo pipefail

# The mode is the first NON-flag argument (default: all). Any --flags that follow
# (or that come first, implying `all`) configure the run — e.g. `env --host H`.
MODE="all"
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then MODE="$1"; shift
elif [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then MODE="$1"; shift; fi
ENV_HOST="" ENV_API_HOST="" ENV_TOPOLOGY="same" ENV_NAME="" ENV_TAGLINE=""
FORCE="${FORCE:-0}"
# Terraform pin: 1.15.7 matches CI (.github/workflows/terraform.yml TF_VERSION) and
# satisfies environments/prod's required_version ~> 1.10. Override via TF_VERSION.
TF_VERSION="${TF_VERSION:-1.15.7}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CCP_DIR/.." && pwd)"
API_DIR="$CCP_DIR/api"
APP_DIR="$CCP_DIR/app"
CATALOGCTL_DIR="$REPO_ROOT/tools/catalogctl"

# ---- pretty output (degrades on a non-TTY) ----------------------------------
if [ -t 1 ]; then C_CY=$'\033[1;36m'; C_GR=$'\033[1;32m'; C_YE=$'\033[1;33m'; C_RE=$'\033[1;31m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
else C_CY=""; C_GR=""; C_YE=""; C_RE=""; C_DIM=""; C_0=""; fi
say()  { printf '%s▸ %s%s\n' "$C_CY" "$*" "$C_0"; }
ok()   { printf '%s✓ %s%s\n' "$C_GR" "$*" "$C_0"; }
warn() { printf '%s! %s%s\n' "$C_YE" "$*" "$C_0"; }
err()  { printf '%s✗ %s%s\n' "$C_RE" "$*" "$C_0" >&2; }

REPORT=""          # accumulated prerequisite rows, printed as a summary table
REQUIRED_MISSING=0 # >0 ⇒ cannot install/run until fixed
STEP_FAIL=0        # >0 ⇒ an install/env step failed

row() { # $1=status(OK|WARN|FAIL|OPT) $2=tool $3=detail
  local badge
  case "$1" in
    OK)   badge="${C_GR}✓ ok  ${C_0}" ;;
    WARN) badge="${C_YE}! warn${C_0}" ;;
    FAIL) badge="${C_RE}✗ fail${C_0}" ;;
    OPT)  badge="${C_DIM}· opt ${C_0}" ;;
  esac
  REPORT+="  ${badge}  $(printf '%-10s' "$2")  $3"$'\n'
}

have()      { command -v "$1" >/dev/null 2>&1; }
node_major(){ node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
py_ge_310() { python3 -c 'import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)' 2>/dev/null; }
tf_have_ver(){ have terraform && terraform version 2>/dev/null | head -1 | sed -n 's/^Terraform v\([0-9.]*\).*/\1/p'; }
tf_ok_pin() { # $1=x.y.z — satisfies ~> 1.10 (major 1, minor >= 10)?
  local M mn; M="${1%%.*}"; mn="${1#*.}"; mn="${mn%%.*}"
  [ "${M:-0}" = "1" ] && [ "${mn:-0}" -ge 10 ] 2>/dev/null
}

# ---- 1. check ---------------------------------------------------------------
check_prereqs() {
  say "checking CCP toolchains"

  # Node + npm — REQUIRED. app engines>=20, api engines>=22 ⇒ Node 22 runs both.
  if have node && have npm; then
    local nmaj; nmaj="$(node_major)"
    if   [ -z "$nmaj" ];        then row FAIL node "installed but version unreadable"; REQUIRED_MISSING=1
    elif [ "$nmaj" -ge 22 ]; then row OK   node "$(node --version) — runs api (>=22) and app (>=20)"
    elif [ "$nmaj" -ge 20 ]; then row WARN node "$(node --version) — ok for the app (>=20); the api needs Node >=22"
    else row FAIL node "$(node --version) — too old; api needs >=22, app needs >=20"; REQUIRED_MISSING=1; fi
    row OK npm "$(npm --version)"
  else
    row FAIL node "not found — REQUIRED. Install Node 22: nvm install 22  (or fnm/asdf/brew)"
    REQUIRED_MISSING=1
  fi

  # Go — recommended: catalogctl is the only thing that writes Terraform.
  if have go; then
    row OK go "$(go version 2>/dev/null | awk '{print $3}') — catalogctl (the Terraform writer)"
  else
    row WARN go "not found — needed to build catalogctl. Install Go 1.25: https://go.dev/dl"
  fi

  # Python 3.10+ — recommended: (re)builds the portal inventory for a new estate.
  if have python3; then
    if py_ge_310; then row OK python3 "$(python3 --version 2>&1 | awk '{print $2}') — inventory build (build-inventory.py)"
    else row WARN python3 "$(python3 --version 2>&1 | awk '{print $2}') — need >=3.10 for the inventory scripts"; fi
  else
    row WARN python3 "not found — needed only to (re)generate the portal inventory. Install Python 3.10+"
  fi

  # Docker + compose — recommended: the one-command containerized bring-up.
  if have docker; then
    if docker compose version >/dev/null 2>&1; then
      row OK docker "$(docker --version | awk '{print $3}' | tr -d ,) + compose — containerized bring-up (docker compose up)"
    else
      row WARN docker "present but 'docker compose' v2 plugin missing — needed for docker-compose.yml"
    fi
  else
    row OPT docker "not found — only needed for the containerized/production bring-up (docker-compose.yml)"
  fi

  # openssl — used to mint the TOTP key; node crypto is the fallback, so optional.
  if have openssl; then row OK openssl "$(openssl version 2>/dev/null | awk '{print $1,$2}') — TOTP key generation"
  else row OPT openssl "not found — TOTP key will be generated via Node crypto instead"; fi

  # curl — recommended: the /healthz + /readyz checks in run-local.sh & go-live.
  if have curl; then row OK curl "$(curl --version 2>/dev/null | head -1 | awk '{print $2}') — health/readiness checks"
  else row OPT curl "not found — used by the /readyz smoke checks, not by the service itself"; fi

  # terraform — the estate + catalogctl plan-check pin. The portal runs without it,
  # but this server also plans against the estate, so setup installs it. It is never
  # run with 'apply'/'destroy' here — that happens only in CI (AGENTS.md rule 1).
  local tfv; tfv="$(tf_have_ver)"
  if   [ -z "$tfv" ];              then row WARN terraform "not found — 'scripts/setup.sh terraform' installs the pinned $TF_VERSION"
  elif [ "$tfv" = "$TF_VERSION" ]; then row OK   terraform "$tfv — matches CI's pin"
  elif tf_ok_pin "$tfv";           then row WARN terraform "$tfv — satisfies ~> 1.10 but CI pins $TF_VERSION ('scripts/setup.sh terraform' aligns it)"
  else                                  row WARN terraform "$tfv — does NOT satisfy ~> 1.10; install $TF_VERSION via 'scripts/setup.sh terraform'"
  fi

  # /data — the persistent-disk layout (store/config/update/scratch/runner). Not
  # needed for run-local.sh trials; a production docker deploy needs it (setup.sh
  # data). Informational only here — 'data'/'all' modes do the real check-first work.
  if [ -d /data ]; then
    local davail; davail="$(df -Pk /data 2>/dev/null | awk 'NR==2{print int($4/1024)}')"
    row OPT data "present — ${davail:-?}MB free (persistent disk for the docker deploy)"
  else
    row OPT data "not present — fine for run-local.sh trials; a production docker deploy needs a persistent disk mounted at /data"
  fi

  printf '\n%s── prerequisites ──%s\n%s' "$C_CY" "$C_0" "$REPORT"
  if [ "$REQUIRED_MISSING" -ne 0 ]; then
    err "a REQUIRED toolchain is missing — install it (hint above) and re-run"
    return 1
  fi
  ok "required toolchains present"
}

# ---- 2. install -------------------------------------------------------------
npm_ci() { # $1=dir $2=label
  local dir="$1" label="$2"
  if [ ! -f "$dir/package.json" ]; then warn "$label: no package.json at $dir — skipping"; return 0; fi
  if [ -d "$dir/node_modules" ] && [ "$FORCE" != "1" ]; then
    ok "$label: node_modules present — skipping (FORCE=1 to reinstall)"; return 0
  fi
  say "$label: npm ci"
  if ( cd "$dir" && npm ci ); then ok "$label: dependencies installed"
  else err "$label: npm ci failed"; STEP_FAIL=1; fi
}

build_catalogctl() {
  if ! have go; then warn "catalogctl: Go not installed — skipping build (install Go 1.25 to enable it)"; return 0; fi
  if [ ! -f "$CATALOGCTL_DIR/go.mod" ]; then warn "catalogctl: not found at $CATALOGCTL_DIR — skipping"; return 0; fi
  say "catalogctl: go build ./..."
  if ( cd "$CATALOGCTL_DIR" && go build ./... ); then ok "catalogctl: builds cleanly"
  else err "catalogctl: go build failed"; STEP_FAIL=1; fi
}

do_install() {
  if ! have node || ! have npm; then err "cannot install: Node + npm are required (run 'check')"; STEP_FAIL=1; return 1; fi
  npm_ci "$API_DIR" "ccp-api"
  npm_ci "$APP_DIR" "ccp-app"
  build_catalogctl
}

# ---- 3. data (the /data persistent-disk layout — production hosts only) -----
# Owners/modes exactly per docs/go-live.md's /data layout table:
#   /data/ccp             root:root      755   the one backup parent
#   /data/ccp/store       1000:1000      700   api durable store (node user in the image)
#   /data/ccp/config      <deploy user>  750   holds ccp.env (the real .env)
#   /data/ccp/update      root:root      750   self-update state + pre-update tars
#   /data/scratch            1000:1000      700   armed-lane TMPDIR pass-through
#   /data/runner             1001:1001      750   CI runner dist + registration state
# Check-first: each path is left alone when already correct, so re-running this
# is a no-op on a healthy host. chown to an arbitrary uid/gid needs root; when a
# path isn't already correct and we aren't root, this refuses with the exact
# re-run rather than silently doing nothing.
ensure_owned() { # $1=path $2=uid $3=gid $4=mode $5=label — returns 0 ok, 1 fail, 2 needs-root
  local path="$1" uid="$2" gid="$3" mode="$4" label="$5"
  if [ -d "$path" ]; then
    local cur_uid cur_gid cur_mode
    cur_uid="$(stat -c %u "$path" 2>/dev/null || stat -f %u "$path" 2>/dev/null)"
    cur_gid="$(stat -c %g "$path" 2>/dev/null || stat -f %g "$path" 2>/dev/null)"
    cur_mode="$(stat -c %a "$path" 2>/dev/null || stat -f %Lp "$path" 2>/dev/null)"
    if [ "$cur_uid" = "$uid" ] && [ "$cur_gid" = "$gid" ] && [ "$cur_mode" = "$mode" ]; then
      ok "$label: $path already ${uid}:${gid} ${mode}"; return 0
    fi
  fi
  if [ "$(id -u)" != "0" ]; then return 2; fi
  mkdir -p "$path" && chown "$uid:$gid" "$path" && chmod "$mode" "$path" \
    && { ok "$label: $path set to ${uid}:${gid} ${mode}"; return 0; } \
    || { err "$label: failed to prepare $path"; return 1; }
}

do_data() { # $1 = "all" when invoked from the full run (laptop hosts skip silently)
  local ctx="${1:-direct}"
  if [ ! -d /data ]; then
    if [ "$ctx" = "all" ]; then
      warn "/data not present — skipping the persistent-disk layout (laptop/trial flow unaffected)"
      warn "for a production deploy: mount a persistent disk at /data (see docs/go-live.md → Prerequisites), then: sudo ccp/scripts/setup.sh data"
      return 0
    fi
    err "/data does not exist — mount a persistent disk at /data (see docs/go-live.md → Prerequisites)"
    STEP_FAIL=1; return 1
  fi

  say "preparing the /data layout"
  local deploy_user deploy_uid deploy_gid
  deploy_user="${SUDO_USER:-$(id -un)}"
  deploy_uid="$(id -u "$deploy_user" 2>/dev/null)"; deploy_gid="$(id -g "$deploy_user" 2>/dev/null)"
  if [ -z "$deploy_uid" ] || [ -z "$deploy_gid" ]; then deploy_uid=0; deploy_gid=0; fi

  local need_root=0 data_fail=0 rc
  ensure_owned /data/ccp        0            0            755 "backup parent";      rc=$?; [ "$rc" = 2 ] && need_root=1; [ "$rc" = 1 ] && data_fail=1
  ensure_owned /data/ccp/store  1000         1000         700 "api durable store";  rc=$?; [ "$rc" = 2 ] && need_root=1; [ "$rc" = 1 ] && data_fail=1
  ensure_owned /data/ccp/config "$deploy_uid" "$deploy_gid" 750 "env config";        rc=$?; [ "$rc" = 2 ] && need_root=1; [ "$rc" = 1 ] && data_fail=1
  ensure_owned /data/ccp/update 0            0            750 "self-update state";  rc=$?; [ "$rc" = 2 ] && need_root=1; [ "$rc" = 1 ] && data_fail=1
  ensure_owned /data/scratch       1000         1000         700 "armed-lane scratch"; rc=$?; [ "$rc" = 2 ] && need_root=1; [ "$rc" = 1 ] && data_fail=1
  ensure_owned /data/runner        1001         1001         750 "CI runner state";    rc=$?; [ "$rc" = 2 ] && need_root=1; [ "$rc" = 1 ] && data_fail=1

  if [ "$need_root" = "1" ]; then
    err "root is required to create/chown the /data/ccp tree — re-run: sudo ccp/scripts/setup.sh data"
    STEP_FAIL=1; return 1
  fi
  if [ "$data_fail" = "1" ]; then STEP_FAIL=1; return 1; fi
  ok "/data layout ready"
}

# ---- 4. env -----------------------------------------------------------------
gen_totp_key() {
  if have openssl; then openssl rand -base64 48
  elif have node;  then node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
  else return 1; fi
}

do_env() {
  local example="$CCP_DIR/.env.example" link="$CCP_DIR/.env"
  if [ ! -f "$example" ]; then err "missing $example — cannot scaffold .env"; STEP_FAIL=1; return 1; fi
  local deploy_user="${SUDO_USER:-$(id -un)}"

  # When /data/ccp/config is writable, the REAL file lives there and
  # ccp/.env becomes a symlink to it (the one durable secret — CCP_TOTP_KEY
  # — must live under the /data backup parent). No /data/ccp/config ⇒ exactly
  # today's behavior: $link IS the real file.
  local data_cfg="/data/ccp/config" real="$link" use_data=0
  if [ -d "$data_cfg" ] && [ -w "$data_cfg" ]; then
    use_data=1
    real="$data_cfg/ccp.env"
    # Relocate an existing plain-file .env into /data — content untouched, and
    # this is NOT gated on FORCE (FORCE only ever means "regenerate content").
    if [ -f "$link" ] && [ ! -L "$link" ]; then
      if [ -e "$real" ]; then
        warn "$real already exists — leaving $link's content as-is (FORCE=1 regenerates $real instead); reconcile the two by hand, then re-run"
      else
        say "relocating existing $link → $real (content unchanged)"
        if mv "$link" "$real"; then
          chown "$deploy_user" "$real" 2>/dev/null || true
          chmod 600 "$real" 2>/dev/null || true
          ok "relocated .env into /data/ccp/config"
        else
          err "failed to relocate $link → $real"; STEP_FAIL=1; return 1
        fi
      fi
    fi
  elif [ -d "$data_cfg" ]; then
    warn "$data_cfg exists but is not writable — falling back to a plain $link (run: sudo ccp/scripts/setup.sh data)"
  fi

  if [ -e "$real" ] && [ "$FORCE" != "1" ]; then
    ok "$(basename "$real") already exists — keeping it (FORCE=1 to overwrite)"
  else
    say "scaffolding $real with a generated CCP_TOTP_KEY"
    local key; key="$(gen_totp_key)" || { err "could not generate a TOTP key (need openssl or node)"; STEP_FAIL=1; return 1; }
    # ADR-0023 — the instance name/tagline: --name/--tagline win outright;
    # otherwise a bare TTY with NO --host either (the SAME gate the
    # VITE_API_BASE prompt below uses — a --host call, e.g. from install.sh,
    # is already flag-driven end to end and must stay non-interactive) offers
    # one optional prompt, Enter keeping the generic default. Resolved BEFORE
    # the vite/topology block below so both prompts read in the natural order.
    local name="$ENV_NAME" tagline="$ENV_TAGLINE"
    if [ -z "$name" ] && [ -z "$ENV_HOST" ] && [ -t 0 ] && [ -t 1 ]; then
      printf '%s' "  Instance name — shown on the sign-in screen and everywhere in the app.
  Enter for the generic default [Cloud Control Plane]: "
      local namereply; read -r namereply || namereply=""
      name="$namereply"
    fi
    # With --host, also derive VITE_API_BASE + the topology block per .env.example's
    # A/B shapes, so no line is left to hand-edit (the last typo-prone step).
    local vite="" same="" cors="" samesite="" topo="$ENV_HOST"
    if [ -n "$ENV_HOST" ]; then
      if [ "$ENV_TOPOLOGY" = "split" ]; then
        vite="https://${ENV_API_HOST}"; same="";  cors="https://${ENV_HOST}"; samesite="None"
      else
        vite="https://${ENV_HOST}/api"; same="1"; cors="";                    samesite="Lax"
      fi
    elif [ -t 0 ] && [ -t 1 ]; then
      # No --host given, but we're on a terminal: don't leave the
      # https://ccp.example.com/api placeholder for the operator to trip over
      # (that static example URL is a common "Failed to fetch" root cause) — ask,
      # offering the same-origin relative default. .env.example's other Topology-A
      # defaults (CCP_SAME_ORIGIN=1, empty CCP_CORS_ORIGIN, SameSite=Lax)
      # already match a relative base, so only this one line needs setting.
      printf '%s' "  API base URL the BROWSER will use to reach the api (through your proxy).
  Same-origin relative — recommended when one proxy serves both the app and
  the api on the same host/IP [/api]: "
      local reply; read -r reply || reply=""
      vite="${reply:-/api}"
      case "$vite" in
        http://*|https://*)
          # Minimal extension of the same idea, for the split-origin shape typed
          # by hand here: a cross-origin answer needs the SPA's own origin for
          # CORS + SameSite=None too, or the Topology-A defaults (CCP_SAME_ORIGIN=1,
          # empty CORS) would silently stay underneath it — the same mismatch
          # --host exists to prevent.
          printf '%s' "  Cross-origin API base — this SPA's OWN public origin, for CORS (e.g. https://ccp.example.com): "
          local origin; read -r origin || origin=""
          if [ -n "$origin" ]; then same=""; cors="$origin"; samesite="None"; topo=1
          else warn "no origin given — CCP_CORS_ORIGIN left at the template default (empty); the api will refuse cross-site sign-in until you set it by hand"
          fi
          ;;
      esac
    fi
    # awk keeps the base64 key intact; rewrites VITE_API_BASE when either the
    # --host path or the bare-TTY prompt above produced a value, and the A/B
    # topology lines whenever a topology was actually decided (--host, or the
    # bare-TTY cross-origin follow-up above) — the commented examples stay put
    # otherwise, so a plain relative-path answer stays byte-for-byte unchanged.
    # ADR-0023: name/tagline rewrite independently of topo/vite — an operator
    # may set a name with no --host at all.
    if awk -v key="$key" -v topo="$topo" -v vite="$vite" -v same="$same" -v cors="$cors" -v ss="$samesite" -v name="$name" -v tagline="$tagline" '
         /^CCP_TOTP_KEY=/                    { print "CCP_TOTP_KEY=" key; next }
         vite!="" && /^VITE_API_BASE=/          { print "VITE_API_BASE=" vite; next }
         topo!="" && /^CCP_SAME_ORIGIN=/     { print "CCP_SAME_ORIGIN=" same; next }
         topo!="" && /^CCP_CORS_ORIGIN=/     { print "CCP_CORS_ORIGIN=" cors; next }
         topo!="" && /^CCP_COOKIE_SAMESITE=/ { print "CCP_COOKIE_SAMESITE=" ss; next }
         name!="" && /^CCP_INSTANCE_NAME=/   { print "CCP_INSTANCE_NAME=" name; next }
         tagline!="" && /^CCP_INSTANCE_TAGLINE=/ { print "CCP_INSTANCE_TAGLINE=" tagline; next }
         { print }
       ' "$example" > "$real"; then
      chmod 600 "$real" 2>/dev/null || true
      if [ -n "$name" ]; then
        ok "instance name set: ${name}${tagline:+ ($tagline)}"
      fi
      if [ -n "$ENV_HOST" ]; then
        ok "wrote $real — TOTP key generated; ${ENV_TOPOLOGY}-origin topology set for ${ENV_HOST}${ENV_API_HOST:+ (api: $ENV_API_HOST)}"
      elif [ -n "$vite" ] && [ -n "$topo" ]; then
        ok "wrote $real — TOTP key generated; VITE_API_BASE=$vite, split-origin CORS set (CCP_CORS_ORIGIN=$cors, SameSite=None)"
      elif [ -n "$vite" ]; then
        ok "wrote $real — TOTP key generated; VITE_API_BASE=$vite (the template's same-origin defaults apply otherwise)"
      else
        ok "wrote $real (CCP_TOTP_KEY generated; other values at template defaults)"
        warn "set VITE_API_BASE for a real deploy — re-run 'setup.sh env --host <fqdn>', or see docs/go-live.md"
      fi
    else
      err "failed to write $real"; STEP_FAIL=1; return 1
    fi
  fi

  if [ "$use_data" = "1" ]; then
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$real" ]; then
      ok "$link → $real (symlink already correct)"
    else
      ln -sfn "$real" "$link" && ok "linked $link → $real" || { err "failed to symlink $link → $real"; STEP_FAIL=1; return 1; }
    fi
  fi

  # Armed-overlay hint (commented — the operator uncomments + sets it for real
  # only when arming docker-compose.armed.yml; see .env.example).
  if [ -S /var/run/docker.sock ] && ! grep -qE '^#? ?CCP_DOCKER_GID=' "$real" 2>/dev/null; then
    local gid; gid="$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock 2>/dev/null)"
    if [ -n "$gid" ]; then
      printf '\n# CCP_DOCKER_GID=%s   # armed overlay — detected from /var/run/docker.sock at setup time\n' "$gid" >> "$real"
      ok "appended a commented CCP_DOCKER_GID=$gid hint for the armed overlay"
    fi
  fi

  # Belt-and-braces: this file holds a secret; make sure git will not track it
  # (the symlink path is what git sees — unaffected by the /data relocation).
  if git -C "$REPO_ROOT" check-ignore -q "$link" 2>/dev/null; then
    ok ".env is git-ignored — safe from an accidental commit"
  else
    err "WARNING: $link is NOT git-ignored — do not commit it (it holds CCP_TOTP_KEY)"
  fi
}

# ---- 5. terraform (install the pinned CLI on this server) --------------------
# Prefers tfenv (the repo's recommended installer); otherwise a checksum-verified
# download of the exact pinned version from releases.hashicorp.com. NEVER runs a
# plan/apply — only 'terraform version' to confirm the install.
install_terraform() {
  if [ "$(tf_have_ver)" = "$TF_VERSION" ]; then ok "terraform $TF_VERSION already installed"; return 0; fi

  if have tfenv; then
    say "installing terraform $TF_VERSION via tfenv (repo-recommended)"
    if tfenv install "$TF_VERSION" && tfenv use "$TF_VERSION"; then ok "terraform $TF_VERSION installed (tfenv)"; terraform version | head -1; return 0
    else err "tfenv install failed"; return 1; fi
  fi

  have curl  || { err "need curl to download terraform (or install tfenv/brew)"; return 1; }
  have unzip || { err "need unzip to install terraform"; return 1; }
  local os arch shac
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) err "unsupported OS $(uname -s) — install terraform $TF_VERSION by hand"; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) err "unsupported arch $(uname -m)"; return 1 ;; esac
  if   have sha256sum; then shac="sha256sum"
  elif have shasum;    then shac="shasum -a 256"
  else err "need sha256sum or shasum to verify the download"; return 1; fi

  local base="https://releases.hashicorp.com/terraform/${TF_VERSION}"
  local zip="terraform_${TF_VERSION}_${os}_${arch}.zip"
  local sums="terraform_${TF_VERSION}_SHA256SUMS"
  local tmp; tmp="$(mktemp -d)"
  say "downloading terraform ${TF_VERSION} (${os}/${arch}) + checksums"
  if ! curl -fsSL "${base}/${zip}"  -o "${tmp}/${zip}";  then err "download failed: ${base}/${zip}"; rm -rf "$tmp"; return 1; fi
  if ! curl -fsSL "${base}/${sums}" -o "${tmp}/${sums}"; then err "checksum list download failed: ${base}/${sums}"; rm -rf "$tmp"; return 1; fi

  say "verifying SHA256 checksum"
  if ! ( cd "$tmp" && grep " ${zip}\$" "${sums}" | ${shac} -c - ) >/dev/null 2>&1; then
    err "checksum verification FAILED for ${zip} — refusing to install"; rm -rf "$tmp"; return 1
  fi
  ok "checksum verified"

  local dir="${TF_INSTALL_DIR:-}"
  if [ -z "$dir" ]; then
    if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
  fi
  mkdir -p "$dir" || { err "cannot create install dir $dir"; rm -rf "$tmp"; return 1; }
  if ! unzip -o "${tmp}/${zip}" terraform -d "$dir" >/dev/null; then err "unzip into $dir failed"; rm -rf "$tmp"; return 1; fi
  chmod +x "$dir/terraform"; rm -rf "$tmp"
  ok "installed terraform ${TF_VERSION} → ${dir}/terraform"
  case ":$PATH:" in *":$dir:"*) : ;; *) warn "add it to PATH:  export PATH=\"$dir:\$PATH\"" ;; esac
  "$dir/terraform" version | head -1
}

# Full-setup wrapper: install Terraform only when it's missing or off-pin, and never
# fail the whole setup on it (the web service runs without it) — but surface it loudly.
setup_terraform_step() {
  if [ "${SKIP_TERRAFORM:-0}" = "1" ]; then
    warn "SKIP_TERRAFORM=1 — skipping Terraform install (run 'scripts/setup.sh terraform' later)"; return 0
  fi
  if [ "$(tf_have_ver)" = "$TF_VERSION" ]; then ok "terraform $TF_VERSION already installed"; return 0; fi
  say "installing Terraform (pinned $TF_VERSION) — never runs apply (AGENTS.md rule 1)"
  install_terraform || warn "Terraform install did not complete — install it manually (README → Prerequisites); the web service itself runs without it"
}

# ---- next steps -------------------------------------------------------------
print_next_steps() {
  cat <<EOF

${C_CY}── you're set up. To run the web service, pick one: ──${C_0}

  ${C_GR}Trial${C_0} (no Docker, no TLS proxy — a laptop demo of the REAL tool):
      ccp/scripts/run-local.sh
    Prints the URLs + a one-time admin password; Ctrl-C stops (throwaway store).

  ${C_GR}Dev${C_0} (hot reload):
      cd ccp/app && npm run dev                       # mock backend, no api needed
      cd ccp/api && npm run dev                        # + the real api in another shell
      cd ccp/app && VITE_API_BASE=http://localhost:8801 npm run dev   # app wired to it

  ${C_GR}Production${C_0} (Docker + your HTTPS reverse proxy):
      cd ccp && docker compose up -d --build
    Follow ${C_DIM}ccp/docs/go-live.md${C_0} — first boot, the reverse proxy, and 2FA enrolment.
    Bring the self-hosted CI runner online any time:
      docker compose --profile runner up -d --build runner   (see go-live.md → "CI runner")

  ${C_DIM}Terraform ${TF_VERSION} is installed for catalogctl plan-check / estate plans —
  never run 'terraform apply' locally; CI does that behind the gated prod environment.${C_0}

  Verify what CI checks before you push:  ./scripts/gate.sh
EOF
}

usage() { sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; }

# ---- flags (consumed by `env` / `all` to fill VITE_API_BASE + topology) ------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)     ENV_HOST="${2:?--host needs a value}"; shift 2 ;;
    --api-host) ENV_API_HOST="${2:?--api-host needs a value}"; shift 2 ;;
    --topology) ENV_TOPOLOGY="${2:?--topology needs a value}"; shift 2 ;;
    --name)     ENV_NAME="${2:?--name needs a value}"; shift 2 ;;
    --tagline)  ENV_TAGLINE="${2:?--tagline needs a value}"; shift 2 ;;
    *) err "unknown argument: $1"; echo; usage; exit 2 ;;
  esac
done
case "$ENV_TOPOLOGY" in same|split) ;; *) err "--topology must be 'same' or 'split'"; exit 2 ;; esac
if [ "$ENV_TOPOLOGY" = "split" ] && [ -n "$ENV_HOST" ] && [ -z "$ENV_API_HOST" ]; then
  err "--topology split needs --api-host (the API's own FQDN)"; exit 2
fi

# ---- dispatch ---------------------------------------------------------------
case "$MODE" in
  -h|--help|help) usage; exit 0 ;;
  check)     check_prereqs; exit $? ;;
  install)   do_install; [ "$STEP_FAIL" -eq 0 ] && ok "install complete" || err "install had failures"; exit "$STEP_FAIL" ;;
  data)      do_data direct; exit "$STEP_FAIL" ;;
  env)       do_env;     exit "$STEP_FAIL" ;;
  terraform) install_terraform; exit $? ;;
  all)
    if ! check_prereqs; then
      err "fix the prerequisite(s) above, then re-run — skipping install/env"; exit 1
    fi
    echo; do_install
    echo; do_data all
    echo; do_env
    echo; setup_terraform_step
    if [ "$STEP_FAIL" -eq 0 ]; then print_next_steps; echo; ok "setup complete"; exit 0
    else echo; err "setup finished with errors above — resolve them and re-run"; exit 1; fi ;;
  *) err "unknown mode: $MODE"; echo; usage; exit 2 ;;
esac
