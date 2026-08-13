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
- [x] API-5 | medium | concurrency | fixed:141077f | 02-api-correctness.md | Cancel can race an in-flight bundle: the change applies but the request reads CANCELLED
- [x] CONC-11 | medium | concurrency | fixed:951aaf9 | 04-concurrency.md | Registry writes that bump `version` without guarding it (trust-request upload, identity confirm) can clobber concurrent registry ops and rewind the dual-control version guard
- [x] CONC-4 | medium | concurrency | fixed:3b243aa | 04-concurrency.md | A revoked session can be resurrected by the concurrent idle-window slide
- [x] CONC-6 | medium | concurrency | fixed:bf6597d | 04-concurrency.md | The bundle claim has no crash/exception/race recovery: `bundle.state:'running'` can stick forever, and a raced outcome write loses the record of a fired deploy
- [x] CONC-7 | medium | concurrency | fixed:9dce28b | 04-concurrency.md | `FileStore` has no single-writer enforcement: two processes on the same data file silently destroy each other's writes
- [x] CONC-9 | medium | concurrency | fixed:b3d34f5 | 04-concurrency.md | Dual-control ack does not guard the pending row's status: a concurrently rejected proposal can still apply
- [x] DATA-8 | medium | concurrency | fixed:b3d34f5 | 03-data-integrity.md | Pending-change status transitions have no CAS: concurrent ack + reject can apply a change and record it as REJECTED
- [x] DATA-9 | medium | concurrency | fixed:9dce28b | 03-data-integrity.md | No single-writer guard: restore can be silently clobbered by a running server; nothing prevents two processes on one file
- [x] ERR-11 | medium | concurrency | fixed:09fb510 | 09-error-handling.md | The bundle idempotency claim guards on `status`, not `bundle.state`: concurrent applies can both run
- [x] ERR-8 | medium | concurrency | fixed:aaf11c9; node as PID 1 + graceful drain (src/shutdown.ts) + boot failures exit non-zero; test/processLifecycle.test.ts | 09-error-handling.md | No process-level failure handling: no graceful shutdown, no rejection/exception handlers, npm-as-PID-1
- [x] OPS-8 | medium | concurrency | fixed:aaf11c9; same defect as ERR-8, closed by it; adds stop_grace_period above the drain budget; test/processLifecycle.test.ts | 10-reliability-operations.md | No graceful shutdown: `npm` as PID 1, no SIGTERM handling, default 10 s grace on the api
- [ ] TEST-6 | medium | concurrency | open | 12-testing-quality.md | No route-level concurrency/race tests; store-level concurrency only
- [ ] API-14 | low | concurrency | open | 02-api-correctness.md | Conditional-write collisions inside `transactWithAudit` surface as the wrong error
- [ ] CONC-12 | low | concurrency | open | 04-concurrency.md | The store-backed submit rate limiter is check-then-insert: concurrent submits breach both caps
- [ ] CONC-13 | low | concurrency | open | 04-concurrency.md | Concurrent first-boot settlement can escape its own race handling and 500 early requests
- [x] CONC-14 | low | concurrency | fixed:version guards on rename, set-services and stripFromOthers; test/teamWriteGuards.test.ts | 04-concurrency.md | Team CRUD writes bump `version` but never guard on it
- [ ] CONC-15 | low | concurrency | open | 04-concurrency.md | `transactWithAudit` conflates a caller's domain guard failure with chain contention, producing dead error paths and mislabeled conflicts
- [x] REM-2 | low | concurrency | fixed:putSessionFieldGuarded narrows every SessionItem write to one guarded attribute (reauthAt, enrollSecretEnc+enrollOfferedAt); test/sessionFieldGuard.test.ts | 15-remediation.md | Session rows are still written with blind full-row puts

## contracts-docs

OpenAPI vs reality, and docs citing things that do not exist.

- [x] DOC-1 | high | contracts-docs | fixed:cdc5f2c | 14-contracts-docs.md | OpenAPI declares two `/catalog/*` endpoints that do not exist — and the parity test pins the phantoms
- [x] DOC-2 | high | contracts-docs | fixed:cdc5f2c | 14-contracts-docs.md | Shipped routes absent from the OpenAPI spec; `POST /requests/:id/apply` is documented nowhere at all
- [x] ARCH-6 | medium | contracts-docs | fixed:07a397f allowlist + transitive dependency-free rule over the @app-lib closure, and a planSummary copy-parity test — ARCH-6's declared partial; ccp/shared not extracted, R-60 | 01-architecture.md | The backend depends on frontend-package internals; the shared-contract layer is a path alias plus a hand-synced copy
- [x] DOC-10 | medium | contracts-docs | fixed:added 8 taxonomy codes + 13 inline literals to ERROR-STATES.md's tables; scripts/docs-error-codes-check.py generated check found 2 more the hand audit missed | 14-contracts-docs.md | ERROR-STATES.md's "every error code the API can return" is missing 8 taxonomy codes and 6 inline literals
- [x] DOC-11 | medium | contracts-docs | fixed:ChangeRequest.planSummary now $refs the PlanSummary component | 14-contracts-docs.md | OpenAPI types `ChangeRequest.planSummary` as a string; the API stores and serves a structured object
- [x] DOC-12 | medium | contracts-docs | fixed:added 8 rows (+ RequestSetItem, a 9th the hand audit missed) to DOMAIN-MODEL.md's entity catalog; scripts/docs-entity-catalog-check.py, extended to also verify each row's schema.ts line citation (DOC-17) | 14-contracts-docs.md | DOMAIN-MODEL.md's entity catalog is missing a third of the store's item types
- [x] DOC-4 | medium | contracts-docs | fixed:errors.ts cites the real contract; ERROR-STATES.md's grep-a-missing-file analysis re-measured and corrected | 14-contracts-docs.md | Multiple docs and a code header cite `ccp/docs/specs/ccp-api.md`, which does not exist in this repo
- [x] DOC-5 | medium | contracts-docs | fixed:cdc5f2c | 14-contracts-docs.md | ~100 broken relative markdown links across the published tree
- [x] DOC-6 | medium | contracts-docs | fixed:verified current code (routes/projects.ts) DOES gate on isOnboardable + refuses archived; API-SPEC.md row corrected to match | 14-contracts-docs.md | API-SPEC.md states the opposite of current code on `PUT /projects/:id/identity` gating
- [x] DOC-7 | medium | contracts-docs | fixed:2082fba | 14-contracts-docs.md | App `DriftProposal` type does not match the wire: `importPayload` has a different shape, and top-level `arn`/`tfType` are mock-only
- [x] DOC-8 | medium | contracts-docs | fixed:added drift-edit/scan-worker/window-check to the subcommand table, create_resource + its 4th dispatch table to the edit-verbs count (12→13); tools/catalogctl/readme_test.go | 14-contracts-docs.md | catalogctl README makes two explicit completeness claims that are false
- [x] DOC-9 | medium | contracts-docs | fixed:CCP_APPLY_FROZEN/CCP_APPLY_AUTO_REVERT/CCP_DRIFT_IMPORT/CCP_DRIFT_CHECK_CMD (+ CCP_GITHUB_APP_KEY, found in the same audit) added to api/README.md's env table + .env.example/docker-compose.yml; scripts/docs-env-vars-check.py | 14-contracts-docs.md | Four operator-facing env vars are undocumented (two of them documented nowhere at all)
- [x] TEST-7 | medium | contracts-docs | fixed:572e96d | 12-testing-quality.md | The SPA has no DOM/interaction testing; ~25 test files pin UI by source-string inspection
- [x] API-12 | low | contracts-docs | fixed:prNumberFromUrl now requires /pull/<n> or /merge_requests/<n>; test/linkPr.test.ts | 02-api-correctness.md | `prNumberFromUrl` extracts a "PR number" from any URL ending in digits
- [x] ARCH-14 | low | contracts-docs | fixed:verified closed by DOC-1 and DOC-2 — openapi.test.ts diffs the live Hono route table against the contract both ways | 01-architecture.md | The OpenAPI "parity test" is string containment, not parity
- [x] DOC-15 | low | contracts-docs | fixed:ec95bd2 | 14-contracts-docs.md | MAINTAINING-THE-CATALOG.md points at a generated-output directory that does not exist in the tree
- [x] DOC-16 | low | contracts-docs | fixed:GET /requests cursor was already resolved at HEAD (verified); fixed /admin/audit's uncapped claim + limit param, POST /admin/accounts' projectId, DriftChangedAttr's pathSegments in ccp-api.yaml | 14-contracts-docs.md | Assorted OpenAPI request/response gaps against route behavior
- [x] DOC-17 | low | contracts-docs | fixed:re-stamped the 4 named citations + all 24 DOMAIN-MODEL.md entity-catalog line citations (13 more were stale); scripts/docs-entity-catalog-check.py now verifies each against schema.ts — other prose citations remain disciplined staleness, not exhaustively re-verified | 14-contracts-docs.md | The code-derived docs' line citations have drifted from HEAD
- [x] TEST-11 | low | contracts-docs | fixed:verified closed by DOC-1 and DOC-2 — same defect as ARCH-14, fixed once | 12-testing-quality.md | OpenAPI contract test is substring matching, not conformance

