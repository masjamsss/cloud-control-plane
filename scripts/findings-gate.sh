#!/usr/bin/env bash
# findings-gate.sh — make docs/audit/FINDINGS.md binding.
#
# The audit reports in docs/audit/ carry findings. FINDINGS.md is the ledger that
# tracks what happened to each one. Without a gate, a finding can be quietly
# dropped from the ledger, or left with no status forever, and nothing notices.
#
# Two modes, deliberately:
#
#   (default)  RATCHET. Every finding in the reports must have a ledger entry,
#              every entry must parse, and the count of `open` findings must not
#              rise above scripts/findings-baseline.txt. This is what CI runs on
#              every PR: it lets the backlog be worked down incrementally while
#              making it impossible to add a finding and leave it untracked, or
#              to regress one that was already closed.
#
#   --strict   Fails while ANY finding is still `open`. This is the mode that
#              must pass before the audit work is considered finished. Wire it
#              into the final PR, not into everyday CI.
#
# Lower the baseline as findings close. Raising it is allowed ONLY when new findings
# were genuinely declared — and that is checked rather than trusted: the baseline file
# records BOTH counts, `<open> <declared>`, and a rise in `open` must be paid for by a
# rise in `declared`. So "we found more work" is expressible; "raise the number until
# the build goes green" is not, because it would require inventing findings in the
# reports to pay for it. A fall in `declared` fails outright — a finding cannot be
# retired by deleting it from a report.
#
# This distinction exists because the first honest attempt to record two newly-found
# defects hit a gate that forbade the raise outright, which would have created pressure
# NOT to write new findings down. A ratchet that punishes discovery is worse than no
# ratchet.
#
# Exit codes: 0 ok · 1 gate failure · 2 usage/internal error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="$ROOT/docs/audit/FINDINGS.md"
BASELINE_FILE="$ROOT/scripts/findings-baseline.txt"

# ── L-28: a `fixed:<sha>` must point at a commit that EXISTS AND IS REACHABLE ──────────
# The gate checked that `fixed:` carried *something*, never that the something resolved.
# Eight entries recorded a sha taken BEFORE a `git commit --amend`, which the amend then
# destroyed; they dangled from the moment they were written and nothing noticed until the
# branch was merged and the shas were checked against main by hand. A reference is only
# evidence if something dereferences it.
#
# A reference fails in two distinct ways, and for a long time this check caught only the
# second one:
#
#   1. **The sha resolves to nothing.** A `commit --amend` or a rebase destroyed the
#      object, so no clone anywhere can see it. **All eight of L-28's own entries are this
#      shape** — and the first version of this check skipped exactly them, as "not in this
#      clone". It passed on the case it was written to catch.
#   2. **The sha resolves but is not an ancestor of HEAD** — recorded on a branch that was
#      never merged, or superseded by a rewrite that left the original reachable.
#
# What makes case 1 safe to fail on is a property of clones, not of this repo: **a complete
# clone containing HEAD contains every ancestor of HEAD.** So when git says the clone is not
# shallow, "cannot resolve" is not a limit of the checkout — it is proof the sha is not an
# ancestor, which is the whole question. In a shallow clone it proves nothing, and refusing
# there would fail on the checkout depth rather than on the ledger.
#
# That unverifiable case must not look like a pass either — "PASS" would mean "I could not
# look" (L-1) — so it is counted and named on its own rather than folded into the verified
# total. `findings.yml` checks out full history precisely so this branch never runs in CI.
check_fixed_shas() {
  git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0

  # Only a positive "false" earns the right to fail on an unresolvable sha. If the query
  # itself cannot answer (older git, unusual checkout), assume the weaker position and
  # report the references as unverified instead of calling them dangling.
  local complete=0
  if [ "$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null)" = "false" ]; then
    complete=1
  fi

  local seen=0 verified=0 destroyed=0 dangling=0 unverified=0 sha
  for sha in $(grep -oE 'fixed:[0-9a-f]{7,40}' "$LEDGER" | sed 's/fixed://' | sort -u); do
    seen=$((seen + 1))
    if ! git -C "$ROOT" cat-file -e "${sha}^{commit}" 2>/dev/null; then
      if [ "$complete" -eq 1 ]; then
        echo "ERROR: FINDINGS.md cites fixed:${sha}, which resolves to NOTHING in a complete clone — every ancestor of HEAD is present here, so that sha is not one of them. A \`git commit --amend\` or rebase destroyed it after it was recorded (L-28)." >&2
        destroyed=$((destroyed + 1))
      else
        unverified=$((unverified + 1))
      fi
      continue
    fi
    if git -C "$ROOT" merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
      verified=$((verified + 1))
    else
      echo "ERROR: FINDINGS.md cites fixed:${sha}, which exists but is NOT an ancestor of HEAD — it was probably recorded before a \`git commit --amend\` rewrote it (L-28)." >&2
      dangling=$((dangling + 1))
    fi
  done

  # Report what was DEREFERENCED, never what was looked at. Each failing category is named
  # on the summary line as well as on stderr: a reader who sees only the last line of a
  # green-looking run still learns that part of the ledger went unchecked.
  if [ "$seen" -gt 0 ]; then
    local summary="findings-gate: $verified of $seen fixed:<sha> reference(s) verified reachable from HEAD"
    if [ "$dangling" -gt 0 ]; then
      summary="$summary; $dangling DANGLING"
    fi
    if [ "$destroyed" -gt 0 ]; then
      summary="$summary; $destroyed resolve to NOTHING"
    fi
    if [ "$unverified" -gt 0 ]; then
      summary="$summary; $unverified NOT VERIFIED (shallow clone — \`git fetch --unshallow\` to check them)"
    fi
    echo "$summary."
  fi

  [ "$((destroyed + dangling))" -eq 0 ]
}

