#!/usr/bin/env bash
# =============================================================================
# doctor.sh — read-only health diagnostic for a DEPLOYED CCP host.
# Run it any time something feels off (or after install/update). It changes
# NOTHING: no writes, no restarts, no terraform, no AWS. Exit 0 = all good;
# 1 = at least one FAIL (warnings alone don't fail it).
#
#   ccp/scripts/doctor.sh                 # full check against the local deploy
#   ccp/scripts/doctor.sh --host FQDN     # also probe https://FQDN through the proxy
# =============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; CCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST=""; [ "${1:-}" = "--host" ] && HOST="${2:-}"
if [ -t 1 ]; then G=$'\033[1;32m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; N=$'\033[0m'; else G=""; Y=""; R=""; N=""; fi
FAIL=0
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '%s✗%s %s\n' "$R" "$N" "$*"; FAIL=1; }

# ── config file ──────────────────────────────────────────────────────────────
# ccp/.env may now be a symlink into /data/ccp/config/ccp.env (setup.sh
# env). `-f` follows symlinks (so a healthy symlink is handled by the normal
# path below), but a DANGLING symlink must FAIL loudly rather than silently
# falling through to the "no .env" warn (that warn is fine for a trial host
# with no .env at all — it is NOT fine for a broken symlink on a deployed one).
ENVF="$CCP_DIR/.env"
if [ -L "$ENVF" ] && [ ! -e "$ENVF" ]; then
  bad ".env is a symlink to a missing target ($(readlink "$ENVF" 2>/dev/null)) — re-run setup.sh env, or restore /data/ccp/config"
