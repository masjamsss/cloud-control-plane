#!/usr/bin/env bash
# discover.sh — LIVE capture driver for a new environment's discovery.
#
# This is the ONLY file in the kit that talks to AWS, and it only ever runs
# read-only `aws ... list/describe` commands (the exact command list is data:
# services.json `cli` fields, enumerated via `discover.py plan-commands` — bash
# never parses JSON). Everything downstream (discover.py build, gen-imports.py,
# normalize.py) is offline and fixture-tested; this script's own logic is
# testable without AWS via --dry-run or a stub `aws` on PATH (see
# tests/test_scripts.py).
#
# Usage:
#   discover.sh --region <region> --account <12-digit id> --out <capture-dir>
#               [--services <services.json>] [--dry-run]
#
# Behavior:
#   1. refuses unless `aws sts get-caller-identity` reports EXACTLY --account
#      (ACCOUNT_MISMATCH guard — a wrong-profile capture must die here, not
#      surface as a confusing manifest later)
#   2. runs each allowlisted read-only list call, saving raw JSON into
#      <capture-dir>/<capture>.json
#   3. ALSO runs one account-wide coverage sweep — read-only, paginated
#      `aws resourcegroupstaggingapi get-resources` — into <capture-dir>/
#      coverage-resources.json, through the exact same AWS_BIN seam and
#      capture loop as every allowlisted call above (it is appended to the
#      capture plan, not special-cased). discover.py build diffs its ARN
#      service families against services.json so a resource type OUTSIDE the
#      44-type allowlist is a loud manifest WARN, never invisible (the kit's
#      refuse-never-silent doctrine applied to coverage itself — see
#      README.md "coverage sweep"). Taggable resources only: anything AWS
#      does not expose to the tagging API is still a gap this cannot see.
#   4. writes capture-meta.json (account/region/capturedAt provenance)
#   5. builds <capture-dir>/discovery-manifest.json via discover.py build
#
# Credentials: a READ-ONLY principal (e.g. arn:aws:iam::aws:policy/ReadOnlyAccess).
# Nothing here can mutate; still, never point it at creds with write access.
# The capture dir contains real resource IDs — keep it in importer/kit/work/
# (gitignored) or outside the repo entirely.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
AWS_BIN="${AWS_BIN:-aws}"

REGION="" ACCOUNT="" OUT="" SERVICES="$KIT_DIR/services.json" DRY_RUN=0

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --region)   REGION="$2"; shift 2 ;;
    --account)  ACCOUNT="$2"; shift 2 ;;
    --out)      OUT="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "REFUSE BAD_ARG: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done

[ -n "$REGION" ]  || { echo "REFUSE BAD_ARG: --region is required" >&2; exit 2; }
[ -n "$ACCOUNT" ] || { echo "REFUSE BAD_ARG: --account is required" >&2; exit 2; }
[ -n "$OUT" ]     || { echo "REFUSE BAD_ARG: --out is required" >&2; exit 2; }
case "$ACCOUNT" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) echo "REFUSE BAD_ARG: --account must be a 12-digit account id" >&2; exit 2 ;;
esac

command -v "$PYTHON" >/dev/null 2>&1 || { echo "REFUSE MISSING_DEP: $PYTHON not found" >&2; exit 2; }

# Enumerate the read-only command list from the allowlist (data, not code).
PLAN="$("$PYTHON" "$KIT_DIR/discover.py" plan-commands --services "$SERVICES" --region "$REGION")" \
  || { echo "REFUSE BAD_SERVICES: discover.py plan-commands failed" >&2; exit 2; }

