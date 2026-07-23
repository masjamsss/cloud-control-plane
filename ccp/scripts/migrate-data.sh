#!/usr/bin/env bash
# =============================================================================
# migrate-data.sh — ONE-TIME guarded migration of the api's durable store from
# the legacy `ccp_ccp-data` DOCKER VOLUME to the /data/ccp/store BIND
# that docker-compose.yml now mounts (see docs/superpowers/plans/
# 2026-07-21-ccp-docker-consolidation.md §6, and ccp/docs/go-live.md →
# "Migrating an existing install to /data"). Written to the same data-safety
# contract as self-update.sh: verified backup first, byte-identical manifest
# comparison at every hand-off, refuse (with automatic rollback) on any
# mismatch. The OLD volume is NEVER deleted by this script — removing it is an
# explicit, manual, later operator step, only after confirming the new store
# and a backup-restore drill:
#
#   docker volume rm ccp_ccp-data
#
# This script NEVER runs `docker compose down -v` or `docker volume rm`, ever,
# in any code path. The old volume is mounted read-only (:ro) every time it is
# read, so it physically cannot be corrupted by this script.
#
# Ceremony (see docs/go-live.md → "Migrating an existing install to /data"):
#   touch /var/lib/ccp-update/hold      # pause self-update during the migration
#   cd <repo> && git pull --ff-only        # brings the new compose + this script
#   sudo ccp/scripts/migrate-data.sh    # this script (the guarded migration)
#   rm /var/lib/ccp-update/hold         # resume self-update
#   … days later, after confirming the portal + a backup-restore drill:
#   docker volume rm ccp_ccp-data    # the ONLY destructive step — manual, never scripted
#
# Usage:
#   sudo ccp/scripts/migrate-data.sh            run the guarded migration (needs root)
#   ccp/scripts/migrate-data.sh --check         dry run — report only, change nothing
#   ccp/scripts/migrate-data.sh --volume NAME   override the old volume name
#                                                   (default: ccp_ccp-data, i.e.
#                                                   compose project "ccp" + service
#                                                   volume "ccp-data")
#   ccp/scripts/migrate-data.sh --help
#
# Idempotent: an already-migrated host — compose binds /data/ccp/store AND
# /data/ccp/store/ccp.json exists AND /readyz is green — exits 0
# immediately ("already migrated"), in either mode, without requiring root.
#
# AGENTS.md rules 1–2 hold: no terraform, no AWS writes, ever.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="run"
VOLUME="ccp_ccp-data"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)  MODE="check"; shift ;;
    --volume) VOLUME="${2:?--volume needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then C_CY=$'\033[1;36m'; C_GR=$'\033[1;32m'; C_YE=$'\033[1;33m'; C_RE=$'\033[1;31m'; C_0=$'\033[0m'
else C_CY=""; C_GR=""; C_YE=""; C_RE=""; C_0=""; fi
say()  { printf '%s▸ %s%s\n' "$C_CY" "$*" "$C_0"; }
ok()   { printf '%s✓ %s%s\n' "$C_GR" "$*" "$C_0"; }
warn() { printf '%s! %s%s\n' "$C_YE" "$*" "$C_0"; }
err()  { printf '%s✗ %s%s\n' "$C_RE" "$*" "$C_0" >&2; }

# Pinned helper image for the read-only volume-side operations (space check,
# source manifest, copy). One tag, used consistently everywhere it's needed.
ALPINE_IMAGE="alpine:3.20"

STORE=/data/ccp/store
UPDATE_STATE=/data/ccp/update
ROLLBACK_OVERRIDE="$UPDATE_STATE/rollback-volume.yml"
TS="$(date +%Y%m%d-%H%M%S)"

