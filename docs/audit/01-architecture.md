# Architecture & Design Coherence Audit

**Audit date:** unknown-date
**Dimension:** Architecture & design coherence (`architecture`)
**Repository:** `cloud-control-plane` @ `3000920` ("Easy first import: paste a repo address and this system scans it (#2)")

---

## Scope & method

Read in full or in substantial part:

- **Product & decision record:** `PRD.md`; `docs/adr/README.md` (ledger) and ADRs 0012, 0015, 0016, 0022, 0033 in full, plus targeted reads of 0013/0017/0022/0024–0026/0028/0031/0032; `docs/FUNDAMENTALS.md`; `ccp/docs/DOMAIN-MODEL.md` (complete), `ccp/docs/MAINTAINING-THE-CATALOG.md`, portions of `ccp/docs/go-live.md`, `ccp/README.md`, `ccp/api/README.md`, `tools/catalogctl/README.md`.
- **API (`ccp/api/src`, ~16.5k LOC):** `index.ts`, `server.ts`, `deploy.ts` (grep), `projects.ts`, `manifests.ts`, `errors.ts` (head); middleware `session.ts`, `authz.ts`, `rateLimit.ts`; store `schema.ts` (head), `configStore.ts`, `fileStore.ts`, `planSummarySchema.ts`; domain `exposure.ts`, `bundle.ts`, `driftCheck.ts`, `driftProposals.ts` (config + gen seam), `projectData.ts` (upload pipeline), `apply/loop.ts`, `apply/scheduler.ts`, `apply/terraformExecutor.ts` (head), `dualControl.ts#sweepExpired`; routes `requests.ts` (submit, approve, apply, cancel), `drift.ts` (head + submit sites), `projects.ts` (targeted).
- **SPA (`ccp/app/src`, ~47.6k LOC non-test):** `lib/api.ts` (head + `ApiClient`), `lib/httpApi.ts` (head + manifest resolution), `types/request.ts`, `lib/permissions.ts` (usage), directory map of `features/` (55 feature components), `data/` layout.
- **Go tooling:** `tools/catalogctl` structure, `internal/cli/cli.go`, `internal/prprep` (UNAPPROVED refusal), `internal/windowcheck` (estate-tz), README; `tools/schemadump` listing.
- **Deployment:** `ccp/api/Dockerfile`, `ccp/scanner/Dockerfile`, `ccp/docker-compose.yml` (profiles), `.github/workflows` listing, `scripts/gate.sh`.
- **Tests:** inventory of `ccp/api/test` (74 files) and `ccp/app/src/test` (214 total test files across both), read `bundle.test.ts` (route surface), `openapi.test.ts`, `planSummary.test.ts` imports.

Method: read the governing documents first, then verified each architectural claim (layering, contracts, ADR decisions, "ships blank") directly against code, greping for every cross-boundary import, every `CCP_*` env knob, and every duplicated definition cited below. No files other than this report were created or modified; nothing was committed.

---

## Strengths

This is an unusually coherent, self-aware architecture. Concretely:

