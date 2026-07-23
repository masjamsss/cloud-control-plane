#!/usr/bin/env bash
# discover.sh — LIVE capture driver for a new Azure environment's discovery.
#
# The Azure sibling of importer/kit/discover.sh. This is the ONLY file in the kit that
# talks to Azure, and it only ever runs the READ-ONLY `az graph query` verb (Azure Resource
# Graph) plus a read-only `az account show` identity check. The queries themselves are DATA
# (azure-services.json graphCaptures[].kql, enumerated via `discover.py plan-commands`); bash
# never parses JSON — the skip-token paging loop reads each page's continuation token back
# through `discover.py next-token`. Everything downstream (discover.py build, gen-imports.py,
# reconcile.py, normalize.py) is offline and fixture-tested; this script's own logic is
# testable without Azure via --dry-run or a stub `az` on PATH (see tests/test_scripts.py).
#
# Usage:
#   discover.sh --subscription <guid> --tenant <guid> --out <capture-dir>
#               [--location <region>] [--services <azure-services.json>] [--dry-run]
#   discover.sh --list-subscriptions --tenant <guid> [--dry-run]
#               enumerate every subscription the Reader can see in the tenant (with its
#               management-group chain) — the per-subscription iteration list. A tenant spans
#               MANY subscriptions; the kit imports ONE per run, so run this first, then run the
#               import once per subscription (distinct --out / env root / state key each).
#
# Behavior:
#   1. refuses unless `az account show` reports EXACTLY --subscription AND --tenant
#      (SUBSCRIPTION_MISMATCH / TENANT_MISMATCH guard — Azure has no single "account"
#      primitive, so BOTH axes are checked; a wrong-subscription or wrong-tenant capture
#      must die here, not surface as a confusing manifest later). `az account set
#      --subscription <guid>` first if the active subscription is wrong.
#   2. runs each fixed ARG capture as a read-only, paginated `az graph query`, saving each
#      page as <capture-dir>/<capture>.page<N>.json. ARG pages at 1000 rows; the skip-token
#      loop follows every page (limit/take/sample are refused in a kql upstream so the token
#      is never suppressed — the silent-1000-row-truncation guard). The primary `resources`
#      query is BOTH the resource source and the account-wide coverage sweep (Azure Resource
#      Graph sees all ARM control-plane resources, not just taggable ones).
#   3. writes capture-meta.json (subscription/tenant/location/capturedAt provenance)
#   4. builds <capture-dir>/discovery-manifest.json via discover.py build, which re-checks
#      the subscription+tenant offline (--require-subscription/--require-tenant)
#
# Credentials: a READ-ONLY principal — the built-in Reader role (Actions:*/read, no
# DataActions, so it cannot even read Key Vault values or blob contents). Nothing here can
# mutate; still, never point it at a principal with write access. The capture dir contains
# real resource ids — keep it in importer/kit-azure/work/ (gitignored) or outside the repo.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
AZ_BIN="${AZ_BIN:-az}"

SUBSCRIPTION="" TENANT="" OUT="" LOCATION="unknown" SERVICES="$KIT_DIR/azure-services.json" DRY_RUN=0 LIST_SUBS=0

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; }

is_guid() { case "$1" in
  [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) return 0 ;;
  *) return 1 ;;
esac ; }

while [ $# -gt 0 ]; do
  case "$1" in
    --subscription) SUBSCRIPTION="$2"; shift 2 ;;
    --tenant)       TENANT="$2"; shift 2 ;;
    --out)          OUT="$2"; shift 2 ;;
    --location)     LOCATION="$2"; shift 2 ;;
    --services)     SERVICES="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --list-subscriptions) LIST_SUBS=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "REFUSE BAD_ARG: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done

