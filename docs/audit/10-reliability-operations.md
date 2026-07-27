# Reliability, Deployment & Observability Audit — Cloud Control Plane

**Dimension:** Deployment, runtime reliability & observability (`reliability-ops`)
**Audit date:** 2026-07-26
**Auditor scope:** operational surface only — compose files, Dockerfiles, entrypoints, ops scripts, health/readiness, logging, upgrade/migration paths, first-run journey. Cybersecurity is explicitly out of scope; everything below is framed as robustness/correctness.

---

## Scope & method

Read in full (no code was modified; nothing was committed):

- Compose & images: `ccp/docker-compose.yml`, `ccp/docker-compose.armed.yml`, `ccp/api/Dockerfile`, `ccp/app/Dockerfile` + `ccp/app/nginx.conf`, `ccp/runner/Dockerfile` + `ccp/runner/entrypoint.sh`, `ccp/scanner/Dockerfile`, `ccp/toolbox/Dockerfile` + `ccp/toolbox/toolbox-selfcheck`
- Ops scripts: `ccp/scripts/setup.sh`, `install.sh`, `run-local.sh`, `doctor.sh`, `self-update.sh`, `migrate-data.sh`, `nginx-vhost.sh`, `intranet-setup.sh` (skimmed, structure + compose interactions verified), `scripts/gate.sh`
- Runtime code that defines operational behavior: `ccp/api/src/server.ts`, `deploy.ts`, `index.ts`, `errors.ts`, `middleware/session.ts`, `store/fileStore.ts`, `store/snapshot.ts`, `domain/readiness.ts`, `domain/settlement.ts`, `domain/apply/loop.ts`, `domain/bundle.ts`, `domain/driftCheck.ts`, `domain/driftProposals.ts` (gen runner), `domain/scanner.ts`, `routes/scanJobs.ts`, `routes/projects.ts` (scan-job routes), `scripts/bootstrap.ts`, `scripts/backup.ts`, `scripts/restore.ts`
- Worker: `tools/catalogctl/internal/scanworker/worker.go`
- Env/config: `ccp/.env.example`, `ccp/api/.env.example`, `ccp/app/.env.example`
- CI/release: `.github/workflows/*` (esp. `ccp-smoke.yml`, `release-images.yml`), `ccp/docs/go-live.md`

Method: static reading with cross-verification of every claimed failure path (e.g. the first-boot deadlock in OPS-1 was traced through `install.sh` → compose env interpolation → `server.ts` boot order → `runSettlement` → `FileStore.persist` → the `existsSync` refusal). No containers were run.

---

## Strengths

This codebase's operational tooling is far above average for a project of this size. Concretely:

1. **Durable state on a bind mount, with atomic writes.** The store is a host bind (`/data/ccp/store:/var/lib/ccp`, `ccp/docker-compose.yml:80`), so API state survives container recreation and image upgrades by construction. `FileStore.writeAtomic` (`ccp/api/src/store/fileStore.ts:87-99`) does temp + `fsync` + `rename`, so a `kill -9` mid-write leaves the prior complete snapshot, never a torn file. `docker compose down -v` is documented as a forbidden verb (`ccp/docs/go-live.md:364-370`).
2. **A readiness probe that does not lie.** `/healthz` is shallow liveness; `/readyz` (`ccp/api/src/index.ts:68-76`, `domain/readiness.ts:41-68`) verifies store-loaded + ≥1 account + every per-project audit chain, so an emptied or corrupted store is visibly 503. The api Dockerfile healthcheck uses `/readyz` with Node's built-in `fetch` — no curl needed in the image (`ccp/api/Dockerfile:96-97`).
3. **Fail-closed production preflight.** `assertDeployable` (`ccp/api/src/deploy.ts:125-159`) refuses to boot on memory store, insecure cookies, or a missing TOTP key, with actionable error text, before the store is opened or a port bound.
4. **A genuinely guarded self-update.** `ccp/scripts/self-update.sh` takes a chain-verified backup plus a full-store tar and a sha256 manifest of project data before updating; fast-forward-only; health-gates on `/readyz` **plus** a data-integrity probe (`:208-230`); rolls back on failure; writes a hold file when rollback also fails (`:250-253`); serializes via `flock` (`:160-161`); refuses when `.env` still has `CCP_BOOTSTRAP=1` (`:150`); emits a systemd unit template.
5. **Verified backup/restore.** `npm run backup` validates and chain-verifies before copying (backing up anyway for forensics); `npm run restore` refuses to install a snapshot whose chain does not verify unless `--force` (`ccp/api/scripts/backup.ts`, `restore.ts`, `store/snapshot.ts:95-106`).
6. **`doctor.sh`** is a real read-only diagnostic: dangling `.env` symlinks, the root-owned-bind trap (`:179-183`), armed-posture TMPDIR/bind agreement (`:86-99`), TLS expiry, disk space, leftover legacy volume, update-hold detection.
7. **Migration discipline.** `migrate-data.sh` writes its rollback override *before* any destructive step (`:166-173`), mounts the source volume read-only throughout, hashes both sides, and auto-restores the api on the old volume on any failure (`:112-129`).
8. **Supply-chain-pinned runtime binaries.** Terraform verified against HashiCorp's SHA256SUMS (`ccp/toolbox/Dockerfile:35-50`, `setup.sh:454-466`); docker CLI and actions/runner tarballs sha256-pinned (`ccp/api/Dockerfile:46-48`, `ccp/runner/Dockerfile:26-28`).
9. **Sensible per-service shutdown budgets where they exist:** `stop_grace_period: 2m` for the runner (in-flight CI job), `30s` for the scanner (terminal status report) (`ccp/docker-compose.yml:119,159`); the runner entrypoint `exec`s `run.sh` so signals reach the runner process directly (`ccp/runner/entrypoint.sh:55`).
10. **The runner's state model is right:** distribution + registration live together on `/data/runner`, extracted by the entrypoint on first boot or version bump, so registration survives recreation *and* image upgrades (`ccp/runner/Dockerfile:9-16`, `entrypoint.sh:22-27`).
11. **The scanner container's posture** (read-only rootfs, tmpfs workspace with an explicit size ceiling so a huge repo is a failed job rather than a full host disk, cap-drop, no ports/volumes) is documented in the compose file itself (`ccp/docker-compose.yml:134-180`).
12. **Armed-lane runs leave audit evidence.** Bundle step logs (prepare/gate/commit/trigger with output tails) become the audit payload (`domain/bundle.ts:72-106`); drift generation failures are audited (`driftProposals.ts:892-897`); scan failures land sanitized on the job row the wizard reads.
13. **The install-journey smoke exists and runs in CI** (`.github/workflows/ccp-smoke.yml`, `run-local.sh --smoke`) — production posture, real preflight, `/readyz`-asserted, mock-bundle detection.

These are the right instincts. The findings below are mostly places where two correct pieces interact wrongly.

---

## Findings

### OPS-1 — Fresh-install bootstrap deadlock: boot-time settlement creates the store file, then `CCP_BOOTSTRAP=1` is refused
- **Severity:** critical
- **Location:** `ccp/scripts/install.sh:107-131`, `ccp/api/src/server.ts:63-80,94`, `ccp/api/src/domain/settlement.ts:206`, `ccp/scripts/intranet-setup.sh:667-668`, `ccp/docs/go-live.md:127-131`
- **Description:** `server.ts` refuses `CCP_BOOTSTRAP=1` whenever the data file already exists on disk (`server.ts:74-79`, `existsSync(dataFile)` → `process.exit(1)`). But *any* boot — bootstrap or not — materializes that file: `runSettlement` (called at `server.ts:94` before serving) always writes its `SETTLEMENT` marker on a marker-less store (`settlement.ts:206`), and `FileStore.put` persists the snapshot to `/var/lib/ccp/ccp.json` (`fileStore.ts:58-61`). `install.sh` deliberately runs the two-phase flow: step 3 brings the stack up **without** bootstrap (`install.sh:107`), polls `/readyz`, sees `"accounts":0` (fresh store), then re-ups with `CCP_BOOTSTRAP=1` (`install.sh:125`). By that point the marker-only `ccp.json` exists on the persistent bind, so the recreated api hits the disk-presence refusal and exits 1 — and `restart: unless-stopped` turns that into a crash loop with `CCP_BOOTSTRAP=1` baked into the container. `install.sh` waits 90 s, dumps 40 log lines, and dies with "/readyz never went green after first boot" (`install.sh:131`). The intranet path breaks the same way by documented ordering: `intranet-setup.sh` steps 5 runs `docker compose up -d api` (`:668`) before go-live tells the operator to "pick back up at Step 3" (set `CCP_BOOTSTRAP=1`, up) — same refusal, same crash loop. Only the strictly manual go-live flow (bootstrap set on the *very first* `up` ever) works, because the refusal check was moved before store-open for exactly the single-process case (`server.ts:70-73` documents that fix; the CI smoke `run-local.sh --smoke` only exercises the single-process case, `run-local.sh:84`).
- **Impact:** The flagship "one command to a running portal" installer fails on every genuinely fresh production host, leaving a crash-looping api whose container env still carries `CCP_BOOTSTRAP=1`. Recovery requires reading the refusal in the logs, deleting `/data/ccp/store/ccp.json` by hand, and re-running — precisely the kind of first-hour experience `install.sh` exists to prevent.
- **Recommendation:** Either (a) make `install.sh` decide bootstrap *before* the first `up` (e.g. check `/data/ccp/store/ccp.json` absence and pass `CCP_BOOTSTRAP=1` on the first `up`), or (b) teach the refusal to recognize a store that contains only the settlement marker (and no accounts) as fresh, or (c) defer the settlement-marker write until the store holds at least one account. Add an install-journey smoke that runs `install.sh`'s actual two-phase compose flow (the current smoke cannot catch this class).

