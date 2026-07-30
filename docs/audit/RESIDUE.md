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

### R-6 · The bundle's landed-but-untriggered half state
*Residue on **ERR-2**. Tracked by ERR-12, which has now closed it.*

If `commit` succeeded but `trigger` failed, the landed SHA survived only inside the audit
`steps`, and a retry re-cloned and died at commit with a technically-true but actively
misleading message. ERR-2's lease made the request appliable again; it did not make that
retry smarter.

**Resolved by ERR-12**, which gave the half state a name (`landed-untriggered`), put the
sha on the request row, and made a retry resume at the trigger rather than re-run from the
top.

---

## tracked — an open finding covers it

### R-5 · The scan worker does not report its own terminal failure
*Residue on **ERR-3**.*
**Tracked by: ERR-15.**

`worker.go` returns without attempting a terminal `failed` report after a progress-report
failure. The server-side lease (OPS-4) makes recovery independent of the worker, which is
the stronger guarantee — but it does not make the worker better behaved.

### R-51 · Deep audit paging still scans, and the export still buffers whole
*Partial work on **PERF-8**.*
**Tracked by: PERF-8**, which stays OPEN because two of its three parts remain.

Done: the page walk now asks the store for `limit` rows per partition instead of cloning
the whole month to take fifty off the front of it — a first page of a 20,000-entry chain
went 5.8 ms to 0.33 ms. That bound applies only once the cursor is behind us; while still
SEARCHING for the cursor the partition must be read in full, or a limited read could stop
short of it and silently resume the page from the wrong place.

So a deep page still costs the entries newer than its cursor (23.7 ms to 17.6 ms at 20,000
entries, cursor 90% back) — paging *through* a long history is still quadratic.

**The finding's proposed mechanism does not work here, and that is worth writing down
before someone tries it.** It says to "resolve the cursor by its ULID's embedded month".
But the partition month comes from the entry's `at` (`buildAuditItem` keys on
`yyyymm(new Date(at))`), and `at` and `id` are *independently* injectable through
`RecordOpts` (`nowFn`, `idFn`) — the suite routinely writes synthetic ids that decode to a
timestamp unrelated to their partition. Deriving the month from the ULID would send the
walk to the wrong partition and yield an empty page for a cursor that exists.

What would work is a COMPOSITE cursor — `<yyyymm>:<ulid>` — which names the partition
directly, lets the walk start there, allows the seam's existing `after` to skip within it
at the store, and still permits an existence check so the deliberate "unknown cursor yields
an empty page, never a silent replay from the top" semantic survives. That is a wire-format
change (the SPA treats the cursor as opaque, so it is compatible if a bare ULID is still
accepted as a legacy cursor) and wants the OpenAPI contract updated with it, which is why
it is not folded into a read-path tuning commit.

Also untouched: `GET /admin/audit/export` still builds the entire self-verifying document
in memory for one `c.json`, which the finding notes as an additional problem and which
needs a streaming response rather than a faster read.

### R-52 · The raised retry budget does not close API-20's settlement race
*Residue on **PERF-11**.*
**Tracked by: API-20.**

The route-level test for PERF-11 failed at first for a reason that had nothing to do with
approve: six concurrent authenticated requests against a cold store all race the ONE-TIME
legacy settlement, and the raised budget does not save them. A single write that N callers
must each win needs roughly N rounds, and at the low attempts the jitter ceiling is only a
few milliseconds — too coarse to separate six racers reliably.

So PERF-11 makes API-20 less likely without closing it, and the test now warms the
settlement before the burst so it measures what it claims to. API-20's own recommendation is
the structural one and still stands: serialize settlement behind a single in-process promise
so concurrent callers await one attempt instead of racing N, which is the same
"one in-flight attempt, shared" shape `TerraformExecutor.init` took for ERR-5.

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

### R-3 · The Python/importer CI gap is only partly closed
*Residue on **TEST-1**, **TEST-4**, **CI-4**.*

`importer.yml` runs both kits, `ccp/app/scripts` and `tools/schemadump`;
`CCP_REQUIRE_INTEGRATION=1` stops the api's integration suites skipping silently; and
`scripts/gate.sh` gained a `py` section, which closed CI-1, IMP-3 and TEST-2.

