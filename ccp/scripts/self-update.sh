#!/usr/bin/env bash
# =============================================================================
# self-update.sh — guarded, opt-in code update for a DEPLOYED Cloud Control
# Plane host: git pull (ff-only) + docker compose up -d --build, wrapped in the
# gates that make it safe. It updates CODE ONLY and is built so it can NEVER lose
# the imported/activated project data an admin already put on the portal:
#
#   • the durable store + all activated project data live on the /data/ccp/store
#     BIND (container path /var/lib/ccp: ccp.json + projects/<id>/v<N>/…);
#     `up -d --build` replaces images/containers and NEVER touches bind-mounted
#     data (a host still on the legacy named volume: run scripts/migrate-data.sh
#     first — see docs/go-live.md → "Migrating an existing install to /data");
#   • this script NEVER runs `down -v`, `volume rm`, or any terraform/aws command,
#     and never sets CCP_BOOTSTRAP;
#   • BEFORE updating: a chain-verified store backup (npm run backup) AND a full-
#     store tar (captures projects/ — the store-only backup misses it) AND a
#     sha256 manifest of every project-data file;
#   • AFTER updating: /readyz must go green AND the manifest must verify — every
#     pre-update data file still present and byte-identical, version rows and
#     active pointers non-decreasing (/readyz alone does NOT check project data);
#   • on any failure: roll back to the recorded commit (the store bind untouched),
#     re-verify, alert; if rollback fails too, write the hold file and stop.
#
# Usage:
#   ccp/scripts/self-update.sh                run one guarded update cycle
#   ccp/scripts/self-update.sh --check        fetch + report only, change nothing
#   ccp/scripts/self-update.sh --print-systemd  emit the service+timer units
#   ccp/scripts/self-update.sh --help
#
# Config (env, or EnvironmentFile in the emitted systemd unit):
#   CCP_UPDATE_REF      REQUIRED. Branch/tag/SHA to follow (e.g. main). No
#                          default on purpose — choose what this host tracks.
#   CCP_UPDATE_STATE    state+backup dir (default /data/ccp/update, else
#                          /var/lib/ccp-update, else ~/.ccp-update). Never
#                          inside the repo.
#   CCP_UPDATE_HOLD     hold-file path (default <state>/hold). Exists ⇒ skip.
#   CCP_READYZ_TIMEOUT  seconds to wait for /readyz after up (default 180)
#   CCP_BACKUP_KEEP     pre-update backups to keep (default 5)
#   CCP_UPDATE_WEBHOOK  optional URL; POSTed a JSON line on failure/rollback
#                          (and on success if CCP_UPDATE_NOTIFY_SUCCESS=1)
#
# Pause it: touch the hold file, or `systemctl disable --now ccp-update.timer`
# (do this during an incident or change freeze). AGENTS.md rules 1–2 hold: this
# script contains no terraform and no aws invocation, ever.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CCP_DIR/.." && pwd)"

MODE="run"
case "${1:-}" in
  --check) MODE="check"; shift ;;
  --print-systemd) MODE="systemd"; shift ;;
  -h|--help) sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
  "") : ;;
  *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
esac

if [ -t 1 ]; then C_CY=$'\033[1;36m'; C_GR=$'\033[1;32m'; C_YE=$'\033[1;33m'; C_RE=$'\033[1;31m'; C_0=$'\033[0m'
else C_CY=""; C_GR=""; C_YE=""; C_RE=""; C_0=""; fi
say()  { printf '%s▸ %s%s\n' "$C_CY" "$*" "$C_0"; jrn "$*"; }
ok()   { printf '%s✓ %s%s\n' "$C_GR" "$*" "$C_0"; jrn "OK: $*"; }
warn() { printf '%s! %s%s\n' "$C_YE" "$*" "$C_0"; jrn "WARN: $*"; }
err()  { printf '%s✗ %s%s\n' "$C_RE" "$*" "$C_0" >&2; jrn "ERROR: $*"; }
jrn()  { command -v logger >/dev/null 2>&1 && logger -t ccp-update -- "$*" 2>/dev/null || true; }

# ---- systemd template (emit-don't-own, like nginx-vhost --print) -------------
if [ "$MODE" = "systemd" ]; then
  cat <<EOF