### OPS-2 — Unhandled errors become 500 `INTERNAL` with zero server-side logging
- **Severity:** high
- **Location:** `ccp/api/src/errors.ts:354-359`
- **Description:** The app-wide error handler maps non-`ApiError` exceptions to `{code:"INTERNAL"}` 500 and **never logs the error** — no `console.error`, no stack trace, nothing. There is also no `process.on('unhandledRejection'/'uncaughtException')` handler anywhere in the api (verified by grep).
- **Impact:** Any bug-class failure (store I/O error, TypeError in a route, a throw inside `transactWithAudit`) is invisible to the operator: the user sees "Internal error.", `docker compose logs api` shows nothing, and there is no way to diagnose or even notice recurring 500s. For a system whose selling point is evidence, its own faults leave no evidence.
- **Recommendation:** Log the error (message + stack + method/path) in `registerErrorHandler` before responding, and add a process-level `unhandledRejection` logger. This is a three-line fix with outsized operational value.

### OPS-3 — Armed-lane commands run `spawnSync` on the event loop: the whole API freezes for up to 15 minutes and health checks flap
- **Severity:** high
- **Location:** `ccp/api/src/domain/bundle.ts:112-125`, `ccp/api/src/domain/driftProposals.ts:814,827-832`, `ccp/api/src/domain/driftCheck.ts:52-56`
- **Description:** The bundle gate/trigger (`timeout: 15*60_000`), the drift-proposal generator (git clone 5 min + generator 10 min), and the drift-check trigger (5 min) all use `spawnSync`, which blocks Node's single-threaded event loop for the entire child-process lifetime. The drift generator's "fire-and-forget so the CI upload never blocks" comment (`driftProposals.ts:1044-1050`) is defeated by this: the async wrapper still executes a synchronous clone on the only thread. During a run, **no** request is served — including `/healthz` and `/readyz` — so the Docker healthcheck (30 s interval, 3 retries, `ccp/api/Dockerfile:96`) marks the container unhealthy after ~105 s of a routine armed run, and every portal user sees a frozen UI. A `docker stop` during a run cannot deliver SIGTERM until the sync call returns; with the api's default 10 s grace period the process is SIGKILLed — potentially between the CAS push landing on `main` and the audit/status write recording it.
- **Impact:** On an armed deployment (a documented production configuration — `docker-compose.armed.yml`, go-live "Toolbox + armed lanes"), every request-to-PR bundle or drift generation freezes the entire control plane, flaps its health status, and risks a landed-but-unrecorded commit on shutdown.
- **Recommendation:** Switch to async `spawn`/`execFile` (promise-wrapped) for all three seams; the surrounding orchestration (`runBundle`, `runDriftGen`) is already structured to accommodate async steps. Give the api service a `stop_grace_period` that covers the longest armed step.

