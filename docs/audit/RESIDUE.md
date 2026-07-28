# Residue ledger — what the fixes deliberately left behind

Every entry in [`FIXES.md`](FIXES.md) that ends with a **Residue** note put something down
on purpose. Individually each of those notes is honest. Collectively they were invisible:
nothing listed them, nothing counted them, and nothing noticed when the same one was
written three times.

That is what this file is for. A residue note inside a fix entry is a footnote to a closed
finding; here it is an item with a state.

**Verified by `scripts/findings-gate.sh`.** Every finding id cited below must exist, an item
claiming to be *tracked* must cite a finding that is still **open** (a closed finding cannot
be tracking anything), and every `FIXES.md` section carrying a residue note must appear
here. The last rule is the point: it makes "left behind and forgotten" a build failure.

## States

| State | Meaning |
| --- | --- |
| `resolved` | A later fix closed it. Cites the commit or finding that did. |
| `tracked` | An open finding covers it. Cites that finding. |
| `untracked` | Nothing covers it. **These are the ones that get lost** — each needs a finding or a deliberate decision to accept. |
| `accepted` | Deliberately permanent, with the reason. Not a gap. |

---

## resolved — closed by later work

### R-1 · The legacy-row concurrency window
*Recorded as residue on **CONC-1**, again on **CONC-2**, and a third time on **CONC-3**,
which noted "it still has no finding".*

A guard comparing `eventSeq`/`accountVersion` could not bite while the attribute was absent:
both concurrent readers captured `undefined`, `undefined !== undefined` is false, and both
writes landed. Every fix that added a guard inherited it and said so; none closed it.

**Resolved in two halves.** `REM-1`'s boot stamp back-fills rows that predate the field.
`DATA-1` writes `eventSeq: 0` at creation, covering rows created *after* boot — which the
boot stamp by definition cannot reach, and which is the case that actually mattered (the
approve/approve race on a freshly-submitted request).

Being written three times without being tracked is the reason this file exists.

**Not fully closed at the seam** — see R-2.

### R-2 · `ifEquals` passes when the attribute is absent
*Residue on **DATA-1**.*

`memoryStore`'s `ifEquals` compares `cur[attr] !== value`. Against a missing attribute with
a captured `undefined`, that is false, so the guard passes for every writer at once.
DynamoDB does the opposite: a condition on a missing attribute does not match.

**State: `untracked`** — no finding covers the seam itself, only its symptoms (R-1).

Making it fail closed was attempted and reverted: it breaks **80 tests across 14 files**,
because several real paths — `versionStamp` among them — guard on absent attributes *on
purpose*, in order to back-fill them. Closing it needs a pass over every `ifEquals` call
site, deciding for each whether "absent" means "expected absent" or "cannot guard".

Kept as an **executable demonstration** in `ccp/api/test/requestRowLostUpdate.test.ts`
rather than a comment, so it fails visibly if anyone assumes it is fixed.

---

## tracked — an open finding covers it

### R-3 · The Python/importer CI gap is only partly closed
*Residue on **TEST-1**, **TEST-4**.*
**Tracked by: CI-4.**

`importer.yml` runs both kits, `ccp/app/scripts` and `tools/schemadump`;
`CCP_REQUIRE_INTEGRATION=1` stops the api's integration suites skipping silently; and
`scripts/gate.sh` gained a `py` section, which closed CI-1, IMP-3 and TEST-2.

One gap remains: the **GitLab mirror** (`.gitlab/ci/`) has no api/app test lane at all, so
none of this reaches it. Also still absent: a `requirements.txt`/`pyproject.toml` declaring
the Python test environment — both the workflow and `gate.sh` read the pin from
`gen-project-data.sh`, which keeps them consistent but is not a declared environment.

### R-27 · The two literal-object token-walkers are still duplicated
*Residue on **CTL-1**.*
**Tracked by: CTL-10.**

`internal/edit` and `internal/driftpropose` carry near-identical HCL object walkers. CTL-1's
defect was fixed in **both** — the drift-adopt path would otherwise have stayed broken and
looked maintained (L-8) — but the duplication itself is untouched, so the next divergence
has nothing stopping it.

### R-28 · The path-filter check covers four named edges, not the import graph
*Residue on **CI-3**.*
**Tracked by: CI-4.**

`scripts/ci/check-path-filters.sh` derives each of the four cross-component edges CI-3
names from the source — the `@app-lib` alias, the tests that execute `scripts/ci/*.sh`, the
Go embed's sync obligation — and fails when a filter stops covering one. It is deliberately
**not** a general import-graph walker, so a new cross-component import somewhere else would
not be noticed.

A considered trade rather than an oversight: a vague check nobody trusts gets deleted, and
a specific one naming the alias and the file count gets fixed. But it is a limit, not a
guarantee, and it belongs with the rest of the CI-completeness work.

