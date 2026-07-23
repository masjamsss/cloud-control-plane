#!/usr/bin/env bash
#
# gen.sh — regenerate a tools/schemadump/<provider>-<tag>-schema.json.
#
# Pipeline (see README.md and docs/proposals/0013d G0, 0039 F1/F2):
#   1. Acquire the provider SOURCE at the pinned tag (git clone). HashiCorp
#      does NOT follow Go semantic-import-versioning for either provider used
#      here: the module path in go.mod has no /vN suffix, so
#      `go mod download .../vN@<tag>` CANNOT work — a source checkout is the
#      only way to reach internal/provider (Go forbids external internal/ imports).
#   2. Drop cmd/schemadump/{main.go,schemadump.go} INSIDE the checkout (so the
#      internal/ packages are importable), rendering the AWS template's import
#      placeholders (the azurerm template's imports are already literal — see
#      main-azurerm.go.tmpl's header — so this step is a no-op copy for it).
#   3. Build there (compiles the whole provider — slow, be patient) and run,
#      reflecting SDKv2 ForceNew authoritatively; framework resources are marked
#      framework_unreflected.
#
# PROVIDER (default aws) selects the provider: aws | azurerm. It picks the
# template, the MODULE/REPO_URL/TAG/VERSION defaults, the output filename
# (${PROVIDER}-v${VERSION}-schema.json), and the -types file. PROVIDER=aws
# reproduces the pre-0039 run byte-identically. NOTE: azurerm's resource
# prefix (and this tool's PROVIDER token / filename prefix) is "azurerm", NOT
# "azure" — the app-level CloudProvider union ('aws'|'azure', providerDisplay.ts)
# is a different, higher-level concept than this tool's provider short name.
#
# Everything is parameterised by env vars with defaults. Nothing is committed
# except this tool dir; the provider source stays in the scratchpad.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

PROVIDER="${PROVIDER:-aws}"
TOOLDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$PROVIDER" in
  aws)
    TAG="${TAG:-v6.53.0}"
    VERSION="${VERSION:-6.53.0}"
    MODULE="${MODULE:-github.com/hashicorp/terraform-provider-aws}"
    REPO_URL="${REPO_URL:-https://github.com/hashicorp/terraform-provider-aws.git}"
    TMPL="$TOOLDIR/main.go.tmpl"
    TYPES="${TYPES:-$TOOLDIR/types.txt}"
    ;;
  azurerm)
    TAG="${TAG:-v4.81.0}"
    VERSION="${VERSION:-4.81.0}"
    MODULE="${MODULE:-github.com/hashicorp/terraform-provider-azurerm}"
    REPO_URL="${REPO_URL:-https://github.com/hashicorp/terraform-provider-azurerm.git}"
    TMPL="$TOOLDIR/main-azurerm.go.tmpl"
    TYPES="${TYPES:-$TOOLDIR/types-azure.txt}"
    ;;
  *)
    echo "gen.sh: unknown PROVIDER '$PROVIDER' (use: aws|azurerm)" >&2
    exit 1
    ;;
esac
# Module-path SIV suffix a naive `go mod download` would try (HashiCorp never
# publishes one) — used only for the provenance note below.
SIV_MAJOR="${VERSION%%.*}"

WORK="${WORK:-${SCHEMADUMP_WORK:-$(mktemp -d)}}"
SRC="${SRC:-$WORK/terraform-provider-${PROVIDER}}"
OUT="${OUT:-$TOOLDIR/${PROVIDER}-v${VERSION}-schema.json}"

# Isolated Go caches so we never touch the user's environment.
export GOMODCACHE="${GOMODCACHE:-$WORK/gomodcache}"
export GOCACHE="${GOCACHE:-$WORK/gocache}"
export GOPATH="${GOPATH:-$WORK/gopath}"
export GOTOOLCHAIN="${GOTOOLCHAIN:-auto}"
export GOFLAGS="${GOFLAGS:--mod=mod}"
export GOSUMDB="${GOSUMDB:-off}"
mkdir -p "$GOMODCACHE" "$GOCACHE" "$GOPATH"

log(){ echo "[$(date +%H:%M:%S)] $*" >&2; }

# ---- 1. acquire source (idempotent) ----------------------------------------
if [ -f "$SRC/go.mod" ] && grep -q "^module ${MODULE}$" "$SRC/go.mod"; then
  log "reusing source at $SRC"
else
  log "cloning $REPO_URL @ $TAG -> $SRC (shallow)"
  mkdir -p "$(dirname "$SRC")"
  rm -rf "$SRC"
  git clone --depth 1 --branch "$TAG" --single-branch "$REPO_URL" "$SRC"
fi

COMMIT="$(git -C "$SRC" rev-parse HEAD)"
GOSUM_SHA="$(shasum -a 256 "$SRC/go.sum" | awk '{print $1}')"
GOMOD_SHA="$(shasum -a 256 "$SRC/go.mod" | awk '{print $1}')"
log "source commit=$COMMIT"

# ---- 2. drop the generator inside the module -------------------------------
CMDDIR="$SRC/cmd/schemadump"
mkdir -p "$CMDDIR"
# walker: package schemadump -> package main
sed 's/^package schemadump$/package main/' "$TOOLDIR/schemadump.go" > "$CMDDIR/schemadump.go"
# glue: fill import placeholders for the real provider (main-azurerm.go.tmpl
# carries no __SDKV2_PKG__/__FRAMEWORK_PKG__ tokens, so for PROVIDER=azurerm
# these two substitutions simply find no match — an effective verbatim copy)
sed -e "s#__SDKV2_PKG__#${MODULE}/internal/provider/sdkv2#" \
    -e "s#__FRAMEWORK_PKG__#${MODULE}/internal/provider/framework#" \
    "$TMPL" > "$CMDDIR/main.go"
gofmt -w "$CMDDIR/main.go" "$CMDDIR/schemadump.go" 2>/dev/null || true

# provenance embedded into the artifact metadata
PROV="$WORK/provenance.json"
cat > "$PROV" <<EOF
{
  "acquisition": "git clone --depth 1 --branch ${TAG} ${REPO_URL}",
  "module": "${MODULE}",
  "tag": "${TAG}",
  "commit_sha": "${COMMIT}",
  "go_mod_sha256": "${GOMOD_SHA}",
  "go_sum_sha256": "${GOSUM_SHA}",
  "note": "Module path has no /v${SIV_MAJOR} suffix (HashiCorp does not follow Go SIV); go mod download of .../v${SIV_MAJOR}@${TAG} fails by design — source checkout is required. commit_sha is the authoritative content hash (git object); go_sum_sha256 fingerprints the full dependency graph."
}
EOF

# ---- 3. build (slow!) + run ------------------------------------------------
BIN="$WORK/schemadump.bin"
log "downloading provider deps (idempotent) ..."
( cd "$SRC" && go mod download all )
log "building ./cmd/schemadump (compiles the whole provider — expect several minutes) ..."
( cd "$SRC" && go build -o "$BIN" ./cmd/schemadump )
log "running reflection over $(grep -vc '^#' "$TYPES") requested types ..."
"$BIN" -types "$TYPES" -provenance "$PROV" -version "$VERSION" -tag "$TAG" -module "$MODULE" -out "$OUT"

log "wrote $OUT ($(wc -c < "$OUT") bytes)"
