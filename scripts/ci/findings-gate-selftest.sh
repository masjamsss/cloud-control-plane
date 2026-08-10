#!/usr/bin/env bash
# findings-gate-selftest.sh — does the L-28 sha check actually catch a dangling reference?
#
# `scripts/findings-gate.sh` verifies that every `fixed:<sha>` in FINDINGS.md is an ancestor
# of HEAD. That check is itself a piece of evidence, and the rule this repo runs on is that
# a reference nobody dereferences is not evidence — which applies to the checker as much as
# to the thing checked. So this drives the real gate against four synthetic repositories
# where the correct answer is known before it runs.
#
# Scenario B is the one that matters. L-28 was written about eight shas destroyed by
# `git commit --amend`; a destroyed commit is in no clone, and the check used to skip
# exactly those as "not in this clone" — so it passed on its own motivating case, and
# nothing said otherwise. B reproduces that workflow (record the sha, amend it away, clone
# the way a merge does) and requires a failure.
#
# Written as rules rather than as a list of today's offenders (L-25): each scenario states a
# property of the check — catches a destroyed sha, catches an unmerged one, passes a good
# one, refuses to fail on checkout depth — so a future rewrite of the gate is held to the
# same four, however it is implemented.
#
#   FINDINGS_GATE=<path>  run a different copy of the gate (used to prove these fail
#                         against the unfixed script — see FIXES.md, CI-3).
#
# Exit codes: 0 every scenario behaved · 1 a scenario did not · 2 setup/internal error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${FINDINGS_GATE:-$ROOT/scripts/findings-gate.sh}"

