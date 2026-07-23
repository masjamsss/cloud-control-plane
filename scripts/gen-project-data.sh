#!/usr/bin/env bash
# gen-project-data.sh — regenerate one account's portal data and hand it to the
# control plane. The single shared entry point behind BOTH CI templates:
#
#   .github/workflows/ccp-data.yml        (GitHub Actions)
#   .gitlab/ci/ccp-data.gitlab-ci.yml     (GitLab CI)
#
# PROVIDER-AGNOSTIC (0039 S1): the generators parse *.tf statically, so this is
# the SAME script an AZURE subscription's CI runs — point --root at the azurerm
# Terraform root (the default environments/prod is only a convention) and the
# bundle carries azurerm_* resources under the same ccp.project-data.v1
# schema. Nothing here is AWS-specific; the control-plane project id (registered
# as provider:'azure' via Admin -> Projects) is all that scopes the upload.
#
# What it does, in order:
#   1. verifies the toolchain pins (below) — the generated data is only
#      reproducible on the exact pinned toolchain, so a mismatch fails loudly
#      instead of uploading subtly-skewed data;
#   2. runs ccp/app/scripts/build-inventory.py  (inventory.json + run summary);
#   3. runs ccp/app/scripts/extract-blocks.ts   (block index + chunks);
#   4. assembles one JSON upload bundle (schema ccp.project-data.v1:
#      inventory + blocks index/chunks + summary with sourceCommit /
#      generatedAt / counts / providerPins);
#   5. PUTs it to $CONTROL_PLANE_URL/projects/$PROJECT_ID/data with
#      "Authorization: Bearer $CCP_UPLOAD_TOKEN".
#
# If the control plane cannot be REACHED (air-gapped estate, DNS, timeout) the
# script exits 0 with the bundle left on disk — the CI templates keep the out
# dir as a build artifact so an operator can upload it by hand (see
# docs/runbooks/account-data-ci.md). An HTTP error response (401/403/422/...)
# is a real failure and exits non-zero: that is misconfiguration, not air-gap.
#
# If the resolved scan root (--root / CCP_SCAN_ROOT, default environments/prod)
# does not exist on disk, the script prints one line and exits 0 — nothing is
# generated, nothing is uploaded. This repo ships no estate tree of its own; a
# real deployment sets CCP_SCAN_ROOT (or --root) once its Terraform exists.
#
# Usage:
#   scripts/gen-project-data.sh [--project-id <id>] [--root <tf-root>]
#       [--out <dir>] [--tools-root <dir>] [--url <control-plane-url>]
#       [--imports <file>] [--install-deps] [--skip-upload]
#       [--unsafe-skip-pin-check] [--print-pins] [--help]
#
# Environment fallbacks (flags win):
#   CCP_PROJECT_ID          control-plane project id (required)
#   CCP_SCAN_ROOT           Terraform root to scan   (default: environments/prod;
#                              missing on disk ⇒ exit 0, nothing to scan yet)
#   CCP_OUT_DIR             output dir               (default: ./ccp-data-out)
#   CCP_TOOLS_ROOT          control-plane repo checkout holding the generators
#                              (default: this script's own repo root)
#   CONTROL_PLANE_URL          control-plane base URL (https://...); also read
#                              from CCP_CONTROL_PLANE_URL. Empty = no upload
#                              (artifact fallback), by design.
#   CCP_UPLOAD_TOKEN        per-project upload key (env only — NEVER a flag,
#                              so it can't leak into `ps` or CI step echo)
#
# The generators are CI-only by design (AGENTS.md rule 5): python-hcl2 is
# pinned because its parse-output shape is load-bearing. ALL version pins live
# here — the CI templates read them via --print-pins instead of duplicating.

set -euo pipefail

# ─── Version pins — the ONE place. Templates consume via --print-pins. ───────
# Mirrors .github/workflows/terraform.yml portal-data-freshness exactly:
#   python 3.12 + python-hcl2==5.1.1 (5.1.1 is the newest python-hcl2 that
#   reproduces the committed inventory byte-for-byte; 6.x changes string
#   escapes, 8.x quotes block-type keys and drops every resource), node 20
#   (extract-blocks.ts runs under ccp/app's pinned vite-node).
# Terraform itself is NOT needed: both generators parse *.tf statically.
PIN_PYTHON_SERIES="3.12"
PIN_NODE_MAJOR="20"
PIN_PYTHON_HCL2="5.1.1"

SCHEMA="ccp.project-data.v1"