## silent-failure

Failures that produce no signal — swallowed rejections, best-effort compensation, lanes that go green when they did nothing.

- [x] DATA-3 | high | silent-failure | fixed:0d4c3a4 | 03-data-integrity.md | A failed disk persist is not rolled back from memory: served state diverges from disk, and "failed" writes silently commit later
- [x] TEST-4 | high | silent-failure | fixed:fdda986 | 12-testing-quality.md | The highest-value integration tests skip silently when a toolchain is missing, and nothing asserts they ran in CI
- [x] ARCH-10 | medium | silent-failure | fixed:settlePendingExpiry writes a config-expire audit entry on every lazy expiry; test/dualControl.test.ts | 01-architecture.md | Unaudited governance transition: dual-control proposals expire silently
- [x] ARCH-9 | medium | silent-failure | fixed:572e96d | 01-architecture.md | Single-process, single-file scaling ceiling with in-process singletons the planned DynamoDB path would silently break
- [x] CI-9 | medium | silent-failure | fixed:scripts/ci/check-workflow-safety.sh (no job gated on vars.CI_RUNNER) | 13-ci-cd.md | The recurring data lane keeps the silent-skip gate its own sibling workflow documents as a trap
- [ ] DATA-5 | medium | silent-failure | open | 03-data-integrity.md | Store rows are not validated against the schemas on load: corrupt-but-parseable state is accepted silently
- [ ] ERR-6 | medium | silent-failure | open | 09-error-handling.md | `executor.replan()` failures are an unmodeled halt: unbounded silent retry, and they abort the rest of the project's due list
- [x] FE-8 | medium | silent-failure | fixed:loadAuditRows returns {rows, cursor}; AuditHistory adds a "Load older events" control + honest "N events loaded ... more available" caption | 05-frontend-flows.md | AuditHistory silently truncates to the first page (100 entries) — the cursor is fetched and thrown away
- [x] OPS-6 | medium | silent-failure | fixed:d10d035 | 10-reliability-operations.md | Plain `compose up` (including every self-update cycle) silently strips the armed overlay
- [x] TEST-8 | medium | silent-failure | fixed:treeDiff() now walks gotDir too, catching extra files golden.go never accounted for; golden_test.go TestTreeDiff | 12-testing-quality.md | Golden-tree comparison is one-directional: extra files created by an edit go unnoticed
- [x] CTL-8 | low | silent-failure | fixed:atomicWrite os.Stats the target's existing mode (default 0644 for a new file) and Chmods the temp file before rename; adds tmp.Sync() before Close() for crash-durability, mirroring ccp-api's FileStore.writeAtomic/ERR-10 pattern | 07-catalogctl.md | `atomicWrite` silently changes edited-file permissions to 0600 and skips fsync
- [x] ERR-14 | low | silent-failure | fixed:572e96d | 09-error-handling.md | Drift-upload compensation is non-transactional best-effort
- [x] ERR-16 | low | silent-failure | fixed:GH Actions warning annotation + step-summary on unreachable-control-plane; opt-in CCP_DATA_REQUIRE_UPLOAD hard-fail; scripts/ci/gen-project-data-selftest.sh | 09-error-handling.md | The ccp-data CI lane goes green when the control plane is unreachable
- [x] FE-15 | low | silent-failure | fixed:b5b703b | 05-frontend-flows.md | Notifications bell and CommandPalette swallow rejections silently
- [x] IMP-12 | low | silent-failure | fixed:cmd_split (both kit and kit-azure normalize.py) now also collects data/moved/import/locals/terraform top-level blocks into unclassified.tf's own section, WITH a warning, via a new parse_non_resource_blocks() | 08-importer-schemadump.md | `normalize.py split` silently drops non-`resource` top-level blocks
- [x] IMP-15 | low | silent-failure | fixed:d438983 | 08-importer-schemadump.md | Coverage-sweep family granularity marks undiscoverable resources as "covered" (documented, but with a concrete silent case)
- [x] UI-12 | low | silent-failure | fixed:RequestForm moves focus to the Review/Configure heading on each step transition (rAF, mirroring the existing invalid-path errorRef focus); RouteSkeleton is role="status" aria-busy with a visually-hidden "Loading…" text | 06-frontend-ui-robustness.md | Configure ⇄ Review step transitions never move focus, and the Suspense skeleton is silent for assistive tech

## stuck-state

States nothing can leave: wedged jobs, dead-end requests, permanently disabled controls.

