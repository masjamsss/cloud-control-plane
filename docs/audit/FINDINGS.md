# Findings checklist

Single source of truth for every finding in `docs/audit/`. **Machine-verified by `scripts/findings-gate.sh`** — a finding cannot be silently dropped, and its status cannot be left blank.

## Line grammar (the gate parses this — keep the format)

```
- [ ] ID | severity | status | report | title
```

`status` is one of:

| status | means | required |
|---|---|---|
| `open` | not yet triaged or not yet done | — (checkbox stays `[ ]`) |
| `fixed:<evidence>` | resolved | a commit sha, PR ref, or test name |
| `accepted:<reason>` | will not fix, deliberately | a reason |
| `deferred:<owner>` | will fix later | an owner |

Anything other than `open` must have the checkbox ticked (`[x]`). The gate enforces that.

## Status

**210 findings** — 2 critical, 47 high, 91 medium, 70 low.

The gate runs in two modes. Normal mode **ratchets**: it fails if a finding loses its ledger entry, if a status is malformed, or if the open count rises above the baseline in `scripts/findings-baseline.txt`. `--strict` fails while *any* finding is still `open` — that is the mode that must pass before this work is considered closed.


## 01-architecture.md

- [ ] ARCH-1 | high | open | 01-architecture.md | Bundle apply route accepts pre-quorum requests, contradicting ADR-0016's "fully approved" contract
- [ ] ARCH-2 | high | open | 01-architecture.md | The armed apply/drift-generation lanes are single-estate by construction in a multi-account product
- [ ] ARCH-3 | high | open | 01-architecture.md | The "reviewed-plan ≡ applied-plan" guardrail is delegated to unverifiable operator shell strings
- [ ] ARCH-4 | medium | open | 01-architecture.md | No mutual exclusion between the two apply lanes; both act on `AWAITING_DEPLOY_APPROVAL`
- [ ] ARCH-5 | medium | open | 01-architecture.md | Two sources of truth for the catalog: the server validates against the image-baked catalog, the SPA renders the per-project uploaded one
- [ ] ARCH-6 | medium | open | 01-architecture.md | The backend depends on frontend-package internals; the shared-contract layer is a path alias plus a hand-synced copy
- [ ] ARCH-7 | medium | open | 01-architecture.md | The request-status vocabulary is an unowned, drifted contract
- [ ] ARCH-8 | medium | open | 01-architecture.md | The governance domain is implemented twice (server + browser mock) with acknowledged behavioral divergence
- [ ] ARCH-9 | medium | open | 01-architecture.md | Single-process, single-file scaling ceiling with in-process singletons the planned DynamoDB path would silently break
- [ ] ARCH-10 | medium | open | 01-architecture.md | Unaudited governance transition: dual-control proposals expire silently
- [ ] ARCH-11 | low | open | 01-architecture.md | Arming-flag sprawl with no whole-config validation
- [ ] ARCH-12 | low | open | 01-architecture.md | `catalogctl` README's "complete, no more, no fewer" subcommand table omits a third of the subcommands
- [ ] ARCH-13 | low | open | 01-architecture.md | Project-id grammar duplicated inline despite a declared single home
- [ ] ARCH-14 | low | open | 01-architecture.md | The OpenAPI "parity test" is string containment, not parity
- [ ] ARCH-15 | low | open | 01-architecture.md | ADR ledger statuses lag the built system
- [ ] ARCH-16 | low | open | 01-architecture.md | Vestigial code and stale references

## 02-api-correctness.md