compose()          { ( cd "$CCP_DIR" && docker compose "$@" ); }
compose_rollback() { ( cd "$CCP_DIR" && docker compose -f docker-compose.yml -f "$ROLLBACK_OVERRIDE" "$@" ); }
api_port()   { grep -E '^PORT=' "$CCP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]'; }
readyz_ok()  { [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${1}/readyz" 2>/dev/null)" = "200" ]; }
wait_readyz(){ local p="$1" t="${2:-180}" i=0; while [ "$i" -lt "$t" ]; do readyz_ok "$p" && return 0; sleep 2; i=$((i+2)); done; return 1; }
PORT="$(api_port)"; PORT="${PORT:-8801}"

is_separate_mount() { # /data ideally its own mount — informational only, never fatal
  if command -v mountpoint >/dev/null 2>&1; then mountpoint -q /data; return $?; fi
  awk '$2=="/data"{found=1} END{exit !found}' /proc/mounts 2>/dev/null
}

mounted_by_running_container() { # $1=host path — true if any running container mounts it
  docker ps -q 2>/dev/null | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null | grep -qx "$1"
}

# Escape hatch: re-point the api at the OLD volume until it is removed by hand.
# Written BEFORE any destructive step so it always exists if something later fails.
write_rollback_override() {
  mkdir -p "$UPDATE_STATE" 2>/dev/null || true
  cat > "$ROLLBACK_OVERRIDE" <<EOF
# Escape hatch written by migrate-data.sh on $TS — re-points the api at the OLD
# volume ('$VOLUME') until it is removed by hand. Usage:
#   docker compose -f docker-compose.yml -f $ROLLBACK_OVERRIDE up -d api
services:
  api:
    volumes: ["ccp-data:/var/lib/ccp"]
volumes:
  ccp-data:
    name: $VOLUME
    external: true
EOF
}

# Re-up the api on the OLD volume via the override, wait for /readyz. Safe to
# call even if the api was never stopped (up -d is idempotent) — always leaves
# the api running against the untouched old volume.
rollback_to_old_volume() {
  err "restoring the api on the OLD volume ('$VOLUME') via $ROLLBACK_OVERRIDE"
  write_rollback_override
  if compose_rollback up -d api && wait_readyz "$PORT" 180; then
    ok "api restarted on the old volume; /readyz is green — no data was moved or lost"
  else
    err "could NOT restart the api on the old volume either — manual intervention required."
    err "the old volume ('$VOLUME') itself is untouched; see docs/go-live.md → \"Migrating an existing install to /data\""
  fi
}

# Centralizes every failure path from step 3 onward: log, roll back (RUN mode
# only — --check never changes anything so there is nothing to roll back), exit 1.
refuse() {
  err "$1"
  [ "$MODE" = "run" ] && rollback_to_old_volume
  exit 1
}

say "migrate-data.sh — legacy volume ('$VOLUME') → /data/ccp/store"
[ "$MODE" = "check" ] && say "(--check: dry run — nothing will be changed)"

# ---- step 1: already-migrated fast path + guards -----------------------------
# Checked BEFORE any privilege/tooling requirement so a harmless re-run on an
# already-migrated host is a clean no-op for any user, in either mode.
ALREADY=0
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if compose config 2>/dev/null | grep -q '/data/ccp/store' \
     && [ -s "$STORE/ccp.json" ] \
     && readyz_ok "$PORT"; then
    ALREADY=1
  fi
fi
if [ "$ALREADY" = "1" ]; then
  ok "already migrated: compose binds $STORE, ccp.json present, /readyz green — nothing to do"
  exit 0
fi

say "[1/12] guards"
if [ "$MODE" = "run" ] && [ "$(id -u)" != "0" ]; then
  err "must run as root (chown into $STORE needs it) — sudo ccp/scripts/migrate-data.sh"
  exit 1
fi
command -v docker >/dev/null 2>&1 || { err "docker not found"; exit 1; }
docker compose version >/dev/null 2>&1 || { err "'docker compose' v2 not found"; exit 1; }
[ -d /data ] || { err "/data does not exist — mount a persistent disk at /data first (see docs/go-live.md → Prerequisites)"; exit 1; }
[ -w /data ] || { err "/data exists but is not writable by this user"; exit 1; }
is_separate_mount || warn "/data does not appear to be a separate mount (per /proc/mounts) — continuing, but confirm this is really your persistent disk"
compose config --services 2>/dev/null | grep -qx api \
  || { err "compose project has no 'api' service — wrong directory, or docker-compose.yml changed shape"; exit 1; }
docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || { err "old volume '$VOLUME' not found — nothing to migrate (override with --volume NAME if your compose project name differs)"; exit 1; }
ok "guards passed: docker+compose present, /data ready, api service found, old volume '$VOLUME' exists"

# ---- step 2: write the rollback override (RUN mode only) ---------------------
# --check never writes anything, including this — the escape hatch every
# subsequent RUN-mode step relies on.
if [ "$MODE" = "run" ]; then
  say "[2/12] writing the rollback override → $ROLLBACK_OVERRIDE"
  write_rollback_override || { err "could not write $ROLLBACK_OVERRIDE"; exit 1; }
  ok "rollback override ready (escape hatch until '$VOLUME' is removed by hand)"
fi

# ---- step 3: space check (old-volume size ×1.2 must fit /data's free space) --
say "[3/12] checking free space on /data"
VOL_KB="$(docker run --rm -v "$VOLUME":/from:ro "$ALPINE_IMAGE" du -sk /from 2>/dev/null | awk '{print $1}')"
if [ -z "${VOL_KB:-}" ]; then refuse "could not measure the size of volume '$VOLUME'"; fi
AVAIL_KB="$(df -Pk /data 2>/dev/null | awk 'NR==2{print $4}')"
if [ -z "${AVAIL_KB:-}" ]; then refuse "could not read available space on /data"; fi
NEED_KB=$(( VOL_KB * 12 / 10 ))
if [ "$NEED_KB" -gt "$AVAIL_KB" ]; then
  refuse "not enough space on /data: need ~${NEED_KB}KB (volume ${VOL_KB}KB ×1.2), only ${AVAIL_KB}KB available"
fi
ok "space check passed: volume ${VOL_KB}KB ×1.2 fits in ${AVAIL_KB}KB available on /data"

if [ "$MODE" = "check" ]; then
  say "[4-11/12] --check stops here: would back up (npm run backup + a full-store tar),"
  say "          freeze the api, copy '$VOLUME' → $STORE, verify a byte-identical"
  say "          manifest, cut over the compose stack, and verify again — this run"
  say "          changes nothing."
  ok "--check: migration plan looks clear (guards passed; '$VOLUME' is $((VOL_KB/1024))MB; /data has $((AVAIL_KB/1024))MB free)"
  exit 0
fi

# ---- step 4: backups first — refuse unless the currently running api is green
say "[4/12] verifying the current api is healthy, then backing it up"
readyz_ok "$PORT" || refuse "the running api is not green on /readyz — fix the deployment before migrating"
say "        chain-verified store backup (npm run backup)"
compose exec -T api npm run --silent backup -- --out "/var/lib/ccp/pre-migrate-$TS.json" >/dev/null \
  || refuse "store backup (npm run backup) FAILED — aborting migration"
say "        full-store tar (captures projects/) → $UPDATE_STATE/pre-migrate-$TS.tar"
mkdir -p "$UPDATE_STATE"
compose exec -T api tar cf - -C /var/lib/ccp . > "$UPDATE_STATE/pre-migrate-$TS.tar" \
  || refuse "full-store tar FAILED — aborting migration"
compose exec -T api rm -f "/var/lib/ccp/pre-migrate-$TS.json" >/dev/null 2>&1 || true  # copy lives in the tar
ok "backup written: $UPDATE_STATE/pre-migrate-$TS.tar ($(du -h "$UPDATE_STATE/pre-migrate-$TS.tar" 2>/dev/null | cut -f1))"

# ---- step 5: freeze writers ---------------------------------------------------
say "[5/12] freezing writers: compose stop api (app + nginx keep serving the static SPA; the portal api is briefly down)"
compose stop api || refuse "could not stop the api — aborting migration"

# ---- step 6: source manifest (volume, read-only mount — cannot be corrupted) -
say "[6/12] hashing the source volume (read-only mount)"
docker run --rm -v "$VOLUME":/from:ro "$ALPINE_IMAGE" sh -c 'cd /from && find . -type f | sort | xargs -r sha256sum' \
  > "$UPDATE_STATE/pre.files" 2>/dev/null || refuse "could not hash the source volume"
PRE_ROWS="$(docker run --rm -v "$VOLUME":/from:ro "$ALPINE_IMAGE" sh -c 'grep -o "\"DATA#v" /from/ccp.json 2>/dev/null | wc -l' | tr -d '[:space:]')"
PRE_ACTIVE="$(docker run --rm -v "$VOLUME":/from:ro "$ALPINE_IMAGE" sh -c 'grep -o "\"dataActive\"" /from/ccp.json 2>/dev/null | wc -l' | tr -d '[:space:]')"
PRE_ROWS="${PRE_ROWS:-0}"; PRE_ACTIVE="${PRE_ACTIVE:-0}"
PRE_FILES_N="$(wc -l < "$UPDATE_STATE/pre.files" | tr -d '[:space:]')"
ok "source manifest: $PRE_FILES_N files, $PRE_ROWS version rows, $PRE_ACTIVE active pointers"

# ---- step 7: copy (source stays :ro throughout) -------------------------------
say "[7/12] copying '$VOLUME' → $STORE"
mkdir -p "$STORE"
if [ -n "$(ls -A "$STORE" 2>/dev/null)" ]; then
  # Non-empty from a previous failed attempt. The wipe target is the never-yet-
  # live destination — NEVER the volume — and only after re-asserting no
  # running container currently mounts it.
  mounted_by_running_container "$STORE" && refuse "$STORE is non-empty AND a running container currently mounts it — refusing to wipe a live mount"
  warn "$STORE is non-empty (leftover from a previous failed attempt) — wiping it before the copy (the source volume is untouched, mounted :ro)"
  rm -rf "${STORE:?}"/* "${STORE:?}"/.[!.]* 2>/dev/null || true
fi
docker run --rm -v "$VOLUME":/from:ro -v "$STORE":/to "$ALPINE_IMAGE" sh -c 'cd /from && cp -a . /to/' \
  || refuse "copy from '$VOLUME' to $STORE failed"
chown -R 1000:1000 "$STORE" || refuse "chown $STORE to 1000:1000 failed"
chmod 700 "$STORE" || refuse "chmod 700 $STORE failed"
ok "copy complete; $STORE owned 1000:1000, mode 700"

# ---- step 8: verify — refuse on ANY mismatch ----------------------------------
say "[8/12] verifying the copy (host-side hash of $STORE)"
( cd "$STORE" && find . -type f | sort | xargs -r sha256sum ) > "$UPDATE_STATE/post.files" 2>/dev/null \
  || refuse "could not hash $STORE"
DIFF_OUT="$(diff "$UPDATE_STATE/pre.files" "$UPDATE_STATE/post.files" || true)"
POST_ROWS="$(grep -o '"DATA#v' "$STORE/ccp.json" 2>/dev/null | wc -l | tr -d '[:space:]')"; POST_ROWS="${POST_ROWS:-0}"
POST_ACTIVE="$(grep -o '"dataActive"' "$STORE/ccp.json" 2>/dev/null | wc -l | tr -d '[:space:]')"; POST_ACTIVE="${POST_ACTIVE:-0}"
if [ -n "$DIFF_OUT" ] || [ "$POST_ROWS" != "$PRE_ROWS" ] || [ "$POST_ACTIVE" != "$PRE_ACTIVE" ]; then
  err "COPY VERIFICATION MISMATCH — the source volume was mounted read-only throughout and is intact:"
  [ -n "$DIFF_OUT" ] && printf '%s\n' "$DIFF_OUT" | head -20 >&2
  [ "$POST_ROWS" != "$PRE_ROWS" ] && err "version rows: source $PRE_ROWS vs copy $POST_ROWS"
  [ "$POST_ACTIVE" != "$PRE_ACTIVE" ] && err "active pointers: source $PRE_ACTIVE vs copy $POST_ACTIVE"
  refuse "aborting migration — see the diff above"
fi
ok "copy verified byte-identical: $PRE_FILES_N files, rows $PRE_ROWS, active $PRE_ACTIVE"

# ---- step 9: consolidate the rest of /data (idempotent) -----------------------
say "[9/12] consolidating the rest of /data"
mkdir -p "$UPDATE_STATE"
if [ -d /var/lib/ccp-update ] && [ ! -L /var/lib/ccp-update ]; then
  say "        moving /var/lib/ccp-update/* → $UPDATE_STATE/ (leaving a symlink back)"
  ( shopt -s dotglob nullglob 2>/dev/null; for f in /var/lib/ccp-update/*; do mv -n "$f" "$UPDATE_STATE/" 2>/dev/null || true; done )
  rmdir /var/lib/ccp-update 2>/dev/null || rm -rf /var/lib/ccp-update
  ln -s "$UPDATE_STATE" /var/lib/ccp-update
  ok "/var/lib/ccp-update → $UPDATE_STATE (symlink; existing systemd units keep working)"
elif [ -L /var/lib/ccp-update ]; then
  ok "/var/lib/ccp-update is already a symlink — skipping"
else
  ln -s "$UPDATE_STATE" /var/lib/ccp-update 2>/dev/null || true
  ok "/var/lib/ccp-update → $UPDATE_STATE (symlink created)"
fi

if [ -f "$CCP_DIR/.env" ] && [ ! -L "$CCP_DIR/.env" ]; then
  say "        relocating ccp/.env → /data/ccp/config/ccp.env"
  mkdir -p /data/ccp/config
  DEPLOY_USER="${SUDO_USER:-root}"
  if mv "$CCP_DIR/.env" /data/ccp/config/ccp.env \
      && chown "$DEPLOY_USER" /data/ccp/config/ccp.env 2>/dev/null \
      && chmod 600 /data/ccp/config/ccp.env \
      && ln -sfn /data/ccp/config/ccp.env "$CCP_DIR/.env"; then
    ok "ccp/.env → /data/ccp/config/ccp.env (symlink)"
  else
    refuse "failed to relocate ccp/.env into /data/ccp/config"
  fi
else
  ok "ccp/.env already a symlink (or absent) — skipping relocation"
fi

( mkdir -p /data/scratch && chown 1000:1000 /data/scratch && chmod 700 /data/scratch ) \
  || refuse "failed to prepare /data/scratch"
( mkdir -p /data/runner  && chown 1001:1001 /data/runner  && chmod 750 /data/runner ) \
  || refuse "failed to prepare /data/runner"
ok "/data/scratch + /data/runner ready"

# ---- step 10: cut over --------------------------------------------------------
say "[10/12] cutting over: compose up -d --build (now binds $STORE)"
compose up -d --build || refuse "compose up -d --build failed during cutover"
wait_readyz "$PORT" 180 || refuse "/readyz did not go green within 180s after cutover"
ok "cutover complete; /readyz green"

# ---- step 11: post-cutover manifest re-check — refuse (+rollback) on mismatch
say "[11/12] post-cutover manifest re-check (inside the container) vs the pre-migration source"
compose exec -T api sh -c 'cd "${CCP_DATA_DIR:-/var/lib/ccp}" && find . -type f | sort | xargs -r sha256sum' \
  > "$UPDATE_STATE/post-cutover.files" 2>/dev/null || refuse "could not read the manifest from inside the container after cutover"
CUTOVER_DIFF="$(diff "$UPDATE_STATE/pre.files" "$UPDATE_STATE/post-cutover.files" || true)"
if [ -n "$CUTOVER_DIFF" ]; then
  err "post-cutover manifest MISMATCH (container vs pre-migration source):"
  printf '%s\n' "$CUTOVER_DIFF" | head -20 >&2
  refuse "aborting after cutover — see the diff above (nothing destructive happened; the api is being restored on the old volume)"
fi
ok "post-cutover manifest verified identical to the pre-migration source ($PRE_FILES_N files)"

# ---- step 12: success ----------------------------------------------------------
say "[12/12] migration complete"
cat <<SUMMARY

${C_GR}✓ migration complete${C_0}
   Store now lives at:    $STORE  (bind-mounted into the api at /var/lib/ccp)
   Pre-migration backup:  $UPDATE_STATE/pre-migrate-$TS.tar ($(du -h "$UPDATE_STATE/pre-migrate-$TS.tar" 2>/dev/null | cut -f1))
   Old volume:            '$VOLUME' — left INTACT. After confirming the portal
                           and a backup-restore drill (a few days is fine),
                           remove it BY HAND (never scripted):
                             docker volume rm $VOLUME
   Self-update:            resume it now — rm the hold file (see docs/go-live.md
                           → "Migrating an existing install to /data")
SUMMARY
ok "done"
exit 0