AUDIT_DIR="$ROOT/docs/audit"

STRICT=0
case "${1:-}" in
  --strict) STRICT=1 ;;
  "") ;;
  *) echo "usage: findings-gate.sh [--strict]" >&2; exit 2 ;;
esac

[[ -f "$LEDGER" ]] || { echo "findings-gate: missing $LEDGER" >&2; exit 2; }

# L-28 — BEFORE the parse: a gate that prints "PASS" and then an error has told
# the reader the opposite of the truth on the line they will actually read.
check_fixed_shas || exit 1

python3 - "$AUDIT_DIR" "$LEDGER" "$BASELINE_FILE" "$STRICT" <<'PY' || exit 1
import sys, re, glob, os, subprocess
audit_dir, ledger_path, baseline_path, strict = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
SEV = r"critical|high|medium|low"

# --- findings as the reports actually declare them -------------------------
# The reports use several heading styles; all of them are load-bearing, so the
# parser accepts each rather than forcing one house style onto prose already
# written and reviewed.
declared = {}
for f in sorted(glob.glob(os.path.join(audit_dir, "*.md"))):
    base = os.path.basename(f)
    # FINDINGS.md and LESSONS.md are the tracking files, not reports. LESSONS.md in
    # particular numbers its entries `L-1`, which matches the finding-id shape.
    if base in ("README.md", "FINDINGS.md", "LESSONS.md", "RESIDUE.md"):
        continue
    for line in open(f, encoding="utf-8"):
        h = re.match(r"^###\s+([A-Z]+-\d+[a-z]?)\s*(.*)$", line)
        if h:
            declared[h.group(1)] = base

# --- the ledger ------------------------------------------------------------
topics_path = os.path.join(os.path.dirname(os.path.dirname(ledger_path)), "..", "scripts", "findings-topics.txt")
topics_path = os.path.normpath(topics_path)
try:
    valid_topics = {t.strip() for t in open(topics_path) if t.strip()}
except Exception:
    valid_topics = set()