- [ ] API-1 | high | open | 02-api-correctness.md | Synchronous child-process execution freezes the whole API for minutes at a time
- [ ] API-2 | high | open | 02-api-correctness.md | HALTED_* and orphaned APPLYING requests are unrecoverable dead-end states
- [ ] API-3 | high | open | 02-api-correctness.md | Arming the scheduler halts every scheduled request: nothing ever writes the plan pin it requires
- [ ] API-4 | medium | open | 02-api-correctness.md | The bundle "claim" is not a mutual-exclusion, and a crashed bundle wedges the request at `running`
- [ ] API-5 | medium | open | 02-api-correctness.md | Cancel can race an in-flight bundle: the change applies but the request reads CANCELLED
- [ ] API-6 | medium | open | 02-api-correctness.md | The 72-hour dual-control expiry is dead code: `sweepExpired` has no callers and `ackPending` never checks `expiresAt`
- [ ] API-7 | medium | open | 02-api-correctness.md | Scheduler ignores `earliestApplyAt`: a still-cooling request auto-applies the moment its window opens
- [ ] API-8 | medium | open | 02-api-correctness.md | Freeze-held `kind:'now'` requests dead-end in AWAITING_DEPLOY_APPROVAL after the freeze lifts
- [ ] API-9 | medium | open | 02-api-correctness.md | Project deregistration leaves orphaned satellite rows; a reused id inherits the previous tenant's state
- [ ] API-10 | medium | open | 02-api-correctness.md | Session revocation can be silently undone by the idle-slide write-back race
- [ ] API-11 | low | open | 02-api-correctness.md | Audit-chain read path bypasses the injected clock and truncates at 120 months
- [ ] API-12 | low | open | 02-api-correctness.md | `prNumberFromUrl` extracts a "PR number" from any URL ending in digits
- [ ] API-13 | low | open | 02-api-correctness.md | `maxOpen` rate-limit counts a nonexistent status and misses real open states
- [ ] API-14 | low | open | 02-api-correctness.md | Conditional-write collisions inside `transactWithAudit` surface as the wrong error
- [ ] API-15 | low | open | 02-api-correctness.md | A dangling idempotency marker makes its key permanently unusable
- [ ] API-16 | low | open | 02-api-correctness.md | Bundle workspace leaks and unchecked git steps
- [ ] API-17 | low | open | 02-api-correctness.md | Store-seam divergences from the DynamoDB semantics it mirrors
- [ ] API-18 | low | open | 02-api-correctness.md | Legitimize endpoint mints unlimited duplicate engineer requests for the same digest

## 03-data-integrity.md

- [ ] DATA-1 | high | open | 03-data-integrity.md | Request-row writes lack optimistic concurrency: concurrent approvals/rejections silently lose updates and can corrupt the quorum ledger
- [ ] DATA-2 | high | open | 03-data-integrity.md | Audit month-walk duplicates the current month at month ends: audit export corrupts and `/readyz` goes red on ~7 days a year
- [ ] DATA-3 | high | open | 03-data-integrity.md | A failed disk persist is not rolled back from memory: served state diverges from disk, and "failed" writes silently commit later
- [ ] DATA-4 | high | open | 03-data-integrity.md | Full-file rewrite + fsync on every mutation, including a session write on every authenticated request, against a store that only ever grows
- [ ] DATA-5 | medium | open | 03-data-integrity.md | Store rows are not validated against the schemas on load: corrupt-but-parseable state is accepted silently
- [ ] DATA-6 | medium | open | 03-data-integrity.md | `rename` durability is not guaranteed: no directory fsync after the atomic swap
- [ ] DATA-7 | medium | open | 03-data-integrity.md | The 72-hour dual-control expiry is unenforced: `sweepExpired` is dead code and `ackPending` never checks `expiresAt`
- [ ] DATA-8 | medium | open | 03-data-integrity.md | Pending-change status transitions have no CAS: concurrent ack + reject can apply a change and record it as REJECTED
- [ ] DATA-9 | medium | open | 03-data-integrity.md | No single-writer guard: restore can be silently clobbered by a running server; nothing prevents two processes on one file
- [ ] DATA-10 | medium | open | 03-data-integrity.md | Backup/restore covers only the store JSON; the on-disk project-data/drift root it references is out of scope, with no consistency check
- [ ] DATA-11 | medium | open | 03-data-integrity.md | v1 migration writes rows that violate the store schemas, including an `id`≠`username` shape that breaks session resolution
- [ ] DATA-12 | low | open | 03-data-integrity.md | Crash between the version-row transact and the file write leaves an activatable orphan row in the upload lane
- [ ] DATA-13 | low | open | 03-data-integrity.md | Failed atomic writes leak temp files in the store path
- [ ] DATA-14 | low | open | 03-data-integrity.md | Seam-fidelity gaps between MemoryStore and the promised DynamoDB semantics
- [ ] DATA-15 | low | open | 03-data-integrity.md | Map key concatenation with a space separator is aliasable in principle; client-controlled bytes reach PKs unconstrained
- [ ] DATA-16 | low | open | 03-data-integrity.md | No format/version marker in the snapshot file; migration rests entirely on convention
- [ ] DATA-17 | low | open | 03-data-integrity.md | Calendar-dependent test: the FileStore audit-durability test hardcodes month `202607`