One gap remains: the **GitLab mirror** (`.gitlab/ci/`) has no api/app test lane at all, so
none of this reaches it — and none of the apply lane CI-4 shipped either.

**Untracked.** It was tracked against CI-3 and then CI-4; both are now closed, and no
remaining open finding mentions the GitLab mirror at all. Re-pointing it at another CI
finding would be inventing a link — the honest state is that the mirror is nobody's. Also still absent: a `requirements.txt`/`pyproject.toml` declaring
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

`scripts/ci/check-path-filters.sh` derives each of the four cross-component edges CI-3
names from the source — the `@app-lib` alias, the tests that execute `scripts/ci/*.sh`, the
Go embed's sync obligation — and fails when a filter stops covering one. It is deliberately
**not** a general import-graph walker, so a new cross-component import somewhere else would
not be noticed.

A considered trade rather than an oversight: a vague check nobody trusts gets deleted, and
a specific one naming the alias and the file count gets fixed. But it is a limit, not a
guarantee.

**Untracked** — it was tracked against CI-4 until that finding closed, which is exactly the
transition this ledger's `tracked` rule exists to catch. No open finding covers general
import-graph coverage.



### R-32 · Sequential write latency is still O(store size)
*Residue on **DATA-4**.*

Batching fixes the CONCURRENT case — a 32-write burst went 126 ms/op → 4.0 ms/op — which is
the number a server lives by. A single write still costs a full-snapshot fsync proportional
to the database. Changing the durability model of a governance database was judged not worth
it for the sequential case; that judgement is the residue.

### R-33 · The SPA still fetches unpaged request lists
*Residue on **PERF-3**.*

`GET /requests` pagination is real now, and deliberately opt-in — without `limit` the
response is byte-for-byte what it always was, and the SPA does not pass one.

Not an oversight: `Notifications` sorts by `updatedAt` and slices to 8, but the GSI orders
by ulid (creation), so a server-side `limit` would silently drop a recently-approved OLD
request from the bell. Correcting it needs either an `updatedAt`-ordered index or a product
decision that the bell means "recently created". Left alone rather than quietly regressed —
which is the right call, and leaves the client-side cost unaddressed.

### R-34 · `/readyz`'s incremental verification is not a tamper-detector
*Residue on **PERF-4**.*

`/readyz` verifies fully on the first probe of a process, then re-hashes only entries
appended since (253 ms → 1.05 ms). The memo is used only if the anchor entry still re-hashes
**from its content** — trusting its stored `hash` field would let a content rewrite walk
straight past.

It deliberately does not detect a rewrite deep inside an already-verified prefix.
`GET /admin/audit/export` and `scripts/verify-audit-chain.ts` still verify every entry every
time, and a test pins that they catch what the memo path does not. A stated trade — but it
means `/readyz` alone must not be read as continuous tamper-evidence.

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

### R-30 · The built-in gate runner was not shipped
*Residue on **ARCH-3**.*

ARCH-3's primary recommendation is a built-in gate runner invoking a pinned `catalogctl`
with fixed arguments, demoting the free-form command to a labelled escape hatch. What landed
is the "at minimum" clause: the api verifies the plan digest rather than assuming it. A
deployment can still run any tool it likes as the gate.

**Untracked.** It was tracked against ARCH-2 on the reasoning that the two share a seam —
the armed lanes' single deployment-global command/credential set — and that a built-in runner
was "the same change" as per-project resolution. ARCH-2 has now closed and shipped no such
runner, which settles the question: it was never the same change, and the tracker was
assigned by adjacency rather than by coverage. That is the second time in this ledger (see
**R-1**) that a residue was parked against a finding that did not actually cover it, and it
is precisely what the gate's *tracked-must-cite-an-open-finding* rule exists to surface.
Nothing open covers the free-form gate command today.

Note also that the verification is **inert on every real request today**: no request carries
a plan pin, because the pin-writer does not exist (R-21 / API-3).

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

### R-35 · PERF-5 moved the catalog parse; it did not make it cheaper
*Residue on **PERF-5**.* The zod deep-parse of all 115 manifests still runs in full — now on
the first `listManifests()` for a sample-estate session instead of before first paint. That
relocation *is* the fix (nothing on the login path pays for a catalog it cannot use), but a
sample-estate user's first catalog read still stalls the main thread for the whole parse.

