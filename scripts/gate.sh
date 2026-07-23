#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Local pre-push gate — mirrors the GitHub Actions workflows (catalogctl,
# ccp-api, ccp-app, terraform) so a failing check is caught in seconds
# LOCALLY instead of minutes of Actions time (and a red PR).
#
# Usage:
#   scripts/gate.sh              # fast gates: go + api + app + tf-fmt  (default)
#   scripts/gate.sh all          # same as default
#   scripts/gate.sh full         # + terraform validate + checkov/tflint
#                                #   + the ccp install smoke (run-local.sh --smoke) if Node >= 22
#   scripts/gate.sh go|api|app|tf|smoke # run just one section
#
# Exit code is non-zero if ANY selected gate fails — so it composes:
#   scripts/gate.sh && git push
# ---------------------------------------------------------------------------
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-all}"
FAIL=0
SUMMARY=""

section() { printf "\n\033[1m\033[36m━━ %s ━━\033[0m\n" "$1"; }
step()    { printf "  \033[2m· %s\033[0m\n" "$1"; }
record()  { # $1=name $2=rc
  if [ "$2" -eq 0 ]; then SUMMARY+=$'\n'"  \033[32m✓ PASS\033[0m  $1"
  else SUMMARY+=$'\n'"  \033[31m✗ FAIL\033[0m  $1"; FAIL=1; fi
}
have()    { command -v "$1" >/dev/null 2>&1; }
ensure_deps() { [ -d node_modules ] || { step "npm ci (node_modules missing)"; npm ci --silent; }; }

gate_go() {
  section "catalogctl (Go)"
  ( cd tools/catalogctl
    step "go build" && go build ./... \
    && step "go vet" && go vet ./... \
    && step "go test" && go test ./... \
    && step "gofmt" && [ -z "$(gofmt -l internal/)" ]
  ); record "catalogctl: build/vet/test/gofmt" $?
}

gate_api() {
  section "ccp-api (Node)"
  ( cd ccp/api && ensure_deps
    step "typecheck" && npm run --silent typecheck \
    && step "test" && npm test --silent
  ); record "ccp-api: typecheck/test" $?
}

gate_app() {
  section "ccp-app (Node)"
  # Deterministic gates — reliable across Node versions.
  ( cd ccp/app && ensure_deps
    step "typecheck" && npm run --silent typecheck \
    && step "test" && npm test --silent \
    && step "build" && npm run --silent build \
    && step "contrast" && npm run --silent contrast \
    && step "help:check" && npm run --silent help:check \
    && step "verify:safety" && npm run --silent verify:safety
  ); record "ccp-app: typecheck/test/build/contrast/help/safety" $?

  # eslint (plugin resolution) and prettier (config load) are Node-RUNTIME
  # sensitive: CI pins Node 20, and on a different local major they emit false
  # failures ("rule not found", spurious format diffs). Only run them when the
  # local major matches CI's; otherwise CI is authoritative (a cheap ~50s job).
  local nmaj; nmaj="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  if [ "$nmaj" = "20" ]; then
    ( cd ccp/app && step "lint" && npm run --silent lint && step "format:check" && npm run --silent format:check
    ); record "ccp-app: lint/format" $?
  else
    step "lint/format SKIPPED — local Node $nmaj != CI Node 20 (eslint/prettier unreliable here)"
    SUMMARY+=$'\n'"  \033[33m~ SKIP\033[0m  ccp-app: lint/format (Node $nmaj!=20 — CI authoritative)"
  fi
}

gate_smoke() {
  section "ccp install smoke (run-local.sh --smoke)"
  # Boots the REAL stack docker-free: SPA built in api-mode, api in production
  # posture on a throwaway store, /readyz asserted 200, then teardown. Node >= 22
  # required (api engines) — on older majors CI (ccp-smoke.yml) is authoritative.
  local nmaj; nmaj="$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')"
  if [ -z "$nmaj" ] || [ "$nmaj" -lt 22 ]; then
    step "SKIPPED — local Node ${nmaj:-none} < 22 (api engines); CI runs it (ccp-smoke.yml)"
    SUMMARY+=$'\n'"  \033[33m~ SKIP\033[0m  ccp smoke (Node ${nmaj:-none} < 22 — CI authoritative)"
    return
  fi
  ( step "run-local.sh --smoke"
    LOG="$(mktemp)"
    if ccp/scripts/run-local.sh --smoke >"$LOG" 2>&1; then rm -f "$LOG"
    else echo "--- smoke output (tail) ---"; tail -30 "$LOG"; rm -f "$LOG"; exit 1; fi
  ); record "ccp: install smoke (build + boot + /readyz)" $?
}

