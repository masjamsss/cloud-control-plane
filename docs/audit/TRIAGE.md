# Triage — which model should take which finding, and what "done" looks like

**139 findings open** (0 critical, 0 high, 72 medium, 67 low) as of the head of
`claude/cloud-control-plane-audit-v516ug`. This file exists so the remaining work can be
split across sessions or accounts without two of them landing in the same file.

Three things per finding: a **batch id** (the unit you hand to someone), a **model**, and
an **expected result** — what has to be true for the finding to close, written so it can be
checked rather than interpreted.

> Batch ids are stable. If you take `B-O4`, say so; nothing else in that batch should be
> picked up in parallel, because the findings in a batch touch the same files on purpose.

## How the model was chosen

This is not a difficulty ranking. It is about **what happens when the fix is wrong**.

Route to **Opus** when any one of these holds:

1. **The finding's own recommendation is likely wrong or incomplete.** This happened
   repeatedly in the work already done — DATA-3's suggested rollback would have inverted
   the divergence, ARCH-1's premise that status signals quorum can never hold, OPS-5's
   check was right at the wrong moment. Each needed the recommendation rejected in writing.
2. **The fix crosses a seam** — two components, a shared contract, or a credential
   boundary. ARCH-2 looked like a lookup change and turned out to be about *how the lane
   authenticates*, because a registered repo reference is read-only by construction while
   the lane pushes.
3. **A new invariant, lease or guard has to be designed**, rather than an existing one
   applied.
4. **A wrong fix fails silently** — concurrency, the audit chain, authz, retention.
5. **The finding is really two findings**, or its scope is contested.

Route to **Sonnet** when *all* of these hold: the change is well-scoped and the
recommendation is unambiguous; **the pattern already exists somewhere in this repo to
copy**; the test is local and obvious; and a wrong fix fails loudly, in typecheck or CI.

The "pattern already exists" clause is doing most of the work. Several findings moved from
Opus to Sonnet purely because earlier fixes left a worked example — REM-2 is mechanical now
that API-10 has converted the idle slide, PERF-9 is mechanical now that PERF-5 has done the
lazy-glob, and the whole of `B-S7` follows a settle-on-read lease used four times already.

## Split

| model | batches | findings |
| --- | ---: | ---: |
| **Opus** | 13 | **64** |
| **Sonnet** | 9 | **75** |

Roughly 54% Sonnet. The Sonnet half is not the unimportant half — it contains every
front-end correctness bug and all the documentation-accuracy work. It is the half where
being wrong is *visible*.

## Rules that apply to every batch, whichever model runs it

These are not style preferences; each one was learned by getting it wrong here.

- **A regression test must fail against the unfixed code.** Run it against the original and
  watch it fail. Three of the fixes already shipped had bugs *in the test* that only the
  negative run exposed — one check matched the prose of the very fix it protected, so
  deleting the real guard changed nothing.
- **Assert the setup fired.** A race test that never raced, a scan that found no files, a
  fixture whose GSI key was hand-typed and therefore never matched — all of these pass for
  the wrong reason. Pin the precondition (`L-1`).
- **Write the rule, not the list** (`L-25`). A check that enumerates today's offenders does
  not catch tomorrow's.
- **Anything the fix deliberately leaves behind goes in [`RESIDUE.md`](RESIDUE.md)**, with a
  state. The gate enforces this, and it has caught a missing entry on nearly every batch.
- **If the finding's recommendation is wrong, say so in the fix entry and do the right
  thing instead.** A partial fix stays `open` with the residue described, rather than being
  rounded up.
- Read [`LESSONS.md`](LESSONS.md) before starting a batch. `L-1`, `L-25`, `L-26` and `L-27`
  apply broadly.

## Verify before you fix

Ten of these findings predate fixes that may already have closed them. **`B-S1` is entirely
verify-and-close**, and several other batches flag individual entries the same way. Re-fixing
something already fixed is the most expensive way to spend a session here — check the code
at HEAD first, and if it is closed, close it with evidence rather than a patch.


---

# Opus batches


## B-O1 — Bundle / apply-lane state machine


**Model:** opus · **Findings:** 4 · **Touches:** `ccp/api/src/routes/requests.ts, ccp/api/src/domain/bundle.ts`


| finding | sev | expected result |
| --- | --- | --- |
| **CONC-6** | medium | A throwing `runBundle` reaches a terminal `bundle` state instead of leaving `running`; the outcome's AUDIT ENTRY lands even when the request row refuses the update (a cancel won), because a fired deploy is a fact and not a state transition; the caller gets a specific code, not CHAIN_CONTENTION with nothing written. |
| **API-5** | medium | A cancel committed during a bundle can no longer produce `CANCELLED` on a request whose change applied: either the cancel refuses while a live claim exists, or the timeline records both truthfully. Decide which, and say why in the fix entry. |
| **ERR-12** | medium | A trigger failure after a landed commit stops being a dead end: the request reaches a state with an exit, and a spawn TIMEOUT is distinguishable from `exit 1` in the recorded evidence. |
| **API-4** | medium | VERIFY, DO NOT RE-FIX. Both defects look closed already — ERR-11 made the claim guard `eventSeq` (which the claim advances), and ERR-2 added the lease + takeover. Confirm against the code, add a regression test if none pins it, then close with evidence. If any part survives, fix only that part. |


## B-O2 — Scheduler & executor semantics


**Model:** opus · **Findings:** 5 · **Touches:** `ccp/api/src/domain/apply/*`


