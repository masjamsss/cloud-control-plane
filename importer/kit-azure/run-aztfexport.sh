#!/usr/bin/env bash
# run-aztfexport.sh — pinned, READ-ONLY, STATE-FREE wrapper around Microsoft's aztfexport.
#
# NEW component with no AWS analog. The kit delegates ONLY schema-accurate HCL-BODY generation
# to aztfexport; it never lets aztfexport do anything else. Two hard safety properties:
#   1. STATE-FREE. aztfexport's DEFAULT mode runs `terraform import` and writes state. This
#      wrapper ALWAYS passes --hcl-only (bodies only, no state), and afterward REFUSES if any
#      *.tfstate appeared in the output dir — a read-only regression tripwire (the flag could
#      be dropped by an upstream default change; the tripwire catches it anyway).
#   2. NO IMPORT BLOCKS. gen-imports.py is the SOLE emitter of imports.tf (secret-free by
#      construction). This wrapper never passes --generate-import-block.
#
# Usage:
#   run-aztfexport.sh --mode mapping|hcl --out-dir D --scope-kind resource-group|query
#                     --scope S [--provider azurerm|azapi]
#
#   mode mapping  discovery only: emit aztfexportResourceMapping.json for reconcile.py (no bodies)
#   mode hcl      emit HCL bodies (--hcl-only) for the curated scope
#
# AZTFEXPORT_BIN overrides the binary (tests point it at testdata/stub-bin/aztfexport), so this
# script's logic is fixture-testable with zero Azure and zero real aztfexport.
set -uo pipefail

AZTFEXPORT_BIN="${AZTFEXPORT_BIN:-aztfexport}"
# keep in lockstep with templates/versions.tf (the exact azurerm pin)
PROVIDER_VERSION="${AZTFEXPORT_PROVIDER_VERSION:-4.14.0}"
MODE="" OUT_DIR="" SCOPE_KIND="" SCOPE="" PROVIDER="azurerm"

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)       MODE="$2"; shift 2 ;;
    --out-dir)    OUT_DIR="$2"; shift 2 ;;
    --scope-kind) SCOPE_KIND="$2"; shift 2 ;;
    --scope)      SCOPE="$2"; shift 2 ;;
    --provider)   PROVIDER="$2"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "REFUSE BAD_ARG: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done

case "$MODE" in mapping|hcl) ;; *) echo "REFUSE BAD_ARG: --mode must be mapping or hcl" >&2; exit 2 ;; esac
[ -n "$OUT_DIR" ] || { echo "REFUSE BAD_ARG: --out-dir is required" >&2; exit 2; }
case "$SCOPE_KIND" in resource-group|query) ;; *) echo "REFUSE BAD_ARG: --scope-kind must be resource-group or query" >&2; exit 2 ;; esac
[ -n "$SCOPE" ] || { echo "REFUSE BAD_ARG: --scope is required" >&2; exit 2; }
case "$PROVIDER" in azurerm|azapi) ;; *) echo "REFUSE BAD_ARG: --provider must be azurerm or azapi" >&2; exit 2 ;; esac
command -v "$AZTFEXPORT_BIN" >/dev/null 2>&1 || { echo "REFUSE MISSING_DEP: aztfexport not found" >&2; exit 2; }

mkdir -p "$OUT_DIR"
export AZTFEXPORT_TELEMETRY_ENABLED=false

# --hcl-only is ALWAYS present: bodies only, never a `terraform import` into state.
common=(--non-interactive --overwrite --hcl-only
        --provider-name "$PROVIDER" --provider-version "$PROVIDER_VERSION" --output-dir "$OUT_DIR")

if [ "$MODE" = "mapping" ]; then
  "$AZTFEXPORT_BIN" "$SCOPE_KIND" "${common[@]}" --generate-mapping-file "$SCOPE" \
    || { echo "REFUSE AZTFEXPORT_FAILED: mapping-file generation failed" >&2; exit 2; }
else
  "$AZTFEXPORT_BIN" "$SCOPE_KIND" "${common[@]}" "$SCOPE" \
    || { echo "REFUSE AZTFEXPORT_FAILED: hcl generation failed" >&2; exit 2; }
fi

# ── read-only tripwire: aztfexport must NEVER have produced terraform state ──────────────────
if [ -f "$OUT_DIR/terraform.tfstate" ] || ls "$OUT_DIR"/*.tfstate >/dev/null 2>&1; then
  echo "REFUSE STATE_WRITTEN: aztfexport produced a terraform state file in $OUT_DIR — the kit is" >&2
  echo "  hcl-only by contract; a state file means --hcl-only was bypassed. Nothing is trusted here." >&2
  exit 2
fi
echo "aztfexport ($MODE) complete: $OUT_DIR (hcl-only, no state written)"
