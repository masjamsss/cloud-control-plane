# Settings catalog — every admin-controllable setting and flag

Facts in this document are measured from the working tree at commit `d781c25` (2026-07-17, post-rename merge). Paths are the live post-rename paths (`ccp/app`, `ccp/api`). All `file:line` citations below are relative to the `ccp/` directory.

## Where settings live, and who may change them

The Cloud Control Plane keeps admin-controllable configuration in **two stores**:

| Store | Backing | Authority |
|---|---|---|
| **api store** | `SETTING#<key>` / `POLICY` / `RISKOVR#<opId>` items, project-scoped (`P#<projectId>#…` PK) | Authoritative — server request paths re-read these (api/src/store/schema.ts:587-598) |
| **app store** | Browser `localStorage`, project-scoped keys via `scopedKey(...)` (app/src/lib/settings.ts:103, app/src/lib/policy.ts:30, app/src/lib/riskOverrides.ts:16) | Advisory only. When a real ccp-api is connected, the SPA's local editors are disabled (`GateFieldset disabled={!authoritative}` — app/src/features/admin/SettingsAdmin.tsx:139) and the server view is loaded instead (SettingsAdmin.tsx:92-99) |

**Who can change anything below (server side):** an account with `isAdmin: true` — the entire `/admin/*` route group is mounted behind `requireSession, requireAdmin, requireProjectMembership` (api/src/routes/admin.ts:112). `requireAdmin` gates on `isAdmin`, never on `role === 'lead'` (api/src/middleware/authz.ts:36-42), and the admin must also be bound to the acting project (authz.ts:54-69). In the SPA, the whole admin area is behind `AdminGate`, which also checks `isAdmin` (app/src/components/guards.tsx:31-36).

**Dual-control envelope:** every privilege-affecting write is classified `tightening` (applies immediately, one admin) or `loosening` (creates a `PendingConfigChange` that a **second distinct admin** must ack — self-ack is refused with `SELF_ACK`, api/src/domain/dualControl.ts:234). Pending changes expire after **72 hours** (dualControl.ts:203, sweep at 326-337). A stale ack (target row changed since propose) is rejected `409 STALE_PROPOSAL` via a version drift guard (dualControl.ts:244-252). Every write — immediate or acked — lands in the per-project hash-chained audit log (`transactWithAudit`, dualControl.ts:187, 212).

**Note (data-birth, 2026-07-22):** no setting anywhere in this catalog controls whether a fresh
install ships an estate — a blank install shipping zero estates is unconditional application
behavior, not a flag ([ADR-0020](../../docs/adr/0020-ccp-data-birth-blank-install.md)).
Loading the bundled sample estate is a mock/standalone-default or an explicit "Load sample
data" click on the first-run screen — a client-side act, not an admin-controlled setting, and
it has no server-side counterpart in either store above.

## Project-scoped estate settings (api store — authoritative)