| finding | sev | expected result |
| --- | --- | --- |
| **ERR-6** | medium | `executor.replan()` failure is a modelled outcome, not an unbounded silent retry, and one project's failure no longer aborts the rest of the due list. |
| **ERR-5** | medium | One transient `init()` failure no longer bricks the executor until restart — the rejected promise is not cached, and a retry can succeed. |
| **CONC-10** | medium | VERIFY FIRST: API-2's `APPLY_LEASE_MS` + halt-on-expiry, plus cancel accepting the halt statuses, may already close this. Confirm the operator path end to end; close with evidence, or fix only the remaining gap. |
| **PERF-14** | low | The tick stops re-scanning every project's full request collection every minute. Needs an index or a due-set the write path maintains — a design decision, not a loop tweak. |
| **API-8** | medium | A freeze-held `kind:'now'` request has a defined path once the freeze lifts, instead of dead-ending in AWAITING_DEPLOY_APPROVAL. |


## B-O3 — Store seam & snapshot semantics


**Model:** opus · **Findings:** 6 · **Touches:** `ccp/api/src/store/*`


| finding | sev | expected result |
| --- | --- | --- |
| **DATA-5** | medium | Corrupt-but-parseable rows stop loading silently. WARNING: the wrong shim fails a BOOT, not a test (see R-41) — design the legacy-passthrough against real stored shapes, and make refusing loud and specific about which row. |
| **DATA-15** | low | Client-controlled bytes can no longer reach a PK unconstrained, and the space-separated map key is no longer aliasable in principle. Security-relevant; assume an adversarial id. |
| **DATA-16** | low | The snapshot carries a format/version marker, so a future migration does not rest on convention. Must stay readable by the current loader. |
| **API-17** | low | Each named seam divergence from DynamoDB is either fixed or documented as deliberate with the reason. A seam that quietly differs makes every local test a lie about production. |
| **DATA-14** | low | As API-17 — batch them; they are the same list from two reports. |
| **CONC-8** | medium | Snapshot serialization stops being synchronous O(store) on the event loop. PR #6 coalesced the WRITES; the serialize step itself still blocks. Note R-32: sequential write latency is still O(store size). |


## B-O4 — Audit chain: scale, contention, retention


**Model:** opus · **Findings:** 3 · **Touches:** `ccp/api/src/domain/audit.ts, routes/audit`


| finding | sev | expected result |
| --- | --- | --- |
| **PERF-11** | medium | Chain-head contention stops surfacing as user-facing 409s after one retry. The chain is the product's evidence store — a fix that drops entries under load is worse than the 409. |
| **PERF-7** | medium | A retention story exists for sessions, idempotency markers and the chain. RETENTION OF AN AUDIT CHAIN IS A PRODUCT DECISION, not a cleanup task — state the policy explicitly and get it agreed before implementing. |
| **PERF-8** | medium | Admin audit paging stops materializing and re-sorting the whole chain per page, and the cursor lookup stops being a linear scan. Same family as PERF-3 (done) — reuse its cursor semantics. |


## B-O5 — Shared-contract layer & the two domain implementations


**Model:** opus · **Findings:** 4 · **Touches:** `ccp/shared (new), ccp/api, ccp/app`


| finding | sev | expected result |
| --- | --- | --- |
| **ARCH-6** | medium | A real shared package replaces the `@app-lib` path alias + hand-synced `planSummary` copy, installed by both CI jobs. HAZARD: a zod VALUE import through the alias silently collapses the api's types to `unknown` in CI — that is why the copy exists. Until the package lands, an allowlist lint + a copy-parity test is the acceptable partial. |
| **ARCH-8** | medium | The mock's surface shrinks toward 'the http client over an in-browser toy store', and the mock-vs-api behavioural gaps are enumerated in ONE table instead of scattered comments. Note ARCH-7 already moved the status vocabulary into the shared seam — follow that shape. |
| **ARCH-5** | medium | Submit-time operation resolution stops disagreeing with what the SPA renders. Decide which catalog is authoritative per project and write it into DOMAIN-MODEL; a digest pin at submit is the alternative. |
| **DOC-7** | medium | The app's `DriftProposal` type matches the wire. Decide which side is authoritative for `importPayload` and the mock-only `arn`/`tfType` before changing either. |


## B-O6 — Process lifecycle, container and operator surface


**Model:** opus · **Findings:** 4 · **Touches:** `ccp/api/src/server.ts, Dockerfile, docker-compose*.yml`


| finding | sev | expected result |
| --- | --- | --- |
| **ERR-8** | medium | The api is not `npm` as PID 1; SIGTERM is handled; rejection/exception handlers exist and do the right thing. PARTIAL ALREADY: OPS-2 installed handlers and CONC-7 added SIGTERM/SIGINT lock release — build on those, and note R-16 (neither process error handler exits). |
| **OPS-8** | medium | As ERR-8 — the same defect from the ops report. Fix once, close both. |
| **OPS-6** | medium | A plain `compose up` can no longer silently strip the armed overlay, including on every self-update cycle. The fix shape is contested: refuse, warn, or make arming sticky — pick one and justify it. |
| **OPS-7** | medium | Request logging and request IDs exist. IN A GOVERNANCE PRODUCT THIS IS A PRIVACY SURFACE: decide what must never be logged (params, plan text, tokens) before adding the logger, and reuse `redact.ts`. |


## B-O7 — Multi-tenant data lifecycle & identity


**Model:** opus · **Findings:** 6 · **Touches:** `ccp/api/src/routes/projects.ts, projectData.ts, ccp/app/src/lib/apiSession.ts`


