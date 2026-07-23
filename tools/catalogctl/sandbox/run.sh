#!/usr/bin/env sh
# Sandbox wrapper — the committed trust-boundary contract (spec §6.3).
#
# It extracts a provider schema from a repo with NO cloud credentials and NO
# backend negotiation. The order in catalogctl's onboard orchestrator guarantees
# this only ever runs on a Lead-trusted repo; this script is the second, narrower
# guard: even if invoked directly it fails closed on any credential and never
# talks to a state backend.
set -eu

# 1. Fail closed if ANY cloud/registry credential is present in the environment.
#    Never negotiate the repo's real backend (e.g. the live prod state bucket).
if env | grep -Eq '^(AWS_|GOOGLE_|ARM_|TF_TOKEN_)'; then
  echo "refuse: cloud/registry credentials present in environment" >&2
  exit 1
fi

root="${1:-/workspace}"
cd "$root"

# 2. Initialise providers only — -backend=false is enforced here, not by convention.
terraform init -backend=false -input=false

# 3. Emit the provider schema as JSON on stdout for the orchestrator to capture.
terraform providers schema -json
