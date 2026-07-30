# API Backend Correctness Audit — ccp/api

Audit date: 2026-07-26
Dimension: `api-correctness` — functional correctness of the Node/Hono backend (`ccp/api/src`)

---

## Scope & method

Read in full (every line):

- Entry/config surface: `ccp/api/src/index.ts`, `server.ts`, `deploy.ts`, `appEnv.ts`, `clock.ts`, `manifests.ts`, `projects.ts`, `errors.ts`
- Every module under `src/domain/`: `schedule.ts`, `cooling.ts`, `exposure.ts`, `eligibility.ts`, `requirement.ts`, `feasibility.ts`, `changeset.ts`, `config.ts`, `bundle.ts`, `audit.ts`, `auditQuery.ts`, `dualControl.ts`, `settlement.ts`, `readiness.ts`, `systemOps.ts`, `drift.ts`, `driftProposals.ts`, `driftCheck.ts`, `scanner.ts`, `projectData.ts`, `projectsLifecycle.ts`, `onboardToken.ts`, `forgeCredentials.ts`, and the whole `apply/` subsystem (`loop.ts`, `scheduler.ts`, `executor.ts`, `terraformExecutor.ts`, `notify.ts`)
- Every route file: `routes/requests.ts`, `routes/drift.ts`, `routes/admin.ts`, `routes/projects.ts`, `routes/projectData.ts`, `routes/scanJobs.ts`, `routes/auth.ts`, `routes/account.ts`, `routes/instance.ts`, `routes/migrate.ts`
- Middleware (`session.ts`, `authz.ts`, `rateLimit.ts`), auth helpers (`sessions.ts`, `totp.ts`, `credentials.ts`, `recovery.ts`, `account.ts`), stores (`configStore.ts`, `memoryStore.ts`, `fileStore.ts`, `snapshot.ts`, `schema.ts`, `planSummarySchema.ts`), `scripts/bootstrap.ts`
- Shared app-lib modules the server imports: `ccp/app/src/lib/permissions.ts`, `ccp/app/src/lib/dependsOn.ts`

Traced end-to-end: the request-to-PR pipeline (submit → validate → ladder → approve → quorum-met status decision → link-pr / plan-summary → apply bundle → scheduler auto-apply), the drift-report → proposal → drift-request pipeline, the settle-on-read state machine (`settleCooling` / `settleWindow`), and the dual-control propose/ack lifecycle. The test suite (70+ files, including the `scheduleWindowCheckParity` cross-check against the Go `catalogctl window-check` binary) could not be executed — `node_modules` is not installed in this environment — so all findings below are from code reading, each verified against the exact source lines cited.

Severity framing: this audit covers robustness/correctness only (cybersecurity explicitly out of scope). Auth-flow findings are treated as ordinary functional defects.

---

## Strengths

The core request/approval machinery is unusually carefully engineered:

- **One clock** (`src/clock.ts`), with every pure schedule function taking `now` as a parameter (`domain/schedule.ts:72`, `domain/apply/scheduler.ts:151`) so time behavior is deterministic and table-testable. Almost all call sites honor this discipline (one exception — see API-11).
- **Schedule arithmetic is a single module** (`domain/schedule.ts`) with a shared `analyzeTime` core so `evaluateTime` (the windowcheck.go mirror) and `applyGate` (the richer SPA gate) cannot diverge on what "cooling / before-window / expired" mean; V1–V6 validation normalizes every stored schedule (`validateSchedule`, `schedule.ts:72-95`) and `windowEndOf` makes legacy rows total (`schedule.ts:103-109`). A parity test (`test/scheduleWindowCheckParity.test.ts`) pins the TS port to the real Go binary verdict-for-verdict.
- **Lazy settle-on-read is idempotent and race-safe**: `settleCooling` (`domain/cooling.ts:41-83`) and `settleWindow` (`domain/schedule.ts:285-328`) both write under `ifEquals status` guards, re-read on a lost race, and distinguish "someone else settled it" from chain contention. Cooling settles before window expiry at every call site so a row can traverse two transitions in one touch (`routes/requests.ts:526`).
- **The 0037 approval ladder is structurally positional** (`domain/exposure.ts:76-78`): the Nth signature fills `ladder[N-1]`, so L3-before-L2 is unrepresentable; distinct-signer dedup is a separate `approvalKey` row with `ifNotExists` (`routes/requests.ts:609-610, 692`); the tighten-only re-gate (`domain/requirement.ts:37-48`) recomputes the effective tier per item across change sets and can only raise the bar; unknown exposure fails closed to the engineer tier (`exposure.ts:26-37`).
- **Hash-chained audit with a real CAS head** (`domain/audit.ts:153-170`): audit puts and the conditional CHAINHEAD update ride the same transaction as the domain write, monotonic ULIDs keep SK order equal to creation order, and `verifyChain` is the single implementation shared by `/readyz`, the export endpoint, and the offline snapshot tools.
- **Server-side re-validation everywhere**: manifest param bounds re-checked with the exact client predicate (`manifests.ts:47-72`, `@app-lib/dependsOn`), the repeated-block branch correctly avoids misreading instance-count bounds as field-count bounds (`manifests.ts:81-101`), Azure tag-map case-folding collisions refused (`manifests.ts:125-132`), prototype-pollution-aware class maps (`driftProposals.ts:311`, `drift.ts:347`).
- **Drift eligibility is re-derived at submit, never trusted from the proposal** (`routes/drift.ts:633-687`), with the duplicate-address fold (`foldVerdictsByAddress`/`addressEligibleFor`, `driftProposals.ts:514-534`) refusing an address whose verdicts disagree, and the atomic submitted-flip riding the same transact as the request put (`routes/drift.ts:838-849`).
- **Fail-closed deployment posture**: production preflight (`deploy.ts:125-153`), bootstrap refusal on any present data file (`server.ts:63-80`), FileStore refusing an empty snapshot (`fileStore.ts:47-56`), settlement refusing bare legacy rows without `CCP_LEGACY_PROJECT_ID` (`domain/settlement.ts:155-165`), and every optional lane (`CCP_BUNDLE`, `CCP_DRIFT*`, `CCP_SCHEDULER`, `CCP_SCANNER`) genuinely off by default.
- **Idempotent submit** with a `(project, requester, key)` marker committed in the same transaction (`routes/requests.ts:472-503`) and version allocation loops that correctly retry allocation races (`routes/projectData.ts:274-328`, `routes/drift.ts:350-435`).
- **The store seam faithfully mirrors DynamoDB conditional semantics** — phase-1 condition validation against the pre-transaction snapshot, fail-closed `ifEquals` on a missing item (`memoryStore.ts:63-95`) — and FileStore's atomic snapshot writes (temp + fsync + rename, serialized chain) are crash-safe (`fileStore.ts:79-99`).

---

## Findings

### API-1 — Synchronous child-process execution freezes the whole API for minutes at a time
**Severity: high**
**Location:** `ccp/api/src/domain/bundle.ts:112-124`, `ccp/api/src/domain/driftProposals.ts:812-843` and `1051-1077`, `ccp/api/src/routes/requests.ts:922-926`, `ccp/api/src/routes/drift.ts:1101`, `ccp/api/src/domain/driftCheck.ts:49-61`

Three lanes shell out with `spawnSync` on the request path of a single-threaded Node process:

1. `POST /requests/:id/apply` calls `runBundle(realSteps(cfg), …)` inline (`requests.ts:922`). `realSteps` uses `spawnSync` with a 5-minute timeout per git command and **15 minutes** for the gate and trigger commands (`bundle.ts:113-124`). The entire event loop is blocked for the duration — every other request, including `/healthz` and `/readyz`, stalls, so an external orchestrator will kill the process mid-apply.
2. `PUT /projects/:id/drift` claims its proposal generation is "fire-and-forget (never awaited), so the CI PUT never blocks on a git clone" (`routes/drift.ts:423-431`). This is false: `scheduleDriftGeneration` → `runQueueDrainingLoop` → `generateDriftProposalsOnce` executes **synchronously up to and including `runDriftGen`** (there is no `await` before it — `driftProposals.ts:880-900`), and `runDriftGen`'s `prepare()`/`generate()` are `spawnSync` git clone (5 min timeout) + generator command (10 min timeout) (`driftProposals.ts:812-843`). The 201 response cannot flush until the clone and generation complete, and the whole server is frozen meanwhile.
3. `POST /:id/drift/check` awaits `runDriftCheck(realDriftCheckSteps(cfg), id)` whose trigger is `spawnSync` with a 5-minute timeout (`driftCheck.ts:52-58`).

**Impact:** whenever any of these armed lanes runs, the API is unavailable to all users for up to minutes; liveness probes fail; concurrent bundles/generations serialize invisibly. The design intent stated in the code ("the CI upload never blocks") is not what the code does.
**Recommendation:** replace `spawnSync` with async `execFile`/`spawn` (the pattern `terraformExecutor.ts` already uses via `promisify(execFile)`), or move the work to a worker thread/queue. At minimum, make `runDriftGen` genuinely asynchronous (e.g. `setImmediate`/`await`-yield before `prepare()`).