## 04-concurrency.md

- [ ] CONC-1 | high | open | 04-concurrency.md | Concurrent approvals of the same request silently lose signatures (lost update via unguarded row put + stale retry)
- [ ] CONC-2 | high | open | 04-concurrency.md | Reject, link-pr and plan-summary use unguarded full-row puts through `transactWithAudit`, which retries with the stale snapshot; this also defeats the scheduler's `APPLYING` claim
- [ ] CONC-3 | high | open | 04-concurrency.md | The entire auth/self-service lane writes the account row with blind full-row puts, clobbering concurrent admin mutations and undermining the `accountVersion` drift-guard doctrine
- [ ] CONC-5 | high | open | 04-concurrency.md | `POST /requests/:id/apply` runs the entire bundle with `spawnSync`, freezing the whole API (health checks included) for up to tens of minutes
- [ ] CONC-4 | medium | open | 04-concurrency.md | A revoked session can be resurrected by the concurrent idle-window slide
- [ ] CONC-6 | medium | open | 04-concurrency.md | The bundle claim has no crash/exception/race recovery: `bundle.state:'running'` can stick forever, and a raced outcome write loses the record of a fired deploy
- [ ] CONC-7 | medium | open | 04-concurrency.md | `FileStore` has no single-writer enforcement: two processes on the same data file silently destroy each other's writes
- [ ] CONC-8 | medium | open | 04-concurrency.md | Every authenticated request triggers a full-store snapshot write; snapshot serialization is synchronous O(store) on the event loop
- [ ] CONC-9 | medium | open | 04-concurrency.md | Dual-control ack does not guard the pending row's status: a concurrently rejected proposal can still apply
- [ ] CONC-10 | medium | open | 04-concurrency.md | Stuck `APPLYING` after a worker crash has no reclaim or operator path
- [ ] CONC-11 | medium | open | 04-concurrency.md | Registry writes that bump `version` without guarding it (trust-request upload, identity confirm) can clobber concurrent registry ops and rewind the dual-control version guard
- [ ] CONC-12 | low | open | 04-concurrency.md | The store-backed submit rate limiter is check-then-insert: concurrent submits breach both caps
- [ ] CONC-13 | low | open | 04-concurrency.md | Concurrent first-boot settlement can escape its own race handling and 500 early requests
- [ ] CONC-14 | low | open | 04-concurrency.md | Team CRUD writes bump `version` but never guard on it
- [ ] CONC-15 | low | open | 04-concurrency.md | `transactWithAudit` conflates a caller's domain guard failure with chain contention, producing dead error paths and mislabeled conflicts

## 05-frontend-flows.md

- [ ] FE-1 | high | open | 05-frontend-flows.md | Mutation calls have no rejection path — a network failure strands the acting control in a permanent busy state
- [ ] FE-2 | high | open | 05-frontend-flows.md | Initial page loads have no error state — any failed fetch leaves an eternal "Loading…" with no retry
- [ ] FE-3 | high | open | 05-frontend-flows.md | RequestForm: one server-side rejection permanently disables submit — the only way out abandons the drafted request
- [ ] FE-5 | high | open | 05-frontend-flows.md | Api-mode session expiry is never detected in-app — the UI stays "signed in" while every call fails
- [ ] FE-4 | medium | open | 05-frontend-flows.md | ApprovalsQueue's stale-response guard is dead code — overlapping project-switch fetches can commit the wrong project's queue
- [ ] FE-6 | medium | open | 05-frontend-flows.md | Api-mode submit gates read the advisory localStorage settings, not the server's — the freeze preview is dead and a stale local freeze silently blocks valid submits
- [ ] FE-7 | medium | open | 05-frontend-flows.md | PendingChangesBanner count goes stale after any dual-control activity — and the mock branch reads an unsubscribed store
- [ ] FE-8 | medium | open | 05-frontend-flows.md | AuditHistory silently truncates to the first page (100 entries) — the cursor is fetched and thrown away
- [ ] FE-9 | medium | open | 05-frontend-flows.md | apiSession role resolution falls back to another scope's role when the user has no binding on the active project
- [ ] FE-10 | low | open | 05-frontend-flows.md | Mock `rejectRequest` skips the status guard the real API enforces
- [ ] FE-11 | low | open | 05-frontend-flows.md | `WINDOW_EXPIRED` is missing from both status-filter vocabularies
- [ ] FE-12 | low | open | 05-frontend-flows.md | After a partial approval, the queue keeps a card the server's pending scope would drop
- [ ] FE-13 | low | open | 05-frontend-flows.md | RequestDetail sub-panels hold un-keyed local state across request-id navigation
- [ ] FE-14 | low | open | 05-frontend-flows.md | DriftPage's post-trigger refetches bypass the staleness guard
- [ ] FE-15 | low | open | 05-frontend-flows.md | Notifications bell and CommandPalette swallow rejections silently