# ── --list-subscriptions: enumerate subscriptions in the tenant (read-only, tenant-wide) ─────
# A tenant/estate spans many subscriptions (often under one management group); the import runs
# ONE subscription per run, so this lists them all so estate-level coverage is loud. It queries
# only the ResourceContainers table (subscription metadata) tenant-wide — NOT resources — so it
# does not widen resource discovery beyond the committed single-subscription scope.
if [ "$LIST_SUBS" -eq 1 ]; then
  SUBS_KQL="ResourceContainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, name, tenantId, mgChain = properties.managementGroupAncestorsChain | order by name asc"
  [ -n "$TENANT" ] || { echo "REFUSE BAD_ARG: --list-subscriptions requires --tenant" >&2; exit 2; }
  is_guid "$TENANT" || { echo "REFUSE BAD_ARG: --tenant must be an 8-4-4-4-12 GUID" >&2; exit 2; }
  command -v "$PYTHON" >/dev/null 2>&1 || { echo "REFUSE MISSING_DEP: $PYTHON not found" >&2; exit 2; }
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "dry-run: would verify the active tenant is $TENANT, then run (read-only, tenant-wide):"
    echo "  az graph query -q \"$SUBS_KQL\" --first 1000 --output json"
    exit 0
  fi
  command -v "$AZ_BIN" >/dev/null 2>&1 || { echo "REFUSE MISSING_DEP: az CLI not found" >&2; exit 2; }
  IDENT="$("$AZ_BIN" account show --query "[id,tenantId]" --output tsv 2>/dev/null)" \
    || { echo "REFUSE NO_CREDENTIALS: az account show failed — no (or expired) credentials; run 'az login'" >&2; exit 2; }
  ACTIVE_TENANT="$(printf '%s' "$IDENT" | cut -f2)"
  if [ "$ACTIVE_TENANT" != "$TENANT" ]; then
    echo "REFUSE TENANT_MISMATCH: active tenant is $ACTIVE_TENANT, not $TENANT — wrong directory?" >&2
    exit 2
  fi
  SUBS_TMP="$(mktemp "${TMPDIR:-/tmp}/kit-subs.XXXXXX")"
  trap 'rm -f "$SUBS_TMP"' EXIT
  if ! "$AZ_BIN" graph query -q "$SUBS_KQL" --first 1000 --output json >"$SUBS_TMP" 2>/dev/null; then
    echo "REFUSE LIST_FAILED: az graph query for subscriptions failed" >&2; exit 2
  fi
  "$PYTHON" "$KIT_DIR/discover.py" list-subscriptions --capture "$SUBS_TMP" --tenant "$TENANT"
  exit $?
fi

[ -n "$SUBSCRIPTION" ] || { echo "REFUSE BAD_ARG: --subscription is required" >&2; exit 2; }
[ -n "$TENANT" ]       || { echo "REFUSE BAD_ARG: --tenant is required" >&2; exit 2; }
[ -n "$OUT" ]          || { echo "REFUSE BAD_ARG: --out is required" >&2; exit 2; }
is_guid "$SUBSCRIPTION" || { echo "REFUSE BAD_ARG: --subscription must be an 8-4-4-4-12 GUID" >&2; exit 2; }
is_guid "$TENANT"       || { echo "REFUSE BAD_ARG: --tenant must be an 8-4-4-4-12 GUID" >&2; exit 2; }

command -v "$PYTHON" >/dev/null 2>&1 || { echo "REFUSE MISSING_DEP: $PYTHON not found" >&2; exit 2; }

# Enumerate the fixed ARG capture list from the allowlist (data, not code).
PLAN="$("$PYTHON" "$KIT_DIR/discover.py" plan-commands --services "$SERVICES")" \
  || { echo "REFUSE BAD_SERVICES: discover.py plan-commands failed" >&2; exit 2; }

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run: would verify the active subscription is $SUBSCRIPTION and tenant is $TENANT, then record:"
  printf '%s\n' "$PLAN" | while IFS="$(printf '\t')" read -r capture kql; do
    [ -n "$capture" ] || continue
    echo "  az graph query -q \"$kql\" --first 1000 --output json --subscriptions $SUBSCRIPTION  ->  $OUT/$capture.page<N>.json"
  done
  echo "dry-run: then capture-meta.json + discover.py build -> $OUT/discovery-manifest.json"
  exit 0
