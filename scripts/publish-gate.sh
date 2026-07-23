#!/usr/bin/env bash
#
# publish-gate.sh — the publish-safety gate for the cloud-control-plane split.
#
# Implements docs/superpowers/plans/2026-07-22-repo-scrub-and-generalize.md §8: the hard
# gate the owner's directive demands (zero findings before any public push) and the
# per-lane ratchet every §10 scrub lane runs against its own write-set.
#
# ─────────────────────────────────────────────────────────────────────────────────────────
# USAGE
#
#   scripts/publish-gate.sh [--tree DIR] [--scope GLOB]... [--denylist FILE] [--report]
#
#   --tree DIR       Scan an assembled tree (e.g. the split's /work/public-tree) as plain
#                     files on disk — no git, no manifest/excludes filtering. Combine with
#                     --scope to further narrow it. Omit this flag to operate on the
#                     current git checkout instead (see mode table below).
#   --scope GLOB     Restrict the scan to files matching GLOB (repeatable; OR'd
#                     together). This is the per-lane ratchet: each §10 lane proves its own
#                     write-set carries no real literal, independent of public/private
#                     classification. Cannot be combined with a bare invocation's
#                     manifest-minus-excludes filtering — see mode table.
#   --denylist FILE  Untracked, private-side file carrying REAL literals (see FORMAT
#                     below). Defaults to ./.estate-denylist.json relative to the repo
#                     root if that file exists; otherwise the gate runs in generic-patterns
#                     mode (no exact-match checks against real values — this is the mode
#                     the public repo's forever-CI runs in, since that file never ships).
#                     Passing --denylist FILE explicitly and having FILE not exist is a
#                     usage error (fails fast rather than silently running weaker checks
#                     you thought you asked for).
#   --report         Print a full per-check table (status + count + description) even on
#                     a clean pass. Without it, a clean pass prints a one-line summary and
#                     a failing run still prints every failing check's detail.
#   -h, --help       Print this usage block and exit 0.
#
# MODES (how the scan target file set is resolved — see resolve_files()):
#
#   1. Bare invocation (no --tree, no --scope): the DEFAULT. Operates on the current git
#      checkout ("."). File universe = every file `git ls-files --cached --others
#      --exclude-standard` reports — i.e. tracked files PLUS untracked-but-not-gitignored
#      ones, so brand-new work-in-progress files are checked before you even `git add`
#      them, same as every other mode below. Scan target = that universe filtered to
#      files matching scripts/split/public-manifest.txt AND NOT matching
#      scripts/split/public-excludes.txt (§2.1/§2.2/§2.3) — i.e. "only the
#      §2.1 public-bound set". Private files (environments/**, docs/proposals/**, the real
#      sample estate under ccp/app/src/data, ...) are out of scope BY CONSTRUCTION, so
#      the estate's own legitimate content never makes this gate cry wolf. If either list
#      file is absent (this is what happens when this same script ships inside the PUBLIC
#      repo, which never carries scripts/split/**), the gate degrades gracefully: a missing
#      manifest is treated as "everything matches" and a missing excludes list as "nothing
#      is excluded" — i.e. bare mode becomes "scan everything", which is exactly correct
#      once you're already inside the public-only repo and every file present has already
#      crossed the boundary.
#   2. --scope GLOB (no --tree): the per-lane ratchet. Scan target = the same tracked +
#      untracked-not-ignored universe as mode 1, filtered to files matching any given
#      GLOB, full stop — deliberately NOT further filtered by manifest/excludes,
#      because a lane's write-set may legitimately include files not yet classified either
#      way (this script's own scripts/split/*.txt seed lists are a case in point). PG-7
#      (private-path escapee check) is skipped in this mode — see PG-7's function comment
#      for why.
#   3. --tree DIR (assembled-tree mode, --scope optional on top): scan target = every plain
#      file under DIR (found via `find`, not git — the assembled tree is "no .git by
#      construction", per the audit). This is the pre-publish / assembly-rehearsal mode
#      (plan §9 step 4, §12 acceptance #1).
#
# ─────────────────────────────────────────────────────────────────────────────────────────
# THE DENYLIST FILE FORMAT (--denylist, default ./.estate-denylist.json)
#
# A JSON object, ALL keys optional (missing key == empty list). Every value in this file is
# a REAL literal that must never appear in a tracked file — which is exactly why this file
# itself is gitignored and must never be committed. The example below shows the SHAPE only;
# every value is a placeholder, never a real account id/key/secret/email/domain/name:
#
#   {
#     "accountIds": ["123456789012", "111122223333"],
#     "akiaIds":    ["AKIAIOSFODNN7EXAMPLE"],
#     "secrets":    ["<a GUID- or token-shaped literal, e.g. an API_TOKEN value>"],
#     "emails":     ["someone@example-corp.example"],
#     "domains":    ["example-corp.example"],
#     "names":      ["Firstname Lastname", "Firstname.Lastname"],
#     "region":     ["aa-example-1"],
#     "estateTerms":["Examplecorp", "ExampleWorkload"]
#   }
#
#   - accountIds  Real AWS account ids (PG-1a exact-match, on top of PG-1b/c's generic
#                 ARN-context / bare-12-digit patterns which run regardless of this file).
#   - akiaIds     Real AKIA... access key ids (defense-in-depth on top of PG-4's generic
#                 "must be in the public example set" rule).
#   - secrets     Real secret-shaped literals (e.g. the dead S-1 API token) — PG-5
#                 exact-matches every one of these anywhere in scope, in addition to its
#                 generic heuristic pass.
#   - emails      Real people's email addresses — PG-6 exact-matches these on top of its
#                 generic "not @example.{com,net,org}" rule.
#   - domains     Real customer/vendor domains — extends PG-2's generic pattern.
#   - names       Real people's display-name/tag-value forms that aren't email-shaped
#                 (e.g. a "Firstname.Lastname" IAM tag value) — PG-6 exact-matches these too.
#   - region      Real home region(s) of the estate (e.g. an AWS region code) — PG-3
#                 exact-matches these word-bounded/case-insensitive in denylist mode, on
#                 top of its generic estate-vocabulary regex. Generic mode names no region.
#   - estateTerms Any extra estate vocabulary not already in PG-3's built-in generic list
#                 — same word-bounded/case-insensitive match, denylist mode only. (Same
#                 field the app-side guards read via scripts/lib/estateDenylist.ts.)
#
# This script's own committed copy of itself, and every file under scripts/split/, must
# NEVER contain a real value from any of these categories — that would BE the leak the gate
# exists to catch. If you are ever about to add one: stop, put it in the untracked denylist
# instead.
#
# ─────────────────────────────────────────────────────────────────────────────────────────
# CHECKS (§8.2) — PG-1 through PG-8, PG-10 are hard-fail; PG-1(c) and PG-11 are advisory
# (reported, never block); PG-9 (gitleaks) hard-fails when gitleaks IS installed and finds
# something, but SKIPS (never fails, never blocks) when gitleaks is not installed — printing
# a warning instead, so this gate is still useful in an environment without it.
#
# Exit 0 only when every hard-fail check reports zero (or was gracefully skipped, in the
# sole case of PG-9 without gitleaks installed). Exit 1 if any hard-fail check has a
# nonzero count. Exit 2 on a usage error (bad flags, an explicitly-named file missing).

