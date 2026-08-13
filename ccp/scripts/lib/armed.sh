#!/usr/bin/env bash
# =============================================================================
# OPS-6 — armed-overlay state, in ONE place.
#
# Arming the bundle/drift lanes means running the api with `docker-compose.armed.yml`
# layered on top of `docker-compose.yml`. The documented way to do that used to be a
# one-shot command:
#
#     docker compose -f docker-compose.yml -f docker-compose.armed.yml up -d
#
# which arms the CONTAINER but records nothing about the DEPLOYMENT. Reproduced with
# `docker compose config` (which resolves exactly what `up` would create):
#
#     -f docker-compose.yml -f docker-compose.armed.yml   ->  ARMED   (socket mounted)
#     (plain, what every script runs afterwards)          ->  DISARMED
#     COMPOSE_FILE=…yml:…armed.yml in .env                ->  ARMED
#
# So every scripted re-up — self-update.sh nightly, an install.sh re-run, the
# migrate-data.sh cutover — silently recreated the api WITHOUT the socket, the
# /data/scratch bind, or TMPDIR, and the armed lanes started failing with a
# docker-cannot-connect error that nothing explained.
#
# THE FIX IS TO MAKE ARMING A PROPERTY OF THE DEPLOYMENT, NOT OF ONE COMMAND:
# `COMPOSE_FILE` in `.env`. Every compose invocation in every script — and every one an
# operator types — then resolves the overlay with no flag changes anywhere. This is the
# mechanism `.env.example` already documents for `COMPOSE_PROFILES=runner`, described
# there as "the sticky opt-in, which also lets self-update.sh rebuild it on code
# updates" — the identical problem, already solved this way once.
#
# The functions below are the DETECTOR for hosts armed the old way, which no amount of
# documentation can retro-fix. See `armed_drift_guard`.
# =============================================================================

# Path to the ccp/ directory. Callers set CCP_DIR before sourcing; fall back to this
# file's grandparent so the lib is usable standalone.
: "${CCP_DIR:="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}"

ARMED_OVERLAY="docker-compose.armed.yml"

# Does the RESOLVED compose config mount the docker socket into the api service?
# This is what the next `up` would create — the same technique self-update.sh already
# uses to assert the /data/ccp/store bind.
armed_in_config() {
  ( cd "$CCP_DIR" && docker compose config 2>/dev/null ) | grep -q '/var/run/docker.sock'
}

# Is the RUNNING api container armed? Mirrors doctor.sh's existing detection: ask the
# container what it actually has, not what any file says it should have.
armed_in_running_api() {
  local cid
  cid="$( cd "$CCP_DIR" && docker compose ps -q api 2>/dev/null )"
  [ -n "$cid" ] || return 1
  docker inspect "$cid" --format '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null \
    | grep -qx '/var/run/docker.sock'
}

# Is arming STICKY — i.e. will it survive the next plain `docker compose up`?
# Sticky means COMPOSE_FILE names the overlay, so the resolved config carries it.
armed_is_sticky() {
  armed_in_config
}

# The one-line fix, printed wherever the drift is detected so an operator never has to
# go and look it up.
armed_fix_hint() {
  printf 'add this line to %s/.env, then re-run:\n    COMPOSE_FILE=docker-compose.yml:%s\n' "$CCP_DIR" "$ARMED_OVERLAY"
}

# The guard itself: the api is running ARMED but the resolved config is NOT, so the next
# `up` would strip the overlay.
#
# WHY IT REFUSES RATHER THAN RE-ARMING SILENTLY. Re-applying the overlay automatically
# would mean a script deciding, on its own, to grant a container the docker socket —
# root-equivalence on the host — because it inspected a running container. That is not a
# decision to take without an operator, in a product whose entire subject is who may
# authorize what. Refusing leaves the host exactly as it is (armed, running, serving) and
# names the one line that fixes it permanently.
#
# Returns 0 when there is drift (caller should refuse), 1 otherwise.
armed_drift_detected() {
  armed_in_running_api && ! armed_in_config
}
