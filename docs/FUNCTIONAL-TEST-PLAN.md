# Cloud Control Plane — Functional Test Plan

**Repo:** `cloud-control-plane` · **Components under test:** SPA `ccp/app` (Vite + React 19), API `ccp/api` (Node/Hono), CLI `tools/catalogctl` (Go), installers `ccp/scripts/*`, repo gates `scripts/gate.sh` + `scripts/publish-gate.sh`
**Audience:** a human tester with a fresh clone, Docker, and a terminal.
**Verification basis:** every expected value below is derived from the code and automated tests. Where a doc contradicts code, code wins (noted inline).

---

## 1. Scope and conventions

### In scope
End-to-end functional verification of: install & boot, demo/mock mode, day-zero bootstrap, authentication (password + TOTP + recovery codes), the account & security center, project registry & onboarding, the change-request lifecycle (submit → approve → applied/held states, cancel, re-window), admin surfaces (teams, catalog, freeze, policy, risk, accounts, dual control), the disarmed apply/drift lanes, the `catalogctl` CLI, and the repo's own CI-mirror gates.

### Explicitly excluded
- Load, performance, soak, and penetration testing.
- Real AWS/Azure mutation of any kind (the product never runs `terraform apply`; nothing in this plan does either).
- The importer kits (`importer/kit`, `importer/kit-azure`) and `tools/schemadump` (covered by their own suites).
- The opt-in `runner` and armed (`docker-compose.armed.yml`) deployments beyond verifying they are **off** by default.
- Browser-matrix/visual testing (single evergreen Chromium/Firefox is sufficient).

### Environments

| Env | Requirements | Used by journeys |
|---|---|---|
| **E1 Docker** | Docker + Compose v2, a writable `/data` dir (production path only) | INST, DAY0 (compose variant) |
| **E2 Local Node** | Node **>= 22** (`ccp/api` `engines`; `run-local.sh` and `gate.sh smoke` require it), npm | INST, DAY0, ACCT, PROJ, REQ, ADMIN, ARM |
| **E3 Go** | Go **1.25** (pinned in `tools/catalogctl/go.mod`), bash | CLI, GATE |
| **E4 Browser** | Any evergreen browser; an authenticator app or `oathtool` (`oathtool --totp -b <SECRET>`) for TOTP codes | DEMO, DAY0, ACCT, REQ (UI walks) |

### Fixed values used throughout (from code)

| Fact | Value | Source |
|---|---|---|
| API port / app port | `8801` / `8800` (compose maps app container `:8080` → host `127.0.0.1:8800`; API is loopback-published) | `ccp/docker-compose.yml`, `ccp/scripts/run-local.sh` |
| Vite dev server | `http://localhost:5173` | `ccp/app` README/Vite default |
| Durable store | `${CCP_DATA_DIR:-.ccp-data}/ccp.json`; in Docker `CCP_DATA_DIR=/var/lib/ccp` bind-mounted from `/data/ccp/store` | `ccp/api/src/deploy.ts#resolveDataFile`, compose file |
| Error body shape | every 4xx/5xx is `{code, reason, details?}`; every 429 carries `Retry-After` | `ccp/api/src/errors.ts` |
| CSRF header | non-GET business routes require `x-ccp-client: ccp-spa`; `/auth/*`, GET/HEAD, and the Bearer upload lane are exempt | `ccp/api/src/middleware/session.ts` |
| Project header | `x-ccp-project: <id>`; absent ⇒ reserved `@control` scope; unknown id ⇒ `422 VALIDATION_FAILED {details:{field:"x-ccp-project"}}` | `middleware/session.ts#withProject` |
| Session lifetimes | absolute 12 h, idle 30 min, TOTP pre-session 5 min, re-auth window 10 min | `ccp/api/src/auth/sessions.ts` |
| Password minimum | 8 chars (`MIN_PASSWORD`) | `ccp/api/src/auth/credentials.ts` |
| Login lockout | 5 consecutive failures lock; backoff `min(60, 2^(n-5))` minutes; attempts during backoff ⇒ `429 LOGIN_BACKOFF {details:{until}}` | `ccp/api/src/routes/auth.ts` |
| Recovery codes | 10 codes, 16 symbols, displayed `XXXX-XXXX-XXXX-XXXX`, alphabet has no `0/O/1/I` | `ccp/api/src/auth/recovery.ts` |
| TOTP devices | max 5 per account, named at confirm time (there is **no rename endpoint** — verify absence) | `ccp/api/src/routes/account.ts` |
| Approval ladder | self_service → `[L2]` (1 approval); guardrails/engineer and **any** forces-replace → `[L2, L3]` (2 distinct people, L3 = lead only) | `ccp/api/src/domain/exposure.ts` |
| Schedule bounds | window `at` >= now+30 min, <= now+90 days; default duration 4 h; max 24 h; re-window refused if last approval > 30 days old | `ccp/api/src/domain/schedule.ts` |
| Rate limits (defaults) | 50 submissions/hour, 20 open requests per requester (settings key `rate.limits`) | `ccp/api/src/domain/config.ts`, `middleware/rateLimit.ts` |
| Sample estate | project id `sample`, name "Example Estate", 51 resources, timezone Asia/Tokyo | `ccp/app/src/data/project.json`, `inventory.json` |
| Demo roster | `alice`/`alice` (Lead, admin) · `bob`/`bob` (Lead) · `carol`/`carol` (Approver) · `dave`/`dave`, `erin`/`erin` (Requesters) | `ccp/app/src/data/project.json`, `ccp/app/src/lib/accounts.ts#ensureSeeded` |
| catalogctl exit codes | `0` ok · `2` refusal (`REFUSE <CODE>: <reason>` on stderr) · `3` resolution/schema/usage · `1` internal; window-check adds `5` before-window, `6` expired; window gate script adds `7` freeze; plan-check gate adds `4` digest mismatch | `tools/catalogctl/internal/cli/cli.go`, `internal/windowcheck/command.go`, `plancheck_gate_test.go`, `windowgate_test.go` |

### curl harness (used by API-level cases)

```sh
API=http://localhost:8801
J() { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }          # status only
CH='-H content-type:application/json -H x-ccp-client:ccp-spa'    # CSRF header
# login and keep the httpOnly cookie:
curl -s -c /tmp/ccp.jar $CH -d '{"username":"<admin>","password":"<pw>"}' $API/auth/login
# subsequent calls: curl -b /tmp/ccp.jar $CH -H x-ccp-project:<id> ...
```

### Resetting state between journeys

| Mode | Reset procedure |
|---|---|
| `run-local.sh` | Ctrl-C — the temp store (`mktemp -d`) is deleted on exit; restart for a fresh instance |
| Manual `npm run start` | stop the API and delete the data dir you pointed `CCP_DATA_DIR` at (default `./.ccp-data`) |
| Docker | `cd ccp && docker compose down` then `sudo rm -rf /data/ccp/store/*` (destroys the audit chain — test hosts only) |
| Demo/mock SPA | browser devtools → Application → clear site data (localStorage holds the mock stores) |
| catalogctl | nothing to reset — each case copies fixtures to a scratch dir |

### Estimated duration

