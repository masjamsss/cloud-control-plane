#!/usr/bin/env bash
# =============================================================================
# CI-9 / CI-6 — workflow invariants that no single workflow file can protect.
#
# Both findings this checks for were about a workflow that looked fine in isolation:
#
#   CI-9  ccp-data.yml gated its job on `vars.CI_RUNNER != ''`, an undocumented variable.
#         Unset — the default — the job SKIPPED on every push forever: no data uploaded, no
#         error, green CI. The sibling lane ccp-onboard.yml had already called that exact
#         construct a trap in its own header and moved off it, and the trap came back anyway,
#         because a comment in one file cannot bind another.
#
#   CI-6  release-images.yml applied `latest` unconditionally in all three publishing jobs,
#         published on any `v*` tag at any commit with no quality gate, and had no
#         concurrency group. A maintenance release repointed `latest` backwards; an
#         untested commit could become the released image.
#
# Written as rules over ALL workflows rather than as assertions about the two files that
# were wrong (L-25) — the next lane to copy the trap is the one nobody is watching.
#
# Exit codes: 0 every rule holds · 1 a rule is broken.
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# The subjects must exist before anything is asserted about them: a renamed workflow would
# otherwise make every rule below pass by finding nothing to check (L-1).
for f in .github/workflows/ccp-data.yml .github/workflows/release-images.yml; do
  [ -f "$f" ] || { echo "missing input: $f — this check cannot run, which is not passing" >&2; exit 1; }
done

python3 - "$@" <<'PY'
import glob, re, sys

import yaml

fails = []
def ok(msg):   print(f"  ok   {msg}")
def bad(m, d): print(f"  FAIL {m}\n     {d}"); fails.append(m)

workflows = sorted(glob.glob(".github/workflows/*.yml"))
if not workflows:
    print("no workflows found — this check cannot run, which is not passing", file=sys.stderr)
    sys.exit(1)

# ── CI-9 · no job may be gated on the runner override ────────────────────────────────
#
# `vars.CI_RUNNER` selects a runner. Gating on it means "run only where someone happened to
# pin a runner label", which is never what the author means and is invisible when false —
# GitHub renders a skipped job in grey, identically to one that had nothing to do. Gate on a
# variable the runbook already makes the operator set (CCP_PROJECT_ID), so a misconfigured
# lane is a lane that never appears rather than one that silently does nothing.
gated_on_runner = []
for wf in workflows:
    doc = yaml.safe_load(open(wf, encoding="utf-8")) or {}
    for name, job in (doc.get("jobs") or {}).items():
        cond = str((job or {}).get("if", ""))
        if "CI_RUNNER" in cond:
            gated_on_runner.append(f"{wf}: job `{name}` — if: {cond.strip()}")
if gated_on_runner:
    bad("no job is gated on vars.CI_RUNNER",
        "gating on the runner override skips the job silently when it is unset; gate on a "
        "variable the runbook requires (CCP_PROJECT_ID), as ccp-onboard.yml does:\n     "
        + "\n     ".join(gated_on_runner))
else:
    ok("no job gates on vars.CI_RUNNER (CI-9)")

# ── CI-6 · publishing rules ──────────────────────────────────────────────────────────
rel_path = ".github/workflows/release-images.yml"
rel_text = open(rel_path, encoding="utf-8").read()
rel = yaml.safe_load(rel_text) or {}
rel_jobs = rel.get("jobs") or {}

# Which jobs actually push an image? Derived from the steps, not from a list of job names
# here — a fourth image added tomorrow is covered without editing this file.
publishers = [
    n for n, j in rel_jobs.items()
    if any("build-push-action" in str((s or {}).get("uses", "")) for s in ((j or {}).get("steps") or []))
]
if not publishers:
    bad("release-images has an identifiable publishing job",
        "no job uses build-push-action — either the workflow changed shape or this rule has "
        "stopped measuring anything, and a rule that measures nothing must not report a pass")
else:
    ungated = [n for n in publishers if "preflight" not in str((rel_jobs[n] or {}).get("needs", ""))]
    if ungated:
        bad("every publishing job depends on the preflight gate",
            f"these publish without waiting for it: {', '.join(sorted(ungated))} — a tag at an "
            "untested commit would build and push immediately")
    else:
        ok(f"all {len(publishers)} publishing job(s) depend on preflight (CI-6)")

    if not rel.get("concurrency"):
        bad("release-images serializes its runs",
            "no concurrency group: two tag pushes in flight race each other to `latest`")
    else:
        ok("release-images declares a concurrency group (CI-6)")

# `latest` must never be applied unconditionally. Checked on the raw text because the tags
# block is a newline-delimited string, not structure PyYAML can meaningfully walk.
unconditional = [
    ln.strip() for ln in rel_text.splitlines()
    if re.search(r"type=raw,value=latest\s*$", ln)
]
if unconditional:
    bad("`latest` is never applied unconditionally",
        f"{len(unconditional)} tag rule(s) move `latest` on every build, so a maintenance "
        "release repoints it backwards; add an enable= condition")
else:
    ok("`latest` moves only under an enable= condition (CI-6)")

print()
if fails:
    print(f"check-workflow-safety: {len(fails)} problem(s)")
    sys.exit(1)
print("check-workflow-safety: workflow gating and publishing rules hold")
PY