### OPS-4 — A scan job whose worker dies stays `claimed`/`cloning`/`scanning` forever and permanently wedges that project's onboarding
- **Severity:** high
- **Location:** `ccp/api/src/routes/scanJobs.ts:274-314` (claim), `ccp/api/src/routes/projects.ts:924-929` (one-in-flight refusal), `tools/catalogctl/internal/scanworker/worker.go:153-179`
- **Description:** The claim CAS moves a job out of the queue partition; from then on only the worker can advance it via `/scan-jobs/:jobId/status`. There is no lease, no timeout, no janitor, and no operator-facing cancel/requeue endpoint (verified: the only scan-job routes are create, latest, claim, status). A restarted worker has no memory of its claimed job and simply polls for new ones. Meanwhile `POST /projects/:id/scan-jobs` refuses (`STATE_CONFLICT`) while any non-terminal job exists (`projects.ts:928-929`). A worker death mid-job is a *routine* event: `self-update.sh` runs `compose up -d --build` (which rebuilds/recreates a profile-enabled scanner mid-scan), host reboots, OOM. The only recovery is hand-crafting a `POST /scan-jobs/<id>/status {status:"failed"}` with the shared worker key — undocumented, and invisible to the wizard user, who just sees a spinner forever.
- **Impact:** One container restart during a scan permanently blocks that project's paste-a-URL onboarding path — the feature ADR-0033 calls the zero-touch first import.
- **Recommendation:** Add a claim lease (e.g. requeue or fail jobs whose `startedAt` exceeds clone-timeout + margin — the claim already stamps `startedAt`, `scanJobs.ts:291`), checked lazily at claim time or from the existing scheduler loop; and/or an admin "cancel scan job" route. Document the manual recovery in the runbook meanwhile.

### OPS-5 — `migrate-data.sh`'s post-cutover byte-identical check is tripped by the new code's own boot writes: legacy migrations auto-roll back
- **Severity:** high
- **Location:** `ccp/scripts/migrate-data.sh:295-309`, `ccp/api/src/domain/settlement.ts:206`, `ccp/api/src/server.ts:94`
- **Description:** Step 10 cuts over (`compose up -d --build`) and waits for `/readyz`; step 11 then re-hashes the store *inside the running container* and `diff`s against the pre-migration source manifest, refusing (and rolling back to the old volume) on **any** difference (`migrate-data.sh:304-309`). But the cutover boot is, by the ceremony's own design ("git pull --ff-only brings the new compose + this script"), the first boot of the *new* code on this store — and on any store without a `SETTLEMENT` marker, `runSettlement` writes the marker (plus any retro-registration/materialization) at boot, rewriting `ccp.json` before step 11 hashes it. The diff on `./ccp.json` is then non-empty → `refuse` → automatic rollback of a perfectly successful migration. Re-running wipes the copy and fails identically. The exact population this script targets — hosts still on the legacy named volume, i.e. installs predating the /data consolidation and almost certainly the settlement feature — is the population guaranteed to hit it.
- **Impact:** The guarded volume→bind migration is effectively impossible for its primary audience; each attempt ends in a (safe, but baffling) rollback with a hash-mismatch error implicating data corruption that never happened.
- **Recommendation:** Hash and compare *before* starting the api on the new bind (steps 7–8 already prove the copy byte-identical); for the post-cutover probe, reuse `self-update.sh`'s mutation-tolerant check (project-data files identical, `DATA#v`/`dataActive` counts non-decreasing) instead of whole-store byte equality — or run settlement explicitly and re-baseline before the final diff.

### OPS-6 — Plain `compose up` (including every self-update cycle) silently strips the armed overlay
- **Severity:** medium
- **Location:** `ccp/docker-compose.armed.yml`, `ccp/scripts/self-update.sh:120,206,244`, `ccp/scripts/install.sh:76`, `ccp/docs/go-live.md:549-588`
- **Description:** Arming the bundle/drift lanes requires `docker compose -f docker-compose.yml -f docker-compose.armed.yml up -d`. Every scripted re-up — `self-update.sh` (nightly, by design), `install.sh` re-runs, `migrate-data.sh` cutover — invokes plain `docker compose up -d --build`, which recreates the api *without* the overlay: no docker socket, no `/data/scratch` bind, no `TMPDIR`. Nothing documents the sticky mechanism (`COMPOSE_FILE=docker-compose.yml:docker-compose.armed.yml` in `.env`), and no script detects an armed deployment.
- **Impact:** On an armed host with scheduled self-update, the armed lanes break silently every night at 03:17: the next bundle/drift run fails with a docker-cannot-connect error, and `doctor.sh` only notices if someone runs it. Conversely, the disarm is at least fail-safe (the api loses privilege, not data).
- **Recommendation:** Document `COMPOSE_FILE` in `.env.example` as *the* way to arm persistently, or teach `self-update.sh` to detect the socket mount on the running api (as `doctor.sh:88-99` already does) and re-apply the overlay on rebuild.