ENTRY_PREFIX = re.compile(r"^- \[[ xX]\] [A-Z]+-\d+[a-z]? \|")
LINE = re.compile(
    r"^- \[(?P<box>[ xX])\] (?P<id>[A-Z]+-\d+[a-z]?) \| (?P<sev>%s) \| (?P<topic>[^|]+?) \| (?P<status>[^|]+?) \| (?P<report>[^|]+?) \| (?P<title>.*)$"
    % SEV
)
errors, entries = [], {}
in_fence = False
for n, line in enumerate(open(ledger_path, encoding="utf-8"), 1):
    # The header documents the line grammar inside a fenced block; that example
    # is not an entry, so fenced regions are skipped rather than parsed.
    if line.lstrip().startswith("```"):
        in_fence = not in_fence
        continue
    # An entry is a checkbox line whose first field is a finding id followed by `|`.
    # The header's "definition of done" is also a checkbox list, and is prose — matching
    # on the id-and-pipe prefix keeps the two apart without depending on line position.
    if in_fence or not ENTRY_PREFIX.match(line):
        continue
    m = LINE.match(line.rstrip("\n"))
    if not m:
        errors.append(f"{ledger_path}:{n}: malformed ledger line — check the grammar in the header")
        continue
    d = m.groupdict()
    if d["id"] in entries:
        errors.append(f"{ledger_path}:{n}: duplicate entry for {d['id']}")
    topic = d["topic"].strip()
    if not valid_topics:
        errors.append(f"findings-gate: cannot read topic list at {topics_path}")
    elif topic not in valid_topics:
        errors.append(
            f"{ledger_path}:{n}: {d['id']}: unknown topic '{topic}' "
            f"(add it to scripts/findings-topics.txt if it is genuinely new)"
        )
    status = d["status"].strip()
    kind = status.split(":", 1)[0]
    detail = status.split(":", 1)[1].strip() if ":" in status else ""
    if kind not in ("open", "fixed", "accepted", "deferred"):
        errors.append(f"{ledger_path}:{n}: {d['id']}: unknown status '{kind}'")
    elif kind != "open" and not detail:
        need = {"fixed": "evidence (commit/PR/test)", "accepted": "a reason", "deferred": "an owner"}[kind]
        errors.append(f"{ledger_path}:{n}: {d['id']}: status '{kind}' requires {need} after the colon")
    ticked = d["box"].lower() == "x"
    if (kind != "open") != ticked:
        errors.append(
            f"{ledger_path}:{n}: {d['id']}: checkbox and status disagree "
            f"(status '{kind}' but box is '{'[x]' if ticked else '[ ]'}')"
        )
    entries[d["id"]] = kind

# --- cross-checks ----------------------------------------------------------
for fid, report in sorted(declared.items()):
    if fid not in entries:
        errors.append(f"{report}: finding {fid} has no entry in docs/audit/FINDINGS.md — findings may not be silently dropped")
for fid in sorted(entries):
    if fid not in declared:
        errors.append(f"FINDINGS.md: {fid} is not declared by any report in docs/audit/ — stale or invented entry")

open_ids = sorted(f for f, k in entries.items() if k == "open")
n_open = len(open_ids)

# --- fix log ---------------------------------------------------------------
# Marking a finding `fixed:` requires a worked-through entry in FIXES.md. Without this,
# "fixed" is just a word someone typed into the ledger; with it, closing a finding means
# stating how the definition of done was met — including where it was not.
fixes_path = os.path.join(audit_dir, "FIXES.md")
documented_fixes = set()
if os.path.exists(fixes_path):
    fence = False
    for line in open(fixes_path, encoding="utf-8"):
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence:
            continue
        h = re.match(r"^## ([A-Z]+-\d+[a-z]?)\s*$", line)
        if h:
            documented_fixes.add(h.group(1))
for fid, kind in sorted(entries.items()):
    if kind == "fixed" and fid not in documented_fixes:
        errors.append(
            f"FINDINGS.md: {fid} is marked fixed but has no '## {fid}' entry in "
            "docs/audit/FIXES.md — a fix is not done until its checklist is filled in"
        )
for fid in sorted(documented_fixes):
    if fid not in declared:
        errors.append(f"FIXES.md: '## {fid}' is not a finding declared by any report")