1. **Layering in `ccp/api/src` is real, not aspirational.** Routes orchestrate; policy lives in small, pure domain modules (`domain/exposure.ts` is the single source of the approval ladder — count and role rule derived from one `ladderFor`, `exposure.ts:65-87`; `domain/schedule.ts`, `domain/cooling.ts`, `domain/requirement.ts` are shared by submit, approve, feasibility and the scheduler so "the two never drift" — `routes/requests.ts:604`). The scheduler core takes `now` as a parameter and an injected executor (`domain/apply/scheduler.ts:19-24`), and the impure shell (`domain/apply/loop.ts:11-16`) is explicitly the one file that reads env and arms a timer.
2. **The store seam is disciplined.** `ConfigStore` mirrors DynamoDB semantics (`store/configStore.ts:31-42`), `MemoryStore`/`FileStore` implement it, and `FileStore` does crash-safe atomic snapshots with a serialized write chain and a fail-closed load of empty files (`store/fileStore.ts:38-56, 79-99`). Keying is centralized in `store/schema.ts` helpers ("No caller concatenates key strings by hand", `schema.ts:8-13`) — and that holds in the code I read.
3. **Off-by-default arming is a consistent house doctrine.** Scheduler (`apply/loop.ts:18-30`), bundle (`domain/bundle.ts:13-15`), drift lanes (`domain/driftProposals.ts:69-78`), drift-check (`domain/driftCheck.ts:17-20`) and scanner (`domain/scanner.ts`) all return `null`/refuse when unarmed, and a *misconfigured* terraform executor refuses to arm the loop rather than silently falling back to dry-run (`apply/loop.ts:96-102`) — an unusually honest failure posture.
4. **"Ships blank" is structural, not a README claim.** The reserved `@control` scope is deliberately outside the project-id grammar so collision is impossible by construction (`projects.ts:31-51`); there is no baked estate id (`projects.ts:28`, blank cache = `{'@control'}`); the sample estate loads only in mock builds or on an explicit click (`app/src/lib/api.ts:54-68`); legacy single-estate stores are handled by an idempotent, audited settlement lane (`domain/settlement.ts`, wired at `server.ts:85-111` and `middleware/session.ts:49-52`); genericity is CI-enforced (`ccp/app/package.json:21` `verify:safety` → `verify-source-genericity.ts`; `publish-gate.yml`).
5. **The audit chain is a first-class architectural element.** Per-project hash chain with a chain-head CAS in the same transaction as every append (`domain/audit.ts`, per DOMAIN-MODEL §5.3), a single canonical verifier shared by CLI, export and restore, and route code consistently folds domain writes + audit into one guarded transact with a one-retry contention loop (`routes/requests.ts:687-707`, `apply/scheduler.ts:340-383`).
6. **`catalogctl`'s boundary holds.** It is genuinely the only Terraform writer; the api never edits `.tf` (grep confirms no HCL writing in `ccp/api/src`); its refusal contract (exit codes, `REFUSE <CODE>`) is explicit (`internal/cli/cli.go:1-2, 89-93`), and golden/fixture testing is extensive (`testdata/golden/*`, plans R1–R7, onboarding malicious-repo fixtures). The ADR-0033 scanner reuses it unchanged with subtractive containment (`ccp/scanner/Dockerfile`: no terraform, runtime preflight refusals, tmpfs workspace).
7. **Documentation discipline is exceptional and self-critical.** `docs/FUNDAMENTALS.md` maps every standard doc to one home; `ccp/docs/DOMAIN-MODEL.md` is code-cited per claim, ends with regeneration commands, and — remarkably — carries its own "Known tensions & caveats" section listing real drift it found (several items below are that list's still-open entries). The ADR ledger tracks supersession honestly (e.g. 0033's carefully-scoped supersession of 0031/0032).
8. **Contract seams exist where they matter:** one `ApiClient` interface behind both the mock and HTTP clients (`app/src/lib/api.ts:274`, `httpApi.ts:25-46`); injected-steps interfaces for every process-spawning lane so tests never hit the network (`BundleSteps`, `DriftGenSteps`, `DriftCheckSteps`); a contract test forbids spawns in the timer-driven apply subsystem (`schedulerGating.test.ts`, noted at `bundle.ts:26-29`); shared serializer for the `.bundle-request.json` payload after a drift-parity bug (`routes/requests.ts:197-223`).

---

## Findings

### ARCH-1 — Bundle apply route accepts pre-quorum requests, contradicting ADR-0016's "fully approved" contract
**Severity:** high
**Location:** `ccp/api/src/routes/requests.ts:880` (and the handler at `:887-926`)