| Setting / key | What it does | Allowed values + default | Where it lives | Enforcement point | Guard rails |
|---|---|---|---|---|---|
| **Change freeze** — `freeze.global` | When on, no new change requests may be submitted in this project | `true` / `false`; default absent = not frozen (api/src/domain/config.ts:46-48) | `SETTING#freeze.global` (api store); route `PUT /admin/settings/freeze.global` (api/src/routes/admin.ts:161-195) | **Server-enforced**: submit rejects `GLOBAL_FREEZE` (api/src/routes/requests.ts:238); a freeze at quorum-met holds the request (`held_frozen`, requests.ts:608) | Freeze **ON** = tightening → immediate; freeze **OFF** = loosening → second admin ack (dualControl.ts:53-55, admin.ts:172). Audited as `setting-change` (admin.ts:191) |
| **Per-op disable** — `catalog.disabled-ops` | Operation ids an admin has switched off — hidden from the catalog and rejected at submit | `string[]` of operation ids; default `[]` (config.ts:50-52) | `SETTING#catalog.disabled-ops`; written via `PUT /admin/catalog/:opId` with body `{enabled: boolean}` (admin.ts:280-306) | **Server-enforced**: submit rejects `OP_DISABLED` per item (requests.ts:269) | Disable = tightening → immediate; **re-enable** = loosening → second admin ack (dualControl.ts:50-52). Audited as `catalog-toggle` (admin.ts:302). Unknown op id → `VALIDATION_FAILED` (admin.ts:287) |
| **Rate limits** — `rate.limits` | Per-requester submission throttle and open-request cap | `{submissionsPerHour, maxOpen}`; defaults `{submissionsPerHour: 50, maxOpen: 20}` (config.ts:55). SPA clamps to 1–500 and 1–100 respectively before writing (app/src/features/admin/settingsFlow.ts:209-213, app/src/lib/settings.ts:73-78) — **the server itself performs no range validation** (admin.ts:180 stores the value opaquely) | `SETTING#rate.limits`; `PUT /admin/settings/rate.limits`. Note the wire field is `maxOpen`; the SPA's local name is `maxOpenPerUser` (settingsFlow.ts:222-234) | **Server-enforced** on every submit: over either limit → `429 RATE_LIMITED` (requests.ts:294; api/src/middleware/rateLimit.ts:24-41). Open statuses that occupy a slot: `AWAITING_CODE_REVIEW`, `AWAITING_DEPLOY_APPROVAL`, `CHANGES_REQUESTED`, `NEEDS_ENGINEER`, `APPROVED_COOLING` (rateLimit.ts:22) | Always classified tightening → applies immediately, single admin (admin.ts:180). Audited as `setting-change` |
| **Allowlist restrictions** — `allowlist.restrictions` | Admin narrowing of which manifest-allowlisted values L1 may pick per param. Can only narrow, never widen beyond the Terraform (app/src/lib/settings.ts:349-354) | `string[]` of `<opId>::<param>::<permittedValue>` entries (settingsFlow.ts:44-74); default absent = no restriction | `SETTING#allowlist.restrictions`; `PUT /admin/settings/allowlist.restrictions` (admin.ts:178-179) | **Advisory at enforcement level.** This stored setting is read by **no server request path**: submit-time param validation enforces only the *manifest* allowlist (api/src/manifests.ts:75). The narrowing is applied in the SPA picker only (`narrowAllowlist`, settings.ts:349-354; settingsFlow.ts:93-107) | Widening (any new permitted entry, incl. clearing — written as the full base list) = loosening → second admin ack; narrowing = tightening → immediate (dualControl.ts:56-58, settingsFlow.ts:44-66) |
| **Approval policy tiers + delete floor** — `low` / `medium` / `high` / `deleteMin` | Approvals needed per risk tier, plus a minimum for any Delete regardless of tier | Each integer **1–5** (admin.ts:89-91; app/src/lib/policy.ts:25-26); default `{low: 1, medium: 1, high: 2, deleteMin: 2}` (policy.ts:24) | `POLICY` item, api store (`policyKey`, schema.ts:587-589); routes `GET/PUT /admin/policy` (admin.ts:115-149). SPA mirror: `scopedKey('policy')` in localStorage (policy.ts:30) | **Partially superseded.** The server's actual approval count and signer roles come from the fixed 0037 ladder — `self_service → [L2]`, everything riskier and every forces-replace → `[L2, L3]` (api/src/domain/exposure.ts:65-68, requests.ts:308-309). Server-side, risk is "display-only now (it no longer varies the count)" (requests.ts:317-319) and `loadPolicy` at submit is used only to pin `policyVersion` on the request (requests.ts:320). The policy numbers drive approval counts only in the SPA's local/mock mode (`approvalsRequiredFor`, app/src/lib/permissions.ts:7-9 → policy.ts:101-104) | Any tier or `deleteMin` **decrease** = loosening → second admin ack; increase/no-op = tightening → immediate (dualControl.ts:43-47). Out-of-range → `POLICY_OUT_OF_RANGE` (admin.ts:126). Versioned, drift-guarded, audited as `policy-change` (admin.ts:133-146) |
| **Per-op risk override** — `RISKOVR#<opId>` | Reclassifies one operation's risk as LOW / MEDIUM / HIGH, overriding the manifest `riskFloor` | `LOW` \| `MEDIUM` \| `HIGH` (admin.ts:37); default = the op's manifest `riskFloor` (config.ts:29-37) | `RISKOVR#<opId>` item, api store (schema.ts:593-595); routes `GET /admin/risk`, `PUT/DELETE /admin/risk/:opId` (admin.ts:204-277). SPA mirror: `scopedKey('risk-overrides')` (riskOverrides.ts:16) | Server reads it at submit via `resolveRisk` (requests.ts:319), but the resulting risk is **display/badge only** — it no longer changes the approval count (requests.ts:317-318); `riskOverrideVersion` is pinned on the request | Risk **reduction** = loosening → second admin ack; raise = tightening → immediate (dualControl.ts:48-49). DELETE (clear to floor) classifies against the floor (admin.ts:263-264). Audited as `risk-override` / `risk-override-clear` |

