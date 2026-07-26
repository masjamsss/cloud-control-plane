# Concurrency & Race Conditions Audit — `ccp/api`

Audit date: unknown-date
Dimension: concurrency (finding prefix: CONC)
Auditor scope: the Node/Hono backend (`ccp/api`), plus its child-process seams (`domain/bundle.ts`, `domain/apply/terraformExecutor.ts`) and the runner entrypoint.

---

## Scope & method

Read in full (or in targeted depth) and traced for interleaving hazards:

- Stores: `ccp/api/src/store/configStore.ts`, `store/memoryStore.ts`, `store/fileStore.ts`, `store/schema.ts`
- Request pipeline: `src/routes/requests.ts` (submit / approve / reject / link-pr / plan-summary / apply / cancel / rewindow), `src/domain/cooling.ts`, `src/domain/schedule.ts` (`settleWindow`), `src/domain/audit.ts` (chain head OCC, `record`, `recordIn`, `transactWithAudit`)
- Apply subsystem: `src/domain/apply/loop.ts`, `scheduler.ts`, `executor.ts`, `terraformExecutor.ts`; bundle: `src/domain/bundle.ts`
- Auth/session: `src/auth/sessions.ts`, `credentials.ts`, `totp.ts`, `account.ts`, `recovery.ts` (via callers), `src/routes/auth.ts`, `src/routes/account.ts`, `src/middleware/session.ts`
- Admin/dual-control: `src/routes/admin.ts`, `src/domain/dualControl.ts`
- Rate limiting: `src/middleware/rateLimit.ts` (both the store-backed submit limiter and the in-memory upload token bucket)
- Registry/data plane: `src/routes/projects.ts` (trust-request, trust, identity), `src/routes/projectData.ts`, `src/domain/projectData.ts` (on-disk version store), `src/routes/drift.ts` (staging/pointer/rollback), `src/domain/driftProposals.ts` (the per-project generation runner)
- Machine lanes: `src/routes/scanJobs.ts`, `src/domain/settlement.ts`, `src/projects.ts` (known-projects cache), `src/routes/migrate.ts`, `src/routes/instance.ts`, `src/server.ts`, `src/index.ts`, `src/errors.ts`
- `ccp/runner/entrypoint.sh`

Method: static reasoning about `await` yield points in read-modify-write sequences on shared state (the single `ConfigStore` instance, module-level maps, on-disk files), verification of every conditional-write guard (`ifNotExists` / `ifEquals`) and every retry loop's behavior on a lost condition, and tracing what each retry replays (fresh vs. stale snapshots). No code was modified; no commands mutated the repo.

Key structural facts established first:

- Every audit-bearing write goes through `recordIn` (`src/domain/audit.ts:153-170`), which folds a `CHAINHEAD` update guarded by `ifEquals: {attr:'hash'}` into the caller's transaction. **Consequence: any two concurrent audited writes to the same project always contend at the chain head — one wins, the other gets `ConditionError` and enters its caller's retry loop.** Whether that retry is safe depends entirely on whether the caller rebuilds its domain writes from a fresh read. Some callers do (cancel, rewindow, settleCooling, settleWindow, scheduler); the most important ones do not (approve; everything routed through `transactWithAudit`, which replays the *same* `domainWrites` array on retry — `src/domain/audit.ts:210-233`).
- `MemoryStore.transact` (`src/store/memoryStore.ts:63-95`) is a faithful two-phase all-or-nothing batch; the map mutation is synchronous, so the store itself has no internal interleaving hazard.
- `FileStore` (`src/store/fileStore.ts`) captures the snapshot JSON synchronously at mutation time and serializes disk writes on a promise chain (`persist`, lines 79-85) — snapshot ordering is correct and crash-safe (temp + fsync + rename, lines 87-99).

---

## Strengths

The newer subsystems show deliberate, correct concurrency engineering; these patterns are the house style the remaining findings fail to follow:

1. **Audit chain optimistic concurrency** — the hash-chained head guarded by `ifEquals` on `hash` in the same transaction as the entry put (`src/domain/audit.ts:166-169`) makes chain forks unrepresentable, and per-project partitioning bounds contention.
2. **Scheduler single-apply claim** — `runDueApplies` claims a row with a CAS `AWAITING_DEPLOY_APPROVAL → APPLYING` before any `executor.apply` (`src/domain/apply/scheduler.ts:236-256`), the loop refuses re-entrant ticks with an `inFlight` flag (`src/domain/apply/loop.ts:111-132`), processing is deliberately sequential per project (scheduler.ts:194-208), and every status write is guarded + idempotently re-read on a lost race (`writeStatusWithAudit`, scheduler.ts:340-383).
3. **Scan-job claim is exactly-once** — one conditional write flips `queued → claimed` and moves the row out of the queue GSI atomically (`src/routes/scanJobs.ts:273-306`); status reports are validated against the *stored* status and guarded with `ifEquals` on it (lines 429-454).
4. **Lazy settlement is race-safe** — `settleCooling` (`src/domain/cooling.ts:63-81`) and `settleWindow` (`src/domain/schedule.ts:308-327`) guard on the exact prior status and, on a lost guard, re-read and return the row's true state instead of erroring; the list endpoint settles sequentially, explicitly to avoid self-contention (`src/routes/requests.ts:521-526`).
5. **Cancel and rewindow** guard on the observed status and re-read on retry, distinguishing a real state conflict from chain contention (`src/routes/requests.ts:1013-1038`, `1117-1145`).
6. **Submit idempotency** — an `idempotencyKey` marker rides the same atomic transaction as the request put with `ifNotExists` (`src/routes/requests.ts:472-503`), and a concurrent duplicate is detected in the catch and answered with the winner's request. This is a textbook double-submit defense.
7. **Approval distinctness** — the per-(request, signer) marker item with `ifNotExists` (`src/routes/requests.ts:609-610, 692, 700`) makes "the same person signs twice" unrepresentable even under races.
8. **Version allocation for uploads is CAS-based** — project-data staging allocates the version number by *winning* the metadata row's `ifNotExists` put, retrying once on a lost race, and only the winner writes files (`src/routes/projectData.ts:268-328`); drift staging does the same and advances its pointer in the same transaction (`src/routes/drift.ts:341-416`). On-disk version content is written to a temp dir and atomically renamed (`src/domain/projectData.ts:317-342`).
9. **Drift proposal generation** is a non-reentrant per-project async runner with collapsing queued versions — the check-and-set on `genState` happens synchronously before any `await`, which is sound in single-threaded Node (`src/domain/driftProposals.ts:1026-1076`).
10. **Dual-control drift guards** — `ApplySpec` carries `guardAttr`/`guardValue` (project `version`, account `accountVersion`), so a stale ack fails `STALE_PROPOSAL` instead of replaying an old snapshot, and `ackPending` explicitly distinguishes guard drift from chain contention in its retry (`src/domain/dualControl.ts:299-320`).
11. **The upload rate limiter is interleaving-free** — `checkUploadRateLimit` performs its whole read-modify-write synchronously with no `await` in between (`src/middleware/rateLimit.ts:71-93`), and eviction is bounded. Correct for Node's model.
12. **Instance identity is OCC done right** — a version-guarded write whose lost race is honestly mapped to `INSTANCE_STALE` (`src/routes/instance.ts:88-133`).
13. **Concurrent boot settlement is anticipated** — the marker put race is deliberately swallowed (`src/domain/settlement.ts:207-216`), and the "already settled" cache is keyed per store instance.
14. **The bundle's git CAS** — the push lands only as a fast-forward from the gated SHA, never `--force` (`src/domain/bundle.ts:145-155`), so a third-party commit between gate and land is structurally rejected.

---

## Findings

### CONC-1 — Concurrent approvals of the same request silently lose signatures (lost update via unguarded row put + stale retry)

- **Severity: high** (borderline critical — governance-record corruption with a possible permanent quorum deadlock)
- **Location:** `ccp/api/src/routes/requests.ts:688-707` (the approve transact loop; the unguarded `{ kind: 'put', item: updated }` at line 693, the stale `continue` at line 701)