note() { printf '[gen-project-data] %s\n' "$*"; }
warn() { printf '[gen-project-data] WARN: %s\n' "$*" >&2; }
die()  { printf '[gen-project-data] ERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; }

abspath() { (cd "$1" 2>/dev/null && pwd) || die "not a directory: $1"; }

# ─── Args ─────────────────────────────────────────────────────────────────────
PROJECT_ID="${CCP_PROJECT_ID:-}"
TF_ROOT="${CCP_SCAN_ROOT:-environments/prod}"
OUT_DIR="${CCP_OUT_DIR:-ccp-data-out}"
TOOLS_ROOT="${CCP_TOOLS_ROOT:-}"
URL="${CONTROL_PLANE_URL:-${CCP_CONTROL_PLANE_URL:-}}"
IMPORTS=""
INSTALL_DEPS=0
SKIP_UPLOAD=0
SKIP_PIN_CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project-id) PROJECT_ID="${2:?--project-id needs a value}"; shift 2 ;;
    --root)       TF_ROOT="${2:?--root needs a value}"; shift 2 ;;
    --out)        OUT_DIR="${2:?--out needs a value}"; shift 2 ;;
    --tools-root) TOOLS_ROOT="${2:?--tools-root needs a value}"; shift 2 ;;
    --url)        URL="${2:?--url needs a value}"; shift 2 ;;
    --imports)    IMPORTS="${2:?--imports needs a value}"; shift 2 ;;
    --install-deps) INSTALL_DEPS=1; shift ;;
    --skip-upload)  SKIP_UPLOAD=1; shift ;;
    --unsafe-skip-pin-check) SKIP_PIN_CHECK=1; shift ;;
    --print-pins)
      # GITHUB_OUTPUT-compatible key=value lines. The GitHub template feeds
      # these straight into setup-python/setup-node so the pins exist once.
      printf 'python_series=%s\n' "$PIN_PYTHON_SERIES"
      printf 'node_major=%s\n'    "$PIN_NODE_MAJOR"
      printf 'python_hcl2=%s\n'   "$PIN_PYTHON_HCL2"
      exit 0
      ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# Project id must match the control plane's own slug rule
# (ccp/api/src/routes/projects.ts PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/).
[ -n "$PROJECT_ID" ] || die "no project id. Pass --project-id or set CCP_PROJECT_ID."
printf '%s' "$PROJECT_ID" | grep -Eq '^[a-z][a-z0-9-]{1,31}$' \
  || die "project id '$PROJECT_ID' is not a valid slug (^[a-z][a-z0-9-]{1,31}$)"

# ─── Locate the pieces ────────────────────────────────────────────────────────
if [ -z "$TOOLS_ROOT" ]; then
  TOOLS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
TOOLS_ROOT="$(abspath "$TOOLS_ROOT")"
APP_DIR="$TOOLS_ROOT/ccp/app"
INVENTORY_PY="$APP_DIR/scripts/build-inventory.py"
[ -f "$INVENTORY_PY" ] || die "generators not found under $TOOLS_ROOT (expected ccp/app/scripts/build-inventory.py).
In a foreign estate repo, check out the control-plane repo and pass --tools-root <that checkout> — do not copy this script alone."

# Fail SOFT here, not hard: this public template repo ships no estate tree of
# its own, so the out-of-the-box default (environments/prod) legitimately does
# not exist until a real deployment sets CCP_SCAN_ROOT (or --root) to point at
# its own Terraform. That is "nothing to generate yet", not a misconfiguration
# — same exit-0-and-explain treatment the unreachable-control-plane case below
# gets, so a fork's CI does not red-X on a step it hasn't configured.
if [ ! -d "$TF_ROOT" ]; then
  note "no Terraform root at '$TF_ROOT' — this repo ships no estate tree; set CCP_SCAN_ROOT (or pass --root) once one exists. Nothing to generate; exiting."
  exit 0