**Note on unknown keys:** `PUT /admin/settings/:key` accepts any key; anything that is not `freeze.global`, `catalog.disabled-ops`, or `allowlist*` defaults to tightening and is stored (admin.ts:180), but `GET /admin/settings` only returns the four known keys (admin.ts:155).

## Per-account flags and admin account actions (api store — global identity)

| Flag / action | What it does | Allowed values + default | Enforcement point | Guard rails |
|---|---|---|---|---|
| **`totpRequired`** (per-user 2FA requirement) | Pins whether this account must complete TOTP at login. `undefined` = role default: 2FA required iff senior anywhere (approver/lead on any project) or admin (api/src/auth/totp.ts:67-70). **`totpRequired` alone no longer decides whether an already-enrolled account is CHALLENGED** (2026-07-22, [ADR-0024](../../docs/adr/0024-ccp-multi-device-totp.md) clause 4, partially superseding [ADR-0013](../../docs/adr/0013-ccp-approval-ladder-2fa.md)'s dormant-secret clause): any account holding at least one device is challenged at every login regardless of this pin; the pin still fully controls whether an un-enrolled account is *forced* to enrol | `true` / `false` / absent; default absent (api/src/store/schema.ts:125-134) | **Server-enforced** at login by `needsTotp` (totp.ts:67-70) for the enrol-vs-skip decision; the challenge condition itself is `needsTotp(a) \|\| totpDevicesOf(a).length > 0` (routes/auth.ts:149) | Applied **immediately** + audited in either direction — deliberately no dual-control and no server role floor (admin.ts:72-75, 494-496; schema.ts:125-134). The SPA shows a warning-confirm before turning 2FA **off** for a privileged account (`TOTP_DOWNGRADE_WARNING`, app/src/features/admin/UsersAdmin.tsx:67, confirm state :496) — "this gate is UI-only" (UsersAdmin.tsx:632-635) |
| **`isAdmin`** | Grants the admin capability (all `/admin/*` routes). Orthogonal to role — never grants approval seniority (exposure.ts:61) | `true` / `false`; default `false` on enroll (admin.ts:342) | Server: `requireAdmin` on every admin route (authz.ts:36-42). SPA: `AdminGate` (guards.tsx:31-36) | Grant **or** revoke = loosening → second admin ack (dualControl.ts:62-64). Last-active-admin guard refuses stranding the estate (`LAST_LEAD_GUARD`, admin.ts:441-443). Newly-gained admin bumps `sessionVersion` to force the TOTP gate (admin.ts:477-480). SPA renders the Admin switch display-only: "Granted by two admins, not here" (UsersAdmin.tsx:73-74) |
| **`status`** (`active` / `disabled`) | Disables or re-enables an account | `active` \| `disabled`; default `active` on enroll (admin.ts:338) | Server-enforced on every request via session/account resolution | Disable = tightening → immediate; **re-enable** = loosening → second admin ack (dualControl.ts:75-77). Per-project last-active-lead guard and last-admin guard refuse coverage-stranding disables (admin.ts:441-459) |
| **Role verbs** (`setRole` / `setTeam` / `revoke`) | Per-project role grant/change/revoke — PATCH is verbs, never a whole-map replace (admin.ts:53-58) | roles `requester` \| `approver` \| `lead` (admin.ts:39); one verb per request (admin.ts:401-402); `'*'` project refused (admin.ts:404-409) | Server-enforced per request via `roleFor` (authz.ts:26-34) | Raising rank (incl. a new senior member) = loosening → second admin ack; lateral/downgrade/`setTeam`/`revoke` = tightening → immediate (admin.ts:84-86, 427). Last-lead-per-project guard (admin.ts:448-459). `accountVersion` drift guard on every apply (admin.ts:499-510) |
| **Account delete** (permanent) | Removes an account for good; Disable stays the reversible option | — | `DELETE /admin/accounts/:id` (admin.ts:558-595) | Fail-closed refusals: self-delete (`SELF_DELETE`, admin.ts:568), last active admin (:575), last active lead of any project (:584). Immediate + audited; all live sessions killed (:593) |
| **Password reset** | Sets a temporary password; target must change it at next login | min length `MIN_PASSWORD` (admin.ts:87) | `POST /admin/accounts/:id/reset-password` (admin.ts:597-635) | Resetting anyone senior-anywhere = loosening → second admin ack; pure requester = immediate (admin.ts:612). Kills live sessions (:616); drift-guarded (:623) |
| **TOTP reset** | Clears **every** enrolled authenticator device **and** the recovery-code set (2026-07-22, account & security — widened from the single legacy secret; unchanged in meaning, wider in effect); next login re-enrolls a fresh device and mints a fresh code set | — | `POST /admin/accounts/:id/reset-totp` (admin.ts:804-819) | Immediate + audited (availability recovery, not a privilege grant — admin.ts:813-818); kills live sessions; wins over anything the account did to itself via the self-service devices/codes routes below |
| **Session revocation** | Kills all of one account's live sessions | — | `POST /admin/accounts/:id/revoke-sessions` (admin.ts:822-839) | Immediate + audited (:834) |

## Per-account self-service (api store — self only, 2026-07-22, account & security)

Not admin settings — every row below is something the SIGNED-IN account does to **itself**
only (route detail + full enforcement table: [PERMISSIONS.md §10](PERMISSIONS.md#10-self-service-account--security-operations-2026-07-22-account--security)),
reached from the standing "Account & security" page (`/p/:projectId/account`, every role, not
under `/admin`). Listed here because they read/write the same account record the admin rows
above act on, and an admin action always wins over anything a person did to their own account
(reset-totp above clears everything self-service built).

| Setting / action | What it does | Allowed values + default | Enforcement point | Guard rails |
|---|---|---|---|---|
| **Authenticator devices** (`totpDevices[]`) | Named authenticator devices — add (QR-scan a fresh secret), name, remove. Any one device satisfies a login challenge | 0–5 devices (`MAX_TOTP_DEVICES`); each `{id, name (1-40 chars), enrolledAt, lastUsedAt?}` | `GET/POST /auth/totp-devices`, `POST /auth/totp-devices/confirm`, `DELETE /auth/totp-devices/:id` (api/src/routes/account.ts) | Add/remove re-auth-gated (⚿, `REAUTH_REQUIRED` within 10m); add refuses `DEVICE_LIMIT` at the cap; remove refuses `LAST_FACTOR` while `needsTotp` is true for the account — never lets a person strand their own required 2FA |
| **Recovery codes** (`recoveryCodes`) | 10 one-time codes; auto-issued the moment the account's first device is confirmed, regenerable any time after | 10 codes, sha256 at rest, shown in plaintext exactly once per (re)generation | `GET /auth/recovery-codes` (counts only), `POST /auth/recovery-codes/regenerate` (api/src/routes/account.ts) | Regenerate re-auth-gated (⚿); refused (`TOTP_REQUIRED`) with no device enrolled — codes exist only while 2FA is active; burned one-time via `POST /auth/totp/recovery` at the login screen (never a factor, never valid for re-auth) |
| **Own password** | Rotate the signed-in account's own password | min length `MIN_PASSWORD`; `keepOtherSessions` checkbox, default **unchecked** (other sessions signed out) | `POST /auth/change-password` (api/src/routes/auth.ts, pre-existing route; `keepOtherSessions` added 2026-07-22) | Current password re-verified — that check **is** the re-auth, no ⚿ on top. Wrong current password feeds the same lockout counter as a login guess |
| **Own sessions** | List the account's own live sessions (`current` marked); sign out one, or every session but the current one | — | `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others` (api/src/routes/account.ts) | Revoke re-auth-gated (⚿); a session id from another account's list 404s (no cross-user probing); revoke-others deliberately does NOT bump `sessionVersion` (that would also kill the keeper) — distinct from the admin's `revoke-sessions`, which does |
| **Re-authentication** (`session.reauthAt`) | Prove it's you again (password, or — once a device is enrolled — a live authenticator code) to open a 10-minute window for the ⚿ rows above | `REAUTH_MS` = 10 minutes | `POST /auth/reauth` (api/src/routes/auth.ts) | Stamps the CALLER's own session item only; failures feed the same lockout counter as a login guess; absent `reauthAt` fails closed (never-elevated reads as expired) |

## Global instance identity (api store — global, ADR-0023)

The instance's displayed name/tagline — GLOBAL like identity (the accounts partition), never
project-scoped (`SETTING#<key>` items above are always `P#<projectId>#…`-prefixed; instance
naming is not an estate concern). Not dual-controlled — a display string, not a privilege edge.

| Setting | What it does | Allowed values + default | Where it lives | Enforcement point | Guard rails |
|---|---|---|---|---|---|
| **Instance name/tagline** — `INSTANCE` item | The name + one-line tagline shown on the sign-in screen, the app header, and everywhere else the product names itself | `name`: trimmed, single-line, 1–64 chars, no control characters; `tagline`: same rules, 0–140 chars, optional. Absent item ⇒ both `null` — the SPA falls back to its baked `VITE_INSTANCE_NAME`/generic-default constant (ccp/app/src/brand.ts) | `INSTANCE` item, GLOBAL key (`instanceKey()`, api/src/store/schema.ts); routes `GET /instance` (unauthenticated) + `PUT /admin/instance` (api/src/routes/instance.ts) | **Server-enforced and served.** `GET /instance` is read by every chrome surface pre- and post-auth (login page, app shell, first-run) via the SPA's `lib/instanceIdentity.ts`; `auth/totp.ts#resolveTotpIssuer` reads the same item at TOTP enrollment time (issuer label) | **Immediate + audited, never dual-control** (a display string, not a privilege edge — ADR-0023 §4.2). Admin-only (`requireAdmin`), deliberately **not** gated by `requireProjectMembership` (global, not a project verb). Version-guarded (read-then-guarded-write); a lost race → `409 INSTANCE_STALE`. Audited as `instance-identity-change` on the control-plane's own chain (`CONTROL_SCOPE`/`@control`). Seeded at most once, during the installer's one `CCP_BOOTSTRAP=1` first boot, from `.env`'s `CCP_INSTANCE_NAME`/`CCP_INSTANCE_TAGLINE` — never overwrites an existing item |

## SPA-local advisory settings (app store only — no server surface)

These live only in the browser's project-scoped localStorage (`scopedKey('settings')`, app/src/lib/settings.ts:103). `GET /admin/settings` never returns them (settingsFlow.ts:17-19), and **no server request path reads them**. Against a connected api build the SPA renders their editors disabled with an explicit reason (SettingsAdmin.tsx:251-256, 270-280).

| Setting | What it does | Allowed values + default | Enforcement point | Guard rails |
|---|---|---|---|---|
| **Notification channels** — `notifications.channels` | Where approvals/status changes would be echoed beyond the in-app bell | `{id, kind: 'email' \| 'chat-webhook', target, events ⊆ ['submitted','approved','rejected','applied']}` (settings.ts:21-30); default `[]` (settings.ts:91) | **None** — "the server doesn't send messages to them" (SettingsAdmin.tsx:251-252) | Every add/remove records a local audit entry (settings.ts:373, 386). SPA validates email/URL shape (SettingsAdmin.tsx:311-315) |
| **Maintenance windows** — `maintenanceWindows` | Recurring "don't deploy here" windows, e.g. month-end close | `{id, label, cron (5-field), tz}` (settings.ts:34-39); default `[]` | **None** — "Advisory today — nothing currently blocks a submission against it; the render layer surfaces it" (settings.ts:32-33; SettingsAdmin.tsx:255-256). Not to be confused with a request's own apply *schedule window*, which IS server-validated at submit (`validateSchedule`, requests.ts:290-292) | Add/remove audited locally (settings.ts:404, 416) |
| **Session limits** — `limits.sessionAbsoluteHours`, `limits.sessionIdleMinutes` | Session lifetime guardrails | Bounds 1–24 h and 5–120 min; defaults 12 h and 30 min (settings.ts:73-85) | **Local-only.** ccp-api fixes session lifetimes as constants: `ABSOLUTE_MS` = 12 h, `IDLE_MS` = 30 min (api/src/auth/sessions.ts:9-10). Against a real backend the SPA deliberately hides these steppers ("authority theater", SettingsAdmin.tsx:509-512) | `clampLimits` guarantees the store can never hold an out-of-range value (settings.ts:195-206); `setLimits` records an audit entry (settings.ts:436) |
| **Local mirrors of server settings** | `changeFreeze`, `disabledOps`, `allowlistOverrides`, `limits.submissionsPerHour`, `limits.maxOpenPerUser` — same meanings as the server rows above | Defaults `false` / `[]` / `{}` / 50 / 20 (settings.ts:87-94) | Used only in mock/demo mode; when `can('settings')` is true the server truth is loaded and local editors are disabled (SettingsAdmin.tsx:83-99, 139) | Submit-time re-check of freeze/disabled-ops exists in the SPA too (settings.ts:237-238 comment), but the server copy is authoritative |

Legacy note: pre-rename localStorage keys (`gerbang.settings.v1`, `gerbang.policy.v1`, `gerbang.risk-overrides.v1`) are migrated once into the legacy-project-scoped keys and never written again (settings.ts:101-124, policy.ts:29-45, riskOverrides.ts:15-32).

## Reviewing and acking pending (dual-controlled) changes

| Surface | Detail |
|---|---|
| List | `GET /admin/config-changes` — PENDING items for the acting project (admin.ts:638-641) |
| Approve | `POST /admin/config-changes/:id/ack` — must be a **different** admin than the proposer (`SELF_ACK`, dualControl.ts:234); drift-guarded replay (dualControl.ts:244-252) |
| Reject | `POST /admin/config-changes/:id/reject` (admin.ts:657-665) |
| Expiry | 72 h from proposal → `EXPIRED` (dualControl.ts:203, 326-337) |
| SPA | Admin → "Pending changes" tab (app/src/features/admin/AdminLayout.tsx:15, PendingChanges.tsx) |

## Regenerate / verify

Run these from the `ccp/` directory. Each command re-checks one table against code; the quoted anchor must appear at (or very near) the cited line.

```sh
# Server setting keys that exist (Table: estate settings)
grep -n "freeze.global\|catalog.disabled-ops\|rate.limits\|allowlist.restrictions" api/src/routes/admin.ts
# expect the 4-key list at api/src/routes/admin.ts:155

# Defaults
grep -n "DEFAULT_POLICY: ApprovalPolicy" app/src/lib/policy.ts          # {low:1, medium:1, high:2, deleteMin:2} at :24
grep -n "MIN_APPROVALS\|MAX_APPROVALS" app/src/lib/policy.ts            # 1 and 5 at :25-26
grep -n "DEFAULT_RATE_LIMITS" api/src/domain/config.ts                  # {submissionsPerHour:50, maxOpen:20} at :55
grep -n "DEFAULT_LIMITS: Limits" -A 5 app/src/lib/settings.ts           # 12h/30m/50/20 at :80-85
grep -n "LIMITS_BOUNDS" -A 5 app/src/lib/settings.ts                    # [1,24] [5,120] [1,500] [1,100] at :73-78
grep -n "ABSOLUTE_MS\|IDLE_MS" api/src/auth/sessions.ts                 # fixed 12h / 30m at :9-10

# Server enforcement points
grep -n "GLOBAL_FREEZE\|OP_DISABLED\|RATE_LIMITED" api/src/routes/requests.ts   # :238, :269, :294
grep -n "held_frozen\|isFrozen" api/src/routes/requests.ts                       # freeze at quorum-met :608
grep -n "OPEN_STATUSES" api/src/middleware/rateLimit.ts                          # slot statuses at :22
grep -rn "allowlist" api/src/manifests.ts                                        # only the MANIFEST allowlist is validated (:75)
grep -rn "allowlist.restrictions" api/src --include='*.ts' | grep -v test        # confirm no reader outside routes/admin.ts

# Approval count source (ladder, not policy)
grep -n "ladderFor\|requiredApprovalsFor" api/src/domain/exposure.ts             # [L2] vs [L2,L3] at :65-68, :85-87
grep -n "display-only" api/src/routes/requests.ts                                # risk no longer varies the count (:317)

# Dual-control classification table
grep -n "case '" api/src/domain/dualControl.ts                                   # classify() branches :43-84
grep -n "72 \* 60 \* 60" api/src/domain/dualControl.ts                           # 72h expiry :203
grep -n "SELF_ACK" api/src/domain/dualControl.ts                                 # distinct-admin ack :234

# Account flags
grep -n "totpRequired" api/src/routes/admin.ts                                   # immediate, no dual-control :72-75, :496
grep -n "needsTotp" -A 3 api/src/auth/totp.ts                                    # effective 2FA rule :67-70
grep -n "TOTP_DOWNGRADE_WARNING" app/src/features/admin/UsersAdmin.tsx           # UI warning-confirm :67
grep -n "LAST_LEAD_GUARD\|SELF_DELETE" api/src/routes/admin.ts                   # guards :443, :459, :568, :575, :584

# Who can change
grep -n "requireAdmin" api/src/middleware/authz.ts api/src/routes/admin.ts       # isAdmin gate :37 / route mount :112
grep -n "AdminGate" -A 5 app/src/components/guards.tsx                           # SPA gate :31-36

# Per-account self-service (2026-07-22, account & security)
grep -n "MAX_TOTP_DEVICES" api/src/auth/totp.ts                                  # cap = 5
grep -n "DEVICE_LIMIT\|LAST_FACTOR" api/src/routes/account.ts                    # add-cap / last-factor refusals
grep -n "RECOVERY_CODE_COUNT\|RECOVERY_CODE_LENGTH" api/src/auth/recovery.ts     # 10 codes x 16 chars = 80 bits
grep -n "REAUTH_MS" api/src/auth/sessions.ts                                     # 10-minute elevation window
grep -n "reset-totp" -A 15 api/src/routes/admin.ts | grep -n "recoveryCodes\|totpDevices" # admin reset clears both

# Local-only settings (no server surface)
grep -n "NOTIFICATIONS_OFF_REASON\|MAINTENANCE_OFF_REASON" app/src/features/admin/SettingsAdmin.tsx  # :251-256
grep -n "recordAudit" app/src/lib/settings.ts                                    # local audits :373, :386, :404, :416, :436

# Global instance identity (ADR-0023)
grep -n "instanceKey" api/src/store/schema.ts                                    # GLOBAL key, sibling to settlementKey
grep -n "requireAdmin" api/src/routes/instance.ts                                # admin-gated PUT, no requireProjectMembership
grep -n "instance-identity-change" api/src/routes/instance.ts                    # audit action kind
grep -n "resolveTotpIssuer" api/src/auth/totp.ts                                 # TOTP issuer reads the same item
```

## Known tensions & caveats (extraction findings, 2026-07-17)

Found while deriving this doc from code at commit d781c25 — kept verbatim so nothing
is lost. Actionable ones are tracked separately; do not silently "fix" this doc to hide them.

- The task said to state facts were measured 'at commit undefined' — that read as an unfilled template variable, so the doc cites the actual worktree HEAD, d781c25 (2026-07-17).
- allowlist.restrictions is stored and dual-controlled server-side (ccp/api/src/routes/admin.ts:155,178-179) but read by NO server request path — submit-time param validation enforces only the manifest allowlist (ccp/api/src/manifests.ts:75). The doc states this explicitly; if server enforcement was intended, it is a gap.
- PUT /admin/settings/rate.limits performs no server-side range or shape validation — any JSON value is stored and always classified tightening (ccp/api/src/routes/admin.ts:167,180). The 1–500 / 1–100 bounds exist only in the SPA (ccp/app/src/features/admin/settingsFlow.ts:209-213). A malformed stored value falls back to defaults on read (ccp/api/src/domain/config.ts:57-60), but a huge valid number would be enforced as-is.
- Approval policy tiers/deleteMin contradiction: app-side policy.ts:5-10 says approvalsFor/permissions read the policy, but the server's approval count comes exclusively from the fixed 0037 ladder (ccp/api/src/domain/exposure.ts:65-68; ccp/api/src/routes/requests.ts:308-309) and requests.ts:317-318 says risk is display-only. The policy numbers change counts only in SPA local/mock mode (ccp/app/src/lib/permissions.ts:7-9). The server still stores, dual-controls, and version-pins the policy (requests.ts:320), so the admin screen is not dead — but its tier numbers do not govern server approvals.
- Stale code comment: ccp/app/src/lib/policy.ts:10 asserts 'Invariant from the concept: nothing auto-applies' while the api schema documents the 0038 scheduled dry-run auto-apply pin (ccp/api/src/store/schema.ts:330-345). Matches the known unreconciled auto-apply direction; the doc sidesteps the invariant claim.
- PUT /admin/settings/:key accepts arbitrary keys (stored, classified tightening — admin.ts:180) while GET /admin/settings returns only the four known keys (admin.ts:155), so a typo'd key writes an invisible orphan setting.
- Wire-name mismatch documented but easy to trip on: the server rate-limit field is maxOpen (ccp/api/src/domain/config.ts:54) while the SPA calls it maxOpenPerUser (settingsFlow.ts:222-234).
- Teams CRUD and the projects registry/trust flow are admin-controllable but are directory/registry management rather than settings; the doc mentions teams guards only in passing (TEAM_NOT_EMPTY — admin.ts:789) and leaves projects to a separate doc.
- Line numbers were read from the docs-restructure worktree at d781c25; if the canonize sweep rewrites these files before this doc merges, citations need re-verification via the Regenerate/verify section.