| Journey | Manual time |
|---|---|
| INST Install & boot | 45–60 min |
| DEMO Demo/mock mode | 30 min |
| DAY0 First run | 30 min |
| ACCT Account & security | 45 min |
| PROJ Projects & onboarding | 45 min |
| REQ Request lifecycle | 90 min |
| ADMIN Admin surface | 60 min |
| ARM Disarmed lanes | 20 min |
| CLI catalogctl | 45 min |
| GATE CI gates | 30 min (plus one full `gate.sh` run ~10–20 min machine time) |
| **Total** | ~1.5 days with breaks |

---

## 2. Journey INST — Install & boot

**Preconditions:** fresh clone; nothing listening on 8800/8801. Cases INST-01..03 need E2 (Node >= 22); INST-04+ need E1 (Docker).

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| INST-01 | run-local smoke | `ccp/scripts/run-local.sh --smoke` | Exit **0**. Output includes, in order: `api base is baked into the bundle — real mode confirmed (not the demo/mock build)`, `/readyz answered 200`, `SPA is served (index.html with #root) at http://localhost:8800`, and finally `SMOKE PASSED — api answers /readyz (200, bootstrapped) and the SPA is served in api-mode`. Temp store is deleted afterwards. | `gate.sh smoke` / CI `ccp-smoke.yml` |
| INST-02 | run-local interactive | `ccp/scripts/run-local.sh`; leave running | Banner prints `Cloud Control Plane is up — REAL mode, docker-free`, `App: http://localhost:8800`, `API: http://localhost:8801`, and the bootstrap credentials: the first-admin username + a one-time password. Ctrl-C stops both processes and removes the temp store. | manual only |
| INST-03 | Health vs readiness | With INST-02 up: `curl $API/healthz` and `curl -i $API/readyz` | `/healthz` → 200 `{"ok":true}` always. `/readyz` → 200 with JSON containing `"ready":true`, `"accounts":1`, `"estates":0`, `"chains":[{"projectId":"@control",...,"verified":true}]`, `"reasons":[]`. | `ccp/api/test/readyz.test.ts`, `blankInstall.test.ts` |
| INST-04 | Compose refuses without VITE_API_BASE | `cd ccp && cp .env.example .env`, set a real `CCP_TOTP_KEY` (`openssl rand -base64 48`) but **delete the `VITE_API_BASE` line**, then `docker compose up -d --build` | Compose aborts before building the app image; error output contains the pinned message **`set VITE_API_BASE in .env — the api's public URL`** (from `${VITE_API_BASE:?...}`). Nothing starts. | manual only |
| INST-05 | Compose refuses without CCP_TOTP_KEY | Same but leave `VITE_API_BASE` set and delete `CCP_TOTP_KEY` | Compose aborts with a message containing **`set CCP_TOTP_KEY in .env — see .env.example`**. | manual only |
| INST-06 | Production preflight fails closed | Run the API directly with a bad prod config: `cd ccp/api && NODE_ENV=production CCP_STORE=memory npm run start` | Process exits **1**. stderr: `ccp-api: refusing to start — insecure/incomplete production config:` listing `CCP_STORE=memory is not durable …` (and, if also missing, the Secure-cookie / `CCP_CORS_ORIGIN`+`CCP_SAME_ORIGIN` / `CCP_TOTP_KEY` problems), then `Fix the env (see ccp/api/README.md "Deploy") …`. | `ccp/api/test/deployConfig.test.ts` |
| INST-07 | install.sh happy path | On a host with a persistent disk at `/data`: `ccp/scripts/install.sh --host ccp.example.test` (no cert flags) | Five numbered steps `1/5`..`5/5` run: `/data` layout + `.env` written (via `setup.sh data` / `setup.sh env`), nginx step reports `skipping nginx (no --cert/--key)`, images build, first boot runs ONCE with ephemeral `CCP_BOOTSTRAP=1`, then re-ups with it unset. Final banner: `✓ Cloud Control Plane is up`, `Sign in at: https://ccp.example.test`, `Health: http://127.0.0.1:8801/readyz`, and a `First admin — shown ONCE:` block with the username + one-time password, plus the backup one-liner (`tar czf backup-$(date +%Y%m%d).tar.gz -C /data ccp`). | manual only |
| INST-08 | install.sh is idempotent | Re-run the exact INST-07 command | No re-bootstrap. Output contains `store already initialized — this is a rebuild/update, not a first install (no re-bootstrap)` and `5/5  (nothing to disable — was already initialized)`. No new one-time password is printed. | manual only |
| INST-09 | install.sh guards | (a) run without `--host`; (b) run on a host with no `/data` | (a) dies: `--host is required (the portal's public FQDN, e.g. ccp.example.com)`. (b) dies: `mount a persistent disk at /data — laptop trials: run-local.sh (see docs/go-live.md → Prerequisites)`. Exit 1 both times. | manual only |
| INST-10 | Bootstrap refused on an existing store | With the compose stack initialized, set `CCP_BOOTSTRAP=1` in `.env` and `docker compose up -d`; read `docker compose logs api` | The api container exits **1**; log contains `ccp-api: bootstrap refused — data file /var/lib/ccp/ccp.json already exists on disk; refusing to re-provision (remove it to start fresh).` (`restart: unless-stopped` will loop it — that is expected.) Remove the flag and re-up to recover. | `ccp/api/test/bootstrap.test.ts` (refusal logic) |
| INST-11 | doctor.sh green run | On the INST-07 host: `ccp/scripts/doctor.sh` | Exit **0**, final line `✓ doctor: no failures`. Individual `✓` lines include: `.env present`, `.env permissions 600`, `bootstrap flag off`, `TOTP key set`, `.env is git-ignored`, `container: api …Up`, `container: app …Up`, `api /healthz 200 (:8801)`, `api /readyz ready=true — store loaded, accounts present, audit chains verify`, `app serves on :8800`, `/data present`, `/data/ccp/store/ccp.json present`, `store owned by uid 1000 (matches the api container's node user)`. Warnings (`!`) about the runner profile / toolbox image being off are expected and do **not** fail it. | manual only |
| INST-12 | doctor.sh catches misconfig | (a) set `CCP_BOOTSTRAP=1` in `.env`, rerun doctor; (b) restore, then `sudo chown -R root /data/ccp/store`, rerun | Exit **1**, `✗ doctor: at least one FAIL above needs attention`. (a) shows `✗ CCP_BOOTSTRAP=1 is still set — the api will refuse to restart once the store exists (set it empty)`; (b) shows `✗ store is owned by uid 0, not 1000 — the classic root-owned-bind trap (chown -R 1000:1000 /data/ccp/store)`. Restore ownership afterwards. | manual only |
| INST-13 | Wiped store is visibly not ready | Stop the api, empty the store file, start, `curl -i $API/readyz` | **503** with `"ready":false` and `reasons` containing `store holds 0 accounts — an emptied/wiped store is not ready (a bootstrapped store has ≥1 admin).` `/healthz` still 200 — the two probes intentionally disagree. | `ccp/api/test/readyz.test.ts` |
| INST-14 | setup.sh check | `ccp/scripts/setup.sh check` | Prerequisites report listing Node/Go/Python/Docker/Terraform with per-tool OK/missing hints; exit 0 when the toolchain is present. | manual only |

---

## 3. Journey DEMO — Demo/mock mode (zero backend)