- [x] API-2 | high | stuck-state | fixed:a19e688 | 02-api-correctness.md | HALTED_* and orphaned APPLYING requests are unrecoverable dead-end states
- [x] ERR-2 | high | stuck-state | fixed:09fb510 | 09-error-handling.md | A crash or late write failure strands `bundle.state='running'` forever; no recovery path exists
- [x] ERR-3 | high | stuck-state | fixed:a19e688 | 09-error-handling.md | Scan jobs stuck in non-terminal states are unrecoverable and block all future scans for the project
- [x] ERR-4 | high | stuck-state | fixed:a19e688 | 09-error-handling.md | A crashed apply worker strands a request in `APPLYING` forever, silently
- [x] FE-3 | high | stuck-state | fixed:0b83aec | 05-frontend-flows.md | RequestForm: one server-side rejection permanently disables submit — the only way out abandons the drafted request
- [x] OPS-4 | high | stuck-state | fixed:a19e688 | 10-reliability-operations.md | A scan job whose worker dies stays `claimed`/`cloning`/`scanning` forever and permanently wedges that project's onboarding
- [x] UI-2 | high | stuck-state | fixed:ed4ca42 | 06-frontend-ui-robustness.md | Resource drill-in dead-ends for every "named service" whose slug is not a literal manifest file: all 16 azure-fixture services are broken
- [x] API-4 | medium | stuck-state | fixed:02907ae | 02-api-correctness.md | The bundle "claim" is not a mutual-exclusion, and a crashed bundle wedges the request at `running`
- [ ] API-9 | medium | stuck-state | open | 02-api-correctness.md | Project deregistration leaves orphaned satellite rows; a reused id inherits the previous tenant's state
- [ ] CONC-10 | medium | stuck-state | open | 04-concurrency.md | Stuck `APPLYING` after a worker crash has no reclaim or operator path
- [x] ERR-12 | medium | stuck-state | fixed:141077f | 09-error-handling.md | Trigger failure after a landed commit: honest-but-dead-end half state, and spawn timeouts are indistinguishable from exit-1
- [ ] ERR-5 | medium | stuck-state | open | 09-error-handling.md | `TerraformExecutor.init()` caches a rejected promise: one transient init failure bricks the executor until restart
- [x] UI-4 | medium | stuck-state | fixed:b5b703b | 06-frontend-ui-robustness.md | Mutation handlers `await` API calls without try/catch: a network failure permanently wedges busy/submitting state
- [ ] API-15 | low | stuck-state | open | 02-api-correctness.md | A dangling idempotency marker makes its key permanently unusable
- [ ] DATA-12 | low | stuck-state | open | 03-data-integrity.md | Crash between the version-row transact and the file write leaves an activatable orphan row in the upload lane
- [x] ERR-15 | low | stuck-state | fixed:progress-report failures route through fail() for a best-effort terminal report; claim failures retry with backoff instead of exiting (--once excepted); worker_test.go, covscanworker_cov_test.go | 09-error-handling.md | Scan worker: a failed progress report abandons the job without a terminal status; a claim non-2xx is process-fatal with no backoff
- [x] OPS-12 | low | stuck-state | fixed:--heartbeat/--healthcheck liveness probe wired into scanner/Dockerfile's HEALTHCHECK and docker-compose.yml; claim retry (shared fix with ERR-15); worker_test.go | 10-reliability-operations.md | Scanner service: no healthcheck, and the worker exits on any control-plane error

## authz-identity

Roles, sessions, TOTP, dual control, quorum and idempotency.