Making the parse itself cheaper — per-manifest on access, or trusting a build-time-validated
payload — was deliberately not done. The eager whole-catalog parse is what makes a malformed
manifest fail loudly at one known point rather than as a runtime cast error three screens
later, and that property is worth more than the stall. PERF-5 is a first-paint finding; the
parse cost is a different question and is not pretended to be closed here.

### R-36 · The entry chunk is still 855 kB (248 kB gzip), and `manualChunks` would not shrink it
*Residue on **PERF-5**.* After the catalog and the eleven heavy leaf routes came out, what
remains on the entry graph is React, react-router, zod, and the shared component/lib layer.
That is the app's floor, not an oversight — it is above Vite's 500 kB warning and will stay
there.

The finding's third suggestion, `manualChunks` to separate vendor React from catalog data,
was **not** taken, and the reason is that it does not do what the finding's framing implies:
the catalog is already its own chunk, and splitting vendor out of the entry changes the
first-paint byte count by zero while adding a second blocking request. Its real benefit is
cache granularity across deploys — a returning visitor re-downloading ~45 kB of app code
instead of 248 kB. That is worth having and is not why PERF-5 was filed, so it is recorded
here rather than folded in silently. Chunk-init ordering is the risk that makes it worth
doing on purpose rather than as a footnote to a performance fix.

### R-37 · The forge-credential broker is not wired into the armed lanes
*Residue on **ARCH-2**.*

ARCH-2's recommendation names "the ADR-0033 forge-credential broker already built for the
scanner" as the credential half of per-project resolution. It was deliberately **not** wired
in, because the two lanes need different things and the mismatch is not cosmetic: the broker's
GitHub App path mints an installation token scoped `contents:read`, for one repository, for
one hour — exactly right for a scanner that clones, and unusable for a bundle that **pushes**.
Wiring it would have produced a lane that clones the right estate and then fails at the push,
which is a worse failure than the one being fixed because it fails after the gate has run.

So a per-project remote is a credential-free URL (`buildCloneUrl` refuses embedded credentials
by construction) and the deployment supplies the credential through git's own credential
helper — one of the two mechanisms `CCP_GIT_REMOTE` already documented. An estate whose push
credential cannot be expressed that way names itself in `CCP_GIT_PROJECT` and keeps using the
env remote verbatim. Both paths work; neither is the broker.

The broker becomes the right answer when it can mint a write-scoped, per-project, short-lived
token. That is a change to the broker, not to these lanes.

### R-38 · With no pin and no registered repo, a multi-estate deployment still shares one remote
*Residue on **ARCH-2**.*

The fix closes the cross-estate clone for every project that registers a repository, and gives
a deployment an explicit way to say which estate the global remote is (`CCP_GIT_PROJECT`, after
which every other estate must bring its own or be refused). What it cannot do is detect the
remaining case from inside the process: `CCP_GIT_REMOTE` set, no pin, and two estates that have
both registered nothing. Those two still share a checkout, exactly as before.

Closing that arm by default would mean either counting registered projects at config time — a
store read inside what is deliberately a pure function over the environment — or breaking every
single-estate deployment that never registered a repo, which is the shape the finding explicitly
asks to keep working ("keeping the env vars as a single-estate fallback"). Neither is worth it
for a case an operator resolves by registering the repository they already have, or by naming
their estate in one variable.

What did change is that the arm is now **nameable**: the resolution's source travels into the
bundle's audit entry (`remote.source` / `remote.detail`), so a reader of the chain can see that
a run used the deployment-global remote rather than the estate's own. The defect was invisible
for as long as it was because that answer lived only in one process's environment.

### R-31 · The reference apply lane's apply step is a stub
*Residue on **CI-4**.*

`ccp-apply.yml` wires, orders and tests every gate; the irreversible step deliberately
ships no credential wiring. An estate adds its own cloud auth and `terraform apply`. A
credential pattern in a template invites copying one that does not match the estate's
threat model, and this is the step where that would matter most — but it does mean the
template is not runnable as-is.

**Accepted**, and re-stated now that ARCH-2 has closed without shipping credential wiring
either. This is not a gap waiting on a finding — it is a decision: a template that ships a
credential pattern gets that pattern copied into estates whose threat model it does not fit,
and this is the one step where that would matter most. The stub is the deliverable.