**Preconditions:** `cd ccp/app && npm ci && npm run dev` — `VITE_API_BASE` **unset**. Open `http://localhost:5173`. This is the bundled demo: `isApiMode=false`, the sample estate `sample` is auto-scoped, identity is a local PBKDF2 store, and `serverInfo()` answers `{mode:'mock', capabilities: all-false}`.

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| DEMO-01 | Demo login works with the seeded roster | Visit `/login`; sign in `alice` / `alice` | Login page shows title **Sign in** and the sub-line "Change cloud infrastructure through reviewed forms…". Alice lands in the shell at `/p/sample/` with the full sample estate (services, inventory of 51 resources). No forced password change in mock (`mustChangePassword:false` by seed). | `ccp/app/src/test/accounts.test.ts`, `authFlow.test.ts` |
| DEMO-02 | Wrong password is generic | Sign out; try `alice` / `wrong` | Inline `role=alert` error; generic failure text; password field cleared; no session. | `ccp/app/src/test/accountFlow.test.ts` |
| DEMO-03 | How you can tell it's the demo | Check: (a) no `Set-Cookie`/network calls to any API on login (devtools); (b) admin controls that need a server render inside a disabled fieldset with the note **`This control is inactive until the server enforces it`**; (c) URL scope is `/p/sample` from first paint | All three hold. `SERVER_MODE==='mock'` drives (b) — the exact advisory string is pinned by test. | `ccp/app/src/test/advisoryGate.test.ts` |
| DEMO-04 | Demo request → approval round-trip | As `dave` (requester, team ERP Basis): Services → EBS → pick a volume → "Grow an EBS volume" → size 60 → justification (>= 10 chars) → Review → Submit. Sign out, sign in as `carol` (approver) → `/p/sample/approvals` → the card → **Approve**. Then as `bob` (lead) → **Approve** again | Submit succeeds into the review queue (ebs-grow is `l1_with_guardrails` ⇒ ladder [L2, L3], "Awaiting 2 approvals"). Carol's approval records 1/2 (next step L3); Bob's approval completes 2/2 → status badge **Applied** (mock stamps APPLIED for `now` schedules; no real infra changes — this is the demo). | `ccp/app/src/test/approvalsQueue.test.ts`, `w1DayTwoOps.test.ts`, `fullCoverage.test.ts` |
| DEMO-05 | Separation of duties in the demo | As `carol`, submit any request; open `/p/sample/approvals` | Her own card's **Approve** button is disabled (`canApprove` excludes own requests); the ladder shows "your own request". | `ccp/app/src/test/permissions.test.ts`, `approvalsQueue.test.ts` |
| DEMO-06 | Team scope in the demo | As `dave` (ERP Basis), attempt a Network & Security service op | The catalog/action picker does not offer out-of-team services for requesters; direct navigation shows the op as not requestable for him. | `ccp/app/src/test/permissions.test.ts` |
| DEMO-07 | Forces-replace typed confirmation (UI gate) | As `dave`: EBS → `ebs-set-encrypted` on a volume; try to submit without typing the address, then type a wrong one, then the exact address | Submit stays disabled until the typed value exactly equals the target address; wrong text shows **`That name does not match. Type the resource name exactly to continue.`**; exact match enables submit → request routed to the engineer track ("Needs engineer" badge). | `ccp/app/src/test/replaceConfirmGate.test.ts` |
| DEMO-08 | Freeze in the demo | As `alice`: Admin → Settings → turn the change freeze ON. As `dave`, try to submit any request | The form blocks with **`Change requests are frozen by an administrator right now. Try again once the freeze is lifted.`** Turn the freeze back off; submit works again. | `ccp/app/src/test/settingsFlow.test.ts` |
| DEMO-09 | What the demo deliberately lacks | Verify: (a) `WINDOW_EXPIRED` never appears (mock never produces it); (b) mutation failures carry no server `code` (generic reasons only); (c) drift page shows the synthetic/disconnected posture; (d) admin "server" capabilities all advisory | All four hold — documented mock limitations, not bugs. | `ERROR-STATES.md` §SPA, `driftStatus.test.ts` |
| DEMO-10 | Demo user admin is local | As `alice`: Admin → Users → enrol a new requester with a starting password; sign in as that user in a fresh tab | Works entirely against localStorage; the new account can sign in (forced to change its admin-set starting password). Clearing site data removes it. | `ccp/app/src/test/accounts.test.ts` |

---

## 4. Journey DAY0 — First run / day zero (real backend)

**Preconditions:** fresh `run-local.sh` (interactive) instance from INST-02, or the compose stack from INST-07. You have the printed one-time password for the first admin. SPA at `:8800`, API at `:8801`.

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| DAY0-01 | Bootstrap prints once, seeds one admin | Inspect the api log from first boot | Exactly: `ccp-api bootstrap: Lead created.` / the username / `  one-time password: <base64url>` / `  (change it on first sign-in — this password is shown ONCE)`. `/readyz` flips 503 → 200 (accounts: 1). | `ccp/api/test/bootstrap.test.ts` |
| DAY0-02 | First login forces the interstitials, in order | Browser → `:8800/login` → first admin + one-time password | Password accepted, then the **TOTP enrolment** screen appears first (title **Set up two-factor authentication**): a scannable QR, a **Setup key** block, and the full `otpauth://` URI. Enrolment precedes the password change. | `ccp/app/src/test/authFlow.test.ts` |
| DAY0-03 | Wrong TOTP code | Enter `000000` | Error `A verification code is required.` (server `TOTP_REQUIRED` reason surfaced verbatim); field clears; still on the enrol screen. | `ccp/api/test/totp.test.ts` |
| DAY0-04 | Enrol + recovery-code ceremony | Enter a correct code from the authenticator (or `oathtool --totp -b <setup key>`) | Device #1 ("Authenticator") enrols; because it is the account's FIRST device the **Save your recovery codes** ceremony interposes: exactly **10** codes formatted `XXXX-XXXX-XXXX-XXXX`. Continue → the **Set a new password** screen (account still on its temporary password). | `ccp/api/test/totp.test.ts`, `recoveryCodes.test.ts`, app `authFlow.test.ts` |
| DAY0-05 | Forced password change semantics (API) | While still pinned: `curl -b jar $API/auth/me` vs any other route, e.g. `curl -b jar -H x-ccp-client:ccp-spa $API/admin/accounts` | `/auth/me` → 200 (allowed). Everything except `/auth/*`, `/healthz`, `/readyz`, `/instance` → **403 `PASSWORD_CHANGE_REQUIRED`** "You must change your password before continuing." | `ccp/api/test/auth.test.ts` case (e) |
| DAY0-06 | Password change rules | On the set-password screen: (a) new password < 8 chars; (b) mismatch with confirm; (c) new == temporary; (d) valid 8+ password | (a) `Password must be at least 8 characters.`; (b) `The two passwords do not match.`; (c) `Choose a password different from the temporary one.`; (d) success → lands on the **first-run page** (DAY0-08). Server side, the change bumps `sessionVersion`: any other old cookie now gets `401 SESSION_INVALIDATED`. | `ccp/api/test/auth.test.ts` (c), app `session-security.test.ts` |
| DAY0-07 | Wrong current password on change | `curl -b jar $CH -d '{"currentPassword":"nope","newPassword":"longenough1"}' $API/auth/change-password` | **401 `BAD_CREDENTIALS`** "Wrong username or password." | `ccp/api/test/auth.test.ts` |
| DAY0-08 | Day-zero landing (first-run page) | Observe the page after DAY0-06 | Header shows the instance name (default **Cloud Control Plane**) + **Sign out**. Sections: **Name this instance** (admin sees the identity editor), headline **No accounts onboarded yet**, the embedded Projects wizard, and a **Just exploring?** card with the **Load sample data** button ("captured demo data, not your infrastructure"). | `ccp/app/src/test/bootstrapProject.test.ts`, `instanceIdentity.test.ts` |
| DAY0-09 | Lockout backoff | Sign out. Fail login 5 times, then try a 6th (even with the right password) | Attempts 1–5 → `401 BAD_CREDENTIALS` (byte-identical for unknown user vs wrong password — verify with a bogus username too). After the 5th, the account locks for `2^0 = 1` minute; the 6th attempt → **429 `LOGIN_BACKOFF`** "Too many attempts. Try again later." with `details.until` and a `Retry-After` header. After the window, correct login succeeds and the counter resets. | `ccp/api/test/auth.test.ts` (a), (d) |
| DAY0-10 | Missing CSRF client header | `curl -b jar -H content-type:application/json -H x-ccp-project:sample -d '{}' $API/requests` (no `x-ccp-client`) | **403 `MISSING_CLIENT_HEADER`** "Missing or invalid client header." (`/auth/*` routes are exempt — confirm login works without the header.) | `ccp/api/test/errors.test.ts` |
| DAY0-11 | Unknown project header | `curl -b jar $CH -H x-ccp-project:nope $API/requests?scope=mine` | **422 `VALIDATION_FAILED`** with `details: {"field":"x-ccp-project"}`. | `ccp/api/test/projectAuthz.test.ts` |
| DAY0-12 | Grant-admin break-glass (second admin) | Create a requester account via `POST /admin/accounts` (see ADMIN-07), log her in once and change her password. Then stop the api and run `cd ccp/api && npx tsx scripts/grant-admin.ts --username <name> --pr pr#test --data <data-file>` | Grant succeeds, is hash-chain audited, bumps her `sessionVersion` (her old session dies). Refusal cases: not-yet-onboarded target (`mustChangePassword:true`) refused; already-admin refused; refused when 2+ active admins already exist. | `ccp/api/test/grantAdmin.test.ts` |