## 06-frontend-ui-robustness.md

- [ ] UI-1 | high | open | 06-frontend-ui-robustness.md | Non-admin data pages have no fetch-error path: any API failure leaves a permanent "Loading…" with no message or retry
- [ ] UI-2 | high | open | 06-frontend-ui-robustness.md | Resource drill-in dead-ends for every "named service" whose slug is not a literal manifest file: all 16 azure-fixture services are broken
- [ ] UI-3 | high | open | 06-frontend-ui-robustness.md | Primary/admin navigation is built from unscoped absolute paths: current-page indication (aria-current + active styling) never renders, and every nav click detours through a full unmount/redirect
- [ ] UI-4 | medium | open | 06-frontend-ui-robustness.md | Mutation handlers `await` API calls without try/catch: a network failure permanently wedges busy/submitting state
- [ ] UI-5 | medium | open | 06-frontend-ui-robustness.md | RepeatedBlockField renders duplicate DOM ids and a shared radio-group `name` across instances
- [ ] UI-6 | medium | open | 06-frontend-ui-robustness.md | Hand-rolled drift drawers are dialogs in name only: no aria-modal, no focus move, no focus trap, no Escape
- [ ] UI-7 | medium | open | 06-frontend-ui-robustness.md | ErrorSummary links are dead anchors for radio-group and repeated-block fields
- [ ] UI-8 | medium | open | 06-frontend-ui-robustness.md | DiffView corrupts `~` change lines whose old value contains " -> "
- [ ] UI-9 | medium | open | 06-frontend-ui-robustness.md | `/login`, `/onboarding`, and the LegacyRedirect route have no errorElement: a render error there shows React Router's raw default error screen
- [ ] UI-10 | low | open | 06-frontend-ui-robustness.md | Request-status copy has four competing sources; raw enum text can reach the UI
- [ ] UI-11 | low | open | 06-frontend-ui-robustness.md | Nested repeated blocks skip their instance-count bounds
- [ ] UI-12 | low | open | 06-frontend-ui-robustness.md | Configure ⇄ Review step transitions never move focus, and the Suspense skeleton is silent for assistive tech
- [ ] UI-13 | low | open | 06-frontend-ui-robustness.md | RepeatedBlockField keys instances and touched-state by array index: state misattributes after a mid-list removal
- [ ] UI-14 | low | open | 06-frontend-ui-robustness.md | InventoryPicker: an optional single-select can never be cleared
- [ ] UI-15 | low | open | 06-frontend-ui-robustness.md | CommandPalette data is fetched once per shell mount, so "My requests" rows go stale within a session

## 07-catalogctl.md

- [ ] CTL-1 | high | open | 07-catalogctl.md | Full-line comment above a map entry corrupts every literal-map edit (duplicate keys, defeated KEY_CONFLICT guard, silent no-op removes) — exit 0
- [ ] CTL-2 | medium | open | 07-catalogctl.md | `moved_block` writes invalid or duplicate-resource HCL at exit 0: no identifier validation, no destination-collision check, no dangling-reference handling
- [ ] CTL-3 | medium | open | 07-catalogctl.md | Shipped catalog op `waf-add-ip-set-entry` can never execute (exit 1 internal error); the corrected manifest exists only in test fixtures
- [ ] CTL-4 | medium | open | 07-catalogctl.md | plan-check R1 structurally vetoes every legitimate plan for a `local.`-targeted foreach op
- [ ] CTL-5 | medium | open | 07-catalogctl.md | `drift-edit` writes are neither atomic nor transactional: a mid-batch refusal leaves earlier edits in the checkout
- [ ] CTL-6 | medium | open | 07-catalogctl.md | `danglingRef` substring scan falsely refuses removal when another resource's name extends the target's name
- [ ] CTL-11 | medium | open | 07-catalogctl.md | Golden coverage runs against forked fixture manifests, not the shipped catalog; comment-bearing fixtures are absent
- [ ] CTL-7 | low | open | 07-catalogctl.md | plancheck's `inventoryAddr` does not skip `role:"reference"` inventory params, diverging from the executor's `targetAddress`
- [ ] CTL-8 | low | open | 07-catalogctl.md | `atomicWrite` silently changes edited-file permissions to 0600 and skips fsync
- [ ] CTL-9 | low | open | 07-catalogctl.md | `pr-prepare`'s UNAPPROVED gate accepts any non-empty approvals list without checking `decision`
- [ ] CTL-10 | low | open | 07-catalogctl.md | Duplicated literal-object token-walkers (edit vs driftpropose) have already diverged in behavior