### R-39 · Co-arming the two apply lanes is still allowed
*Residue on **ARCH-4**.*

The finding offers a second remedy: refuse `CCP_BUNDLE` + `CCP_SCHEDULER` together at
`assertDeployable` unless an override is set. That was not taken, and not by oversight.

The two lanes answer different questions — "a Lead decided to apply this now" and "this
request's window opened while nobody was watching" — and an estate can legitimately want
both. Refusing the combination would make the safe configuration unavailable rather than
making the unsafe one safe. Now that the scheduler observes the bundle's claim, the
overlap has an answer instead of a race, so the arming-time refusal would only remove a
capability.

What remains is that the two lanes are *coordinated* rather than *mutually exclusive*: the
scheduler defers to a live bundle claim, and the bundle refuses an `APPLYING` row, but
nothing serialises them at a higher level. A third apply lane added later would have to
learn both rules rather than inherit one. That is a real cost of the choice, recorded
rather than argued away.

### R-40 · The ~10 client-only statuses were kept, not pruned
*Residue on **ARCH-7**.*

`GENERATING`, `CHECKS_RUNNING`, `PLAN_READY`, `CODE_APPROVED`, `MERGED`, `NOOP`,
`DIGEST_MISMATCH`, `WITHDRAWN`, `DRAFT` and `SUBMITTED` are in the closed set and the api
has never written any of them. They stay because the SPA's ordering, labelling and
phase-track tables index by them: removing one is a decision about what the pipeline view
promises a user it can show, not a typing cleanup, and making that call inside a
consistency fix would be smuggling a product change through a refactor.

What changed is that they are now *in a list something can be checked against*. Pruning
them is a follow-up with a UI owner; the vocabulary drifting again is not.

### R-41 · The store schema still types `status` as `z.string()`
*Residue on **ARCH-7**.*

The finding's recommendation includes having the store schema validate against the closed
enum with a legacy-passthrough shim. Not done. The closed set plus the source-scan parity
test catches the drift at the point it is introduced — a developer writing a new status —
which is where it is cheapest to catch and where every instance of this defect actually
originated.

Tightening the schema catches something different: a row that is *already* wrong, in a
store that has been running. That needs the passthrough shim to be designed against real
legacy data rather than guessed at, and getting it wrong fails a boot rather than a test.
Worth doing; not worth doing blind.

### R-42 · `APPLIED` still means two things
*Residue on **ARCH-7**.*

The api stamps `APPLIED` on quorum-met `schedule:'now'` requests with nothing applied — the
"Stage-0/1 fiction" `DOMAIN-MODEL.md` itself warns operators about. The finding asks to
split "approved, no apply lane armed" from "the change landed".

That is a data migration and a UI change, not a vocabulary fix: existing rows carry the
ambiguous value with no way to tell the two cases apart after the fact, and every reader —
the quota list above included, where both readings are correctly terminal — would need
auditing against the new pair. Recorded here rather than folded into a consistency pass
that could not have done it honestly.

### R-43 · The bundle timeline merge is a re-read, not a store-level append
*Residue on **CONC-6**.*

`events` is a whole attribute and the store's `set` replaces it, so appending means reading
the current array and writing it back. The `ifEquals` guard covers `eventSeq`, and a cancel
— the writer this race is actually about — advances no `eventSeq`, so the guard cannot
catch it. What closes the window instead is ordering: the chain head is read first and the
row last, leaving no `await` between reading the timeline and writing it, which on
`MemoryStore` and `FileStore` (single-threaded, no interleaving without a yield) makes the
window empty rather than merely small.

Accepted at that. It stops being empty the day the DynamoDB backend lands, because the two
reads become two network round-trips with a real gap between them — and the proper fix
there is a list-append update expression, which is a store-seam capability that does not
exist yet and should be designed against the real backend rather than guessed at now. The
cost if it is ever hit is one lost `cancelled` timeline entry on a request whose `status`
still correctly reads `CANCELLED` and whose audit chain still records both the cancel and
the bundle — a degraded timeline, not a lost decision.

### R-44 · The replan-failure halt threshold is a constant, not per-project policy
*Residue on **ERR-6**.*