`BUNDLE_ELIGIBLE = new Set(['AWAITING_CODE_REVIEW', 'AWAITING_DEPLOY_APPROVAL'])` with the comment "statuses the bundle may act on — fully approved, unapplied. A pre-quorum … request is refused." But `AWAITING_CODE_REVIEW` **is** the pre-quorum status: `initialStatusFor` places every fresh non-engineer submission there (`domain/exposure.ts:90-92`), and the approve handler moves a quorum-met request *out* of it (`routes/requests.ts:658-674` → `WINDOW_EXPIRED`/`AWAITING_DEPLOY_APPROVAL`/`APPLIED`). The apply handler checks role, freeze, status and bundle-state — but never `approvals.length` against the ladder (`:894-919`). The test suite's own "pre-quorum is refused" case has to flip the seeded row to `NEEDS_ENGINEER` first, precisely because `AWAITING_CODE_REVIEW` would *not* be refused (`ccp/api/test/bundle.test.ts:169-181`).

**Impact:** on an armed deployment, a Lead/admin calling `POST /requests/:id/apply` on a zero-approval request runs the full bundle — gate, commit to `main`, deploy-gate trigger. The only remaining defense is whatever the operator wired into `CCP_BUNDLE_GATE_CMD`; the shipped `UNAPPROVED` refusal exists only in `pr-prepare` (`tools/catalogctl/internal/prprep/prprep.go:85`), not in the documented `drift-edit`/`plan-check` gate recipe. This voids ADR-0016's premise that the portal ladder *is* the human review of the change.

**Recommendation:** in the apply route, require `req.approvals.length >= currentRequirement(req).ladder.length` (the same tighten-only helper approve uses) before the claim, and remove `AWAITING_CODE_REVIEW` from `BUNDLE_ELIGIBLE` unless a fully-approved request can actually inhabit it; add the un-flipped `AWAITING_CODE_REVIEW` case to `bundle.test.ts`.

### ARCH-2 — The armed apply/drift-generation lanes are single-estate by construction in a multi-account product
**Severity:** high
**Location:** `ccp/api/src/domain/bundle.ts:46-53`; `ccp/api/src/domain/driftProposals.ts:733-749`

The bundle and the drift-proposal generator both resolve their git checkout from **one deployment-global** `CCP_GIT_REMOTE`/`CCP_GIT_BRANCH` ("one credential, two lanes" — `ccp/api/README.md:59`), with one global gate/trigger/gen command. Nothing reads the acting project's own registered repo, although the registry stores it (`ProjectItem.github`, `store/schema.ts:756-757`) and although the newest lane (ADR-0033 scanner) already resolves clone URLs per project from the validated `RepoRef` (`buildCloneUrl`, per ADR-0033 "What shipped" table). ADR-0015's binding rule 6 is explicit: "The request→PR bridge/executor, whenever built, reads provider/scope from project config **from day one** (seam-now sequencing, owner-accepted over wait-and-retrofit)" (`docs/adr/0015-ccp-azure-second-provider.md:48-49`). The bridge, as built, does not.