- [x] ARCH-1 | high | authz-identity | fixed:4af8a46 | 01-architecture.md | Bundle apply route accepts pre-quorum requests, contradicting ADR-0016's "fully approved" contract
- [x] ARCH-2 | high | authz-identity | fixed:b7059cd | 01-architecture.md | The armed apply/drift-generation lanes are single-estate by construction in a multi-account product
- [x] FE-5 | high | authz-identity | fixed:85f2980 | 05-frontend-flows.md | Api-mode session expiry is never detected in-app — the UI stays "signed in" while every call fails
- [x] API-6 | medium | authz-identity | fixed:GET /admin/config-changes list-settles expired proposals (sweepExpired's real caller); ackPending/rejectPending settle-on-read before acting; test/dualControl.test.ts | 02-api-correctness.md | The 72-hour dual-control expiry is dead code: `sweepExpired` has no callers and `ackPending` never checks `expiresAt`
- [x] ARCH-4 | medium | authz-identity | fixed:80f024e | 01-architecture.md | No mutual exclusion between the two apply lanes; both act on `AWAITING_DEPLOY_APPROVAL`
- [ ] DATA-11 | medium | authz-identity | open | 03-data-integrity.md | v1 migration writes rows that violate the store schemas, including an `id`≠`username` shape that breaks session resolution
- [x] DATA-7 | medium | authz-identity | fixed:identical defect to API-6, fixed once (dualControl.ts); test/dualControl.test.ts | 03-data-integrity.md | The 72-hour dual-control expiry is unenforced: `sweepExpired` is dead code and `ackPending` never checks `expiresAt`
- [x] FE-4 | medium | authz-identity | fixed:b5b703b | 05-frontend-flows.md | ApprovalsQueue's stale-response guard is dead code — overlapping project-switch fetches can commit the wrong project's queue
- [x] FE-7 | medium | authz-identity | fixed:lib/pendingChanges.ts got the emitter/subscribeWithStorage/useSyncExternalStore treatment (usePendingCount); the server branch's effect is re-keyed on the route path so it refetches on every admin sub-route change | 05-frontend-flows.md | PendingChangesBanner count goes stale after any dual-control activity — and the mock branch reads an unsubscribed store
- [ ] FE-9 | medium | authz-identity | open | 05-frontend-flows.md | apiSession role resolution falls back to another scope's role when the user has no binding on the active project
- [ ] CTL-9 | low | authz-identity | open | 07-catalogctl.md | `pr-prepare`'s UNAPPROVED gate accepts any non-empty approvals list without checking `decision`
- [x] DOC-14 | low | authz-identity | fixed:verified already closed by DOC-2's fix (cdc5f2c) — §2 now has the apply row, §9's cross-reference resolves | 14-contracts-docs.md | PERMISSIONS.md §9 cites a "§2 apply row" that does not exist
- [x] FE-12 | low | authz-identity | fixed:applyMutatedRequestToList now takes the viewer and applies the same open-status ∧ canApprove ∧ can-sign-next-step predicate routes/requests.ts's scope=pending uses | 05-frontend-flows.md | After a partial approval, the queue keeps a card the server's pending scope would drop

## ci-not-wired

Checks that exist but run nowhere, or run and prove nothing.

- [x] CI-1 | high | ci-not-wired | fixed:21fd092 | 13-ci-cd.md | Two components' test suites run in no CI at all, and one of them is currently failing
- [x] CI-2 | high | ci-not-wired | fixed:pin >=v8.19.0 for `gitleaks dir` + PG-9 now hard-fails on a failed invocation | 13-ci-cd.md | PG-9 (gitleaks) is a silent no-op in CI: the pinned v8.18.4 has no `dir` subcommand, and the script converts the resulting error into PASS
- [x] CI-3 | high | ci-not-wired | fixed:81b7fbc | 13-ci-cd.md | Path filters skip validation for cross-component dependencies: app-lib, catalogctl parity, the canonical redaction rules, and the gate scripts themselves
- [x] CI-4 | high | ci-not-wired | fixed:dd1c241 | 13-ci-cd.md | The product's core "CI applies" pipeline is not shipped: nothing invokes plancheck-gate.sh or apply-window-gate.sh, and docs/scripts reference a workflow that no longer exists
- [x] IMP-3 | high | ci-not-wired | fixed:21fd092 | 08-importer-schemadump.md | No CI executes any importer test suite; two shipped regressions prove the gap
- [x] TEST-2 | high | ci-not-wired | fixed:21fd092 | 12-testing-quality.md | No CI lane executes any Python test suite; `gate.sh` omits them too
- [x] CI-8 | medium | ci-not-wired | fixed:scripts/ci/publish-gate-selftest.sh | 13-ci-cd.md | PG-5's secret heuristic misses the most common real-world shapes, and its designated backstop is dead in CI
- [x] OPS-9 | medium | ci-not-wired | fixed:CI_RUNNER wired into 10 of 12 workflows (docker-building release-images.yml/docker-build.yml excepted, no docker socket); check-workflow-safety.sh rule | 10-reliability-operations.md | The documented CI-runner cutover only routes 2 of 8 workflows
- [x] CI-10 | low | ci-not-wired | fixed:self-path added to ccp-api.yml/ccp-smoke.yml push:paths; check-path-filters.sh's new general self-inclusion check | 13-ci-cd.md | Push-trigger path filters omit the workflow file itself on ccp-api and ccp-smoke
- [x] CI-11 | low | ci-not-wired | fixed:gate.sh header comment corrected (real 4-workflow mirror list, terraform's actual placement) and checkov skip message stopped claiming a nonexistent CI backstop | 13-ci-cd.md | Stale toolchain claims: gate.sh advertises checks CI does not run
- [x] CI-12 | low | ci-not-wired | fixed:every uses: SHA-pinned across all 12 workflow files; cache-dependency-path added to all 5 setup-go usages | 13-ci-cd.md | Inconsistent action pinning, with a comment that contradicts the file it sits in; setup-go caching is configured to a nonexistent root go.sum
- [x] CI-13 | low | ci-not-wired | fixed:the smoke asserts authz, credential verification and the bootstrap login; ccp-smoke.yml no longer triggers on ccp/docs | 13-ci-cd.md | The smoke proves boot + serve, not the system's function; PR runs of it are triggered by any `ccp/**` docs change

## data-persistence

Durability, rollback, schema validation on load, and store-seam fidelity against DynamoDB.

- [x] PERF-1 | critical | data-persistence | fixed:813a6d9 | 11-performance-scalability.md | Every authenticated request rewrites the entire database to disk (session-slide write × full-store snapshot)
- [x] DATA-4 | high | data-persistence | fixed:813a6d9 | 03-data-integrity.md | Full-file rewrite + fsync on every mutation, including a session write on every authenticated request, against a store that only ever grows
- [x] CTL-5 | medium | data-persistence | fixed:572e96d | 07-catalogctl.md | `drift-edit` writes are neither atomic nor transactional: a mid-batch refusal leaves earlier edits in the checkout
- [x] DATA-10 | medium | data-persistence | fixed:572e96d | 03-data-integrity.md | Backup/restore covers only the store JSON; the on-disk project-data/drift root it references is out of scope, with no consistency check
- [x] DATA-6 | medium | data-persistence | fixed:fileStore.ts's directory fsync (ERR-10) was already in place; extended the identical syncDir pattern to snapshot.ts's writeFileAtomic (deliberately duplicated, not imported — it stays standalone for the backup/restore scripts) and to the 3 disk writers the recommendation names: projectData.ts, drift.ts, driftProposals.ts | 03-data-integrity.md | `rename` durability is not guaranteed: no directory fsync after the atomic swap
- [x] ERR-10 | medium | data-persistence | fixed:0d4c3a4 | 09-error-handling.md | FileStore persist failure leaves memory ahead of disk: the client gets a 500 for a write that took effect
- [x] UI-8 | medium | data-persistence | fixed:toRows splits a change line on body.lastIndexOf(' -> ') instead of split(' -> '); the trim()-discards-indentation sub-claim did not reproduce against current code (indent is always captured before trim runs) and was left unfixed, noted honestly | 06-frontend-ui-robustness.md | DiffView corrupts `~` change lines whose old value contains " -> "
- [ ] API-17 | low | data-persistence | open | 02-api-correctness.md | Store-seam divergences from the DynamoDB semantics it mirrors
- [ ] DATA-14 | low | data-persistence | open | 03-data-integrity.md | Seam-fidelity gaps between MemoryStore and the promised DynamoDB semantics
- [ ] DATA-15 | low | data-persistence | open | 03-data-integrity.md | Map key concatenation with a space separator is aliasable in principle; client-controlled bytes reach PKs unconstrained
- [ ] DATA-16 | low | data-persistence | open | 03-data-integrity.md | No format/version marker in the snapshot file; migration rests entirely on convention
- [x] REM-1 | medium | data-persistence | fixed:domain/versionStamp.ts marker-guarded boot one-shot; test/versionStamp.test.ts | 15-remediation.md | The optimistic-concurrency guards cannot bite on rows written before they existed

## duplication

The same rule implemented in two places, free to drift.

- [x] ARCH-5 | medium | duplication | fixed:268d5a2 | 01-architecture.md | Two sources of truth for the catalog: the server validates against the image-baked catalog, the SPA renders the per-project uploaded one
- [x] ARCH-7 | medium | duplication | fixed:3cf798c | 01-architecture.md | The request-status vocabulary is an unowned, drifted contract
- [x] ARCH-8 | medium | duplication | fixed:2082fba canSignApprovalStep/canSignStep unified through @app-lib (ARCH-6 seam); mock-vs-api gap table in ccp/README.md; policy-count divergence found and tracked as R-76, not fixed here | 01-architecture.md | The governance domain is implemented twice (server + browser mock) with acknowledged behavioral divergence
- [x] DOC-13 | medium | duplication | fixed:the YAML prose now names APPLYING/HALTED_DRIFT/HALTED_APPLY_FAILED; test/openapi.test.ts checks agreement automatically | 14-contracts-docs.md | Request-status vocabulary is three-way inconsistent (SPA union vs server writes vs YAML prose)
- [x] ARCH-11 | low | duplication | fixed:572e96d | 01-architecture.md | Arming-flag sprawl with no whole-config validation
- [x] ARCH-13 | low | duplication | fixed:new ccp/app/src/lib/projectId.ts is the single home; ccp/api/src/projects.ts re-exports PROJECT_ID_RE from it (via @app-lib/*), and drift.ts/projectData.ts/domain/drift.ts/projectOnboarding.ts all import it instead of redeclaring | 01-architecture.md | Project-id grammar duplicated inline despite a declared single home
- [x] ARCH-16 | low | duplication | fixed:removed unused requestableServices (permissions.ts) + its test, per the finding's own ADR-0022 deferred-removal note; corrected terraformExecutor.ts's stale "this repo's live estate roots" claim in 2 places; errors.ts was already fixed by DOC-4; autoEligible/CommitInput.audit left as already-adequately-documented | 01-architecture.md | Vestigial code and stale references
- [ ] CTL-10 | low | duplication | open | 07-catalogctl.md | Duplicated literal-object token-walkers (edit vs driftpropose) have already diverged in behavior
- [x] FE-11 | low | duplication | fixed:ALL_STATUSES derived from REQUEST_STATUSES in both filter files, not hand-typed | 05-frontend-flows.md | `WINDOW_EXPIRED` is missing from both status-filter vocabularies
- [x] OPS-14 | low | duplication | fixed:dd1c241 | 10-reliability-operations.md | Stale references to a nonexistent `.github/workflows/terraform.yml` anchor the Terraform pin
- [x] UI-10 | low | duplication | fixed:lib/statusCopy.ts is the one source; three humanizeStatus clones deleted, Notifications' default branch routed through it | 06-frontend-ui-robustness.md | Request-status copy has four competing sources; raw enum text can reach the UI

## importer

importer/kit, kit-azure and schemadump.

- [x] IMP-2 | high | importer | fixed:scripts/drift/sweep-ignore.json shipped with generic seeds | 08-importer-schemadump.md | `scripts/drift/sweep-ignore.json` is missing: the statediff sweep refuses out of the box
- [x] IMP-4 | high | importer | fixed:e3cc2c9 | 08-importer-schemadump.md | Azure capability ledger family classification is systematically wrong: multi-token `familyMap` keys are unreachable
- [x] IMP-6 | medium | importer | fixed:3358257 | 08-importer-schemadump.md | statediff's managed-set match assumes Terraform state `id` equals the discovery id; false-positive findings for id-divergent types (concrete: `aws_volume_attachment`)
- [x] IMP-7 | medium | importer | fixed:661d247 moved both Azure pins to 4.81.0; recurrence guard still missing | 08-importer-schemadump.md | Azure template provider pin (4.14.0) contradicts the committed azurerm schemadump tag (v4.81.0) it claims to bind to
- [x] IMP-8 | medium | importer | fixed:2cf8e05 | 08-importer-schemadump.md | Committed schemadump artifacts are not reproducible via the documented `gen.sh` pipeline; generated-catalog staleness detection is entirely manual
- [x] ARCH-15 | low | importer | fixed:ADR-0031 and ADR-0028 rows corrected to disclose their built pieces (Phase 1 shipped; --estate-tz/CCP_ESTATE_TZ shipped) alongside their still-Proposed formal status | 01-architecture.md | ADR ledger statuses lag the built system
- [x] IMP-10 | low | importer | fixed:services.json grows a `regional` flag (false for IAM/S3-bucket/KMS-alias types); gen-imports.py skips the @region suffix for them and refuses if the flag applies to zero rows | 08-importer-schemadump.md | `gen-imports.py --id-region-suffix` appends `@region` to global-service ids too
- [x] IMP-13 | low | importer | fixed:(a) mkdir/plan-write/meta-write in both discover.sh's now REFUSE IO_ERROR on failure instead of proceeding silently; (b) --region/--location are shape-validated before interpolation into capture-meta.json; (c) verify.sh's steady phase distinguishes plan-error (exit 1) from real drift (exit 2); (d) kit-azure's next-token call no longer swallows its own REFUSE via 2>/dev/null | 08-importer-schemadump.md | Shell scripts: minor robustness gaps around the deliberate no-`set -e` style
- [x] IMP-14 | low | importer | fixed:discover.sh's 44→43 count fixed; statediff.py's SWEEP_METHOD now derives its count from services.json instead of hardcoding it; kit-azure's dangling "terraform.yml" pin reference fixed; schemadump README's 85-vs-1677 mismatch documented | 08-importer-schemadump.md | Stale numbers and dangling references in kit/schemadump docs and comments
- [x] IMP-9 | low | importer | fixed:cmd_list_subscriptions's truncation-warning condition gains `isinstance(doc, dict) and`, mirroring cmd_next_token's already-correct guard | 08-importer-schemadump.md | Azure `discover.py list-subscriptions` crashes on a bare-list capture at the truncation-warning check

## test-quality

Red suites, silent skips, fixtures that pin the wrong premise.

- [x] TEST-1 | high | test-quality | fixed:importer/kit is green at HEAD (106 pass, was 7 failing) + .github/workflows/importer.yml | 12-testing-quality.md | `importer/kit` test suite is red at HEAD: 7 of 106 tests fail
- [ ] CTL-11 | medium | test-quality | open | 07-catalogctl.md | Golden coverage runs against forked fixture manifests, not the shipped catalog; comment-bearing fixtures are absent
- [ ] CTL-3 | medium | test-quality | open | 07-catalogctl.md | Shipped catalog op `waf-add-ip-set-entry` can never execute (exit 1 internal error); the corrected manifest exists only in test fixtures
- [x] TEST-3 | medium | test-quality | fixed:synthetic unmanaged type in the fixture + suite wired into .github/workflows/importer.yml | 12-testing-quality.md | `ccp/app/scripts/test_build_inventory.py` fails at HEAD (stale fixture premise)
- [x] TEST-5 | medium | test-quality | fixed:@vitest/coverage-v8 floors in ccp/api/vitest.config.ts and ccp/app/vite.config.ts, enforced by both CI lanes | 12-testing-quality.md | No code-coverage measurement anywhere; `coverage.test.ts` is not code coverage
- [x] CTL-7 | low | test-quality | fixed:inventoryAddr adds `&& p.Role != "reference"`, matching edit.targetAddress/prprep.inventoryAddr's existing sibling logic | 07-catalogctl.md | plancheck's `inventoryAddr` does not skip `role:"reference"` inventory params, diverging from the executor's `targetAddress`
- [x] FE-10 | low | test-quality | fixed:mock rejectRequest refuses a terminal request (status != AWAITING_CODE_REVIEW/NEEDS_ENGINEER), mirroring approveRequest's own status guard and ccp-api's OPEN_STATUSES/STATE_CONFLICT | 05-frontend-flows.md | Mock `rejectRequest` skips the status guard the real API enforces
- [x] TEST-10 | low | test-quality | fixed:§15 counts regenerated + command-quoted; ADMIN-01/ADMIN-04/REQ-16 dead citations repointed; deferred-XLAYER table added; scripts/docs-test-plan-citations-check.py | 12-testing-quality.md | Functional test plan drift: stale counts, loose citations, and "new" rows with no tracking
- [x] TEST-12 | low | test-quality | fixed:test/helpers/catalogctlBuild.ts — content-hash-keyed, renameSync'd build cache shared by both parity files; test/catalogctlBuild.test.ts | 12-testing-quality.md | One test file consumes ~60% of the api suite wall time by rebuilding catalogctl per run
- [x] TEST-13 | high | test-quality | fixed:the suite passes with the system clock shifted 4 months; 12 failures without the fix | 12-testing-quality.md | The test suites are coupled to the wall-clock calendar: they go red on a month boundary with no code change
- [x] TEST-9 | low | test-quality | fixed:driftGenIdle() completion hook (domain/driftProposals.ts) for positive waits; test/helpers/pollUntil.ts poll-with-deadline for negative waits | 12-testing-quality.md | Sleep-based synchronization in async API tests (flake and false-pass risk)

## blocking-io

`spawnSync` on the serving thread. One root cause, many symptoms.

- [x] API-1 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 02-api-correctness.md | Synchronous child-process execution freezes the whole API for minutes at a time
- [x] CONC-5 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 04-concurrency.md | `POST /requests/:id/apply` runs the entire bundle with `spawnSync`, freezing the whole API (health checks included) for up to tens of minutes
- [x] ERR-1 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 09-error-handling.md | Synchronous child processes block the entire API event loop for minutes
- [x] OPS-3 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 10-reliability-operations.md | Armed-lane commands run `spawnSync` on the event loop: the whole API freezes for up to 15 minutes and health checks flap
- [x] PERF-2 | high | blocking-io | fixed:domain/exec.ts replaces spawnSync with an awaited spawn; test/execNonBlocking.test.ts | 11-performance-scalability.md | `spawnSync` on the serving thread: the API freezes for up to 10-15 minutes during bundle/drift work
- [ ] API-8 | medium | stuck-state | open | 02-api-correctness.md | Freeze-held `kind:'now'` requests dead-end in AWAITING_DEPLOY_APPROVAL after the freeze lifts
- [ ] CONC-8 | medium | data-persistence | open | 04-concurrency.md | Every authenticated request triggers a full-store snapshot write; snapshot serialization is synchronous O(store) on the event loop
- [x] FE-6 | medium | duplication | fixed:572e96d | 05-frontend-flows.md | Api-mode submit gates read the advisory localStorage settings, not the server's — the freeze preview is dead and a stale local freeze silently blocks valid submits
- [x] PERF-12 | medium | scale-and-paging | fixed:5f9687b | 11-performance-scalability.md | Upload ingest does 4+ full canonical-JSON passes over the 16 MiB bundle synchronously on the event loop

## fail-open

Guards that pass when they should refuse.

- [x] ARCH-3 | high | fail-open | fixed:a64839a | 01-architecture.md | The "reviewed-plan ≡ applied-plan" guardrail is delegated to unverifiable operator shell strings
- [x] CTL-1 | high | fail-open | fixed:bd7275b | 07-catalogctl.md | Full-line comment above a map entry corrupts every literal-map edit (duplicate keys, defeated KEY_CONFLICT guard, silent no-op removes) — exit 0
- [ ] CTL-4 | medium | fail-open | open | 07-catalogctl.md | plan-check R1 structurally vetoes every legitimate plan for a `local.`-targeted foreach op
- [x] CTL-6 | medium | fail-open | fixed:new containsAddress()/isIdentByte() boundary check replaces the raw bytes.Contains scan at both call sites in danglingRef, so a byte-prefix sibling (aws_ebs_volume.data inside .data_archive) no longer over-matches — boundary checks only remove false positives, provably never introduce false negatives | 07-catalogctl.md | `danglingRef` substring scan falsely refuses removal when another resource's name extends the target's name
- [x] API-11 | low | fail-open | fixed:the clock-usage half was already correctly using nowDate() (verified, not re-fixed); MAX_MONTHS_WALKED raised from 120 to 1200 — every walk site already self-terminates on collected>=total, so the cap is a corrupted-store safety valve, not the real limit, and 120 was low enough to silently truncate a genuinely decade-plus deployment | 02-api-correctness.md | Audit-chain read path bypasses the injected clock and truncates at 120 months
- [x] API-13 | low | fail-open | fixed:verified closed by ARCH-7 — rateLimit.ts's occupiesQuotaSlot is derived from the closed vocabulary; test/statusVocabulary.test.ts covers all four missing statuses | 02-api-correctness.md | `maxOpen` rate-limit counts a nonexistent status and misses real open states
- [ ] API-18 | low | fail-open | open | 02-api-correctness.md | Legitimize endpoint mints unlimited duplicate engineer requests for the same digest
- [x] FE-14 | low | fail-open | fixed:refreshStatus now captures the project id via a ref before its request and discards the response if the project switched or the page unmounted before it resolved, mirroring the main effect's own active-flag guard | 05-frontend-flows.md | DriftPage's post-trigger refetches bypass the staleness guard

## frontend-ux

Missing error and retry paths; permanent loading states.

- [x] FE-1 | high | frontend-ux | fixed:b5b703b | 05-frontend-flows.md | Mutation calls have no rejection path — a network failure strands the acting control in a permanent busy state
- [x] FE-2 | high | frontend-ux | fixed:b5b703b | 05-frontend-flows.md | Initial page loads have no error state — any failed fetch leaves an eternal "Loading…" with no retry
- [x] UI-1 | high | frontend-ux | fixed:b5b703b | 06-frontend-ui-robustness.md | Non-admin data pages have no fetch-error path: any API failure leaves a permanent "Loading…" with no message or retry
- [x] ERR-9 | medium | frontend-ux | fixed:572e96d | 09-error-handling.md | GitHub App credential fetches have no timeout, and any failure terminally fails the scan job with no retry
- [x] UI-9 | medium | frontend-ux | fixed:the whole route tree wraps in a pathless root layout route carrying one errorElement (routeConfig.tsx, split out of router.tsx so it's importable as plain data for the structural regression test) | 06-frontend-ui-robustness.md | `/login`, `/onboarding`, and the LegacyRedirect route have no errorElement: a render error there shows React Router's raw default error screen
- [x] IMP-11 | low | frontend-ux | fixed:split_generated tracks heredoc open/close markers (HEREDOC_OPEN_RE) and suspends "}"/new-header detection until the terminator closes it, so a column-0 "}" inside the body no longer ends the block early; a heredoc still open at EOF/next-header falls through to the existing "unterminated" ambiguity | 08-importer-schemadump.md | `payloads.py` block scanner: a column-0 `}` inside a heredoc body truncates the skeleton and ships it
- [x] UI-15 | low | frontend-ux | fixed:"My requests" split into its own effect keyed additionally on `open`, mirroring Notifications.tsx's UIUX-13 fix, while manifests/inventory stay mount-only (legitimately static) | 06-frontend-ui-robustness.md | CommandPalette data is fetched once per shell mount, so "My requests" rows go stale within a session

## install-ops

Bootstrap, install, migration, compose and overlays.

- [x] OPS-1 | critical | install-ops | fixed:install.sh + intranet-setup.sh decide bootstrap before the first up; ccp/scripts/test/install-bootstrap-decision.test.sh | 10-reliability-operations.md | Fresh-install bootstrap deadlock: boot-time settlement creates the store file, then `CCP_BOOTSTRAP=1` is refused
- [x] OPS-5 | high | install-ops | fixed:f33aa29 | 10-reliability-operations.md | `migrate-data.sh`'s post-cutover byte-identical check is tripped by the new code's own boot writes: legacy migrations auto-roll back
- [x] CI-5 | medium | install-ops | fixed:verified closed by TEST-4 — requireToolchain.ts plus pinned toolchains in ccp-api.yml | 13-ci-cd.md | Whether the api's live parity/integration suites run in CI depends on unpinned runner-preinstalled toolchains; nothing asserts they ran
- [x] CI-7 | medium | install-ops | fixed:new .github/workflows/docker-build.yml — compose-config validation + matrix build of all 5 images, api image booted and /readyz-probed | 13-ci-cd.md | The Docker build path (the documented production install) is never exercised by CI; images are first built at release time
- [x] DOC-3 | medium | install-ops | fixed:cdc5f2c | 14-contracts-docs.md | OpenAPI `servers: [{url: /v2}]` does not match any deployed base path
- [x] OPS-13 | low | install-ops | fixed:the container-status case statement checks "(unhealthy)"/Restarting BEFORE the bare `*Up*)` pattern, and the aggregate FAIL check gains a second grep for both, since the per-line loop runs in a pipe subshell and can't set FAIL itself | 10-reliability-operations.md | `doctor.sh` reports an unhealthy container as OK
- [x] OPS-15 | low | install-ops | fixed:setup.sh data's layout gains /data/ccp/forge (1000:1000 700); doctor.sh resolves CCP_GITHUB_APP_KEY_FILE's container path to its host path via CCP_GITHUB_APP_KEY_HOST_DIR and checks it exists + is readable by uid 1000 | 10-reliability-operations.md | GitHub App key directory is not prepared or checked by any tooling

## scale-and-paging

Full scans, unpaged reads, work proportional to total data.

- [x] PERF-3 | high | scale-and-paging | fixed:813a6d9 | 11-performance-scalability.md | `GET /requests` has no pagination and ships full rows (events, params, plan summaries, pinned plan text), with an O(n) write-capable settle loop per call
- [x] PERF-5 | high | scale-and-paging | fixed:2fd1794 | 11-performance-scalability.md | Frontend main bundle is 3.76 MB (663 KB gzip) with all 115 manifest JSONs inlined and zod-parsed at module init
- [x] PERF-10 | medium | scale-and-paging | fixed:5f9687b | 11-performance-scalability.md | Submit-path full scans: rate-limit check and feasibility each re-scan whole collections per submission
- [x] PERF-8 | medium | scale-and-paging | fixed:25a7f0b | 11-performance-scalability.md | Admin audit "pagination" materializes and re-sorts the whole chain per page; cursor lookup is a linear scan
- [x] PERF-9 | medium | scale-and-paging | fixed:blockSourcesFor fetches only the chunks the given addresses live in; test/block-source.test.ts | 11-performance-scalability.md | `ServiceConsole` loads the entire block-source corpus on every service page mount, fetching server chunks sequentially
- [x] PERF-13 | low | scale-and-paging | fixed:resolveEnum's inventory scan is memoized per (inventory, resourceType, field) in a WeakMap; test/interpreter.test.ts | 11-performance-scalability.md | SchemaForm recomputes inventory-derived enums for every field on every keystroke
- [x] PERF-15 | low | scale-and-paging | fixed:windowSlice caps MyRequests/ApprovalsQueue/LeadDashboard to DEFAULT_WINDOW_SIZE with a "Show more" control; test/windowing.test.ts | 11-performance-scalability.md | Request-history views render unbounded lists without windowing

## audit-chain

The evidence chain: month walk, export, verification.

- [x] DATA-2 | high | audit-chain | fixed:813a6d9 | 03-data-integrity.md | Audit month-walk duplicates the current month at month ends: audit export corrupts and `/readyz` goes red on ~7 days a year
- [x] PERF-4 | high | audit-chain | fixed:813a6d9 | 11-performance-scalability.md | `/readyz` re-verifies every audit chain hash on every probe: O(total audit entries) CPU per health check
- [x] OPS-11 | medium | audit-chain | fixed:verified closed by PERF-4 — verifyProjectChain (auditQuery.ts) memoizes a verified prefix and only re-walks the suffix added since the last probe; readiness.ts already calls it instead of exportAuditChain; test/auditPaging.test.ts's 8-test "incremental verification" suite pins the fast path AND R-34's caveat (a mid-prefix tamper is caught by export/a fresh process, not by the fast memo path — confirmed still true) | 10-reliability-operations.md | `/readyz` re-verifies every audit chain on every probe; cost grows unboundedly with history
- [x] PERF-11 | medium | audit-chain | fixed:25a7f0b | 11-performance-scalability.md | Per-project audit chain head serializes all writes and surfaces contention as user-facing 409s after one retry
- [x] PERF-7 | medium | audit-chain | fixed:25a7f0b | 11-performance-scalability.md | Nothing in the store is ever purged: sessions, idempotency markers, and the audit chain grow forever (and every byte is re-serialized per request)
- [x] DATA-17 | low | audit-chain | fixed:verified already closed by TEST-13's fix — the actual calendar-dependent test now derives its partition via nowIso().slice(0,7) (inline comment credits TEST-13); the one remaining literal '202607' (fileStore.test.ts:98) is self-consistent (same key object for write and read-back), not calendar-dependent | 03-data-integrity.md | Calendar-dependent test: the FileStore audit-durability test hardcodes month `202607`

## catalogctl

The codemod, plan-check and drift-edit.

- [x] IMP-1 | high | catalogctl | fixed:with_meta=True back-ported from the azure kit; importer/kit suite 106 pass | 08-importer-schemadump.md | `importer/kit/normalize.py` `split`/`guard` crash under the repo-pinned python-hcl2 (KeyError, not a refusal)
- [ ] CTL-2 | medium | catalogctl | open | 07-catalogctl.md | `moved_block` writes invalid or duplicate-resource HCL at exit 0: no identifier validation, no destination-collision check, no dangling-reference handling
- [x] IMP-5 | medium | catalogctl | fixed:discover.sh clears `$OUT/$capture.page*.json` and `$OUT/$capture.json` at the top of each capture's paging loop, before writing anything; merge_pages (discover.py) refuses BAD_CAPTURE if both forms exist for one capture (a hand-assembled or interrupted-cleanup directory) instead of silently double-counting | 08-importer-schemadump.md | kit-azure `discover.sh` never clears stale page files: a re-run can resurrect deleted resources into the manifest
- [x] PERF-6 | medium | catalogctl | fixed:client caches inventory/manifests per project + revalidates via If-None-Match; server sends ETag off the stored digest and reads async; test/httpApiProjectData.test.ts, test/projectData.test.ts | 11-performance-scalability.md | API mode re-downloads and re-parses the full inventory + manifest set on every route mount; the serve endpoints send no caching headers

## frontend-a11y

Focus management, dialog semantics, duplicate DOM ids.

- [x] UI-3 | high | frontend-a11y | fixed:64dfc38 | 06-frontend-ui-robustness.md | Primary/admin navigation is built from unscoped absolute paths: current-page indication (aria-current + active styling) never renders, and every nav click detours through a full unmount/redirect
- [x] UI-5 | medium | frontend-a11y | fixed:Field/RepeatedBlockField take an idPrefix so nested instance ids/radio-group names are unique per instance (field-<prefix>.<name>) | 06-frontend-ui-robustness.md | RepeatedBlockField renders duplicate DOM ids and a shared radio-group `name` across instances
- [x] UI-6 | medium | frontend-a11y | fixed:new shared useModal hook gives every drift drawer + ReauthDialog aria-modal, initial focus, Tab/Shift+Tab trap (tabTrapTarget extracted pure for unit testing), Escape-to-close, and focus restoration to the trigger | 06-frontend-ui-robustness.md | Hand-rolled drift drawers are dialogs in name only: no aria-modal, no focus move, no focus trap, no Escape
- [x] UI-7 | medium | frontend-a11y | fixed:the radiogroup div and the RepeatedBlockField fieldset both carry the id ErrorSummary's #field-<name> anchor needs, via the same idPrefix plumbing as UI-5 | 06-frontend-ui-robustness.md | ErrorSummary links are dead anchors for radio-group and repeated-block fields

## observability

No request logging, no request ids, missing healthchecks.

- [x] OPS-2 | high | observability | fixed:c89f727 | 10-reliability-operations.md | Unhandled errors become 500 `INTERNAL` with zero server-side logging
- [x] ERR-7 | medium | observability | fixed:verified closed by OPS-2 — registerErrorHandler (errors.ts) calls logServerError (message+stack+method+path, redacted) before every 500; confirmed via grep that errors.ts's app.onError is the ONLY HTTP-500-producing code path anywhere in ccp/api/src, so "every 500 path logs" is trivially satisfied; test/serverErrorLogging.test.ts (11 tests) pins it | 09-error-handling.md | Unexpected errors become `{code:'INTERNAL'}` 500 with zero server-side logging
- [x] OPS-10 | medium | observability | fixed:shared x-logging anchor (json-file, max-size 10m, max-file 5) applied to all 5 services; api gets mem_limit ${CCP_API_MEM_LIMIT:-1g}, runner gets ${CCP_RUNNER_MEM_LIMIT:-4g} — both compose-syntax (mem_limit/cpus, not deploy:, which plain `docker compose up` ignores outside swarm mode) | 10-reliability-operations.md | No log rotation and no resource limits on any service
- [x] OPS-7 | medium | observability | fixed:d10d035 | 10-reliability-operations.md | No HTTP request logging and no request IDs anywhere in the api

## frontend-form

SchemaForm, repeated blocks and pickers.

- [x] UI-11 | low | frontend-form | fixed:repeatedInstanceErrors' f.repeated branch now applies the same bounds.minItems/maxItems check validateParams applies at the top level, before recursing into per-instance sub-field validity | 06-frontend-ui-robustness.md | Nested repeated blocks skip their instance-count bounds
- [x] UI-13 | low | frontend-form | fixed:new reindexTouchedAfterRemove pure function; RepeatedBlockField's remove() calls it so a sub-field's touched state stays attached to the row it belonged to, not the row that slides into its old index | 06-frontend-ui-robustness.md | RepeatedBlockField keys instances and touched-state by array index: state misattributes after a mid-list removal
- [x] UI-14 | low | frontend-form | fixed:a "×" clear button renders over a committed, closed, non-required selection; aria-controls now only present while the listbox is open | 06-frontend-ui-robustness.md | InventoryPicker: an optional single-select can never be cleared

## frontend-nav

Routing, redirects and current-page indication.

- [x] CI-6 | medium | frontend-nav | fixed:scripts/ci/check-workflow-safety.sh (preflight gate, conditional latest, concurrency) | 13-ci-cd.md | release-images publishes on any tag with no quality gate, mutable version stamping, and an unconditional `latest`
- [x] ARCH-12 | low | frontend-nav | fixed:drift-edit/scan-worker/window-check added to the subcommand table (shared fix with DOC-8); tools/catalogctl/readme_test.go#TestReadmeSubcommandsComplete | 01-architecture.md | `catalogctl` README's "complete, no more, no fewer" subcommand table omits a third of the subcommands
- [x] FE-13 | low | frontend-nav | fixed:WindowPanel and LinkPrPanel are both keyed key={request.id} so a request-id navigation forces a fresh mount (and fresh initial rewindowAt/prUrl state) instead of reusing the prior request's | 05-frontend-flows.md | RequestDetail sub-panels hold un-keyed local state across request-id navigation

## resource-leak

Workspaces, temp files and unbounded resources.

- [x] API-16 | low | resource-leak | fixed:prepare() rmSyncs on a rev-parse failure; commit() checks add's status and validates the post-commit sha; test/bundle.test.ts | 02-api-correctness.md | Bundle workspace leaks and unchecked git steps
- [x] DATA-13 | low | resource-leak | fixed:fileStore.ts's cleanup-on-failure (ERR-10) was already in place; extended: snapshot.ts's writeFileAtomic gains the same try/catch temp-file cleanup (was leaking); FileStore.open now sweeps stale `<file>.tmp-*` on boot (a kill -9 mid-write leaves one behind that no catch block ever runs for) — drift.ts/driftProposals.ts/projectData.ts already cleaned up on failure, confirmed unaffected | 03-data-integrity.md | Failed atomic writes leak temp files in the store path
- [x] ERR-13 | low | resource-leak | fixed:same fix as API-16's prepare() half; test/bundle.test.ts | 09-error-handling.md | `prepare()` leaks the cloned workspace when `rev-parse` fails

## scheduler

The apply scheduler and cooling windows.

- [x] API-3 | high | scheduler | fixed:a19e688 | 02-api-correctness.md | Arming the scheduler halts every scheduled request: nothing ever writes the plan pin it requires
- [x] API-7 | medium | scheduler | fixed:a19e688 | 02-api-correctness.md | Scheduler ignores `earliestApplyAt`: a still-cooling request auto-applies the moment its window opens
- [ ] PERF-14 | low | scheduler | open | 11-performance-scalability.md | Scheduler tick re-scans every project's full request collection every minute
