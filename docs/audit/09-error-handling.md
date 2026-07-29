# Error Handling & Failure Modes Audit — cloud-control-plane

- **Audit date:** 2026-07-26
- **Dimension:** Error handling & failure modes (`error-handling`)
- **Auditor scope:** backend pipeline failure behavior — `ccp/api/src` (deploy, scheduler/apply subsystem, bundle, drift, scan-job lanes, stores, error taxonomy), `ccp/runner/entrypoint.sh`, `ccp/scanner` + the Go scan worker (`tools/catalogctl/internal/scanworker`), CI gating scripts, compose/Dockerfile runtime posture.

---

## Scope & method

Read in full (no code executed; all claims anchored in the source as read):

- **API core:** `ccp/api/src/server.ts`, `src/index.ts`, `src/errors.ts`, `src/deploy.ts`, `src/domain/readiness.ts`, `src/middleware/session.ts`, `src/middleware/rateLimit.ts`, `src/auth/credentials.ts`
- **Stores:** `src/store/memoryStore.ts`, `src/store/fileStore.ts`
- **Audit chain:** `src/domain/audit.ts` (record / recordIn / transactWithAudit), `src/domain/schedule.ts` (settleWindow guard pattern)
- **Scheduled apply subsystem:** `src/domain/apply/loop.ts`, `scheduler.ts`, `executor.ts`, `terraformExecutor.ts`, `notify.ts`
- **Route-triggered external effects:** `src/domain/bundle.ts` + `src/routes/requests.ts` (POST /:id/apply), `src/domain/driftCheck.ts`, `src/domain/driftProposals.ts` + `src/routes/drift.ts` (PUT /:id/drift, submit, legitimize, POST drift/check, drift/proposals/generate), `src/routes/projectData.ts` (upload/activate)
- **Scanner lane:** `src/domain/scanner.ts`, `src/domain/forgeCredentials.ts`, `src/domain/onboardToken.ts`, `src/routes/scanJobs.ts`, `src/routes/projects.ts` (scan-job queueing), `tools/catalogctl/internal/scanworker/worker.go`, `ccp/scanner/Dockerfile`
- **Runtime/CI:** `ccp/runner/entrypoint.sh`, `ccp/docker-compose.yml`, `ccp/docker-compose.armed.yml`, `ccp/api/Dockerfile` (HEALTHCHECK/CMD), `.github/workflows/ccp-data.yml`, `scripts/gen-project-data.sh`, `scripts/ci/apply-window-gate.sh`, `scripts/ci/plancheck-gate.sh`

Method: for every external dependency (GitHub API, git, spawned operator commands, terraform, filesystem, the store) I traced what happens on timeout, non-2xx, network failure, malformed output, and process crash; whether errors are retried and with what policy; whether failures fail closed or strand half-done state; and whether errors reach users/operators with actionable detail or vanish.

---

## Strengths

This codebase's failure-mode discipline is well above average, and it is worth being concrete about it:

1. **A real, closed error taxonomy.** `ccp/api/src/errors.ts:10-302` defines every 4xx as `{code, reason, details?}` with human-actionable `reason` strings ("The maintenance window must start at least 30 minutes from now", "Set the SPA origin(s)…"). `ApiError` + `registerErrorHandler` (errors.ts:312-359) make routes throw codes, not strings. 429s always carry `Retry-After` (errors.ts:337-341). Operator-fixable conditions are deliberately 409/422, never 500 (e.g. `SCANNER_DISABLED`, `FORGE_CREDENTIAL_REFUSED`, errors.ts:259-272).

2. **Fail-closed boot.** Production preflight refuses to start on an insecure/incomplete config (`deploy.ts:125-159`, enforced in `server.ts:43-52` with a named fix per problem). `FileStore.load` refuses a present-but-empty data file instead of silently booting an empty governance DB (`fileStore.ts:47-56`); bootstrap is refused when a data file exists on disk at all (`server.ts:74-80`); a mis-set `CCP_LEGACY_PROJECT_ID` throws with the exact remediation (`deploy.ts:56-65`, `server.ts:100-105`).

3. **Crash-safe durable store.** Every FileStore mutation is applied to the map, snapshotted synchronously, then written temp+fsync+rename on a serialized chain, and the caller *awaits real durability* before its 2xx (`fileStore.ts:58-99`). The write chain survives a failed write (`persist()` keeps the chain alive while surfacing the error to the caller, fileStore.ts:79-85).