---

## 5. Journey ACCT — Account & security center

**Preconditions:** DAY0 complete; signed in as the first admin (TOTP enrolled). SPA page: `/p/<project>/account` (title **Account & security**).

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| ACCT-01 | Re-auth gate blocks sensitive actions | >10 min after login, click **Add device** (or `POST /auth/totp-devices` with only the session) | **403 `REAUTH_REQUIRED`** — the SPA opens the *Confirm it's you* password prompt; after re-entering the password the same action succeeds (10-minute re-auth window per `sessions.ts`) | `ccp/api/test/reauth.test.ts` |
| ACCT-02 | Self password change | Account page → change password with correct current + valid new | 200; other sessions die (`sessionVersion` bump → their next call `401 SESSION_INVALIDATED`); current session continues | `ccp/api/test/auth.test.ts`, app `session-security.test.ts` |
| ACCT-03 | Add/remove named TOTP devices | Add a second device ("Phone"), then remove the first | Both listed by name with enrolment dates; removal leaves ≥1 device for a TOTP-required account (the last-device guard refuses) ; max **5** devices — the 6th enrolment is refused | `ccp/api/test/totpDevices.test.ts` |
| ACCT-04 | Recovery-code login + burn | Sign out; login with password then a recovery code instead of TOTP | Login succeeds; that code is consumed (re-use fails); remaining count shown on the Account page decrements | `ccp/api/test/recoveryCodes.test.ts` |
| ACCT-05 | Regenerate recovery codes | Account page → regenerate (re-auth gated) | A fresh set of 10 codes; ALL old codes dead immediately | `ccp/api/test/recoveryCodes.test.ts` |
| ACCT-06 | Session list & revoke | Open sessions list; revoke the other browser's session | Revoked session's next call → **401 `SESSION_INVALIDATED`**; the list drops it; current session unaffected | `ccp/api/test/auth.test.ts` (sessions) |

---

## 6. Journey PROJ — Projects & onboarding

**Preconditions:** DAY0 complete (real backend) or the demo. Project scope rides the `x-ccp-project` header; the SPA path is `/p/<projectId>/…`.

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| PROJ-01 | Blank install shows no estate | Fresh real-mode instance, before loading anything | First-run page: **No accounts onboarded yet**; no inventory, no catalog data; `/readyz` reports `"estates":0` | `ccp/api/test/blankInstall.test.ts` |
| PROJ-02 | Load sample data | First-run page → **Load sample data** | Project `sample` ("Example Estate") appears with 51 inventory resources and the full catalog; clearly labeled demo data | app `bootstrapProject.test.ts`, `projectRegistry.test.ts` |
| PROJ-03 | Vendored sandbox project | Switch to `bootstrap` ("Bootstrap — importer sandbox") | Catalog = exactly `iam, kms, s3`; inventory non-empty; Block Viewer shows source for `aws_s3_bucket.state` with file:line provenance | app `bootstrapProject.test.ts` |
| PROJ-04 | Empty-catalog fail-safe | Register a project with NO vendored/uploaded data; scope to it | Catalog and inventory are **empty** — never another project's data under this name | app `projectRegistry.test.ts` |
| PROJ-05 | Project switcher re-scopes everything | Switch projects while on a data view | The fetch key changes per hop (view refetches); URL flips to the new `/p/<id>/…`; no stale data from the previous project | app `useActiveProjectId.test.ts` |
| PROJ-06 | Per-project roles | One account with different roles in two projects | Each scope shows that project's role: approver powers in one, requester limits in the other; `403 PROJECT_SCOPE` on a project the account has no role in | `ccp/api/test/perProjectAuthz.test.ts` |

---

## 7. Journey REQ — Request lifecycle (the core)