| finding | sev | expected result |
| --- | --- | --- |
| **API-9** | medium | Deregistration no longer leaves orphaned satellite rows, and a reused project id cannot inherit the previous tenant's state. Treat as a cross-tenant data-leak class, not a cleanup task. |
| **DATA-11** | medium | The v1 migration stops writing schema-violating rows; the `id` != `username` shape that breaks session resolution is corrected, with a path for rows already written. |
| **FE-9** | medium | Role resolution never falls back to another scope's role when the user has no binding on the active project. Fail closed — this is an authz fail-open. |
| **DATA-12** | low | A crash between the version-row transact and the file write can no longer leave an activatable orphan row. |
| **API-15** | low | A dangling idempotency marker no longer makes its key permanently unusable. |
| **API-18** | low | The legitimize endpoint stops minting unlimited duplicate engineer requests for one digest. |


## B-O8 — CI trust: can the gates actually fail?


**Model:** opus · **Findings:** 8 · **Touches:** `scripts/, .github/workflows/`


| finding | sev | expected result |
| --- | --- | --- |
| **CI-8** | medium | PG-5 catches the common real-world secret shapes, and its designated backstop actually runs in CI. THE CLASS: a check that cannot run must be indistinguishable from nothing, never from a pass (this session hit exactly that — PG-9 skipped locally with no gitleaks and a token-shaped literal reached CI). |
| **CI-5** | medium | Whether the live parity/integration suites ran is asserted, not inferred from an unpinned preinstalled toolchain. `CCP_REQUIRE_INTEGRATION=1` (TEST-4) is the established shape — extend it. |
| **CI-13** | low | The smoke asserts the system's function, not just boot+serve, and stops being triggered by any `ccp/**` docs change. What it should assert is the design question. |
| **CI-9** | medium | The recurring data lane stops keeping the silent-skip gate its own sibling workflow documents as a trap. |
| **CI-6** | medium | release-images gets a quality gate, immutable version stamping, and a conditional `latest`. Release safety — a wrong fix ships a bad image under a good tag. |
| **ARCH-14** | low | The OpenAPI parity test becomes real conformance, not string containment. Designing what conformance means here is the work. |
| **TEST-11** | low | As ARCH-14 — same defect, two reports. Fix once. |
| **TEST-5** | medium | Code coverage is measured. The thresholds and what they gate are a policy call; `coverage.test.ts` is not code coverage and should be renamed so the next reader is not misled. |


## B-O9 — catalogctl gate semantics (Go)


**Model:** opus · **Findings:** 6 · **Touches:** `tools/catalogctl/`


| finding | sev | expected result |
| --- | --- | --- |
| **CTL-4** | medium | plan-check R1 stops structurally vetoing every legitimate plan for a `local.`-targeted foreach op. WARNING: this is a SAFETY GATE — a loosening that is too broad is a silent security regression, so pin the newly-accepted shapes with fixtures. |
| **CTL-2** | medium | `moved_block` no longer writes invalid or duplicate-resource HCL at exit 0: identifiers are validated, destination collisions are refused, dangling references are handled. |
| **CTL-10** | low | The two literal-object token-walkers (edit vs driftpropose) stop diverging. They ALREADY have — reconciling means deciding which behaviour is correct, not merging the code. |
| **CTL-11** | medium | Golden coverage runs against the SHIPPED catalog, not forked fixture manifests, and comment-bearing fixtures exist. This is the can-it-fail class (L-1). |
| **CTL-3** | medium | `waf-add-ip-set-entry` executes, and the corrected manifest lives in the shipped catalog rather than only in test fixtures. Batch with CTL-11 — same root cause. |
| **CTL-9** | low | `pr-prepare`'s UNAPPROVED gate checks `decision`, not merely a non-empty approvals list. Security gate. |


## B-O10 — Importer / schemadump correctness


**Model:** opus · **Findings:** 3 · **Touches:** `importer/, tools/schemadump/`


| finding | sev | expected result |
| --- | --- | --- |
| **IMP-6** | medium | statediff stops assuming Terraform state `id` equals the discovery id, so id-divergent types (e.g. `aws_volume_attachment`) stop producing false-positive findings. |
| **IMP-8** | medium | Committed schemadump artifacts are reproducible via the documented `gen.sh`, and staleness detection is mechanical rather than manual. NOTE: IMP-4 (done) added a self-check that REFUSES TO WRITE on anchor mismatch — extend that discipline, and read its lesson about a field-name typo producing a uniform zero. |
| **IMP-15** | low | Coverage-sweep family granularity stops marking undiscoverable resources as covered. IMP-4's family matcher is the adjacent code and was subtle — read it first. |


## B-O11 — Submit-path and ingest performance


**Model:** opus · **Findings:** 2 · **Touches:** `ccp/api/src/middleware/rateLimit.ts, domain/feasibility.ts, routes/projectData.ts`


| finding | sev | expected result |
| --- | --- | --- |
| **PERF-10** | medium | The submit path stops re-scanning whole collections per submission for the rate-limit and feasibility checks. Needs an index or a maintained counter — and NOTE the counter must stay correct under the concurrency CONC-12 describes. |
| **PERF-12** | medium | Upload ingest stops doing 4+ full canonical-JSON passes over a 16 MiB bundle synchronously on the event loop. |


## B-O12 — Concurrency long tail


**Model:** opus · **Findings:** 5 · **Touches:** `ccp/api/src/domain/audit.ts, middleware/rateLimit.ts, domain/settlement.ts`


