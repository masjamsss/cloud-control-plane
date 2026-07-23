#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# apply-window-gate.sh — the CI wrapper around `catalogctl window-check`
# (proposal 0024 §3.2/§3.3). It is the ONE place the scheduling pipeline reads
# the wall clock: it stamps `now` and injects it into window-check as `--at`,
# keeping every line of time logic in unit-tested Go (window-check reads no
# clock at all). This script only orchestrates — locate, freeze, map, annotate:
#
#   1. Locate the request: an explicit --request PATH, or the single
#      requests/REQ-*.yaml inside a --bundle DIR. No REQ in the bundle ⇒ the
#      gate is INERT (exit 0) — an ordinary, non-ccp push carries none.
#   2. Freeze veto FIRST (0024 §0.2, §3.5): the api's freeze state is invisible
#      to CI, so it is mirrored as the CCP_FREEZE repo variable. Truthy ⇒
#      REFUSE (exit 7) before the window is even consulted — freeze is absolute.
#   3. Otherwise run `window-check --request REQ --at <now> --estate-tz <tz>` and
#      map its verdict to this script's exit code + a GitHub ::error:: annotation
#      + a $GITHUB_STEP_SUMMARY block. --estate-tz is projected the same way as
#      CCP_FREEZE above: the estate account repo's CCP_ESTATE_TZ variable
#      (estate-config, ADR-0028; default "UTC" when unset — the blank-install
#      estate names no zone, spec §7).
#
# It is deterministic and offline (no AWS, no GitHub, no api): given --now it is
# fully reproducible, which is what makes it unit-testable against the
# tools/catalogctl/testdata/windows fixtures (see windowgate_test.go) — the
# workflow invokes the exact script the test exercises.
#
# Usage:
#   scripts/ci/apply-window-gate.sh \
#       (--request REQ.yaml | --bundle DIR) \
#       [--now RFC3339] [--catalogctl BIN]
#
# Env (mirrors estate state into CI; both optional, both default safe):
#   CCP_FREEZE      truthy (true/1/yes/on) ⇒ FROZEN veto (step 2 above).
#   CCP_ESTATE_TZ   the estate's configured operating timezone (IANA name);
#                      passed to window-check as --estate-tz. Unset ⇒ "UTC" (the
#                      blank-install default, estate-config ADR-0028).
#
# Exit codes (window-check's, plus the freeze veto):
#   0  in window (or no window) AND cooled AND not frozen → apply may proceed
#   5  BEFORE_WINDOW   (not yet: cooling and/or window)    → window-check exit 5
#   6  WINDOW_EXPIRED  (now >= end)                        → window-check exit 6
#   3  SCHEDULE_INVALID (malformed window/earliest, incl. an estate-tz mismatch or
#                        an unresolvable CCP_ESTATE_TZ) → window-check exit 3
#   7  FROZEN          (CCP_FREEZE truthy)             → freeze veto
#   1  usage / internal error
# ---------------------------------------------------------------------------
set -euo pipefail

REQUEST="" BUNDLE="" NOW="" CATALOGCTL=""

die() { echo "apply-window-gate: $*" >&2; exit 1; }

# is_truthy treats true/1/yes/on (any case) as set; everything else — including
# empty/unset — as not frozen.
is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

annotate() { echo "::error::$*" >&2; }
summary()  { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%b\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --request)    REQUEST="${2:-}"; shift 2 ;;
    --bundle)     BUNDLE="${2:-}"; shift 2 ;;
    --now)        NOW="${2:-}"; shift 2 ;;
    --catalogctl) CATALOGCTL="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,47p' "$0"; exit 0 ;;
    *)            die "unknown flag: $1" ;;
  esac
done

