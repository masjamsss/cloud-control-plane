#!/usr/bin/env bash
# =============================================================================
# entrypoint.sh — ccp-runner check-first state machine. Runs as the
# unprivileged `runner` user (see ./Dockerfile). /runner is the /data/runner
# bind (see ../docker-compose.yml): the distribution AND registration state
# live together there so both survive container recreation AND image upgrades.
#
#   1. provision/upgrade dist — extract the image's staged tarball into /runner
#      whenever it's missing or off the image's pinned RUNNER_VERSION. The
#      tarball carries no state files, so .runner/.credentials survive this.
#   2. register once — if /runner/.runner is absent, config.sh against
#      RUNNER_REPO_URL + RUNNER_TOKEN (missing ⇒ print instructions, exit 1).
#   3. exec run.sh — handles SIGTERM; compose grants stop_grace_period: 2m so
#      an in-flight CI job can wind down.
# =============================================================================
set -euo pipefail
cd /runner

RUNNER_VERSION="${RUNNER_VERSION:?RUNNER_VERSION was not baked into this image — rebuild it}"
DIST_STAMP=/runner/.dist-version

# ---- 1. provision/upgrade dist ----------------------------------------------
if [ ! -f "$DIST_STAMP" ] || [ "$(cat "$DIST_STAMP" 2>/dev/null)" != "$RUNNER_VERSION" ]; then
  echo "▸ installing actions/runner ${RUNNER_VERSION} into /runner"
  tar -xzf /opt/runner-dist/runner.tgz -C /runner
  echo "$RUNNER_VERSION" > "$DIST_STAMP"
fi

# ---- 2. register once (never re-registers over live credentials) -----------
if [ ! -f /runner/.runner ]; then
  if [ -z "${RUNNER_REPO_URL:-}" ] || [ -z "${RUNNER_TOKEN:-}" ]; then
    cat >&2 <<'EOF'
✗ this runner is not registered yet, and RUNNER_REPO_URL / RUNNER_TOKEN are not set.

Register it (see ccp/docs/go-live.md → "CI runner"):
  1. mint a short-lived (1h) registration token — either from the repo UI
     (Settings → Actions → Runners → New self-hosted runner), or:
       gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token
  2. register + start (the token is used once and is NEVER stored):
       cd ccp && RUNNER_TOKEN=<token> docker compose --profile runner up -d --build runner
EOF
    exit 1
  fi
  echo "▸ registering with ${RUNNER_REPO_URL} (labels: ${RUNNER_LABELS:-ccp})"
  ./config.sh --unattended \
    --url "$RUNNER_REPO_URL" \
    --token "$RUNNER_TOKEN" \
    --name "${RUNNER_NAME:-ccp-$(hostname)}" \
    --labels "${RUNNER_LABELS:-ccp}" \
    --work /runner/work \
    --replace
fi

# ---- 3. run -------------------------------------------------------------------
exec ./run.sh
