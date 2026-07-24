# Error states

The error taxonomy of the Cloud Control Plane: every error code the API can return, every refusal code `catalogctl onboard` can print, and every terminal request state the SPA can show. Facts measured at commit `3a77618` (2026-07-17, post-rename merge); all paths are the current post-rename paths.

## How errors reach the user

Server side, the taxonomy in `ccp/api/src/errors.ts:10-71` is declared "the ONLY error surface. Every 4xx body is `{code, reason, details?}`" (ccp/api/src/errors.ts:5). Routes and middleware either return `apiError(c, CODE, details?)` directly (ccp/api/src/errors.ts:102-110) or throw `new ApiError(CODE)` from domain code (ccp/api/src/errors.ts:78-86), which the app-wide handler registered in ccp/api/src/index.ts:28 converts to the same body; anything else becomes `{code: 'INTERNAL', reason: 'Internal error.'}` at 500, "outside the taxonomy by design — reserved for bugs" (ccp/api/src/errors.ts:116-121). Every 429 carries a `Retry-After` header derived from `details.retryAfter` seconds, else `details.until` ISO, else 60s (ccp/api/src/errors.ts:88-105). Client side, the SPA's HTTP client parses any non-ok body with `readError` — falling back to `{code: 'INTERNAL', reason: 'Something went wrong. Please try again.'}` if the body is unparseable (ccp/app/src/lib/httpApi.ts:562-567) — and surfaces the server's `reason` string verbatim as `MutationResult.ok:false` (ccp/app/src/lib/api.ts:103-105) or, for submits, buckets the code into the narrow `SubmitResult` set (ccp/app/src/lib/api.ts:120-122, ccp/app/src/lib/httpApi.ts:519-529). Reads throw `Error(reason)` instead (ccp/app/src/lib/httpApi.ts:572). The in-memory mock client never sets `code` on `MutationResult` — "its rejections have no server taxonomy behind them" (ccp/app/src/lib/api.ts:99-101).

## API error codes (`ccp-api` taxonomy, `ccp/api/src/errors.ts`)

`reason` strings are verbatim from code. "Thrown where" lists non-test emission sites (representative sites where there are many).

### 401

| Code | HTTP | `reason` | Thrown where |
|---|---|---|---|
| `NO_SESSION` | 401 | You are not signed in. | Defined ccp/api/src/errors.ts:12; via `failCode` fallback in ccp/api/src/middleware/session.ts:16-28,85, ccp/api/src/middleware/authz.ts:14, ccp/api/src/routes/auth.ts:210,225 |
| `SESSION_EXPIRED` | 401 | Your session has expired. Please sign in again. | errors.ts:13; `failCode('expired'\|'idle')` ccp/api/src/middleware/session.ts:18-20 |
| `SESSION_INVALIDATED` | 401 | Your session is no longer valid. Please sign in again. | errors.ts:14; `failCode('version')` ccp/api/src/middleware/session.ts:21-22 |
| `BAD_CREDENTIALS` | 401 | Wrong username or password. | errors.ts:15; ccp/api/src/routes/auth.ts:107 (login failure, generic — no enumeration), auth.ts:233 (change-password wrong current) |
| `TOTP_REQUIRED` | 401 | A verification code is required. | errors.ts:16; ccp/api/src/routes/auth.ts:159,162,179,182 (TOTP verify/enroll), plus `failCode('totp')` ccp/api/src/middleware/session.ts:23-24. Reused verbatim (2026-07-22, account & security) on three more doors: `POST /auth/totp/recovery` (a wrong/used/unknown recovery code — never a distinct code, so a guesser learns nothing, auth.ts:275,291), `POST /auth/recovery-codes/regenerate` (no device enrolled — codes exist only while 2FA is active, routes/account.ts:221), and a failed `POST /auth/reauth` by code (auth.ts:428 — a failed reauth by password instead returns `BAD_CREDENTIALS`; both feed the same lockout counter as a login guess) |
| `UPLOAD_TOKEN_INVALID` | 401 | The upload token is missing, wrong, expired, or revoked. | errors.ts (2026-07-17, data plane); ccp/api/src/routes/projectData.ts `PUT /projects/:id/data` — one generic refusal for unknown/expired/revoked/wrong-project/wrong-secret (no enumeration) |
| `ONBOARD_TOKEN_INVALID` | 401 | The onboarding token is missing, wrong, expired, or revoked. | errors.ts (2026-07-24, easy-first-import Phase 1); ccp/api/src/routes/projects.ts — the Bearer lane on `PUT /projects/:id/trust-request`. A SEPARATE code from `UPLOAD_TOKEN_INVALID` (a separate credential/key-namespace, I10) — same one-generic-refusal-no-enumeration posture, folding unknown/expired/revoked/wrong-project/wrong-secret into one code |

