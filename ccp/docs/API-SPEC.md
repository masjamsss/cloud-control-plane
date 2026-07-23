# ccp-api — API summary

> **Source of truth:** `ccp/api/openapi/ccp-api.yaml`. This file is a **derived, human-readable summary** — when they disagree, the YAML wins, and the YAML itself defers to the route code for behavior it has not caught up with (see Caveats in the PR that generated this doc).
> **Parity enforcement:** `ccp/api/test/openapi.test.ts` — a vitest suite that reads the YAML as text (openapi.test.ts:4) and asserts, string-containment style, that: the file is OpenAPI 3.1.0 with `ccp_session` and `X-Ccp-Client` declared (openapi.test.ts:7-12), every ApiClient path is present (openapi.test.ts:14-34), the scope enum and `SubmitDraft` exist (openapi.test.ts:36-39), and each later lane's endpoints/error-codes/status-values are declared (openapi.test.ts:41-100). It is a **spec-completeness** gate (spec must mention what shipped), not a route-by-route code↔spec differ.
> Facts below are measured from the working tree at commit `d781c25` (2026-07-17, post-rename merge). All identifiers are verbatim from code.

## Base URL and versioning

The YAML declares `servers: [{ url: /v2 }]` (ccp-api.yaml:6). The Hono app itself mounts route groups at the root — `/instance`, `/auth`, `/requests`, `/admin/migrate`, `/admin/instance`, `/admin`, `/projects` (ccp/api/src/index.ts) — so any `/v2` prefix must come from a reverse proxy, not this process.

## Global middleware (every request, in order)

CORS → store context → `withSession` → `withClientHeader` (CSRF) → `withProject` → `withPasswordGate` (ccp/api/src/index.ts:32-48).

| Gate | Rule | Failure |
|---|---|---|
| CORS | Origin must be in comma-separated `CCP_CORS_ORIGIN`; credentialed; allowed headers `Content-Type`, `x-ccp-client`, `X-Ccp-Project` (ccp/api/src/index.ts:32-39, deploy.ts:88-93) | No CORS headers echoed |
| CSRF header | Non-GET/HEAD requests outside `/auth/*` must send `x-ccp-client: ccp-spa` (ccp/api/src/middleware/session.ts:12-13, 55-63) | 403 `MISSING_CLIENT_HEADER` |
| Project scope | See "Project-scoping header" below (session.ts:71-78) | 422 `VALIDATION_FAILED` |
| Password gate | While `mustChangePassword` is true, everything except `/auth/*`, `/healthz`, `/readyz`, `/instance` (ADR-0023 — unauthenticated by design, never worth blocking) is refused (session.ts:90-105) | 403 `PASSWORD_CHANGE_REQUIRED` |

## Endpoint table

Auth column legend — **session**: valid full session cookie (`requireSession`, authz.ts via route group); **member**: account bound to the acting project (`requireProjectMembership`, ccp/api/src/middleware/authz.ts:54-69, else 403 `PROJECT_SCOPE`, denial audited); **role(x)**: per-project role gate (`requireRole`, authz.ts:26-34, else 403 `FORBIDDEN_ROLE`); **isAdmin**: `requireAdmin` gates on `isAdmin === true`, never `role === 'lead'` (authz.ts:37-42, else 403 `NOT_ADMIN`); **CSRF**: the `x-ccp-client` header (all non-GET below except `/auth/*`).

### Infra (code-only; not in the YAML)

