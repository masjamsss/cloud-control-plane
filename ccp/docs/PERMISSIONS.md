# Permissions matrix

Single source-of-truth permissions reference for the Cloud Control Plane. All facts below are measured from the working tree at commit `d781c25d828bd580dd2c426e6337b523cdb05511` (2026-07-17, post-rename merge); every claim cites the file and line it was read from. The control plane has two runtime modes: the SPA's standalone/mock mode (localStorage-backed, advisory only) and api-mode against `ccp-api` (server-enforced). **Where the two disagree, the server is the authority** — the SPA's checks only decide what to show (ccp/app/src/lib/approvalLadder.ts:4-9).

## 1. Roles and the admin capability

| Primitive | Values / type | Defined at | Notes |
|---|---|---|---|
| `role` | `requester` \| `approver` \| `lead` | ccp/api/src/store/schema.ts:17 | Exactly three roles; the union is locked (docs/adr/0011-gerbang-admin-capability.md:11) |
| `roles` (per-project map) | `{ [projectId \| '*']: { role, teamId? } }` | ccp/api/src/store/schema.ts:31, :109 | Canonical authorization field; `'*'` = all projects (ccp/api/src/projects.ts:73) |
| `role` / `teamId` / `projects` (top-level) | legacy, optional | ccp/api/src/store/schema.ts:117, :119, :142 | Read only through the `rolesOf` shim (ccp/api/src/projects.ts:95-109); never a live authz source |
| `isAdmin` | `boolean` | ccp/api/src/store/schema.ts:124 | A **capability, not a role** (ADR-0011); global across projects (ccp/api/src/routes/admin.ts:441 comment) |
| `totpRequired` | `boolean?` | ccp/api/src/store/schema.ts:134 | Admin-set per-account 2FA override; `undefined` = role default |
| Ladder step | `L2` \| `L3` | ccp/api/src/domain/exposure.ts:63 | L2 = first approver (approver-or-lead), L3 = final approver (lead only) |