## 08-importer-schemadump.md

- [ ] IMP-1 | high | open | 08-importer-schemadump.md | `importer/kit/normalize.py` `split`/`guard` crash under the repo-pinned python-hcl2 (KeyError, not a refusal)
- [ ] IMP-2 | high | open | 08-importer-schemadump.md | `scripts/drift/sweep-ignore.json` is missing: the statediff sweep refuses out of the box
- [ ] IMP-3 | high | open | 08-importer-schemadump.md | No CI executes any importer test suite; two shipped regressions prove the gap
- [ ] IMP-4 | high | open | 08-importer-schemadump.md | Azure capability ledger family classification is systematically wrong: multi-token `familyMap` keys are unreachable
- [ ] IMP-5 | medium | open | 08-importer-schemadump.md | kit-azure `discover.sh` never clears stale page files: a re-run can resurrect deleted resources into the manifest
- [ ] IMP-6 | medium | open | 08-importer-schemadump.md | statediff's managed-set match assumes Terraform state `id` equals the discovery id; false-positive findings for id-divergent types (concrete: `aws_volume_attachment`)
- [x] IMP-7 | medium | fixed:661d247 moved both Azure pins to 4.81.0; recurrence guard still missing (see report note) | 08-importer-schemadump.md | Azure template provider pin (4.14.0) contradicts the committed azurerm schemadump tag (v4.81.0) it claims to bind to
- [ ] IMP-8 | medium | open | 08-importer-schemadump.md | Committed schemadump artifacts are not reproducible via the documented `gen.sh` pipeline; generated-catalog staleness detection is entirely manual
- [ ] IMP-9 | low | open | 08-importer-schemadump.md | Azure `discover.py list-subscriptions` crashes on a bare-list capture at the truncation-warning check
- [ ] IMP-10 | low | open | 08-importer-schemadump.md | `gen-imports.py --id-region-suffix` appends `@region` to global-service ids too
- [ ] IMP-11 | low | open | 08-importer-schemadump.md | `payloads.py` block scanner: a column-0 `}` inside a heredoc body truncates the skeleton and ships it
- [ ] IMP-12 | low | open | 08-importer-schemadump.md | `normalize.py split` silently drops non-`resource` top-level blocks
- [ ] IMP-13 | low | open | 08-importer-schemadump.md | Shell scripts: minor robustness gaps around the deliberate no-`set -e` style
- [ ] IMP-14 | low | open | 08-importer-schemadump.md | Stale numbers and dangling references in kit/schemadump docs and comments
- [ ] IMP-15 | low | open | 08-importer-schemadump.md | Coverage-sweep family granularity marks undiscoverable resources as "covered" (documented, but with a concrete silent case)

## 09-error-handling.md