| Method | Path | Auth | Purpose | Code |
|---|---|---|---|---|
| GET | `/healthz` | none | Liveness — always `{ok:true}` when the process serves | index.ts:52 |
| GET | `/readyz` | none | Readiness: store-loaded + account-count + audit-chain verify (every known project's chain, incl. `@control`); 503 when not ready. Body includes `estates` — the ready-project count excluding `@control` — so `estates: 0, ready: true` distinguishes a founded-but-still-blank instance from an actually-unready one (data-birth, [ADR-0021](../../docs/adr/0021-ccp-control-scope-and-settlement.md), `domain/readiness.ts`) | index.ts:57-60 |

### Instance identity (ADR-0023) — mounted before `/auth`, index.ts

| Method | Path | Auth | Purpose | Shapes | Spec : code |
|---|---|---|---|---|---|
| GET | `/instance` | none | The instance's displayed name + tagline (name/tagline only — no version/updatedBy leak); absent `INSTANCE` row → `{name: null, tagline: null}`, the SPA falls back to its baked-generic default | → `{name, tagline}` | yaml:275-283 : routes/instance.ts (`instancePublicRoutes`) |
| PUT | `/admin/instance` | session + isAdmin (**not** member — deliberately global, never project-scoped) | Rename the instance. Validated (name 1–64 chars trimmed single-line no control chars; tagline 0–140 same); version-guarded (read-then-guarded-write, lost race → 409); audited `instance-identity-change` on the `@control` chain. Immediate — never dual-control | `{name, tagline?}` → `{name, tagline, version}` | yaml:284-303 : routes/instance.ts (`instanceAdminRoutes`) |

### Auth

| Method | Path | Auth | Purpose | Shapes | Spec : code |
|---|---|---|---|---|---|
| POST | `/auth/login` | none | Verify credentials; full session for requesters, or 200 + `totpRequired:true` with a 5-minute pre-session for accounts with at least one enrolled device (challenge condition widened 2026-07-22: `needsTotp(a) \|\| totpDevicesOf(a).length > 0`, routes/auth.ts:149 — an enrolled account is now ALWAYS challenged, superseding ADR-0013's dormant-secret clause in part, see [ADR-0024](../../docs/adr/0024-ccp-multi-device-totp.md) clause 4); un-enrolled-but-required accounts also get `totpEnrollment:{secret, otpauthUri}` | `{username, password}` → `Me` (+`totpRequired?`, `totpEnrollment?`) | yaml:304-315 : auth.ts:63-149ish |
| POST | `/auth/totp` | pre-session cookie (`pending:'totp'`) | Complete the TOTP step — verified against EACH of the account's enrolled devices (≤5, `verifyAnyTotpDevice`), not just one; stamps the matching device's `lastUsedAt` (a lazy migration trigger for a legacy single-secret row) and carries `after:{deviceId}` on the `login-success` audit entry; swaps pre-session for a full session | `{code}` → `Me` | yaml:316-321 : auth.ts:185-213 |
| POST | `/auth/totp/enroll` | pre-session cookie (`pending:'enroll'`) | Confirm first-login TOTP enrollment — becomes the account's device #1, named "Authenticator"; if it is the account's first device, also auto-issues 10 recovery codes returned once in this response | `{code}` → `Me` (+`recoveryCodes?: string[]`) | yaml:322-329 : auth.ts:219-256ish |
| POST | `/auth/totp/recovery` | pre-session cookie (`pending:'totp'`) | A THIRD way to clear the same TOTP gate: burn one one-time recovery code instead of a device code (the "I lost every device" door). Response carries `recoveryLogin:true`. Failure is generic `TOTP_REQUIRED` (no enumeration) and feeds the same lockout backoff as a bad password | `{code}` → `Me` (+`recoveryLogin: true`) | yaml:352-358 : auth.ts:268-313 |
| POST | `/auth/logout` | none required | Delete the server session (if a cookie is present), clear cookie | → 204 | yaml:330-331 : auth.ts:314-324ish |
| GET | `/auth/me` | session | Session probe; slides the 30m idle window | → `Me` (`{user, mustChangePassword, sessionExpiresAt}`) | yaml:332-335 : auth.ts:326-343ish |
| POST | `/auth/change-password` | session | Change OWN password; current password re-verified (that check **is** the re-authentication — no ⚿ gate on top). `keepOtherSessions` (default false, 2026-07-22): false bumps `sessionVersion` (today's behavior — invalidates every other session, re-mints the caller's); true keeps other sessions alive (credential swap only; audited `after:{otherSessionsKept:true}`). Always bumps `accountVersion` | `{currentPassword, newPassword(min 8), keepOtherSessions?}` → `Me` | yaml:336-342 : auth.ts:345-388 |
| POST | `/auth/reauth` | session | The re-authentication gate ([ADR-0026](../../docs/adr/0026-ccp-reauth-gate.md)): prove it's you again with EXACTLY ONE of `{password}` or `{code}` (a live code from any enrolled device; recovery codes never accepted). Success stamps `reauthAt` on the CURRENT session item, valid 10 minutes (`REAUTH_MS`); failures bump the same login lockout counter, and a locked account is refused `LOGIN_BACKOFF` before the body is even read | `{password}` \| `{code}` → `{ok, reauthAt}` | yaml:343-351 : auth.ts:394-441ish |

### Account self-service (2026-07-22, account & security — mounted at `/auth`, `routes/account.ts`, a second Hono group beside the login-step routes above)

Every route below requires a live **full** session and acts only on `c.get('account')` — no id parameter anywhere in this group, so one account can never reach another's devices, codes, or sessions. "⚿" marks a route additionally gated by `requireReauth` (403 `REAUTH_REQUIRED` unless `session.reauthAt` is within 10 minutes).

| Method | Path | Auth | Purpose | Shapes | Spec : code |
|---|---|---|---|---|---|
| GET | `/auth/totp-devices` | session | List the caller's own devices — id/name/enrolledAt/lastUsedAt only, **never** `secretEnc` | → `[{id, name, enrolledAt, lastUsedAt?}]` | yaml:359-363 : account.ts:74-83 |
| ⚿ POST | `/auth/totp-devices` | session + reauth | Begin adding a device: mints a secret held on the caller's FULL session, returns the QR/setup-key material. Offer expires after 5 minutes. Refused `DEVICE_LIMIT` at the 5-device cap | → `{secret, otpauthUri}` | yaml:364-368 : account.ts:89-101 |
| ⚿ POST | `/auth/totp-devices/confirm` | session + reauth | Confirm the held secret with a live code + a name (1–40 chars). Appends the named device — materializes `totpDevices`, deletes the legacy `totp` field (idempotent). The account's FIRST device auto-issues recovery codes, returned once | `{code, name}` → `{id, name, enrolledAt, recoveryCodes?}` | yaml:369-377 : account.ts:107-163 |
| ⚿ DELETE | `/auth/totp-devices/:id` | session + reauth | Remove a device by id. Refuses `LAST_FACTOR` if it is the last device AND `needsTotp(account)` is true. If the last device and removal IS allowed, the recovery-code set is deleted with it | → `{ok: true}` | yaml:378-383 : account.ts:168-204 |
| GET | `/auth/recovery-codes` | session | Counts only, ever — never the codes or their hashes | → `{remaining, generatedAt?}` | yaml:384-388 : account.ts:209-213 |
| ⚿ POST | `/auth/recovery-codes/regenerate` | session + reauth | Replace the WHOLE set (old codes all die). Refused `TOTP_REQUIRED` with no device enrolled — codes exist only while 2FA is active | → `{codes: string[10], generatedAt}` | yaml:389-393 : account.ts:217-239 |
| GET | `/auth/sessions` | session | The caller's own LIVE sessions (expired/pre-session rows filtered). `id` is the stored sha256 of the token (never the token); `current` marks the session resolved for this request | → `[{id, issuedAt, lastSeenAt, current}]` | yaml:394-398 : account.ts:244-250 |
| ⚿ DELETE | `/auth/sessions/:id` | session + reauth | Revoke ONE of the caller's OWN sessions — 404 on any id not in their own list (no cross-user probing). Deleting the current session IS sign-out | → `{ok: true, revoked: 1}` | yaml:399-404 : account.ts:256-269 |
| ⚿ POST | `/auth/sessions/revoke-others` | session + reauth | Sign out every OTHER session, keeping the caller's own alive — deliberately NO `sessionVersion` bump (that would kill the keeper too) | → `{ok: true, revoked: n}` | yaml:405-409 : account.ts:273-282 |

### Requests (group gate: session + member — requests.ts:197)

| Method | Path | Extra auth | Purpose | Shapes | Spec : code |
|---|---|---|---|---|---|
| POST | `/requests` | CSRF | Submit a change. Identity-free (requester/teamId/risk recomputed server-side); single-op OR `items[1..100]` change set, validated atomically; schedule V2-V6 validated; idempotent via `idempotencyKey` | `SubmitDraft` → 201 `ChangeRequest` (200 on idempotent replay) | yaml:193-201 : requests.ts:202-457 |
| GET | `/requests?scope=mine\|pending\|all` | `pending`/`all` need role(approver\|lead) on the project | List; lazily settles cooling + window expiry; `pending` filters to requests whose NEXT ladder step the caller's role can sign | → `{items: ChangeRequest[]}` | yaml:187-192 : requests.ts:460-494 |
| GET | `/requests/:id` | — | Read one (settles cooling/window first) | → `ChangeRequest` \| 404 | yaml:202-205 : requests.ts:497-506 |
| GET | `/requests/:id/feasibility` | — | LIVE-recomputed quorum feasibility (vs the submit-time snapshot on the row) | → `Feasibility` | yaml:274-281 : requests.ts:512-530 |
| POST | `/requests/:id/approve` | role(approver\|lead) + CSRF + **enrolled TOTP factor** (403 `TOTP_ENROLLMENT_REQUIRED` without one, requests.ts:548-550) | Sign the next positional ladder step (L2 = approver-or-lead, L3 = lead, else 403 `WRONG_APPROVAL_LEVEL`); one signature per person (409 `ALREADY_APPROVED`); not own (403 `SELF_APPROVAL`); tighten-only requirement re-derived live | → `ChangeRequest` | yaml:206-222 : requests.ts:533-660 |
| POST | `/requests/:id/reject` | role(approver\|lead) + CSRF; not own | Reject an open request (both tracks) | `{reason?}` → `ChangeRequest` | yaml:223-229 : requests.ts:663-700 |
| POST | `/requests/:id/link-pr` | role(lead) + CSRF | Record the fulfilling engineering PR (https-only URL; number derived from a `/pull/{n}` tail); refused on REJECTED/CANCELLED | `{prUrl(≤500), prNumber?}` → `ChangeRequest` | yaml:258-273 : requests.ts:712-766 |
| POST | `/requests/:id/plan-summary` | role(lead) + CSRF | CI records the structured terraform-plan summary onto the request; refused on REJECTED/CANCELLED/WITHDRAWN | `PlanSummarySchema` body → `ChangeRequest` | **not in YAML** : requests.ts:786-828 |
| POST | `/requests/:id/cancel` | requester-own OR lead/isAdmin (else 403 `CANCEL_FORBIDDEN`) + CSRF | Cancel an approved-but-unapplied change; valid from `APPROVED_COOLING`, `AWAITING_DEPLOY_APPROVAL`, `WINDOW_EXPIRED` (requests.ts:116) | → `ChangeRequest` | yaml:230-241 : requests.ts:836-905 |
| POST | `/requests/:id/rewindow` | requester-own OR lead/isAdmin (else 403 `REWINDOW_FORBIDDEN`) + CSRF | Re-time a maintenance window (exit from `WINDOW_EXPIRED`, or before-window re-time); refused mid-window, for `kind:'now'` rows, or when the last approval is >30 days old (`SCHEDULE_STALE_APPROVAL`); approvals survive | `{at, endAt?}` → `ChangeRequest` | yaml:242-257 : requests.ts:914-1012 |

### Catalog — **declared in the YAML, not routed in code**

`GET /catalog/manifests` (yaml:282-283) and `GET /catalog/inventory` (yaml:284-285) have no route group in the app (index.ts:62-66 mounts only `/auth`, `/requests`, `/admin/migrate`, `/admin`, `/projects`) — a request to them returns 404 from this process.

### Admin (group gate: session + isAdmin + member — admin.ts:112; all non-GET need CSRF)

| Method | Path | Purpose | Dual-control? | Spec : code |
|---|---|---|---|---|
| GET | `/admin/policy` | Current approval policy + version | — | yaml:361-363 : admin.ts:115-118 |
| PUT | `/admin/policy` | Set policy (each field 1–5, else 422 `POLICY_OUT_OF_RANGE`) | tighten → 200; downgrade → 202 `PendingConfigChange` | yaml:364-368 : admin.ts:120-149 |
| GET | `/admin/settings` | The four settings: `freeze.global`, `catalog.disabled-ops`, `rate.limits`, `allowlist.restrictions` | — | yaml:380-381 : admin.ts:152-159 |
| PUT | `/admin/settings/:key` | Put a setting | freeze-on / narrow → 200; freeze-off / widen → 202 | yaml:382-385 : admin.ts:161-195 |
| GET | `/admin/risk` | All applied risk overrides (map opId→risk) | — | yaml:369-370 : admin.ts:204-216 |
| PUT | `/admin/risk/:opId` | Set override `{risk: LOW\|MEDIUM\|HIGH}` | increase → 200; reduction → 202 | yaml:371-376 : admin.ts:218-251 |
| DELETE | `/admin/risk/:opId` | Clear override to the manifest floor | reduction → 202 | yaml:377-379 : admin.ts:253-277 |
| PUT | `/admin/catalog/:opId` | Enable/disable an operation `{enabled}` | disable → 200; re-enable → 202 | yaml:386-391 : admin.ts:280-306 |
| GET | `/admin/accounts` | List accounts (public projection only) | — | yaml:286-288 : admin.ts:309-313 |
| POST | `/admin/accounts` | Enroll `{username, displayName, role, teamId, password, projectId?}`; `'*'` binding refused | senior role, or cross-project enroll → 202; requester-on-own-project → 201 | yaml:289-297 : admin.ts:315-368 |
| PATCH | `/admin/accounts/:id` | ONE verb of `setRole`/`setTeam`/`revoke` (each names one projectId) + global `status`/`isAdmin`/`totpRequired`, or a standalone `displayName` | loosening (capacity raise, isAdmin grant, re-enable) → 202; tightening → 200. Last-active-admin and per-project last-lead guards → 422 `LAST_LEAD_GUARD` | yaml:298-316 : admin.ts:370-550 |
| DELETE | `/admin/accounts/:id` | PERMANENT delete; refuses self (403 `SELF_DELETE`), last active admin, last active lead of any project; kills sessions | immediate (tightening) | yaml:317-326 : admin.ts:558-595 |
| POST | `/admin/accounts/:id/reset-password` | `{newPassword(min 8)}`; sets `mustChangePassword`, bumps `sessionVersion` | senior-anywhere target → 202; requester → 200 | yaml:327-333 : admin.ts:597-635 |
| POST | `/admin/accounts/:id/reset-totp` | Clear the enrolled factor + kill sessions; next login re-enrolls | immediate | yaml:334-342 : admin.ts:798-819 |
| POST | `/admin/accounts/:id/revoke-sessions` | Bump `sessionVersion` + delete every live session | immediate | yaml:343-349 : admin.ts:822-839 |
| GET | `/admin/config-changes` | Pending/dispositioned dual-control items | — | yaml:392-395 : admin.ts:638-641 |
| POST | `/admin/config-changes/:id/ack` | Second DISTINCT admin applies (proposer self-ack → 403 `SELF_ACK`; drift → 409 `STALE_PROPOSAL`) | — | yaml:396-400 : admin.ts:643-655 |
| POST | `/admin/config-changes/:id/reject` | Any admin (incl. proposer) withdraws | — | yaml:401-403 : admin.ts:657-665 |
| GET | `/admin/audit` | Hash-chained audit, newest first; `?limit=` (default 100, max 1000) + `?cursor=` | — | yaml:404-408 : admin.ts:669-683 |
| GET | `/admin/audit/export` | Whole chain as a self-verifying JSON attachment | — | **not in YAML** : admin.ts:687-690 |
| GET | `/admin/teams` | List teams | — | yaml:350-351 : admin.ts:693-698 |
| POST | `/admin/teams` | Create `{name, serviceSlugs?}` (dupes → 409 `DUPLICATE_TEAM`; slugs stolen from other teams, audited) | immediate | yaml:352-353 : admin.ts:700-727 |
| PATCH | `/admin/teams/:id` | Rename `{name}` | immediate | yaml:354-355 : admin.ts:729-749 |
| PUT | `/admin/teams/:id/services` | Replace owned services `{serviceSlugs}` (single-ownership steal audited) | immediate | yaml:358-360 : admin.ts:751-774 |
| DELETE | `/admin/teams/:id` | Delete (refused while members/services exist → 409 `TEAM_NOT_EMPTY`) | immediate, 204 | yaml:356-357 : admin.ts:776-795 |
| POST | `/admin/migrate/v1` | One-shot v1 (SPA localStorage) import; only while the backend holds JUST the bootstrap account (else 409 `BACKEND_NOT_EMPTY`) | — | yaml:409-413 : migrate.ts:51-121 |

### Projects registry (group gate: session + member — projects.ts:201; non-GET need CSRF)

| Method | Path | Extra auth | Purpose | Spec : code |
|---|---|---|---|---|
| GET | `/projects` | any bound session | TWO-TIER: lead-on-acting-project **and** isAdmin → rich `Project` (trustRequest/report/artifacts); everyone else → `ProjectSummary` (`{id, name, github, accountId, region, status, trust?}`). `rawReport` never serializes | yaml:414-425 : projects.ts:204-215 |
| POST | `/projects` | role(lead) + isAdmin | Register a draft; strict body (`status`/`trust`/`artifacts` refused); region must be in `REGION_ALLOWLIST` (projects.ts:55-89); dupes → 409 `DUPLICATE_PROJECT` | yaml:426-439 : projects.ts:218-250 |
| PUT | `/projects/:id/trust-request` | role(lead) | Upload the `catalogctl onboard` artifact pair; server recomputes sha256 over the raw bytes (else 422 `PRESCAN_SHA_MISMATCH`), strict-parses `PrescanReport`, requires repo match; status → `pending-trust`; refused once trusted/ready (409) | yaml:440-458 : projects.ts:253-322 |
| POST | `/projects/:id/trust` | role(lead) + isAdmin | ALWAYS 202 dual-control (`kind: project-trust`); body must echo the stored binding; stored bytes re-hashed; verdict ≠ clean → 422 `TRUST_VERDICT_NOT_CLEAN` | yaml:459-476 : projects.ts:325-381 |
| DELETE | `/projects/:id` | role(lead) + isAdmin | ALWAYS 202 dual-control (`kind: project-deregister`); ack deletes the registry item **and (2026-07-17) its upload tokens, data-version rows, and on-disk served data**; request/audit history is never erased | yaml:491-500 : projects.ts:416-437 |

### Projects data plane (2026-07-17 — routes/projectData.ts, mounted inside the same group; full detail: specs/ccp-api.md §11.4)

The registry group gate (session + member) applies to every row below EXCEPT the token-authed upload, which the group
middleware deliberately steps aside for (`middleware/session.ts#isUploadTokenLane` — CSRF is also exempt there: the
Bearer token, not an ambient cookie, is the credential) and which enforces its own fail-closed token gate.

| Method | Path | Extra auth | Purpose | Spec : code |
|---|---|---|---|---|
| POST | `/projects/:id/upload-tokens` | role(lead) + isAdmin; project trusted/ready, not archived | Mint a CI upload token (shown ONCE; argon2id hash at rest; default 24h, `ttlMinutes` 5..10080) | yaml `/projects/{id}/upload-tokens` : projectData.ts |
| DELETE | `/projects/:id/upload-tokens/:tokenId` | role(lead) + isAdmin | Revoke (immediate) | yaml : projectData.ts |
| PUT | `/projects/:id/data` | **Bearer upload token only** (never a session) | Stage a data bundle as the next immutable version: 16 MiB cap → strict schema → canonical-JSON sha256 digest binding (422 `DATA_DIGEST_MISMATCH`) → server-side redaction re-run (warnings) | yaml : projectData.ts |
| GET | `/projects/:id/data` | role(lead) + isAdmin | List versions (staged + active) + the `activeVersion` pointer | yaml : projectData.ts |
| POST | `/projects/:id/data/:version/activate` | role(lead) + isAdmin | ALWAYS 202 dual-control (`kind: project-data-activate`); the ack points `dataActive` at the version. The FIRST activation's ack is the go-live: it also flips the project `ready` (the ONE transition making a project routable) and records `artifacts` from the server's own digests | yaml : projectData.ts |
| POST | `/projects/:id/archive` | role(lead) + isAdmin | Tightening — applies immediately; drops routability/serving, refuses uploads/mints | yaml : projectData.ts |
| POST | `/projects/:id/unarchive` | role(lead) + isAdmin | Loosening — ALWAYS 202 dual-control (`kind: project-unarchive`) | yaml : projectData.ts |
| GET | `/projects/:id/manifests` · `/inventory` · `/blocks/:chunk` | session bound to the TARGET `:id` | Serve the ACTIVE version's files (chunk `index` = the address map; chunk names checked against the stored list, never the filesystem); archived/never-activated → 404 | yaml : projectData.ts |

### Drift telemetry — the two operator buttons + the legitimize front door (2026-07-20 drift-audit-fixes plan, routes/drift.ts, mounted inside the same registry group)

The three routes this program ADDED (C2/B1/B2). The pre-existing `PUT`/`GET /projects/:id/drift` (WI-2, token-lane ingest + role-projected serve) and `POST /projects/:id/drift/proposals/:digest/submit` (WI-6, the ordinary adopt/revert door) predate this table and are declared in the YAML (`ccp-api.yaml` `/projects/{id}/drift`, `/projects/{id}/drift/proposals/{digest}/submit`) and implemented at `routes/drift.ts:212` (PUT), `:389` (GET), `:467` (submit) — not repeated here; this section only covers the three NEW ones.

| Method | Path | Extra auth | Purpose | Spec : code |
|---|---|---|---|---|
| POST | `/projects/:id/drift/security/:digest/legitimize` | session + TARGET-bound; role(approver\|lead) | C2: converge code to a justified emergency change via a full-scrutiny `system-drift-legitimize` (engineer_only ⇒ `NEEDS_ENGINEER`, `[L2,L3]` ladder) request; `:digest` must name an open, fresh, REVERT-flavored proposal; eligibility re-derived (every verdict at the addresses must be security-posture); the revert proposal row is NOT consumed | yaml `/projects/{id}/drift/security/{digest}/legitimize` : routes/drift.ts:741 |
| POST | `/projects/:id/drift/check` | session + TARGET-bound; role **lead or admin** (`roleFor==='lead' \|\| isAdmin===true`, the apply-route precedent — stricter than adopt/revert/legitimize) | B1 "Start drift check": one-in-flight-per-project run of the operator's `CCP_DRIFT_CHECK_CMD` (env `CCP_DRIFT_PROJECT`) — the api never runs terraform; 202 regardless of the trigger's own exit code (fire-and-forget) | yaml `/projects/{id}/drift/check` : routes/drift.ts:878, domain/driftCheck.ts |
| POST | `/projects/:id/drift/generate` | session + TARGET-bound; role lead or admin | B2 "Fix the drift" refresh: exposes the existing §6.3 non-reentrant generation runner on demand (idempotent via digests); deliberately NOT freeze-gated (produces proposal rows, never a request) | yaml `/projects/{id}/drift/generate` : routes/drift.ts:947 |

`DRIFT_CHECK_FORBIDDEN`/`DRIFT_GENERATE_FORBIDDEN` are inline, non-taxonomy 403 literals (like `APPLY_FORBIDDEN`/`DRIFT_DISARMED`) — see [PERMISSIONS.md §9](PERMISSIONS.md#9-drift-telemetry-the-two-operator-buttons--the-legitimize-front-door-2026-07-20-drift-audit-fixes-plan). No new `errors.ts` codes were added by this program (ERROR-STATES.md is unchanged).

## Project-scoping header

- Header name (exact, as read in code): **`x-ccp-project`** (ccp/api/src/middleware/session.ts:73).
- **Absent → defaults to the reserved control-plane scope `'@control'`** (`CONTROL_SCOPE`,
  ccp/api/src/projects.ts; session.ts) — data-birth
  ([ADR-0021](../../docs/adr/0021-ccp-control-scope-and-settlement.md)): a header-less client
  is now an inert **control-plane** client (auth + admin-global + the projects registry only),
  never an implicit estate. This supersedes the pre-data-birth wording "a header-less client is
  an inert single-project client," which described the old hardcoded single-project default.
- **Unknown id → 422 `VALIDATION_FAILED` `{field: 'x-ccp-project'}`** (session.ts). The known
  set is `{'@control'} ∪ {store projects with status 'ready', unarchived}`, cached in-process
  and lazily hydrated from the registry (projects.ts; session.ts) — a blank/freshly-founded
  store's known set is exactly `{'@control'}` until an account is registered, trusted, and
  activated.
- Passing the header only proves the project **exists**; `requireProjectMembership` then
  requires the account be **bound** to it (`roles` map; `'*'` = all projects; a bare legacy row
  now resolves to `{}` — member of nothing, materialized to an explicit binding by the one-time
  boot settlement, `domain/settlement.ts`, for any store that actually has one) — else 403
  `PROJECT_SCOPE`, with the denial appended to the target project's audit chain (authz.ts). A
  caller bound (e.g. via `'*'`) but acting on `'@control'` itself instead gets 403
  `CONTROL_SCOPE` on any estate-only surface — request submission/approval, catalog/inventory
  reads — since `'@control'` is not a project and has no data plane (`routes/requests.ts`,
  `errors.ts`).

## Session / cookie mechanics

1. Cookie **`ccp_session`** carries an opaque 256-bit base64url token; the server stores only `sha256(token)` (ccp/api/src/auth/sessions.ts:16-24; middleware/session.ts:9).
2. Posture: `HttpOnly` always, `Path=/`; `Secure` defaults ON in production (`CCP_SECURE_COOKIES` overrides); `SameSite` defaults `Lax` (`CCP_COOKIE_SAMESITE` = strict/none overrides) (deploy.ts:56-81).
3. TTLs: **12h absolute, 30m idle**, idle window slid on every successfully resolved request (sessions.ts:8-10, 74-77).
4. `sessionVersion` mismatch (password reset, senior grant, revoke-sessions) → 401 `SESSION_INVALIDATED`; expiry/idle → 401 `SESSION_EXPIRED` (sessions.ts:66-69; session.ts:16-28).
5. TOTP pre-sessions (`pending: 'totp' | 'enroll'`) live 5 minutes (auth.ts:23) and never resolve as full sessions — any business route sees 401 `TOTP_REQUIRED` (sessions.ts:71-72).

## Rate and size limits

| Limit | Value | Over → | Code |
|---|---|---|---|
| Login backoff | 5 failed attempts, then lock `min(60, 2^(attempts−5))` minutes | 429 `LOGIN_BACKOFF` (`details.until`) | auth.ts:75-91 |
| Submissions per requester | 50/hour per project (settings-tunable, `SETTING#rate.limits`) | 429 `RATE_LIMITED` | rateLimit.ts:24-35; config.ts:55 |
| Open requests per requester | max 20 (statuses `AWAITING_CODE_REVIEW`, `AWAITING_DEPLOY_APPROVAL`, `CHANGES_REQUESTED`, `NEEDS_ENGINEER`, `APPROVED_COOLING` occupy a slot) | 429 `RATE_LIMITED` | rateLimit.ts:22, 37-38 |
| Submit body size | 256 KiB (`MAX_SUBMIT_BODY_BYTES`) | 422 `VALIDATION_FAILED` before parsing | requests.ts:50, 202 |
| Change-set items | 100 (`MAX_CHANGE_SET_ITEMS`) | 422 `VALIDATION_FAILED` | requests.ts:44, 87 |
| Prescan report upload | 512 KiB string max | 422 `VALIDATION_FAILED` | projects.ts:123; yaml:454 |
| `GET /admin/audit` page | `limit` default 100, cap 1000 | — | admin.ts:672-673 |
| Any 429 | always sets `Retry-After` (from `details.retryAfter`, else `details.until`, else 60s) | — | errors.ts:88-105 |

Every 4xx body is `{code, reason, details?}` from the single taxonomy in ccp/api/src/errors.ts:10-71.

## Regenerate / verify

Run from the repo root. Each command re-checks one table above against code.

```sh
# 1. The spec file + parity test exist and the test reads the YAML as text
sed -n '1,12p' ccp/api/test/openapi.test.ts

# 2. Every path declared in the YAML (compare against the endpoint tables)
grep -n '^  /' ccp/api/openapi/ccp-api.yaml

# 3. Every route registered in code (compare method+path against the tables)
grep -n "app.route\|app.get" ccp/api/src/index.ts
grep -nE "^\s*(a|r|p|m|auth)\.(get|post|put|patch|delete)\(" ccp/api/src/routes/*.ts

# 4. Route-group auth gates (session/admin/membership per group)
grep -n "r.use\|a.use\|p.use\|m.use" ccp/api/src/routes/*.ts
grep -n "requireRole\|requireAdmin" ccp/api/src/routes/*.ts

# 5. Project header semantics: name, default, unknown-id refusal, membership gate
grep -n "x-ccp-project\|CONTROL_SCOPE" ccp/api/src/middleware/session.ts ccp/api/src/projects.ts
grep -n "PROJECT_SCOPE\|CONTROL_SCOPE" ccp/api/src/middleware/authz.ts ccp/api/src/routes/requests.ts

# 6. Session cookie + TTLs + CSRF header constants
grep -n "SESSION_COOKIE\|CLIENT_HEADER\|CLIENT_VALUE" ccp/api/src/middleware/session.ts
grep -n "ABSOLUTE_MS\|IDLE_MS" ccp/api/src/auth/sessions.ts
grep -n "sessionCookieOptions\|resolveSameSite\|resolveSecureCookies" ccp/api/src/deploy.ts

# 7. Rate/size limits
grep -n "MAX_SUBMIT_BODY_BYTES\|MAX_CHANGE_SET_ITEMS" ccp/api/src/routes/requests.ts
grep -n "DEFAULT_RATE_LIMITS" ccp/api/src/domain/config.ts
grep -n "failedAttempts >= 5" ccp/api/src/routes/auth.ts

# 8. Known spec-vs-code gaps still open? (should print route hits for plan-summary
#    and audit/export, and NO /catalog mount in index.ts)
grep -n "plan-summary\|audit/export" ccp/api/src/routes/*.ts ccp/api/openapi/ccp-api.yaml
grep -n "catalog" ccp/api/src/index.ts

# 9. Error taxonomy statuses cited in the tables
grep -n "status: 4" ccp/api/src/errors.ts
```

## Known tensions & caveats (extraction findings, 2026-07-17)

Found while deriving this doc from code at commit d781c25 — kept verbatim so nothing
is lost. Actionable ones are tracked separately; do not silently "fix" this doc to hide them.

- Task text said to state facts "at commit undefined" — the working tree HEAD is d781c25 (branch claude/docs-restructure-fundamentals-a929a5, clean); the doc cites d781c25.
- Base-path mismatch: the YAML declares servers url /v2 (ccp/api/openapi/ccp-api.yaml:6) but the app mounts all groups at the root (ccp/api/src/index.ts:62-66); no /v2 prefix exists in this process. Stated in the doc; flagging because the YAML is nominally authoritative.
- /catalog/manifests and /catalog/inventory are declared in the YAML (ccp-api.yaml:282-285) but NO /catalog route group is mounted (ccp/api/src/index.ts:62-66) — they 404 in code. The parity test only checks the strings exist in the YAML (openapi.test.ts:19-20), so this gap is invisible to it.
- POST /requests/{id}/plan-summary is implemented (ccp/api/src/routes/requests.ts:786-828, lead-only) but absent from the YAML paths — spec lags code.
- GET /admin/audit/export is implemented (ccp/api/src/routes/admin.ts:687-690) but absent from the YAML paths.
- GET /healthz and GET /readyz are implemented (ccp/api/src/index.ts:52-60) but absent from the YAML.
- ChangeRequest.planSummary is typed `string` in the YAML (ccp-api.yaml:58) but code stores the structured PlanSummarySchema object with counts/resourceChanges (requests.ts:790-813, store/planSummarySchema.ts).
- GET /admin/audit supports a `limit` query (default 100, cap 1000, admin.ts:672-673) that the YAML does not declare (ccp-api.yaml:404-408 declares only cursor).
- The YAML's security-scheme note "Non-GET also requires X-Ccp-Client header" (ccp-api.yaml:11) is broader than code: /auth/* non-GET routes are exempt from the CSRF header (middleware/session.ts:55-63).
- YAML /auth/totp summary says the TOTP step is "for approver/lead" (ccp-api.yaml:160); code's needsTotp also covers isAdmin accounts and any account with admin-pinned totpRequired=true (ccp/api/src/auth/totp.ts:67-71).
- The parity test is string-containment over the YAML text only (openapi.test.ts:4, 32) — it proves the spec MENTIONS shipped surfaces, not that every code route is declared or that declared routes exist in code; the /catalog and plan-summary/audit-export gaps above are exactly the class it cannot catch.
- Rate-limit OPEN_STATUSES includes CHANGES_REQUESTED and plan-summary refuses WITHDRAWN (rateLimit.ts:22, requests.ts:131) — neither status appears in the YAML's ChangeRequest.status known-values prose (ccp-api.yaml:53); likely SPA-era or future statuses.
- The doc's endpoint auth column comes from route code (the guards actually enforced), not the YAML — the YAML has no per-path security overrides except security:[] on /auth/login, /auth/totp, /auth/totp/enroll (ccp-api.yaml:149,160,166); /auth/logout is declared session-secured in the YAML by inheritance but code deletes the session without requiring one (auth.ts:194-203).