**Preconditions:** real backend, sample loaded, the demo roster seeded (`alice` lead/admin, `bob` lead, `carol` approver, `dave`/`erin` requesters — teams per `project.json`).

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| REQ-01 | Self-service submit | `dave`: catalog → a LOW self-service op (e.g. add a tag) → valid params → justification ≥10 chars → submit | 201; status **`AWAITING_CODE_REVIEW`**; ladder `[L2]`, `approvalsRequired: 1`; appears in "My requests" and the approvals queue | `ccp/api/test/changeSet.test.ts`, app `fullCoverage.test.ts` |
| REQ-02 | Out-of-bounds param | Same op, one value past its manifest bound (e.g. `ebs-grow` `new_size_gib: 99999`, max 16384) | **422 `PARAM_OUT_OF_BOUNDS`** "A parameter is outside its allowed bounds."; nothing stored; the SPA showed the same violation inline pre-submit | `ccp/api/test/adv2.test.ts` |
| REQ-03 | Guardrails = two distinct people | `dave` submits `ebs-grow` (guardrailed); `carol` approves; `carol` tries again; `bob` completes | Ladder `[L2, L3]`, `approvalsRequired: 2`. First approval → step L3, still open. Same approver again → **409 `ALREADY_APPROVED`**. `bob` (lead, L3) completes → the request leaves the queue | `ccp/api/test/approvalLadder.test.ts`, `dualControl.test.ts` |
| REQ-04 | Wrong-level approval | An approver (not lead) attempts the L3 step | **403 `WRONG_APPROVAL_LEVEL`** — L3 is lead-only | `ccp/api/test/approvalLadder.test.ts` |
| REQ-05 | Self-approval refused | The requester of an open request calls approve on it | **403 `SELF_APPROVAL`** (server); the SPA already disables the button with "your own request" | `ccp/api/test/adv2.test.ts`, app `approvalsQueue.test.ts` |
| REQ-06 | Team scope | `dave` (ERP Basis team) force-POSTs an op on a service his team doesn't own | **403 `TEAM_SCOPE`**; the SPA never offered the op in his catalog | `ccp/api/test/perProjectAuthz.test.ts`, app `permissions.test.ts` |
| REQ-07 | Engineer-only routing | Submit an `engineer_only` op | Status **`NEEDS_ENGINEER`** with event `Routed to an engineer to author and review the Terraform`; no self-service ladder runs | `ccp/api/test/exposure.test.ts` |
| REQ-08 | Forces-replace confirmation | Submit a `forcesReplace` op without / with a wrong / with the exact typed resource address | Without or wrong → **422 `REPLACE_CONFIRMATION_REQUIRED`** "This change destroys and recreates the resource. Type the resource name to confirm before submitting."; exact match → accepted, ladder forced `[L2, L3]` | `ccp/api/test/replaceConfirmation.test.ts` |
| REQ-09 | Change set, strictest wins | One request with a self-service item + a guardrailed item | ONE stored request; ladder `[L2, L3]`, required 2 (order-independent); item statuses tracked per item | `ccp/api/test/changeSet.test.ts` |
| REQ-10 | Change set is atomic | Same, but one item has an unknown `operationId` / out-of-bounds param / disabled op | **422** (`VALIDATION_FAILED` / `PARAM_OUT_OF_BOUNDS` / `OP_DISABLED`) and **nothing** is persisted — no partial set | `ccp/api/test/changeSet.test.ts` |
| REQ-11 | Freeze blocks submits | Admin turns the global freeze on; `dave` submits | **423 `GLOBAL_FREEZE`** "Changes are frozen right now."; the freeze banner shows for everyone; unfreeze → submit works | `ccp/api/test/errors.test.ts`, app `settingsFlow.test.ts` |
| REQ-12 | Disabled op | Admin disables one op; requester submits it | **422 `OP_DISABLED`** "That operation is currently disabled."; re-enable restores it | `ccp/api/test/eligibility.test.ts` |
| REQ-13 | Cooling-off | Approve a request subject to a cooling period | Status **`APPROVED_COOLING`**; apply-eligibility only after `earliestApplyAt`; the window gate refuses before it (BEFORE_WINDOW verdict) | `ccp/api/test/cooling.test.ts` |
| REQ-14 | Scheduled window lifecycle | Submit with a future window (≥ now+30 min); let it expire un-applied | Parks at **`AWAITING_DEPLOY_APPROVAL`**; after the window passes → **`WINDOW_EXPIRED`** (badge "Window expired") — parked, not terminal: re-window or cancel are the only moves | `ccp/api/test/windowExpiry.test.ts` |
| REQ-15 | Re-window rules | Re-window the expired request (owner), then try as a stranger; try a window < now+30 min | Owner with fresh-enough approval → new window accepted; non-owner → **403 `REWINDOW_FORBIDDEN`**; too-soon window → **422** schedule validation | `ccp/api/test/rewindow.test.ts` |
| REQ-16 | Cancel rules | Cancel own open request; then try cancelling someone else's | Own → status **`CANCELLED`** (terminal); foreign → **403 `CANCEL_FORBIDDEN`** | `ccp/api/test/requests` coverage (cancel arm) |
| REQ-17 | Rate limits | Submit past the per-hour cap (default 50/h) or hold 20 open requests | **429 `RATE_LIMITED`** with a `Retry-After` header; existing requests unaffected | `ccp/api/test/rateLimit.test.ts` |
| REQ-18 | Plan summary recording | Record a CI plan summary on a request (`POST /requests/:id/plan-summary`); then a malformed one | Valid summary stored and rendered on the detail card; malformed → **422 `VALIDATION_FAILED`** | `ccp/api/test/planSummary.test.ts` |
| REQ-19 | Pinned review artifact | Approve a request after its inventory mutated | The approver sees the **pinned** diff captured at submit, byte-identical to what the requester reviewed — never a regenerated one | app `pinned-diff.test.ts`, `reviewArtifact.test.ts` |
| REQ-20 | TOTP-gated approval | Approve with an account that has no enrolled authenticator (policy requires one) | **403 `TOTP_ENROLLMENT_REQUIRED`**; after enrolment the same approval succeeds | `ccp/api/test/approveTotpGuard.test.ts` |

---

## 8. Journey ADMIN — Admin surfaces

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| ADMIN-01 | Teams CRUD | Create a team, assign services, rename, attempt delete while members exist | Create/rename OK (duplicate name → **409 `DUPLICATE_TEAM`**); delete with members → **409 `TEAM_NOT_EMPTY`**; empty team deletes | `ccp/api/test/teams` coverage |
| ADMIN-02 | Account admin | Create a user with a starting password; duplicate username; set per-project role | Created (user forced to change password on first login); duplicate → **409 `DUPLICATE_USERNAME`**; role change takes effect on the user's next request | `ccp/api/test/accountsAdmin.test.ts` |
| ADMIN-03 | Risk policy | Set medium=2 in the risk policy; submit a MEDIUM request | `approvalsRequired` reflects the policy where the policy drives it (see PERMISSIONS.md §4 for the server-ladder split); the SPA renders the requirement it was told | `ccp/api/test/adv2.test.ts` policy case |
| ADMIN-04 | Freeze toggle audit | Toggle freeze on/off | Both flips are audit-chained events with actor + timestamp; banner state follows | `ccp/api/test/settings` coverage |
| ADMIN-05 | Non-admin denied | A lead (non-admin) calls an `/admin/*` route | **403 `NOT_ADMIN`** | `ccp/api/test/projectAuthz.test.ts` |
| ADMIN-06 | Settings catalog honesty | Compare three visible settings against `ccp/docs/SETTINGS-CATALOG.md` rows | Each row's "enforced by" claim matches observed behavior (server-enforced vs SPA-advisory) | XLAYER-72 companion |
| ADMIN-07 | Admin does not equal approver | An admin with no approver/lead role tries to approve | **403 `FORBIDDEN_ROLE`** — admin is account/settings power, not an approval level | `ccp/api/test/projectAuthz.test.ts` |

---

## 9. Journey ARM — Disarmed lanes stay disarmed

**These verify the OFF state only.** Arming requires the operator env sets described in `ccp/api/README.md` (bundle: `CCP_BUNDLE=1` + git remote + gate/trigger commands; drift: `CCP_DRIFT=1`…).

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| ARM-01 | Apply bundle disarmed | Lead clicks Apply / `POST /requests/:id/apply` on a fully-approved request, `CCP_BUNDLE` unset | **`BUNDLE_DISARMED`** — the endpoint answers the disarmed code; nothing deploys; the UI explains the operator must arm the lane | `ccp/api/test/schedulerApply.test.ts` |
| ARM-02 | Apply is lead/admin-only even armed | A requester/approver calls apply | **403 `APPLY_FORBIDDEN`** before any bundle logic runs | `ccp/api/test/schedulerGating.test.ts` |
| ARM-03 | Drift ingest disarmed | `PUT /projects/:id/drift` with a valid upload token, `CCP_DRIFT` unset | **`DRIFT_DISARMED`**; `GET /projects/:id/drift` answers `{connected:false}`; the SPA drift page shows the disconnected posture | `ccp/api/test/drift.test.ts` |
| ARM-04 | Restore flavor separately disarmed | With `CCP_DRIFT=1` but `CCP_DRIFT_RESTORE` unset, submit a restore-flavor proposal | **409 `DRIFT_DISARMED`** naming the missing flag; plain drift serving still works | `ccp/api/test/driftBundleSeam.test.ts` |