| finding | sev | expected result |
| --- | --- | --- |
| **CONC-15** | low | `transactWithAudit` stops conflating a caller's domain guard failure with chain contention. NOTE: this session's CONC-9 fix leans on the current behaviour (a guarded write is refused rather than replayed) — do not break that property while separating the error paths. |
| **API-14** | low | As CONC-15 — the same defect from the API report. Fix once, close both. |
| **CONC-12** | low | The store-backed submit rate limiter stops being check-then-insert, so concurrent submits cannot breach both caps. |
| **CONC-13** | low | Concurrent first-boot settlement stops escaping its own race handling and 500ing early requests. |
| **TEST-6** | medium | Route-level concurrency/race tests exist. THE PATTERN IS NOW IN THE REPO: `test/sessionRevokeRace.test.ts` and `test/pendingChangeCas.test.ts` use a store wrapper that commits a competing write between the read and the write. Choosing WHICH races to pin is the judgment. |


## B-O13 — Architecture & front-end authority


**Model:** opus · **Findings:** 8 · **Touches:** `ccp/app/src/lib/, ccp/api/src/domain/`


| finding | sev | expected result |
| --- | --- | --- |
| **ARCH-9** | medium | The single-process in-process singletons stop being ones the planned DynamoDB path would silently break. Name each one and say what it becomes. |
| **ARCH-11** | low | Arming-flag sprawl gets whole-config validation, so a half-armed deployment is refused at boot rather than discovered at the first click. |
| **FE-6** | medium | Api-mode submit gates read the SERVER's settings, not advisory localStorage. Two bugs to close: the dead freeze preview, and a stale local freeze silently blocking submits. |
| **TEST-7** | medium | The SPA gets interaction testing, OR a written decision that it will not. NOTE R-22: this repo has NO jsdom and `test/standalone.test.ts` enforces a dependency allowlist — 'add jsdom' is a real architectural change, not a dependency bump. |
| **ERR-9** | medium | GitHub App credential fetches have a timeout, and a transient failure stops terminally failing the scan job with no retry. |
| **ERR-14** | low | Drift-upload compensation stops being non-transactional best-effort, or its limits are stated and bounded. |
| **DATA-10** | medium | Backup/restore covers the on-disk project-data/drift root it references, with a consistency check. NOTE: CONC-7/DATA-9 (done) added a writer lock that restore now takes — build on it. |
| **CTL-5** | medium | `drift-edit` writes become atomic/transactional: a mid-batch refusal leaves NO earlier edits in the checkout. |


---

# Sonnet batches


## B-S1 — Verify-and-close: likely already fixed


**Model:** sonnet · **Findings:** 5 · **Touches:** `docs/audit/ (plus targeted checks)`


| finding | sev | expected result |
| --- | --- | --- |
| **API-13** | low | VERIFY ONLY. ARCH-7 (this session) replaced the hand-maintained `OPEN_STATUSES` with a derived not-terminal rule, which should close both halves ('counts a nonexistent status' and 'misses real open states'). Confirm against `middleware/rateLimit.ts` + `@app-lib/requestStatus`, then close with evidence. Do NOT re-implement. |
| **ERR-7** | medium | VERIFY ONLY. OPS-2 added server-side logging for unexpected errors. Confirm every 500 path logs, then close — or fix only the paths that do not. |
| **OPS-11** | medium | VERIFY ONLY. PERF-4 made `/readyz` verify incrementally (253ms -> 1.05ms). Confirm, then close. NOTE R-34: the memo is deliberately NOT a tamper-detector, and that stays true. |
| **DATA-6** | medium | VERIFY ONLY. ERR-10 added `syncDir` after the rename in `fileStore.ts`. Confirm it covers every atomic-write site (`store/snapshot.ts` too), then close or extend. |
| **DATA-13** | low | VERIFY, THEN EXTEND. ERR-10 fixed the temp-file leak in `fileStore.writeAtomic`. Check the OTHER atomic-write sites for the same shape and fix any that leak. |


## B-S2 — Status vocabulary follow-through


**Model:** sonnet · **Findings:** 3 · **Touches:** `ccp/app/src/lib/requestStatus.ts and its consumers`


| finding | sev | expected result |
| --- | --- | --- |
| **DOC-13** | medium | The YAML prose, the SPA union and the server writes agree. DEPENDS ON ARCH-7 (done): the closed set now lives in `ccp/app/src/lib/requestStatus.ts` — point the docs at it and add a check that keeps them agreeing. |
| **FE-11** | low | `WINDOW_EXPIRED` appears in both status-filter vocabularies. Trivial now that the closed set exists. |
| **UI-10** | low | Status copy has ONE source. `StatusBadge`'s label map is the natural home; raw enum text must not reach the UI. |


## B-S3 — Documentation accuracy (with a check each)


**Model:** sonnet · **Findings:** 11 · **Touches:** `docs/, ccp/api/README.md, tools/catalogctl/README.md`


| finding | sev | expected result |
| --- | --- | --- |
| **DOC-10** | medium | ERROR-STATES.md lists every error code the API can return — all 8 missing taxonomy codes and 6 inline literals. ADD A GENERATED CHECK so it cannot drift again; a hand-updated list is the defect. |
| **DOC-12** | medium | DOMAIN-MODEL.md's entity catalog covers every store item type, with a check that fails when a new one is added. |
| **DOC-6** | medium | API-SPEC.md matches the code on `PUT /projects/:id/identity` gating. Read the route first; the code is authoritative. |
| **DOC-8** | medium | catalogctl README's two completeness claims are true, or removed. Same shape as ARCH-12 — batch them. |
| **DOC-9** | medium | All four operator-facing env vars are documented. NOTE: `CCP_GIT_PROJECT` and `CCP_DATA_LOCK_TAKEOVER` were added this session and ARE documented — check the finding's list against HEAD before writing. |
| **DOC-14** | low | PERMISSIONS.md no longer cites a '§2 apply row' that does not exist. |
| **DOC-16** | low | The listed OpenAPI request/response gaps against route behaviour are closed. |
| **DOC-17** | low | The code-derived docs' line citations match HEAD, with a checker so they stop drifting. |
| **ARCH-12** | low | catalogctl README's subcommand table is complete. Batch with DOC-8. |
| **ARCH-15** | low | The ADR ledger statuses match the built system. |
| **IMP-14** | low | Stale numbers and dangling references in kit/schemadump docs and comments are corrected. |