### API-2 — HALTED_* and orphaned APPLYING requests are unrecoverable dead-end states
**Severity: high**
**Location:** `ccp/api/src/domain/apply/scheduler.ts:50-51, 199-204`; `ccp/api/src/routes/requests.ts:112, 121, 1066-1071`

The scheduler introduces three statuses — `APPLYING`, `HALTED_DRIFT`, `HALTED_APPLY_FAILED` — that **no route can ever transition out of**:

- approve/reject act only on `OPEN_STATUSES = {AWAITING_CODE_REVIEW, NEEDS_ENGINEER}` (`requests.ts:112, 589, 723`);
- cancel acts only on `CANCELLABLE_STATUSES = {APPROVED_COOLING, AWAITING_DEPLOY_APPROVAL, WINDOW_EXPIRED}` (`requests.ts:121, 985`);
- rewindow requires `WINDOW_EXPIRED` or a not-yet-open `AWAITING_DEPLOY_APPROVAL` (`requests.ts:1067-1071`);
- the bundle requires `BUNDLE_ELIGIBLE = {AWAITING_CODE_REVIEW, AWAITING_DEPLOY_APPROVAL}` (`requests.ts:880`);
- the scheduler itself refuses to touch an `APPLYING` row forever ("Already claimed by a (possibly still-running or crashed) worker — NEVER re-apply", `scheduler.ts:199-204`), and only transitions `HALTED_*` … from nothing (no code path reads those statuses at all).

The halt messages promise "routed to a fresh plan/review" (`scheduler.ts:119, 126, 133`) but no such route exists. A worker crash between the claim (`AWAITING_DEPLOY_APPROVAL → APPLYING`, `scheduler.ts:254`) and the outcome write permanently wedges the request in `APPLYING` — not cancellable, not re-windowable, not re-appliable, invisible to `maxOpen` accounting.
**Impact:** any halt or mid-apply crash strands an approved change permanently; the only remedy is manual store surgery on the JSON snapshot.
**Recommendation:** add an operator verb (lead/admin) to move `HALTED_*`/stale `APPLYING` back to `AWAITING_DEPLOY_APPROVAL` or `CANCELLED` (with audit), and/or a claim lease (timestamp on `APPLYING`) after which the scheduler may reclaim.

### API-3 — Arming the scheduler halts every scheduled request: nothing ever writes the plan pin it requires
**Severity: high**
**Location:** `ccp/api/src/domain/apply/scheduler.ts:225`; `ccp/api/src/store/schema.ts:428-435`

`processOne` halts with `NO_PINNED_PLAN` unless `isPinIntact(req)` — which requires non-empty `pinnedDiff` + `planDigest` (`scheduler.ts:79-87, 225`). But no route or domain code ever writes `pinnedDiff`/`planDigest` onto a request: the schema's own comment says they are "Written at approval time by a LATER step" (`schema.ts:428-433`), and a repo-wide grep confirms the only writers are test helpers and the standalone proof script (`scripts/proof-terraform-executor.ts`). Consequently, the moment an operator sets `CCP_SCHEDULER=1` (the documented switch, logged at boot — `server.ts:134-141`), the first tick after any approved window opens flips that request `AWAITING_DEPLOY_APPROVAL → HALTED_DRIFT` — which, per API-2, is unrecoverable.
**Impact:** turning on the documented auto-apply feature destroys (not merely skips) every scheduled approved request that reaches its window. The boot log ("held requests stay AWAITING") describes only the misconfigured-executor case, not this one.
**Recommendation:** treat a missing pin as *skip* (leave `AWAITING_DEPLOY_APPROVAL`, notify) rather than *halt*, until the pin-writing approval step actually exists; or refuse to arm the loop while no pin-writer is deployed.

### API-4 — The bundle "claim" is not a mutual-exclusion, and a crashed bundle wedges the request at `running`
**Severity: medium**
**Location:** `ccp/api/src/routes/requests.ts:906-919, 946-960`

Two defects in `POST /requests/:id/apply`:

1. The claim writes `bundle:{state:'running'}` guarded by `ifEquals: {attr:'status', value: req.status}` (`requests.ts:914`) — but the claim does not change `status`, so the guard does not exclude a concurrent second apply. Two concurrent requests that both read `req.bundle === undefined` both pass the `state === 'running'` check (`:906`) and both win their claims; both then run `runBundle`. The git CAS push means only one commit lands, but the gate/trigger commands run twice and the losing outcome write clobbers/duplicates events.
2. If the process crashes (or `runBundle`/`writeFileSync` throws) between the claim and the outcome write, `bundle.state` stays `'running'` forever, and `:906` returns `BUNDLE_RUNNING` on every retry. Only `'failed'` is re-runnable; there is no route that resets `'running'`.