4. **CAS-guarded state transitions everywhere.** The scheduler's claim (`AWAITING → APPLYING` under `ifEquals`, `scheduler.ts:236-256`), the scan-job claim (`queued → claimed` CAS that atomically leaves the queue partition, `scanJobs.ts:281-314`), settleWindow, and drift-proposal submit (`routes/drift.ts:831-886`, whole-batch atomicity: request put + N proposal flips + audit in ONE transact) all follow the same lost-guard → re-read → report-true-state idempotent pattern, with chain contention retried exactly once then surfaced as 409 `CHAIN_CONTENTION` (`domain/audit.ts:177-233`).

5. **Compensation on the file/row seam.** Both upload lanes write the version row first (`ifNotExists` = the version claim), then the file, and delete the row (drift also restores the pointer) if the file write throws — "nothing half-exists" (`routes/projectData.ts:268-324`, `routes/drift.ts:384-416`). File writes themselves are temp+rename atomic (`domain/drift.ts:572-586`).

6. **Readiness that does not lie.** `/healthz` is deliberately shallow; `/readyz` re-verifies every project's audit hash chain and reports 0-account stores as 503 with reasons (`domain/readiness.ts:41-69`, `index.ts:68-76`); the container HEALTHCHECK probes `/readyz` (`ccp/api/Dockerfile:96-97`).

7. **Worker input is never trusted.** Scan status transitions are validated against the *stored* status with a forward-only table and CAS-guarded (`domain/scanner.ts:151-175`, `scanJobs.ts:424-466`); worker error text is control-char/URL/token-scrubbed and capped at the boundary (`scanner.ts:202-214`). The Go worker re-validates the server-supplied clone URL client-side (`worker.go:274-292`), bounds claim/status HTTP at 30s and clones at 10m (`worker.go:108-114, 208-217`), reports a terminal status on every job exit path (`worker.go:181-244`), and survives any single job's failure (`worker.go:158-163`).

8. **Off-by-default arming, refuse-don't-fallback.** A misconfigured terraform executor refuses to arm the loop rather than silently running dry-run (`loop.ts:91-101`); a missing forge seal key is a refusal, never a default-key fallback (`forgeCredentials.ts:56-69`); an unreadable configured GitHub App key throws instead of pretending no App exists (`forgeCredentials.ts:124-154`).

9. **CI gates are fail-closed and enumerate their exit codes.** `scripts/ci/apply-window-gate.sh` (freeze veto exit 7 before the window is consulted; distinct exits for BEFORE_WINDOW/EXPIRED/INVALID) and `scripts/ci/plancheck-gate.sh` (digest mismatch = hard fail 4). `scripts/gen-project-data.sh:365-405` classifies curl exit codes (unreachable vs rejected vs other) with `--retry 3`, timeouts, and a written `upload-status.json`.

10. **The apply pre-checks fail closed with specific reasons.** `terraformExecutor.apply()` re-verifies pin integrity, artifact presence, approved-digest match, and planfile-byte sha before ever spawning terraform, each with a distinct `{ok:false, detail}` (terraformExecutor.ts:200-249); the scheduler stamps `dryRun` into the audit so a dry-run APPLIED can never masquerade as a real one (`scheduler.ts:279-291`).

---

## Findings

### ERR-1 — Synchronous child processes block the entire API event loop for minutes — HIGH
**Location:** `ccp/api/src/domain/bundle.ts:113-125`, `ccp/api/src/domain/driftProposals.ts:814,827-832`, `ccp/api/src/domain/driftCheck.ts:52-56`, invoked from `ccp/api/src/routes/requests.ts:922`, `ccp/api/src/routes/drift.ts:430,1101,1176`

All three armed effect lanes shell out with **`spawnSync`** on the single-threaded API server:

- The bundle apply (`POST /requests/:id/apply`) runs clone (git timeout 5 min, bundle.ts:123) + gate command (15 min, bundle.ts:118) + push + trigger (15 min) **inline in the request handler** (requests.ts:922).
- Drift-proposal generation is described as "fire-and-forget … so the CI PUT never blocks on a git clone" (drift.ts:423-425, driftProposals.ts:1044-1049), but this is not true: `scheduleDriftGeneration` → `runQueueDrainingLoop` → `generateDriftProposalsOnce` reaches `runDriftGen(steps, rawText)` (driftProposals.ts:895) **before any `await` executes**, so the `spawnSync` git clone (5 min timeout) and generator command (10 min timeout) run in the synchronous prefix of the async call — the PUT handler does not return, and no other request is served, until they finish.
- The drift-check trigger is `await`ed in-route and is `spawnSync` underneath (drift.ts:1101, driftCheck.ts:52, 5 min timeout).