# ── /etc/systemd/system/ccp-update.service ────────────────────────────────
[Unit]
Description=CCP guarded self-update (git ff-only + compose rebuild; data-safe)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${REPO_ROOT}
# CCP_UPDATE_REF is REQUIRED — set it here (no default on purpose):
# State/backups default to /data/ccp/update when present, else /var/lib/ccp-update.
EnvironmentFile=-/etc/ccp/update.env
ExecStart=${SCRIPT_DIR}/self-update.sh

# ── /etc/systemd/system/ccp-update.timer ──────────────────────────────────
[Unit]
Description=Run the CCP self-update in a quiet window

[Timer]
# Pick YOUR window; this IS the apply window. Example: daily 03:17 local.
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target

# ── enable ───────────────────────────────────────────────────────────────────
#   sudo mkdir -p /etc/ccp && echo 'CCP_UPDATE_REF=main' | sudo tee /etc/ccp/update.env
#   sudo systemctl daemon-reload && sudo systemctl enable --now ccp-update.timer
# cron equivalent:  17 3 * * *  CCP_UPDATE_REF=main ${SCRIPT_DIR}/self-update.sh
EOF
  exit 0
fi

# ---- config -----------------------------------------------------------------
REF="${CCP_UPDATE_REF:-}"
READYZ_TIMEOUT="${CCP_READYZ_TIMEOUT:-180}"
KEEP="${CCP_BACKUP_KEEP:-5}"
STATE="${CCP_UPDATE_STATE:-}"
if [ -z "$STATE" ]; then
  if mkdir -p /data/ccp/update 2>/dev/null && [ -w /data/ccp/update ]; then STATE=/data/ccp/update
  elif mkdir -p /var/lib/ccp-update 2>/dev/null && [ -w /var/lib/ccp-update ]; then STATE=/var/lib/ccp-update
  else STATE="$HOME/.ccp-update"; mkdir -p "$STATE" || { err "cannot create state dir"; exit 1; }; fi
else mkdir -p "$STATE" || { err "cannot create state dir $STATE"; exit 1; }; fi
HOLD="${CCP_UPDATE_HOLD:-$STATE/hold}"
WEBHOOK="${CCP_UPDATE_WEBHOOK:-}"

compose() { ( cd "$CCP_DIR" && docker compose "$@" ); }
notify() { # $1=status $2=detail — best-effort webhook + journal
  jrn "notify: $1 — $2"
  [ -n "$WEBHOOK" ] && curl -fsS -m 10 -X POST -H 'content-type: application/json' \
    -d "{\"source\":\"ccp-self-update\",\"host\":\"$(hostname)\",\"status\":\"$1\",\"detail\":\"$2\"}" \
    "$WEBHOOK" >/dev/null 2>&1 || true
}
api_port() { grep -E '^PORT=' "$CCP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]'; }
readyz_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${1}/readyz" 2>/dev/null)" = "200" ]; }
wait_readyz() { local p="$1" t="$2" i=0; while [ "$i" -lt "$t" ]; do readyz_ok "$p" && return 0; sleep 2; i=$((i+2)); done; return 1; }

# Data manifest: sha256 of every activated-project data file + textual row counts.
# Shape-agnostic on purpose (no assumptions about the snapshot's JSON layout).
manifest() { # $1=outfile-prefix
  compose exec -T api sh -c 'cd "${CCP_DATA_DIR:-/var/lib/ccp}" && { [ -d projects ] && find projects -type f | sort | xargs -r sha256sum; true; }' \
    > "$1.files" 2>/dev/null || { err "could not read the project-data tree from the api container"; return 1; }
  # occurrence counts (grep -o | wc -l — a single-line JSON snapshot would fool grep -c)
  compose exec -T api sh -c 'cd "${CCP_DATA_DIR:-/var/lib/ccp}"; c=$(grep -o "\"DATA#v" ccp.json 2>/dev/null | wc -l); echo "${c:-0}"' \
    | tr -d '[:space:]' > "$1.rows" || echo 0 > "$1.rows"
  [ -s "$1.rows" ] || echo 0 > "$1.rows"
  compose exec -T api sh -c 'cd "${CCP_DATA_DIR:-/var/lib/ccp}"; c=$(grep -o "\"dataActive\"" ccp.json 2>/dev/null | wc -l); echo "${c:-0}"' \
    | tr -d '[:space:]' > "$1.active" || echo 0 > "$1.active"
  [ -s "$1.active" ] || echo 0 > "$1.active"
}