`REPLAN_FAILURE_LIMIT = 5` is one number for every estate. Five ticks is a reasonable
default — long enough for a blip to clear, short enough to reach a human while the
maintenance window is usually still open — but the right value genuinely differs by
deployment: a project whose terraform backend is a flaky VPN hop away wants more patience
than one whose backend is in the same VPC, and a project with two-hour windows can afford
to wait where a fifteen-minute window cannot.

Accepted as a constant for now rather than made a knob. The knob is cheap to add
(`deploymentSettings` already has the shape for it) and the reason not to is that there is
no operational experience yet to set it from: shipping a tunable whose correct value nobody
knows invites it being set to something worse than the default, and the failure mode of
tuning it too high is the finding's own defect wearing a configuration hat. Revisit when a
real deployment has hit the limit and can say whether it fired too early.

### R-45 · The stuck-`APPLYING` lease sweep only runs while the scheduler is armed
*Residue on **CONC-10**.*

The sweep lives inside `runDueApplies`, so it runs only when the scheduler loop is on
(`CCP_SCHEDULER=1`). A deployment that armed the scheduler, had a worker die mid-apply, and
then disarmed the scheduler keeps that row in `APPLYING` with nothing to release it — the
finding's dead end, reachable by a narrower route.

Accepted rather than tracked, for two reasons. Only the scheduler can create an `APPLYING`
row in the first place, so this needs an operator to arm the lane, crash a worker, and then
disarm it before anyone looked — and the remedy is to re-arm the scheduler for one tick,
which is the same switch they just turned off. The finding's own alternative (an admin
"resolve stuck apply" verb) would cover it, and was deliberately not taken: a recovery verb
nobody knows to run is not a recovery path, and adding one *as well* means two mechanisms
that can disagree about when a claim is dead.

### R-46 · `where` counts MATCHING items against `limit`; DynamoDB counts EXAMINED ones
*Residue on **PERF-14**.*

The seam's `limit` now means "up to N items that match `where`". DynamoDB's `Limit` means
"stop after examining N items", and `FilterExpression` is applied *after* that — so the same
call against a real backend can return fewer items than the in-memory store does, or none
at all, without being at the end of the partition.

Nothing hits this today: the only `where` caller is the scheduler scan, which passes no
`limit`. Recorded rather than resolved because the divergence is invisible until the
DynamoDB backend lands, and that is exactly the kind of thing that gets discovered as a
paging bug in production. The contract note lives on `QueryOptions` where an implementer
will read it: a DynamoDB implementation must page internally until it has `limit` matches
rather than passing both through in one request. The alternative — matching DynamoDB's
semantics exactly in `MemoryStore` — would mean the in-memory store returning short pages
for no reason a reader of this codebase could see, which trades a documented divergence for
a baffling one.

### R-47 · The snapshot row CAPTURE is still one synchronous O(store) step
*Residue on **CONC-8**.*

`itemsInKeyOrder()` sorts the key list (when the cache is cold, which any insert
invalidates) and then does one map lookup per row, all synchronously, before the first
chunk is rendered. At 20,000 rows the measured max block is 20.3 ms against a predicted
~10 ms of stringify for a 2,000-row chunk, and the difference is that capture.

Accepted at that. It is roughly an order of magnitude cheaper than the serialization it
replaced as the dominant cost, it is bounded by the same store size rather than growing
faster, and chunking it too would mean giving up the one property the whole design rests
on: that the rows are fixed in a single synchronous step, so the waiters claimed by
`flush` and the state written for them cannot disagree. Trading that guarantee for another
10 ms would be a bad bargain. The real answer is the same one PERF-10 points at — an index
that does not need a full re-sort per snapshot.

### R-48 · Three tests are timing-flaky under full-suite parallel load
*Residue on **CONC-8**, observed while running the suite repeatedly.*

`driftBundleSeam.test.ts` and `bundleCrashRecovery.test.ts` each failed once with
`Test timed out in 5000ms` during a full run, and passed in isolation and on two subsequent
full runs. Both shell out to real subprocesses (git, `catalogctl`) under vitest's default
5-second timeout, so they are competing for CPU with the rest of the suite; the
`snapshotChunking` FileStore test hit the same wall until its writes were made concurrent.