### R-30 · The built-in gate runner was not shipped
*Residue on **ARCH-3**.*
**Tracked by: ARCH-2.**

ARCH-3's primary recommendation is a built-in gate runner invoking a pinned `catalogctl`
with fixed arguments, demoting the free-form command to a labelled escape hatch. What landed
is the "at minimum" clause: the api verifies the plan digest rather than assuming it. A
deployment can still run any tool it likes as the gate.

Tracked against ARCH-2 because that finding owns the same seam — the armed lanes' single
deployment-global command/credential set — and a built-in runner is the same change ARCH-2's
per-project resolution needs.

Note also that the verification is **inert on every real request today**: no request carries
a plan pin, because the pin-writer does not exist (R-21 / API-3).

### R-4 · `planSummary` is typed `string` in the contract
*Residue on **DOC-2**.*
**Tracked by: DOC-11.**

The API stores and serves a structured object. The new `PlanSummary` schema carries a note
where a reader comparing the two will hit it.

### R-5 · The scan worker does not report its own terminal failure
*Residue on **ERR-3**.*
**Tracked by: ERR-15.**

`worker.go` returns without attempting a terminal `failed` report after a progress-report
failure. The server-side lease (OPS-4) makes recovery independent of the worker, which is
the stronger guarantee — but it does not make the worker better behaved.

### R-6 · The bundle's landed-but-untriggered half state
*Residue on **ERR-2**.*
**Tracked by: ERR-12.**

If `commit` succeeds but `trigger` fails, the landed SHA survives only inside the audit
`steps`, and a retry re-clones and dies at commit with a technically-true but actively
misleading message. ERR-2's lease makes the request appliable again; it does not make that
retry smarter.

---

## untracked — nothing covers these

**These are the ones that get lost.** Each needs a finding raised or an explicit decision to
accept.

### R-25 · `ENGINEER_REVIEW_REQUIRED` is defined and emitted by nothing
*Residue on **DOC-4**, **DOC-2** — both now closed, which is how this became untracked.*

It is declared in `errors.ts`; the engineer-tier gate returns `WRONG_APPROVAL_LEVEL`
instead. Adding it to the contract would document a response the API cannot return, so
`openapi.test.ts` asserts its continued absence — that pins the decision but does not make
it. The code is the wrong side here: the entry should either be emitted or deleted.

### R-8 · Session rows are written with blind puts
*Residue on **CONC-3**.*

`auth.ts:507` and `account.ts:117,161` write `SessionItem` unguarded. Out of CONC-3's scope
(which is the account row) and covered by no finding of its own. The same lost-update shape
DATA-1 fixed for request rows.

### R-29 · The Azure tag catalog was not regenerated from the corrected ledger
*Residue on **IMP-4**.*

`ccp/app/scripts/gen-azure-tag-catalog.mjs` reads a file under `.superpowers/sdd/` that the
public split removed, so it cannot run in this repo. The ledger is corrected and committed;
anything previously derived from the wrong one still needs regenerating wherever that input
exists. Untracked, because no finding covers the split's effect on regenerable artifacts.

### R-9 · No end-to-end install-journey smoke
*Residue on **OPS-1**, **OPS-5**.*

The finding asks for a test that runs the real two-phase compose flow. What exists covers
the *decision* with docker stubbed, so it cannot catch a failure that only appears against
real containers.

The same gap covers `migrate-data.sh`: OPS-5's test drives step 11's decision, not the
ceremony. `DATA_ROOT`/`LEGACY_UPDATE_DIR` are now parameterised (the seam `install.sh`
already has) so an end-to-end walk *could* be written against a throwaway tree. It has not
been.

### R-10 · `transactWithAudit` cannot tell which condition failed
*Residue on **CONC-2**.*

A `ConditionError` from the domain write and one from audit-chain contention are
indistinguishable to the caller. L-6 is the lesson this produced; the seam itself is
unchanged.

### R-11 · The redaction/toolchain helpers are duplicated across packages
*Residue on **TEST-4**.*

`requireToolchain.ts` exists in both `ccp/api/test/helpers/` and `ccp/app/src/test/helpers/`
because the two packages have separate `node_modules` and `tsconfig` path maps. Per **L-8**
that divergence is a real risk. Mitigated only by both copies being nine lines and reading
the same `CCP_REQUIRE_INTEGRATION` variable.

### R-12 · `versionStamp` cannot reach an incomplete project registry
*Residue on **REM-1**.*

Requests and teams are found by walking `projectCollectionGsi()`. A project row missing from
that registry leaves its requests and teams unstamped, and the marker is written anyway — so
the one-shot will not retry them.

