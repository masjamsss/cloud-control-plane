# Findings checklist

Single source of truth for every finding in `docs/audit/`. **Machine-verified by `scripts/findings-gate.sh`** — a finding cannot be silently dropped, its status cannot be left blank, and its topic must be one of the known topics.

Grouped by **root-cause topic**, not by report, because the reports slice the same causes several ways: `spawnSync` on the serving thread produces findings in five different reports, and the missing `ifEquals` guard produces findings in three. Fixing by topic closes them in batches; fixing by report re-derives the same cause repeatedly.

## Definition of done — every fix must satisfy all of these

A finding is not `fixed` because the code changed. It is `fixed` when a reader six
months from now can confirm it without re-deriving the problem. Before flipping a line
to `fixed:`, all six must hold:

- [ ] **The defect is reproduced first.** You saw it fail, not just reasoned that it would.
- [ ] **The fix addresses the cause, not the symptom.** If the same class can recur through
      another path, say so in the ledger or open a new finding for it.
- [ ] **A regression test pins it**, and that test fails against the unfixed code. An
      untested fix is a claim, not a result.
- [ ] **The failure mode is loud.** A check that cannot run must never be
      indistinguishable from a check that passed — that is CI-2's whole lesson.
- [ ] **Evidence is in the status line**: a commit sha, PR ref, or test name. `fixed:` with
      no evidence is rejected by the gate. **If it is a sha, take it AFTER your last
      `--amend`** — recording it before folding the ledger edit in leaves a sha the amend
      destroys, which is how eight entries here came to point at nothing (L-28).
- [ ] **A lesson is recorded in [`LESSONS.md`](LESSONS.md)** if the finding taught something
      that generalises beyond the one line changed.

Partial fixes are honest and welcome — but they stay `open`, with the residue described,
rather than being rounded up to `fixed`. IMP-7 is the worked example: its divergence is
gone, its recurrence guard is not, so the entry records both.

**Which model should take what is in [`TRIAGE.md`](TRIAGE.md).** Every open finding is
assigned to exactly one batch there, with a recommended model and a checkable statement of
what "done" means. Batches are grouped by the files they touch, so two sessions can run in
parallel without colliding — take a batch id, not a scattered set of findings. Ten findings
are flagged **verify-before-you-fix**: earlier work may already have closed them.

**Anything a fix deliberately leaves behind goes in [`RESIDUE.md`](RESIDUE.md).** A
`**Residue:**` note inside a `FIXES.md` entry is a footnote to a closed finding — easy to
write and impossible to find later. The residue ledger gives each one a state (`resolved` /
`tracked` / `untracked` / `accepted`), and the gate enforces three things: a cited finding
must exist, an item claiming to be *tracked* must cite a finding that is still **open**, and
every `FIXES.md` entry carrying a residue note must appear there. The first item in that
file is why it exists — the same residue was recorded on three separate findings, each
noting it "still has no finding", and nothing ever picked it up.

## Line grammar (the gate parses this — keep the format)

```
- [ ] ID | severity | topic | status | report | title
```

`status` is one of:

| status | means | required |
|---|---|---|
| `open` | not yet triaged or not yet done | — (checkbox stays `[ ]`) |
| `fixed:<evidence>` | resolved | a commit sha, PR ref, or test name |
| `accepted:<reason>` | will not fix, deliberately | a reason |
| `deferred:<owner>` | will fix later | an owner |

Anything other than `open` must have the checkbox ticked (`[x]`). The gate enforces that.

Valid topics live in `scripts/findings-topics.txt`; the gate rejects any other value, so a typo cannot invent a topic nobody tracks.

## Status

**210 findings** across **23 topics** — 2 critical, 47 high, 91 medium, 70 low.

The gate has two modes. The default **ratchets**: it fails if a finding loses its entry, if a field is malformed, or if the open count rises above `scripts/findings-baseline.txt`. `--strict` fails while *any* finding is still `open` — that is the mode that must pass before this work is closed out.

### Topics by size