**Impact:** while any of these runs, *every* other request — logins, approvals, CI uploads, `/healthz`, `/readyz` — stalls. The Docker HEALTHCHECK (interval 30s, retries 3, `ccp/api/Dockerfile:96`) marks the container unhealthy after ~90s; any orchestration that acts on health (autoheal, swarm) will kill the process **mid-push/mid-commit**, producing exactly the wedged half-states of ERR-2. CI upload clients (`gen-project-data.sh` uses `--max-time 300`) time out against a healthy server.
**Recommendation:** replace `spawnSync` with async `execFile`/`spawn` (the pattern `terraformExecutor.ts:91,135-148` already uses), or move these lanes to a worker thread/queue. At minimum make the drift-gen loop yield (`await setImmediate`) before spawning, and convert the bundle route to run the bundle truly asynchronously with a status the UI polls.

### ERR-2 — A crash or late write failure strands `bundle.state='running'` forever; no recovery path exists — HIGH
**Location:** `ccp/api/src/routes/requests.ts:906,912-919,946-961`

The bundle claim writes `bundle:{state:'running'}` (requests.ts:914), then runs the multi-minute bundle, then records `triggered`/`failed` (requests.ts:951). There is **no reaper, no timeout, and no admin route that resets `bundle.state`** (verified: the only writes to `bundle` in the codebase are these two). Consequences:

1. A process crash/restart mid-bundle (made likely by ERR-1's healthcheck interaction) leaves the request answering `409 BUNDLE_RUNNING` on every future apply attempt, forever (requests.ts:906).
2. If the post-bundle record loses its `ifEquals status` guard twice (a concurrent settle/cancel moved `status` while the bundle ran), the handler throws `CHAIN_CONTENTION` (requests.ts:956-957) → the caller gets a 500-class response, the state stays `'running'`, **and the outcome — including a commit that already landed on `main` and a trigger that already fired — is recorded nowhere**.

**Impact:** a fully-approved change becomes permanently un-appliable through the portal after a single crash; in case (2) the git history and the portal state silently diverge.
**Recommendation:** store a `startedAt` with the running claim and treat a running claim older than the worst-case bundle duration as expired (allow re-claim); record the bundle outcome with an unconditional write (or retry loop without the status guard — the outcome is evidence, not a transition); add an admin reset verb.

### ERR-3 — Scan jobs stuck in non-terminal states are unrecoverable and block all future scans for the project — HIGH
**Location:** `ccp/api/src/routes/scanJobs.ts:281-374`, `ccp/api/src/routes/projects.ts:924-929`, `tools/catalogctl/internal/scanworker/worker.go:205-207`

Once a job is CAS-claimed (`queued → claimed`, scanJobs.ts:281-314), only the worker can move it forward, and only via legal transitions. There is **no stale-claim timeout, no requeue, and no operator route to force-fail a job**. Ways a job wedges permanently in `claimed`/`cloning`/`scanning`:

- `mintOnboardToken` throws after the claim committed (chain contention after both retries — `onboardToken.ts:81-92` via `audit.ts:210-233`; the call at scanJobs.ts:357 is outside the route's try/catch): the worker never receives the packet, the job stays `claimed`.
- The worker process dies mid-clone/mid-scan (its tmpfs checkout is by design lost on restart, `ccp/docker-compose.yml:171-177`), or a progress report fails transiently — `worker.go:205-207` returns without attempting a terminal `failed` report.

Meanwhile `POST /projects/:id/scan-jobs` refuses to queue a new job while **any** non-terminal job exists (projects.ts:794: `STATE_CONFLICT`).
**Impact:** one transient failure permanently wedges a project's onboarding wizard; the fix is manual store surgery. The doc comment "a job hanging in claimed would tell them nothing" (scanJobs.ts:334-338) shows the failure mode was seen but only mitigated for the credential path.
**Recommendation:** stamp `startedAt` at claim (already done) and treat non-terminal jobs older than, e.g., `2 × CLAIM_TOKEN_TTL_MINUTES` as expired — either auto-fail them at claim/queue time or let the queue route supersede them; and/or add an admin force-fail verb.

### ERR-4 — A crashed apply worker strands a request in `APPLYING` forever, silently — HIGH
**Location:** `ccp/api/src/domain/apply/scheduler.ts:162-208 (esp. 199-204), 254-257`

The claim `AWAITING_DEPLOY_APPROVAL → APPLYING` correctly makes double-apply impossible, but there is no lease/expiry on the claim: if the process dies between the claim commit and the terminal `APPLIED`/`HALTED_APPLY_FAILED` write (a window that contains the entire real `terraform apply`, up to the 10-minute timeout at terraformExecutor.ts:125), every subsequent tick sees `status === APPLYING` and reports `skipped-moved` without notifying anyone (scheduler.ts:199-204). The request never reaches a terminal state, no `halted-*` notification fires, and no human is alerted — the exact opposite of the subsystem's own "a job the worker walks away from silently is a job the operator watches spin forever" doctrine.
**Impact:** after one crash mid-apply the change is neither applied nor halted; whether terraform actually mutated the estate is unknown, and nothing surfaces it.
**Recommendation:** record `claimedAt` on the claim write; on a later tick, treat an `APPLYING` row older than the executor timeout as abandoned → transition to `HALTED_APPLY_FAILED` (with a distinct reason like `WORKER_LOST`) and notify, so a human reconciles.

### ERR-5 — `TerraformExecutor.init()` caches a rejected promise: one transient init failure bricks the executor until restart — MEDIUM
**Location:** `ccp/api/src/domain/apply/terraformExecutor.ts:130-133`

```ts
private init(): Promise<void> {
  this.initDone ??= this.tf(['init', '-input=false', '-no-color']).then(() => undefined);
  return this.initDone;
}
```

If the first `terraform init` fails (registry/network blip, transient lock), the **rejected** promise is memoized; every later `plan()`/`replan()`/`apply()` re-awaits the same rejection. The executor is constructed once at loop start (`loop.ts:95-101`), so the auto-apply lane is dead until the process restarts, while the loop keeps logging the same stale init error every tick (via ERR-6's path).
**Impact:** a single transient failure at boot converts into a permanent, unreported outage of scheduled applies.
**Recommendation:** clear `this.initDone` on rejection (`.catch(e => { this.initDone = null; throw e; })`) so init is retried on the next call.

### ERR-6 — `executor.replan()` failures are an unmodeled halt: unbounded silent retry, and they abort the rest of the project's due list — MEDIUM
**Location:** `ccp/api/src/domain/apply/scheduler.ts:234`, `ccp/api/src/domain/apply/loop.ts:120-127`

`processOne` wraps `executor.apply` in `tryApply` (scheduler.ts:303-309) but calls `executor.replan(req)` bare (scheduler.ts:234). `TerraformExecutor.replan` throws `TerraformExecutorError` on any `terraform plan` failure (backend unreachable, bad config, ERR-5's cached init rejection). The exception propagates out of `processOne`, out of `runDueApplies` (no per-request catch — the loop at scheduler.ts:197-208 stops), and is swallowed by the per-project `console.error` in `loop.ts:123-127`. Result: (a) the failing request is retried **every tick forever** with no `HALTED_*` transition, no timeline event, and no notifier alert — the only trace is stdout; (b) **all later due requests in the same project are skipped for that tick**, every tick, as collateral.
**Impact:** a persistent plan failure looks, in the portal, like the scheduler simply never ran; other windowed requests in the project can silently miss their windows.
**Recommendation:** catch replan errors in `processOne` and either halt after N consecutive failures (a new `REPLAN_FAILED` halt spec) or at least emit a notifier event; catch per-request in `runDueApplies` so one request cannot starve its siblings.

### ERR-7 — Unexpected errors become `{code:'INTERNAL'}` 500 with zero server-side logging — MEDIUM
**Location:** `ccp/api/src/errors.ts:354-359`

```ts
app.onError((err, c) => {
  if (err instanceof ApiError) return apiError(c, err.code, err.details);
  return c.json({ code: "INTERNAL", reason: "Internal error." }, 500);
});
```

Non-`ApiError` exceptions (store I/O failures, `ForgeCredentialError` escaping a route, TypeErrors — anything "outside the taxonomy by design, reserved for bugs") are converted to a generic 500 and **discarded**. Hono does not log by default, and no middleware here does. A production 500 is undiagnosable: no stack, no route, no request id anywhere.
**Impact:** the exact class of failure this handler declares "reserved for bugs" is the one class with no forensic trail.
**Recommendation:** `console.error` (method, path, stack) before returning the 500, ideally with a correlation id echoed in the body's `details`.

### ERR-8 — No process-level failure handling: no graceful shutdown, no rejection/exception handlers, npm-as-PID-1 — MEDIUM
**Location:** `ccp/api/src/server.ts:147`, `ccp/api/Dockerfile:100`, repo-wide (grep: zero `process.on(` in `ccp/api`)

- There is no `SIGTERM`/`SIGINT` handler anywhere: `serve()` is never closed, the scheduler handle's `stop()` is never invoked on shutdown, and in-flight requests are simply cut when the process dies.
- The container runs `CMD ["npm", "run", "start"]` → npm → sh → tsx → node with no `init` process; the SIGTERM-forwarding chain through npm/sh is unreliable, so `docker stop` frequently ends as SIGKILL after the 10s grace period.
- No `uncaughtException`/`unhandledRejection` handlers; `void start()` (server.ts:147) means any non-`DeployConfigError`/`SettlementConfigError` boot failure (e.g. `FileStore.open` on corrupt JSON, fileStore.ts:55) surfaces only as Node's default unhandled-rejection crash dump.

**Impact:** FileStore's atomic-rename design keeps the *store* consistent under SIGKILL (a genuine strength), but every in-flight external effect (bundle, scan claim, apply) dies un-recorded — feeding the wedged states of ERR-2/3/4 — and boot failures print raw stacks instead of the operator-grade messages the rest of boot invests in.
**Recommendation:** add a SIGTERM handler that stops accepting connections, stops the scheduler loop, awaits the FileStore write chain, and exits; run node directly (or under tini) as PID 1; give `start()` a top-level catch that prints an operator-grade message and exits non-zero.

### ERR-9 — GitHub App credential fetches have no timeout, and any failure terminally fails the scan job with no retry — MEDIUM
**Location:** `ccp/api/src/routes/scanJobs.ts:185-188,339-353`, `ccp/api/src/domain/forgeCredentials.ts:207-267`

`realAppFetch` is a bare `fetch(url, init)` with no `AbortSignal`: a black-holed connection to `api.github.com` holds the claim request (and the claimed job) for undici's default header timeout (~5 minutes). There is no retry for either broker call. On any failure — including a plain network error or a GitHub 5xx — the just-claimed job is moved to **terminal `failed`** (`failClaimed`, scanJobs.ts:341-353): a 30-second GitHub blip permanently fails a queued scan, and (per ERR-3's one-non-terminal-job rule) requires the operator to notice and re-queue. Note `failClaimed` itself can throw (chain contention, scanJobs.ts:156-179), which would escape the route as a 500 and strand the job in `claimed` (ERR-3).
**Impact:** transient upstream failures become permanent job failures; a stalled upstream stalls the worker lane.
**Recommendation:** add `AbortSignal.timeout(…)` to `realAppFetch` (10–30s); distinguish transient (network/5xx → release the claim back to `queued`, or retry once) from permanent (404 not-installed → fail with the existing message); wrap `failClaimed` so its own failure cannot escape the route.

### ERR-10 — FileStore persist failure leaves memory ahead of disk: the client gets a 500 for a write that took effect — MEDIUM
**Location:** `ccp/api/src/store/fileStore.ts:58-71,79-99`

`put`/`delete`/`transact` apply to the in-memory map first, then await `persist()`. If the disk write fails (disk full, EACCES), the caller receives the rejection (→ generic 500 via ERR-7), **but the mutation stays applied in memory**: subsequent reads serve it, and the next successful persist (triggered by any later mutation) silently writes it to disk — or, if the process restarts first, it vanishes. So a 500-answered request may be durably applied, transiently applied, or lost, and neither the client nor the operator can tell which. Two smaller issues in `writeAtomic` (fileStore.ts:87-99): the temp file leaks if `writeFile`/`sync` throws (no unlink in the catch path), and there is no directory fsync after `rename`, so the rename itself is not durable across power loss (process-kill safety is unaffected).
**Impact:** memory/disk divergence under disk pressure; misleading failure semantics for the one component every route trusts.
**Recommendation:** on persist failure either roll the map back (snapshot-based undo) or mark the store read-only/unready (flip `/readyz`) until a persist succeeds; unlink the temp file on failure; fsync the directory after rename.

### ERR-11 — The bundle idempotency claim guards on `status`, not `bundle.state`: concurrent applies can both run — MEDIUM
**Location:** `ccp/api/src/routes/requests.ts:906-919`

The pre-check `req.bundle?.state === 'running'` (requests.ts:906) is read-then-act; the CAS that follows conditions on `ifEquals: {attr:'status'}` (requests.ts:914) — an attribute the claim itself does not change. Two near-simultaneous `POST /:id/apply` calls both pass the pre-check, both satisfy the status guard, and both run full bundles (two clones, two gate runs). Only git's non-fast-forward push rejection prevents a double landing; the loser records `bundle-failed` over the winner's `triggered` (last write wins on the same row), leaving misleading state and a confusing timeline.
**Impact:** duplicated multi-minute effect executions (doubling ERR-1's blocking) and a corrupted-looking bundle record after a benign double-click; the comment's claim ("a lost race means a concurrent bundle … won", requests.ts:909-910) is not what the guard enforces.
**Recommendation:** make the claim conditional on the bundle state itself (e.g. `ifEquals` on a dedicated attribute, or `ifNotExists` on a separate claim row), mirroring the scan-job claim's design.

### ERR-12 — Trigger failure after a landed commit: honest-but-dead-end half state, and spawn timeouts are indistinguishable from exit-1 — MEDIUM
**Location:** `ccp/api/src/domain/bundle.ts:96-102,112-125,149`, `ccp/api/src/routes/requests.ts:929,961`

If `commit` succeeds (the change **is on `main`**) but `trigger` fails, the outcome is `ok:false` → `bundle.state='failed'` → HTTP 502. The landed SHA survives only inside the audit `steps`. A natural retry of `/apply` re-clones (now containing the landed commit), re-runs the gate, and dies at `commit` with *"commit failed (gate left no change?)"* (bundle.ts:149) — technically true, actively misleading: the operator's real remediation is "the change already landed; fire the CI gate approval for SHA X", which nothing tells them. Separately, `sh()`/`git()` map a `spawnSync` timeout or spawn error (`r.error`, `status:null`) to plain `status:1` with whatever partial output existed (bundle.ts:119,124) — a 15-minute gate timeout reports as "gate exit 1" with no hint that it timed out.
**Impact:** a recoverable half-state needs git archaeology to untangle; timeouts are undiagnosable from the audit evidence.
**Recommendation:** on trigger failure, persist the landed SHA on the request (e.g. `bundle:{state:'landed-untriggered', sha}`) and make a retry skip to the trigger step; include `r.error?.message` and an explicit "timed out after Nms" in step detail.

### ERR-13 — `prepare()` leaks the cloned workspace when `rev-parse` fails — LOW
**Location:** `ccp/api/src/domain/bundle.ts:136-139`

The clone-failure path removes the temp dir (bundle.ts:133-135) but the `rev-parse failed` path returns the error without `rmSync`, and `runBundle` only reaches `cleanup` when `prepare` succeeded (bundle.ts:83-87,103-105) — the full clone is left under `TMPDIR` (`/data/scratch` in the armed overlay, `docker-compose.armed.yml:8`) each time.
**Recommendation:** `rmSync(dir, …)` before returning the rev-parse error.

### ERR-14 — Drift-upload compensation is non-transactional best-effort — LOW
**Location:** `ccp/api/src/routes/drift.ts:408-416`

On a report-file write failure the handler compensates with three separate unguarded store calls (delete version row, restore/delete pointer). A failure or crash between them leaves an advanced pointer over a fileless version. Mitigation exists — reads fail closed to `report:null` with a console.error (drift.ts:466-468) — but the DB then permanently claims a version that has no body, and the next upload dedupes against that ghost row's digest (drift.ts:352-357: digest is on the row, not the file).
**Recommendation:** perform the compensation as one transact; or write the file first and make the row transact the commit point (the ordering `reconcileProposals` already uses for proposal bodies, driftProposals.ts:961-973).

### ERR-15 — Scan worker: a failed progress report abandons the job without a terminal status; a claim non-2xx is process-fatal with no backoff — LOW
**Location:** `tools/catalogctl/internal/scanworker/worker.go:154-156,205-207,219-221,330-343`

A transient failure of the `cloning`/`scanning` progress `Report` returns from `runJob` without attempting the terminal `failed` report (worker.go:205-207,219-221), stranding the job server-side (ERR-3). And `Claim` treats *any* non-2xx/204 — including a control-plane restart's connection refusal or the 409 `CHAIN_CONTENTION` the claim route can emit — as fatal, exiting the process (worker.go:154-156); recovery relies wholly on compose `restart: unless-stopped` with no backoff, so a down control plane produces a tight crash loop.
**Recommendation:** on progress-report failure, still attempt the terminal `failed` report (best-effort) before returning; make `Claim` retry transient failures with backoff instead of exiting.

### ERR-16 — The ccp-data CI lane goes green when the control plane is unreachable — LOW
**Location:** `scripts/gen-project-data.sh:388-394`, `.github/workflows/ccp-data.yml:100-110`

Curl exits 5/6/7/28/35/52/55/56 are classified "unreachable" and the job **exits 0**, keeping the bundle as an artifact. This is a documented air-gap fallback, but it means a week-long control-plane outage (or a firewall regression) produces an unbroken row of green `ccp-data` runs while the portal serves ever-staler data; the only record is `upload-status.json` inside each run's artifact. (Config errors — HTTP 22 — correctly hard-fail, gen-project-data.sh:396-401.)
**Recommendation:** emit a workflow warning annotation (`::warning::`) and/or a step-summary line on the unreachable path so the outage is visible in the Actions UI without opening artifacts; consider a repo variable to opt into hard-fail for non-air-gapped estates.

---

## Minor observations

- **`/readyz` re-verifies every audit chain on every probe** (`domain/readiness.ts:49-53`, HEALTHCHECK every 30s): full-chain sha256 recomputation is O(chain length) on the single thread; on a long-lived estate this becomes a steady CPU tax and a growing pause every 30s. Consider verifying incrementally or caching the verified head.
- **The scheduler's apply retry is immediate** (scheduler.ts:260-261): one retry with zero delay mostly re-hits the same transient condition; a short jittered delay would make the "retry once" policy meaningful.
- **Notifier "page a human" seam is console-only** (`notify.ts:46-52`): `halted-*` and `apply-failed` — the signals the scheduler's own docs call "a human must look now" — reach stdout only. Fine as a seam; worth stating in the runbook that today nobody is actually paged.
- **`pruneDriftVersions` is sequential best-effort** (drift.ts:173-181): a mid-loop failure (thrown store delete) escapes into the upload handler after the 201-worthy work is done; wrap it so janitorial failure can't fail the upload.
- **`runner/entrypoint.sh` is clean** (`set -euo pipefail`, `exec ./run.sh` for signal delivery, never re-registers over live credentials, actionable exit-1 message with the exact commands); only note: an interrupted dist extraction leaves a partial tree that the stamp check will correctly re-extract next boot — self-healing, no action needed.
- **`middleware/rateLimit.ts` upload bucket is bounded and evicts junk keys** (rateLimit.ts:66-109) — a nice contrast to the common unbounded-map failure.
- **`verifyPassword` never throws on malformed hashes** (`auth/credentials.ts:24-31`) — the malformed-stored-credential path degrades to a clean auth failure, not a 500.
- **`sanitizeScanError` defends its own future call sites** (scanner.ts:202-214): URL- and token-shaped redaction at the boundary rather than trusting each caller.

---

## Overall grade: **B**

**Justification.** The deliberate failure-mode engineering here is genuinely strong: a closed, actionable error taxonomy; fail-closed boot and preflight; an atomic, awaited durable store; CAS-guarded transitions with honest idempotent lost-race handling; compensation on every file/row seam; and refuse-don't-fallback misconfiguration handling throughout. What keeps it out of the A range is a consistent blind spot around *process death and long-running effects*: three separate lanes can wedge state permanently with no lease, reaper, or admin reset (bundle `running` ERR-2, scan `claimed` ERR-3, request `APPLYING` ERR-4); the armed lanes block the entire event loop with `spawnSync` — contradicting their own "never blocks" comments and actively courting the mid-effect kills that create those wedges (ERR-1); and the process has no shutdown handling or 500-path logging at all (ERR-7/8). These are exactly the failures that will bite in production, but none corrupts data — the store and audit-chain design confine the damage to stuck workflows and lost observability rather than loss or corruption.