### 403

| Code | HTTP | `reason` | Thrown where |
|---|---|---|---|
| `FORBIDDEN_ROLE` | 403 | Only approvers and leads can do that. | errors.ts:19; ccp/api/src/middleware/authz.ts:31, ccp/api/src/routes/requests.ts:469 |
| `NOT_ADMIN` | 403 | Admin capability is required for that. | errors.ts:20; ccp/api/src/middleware/authz.ts:40 |
| `SELF_APPROVAL` | 403 | You cannot approve your own request. | errors.ts:21; ccp/api/src/routes/requests.ts:542,676 |
| `SELF_ACK` | 403 | You cannot acknowledge your own proposal. | errors.ts:22; ccp/api/src/domain/dualControl.ts:234 |
| `SELF_DELETE` | 403 | You cannot delete your own account. Ask another admin to do it. | errors.ts:23; ccp/api/src/routes/admin.ts:568 |
| `TEAM_SCOPE` | 403 | You can only request changes for your team's services. | errors.ts:24; ccp/api/src/routes/requests.ts:270 |
| `PROJECT_SCOPE` | 403 | Your account is not authorized for this project. | errors.ts:25; ccp/api/src/middleware/authz.ts:66 |
| `CONTROL_SCOPE` | 403 | This action needs an onboarded account's scope. | errors.ts (2026-07-22, data-birth); ccp/api/src/routes/requests.ts — the reserved `@control` scope ([ADR-0021](../../docs/adr/0021-ccp-control-scope-and-settlement.md)) is not an estate: request submission/approval and catalog/inventory reads refuse it. Distinct from `PROJECT_SCOPE` — the caller **is** bound (typically via `'*'`), the scope itself just has no data plane to act on |
| `ENGINEER_REVIEW_REQUIRED` | 403 | This change needs an engineer-tier review; only a Lead can approve it. | errors.ts:26; **defined but never emitted** (no non-test usage under ccp/api/src) |
| `WRONG_APPROVAL_LEVEL` | 403 | The next approval on this change needs a different approver level — the final sign-off must come from a lead. | errors.ts:27; ccp/api/src/routes/requests.ts:571 |
| `PASSWORD_CHANGE_REQUIRED` | 403 | You must change your password before continuing. | errors.ts:28; ccp/api/src/middleware/session.ts:102 |
| `MISSING_CLIENT_HEADER` | 403 | Missing or invalid client header. | errors.ts:29; ccp/api/src/middleware/session.ts:60 (`x-ccp-client` ≠ `ccp-spa`, session.ts:12-13) |
| `REAUTH_REQUIRED` | 403 | Please confirm it is you before continuing. | errors.ts:42 (2026-07-22, account & security); the `requireReauth` middleware, ccp/api/src/routes/account.ts:55-64 — guards every ⚿ self-service route (add/confirm/remove a device, regenerate recovery codes, revoke a session/other sessions) when `session.reauthAt` is absent or older than `REAUTH_MS` (10 minutes) |

### 409

| Code | HTTP | `reason` | Thrown where |
|---|---|---|---|
| `ALREADY_APPROVED` | 409 | You have already approved this request. | errors.ts:32; ccp/api/src/routes/requests.ts:562,652 |
| `STATE_CONFLICT` | 409 | This request is not in a state that allows that. | errors.ts:33; 14 sites in ccp/api/src/routes/requests.ts (e.g. 541,675,732,796,851,896,932-937,1003), ccp/api/src/routes/projects.ts:267,335,394, ccp/api/src/domain/dualControl.ts:232-236,312-313 |
| `STALE_PROPOSAL` | 409 | The target changed since this proposal was made. | errors.ts:34; ccp/api/src/domain/dualControl.ts:246,248,251,291,293 |
| `CHAIN_CONTENTION` | 409 | The audit chain is busy; please retry. | errors.ts:35; ccp/api/src/domain/audit.ts:193,199,227,232, domain/cooling.ts:77, domain/dualControl.ts:296,301, domain/schedule.ts:322, domain/apply/scheduler.ts:372,377, routes/requests.ts:451,456,654,659,899,904,1006,1011 |
| `DUPLICATE_USERNAME` | 409 | That username is already taken. | errors.ts:36; ccp/api/src/routes/admin.ts:323 |
| `DUPLICATE_TEAM` | 409 | That team name is already taken. | errors.ts:37; ccp/api/src/routes/admin.ts:710,742 |
| `TEAM_NOT_EMPTY` | 409 | Move this team's members and services before deleting it. | errors.ts:38; ccp/api/src/routes/admin.ts:789 |
| `BACKEND_NOT_EMPTY` | 409 | The backend already holds data. | errors.ts:39; ccp/api/src/routes/migrate.ts:60 |
| `DUPLICATE_PROJECT` | 409 | That project id is already registered. | errors.ts:40; ccp/api/src/routes/projects.ts:227 |