### R-13 · IMP-7's recurrence guard was never built
*Residue on **IMP-7** — and the only entry in `FIXES.md` with an **unticked** definition-of-done box.*

Nothing compares the Azure template provider pin to the committed schemadump filename, so
they can silently diverge again. The divergence was fixed; the guard against recurrence was
not.

---

## accepted — deliberately permanent

### R-7 · A fix landed inside another finding's commit
*Residue on **CONC-14**.*

The team-rename guard landed in the CONC-3 commit, because a bulk replacement of
account-row writes matched a team row too. Typecheck and `adminSurface.test.ts` caught it,
and it was corrected into a real fix rather than reverted.

Accepted rather than tracked: the work is done and correct, and both the fix log and the
commit say where it actually landed. What remains is only that CONC-14's evidence line
points at a commit whose subject describes CONC-3 — a provenance wrinkle already written
down, not an outstanding gap. (An earlier draft of this file claimed ARCH-8 tracked it;
ARCH-8 is about the governance domain being implemented twice and has nothing to do with
this.)

### R-14 · The link checker does not check external URLs
*Residue on **DOC-5**.* Network calls would make the gate flaky and dependent on
third-party uptime. Only relative links are checked — the ones the public split broke and
the ones this repo controls.

### R-26 · Four allowlisted gitleaks hits, and a scanner that had never run
*Residue on **CI-2**.*

Running the secret scanner for the first time surfaced 4 hits. All four are genuine
placeholders — three are the audit's own PG-5 probe values, one is PG-4's published AKIA
example set — and are allowlisted in `.gitleaks.toml` with a reason each. Accepted because
the alternative is a permanently red gate over values that exist to be found.

Worth keeping visible: three of the four are *the shapes the report says PG-5 misses*, so
the argument for layering gitleaks over the pattern checks was correct and had simply never
been exercised. That is what a check reporting PASS for months without running looks like
from the other side.

### R-15 · Enrichment call sites degrade to absent rather than showing an error
*Residue on **FE-2**.* Correct for a surface with no error slot whose screen works without
the data. Now a decision recorded at each site rather than an unhandled rejection.

### R-16 · Neither process error handler exits
*Residue on **OPS-2**.* `uncaughtException` is undefined behaviour and the textbook advice
is to crash — but this process is supervised with `restart: unless-stopped`, and an api that
exits on any stray throw is a restart loop that serves nothing. Staying up and loud is the
better failure mode; the exit policy is now a decision an operator can make from evidence
they previously did not have.

### R-17 · Rewindow is not widened to the halt statuses
*Residue on **API-2**.* Re-windowing a halted row re-arms the exact plan the halt refused.
The way out of a halt is cancel and a fresh request, through the humans.

### R-18 · `AWAITING_CODE_REVIEW` stays in `BUNDLE_ELIGIBLE`
*Residue on **ARCH-1**.* A multi-item ladder can legitimately reach quorum while the row is
still there. The explicit approvals check makes membership harmless.

### R-19 · Scan-job leases settle on read, not on a timer
*Residue on **OPS-4**.* A project nobody looks at keeps its stale row until someone does —
acceptable, since an unobserved wedge blocks nothing. It does mean the audit trail dates the
expiry from the read rather than from the worker's death.

### R-20 · Store durability recovery is an operator action
*Residue on **DATA-3**.* Nothing reconciles memory and disk automatically, and nothing
could — the divergence is unmeasurable from inside the process. What changed is that it
stops compounding and stops being invisible.

### R-21 · The auto-apply pin-writer does not exist
*Residue on **API-3**.* No request is auto-appliable today; the scheduler holds all of them.
That is the honest state, now visible in the timeline instead of expressed as destruction.
Building the pin-writer is separate work.

### R-22 · Component-level behaviour that jsdom would be needed to test
*Residue on **FE-4**, **FE-5**, **FE-15**.* This repo has no jsdom and
`test/standalone.test.ts` enforces an exact dependency allowlist. Where a rule could be
extracted into a pure function it was; what remains is genuinely component state — the
ApprovalsQueue commit ordering, the guard redirect, the Notifications panel. The better
shape for FE-4 (extract the commit decision into a pure function) is noted, not done.

### R-23 · The `importer` CI lane also runs a non-importer suite
*Residue on **TEST-3**.* `ccp/app/scripts` is Python and ran in no workflow, which is the
gap that lane exists to close. Accurate enough today and commented; if a third unrelated
Python suite joins, the workflow should be renamed rather than accreting.

### R-24 · PERF-2 removed the freeze, not the serialisation
*Residue on **PERF-2**.* Two applies still cannot run concurrently, for other reasons. The
fix stops an in-flight child blocking *unrelated* traffic and `/readyz`; it does not make
applies parallel.