---

## 10. Journey CLI — catalogctl

**Preconditions:** E3. `cd tools/catalogctl && go build -o /tmp/catalogctl ./cmd/catalogctl`.

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| CLI-01 | Build + suite | `go build ./... && go vet ./... && go test ./...` | All green (368+ subtests) | CI `catalogctl.yml` |
| CLI-02 | window-check verdicts | Run against `testdata/windows/windowed.yaml` at 17:00 / 18:00 / 19:30 / 22:00Z with `--estate-tz America/New_York` | `verdict=BEFORE_WINDOW` exit **5** · `IN_WINDOW` exit **0** (start inclusive) · `IN_WINDOW` **0** · `WINDOW_EXPIRED` exit **6** (end exclusive); stdout always carries the greppable `verdict=<TOKEN> now=<RFC3339>` line | `internal/windowcheck/windowcheck_test.go`, `ccp/api/test/scheduleWindowCheckParity.test.ts` |
| CLI-03 | window-check fail-closed | Garbled fixture (`at: not-a-timestamp`); or tz-mismatched estate flag | `verdict=SCHEDULE_INVALID` exit **3** — never "apply freely" on bad input | same |
| CLI-04 | Freeze veto in the gate script | Run the apply-window gate with the freeze flag set | Exit **7** (freeze) before any window logic | `windowgate_test.go` |
| CLI-05 | edit refusals | Run `edit` on a forces-replace op without confirmation; on a fmt-dirty file | `REFUSE FORCES_REPLACE` exit **2**; `REFUSE FMT_DIRTY` exit **2** (never reformats or corrupts) | `forcesreplace_confirm_test.go`, `internal/edit` tests |
| CLI-06 | edit golden corpus | Any surviving `testdata/golden/<verb>/<case>`: run per its request.yaml, diff `expected/` | Byte-identical output to `expected/`; `expected.diff` matches | `golden_test.go` (glob-driven) |
| CLI-07 | plan-check gate | Feed the r1..r6 plan fixtures | Passing plans exit **0**; violations (extra address, delete on change-op, unexpected replace, shrink on grow-only, moved-with-destroy, interior escape) print `VIOLATION <rule>: …` and exit **2**; digest mismatch exits **4** | `plancheck_gate_test.go`, `plancheck_drift_test.go` |
| CLI-08 | manifest lint | `go test` manifest-lint gate over `ccp/app/src/data/manifests` | Zero `prose-attr` findings on core services; any NEW arity finding outside the frozen baseline fails | `manifest_lint_test.go` |

---

## 11. Journey GATE — repo gates as user-facing surfaces

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| GATE-01 | Full local gate | `bash scripts/gate.sh` (Node 22, Go 1.25, no terraform) | Sections: catalogctl PASS · api PASS · app typecheck/test/build/contrast/help/safety PASS · app lint/format may FAIL on the known pre-existing formatting debt (documented; not a release blocker) · terraform SKIP (not installed). Summary names each | mirrors CI |
| GATE-02 | Publish gate, generic mode | `bash scripts/publish-gate.sh` on a clean public checkout | `PASS — zero findings across all hard-fail checks.` (no denylist file exists publicly; generic backstops still ran) | CI `publish-gate.yml` |
| GATE-03 | Gate honesty | Plant a fake AWS key (`AKIA` + 16 chars not in the example set) in a scratch file; re-run | PG-4 FAILs with the file:line; remove it, PASS returns | `publish-gate.sh` self-behavior |

---

## 12. Operator & reliability perspective (OPS)

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| OPS-01 | Restart survival | With requests in `AWAITING_CODE_REVIEW` and a half-approved ladder: `docker compose restart api` | All request state, approvals-so-far, sessions (within lifetime), and the audit chain survive (durable FileStore); the UI resumes exactly where it was | `ccp/api/scripts/restart-survival.ts` |
| OPS-02 | Backup & restore | `npm run backup`; wipe the store; restore onto a fresh container | Backup captures the data dir; restore brings back accounts/requests/audit; `verify-audit-chain` reports the chain intact | `ccp/api/scripts/{backup,restore,verify-audit-chain}.ts` |
| OPS-03 | Audit chain tamper visibility | Truncate/edit a store row by hand; run `verify-audit-chain` and hit `/readyz` | The chain verification names the break; `/readyz` reports the failing chain — corruption is loud, never silent | `verify-audit-chain.ts`, `readyz.test.ts` |
| OPS-04 | Self-update refusals | Run `self-update.sh` with a dirty worktree | Clean-worktree refusal (no update over local changes); with a clean tree it pulls, rebuilds, re-ups | manual only |
| OPS-05 | Demo-bundle-in-production tell | Deploy with `VITE_API_BASE` accidentally empty | The served bundle is the mock build — INST-01's smoke assertion (`real mode confirmed (not the demo/mock build)`) is the detection; run-local/install print it | `run-local.sh --smoke` |
| OPS-06 | Two api instances, one store | Start a second api process on the same `CCP_DATA_DIR` | Not a supported topology: expect store contention (`CHAIN_CONTENTION` on concurrent writes) — document, don't do it in production | `ccp/api/test` chain coverage |

---

## 13. Role-by-role perspective (ROLE)

| ID | Title | Steps | Expected result | Automated? |
|---|---|---|---|---|
| ROLE-01 | Requester's boundary | As `dave`: catalog shows ONLY his team's services; approvals page shows his own requests un-approvable; no admin nav | Catalog filtered by team-service ownership; own cards disabled; `/admin` links absent (server would 403 anyway) | app `permissions.test.ts` |
| ROLE-02 | Approver's queue | As `carol`: queue lists open requests (not her own as approvable); she can approve L2 steps, not L3 | L2 approve works; L3 attempt → **403 `WRONG_APPROVAL_LEVEL`**; own request disabled ("your own request") | `approvalLadder.test.ts` |
| ROLE-03 | Lead's extra powers | As `bob`: complete L3 steps; see the Apply control on fully-approved requests | L3 completes ladders; Apply visible to lead/admin only (others → **403 `APPLY_FORBIDDEN`**), answers disarmed today | `schedulerGating.test.ts` |
| ROLE-04 | The engineer lane | Any role opens an `engineer_only` op | The op is visible with its decisions[] checklist but routes `NEEDS_ENGINEER` — nobody self-serves it | `exposure.test.ts` |
| ROLE-05 | Admin's scope and its limits | As `alice`: users/teams/settings all editable; approving without an approver role fails | Admin manages accounts/settings; approval attempt → **403 `FORBIDDEN_ROLE`** — separation of duties holds at the top | `projectAuthz.test.ts` |
| ROLE-06 | One request, four screens | `dave` files → `carol` sees it appear in the queue → approves (1/2) → `bob` completes (2/2) → `dave` watches the status flip | Statuses in order on every screen: `AWAITING_CODE_REVIEW` → (approvals count 1/2, step L3) → left the queue / applied-or-scheduled path; every hop audit-chained with the actor | app `w1DayTwoOps.test.ts` |
| ROLE-07 | Same person, two hats | One account: approver in project A, requester in project B | Project A scope: queue + approve powers; project B scope: requester limits; no leakage between scopes; `403 PROJECT_SCOPE` outside both | `perProjectAuthz.test.ts` |