fi
TF_ROOT="$(abspath "$TF_ROOT")"
if ! ls "$TF_ROOT"/*.tf >/dev/null 2>&1 && ! ls "$TF_ROOT"/*.tf.json >/dev/null 2>&1; then
  warn "no *.tf/*.tf.json directly under $TF_ROOT — is --root right?"
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(abspath "$OUT_DIR")"
GEN_DIR="$OUT_DIR/gen"
rm -rf "$GEN_DIR"
mkdir -p "$GEN_DIR"

# The estate's own imports.tf (if it keeps one at the conventional path)
# enriches subnet→AZ data; a missing file is a WARN inside build-inventory.py,
# never an error. Deliberately resolved against the ESTATE repo, not the tools
# repo, so a foreign estate never gets this estate's import data joined in.
ESTATE_TOP="$(git -C "$TF_ROOT" rev-parse --show-toplevel 2>/dev/null || dirname "$TF_ROOT")"
[ -n "$IMPORTS" ] || IMPORTS="$ESTATE_TOP/importer/prod/imports.tf"

# ─── Toolchain pins ───────────────────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || die "python3 not found"
command -v node    >/dev/null 2>&1 || die "node not found"

if [ "$INSTALL_DEPS" = 1 ]; then
  note "pip install python-hcl2==$PIN_PYTHON_HCL2"
  python3 -m pip install --quiet "python-hcl2==$PIN_PYTHON_HCL2"
  note "npm ci in $APP_DIR (extract-blocks.ts needs its pinned vite-node + the '@' path alias)"
  (cd "$APP_DIR" && npm ci --no-audit --no-fund)
fi

PYTHON_SERIES="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
HCL2_VERSION="$(python3 -c 'import importlib.metadata as m; print(m.version("python-hcl2"))' 2>/dev/null || echo missing)"

PIN_ERRORS=""
[ "$PYTHON_SERIES" = "$PIN_PYTHON_SERIES" ] || PIN_ERRORS="$PIN_ERRORS
  python $PYTHON_SERIES (pin: $PIN_PYTHON_SERIES)"
[ "$NODE_MAJOR" = "$PIN_NODE_MAJOR" ] || PIN_ERRORS="$PIN_ERRORS
  node major $NODE_MAJOR (pin: $PIN_NODE_MAJOR)"
[ "$HCL2_VERSION" = "$PIN_PYTHON_HCL2" ] || PIN_ERRORS="$PIN_ERRORS
  python-hcl2 $HCL2_VERSION (pin: $PIN_PYTHON_HCL2 — its parse-output shape is load-bearing)"

if [ -n "$PIN_ERRORS" ]; then
  if [ "$SKIP_PIN_CHECK" = 1 ]; then
    warn "PIN MISMATCH (continuing because --unsafe-skip-pin-check):$PIN_ERRORS"
    warn "data generated off-pin is NOT reproducible — never upload it to a real control plane"
  else
    die "toolchain does not match the pins:$PIN_ERRORS
Fix the CI image / setup steps (or run via the provided templates). The pins live at the top of $0."
  fi
fi

[ -d "$APP_DIR/node_modules" ] \
  || die "$APP_DIR/node_modules missing — run with --install-deps (CI) or 'npm ci' there first"

# ─── Generate ─────────────────────────────────────────────────────────────────
note "inventory: build-inventory.py --root $TF_ROOT"
python3 "$INVENTORY_PY" \
  --root "$TF_ROOT" \
  --out "$GEN_DIR/inventory.json" \
  --imports "$IMPORTS" \
  --manifests "$TOOLS_ROOT/ccp/app/src/data/manifests" \
  --summary "$GEN_DIR/inventory-summary.json"

# Must run FROM ccp/app: vite-node resolves the "@" alias (and the pinned
# local vite-node itself) from its own vite.config.ts — invoked from elsewhere
# it silently falls back to a global vite-node and then fails to resolve
# "@/lib/hclScan". Same invocation as terraform.yml portal-data-freshness.
note "blocks: extract-blocks.ts --root $TF_ROOT"
(cd "$APP_DIR" && npx vite-node scripts/extract-blocks.ts --root "$TF_ROOT" --out "$GEN_DIR/blocks")

[ -f "$GEN_DIR/inventory.json" ]         || die "build-inventory.py produced no inventory.json"
[ -f "$GEN_DIR/inventory-summary.json" ] || die "build-inventory.py produced no run summary"
[ -f "$GEN_DIR/blocks/index.json" ]      || die "extract-blocks.ts produced no blocks/index.json"

# ─── Assemble the upload bundle ───────────────────────────────────────────────
# One JSON document; the control plane recomputes and records digests
# server-side, so the transport carries content only, no client-side signing.
GENERATORS_COMMIT="$(git -C "$TOOLS_ROOT" rev-parse HEAD 2>/dev/null || echo '')"
CI_HOST="local"; CI_RUN_ID=""; CI_RUN_URL=""; CI_COMMIT=""; SOURCE_REPO=""; SOURCE_REF=""
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  CI_HOST="github"
  CI_RUN_ID="${GITHUB_RUN_ID:-}"
  CI_RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
  CI_COMMIT="${GITHUB_SHA:-}"
  SOURCE_REPO="${GITHUB_REPOSITORY:-}"
  SOURCE_REF="${GITHUB_REF_NAME:-}"
elif [ "${GITLAB_CI:-}" = "true" ]; then
  CI_HOST="gitlab"
  CI_RUN_ID="${CI_JOB_ID:-}"
  CI_RUN_URL="${CI_JOB_URL:-}"
  CI_COMMIT="${CI_COMMIT_SHA:-}"
  SOURCE_REPO="${CI_PROJECT_PATH:-}"
  SOURCE_REF="${CI_COMMIT_REF_NAME:-}"
fi

note "assembling bundle.json (schema $SCHEMA)"
ASM_SCHEMA="$SCHEMA" ASM_PROJECT_ID="$PROJECT_ID" ASM_GEN_DIR="$GEN_DIR" \
ASM_OUT_DIR="$OUT_DIR" ASM_PY_HCL2="$HCL2_VERSION" ASM_PY="$PYTHON_SERIES" \
ASM_NODE="$(node --version)" ASM_GENERATORS_COMMIT="$GENERATORS_COMMIT" \
ASM_CI_HOST="$CI_HOST" ASM_CI_RUN_ID="$CI_RUN_ID" ASM_CI_RUN_URL="$CI_RUN_URL" \
ASM_CI_COMMIT="$CI_COMMIT" ASM_SOURCE_REPO="$SOURCE_REPO" ASM_SOURCE_REF="$SOURCE_REF" \
python3 - <<'PY'
import hashlib, json, os
from collections import OrderedDict

gen = os.environ["ASM_GEN_DIR"]
out = os.environ["ASM_OUT_DIR"]

with open(os.path.join(gen, "inventory.json")) as fh:
    inventory = json.load(fh)
with open(os.path.join(gen, "inventory-summary.json")) as fh:
    run_summary = json.load(fh)
with open(os.path.join(gen, "blocks", "index.json")) as fh:
    index = json.load(fh)

chunks = OrderedDict()
blocks_dir = os.path.join(gen, "blocks")
for name in sorted(os.listdir(blocks_dir)):
    if not name.endswith(".json") or name == "index.json":
        continue
    with open(os.path.join(blocks_dir, name)) as fh:
        chunks[name[:-len(".json")]] = json.load(fh)

def env(k):
    v = os.environ.get(k, "")
    return v or None

bundle = OrderedDict([
    ("schema", os.environ["ASM_SCHEMA"]),
    ("projectId", os.environ["ASM_PROJECT_ID"]),
    ("summary", OrderedDict([
        # sourceCommit/generatedAt are git-derived by build-inventory.py from
        # the SCANNED root (deterministic, 0027 §2.5) — on a shallow CI
        # checkout they equal the built commit.
        ("generatedAt", run_summary.get("generatedAt")),
        ("sourceCommit", run_summary.get("sourceCommit")),
        ("sourceRepo", env("ASM_SOURCE_REPO")),
        ("sourceRef", env("ASM_SOURCE_REF")),
        ("ci", OrderedDict([
            ("host", os.environ["ASM_CI_HOST"]),
            ("runId", env("ASM_CI_RUN_ID")),
            ("runUrl", env("ASM_CI_RUN_URL")),
            ("commit", env("ASM_CI_COMMIT")),
        ])),
        ("counts", OrderedDict([
            ("resources", run_summary.get("resourceCount")),
            ("blockChunks", len(chunks)),
            ("blockAddresses", len(index)),
        ])),
        ("providerPins", run_summary.get("providerPins", {})),
        ("toolchain", OrderedDict([
            ("python", os.environ["ASM_PY"]),
            ("node", os.environ["ASM_NODE"]),
            ("pythonHcl2", os.environ["ASM_PY_HCL2"]),
            ("generatorsCommit", env("ASM_GENERATORS_COMMIT")),
        ])),
        # Full generator run summary (byService/byType/modules/warnings) —
        # this is what the admin reviews before activating staged data.
        ("inventoryRun", run_summary),
    ])),
    ("inventory", inventory),
    ("blocks", OrderedDict([("index", index), ("chunks", chunks)])),
])

path = os.path.join(out, "bundle.json")
with open(path, "w") as fh:
    json.dump(bundle, fh, separators=(",", ":"))
    fh.write("\n")

with open(path, "rb") as fh:
    digest = hashlib.sha256(fh.read()).hexdigest()
with open(os.path.join(out, "bundle.sha256"), "w") as fh:
    fh.write(digest + "\n")

size = os.path.getsize(path)
print(f"[gen-project-data] bundle.json: {size} bytes, sha256 {digest}")
print(f"[gen-project-data]   resources={run_summary.get('resourceCount')} "
      f"blockChunks={len(chunks)} blockAddresses={len(index)} "
      f"sourceCommit={run_summary.get('sourceCommit')}")
PY

# ─── Upload (or fall back to the artifact) ────────────────────────────────────
write_status() { # $1 status, $2 curl exit code (or empty), $3 endpoint
  ST="$1" CE="${2:-}" EP="${3:-}" OUT="$OUT_DIR" python3 - <<'PY'
import json, os
path = os.path.join(os.environ["OUT"], "upload-status.json")
with open(path, "w") as fh:
    json.dump({
        "status": os.environ["ST"],
        "curlExit": int(os.environ["CE"]) if os.environ["CE"] else None,
        "endpoint": os.environ["EP"] or None,
    }, fh, indent=1)
    fh.write("\n")
PY
}

if [ "$SKIP_UPLOAD" = 1 ]; then
  write_status "skipped-flag" "" ""
  note "upload skipped (--skip-upload). Bundle at $OUT_DIR/bundle.json"
  exit 0
fi

if [ -z "$URL" ]; then
  write_status "skipped-no-url" "" ""
  warn "CONTROL_PLANE_URL not set — no upload attempted. The bundle is kept as a build artifact; upload it by hand (docs/runbooks/account-data-ci.md §Manual fallback)."
  exit 0
fi

URL="${URL%/}"
case "$URL" in
  https://*) : ;;
  http://localhost*|http://127.0.0.1*) warn "plain-HTTP control plane — acceptable for local testing only" ;;
  *) die "CONTROL_PLANE_URL must be https:// (got: $URL) — the upload carries a bearer token" ;;
esac

[ -n "${CCP_UPLOAD_TOKEN:-}" ] \
  || die "CONTROL_PLANE_URL is set but CCP_UPLOAD_TOKEN is empty. Set the secret (GitHub: repo secret / GitLab: masked+protected variable), or unset the URL to use the artifact fallback."

ENDPOINT="$URL/projects/$PROJECT_ID/data"
note "PUT $ENDPOINT ($(cat "$OUT_DIR/bundle.sha256"))"

set +e
curl -sS --fail-with-body \
  --connect-timeout 10 --max-time 300 \
  --retry 3 --retry-connrefused \
  -X PUT \
  -H "Authorization: Bearer $CCP_UPLOAD_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @"$OUT_DIR/bundle.json" \
  -o "$OUT_DIR/upload-response.txt" \
  "$ENDPOINT"
CURL_EXIT=$?
set -e

if [ "$CURL_EXIT" -eq 0 ]; then
  write_status "uploaded" "$CURL_EXIT" "$ENDPOINT"
  note "uploaded — control-plane response:"
  cat "$OUT_DIR/upload-response.txt" 2>/dev/null || true
  note "the data is STAGED server-side; an admin still has to activate it (Admin → Projects)."
  exit 0
fi

case "$CURL_EXIT" in
  5|6|7|28|35|52|55|56)
    # Could not reach the control plane at all (DNS/connect/timeout/TLS-handshake/
    # dropped connection) — the air-gapped/manual-upload case, not a config error.
    write_status "unreachable" "$CURL_EXIT" "$ENDPOINT"
    warn "control plane unreachable (curl exit $CURL_EXIT). Keeping the bundle as a build artifact for a manual upload — see docs/runbooks/account-data-ci.md §Manual fallback."
    exit 0
    ;;
  22)
    write_status "rejected" "$CURL_EXIT" "$ENDPOINT"
    warn "control plane REJECTED the upload (HTTP error). Response body:"
    cat "$OUT_DIR/upload-response.txt" >&2 2>/dev/null || true
    die "fix the token/project id/bundle and re-run (401/403 → mint or re-set CCP_UPLOAD_TOKEN; 404/422 → check the project id and that the control plane build has the upload endpoint)"
    ;;
  *)
    write_status "failed" "$CURL_EXIT" "$ENDPOINT"
    die "upload failed (curl exit $CURL_EXIT)"
    ;;
esac
