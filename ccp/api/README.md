# ccp-api

The Cloud Control Plane governance backend: durable identity, per-project hash-chained audit,
and the dual-control config surface. This document is the **deploy reference** —
every environment variable, the production start path, and the operational runbooks.

## Runtime

```bash
npm ci
npm run start      # production entrypoint (tsx src/server.ts)
npm run dev        # local dev with watch/reload
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

`npm run start` runs the same `src/server.ts` entrypoint as dev, without file
watching. It selects the **durable FileStore by default** and runs a production
**preflight** that refuses to boot on an insecure/incomplete config (see below).

### TLS is terminated externally

This process speaks **plain HTTP** and is designed to run **behind an external
reverse proxy / load balancer (nginx, ALB, Caddy, …) that terminates TLS**. There is
no in-process certificate. The proxy MUST:

- terminate HTTPS and forward to the API's `PORT`;
- serve the SPA and the API such that the browser only ever talks HTTPS (so the
  `Secure` session cookie is actually sent).

`Secure` cookies are therefore driven by **env** (`CCP_SECURE_COOKIES`, default
ON in production), not by an in-process TLS listener.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | _(unset)_ | `production` enables the deploy preflight and turns Secure cookies ON by default. Anything else = dev/test posture (http-friendly). |
| `PORT` | `8801` | HTTP port the API listens on (behind the TLS proxy). |
| `CCP_STORE` | _(unset → FileStore)_ | `memory` selects the process-bound store (tests / throwaway dev). **Refused in production** — it is not durable. |
| `CCP_DATA_DIR` | `.ccp-data` | Directory for the durable snapshot file (`ccp.json`). Point this at a persistent volume. |
| `CCP_DATA_FILE` | `<CCP_DATA_DIR>/ccp.json` | Explicit override of the full data-file path (wins over `CCP_DATA_DIR`). |
| `CCP_STORE_VALIDATE` | `warn` | DATA-5: whether a loaded row that does not match its entity schema (a hand-edit, a half-restored backup, a row from an incompatible version) blocks boot. `warn` (default) boots anyway and logs every violation, naming the row and its failing fields. `strict` refuses to boot on any violation — an explicit operator choice, since a store already holding bad rows failing to boot is exactly the moment nobody can afford a surprise. `off` skips the check entirely. An unrecognized value falls back to `warn`, never `off`. |
| `CCP_BOOTSTRAP` | _(unset)_ | `1` runs first-boot provisioning in-process (seeds one admin Lead, prints a one-time password). **Refused once a data file exists** — exits non-zero. |
| `CCP_LEGACY_PROJECT_ID` | _(unset)_ | Only for a deployment upgrading a store born **before multi-project support**: the project id that store's data lives under. Consulted **once**, at the first boot without a settlement marker; inert afterwards. Leave unset on fresh installs. A store with pre-multi-project (bare) account rows and no value here **refuses to start** (by design) — set it to that store's id and reboot. |
| `CCP_TOTP_KEY` | _(unset)_ | Key for the TOTP secret cipher (AES-256-GCM). **Required in production** — privileged (approver/lead/admin) enrollment fails without it. Use a stable, high-entropy value; rotating it invalidates enrolled factors. |
| `CCP_SECURE_COOKIES` | _(prod: ON)_ | Force the session cookie's `Secure` flag on/off (`true`/`false`). Unset → ON in production, OFF elsewhere. Do **not** disable behind TLS. |
| `CCP_COOKIE_SAMESITE` | `Lax` | Session cookie `SameSite`: `Lax` (default), `Strict`, or `None`. A **cross-origin** credentialed SPA needs `None` (+ Secure); a same-origin deploy keeps `Lax`. CSRF is enforced by the `x-ccp-client` header, not by SameSite. |
| `CCP_CORS_ORIGIN` | _(empty)_ | Comma-separated exact browser origins allowed to authenticate with credentials (e.g. `https://ccp.example.com`). Empty = no cross-origin access. **Required in production** unless `CCP_SAME_ORIGIN=1`. |
| `CCP_SAME_ORIGIN` | _(unset)_ | `1` acknowledges the SPA is served **same-origin** behind the proxy, so an empty `CCP_CORS_ORIGIN` is intentional and the preflight allows it. |
| `CCP_BUNDLE` | _(unset — **disarmed**)_ | `1` arms the [ADR-0016](../../docs/adr/0016-ccp-approval-to-apply-bundle.md) approval-to-apply bundle (`POST /requests/:id/apply`). Requires ALL of the next three; anything missing ⇒ the endpoint answers `BUNDLE_DISARMED` and the deploy is inert. |
| `CCP_GIT_REMOTE` / `CCP_GIT_BRANCH` | _(unset)_ / `main` | Pushable clone URL (bot credential embedded/via helper — see Credentials) + target branch for the bundle's compare-and-swap commit. Never force-pushes. |
| `CCP_BUNDLE_GATE_CMD` | _(unset)_ | Operator-configured gate: runs with `$BUNDLE_CHECKOUT` (scratch clone) + `$BUNDLE_REQUEST` (request JSON); must make the approved edit, verify plan == the approved change and NOTHING else (plan-check + digest), and exit 0. Non-zero ⇒ nothing is committed. |
| `CCP_BUNDLE_TRIGGER_CMD` | _(unset)_ | Operator-configured trigger: satisfies the gated CI apply for `$BUNDLE_SHA` (e.g. the GitHub deployment-approval API). The apply itself stays in gated CI — the api never runs terraform. |
| `CCP_DRIFT` | _(unset — **disarmed**)_ | `1` arms the drift-on-the-portal ingest + serve lane: `PUT /projects/:id/drift` (the same upload token `PUT /:id/data` mints — no new credential) and `GET /projects/:id/drift`. Unset ⇒ PUT answers `DRIFT_DISARMED`, GET answers `{connected:false}`. |
| `CCP_DRIFT_RESTORE` | _(unset — **disarmed**)_ | `1` arms `restore`-flavor drift proposal SUBMIT specifically (the restore lane), in addition to `CCP_DRIFT` above — an out-of-band-deletion restore re-asserts the code already on `main` over the deleted address(es). Unset ⇒ submitting a restore proposal answers `409 DRIFT_DISARMED` naming this flag; serving a restore proposal (`GET /projects/:id/drift`) rides `CCP_DRIFT` alone. Generation itself is armed separately, via `--enable-restore` inside the operator's own `CCP_DRIFT_GEN_CMD` below (the `--enable-import` precedent). |
| `CCP_DRIFT_IMPORT` | _(unset — **disarmed**)_ | `1` arms `import`-flavor drift proposal SUBMIT specifically (OOB provisioning-import spec §9/§6), in addition to `CCP_DRIFT` above — a distinct, narrower gate so an operator can serve findings (and even adopt/revert) without yet arming the import lane. Generation itself is armed separately, via `--enable-import` inside the operator's own `CCP_DRIFT_GEN_CMD` below. |
| `CCP_DRIFT_KEEP` | `90` | Drift report versions retained per project; older versions (rows + on-disk files) are pruned best-effort after each successful stage. |
| `CCP_DRIFT_PROPOSALS` | _(unset — **disarmed**)_ | `1` arms slice-2 proposal generation (drift-portal spec §6.3): after a report stages, the api asynchronously runs `CCP_DRIFT_GEN_CMD` and reconciles its output into the proposal store. Requires ALL of the next two; anything missing ⇒ generation never schedules — the report still stages either way (fail-open). |
| `CCP_DRIFT_GEN_CMD` | _(unset)_ | Operator-configured generator: runs with `$DRIFT_CHECKOUT` (scratch clone of `main`) + `$DRIFT_ENVELOPE` (the staged envelope) + `$DRIFT_OUT` (where to write `proposals.json`); the command runs `catalogctl drift-propose` inside it. Exit 0 + a valid `ccp.drift-proposals/v1` document at `$DRIFT_OUT` ⇒ reconciled into the proposal store. |
| `CCP_DRIFT_CHECK_CMD` | _(unset)_ | Arms the portal's "start drift check" button (`POST /projects/:id/drift/check`, Lead/admin only) — an OPERATOR command wired to the estate's existing drift workflow's `workflow_dispatch` (e.g. `gh workflow run drift.yml -f project=$CCP_DRIFT_PROJECT`; the api never runs terraform). Run with env `CCP_DRIFT_PROJECT=<id>`; exit 0 = fired. The report only lands later, through the normal `PUT /:id/drift` publish — this button only asks the workflow to run. Unset ⇒ the route answers `409 DRIFT_DISARMED` naming this flag. |
| `CCP_GIT_REMOTE` (shared with the bundle) | _(unset)_ | Also the checkout source for `CCP_DRIFT_GEN_CMD`'s scratch clone (branch: `CCP_GIT_BRANCH`, default `main`) — one credential, two lanes. |
| `CCP_GIT_PROJECT` | _(unset)_ | **Which estate `CCP_GIT_REMOTE` belongs to** (ARCH-2). Both armed lanes resolve their checkout **per project**: a project that has registered a repository (`POST /projects`, served as `repo`/`github`) is cloned from *its own* repository, never from `CCP_GIT_REMOTE`. Set this to a project id when the deployment-global remote **is** that estate's — e.g. a credentialed push URL, which the registered clone URL cannot be (it is a scanner reference and embedded credentials are refused by construction). The named project then uses `CCP_GIT_REMOTE` verbatim, and **every other project must bring its own repository or be refused** (`BUNDLE_REPO_UNRESOLVED` / `DRIFT_REPO_UNRESOLVED`). Unset keeps the legacy single-estate behaviour: `CCP_GIT_REMOTE` serves any project that registers no repository of its own — safe with one estate, and the reason this variable exists once there are two. |
| `CCP_DATA_LOCK_TAKEOVER` | _(unset)_ | `1` clears a data-file write lock this process cannot verify — one held by **another host**, or one it cannot parse (CONC-7/DATA-9). The data file has exactly ONE writer: `FileStore` rewrites the whole snapshot from its own in-memory map on every mutation, so a second process silently destroys the first's writes across accounts, sessions, requests and both audit chains, with every in-process concurrency guard void between them. The holder **heartbeats** its claim every 30s, and a claim unrefreshed for 120s is cleared automatically — so a crash, an OOM kill or a recreated container recovers by itself, whatever hostname or pid namespace it comes back with. A dead pid on the same host is cleared immediately as a fast path. A claim that is still beating refuses. Set this only after confirming no other process — including `npm run restore` and `grant-admin`, which take the same lock — is writing that file. |
| `CCP_APPLY_FROZEN` | _(unset)_ | `1` is the 0038 auto-apply scheduler's operator **emergency stop**: every tick still runs, but no due request is auto-applied while frozen — re-read every tick, so an operator can freeze/unfreeze WITHOUT a redeploy. Only meaningful when `CCP_SCHEDULER=1` below. |
| `CCP_APPLY_AUTO_REVERT` | _(unset)_ | `1` opts a failed scheduled auto-apply into an automatic revert attempt, instead of leaving the request halted (`APPLY_FAILED_HALTED`) for a human to resolve. Only meaningful when `CCP_SCHEDULER=1` below. |