# --- residue ledger --------------------------------------------------------
# RESIDUE.md lists what the fixes deliberately left behind. Individually each residue
# note inside a FIXES.md entry is honest; collectively they were invisible, and the same
# one got written three times without ever being tracked (see R-1). This check makes
# "left behind and forgotten" a build failure rather than a footnote on a closed finding.
#
# Three rules, each earning its place:
#   1. Every finding id cited must EXIST — a residue note pointing at nothing is worse
#      than no note, because it reads as tracked.
#   2. An item claiming to be `tracked` must cite at least one finding that is still
#      OPEN. A closed finding cannot be tracking anything, and this is exactly how
#      residue disappears: the finding that was going to cover it gets closed for other
#      reasons and the residue silently becomes nobody's.
#   3. Every FIXES.md section carrying a residue note must appear in RESIDUE.md. Without
#      this the file is a snapshot that decays; with it, adding a residue note to a fix
#      forces the item into the ledger.
residue_path = os.path.join(audit_dir, "RESIDUE.md")
n_residue = 0
if os.path.exists(residue_path):
    rtext = open(residue_path, encoding="utf-8").read()
    # An item: "### R-<n> · <title>", then prose until the next item.
    items = re.split(r"\n### (R-\d+)", rtext)
    seen_ids = set()
    for idx in range(1, len(items), 2):
        rid, body = items[idx], items[idx + 1]
        n_residue += 1
        if rid in seen_ids:
            errors.append(f"{residue_path}: duplicate residue id {rid}")
        seen_ids.add(rid)
        cited = set(re.findall(r"\b([A-Z]+-\d+[a-z]?)\b", body))
        for c in cited:
            # Not findings: L-<n> lessons, R-<n> residue cross-references, PG-<n>
            # publish-gate check ids, and ADR-<n> decision records. All share the
            # <LETTERS>-<digits> shape, so the exclusion has to be explicit.
            if c.startswith(("L-", "R-", "PG-", "ADR-")):
                continue
            if c not in declared:
                errors.append(
                    f"{residue_path}: {rid} references '{c}', which is not a finding "
                    "declared by any report"
                )
        m = re.search(r"\*\*Tracked by:\s*([^*]+)\*\*", body)
        if m:
            refs = [r.strip().rstrip('.') for r in m.group(1).split(",") if r.strip()]
            live = [r for r in refs if r in open_ids]
            if refs and not live:
                errors.append(
                    f"{residue_path}: {rid} claims to be tracked by {', '.join(refs)}, but "
                    "none of those findings is still open — the residue has become nobody's"
                )
    # Rule 3: a residue note in FIXES.md must have an item here.
    fx = os.path.join(audit_dir, "FIXES.md")
    if os.path.exists(fx):
        ftext = open(fx, encoding="utf-8").read()
        # Strip fenced blocks first: FIXES.md's own header shows the entry FORMAT inside a
        # fence, residue line included, and matching that example reports a phantom.
        ftext = re.sub(r"```.*?```", "", ftext, flags=re.S)
        for m in re.finditer(r"\n## ([A-Z]+-\d+[a-z]?)\n(.*?)(?=\n## |\Z)", ftext, re.S):
            fid, fbody = m.group(1), m.group(2)
            if "**Residue:**" in fbody and fid not in rtext:
                errors.append(
                    f"{fx}: {fid} carries a Residue note but {os.path.basename(residue_path)} "
                    "never mentions it — residue must be tracked, not left as a footnote"
                )
else:
    errors.append("docs/audit/RESIDUE.md is missing — the residue ledger is required")

# --- lessons ledger --------------------------------------------------------
# LESSONS.md is where a finding's generalisable lesson goes. It is checked here so it
# cannot drift into unattributed folklore: every lesson must name at least one finding
# that actually exists, and every heading must carry a Findings: line.
lessons_path = os.path.join(audit_dir, "LESSONS.md")
n_lessons = 0
if os.path.exists(lessons_path):
    lines = open(lessons_path, encoding="utf-8").read().split("\n")
    fence, current = False, None
    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence:
            continue
        h = re.match(r"^### (L-\d+)\s+—\s+(.+)$", line)
        if h:
            if current:
                errors.append(f"{lessons_path}: lesson {current} has no 'Findings:' line")
            current = h.group(1)
            n_lessons += 1
            continue
        if current and line.startswith("Findings:"):
            refs = [r.strip() for r in line[len("Findings:"):].split(",") if r.strip()]
            if not refs:
                errors.append(f"{lessons_path}:{i}: {current}: 'Findings:' line names no finding")
            for r in refs:
                if r not in declared:
                    errors.append(
                        f"{lessons_path}:{i}: {current} references '{r}', which is not a finding "
                        "declared by any report"
                    )
            current = None
    if current:
        errors.append(f"{lessons_path}: lesson {current} has no 'Findings:' line")

baseline = None
baseline_declared = None
try:
    parts = open(baseline_path).read().split()
    baseline = int(parts[0])
    # Second field is the declared total at the time the baseline was set. A bare number
    # (the original format) still parses; it just cannot police a raise.
    baseline_declared = int(parts[1]) if len(parts) > 1 else None
except Exception:
    errors.append(f"findings-gate: cannot read baseline at {baseline_path}")

print(f"findings-gate: {len(declared)} findings declared · {len(entries)} tracked · {n_open} open"
      + (f" (baseline {baseline})" if baseline is not None else "")
      + f" · {len(documented_fixes)} fix log entr(ies) · {n_lessons} lesson(s)")

