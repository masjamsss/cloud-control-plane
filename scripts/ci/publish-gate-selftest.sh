#!/usr/bin/env bash
# publish-gate-selftest.sh — does PG-5 catch the shapes people actually commit by accident?
#
# CI-8 measured the old pattern `(_TOKEN|_SECRET|_KEY|[Pp]assword)` against real-world
# shapes and found it blind to the most common one of all — `ADMIN_PASSWORD=`, because
# `[Pp]assword` cannot match all-caps and all-caps IS the env-var convention. A secret
# heuristic nobody has probed is a heuristic nobody can trust, so this probes it, using the
# gate's own `--tree` mode against synthetic trees where the answer is known.
#
# Both directions are asserted, and the second is the one that keeps the check alive: a
# pattern that flags `const tKey = uploadTokenKey(id)` produces dozens of false positives on
# this repo, and a gate that cries wolf gets switched off. Case-insensitivity was the
# obvious fix and is the wrong one for exactly that reason — measured, 7 hits became 49.
#
# NOTE ON THIS FILE'S OWN CONTENT: the probe values are ASSEMBLED AT RUNTIME and never
# written here as a secret-shaped assignment, so this script does not trip the check it
# tests. That is not a trick — it is the same trap CI-8 itself documents, where the audit
# report could not quote its own probes without failing the gate it was describing.
#
# Exit codes: 0 every probe behaved · 1 a probe did not · 2 setup/internal error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${PUBLISH_GATE:-$ROOT/scripts/publish-gate.sh}"

[[ -f "$GATE" ]] || { echo "selftest: no publish gate at $GATE" >&2; exit 2; }

# The gate under test must not be the one that hard-fails on a missing gitleaks: these runs
# are about PG-5's pattern, and a laptop without gitleaks would otherwise fail every one.
unset PUBLISH_GATE_REQUIRE_ALL

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

# 16+ chars of the value class, built in two halves so the literal never appears next to a
# secret-shaped name anywhere in this file.
PROBE_VALUE="Zk4mQ8pR2t$(printf '%s' 'Vx7Ly3')"

pg5_count() { # pg5_count <dir> -> the PG-5 finding count the gate reports for that tree
  local out
  out="$("$GATE" --tree "$1" --report 2>/dev/null || true)"
  local n
  n="$(printf '%s\n' "$out" | awk '$1 == "PG-5" { print $3; exit }')"
  [[ -n "$n" ]] || { echo "selftest: could not read a PG-5 row from the gate's report — the harness is broken, which is not a pass" >&2; exit 2; }
  printf '%s' "$n"
}

check() { # check <name> <expected count> <actual count>
  if [ "$2" != "$3" ]; then
    echo "SELFTEST FAIL — $1: expected PG-5 to report $2 finding(s), got $3." >&2
    failures=$((failures + 1))
    return
  fi
  echo "selftest: ok — $1"
}

# ── 1 · the shapes that must be caught ─────────────────────────────────────────────────
# Five real-world assignment shapes. The first three are the ones CI-8 proved the old
# pattern missed; client_secret is the OAuth shape the finding did not name; API_TOKEN is
# the control case the old pattern already caught, here so a rewrite cannot lose it.
scenario_caught() {
  local d="$TMP/caught"
  mkdir -p "$d"
  {
    printf 'ADMIN_PASSWORD=%s\n' "$PROBE_VALUE"
    printf 'DB_PASSWD: %s\n' "$PROBE_VALUE"
    printf 'apikey = "%sabc"\n' "$PROBE_VALUE"
    printf 'client_secret: %sabc\n' "$PROBE_VALUE"
    printf 'API_TOKEN=%sabc\n' "$PROBE_VALUE"
  } >"$d/app.env"
  check "the five real-world secret shapes are all caught" 5 "$(pg5_count "$d")"
}

# ── 2 · the code shapes that must NOT be caught ────────────────────────────────────────
# camelCase identifier assignments, lifted verbatim from ccp/api/src/routes/drift.ts and
# RequestForm.tsx. Under a case-insensitive pattern every one of these is a finding — this
# is the scenario that fails when someone "simplifies" the pattern by adding -i.
scenario_not_caught() {
  local d="$TMP/code"
  mkdir -p "$d"
  {
    printf 'const tKey = uploadTokenKey(projectId);\n'
    printf 'const driftVersionKey = makeVersionKey(project);\n'
    printf 'const pKey = driftPointerKey(project);\n'
    printf 'setState({ rKey: currentDraftKey });\n'
    printf 'const eKey = readFileSync(credentialPath);\n'
  } >"$d/routes.ts"
  check "camelCase identifier assignments are not secrets" 0 "$(pg5_count "$d")"
}

# ── 3 · placeholders stay exempt (the over-fix guard) ──────────────────────────────────
# Widening the name pattern must not start failing .env.example-style placeholder lines;
# without this, the cheapest way to make scenario 1 pass is a pattern that flags everything.
scenario_placeholders() {
  local d="$TMP/placeholder"
  mkdir -p "$d"
  {
    printf 'CCP_SESSION_KEY=REPLACE_ME__run_openssl_rand_hex_32\n'
    printf 'CCP_UPLOAD_TOKEN=change-me-to-a-long-random-value\n'
  } >"$d/sample.env"
  check "documented placeholders are still exempt" 0 "$(pg5_count "$d")"
}

scenario_caught
scenario_not_caught
scenario_placeholders

if [ "$failures" -ne 0 ]; then
  echo "publish-gate-selftest: $failures probe(s) FAILED" >&2
  exit 1
fi
echo "publish-gate-selftest: PASS — 3 probes"