# ---- guards (run + check modes) ---------------------------------------------
[ -n "$REF" ] || { err "CCP_UPDATE_REF is not set — refusing to guess a ref (main may not be what this host should track)"; exit 2; }
command -v git >/dev/null || { err "git not found"; exit 1; }
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || { err "docker compose not available"; exit 1; }
[ -f "$HOLD" ] && { warn "hold file present ($HOLD) — skipping (remove it, or systemctl enable --now ccp-update.timer, to resume)"; exit 0; }
grep -qE '^CCP_BOOTSTRAP=1' "$CCP_DIR/.env" 2>/dev/null && { err ".env still has CCP_BOOTSTRAP=1 — fix that first (a recreated api would refuse to boot)"; exit 1; }
cd "$REPO_ROOT" || exit 1
[ -z "$(git status --porcelain)" ] || { err "working tree not clean — refusing to update over local changes (reconcile by hand)"; exit 1; }
# F3: the api service must still mount the /data/ccp/store bind (retargeted
# from the legacy ccp-data volume — see scripts/migrate-data.sh).
compose config 2>/dev/null | grep -q '/data/ccp/store' || { err "compose config does not mount /data/ccp/store on the api service — refusing (data would land off the persistent disk). If this host predates the /data migration, run scripts/migrate-data.sh first (see docs/go-live.md → \"Migrating an existing install to /data\")"; exit 1; }
# Post-migration invariant: the store bind must already hold real data — the
# bind-side twin of the old volume check above.
[ -s /data/ccp/store/ccp.json ] || { err "/data/ccp/store/ccp.json is missing or empty — this host has not completed the /data migration. Run scripts/migrate-data.sh first (see docs/go-live.md → \"Migrating an existing install to /data\")"; exit 1; }

exec 9>"$STATE/lock"
flock -n 9 || { warn "another update is already running — skipping"; exit 0; }

PRE_SHA="$(git rev-parse HEAD)"
say "fetching origin/$REF (currently at ${PRE_SHA:0:9})"
git fetch --quiet origin "$REF" || { err "git fetch failed"; notify failure "fetch failed"; exit 1; }
NEW_SHA="$(git rev-parse FETCH_HEAD)"

if [ "$MODE" = "check" ]; then
  if [ "$PRE_SHA" = "$NEW_SHA" ]; then ok "--check: already at origin/$REF (${PRE_SHA:0:9}) — nothing to do"
  else
    say "--check: update available ${PRE_SHA:0:9} → ${NEW_SHA:0:9}:"
    git log --oneline "${PRE_SHA}..${NEW_SHA}" | head -20
    git merge-base --is-ancestor "$PRE_SHA" "$NEW_SHA" && ok "fast-forward possible" || warn "NOT fast-forwardable — a human must reconcile"
    git diff --name-only "$PRE_SHA" "$NEW_SHA" | grep -q '^\.github/workflows/terraform.yml\|^scripts/gate.sh' && warn "toolchain files change in this update — review before applying"
  fi
  exit 0
fi

[ "$PRE_SHA" = "$NEW_SHA" ] && { ok "already up to date (${PRE_SHA:0:9}) — nothing to do"; exit 0; }
git merge-base --is-ancestor "$PRE_SHA" "$NEW_SHA" || { err "origin/$REF is not fast-forwardable from HEAD — refusing (never rewriting local history)"; notify failure "non-ff"; exit 1; }

PORT="$(api_port)"; PORT="${PORT:-8801}"
readyz_ok "$PORT" || { err "the running api is not green on /readyz BEFORE the update — fix the deployment first, then update"; notify failure "pre-update readyz red"; exit 1; }

# ---- BEFORE: verified backups + data manifest --------------------------------
TS="$(date +%Y%m%d-%H%M%S)"
say "backing up: chain-verified store copy + full-store tar (captures projects/)"
compose exec -T api npm run --silent backup -- --out "/var/lib/ccp/pre-update-$TS.json" >/dev/null \
  || { err "store backup (npm run backup) FAILED — aborting update"; notify failure "store backup failed"; exit 1; }
compose exec -T api tar cf - -C /var/lib/ccp . > "$STATE/pre-update-$TS.tar" \
  || { err "full-store tar FAILED — aborting update"; notify failure "store tar failed"; exit 1; }
compose exec -T api rm -f "/var/lib/ccp/pre-update-$TS.json" >/dev/null 2>&1 || true  # copy lives in the tar
ok "backup written: $STATE/pre-update-$TS.tar ($(du -h "$STATE/pre-update-$TS.tar" | cut -f1))"
ls -1t "$STATE"/pre-update-*.tar 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