gate_tf() {
  section "terraform (real infra only — fixtures are intentionally malformed)"
  if ! have terraform; then step "terraform not installed — SKIP"; record "terraform: (skipped, not installed)" 0; return; fi

  # environments/ is a real estate tree — this public repo ships none (a
  # deployment supplies its own); [ -d "$root" ] || continue below is the same
  # no-estate-tree idea applied per-root. importer/ DOES ship here (templates
  # + tests), so its fmt check still runs either way.
  if [ -d environments ]; then
    ( step "fmt environments" && terraform fmt -check -recursive environments \
      && step "fmt importer" && terraform fmt -check -recursive importer
    ); record "terraform: fmt (real infra)" $?
  else
    step "fmt environments SKIPPED — environments/ absent (this repo ships no estate tree; a deployment adds its own)"
    SUMMARY+=$'\n'"  \033[33m~ SKIP\033[0m  terraform: fmt environments (no environments/ in this repo)"
    ( step "fmt importer" && terraform fmt -check -recursive importer
    ); record "terraform: fmt importer" $?
  fi

  if [ "$MODE" = "full" ]; then
    for root in environments/prod importer/prod importer/bootstrap; do
      [ -d "$root" ] || continue
      ( cd "$root" && step "validate $root" && terraform init -backend=false -input=false >/dev/null 2>&1 && terraform validate >/dev/null
      ); record "terraform validate: $root" $?
    done
    if have checkov; then
      if [ -f .checkov.yaml ] && [ -f .checkov.baseline ]; then
        ( step "checkov" && checkov --config-file .checkov.yaml --directory . --baseline .checkov.baseline --compact >/dev/null
        ); record "checkov" $?
      else
        step "checkov SKIPPED — .checkov.yaml/.checkov.baseline absent (this repo ships no estate tree)"
        SUMMARY+=$'\n'"  \033[33m~ SKIP\033[0m  checkov (no .checkov.yaml/.checkov.baseline in this repo)"
      fi
    else step "checkov not installed — SKIP (runs in CI)"; fi

    # (data-birth, 2026-07-21: the portal-data-freshness local mirror that used
    # to run here — regenerating inventory.json + block chunks and diffing them
    # against the committed copy — is retired. ccp/app/src/data/inventory.json
    # + blocks/ are no longer product-shaped default data kept fresh by this gate;
    # per-account estate data now arrives at runtime through onboarding and is
    # kept fresh by that account's own CI (ccp-data.yml,
    # docs/runbooks/account-data-ci.md), never by a committed-copy diff. See
    # docs/superpowers/specs/2026-07-21-ccp-data-birth-generic-onboarding.md §4.2.)
  fi
}

case "$MODE" in
  go)  gate_go ;;
  api) gate_api ;;
  app) gate_app ;;
  tf)  gate_tf ;;
  smoke) gate_smoke ;;
  all|full) gate_go; gate_api; gate_app; gate_tf; [ "$MODE" = "full" ] && gate_smoke ;;
  *) echo "unknown mode: $MODE (use: all|full|go|api|app|tf|smoke)"; exit 2 ;;
esac

printf "\n\033[1m━━ gate summary ━━\033[0m"
printf "%b\n" "$SUMMARY"
if [ "$FAIL" -eq 0 ]; then printf "\n\033[1m\033[32m✓ all selected gates passed — safe to push\033[0m\n"
else printf "\n\033[1m\033[31m✗ gate failed — fix before pushing (this is what CI would reject)\033[0m\n"; fi
exit $FAIL