## B-S4 — OpenAPI / wire contract fixes


**Model:** sonnet · **Findings:** 2 · **Touches:** `openapi/ccp-api.yaml, ccp/api/src/store/planSummarySchema.ts`


| finding | sev | expected result |
| --- | --- | --- |
| **DOC-11** | medium | OpenAPI types `ChangeRequest.planSummary` as the structured object the API actually stores and serves. |
| **API-12** | low | `prNumberFromUrl` no longer extracts a 'PR number' from any URL ending in digits — it validates the shape. |


## B-S5 — Front-end component bugs


**Model:** sonnet · **Findings:** 16 · **Touches:** `ccp/app/src/components/, features/`


| finding | sev | expected result |
| --- | --- | --- |
| **UI-8** | medium | DiffView renders a `~` change line whose old value contains ' -> ' correctly. Pin it with the exact string from the finding. |
| **UI-5** | medium | RepeatedBlockField stops rendering duplicate DOM ids. |
| **UI-6** | medium | The drift drawers are real dialogs (focus trap, escape, aria), not dialogs in name only. |
| **UI-7** | medium | ErrorSummary links resolve for radio groups instead of being dead anchors. |
| **UI-11** | low | Nested repeated blocks enforce their instance-count bounds. |
| **UI-13** | low | RepeatedBlockField keys instances by identity, not array index, so state survives a mid-list removal. |
| **UI-14** | low | An optional single-select InventoryPicker can be cleared. |
| **UI-12** | low | Configure <-> Review transitions move focus, and the Suspense skeleton announces itself. |
| **UI-9** | medium | `/login`, `/onboarding` and LegacyRedirect have an errorElement instead of React Router's raw default screen. |
| **UI-15** | low | CommandPalette data refreshes instead of being fetched once per shell mount. |
| **FE-13** | low | RequestDetail sub-panels key their local state by request id, so it does not leak across navigation. |
| **FE-14** | low | DriftPage's post-trigger refetches respect the staleness guard. |
| **FE-12** | low | After a partial approval the queue drops the card the server's pending scope would drop. |
| **FE-7** | medium | PendingChangesBanner's count stays fresh after dual-control activity, and the mock branch subscribes to the store it reads. |
| **FE-8** | medium | AuditHistory pages instead of silently truncating at 100 — the cursor it already fetches is used. PERF-3 (done) built the server side. |
| **FE-10** | low | Mock `rejectRequest` enforces the same status guard the real API does. |


## B-S6 — Front-end performance (patterns already in-repo)


**Model:** sonnet · **Findings:** 4 · **Touches:** `ccp/app/src/`


| finding | sev | expected result |
| --- | --- | --- |
| **PERF-9** | medium | `ServiceConsole` stops loading the entire block-source corpus on every mount. THE PATTERN EXISTS: `lib/providerCatalog.ts` uses non-eager `import.meta.glob`, and PERF-5 (done) applied the same idea to the manifests — copy it. |
| **PERF-13** | low | SchemaForm memoizes inventory-derived enums instead of recomputing every field on every keystroke. |
| **PERF-15** | low | Request-history views window their lists. Virtualization already exists in this codebase — reuse it. |
| **PERF-6** | medium | API-mode stops re-downloading and re-parsing the full inventory + manifest set per route mount, and the serve endpoints send caching headers. |


## B-S7 — Lease / cleanup patterns already worked out in-repo


**Model:** sonnet · **Findings:** 8 · **Touches:** `ccp/api/src/domain/, scanner worker`


| finding | sev | expected result |
| --- | --- | --- |
| **API-6** | medium | The 72-hour dual-control expiry is enforced: `sweepExpired` has a caller and `ackPending` checks `expiresAt`. THE PATTERN IS SETTLE-ON-READ, used four times already (APPLYING, scan jobs, bundle claims) — follow it rather than adding a timer. NOTE: CONC-9 (this session) already made `sweepExpired` guarded and idempotent. |
| **DATA-7** | medium | Identical to API-6 — same defect, two reports. Fix once, close both. |
| **ARCH-10** | medium | A dual-control proposal expiring writes an audit entry, so the transition is not silent. |
| **ERR-15** | low | The scan worker records a terminal status when a progress report fails, and a claim non-2xx backs off instead of being process-fatal. |
| **OPS-12** | low | The scanner service has a healthcheck and stops exiting on any control-plane error. |
| **API-16** | low | The bundle workspace cannot leak, and every git step's exit code is checked. ERR-10's cleanup-spans-the-whole-window shape is the model. |
| **ERR-13** | low | `prepare()` cleans up the cloned workspace when `rev-parse` fails. Batch with API-16. |
| **REM-2** | low | The remaining blind full-row session puts become guarded writes. WORKED EXAMPLE: API-10 (this session) converted the idle slide — copy its shape, INCLUDING its rule that a lost condition means re-read, not log out. |


## B-S8 — CI wiring (mechanical)


**Model:** sonnet · **Findings:** 10 · **Touches:** `.github/workflows/, scripts/`