---

## 14. Cross-layer consistency perspective (XLAYER)

**Scope.** The product's promise — *a form submission becomes a governed, reviewed, EXACT Terraform change* — is only true if four independently-built layers keep telling the same story from one shared source of truth, `ccp/app/src/data/manifests/*.json`:

```
                    ccp/app/src/data/manifests/*.json          ← ONE op catalog, four readers
        ┌────────────────────┬─────────────────────┬──────────────────────────┬─────────────────────────────┐
  L1 SPA (ccp/app)      L2 api (ccp/api)       L3 catalogctl (Go)          L4 pinned corpora
  zod parseManifests    readdirSync same dir   manifests.LoadDir           skeletons/baselines/*.golden.tf
  form + preview        validateParams →       edit / plan-check /         testdata/golden/*, testdata/windows/*,
  checkBounds           422 PARAM_OUT_OF_BOUNDS  window-check (exit codes)   idiomrender_test.go hand-mirror
```

The repo uses five parity idioms, each exercised below: **(a)** a literally-shared module (`ccp/api/src/manifests.ts` imports the SPA's own `@app-lib/dependsOn`), **(b)** one fixture with multiple readers (`testdata/driftpropose/eligibility-cases.json`; `testdata/windows/*.yaml`), **(c)** hand-mirrored twins kept in lockstep by tests (`checkBounds` ↔ `paramOutOfBounds`; `baselines/values.ts` ↔ `idiomrender_test.go#baselineValues`), **(d)** live shell-out byte/verdict comparison (`createResourceParity.test.ts`, `scheduleWindowCheckParity.test.ts`), and **(e)** ordered authority when layers CAN disagree: the SPA advises, the api enforces (PERMISSIONS.md: "Where the two disagree, the server is the authority"), and the Go gates hold veto in the apply lane (`plan-check` exit 2, `window-check` exit 3/5/6). Reference ops (one per exposure class): **`s3-add-lifecycle-rule`** (self-service, append_block), **`ebs-grow`** (guardrails, set_attribute, grow-only), **`s3-enable-replication`** (engineer_only).

### 14.1 Manifest → form → server agreement ("one rule, both sides")

| ID | Steps | Expected result | Automated? |
|---|---|---|---|
| XLAYER-01 | Open the `s3-add-lifecycle-rule` form; compare every rendered field against the manifest | Exactly the manifest's params with verbatim labels/help: `Rule ID` (pattern `^[a-zA-Z0-9_-]{1,64}$`), `Transition after (days)` default `90`, `Target storage class` offering exactly `STANDARD_IA, ONEZONE_IA, INTELLIGENT_TIERING, GLACIER, GLACIER_IR, DEEP_ARCHIVE`, the inventory picker; the `status` const param is never editable; no undeclared field | new RTL case |
| XLAYER-02 | Boundary values both ways: `transition_days = 3650` via form AND direct POST | Both accept: `checkBounds` null; server `{ok:true}`; stored `AWAITING_CODE_REVIEW`. Same for `ebs-grow` `new_size_gib = 16384` (max) | extends `paramValidation.test.ts` |
| XLAYER-03 | One-over: `transition_days = 3651` both ways | SPA inline `Transition after (days) must be ≤ 3650`; server **422 `PARAM_OUT_OF_BOUNDS`** "A parameter is outside its allowed bounds."; the SPA surfaces the server reason on forced submits | precedent: `adv2.test.ts` |
| XLAYER-04 | Off-allowlist: `storage_class = "STANDARD"` (legal for replication, not lifecycle) both ways | SPA: `…must be one of: STANDARD_IA, …`; server 422 `PARAM_OUT_OF_BOUNDS` — allowlists are per-op manifest data | new |
| XLAYER-05 | `s3-enable-replication` ARN pattern + mode parity: bad-case `arn:aws:s3:::DR-Backup` (uppercase); valid submit in mock AND api mode | Bad: SPA `Destination bucket ARN has an invalid format`, server 422. Valid: BOTH modes land `NEEDS_ENGINEER` with the identical event `Routed to an engineer to author and review the Terraform` | extends `serverContract.test.ts` |
| XLAYER-06 | **Grow-only ownership (documented asymmetry).** `ebs-grow` current 200 → 150 via (1) form, (2) direct POST, (3) plan-check on a shrinking plan | (1) SPA blocks: `New size (GiB) must be greater than the current value (200) — this change is grow-only`. (2) The api ACCEPTS (its bounds checker has no growOnly branch) — expected. (3) The Go gate holds the line: **R4 grow-only** `VIOLATION …`, exit **2** — the shrink can never apply. If the api ever learns growOnly, this case flags the welcome tightening | new (api vitest + go test) |
| XLAYER-07 | dependsOn: `s3-create-bucket` with `encryption="AES256"` and a stale `kms_key` value | One shared predicate (`@app-lib/dependsOn`) both sides: SPA strips the inactive param; server skips it; stored request has no `kms_key` | `paramValidation.test.ts` dependsOn suite |

### 14.2 Preview honesty — the reviewed artifact never fabricates

| ID | Steps | Expected result | Automated? |
|---|---|---|---|
| XLAYER-10 | Preview `s3-add-lifecycle-rule` (rule `expire-logs`, prefix `logs/`, 90d → GLACIER, expire 365d) | Header `# ~ update  (Add) — new rule block appended to <address>`; body has `+`-prefixed `rule {`, `id = "expire-logs"`, `status = "Enabled"`, `storage_class = "GLACIER"`, `expiration {`; does NOT contain `resource "aws_s3_bucket_lifecycle_configuration"` (no re-creation lie) | `diffAppend.test.ts` |
| XLAYER-11 | Preview `ebs-create-snapshot` on `app01_sdb` | Contains `resource "aws_ebs_snapshot"`, `volume_id = aws_ebs_volume.app01_sdb.id`; contains neither `resource "aws_ebs_volume"` nor raw param names | `diffAppend.test.ts` |
| XLAYER-12 | Removal classes: (a) `sg-remove-ingress-rule` (sub-block), (b) `ebs-delete-volume` (whole), (c) `sns-delete-topic` (trap: block name == resource type) | (a) full-block diff returns **null** — honest degrade to the parameter diff. (b) `kind:'remove'`, whole block struck. (c) still whole-resource — the classifier (`isWholeResourceRemoveBlockOp`) gets the trap right | `blockDiffSubBlock.test.ts` |
| XLAYER-13 | Corpus invariants over every append + remove_block op | No append op renders a `resource "<type>"` re-creation; every remove_block agrees with the classifier | catalog sweeps in the two tests above |
| XLAYER-14 | **Differential probe (a real, current divergence).** `sg-add-internal-ingress-rule` preview vs `catalogctl edit` golden | SPA preview says `cidr_blocks = ["10.20.0.0/16"]` (client-side hint); the Go verb authors `cidr_block = "10.20.0.0/16"`. Expected result IS the divergence detected: the backstop is the PR lane's `terraform validate` (loud-but-broken doctrine). Resolution seam: mirror the override into the manifest/Go renameTable or delete the client hint | new differential case |
| XLAYER-15 | Mutate inventory after submit; open as approver | The approver renders the **pinned** artifact captured at submit — byte-identical to what the requester reviewed | `pinned-diff.test.ts` + new mutation arm |

### 14.3 Skeleton baseline parity (TS ↔ Go)

| ID | Steps | Expected result | Automated? |
|---|---|---|---|
| XLAYER-20 | `s3-create-bucket` with the baseline values through (1) TS renderer, (2) Go renderer, (3) real `catalogctl edit` | All three byte-equal after stripping the two-line DRAFT banner, and equal the committed `s3-create-bucket.golden.tf`: five resources incl. `lifecycle { prevent_destroy = true }`, four-`true` public-access block, SSE via `aws_kms_key.shared_cmk.arn`, versioning Enabled, lifecycle `days = 365` | `baselineSkeletons.test.ts`, `idiomrender_test.go`, `createResourceParity.test.ts` |
| XLAYER-21 | Mutation drill: change ONE value in the Go mirror only (`365 → 180`), run both suites | Go parity test fails (`render mismatch for s3-create-bucket`); TS stays green — drift is always a one-sided failure, never silently vacuous | manual release drill |
| XLAYER-22 | Escape parity: literal `${aws:Region}` in a tag | Both sides render `$${aws:Region}`; byte-equal | `createResourceParity.test.ts` |
| XLAYER-23 | Toolchain-degradation: run parity suites without `go`; run Go golden without `ccp/app` | Both SKIP loudly (never fail): `could not build catalogctl (go missing?) — skipping…` / `real manifest catalog not present at …`; the committed corpora remain the backstop. Triangulation: which suite reddens identifies which layer moved | skip paths pinned in code |

### 14.4 Window/cooling parity (TS ↔ Go), and who wins

| ID | Steps | Expected result | Automated? |
|---|---|---|---|
| XLAYER-40 | Full fixture matrix with `--estate-tz America/New_York` vs the TS port | Verdict-for-verdict and exit-for-exit equality incl. boundaries: 18:00 start inclusive `IN_WINDOW`/0; 22:00 end exclusive `WINDOW_EXPIRED`/6; inside-window-but-cooling `BEFORE_WINDOW`/5 (conjunction proven); garbled → `SCHEDULE_INVALID`/3 fail-closed | `scheduleWindowCheckParity.test.ts` |
| XLAYER-41 | **Disagreement scenario:** same fixture WITHOUT the tz flag | Go: `SCHEDULE_INVALID` exit 3 (estate-tz mismatch); TS: `IN_WINDOW` (no estate-tz concept — documented). **The Go gate wins** — CI's apply lane dispatches on the binary's exit code; the TS verdict is display-only | new subprocess case |
| XLAYER-42 | Run with Go absent | Live suite skips; the hand-transcribed TS verdict table (`schedule.test.ts`) still enforces the law | `schedule.test.ts` |

### 14.5 Catalog integrity, ForceNew honesty, vendored-data chain, generated docs

| ID | Steps | Expected result | Automated? |
|---|---|---|---|
| XLAYER-50 | Both ends lint the same catalog (Go manifest-lint + app opTaxonomy/verbShape); seed one violation per end | Go: `[target-arity] <op>: has 2 inventory non-reference locator params, want exactly 1`. App: `remove_block without target.path removes the WHOLE resource`. The two ends check DIFFERENT properties — both are load-bearing | both gates + new seeded-violation fixtures |
| XLAYER-51 | `npm run verify:safety`; then adjudicate one attribute ForceNew in a scratch copy | Baseline `forcenew-gate: N pass · 0 FAIL`; seeded: `FAIL FORCENEW <op>: <attr> adjudicated ForceNew`, exit 1; a deleted map hard-fails `MAP-ABSENT` (absent ≠ empty) | `verify:safety` + scratch drill |
| XLAYER-52 | Trace ONE forces-replace disagreement through every layer | Manifest true: SPA typed confirmation → api 422 `REPLACE_CONFIRMATION_REQUIRED` → ladder `['L2','L3']` → `catalogctl edit` `REFUSE FORCES_REPLACE` exit 2. Manifest false but plan replaces: **plan-check R3 replace-guard** `VIOLATION replace-guard: <address>`, exit 2 — no layer trusts another's claim | halves across 4 suites |
| XLAYER-60 | Walk the bootstrap chain: registry → manifests → inventory → blocks → panel | Discovery (`Bootstrap — importer sandbox`), manifests `iam,kms,s3`, inventory services match, every index key resolves to a chunk, `getBlockSource('aws_s3_bucket.state')` starts `resource "aws_s3_bucket" "state"` | `bootstrapProject.test.ts` |
| XLAYER-61 | Break each link once (no vendored data / corrupt project.json / inventory address missing from blocks index) | Empty-catalog fail-safe; `[ccp] vendored project at <key> failed validation; skipped.`; the silent-null case shows `No committed block for this address — it may be newer than the last baseline.` — plus a NEW guard asserting every bootstrap inventory address resolves a block | partly `projectRegistry.test.ts`; new sweep |
| XLAYER-70 | Prove one documented row live per generated doc (ERROR-STATES `PARAM_OUT_OF_BOUNDS` row; PERMISSIONS server-ladder rule; SETTINGS advisory row) | Doc row == code == wire, three-way; for the advisory row the pass criterion IS the documented asymmetry (SPA restricts, server accepts) — docs-as-contract | new thin asserts |
| XLAYER-73 | Execute every "Regenerate / verify" command block in the three generated docs | Every command runs clean and every quoted anchor appears at its cited location — doc drift caught before it misleads | new CI wrapper |

---

## 15. Traceability & the smoke subset

**Fully covered by automation today:** the api request lifecycle + auth + account (65 files, 977 tests — `ccp/api/test/`), the SPA journeys in jsdom-free component/logic tests (141 files, 2631+ tests — `ccp/app/src/test/`), the CLI corpus (368+ subtests — `tools/catalogctl`), the install smoke (`ccp-smoke.yml`), and the publish gate (`publish-gate.yml`). **Manual-only:** the Docker/installer paths (INST-04..14), doctor/self-update (OPS-04), browser-real TOTP enrolment with a phone authenticator, and the XLAYER mutation/triangulation drills.

**Smoke subset (~20 min) — run these 10 when time is short:**
1. INST-01 (`run-local.sh --smoke` exits 0)
2. INST-03 (`/healthz` 200 + `/readyz` ready:true)
3. DAY0-02..04 (first login → TOTP enrol → recovery codes → password change)
4. DEMO-04 (demo request → 2-person approval round-trip)
5. REQ-02 (out-of-bounds → 422 `PARAM_OUT_OF_BOUNDS`)
6. REQ-03 (two distinct approvers; 409 `ALREADY_APPROVED` on the repeat)
7. REQ-08 (forces-replace typed confirmation)
8. REQ-11 (freeze blocks with 423 `GLOBAL_FREEZE`)
9. ARM-01/03 (apply + drift lanes answer DISARMED)
10. CLI-02 (window-check verdict tokens + exit codes)

*Maintained alongside the code: when a case's expected value changes, the change is a product change — update the row in the same PR, citing the test that pins it.*