### 422

| Code | HTTP | `reason` | Thrown where |
|---|---|---|---|
| `VALIDATION_FAILED` | 422 | The request could not be validated. | errors.ts:43; 47 sites across every route file (e.g. routes/auth.ts:67, routes/admin.ts, routes/projects.ts, routes/requests.ts) plus ccp/api/src/middleware/session.ts:75 (unknown `x-ccp-project` header, `details: {field}`) and via `ParamCheck` ccp/api/src/manifests.ts:55 |
| `REPLACE_CONFIRMATION_REQUIRED` | 422 | This change destroys and recreates the resource. Type the resource name to confirm before submitting. | errors.ts:46-49; ccp/api/src/routes/requests.ts:275 |
| `OP_DISABLED` | 422 | That operation is currently disabled. | errors.ts:50; ccp/api/src/routes/requests.ts:269 |
| `PARAM_OUT_OF_BOUNDS` | 422 | A parameter is outside its allowed bounds. | errors.ts:51; via `ParamCheck` ccp/api/src/manifests.ts:59 → ccp/api/src/routes/requests.ts:272 |
| `LAST_LEAD_GUARD` | 422 | That would remove the last active Lead/admin. | errors.ts:52; ccp/api/src/routes/admin.ts:443,459,575,584 |
| `POLICY_OUT_OF_RANGE` | 422 | Policy values must be between 1 and 5. | errors.ts:53; ccp/api/src/routes/admin.ts:126 |
| `SCHEDULE_INVALID` | 422 | The schedule is not a valid maintenance window. | errors.ts:55; via `validateSchedule` ccp/api/src/domain/schedule.ts:76,85 → routes/requests.ts:291,956; directly at routes/requests.ts:961 (cooling-off would outlast the window) |
| `SCHEDULE_TOO_SOON` | 422 | The maintenance window must start at least 30 minutes from now. | errors.ts:56; ccp/api/src/domain/schedule.ts:78 → routes/requests.ts:291,956 |
| `SCHEDULE_TOO_FAR` | 422 | The maintenance window may not be more than 90 days out. | errors.ts:57; ccp/api/src/domain/schedule.ts:79 → routes/requests.ts:291,956 |
| `SCHEDULE_STALE_APPROVAL` | 422 | This approval is too old to re-window; reject and resubmit, or get a fresh approval first. | errors.ts:59; ccp/api/src/routes/requests.ts:952 |
| `PRESCAN_SHA_MISMATCH` | 422 | The uploaded prescan report does not hash to the trust request’s prescanSha256. | errors.ts:61; ccp/api/src/routes/projects.ts:274,345 |
| `TRUST_VERDICT_NOT_CLEAN` | 422 | The prescan verdict is not clean — a rejected repo can never be trusted. | errors.ts:62; ccp/api/src/routes/projects.ts:349 |
| `DATA_DIGEST_MISMATCH` | 422 | The uploaded data does not hash to the digests it claims. Nothing was stored. | errors.ts (2026-07-17, data plane); ccp/api/src/routes/projectData.ts `PUT /projects/:id/data` — sha256 over the canonical JSON of each bundle part, recomputed server-side |
| `LAST_FACTOR` | 422 | That is your last authenticator device and 2FA is required for your account — add another before removing it. | errors.ts:82 (2026-07-22, account & security); ccp/api/src/routes/account.ts:179 — `DELETE /auth/totp-devices/:id` refuses when removing would leave zero devices while `needsTotp(account)` is true |
| `DEVICE_LIMIT` | 422 | You already have 5 authenticator devices — remove one before adding another. | errors.ts:84 (2026-07-22, account & security); ccp/api/src/routes/account.ts:93,121 — both the begin-add and confirm-add steps refuse past `MAX_TOTP_DEVICES` (5), so a device can never be added between the two checks |