The approve handler reads the request (line 586), computes `updated` with `approvals = [...req.approvals, {user, at}]` (line 622), and then writes it with a **plain, unconditional put** — there is no `ifEquals` on the request row (no status guard, no approvals-length/version guard; the schema's `eventSeq` field at `store/schema.ts:453` is never used). The transaction *does* contend at the audit chain head, but the retry loop re-reads **only the chain head** (line 689), never the request row, and replays the stale `updated`.

Failure scenario (two different reviewers, A then B, clicking approve near-simultaneously on the same 2-step request):
1. Both handlers read the row with `approvals: []` and the same chain head `H0`.
2. A's transaction commits: row has `approvals:[A]` (1/2), A's marker item exists, head is `H1`.
3. B's transaction fails on the head guard (`ifEquals hash=H0`). The catch checks B's own marker (absent → not `ALREADY_APPROVED`, line 700) and retries (line 701).
4. B's retry re-reads the head (`H1`) but replays the **stale** `updated` built from `approvals: []` → commits `approvals:[B]` (1/2), overwriting A's signature. Both markers now exist.

Result: the row records one signature while two people are marked as having signed; both are refused `ALREADY_APPROVED` forever (the markers survive, line 610). If A and B were the only eligible signers for the ladder (small teams are exactly the interim-profile case this product documents), the request is **permanently unable to reach quorum** without manual store surgery. The audit chain also becomes self-inconsistent: two `request-approve` entries both claim `before:0 → after:1`.

The same stale-retry writes back the whole row, so it can also resurrect a concurrently-changed status: if a reject (or cancel, or a scheduler claim) lands between B's read and B's retry, B's retry silently reverts it (a `REJECTED` request can end up `APPLIED` when B's approval completed the ladder).

**Recommendation:** make the approve write conditional on what was read — e.g. introduce a monotonic `revision` attribute on `RequestItem` (or use the existing `eventSeq`), write with `ifEquals: {attr:'revision', value: req.revision}`, and on any `ConditionError` **re-read the row**, re-run the eligibility/ladder computation, and rebuild `updated` before retrying (the exact pattern `settleCooling`/`writeStatusWithAudit` already implement). At minimum, guard on `status` *and* on `approvals` length via a counter attribute.

### CONC-2 — Reject, link-pr and plan-summary use unguarded full-row puts through `transactWithAudit`, which retries with the stale snapshot; this also defeats the scheduler's `APPLYING` claim

- **Severity: high**
- **Location:** `ccp/api/src/routes/requests.ts:746` (reject), `:812` (link-pr), `:874` (plan-summary); root cause shared with `src/domain/audit.ts:210-233` (`transactWithAudit` replays the same `domainWrites` on its internal retry)

All three handlers read the request, build a full replacement row, and `transactWithAudit` it with no row condition. Any concurrent write to the *same project* (not even the same request) trips the chain-head guard, and `transactWithAudit`'s retry replays the stale row verbatim. Concrete corruptions:

- **Approve vs. reject:** reject commits `REJECTED`; a racing approve (CONC-1's retry) or a racing link-pr's stale put flips it back. Conversely a reject replayed after an approve erases the approval from the row (markers remain → signer locked out, as in CONC-1).
- **The scheduler's single-apply invariant is only as strong as its weakest co-writer.** `scheduler.ts` documents (lines 26-33) that the CAS claim makes double-apply impossible — but link-pr/plan-summary/approve/reject write the whole row unconditionally. Sequence with `CCP_SCHEDULER=1` and the real terraform executor: scheduler claims `AWAITING_DEPLOY_APPROVAL → APPLYING` and enters `executor.apply` (minutes); a lead links a PR (`link-pr` read the row pre-claim, hits chain contention, retries stale) → the row reverts to `AWAITING_DEPLOY_APPROVAL` and the claim is erased mid-apply. The scheduler's outcome write then fails its `ifEquals status=APPLYING` guard and reports `skipped-moved` (scheduler.ts:296-297) — **a change that really applied is never recorded as applied**. The next tick re-plans, sees drift (the change is now live), and stamps `HALTED_DRIFT` — the durable record of an applied change says it halted and was never applied.
- Both link-pr and plan-summary also clobber each other's fields and any events appended in between (each rewrites the whole `events` array from its stale read).

**Recommendation:** same fix as CONC-1 — a row revision attribute guarded on every request-row write, with re-read-and-rebuild on retry. For narrow field updates (prUrl/prNumber, planSummary), prefer `kind:'update'` with only the touched attributes plus the guard, rather than whole-row puts.

### CONC-3 — The entire auth/self-service lane writes the account row with blind full-row puts, clobbering concurrent admin mutations and undermining the `accountVersion` drift-guard doctrine

- **Severity: high**
- **Location:** `ccp/api/src/routes/auth.ts:116` (login-failure counter), `:138` (login-success reset + re-hash), `:201` (TOTP `lastUsedAt` stamp), `:243` (first-login enroll), `:289/:303` (recovery), `:373` (change-password), `:426-438` (reauth); `ccp/api/src/routes/account.ts:132` (device confirm), `:184` (device remove), `:230` (recovery-codes regenerate); `ccp/api/src/routes/admin.ts:826` (reset-totp), `:847` (revoke-sessions)

Every one of these does `read account → await (often an argon2id verify/hash, i.e. a **deliberately slow ~50-200 ms yield window**) → store.put(full stale row)` with no condition. The store supports `ifEquals`; none of these use it. Consequences:

- **An admin disable can be silently undone.** Admin PATCH commits `{status:'disabled', sessionVersion+1, accountVersion+1}` (guarded — `admin.ts:516`). A login attempt for that account that started just before (its account read at line 96 predates the disable; the argon2 verify at line 103 spans the admin's commit) then blind-puts the stale row at line 116/138 — `status:'active'`, old `sessionVersion`, old `accountVersion` all restored. Role grants/revocations are lost the same way (any in-flight TOTP stamp, reauth, device mutation, or recovery write for that user restores the pre-mutation `roles` map).
- **The dual-control drift counter can be rewound.** `store/schema.ts:181-196` documents that *every* account mutation must bump `accountVersion` so a stale dual-control ack fails `STALE_PROPOSAL`. The blind puts restore the old counter value, so a pending proposal captured against the old state passes its guard again after an interleaved change — precisely the replay the counter exists to prevent. (The login-failure path additionally never bumps `accountVersion` at all.)
- **The lockout counter undercounts under parallel attempts.** N concurrent wrong-password requests all read `failedAttempts: 0` during each other's argon2 verifies and all write `1` (`auth.ts:107-116`); the 5-attempt backoff threshold is reached far later than intended. Same for `/auth/reauth` failures (`auth.ts:420-427`) and recovery-code failures (`auth.ts:283-289`).
- Self-service device add has a cap TOCTOU: two concurrent confirms both pass the `MAX_TOTP_DEVICES` check (`account.ts:121`) and one add is lost anyway (last-writer-wins on `totpDevices`).

**Recommendation:** route every account write through a guarded update: `ifEquals {attr:'accountVersion', value: <read value>}` + always bump, with a re-read-and-retry (or a 409 to the client) on a lost race. For pure counters (`failedAttempts`) prefer a narrow `kind:'update'` touching only the counter fields so it cannot clobber authorization fields even when it races.

### CONC-4 — A revoked session can be resurrected by the concurrent idle-window slide

- **Severity: medium**
- **Location:** `ccp/api/src/auth/sessions.ts:83-85` (the slide put), vs. `:89-95` (`killAllSessions`), `:118-127` (`killOtherSessions`), `ccp/api/src/routes/account.ts:256-269` (`DELETE /auth/sessions/:id`)

`resolveSession` slides the idle window by blind-putting the whole session item after two awaited reads. If a self-service revocation (`DELETE /auth/sessions/:id` or `POST /auth/sessions/revoke-others` — both deliberately do **not** bump `sessionVersion`) deletes that session between the read and the put, the put **re-creates the deleted item**, and the "revoked" session keeps working until idle/absolute expiry. The `sessionVersion`-bumping paths (password reset, admin revoke-sessions) are immune because a resurrected item fails the version check; the self-service paths are not. The user-visible contract ("sign out my other devices") is broken by any in-flight request on the session being revoked — which is the common case, since the point of revoking a session is that it is active.

**Recommendation:** make the slide a conditional update (`ifEquals` on `lastSeenAt` or an existence-guarded `kind:'update'` — note `MemoryStore.transact` already fails `ifEquals` on a missing item, `memoryStore.ts:70-80`), and treat a lost condition as "session gone → 401".

### CONC-5 — `POST /requests/:id/apply` runs the entire bundle with `spawnSync`, freezing the whole API (health checks included) for up to tens of minutes

- **Severity: high**
- **Location:** `ccp/api/src/domain/bundle.ts:112-125` (`sh`/`git` via `spawnSync`, timeouts 15 min and 5 min per invocation), invoked synchronously from the route at `ccp/api/src/routes/requests.ts:922`

`runBundle(realSteps(cfg), …)` is fully synchronous: clone (≤5 min), gate command (≤15 min), commit+push (≤5 min each), trigger (≤15 min) — all `spawnSync` on the event loop. While a bundle runs, the single-threaded server processes **nothing**: no other requests, no `/healthz`, no `/readyz`, no scheduler ticks. Two operational consequences: (a) any orchestrator with a liveness probe will kill the process mid-bundle — potentially after the push/trigger fired but before the outcome is recorded (see CONC-6), the worst possible crash point; (b) every concurrent user sees the API hang for the duration. The comparable subsystem (`terraformExecutor.ts`) got this right with async `execFile` (`terraformExecutor.ts:91,135-148`) and the schedulerGating test forbids spawns in `domain/apply/` — but the bundle lane has no such protection. (The feature is off by default behind `CCP_BUNDLE=1`, which is why this is high rather than critical.)

**Recommendation:** convert `sh`/`git` to async `execFile`/`spawn` (promisified, same timeouts). The route's CAS claim already protects against re-entry, so making the bundle async is safe; keep the claim, `await` the steps.

### CONC-6 — The bundle claim has no crash/exception/race recovery: `bundle.state:'running'` can stick forever, and a raced outcome write loses the record of a fired deploy

- **Severity: medium**
- **Location:** `ccp/api/src/routes/requests.ts:906-961` (claim at 913-919, no try/catch around `runBundle` at 922, outcome write guarded on `status` at 951, retry at 956-957)

Three related gaps in the otherwise-sound claim design:

1. **No exception path.** If `runBundle` throws (e.g. `writeFileSync` ENOSPC at `bundle.ts:91`, or an unexpected error in a step), the route has no catch: the response is a 500 and the row keeps `bundle.state:'running'`. Every future `POST /:id/apply` returns `BUNDLE_RUNNING` (line 906) — there is **no route, admin verb, or timeout anywhere that clears a stuck `running` state**. Same if the process dies mid-bundle (which CONC-5 makes likely). Permanent manual-surgery state.
2. **Cancel-during-bundle loses the outcome record.** `AWAITING_DEPLOY_APPROVAL` is cancellable (`CANCELLABLE_STATUSES`, requests.ts:121) and the claim does not change `status`, so a cancel can commit while the bundle runs. The outcome write is guarded `ifEquals status=<observed>` (line 951); it fails, retries with the same guard, fails again, and throws `CHAIN_CONTENTION` — after the CI trigger already fired. The bundle's audit entry (the "audit trail of record" per the comment at line 934) is never written, `bundle` stays `'running'`, and a cancelled request has a live deploy in flight with no recorded evidence.
3. The 502-vs-recorded coupling: because the audit write happens after the external effects, any store failure there also orphans a fired trigger.

**Recommendation:** wrap `runBundle` in try/finally that always writes a terminal bundle state (`failed` with the error) under a widened guard; record the outcome guarded on `bundle.state:'running'` (which cancel never touches) instead of on `status`; add a stale-`running` timeout or an admin unstick verb.

### CONC-7 — `FileStore` has no single-writer enforcement: two processes on the same data file silently destroy each other's writes

- **Severity: medium**
- **Location:** `ccp/api/src/store/fileStore.ts` (whole file — no lock file, no exclusive open, no boot-time claim); `ccp/api/src/server.ts:82` (any second process happily opens the same file)

Each process loads the snapshot into its own in-memory `Map` and, on every mutation, rewrites the **entire file** from its own map. Two processes (a rolling deploy where the new container starts before the old stops; an operator scaling the service to 2 replicas; a stray `npm run dev` against the production data dir) never see each other's writes and alternately overwrite the whole store — total, silent, mutual lost updates across accounts, sessions, requests, and both audit chains, behind green health checks. All the careful in-process OCC (chain head, CAS claims) is void across processes because the conditions are evaluated against each process's private map.

**Recommendation:** take an exclusive advisory lock (or an `O_EXCL` lock file with PID + liveness check) on the data file at `FileStore.open` and refuse to boot when it is held; document single-replica as a hard requirement in the compose files until the DynamoDB backend lands.

### CONC-8 — Every authenticated request triggers a full-store snapshot write; snapshot serialization is synchronous O(store) on the event loop

- **Severity: medium**
- **Location:** `ccp/api/src/auth/sessions.ts:83-85` (idle-slide put on every successful resolve, i.e. every authenticated request incl. GETs) × `ccp/api/src/store/fileStore.ts:79-85` (`persist`: `JSON.stringify(this.exportItems())` per mutation) × `ccp/api/src/store/memoryStore.ts:24-26` (`exportItems` `structuredClone`s and sorts every item)

The design ("full-snapshot-per-write, correctness beats write-amplification") is coherent for a small governance DB, but the session slide turns *every* request into a mutation: each one synchronously clones + sorts + stringifies the entire store on the event loop and enqueues a full-file fsync on the serialized `writeChain`. Under concurrent load, (a) event-loop stalls grow linearly with store size (thousands of requests/audit entries × per-request serialization), and (b) the write chain becomes a global queue — a caller's `await store.put(...)` latency includes every previously-enqueued snapshot's fsync. This compounds with CONC-5 (any stall lengthens the read-to-write race windows of CONC-1/2/3).

**Recommendation:** don't persist the idle slide on every request (slide at most once per N seconds per session, or hold `lastSeenAt` in memory with periodic flush — an idle-window heartbeat is not governance data); longer term, move snapshot serialization off the hot path (dirty-flag + debounced writer that still honors write-after ordering, or per-partition files).

### CONC-9 — Dual-control ack does not guard the pending row's status: a concurrently rejected proposal can still apply

- **Severity: medium**
- **Location:** `ccp/api/src/domain/dualControl.ts:249` (status checked only on the read snapshot), `:272-275` (the pending-row update carries no `ifEquals status:'PENDING'`), `:334-341` (reject's update is equally unguarded)

`ackPending` validates `status === 'PENDING'` on its read, then transacts `[applyToWrite(apply), update pending → APPLIED]`. If a reject commits in between (both are chain-head contenders, so the ack's first transact fails and retries), the ack's retry re-checks only the *apply target's* guard — the target didn't change, so the retry commits: the config change **applies** and the pending row flips `REJECTED → APPLIED`. An admin's explicit refusal is overridden by a racing ack. (Double-ack of the same proposal is in practice blocked by the apply's own `guardAttr`, which is why this is medium, not high.)

**Recommendation:** add `ifEquals: {attr:'status', value:'PENDING'}` to the pending-row update inside both `ackPending` and `rejectPending`, and on a lost guard re-read and report `STATE_CONFLICT`.

### CONC-10 — Stuck `APPLYING` after a worker crash has no reclaim or operator path

- **Severity: medium**
- **Location:** `ccp/api/src/domain/apply/scheduler.ts:199-204` (`APPLYING` rows are permanently `skipped-moved`); `ccp/api/src/routes/requests.ts:112,121` (`APPLYING` is neither approvable, cancellable, nor rewindowable)

The claim-first design intentionally never re-applies a claimed row ("possibly still-running or crashed worker — NEVER re-apply"), which is the right default — but a crash between claim and outcome write leaves the request in `APPLYING` forever: the scheduler skips it every tick, and no route accepts that status. There is no lease/expiry on the claim and no admin verb to resolve it to `HALTED_APPLY_FAILED`. Given CONC-5/CONC-7 make mid-work process death plausible, this is a real operational dead end requiring store surgery.

**Recommendation:** stamp a claim timestamp (`applyStartedAt`) and either let the scheduler transition `APPLYING` rows older than a generous lease to `HALTED_APPLY_FAILED` (never re-apply — halt for a human, preserving the invariant), or add an admin-only "resolve stuck apply" verb.

### CONC-11 — Registry writes that bump `version` without guarding it (trust-request upload, identity confirm) can clobber concurrent registry ops and rewind the dual-control version guard

- **Severity: medium**
- **Location:** `ccp/api/src/routes/projects.ts:1107-1121` (trust-request: full-row put, `version: project.version + 1`, no guard), `:1266-1275` (identity confirm: same pattern)

Other `ProjectItem` writers use `guardAttr:'version'` (trust decision at `projects.ts:1193-1197`, activate/archive/unarchive in `projectData.ts:379-383,424-430,460-467`), so the project row *has* an OCC discipline — these two handlers bypass it with unconditional full-row puts built from a stale read. A trust-request upload racing an identity confirm loses one of the two writes entirely; worse, because both *reset* `version` to `stale+1`, they can rewind the counter to a value a pending dual-controlled proposal captured, letting a genuinely stale ack pass its `version` guard against different row content (the exact class the guard exists to stop).

**Recommendation:** convert both to `kind:'update'` with `ifEquals {attr:'version', value: project.version}` and only the touched attributes, retrying from a fresh read on a lost guard.

### CONC-12 — The store-backed submit rate limiter is check-then-insert: concurrent submits breach both caps

- **Severity: low**
- **Location:** `ccp/api/src/middleware/rateLimit.ts:28-45` (`checkSubmitRateLimit` queries and counts), enforced at `ccp/api/src/routes/requests.ts:342` before an unrelated transact

N concurrent submits by the same requester all count the pre-existing rows during each other's in-flight creation and all pass, so `submissionsPerHour` and `maxOpen` can be exceeded by the concurrency factor. The overshoot is bounded (each racer adds one), the limits are coarse abuse guards rather than invariants, and the store has no atomic counter primitive — hence low. Worth a code comment at minimum; a counter item updated in the submit transaction would close it.

### CONC-13 — Concurrent first-boot settlement can escape its own race handling and 500 early requests

- **Severity: low**
- **Location:** `ccp/api/src/domain/settlement.ts:167-180` (`materializeBareAccountRows` writes via `transactWithAudit` with an `ifEquals roles: undefined` guard), `:203-216` (the catch swallows only `ConditionError`)

Two concurrent callers can both start settlement (acknowledged in the comment). The loser's per-account `ifEquals` guard fails against the winner's already-materialized row; `transactWithAudit` retries once, fails again, and throws **`ApiError('CHAIN_CONTENTION')`** — which is *not* a `ConditionError`, so it escapes the deliberate fail-open catch at line 215 and surfaces as an error on that request. Transient (the winner stamps the marker), legacy-store-only, first-boot-only — but the race the code explicitly means to tolerate isn't fully tolerated.

**Recommendation:** also catch `ApiError` with code `CHAIN_CONTENTION` in `runSettlement`'s catch, or have materialization treat a failed `roles` guard as "already done by the other racer".

### CONC-14 — Team CRUD writes bump `version` but never guard on it

- **Severity: low**
- **Location:** `ccp/api/src/routes/admin.ts:751` (rename put), `:772` (set-services put), `:863-879` (`stripFromOthers` puts over other teams)

All team writes are unconditional full-row puts computed from a stale `queryGSI1` read. Two admins editing teams concurrently lose updates (rename vs. set-services on the same team; two set-services calls whose `stripFromOthers` sets were computed against each other's pre-images can leave a service slug owned by two teams — the single-ownership invariant the helper exists to maintain). Version numbers can duplicate. Blast radius is small (admin-only, low frequency), hence low.

**Recommendation:** `ifEquals {attr:'version'}` on every team write, including the stolen-from teams inside `stripFromOthers`.

### CONC-15 — `transactWithAudit` conflates a caller's domain guard failure with chain contention, producing dead error paths and mislabeled conflicts

- **Severity: low**
- **Location:** `ccp/api/src/domain/audit.ts:210-233`; concrete dead code at `ccp/api/src/routes/scanJobs.ts:451-453`; the pattern is acknowledged (and manually compensated) at `ccp/api/src/routes/instance.ts:123-131`

Because `transactWithAudit` retries any `ConditionError` once and then throws `ApiError('CHAIN_CONTENTION')`, a caller whose *own* `ifEquals` guard lost deterministically burns the retry and receives `CHAIN_CONTENTION` — never `ConditionError`. The scan-job status route's `catch (e instanceof ConditionError) → STATE_CONFLICT` therefore never fires; a real lost transition is reported to the worker as "the audit chain is busy; please retry" (`errors.ts:120-123`), inviting a pointless retry of a permanently-failed transition. `instance.ts` documents and works around the same seam by re-mapping `CHAIN_CONTENTION` to `INSTANCE_STALE`. The helper's docstring says guard-carrying callers "must NOT use this" — but scanJobs, settlement, and drift staging all do (each with local compensation of varying completeness).

**Recommendation:** have `transactWithAudit` (or a variant) accept the domain writes' guards and re-check them on `ConditionError` (the pattern `ackPending` hand-rolls at `dualControl.ts:306-313`), or return a discriminated result so callers can tell "your guard failed" from "chain busy".

---

## Minor observations

- **`sweepExpired` is dead code and the 72h dual-control envelope is unenforced at ack.** `sweepExpired` (`dualControl.ts:347-358`) has no caller anywhere in `src/`, so `PENDING` proposals never become `EXPIRED`; `ackPending` never checks `expiresAt`, so a proposal can be acked arbitrarily long after its stated expiry. If the sweep is ever wired, note its blind `store.put({...p, status:'EXPIRED'})` would race an in-flight ack (it should guard `ifEquals status:'PENDING'`).
- **Drift-upload rollback can clobber a concurrent pointer advance.** The file-write-failure path restores `currentPointer` with a blind put (`routes/drift.ts:409-414`); a second upload that won the next version in between would have its pointer advance overwritten. Requires a disk failure + a concurrent upload — vanishingly rare, but the rollback should guard on the pointer value it wrote.
- **Migrate's precondition is check-then-import** (`routes/migrate.ts:59-60`): two concurrent `POST /admin/migrate/v1` both see `accounts.length === 1` and both import (account puts are `ifNotExists`, but teams/policy/audit wrappers duplicate). Admin-only, one-shot tooling; low risk.
- **The freeze check inside quorum-met** (`requests.ts:656`) and the frozen-check in the apply route (`requests.ts:904`) are read-then-act against a setting another admin may flip concurrently — inherent to the lazy design and acceptable, but worth knowing the freeze is best-effort at the millisecond scale.
- **`refreshKnownProjects`** (`projects.ts:94-97`) sets `hydrated = false` before awaiting the re-read; a concurrent request in that window re-hydrates redundantly (idempotent, harmless). Cross-process staleness of the `KNOWN` cache is subsumed by CONC-7.
- **`TerraformExecutor` shares one root across requests** — safe today only because the scheduler is strictly sequential per tick and non-reentrant across ticks; if `plan()` is ever called from a route while the scheduler runs, two terraform invocations would contend on the same working dir (terraform's own state lock is the only net). The `initDone ??=` memoization (`terraformExecutor.ts:130-133`) is a synchronous check-and-set and is sound.
- **Request `events` arrays are rewritten wholesale on every mutation**, which both magnifies the lost-update class (CONC-1/2) and grows the per-write snapshot cost (CONC-8). Event items in their own rows (the `RequestEventItem` shape already exists in `store/schema.ts:480-488`, apparently unused) would shrink both.
- **`ccp/runner/entrypoint.sh`** is single-container by design; its check-then-register (`.runner` marker, lines 30-52) races only if an operator starts two runner containers on one bind mount — `config.sh --replace` makes the outcome last-writer-wins on the registration, which is acceptable for this tooling.

---

## Overall grade: **C**

The repository is two codebases from a concurrency standpoint. Everything built in the later, machine-lane era — the audit chain head OCC, the scheduler's claim-first CAS with a non-reentrant loop, scan-job claiming, upload version allocation, lazy settlement, dual-control drift guards, the drift-generation runner, the instance OCC — is genuinely well engineered, with the races named in comments and closed with conditional writes and idempotent lost-race re-reads. But the highest-traffic human paths were never brought up to that standard: the approve/reject/link-pr/plan-summary handlers and the *entire* account/auth lane still do unguarded read-modify-write full-row puts, and the shared retry helper replays stale snapshots — so the exact scenario the product exists to govern (two reviewers acting on the same change at the same moment) can corrupt the governance record, and routine auth traffic can silently revert admin account actions. Add the event-loop-freezing synchronous bundle and the absence of any multi-process guard on the file store, and the system's concurrency posture depends on low traffic and a single process staying alive — assumptions production will eventually violate. The fixes are mechanical (the codebase already contains the correct pattern in half a dozen places); until they land, the grade is C.