elif [ -f "$ENVF" ]; then
  if [ -L "$ENVF" ]; then
    ok ".env present (symlink → $(readlink "$ENVF" 2>/dev/null))"
    case "$(readlink -f "$ENVF" 2>/dev/null)" in
      /data/ccp/config/*) ok ".env symlink target is under /data/ccp/config" ;;
      *) warn ".env symlink target is not under /data/ccp/config ($(readlink -f "$ENVF" 2>/dev/null))" ;;
    esac
  else
    ok ".env present"
  fi
  # -L dereferences the symlink so this reports the TARGET's permissions, not
  # the link's own (a bare `stat -c %a` on a symlink reports the link's 777).
  PERM="$(stat -L -c %a "$ENVF" 2>/dev/null || stat -L -f %Lp "$ENVF" 2>/dev/null)"
  [ "$PERM" = "600" ] && ok ".env permissions 600" || warn ".env permissions are $PERM — recommend chmod 600 (it holds CCP_TOTP_KEY)"
  grep -qE '^CCP_BOOTSTRAP=1' "$ENVF" && bad "CCP_BOOTSTRAP=1 is still set — the api will refuse to restart once the store exists (set it empty)" || ok "bootstrap flag off"
  grep -qE '^CCP_TOTP_KEY=(REPLACE|change-me|$)' "$ENVF" && bad "CCP_TOTP_KEY looks like a placeholder — generate a real one (setup.sh env)" || ok "TOTP key set"
  git -C "$CCP_DIR/.." check-ignore -q "$ENVF" 2>/dev/null && ok ".env is git-ignored" || bad ".env is NOT git-ignored — never commit it"
else
  warn "no $ENVF — fine for run-local.sh trials; required for the docker deploy (setup.sh env)"
fi
API_PORT="$(grep -E '^PORT=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2)"; API_PORT="${API_PORT:-8801}"
APP_PORT="$(grep -E '^APP_PORT=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2)"; APP_PORT="${APP_PORT:-8800}"

# ── containers ───────────────────────────────────────────────────────────────
# --profile runner --profile toolbox so opt-in profile services are visible to
# `compose ps` too (bare `compose ps` only shows the core api/app services).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  UP="$(cd "$CCP_DIR" && docker compose --profile runner --profile toolbox ps --format '{{.Service}} {{.Status}}' 2>/dev/null)"
  if [ -n "$UP" ]; then
    echo "$UP" | while read -r line; do case "$line" in *Up*) ok "container: $line";; *) echo "${R}✗${N} container: $line";; esac; done
    echo "$UP" | grep -qv Up && FAIL=1
  else warn "no compose services found in $CCP_DIR — not a docker deploy, or different project dir"; fi

  # runner (opt-in profile: runner) — never a FAIL just for being off.
  if echo "$UP" | grep -q '^runner '; then
    [ -f /data/runner/.runner ] && ok "runner registered (/data/runner/.runner present)" \
      || warn "runner container present but unregistered — see docs/go-live.md → \"CI runner\""
  else
    warn "runner profile not enabled (OPT) — bring it up with: docker compose --profile runner up -d --build runner (see docs/go-live.md → \"CI runner\")"
  fi

  # toolbox (run-on-demand — profile: toolbox, restart: "no"; never `up`, so it
  # is checked by image presence + toolbox-selfcheck's own exit code, not
  # compose ps). catalogctl itself has no 0-exit -h/no-arg path (usage exits 3
  # — see ccp/toolbox/toolbox-selfcheck), so toolbox-selfcheck's exit code
  # is authoritative here, never a direct `catalogctl` invocation.
  if docker image inspect ccp-toolbox:local >/dev/null 2>&1; then
    if docker run --rm ccp-toolbox:local toolbox-selfcheck >/dev/null 2>&1; then
      ok "toolbox image present; toolbox-selfcheck OK"
    else
      bad "toolbox image present but toolbox-selfcheck FAILED — rebuild: docker compose --profile toolbox build toolbox"
    fi
  else
    warn "toolbox image not built (OPT) — docker compose --profile toolbox build toolbox"
  fi

  # armed posture (docker-compose.armed.yml, opt-in) — silent when not armed.
  API_CID="$(cd "$CCP_DIR" && docker compose ps -q api 2>/dev/null)"
  if [ -n "$API_CID" ] && docker inspect "$API_CID" >/dev/null 2>&1; then
    MOUNTS="$(docker inspect "$API_CID" --format '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null)"
    if echo "$MOUNTS" | grep -qx '/var/run/docker.sock'; then
      warn "api is ARMED — /var/run/docker.sock is mounted (root-equivalent on this host; see docker-compose.armed.yml SECURITY note)"
      TMPDIR_VAL="$(docker inspect "$API_CID" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^TMPDIR=' | cut -d= -f2)"
      if echo "$MOUNTS" | grep -qx '/data/scratch'; then
        [ "$TMPDIR_VAL" = "/data/scratch" ] && ok "armed: /data/scratch bind + TMPDIR agree" \
          || bad "armed: /data/scratch is bound but TMPDIR=${TMPDIR_VAL:-unset} (expected /data/scratch) — path identity broken for armed-lane checkouts"
      else
        bad "armed (docker.sock mounted) but /data/scratch is NOT bound — path identity broken for armed-lane checkouts"
      fi
    fi
  fi
else
  warn "docker unavailable — skipping container checks (trial/dev mode?)"
fi

# ── the api itself ───────────────────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  H="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/healthz" 2>/dev/null)"
  [ "$H" = "200" ] && ok "api /healthz 200 (:${API_PORT})" || bad "api /healthz answered '${H:-none}' on :${API_PORT} — is the api up?"
  RZ="$(curl -s "http://127.0.0.1:${API_PORT}/readyz" 2>/dev/null)"
  if echo "$RZ" | grep -q '"ready":true'; then
    ok "api /readyz ready=true — store loaded, accounts present, audit chains verify"
  else
    bad "api /readyz NOT ready: ${RZ:-no response} — see api/README.md (readyz reasons)"
  fi
  # ADR-0023 — effective instance identity: baked (.env's CCP_INSTANCE_NAME,
  # what the NEXT rebuild bakes into the SPA) vs runtime (GET /instance,
  # unauthenticated — what every surface shows RIGHT NOW). A mismatch is
  # expected and benign right after a Settings rename (converges at the next
  # routine rebuild, e.g. self-update.sh) — informational only, never a FAIL.
  BAKED_NAME="$(grep -E '^CCP_INSTANCE_NAME=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2-)"
  BAKED_NAME="${BAKED_NAME:-<generic default: Cloud Control Plane>}"
  RUNTIME_NAME="$(curl -s "http://127.0.0.1:${API_PORT}/instance" 2>/dev/null | sed -n 's/.*"name":"\?\([^",}]*\)"\?.*/\1/p')"
  { [ -z "$RUNTIME_NAME" ] || [ "$RUNTIME_NAME" = "null" ]; } && RUNTIME_NAME="<not yet seeded — generic default stands>"
  ok "instance identity — .env (next rebuild bakes): ${BAKED_NAME}; runtime (live now): ${RUNTIME_NAME}"
  A="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/" 2>/dev/null)"
  [ "$A" = "200" ] && ok "app serves on :${APP_PORT}" || warn "app answered '${A:-none}' on :${APP_PORT}"
  if [ -n "$HOST" ]; then
    # A plain `curl https://HOST/` refuses an untrusted cert (curl exit != 0, no
    # http_code) — that includes our OWN intranet-setup.sh self-signed leaf, which
    # would false-fail here otherwise. Verify against OUR root when it exists
    # (proves the cert really is ours, not just "any cert"); fall back to -k
    # (skip verification) only when there's no local CA to verify against.
    INTRANET_CA="/data/ccp/config/tls/ca.crt"
    if [ -f "$INTRANET_CA" ]; then CURL_TLS_OPTS=(--cacert "$INTRANET_CA")
    else CURL_TLS_OPTS=(-k)
    fi
    P="$(curl -s "${CURL_TLS_OPTS[@]}" -o /dev/null -w '%{http_code}' "https://${HOST}/" 2>/dev/null)"
    [ "$P" = "200" ] && ok "proxy: https://${HOST}/ 200" || bad "proxy: https://${HOST}/ answered '${P:-none}' — nginx vhost/TLS/DNS?"
    DAYS="$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    [ -n "$DAYS" ] && ok "TLS cert valid until: $DAYS" || warn "could not read the TLS cert expiry"
  fi