### 413

| Code | HTTP | `reason` | Thrown where |
|---|---|---|---|
| `UPLOAD_TOO_LARGE` | 413 | The uploaded data bundle is too large. | errors.ts (2026-07-17, data plane); ccp/api/src/routes/projectData.ts `PUT /projects/:id/data` — explicit 16 MiB cap, checked against Content-Length before the body is read and against the real byte length before parsing |

### 423 / 429

| Code | HTTP | `reason` | Thrown where |
|---|---|---|---|
| `ACCOUNT_LOCKED` | 423 | This account is locked. Try again later. | errors.ts:65; **defined but never emitted** — the lockout path emits `LOGIN_BACKOFF` instead (ccp/api/src/routes/auth.ts:75-77) |
| `GLOBAL_FREEZE` | 423 | Changes are frozen right now. | errors.ts:66; ccp/api/src/routes/requests.ts:238 |
| `RATE_LIMITED` | 429 | Too many requests. Please slow down. | errors.ts:69; ccp/api/src/routes/requests.ts:294 (submit token bucket, ccp/api/src/middleware/rateLimit.ts:24) |
| `LOGIN_BACKOFF` | 429 | Too many attempts. Try again later. | errors.ts:70; ccp/api/src/routes/auth.ts:76 (`details: {until}`) |

### Emitted-but-undefined literals (bypass the `ERRORS` map)

These are returned as inline `c.json({code, reason}, status)` literals — the same body shape, but NOT members of the `ErrorCode` union (ccp/api/src/errors.ts:73), contradicting the "ONLY error surface" claim at errors.ts:5.

| Literal code | HTTP | `reason` | Emitted where |
|---|---|---|---|
| `NOT_FOUND` | 404 | No such request. / No such project. / No such account. / No such team. | ccp/api/src/routes/requests.ts:502,517,539,672,731,795,842,923; routes/projects.ts:262,334,393,422; routes/admin.ts:380,565,606,741,761,783,805,829 |
| `TOTP_ENROLLMENT_REQUIRED` | 403 | Approval requires an enrolled authenticator on your account. | ccp/api/src/routes/requests.ts:549 |
| `CANCEL_FORBIDDEN` | 403 | Only the requester or a Lead/admin may cancel this request. | ccp/api/src/routes/requests.ts:856 |
| `REWINDOW_FORBIDDEN` | 403 | Only the requester or a Lead/admin may re-window this request. | ccp/api/src/routes/requests.ts:943 |
| `INTERNAL` | 500 | Internal error. | ccp/api/src/errors.ts:119 (unhandled-exception fallback; "outside the taxonomy by design") |

### Header transcription claim vs the spec

errors.ts:6 claims "Statuses and codes are transcribed verbatim from `ccp/docs/specs/ccp-api.md`". Fourteen taxonomy codes do NOT appear in that spec: `DUPLICATE_TEAM`, `ENGINEER_REVIEW_REQUIRED`, `WRONG_APPROVAL_LEVEL`, `SELF_DELETE`, `PROJECT_SCOPE`, `REPLACE_CONFIRMATION_REQUIRED`, `SCHEDULE_INVALID`, `SCHEDULE_TOO_SOON`, `SCHEDULE_TOO_FAR`, `SCHEDULE_STALE_APPROVAL`, `CONTROL_SCOPE` (added 2026-07-22, data-birth), `REAUTH_REQUIRED`, `LAST_FACTOR`, `DEVICE_LIMIT` (added 2026-07-22, account & security) (grep of ccp/docs/specs/ccp-api.md returns 0 hits for each). None of the five inline literals above are in the spec either. Only `BAD_CREDENTIALS.reason` is pinned by the spec (errors.ts:8).

## Onboarding reject codes (`catalogctl onboard`)

`Run` returns a process exit code: "0 ok · 2 refusal · 3 terraform/schema error · 1 internal" (tools/catalogctl/internal/onboard/onboard.go:71-72). Every refusal prints `REFUSE <code>: <reason>` and exits 2 (onboard.go:212-215). CLI usage errors (missing path or `--project-id`) exit 3 (onboard.go:496-509).