**Impact:** double-fired gate/trigger under concurrency; a single crash permanently blocks the one-click apply for that request.
**Recommendation:** guard the claim on the *bundle* attribute (e.g. `ifEquals {attr:'bundle', value: req.bundle ?? null}` or a dedicated claim row with `ifNotExists`), and stamp the claim with a timestamp so a stale `'running'` (older than the max step timeout) is re-claimable.

### API-5 — Cancel can race an in-flight bundle: the change applies but the request reads CANCELLED
**Severity: medium**
**Location:** `ccp/api/src/routes/requests.ts:970-1038` vs `:908-961`

`CANCELLABLE_STATUSES` includes `AWAITING_DEPLOY_APPROVAL`, and the bundle claim leaves `status` unchanged (API-4), so a cancel issued while a bundle is mid-flight succeeds (`ifEquals status == AWAITING_DEPLOY_APPROVAL` still holds). The bundle then lands the CAS commit on `main` and fires the CI apply trigger; its final status-guarded outcome write fails twice and surfaces `CHAIN_CONTENTION` (409) to the lead (`:951-958`). Net result: infrastructure change applied, request permanently recorded `CANCELLED`, bundle stuck at `'running'`, and the audit chain carries no bundle outcome entry.
**Impact:** the durable record contradicts reality on exactly the class of request this system exists to govern. Window is real (the bundle takes minutes; cancel is a single click).
**Recommendation:** have cancel refuse (or require confirmation) when `bundle.state === 'running'`; on the bundle's lost outcome write, record a standalone audit entry ("bundle landed sha X but request moved to <status>") instead of throwing.

### API-6 — The 72-hour dual-control expiry is dead code: `sweepExpired` has no callers and `ackPending` never checks `expiresAt`
**Severity: medium**
**Location:** `ccp/api/src/domain/dualControl.ts:216, 239-265, 347-358`; `ccp/api/src/routes/admin.ts:1144-1176`

Every pending loosening change is stamped `expiresAt = now + 72h` (`dualControl.ts:216`), and `sweepExpired` exists to flip stale PENDING rows to EXPIRED — but nothing outside tests ever calls it (repo-wide grep: only `dualControl.test.ts`), and `ackPending` validates status/self-ack/drift-guard but never `expiresAt` (`:246-265`). So a privilege-loosening proposal (senior grant, policy downgrade, freeze-off, project trust) can be acked weeks or months after proposal; the `EXPIRED` status is unreachable in production. Secondary defects in `sweepExpired` itself if it is ever wired: it rewrites the row with an **unguarded** `store.put` from a stale snapshot (a concurrent ack that just APPLIED the change gets clobbered back to EXPIRED), and it writes no audit entry for a governance-record state change (also flagged in `ccp/docs/DOMAIN-MODEL.md:287`).
**Impact:** the documented time-bound on the second-control window is not enforced; stale proposals against unchanged targets (settings at the same version, fresh accounts) replay cleanly long after context changed.
**Recommendation:** check `expiresAt` inside `ackPending` (refuse with `STATE_CONFLICT`/a new code), call `sweepExpired` from `GET /admin/config-changes`, and give the sweep an `ifEquals status=PENDING` guard + audit entry.

### API-7 — Scheduler ignores `earliestApplyAt`: a still-cooling request auto-applies the moment its window opens
**Severity: medium**
**Location:** `ccp/api/src/domain/apply/scheduler.ts:90-92`; inconsistency at `ccp/api/src/routes/requests.ts:652` vs `:1094`

`windowOpen` evaluates `evaluateTime(req.schedule, undefined, now)` — passing `undefined` for `earliestApplyAt` — so the COOLING gate that `applyGate` composes for every human-facing read (and that the store schema documents: "a windowed interim completion stays AWAITING_DEPLOY_APPROVAL with cooling composed as an applyGate reason", `schema.ts:361-373`) is invisible to the auto-apply scheduler. A legacy row with a future `earliestApplyAt` and an open window is `isDue` and gets claimed/applied during its cooling-off. Relatedly, the quorum-met eager-infeasibility check passes `undefined` (`requests.ts:652`) while rewindow passes `req.earliestApplyAt` (`requests.ts:1094`) — the same predicate fed inconsistently, so a cooling-outlasts-window row is caught at rewindow but not at approve.
**Impact:** limited to rows carrying `earliestApplyAt` (legacy interim-profile data), but for those the compensating-control delay is silently bypassed by the machine lane while every human lane enforces it.
**Recommendation:** pass `req.earliestApplyAt` through `windowOpen`/`isDue` (the verdict logic already handles it), and align `requests.ts:652` with `:1094`.