if errors:
    for e in errors:
        print(f"::error::{e}" if os.environ.get("GITHUB_ACTIONS") else f"ERROR: {e}")
    print(f"findings-gate: FAIL — {len(errors)} problem(s).")
    sys.exit(1)

if strict:
    if n_open:
        print("findings-gate: FAIL (--strict) — these findings are still open:")
        for f in open_ids:
            print(f"  {f}")
        sys.exit(1)
    print("findings-gate: PASS (--strict) — every finding is closed.")
    sys.exit(0)

if baseline is not None and n_open > baseline:
    print(f"findings-gate: FAIL — open findings rose {baseline} -> {n_open}. "
          "Close them, or fix the entry; do not raise the baseline.")
    sys.exit(1)

if baseline_declared is not None and len(declared) != baseline_declared:
    print(f"findings-gate: FAIL — the baseline's declared count ({baseline_declared}) does not "
          f"match the reports ({len(declared)}). Update scripts/findings-baseline.txt to "
          f"'<open> {len(declared)}' in the same commit that adds or removes a finding.")
    sys.exit(1)

# Was the baseline RAISED, and was the raise paid for? The working copy alone cannot
# answer that — a baseline file is just a number someone can edit. So compare against the
# committed one. Any rise in `open` must be covered by a rise in `declared`: new findings
# can be recorded, but a stalled backlog cannot be legalised by editing the number.
# WHICH reference to compare against matters, and getting it wrong makes this check a
# no-op that still prints a tick — the exact failure mode CI-2 was about. On a PR, HEAD is
# the merge commit and already contains this branch's baseline, so comparing to HEAD
# compares the file to itself. Prefer the PR's base branch; fall back to HEAD (correct
# locally, where HEAD is the previous commit). Either way, SAY which one was used and say
# so loudly when neither is usable, so the check's strength is visible instead of assumed.
repo_root = os.path.dirname(os.path.dirname(baseline_path))
base_ref = os.environ.get("GITHUB_BASE_REF")
candidates = ([f"origin/{base_ref}"] if base_ref else []) + ["HEAD"]
prev, prev_src = None, None
for ref in candidates:
    r = subprocess.run(
        ["git", "show", f"{ref}:scripts/findings-baseline.txt"],
        capture_output=True, text=True, cwd=repo_root,
    )
    if r.returncode == 0:
        prev, prev_src = r, ref
        break
if prev is None:
    print("findings-gate: NOTE — no committed baseline to compare against "
          f"(tried {', '.join(candidates)}); the raise check is INERT this run. "
          "It becomes effective once scripts/findings-baseline.txt exists on the base branch.")
elif prev_src == "HEAD" and base_ref:
    print(f"findings-gate: NOTE — base branch 'origin/{base_ref}' has no baseline yet; "
          "compared against HEAD, which on a PR is the merge commit and may be this "
          "branch's own value. Treat the raise check as WEAK this run.")
if prev is not None and prev.returncode == 0 and baseline is not None:
    parts = prev.stdout.split()
    try:
        prev_open = int(parts[0])
        prev_declared = int(parts[1]) if len(parts) > 1 else None
    except (ValueError, IndexError):
        prev_open, prev_declared = None, None
    if prev_open is not None and baseline > prev_open:
        allowance = (len(declared) - prev_declared) if prev_declared is not None else None
        raised = baseline - prev_open
        if allowance is None:
            print(f"findings-gate: FAIL — baseline raised {prev_open} -> {baseline}, and the "
                  "previous baseline recorded no declared count to justify it against.")
            sys.exit(1)
        if raised > allowance:
            print(f"findings-gate: FAIL — baseline raised by {raised} but only {allowance} new "
                  f"finding(s) were declared ({prev_declared} -> {len(declared)}). A raise must be "
                  "paid for by newly declared findings, not by an edit.")
            sys.exit(1)
        print(f"findings-gate: baseline raised {prev_open} -> {baseline} (vs {prev_src}), "
              f"covered by {allowance} newly declared finding(s).")

if baseline is not None and n_open < baseline:
    print(f"findings-gate: {baseline - n_open} finding(s) closed since the baseline. "
          f"Lower scripts/findings-baseline.txt to {n_open} to lock the progress in.")

print("findings-gate: PASS")
PY