# Account-wide coverage sweep (Gap 1): NOT a services.json type (it has no
# single resource type — it is every taggable resource in the account/region,
# in one read-only paginated call), so it is appended to the plan here rather
# than added to services.json's allowlist. Appending to $PLAN — instead of a
# parallel code path — is deliberate: it means this capture gets the exact
# same --dry-run preview, AWS_BIN seam, and FAILED/PARTIAL_CAPTURE accounting
# as every allowlisted capture below, for free, with nothing to keep in sync.
# The AWS CLI paginates get-resources itself (same as every other capture
# here relies on default CLI pagination for a large account) — one call,
# every page merged into one JSON document.
COVERAGE_CAPTURE="coverage-resources"
COVERAGE_CLI="aws resourcegroupstaggingapi get-resources --output json --region $REGION"
PLAN="$(printf '%s\n%s\t%s' "$PLAN" "$COVERAGE_CAPTURE" "$COVERAGE_CLI")"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run: would verify caller identity is account $ACCOUNT, then record:"
  printf '%s\n' "$PLAN" | while IFS="$(printf '\t')" read -r capture cmd; do
    [ -n "$capture" ] || continue
    echo "  $cmd  ->  $OUT/$capture.json"
  done
  echo "dry-run: then capture-meta.json + discover.py build -> $OUT/discovery-manifest.json"
  exit 0
fi

command -v "$AWS_BIN" >/dev/null 2>&1 || { echo "REFUSE MISSING_DEP: aws CLI not found" >&2; exit 2; }

# ── account guard: the caller identity MUST be the requested account ─────────
CALLER_ACCOUNT="$("$AWS_BIN" sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || { echo "REFUSE NO_CREDENTIALS: aws sts get-caller-identity failed — no (or expired) credentials" >&2; exit 2; }
if [ "$CALLER_ACCOUNT" != "$ACCOUNT" ]; then
  echo "REFUSE ACCOUNT_MISMATCH: credentials belong to account $CALLER_ACCOUNT, not $ACCOUNT — wrong profile?" >&2
  exit 2
fi

mkdir -p "$OUT"
FAILED=""
printf '%s\n' "$PLAN" > "$OUT/.capture-plan.tsv"
while IFS="$(printf '\t')" read -r capture cmd; do
  [ -n "$capture" ] || continue
  # Every allowlisted line MUST be an `aws ...` read-only call; anything else
  # in services.json is refused rather than executed. The leading word is
  # replaced by $AWS_BIN so a stub/test binary governs EVERY invocation, not
  # just the sts identity check.
  case "$cmd" in
    "aws "*) ;;
    *) echo "REFUSE BAD_SERVICES: cli for capture '$capture' does not start with 'aws ': $cmd" >&2; exit 2 ;;
  esac
  rest="${cmd#aws }"
  echo "capture: $capture"
  # shellcheck disable=SC2086 — $rest is the allowlisted read-only CLI argument line
  if ! "$AWS_BIN" $rest > "$OUT/$capture.json" 2>"$OUT/$capture.stderr"; then
    FAILED="$FAILED $capture"
    rm -f "$OUT/$capture.json"
    echo "  FAILED (stderr kept at $OUT/$capture.stderr)" >&2
  else
    rm -f "$OUT/$capture.stderr"
  fi
done < "$OUT/.capture-plan.tsv"
rm -f "$OUT/.capture-plan.tsv"

CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$OUT/capture-meta.json" <<EOF
{
  "account": "$ACCOUNT",
  "region": "$REGION",
  "capturedAt": "$CAPTURED_AT",
  "tool": "importer/kit/discover.sh"
}
EOF

"$PYTHON" "$KIT_DIR/discover.py" build \
  --capture-dir "$OUT" --services "$SERVICES" \
  --require-account "$ACCOUNT" --out "$OUT/discovery-manifest.json" || exit $?

if [ -n "$FAILED" ]; then
  echo "REFUSE PARTIAL_CAPTURE: these listings failed:$FAILED" >&2
  echo "  (their types appear under missing_captures in the manifest; fix IAM/region and re-run)" >&2
  exit 2
fi
echo "capture complete: $OUT/discovery-manifest.json"