- [ ] ERR-1 | high | open | 09-error-handling.md | Synchronous child processes block the entire API event loop for minutes
- [ ] ERR-2 | high | open | 09-error-handling.md | A crash or late write failure strands `bundle.state='running'` forever; no recovery path exists
- [ ] ERR-3 | high | open | 09-error-handling.md | Scan jobs stuck in non-terminal states are unrecoverable and block all future scans for the project
- [ ] ERR-4 | high | open | 09-error-handling.md | A crashed apply worker strands a request in `APPLYING` forever, silently
- [ ] ERR-5 | medium | open | 09-error-handling.md | `TerraformExecutor.init()` caches a rejected promise: one transient init failure bricks the executor until restart
- [ ] ERR-6 | medium | open | 09-error-handling.md | `executor.replan()` failures are an unmodeled halt: unbounded silent retry, and they abort the rest of the project's due list
- [ ] ERR-7 | medium | open | 09-error-handling.md | Unexpected errors become `{code:'INTERNAL'}` 500 with zero server-side logging
- [ ] ERR-8 | medium | open | 09-error-handling.md | No process-level failure handling: no graceful shutdown, no rejection/exception handlers, npm-as-PID-1
- [ ] ERR-9 | medium | open | 09-error-handling.md | GitHub App credential fetches have no timeout, and any failure terminally fails the scan job with no retry
- [ ] ERR-10 | medium | open | 09-error-handling.md | FileStore persist failure leaves memory ahead of disk: the client gets a 500 for a write that took effect
- [ ] ERR-11 | medium | open | 09-error-handling.md | The bundle idempotency claim guards on `status`, not `bundle.state`: concurrent applies can both run
- [ ] ERR-12 | medium | open | 09-error-handling.md | Trigger failure after a landed commit: honest-but-dead-end half state, and spawn timeouts are indistinguishable from exit-1
- [ ] ERR-13 | low | open | 09-error-handling.md | `prepare()` leaks the cloned workspace when `rev-parse` fails
- [ ] ERR-14 | low | open | 09-error-handling.md | Drift-upload compensation is non-transactional best-effort
- [ ] ERR-15 | low | open | 09-error-handling.md | Scan worker: a failed progress report abandons the job without a terminal status; a claim non-2xx is process-fatal with no backoff
- [ ] ERR-16 | low | open | 09-error-handling.md | The ccp-data CI lane goes green when the control plane is unreachable

## 10-reliability-operations.md

- [ ] OPS-1 | critical | open | 10-reliability-operations.md | Fresh-install bootstrap deadlock: boot-time settlement creates the store file, then `CCP_BOOTSTRAP=1` is refused
- [ ] OPS-2 | high | open | 10-reliability-operations.md | Unhandled errors become 500 `INTERNAL` with zero server-side logging
- [ ] OPS-3 | high | open | 10-reliability-operations.md | Armed-lane commands run `spawnSync` on the event loop: the whole API freezes for up to 15 minutes and health checks flap
- [ ] OPS-4 | high | open | 10-reliability-operations.md | A scan job whose worker dies stays `claimed`/`cloning`/`scanning` forever and permanently wedges that project's onboarding
- [ ] OPS-5 | high | open | 10-reliability-operations.md | `migrate-data.sh`'s post-cutover byte-identical check is tripped by the new code's own boot writes: legacy migrations auto-roll back
- [ ] OPS-6 | medium | open | 10-reliability-operations.md | Plain `compose up` (including every self-update cycle) silently strips the armed overlay
- [ ] OPS-7 | medium | open | 10-reliability-operations.md | No HTTP request logging and no request IDs anywhere in the api
- [ ] OPS-8 | medium | open | 10-reliability-operations.md | No graceful shutdown: `npm` as PID 1, no SIGTERM handling, default 10 s grace on the api
- [ ] OPS-9 | medium | open | 10-reliability-operations.md | The documented CI-runner cutover only routes 2 of 8 workflows
- [ ] OPS-10 | medium | open | 10-reliability-operations.md | No log rotation and no resource limits on any service
- [ ] OPS-11 | medium | open | 10-reliability-operations.md | `/readyz` re-verifies every audit chain on every probe; cost grows unboundedly with history
- [ ] OPS-12 | low | open | 10-reliability-operations.md | Scanner service: no healthcheck, and the worker exits on any control-plane error
- [ ] OPS-13 | low | open | 10-reliability-operations.md | `doctor.sh` reports an unhealthy container as OK
- [ ] OPS-14 | low | open | 10-reliability-operations.md | Stale references to a nonexistent `.github/workflows/terraform.yml` anchor the Terraform pin
- [ ] OPS-15 | low | open | 10-reliability-operations.md | GitHub App key directory is not prepared or checked by any tooling

## 11-performance-scalability.md