**Impact:** the moment a second estate is onboarded (the product's headline scenario — "one control plane serves many accounts", PRD), an armed bundle/drift deployment clones estate A's repo for estate B's requests and drift reports. The failure is fail-closed in practice (the gate/generator refuses inside the wrong checkout), so this is an availability/evolvability defect rather than corruption — but it is exactly the retrofit ADR-0015 called "the single most expensive avoidable mistake."

**Recommendation:** move remote/branch resolution behind a per-project lookup (project registry `RepoRef` + the ADR-0033 forge-credential broker already built for the scanner), keeping the env vars as a single-estate fallback; have `bundleConfig`/`driftGenConfig` take the `ProjectItem`.

### ARCH-3 — The "reviewed-plan ≡ applied-plan" guardrail is delegated to unverifiable operator shell strings
**Severity:** high
**Location:** `ccp/api/src/domain/bundle.ts:112-120, 141-144, 157-159`; `ccp/api/src/domain/driftProposals.ts:738-748`; `ccp/api/src/domain/driftCheck.ts:49-61`

ADR-0016 step 1 says "the **api** re-derives the change with `catalogctl` … and runs the plan-check gates (R1–R6, digest)", and marks the plan-must-equal-the-approved-change rule "Owner requirement, binding." As built, the api spawns `bash -lc "$CCP_BUNDLE_GATE_CMD"` and trusts exit 0 (`bundle.ts:112-120, 141-144`); the R-gates, the digest pin, and even *which tool runs at all* are the operator's command string (`ccp/api/README.md:52` documents what the command "must" do). The trigger and the drift generator follow the same pattern. The api performs no digest re-verification of the gate's output, records only a 400-char output tail as evidence (`bundle.ts:110`), and `bash -lc` additionally sources login-shell profiles into the gate environment.

**Impact:** the product's central safety property (PRD: "What was reviewed is exactly what runs… Any difference at all, and it stops") holds only on deployments whose operators wrote the right command; a typo'd or weakened gate command produces a green bundle with no in-product check violated and no way to tell from the audit trail. Determinism ("the same request always produces the same change") becomes per-deployment.

**Recommendation:** ship a built-in gate runner that invokes a pinned `catalogctl` (`edit`/`drift-edit` + `plan-check`) with fixed arguments — the toolbox image already exists for exactly this — and demote the free-form command to an explicitly-labeled escape hatch; at minimum, have the gate emit the plan digest on stdout and have the api re-check it against the request's `planDigest` before committing.

### ARCH-4 — No mutual exclusion between the two apply lanes; both act on `AWAITING_DEPLOY_APPROVAL`
**Severity:** medium
**Location:** `ccp/api/src/routes/requests.ts:913-915` (bundle claim); `ccp/api/src/domain/apply/scheduler.ts:166` (due filter)

The route-triggered bundle (ADR-0016, `CCP_BUNDLE=1`) and the timer-driven scheduler (0038, `CCP_SCHEDULER=1`) are independent opt-ins with overlapping domains: every bundle-eligible *approved* request is windowed (`schedule: now` requests jump straight to `APPLIED` at quorum — `requests.ts:671-673`), i.e. sits in `AWAITING_DEPLOY_APPROVAL`, the exact status the scheduler claims when the window opens. The bundle's claim writes `bundle.state='running'` but does **not** move `status`; the scheduler's due filter reads only status + window and never consults `bundle` (`scheduler.ts:161-166`). Nothing at arming time refuses the combination.

**Impact:** with both lanes armed, a Lead's bundle click inside an open window races the next scheduler tick: the scheduler can claim (`AWAITING → APPLYING`) and run its executor while the bundle is mid-clone/gate; the bundle then lands its commit and satisfies the CI deploy gate, after which its result write loses its `ifEquals status` guard and surfaces as 500 `CHAIN_CONTENTION` (`requests.ts:946-959`) — real side effects (pushed commit, satisfied gate, possibly a terraform apply) with a request record stuck at `bundle.state='running'`.

**Recommendation:** make the bundle claim a status transition (or have the scheduler skip rows with `bundle.state='running'`), and/or refuse co-arming (`CCP_BUNDLE` + `CCP_SCHEDULER`) at `assertDeployable` unless an explicit override is set.

### ARCH-5 — Two sources of truth for the catalog: the server validates against the image-baked catalog, the SPA renders the per-project uploaded one
**Severity:** medium
**Location:** `ccp/api/src/manifests.ts:14, 24-26`; `ccp/api/src/routes/requests.ts:309`; `ccp/api/src/routes/projectData.ts:523`; `ccp/app/src/lib/httpApi.ts:36-45, 2000`

Post data-birth, every real estate's manifests are uploaded by its CI, staged, dual-control-activated and served from the data plane (`GET /projects/:id/manifests`), and the SPA builds its forms from that active version (`httpApi.ts:36-45`). But server-side submit validation resolves every operation and its bounds from the **product-bundled** catalog baked into the api image (`manifests.ts` `DEFAULT_DIR` → `app/src/data/manifests`, vendored by `api/Dockerfile:64-67`), with no per-project resolution and no version/digest compatibility check between the two sets. `MAINTAINING-THE-CATALOG.md` even sanctions per-project vendored manifests "when a project genuinely needs a private op" — which this seam cannot honor (a private op fails `getOperation` → `VALIDATION_FAILED`).

**Impact:** version skew between an estate's uploaded catalog and the deployed image's bundled catalog means the form and the server disagree — ops offered but refused, bounds displayed but not the ones enforced, or ops enforced that the project's catalog no longer offers. Fail direction varies by case (some widen, some refuse), and nothing detects the skew.

**Recommendation:** resolve submit-time operations from the acting project's *active* manifest version when one exists (falling back to the bundled catalog otherwise), or pin and verify a catalog digest at submit; document which set is authoritative in DOMAIN-MODEL.

### ARCH-6 — The backend depends on frontend-package internals; the shared-contract layer is a path alias plus a hand-synced copy
**Severity:** medium
**Location:** `ccp/api/tsconfig.json:13-14`; `ccp/api/src/routes/requests.ts:5`; `ccp/api/src/domain/{drift,projectData,config}.ts` (`@app-lib` imports); `ccp/api/src/store/planSummarySchema.ts:4-17`; `ccp/api/Dockerfile:15-24, 64-67`

Server-enforced authorization (`canRequest`/`canApprove`), redaction (`redactHcl`/`redactTfJson`), policy defaults and param-activation rules are **imported from `ccp/app/src/lib`** via a tsconfig `paths` alias, and the api Docker image vendors the whole `app/src` tree to make that resolvable at runtime. There is no shared package: the constraint that these modules stay dependency-free is enforced only by comments, and its known failure mode is nasty — a zod value import through the alias makes the api's types silently "collapse to `unknown`" in CI (`planSummarySchema.ts:6-11`), which is exactly why `PlanSummary` exists as a hand-maintained copy with a "keep this edited in lockstep" instruction and **no parity test** (`test/planSummary.test.ts` exercises behavior, not copy-equality).

**Impact:** the app's `lib/` cannot be refactored without auditing the api's import graph; a dependency added to any aliased file breaks the api build (or worse, degrades typechecking); the copied schema can drift silently from `app/src/lib/planSummary.ts`.

**Recommendation:** extract a real `ccp/shared` workspace package (permissions, policy, redact, dependsOn, planSummary, the shared types) with its own `package.json` installed by both CI jobs; until then, add a lint rule confining `@app-lib` to an allowlist and a byte/shape parity test for the planSummary copy.

### ARCH-7 — The request-status vocabulary is an unowned, drifted contract
**Severity:** medium
**Location:** `ccp/api/src/store/schema.ts` (status is `z.string()`, per DOMAIN-MODEL §2.2/known-tensions); `ccp/app/src/types/request.ts:4-46`; `ccp/api/src/domain/apply/scheduler.ts:50-51`; `ccp/api/src/routes/requests.ts:671-673`

The server stores status as free text; the SPA declares a 21-value union. The two have drifted in both directions: the scheduler writes `HALTED_DRIFT`/`HALTED_APPLY_FAILED`, absent from the SPA union entirely (grep of `ccp/app/src` finds no occurrence), while the union carries ~10 statuses the api never writes (`GENERATING`, `CHECKS_RUNNING`, `PLAN_READY`, `CODE_APPROVED`, `MERGED`, `NOOP`, `DIGEST_MISMATCH`, `WITHDRAWN`, …). The api also stamps `APPLIED` on quorum-met `schedule:'now'` requests with nothing applied — the "Stage-0/1 fiction" the domain model itself warns operators about. All of this was recorded as a known tension in `DOMAIN-MODEL.md` (extraction of 2026-07-17) and remains unfixed while new statuses (`APPLYING`, halts, `bundle-*` events) kept accreting.

**Impact:** the client renders statuses it cannot type; downstream filters (e.g. the rate limiter's `OPEN_STATUSES`, `middleware/rateLimit.ts:26` — which counts neither `APPLYING` nor the halt statuses as occupying a slot) must be hand-audited against a vocabulary that exists nowhere as a closed set; `APPLIED` is ambiguous evidence.

**Recommendation:** define one closed status enum in the shared layer (see ARCH-6), have the store schema validate against it (with a legacy-passthrough shim), and split "approved, no apply lane armed" from `APPLIED`.

### ARCH-8 — The governance domain is implemented twice (server + browser mock) with acknowledged behavioral divergence
**Severity:** medium
**Location:** `ccp/app/src/lib/{accounts,teams,policy,riskOverrides,pendingChanges,audit,settings}.ts` vs `ccp/api/src/domain/*` + `store/*`; `ccp/app/src/lib/api.ts` (1,756 LOC) vs `lib/httpApi.ts` (2,036 LOC)

Mock/standalone mode reimplements accounts (PBKDF2 hashing), teams, policy, risk overrides, pending config changes and a non-chained audit log in `localStorage`, plus a full mock `ApiClient`. The seam is clean and the mode is a deliberate product feature ("runs fully standalone"), but parity is maintained by hand and is already partial by design: the mock has no cooling, window, scheduler, bundle or settlement machinery (`types/request.ts:23-46` annotations; DOMAIN-MODEL §5.4's free-text mock audit actions).

**Impact:** every governance change is a two-implementation change; divergences (like ARCH-7's status sets) accumulate at exactly this seam; reviewers must know per-behavior which side is authoritative.

**Recommendation:** shrink the mock's surface toward "the http client over an in-browser toy store" by moving pure rules (quorum/ladder/permissions/policy) into the shared layer — much of this exists — and enumerate mock-vs-api behavioral gaps in one table in `ccp/README.md` instead of scattered comments.

### ARCH-9 — Single-process, single-file scaling ceiling with in-process singletons the planned DynamoDB path would silently break
**Severity:** medium
**Location:** `ccp/api/src/store/fileStore.ts:14-17, 79-99`; `ccp/api/src/projects.ts:28-29, 87-97`; `ccp/api/src/middleware/rateLimit.ts:69`; `ccp/api/src/domain/driftCheck.ts:65`; `ccp/api/src/domain/apply/loop.ts:111`

`FileStore` re-serializes and fsyncs the **entire** store on every mutation, on a serialized chain ("correctness beats write-amplification… this governance DB is small"). But the store accretes per-project audit chains forever, every request with its `pinnedDiff`, sessions, drift metadata — with no compaction, archival, or size telemetry; write latency and memory grow linearly with history across all estates. Meanwhile correctness-relevant state lives in per-process singletons: the known-projects routing cache (refreshed only by the process that handled the registry write), upload-rate buckets, drift in-flight guards, the scheduler's reentrancy flag. The seam docs say "a DynamoDB implementation is planned behind the SAME seam" (`configStore.ts:2-3`) — but the seam only covers the store; a second api process today (or DynamoDB tomorrow) breaks routing-cache freshness and every in-memory guard without any error.

**Impact:** long-lived multi-estate deployments degrade on every write; horizontal scaling is silently unsafe despite the store seam suggesting otherwise.

**Recommendation:** document the single-process invariant where deployers will see it (`api/README.md`), add store-size telemetry/alerting to `/readyz`, and design audit-chain archival (the month-partitioned keys already anticipate it) before the DynamoDB lane.

### ARCH-10 — Unaudited governance transition: dual-control proposals expire silently
**Severity:** medium
**Location:** `ccp/api/src/domain/dualControl.ts:347-358`

`sweepExpired` flips `PENDING → EXPIRED` on pending config changes with a plain `store.put` and writes no audit entry — a state transition on a governance record outside the hash chain, in a system whose stated doctrine is that every governance action lands on the chain. The domain model's extraction notes flagged this on 2026-07-17 ("may be an intentional gap or an oversight"); it is still open, and no ADR or comment since has claimed it as intentional.

**Impact:** the audit chain shows a `config-propose` with no terminal entry; an expired loosening proposal is indistinguishable from a tampered-away one without store forensics.

**Recommendation:** fold a `config-expire` chained entry into the sweep (the `transactWithAudit` helper already exists), or record the intent to omit it in an ADR/DOMAIN-MODEL as a decision rather than a caveat.

### ARCH-11 — Arming-flag sprawl with no whole-config validation
**Severity:** low
**Location:** `ccp/api/src` (grep: ~35 distinct `CCP_*` variables); `ccp/api/src/deploy.ts:131-149`

Four armed lanes (scheduler/executor, bundle, drift × 4 sub-flags + 2 command strings + shared git remote, scanner/forge) plus identity, cookie, CORS, store and legacy knobs. Each lane is individually fail-closed (a genuine strength), but `assertDeployable` validates only store/cookies/CORS/TOTP; no preflight reasons about combinations (e.g. `CCP_DRIFT_PROPOSALS=1` without `CCP_DRIFT=1`, bundle+scheduler co-arming per ARCH-4, `CCP_EXECUTOR=terraform` with the bundle armed). The knowledge of valid combinations lives in the README table and go-live prose.

**Recommendation:** a config-model module (parse env once into a typed deploy config, warn on incoherent combinations) — the codebase's own `deploy.ts` is the natural home.

### ARCH-12 — `catalogctl` README's "complete, no more, no fewer" subcommand table omits a third of the subcommands
**Severity:** low
**Location:** `tools/catalogctl/README.md` (Subcommands table) vs `tools/catalogctl/internal/cli/cli.go:23-87`

The README asserts its 6-row table is "the complete list, no more, no fewer," verified against `cli.go`. `cli.go` dispatches **9**: `drift-edit`, `scan-worker`, and `window-check` are missing from the table (the usage string at `cli.go:25` names all nine). Given this repo's own doctrine that a second untended copy is how docs rot, an explicitly-"verified" false completeness claim is worth fixing promptly.

**Recommendation:** add the three rows; better, generate the table (or a test) from the `Run` switch.

### ARCH-13 — Project-id grammar duplicated inline despite a declared single home
**Severity:** low
**Location:** `ccp/api/src/projects.ts:51` (declares itself "the single home for project-id syntax") vs `ccp/api/src/routes/drift.ts:120`, `ccp/api/src/routes/projectData.ts:56`, `ccp/api/src/domain/drift.ts:58`, `ccp/app/src/lib/projectOnboarding.ts:122`

Four additional verbatim copies of `/^[a-z][a-z0-9-]{1,31}$/` (plus the OpenAPI patterns). Any future change to the grammar must move five code sites in lockstep or path-validation and registration will disagree.

**Recommendation:** import `PROJECT_ID_RE` everywhere in the api; export it through the shared layer for the app.

### ARCH-14 — The OpenAPI "parity test" is string containment, not parity
**Severity:** low
**Location:** `ccp/api/test/openapi.test.ts:6-60`; `docs/FUNDAMENTALS.md:30`

FUNDAMENTALS bills `ccp-api.yaml` as the API source of truth with "a parity test keeps code honest." The test only asserts the YAML *contains* certain path strings and schema names; it never walks the Hono route table against the spec, so a route added without a spec entry (or removed while the spec keeps it) passes. Given the API surface's growth rate (scan-jobs, onboard-tokens, identity, forge-credential routes all recent), drift risk is real.

**Recommendation:** enumerate `app.routes` in a test and diff against the YAML's path set (allowlisting internal lanes), or generate the YAML skeleton from the router.

### ARCH-15 — ADR ledger statuses lag the built system
**Severity:** low
**Location:** `docs/adr/README.md:27-33`

ADR-0031 is listed "Proposed (design lane; build gated on owner sign-off)" while its Phase 1 (onboard tokens, Bearer trust-request lane, CI provenance) is built and shipped — ADR-0033's own context says "the narrow upload lane already exists (ADR-0031 Phase 1, built)" and DOMAIN-MODEL catalogs the rows/routes. ADRs 0024–0026 remain "Proposed … status flips to Accepted on the owner's formal word" with builds landed; 0028 is "Proposed (build gated)" while `catalogctl window-check --estate-tz` (its named mechanism) exists (`internal/windowcheck/command.go:37`). None of this is dishonest — the annotations are candid — but the ledger's status column no longer answers "is this built?" reliably.

**Recommendation:** a periodic status-reconciliation pass; consider a separate "built" column so decision status and build status stop sharing one field.

### ARCH-16 — Vestigial code and stale references
**Severity:** low
**Location:** `ccp/app/src/lib/permissions.ts:36`; `ccp/app/src/types/manifest.ts:245-248`; `ccp/api/src/routes/projects.ts:1200, 1214, 1306, 1320`; `ccp/api/src/domain/apply/terraformExecutor.ts:52-56`; `ccp/api/src/errors.ts:6`

Accumulated residue, each individually documented but collectively adding reader load: `requestableServices` (no production consumer; deferred by ADR-0022 action item 4 to a simplify pass that has not happened); the retired-but-present `autoEligible` manifest field; two `CommitInput.audit` declarations that can never be written (the hardcoded-`'loosening'` trust/deregister calls, self-annotated "istanbul ignore — loosening can never take the 200 branch"); `REAL_ESTATE_ROOT_SEGMENTS` denying `environments/prod`, `importer/prod`, `importer/bootstrap` — estate roots of the pre-split private monorepo that do not exist in this repository ("this repo's live estate roots" is now false, though the deny is harmless); `errors.ts` header citing `ccp/docs/specs/ccp-api.md`, a path that does not exist (the doc is `ccp/docs/API-SPEC.md` / the OpenAPI YAML).

**Recommendation:** run the deferred simplify pass; update the two stale prose references.

---

## Minor observations

- **Drift proposal submit is a second request-creation site.** `routes/drift.ts:789-807, 1005-1010` build `RequestItem`s directly rather than through the submit handler; mitigated well (same `validateSchedule`/`computeFeasibility`/ladder helpers, shared `ScheduleSchema` export at `requests.ts:41`), but the item shape now has two authors to keep aligned.
- **`DRIFT_DISARMED` deliberately bypasses the error taxonomy** to avoid touching the pinned `errors.test.ts` enumeration (`routes/drift.ts:20-29`) — the pin is doing its job, but "add codes inline to avoid the registry" is a pattern that will erode the taxonomy if it spreads (it already covers `BUNDLE_DISARMED` too).
- **`importer/kit` and `importer/kit-azure`** are parallel per-provider Python toolkits with similar module rosters (`discover.py`, `gen-imports.py`, `normalize.py`); per-provider duplication is a defensible choice at n=2 but worth a shared core before a third provider.
- **The api's Docker image ships a docker CLI** for the armed lanes (`api/Dockerfile:37-49`), inert without the `docker-compose.armed.yml` socket overlay — coherent with the armed-lane design, but another reason ARCH-3's built-in gate runner would simplify the deployment story.
- **`middleware/session.ts`'s three Bearer-lane CSRF exemptions** are exact-path predicates, deliberately not folded together (`:96-145`) — good boundary hygiene worth preserving as lanes multiply.
- **DOMAIN-MODEL.md's own currency** is honestly managed but visibly straining: newer rows annotate that neighboring fields were "not individually re-verified here, a pre-existing gap" (§2.1 Project row). The doc's regeneration commands exist; running them wholesale hasn't happened since 2026-07-17.

---

## Overall grade: **B**

The fundamentals are excellent — genuinely clean layering, a disciplined store seam, a consistently applied off-by-default arming doctrine, a structurally-enforced "ships blank" principle, an audit chain treated as architecture, and documentation discipline (FUNDAMENTALS map, code-cited domain model with self-reported caveats, honest ADR supersession) that most codebases never reach. What holds it at B rather than A is that the three high findings all sit on the product's two load-bearing promises: the multi-account principle (ARCH-2: the armed lanes are single-estate by construction, in direct tension with ADR-0015's binding "seam-now" rule) and the reviewed-equals-applied guarantee (ARCH-1: the bundle route accepts pre-quorum requests against ADR-0016's contract; ARCH-3: the R-gate/digest enforcement is delegated to unverifiable operator shell strings). These lanes are disarmed by default, which contains the blast radius today — but they are also the direction the product is explicitly heading, and several medium findings (dual catalogs, status-vocabulary drift, the app→api package inversion) are known tensions the team documented months-in-repo-time ago without retiring. The architecture is coherent; its newest growth (armed lanes, data plane) has outpaced the seams the older decisions promised.