say "capturing the project-data manifest (what must survive)"
manifest "$STATE/pre" || { notify failure "pre-manifest failed"; exit 1; }
PRE_FILES=$(wc -l < "$STATE/pre.files"); PRE_ROWS=$(cat "$STATE/pre.rows"); PRE_ACTIVE=$(cat "$STATE/pre.active")
ok "manifest: $PRE_FILES data files, $PRE_ROWS version rows, $PRE_ACTIVE active pointers"

# ---- UPDATE ------------------------------------------------------------------
say "updating ${PRE_SHA:0:9} → ${NEW_SHA:0:9} (git merge --ff-only)"
git merge --ff-only "$NEW_SHA" --quiet || { err "ff-only merge failed"; notify failure "merge failed"; exit 1; }
say "rebuilding + restarting containers (store bind untouched: up -d --build, NEVER down -v)"
UPDATE_OK=1
compose up -d --build || UPDATE_OK=0

# ---- AFTER: health gate + data-integrity probe -------------------------------
if [ "$UPDATE_OK" = "1" ]; then
  say "health gate: waiting up to ${READYZ_TIMEOUT}s for /readyz"
  wait_readyz "$PORT" "$READYZ_TIMEOUT" || UPDATE_OK=0
fi
if [ "$UPDATE_OK" = "1" ]; then
  say "data-integrity probe (beyond /readyz — it does not check project data)"
  manifest "$STATE/post" || UPDATE_OK=0
fi
if [ "$UPDATE_OK" = "1" ]; then
  # every pre-update file must still exist, byte-identical (additions are fine)
  if ! comm -23 <(sort "$STATE/pre.files") <(sort "$STATE/post.files") | head -5 | grep -q . ; then
    POST_ROWS=$(cat "$STATE/post.rows"); POST_ACTIVE=$(cat "$STATE/post.active")
    if [ "$POST_ROWS" -ge "$PRE_ROWS" ] && [ "$POST_ACTIVE" -ge "$PRE_ACTIVE" ]; then
      ok "project data intact: all $PRE_FILES files identical; rows $PRE_ROWS→$POST_ROWS; active $PRE_ACTIVE→$POST_ACTIVE"
    else
      err "version rows or active pointers DECREASED (rows $PRE_ROWS→$POST_ROWS, active $PRE_ACTIVE→$POST_ACTIVE)"; UPDATE_OK=0
    fi
  else
    err "project-data files MISSING or CHANGED after the update:"; comm -23 <(sort "$STATE/pre.files") <(sort "$STATE/post.files") | head -10
    UPDATE_OK=0
  fi
fi

if [ "$UPDATE_OK" = "1" ]; then
  docker image prune -f >/dev/null 2>&1 || true
  echo "$TS $PRE_SHA -> $NEW_SHA OK" >> "$STATE/history"
  ok "update complete: now at ${NEW_SHA:0:9}; /readyz green; project data verified intact"
  [ "${CCP_UPDATE_NOTIFY_SUCCESS:-0}" = "1" ] && notify success "${PRE_SHA:0:9} -> ${NEW_SHA:0:9}"
  exit 0
fi

# ---- ROLLBACK (store bind untouched; both commits are from origin) -----------
err "update FAILED — rolling back to ${PRE_SHA:0:9} (the store bind was never touched)"
notify rollback "update to ${NEW_SHA:0:9} failed; rolling back"
git reset --hard "$PRE_SHA" --quiet
if compose up -d --build && wait_readyz "$PORT" "$READYZ_TIMEOUT"; then
  echo "$TS $PRE_SHA -> $NEW_SHA FAILED, rolled back" >> "$STATE/history"
  err "rolled back to ${PRE_SHA:0:9} and /readyz is green again. The failed update needs a human. Backup: $STATE/pre-update-$TS.tar"
  notify failure "rolled back to ${PRE_SHA:0:9}; update needs a human"
  exit 1
fi
touch "$HOLD"
err "ROLLBACK ALSO FAILED — hold file written ($HOLD); no further auto-updates will run."
err "Recover by hand: restore the pre-update tar into a STOPPED api (see go-live.md), then remove the hold file."
notify failure "ROLLBACK FAILED on $(hostname) — manual intervention required"
exit 1