- [ ] PERF-1 | critical | open | 11-performance-scalability.md | Every authenticated request rewrites the entire database to disk (session-slide write × full-store snapshot)
- [ ] PERF-2 | high | open | 11-performance-scalability.md | `spawnSync` on the serving thread: the API freezes for up to 10-15 minutes during bundle/drift work
- [ ] PERF-3 | high | open | 11-performance-scalability.md | `GET /requests` has no pagination and ships full rows (events, params, plan summaries, pinned plan text), with an O(n) write-capable settle loop per call
- [ ] PERF-4 | high | open | 11-performance-scalability.md | `/readyz` re-verifies every audit chain hash on every probe: O(total audit entries) CPU per health check
- [ ] PERF-5 | high | open | 11-performance-scalability.md | Frontend main bundle is 3.76 MB (663 KB gzip) with all 115 manifest JSONs inlined and zod-parsed at module init
- [ ] PERF-6 | medium | open | 11-performance-scalability.md | API mode re-downloads and re-parses the full inventory + manifest set on every route mount; the serve endpoints send no caching headers
- [ ] PERF-7 | medium | open | 11-performance-scalability.md | Nothing in the store is ever purged: sessions, idempotency markers, and the audit chain grow forever (and every byte is re-serialized per request)
- [ ] PERF-8 | medium | open | 11-performance-scalability.md | Admin audit "pagination" materializes and re-sorts the whole chain per page; cursor lookup is a linear scan
- [ ] PERF-9 | medium | open | 11-performance-scalability.md | `ServiceConsole` loads the entire block-source corpus on every service page mount, fetching server chunks sequentially
- [ ] PERF-10 | medium | open | 11-performance-scalability.md | Submit-path full scans: rate-limit check and feasibility each re-scan whole collections per submission
- [ ] PERF-11 | medium | open | 11-performance-scalability.md | Per-project audit chain head serializes all writes and surfaces contention as user-facing 409s after one retry
- [ ] PERF-12 | medium | open | 11-performance-scalability.md | Upload ingest does 4+ full canonical-JSON passes over the 16 MiB bundle synchronously on the event loop
- [ ] PERF-13 | low | open | 11-performance-scalability.md | SchemaForm recomputes inventory-derived enums for every field on every keystroke
- [ ] PERF-14 | low | open | 11-performance-scalability.md | Scheduler tick re-scans every project's full request collection every minute
- [ ] PERF-15 | low | open | 11-performance-scalability.md | Request-history views render unbounded lists without windowing

## 12-testing-quality.md

- [ ] TEST-1 | high | open | 12-testing-quality.md | `importer/kit` test suite is red at HEAD: 7 of 106 tests fail
- [ ] TEST-2 | high | open | 12-testing-quality.md | No CI lane executes any Python test suite; `gate.sh` omits them too
- [ ] TEST-4 | high | open | 12-testing-quality.md | The highest-value integration tests skip silently when a toolchain is missing, and nothing asserts they ran in CI
- [ ] TEST-3 | medium | open | 12-testing-quality.md | `ccp/app/scripts/test_build_inventory.py` fails at HEAD (stale fixture premise)
- [ ] TEST-5 | medium | open | 12-testing-quality.md | No code-coverage measurement anywhere; `coverage.test.ts` is not code coverage
- [ ] TEST-6 | medium | open | 12-testing-quality.md | No route-level concurrency/race tests; store-level concurrency only
- [ ] TEST-7 | medium | open | 12-testing-quality.md | The SPA has no DOM/interaction testing; ~25 test files pin UI by source-string inspection
- [ ] TEST-8 | medium | open | 12-testing-quality.md | Golden-tree comparison is one-directional: extra files created by an edit go unnoticed
- [ ] TEST-9 | low | open | 12-testing-quality.md | Sleep-based synchronization in async API tests (flake and false-pass risk)
- [ ] TEST-10 | low | open | 12-testing-quality.md | Functional test plan drift: stale counts, loose citations, and "new" rows with no tracking
- [ ] TEST-11 | low | open | 12-testing-quality.md | OpenAPI contract test is substring matching, not conformance
- [ ] TEST-12 | low | open | 12-testing-quality.md | One test file consumes ~60% of the api suite wall time by rebuilding catalogctl per run

## 13-ci-cd.md