### API-8 — Freeze-held `kind:'now'` requests dead-end in AWAITING_DEPLOY_APPROVAL after the freeze lifts
**Severity: medium**
**Location:** `ccp/api/src/routes/requests.ts:665-667`; `ccp/api/src/domain/schedule.ts:286`; `ccp/api/src/domain/apply/scheduler.ts:90-92`

At quorum-met during a freeze, any schedule (including `kind:'now'`) is parked in `AWAITING_DEPLOY_APPROVAL` with a `held_frozen` event (`requests.ts:665-667`). Once the freeze lifts, no code path ever completes such a request: `settleWindow` returns immediately for `kind:'now'` (`schedule.ts:286`), the scheduler only considers windowed rows (`scheduler.ts:91`), and the bundle route is disarmed by default. The identical request approved one minute after unfreeze would be stamped `APPLIED` instantly (`requests.ts:672-673`), so the held row's terminal fate depends entirely on which side of the freeze the last signature landed — with cancel as its only exit.
**Impact:** approved changes silently stranded in a pending state indefinitely; requesters see "Fully approved — held" forever.
**Recommendation:** settle `kind:'now'` + `AWAITING_DEPLOY_APPROVAL` rows to `APPLIED` on read once unfrozen (a `settleFrozenHold` sibling of `settleWindow`), or re-run the quorum-met decision on unfreeze.

### API-9 — Project deregistration leaves orphaned satellite rows; a reused id inherits the previous tenant's state
**Severity: medium**
**Location:** `ccp/api/src/domain/projectsLifecycle.ts:65-80`; `ccp/api/src/routes/projects.ts:710-722`

The deregister-ack cleanup deletes only `UPLOADTOKEN#`, `ONBOARDTOKEN#`, and `DATA#v` rows plus the on-disk data dir. Surviving rows under the same `PROJECT#<id>` partition: `FORGECRED` (the sealed forge credential), every `SCANJOB#`, every `DRIFT#v…` report row, the `DRIFT#latest` pointer, and every `DRIFTPROP#` proposal row. Registration only checks the META row for collision (`routes/projects.ts:601`), so re-registering the same id yields a "fresh" project that: (a) resolves the *previous* operator's forge credential at scan-claim time (`routes/scanJobs.ts:214-231`), (b) carries a drift pointer aimed at deleted files (GET serves the confusing `connected:true, report:null` degraded state, `routes/drift.ts:461-469`), and (c) lists stale proposal rows.
**Impact:** cross-lifecycle state bleed; wrong credential used to clone a new tenant's repository; misleading drift status.
**Recommendation:** extend the cleanup prefix list to `FORGECRED`, `SCANJOB#`, `DRIFT#`, `DRIFTPROP#` (a single `store.query(pk)` + filtered delete would future-proof it).

### API-10 — Session revocation can be silently undone by the idle-slide write-back race
**Severity: medium**
**Location:** `ccp/api/src/auth/sessions.ts:83-85` vs `:89-95, 118-127`; `ccp/api/src/routes/account.ts:256-282`