### OPS-7 — No HTTP request logging and no request IDs anywhere in the api
- **Severity:** medium
- **Location:** `ccp/api/src/index.ts:37-105` (middleware chain — no logger), grep-verified absence of `hono/logger`/request-id across `ccp/api/src`
- **Description:** The api emits no access log at all: no method/path/status/latency lines, no request correlation IDs, no client identifier. The only runtime log lines are boot messages, scheduler/drift `console.error`s, and the bootstrap password. The audit chain covers business mutations, but 4xx refusals (auth failures, rate limits, validation), 5xx (see OPS-2), and read traffic leave no trace.
- **Impact:** An operator cannot answer "what was the api doing at 14:32", correlate a user's "it failed" report with anything, or observe error rates and latency trends. Combined with OPS-2, a misbehaving deployment is a black box.
- **Recommendation:** Add a request-logging middleware (Hono ships one) with a per-request ID echoed in a response header; log the ID in the error handler.

### OPS-8 — No graceful shutdown: `npm` as PID 1, no SIGTERM handling, default 10 s grace on the api
- **Severity:** medium
- **Location:** `ccp/api/Dockerfile:100` (`CMD ["npm", "run", "start"]`), `ccp/api/src/server.ts:143-147`, grep-verified absence of signal handlers; `ccp/docker-compose.yml:32-84` (no `stop_grace_period`/`init` on api)
- **Description:** The api's PID 1 is `npm`, which layers `npm → sh → tsx → node` between Docker's SIGTERM and the server, with historically unreliable signal forwarding and exit-code masking. Even when the signal arrives, nothing calls `server.close()` or drains in-flight requests — the process just dies; after 10 s Docker SIGKILLs. Data corruption is prevented by the atomic snapshot writes (a strength), but requests in flight are dropped without responses, and a pending `persist()` chain can be cut after the client was told to expect durability only on response — the request that was mid-`await persist()` simply never answers, which is consistent but abrupt.
- **Impact:** Every deploy/restart (including nightly self-update) is a hard-kill rather than a drain; combined with OPS-3, an armed run in progress makes the kill both certain and mid-side-effect.
- **Recommendation:** `CMD ["node_modules/.bin/tsx", "src/server.ts"]` (or `init: true` in compose), plus a SIGTERM handler that stops accepting, drains, and exits.

### OPS-9 — The documented CI-runner cutover only routes 2 of 8 workflows
- **Severity:** medium
- **Location:** `ccp/docker-compose.yml:108-111`, `ccp/docs/go-live.md:466-471`; actual `runs-on` values: only `.github/workflows/ccp-data.yml:57` and `ccp-onboard.yml:63` use `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`; `catalogctl.yml`, `ccp-api.yml`, `ccp-app.yml`, `ccp-smoke.yml`, `publish-gate.yml`, `release-images.yml` hard-code `ubuntu-latest`
- **Description:** Both the compose file and go-live assert "Every workflow already reads `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`, so bringing this online … is the whole cutover — zero workflow-file edits." Six of the eight workflows do not.
- **Impact:** An operator who stands up the self-hosted runner and sets `CI_RUNNER=ccp` gets most CI still running on GitHub-hosted runners — surprising cost/queueing behavior and a runner that sits mostly idle while the docs claim full cutover.
- **Recommendation:** Either apply the variable pattern to all workflows or correct the two docs to name exactly which lanes cut over.