# --- 1. locate the request (explicit --request, or the single REQ in --bundle) ---
if [ -z "$REQUEST" ] && [ -n "$BUNDLE" ]; then
  [ -d "$BUNDLE" ] || die "bundle dir not found: $BUNDLE"
  shopt -s nullglob
  reqs=("$BUNDLE"/requests/REQ-*.yaml)
  shopt -u nullglob
  if [ ${#reqs[@]} -eq 0 ]; then
    echo "apply-window-gate: no requests/REQ-*.yaml in $BUNDLE — nothing to gate (inert)" >&2
    exit 0
  fi
  [ ${#reqs[@]} -eq 1 ] || die "expected exactly one requests/REQ-*.yaml in $BUNDLE, found ${#reqs[@]} (${reqs[*]})"
  REQUEST="${reqs[0]}"
fi
[ -n "$REQUEST" ] || die "--request PATH or --bundle DIR is required"
[ -f "$REQUEST" ] || die "request file not found: $REQUEST"

# --- 2. freeze is the absolute veto, evaluated FIRST (0024 §0.2, §3.5) --------
# Precedes the window so a frozen estate refuses regardless of whether the window
# is open. Fail-safe drift (variable set / app unfrozen) only over-refuses.
if is_truthy "${CCP_FREEZE:-}"; then
  echo "apply-window-gate: REFUSE FROZEN — CCP_FREEZE=${CCP_FREEZE:-}" >&2
  annotate "ccp change freeze active (CCP_FREEZE) — apply refused regardless of the window (0024 §0.2/§3.5). Lift the freeze in the portal AND reset the variable to proceed."
  summary "### ccp/window — FROZEN\n\nA change freeze is active (\`CCP_FREEZE\`). Apply refused regardless of the window."
  exit 7
fi

# --- 3. now: the ONLY wall-clock read in the pipeline (0024 §3.2/§3.3) --------
# window-check itself reads no clock; the runner's NTP-synced UTC is authoritative.
if [ -z "$NOW" ]; then
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

# --- resolve catalogctl (prebuilt bin via --catalogctl, or `go run` from root) ---
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# ESTATE_TZ mirrors CCP_FREEZE's projection above: the estate account repo sets
# the CCP_ESTATE_TZ variable; unset ⇒ "UTC" (estate-config, ADR-0028, spec §7).
ESTATE_TZ="${CCP_ESTATE_TZ:-UTC}"
run_windowcheck() {
  if [ -n "$CATALOGCTL" ]; then
    "$CATALOGCTL" window-check --request "$REQUEST" --at "$NOW" --estate-tz "$ESTATE_TZ"
  else
    ( cd "$ROOT/tools/catalogctl" && go run ./cmd/catalogctl window-check --request "$REQUEST" --at "$NOW" --estate-tz "$ESTATE_TZ" )
  fi
}

# --- run window-check; capture the machine verdict (stdout) and reason (stderr) ---
out="$(mktemp)"; errf="$(mktemp)"
trap 'rm -f "$out" "$errf"' EXIT
set +e
run_windowcheck >"$out" 2>"$errf"
rc=$?
set -e
verdict_line="$(cat "$out")"
reason="$(cat "$errf")"
[ -n "$reason" ] && echo "$reason" >&2

# --- map window-check's verdict → this gate's exit code + annotation ----------
case "$rc" in
  0)
    echo "apply-window-gate: PASS — ${verdict_line}" >&2
    summary "### ccp/window — in window\n\n\`${verdict_line}\`"
    exit 0 ;;
  5)
    annotate "not yet in the apply window — ${reason#window-check: }"
    summary "### ccp/window — not yet\n\n\`${verdict_line}\`\n\n${reason#window-check: }"
    exit 5 ;;
  6)
    annotate "apply window has expired — ${reason#window-check: }"
    summary "### ccp/window — expired\n\n\`${verdict_line}\`\n\n${reason#window-check: } Re-window in the portal (bundle refresh required, 0024 §2.4) or close this PR."
    exit 6 ;;
  3)
    annotate "malformed schedule — window gate fails closed — ${reason#window-check: }"
    summary "### ccp/window — schedule invalid\n\n${reason#window-check: }"
    exit 3 ;;
  *)
    die "window-check exited with unexpected code ${rc}: ${reason}" ;;
esac