Not caused by the snapshot work — the failures are in files that use `MemoryStore`, and the
change is `FileStore`-only — but recorded because a suite that fails once in three runs
teaches people to re-run instead of to read, which is how a real regression gets waved
through. The fix is a longer explicit timeout on the tests that spawn processes, not more
retries; deliberately not done here, where it would be an unrelated change buried in a
store commit.

### R-49 · The snapshot writer still emits the legacy bare array
*Residue on **DATA-16**.*

Every reader now understands `{ formatVersion, items }` and refuses a version it predates,
but the writer still produces the bare array — so no file in the wild carries the marker
yet, and the detection it enables only starts working once something writes one.

Deliberate, and the ordering is the whole point: reading both shapes and writing the old one
is the expand half of an expand/contract migration. Flip the writer in the same release and
a rollback to the previous binary meets a file it cannot parse, turning a routine revert
into hand surgery on a governance database. The contract half — flipping the writer — is a
one-line change once a release that can read the envelope has been deployed everywhere that
matters. A test pins the written shape so that flip has to be made on purpose rather than
arriving as a side effect.

### R-50 · Snapshot rows are still not validated against their zod schemas
*Residue on **DATA-5**.*

Load-time validation is structural only: each row must be an object with a string `PK` and
`SK`. The finding's optional half — running each row through the schema its PK/SK shape
implies, and refusing or quarantining violations — is not done.

Accepted for now for the reason R-41 already records: the wrong shim fails a BOOT, not a
test. `schema.ts` is strict in places where real stored rows are legitimately looser (a
`status` the enum does not list, a legacy account row shaped before `roles` existed), so a
validating loader written against the schemas as they read TODAY would refuse stores that
are perfectly serviceable — trading undefined behaviour on rare corruption for a
guaranteed outage on ordinary data. It becomes safe to do once there is a corpus of real
snapshots to validate the shim against, or once the loader can quarantine a bad row and
carry on rather than refusing the boot; either would be a good follow-up, and neither is
something to guess at.

### R-53 · `syncDir` is now duplicated between `fileStore.ts` and `snapshot.ts`
*Residue on **DATA-6**.*

The DATA-6/DATA-13 fix gave `store/snapshot.ts`'s standalone `writeFileAtomic` its own
copy of `fileStore.ts`'s `syncDir` helper and its temp-cleanup try/catch, rather than
importing either. Deliberate in the moment — `snapshot.ts`'s own header comment states it
is "kept standalone so the scripts never touch the durable store's code path" — but it is
the same duplicated-helper shape R-11 already names for the redaction/toolchain helpers,
and it can drift exactly the way CTL-10's two literal-object walkers already did: a third
fix to one copy's atomic-write discipline (a future ERR-10-shaped finding) can land in
`fileStore.ts` and never reach `snapshot.ts`, silently reopening DATA-6/DATA-13 in the
copy nobody was looking at.

**Untracked.** No existing finding names this pair. Extracting both the temp-cleanup
try/catch and `syncDir` into one dependency-free shared helper (`store/atomicWrite.ts` or
similar) both modules import would close it structurally — the same shape ARCH-6's shared
package is meant to eventually absorb for the api/app boundary, but this pair is
api-internal and does not need to wait for that.

### R-54 · `humanizeStatus` survives as three thin wrappers instead of being deleted
*Residue on **UI-10**.*

The fix gave `StatusBadge.tsx` a canonical `statusLabel()` export and pointed
`MyRequests.tsx`, `ApprovalsQueue.tsx` and `lib/palette.ts`'s existing `humanizeStatus`
functions at it, rather than deleting the three functions and updating every
`humanizeStatus(s)` call site to call `statusLabel(s)` directly. Chosen for the smaller
diff — each file needed one function body changed instead of every JSX/template call site
touched — but it leaves exactly the shape this finding closed: a status-copy indirection
that is not the canonical one.

**Untracked.** No existing finding names this. Low risk given how few call sites remain
(three, all one-line pass-throughs to `statusLabel`), but a fourth wrapper appearing
anywhere else in the app would be the same defect returning in miniature — UI-10's own
`test/statusBadge.test.ts` suite (asserting every `StatusBadge`-rendered label matches
`statusLabel`) would not catch a new wrapper that drifted from `statusLabel` on its own,
since it tests `statusLabel` itself, not every caller of it.
