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
# Lower the baseline as findings close — never raise it to make a red build
# green. Raising it is the one edit that defeats the whole mechanism.
#
# Exit codes: 0 ok · 1 gate failure · 2 usage/internal error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="$ROOT/docs/audit/FINDINGS.md"
BASELINE_FILE="$ROOT/scripts/findings-baseline.txt"
AUDIT_DIR="$ROOT/docs/audit"

STRICT=0
case "${1:-}" in
  --strict) STRICT=1 ;;
  "") ;;
  *) echo "usage: findings-gate.sh [--strict]" >&2; exit 2 ;;
esac

[[ -f "$LEDGER" ]] || { echo "findings-gate: missing $LEDGER" >&2; exit 2; }

python3 - "$AUDIT_DIR" "$LEDGER" "$BASELINE_FILE" "$STRICT" <<'PY'
import sys, re, glob, os
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
    if base in ("README.md", "FINDINGS.md", "LESSONS.md"):
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

try:
    baseline = int(open(baseline_path).read().strip())
except Exception:
    baseline = None
    errors.append(f"findings-gate: cannot read baseline at {baseline_path}")

print(f"findings-gate: {len(declared)} findings declared · {len(entries)} tracked · {n_open} open"
      + (f" (baseline {baseline})" if baseline is not None else "")
      + f" · {n_lessons} lesson(s)")

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

if baseline is not None and n_open < baseline:
    print(f"findings-gate: {baseline - n_open} finding(s) closed since the baseline. "
          f"Lower scripts/findings-baseline.txt to {n_open} to lock the progress in.")

print("findings-gate: PASS")
PY
