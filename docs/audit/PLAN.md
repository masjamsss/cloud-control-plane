# Remediation plan

How to work down the 208 open findings in [`FINDINGS.md`](FINDINGS.md) without re-deriving
the same root cause repeatedly. Ordered by leverage — findings closed per unit of risk and
effort — not by severity alone.

This is a plan, not a contract. It is written down so the ordering does not have to be
re-decided every session.

## What the reports already give you

Each fix does not start from a blank page. Measured across all 210 findings:

| | |
|---|---|
| **210 / 210** | carry a **`Location`** — exact `file:line`, re-anchored to `661d247`, so they point at real code today |
| **208 / 210** | carry a **`Recommendation`** — a concrete proposed fix, not just a complaint |
| 138 / 210 | also state **`Impact`** — what goes wrong for a user or operator |

So for all but two findings the work is: read the recommendation, reproduce the defect at
the cited line, decide whether you agree with the proposed fix, then apply it. The
recommendations are proposals from the review, not instructions — several are explicitly
two-branch ("either bump the pin, or regenerate the dump"), and IMP-7 is the worked
example of picking one branch and leaving the other, with the residue recorded.

**The two exceptions**, both low severity, have a `Location` and a description but no
recommendation, so the fix approach has to be decided before starting:

- `CONC-12` — store-backed submit rate limiter is check-then-insert; concurrent submits
  breach both caps.
- `PERF-15` — request-history views render unbounded lists without windowing (and it is
  downstream of PERF-3, so Batch 0 may change its shape).

---

## Batch 0 — merge what is already fixed (no new code)

**The highest-leverage action available, and it is a merge decision, not an engineering
one.** Two open PRs already contain fixes for findings that are still marked open here,
because the fixes are not on `main`.

PR #6 (`claude/api-performance-optimization-it2n6m`) — green, unreviewed:

| Finding | | Fixed by |
|---|---|---|
| **PERF-1** | **critical** — every authenticated request rewrites the entire database | `cf1b87e` |
| PERF-3 | high — `GET /requests` has no pagination | `c6637cf` |
| PERF-4 | high — `/readyz` re-verifies every audit hash per probe | `bbe41ac` |
| DATA-2 | high — audit month-walk duplicates a month at month ends | `bbe41ac` |
| DATA-4 | high — full-file rewrite + fsync on every mutation | `cf1b87e` |

That is **one critical and four highs**, already written, tested and green — held up only
by review. PR #5 similarly carries catalogctl defect fixes, including a data race that is
live on `main` today.

Merging also clears **PG-6**, which has made the publish gate red on `main` since #7
landed and is inherited by every branch cut from it.

> Do this first. Nothing else in this plan is cheaper.
> Verify each finding against `main` after merging before flipping its line to `fixed:` —
> the mapping above is derived from commit subjects and PR write-ups, not yet from
> post-merge verification.

---

## Batch 1 — `blocking-io` (9 findings, substantially one fix)

`spawnSync` on the single-threaded API server. It surfaces as API-1, CONC-5, OPS-3,
PERF-2 and ERR-1 across five reports, all describing the same freeze.

Fixing it once closes the batch. It is also the largest blast-radius item on the board:
while a bundle or drift run is in flight the whole API stops answering, health checks
included, for minutes at a time.

**Why it is second, not first:** it is a genuine architectural change to how the armed
lanes execute, and it deserves the bench harness that PR #6 introduces. Sequencing it
after Batch 0 means measuring against a server that is not already spending 178 ms per
request on a full-store fsync.

## Batch 2 — `concurrency` (22 findings, one missing primitive)

The store already supports `ifEquals`; almost nothing uses it. CONC-1, CONC-2, CONC-3,
CONC-14 and DATA-1 are the same absent guard in different routes.

Largest single topic on the board, and the fix is mechanical once the pattern is agreed:
read, compute, write conditionally on the version you read. Do CONC-1 first (concurrent
approvals silently losing signatures — it corrupts the quorum ledger, which is the
product's whole point), establish the pattern in review, then apply it across the rest.

## Batch 3 — `ci-not-wired` (11 open) and `test-quality` (10)

Do these together: they are the same problem seen from two sides. Two components' suites
run in no CI at all, and one of them is red at HEAD.

Cheap, low-risk, and they protect every later batch — there is little point fixing
concurrency carefully while the suite that would catch a regression runs nowhere.
**CI-2 is already done** and is the worked example: the check existed, ran, and proved
nothing.

## Batch 4 — `stuck-state` (17) and `scheduler` (3)

Requests and jobs that nothing can move: `HALTED_*`, orphaned `APPLYING`, scan jobs whose
worker died, a scheduler that halts every scheduled request because nothing writes the
plan pin it requires.

Group them because the fix shape is shared — a recovery path plus a terminal status —
and because they are what an operator actually hits.

## Batch 5 — `contracts-docs` (19) and `duplication` (11)

The cheapest findings per item, and the easiest to land without risk. Good work to
interleave when a larger batch is blocked on review. OpenAPI declaring endpoints that do
not exist, docs citing files that were never published, rules implemented twice.

## Batch 6 — the frontend topics (17 across ux / a11y / form / nav)

Independent of everything above and parallelisable with it — a different person can take
these without colliding. FE-1 and FE-2 (no rejection path, no error state) are the
user-visible ones: any network failure currently leaves a permanent "Loading…".

## Remaining

`data-persistence`, `silent-failure`, `fail-open`, `install-ops`, `audit-chain`,
`importer`, `observability`, `resource-leak`, `scale-and-paging`, `catalogctl`.

Two of these hold findings that should not wait for their batch:

- **OPS-1 (critical)** — fresh-install bootstrap deadlock. The installer fails on every
  genuinely fresh host, leaving a crash-looping API. Nothing in Batch 0 touches it and no
  open PR fixes it. Take it standalone whenever there is capacity.
- **IMP-2 / TEST-1** — `importer/kit` is red at HEAD with 7 failing tests, one of them
  asserting on a file that does not exist in this repo. Cheap, and it unblocks Batch 3.

---

## Working rules

1. **One topic per PR** where possible. The batches exist so a reviewer sees one argument.
2. **Follow the definition of done** in [`FINDINGS.md`](FINDINGS.md) — reproduce first, fix
   the cause, pin it with a test that fails against the unfixed code, make the failure
   loud, evidence in the status line, lesson if it generalises.
3. **Fill in [`FIXES.md`](FIXES.md) as you close each finding.** The gate rejects a
   `fixed:` line with no entry. Partial fixes stay `open` with the residue written down.
4. **Lower `scripts/findings-baseline.txt`** as the open count drops, so progress is
   locked in and cannot silently regress. Never raise it.
5. Run `bash scripts/findings-gate.sh` before pushing; `--strict` when you think you are
   finished.