| topic | findings | crit | high |
|---|---:|---:|---:|
| [`concurrency`](#concurrency) | 22 |  | 4 |
| [`contracts-docs`](#contracts-docs) | 19 |  | 2 |
| [`silent-failure`](#silent-failure) | 17 |  | 2 |
| [`stuck-state`](#stuck-state) | 17 |  | 7 |
| [`authz-identity`](#authz-identity) | 13 |  | 3 |
| [`ci-not-wired`](#ci-not-wired) | 12 |  | 6 |
| [`data-persistence`](#data-persistence) | 11 | 1 | 1 |
| [`duplication`](#duplication) | 11 |  |  |
| [`importer`](#importer) | 10 |  | 2 |
| [`test-quality`](#test-quality) | 10 |  | 1 |
| [`blocking-io`](#blocking-io) | 9 |  | 5 |
| [`fail-open`](#fail-open) | 8 |  | 2 |
| [`frontend-ux`](#frontend-ux) | 7 |  | 3 |
| [`install-ops`](#install-ops) | 7 | 1 | 1 |
| [`scale-and-paging`](#scale-and-paging) | 7 |  | 2 |
| [`audit-chain`](#audit-chain) | 6 |  | 2 |
| [`catalogctl`](#catalogctl) | 4 |  | 1 |
| [`frontend-a11y`](#frontend-a11y) | 4 |  | 1 |
| [`observability`](#observability) | 4 |  | 1 |
| [`frontend-form`](#frontend-form) | 3 |  |  |
| [`frontend-nav`](#frontend-nav) | 3 |  |  |
| [`resource-leak`](#resource-leak) | 3 |  |  |
| [`scheduler`](#scheduler) | 3 |  | 1 |

## concurrency

Unguarded full-row writes and lost updates. Largely one root cause — the store supports `ifEquals` and almost nothing uses it.

- [x] CONC-1 | high | concurrency | fixed:ifEquals on transactional put + eventSeq guard on approve; test/approveLostUpdate.test.ts | 04-concurrency.md | Concurrent approvals of the same request silently lose signatures (lost update via unguarded row put + stale retry)
- [x] CONC-2 | high | concurrency | fixed:eventSeq guards on reject/link-pr/plan-summary + transactWithAudit refuses to replay a guarded write; test/transactWithAuditReplay.test.ts | 04-concurrency.md | Reject, link-pr and plan-summary use unguarded full-row puts through `transactWithAudit`, which retries with the stale snapshot; this also defeats the scheduler's `APPLYING` claim
- [x] CONC-3 | high | concurrency | fixed:ifEquals on standalone put + accountVersion guard on every account write in auth/account/admin; test/loginDisableRace.test.ts | 04-concurrency.md | The entire auth/self-service lane writes the account row with blind full-row puts, clobbering concurrent admin mutations and undermining the `accountVersion` drift-guard doctrine
- [x] DATA-1 | high | concurrency | fixed:887746c | 03-data-integrity.md | Request-row writes lack optimistic concurrency: concurrent approvals/rejections silently lose updates and can corrupt the quorum ledger
- [x] API-10 | medium | concurrency | fixed:3b243aa | 02-api-correctness.md | Session revocation can be silently undone by the idle-slide write-back race
- [ ] API-5 | medium | concurrency | open | 02-api-correctness.md | Cancel can race an in-flight bundle: the change applies but the request reads CANCELLED
- [x] CONC-11 | medium | concurrency | fixed:951aaf9 | 04-concurrency.md | Registry writes that bump `version` without guarding it (trust-request upload, identity confirm) can clobber concurrent registry ops and rewind the dual-control version guard
- [x] CONC-4 | medium | concurrency | fixed:3b243aa | 04-concurrency.md | A revoked session can be resurrected by the concurrent idle-window slide
- [ ] CONC-6 | medium | concurrency | open | 04-concurrency.md | The bundle claim has no crash/exception/race recovery: `bundle.state:'running'` can stick forever, and a raced outcome write loses the record of a fired deploy
- [x] CONC-7 | medium | concurrency | fixed:9dce28b | 04-concurrency.md | `FileStore` has no single-writer enforcement: two processes on the same data file silently destroy each other's writes
- [x] CONC-9 | medium | concurrency | fixed:b3d34f5 | 04-concurrency.md | Dual-control ack does not guard the pending row's status: a concurrently rejected proposal can still apply
- [x] DATA-8 | medium | concurrency | fixed:b3d34f5 | 03-data-integrity.md | Pending-change status transitions have no CAS: concurrent ack + reject can apply a change and record it as REJECTED
- [x] DATA-9 | medium | concurrency | fixed:9dce28b | 03-data-integrity.md | No single-writer guard: restore can be silently clobbered by a running server; nothing prevents two processes on one file
- [x] ERR-11 | medium | concurrency | fixed:09fb510 | 09-error-handling.md | The bundle idempotency claim guards on `status`, not `bundle.state`: concurrent applies can both run
- [ ] ERR-8 | medium | concurrency | open | 09-error-handling.md | No process-level failure handling: no graceful shutdown, no rejection/exception handlers, npm-as-PID-1
- [ ] OPS-8 | medium | concurrency | open | 10-reliability-operations.md | No graceful shutdown: `npm` as PID 1, no SIGTERM handling, default 10 s grace on the api
- [ ] TEST-6 | medium | concurrency | open | 12-testing-quality.md | No route-level concurrency/race tests; store-level concurrency only
- [ ] API-14 | low | concurrency | open | 02-api-correctness.md | Conditional-write collisions inside `transactWithAudit` surface as the wrong error
- [ ] CONC-12 | low | concurrency | open | 04-concurrency.md | The store-backed submit rate limiter is check-then-insert: concurrent submits breach both caps
- [ ] CONC-13 | low | concurrency | open | 04-concurrency.md | Concurrent first-boot settlement can escape its own race handling and 500 early requests
- [x] CONC-14 | low | concurrency | fixed:version guards on rename, set-services and stripFromOthers; test/teamWriteGuards.test.ts | 04-concurrency.md | Team CRUD writes bump `version` but never guard on it
- [ ] CONC-15 | low | concurrency | open | 04-concurrency.md | `transactWithAudit` conflates a caller's domain guard failure with chain contention, producing dead error paths and mislabeled conflicts
- [ ] REM-2 | low | concurrency | open | 15-remediation.md | Session rows are still written with blind full-row puts

## contracts-docs

OpenAPI vs reality, and docs citing things that do not exist.

- [x] DOC-1 | high | contracts-docs | fixed:cdc5f2c | 14-contracts-docs.md | OpenAPI declares two `/catalog/*` endpoints that do not exist — and the parity test pins the phantoms
- [x] DOC-2 | high | contracts-docs | fixed:cdc5f2c | 14-contracts-docs.md | Shipped routes absent from the OpenAPI spec; `POST /requests/:id/apply` is documented nowhere at all
- [ ] ARCH-6 | medium | contracts-docs | open | 01-architecture.md | The backend depends on frontend-package internals; the shared-contract layer is a path alias plus a hand-synced copy
- [ ] DOC-10 | medium | contracts-docs | open | 14-contracts-docs.md | ERROR-STATES.md's "every error code the API can return" is missing 8 taxonomy codes and 6 inline literals
- [ ] DOC-11 | medium | contracts-docs | open | 14-contracts-docs.md | OpenAPI types `ChangeRequest.planSummary` as a string; the API stores and serves a structured object
- [ ] DOC-12 | medium | contracts-docs | open | 14-contracts-docs.md | DOMAIN-MODEL.md's entity catalog is missing a third of the store's item types
- [x] DOC-4 | medium | contracts-docs | fixed:errors.ts cites the real contract; ERROR-STATES.md's grep-a-missing-file analysis re-measured and corrected | 14-contracts-docs.md | Multiple docs and a code header cite `ccp/docs/specs/ccp-api.md`, which does not exist in this repo
- [x] DOC-5 | medium | contracts-docs | fixed:cdc5f2c | 14-contracts-docs.md | ~100 broken relative markdown links across the published tree
- [ ] DOC-6 | medium | contracts-docs | open | 14-contracts-docs.md | API-SPEC.md states the opposite of current code on `PUT /projects/:id/identity` gating
- [ ] DOC-7 | medium | contracts-docs | open | 14-contracts-docs.md | App `DriftProposal` type does not match the wire: `importPayload` has a different shape, and top-level `arn`/`tfType` are mock-only
- [ ] DOC-8 | medium | contracts-docs | open | 14-contracts-docs.md | catalogctl README makes two explicit completeness claims that are false
- [ ] DOC-9 | medium | contracts-docs | open | 14-contracts-docs.md | Four operator-facing env vars are undocumented (two of them documented nowhere at all)
- [ ] TEST-7 | medium | contracts-docs | open | 12-testing-quality.md | The SPA has no DOM/interaction testing; ~25 test files pin UI by source-string inspection
- [ ] API-12 | low | contracts-docs | open | 02-api-correctness.md | `prNumberFromUrl` extracts a "PR number" from any URL ending in digits
- [ ] ARCH-14 | low | contracts-docs | open | 01-architecture.md | The OpenAPI "parity test" is string containment, not parity
- [x] DOC-15 | low | contracts-docs | fixed:ec95bd2 | 14-contracts-docs.md | MAINTAINING-THE-CATALOG.md points at a generated-output directory that does not exist in the tree
- [ ] DOC-16 | low | contracts-docs | open | 14-contracts-docs.md | Assorted OpenAPI request/response gaps against route behavior
- [ ] DOC-17 | low | contracts-docs | open | 14-contracts-docs.md | The code-derived docs' line citations have drifted from HEAD
- [ ] TEST-11 | low | contracts-docs | open | 12-testing-quality.md | OpenAPI contract test is substring matching, not conformance

## silent-failure

Failures that produce no signal — swallowed rejections, best-effort compensation, lanes that go green when they did nothing.

- [x] DATA-3 | high | silent-failure | fixed:0d4c3a4 | 03-data-integrity.md | A failed disk persist is not rolled back from memory: served state diverges from disk, and "failed" writes silently commit later
- [x] TEST-4 | high | silent-failure | fixed:fdda986 | 12-testing-quality.md | The highest-value integration tests skip silently when a toolchain is missing, and nothing asserts they ran in CI
- [ ] ARCH-10 | medium | silent-failure | open | 01-architecture.md | Unaudited governance transition: dual-control proposals expire silently
- [ ] ARCH-9 | medium | silent-failure | open | 01-architecture.md | Single-process, single-file scaling ceiling with in-process singletons the planned DynamoDB path would silently break
- [ ] CI-9 | medium | silent-failure | open | 13-ci-cd.md | The recurring data lane keeps the silent-skip gate its own sibling workflow documents as a trap
- [ ] DATA-5 | medium | silent-failure | open | 03-data-integrity.md | Store rows are not validated against the schemas on load: corrupt-but-parseable state is accepted silently
- [ ] ERR-6 | medium | silent-failure | open | 09-error-handling.md | `executor.replan()` failures are an unmodeled halt: unbounded silent retry, and they abort the rest of the project's due list
- [ ] FE-8 | medium | silent-failure | open | 05-frontend-flows.md | AuditHistory silently truncates to the first page (100 entries) — the cursor is fetched and thrown away
- [ ] OPS-6 | medium | silent-failure | open | 10-reliability-operations.md | Plain `compose up` (including every self-update cycle) silently strips the armed overlay
- [ ] TEST-8 | medium | silent-failure | open | 12-testing-quality.md | Golden-tree comparison is one-directional: extra files created by an edit go unnoticed
- [ ] CTL-8 | low | silent-failure | open | 07-catalogctl.md | `atomicWrite` silently changes edited-file permissions to 0600 and skips fsync
- [ ] ERR-14 | low | silent-failure | open | 09-error-handling.md | Drift-upload compensation is non-transactional best-effort
- [ ] ERR-16 | low | silent-failure | open | 09-error-handling.md | The ccp-data CI lane goes green when the control plane is unreachable
- [x] FE-15 | low | silent-failure | fixed:b5b703b | 05-frontend-flows.md | Notifications bell and CommandPalette swallow rejections silently
- [ ] IMP-12 | low | silent-failure | open | 08-importer-schemadump.md | `normalize.py split` silently drops non-`resource` top-level blocks
- [ ] IMP-15 | low | silent-failure | open | 08-importer-schemadump.md | Coverage-sweep family granularity marks undiscoverable resources as "covered" (documented, but with a concrete silent case)
- [ ] UI-12 | low | silent-failure | open | 06-frontend-ui-robustness.md | Configure ⇄ Review step transitions never move focus, and the Suspense skeleton is silent for assistive tech

## stuck-state

States nothing can leave: wedged jobs, dead-end requests, permanently disabled controls.

- [x] API-2 | high | stuck-state | fixed:a19e688 | 02-api-correctness.md | HALTED_* and orphaned APPLYING requests are unrecoverable dead-end states
- [x] ERR-2 | high | stuck-state | fixed:09fb510 | 09-error-handling.md | A crash or late write failure strands `bundle.state='running'` forever; no recovery path exists
- [x] ERR-3 | high | stuck-state | fixed:a19e688 | 09-error-handling.md | Scan jobs stuck in non-terminal states are unrecoverable and block all future scans for the project
- [x] ERR-4 | high | stuck-state | fixed:a19e688 | 09-error-handling.md | A crashed apply worker strands a request in `APPLYING` forever, silently
- [x] FE-3 | high | stuck-state | fixed:0b83aec | 05-frontend-flows.md | RequestForm: one server-side rejection permanently disables submit — the only way out abandons the drafted request
- [x] OPS-4 | high | stuck-state | fixed:a19e688 | 10-reliability-operations.md | A scan job whose worker dies stays `claimed`/`cloning`/`scanning` forever and permanently wedges that project's onboarding
- [x] UI-2 | high | stuck-state | fixed:ed4ca42 | 06-frontend-ui-robustness.md | Resource drill-in dead-ends for every "named service" whose slug is not a literal manifest file: all 16 azure-fixture services are broken
- [ ] API-4 | medium | stuck-state | open | 02-api-correctness.md | The bundle "claim" is not a mutual-exclusion, and a crashed bundle wedges the request at `running`
- [ ] API-9 | medium | stuck-state | open | 02-api-correctness.md | Project deregistration leaves orphaned satellite rows; a reused id inherits the previous tenant's state
- [ ] CONC-10 | medium | stuck-state | open | 04-concurrency.md | Stuck `APPLYING` after a worker crash has no reclaim or operator path
- [ ] ERR-12 | medium | stuck-state | open | 09-error-handling.md | Trigger failure after a landed commit: honest-but-dead-end half state, and spawn timeouts are indistinguishable from exit-1
- [ ] ERR-5 | medium | stuck-state | open | 09-error-handling.md | `TerraformExecutor.init()` caches a rejected promise: one transient init failure bricks the executor until restart
- [x] UI-4 | medium | stuck-state | fixed:b5b703b | 06-frontend-ui-robustness.md | Mutation handlers `await` API calls without try/catch: a network failure permanently wedges busy/submitting state
- [ ] API-15 | low | stuck-state | open | 02-api-correctness.md | A dangling idempotency marker makes its key permanently unusable
- [ ] DATA-12 | low | stuck-state | open | 03-data-integrity.md | Crash between the version-row transact and the file write leaves an activatable orphan row in the upload lane
- [ ] ERR-15 | low | stuck-state | open | 09-error-handling.md | Scan worker: a failed progress report abandons the job without a terminal status; a claim non-2xx is process-fatal with no backoff
- [ ] OPS-12 | low | stuck-state | open | 10-reliability-operations.md | Scanner service: no healthcheck, and the worker exits on any control-plane error

## authz-identity

Roles, sessions, TOTP, dual control, quorum and idempotency.

- [x] ARCH-1 | high | authz-identity | fixed:4af8a46 | 01-architecture.md | Bundle apply route accepts pre-quorum requests, contradicting ADR-0016's "fully approved" contract
- [x] ARCH-2 | high | authz-identity | fixed:b7059cd | 01-architecture.md | The armed apply/drift-generation lanes are single-estate by construction in a multi-account product
- [x] FE-5 | high | authz-identity | fixed:85f2980 | 05-frontend-flows.md | Api-mode session expiry is never detected in-app — the UI stays "signed in" while every call fails
- [ ] API-6 | medium | authz-identity | open | 02-api-correctness.md | The 72-hour dual-control expiry is dead code: `sweepExpired` has no callers and `ackPending` never checks `expiresAt`
- [x] ARCH-4 | medium | authz-identity | fixed:80f024e | 01-architecture.md | No mutual exclusion between the two apply lanes; both act on `AWAITING_DEPLOY_APPROVAL`
- [ ] DATA-11 | medium | authz-identity | open | 03-data-integrity.md | v1 migration writes rows that violate the store schemas, including an `id`≠`username` shape that breaks session resolution
- [ ] DATA-7 | medium | authz-identity | open | 03-data-integrity.md | The 72-hour dual-control expiry is unenforced: `sweepExpired` is dead code and `ackPending` never checks `expiresAt`
- [x] FE-4 | medium | authz-identity | fixed:b5b703b | 05-frontend-flows.md | ApprovalsQueue's stale-response guard is dead code — overlapping project-switch fetches can commit the wrong project's queue
- [ ] FE-7 | medium | authz-identity | open | 05-frontend-flows.md | PendingChangesBanner count goes stale after any dual-control activity — and the mock branch reads an unsubscribed store
- [ ] FE-9 | medium | authz-identity | open | 05-frontend-flows.md | apiSession role resolution falls back to another scope's role when the user has no binding on the active project
- [ ] CTL-9 | low | authz-identity | open | 07-catalogctl.md | `pr-prepare`'s UNAPPROVED gate accepts any non-empty approvals list without checking `decision`
- [ ] DOC-14 | low | authz-identity | open | 14-contracts-docs.md | PERMISSIONS.md §9 cites a "§2 apply row" that does not exist
- [ ] FE-12 | low | authz-identity | open | 05-frontend-flows.md | After a partial approval, the queue keeps a card the server's pending scope would drop

## ci-not-wired

Checks that exist but run nowhere, or run and prove nothing.

- [x] CI-1 | high | ci-not-wired | fixed:21fd092 | 13-ci-cd.md | Two components' test suites run in no CI at all, and one of them is currently failing
- [x] CI-2 | high | ci-not-wired | fixed:pin >=v8.19.0 for `gitleaks dir` + PG-9 now hard-fails on a failed invocation | 13-ci-cd.md | PG-9 (gitleaks) is a silent no-op in CI: the pinned v8.18.4 has no `dir` subcommand, and the script converts the resulting error into PASS
- [x] CI-3 | high | ci-not-wired | fixed:81b7fbc | 13-ci-cd.md | Path filters skip validation for cross-component dependencies: app-lib, catalogctl parity, the canonical redaction rules, and the gate scripts themselves
- [x] CI-4 | high | ci-not-wired | fixed:dd1c241 | 13-ci-cd.md | The product's core "CI applies" pipeline is not shipped: nothing invokes plancheck-gate.sh or apply-window-gate.sh, and docs/scripts reference a workflow that no longer exists
- [x] IMP-3 | high | ci-not-wired | fixed:21fd092 | 08-importer-schemadump.md | No CI executes any importer test suite; two shipped regressions prove the gap
- [x] TEST-2 | high | ci-not-wired | fixed:21fd092 | 12-testing-quality.md | No CI lane executes any Python test suite; `gate.sh` omits them too
- [ ] CI-8 | medium | ci-not-wired | open | 13-ci-cd.md | PG-5's secret heuristic misses the most common real-world shapes, and its designated backstop is dead in CI
- [ ] OPS-9 | medium | ci-not-wired | open | 10-reliability-operations.md | The documented CI-runner cutover only routes 2 of 8 workflows
- [ ] CI-10 | low | ci-not-wired | open | 13-ci-cd.md | Push-trigger path filters omit the workflow file itself on ccp-api and ccp-smoke
- [ ] CI-11 | low | ci-not-wired | open | 13-ci-cd.md | Stale toolchain claims: gate.sh advertises checks CI does not run
- [ ] CI-12 | low | ci-not-wired | open | 13-ci-cd.md | Inconsistent action pinning, with a comment that contradicts the file it sits in; setup-go caching is configured to a nonexistent root go.sum
- [ ] CI-13 | low | ci-not-wired | open | 13-ci-cd.md | The smoke proves boot + serve, not the system's function; PR runs of it are triggered by any `ccp/**` docs change

## data-persistence

Durability, rollback, schema validation on load, and store-seam fidelity against DynamoDB.

- [x] PERF-1 | critical | data-persistence | fixed:813a6d9 | 11-performance-scalability.md | Every authenticated request rewrites the entire database to disk (session-slide write × full-store snapshot)
- [x] DATA-4 | high | data-persistence | fixed:813a6d9 | 03-data-integrity.md | Full-file rewrite + fsync on every mutation, including a session write on every authenticated request, against a store that only ever grows
- [ ] CTL-5 | medium | data-persistence | open | 07-catalogctl.md | `drift-edit` writes are neither atomic nor transactional: a mid-batch refusal leaves earlier edits in the checkout
- [ ] DATA-10 | medium | data-persistence | open | 03-data-integrity.md | Backup/restore covers only the store JSON; the on-disk project-data/drift root it references is out of scope, with no consistency check
- [ ] DATA-6 | medium | data-persistence | open | 03-data-integrity.md | `rename` durability is not guaranteed: no directory fsync after the atomic swap
- [x] ERR-10 | medium | data-persistence | fixed:0d4c3a4 | 09-error-handling.md | FileStore persist failure leaves memory ahead of disk: the client gets a 500 for a write that took effect
- [ ] UI-8 | medium | data-persistence | open | 06-frontend-ui-robustness.md | DiffView corrupts `~` change lines whose old value contains " -> "
- [ ] API-17 | low | data-persistence | open | 02-api-correctness.md | Store-seam divergences from the DynamoDB semantics it mirrors
- [ ] DATA-14 | low | data-persistence | open | 03-data-integrity.md | Seam-fidelity gaps between MemoryStore and the promised DynamoDB semantics
- [ ] DATA-15 | low | data-persistence | open | 03-data-integrity.md | Map key concatenation with a space separator is aliasable in principle; client-controlled bytes reach PKs unconstrained
- [ ] DATA-16 | low | data-persistence | open | 03-data-integrity.md | No format/version marker in the snapshot file; migration rests entirely on convention
- [x] REM-1 | medium | data-persistence | fixed:domain/versionStamp.ts marker-guarded boot one-shot; test/versionStamp.test.ts | 15-remediation.md | The optimistic-concurrency guards cannot bite on rows written before they existed

## duplication

The same rule implemented in two places, free to drift.

- [ ] ARCH-5 | medium | duplication | open | 01-architecture.md | Two sources of truth for the catalog: the server validates against the image-baked catalog, the SPA renders the per-project uploaded one
- [x] ARCH-7 | medium | duplication | fixed:3cf798c | 01-architecture.md | The request-status vocabulary is an unowned, drifted contract
- [ ] ARCH-8 | medium | duplication | open | 01-architecture.md | The governance domain is implemented twice (server + browser mock) with acknowledged behavioral divergence
- [ ] DOC-13 | medium | duplication | open | 14-contracts-docs.md | Request-status vocabulary is three-way inconsistent (SPA union vs server writes vs YAML prose)
- [ ] ARCH-11 | low | duplication | open | 01-architecture.md | Arming-flag sprawl with no whole-config validation
- [ ] ARCH-13 | low | duplication | open | 01-architecture.md | Project-id grammar duplicated inline despite a declared single home
- [ ] ARCH-16 | low | duplication | open | 01-architecture.md | Vestigial code and stale references
- [ ] CTL-10 | low | duplication | open | 07-catalogctl.md | Duplicated literal-object token-walkers (edit vs driftpropose) have already diverged in behavior
- [ ] FE-11 | low | duplication | open | 05-frontend-flows.md | `WINDOW_EXPIRED` is missing from both status-filter vocabularies
- [x] OPS-14 | low | duplication | fixed:dd1c241 | 10-reliability-operations.md | Stale references to a nonexistent `.github/workflows/terraform.yml` anchor the Terraform pin
- [ ] UI-10 | low | duplication | open | 06-frontend-ui-robustness.md | Request-status copy has four competing sources; raw enum text can reach the UI

## importer

importer/kit, kit-azure and schemadump.

- [x] IMP-2 | high | importer | fixed:scripts/drift/sweep-ignore.json shipped with generic seeds | 08-importer-schemadump.md | `scripts/drift/sweep-ignore.json` is missing: the statediff sweep refuses out of the box
- [x] IMP-4 | high | importer | fixed:e3cc2c9 | 08-importer-schemadump.md | Azure capability ledger family classification is systematically wrong: multi-token `familyMap` keys are unreachable
- [ ] IMP-6 | medium | importer | open | 08-importer-schemadump.md | statediff's managed-set match assumes Terraform state `id` equals the discovery id; false-positive findings for id-divergent types (concrete: `aws_volume_attachment`)
- [x] IMP-7 | medium | importer | fixed:661d247 moved both Azure pins to 4.81.0; recurrence guard still missing | 08-importer-schemadump.md | Azure template provider pin (4.14.0) contradicts the committed azurerm schemadump tag (v4.81.0) it claims to bind to
- [ ] IMP-8 | medium | importer | open | 08-importer-schemadump.md | Committed schemadump artifacts are not reproducible via the documented `gen.sh` pipeline; generated-catalog staleness detection is entirely manual
- [ ] ARCH-15 | low | importer | open | 01-architecture.md | ADR ledger statuses lag the built system
- [ ] IMP-10 | low | importer | open | 08-importer-schemadump.md | `gen-imports.py --id-region-suffix` appends `@region` to global-service ids too
- [ ] IMP-13 | low | importer | open | 08-importer-schemadump.md | Shell scripts: minor robustness gaps around the deliberate no-`set -e` style
- [ ] IMP-14 | low | importer | open | 08-importer-schemadump.md | Stale numbers and dangling references in kit/schemadump docs and comments
- [ ] IMP-9 | low | importer | open | 08-importer-schemadump.md | Azure `discover.py list-subscriptions` crashes on a bare-list capture at the truncation-warning check

## test-quality

Red suites, silent skips, fixtures that pin the wrong premise.

- [x] TEST-1 | high | test-quality | fixed:importer/kit is green at HEAD (106 pass, was 7 failing) + .github/workflows/importer.yml | 12-testing-quality.md | `importer/kit` test suite is red at HEAD: 7 of 106 tests fail
- [ ] CTL-11 | medium | test-quality | open | 07-catalogctl.md | Golden coverage runs against forked fixture manifests, not the shipped catalog; comment-bearing fixtures are absent
- [ ] CTL-3 | medium | test-quality | open | 07-catalogctl.md | Shipped catalog op `waf-add-ip-set-entry` can never execute (exit 1 internal error); the corrected manifest exists only in test fixtures
- [x] TEST-3 | medium | test-quality | fixed:synthetic unmanaged type in the fixture + suite wired into .github/workflows/importer.yml | 12-testing-quality.md | `ccp/app/scripts/test_build_inventory.py` fails at HEAD (stale fixture premise)
- [ ] TEST-5 | medium | test-quality | open | 12-testing-quality.md | No code-coverage measurement anywhere; `coverage.test.ts` is not code coverage
- [ ] CTL-7 | low | test-quality | open | 07-catalogctl.md | plancheck's `inventoryAddr` does not skip `role:"reference"` inventory params, diverging from the executor's `targetAddress`
- [ ] FE-10 | low | test-quality | open | 05-frontend-flows.md | Mock `rejectRequest` skips the status guard the real API enforces
- [ ] TEST-10 | low | test-quality | open | 12-testing-quality.md | Functional test plan drift: stale counts, loose citations, and "new" rows with no tracking
- [ ] TEST-12 | low | test-quality | open | 12-testing-quality.md | One test file consumes ~60% of the api suite wall time by rebuilding catalogctl per run
- [ ] TEST-9 | low | test-quality | open | 12-testing-quality.md | Sleep-based synchronization in async API tests (flake and false-pass risk)

## blocking-io

`spawnSync` on the serving thread. One root cause, many symptoms.

- [x] API-1 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 02-api-correctness.md | Synchronous child-process execution freezes the whole API for minutes at a time
- [x] CONC-5 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 04-concurrency.md | `POST /requests/:id/apply` runs the entire bundle with `spawnSync`, freezing the whole API (health checks included) for up to tens of minutes
- [x] ERR-1 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 09-error-handling.md | Synchronous child processes block the entire API event loop for minutes
- [x] OPS-3 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 10-reliability-operations.md | Armed-lane commands run `spawnSync` on the event loop: the whole API freezes for up to 15 minutes and health checks flap
- [x] PERF-2 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 11-performance-scalability.md | `spawnSync` on the serving thread: the API freezes for up to 10-15 minutes during bundle/drift work
- [ ] API-8 | medium | stuck-state | open | 02-api-correctness.md | Freeze-held `kind:'now'` requests dead-end in AWAITING_DEPLOY_APPROVAL after the freeze lifts
- [ ] CONC-8 | medium | data-persistence | open | 04-concurrency.md | Every authenticated request triggers a full-store snapshot write; snapshot serialization is synchronous O(store) on the event loop
- [ ] FE-6 | medium | duplication | open | 05-frontend-flows.md | Api-mode submit gates read the advisory localStorage settings, not the server's — the freeze preview is dead and a stale local freeze silently blocks valid submits
- [ ] PERF-12 | medium | scale-and-paging | open | 11-performance-scalability.md | Upload ingest does 4+ full canonical-JSON passes over the 16 MiB bundle synchronously on the event loop

## fail-open

Guards that pass when they should refuse.

- [x] ARCH-3 | high | fail-open | fixed:a64839a | 01-architecture.md | The "reviewed-plan ≡ applied-plan" guardrail is delegated to unverifiable operator shell strings
- [x] CTL-1 | high | fail-open | fixed:bd7275b | 07-catalogctl.md | Full-line comment above a map entry corrupts every literal-map edit (duplicate keys, defeated KEY_CONFLICT guard, silent no-op removes) — exit 0
- [ ] CTL-4 | medium | fail-open | open | 07-catalogctl.md | plan-check R1 structurally vetoes every legitimate plan for a `local.`-targeted foreach op
- [ ] CTL-6 | medium | fail-open | open | 07-catalogctl.md | `danglingRef` substring scan falsely refuses removal when another resource's name extends the target's name
- [ ] API-11 | low | fail-open | open | 02-api-correctness.md | Audit-chain read path bypasses the injected clock and truncates at 120 months
- [ ] API-13 | low | fail-open | open | 02-api-correctness.md | `maxOpen` rate-limit counts a nonexistent status and misses real open states
- [ ] API-18 | low | fail-open | open | 02-api-correctness.md | Legitimize endpoint mints unlimited duplicate engineer requests for the same digest
- [ ] FE-14 | low | fail-open | open | 05-frontend-flows.md | DriftPage's post-trigger refetches bypass the staleness guard

## frontend-ux

Missing error and retry paths; permanent loading states.

- [x] FE-1 | high | frontend-ux | fixed:b5b703b | 05-frontend-flows.md | Mutation calls have no rejection path — a network failure strands the acting control in a permanent busy state
- [x] FE-2 | high | frontend-ux | fixed:b5b703b | 05-frontend-flows.md | Initial page loads have no error state — any failed fetch leaves an eternal "Loading…" with no retry
- [x] UI-1 | high | frontend-ux | fixed:b5b703b | 06-frontend-ui-robustness.md | Non-admin data pages have no fetch-error path: any API failure leaves a permanent "Loading…" with no message or retry
- [ ] ERR-9 | medium | frontend-ux | open | 09-error-handling.md | GitHub App credential fetches have no timeout, and any failure terminally fails the scan job with no retry
- [ ] UI-9 | medium | frontend-ux | open | 06-frontend-ui-robustness.md | `/login`, `/onboarding`, and the LegacyRedirect route have no errorElement: a render error there shows React Router's raw default error screen
- [ ] IMP-11 | low | frontend-ux | open | 08-importer-schemadump.md | `payloads.py` block scanner: a column-0 `}` inside a heredoc body truncates the skeleton and ships it
- [ ] UI-15 | low | frontend-ux | open | 06-frontend-ui-robustness.md | CommandPalette data is fetched once per shell mount, so "My requests" rows go stale within a session

## install-ops

Bootstrap, install, migration, compose and overlays.

- [x] OPS-1 | critical | install-ops | fixed:install.sh + intranet-setup.sh decide bootstrap before the first up; ccp/scripts/test/install-bootstrap-decision.test.sh | 10-reliability-operations.md | Fresh-install bootstrap deadlock: boot-time settlement creates the store file, then `CCP_BOOTSTRAP=1` is refused
- [x] OPS-5 | high | install-ops | fixed:f33aa29 | 10-reliability-operations.md | `migrate-data.sh`'s post-cutover byte-identical check is tripped by the new code's own boot writes: legacy migrations auto-roll back
- [ ] CI-5 | medium | install-ops | open | 13-ci-cd.md | Whether the api's live parity/integration suites run in CI depends on unpinned runner-preinstalled toolchains; nothing asserts they ran
- [ ] CI-7 | medium | install-ops | open | 13-ci-cd.md | The Docker build path (the documented production install) is never exercised by CI; images are first built at release time
- [x] DOC-3 | medium | install-ops | fixed:cdc5f2c | 14-contracts-docs.md | OpenAPI `servers: [{url: /v2}]` does not match any deployed base path
- [ ] OPS-13 | low | install-ops | open | 10-reliability-operations.md | `doctor.sh` reports an unhealthy container as OK
- [ ] OPS-15 | low | install-ops | open | 10-reliability-operations.md | GitHub App key directory is not prepared or checked by any tooling

## scale-and-paging

Full scans, unpaged reads, work proportional to total data.

- [x] PERF-3 | high | scale-and-paging | fixed:813a6d9 | 11-performance-scalability.md | `GET /requests` has no pagination and ships full rows (events, params, plan summaries, pinned plan text), with an O(n) write-capable settle loop per call
- [x] PERF-5 | high | scale-and-paging | fixed:2fd1794 | 11-performance-scalability.md | Frontend main bundle is 3.76 MB (663 KB gzip) with all 115 manifest JSONs inlined and zod-parsed at module init
- [ ] PERF-10 | medium | scale-and-paging | open | 11-performance-scalability.md | Submit-path full scans: rate-limit check and feasibility each re-scan whole collections per submission
- [ ] PERF-8 | medium | scale-and-paging | open | 11-performance-scalability.md | Admin audit "pagination" materializes and re-sorts the whole chain per page; cursor lookup is a linear scan
- [ ] PERF-9 | medium | scale-and-paging | open | 11-performance-scalability.md | `ServiceConsole` loads the entire block-source corpus on every service page mount, fetching server chunks sequentially
- [ ] PERF-13 | low | scale-and-paging | open | 11-performance-scalability.md | SchemaForm recomputes inventory-derived enums for every field on every keystroke
- [ ] PERF-15 | low | scale-and-paging | open | 11-performance-scalability.md | Request-history views render unbounded lists without windowing

## audit-chain

The evidence chain: month walk, export, verification.

- [x] DATA-2 | high | audit-chain | fixed:813a6d9 | 03-data-integrity.md | Audit month-walk duplicates the current month at month ends: audit export corrupts and `/readyz` goes red on ~7 days a year
- [x] PERF-4 | high | audit-chain | fixed:813a6d9 | 11-performance-scalability.md | `/readyz` re-verifies every audit chain hash on every probe: O(total audit entries) CPU per health check
- [ ] OPS-11 | medium | audit-chain | open | 10-reliability-operations.md | `/readyz` re-verifies every audit chain on every probe; cost grows unboundedly with history
- [ ] PERF-11 | medium | audit-chain | open | 11-performance-scalability.md | Per-project audit chain head serializes all writes and surfaces contention as user-facing 409s after one retry
- [ ] PERF-7 | medium | audit-chain | open | 11-performance-scalability.md | Nothing in the store is ever purged: sessions, idempotency markers, and the audit chain grow forever (and every byte is re-serialized per request)
- [ ] DATA-17 | low | audit-chain | open | 03-data-integrity.md | Calendar-dependent test: the FileStore audit-durability test hardcodes month `202607`

## catalogctl

The codemod, plan-check and drift-edit.

- [x] IMP-1 | high | catalogctl | fixed:with_meta=True back-ported from the azure kit; importer/kit suite 106 pass | 08-importer-schemadump.md | `importer/kit/normalize.py` `split`/`guard` crash under the repo-pinned python-hcl2 (KeyError, not a refusal)
- [ ] CTL-2 | medium | catalogctl | open | 07-catalogctl.md | `moved_block` writes invalid or duplicate-resource HCL at exit 0: no identifier validation, no destination-collision check, no dangling-reference handling
- [ ] IMP-5 | medium | catalogctl | open | 08-importer-schemadump.md | kit-azure `discover.sh` never clears stale page files: a re-run can resurrect deleted resources into the manifest
- [ ] PERF-6 | medium | catalogctl | open | 11-performance-scalability.md | API mode re-downloads and re-parses the full inventory + manifest set on every route mount; the serve endpoints send no caching headers

## frontend-a11y

Focus management, dialog semantics, duplicate DOM ids.

- [x] UI-3 | high | frontend-a11y | fixed:64dfc38 | 06-frontend-ui-robustness.md | Primary/admin navigation is built from unscoped absolute paths: current-page indication (aria-current + active styling) never renders, and every nav click detours through a full unmount/redirect
- [ ] UI-5 | medium | frontend-a11y | open | 06-frontend-ui-robustness.md | RepeatedBlockField renders duplicate DOM ids and a shared radio-group `name` across instances
- [ ] UI-6 | medium | frontend-a11y | open | 06-frontend-ui-robustness.md | Hand-rolled drift drawers are dialogs in name only: no aria-modal, no focus move, no focus trap, no Escape
- [ ] UI-7 | medium | frontend-a11y | open | 06-frontend-ui-robustness.md | ErrorSummary links are dead anchors for radio-group and repeated-block fields

## observability

No request logging, no request ids, missing healthchecks.

- [x] OPS-2 | high | observability | fixed:c89f727 | 10-reliability-operations.md | Unhandled errors become 500 `INTERNAL` with zero server-side logging
- [ ] ERR-7 | medium | observability | open | 09-error-handling.md | Unexpected errors become `{code:'INTERNAL'}` 500 with zero server-side logging
- [ ] OPS-10 | medium | observability | open | 10-reliability-operations.md | No log rotation and no resource limits on any service
- [ ] OPS-7 | medium | observability | open | 10-reliability-operations.md | No HTTP request logging and no request IDs anywhere in the api

## frontend-form

SchemaForm, repeated blocks and pickers.

- [ ] UI-11 | low | frontend-form | open | 06-frontend-ui-robustness.md | Nested repeated blocks skip their instance-count bounds
- [ ] UI-13 | low | frontend-form | open | 06-frontend-ui-robustness.md | RepeatedBlockField keys instances and touched-state by array index: state misattributes after a mid-list removal
- [ ] UI-14 | low | frontend-form | open | 06-frontend-ui-robustness.md | InventoryPicker: an optional single-select can never be cleared

## frontend-nav

Routing, redirects and current-page indication.

- [ ] CI-6 | medium | frontend-nav | open | 13-ci-cd.md | release-images publishes on any tag with no quality gate, mutable version stamping, and an unconditional `latest`
- [ ] ARCH-12 | low | frontend-nav | open | 01-architecture.md | `catalogctl` README's "complete, no more, no fewer" subcommand table omits a third of the subcommands
- [ ] FE-13 | low | frontend-nav | open | 05-frontend-flows.md | RequestDetail sub-panels hold un-keyed local state across request-id navigation

## resource-leak

Workspaces, temp files and unbounded resources.

- [ ] API-16 | low | resource-leak | open | 02-api-correctness.md | Bundle workspace leaks and unchecked git steps
- [ ] DATA-13 | low | resource-leak | open | 03-data-integrity.md | Failed atomic writes leak temp files in the store path
- [ ] ERR-13 | low | resource-leak | open | 09-error-handling.md | `prepare()` leaks the cloned workspace when `rev-parse` fails

## scheduler

The apply scheduler and cooling windows.

- [x] API-3 | high | scheduler | fixed:a19e688 | 02-api-correctness.md | Arming the scheduler halts every scheduled request: nothing ever writes the plan pin it requires
- [x] API-7 | medium | scheduler | fixed:a19e688 | 02-api-correctness.md | Scheduler ignores `earliestApplyAt`: a still-cooling request auto-applies the moment its window opens
- [ ] PERF-14 | low | scheduler | open | 11-performance-scalability.md | Scheduler tick re-scans every project's full request collection every minute