`resolveSession` slides the idle window with an unconditional full-item `store.put(slid)` after its `get`. `killAllSessions`, `killOtherSessions`, and `DELETE /auth/sessions/:id` revoke by *deleting* rows without bumping `sessionVersion` (deliberately, to keep the caller's session alive). If a request from the victim session is in flight when the delete lands — `get` returned the row, delete executes, then `put(slid)` runs — the put **recreates the deleted session row**, and the revocation is undone for up to the absolute expiry (idle keeps sliding on subsequent requests). A polling SPA makes an in-flight request at the moment of revocation likely, and `killOtherSessions` deletes rows one-by-one, widening the window. (Admin flows that bump `sessionVersion` — reset, revoke-sessions — are unaffected: resolve fails the version check regardless of the row.)
**Impact:** the self-service "sign out other devices" and single-session revoke features do not reliably revoke.
**Recommendation:** make the slide a conditional update (`ifEquals` on `lastSeenAt` or an existence-guarded update — the store's `ifEquals` already fails closed on a missing item), or tombstone revoked session SHAs.

### API-11 — Audit-chain read path bypasses the injected clock and truncates at 120 months
**Severity: low**
**Location:** `ccp/api/src/domain/auditQuery.ts:48-55`

`readAuditChronological` starts its backward month-walk from `new Date()` — the real clock, not `clock.ts` — breaking the "all server time reads go through here" contract (`clock.ts:1-5`). Entries are partitioned by the *write-time* clock (`audit.ts:131` uses `yyyymm(new Date(at))` where `at` comes from `nowIso()`), so under a frozen/advanced test clock (or real backwards clock adjustment across a month boundary) entries can land in a month the walk never visits — the collected count falls short, `verifyChain` sees a truncated chain, and `/readyz` reports a broken chain (503) for an intact store. Independently, the hard 120-iteration bound silently truncates any chain with activity spanning >10 years, permanently failing verification.
**Recommendation:** use `nowDate()` from `clock.ts`, and walk from `max(now, lastUlid's timestamp)`; either derive the month range from the head's `lastUlid` or continue past empty months until `count` is satisfied.

### API-12 — `prNumberFromUrl` extracts a "PR number" from any URL ending in digits
**Severity: low**
**Location:** `ccp/api/src/routes/requests.ts:151-154`

The regex `/\/(\d{1,9})\/?$/` matches the trailing path segment of *any* https URL — `https://github.com/org/repo/issues/42` records `prNumber: 42`, and `https://example.com/9999` records `9999` — despite the doc comment restricting it to "a `/pull/123`-shaped URL tail". The stored `prNumber` then renders in timeline labels and the SPA link text.
**Recommendation:** require `/pull/<n>` (or the GitLab `/merge_requests/<n>`) in the pattern, or only derive when the host/path shape matches a known forge.

### API-13 — `maxOpen` rate-limit counts a nonexistent status and misses real open states
**Severity: low**
**Location:** `ccp/api/src/middleware/rateLimit.ts:26`

`OPEN_STATUSES` includes `'CHANGES_REQUESTED'`, which no code in the repository ever writes (vestigial), and excludes `WINDOW_EXPIRED`, `APPLYING`, and `HALTED_*`. A `WINDOW_EXPIRED` request is explicitly non-terminal (re-windowable, cancellable) yet frees its requester quota slot, so a requester can hold `maxOpen` live requests plus an unbounded backlog of expired-but-rewindowable ones.
**Recommendation:** align the set with the real state machine (add `WINDOW_EXPIRED`, `APPLYING`, `HALTED_*`; drop `CHANGES_REQUESTED` or implement it).

### API-14 — Conditional-write collisions inside `transactWithAudit` surface as the wrong error
**Severity: low**
**Location:** `ccp/api/src/domain/audit.ts:210-233`; e.g. `ccp/api/src/routes/admin.ts:673-724`

`transactWithAudit`'s own doc warns that callers carrying their own dedupe condition must not use it — but several do. Example: admin enroll (tightening path) races a concurrent registration of the same username; the account `ifNotExists` collision is retried once (against the same collision) and then thrown as `409 CHAIN_CONTENTION` ("the audit chain is busy; please retry") instead of `DUPLICATE_USERNAME`. Same pattern for team creates and the instance PUT (which at least maps it to `INSTANCE_STALE` explicitly — `routes/instance.ts:114-133`).
**Recommendation:** after a `CHAIN_CONTENTION` from `transactWithAudit`, re-read the domain key and return the domain-accurate conflict (the instance route's pattern), or hand-roll the loop as approve/submit do.

### API-15 — A dangling idempotency marker makes its key permanently unusable
**Severity: low**
**Location:** `ccp/api/src/routes/requests.ts:258-265, 487-503`

If an idempotency marker exists but its referenced request row does not (partial deletion, manual surgery, or any future request-delete feature), the pre-check falls through (`prior` null), the handler builds a new request, and the transaction's marker `ifNotExists` put fails; the recovery path re-reads the marker, finds the same dangling `requestId`, gets `prior === null` again, retries, and finally throws `CHAIN_CONTENTION`. Every submit with that key 409s forever.
**Recommendation:** when the marker exists but the request is missing, either overwrite the marker (treat as stale) or return a specific conflict naming the stale marker.

### API-16 — Bundle workspace leaks and unchecked git steps
**Severity: low**
**Location:** `ccp/api/src/domain/bundle.ts:136-139, 146-152`

`prepare()` removes the temp clone dir on clone failure but not on `rev-parse` failure (the early `{error}` return at `:138` skips both its own `rmSync` and `runBundle`'s `finally` cleanup, which only runs on prepare success) — leaking a full clone under `tmpdir()` per occurrence. In `commit()`, the `git add -A` exit status is ignored and the post-commit `rev-parse` result is used unchecked (`sha` could be an error string on a pathological failure).
**Recommendation:** `rmSync` in the rev-parse failure arm; check `add`'s status; verify `sha` matches `/^[0-9a-f]{7,64}$/` before pushing/recording.

### API-17 — Store-seam divergences from the DynamoDB semantics it mirrors
**Severity: low**
**Location:** `ccp/api/src/store/memoryStore.ts:63-95`

Two latent traps in the otherwise faithful transact implementation: (a) `ifEquals` compares with `!==` on `unknown` — every current guard value is a scalar (versions, statuses) or `undefined`, but the first caller to guard on an object/array (e.g. a `roles` map) will get a condition that can never pass (reference inequality against a cloned item); (b) a batch may contain two writes to the same key — DynamoDB `TransactWriteItems` rejects that, this store applies both with last-wins, so a bug that queues duplicate keys passes locally and would fail on the planned DynamoDB backend.
**Recommendation:** deep-equal (`canonicalJson`) for `ifEquals`; assert key uniqueness per batch.

### API-18 — Legitimize endpoint mints unlimited duplicate engineer requests for the same digest
**Severity: low**
**Location:** `ccp/api/src/routes/drift.ts:1040-1053`

By design the revert proposal row is not consumed by legitimize ("stays open; both paths remain visible"), but nothing else deduplicates either — repeated `POST /:id/drift/security/:digest/legitimize` calls each create a fresh `NEEDS_ENGINEER` request bound to the same digest (only the submit rate limit slows it). The adopt/revert submit lane, by contrast, atomically flips the proposal to `submitted` exactly once.
**Recommendation:** record `legitimizeRequestId` on the proposal row (without changing its `open` status) and refuse a second create while that request is open, or at least surface the prior request in the response.

### API-19 — `settleCooling` stamps `APPLIED` during a change freeze, bypassing the freeze veto
**Severity: medium**
**Location:** `ccp/api/src/domain/cooling.ts:29` (`coolingTargetStatus`), `:41-83` (`settleCooling`); contrast `ccp/api/src/routes/requests.ts:780,789-791` (the approve handler's freeze gate)

The approve handler treats "no request may RECORD an apply during a freeze" as binding (0024 §2.2/§2.6.1): at quorum-met it checks `isFrozen` and parks a `kind:'now'` request in `AWAITING_DEPLOY_APPROVAL` with a `held_frozen` event instead of stamping `APPLIED`. `settleCooling` — the lazy settler for an interim-profile request whose 24h cooling-off has elapsed — makes the *same* status decision via `coolingTargetStatus`, which reads only `schedule.kind` and **never consults the freeze**. So an `APPROVED_COOLING` + `kind:'now'` request whose cooling elapses during a freeze is stamped `APPLIED` by the next read that touches it, on any endpoint.

The two paths are the same decision reached at two different times, and only one of them enforces the veto. Which one a given request takes is decided by whether its risk profile attached a cooling-off period — i.e. the *higher-risk* requests are the ones that bypass the freeze.

Verified against the current code, not inferred: seeding an `APPROVED_COOLING` / `kind:'now'` row with an elapsed `earliestApplyAt` under `freeze.global = true` and calling `settleCooling` returns `APPLIED`.

**Recommendation:** give `settleCooling` the freeze state (resolved once per read, as the list path already does for API-8's release) and have a frozen `kind:'now'` settlement land in `AWAITING_DEPLOY_APPROVAL` with the same `held_frozen` event the approve handler writes — which `settleFrozenHold` (API-8) then releases when the freeze lifts. That makes one freeze rule with one implementation and one exit, rather than two decisions that disagree.

### API-20 — The one-time legacy settlement races itself: concurrent first requests get 409 CHAIN_CONTENTION on a plain read
**Severity: low**

> **DUPLICATE OF CONC-13 — fix once, close both.** This was raised from the observed symptom
> (three concurrent authenticated reads returning `200, 409, 409`) while working an unrelated
> finding, without first checking the concurrency report, where **CONC-13** already describes
> the same defect from the cause end: the loser's `ifEquals roles: undefined` guard fails,
> `transactWithAudit` exhausts its budget, and the resulting `ApiError('CHAIN_CONTENTION')` is
> not a `ConditionError`, so it escapes `runSettlement`'s deliberate fail-open catch. Same
> code, same race, same fix. Kept declared rather than deleted because a finding cannot be
> retired by removing it from a report; CONC-13 carries the recommendation, and closing it
> closes this. Recorded as a duplicate rather than quietly dropped because the *reason* it was
> missed is itself the lesson — see L-31.
**Location:** `ccp/api/src/middleware/session.ts:50` (`withSettlement`), `ccp/api/src/domain/settlement.ts:137,204,228` (`retroRegisterLegacyProject` via `transactWithAudit`)

`ensureSettlement` runs the one-time legacy-estate materialization inside the request path, on whichever authenticated requests arrive first. It writes through `transactWithAudit`, which retries once against a fresh chain head and then throws `CHAIN_CONTENTION`. With three concurrent first requests on an unsettled deployment, one wins and the other two surface **409 on a plain `GET`** — a read failing because two other reads were doing the same one-time bootstrap.

Self-healing (once settlement lands, later requests are unaffected) and confined to the first moments after a deployment upgrade, hence low. But it is a read returning a write-conflict error to a user who did nothing concurrent, and the retry budget is fixed at one regardless of how many callers are racing. Observed directly: three concurrent `GET /requests/:id` against a fresh store return `200, 409, 409`, with the stack in `retroRegisterLegacyProject`.

**Recommendation:** serialize settlement behind a single in-process promise (the same "one in-flight attempt, shared" shape `TerraformExecutor.init` uses after ERR-5) so concurrent callers await one settlement rather than racing N; or, on a lost settlement race, re-read and proceed rather than surfacing the conflict — the loser's work is already done by the winner.

---

## Minor observations

- **`GET /requests` settle cost.** The list endpoint runs `settleCooling` + `settleWindow` over every row sequentially (`routes/requests.ts:520-526`); the first read after a batch of windows expire performs one audited transaction per row, and each FileStore transaction re-serializes the entire store snapshot to disk (`fileStore.ts:79-85`) — O(N × store-size) I/O on a single GET.
- **FileStore error-after-apply.** A failed `persist()` (disk full) leaves the in-memory state mutated while the caller receives an error; the next successful write persists the "failed" mutation anyway (`fileStore.ts:58-71`). Divergence self-heals but the error signal is misleading.
- **Membership denials write to the audit chain.** `requireProjectMembership` appends a chained `project-scope-denied` entry per denied request (`middleware/authz.ts:56-71`) — unbounded chain growth and added head contention from repeated unauthorized/misconfigured clients.
- **Admin-but-not-lead drift asymmetry.** An `isAdmin` account without a lead role may trigger drift checks/generation (`isLeadOrAdmin`, `routes/drift.ts:93-95`) but receives only the requester-tier projection of the report it triggered (`richView` requires approver/lead, `routes/drift.ts:479-481`).
- **Drift PUT rollback races.** The file-write failure rollback restores the pointer with an unguarded put from the loop-local snapshot (`routes/drift.ts:408-415`); a concurrent successful upload's pointer advance can be clobbered. The audit chain also retains the upload entry for the rolled-back version (unavoidable, but worth an explicit compensating entry).
- **Relative default data dir.** `resolveDataFile` defaults to `.ccp-data` relative to CWD (`deploy.ts:46-50`); server and backup/restore scripts agree only if launched from the same directory.
- **`bootstrap.ts` seeds no `accountVersion`** (`scripts/bootstrap.ts:30-53`) — handled by `nextAccountVersion`'s `?? 0`, but inconsistent with the "every fresh row starts at 1" convention used by enroll and migrate.
- **`mintInstallationToken` percent-encodes `repo.owner` whole** (`forgeCredentials.ts:220`): a slash-bearing owner (legal in `RepoRef` for GitLab subgroups) would encode as `%2F` in a GitHub API path — unreachable today (`githubAppCanServe` requires github) but a latent trap if owner grammar tightening ever relaxes.
- **`validateParams` nested-array recursion** re-applies `minItems`/`maxItems` to inner arrays (`manifests.ts:109-113`) — only relevant if a manifest ever declares list-of-list params.
- **Cursor pagination of `/admin/audit`** loads and reverses the entire chain per page (`routes/admin.ts:675-689`) — correct, but O(chain) per request.

---

## Overall grade: B

**Justification.** The core governed pipeline — submit validation, the positional approval ladder, tighten-only re-gating, lazy settle-on-read, the hash-chained audit fold, drift-eligibility re-derivation, and the dual-control envelope — is exemplary: consistently fail-closed, race-aware (guarded transacts with honest lost-race handling everywhere), and cross-checked against its Go twin by a parity test. The defects cluster at the *edges* of the state machine and in the newer, default-off execution lanes: dead-end statuses with no recovery verbs (API-2), a scheduler that would halt everything it touches if armed (API-3), event-loop-blocking subprocess execution that contradicts the code's own non-blocking claims (API-1), an unenforced dual-control TTL (API-6), and several narrow but real races (API-4/5/10). None of these corrupts the durable record in the default configuration, which is why this is a B rather than lower — but three high-severity findings, two of which fire the moment a documented feature flag is turned on, keep it from an A.