else warn "curl missing — skipping endpoint probes"; fi

# ── intranet TLS (self-signed mini-CA, if generated by intranet-setup.sh) ────
INTRANET_LEAF="/data/ccp/config/tls/ccp.crt"
if [ -f "$INTRANET_LEAF" ]; then
  if command -v openssl >/dev/null 2>&1; then
    ENDDATE="$(openssl x509 -in "$INTRANET_LEAF" -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -z "$ENDDATE" ]; then
      warn "intranet TLS cert present but unreadable ($INTRANET_LEAF)"
    elif openssl x509 -in "$INTRANET_LEAF" -noout -checkend 0 >/dev/null 2>&1; then
      ok "intranet TLS cert present, valid until: $ENDDATE"
    else
      bad "intranet TLS cert EXPIRED (was valid until: $ENDDATE) — renew: ccp/scripts/intranet-setup.sh --renew"
    fi
  else
    warn "openssl missing — cannot check the intranet TLS cert expiry"
  fi
else
  warn "no intranet TLS cert at $INTRANET_LEAF (OPT) — fine unless you're using intranet-setup.sh's self-signed flow"
fi

# ── disk ─────────────────────────────────────────────────────────────────────
AVAIL="$(df -Pk "$CCP_DIR" 2>/dev/null | awk 'NR==2{print int($4/1024)}')"
if [ -n "$AVAIL" ]; then [ "$AVAIL" -ge 1024 ] && ok "disk: ${AVAIL}MB free" || bad "disk: only ${AVAIL}MB free — backups/rebuilds may fail"; fi

# ── /data (persistent disk — store/config/update/scratch/runner) ─────────────
# A compose deploy without /data is a real problem (the store bind would be
# auto-created root-owned by dockerd and the api would 503) — FAIL in that
# case. No compose deploy detected at all (trial/dev host): just note it.
COMPOSE_DEPLOY=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DC="$(cd "$CCP_DIR" && docker compose ps -q 2>/dev/null | wc -l | tr -d '[:space:]')"
  [ "${DC:-0}" -gt 0 ] && COMPOSE_DEPLOY=1
fi
if [ -d /data ]; then
  ok "/data present"
  DAVAIL="$(df -Pk /data 2>/dev/null | awk 'NR==2{print int($4/1024)}')"
  if [ -n "$DAVAIL" ]; then [ "$DAVAIL" -ge 1024 ] && ok "/data: ${DAVAIL}MB free" || bad "/data: only ${DAVAIL}MB free — backups/migrations may fail"; fi
  if [ -f /data/ccp/store/ccp.json ]; then
    ok "/data/ccp/store/ccp.json present"
    SUID="$(stat -c %u /data/ccp/store/ccp.json 2>/dev/null || stat -f %u /data/ccp/store/ccp.json 2>/dev/null)"
    [ "$SUID" = "1000" ] && ok "store owned by uid 1000 (matches the api container's node user)" \
      || bad "store is owned by uid ${SUID:-?}, not 1000 — the classic root-owned-bind trap (chown -R 1000:1000 /data/ccp/store)"
  else
    warn "/data/ccp/store/ccp.json not found — not migrated yet, or a fresh/never-booted store (see scripts/migrate-data.sh)"
  fi
elif [ "$COMPOSE_DEPLOY" = "1" ]; then
  bad "/data does not exist but a compose deploy is running — the store bind would be auto-created root-owned by dockerd (see docs/go-live.md → Prerequisites)"
else
  warn "/data not present — fine for run-local.sh trials; a production docker deploy needs a persistent disk mounted at /data"
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker volume inspect ccp_ccp-data >/dev/null 2>&1; then
  warn "legacy volume ccp_ccp-data still present — migration leftover. After confirming the /data store and a backup-restore drill: docker volume rm ccp_ccp-data"
fi

# ── backups + updater ─────────────────────────────────────────────────────────
# Search order matches self-update.sh's state-dir default chain.
for S in /data/ccp/update /var/lib/ccp-update "$HOME/.ccp-update"; do
  LAST="$(ls -1t "$S"/pre-update-*.tar 2>/dev/null | head -1)"
  [ -n "$LAST" ] && { ok "latest update backup: $(basename "$LAST") (in $S)"; break; }
done
[ -z "${LAST:-}" ] && warn "no self-update backups found — fine if you've never run self-update.sh"
HOLD_HIT="$(ls /data/ccp/update/hold /var/lib/ccp-update/hold "$HOME/.ccp-update/hold" 2>/dev/null | head -1)"
[ -n "$HOLD_HIT" ] && warn "self-update HOLD file present ($HOLD_HIT) — auto-updates are paused" || ok "no update hold"

echo
[ "$FAIL" -eq 0 ] && { printf '%s✓ doctor: no failures%s\n' "$G" "$N"; exit 0; } \
                  || { printf '%s✗ doctor: at least one FAIL above needs attention%s\n' "$R" "$N"; exit 1; }