set -uo pipefail
shopt -s globstar extglob nullglob

# ── Path resolution ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

MANIFEST_FILE="$REPO_ROOT/scripts/split/public-manifest.txt"
EXCLUDES_FILE="$REPO_ROOT/scripts/split/public-excludes.txt"
PG3_ALLOWLIST_FILE="$REPO_ROOT/scripts/split/publish-gate-allowlist.txt"
GITLEAKS_CONFIG="$REPO_ROOT/.gitleaks.toml"
DENYLIST_FILE="$REPO_ROOT/.estate-denylist.json"
DENYLIST_EXPLICIT=0

TREE_DIR=""
TREE_GIVEN=0
declare -a SCOPE_GLOBS=()
REPORT=0

# ── usage ────────────────────────────────────────────────────────────────────────────────
usage() {
  # Print this file's own header comment block (line 2 through the blank line right before
  # `set -uo pipefail`) with the leading `#` stripped — keeps --help in sync with the real
  # docs above by construction instead of maintaining a second copy of the text.
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
}

# ── arg parsing ─────────────────────────────────────────────────────────────────────────
while (($#)); do
  case "$1" in
    --tree)
      [[ $# -ge 2 ]] || { echo "publish-gate.sh: --tree requires a directory argument" >&2; exit 2; }
      TREE_DIR="$2"; TREE_GIVEN=1; shift 2 ;;
    --scope)
      [[ $# -ge 2 ]] || { echo "publish-gate.sh: --scope requires a glob argument" >&2; exit 2; }
      SCOPE_GLOBS+=("$2"); shift 2 ;;
    --denylist)
      [[ $# -ge 2 ]] || { echo "publish-gate.sh: --denylist requires a file argument" >&2; exit 2; }
      DENYLIST_FILE="$2"; DENYLIST_EXPLICIT=1; shift 2 ;;
    --report)
      REPORT=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "publish-gate.sh: unrecognized argument: $1" >&2
      echo "Run with --help for usage." >&2
      exit 2 ;;
  esac
done

if ((TREE_GIVEN)); then
  [[ -d "$TREE_DIR" ]] || { echo "publish-gate.sh: --tree directory not found: $TREE_DIR" >&2; exit 2; }
  TREE_DIR="$(cd -- "$TREE_DIR" >/dev/null 2>&1 && pwd)"
fi

if ((DENYLIST_EXPLICIT)); then
  [[ -f "$DENYLIST_FILE" ]] || { echo "publish-gate.sh: --denylist file not found: $DENYLIST_FILE" >&2; exit 2; }
fi

# ── small helpers ───────────────────────────────────────────────────────────────────────

# _load_patterns FILE — print each non-blank, non-comment line of FILE. Silent no-output
# (not an error) if FILE doesn't exist: callers treat "file absent" as "empty pattern set",
# which is exactly the graceful-degradation behavior documented above for the public repo.
_load_patterns() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  grep -vE '^[[:space:]]*(#|$)' "$file" | sed -e 's/[[:space:]]*$//'
}

# _matches_any PATH PATTERN... — true if PATH matches any of the given bash extglob
# patterns. A plain `*`/`**` in this `[[ == ]]` matching context already spans `/`
# (verified empirically; see the PR description for the exact test transcript), so
# "ccp/app/**" correctly matches "ccp/app/src/x/y.ts" and does NOT match the
# unrelated sibling "ccp/appendix/x.ts" — no accidental prefix collisions.
_matches_any() {
  local path="$1"; shift
  local pattern
  for pattern in "$@"; do
    [[ -z "$pattern" ]] && continue
    if [[ "$path" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

# _is_env_example PATH — true if PATH's basename is exactly ".env.example" (the one
# deliberately-placeholder-shaped file class exempted from PG-5 and gitleaks).
_is_env_example() {
  [[ "$(basename -- "$1")" == ".env.example" ]]
}

# _is_env_nonexample PATH — true if PATH's basename is a real ".env"-family file that is
# NOT the ".example" template (PG-8's "no real .env in the tree" rule).
_is_env_nonexample() {
  local base; base="$(basename -- "$1")"
  case "$base" in
    .env|.env.local) return 0 ;;
    .env.*) [[ "$base" == ".env.example" ]] && return 1 || return 0 ;;
    *) return 1 ;;
  esac
}

# ── resolve the scan target file set ────────────────────────────────────────────────────
declare -a SCAN_FILES=()
SCAN_BASE=""
MODE=""

resolve_files() {
  if ((TREE_GIVEN)); then
    MODE="tree"
    SCAN_BASE="$TREE_DIR"
    local f rel
    while IFS= read -r -d '' f; do
      rel="${f#"$TREE_DIR"/}"
      SCAN_FILES+=("$rel")
    done < <(find "$TREE_DIR" -type f -not -path '*/.git/*' -print0)
    if ((${#SCOPE_GLOBS[@]})); then
      local filtered=() r
      for r in "${SCAN_FILES[@]}"; do
        _matches_any "$r" "${SCOPE_GLOBS[@]}" && filtered+=("$r")
      done
      SCAN_FILES=("${filtered[@]}")
    fi
  elif ((${#SCOPE_GLOBS[@]})); then
    MODE="scope"
    SCAN_BASE="$REPO_ROOT"
    local all=() r
    mapfile -t all < <(git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard)
    for r in "${all[@]}"; do
      _matches_any "$r" "${SCOPE_GLOBS[@]}" && SCAN_FILES+=("$r")
    done
  else
    MODE="default"
    SCAN_BASE="$REPO_ROOT"
    local all=() r
    mapfile -t all < <(git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard)
    local -a manifest_patterns=() exclude_patterns=()
    mapfile -t manifest_patterns < <(_load_patterns "$MANIFEST_FILE")
    mapfile -t exclude_patterns < <(_load_patterns "$EXCLUDES_FILE")
    # Graceful degradation (see header): no manifest file => treat as match-everything.
    ((${#manifest_patterns[@]})) || manifest_patterns=("**")
    for r in "${all[@]}"; do
      if _matches_any "$r" "${manifest_patterns[@]}"; then
        ((${#exclude_patterns[@]})) && _matches_any "$r" "${exclude_patterns[@]}" && continue
        SCAN_FILES+=("$r")
      fi
    done
  fi
}

resolve_files

abs_path() { printf '%s/%s' "$SCAN_BASE" "$1"; }

# ── load the denylist (optional; jq-driven; both "file absent" and "jq absent" degrade to
#    an empty denylist rather than erroring, per the same graceful-degradation posture as
#    gitleaks below) ──────────────────────────────────────────────────────────────────────
declare -a DL_ACCOUNT_IDS=() DL_AKIA_IDS=() DL_SECRETS=() DL_EMAILS=() DL_DOMAINS=() DL_NAMES=()
declare -a DL_REGIONS=() DL_ESTATE_TERMS=() DL_REPO_NAMES=() DL_BRAND=()
DENYLIST_LOADED=0
if [[ -f "$DENYLIST_FILE" ]]; then
  if command -v jq >/dev/null 2>&1; then
    mapfile -t DL_ACCOUNT_IDS < <(jq -r '.accountIds[]? // empty' "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_AKIA_IDS   < <(jq -r '.akiaIds[]? // empty'   "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_SECRETS    < <(jq -r '.secrets[]? // empty'   "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_EMAILS     < <(jq -r '.emails[]? // empty'    "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_DOMAINS    < <(jq -r '.domains[]? // empty'   "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_NAMES      < <(jq -r '.names[]? // empty'     "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_REGIONS    < <(jq -r '.region[]? // empty'    "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_ESTATE_TERMS < <(jq -r '.estateTerms[]? // empty' "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_REPO_NAMES < <(jq -r '.repoNames[]? // empty' "$DENYLIST_FILE" 2>/dev/null)
    mapfile -t DL_BRAND      < <(jq -r '.brand[]? // empty'     "$DENYLIST_FILE" 2>/dev/null)
    DENYLIST_LOADED=1
  else
    echo "publish-gate.sh: WARNING — jq not found; denylist exact-match checks skipped (generic patterns still run)." >&2
  fi
fi

# ── reviewed-exception allowlist (file+substring scoped; scripts/split/publish-gate-allowlist.txt).
# Primarily PG-3's (per §8.2's own design), but the identical file+substring exemption
# mechanism is reused for one other, narrow, structurally-unavoidable case: PG-3 and PG-10
# hardcode the very words/string they detect (a detector necessarily contains the pattern
# it looks for), so this script and .gitleaks.toml trivially self-match their OWN check
# definitions when scanned. That is benign, reviewed, self-referential noise — not a real
# occurrence — exactly the audit's own "classified false positive, with reasoning"
# methodology (docs/superpowers/2026-07-21-repo-split-secret-audit.md §A.2), applied here
# via the one suppression mechanism the spec already provides rather than inventing a
# second one. See the allowlist file's own entries for exactly which lines and why.
declare -a GATE_ALLOW_FILE=() GATE_ALLOW_SUBSTR=()
while IFS=$'\t' read -r af asub _areason; do
  [[ -z "$af" ]] && continue
  GATE_ALLOW_FILE+=("$af")
  GATE_ALLOW_SUBSTR+=("$asub")
done < <(_load_patterns "$PG3_ALLOWLIST_FILE")

_gate_allowlisted() {
  local file="$1" line="$2"
  local i
  for i in "${!GATE_ALLOW_FILE[@]}"; do
    if [[ "$file" == ${GATE_ALLOW_FILE[$i]} && "$line" == *"${GATE_ALLOW_SUBSTR[$i]}"* ]]; then
      return 0
    fi
  done
  return 1
}

# The gate's own configuration/metadata files exist specifically to reference the words
# and strings PG-3/PG-10 look for (documenting the check, spelling out per-lane
# exemptions), so they are structurally self-referential by design — whole-file exempt
# from PG-3/PG-10 ONLY, still fully in scope for every other check (PG-1/PG-2/PG-5/PG-6/
# PG-9/gitleaks etc. — which they have no legitimate reason to ever trip). This is a
# different, coarser kind of exemption than the file+substring "reviewed exception"
# allowlist above: that one is for genuine, individually-reviewed hits anywhere in the
# public-bound tree; this one is for the handful of files whose entire job is talking
# ABOUT these two checks.
GATE_OWN_CONFIG_FILES=(
  "scripts/split/public-manifest.txt"
  "scripts/split/public-excludes.txt"
  "scripts/split/publish-gate-allowlist.txt"
  ".gitleaks.toml"
)
_is_gate_own_config() {
  local f="$1" c
  for c in "${GATE_OWN_CONFIG_FILES[@]}"; do [[ "$f" == "$c" ]] && return 0; done
  return 1
}

# ── reporting scaffolding ───────────────────────────────────────────────────────────────
# Status vocabulary: FAIL (hard, blocks exit 0 when count>0), PASS (hard check, clean),
# ADVISORY (reported, never blocks), SKIP (check didn't run this mode/environment, never
# blocks — PG-9 without gitleaks, PG-7 under --scope).
declare -a CHECK_IDS=() CHECK_STATUS=() CHECK_COUNTS=() CHECK_DESCS=()
declare -a CHECK_EXAMPLES=()
FOUND_FAIL=0

record() {
  # record ID STATUS COUNT DESC EXAMPLE
  local id="$1" status="$2" count="$3" desc="$4" example="${5:-}"
  CHECK_IDS+=("$id"); CHECK_STATUS+=("$status"); CHECK_COUNTS+=("$count")
  CHECK_DESCS+=("$desc"); CHECK_EXAMPLES+=("$example")
  if [[ "$status" == "FAIL" && "$count" -gt 0 ]]; then
    FOUND_FAIL=1
  fi
}

# grep_scan PATTERN [-i] — runs `grep -n -o -E [-i]` against every file in SCAN_FILES
# (looped one file at a time, so the relative path is known from the loop variable rather
# than parsed back out of grep's own output — deliberately, since a matched ARN-context id
# like ":123456789012:" contains colons itself, which would make a naive split of grep's
# `file:line:match` output ambiguous). Emits "relpath<TAB>lineno<TAB>matchtext" rows. No
# output and success (rc 0 from this function) when there are zero matches — callers count
# lines, they don't rely on grep's exit code (which is 1, not an error, on no-match).
grep_scan() {
  local pattern="$1" ci="${2:-}"
  ((${#SCAN_FILES[@]})) || return 0
  local -a opts=(-n -o -E -I)
  [[ "$ci" == "-i" ]] && opts+=(-i)
  local f abs raw linenum matchtext
  for f in "${SCAN_FILES[@]}"; do
    abs="$(abs_path "$f")"
    [[ -f "$abs" ]] || continue
    while IFS= read -r raw; do
      [[ -z "$raw" ]] && continue
      linenum="${raw%%:*}"      # longest suffix match on `:*` -> strips from the FIRST colon on
      matchtext="${raw#*:}"     # shortest prefix match on `*:` -> keeps everything after it
      printf '%s\t%s\t%s\n' "$f" "$linenum" "$matchtext"
    done < <(grep "${opts[@]}" -- "$pattern" "$abs" 2>/dev/null)
  done
}

# grep_fixed_scan LITERAL — same as grep_scan but fixed-string (-F), for denylist values
# and other exact literals that must never be treated as a regex.
grep_fixed_scan() {
  local literal="$1"
  [[ -z "$literal" ]] && return 0
  ((${#SCAN_FILES[@]})) || return 0
  local f abs raw linenum matchtext
  for f in "${SCAN_FILES[@]}"; do
    abs="$(abs_path "$f")"
    [[ -f "$abs" ]] || continue
    while IFS= read -r raw; do
      [[ -z "$raw" ]] && continue
      linenum="${raw%%:*}"
      matchtext="${raw#*:}"
      printf '%s\t%s\t%s\n' "$f" "$linenum" "$matchtext"
    done < <(grep -n -o -F -I -- "$literal" "$abs" 2>/dev/null)
  done
}

# grep_scan_line PATTERN [-i] — like grep_scan, but emits the FULL matching line instead of
# just the matched token (no -o). Used only by PG-3, whose allowlist needs to test a
# reviewed substring against surrounding context, not the bare matched word (e.g.
# distinguishing an innocent generic mention from one naming the estate).
grep_scan_line() {
  local pattern="$1" ci="${2:-}"
  ((${#SCAN_FILES[@]})) || return 0
  local -a opts=(-n -E -I)
  [[ "$ci" == "-i" ]] && opts+=(-i)
  local f abs raw linenum linetext
  for f in "${SCAN_FILES[@]}"; do
    abs="$(abs_path "$f")"
    [[ -f "$abs" ]] || continue
    while IFS= read -r raw; do
      [[ -z "$raw" ]] && continue
      linenum="${raw%%:*}"
      linetext="${raw#*:}"
      printf '%s\t%s\t%s\n' "$f" "$linenum" "$linetext"
    done < <(grep "${opts[@]}" -- "$pattern" "$abs" 2>/dev/null)
  done
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-1 — Real account ids
# (a) exact-match any denylist-file id -> FAIL. (b) any :[0-9]{12}: ARN-context id not in
# the public allowlist -> FAIL. (c) bare 12-digit numbers elsewhere -> ADVISORY.
# ═════════════════════════════════════════════════════════════════════════════════════
PG1_ALLOWLIST_IDS=(123456789012 111122223333 444455556666 111111111111 276181064229 439286490199 000000000000 222222222222 333333333333 999999999999)
_in_pg1_allowlist() {
  local id="$1" a
  for a in "${PG1_ALLOWLIST_IDS[@]}"; do [[ "$id" == "$a" ]] && return 0; done
  return 1
}

check_pg1() {
  local f ln m id2

  local total_a=0 example_a=""
  for id2 in "${DL_ACCOUNT_IDS[@]}"; do
    while IFS=$'\t' read -r f ln m; do
      [[ -z "$f" ]] && continue
      total_a=$((total_a + 1))
      [[ -z "$example_a" ]] && example_a="$f:$ln"
    done < <(grep_fixed_scan "$id2")
  done
  record "PG-1a" "$([[ $total_a -gt 0 ]] && echo FAIL || echo PASS)" "$total_a" \
    "Real account ids (denylist exact-match)" "$example_a"

  local total_b=0 example_b=""
  while IFS=$'\t' read -r f ln m; do
    [[ -z "$f" ]] && continue
    id2="${m//:/}"
    if ! _in_pg1_allowlist "$id2"; then
      total_b=$((total_b + 1))
      [[ -z "$example_b" ]] && example_b="$f:$ln (id $id2)"
    fi
  done < <(grep_scan ':[0-9]{12}:')
  record "PG-1b" "$([[ $total_b -gt 0 ]] && echo FAIL || echo PASS)" "$total_b" \
    "Real account ids (ARN-context id not in the public allowlist)" "$example_b"

  local total_c=0 example_c=""
  while IFS=$'\t' read -r f ln m; do
    [[ -z "$f" ]] && continue
    total_c=$((total_c + 1))
    [[ -z "$example_c" ]] && example_c="$f:$ln ($m)"
  done < <(grep_scan '\b[0-9]{12}\b')
  record "PG-1c" "ADVISORY" "$total_c" \
    "Bare 12-digit numbers, human triage (byte-size literals stay legal)" "$example_c"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-2 — Customer identity. Deliberately DENYLIST-ONLY: no real customer domain fragment
# is hardcoded in this committed script. Plan §8.2's own rule text for this check names
# specific real domains — but embedding those here would BE the leak this check exists to
# catch, since this file ships public (the S1 task's hard safety rule wins over the spec's
# literal check text where the two are in tension; see this lane's PR body). This satisfies
# the check's INTENT — fail on the estate's real customer domains — by sourcing them
# exclusively from the untracked --denylist file's `domains` array (grep_fixed_scan, exact
# literal match, never a regex built from denylist content).
#
# In generic-patterns mode (no denylist — the public repo's forever-CI posture) this check
# has nothing to compare against and reports zero. That's expected, not a weakness: those
# specific real domains have no legitimate reason to ever reappear in a generic tool repo,
# and PG-1/PG-4/PG-6/PG-9/PG-10 remain fully generic and denylist-independent as the
# forever backstop against NEW, not-yet-known real values of every OTHER category.
# ═════════════════════════════════════════════════════════════════════════════════════
check_pg2() {
  local total=0 example="" f ln m d
  for d in "${DL_DOMAINS[@]}"; do
    while IFS=$'\t' read -r f ln m; do
      [[ -z "$f" ]] && continue
      total=$((total + 1))
      [[ -z "$example" ]] && example="$f:$ln"
    done < <(grep_fixed_scan "$d")
  done
  record "PG-2" "$([[ $total -gt 0 ]] && echo FAIL || echo PASS)" "$total" \
    "Customer identity (denylist domains only — see check_pg2 comment for why)" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-3 — Estate vocabulary: word-bounded, case-insensitive, minus
# scripts/split/publish-gate-allowlist.txt (file+substring scoped reviewed exceptions).
# The committed script names NO estate word. The whole term list is sourced from the
# untracked .estate-denylist.json (its `region` + `estateTerms` arrays). In the public
# checkout that file is absent, so the list is empty and PG-3 reports zero — a generic
# tool has no estate vocabulary to catch; the private CI materializes the file for full
# strength.
# ═════════════════════════════════════════════════════════════════════════════════════
check_pg3() {
  local total=0 example="" f ln line p t esc
  local -a patterns=()
  # The real region(s), estate term(s), and brand name(s) come only from
  # .estate-denylist.json, matched word-bounded, case-insensitive, with the same
  # gate-own-config + allowlist exemptions. Empty in the public checkout (every array
  # empty → this loop adds nothing → PG-3 zero).
  for t in "${DL_REGIONS[@]}" "${DL_ESTATE_TERMS[@]}" "${DL_BRAND[@]}"; do
    [[ -z "$t" ]] && continue
    esc="$(printf '%s' "$t" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
    patterns+=("\\b${esc}\\b")
  done
  for p in "${patterns[@]}"; do
    while IFS=$'\t' read -r f ln line; do
      [[ -z "$f" ]] && continue
      _is_gate_own_config "$f" && continue
      _gate_allowlisted "$f" "$line" && continue
      total=$((total + 1))
      [[ -z "$example" ]] && example="$f:$ln"
    done < <(grep_scan_line "$p" -i)
  done
  record "PG-3" "$([[ $total -gt 0 ]] && echo FAIL || echo PASS)" "$total" \
    "Estate vocabulary + denylist region/terms, word-bounded (generic list in check_pg3)" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-4 — AWS key IDs: every AKIA[0-9A-Z]{16} must be in the public example set; anything
# else -> FAIL. ASIA... temp-key shapes -> FAIL always (no allowlist).
# ═════════════════════════════════════════════════════════════════════════════════════
PG4_ALLOWLIST_AKIA=(AKIA1234567890ABCDEF AKIAIOSFODNN7EXAMPLE)
_pg4_build_allowlist() {
  local i
  for i in $(seq -w 1 13); do
    PG4_ALLOWLIST_AKIA+=("AKIAEXAMPLE0000000${i}")
  done
}
_pg4_build_allowlist
_in_pg4_allowlist() {
  local v="$1" a
  for a in "${PG4_ALLOWLIST_AKIA[@]}"; do [[ "$v" == "$a" ]] && return 0; done
  return 1
}

check_pg4() {
  local total=0 example="" f ln m
  while IFS=$'\t' read -r f ln m; do
    [[ -z "$f" ]] && continue
    if ! _in_pg4_allowlist "$m"; then
      total=$((total + 1))
      [[ -z "$example" ]] && example="$f:$ln"
    fi
  done < <(grep_scan 'AKIA[0-9A-Z]{16}')
  while IFS=$'\t' read -r f ln m; do
    [[ -z "$f" ]] && continue
    total=$((total + 1))
    [[ -z "$example" ]] && example="$f:$ln (ASIA temp-key shape)"
  done < <(grep_scan 'ASIA[0-9A-Z]{16}')
  record "PG-4" "$([[ $total -gt 0 ]] && echo FAIL || echo PASS)" "$total" \
    "AWS key IDs not in the public AKIA example set, or any ASIA temp-key shape" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-5 — Secret-shaped assignments: a GUID/base64/hex value >=16 chars assigned to a
# *_TOKEN|*_SECRET|*_KEY|password-named attribute -> FAIL, unless the sentinel or an
# .env.example placeholder; plus exact-match of every denylist secret anywhere -> FAIL.
#
# The attribute-name heuristic is intentionally approximate (a lightweight layer, not a
# secret-shape authority) — PG-9 (gitleaks) is the authoritative, entropy-aware detector;
# this check exists to still catch something even when gitleaks isn't installed.
# ═════════════════════════════════════════════════════════════════════════════════════
# The two GUID-shaped literals are DELIBERATELY-FAKE test tokens, never real secrets: the
# SCRUB_SENTINEL_GUID (S-1 re-oracle) and the redaction-suite stand-in "fakeToken" shared
# verbatim by ccp/app/src/test/redact.test.ts and tools/catalogctl/internal/hclops/redact_test.go.
PG5_PLACEHOLDER_MARKERS='REPLACE_ME|replace_me|CHANGE_ME|change-me|changeme|not-a-real-secret|do-not-commit|SuperSecret12345|hardcoded-literal-password|plainlookingword|12345678-1234-5678-1234-567812345678|deadbeef-0000-4000-8000-000000000000'

check_pg5() {
  local total=0 example="" f ln m s

  local -a heuristic_files=()
  for f in "${SCAN_FILES[@]}"; do
    _is_env_example "$f" && continue   # whole file class exempt, placeholder-only by convention
    heuristic_files+=("$f")
  done
  local -a saved_scan_files=("${SCAN_FILES[@]}")
  SCAN_FILES=("${heuristic_files[@]}")
  while IFS=$'\t' read -r f ln m; do
    [[ -z "$f" ]] && continue
    [[ "$m" =~ $PG5_PLACEHOLDER_MARKERS ]] && continue
    total=$((total + 1))
    [[ -z "$example" ]] && example="$f:$ln"
  done < <(grep_scan '(_TOKEN|_SECRET|_KEY|[Pp]assword)[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9+/=_-]{16,}')
  SCAN_FILES=("${saved_scan_files[@]}")

  for s in "${DL_SECRETS[@]}"; do
    while IFS=$'\t' read -r f ln m; do
      [[ -z "$f" ]] && continue
      total=$((total + 1))
      [[ -z "$example" ]] && example="$f:$ln (denylist secret)"
    done < <(grep_fixed_scan "$s")
  done

  record "PG-5" "$([[ $total -gt 0 ]] && echo FAIL || echo PASS)" "$total" \
    "Secret-shaped *_TOKEN/*_SECRET/*_KEY/password assignments, or a denylist secret" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-6 — People: any email-shaped string not @example.{com,net,org} and not in the
# built-in allowlist -> FAIL; denylist-file emails/names -> FAIL.
# ═════════════════════════════════════════════════════════════════════════════════════
PG6_ALLOWLISTED_EMAILS=(noreply@github.com noreply@anthropic.com a@b.com)
_pg6_allowlisted_email() {
  local v="$1" a
  # example.com/.net/.org (plan §3) plus the *.example TLD itself and any subdomain of it
  # (foo.example, foo.bar.example, ...) — all four are IANA/RFC 2606-reserved specifically
  # for documentation, same family as the plan's own placeholder scheme.
  case "$v" in *@example.com|*@example.net|*@example.org|*@*.example|*@example) return 0 ;; esac
  for a in "${PG6_ALLOWLISTED_EMAILS[@]}"; do [[ "$v" == "$a" ]] && return 0; done
  return 1
}

check_pg6() {
  local total=0 example="" f ln m e n

  while IFS=$'\t' read -r f ln m; do
    [[ -z "$f" ]] && continue
    _pg6_allowlisted_email "$m" && continue
    case "$f" in */package-lock.json|package-lock.json) continue ;; esac
    total=$((total + 1))
    [[ -z "$example" ]] && example="$f:$ln"
  done < <(grep_scan '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')

  for e in "${DL_EMAILS[@]}"; do
    while IFS=$'\t' read -r f ln m; do
      [[ -z "$f" ]] && continue
      total=$((total + 1))
      [[ -z "$example" ]] && example="$f:$ln (denylist email)"
    done < <(grep_fixed_scan "$e")
  done
  for n in "${DL_NAMES[@]}"; do
    while IFS=$'\t' read -r f ln m; do
      [[ -z "$f" ]] && continue
      total=$((total + 1))
      [[ -z "$example" ]] && example="$f:$ln (denylist name)"
    done < <(grep_fixed_scan "$n")
  done

  record "PG-6" "$([[ $total -gt 0 ]] && echo FAIL || echo PASS)" "$total" \
    "People: non-example emails, or a denylist email/name" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-7 — Private-path escapees: any path in the scanned tree matching
# scripts/split/public-excludes.txt -> FAIL. Meaningful in "default" (by construction
# should be vacuous — the same excludes list already built the scan set) and "tree"
# (assembled-tree re-check, its real job per §2.3) modes. SKIPPED under --scope: a lane's
# write-set may legitimately include a private-adjacent path as normal PR hygiene, and
# that must not fail the publish gate — the gate's job is guarding the PUBLIC push, not
# policing every lane's PR contents.
# ═════════════════════════════════════════════════════════════════════════════════════
check_pg7() {
  if [[ "$MODE" == "scope" ]]; then
    record "PG-7" "SKIP" 0 "Private-path escapees (not applicable under --scope)" ""
    return
  fi
  local -a exclude_patterns=() manifest_patterns=()
  mapfile -t exclude_patterns < <(_load_patterns "$EXCLUDES_FILE")
  mapfile -t manifest_patterns < <(_load_patterns "$MANIFEST_FILE")
  local total=0 example="" f
  for f in "${SCAN_FILES[@]}"; do
    if _matches_any "$f" "${exclude_patterns[@]}"; then
      # A path listed in BOTH the manifest and the excludes is an intentional dual: the
      # private version is kept out of the assembled tree (excludes wins in resolve_files),
      # and a public overlay ships a generic replacement at the SAME path (README.md,
      # SECURITY.md, CONTRIBUTING.md, …, blessed via public-manifest.txt). Such a file in an
      # assembled --tree is the blessed public copy, not a private escapee — skip it. A
      # genuine escapee matches the excludes but is NOT manifest-blessed, and still fails.
      _matches_any "$f" "${manifest_patterns[@]}" && continue
      total=$((total + 1))
      [[ -z "$example" ]] && example="$f"
    fi
  done
  record "PG-7" "$([[ $total -gt 0 ]] && echo FAIL || echo PASS)" "$total" \
    "Private-path escapees (matches excludes and NOT the manifest overlay-bless list)" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-8 — Binary/state blobs: *.zip, *.pem, *.pfx, *.tfstate*, *tfplan*, real .env
# (non-.example), id_rsa* -> FAIL.
# ═════════════════════════════════════════════════════════════════════════════════════
check_pg8() {
  local total=0 example="" f base
  for f in "${SCAN_FILES[@]}"; do
    base="$(basename -- "$f")"
    case "$base" in
      *.zip|*.pem|*.pfx|*.tfstate*|*tfplan*|id_rsa*)
        total=$((total + 1)); [[ -z "$example" ]] && example="$f" ;;
    esac
    if _is_env_nonexample "$f"; then
      total=$((total + 1)); [[ -z "$example" ]] && example="$f"
    fi
  done
  record "PG-8" "$([[ $total -gt 0 ]] && echo FAIL || echo PASS)" "$total" \
    "Binary/state blobs (zip/pem/pfx/tfstate/tfplan/real .env/id_rsa)" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-9 — gitleaks: `gitleaks dir <staged copy of SCAN_FILES>` with .gitleaks.toml -> zero
# findings. Degrades gracefully (SKIP, never FAIL/crash) if gitleaks isn't installed.
# Assembled-tree (--tree) runs add a best-effort trufflehog filesystem pass, same
# graceful-degradation posture, per §8.2's "belt-and-braces" note.
# ═════════════════════════════════════════════════════════════════════════════════════
check_pg9() {
  if ! command -v gitleaks >/dev/null 2>&1; then
    echo "publish-gate.sh: WARNING — gitleaks not found; install for full coverage (PG-9 skipped). See https://github.com/gitleaks/gitleaks" >&2
    record "PG-9" "SKIP" 0 "gitleaks (not installed)" ""
    return
  fi
  if ((${#SCAN_FILES[@]} == 0)); then
    record "PG-9" "PASS" 0 "gitleaks (nothing in scope)" ""
    return
  fi

  local stage; stage="$(mktemp -d)"
  local f abs dest
  for f in "${SCAN_FILES[@]}"; do
    abs="$(abs_path "$f")"
    [[ -f "$abs" ]] || continue
    dest="$stage/$f"
    mkdir -p -- "$(dirname -- "$dest")"
    cp -- "$abs" "$dest" 2>/dev/null
  done

  local report; report="$(mktemp)"
  local cfg_args=()
  [[ -f "$GITLEAKS_CONFIG" ]] && cfg_args=(--config "$GITLEAKS_CONFIG")
  gitleaks dir "$stage" "${cfg_args[@]}" --report-format json --report-path "$report" \
    --exit-code 0 --no-banner >/dev/null 2>&1

  local count=0 example=""
  if command -v jq >/dev/null 2>&1 && [[ -s "$report" ]]; then
    count="$(jq 'length' "$report" 2>/dev/null || echo 0)"
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
    if ((count > 0)); then
      example="$(jq -r '.[0] | "\(.File):\(.StartLine) (\(.RuleID))"' "$report" 2>/dev/null)"
      # rewrite the staged absolute path back to the relative path for a useful example
      example="${example#"$stage"/}"
    fi
  fi
  rm -rf -- "$stage" "$report"

  record "PG-9" "$([[ $count -gt 0 ]] && echo FAIL || echo PASS)" "$count" \
    "gitleaks findings (.gitleaks.toml)" "$example"

  if [[ "$MODE" == "tree" ]]; then
    if command -v trufflehog >/dev/null 2>&1; then
      local th_report; th_report="$(mktemp)"
      trufflehog filesystem "$TREE_DIR" --no-verification --no-update --json \
        >"$th_report" 2>/dev/null
      local th_count=0
      th_count="$(grep -c . "$th_report" 2>/dev/null || echo 0)"
      record "PG-9t" "ADVISORY" "$th_count" "trufflehog filesystem pass (assembled-tree belt-and-braces)" ""
      rm -f -- "$th_report"
    else
      echo "publish-gate.sh: WARNING — trufflehog not found; assembled-tree belt-and-braces pass skipped." >&2
      record "PG-9t" "SKIP" 0 "trufflehog (not installed)" ""
    fi
  fi
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-10 — Private-repo self-reference: the private repo's own name must never appear in the
# public tree. The committed script names NO repo — the string(s) come only from
# .estate-denylist.json's `repoNames` array, scanned as a plain substring so an owner-prefixed
# `owner/repo` form is caught for free (the shorter string is always a substring of the
# longer one). Empty in the public checkout → PG-10 reports zero. Minus gate-own-config +
# the reviewed allowlist (see check_pg3's comment).
# ═════════════════════════════════════════════════════════════════════════════════════
check_pg10() {
  local total=0 example="" f ln line r esc
  for r in "${DL_REPO_NAMES[@]}"; do
    [[ -z "$r" ]] && continue
    esc="$(printf '%s' "$r" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
    while IFS=$'\t' read -r f ln line; do
      [[ -z "$f" ]] && continue
      _is_gate_own_config "$f" && continue
      _gate_allowlisted "$f" "$line" && continue
      total=$((total + 1))
      [[ -z "$example" ]] && example="$f:$ln"
    done < <(grep_scan_line "$esc")
  done
  record "PG-10" "$([[ $total -gt 0 ]] && echo FAIL || echo PASS)" "$total" \
    "Private-repo self-reference (denylist repoNames only — empty/zero in the public build)" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# PG-11 — RFC1918 topology: ADVISORY only, never fails (synthetic 10.0.x.x test CIDRs are
# legitimate; reviewers eyeball the report on the assembled tree).
# ═════════════════════════════════════════════════════════════════════════════════════
check_pg11() {
  local total=0 example="" f ln m
  while IFS=$'\t' read -r f ln m; do
    [[ -z "$f" ]] && continue
    total=$((total + 1))
    [[ -z "$example" ]] && example="$f:$ln ($m)"
  done < <(grep_scan '\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})\b')
  record "PG-11" "ADVISORY" "$total" "RFC1918 private-IP literals (human triage on the assembled tree)" "$example"
}

# ═════════════════════════════════════════════════════════════════════════════════════
# Run every check, then report + exit.
# ═════════════════════════════════════════════════════════════════════════════════════
check_pg1
check_pg2
check_pg3
check_pg4
check_pg5
check_pg6
check_pg7
check_pg8
check_pg9
check_pg10
check_pg11

print_report() {
  printf '%-7s %-9s %7s  %s\n' "CHECK" "STATUS" "COUNT" "DESCRIPTION"
  printf '%-7s %-9s %7s  %s\n' "-----" "------" "-----" "-----------"
  local i
  for i in "${!CHECK_IDS[@]}"; do
    printf '%-7s %-9s %7s  %s\n' "${CHECK_IDS[$i]}" "${CHECK_STATUS[$i]}" "${CHECK_COUNTS[$i]}" "${CHECK_DESCS[$i]}"
    if [[ -n "${CHECK_EXAMPLES[$i]}" ]] && { [[ "${CHECK_STATUS[$i]}" == "FAIL" ]] || ((REPORT)); }; then
      printf '        %-9s %7s  example: %s\n' "" "" "${CHECK_EXAMPLES[$i]}"
    fi
  done
}

echo "publish-gate.sh — mode=${MODE}  files-scanned=${#SCAN_FILES[@]}  denylist=$(((DENYLIST_LOADED)) && echo "$DENYLIST_FILE" || echo "none (generic-patterns mode)")"
echo

if ((FOUND_FAIL)) || ((REPORT)); then
  print_report
else
  echo "All checks clean (zero hard-fail findings). Pass --report for the full per-check table."
fi
echo

if ((FOUND_FAIL)); then
  echo "publish-gate.sh: FAIL — one or more checks reported a finding. See table above."
  exit 1
fi
echo "publish-gate.sh: PASS — zero findings across all hard-fail checks."
exit 0