### OPS-10 — No log rotation and no resource limits on any service
- **Severity:** medium
- **Location:** `ccp/docker-compose.yml` (grep-verified: no `logging:`, `mem_limit`, `cpus`, or `deploy:` anywhere), `ccp/docs/go-live.md:456-461`
- **Description:** All services rely on Docker's default `json-file` driver with no `max-size`/`max-file`, so container logs grow without bound on `/var/lib/docker` — a partition the runbook's "watch disk space" advice (which watches `/data` only) never mentions. The runner in particular relays entire CI job logs. No service has a memory or CPU limit; only the scanner's tmpfs has an explicit ceiling.
- **Impact:** A long-lived host can fill its root/docker partition from logs alone (taking dockerd down with it), and a memory spike in any one container can OOM the host that also holds the governance store.
- **Recommendation:** Add a `logging: {driver: json-file, options: {max-size: …, max-file: …}}` anchor to all services (or document a daemon.json baseline), and set at least memory limits for api and runner.

### OPS-11 — `/readyz` re-verifies every audit chain on every probe; cost grows unboundedly with history
- **Severity:** medium
- **Location:** `ccp/api/src/domain/readiness.ts:41-57`, `ccp/api/Dockerfile:96` (30 s healthcheck), `ccp/scripts/self-update.sh:129` (2 s polling)
- **Description:** Each `/readyz` call runs `exportAuditChain` + hash verification for **every** project — a full read and re-hash of the entire audit history. The Docker healthcheck calls it every 30 s forever; installers and updaters poll it at 1–2 s intervals. Today the store is small; the design explicitly anticipates years of append-only per-project evidence.
- **Impact:** The health probe's cost scales linearly with total audit history × probe frequency; on a mature instance the *health check itself* becomes the dominant steady-state load, and its latency will eventually exceed the 5 s healthcheck timeout, flapping the container unhealthy exactly when nothing is wrong.
- **Recommendation:** Cache the verification verdict (invalidate on chain append), or verify only heads/tails on the probe path and keep full verification for backup/an explicit deep-check endpoint.

### OPS-12 — Scanner service: no healthcheck, and the worker exits on any control-plane error
- **Severity:** low
- **Location:** `ccp/docker-compose.yml:152-180` (no `healthcheck`), `tools/catalogctl/internal/scanworker/worker.go:154-157`
- **Description:** The scanner container is the only long-running service with no healthcheck, so a wedged worker (hung poll, stuck prescan — only the clone has a timeout) looks "Up" indefinitely. Separately, `Run` treats any claim error as fatal and exits, so during api downtime (every self-update rebuild) the scanner crash-loops under Docker restart backoff rather than retrying in-process — functional, but noisy and dependent on restart policy for a routine condition.
- **Impact:** Reduced observability of the one opt-in daemon that does real work; restart-loop noise during every update window.
- **Recommendation:** Add a trivial liveness (e.g. worker touches a file each loop; healthcheck stats it) and retry transient claim failures with backoff in-process.

### OPS-13 — `doctor.sh` reports an unhealthy container as OK
- **Severity:** low
- **Location:** `ccp/scripts/doctor.sh:56-59`
- **Description:** Container status lines are classified by `case "$line" in *Up*)` — but Docker reports unhealthy containers as `Up X minutes (unhealthy)`, which matches `*Up*` and prints a green ✓. (The later `/readyz` probe partially compensates for the api, but not for the runner, whose healthcheck is the only signal doctor has.)
- **Impact:** The one diagnostic operators are told to run can green-light a stack whose healthchecks are failing.
- **Recommendation:** Treat `(unhealthy)` (and `Restarting`) as failures in the case statement.

### OPS-14 — Stale references to a nonexistent `.github/workflows/terraform.yml` anchor the Terraform pin
- **Severity:** low
- **Location:** `ccp/scripts/setup.sh:63-64`, `ccp/toolbox/Dockerfile:26-27`, `ccp/scripts/self-update.sh:174`
- **Description:** Three places claim the `TF_VERSION=1.15.7` pin "matches CI (.github/workflows/terraform.yml TF_VERSION)" — no such workflow exists in the repo (verified against the workflow listing). `self-update.sh --check`'s toolchain-change warning greps for diffs to that same nonexistent path, so half of that guard is dead code.
- **Impact:** The pin has no CI anchor to drift-check against; the setup/toolbox/estate Terraform versions can silently diverge from whatever CI actually uses.
- **Recommendation:** Point the comments (and the `--check` grep) at the real authority for the pin, or add the referenced workflow.