Effective role is **per project**: `roleFor(account, projectId)` returns the explicit project entry, else the `'*'` entry, else `undefined` = not a member, fail closed (ccp/api/src/projects.ts). **Data-birth (2026-07-22, [ADR-0021](../../docs/adr/0021-ccp-control-scope-and-settlement.md)):** a bare legacy row now resolves to `{}` — member of **nothing**, never the legacy project id alone and never all-projects; the old legacy-id-only fallback is retired. A store that actually had bare legacy rows gets them materialized into an explicit `roles` map by the one-time boot settlement (`domain/settlement.ts`) before this floor is ever consulted at runtime — see [DOMAIN-MODEL.md §4.4](DOMAIN-MODEL.md#44-schema-version--migration-notes).

**The reserved control-plane scope `@control`** (`CONTROL_SCOPE`, projects.ts) is always "known" (routable) but is **not a project** — no `ProjectItem` row for it ever exists, and no account can be bound to it directly. Membership on it holds **only** via the `'*'` all-projects wildcard: the founding admins act on `@control` (auth, admin-global, the projects registry) through their `'*'` binding, exactly as they act on every other project through it. An estate-bound operator with no `'*'` binding has no way to reach `@control` at all, by construction. Every estate-only surface (request submission/approval, catalog/inventory reads) refuses `@control` with 403 `CONTROL_SCOPE` regardless of who is bound.

## 2. Role × capability matrix

"Server" names the enforcement point in `ccp-api`; "SPA" marks purely advisory checks. `isAdmin` grants **nothing** in this table unless its column says so — admin is never an approval seniority (ccp/api/src/domain/eligibility.ts:12-14).

| Capability | requester | approver | lead | isAdmin | Server enforcement | SPA advisory copy |
|---|---|---|---|---|---|---|
| Submit request for **own team's** services | ✔ | ✔ | ✔ | — | `canRequest` gate, 403 `TEAM_SCOPE` (ccp/api/src/routes/requests.ts:270) | ccp/app/src/lib/permissions.ts:19-23 |
| Submit request for **any** service | ✘ | ✔ | ✔ | — | same `canRequest` (approver/lead bypass team scope, ccp/app/src/lib/permissions.ts:20 — the server imports this exact function, ccp/api/src/routes/requests.ts:5) | ccp/app/src/lib/permissions.ts:36-42 (`requestableServices`) |
| List `scope=mine` | ✔ | ✔ | ✔ | — | any project member (ccp/api/src/routes/requests.ts:481) | — |
| List `scope=pending` / `scope=all` | ✘ | ✔ | ✔ | — | 403 `FORBIDDEN_ROLE` (ccp/api/src/routes/requests.ts:468-470) | Approvals nav hidden (ccp/app/src/components/AppShell.tsx:58,64) |
| Sign **L2** (first approval) | ✘ | ✔ | ✔ | — | `canSignStep` (ccp/api/src/domain/eligibility.ts:16-18) via ccp/api/src/routes/requests.ts:571 | ccp/app/src/lib/approvalLadder.ts:16-18 |
| Sign **L3** (final approval) | ✘ | ✘ | ✔ | — | same; wrong role → 403 `WRONG_APPROVAL_LEVEL` (ccp/api/src/routes/requests.ts:571, ccp/api/src/errors.ts:27) | Approve button hidden (ccp/app/src/features/approvals/ApprovalsQueue.tsx:309) |
| Approve own request | ✘ | ✘ | ✘ | ✘ | 403 `SELF_APPROVAL` (ccp/api/src/routes/requests.ts:542) | ccp/app/src/lib/permissions.ts:31 |
| Approve twice (any two steps) | ✘ | ✘ | ✘ | ✘ | `approvalKey` dedup, 409 `ALREADY_APPROVED` (ccp/api/src/routes/requests.ts:561-562) | ccp/app/src/lib/permissions.ts:32 |
| Reject an open request | ✘ | ✔ | ✔ | — | `requireRole('approver','lead')`, self-reject refused (ccp/api/src/routes/requests.ts:663, :676) | — |
| Cancel approved-but-unapplied | own requests only | ✘ (unless owner) | ✔ | ✔ | 403 `CANCEL_FORBIDDEN` otherwise (ccp/api/src/routes/requests.ts:853-856) | — |
| Re-window | own requests only | ✘ (unless owner) | ✔ | ✔ | 403 `REWINDOW_FORBIDDEN` otherwise (ccp/api/src/routes/requests.ts:940-943) | — |
| Link the fulfilling PR | ✘ | ✘ | ✔ | — | `requireRole('lead')` (ccp/api/src/routes/requests.ts:712) | — |
| Record a plan summary | ✘ | ✘ | ✔ (incl. the CI service identity provisioned as lead) | — | `requireRole('lead')` (ccp/api/src/routes/requests.ts:786, comment :776-780) | — |
| Read/export the audit chain (api) | ✘ | ✘ | ✘ | ✔ | all `/admin/*` behind `requireAdmin` (ccp/api/src/routes/admin.ts:112; audit at :669, :686) | SPA "Dashboard" nav is **lead**-gated (ccp/app/src/components/AppShell.tsx:59,65) — see caveats |
| Admin console + all `/admin/*` routes | ✘ | ✘ | ✘ | ✔ | `requireAdmin` gates on `isAdmin`, **never** `role==='lead'` (ccp/api/src/middleware/authz.ts:37-42) | Admin nav on `user.isAdmin` (ccp/app/src/components/AppShell.tsx:67) |
| Ack/reject a pending (dual-control) change | ✘ | ✘ | ✘ | ✔ second **distinct** admin only | 403 `SELF_ACK` on own proposal (ccp/api/src/domain/dualControl.ts:234) | — |

Every request route additionally sits behind `requireSession` + `requireProjectMembership` — an account not bound to the resolved project gets 403 `PROJECT_SCOPE` before any handler runs, and the denial is audited to the target project's chain (ccp/api/src/routes/requests.ts:197; ccp/api/src/middleware/authz.ts:54-69). Admin routes stack `requireSession, requireAdmin, requireProjectMembership` — admin capability alone is **not** cross-project (ccp/api/src/routes/admin.ts:110-112).

## 3. The L2→L3 approval ladder — implemented vs ADR-0013 design

Tier mapping (server truth, fail-closed): `l1_self_service` → `self_service`, `l1_with_guardrails` → `guardrails`, `engineer_only` → `engineer`, anything unknown → `engineer` (ccp/api/src/domain/exposure.ts:26-37).

| ADR-0013 / 0037 design point | Status in code | Evidence |
|---|---|---|
| `self_service` → ladder `[L2]` (one approver-or-lead) | **Implemented** | ccp/api/src/domain/exposure.ts:65-68 |
| `guardrails` / `engineer` → `[L2, L3]` | **Implemented** | ccp/api/src/domain/exposure.ts:65-68 |
| Any forces-replace op → `[L2, L3]` regardless of tier (replaces 0035's two-leads rule) | **Implemented** | ccp/api/src/domain/exposure.ts:65-67; live+pinned floor in ccp/api/src/domain/requirement.ts:44 |
| Strict order: L3 unsignable before L2 | **Implemented** — positional: the Nth signature fills `ladder[N-1]` (ccp/api/src/domain/exposure.ts:76-78; ccp/api/src/routes/requests.ts:564-571) |
| Per-step role: L2 = approver\|lead, L3 = lead; wrong role refused | **Implemented** — `WRONG_APPROVAL_LEVEL` (ccp/api/src/domain/eligibility.ts:16-18; ccp/api/src/routes/requests.ts:571) |
| Distinct people across the whole ladder | **Implemented** — `approvalKey` dedup (ccp/api/src/routes/requests.ts:561-562) |
| No solo approval / interim single-approver profile retired | **Implemented** — no interim branch remains at quorum-met (ccp/api/src/routes/requests.ts:594-599 comment); `interimProfileWillApply` is wire-compat but always `false` (ccp/api/src/domain/feasibility.ts:27, :42) |
| Tighten-only re-gate at approve time (bar can rise, never fall) | **Implemented** — `currentRequirement` recomputes the strictest of pinned+live tiers per item (ccp/api/src/domain/requirement.ts:37-48; applied at ccp/api/src/routes/requests.ts:556-557) |
| Engineer-tier first sign-off widens from lead-only to L2 | **Implemented** (ccp/api/src/domain/exposure.ts:14-17) |
| SPA shows ladder progress + offers Approve only to who can sign the next step | **Implemented in api-mode** (ccp/app/src/features/approvals/ApprovalsQueue.tsx:309-310; ccp/app/src/features/requests/RequestDetail.tsx:144) — display-only, never permission (ccp/app/src/lib/approvalLadder.ts:4-9) |
| Ladder in **mock/standalone mode** | **NOT implemented** — the mock keeps the legacy model; see §4 | ccp/app/src/lib/api.ts:600-659 |
| 2FA downgrade needs "an explicit **typed** confirmation" (ADR-0013 §4) | **Partially implemented** — a confirm dialog exists, but typed-name confirmation is only used for account **delete**, not the 2FA toggle | ccp/app/src/features/admin/UsersAdmin.tsx:64-68, :496, :637 (2FA confirm) vs :949-955 (typed delete confirm) |

The `nextApprovalStep` the SPA renders is server-computed on every ChangeRequest projection (ccp/api/src/routes/requests.ts:159-190) and used for the "pending for ME" queue filter — an approver stops seeing a `[L2,L3]` request once L2 is signed (ccp/api/src/routes/requests.ts:487-491).

## 4. Approval counts: what the server uses vs what the SPA mock uses

| Question | Server (api-mode, authoritative) | SPA mock (standalone mode) |
|---|---|---|
| How many approvals? | **Ladder length**: `approvalsRequired = ladderFor(tier, forcesReplace).length` — 1 for `self_service`, 2 for everything riskier or forces-replace (ccp/api/src/routes/requests.ts:308-309; ccp/api/src/domain/exposure.ts:85-87) | **Legacy risk-count policy**: `approvalsRequiredFor(op)` = policy[risk] with `deleteMin` floor for MACD Delete (ccp/app/src/lib/api.ts:488-492; ccp/app/src/lib/permissions.ts:7-9; ccp/app/src/lib/policy.ts:101-104). Defaults `{low:1, medium:1, high:2, deleteMin:2}`, clamped 1..5 (ccp/app/src/lib/policy.ts:24-26) |
| Role of `risk` | **Display-only** — "it no longer varies the count" (ccp/api/src/routes/requests.ts:317-318) | Drives the count (above) |
| Role of the stored approval policy | Still exists and is dual-controlled (`PUT /admin/policy`, ccp/api/src/routes/admin.ts:120-149; `PolicyItem` ccp/api/src/store/schema.ts:203-215), but submit reads it **only to stamp `policyVersion`** (ccp/api/src/routes/requests.ts:320) | The editable policy IS the count source (ccp/app/src/lib/policy.ts:5-8) |
| Per-step role on the 2nd approval | L3 = lead only (ccp/api/src/routes/requests.ts:571) | **None** — mock approve checks only approver-or-lead; two approvers can complete a 2-count request (ccp/app/src/lib/api.ts:607-609) |
| Approvable statuses | `AWAITING_CODE_REVIEW` **and** `NEEDS_ENGINEER` (ccp/api/src/routes/requests.ts:107, :541) | `AWAITING_CODE_REVIEW` only (ccp/app/src/lib/api.ts:616) |
| Tighten-only re-gate | Ladder re-derived from live manifests (ccp/api/src/routes/requests.ts:556-557) | `max(stored, current policy count)` (ccp/app/src/lib/api.ts:624-626) |
| Quorum feasibility | Server-computed: enough distinct project-bound, activated signers, plus ≥1 lead when the ladder has L3; **never gates submission** (ccp/api/src/domain/feasibility.ts:30-43, :18-20); snapshotted at submit (ccp/api/src/routes/requests.ts:314) + live at `GET /requests/:id/feasibility` (:512-530) | Local estimate from the localStorage directory; explicitly mock-only (ccp/app/src/lib/quorum.ts:13-18); api-mode uses server fields via ccp/app/src/lib/requestFeasibility.ts:1-17 |

Candidate-signer filter (server): role on **this project** is approver-or-lead, `status==='active'`, not the requester, `mustChangePassword===false`, and `totpDevicesOf(a).length > 0` (at least one authenticator device enrolled — multi-device, 2026-07-22, account & security; same truth value the legacy `totp !== undefined` check had for every pre-existing account, via the read shim) — ccp/api/src/domain/eligibility.ts:40-48.

## 5. `canRequest` team scoping

One pure function, two enforcement points. A requester may request only for services in their team's `serviceSlugs`; approvers and leads may request for any service (ccp/app/src/lib/permissions.ts:19-23). The server imports this exact function and enforces it per change-set item at submit — first failing item rejects the whole set with 403 `TEAM_SCOPE` (ccp/api/src/routes/requests.ts:5, :265-276). The requester's team is resolved **per project** through `toUser(account, projectId)` (ccp/api/src/auth/account.ts:72-80). Team membership is not a privilege dimension: an admin `setTeam` applies immediately, no dual-control (ccp/api/src/routes/admin.ts:428-432).

## 6. isAdmin: semantics and the three grant paths

Semantics: `isAdmin` gates the `/admin` surface only (ccp/api/src/middleware/authz.ts:37-42). It is never consulted by `canSignStep` (ccp/api/src/domain/eligibility.ts:12-14), grants no request/approve rights, but does grant the cancel/rewindow senior override (ccp/api/src/routes/requests.ts:854, :941). It is global, not per-project (ccp/api/src/routes/admin.ts:441), though acting on a project still requires membership (ccp/api/src/routes/admin.ts:112).

| Grant path | Mechanism | Guards | Evidence |
|---|---|---|---|
| Day-0 bootstrap | `scripts/bootstrap.ts` seeds exactly one account `putra`: `roles: {'*': {role:'lead', teamId:'platform'}}`, `isAdmin: true`, one-time password, `mustChangePassword: true`; refuses if any account exists | idempotent-refusal | ccp/api/scripts/bootstrap.ts:21-49 |
| In-app grant/revoke (UI → `PATCH /admin/accounts/:id {isAdmin}`) | Any `isAdmin` change classifies **loosening** → 202 `PendingConfigChange`; a second distinct active admin must ack within 72h | `SELF_ACK`; drift-guarded on `accountVersion` → 409 `STALE_PROPOSAL`; last-active-admin guard `LAST_LEAD_GUARD` | ccp/api/src/domain/dualControl.ts:62-64, :203, :234; ccp/api/src/routes/admin.ts:441-443, :465, :509-510 |
| CLI escape hatch (single-admin liveness gap) | `npx tsx scripts/grant-admin.ts --username <id> --pr <ref>` — run from a reviewed PR only; writes through the same store+audit path, flagged `interimProfile: true` | refuses if ≥2 active admins, target missing/already-admin/disabled/still on one-time password; bumps `sessionVersion` and kills live sessions | ccp/api/scripts/grant-admin.ts:74-95, :98-116 |

Related account guards: an admin can never delete their own account (`SELF_DELETE`), the last active admin, or the last active lead of any project (ccp/api/src/routes/admin.ts:568-584); the same last-lead coverage rule blocks role downgrades/revokes/disables (ccp/api/src/routes/admin.ts:448-459).

## 7. Per-account project/role scoping (implemented)

| Rule | Evidence |
|---|---|
| Role and team are per project (`roles` map); all authz reads go through `rolesOf`/`roleFor` | ccp/api/src/projects.ts:95-119 |
| A present-but-empty `roles` map = member of nothing (revoking the last binding never resurrects legacy fields) | ccp/api/src/projects.ts:96-100 |
| Admin PATCH is per-project **verbs** (`setRole`/`setTeam`/`revoke`, one per request), never a whole-map replacement; whole-map bodies are 422 | ccp/api/src/routes/admin.ts:53-82, :401-402 |
| `'*'` binding is bootstrap/migration-only — refused in enroll and every PATCH verb | ccp/api/src/routes/admin.ts:328, :407 |
| Raising role rank on a project (incl. new senior membership) = loosening → dual-control; lateral/downgrade applies immediately | ccp/api/src/routes/admin.ts:86, :419-427 |
| Enrolling into a project other than the acting one = cross-tenant grant → dual-control regardless of role | ccp/api/src/routes/admin.ts:351-353 |
| Signing eligibility is per-project: senior on project A grants nothing on project B | ccp/api/src/domain/eligibility.ts:33-37, :39-42 |
| `sessionVersion` bumps only when an account **newly** gains senior capacity anywhere, or on an isAdmin change (forces re-login through the TOTP gate) | ccp/api/src/routes/admin.ts:472-480 |

## 8. Effective 2FA rule

```
needsTotp(account) = account.totpRequired ?? (isSeniorAnywhere(account) || account.isAdmin === true)
```
(ccp/api/src/auth/totp.ts:67-71). "Senior anywhere" = approver/lead on **any** project (ccp/api/src/projects.ts:129-131) — an approver on one project cannot log into another and skip 2FA (ccp/api/src/auth/totp.ts:62-64).

| Fact | Evidence |
|---|---|
| Admin may pin `totpRequired` true or false for anyone — deliberately no server role floor; the downgrade warning is a UI safety net | ccp/api/src/store/schema.ts:126-134; ccp/api/src/routes/admin.ts:72-75 |
| A `totpRequired`-only change is 'tightening' → applies immediately, one audited mutation, in **either** direction (no second-admin gate) | ccp/api/src/routes/admin.ts:493-496 |
| Login enforces it: `needsTotp` true + not enrolled → pending `enroll`; **any account with at least one device enrolled is challenged regardless of `needsTotp`** (2026-07-22, [ADR-0024](../../docs/adr/0024-ccp-multi-device-totp.md) clause 4 — supersedes ADR-0013's "dormant secret" clause in part) → pending `totp` verify | ccp/api/src/routes/auth.ts:148-150 (`needsTotp(updated) \|\| devicesAtLogin.length > 0`) |
| Turning it off does not delete enrolled devices (flag-only write) — but an enrolled account keeps being challenged at login anyway, per the row above | ccp/api/src/routes/admin.ts:496 (only `set.totpRequired`) |
| **Enrollment-vs-flag mismatch:** whatever `totpRequired` says, the approve route hard-refuses any account with no enrolled authenticator — 403 `TOTP_ENROLLMENT_REQUIRED` | ccp/api/src/routes/requests.ts:544-550 |
| Same mismatch in feasibility: an un-enrolled senior is not a candidate signer (`totpDevicesOf(a).length > 0`, multi-device 2026-07-22) | ccp/api/src/domain/eligibility.ts:48 |
| Self-service last-factor guard protects the same floor: an account for which `needsTotp` is true cannot remove its own last device (403 `LAST_FACTOR`) — quorum can never be self-regressed below what `needsTotp` demands | ccp/api/src/routes/account.ts:179 |

Net effect: an admin can exempt a senior from the 2FA **login** step, but that account still cannot **approve** anything (and doesn't count toward quorum feasibility) until it enrolls an authenticator.

## 9. Drift telemetry: the two operator buttons + the legitimize front door (2026-07-20 drift-audit-fixes plan)

Three routes this program ADDED to `routes/drift.ts` (mounted in the registry group, same as the projects data plane). The pre-existing drift PUT/GET/submit role rules (WI-2/WI-6 — requester-tier presence, adopt any bound member, revert approver/lead) are not repeated here.

| Route | requester | approver | lead | isAdmin | Server enforcement |
|---|---|---|---|---|---|
| `POST /projects/:id/drift/security/:digest/legitimize` (C2) | ✘ | ✔ | ✔ | — | same tier as revert submit — it concerns live security posture (ccp/api/src/routes/drift.ts:759) |
| `POST /projects/:id/drift/check` (B1, "Start drift check") | ✘ | ✘ | ✔ | ✔ | `isLeadOrAdmin` — `roleFor===lead \|\| isAdmin===true`, the apply-route precedent (`routes/requests.ts` `POST /:id/apply`, PERMISSIONS.md §2's own "senior-only" apply row) — STRICTER than every other drift route: a plain approver cannot start a check (ccp/api/src/routes/drift.ts:896-897) |
| `POST /projects/:id/drift/generate` (B2, "Fix the drift" refresh) | ✘ | ✘ | ✔ | ✔ | same `isLeadOrAdmin` gate as the check button (ccp/api/src/routes/drift.ts:962-963) |

`DRIFT_CHECK_FORBIDDEN` / `DRIFT_GENERATE_FORBIDDEN` are inline 403 literals returned directly (`c.json({code, reason}, 403)`), the SAME pattern `APPLY_FORBIDDEN` (routes/requests.ts `POST /:id/apply`) and `DRIFT_DISARMED` already use — deliberately NOT added to `errors.ts`'s `ERRORS` taxonomy map, so `test/errors.test.ts`'s hand-pinned per-status code set (§2 above) is untouched. Legitimize's engineer-tier request rides the EXISTING `[L2,L3]` ladder + TOTP machinery (§3) — `system-drift-legitimize`'s `engineer_only` exposure maps through the same `reviewTierFor`/`ladderFor` this whole document already describes; no new approval code.

## 10. Self-service account & security operations (2026-07-22, account & security)

Every route below sits under `/auth`, requires a live **full** session (`requireSession`; `POST
/auth/totp/recovery` is the one exception — it runs on the pending pre-session, the same slot
`POST /auth/totp` upgrades), and acts **only** on `c.get('account')` — there is no id parameter
anywhere in this group, so one account can never reach another's devices, codes, or sessions.
None of these routes touch `totpRequired`, `isAdmin`, `status`, or any `roles` entry — those stay
admin-only (§6). "⚿" marks a route gated by the `requireReauth` middleware (403 `REAUTH_REQUIRED`
unless `session.reauthAt` is within `REAUTH_MS`, 10 minutes) — ccp/api/src/routes/account.ts:55-64.

| Route | Effect | Gate | Enforcement |
|---|---|---|---|
| `GET /auth/totp-devices` | List the caller's own devices (never `secretEnc`) | full session | ccp/api/src/routes/account.ts:74-83 |
| ⚿ `POST /auth/totp-devices` | Begin adding a device — mints a secret, holds it on the session item | full session + reauth; 422 `DEVICE_LIMIT` at 5 | ccp/api/src/routes/account.ts:89-101 |
| ⚿ `POST /auth/totp-devices/confirm` | Verify the held secret + name the device — first device also mints recovery codes | full session + reauth; 422 `DEVICE_LIMIT` re-checked | ccp/api/src/routes/account.ts:107-163 |
| ⚿ `DELETE /auth/totp-devices/:id` | Remove one of the caller's own devices | full session + reauth; 422 `LAST_FACTOR` while `needsTotp` | ccp/api/src/routes/account.ts:168-204 |
| `GET /auth/recovery-codes` | `{remaining, generatedAt}` — counts only, ever | full session | ccp/api/src/routes/account.ts:209-213 |
| ⚿ `POST /auth/recovery-codes/regenerate` | Replace the whole set; the 10 plaintext codes returned exactly once | full session + reauth; 401 `TOTP_REQUIRED` with no device enrolled | ccp/api/src/routes/account.ts:217-239 |
| `POST /auth/totp/recovery` | Burn one recovery code to clear the pending-TOTP pre-session (the door for "I lost every device") | pending pre-session only; 401 `TOTP_REQUIRED` on any failure, feeds lockout | ccp/api/src/routes/auth.ts:268-313 |
| `POST /auth/reauth` | Prove it's you again (password or a live device code) — stamps `session.reauthAt` | full session; failures feed the same lockout counter as a login guess | ccp/api/src/routes/auth.ts:394-445 |
| `POST /auth/change-password` | Rotate the caller's own password; `keepOtherSessions` (default false) controls whether other sessions survive | full session; current password re-verified (that check **is** the re-auth — no ⚿ on top) | ccp/api/src/routes/auth.ts:345-393 (pre-existing route; `keepOtherSessions` added 2026-07-22) |
| `GET /auth/sessions` | List the caller's own live sessions, with a `current` marker | full session | ccp/api/src/routes/account.ts:244-250 |
| ⚿ `DELETE /auth/sessions/:id` | Revoke one of the caller's own sessions (404 on any id not in their session index — no cross-user probing) | full session + reauth | ccp/api/src/routes/account.ts:256-269 |
| ⚿ `POST /auth/sessions/revoke-others` | Revoke every session but the caller's current one, without a `sessionVersion` bump (that would also kill the keeper) | full session + reauth | ccp/api/src/routes/account.ts:273-282 |

Every mutation in this group bumps `accountVersion`, so a self-change mid-flight stales an admin's
already-captured dual-control proposal to 409 `STALE_PROPOSAL` on ack, same drift-guard doctrine as
every other account write (§7 pattern) — ccp/api/src/store/schema.ts's `accountVersion` field.
Admin's own account-security actions are unchanged and unweakened by any of this: `reset-password`,
`reset-totp` (now clears **every** device and the recovery-code set, not just one secret),
`revoke-sessions` (`sessionVersion` bump — kills everything, including sessions a self-service
revoke-others deliberately kept), and the `totpRequired` pin — ccp/api/src/routes/admin.ts.

## Regenerate / verify

Run from the repo root. Each command re-checks one section; expect the quoted line(s) to appear.

```sh
# §1 primitives
grep -n "z.enum(\['requester', 'approver', 'lead'\])" ccp/api/src/store/schema.ts     # :17
grep -n "isAdmin: z.boolean()" ccp/api/src/store/schema.ts                            # :124
grep -n "totpRequired: z.boolean().optional()" ccp/api/src/store/schema.ts            # :134 (also :75 in routes/admin.ts)
grep -n "roles\[projectId\] ?? roles\[ALL_PROJECTS\]" ccp/api/src/projects.ts         # roleFor :118

# §2 matrix
grep -n "canRequest(toUser" ccp/api/src/routes/requests.ts                            # TEAM_SCOPE gate :270
grep -n "requireRole('approver', 'lead')" ccp/api/src/routes/requests.ts              # approve :533, reject :663
grep -n "requireRole('lead')" ccp/api/src/routes/requests.ts                          # link-pr :712, plan-summary :786
grep -n "SELF_APPROVAL\|ALREADY_APPROVED\|WRONG_APPROVAL_LEVEL" ccp/api/src/routes/requests.ts
grep -n "isAdmin !== true" ccp/api/src/middleware/authz.ts                            # requireAdmin :40
grep -n "requireSession, requireAdmin, requireProjectMembership" ccp/api/src/routes/admin.ts  # :112
grep -n "CANCEL_FORBIDDEN\|REWINDOW_FORBIDDEN" ccp/api/src/routes/requests.ts

# §3 ladder
grep -n "return step === 'L3' ? role === 'lead'" ccp/api/src/domain/eligibility.ts ccp/app/src/lib/approvalLadder.ts
grep -n "tier === 'self_service' ? \['L2'\] : \['L2', 'L3'\]" ccp/api/src/domain/exposure.ts   # :67
grep -n "if (forcesReplace) return \['L2', 'L3'\]" ccp/api/src/domain/exposure.ts     # :66
grep -n "canSignStep(next, roleFor" ccp/api/src/routes/requests.ts                    # :571
grep -n "interimProfileWillApply: false" ccp/api/src/domain/feasibility.ts            # :42

# §4 counts (server = ladder length; SPA mock = risk policy)
grep -n "const approvalsRequired = ladder.length" ccp/api/src/routes/requests.ts      # :309
grep -n "approvalsRequiredFor(op)" ccp/app/src/lib/api.ts                             # mock :489, :625
grep -n "DEFAULT_POLICY: ApprovalPolicy" ccp/app/src/lib/policy.ts                    # {low:1,medium:1,high:2,deleteMin:2} :24
grep -n "deleteMin" ccp/app/src/lib/policy.ts | head -5
grep -n "totp !== undefined" ccp/api/src/domain/eligibility.ts                        # signer must be enrolled :46

# §6 admin grant paths
grep -n "isAdmin: true, // bootstrap admin" ccp/api/scripts/bootstrap.ts              # :42
grep -n "activeAdmins.length >= 2" ccp/api/scripts/grant-admin.ts                     # CLI refusal :76
grep -n "case 'admin':" ccp/api/src/domain/dualControl.ts                             # grant/revoke = loosening :62
grep -n "SELF_ACK" ccp/api/src/domain/dualControl.ts                                  # :234

# §7 per-project scoping
grep -n "if (account.roles) return account.roles" ccp/api/src/projects.ts             # rolesOf :100
grep -n "ALL_PROJECTS) return apiError" ccp/api/src/routes/admin.ts                   # '*' refused :328, :407
grep -n "gainsSeniorCapacity" ccp/api/src/routes/admin.ts                             # sessionVersion rule :479

# §8 2FA
grep -n "account.totpRequired ?? (isSeniorAnywhere" ccp/api/src/auth/totp.ts          # needsTotp :70
grep -n "TOTP_ENROLLMENT_REQUIRED" ccp/api/src/routes/requests.ts                     # approve hard-refusal :549
grep -n "needsTotp(updated) || devicesAtLogin.length > 0" ccp/api/src/routes/auth.ts  # always-challenged widening :149

# §10 self-service account & security
grep -n "const requireReauth" ccp/api/src/routes/account.ts                           # :55
grep -n "r.use('\*', requireSession)" ccp/api/src/routes/account.ts                   # every route full-session-gated :69
grep -n "DEVICE_LIMIT\|LAST_FACTOR" ccp/api/src/routes/account.ts
grep -n "accountVersion: nextAccountVersion(account)" ccp/api/src/routes/account.ts   # every mutation bumps it
```

## Known tensions & caveats (extraction findings, 2026-07-17)

Found while deriving this doc from code at commit d781c25 — kept verbatim so nothing
is lost. Actionable ones are tracked separately; do not silently "fix" this doc to hide them.

- Task text said "measured at commit undefined" — the actual worktree HEAD is d781c25d828bd580dd2c426e6337b523cdb05511 on branch claude/docs-restructure-fundamentals-a929a5; the doc cites that hash. If the doc should pin a main-branch commit instead, update the intro line.
- ccp/app/src/lib/policy.ts:7-8 claims "a real ccp-api keeps the same shape" for the approval policy — misleading post-0037: the server keeps a PolicyItem and a dual-controlled PUT /admin/policy (ccp/api/src/routes/admin.ts:120-149) but submit uses it only to stamp policyVersion (ccp/api/src/routes/requests.ts:320); approval counts come from the ladder (requests.ts:309).
- ADR-0013 (docs/adr/0013-ccp-approval-ladder-2fa.md:33-34) requires "an explicit typed confirmation" for the privileged 2FA downgrade; the built UI shows a confirm dialog (ccp/app/src/features/admin/UsersAdmin.tsx:496, :637) but the typed-name pattern is implemented only for account delete (UsersAdmin.tsx:949-955) — implemented weaker than the ADR wording.
- SPA "Dashboard" (audit view) is gated on role==='lead' (ccp/app/src/components/AppShell.tsx:59, :65) while the server's audit read/export endpoints live under /admin behind isAdmin (ccp/api/src/routes/admin.ts:112, :669, :686) — a lead without isAdmin sees the nav item in the SPA but has no server audit endpoint to call in api-mode. Doc notes it in the matrix; may deserve a UI fix or an explicit lead-readable audit route.
- The SPA mock mode has not been migrated to the 0037 ladder: legacy risk-count approvals (ccp/app/src/lib/api.ts:488-492, :624-626), no per-step role check (api.ts:607-609), and NEEDS_ENGINEER requests are not approvable in the mock (api.ts:616) though they are on the server (ccp/api/src/routes/requests.ts:107). Documented in §4, but it is a live divergence, not just history.
- ccp/api/src/domain/feasibility.ts:19 still cites "ADR-0008 preserved" for never-gates-submission; per docs/proposals/0037 header note (line 1) ADR-0008 was superseded by ADR-0012 the same week. The never-gates behavior itself is real in code; only the ADR citation in the code comment is stale.
- ADR-0013 does not mention the enrollment-vs-flag interaction documented in §8: totpRequired:false exempts a senior from the 2FA login step (ccp/api/src/auth/totp.ts:70) but the approve route still hard-requires an enrolled authenticator (ccp/api/src/routes/requests.ts:544-550) and feasibility excludes un-enrolled seniors (ccp/api/src/domain/eligibility.ts:46) — intentional belt-and-braces per the code comment, but an operator exempting an approver from 2FA may not expect them to remain unable to approve.
- docs/adr/0011 line 48 and dualControl.ts's interimProfile machinery reference the interim single-approver profile; 0037 disabled its request-approval entry point but the audit-context heuristic (INTERIM_RETIREMENT_THRESHOLD=2, ccp/api/src/domain/dualControl.ts:94, :126-136) still flags senior grants made while <2 active seniors exist — that flag is audit metadata only, not an enforcement path; the doc omits it from the matrix for brevity.
- The "CI records plan summaries" row relies on a deployment provisioning a lead-role service identity for the CI poster (ccp/api/src/routes/requests.ts:776-780 comment points to a runbook for this — that runbook is deployment-specific and not shipped in this repo); I did not verify its existence or contents.
- Line numbers were read at this commit; any edit to the cited files shifts them. The Regenerate/verify greps are content-anchored so they survive small drifts.