| Code | Trigger | Where enforced |
|---|---|---|
| `PRESCAN_REJECT` | prescan verdict is `reject` (any finding); findings printed and persisted to `prescan-report.json`; no runner call ever happens | tools/catalogctl/internal/onboard/onboard.go:101-109 |
| `UNTRUSTED_COMMIT` | `--trusted-commit` does not match repo HEAD; re-ack required; no runner call | onboard.go:125-128 |
| `TERRAFORM_MISSING` | `terraform version -json` fails or reports no version | onboard.go:131-134 (via onboard.go:360-377) |
| `VERSION_UNPARSEABLE` | repo `required_version` constraint has an unsupported operator | onboard.go:137-140 (via onboard.go:246-290) |
| `VERSION_UNSATISFIED` | installed terraform does not satisfy the repo's `required_version` — refused before invoking terraform | onboard.go:141-144 |
| `EMPTY_INVENTORY` | prescan counted ≥1 resource block but the independent extraction produced 0 — "refusing a silent-empty import" | onboard.go:169-172 |

Prescan finding codes (any one ⇒ verdict `reject` ⇒ `PRESCAN_REJECT`; constants at tools/catalogctl/internal/prescan/prescan.go:44-48, verdict flip at prescan.go:178). Triggers per ccp/docs/onboarding-security.md:57-63 (contract-test-guarded — do not edit):

| Finding code | Rejected construct | Enforced at |
|---|---|---|
| `DATA_EXTERNAL` | any `data "external"` block | prescan.go:194 |
| `PROVISIONER` | any `provisioner` block, nested anywhere, incl. `dynamic "provisioner"` | prescan.go:202,215,218 |
| `PROVIDER_SOURCE` | `required_providers` source outside the allowlist (default `registry.terraform.io/hashicorp/*`) | prescan.go:274 |
| `MODULE_SOURCE` | module source neither a relative path nor an allowlisted registry namespace | prescan.go:299 |
| `NONSTATIC_SOURCE` | provider/module `source` that is not a static string literal | prescan.go:265,270,290,295 |

Related but distinct: `FMT_DIRTY` is a `catalogctl edit` refusal, not an onboard code — onboard only reports the fmt-dirty count with remediation (onboard.go:206-208, ccp/docs/onboarding-security.md:97). The host-side runner also fails closed (an error, not a REFUSE code) if any `AWS_*`, `GOOGLE_*`, `ARM_*`, or `TF_TOKEN_*` env var is present (onboard.go:540-553), and always runs `terraform init -backend=false -input=false` (onboard.go:522). The API-side counterparts of the trust artifacts are `PRESCAN_SHA_MISMATCH` and `TRUST_VERDICT_NOT_CLEAN` in the 422 table above.

## SPA request-lifecycle terminal states

The full `RequestStatus` union is ccp/app/src/types/request.ts:4-46. The user sees each status as a badge chip — dot + label, tone-colored — from `STATUS_SPEC` (ccp/app/src/components/ui/StatusBadge.tsx:17-51). States a request can END in (no further server transition, per the route guards: only `AWAITING_CODE_REVIEW`/`NEEDS_ENGINEER` are approvable — ccp/api/src/routes/requests.ts:107 — and only `APPROVED_COOLING`/`AWAITING_DEPLOY_APPROVAL`/`WINDOW_EXPIRED` are cancellable — requests.ts:116):

| Status | Badge label | Tone | What it means for the user |
|---|---|---|---|
| `APPLIED` | Applied | done | Change fully approved and applied (StatusBadge.tsx:29) |
| `NOOP` | No change | done | Applied with no change (StatusBadge.tsx:30) |
| `APPLY_FAILED` | Apply failed | fail | Apply ran and failed (StatusBadge.tsx:31) |
| `DIGEST_MISMATCH` | Digest mismatch | fail | Approved-plan ≠ applied-plan digest guard tripped (StatusBadge.tsx:32) |
| `REJECTED` | Rejected | fail | An approver refused it (StatusBadge.tsx:33); no PR may be linked afterwards (requests.ts:124) |
| `WITHDRAWN` | Withdrawn | idle | Requester withdrew it (StatusBadge.tsx:35) |
| `CANCELLED` | Cancelled | idle | Deliberate stop by requester or Lead/admin during cooling-off or around a window; api-mode only (types/request.ts:33-35, StatusBadge.tsx:40-42) |
| `WINDOW_EXPIRED` | Window expired | fail | **Parked, not terminal**: maintenance window closed unapplied; needs a human to `rewindow` or `cancel` (types/request.ts:36-46, StatusBadge.tsx:43-50); api-mode only — the mock never produces it (ccp/app/src/lib/api.ts:644-657) |