### OPS-15 — GitHub App key directory is not prepared or checked by any tooling
- **Severity:** low
- **Location:** `ccp/docker-compose.yml:71-76` (default host dir `/data/ccp/forge`), `ccp/scripts/setup.sh:260-265` (layout list omits it), `doctor.sh` (no check)
- **Description:** The api bind-mounts `${CCP_GITHUB_APP_KEY_HOST_DIR:-/data/ccp/forge}` read-only, but `setup.sh data` does not create it (dockerd auto-creates it root:root on first `up`) and neither setup nor doctor verifies the key file exists or is readable by uid 1000. A root-owned `0600` PEM dropped in by the operator fails only at claim time, per job.
- **Impact:** Private-repo scanning via the GitHub App fails with a per-job credential error whose root cause (file permissions) is nowhere surfaced.
- **Recommendation:** Add `/data/ccp/forge` to `setup.sh data`'s layout and a doctor check that the configured `CCP_GITHUB_APP_KEY_FILE` resolves and is uid-1000-readable when set.

---

## Minor observations

- **`EXPOSE 8787` vs actual runtime port.** `ccp/api/Dockerfile:52,90` bakes `PORT=8787`/`EXPOSE 8787`, but compose runs the api on 8801; cosmetic, but misleading to anyone reading the image metadata.
- **Production boot logs "`ccp-api dev on :8801`"** (`server.ts:144`) — the word "dev" in a production log line invites mis-triage.
- **The one-time admin password exists only in container stdout** (`scripts/bootstrap.ts:56-59`); the container recreation in go-live Step 5 destroys those logs. `install.sh:132` captures it first (good); the manual path relies on the operator copying it in time — the "shown ONCE" warning is present, so this is by design, but a `docker compose logs` after Step 5 finding nothing is a documented-but-sharp edge (`go-live.md:249-267`).
- **`FileStore.writeAtomic` does not fsync the parent directory after `rename`** (`fileStore.ts:98`), so on power loss the rename itself may not be durable — the window is tiny and the old snapshot survives, so this is a durability nicety, not a bug.
- **Runner dist upgrades overlay-extract into `/runner` without cleaning the previous version's files** (`entrypoint.sh:23-27`); stale assemblies accumulate across pins. Also, the runner's own self-update can advance the live version past the image pin without the `.dist-version` stamp noticing — harmless today, but the stamp then lies.
- **`depends_on: [api]` for the app is ordering-only** (correctly commented, `docker-compose.yml:102-103`); nothing uses `condition: service_healthy` anywhere, which is fine given the SPA is static, but worth noting the healthchecks are informational to compose.
- **Restore-while-running is undefended in code** — `npm run restore` into a live api would be clobbered by the next in-memory persist; go-live consistently says "stop the api" first, so this is doc-guarded only.
- **`run-local.sh` cleanup** correctly kills process groups (`set -m`, `kill -- -PGID`) and removes the throwaway store — a nice touch that many projects get wrong.
- **Image strategy is coherent:** production deploys build `:local` from source, upgrades ride git SHAs through the guarded updater, and GHCR publishes are explicitly demo-only with a documented reason (`release-images.yml:5-16`) — there is no image-tag drift problem because there are no floating production image tags.

---

## Overall grade: **C**

The operational *toolkit* here — guarded self-update with rollback and data manifests, chain-verified backup/restore, a readiness probe that refuses to lie, doctor.sh, migration with an always-written escape hatch — reflects unusually mature thinking, and durable state genuinely survives container recreation. But the grade is capped by outcomes, not intentions: the flagship installer (`install.sh`) and the documented intranet ceremony both deadlock every fresh install into a crash loop (OPS-1); the volume→bind migration auto-rolls back for exactly the legacy hosts it targets (OPS-5); a routine container restart permanently wedges a project's scan-based onboarding (OPS-4); armed-lane runs freeze the entire API and flap its health (OPS-3); and when anything unexpected does go wrong, the api's 500s and request traffic leave no log trace at all (OPS-2, OPS-7). The common thread is that individually correct fail-closed mechanisms (settlement marker, bootstrap refusal, byte-identical verification) were never integration-tested against each other on the paths operators actually walk. Fixing OPS-1/2/3/4/5 — none of which requires redesign — would raise this to a B+.