| finding | sev | expected result |
| --- | --- | --- |
| **OPS-9** | medium | All 8 workflows route to the documented CI runner, not 2. |
| **CI-10** | low | Push-trigger path filters include the workflow file itself on ccp-api and ccp-smoke. EXTEND `scripts/ci/check-path-filters.sh` so it catches this class. |
| **CI-11** | low | `gate.sh` advertises only checks CI actually runs. `scripts/ci/check-shipped-lanes.sh` is the adjacent precedent. |
| **CI-12** | low | Action pinning is consistent, the contradicting comment is gone, and setup-go caches against a go.sum that exists. |
| **CI-7** | medium | CI builds the Docker image on PRs, so the documented production install path is exercised before release time. |
| **ERR-16** | low | The ccp-data CI lane fails when the control plane is unreachable instead of going green. |
| **TEST-8** | medium | Golden-tree comparison is bidirectional: extra files created by an edit are reported. |
| **TEST-12** | low | The api suite stops rebuilding catalogctl per run (cache or build once); ~60% of wall time comes back. |
| **TEST-9** | low | Async API tests synchronize on a condition, not a sleep. |
| **TEST-10** | low | The functional test plan's counts and citations match HEAD, and 'new' rows are tracked. |


## B-S9 — Small correctness fixes with obvious tests


**Model:** sonnet · **Findings:** 16 · **Touches:** `various`


| finding | sev | expected result |
| --- | --- | --- |
| **CTL-6** | medium | `danglingRef` stops falsely refusing removal when another resource's name extends the target's. FLAG: this is a SAFETY GATE — match identifiers exactly, and add a fixture proving the true-positive still refuses. |
| **CTL-7** | low | plancheck's `inventoryAddr` skips `role:"reference"` inventory params, matching the executor's `targetAddress`. |
| **CTL-8** | low | `atomicWrite` preserves the edited file's permissions and fsyncs. ERR-10 is the worked example. |
| **API-11** | low | The audit-chain read path uses the injected clock and stops truncating at 120 months. SEE L-26: reading the clock directly is what made the month-boundary bug untestable. |
| **DATA-17** | low | The FileStore audit-durability test stops hardcoding month `202607` — same clock-seam lesson (L-26). |
| **ARCH-13** | low | The project-id grammar lives only in its declared single home. |
| **ARCH-16** | low | Vestigial code and stale references are removed. |
| **IMP-12** | low | `normalize.py split` no longer silently drops non-`resource` top-level blocks. |
| **IMP-10** | low | `gen-imports.py --id-region-suffix` stops appending `@region` to global-service ids. |
| **IMP-9** | low | Azure `discover.py list-subscriptions` handles a bare-list capture at the truncation-warning check. |
| **IMP-11** | low | `payloads.py`'s block scanner stops truncating a skeleton on a column-0 `}` inside a heredoc body. |
| **IMP-13** | low | The shell scripts' robustness gaps are closed within the deliberate no-`set -e` style. |
| **IMP-5** | medium | kit-azure `discover.sh` clears stale page files, so a re-run cannot resurrect deleted resources. |
| **OPS-13** | low | `doctor.sh` reports an unhealthy container as unhealthy. |
| **OPS-15** | low | The GitHub App key directory is prepared and checked by tooling. |
| **OPS-10** | medium | Log rotation and resource limits exist on every service. |


---

## Coverage check

Every one of the 139 open findings appears in exactly one batch above. That was verified
mechanically against `FINDINGS.md` when this file was generated — no finding is assigned
twice, and none is invented. If you add a finding, add it to a batch; if the two lists
disagree, `FINDINGS.md` is authoritative.


---

# Residue triage

[`RESIDUE.md`](RESIDUE.md) holds **42 items** — what the fixes deliberately left behind.
It is a separate ledger from `FINDINGS.md` and was **not** covered by the batches above, so
here it is.

**The headline: no residue item needs new scheduling.** Every one either rides a batch that
already exists, is deliberately permanent, or is already closed. One is misfiled and needs a
state correction, not work.

| state | count | what it means for planning |
| --- | ---: | --- |
| `resolved` | 2 | Closed by later work. Nothing to do. |
| `tracked` | 3 | An open finding covers it — it closes when that finding's batch runs. |
| `untracked` | 15 | Nothing covered it when written. **14 of the 15 fold into a batch above**; 1 is misfiled. |
| `accepted` | 22 | Deliberately permanent, with a reason. **Do not re-open these** without new information. |

## Rides along — assign nothing, it comes with the batch

These close as a side effect of work already scheduled. The point of listing them is so the
person taking the batch knows the residue is theirs, and does not leave it behind a second
time — which is the exact failure this ledger was built to stop.