The `NEEDS_ENGINEER` path is a handoff, not an error: a submit whose exposure is `engineer_only` (or whose change-set combined tier is `engineer`) is stored as `NEEDS_ENGINEER` with the event "Routed to an engineer to author and review the Terraform" (ccp/app/src/lib/api.ts:466-484, 538-539, 589-591), badge "Needs engineer", tone flight (StatusBadge.tsx:34). It stays approvable (`OPEN_STATUSES`, ccp/api/src/routes/requests.ts:107); api-mode approval additionally requires an enrolled authenticator (`TOTP_ENROLLMENT_REQUIRED`, requests.ts:549) and lead-level final sign-off (`WRONG_APPROVAL_LEVEL`, requests.ts:571).

Submit rejections reach the user as one of four `SubmitResult` buckets with the server's `reason` inline (ccp/app/src/lib/api.ts:113-122): `GLOBAL_FREEZE` → `FROZEN`, `OP_DISABLED` → `OP_DISABLED`, `PARAM_OUT_OF_BOUNDS` → `OUT_OF_BOUNDS`, anything else → `FORBIDDEN` (ccp/app/src/lib/httpApi.ts:519-529). All other mutations return `{ok:false, reason, code?}` where `code` is the raw taxonomy code, set only by the HTTP client (ccp/app/src/lib/api.ts:96-105); `GET /requests/:id` 404 becomes `undefined`, not an error (ccp/app/src/lib/httpApi.ts:656).

## Regenerate / verify

Run from the repo root. Each command re-checks one table.

```sh
# 1. The taxonomy itself (codes, statuses, reasons):
sed -n '10,71p' ccp/api/src/errors.ts

# 2. Every emission site of a taxonomy code (must all be codes from step 1):
grep -rnE "apiError\(c, '[A-Z_]+'|ApiError\('[A-Z_]+'" ccp/api/src --include='*.ts' | grep -v '\.test\.'

# 3. Codes emitted via variables (failCode / ParamCheck / schedule validation):
grep -rnE "apiError\(c, [a-z]" ccp/api/src --include='*.ts' | grep -v '\.test\.'
sed -n '16,29p' ccp/api/src/middleware/session.ts
grep -n "code: '" ccp/api/src/manifests.ts ccp/api/src/domain/schedule.ts

# 4. Inline literals NOT in the taxonomy (expect NOT_FOUND, TOTP_ENROLLMENT_REQUIRED,
#    CANCEL_FORBIDDEN, REWINDOW_FORBIDDEN, INTERNAL and nothing else):
grep -rn "c.json({ code: '" ccp/api/src --include='*.ts' | grep -v '\.test\.'

# 5. Defined-but-never-emitted (each must return ONLY its errors.ts definition line):
grep -rn "ACCOUNT_LOCKED" ccp/api/src --include='*.ts' | grep -v '\.test\.'
grep -rn "ENGINEER_REVIEW_REQUIRED" ccp/api/src --include='*.ts' | grep -v '\.test\.'

# 6. Spec-divergence check (each grep should print 0):
for c in DUPLICATE_TEAM ENGINEER_REVIEW_REQUIRED WRONG_APPROVAL_LEVEL SELF_DELETE \
         PROJECT_SCOPE REPLACE_CONFIRMATION_REQUIRED SCHEDULE_INVALID SCHEDULE_TOO_SOON \
         SCHEDULE_TOO_FAR SCHEDULE_STALE_APPROVAL CONTROL_SCOPE \
         REAUTH_REQUIRED LAST_FACTOR DEVICE_LIMIT; do \
  printf "%s " $c; grep -c "$c" ccp/docs/specs/ccp-api.md; done

# 7. Onboarding refusal codes and exit-code contract:
grep -n 'refuse(stdout, "' tools/catalogctl/internal/onboard/onboard.go
sed -n '71,73p;212,215p' tools/catalogctl/internal/onboard/onboard.go

# 8. Prescan finding codes:
sed -n '44,48p' tools/catalogctl/internal/prescan/prescan.go
grep -n "addFinding" tools/catalogctl/internal/prescan/prescan.go

# 9. SPA statuses and badge labels:
sed -n '4,46p' ccp/app/src/types/request.ts
sed -n '17,51p' ccp/app/src/components/ui/StatusBadge.tsx

# 10. SPA error handling (readError fallback, SubmitResult buckets, status sets):
sed -n '519,529p;562,567p' ccp/app/src/lib/httpApi.ts
grep -n "OPEN_STATUSES = \|CANCELLABLE_STATUSES = \|PR_UNLINKABLE_STATUSES = \|PLAN_SUMMARY_UNRECORDABLE_STATUSES = " ccp/api/src/routes/requests.ts
```

