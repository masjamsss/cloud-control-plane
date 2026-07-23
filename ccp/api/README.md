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
| `CCP_DRIFT_KEEP` | `90` | Drift report versions retained per project; older versions (rows + on-disk files) are pruned best-effort after each successful stage. |
| `CCP_DRIFT_PROPOSALS` | _(unset — **disarmed**)_ | `1` arms slice-2 proposal generation (drift-portal spec §6.3): after a report stages, the api asynchronously runs `CCP_DRIFT_GEN_CMD` and reconciles its output into the proposal store. Requires ALL of the next two; anything missing ⇒ generation never schedules — the report still stages either way (fail-open). |
| `CCP_DRIFT_GEN_CMD` | _(unset)_ | Operator-configured generator: runs with `$DRIFT_CHECKOUT` (scratch clone of `main`) + `$DRIFT_ENVELOPE` (the staged envelope) + `$DRIFT_OUT` (where to write `proposals.json`); the command runs `catalogctl drift-propose` inside it. Exit 0 + a valid `ccp.drift-proposals/v1` document at `$DRIFT_OUT` ⇒ reconciled into the proposal store. |
| `CCP_GIT_REMOTE` (shared with the bundle) | _(unset)_ | Also the checkout source for `CCP_DRIFT_GEN_CMD`'s scratch clone (branch: `CCP_GIT_BRANCH`, default `main`) — one credential, two lanes. |

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

The durable store is a single JSON snapshot file (accounts, sessions, the per-project
hash-chained audit log, policy). The audit chain is the **evidence-of-record**, so
backups are verified copies and restore refuses to install an unverifiable one.

```bash
# Snapshot the live data file (atomic copy; verifies + reports the audit chain).
npm run backup -- --out /backups/ccp-$(date +%F).json

# Recover after a disk/host loss (atomic write; refuses a corrupt backup).
npm run restore -- --from /backups/ccp-2026-07-12.json
```

- `backup` reads the data file (`--data`, default = the resolved `CCP_DATA_*`
  path), validates it, prints `accounts` + per-project `audit … verified=…`, and
  writes a byte-for-byte atomic copy to `--out` (default `<data>.backup-<timestamp>.json`).
  A damaged source is still captured (for forensics) with a loud warning.
- `restore` reads `--from`, re-verifies every audit chain, and only then atomically
  replaces the data file (`--data`, default = resolved path). If a chain does **not**
  verify it refuses (exit 1) — pass `--force` for a deliberate disaster restore. The
  write is temp-file + fsync + rename, so an interrupted restore leaves the old file intact.

Restore into a **stopped** API (the running process holds state in memory and
re-snapshots on the next mutation, which would overwrite a hot restore). Start the API
after restoring; it load-verifies the file on boot and `/readyz` re-confirms the chain.

## Health & readiness probes

| Endpoint | Meaning | Wire to |
| --- | --- | --- |
| `GET /healthz` | **Liveness** — the process is up and serving. Deliberately shallow: `200 {"ok":true}` even with an empty store. | container/liveness probe (restart-on-fail) |
| `GET /readyz` | **Readiness** — store loaded + `accounts` count + every project's audit chain verifies. `200` only when all hold; `503` with `reasons` otherwise. | load-balancer/readiness probe (take out of rotation) |

`/readyz` exists because `/healthz` cannot tell a healthy store from an emptied or
corrupted one. A wiped store (0 accounts) or a broken audit chain returns **503** with
a machine-readable body, e.g.:

```json
{ "ready": false, "storeLoaded": true, "accounts": 0,
  "chains": [{ "projectId": "sample", "count": 0, "verified": true }],
  "reasons": ["store holds 0 accounts — an emptied/wiped store is not ready ..."] }
```

Both probes are unauthenticated (no session required).