| residue | rides | with | note |
| --- | --- | --- | --- |
| **R-4** — `planSummary` is typed `string` in the contract | `B-S4` | DOC-11 | — |
| **R-5** — The scan worker does not report its own terminal failure | `B-S7` | ERR-15 | — |
| **R-6** — The bundle's landed-but-untriggered half state | `B-O1` | ERR-12 | — |
| **R-25** — `ENGINEER_REVIEW_REQUIRED` is defined and emitted by nothing | `B-S3` | DOC-10 | Whoever enumerates the error codes for DOC-10 will hit this immediately. The decision is the deliverable, not the edit: emit it or delete it — `openapi.test.ts` currently pins its ABSENCE, which records the choice without making it. |
| **R-3** — The Python/importer CI gap is only partly closed | `B-S8` | the importer/CI lane | The `importer` lane exists but the gap is only partly closed; the CI batch is already opening those files. |
| **R-27** — The two literal-object token-walkers are still duplicated | `B-O9` | CTL-10 | Already carries a `Tracked by: CTL-10` marker — see the ledger corrections below, its section header is wrong. |
| **R-28** — The path-filter check covers four named edges, not the import graph | `B-S8` | CI-10 | THE PATTERN NOW EXISTS: `test/schedulerGating.test.ts` and `ccp/app/src/test/entryGraph.test.ts` both walk a real import graph. `check-path-filters.sh` can stop being a list of four named edges (L-25). |
| **R-32** — Sequential write latency is still O(store size) | `B-O3` | CONC-8 | CONC-8 is the same code path — PR #6 coalesced the writes, this is the serialization that remains. |
| **R-33** — The SPA still fetches unpaged request lists | `B-O4` | PERF-8 | Needs the same decision PERF-8 needs: an `updatedAt`-ordered index, or a product ruling that the bell means "recently created". Do not add a server-side `limit` without settling that — it would silently drop a recently-approved old request. |
| **R-8** — Session rows are written with blind puts | `B-S7` | REM-2 | REM-2 IS this residue with a finding number. Fix once. |
| **R-29** — The Azure tag catalog was not regenerated from the corrected ledger | `B-O10` | IMP-8 | The corrected ledger exists (IMP-4); the Azure tag catalog was never regenerated from it. |
| **R-9** — No end-to-end install-journey smoke | `B-O8` | CI-13 | CI-13 asks what the smoke should assert. "An end-to-end install journey" is the answer this residue is holding. |
| **R-10** — `transactWithAudit` cannot tell which condition failed | `B-O12` | CONC-15 / API-14 | CONC-15 and API-14 are the finding-shaped version of exactly this. Fix once, close three. |
| **R-11** — The redaction/toolchain helpers are duplicated across packages | `B-O5` | ARCH-6 | The shared package ARCH-6 asks for is where these helpers go. |
| **R-12** — `versionStamp` cannot reach an incomplete project registry | `B-O7` | DATA-11 / API-9 | A project missing from the registry leaves its rows unstamped AND the one-shot marker is written anyway, so it never retries. Batch it with the migration work that can actually re-run it. |
| **R-13** — IMP-7's recurrence guard was never built | `B-O10` | IMP-7 follow-up | IMP-7 is closed; its recurrence guard was never built, so the divergence can come back silently. |
| **R-30** — The built-in gate runner was not shipped | `B-O1` | the bundle lane | ARCH-3 shipped the "at minimum" clause (the api verifies the digest). The built-in runner it recommends is still the operator's free-form command, and B-O1 is already inside `domain/bundle.ts`. |

## Ledger corrections — no code, just the record

Found while preparing this. Both are my own entries, and both are the kind of drift the
residue ledger exists to catch, so they should be fixed in `RESIDUE.md` rather than left:

| residue | problem | correction |
| --- | --- | --- |
| **R-27** | Sits under `## untracked — nothing covers these` while carrying `**Tracked by: CTL-10.**`. The gate passes it, because the gate only checks that a `tracked` claim cites an **open** finding — and CTL-10 is open. So the section header is the part that is wrong, and the gate cannot see it. | Move it into the `tracked` section. Consider teaching the gate to check section placement against the marker, since it clearly cannot today. |
| **R-34** | Filed `untracked`, but its own text says "a stated trade" and notes that `GET /admin/audit/export` and `verify-audit-chain.ts` still verify every entry, **with a test pinning that they catch what the memo path does not**. A deliberate limit with a test on it is `accepted`, not a gap. | Restate as `accepted`. The substance is right; only the state is wrong. |

## Accepted — deliberately permanent, do not re-open

Listed so nobody spends a session re-deciding a decision. Each has its reasoning in
`RESIDUE.md`; re-open one only if its **premise** changes, not because it looks like an
open task.

| residue | |
| --- | --- |
| **R-7** | A fix landed inside another finding's commit |
| **R-14** | The link checker does not check external URLs |
| **R-15** | Enrichment call sites degrade to absent rather than showing an error |
| **R-16** | Neither process error handler exits |
| **R-17** | Rewindow is not widened to the halt statuses |
| **R-18** | `AWAITING_CODE_REVIEW` stays in `BUNDLE_ELIGIBLE` |
| **R-19** | Scan-job leases settle on read, not on a timer |
| **R-20** | Store durability recovery is an operator action |
| **R-21** | The auto-apply pin-writer does not exist |
| **R-22** | Component-level behaviour that jsdom would be needed to test |
| **R-23** | The `importer` CI lane also runs a non-importer suite |
| **R-24** | PERF-2 removed the freeze, not the serialisation |
| **R-26** | Four allowlisted gitleaks hits, and a scanner that had never run |
| **R-31** | The reference apply lane's apply step is a stub |
| **R-35** | PERF-5 moved the catalog parse; it did not make it cheaper |
| **R-36** | The entry chunk is still 855 kB (248 kB gzip), and `manualChunks` would not shrink it |
| **R-37** | The forge-credential broker is not wired into the armed lanes |
| **R-38** | With no pin and no registered repo, a multi-estate deployment still shares one remote |
| **R-39** | Co-arming the two apply lanes is still allowed |
| **R-40** | The ~10 client-only statuses were kept, not pruned |
| **R-41** | The store schema still types `status` as `z.string()` |
| **R-42** | `APPLIED` still means two things |

Three of these are worth knowing about before you start any batch, because they will look
like bugs:

- **R-21** — the auto-apply pin-writer does not exist, so **no request carries a plan pin
  today**. That makes ARCH-3's digest verification inert on every real request. If you are
  in `B-O1` and the digest check never fires, this is why.
- **R-22** — this repo has **no jsdom**, and `test/standalone.test.ts` enforces a
  dependency allowlist. Anything in `B-S5` that seems to want a DOM test cannot have one;
  extract the rule into a pure function instead. TEST-7 in `B-O13` is where that constraint
  gets revisited, if it ever does.
