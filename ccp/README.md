# Cloud Control Plane

Cloud Control Plane is a **generic, multi-account self-service portal for Terraform
changes**. Read the [PRD](../PRD.md) first — it is the single source of truth; if this file
and the PRD ever disagree, the PRD wins. Decisions are tracked one-per-file in the
[ADR ledger](../docs/adr/README.md).

The shape of one change: an operator files a request through a form → the right people
approve it (risk-based, second factor on riskier sign-offs) → the tool deterministically
writes the Terraform change → it becomes a change proposal (a GitHub pull request or GitLab
merge request) → automated gates verify the plan matches exactly what was reviewed → the
change **applies automatically** to that account. A person approves every request; the work
*after* the approval is hands-off, held safe by the guardrails in the [PRD](../PRD.md) (scoped
per-account write credentials, reviewed-plan-equals-applied-plan, apply windows,
halt-on-drift, blast-radius limits). No AI sits anywhere in the request path.

This is the **open, estate-agnostic core** — see the repo-root [README](../README.md) for the
"ships blank" design principle. No account, organisation, or catalog data is baked in;
`app/src/data/` bundles one clearly-labeled **sample** estate for demos and tests only,
never a privileged runtime default. A real deployment onboards its own account(s) the same
way `app/src/data/projects/bootstrap/` demonstrates end to end — see "Adopt Cloud Control
Plane in a foreign repo" below.

## The three components

| Component | What it is | Lives at |
|---|---|---|
| **`ccp-app`** | The SPA: Vite + React 19 + TypeScript-strict. Manifests → deterministic interpreter → rendered form → review/diff → submit. Runs fully standalone (bundled mock backend) or wired to a real `ccp-api`. | [`app/`](app/) |
| **`ccp-api`** | The authoritative backend: Node + Hono. Server-side sessions (argon2id, httpOnly cookies, TOTP for privileged roles), server-enforced authz (`canRequest`/`canApprove`/`exposure`/account↔project binding), hash-chained tamper-evident audit, dual-control on privilege-affecting config. Durable by default (`FileStore`, a JSON snapshot file) — not SQLite, not DynamoDB (that's a target, not what's shipped). | [`api/`](api/) — deploy/runtime reference: [`api/README.md`](api/README.md) |
| **`catalogctl`** | The Go HCL codemod — **the only thing that writes Terraform**. Neither `app` nor `api` edits `.tf` files directly; both go through `catalogctl edit` (directly, or via `pr-prepare` for the bot-PR bundle). Lives outside `ccp/` because it operates on the whole repo, not just the control plane's own code. | [`tools/catalogctl/`](../tools/catalogctl/) — see [`tools/catalogctl/README.md`](../tools/catalogctl/README.md) |

The request lifecycle: **manifests + inventory** (`app/src/data/`) → **interpreter** (pure
lookup, no model, no network) → **form** → **review/diff** → **submit** → `ApiClient` seam
(`app/src/lib/api.ts`) → mock today by default, or `ccp-api` in api-mode → an **approved**
request becomes a `catalogctl pr-prepare` bundle → a PR whose plan is checked by
`catalogctl plan-check` before it's mergeable.

Docker packaging for these three components — one profile-gated `docker-compose.yml` —
also lives in this tree:

| Path | What it is |
|---|---|
| [`runner/`](runner/) | Self-hosted GitHub Actions runner image (opt-in `runner` compose profile) — see [`docs/go-live.md` → "CI runner"](docs/go-live.md#ci-runner). |
| [`toolbox/`](toolbox/) | Pinned Terraform + the built `catalogctl`, for armed-lane operator commands (opt-in `toolbox` compose profile, run-on-demand — not a daemon) — see [`docs/go-live.md` → "Toolbox + armed lanes"](docs/go-live.md#toolbox--armed-lanes). |
| [`docker-compose.armed.yml`](docker-compose.armed.yml) | Opt-in overlay that grants the api container the docker socket, for `CCP_BUNDLE_GATE_CMD`/`CCP_DRIFT_GEN_CMD` — never on by default. |

## Mock mode vs. api mode

The SPA defaults to a **bundled in-memory mock** (`createMockApiClient()`) so it runs with
**no backend, no network, no AI** — you can clone the repo and use it standalone. Setting
`VITE_API_BASE` at build/dev time (see [`app/.env.example`](app/.env.example)) swaps in the
real `ccp-api` HTTP client behind the identical `ApiClient` interface
(`app/src/lib/api.ts`, `app/src/lib/apiSession.ts::isApiMode`). Both modes render the same UI;
only where state lives (and whether anything is actually enforced) changes.

## Prerequisites & install

| Piece | Needs | Version | Install |
|---|---|---|---|
| `ccp/app` | Node.js | `>=20` (`package.json` `engines`; CI runs Node 20) | `nvm install 20` / `fnm install 20`, then `cd ccp/app && npm ci` |
| `ccp/api` | Node.js | `>=22` (`package.json` `engines`; CI runs Node 22) | `nvm install 22` / `fnm install 22`, then `cd ccp/api && npm ci` |
| `catalogctl` (the Terraform writer) | Go | `1.25` (`tools/catalogctl/go.mod`) | see [`tools/catalogctl/README.md`](../tools/catalogctl/README.md) |
| Foreign-repo inventory build | Python 3.10+ | — | `pip install python-hcl2` (only third-party dep) — see "Adopt Cloud Control Plane in a foreign repo" below |

Local Node major matters more than usual here: `ccp/app`'s `lint`/`format:check` are only
reliable on Node 20 (CI's version) — `./scripts/gate.sh app` from the repo root already knows
this and skips them on a mismatched local Node, deferring to CI. Full production deploy
prerequisites (env vars, TLS-proxy expectations, the fail-closed preflight) are **not**
repeated here — see [`api/README.md`](api/README.md), which is the deploy reference.

## Set up from zero

Two commands take a fresh box from clone to a running trial:

```bash
cd ccp
scripts/setup.sh          # checks toolchains, installs deps, writes .env
                          # (generates CCP_TOTP_KEY), installs the pinned Terraform CLI
scripts/run-local.sh      # bring it up: prints the URL + a one-time admin password
```

`setup.sh` is idempotent and never runs `terraform apply` or touches AWS. Run a single phase
with `scripts/setup.sh <check|install|env|data|terraform>`, or `--help` for the flags. The
only secret you provide is `CCP_TOTP_KEY` (generated for you); the full list is in
[Credentials and secrets](api/README.md#credentials-and-secrets).

**For a real HTTPS deploy** — mount a persistent disk at `/data` (the one place every piece
of durable state lives; `scripts/setup.sh data` lays out its tree with the right
owners/modes), add an nginx vhost (it won't disturb your other sites), then the containers
(app on `8800`, api on `8801`, loopback-only behind the proxy):

```bash
sudo scripts/setup.sh data
sudo scripts/nginx-vhost.sh --host ccp.example.com \
     --cert /etc/letsencrypt/live/ccp.example.com/fullchain.pem \
     --key  /etc/letsencrypt/live/ccp.example.com/privkey.pem
cd ccp && docker compose up -d --build
```

Add `--profile runner` to that last command (or set `COMPOSE_PROFILES=runner` in `.env`) to
also bring up the self-hosted CI runner, and `docker compose --profile toolbox build toolbox`
to build the pinned-Terraform + `catalogctl` toolbox image — both opt-in and off by default;
see [`docs/go-live.md`](docs/go-live.md) for the CI runner's one manual registration step and
the toolbox / armed lanes.

Then follow [`docs/go-live.md`](docs/go-live.md) for the first-boot admin, health checks, and 2FA.

## Run it

```bash
# ccp-app (SPA) — mock mode, nothing else required
cd ccp/app
npm ci
npm run dev            # http://localhost:5173, bundled mock backend
npm test                # vitest
npm run typecheck        # tsc --noEmit
npm run build             # tsc --noEmit && vite build
npm run lint               # eslint
npm run contrast            # AA contrast gate
npm run help:check           # every op needs a help string — CI-blocking
npm run verify:safety          # manifest safety invariants
```

```bash
# ccp-api (backend) — separate terminal, then point the app at it
cd ccp/api
npm ci
npm run dev             # tsx watch src/server.ts — memory or file store, dev posture
npm test                 # vitest
npm run typecheck         # tsc --noEmit
```

```bash
# app in api-mode, once ccp-api is running
cd ccp/app
VITE_API_BASE=http://localhost:8801 npm run dev
```

`npm run start` (in `ccp/api`) is the **production** entrypoint — durable `FileStore` by
default, a fail-closed preflight that refuses to boot on an insecure/incomplete config, and
TLS-terminated-externally assumptions. All of that — every environment variable, first-boot
bootstrap, backup/restore, and the `/healthz` vs `/readyz` probes — is documented in
[`api/README.md`](api/README.md); this file doesn't duplicate it.

Both `ccp-app` and `ccp-api` are covered by `./scripts/gate.sh app` and
`./scripts/gate.sh api` respectively from the repo root (mirrors CI; see the script header for
all modes).

## Adopt Cloud Control Plane in a foreign repo

The manifests/inventory pipeline is generic — every step below works against any Terraform
root, on GitHub or GitLab. This is the same path `catalogctl onboard` walks a Lead through;
the commands are usable directly too.

1. **Build an inventory** from the target root's `*.tf` (and `*.tf.json` — a filename with
   no signal still resolves its service from the manifests):
   ```bash
   pip install python-hcl2
   python3 ccp/app/scripts/build-inventory.py --root <their-tf-root> --out <their-inventory.json>
   ```
   Run from the repo root. `--imports <file>` is optional — pass an `imports.tf` to enrich
   `aws_subnet`→AZ joins; if you omit it, the script WARNs on stderr and skips that
   enrichment rather than erroring. A root that yields zero resources also WARNs loudly
   rather than exiting silently, so an empty inventory is a signal, not a silent no-op.

2. **Extract the HCL blocks** the SPA's full-block learning view (`FullBlockDiff`) needs:
   ```bash
   cd ccp/app
   npx vite-node scripts/extract-blocks.ts -- --root <their-tf-root> --out <blocks-out>
   ```
   **Known limit, stated honestly:** the tokenizer is HCL-native-syntax only — resources
   defined in `*.tf.json` are **not** extracted. The script counts and WARNs per file (`N
   resource block(s) NOT extracted`) instead of silently under-reporting.

3. **Go through `catalogctl onboard`** for the trust-boundary + prescan pipeline (rejects
   provisioners, non-allowlisted providers/modules, etc. before anything is trusted) — see
   [`docs/onboarding-security.md`](docs/onboarding-security.md) for the ordered pipeline and
   [`tools/catalogctl/README.md`](../tools/catalogctl/README.md) for the real `onboard` flags
   (verify flags there directly against `tools/catalogctl/internal/onboard`; don't trust a
   copy pasted into a second doc).

4. **Use the `bootstrap` project as the reference** for what a second project's manifest +
   inventory + block layout looks like end-to-end:
   [`app/src/data/projects/bootstrap/`](app/src/data/projects/bootstrap/) (`project.json`,
   `inventory.json`, `manifests/`, `blocks/`) — vendored the same way `api.ts` resolves any
   non-default project (an empty catalog if nothing is vendored, never the bundled sample's).

Also run this same pipeline on an ongoing basis, in CI, once an account is onboarded — see
[`docs/runbooks/account-data-ci.md`](../docs/runbooks/account-data-ci.md).

## More

- [`../PRD.md`](../PRD.md) — **the single source of truth** for what Cloud Control Plane is.
- [`docs/`](docs/) — the canonical product docs, code-derived with file:line evidence:
  [`PERMISSIONS.md`](docs/PERMISSIONS.md) · [`SETTINGS-CATALOG.md`](docs/SETTINGS-CATALOG.md) ·
  [`DOMAIN-MODEL.md`](docs/DOMAIN-MODEL.md) · [`ERROR-STATES.md`](docs/ERROR-STATES.md) ·
  [`API-SPEC.md`](docs/API-SPEC.md) · [`MAINTAINING-THE-CATALOG.md`](docs/MAINTAINING-THE-CATALOG.md)
  — plus [`onboarding-security.md`](docs/onboarding-security.md) (the untrusted-repo trust
  boundary, contract-test-guarded), [`onboarding-runbook.md`](docs/onboarding-runbook.md)
  (the account-onboarding ladder), and [`go-live.md`](docs/go-live.md) (first HTTPS deploy,
  the CI runner, the toolbox / armed lanes).
- [`../docs/adr/README.md`](../docs/adr/README.md) — the ADR ledger; the settled decisions
  this control plane is built to.