fi

command -v "$AZ_BIN" >/dev/null 2>&1 || { echo "REFUSE MISSING_DEP: az CLI not found" >&2; exit 2; }

# ── identity guard: the ACTIVE subscription AND tenant MUST be the requested ones ───────────
# One read-only `az account show`, both fields extracted server-side via JMESPath (no bash
# JSON parsing) into a single TAB-separated line.
IDENT="$("$AZ_BIN" account show --query "[id,tenantId]" --output tsv 2>/dev/null)" \
  || { echo "REFUSE NO_CREDENTIALS: az account show failed — no (or expired) credentials; run 'az login'" >&2; exit 2; }
ACTIVE_SUB="$(printf '%s' "$IDENT" | cut -f1)"
ACTIVE_TENANT="$(printf '%s' "$IDENT" | cut -f2)"
if [ "$ACTIVE_SUB" != "$SUBSCRIPTION" ]; then
  echo "REFUSE SUBSCRIPTION_MISMATCH: active subscription is $ACTIVE_SUB, not $SUBSCRIPTION — run 'az account set --subscription $SUBSCRIPTION'" >&2
  exit 2
fi
if [ "$ACTIVE_TENANT" != "$TENANT" ]; then
  echo "REFUSE TENANT_MISMATCH: active tenant is $ACTIVE_TENANT, not $TENANT — wrong directory?" >&2
  exit 2
fi

mkdir -p "$OUT"
FAILED=""
printf '%s\n' "$PLAN" > "$OUT/.capture-plan.tsv"
while IFS="$(printf '\t')" read -r capture kql; do
  [ -n "$capture" ] || continue
  echo "capture: $capture"
  page=0
  skip=""
  ok=1
  while :; do
    pagefile="$OUT/$capture.page$page.json"
    if [ -z "$skip" ]; then
      "$AZ_BIN" graph query -q "$kql" --first 1000 --output json --subscriptions "$SUBSCRIPTION" \
        > "$pagefile" 2>"$OUT/$capture.stderr" || ok=0
    else
      "$AZ_BIN" graph query -q "$kql" --first 1000 --output json --subscriptions "$SUBSCRIPTION" --skip-token "$skip" \
        > "$pagefile" 2>"$OUT/$capture.stderr" || ok=0
    fi
    if [ "$ok" -eq 0 ]; then
      FAILED="$FAILED $capture"
      rm -f "$OUT/$capture".page*.json
      echo "  FAILED (stderr kept at $OUT/$capture.stderr)" >&2
      break
    fi
    skip="$("$PYTHON" "$KIT_DIR/discover.py" next-token --page "$pagefile" 2>/dev/null)"
    [ -n "$skip" ] || break
    page=$((page + 1))
  done
  [ "$ok" -eq 1 ] && rm -f "$OUT/$capture.stderr"
done < "$OUT/.capture-plan.tsv"
rm -f "$OUT/.capture-plan.tsv"

CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$OUT/capture-meta.json" <<EOF
{
  "subscription": "$SUBSCRIPTION",
  "tenant": "$TENANT",
  "location": "$LOCATION",
  "capturedAt": "$CAPTURED_AT",
  "tool": "importer/kit-azure/discover.sh"
}
EOF

"$PYTHON" "$KIT_DIR/discover.py" build \
  --capture-dir "$OUT" --services "$SERVICES" \
  --require-subscription "$SUBSCRIPTION" --require-tenant "$TENANT" \
  --out "$OUT/discovery-manifest.json" || exit $?

if [ -n "$FAILED" ]; then
  echo "REFUSE PARTIAL_CAPTURE: these captures failed:$FAILED" >&2
  echo "  (their types appear under missing_captures in the manifest; fix RBAC/scope and re-run)" >&2
  exit 2
fi
echo "capture complete: $OUT/discovery-manifest.json"