- **R-16** — neither process error handler exits. `B-O6` (ERR-8 / OPS-8) owns that seam;
  don't fix it in passing from somewhere else.

## Resolved

**R-1** (the legacy-row concurrency window, closed by REM-1 + DATA-1) and **R-2**
(`ifEquals` passing when the attribute is absent). Both closed. R-1 is worth reading once
regardless: the same residue was recorded on three separate findings, each noting it "still
has no finding", and nothing picked it up — which is why this file exists at all.


---

# How many Sonnet lanes can run at once

**75 findings, 9 batches — but batches are not lanes.** Three of the Sonnet batches all
edit `ccp/app/src/`, and B-S9 ("various") spans four unrelated components. Regrouped by what
they actually touch, the Sonnet work is **7 lanes that can run concurrently**, plus two
things that cannot.

| lane | batches | findings | owns | why it is one lane |
| --- | --- | ---: | --- | --- |
| **L1 · app** | B-S2, B-S5, B-S6 | 23 | `ccp/app/src/` | The whole front end. These three batches all reach into `ccp/app/src/` — B-S2's `StatusBadge` label map is the same file B-S5 edits for UI-5/6/7, and B-S6's PERF-9 touches `ServiceConsole` — so they are ONE lane, not three. |
| **L2 · api-domain** | B-S7, plus API-11 from B-S9 | 9 | `ccp/api/src/domain/, scanner worker` | API-11 moves here from B-S9: the audit-chain read path is `domain/audit.ts`, so leaving it in a 'various' batch would collide with this lane. |
| **L3 · ci-and-ops** | B-S8, plus OPS-10 / OPS-13 / OPS-15 from B-S9 | 13 | `.github/workflows/, scripts/, docker-compose*.yml` | The ops items live in `scripts/` and compose, which B-S8 already owns. Splitting them out would create a collision, not a lane. |
| **L4 · docs** | B-S3 | 11 | `docs/, ccp/api/README.md, tools/catalogctl/README.md` | Pure documentation accuracy. Collides with nothing, and every item wants a check added so it cannot drift again. |
| **L5 · catalogctl** | CTL-6, CTL-7, CTL-8 from B-S9 | 3 | `tools/catalogctl/ (Go)` | Go, self-contained. CTL-6 is a safety gate — match identifiers exactly and keep a fixture proving the true-positive still refuses. |
| **L6 · importer** | IMP-5, IMP-9, IMP-10, IMP-11, IMP-12, IMP-13 from B-S9 | 6 | `importer/, kit-azure (Python + shell)` | Python and shell, self-contained. Note the deliberate no-`set -e` style in IMP-13 — work within it, don't 'fix' it. |
| **L7 · contract** | B-S4, plus DATA-17 and ARCH-13 from B-S9 | 4 | `openapi/, ccp/api/src/store/, ccp/api/test/` | Small. DATA-17 is a store test; ARCH-13 is the project-id grammar's single home. |

**Run last, alone:**

- **`B-S1` (5 findings) — verify-and-close.** It writes only the ledger, so it collides with
  every other lane by construction. It is also the cheapest work here and the most likely to
  be invalidated by a parallel lane closing the same thing. Run it after the others land.
- **ARCH-16 (vestigial code and stale references)** — cross-cutting by definition. Deleting
  dead code while six lanes are adding code is how you delete something that just became
  live. Last, alone.

## The real ceiling is the ledger, not the code

Seven lanes is what the *source tree* allows. What actually caps parallelism is that every
fix touches the same four ledger files. Measured across the 8 fix commits already on this
branch:

| file | touched by |
| --- | --- |
| `docs/audit/FIXES.md` | 8 of 8 |
| `docs/audit/FINDINGS.md` | 7 of 8 |
| `scripts/findings-baseline.txt` | 7 of 8 |
| `docs/audit/RESIDUE.md` | 3 of 8 |

`FIXES.md` and `RESIDUE.md` are append-only at the end of the file, so two parallel sessions
conflict there **every time** — git sees two additions at the same location.
`findings-baseline.txt` is a single line, so it conflicts every time too, and a careless
resolution is silently wrong (it must reflect *both* lanes' closures, not the later one's).

**The baseline conflict is avoidable, and this is the one operational thing worth knowing:
the baseline is a CEILING, not an exact match.** `findings-gate.sh` fails only when
`n_open > baseline`. A lane that closes findings without touching the file leaves the open
count *lower* than the baseline, and the gate passes. So:

- **Parallel lanes should not touch `scripts/findings-baseline.txt` at all.**
- One reconciliation pass at the end tightens it to the true count, in a single commit.

That leaves `FIXES.md` and `RESIDUE.md` as the remaining friction. They are append-only
conflicts — mechanical to resolve (keep both), but they arrive on every merge. With 7 lanes
that is 7 trivial-but-real conflicts per round.

## What I would actually run

**Four to five concurrent lanes**, not seven. The extra two lanes buy little: L5 (3
findings), L7 (4) and L2 (9) are small enough that a single session absorbs one of them
alongside another lane faster than the merge overhead of a separate branch.

A reasonable shape:

| session | lanes | findings |
| --- | --- | ---: |
| 1 | L1 app | 23 |
| 2 | L3 ci-and-ops | 13 |
| 3 | L4 docs | 11 |
| 4 | L2 api-domain + L7 contract | 13 |
| 5 | L5 catalogctl + L6 importer | 9 |
| then | B-S1 verify-and-close, then ARCH-16 | 6 |

Each on its own branch off the same base, each skipping the baseline file, merged in any
order, with one reconciliation commit at the end.