## Known tensions & caveats (extraction findings, 2026-07-17)

Found while deriving this doc from code at commit d781c25 — kept verbatim so nothing
is lost. Actionable ones are tracked separately; do not silently "fix" this doc to hide them.

- The task said to state facts "measured at commit undefined" — the orchestrator appears to have failed to interpolate a sha. I substituted the actual worktree HEAD, 3a77618 (branch claude/docs-restructure-fundamentals-a929a5, 2026-07-17). If the parent expected a different sha, only that one sentence needs changing.
- errors.ts header contradiction: ccp/api/src/errors.ts:6 claims codes are "transcribed verbatim from ccp/docs/specs/ccp-api.md", but 10 taxonomy codes (DUPLICATE_TEAM, ENGINEER_REVIEW_REQUIRED, WRONG_APPROVAL_LEVEL, SELF_DELETE, PROJECT_SCOPE, REPLACE_CONFIRMATION_REQUIRED, SCHEDULE_INVALID, SCHEDULE_TOO_SOON, SCHEDULE_TOO_FAR, SCHEDULE_STALE_APPROVAL) have zero occurrences in that spec — documented in the doc body, but it means either the spec or the header comment is stale.
- errors.ts:5 claims the taxonomy is "the ONLY error surface. Every 4xx body is {code, reason, details?}", yet five codes are emitted as inline c.json literals outside the ERRORS map: NOT_FOUND (404, 20 sites, e.g. ccp/api/src/routes/requests.ts:502), TOTP_ENROLLMENT_REQUIRED (403, requests.ts:549), CANCEL_FORBIDDEN (403, requests.ts:856), REWINDOW_FORBIDDEN (403, requests.ts:943), INTERNAL (500, errors.ts:119). 404 is arguably a deliberate carve-out (like 500) but nothing in code says so.
- ACCOUNT_LOCKED (ccp/api/src/errors.ts:65) is in the spec and the taxonomy but never emitted anywhere in ccp/api/src (non-test); the actual login-lockout path returns LOGIN_BACKOFF 429 (ccp/api/src/routes/auth.ts:75-77). I cannot tell whether it is dead or reserved for a future admin-disable flow.
- ENGINEER_REVIEW_REQUIRED (errors.ts:26) is defined, absent from the spec, AND never emitted — the engineer-tier gate emits WRONG_APPROVAL_LEVEL (requests.ts:571) instead. Doubly suspicious; flagged in the table.
- ccp/docs/onboarding-security.md:48-49 says the scaffold step fills public/projects/<id>/, but the code's scaffold checklist prints ccp/app/src/data/projects/<id>/blocks (tools/catalogctl/internal/onboard/onboard.go:204) and the SPA vendors from src/data/projects/* (ccp/app/src/lib/api.ts:36-47). That doc is contract-test-guarded so I did not touch it, but its path claim diverges from current code.
- StatusBadge.tsx:47-49 itself notes a divergence from the concept doc: WINDOW_EXPIRED should have a 'blocked' tone per the concept prose, but the StatusTone union has no such value, so it uses 'fail'. Reported as-coded.
- "Thrown where" for VALIDATION_FAILED (47 route sites), STATE_CONFLICT (14 route sites) and CHAIN_CONTENTION cites representative/aggregated locations rather than every line; the regenerate commands (step 2) reproduce the exhaustive list.
- Terminal-vs-open classification of SPA statuses is inferred from the server's gate sets (OPEN_STATUSES requests.ts:107, CANCELLABLE_STATUSES requests.ts:116, PR_UNLINKABLE requests.ts:124) plus type-comment prose — the codebase has no single declared 'terminal' set. Mid-flight states (SUBMITTED, GENERATING, MERGED, APPLYING, etc., types/request.ts:6-15) were left out of the terminal-states table by design.
