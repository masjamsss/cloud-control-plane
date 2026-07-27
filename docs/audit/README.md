# Engineering audit — 14 dimension reports

A non-security robustness review of the control plane, one report per dimension.
**Cybersecurity assessment is explicitly out of scope** for the whole set; security
review is a separate concern handled elsewhere.

| | Report | | Report |
|---|---|---|---|
| 01 | [Architecture & design coherence](01-architecture.md) | 08 | [Importer & schemadump](08-importer-schemadump.md) |
| 02 | [API correctness](02-api-correctness.md) | 09 | [Error handling](09-error-handling.md) |
| 03 | [Data integrity](03-data-integrity.md) | 10 | [Reliability & operations](10-reliability-operations.md) |
| 04 | [Concurrency](04-concurrency.md) | 11 | [Performance & scalability](11-performance-scalability.md) |
| 05 | [Frontend flows](05-frontend-flows.md) | 12 | [Testing & quality](12-testing-quality.md) |
| 06 | [Frontend UI robustness](06-frontend-ui-robustness.md) | 13 | [CI/CD](13-ci-cd.md) |
| 07 | [catalogctl](07-catalogctl.md) | 14 | [Contracts & docs](14-contracts-docs.md) |

Each report states its own scope and method — which files were read in full versus
grepped — so a reader can judge how much weight a given finding carries.

## Tracking

The reports state what was found. These three files track what happened next, and
`scripts/findings-gate.sh` keeps all three honest in CI:

| File | Holds | The gate enforces |
|---|---|---|
| [`FINDINGS.md`](FINDINGS.md) | every finding, one line, grouped by root cause | none may be dropped; status and topic must be valid; the open count may only fall |
| [`FIXES.md`](FIXES.md) | the definition-of-done worked through, per closed finding | nothing may be marked `fixed` without an entry here |
| [`LESSONS.md`](LESSONS.md) | what generalises beyond the line changed | every lesson must cite a real finding |

Run `bash scripts/findings-gate.sh` any time; `--strict` fails while any finding is still
open, and is the mode that must pass before this work is called finished.

## Anchoring

- **Reviewed at:** `3000920` ("Easy first import: paste a repo address and this system scans it (#2)"), 2026-07-26.
  This is the state the findings describe.
- **Citations anchored to:** `661d247` ("GCP as the third provider … (#7)").
  Every `file:line` reference in these reports has been checked against that commit.

The two differ because `main` advanced by three bodies of work (deployment settings,
scanner image publishing, GCP multi-lane) while the review was being written.

### How the citations were re-anchored

Mechanically, by content — not by re-reading the code and guessing:

1. Every `file:line` and `file:line-range` citation was extracted from all 14 reports
   (both full-path forms and the bare-basename shorthand the reports also use).
2. Those were intersected with `git diff --name-only 3000920 661d247`.
   **403 of the 419 cited files were untouched between the two commits**, so their
   citations are valid at both and were left alone.
3. For the **16 cited files that did change**, each citation was re-anchored by pulling
   the exact line (or block) content as of `3000920` and locating that same content in
   the `661d247` version, normalising for the quote-style and line-wrapping changes a
   formatter introduced. Where a whole block matched contiguously, the range end was
   taken from the block; otherwise the end line was matched independently.
4. Anything that could not be resolved that way was investigated by hand — see below.

Result: **29 citations were already correct**, **66 were re-anchored**, and every
remaining case was resolved individually. No finding's substance was edited to fit a
line number.

### Findings whose subject changed, not just their line numbers

Re-anchoring surfaced cases where the code itself moved on. These are called out in
place rather than silently renumbered:

- **IMP-7** (Azure provider pin) — **the divergence it reports is fixed on `661d247`.**
  Both Azure pins moved to 4.81.0, which was the first branch of its own recommendation.
  The second branch — a consistency check so the pins cannot diverge again — was not
  implemented, so a reduced version of the finding still stands. Marked inline.
- **CONC-3 / CONC-14** (unguarded account and team writes) — `ccp/api/src/routes/admin.ts`
  was substantially rewritten and reformatted, moving every cited line. The findings
  themselves were **re-verified as still live**: there is no `ifEquals` anywhere in the
  current `admin.ts`, and the cited writes are still unconditional full-row puts.

## Known limitations

- Findings are **not** re-validated wholesale against `661d247`. Only the citations were
  re-anchored, plus the specific findings named above. A finding may have been fixed
  since without that being reflected here — the two cases above were caught because
  their citations broke, which is not a reliable detector.
- Line numbers are a snapshot. They will drift again on the next substantial change to
  a cited file; the content-matching method described above is repeatable.