- [ ] CI-1 | high | open | 13-ci-cd.md | Two components' test suites run in no CI at all, and one of them is currently failing
- [ ] CI-2 | high | open | 13-ci-cd.md | PG-9 (gitleaks) is a silent no-op in CI: the pinned v8.18.4 has no `dir` subcommand, and the script converts the resulting error into PASS
- [ ] CI-3 | high | open | 13-ci-cd.md | Path filters skip validation for cross-component dependencies: app-lib, catalogctl parity, the canonical redaction rules, and the gate scripts themselves
- [ ] CI-4 | high | open | 13-ci-cd.md | The product's core "CI applies" pipeline is not shipped: nothing invokes plancheck-gate.sh or apply-window-gate.sh, and docs/scripts reference a workflow that no longer exists
- [ ] CI-5 | medium | open | 13-ci-cd.md | Whether the api's live parity/integration suites run in CI depends on unpinned runner-preinstalled toolchains; nothing asserts they ran
- [ ] CI-6 | medium | open | 13-ci-cd.md | release-images publishes on any tag with no quality gate, mutable version stamping, and an unconditional `latest`
- [ ] CI-7 | medium | open | 13-ci-cd.md | The Docker build path (the documented production install) is never exercised by CI; images are first built at release time
- [ ] CI-8 | medium | open | 13-ci-cd.md | PG-5's secret heuristic misses the most common real-world shapes, and its designated backstop is dead in CI
- [ ] CI-9 | medium | open | 13-ci-cd.md | The recurring data lane keeps the silent-skip gate its own sibling workflow documents as a trap
- [ ] CI-10 | low | open | 13-ci-cd.md | Push-trigger path filters omit the workflow file itself on ccp-api and ccp-smoke
- [ ] CI-11 | low | open | 13-ci-cd.md | Stale toolchain claims: gate.sh advertises checks CI does not run
- [ ] CI-12 | low | open | 13-ci-cd.md | Inconsistent action pinning, with a comment that contradicts the file it sits in; setup-go caching is configured to a nonexistent root go.sum
- [ ] CI-13 | low | open | 13-ci-cd.md | The smoke proves boot + serve, not the system's function; PR runs of it are triggered by any `ccp/**` docs change

## 14-contracts-docs.md

- [ ] DOC-1 | high | open | 14-contracts-docs.md | OpenAPI declares two `/catalog/*` endpoints that do not exist — and the parity test pins the phantoms
- [ ] DOC-2 | high | open | 14-contracts-docs.md | Shipped routes absent from the OpenAPI spec; `POST /requests/:id/apply` is documented nowhere at all
- [ ] DOC-3 | medium | open | 14-contracts-docs.md | OpenAPI `servers: [{url: /v2}]` does not match any deployed base path
- [ ] DOC-4 | medium | open | 14-contracts-docs.md | Multiple docs and a code header cite `ccp/docs/specs/ccp-api.md`, which does not exist in this repo
- [ ] DOC-5 | medium | open | 14-contracts-docs.md | ~100 broken relative markdown links across the published tree
- [ ] DOC-6 | medium | open | 14-contracts-docs.md | API-SPEC.md states the opposite of current code on `PUT /projects/:id/identity` gating
- [ ] DOC-7 | medium | open | 14-contracts-docs.md | App `DriftProposal` type does not match the wire: `importPayload` has a different shape, and top-level `arn`/`tfType` are mock-only
- [ ] DOC-8 | medium | open | 14-contracts-docs.md | catalogctl README makes two explicit completeness claims that are false
- [ ] DOC-9 | medium | open | 14-contracts-docs.md | Four operator-facing env vars are undocumented (two of them documented nowhere at all)
- [ ] DOC-10 | medium | open | 14-contracts-docs.md | ERROR-STATES.md's "every error code the API can return" is missing 8 taxonomy codes and 6 inline literals
- [ ] DOC-11 | medium | open | 14-contracts-docs.md | OpenAPI types `ChangeRequest.planSummary` as a string; the API stores and serves a structured object
- [ ] DOC-12 | medium | open | 14-contracts-docs.md | DOMAIN-MODEL.md's entity catalog is missing a third of the store's item types
- [ ] DOC-13 | medium | open | 14-contracts-docs.md | Request-status vocabulary is three-way inconsistent (SPA union vs server writes vs YAML prose)
- [ ] DOC-14 | low | open | 14-contracts-docs.md | PERMISSIONS.md §9 cites a "§2 apply row" that does not exist
- [ ] DOC-15 | low | open | 14-contracts-docs.md | MAINTAINING-THE-CATALOG.md points at a generated-output directory that does not exist in the tree
- [ ] DOC-16 | low | open | 14-contracts-docs.md | Assorted OpenAPI request/response gaps against route behavior
- [ ] DOC-17 | low | open | 14-contracts-docs.md | The code-derived docs' line citations have drifted from HEAD