[[ -f "$GATE" ]] || { echo "selftest: no gate at $GATE" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "selftest: python3 is required" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
OUT="$TMP/out.txt"

git_at() { # git_at <dir> <args...> — commits without depending on the runner's git identity
  # example.com, not example.invalid: PG-6 allowlists the RFC 2606 documentation domains
  # by name, and a bare-runner CI box has no user.email at all, so both have to be handled
  # here rather than assumed.
  git -C "$1" -c user.email=selftest@example.com -c user.name=selftest \
      -c commit.gpgsign=false "${@:2}"
}

# Rewrite every `fixed:<sha>` in a fixture's ledger to point at one known commit, and FAIL
# LOUDLY if it rewrote nothing — a fixture that silently did not take would let every
# scenario below pass for the wrong reason (L-1).
repoint() { # repoint <findings.md> <sha>
  python3 - "$1" "$2" <<'PY'
import re, sys
path, sha = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
text, n = re.subn(r"fixed:[0-9a-f]{7,40}", "fixed:" + sha, text)
if n == 0:
    sys.exit("selftest: fixture did not take — no `fixed:<sha>` reference in " + path)
open(path, "w", encoding="utf-8").write(text)
PY
}

# Point exactly one reference somewhere else, so a fixture can hold two distinct shas.
repoint_first() { # repoint_first <findings.md> <old sha> <new sha>
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
if ("fixed:" + old) not in text:
    sys.exit("selftest: fixture did not take — no `fixed:%s` in %s" % (old, path))
open(path, "w", encoding="utf-8").write(text.replace("fixed:" + old, "fixed:" + new, 1))
PY
}

# A fixture is the repo's own audit ledger and scripts, committed into a throwaway history
# so the `fixed:` shas can be pointed anywhere. Using the real FINDINGS.md keeps every
# other check in the gate satisfied, so a scenario's verdict is about the sha check alone.
make_base() { # make_base <dir> -> prints the sha of the "evidence" commit
  local d="$1"
  mkdir -p "$d/docs"
  git -C "$d" init -q
  git -C "$d" symbolic-ref HEAD refs/heads/main
  cp -R "$ROOT/scripts" "$d/scripts"
  cp -R "$ROOT/docs/audit" "$d/docs/audit"
  cp "$GATE" "$d/scripts/findings-gate.sh"
  git_at "$d" add -A
  git_at "$d" commit -q -m "fixture: audit ledger and scripts"

  # The commit a finding would cite as its evidence.
  echo "the fix" >"$d/fix.txt"
  git_at "$d" add -A
  git_at "$d" commit -q -m "fixture: the fix being cited"
  git -C "$d" rev-parse --short HEAD
}

run_gate() { # run_gate <dir> -> exit code in $rc, combined output in $OUT
  rc=0
  ( cd "$1" && bash scripts/findings-gate.sh ) >"$OUT" 2>&1 || rc=$?
}

check() { # check <name> <expected: pass|fail> <substring that must appear>...
  local name="$1" expect="$2" needle
  local verdict="pass"
  [ "$rc" -eq 0 ] || verdict="fail"
  shift 2

  if [ "$verdict" != "$expect" ]; then
    echo "SELFTEST FAIL — $name: expected the gate to $expect, it exited $rc." >&2
    sed 's/^/    | /' "$OUT" >&2
    failures=$((failures + 1))
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" "$OUT"; then
      echo "SELFTEST FAIL — $name: gate did $expect as expected, but never said \"$needle\"." >&2
      sed 's/^/    | /' "$OUT" >&2
      failures=$((failures + 1))
      return
    fi
  done
  echo "selftest: ok — $name"
}

# ── A · a sha that is an ancestor of HEAD passes, and is counted as verified ────────────
# The over-fix guard. Everything below makes the check refuse things; this one makes sure
# it still accepts the case the ledger is full of, and that the count is the dereferenced
# one rather than the number of references looked at.
scenario_reachable() {
  local d="$TMP/reachable" ev
  ev="$(make_base "$d")"
  repoint "$d/docs/audit/FINDINGS.md" "$ev"
  git_at "$d" add -A
  git_at "$d" commit -q -m "fixture: cite the fix"
  run_gate "$d"
  # Asserted on the count, not on the sentence around it, so a reworded summary line is not
  # a test failure while a miscounted one still is.
  check "reachable sha passes" pass "1 of 1"
}

# ── B · a sha destroyed by `git commit --amend` must be caught ──────────────────────────
# L-28's own workflow, reproduced: commit, read the sha, write it into the ledger, amend to
# fold the ledger edit in — which replaces the commit that the just-written sha names. The
# clone is not decoration. Right after an amend the old object is still in the local repo
# (the reflog holds it), so the defect is invisible there; it becomes visible in a clone
# that only ever received reachable objects, which is what merging to main produces. That
# is exactly when L-28 was discovered, by hand.
scenario_destroyed_by_amend() {
  local d="$TMP/amended" c="$TMP/amended-clone" ev
  ev="$(make_base "$d")"
  repoint "$d/docs/audit/FINDINGS.md" "$ev"
  git_at "$d" add -A
  git_at "$d" commit -q --amend --no-edit          # $ev now names nothing
  git clone -q "file://$d" "$c"                    # file:// so unreachable objects stay behind
  [ "$(git -C "$c" rev-parse --is-shallow-repository)" = "false" ] \
    || { echo "selftest: clone came out shallow, scenario B proves nothing" >&2; exit 2; }
  git -C "$c" cat-file -e "${ev}^{commit}" 2>/dev/null \
    && { echo "selftest: clone still has $ev, scenario B proves nothing" >&2; exit 2; }
  run_gate "$c"
  check "sha destroyed by amend is caught" fail "resolves to NOTHING"
}

# ── C · a sha that exists but was never merged must be caught ───────────────────────────
scenario_not_an_ancestor() {
  local d="$TMP/sidebranch" side
  make_base "$d" >/dev/null
  git_at "$d" checkout -q -b side
  echo "never merged" >"$d/side.txt"
  git_at "$d" add -A
  git_at "$d" commit -q -m "fixture: a commit on an unmerged branch"
  side="$(git -C "$d" rev-parse --short HEAD)"
  git_at "$d" checkout -q main
  repoint "$d/docs/audit/FINDINGS.md" "$side"
  git_at "$d" add -A
  git_at "$d" commit -q -m "fixture: cite the unmerged commit"
  run_gate "$d"
  check "unmerged sha is caught" fail "NOT an ancestor of HEAD"
}

# ── D · a shallow clone must not fail, and must not claim to have checked ───────────────
# The other half of L-1. Refusing here would fail on the checkout depth rather than on the
# ledger — but staying quiet lets "PASS" mean "I could not look".
#
# The fixture deliberately mixes ONE resolvable sha with ONE beyond the shallow boundary,
# because the all-or-nothing case was never the broken one: a checkout that resolves *some*
# references reported the resolvable count and said nothing at all about the rest. Observed
# on this repo at depth 100 — "25 of 31 verified reachable" followed by PASS, with six
# references silently unexamined and no way for the reader to tell which kind of six they
# were. So both halves are asserted: exit 0, and a total that accounts for every reference.
scenario_shallow() {
  local d="$TMP/deep" c="$TMP/shallow-clone" old recent
  old="$(make_base "$d")"

  echo "a second fix" >"$d/fix2.txt"
  git_at "$d" add -A
  git_at "$d" commit -q -m "fixture: a second fix, inside the shallow boundary"
  recent="$(git -C "$d" rev-parse --short HEAD)"

  repoint "$d/docs/audit/FINDINGS.md" "$old"
  repoint_first "$d/docs/audit/FINDINGS.md" "$old" "$recent"
  git_at "$d" add -A
  git_at "$d" commit -q -m "fixture: cite both fixes"

  git clone -q --depth=2 "file://$d" "$c"
  [ "$(git -C "$c" rev-parse --is-shallow-repository)" = "true" ] \
    || { echo "selftest: clone did not come out shallow, scenario D proves nothing" >&2; exit 2; }
  git -C "$c" cat-file -e "${recent}^{commit}" 2>/dev/null \
    || { echo "selftest: shallow clone cannot see $recent, scenario D proves nothing" >&2; exit 2; }
  git -C "$c" cat-file -e "${old}^{commit}" 2>/dev/null \
    && { echo "selftest: shallow clone can still see $old, scenario D proves nothing" >&2; exit 2; }

  run_gate "$c"
  check "shallow clone reports rather than refuses" pass "1 of 2" "NOT VERIFIED"
}

scenario_reachable
scenario_destroyed_by_amend
scenario_not_an_ancestor
scenario_shallow

if [ "$failures" -ne 0 ]; then
  echo "findings-gate-selftest: $failures scenario(s) FAILED" >&2
  exit 1
fi
echo "findings-gate-selftest: PASS — 4 scenarios"