> **Containerized arming.** In the `docker compose` deploy (the default — see
> [`docs/go-live.md`](../docs/go-live.md)), `CCP_BUNDLE_GATE_CMD` and
> `CCP_DRIFT_GEN_CMD` run *inside the api container* and typically shell out to the
> **toolbox image** (`ccp-toolbox:local` — pinned Terraform + the built `catalogctl`,
> see [`toolbox/`](../toolbox/)) as a sibling container, not to binaries on the host.
> Arming needs the opt-in [`docker-compose.armed.yml`](../docker-compose.armed.yml)
> overlay — it grants the api container the docker socket (root-equivalent on that host;
> arm only on a host dedicated to the portal) and sets `TMPDIR=/data/scratch`, bind-mounted
> at the **same path** in the api container and on the host, so the checkouts these
> commands create under `TMPDIR` (`$BUNDLE_CHECKOUT`/`$DRIFT_CHECKOUT` and friends) are
> visible to a `docker run -v /data/scratch:/data/scratch … ccp-toolbox:local …`
> invocation too. Full ceremony + a command template:
> [`docs/go-live.md` → "Toolbox + armed lanes"](../docs/go-live.md#toolbox--armed-lanes).

## Credentials and secrets

**What you provide, where it goes, and in what format.** Every secret the control plane
touches, its format, and where it belongs. The posture
from [SECURITY.md](../../SECURITY.md): secrets live in your secret store (AWS Secrets
Manager / SSM Parameter Store) and are injected as environment variables at start —
**never committed to git**. A single-host `docker compose` deploy may instead keep them in
`ccp/.env` (git-ignored; `scripts/setup.sh env` writes it) — treat that file as a secret
(`chmod 600`). Only **two** secrets are ever operator-supplied: `CCP_TOTP_KEY` and, if you
run the account-data CI job, `CCP_UPLOAD_TOKEN`. Everything else is set in the UI or
managed outside the control plane.

| Secret / credential | Format | Where it goes | Required |
|---|---|---|---|
| **`CCP_TOTP_KEY`** — AES-256-GCM key encrypting enrolled 2FA at rest | base64, high-entropy — `openssl rand -base64 48` | api env var, or `ccp/.env`. Rotating it invalidates every enrolled 2FA | **Yes** (prod) |
| **First-boot admin password** — one-time password for the seeded admin | random string, printed **once** to the api log | you read it from `docker compose logs api`, then change it on first sign-in (see "First boot") | one-time |
| **Account passwords** — each user's login | chosen in the portal UI; stored **argon2id-hashed** | the durable FileStore — never a file, never plaintext | per user |
| **Per-user TOTP (2FA)** — second factor for privileged roles | enrolled via an authenticator app (QR → 6-digit); the secret is stored AES-GCM-encrypted under `CCP_TOTP_KEY` | the durable FileStore | privileged roles |
| **`CCP_UPLOAD_TOKEN`** — per-project CI key for `PUT /projects/:id/data` and, since the drift-portal spec, `PUT /projects/:id/drift` (same token, same trust tier — no new credential kind) | opaque token, shown **once** at mint; sent as `Authorization: Bearer <token>`; stored **argon2id-hashed** | minted in **Admin → Projects → upload key**; stored in the *estate repo's* CI secret store (GitHub Actions **secret** / GitLab **masked+protected** variable) — never in the repo | only for the data/drift CI jobs |
| **AWS credentials** — for `terraform plan` against the estate | **not stored by the control plane**. Humans: AWS SSO (`aws sso login`, read-only). CI: GitHub OIDC → short-lived roles | the standard AWS credential chain / SSO profile on the box; never in git or `.env` | only where Terraform runs |
| **Change-PR token** (GitHub/GitLab) — to open the bot PR against the estate | provided & rotated by you **out of band** | **not consumed by the api yet** — the auto-apply bridge ([ADR-0012](../../docs/adr/0012-ccp-auto-apply.md)) is unbuilt, so there is no env var for it today | future |

Companion **non-secret** config for the account-data CI job (set as CI *variables*, not
secrets): `CCP_CONTROL_PLANE_URL` (this api's base URL), `CCP_PROJECT_ID`, and
`CCP_SCAN_ROOT` (only if the Terraform root isn't `environments/prod`). Full setup +
minting flow: [docs/runbooks/account-data-ci.md](../../docs/runbooks/account-data-ci.md).
AWS plan credentials: provisioning the CI service identity that posts `terraform plan`
summaries is a per-deployment operational step — see your deployment's own runbook for it.

> The auto-apply executor env (`CCP_EXECUTOR=terraform` + an absolute `CCP_TF_ROOT`,
> `CCP_SCHEDULER=1`) is a **proof milestone, not a live posture** — when enabled it uses the
> process's standard AWS credential chain. Leave it unset for a normal portal deploy.

## Production preflight (fail-closed)

When `NODE_ENV=production`, `npm run start` refuses to boot (non-zero exit, clear
stderr) if any of these hold — nothing binds a port or opens the store until they
are fixed:

- `CCP_STORE=memory` — not durable; a restart would drop the whole governance DB.
- `CCP_SECURE_COOKIES` disabled — sessions would ride over plaintext HTTP.
- `CCP_COOKIE_SAMESITE=None` without Secure — browsers reject the cookie.
- `CCP_CORS_ORIGIN` empty **and** `CCP_SAME_ORIGIN` not set — no browser
  origin could authenticate.
- `CCP_TOTP_KEY` unset — the TOTP cipher has no key.

Outside production the preflight is a no-op, so local dev and the test suite (and
B2's restart-survival proof, which boots with `NODE_ENV=development`) are unaffected.

## First boot

```bash
CCP_BOOTSTRAP=1 CCP_DATA_DIR=/var/lib/ccp \
  NODE_ENV=production CCP_TOTP_KEY=… CCP_CORS_ORIGIN=https://… \
  npm run start
```

Bootstrap seeds exactly one admin Lead and prints a **one-time password** (shown
once — change it on first sign-in). It is **refused once a data file exists**, so a
redeploy never reseeds a fresh admin over the live audit chain. Drop
`CCP_BOOTSTRAP` for all subsequent starts.

## Backup & restore (disk/host recovery)

The durable state spans **two** stores, and both matter (DATA-10): the JSON snapshot
file (accounts, sessions, the per-project hash-chained audit log, policy) AND the
on-disk project-data/drift root the snapshot's rows point into (`ProjectItem.dataActive`,
`DriftPointerItem` — served inventory, manifests, block chunks, drift reports, drift
proposal bodies). `backup`/`restore` capture and install **both together, from the same
moment**, so a restore never reconstructs rows that reference files a different backup
generation left behind. The audit chain is the **evidence-of-record**, so the snapshot
half is a verified copy and restore refuses to install an unverifiable one.

```bash
# Snapshot the live data file + project-data root (atomic copies; verifies + reports the audit chain).
npm run backup -- --out /backups/ccp-$(date +%F).json

# Recover after a disk/host loss (atomic writes; refuses a corrupt backup).
npm run restore -- --from /backups/ccp-2026-07-12.json
```

- `backup` reads the data file (`--data`, default = the resolved `CCP_DATA_*`
  path), validates it, prints `accounts` + per-project `audit … verified=…`, and
  writes a byte-for-byte atomic copy to `--out` (default `<data>.backup-<timestamp>.json`).
  A damaged source is still captured (for forensics) with a loud warning. It then also
  copies the project-data root (`--project-data`, default = the resolved
  `<CCP_DATA_DIR>/projects`) into a companion `<out-without-.json>.projects/` directory
  alongside it — atomically, and skipped only if the root does not exist yet (a fresh
  install with no projects onboarded) or `--skip-project-data` is passed.
- `restore` reads `--from`, re-verifies every audit chain, and only then atomically
  replaces the data file (`--data`, default = resolved path). If a chain does **not**
  verify it refuses (exit 1) — pass `--force` for a deliberate disaster restore. The
  write is temp-file + fsync + rename, so an interrupted restore leaves the old file intact.
  It then looks for that backup's companion `.projects/` directory (by convention next
  to `--from`, or `--project-data` to point elsewhere) and, if found, **replaces the
  project-data root wholesale** (`--project-data`, default = resolved path) — never
  merged, so the result is exactly what the one backup captured. A backup made before
  this feature (or with `--skip-project-data`) has no companion directory: restore still
  installs the store and **warns loudly** rather than either refusing or silently leaving
  served files that may now be inconsistent with the restored rows — `/readyz`'s
  presence cross-check (below) is the safety net for exactly that gap. `--skip-project-data`
  on restore leaves the current project-data root untouched even when a companion backup
  exists.

Restore into a **stopped** API (the running process holds state in memory and
re-snapshots on the next mutation, which would overwrite a hot restore; it also
actively reads/writes the project-data root). Start the API after restoring; it
load-verifies the file on boot and `/readyz` re-confirms both the audit chain AND
(DATA-10) that every project's active served-data version and drift report actually
have files on disk.

## Health & readiness probes

| Endpoint | Meaning | Wire to |
| --- | --- | --- |
| `GET /healthz` | **Liveness** — the process is up and serving. Deliberately shallow: `200 {"ok":true}` even with an empty store. | container/liveness probe (restart-on-fail) |
| `GET /readyz` | **Readiness** — store loaded + `accounts` count + every project's audit chain verifies + (DATA-10) every project's ACTIVE served-data version and drift report actually have files on disk. `200` only when all hold; `503` with `reasons` otherwise. | load-balancer/readiness probe (take out of rotation) |

`/readyz` exists because `/healthz` cannot tell a healthy store from an emptied or
corrupted one. A wiped store (0 accounts), a broken audit chain, or a `dataActive`/drift
pointer whose files are missing from the project-data root (a disk-death restore that
lost — or restored from a different backup generation than — the store JSON) returns
**503** with a machine-readable body, e.g.:

```json
{ "ready": false, "storeLoaded": true, "accounts": 0,
  "chains": [{ "projectId": "sample", "count": 0, "verified": true }],
  "storeItemCount": 41,
  "reasons": ["store holds 0 accounts — an emptied/wiped store is not ready ..."] }
```

`storeItemCount` (ARCH-9) is the total row count the store currently holds —
informational telemetry, never a readiness gate. Nothing here compacts or
archives: every account, session, request, and per-project audit/drift entry
accretes forever, so this is the number to alert an operator on (an external
threshold — this API does not itself flag "too big") before write latency
starts to reflect it. See "Scaling & the single-process invariant" below.

Both probes are unauthenticated (no session required).

`/readyz` verifies each chain in full on the first probe of a process, then re-hashes
only entries appended since — a probe on a timer must not get slower every day the
estate is used. `GET /admin/audit/export` and `scripts/verify-audit-chain.ts` remain
the full, uncached verifications. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md#deliberate-trade-offs).

## Performance

[docs/PERFORMANCE.md](docs/PERFORMANCE.md) records what the API costs, where the cost
was, and the trade-offs taken — all of it reproducible:

```bash
npx tsx scripts/bench.ts --scale 8000 --store both --concurrency 32
```

The bench boots the real app against a deterministically seeded store and reports
p50/p95/p99 plus concurrent throughput per endpoint, for the MemoryStore and the
FileStore. Run it before and after a change with `--json` to A/B a diff.

## Scaling & the single-process invariant (ARCH-9)

**Run exactly one `ccp-api` process against one data directory.** This is
enforced TODAY for the store itself (below), but four other pieces of
correctness-relevant state live only in this ONE process's memory, with no
cross-process visibility at all — a second process, or the planned DynamoDB
`ConfigStore` implementation (which is explicitly designed to allow more than
one process, unlike `FileStore`), would silently diverge on every one of them,
with no error anywhere:

| In-process singleton | Where | What it does | What breaks with >1 process |
| --- | --- | --- | --- |
| The store's single-writer lock | `store/fileStore.ts`, `store/dataLock.ts` (CONC-7/DATA-9) | `FileStore` rewrites the ENTIRE snapshot from its private in-memory map on every mutation; a pid/host lock file REFUSES a second process from opening the same data file at all. | Nothing — this is the one singleton already structurally enforced. A `DynamoDB` store has no such lock (rows are independently writable), so this protection does **not** carry over automatically; the other four rows in this table are the reason it still needs to. |
| Known-projects routing cache | `projects.ts` (`KNOWN`, `hydrated`) | Every request's `x-ccp-project` binding check and account-scope validation reads this in-process `Set`, hydrated lazily and refreshed only by the SAME process that handled a registry write (project completed, archived, deregistered). | A second process's cache never sees the first process's registry write. It keeps routing to (or refusing) a project by a stale ready/archived state — wrong-tenant access decisions with no error, since nothing about the check itself fails. |
| Upload-lane rate-limit buckets | `middleware/rateLimit.ts` (`uploadBuckets`) | A per-tokenId token bucket that throttles `PUT /projects/:id/data` BEFORE the expensive argon2id verify — deliberately in-memory (the doc comment there is explicit: "the cost being defended is THIS process's argon2 work"). | Each process enforces its own independent quota — an attacker (or a misbehaving CI job) spread across N processes gets N× the intended burst capacity. Not a correctness bug (the design already accepts "a restart forgets counters"), but the throttle's real ceiling silently becomes N times looser than configured. |
| Drift-check / drift-generation in-flight guards | `domain/driftCheck.ts` (`inFlightProjects`), `domain/driftProposals.ts` (its own `genState`-shaped guard) | A `Set<projectId>` refusing a second concurrent trigger for the same project — "one in flight per project", the same shape as the bundle/scheduler reentrancy guards. | Two processes can each believe they hold the ONLY in-flight run for a project and both trigger the operator's shell command concurrently — the guard's whole purpose (never double-fire an external workflow_dispatch/generation command) is defeated with zero indication either run knew about the other. |
| Scheduler tick reentrancy flag | `domain/apply/loop.ts` (`inFlight`, inside `maybeStartSchedulerLoop`) | Skips a `setInterval` tick if the previous one is still running, so a slow `executor.apply` never overlaps itself. | Lower risk than the others: this flag is explicitly "defense-in-depth atop the scheduler's own claim-first single-apply guard" (a CAS on the request row itself, which IS safe across processes/DynamoDB). Two processes each ticking independently would duplicate WORK (both scan `knownProjects()` and attempt claims) but not duplicate an APPLY — the claim's `ifEquals` guard is what actually prevents that, not this flag. |

**Before any of this changes** (a second replica, a load balancer fronting
more than one `ccp-api`, or the DynamoDB `ConfigStore` implementation the
seam already anticipates — `store/configStore.ts`'s own doc comment): every
row above needs either a shared/coordinated replacement (the routing cache
and the drift in-flight guards are the two that actually need one — a TTL,
a pub/sub invalidation, or a store-level claim analogous to the scheduler's
own row CAS) or a documented decision that per-process behavior is
acceptable (plausible for the rate-limit buckets, whose design already
tolerates a coarser, restart-losable quota).

Audit-chain archival/compaction (so `storeItemCount` above stops growing
unbounded — month-partitioned keys already anticipate this) is real design
work belonging to whichever change actually introduces a second process or
the DynamoDB backend, not to this note; recorded here as a known
prerequisite, not implemented by it.
