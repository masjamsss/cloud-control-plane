import { z } from 'zod';
import { PlanSummarySchema } from './planSummarySchema';

/**
 * The executable version — one zod schema per item shape, plus the
 * key helpers.
 *
 * Multi-project keying (frozen — Global Constraints): IDENTITY is GLOBAL
 * (`ACCOUNT#…`, `SESSION#…` — one account directory across projects); EVERYTHING
 * else is PROJECT-SCOPED with a `P#<projectId>#` prefix on its PK, including a
 * per-project audit chain. Every key helper below that is project-scoped takes
 * `projectId` as its FIRST argument. No caller concatenates key strings by hand.
 */

/* ── shared sub-shapes ──────────────────────────────────────────────────────── */

export const Role = z.enum(['requester', 'approver', 'lead']);
/** The non-optional role scalar (`z.infer<typeof Role>`). Use this where a role is
 * always present (a resolved per-project role, a ladder-step check), as opposed to
 * `AccountItem['role']` which is now the OPTIONAL legacy mirror field. */
export type RoleName = z.infer<typeof Role>;
export const RiskFloor = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const Macd = z.enum(['Add', 'Move', 'Change', 'Delete']);

/**
 * One PER-PROJECT authorization binding: the account's `role` on that project and,
 * optionally, the `teamId` scoping its requests there. The value half of the
 * `AccountItem.roles` map (keyed by projectId or `'*'`). Team is now per project —
 * the legacy top-level `teamId` migrates into each entry via `projects.ts#rolesOf`.
 */
export const RoleBinding = z.object({ role: Role, teamId: z.string().optional() });
export type RoleBinding = z.infer<typeof RoleBinding>;

const Credential = z.object({
  algo: z.enum(['argon2id', 'pbkdf2']),
  hash: z.string(),
  salt: z.string().optional(),
  iterations: z.number().optional(),
});

const Totp = z.object({ secretEnc: z.string(), enrolledAt: z.string() });

/**
 * One named TOTP device (ADR-0024). `id` is server-minted (ulid) except for
 * the shim's synthetic `'legacy'` id (see `auth/totp.ts#totpDevicesOf`),
 * which never round-trips through this schema — it exists only in the
 * in-memory shim projection, never written to the store.
 */
export const TotpDevice = z.object({
  id: z.string(),
  name: z.string(),
  secretEnc: z.string(),
  enrolledAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type TotpDevice = z.infer<typeof TotpDevice>;

/** One recovery code, hashed at rest (ADR-0025). `usedAt` present ⇒ burned
 * (never deleted — burned codes stay for the honest remaining-count). */
const RecoveryCode = z.object({ hash: z.string(), usedAt: z.string().optional() });

/** The account's whole recovery-code set — replaced wholesale on regenerate. */
const RecoveryCodes = z.object({ codes: z.array(RecoveryCode), generatedAt: z.string() });

const Approval = z.object({ user: z.string(), at: z.string() });

const RequestEvent = z.object({
  at: z.string(),
  type: z.string(),
  label: z.string(),
  actor: z.string().optional(),
});

// Schedule v2: `endAt` added, additive — legacy rows without it parse
// unchanged (optional in the type; `domain/schedule.ts#windowEndOf` supplies
// `at + DEFAULT_WINDOW_MS` on read so every gate stays total). Always WRITTEN by
// `validateSchedule` (V5) for new submissions/rewindows — the store, the SPA, and
// the (future) bundle exporter all speak `[start, end)` from here on.
const Schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('now') }),
  z.object({ kind: z.literal('window'), at: z.string(), endAt: z.string().optional() }),
]);

/**
 * One operation inside a multi-operation CHANGE SET (Phase B). A request may hold
 * an ordered list of these — one reviewed change that enacts several operations
 * (multi-edit on one resource, or one action fanned across many targets). Each item
 * carries ONLY the intent (operationId/targetAddress/params) plus the SERVER-COMPUTED,
 * pinned-at-submit facts a later re-gate needs: the item's own `service`/`macd`/`exposure`
 * (from the manifest, never the body), its pinned `reviewTier`, and — for a forces-replace
 * item — the typed `replaceConfirmation` (validated == targetAddress at submit).
 *
 * The combined review requirement is the STRICTEST across every item and the request-level
 * `reviewTier` holds that combined tier; each item's own `reviewTier` here is that ITEM's
 * pinned tier, so the tighten-only live re-gate (`domain/requirement.ts`) can re-evaluate
 * each item independently and can only ever RAISE the set's bar.
 *
 * ADDITIVE + fail-closed: a single-op request carries NO `items` (the top-level
 * operationId/targetAddress/params ARE the one item — `domain/changeset.ts#itemsOf`
 * derives it), so every legacy row and every single-op submit is byte-identical to before.
 */
export const RequestSetItem = z.object({
  operationId: z.string(),
  service: z.string(),
  macd: Macd,
  targetAddress: z.string(),
  params: z.record(z.unknown()),
  exposure: z.string(),
  reviewTier: z.enum(['self_service', 'guardrails', 'engineer']).optional(),
  replaceConfirmation: z.string().optional(),
});
export type RequestSetItem = z.infer<typeof RequestSetItem>;

/* ── item shapes ───────────────────────────────────────────────────────── */

export const AccountItem = z.object({
  PK: z.string(),
  SK: z.string(),
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  /**
   * PER-PROJECT authorization: `{ [projectId | '*']: { role, teamId? } }`. This is
   * the CANONICAL authorization field going forward; the map key set IS the
   * membership set (`'*'` = all-projects, the bootstrap/migration wildcard). Every
   * enforcement point reads it through `projects.ts#roleFor`/`teamFor`/`rolesOf` —
   * never `account.role` directly. ADDITIVE + OPTIONAL: absent on every legacy row,
   * which `rolesOf` canonicalizes from the legacy `role`/`teamId`/`projects` fields
   * below (fail-closed), so nothing changes on deploy. All WRITES emit THIS shape.
   */
  roles: z.record(RoleBinding).optional(),
  /**
   * LEGACY single-global role. Now OPTIONAL (was required): new rows carry `roles`
   * instead and omit this. Still accepted so every stored pre-`roles` row parses,
   * and read ONLY through `rolesOf` (the canonical shim), never as a live authz
   * source. Keeping a second authority field on new rows is deliberately avoided —
   * two sources of truth for a per-project role is exactly the bug class this closes.
   */
  role: Role.optional(),
  /** LEGACY global team. Now OPTIONAL; migrates into each `roles` entry via `rolesOf`. */
  teamId: z.string().optional(),
  status: z.enum(['active', 'disabled']),
  createdAt: z.string(),
  createdBy: z.string(),
  mustChangePassword: z.boolean(),
  isAdmin: z.boolean(),
  /**
   * Admin-controlled per-account 2FA requirement. `undefined` =
   * "use the role default" — so the effective requirement (`auth/totp.ts#needsTotp`)
   * stays `role !== 'requester' || isAdmin` for every legacy row, and NOTHING changes
   * on deploy. An admin may pin it `true` (force a second factor, even for a plain
   * requester) or `false` (exempt anyone, incl. a privileged account — there is
   * deliberately no server role floor; the downgrade warning is a UI safety net).
   * ADDITIVE: optional, so legacy rows parse unchanged.
   */
  totpRequired: z.boolean().optional(),
  /**
   * LEGACY account↔project MEMBERSHIP list (`['*']` = all projects). Superseded by
   * `roles` (which carries a role PER project); still accepted so pre-`roles` rows
   * parse, and folded into `roles` by `rolesOf` — each listed project gets the row's
   * legacy `role`/`teamId`. Absent (pre-binding rows) → `[DEFAULT_PROJECT]`, never
   * all-projects. Fail closed.
   */
  projects: z.array(z.string()).optional(),
  credential: Credential,
  failedAttempts: z.number(),
  lockedUntil: z.string().optional(),
  sessionVersion: z.number(),
  /**
   * Monotonic account-mutation counter — the DRIFT GUARD for dual-control replays.
   * A pending account proposal captures `apply.set` (incl. the WHOLE next `roles`
   * map) at propose time and replays it verbatim at ack; every mutation that could
   * invalidate that snapshot bumps this counter (enroll starts it at 1; the admin
   * PATCH verbs/globals, rename, password reset, TOTP reset, session revocation,
   * and a self password-change all bump), and every account ApplySpec guards on
   * the propose-time value — so a stale ack fails 409 STALE_PROPOSAL instead of
   * silently clobbering the interleaved change. DISTINCT from `sessionVersion`,
   * which keeps its narrow meaning (invalidate live sessions / force the TOTP
   * gate) and deliberately does NOT move on benign changes. ADDITIVE: optional —
   * absent on legacy rows, where an `undefined` propose-time guard value matches
   * the `undefined` stored value until the first bump materializes it.
   */
  accountVersion: z.number().optional(),
  /**
   * LEGACY single 2FA secret. Stays in the schema so every stored row still
   * parses; superseded by {@link TotpDevice}-typed `totpDevices` below.
   * Read ONLY through the shim `auth/totp.ts#totpDevicesOf` (ADR-0024) — never
   * directly (contract-tested, `test/totpDeviceShim.test.ts`).
   */
  totp: Totp.optional(),
  /**
   * The named-device 2FA list (ADR-0024) — the canonical shape going
   * forward. ADDITIVE + OPTIONAL: absent on every legacy row, which
   * `totpDevicesOf` canonicalizes from the legacy `totp` secret above
   * (presented as one device `{id:'legacy', name:'Authenticator'}`), else `[]`.
   * A PRESENT array (even empty) is authoritative — same "present-but-empty
   * wins" rule as `roles` — so a fully de-enrolled account never resurrects
   * the legacy secret. Cap 5 (`auth/totp.ts#MAX_TOTP_DEVICES`), enforced at
   * every write site, never in the schema itself. All writes emit THIS shape
   * and delete `totp` (lazy migration on first device mutation — add,
   * remove, or even a successful login-time challenge that stamps
   * `lastUsedAt` — idempotent, no downtime, no script).
   */
  totpDevices: z.array(TotpDevice).optional(),
  /**
   * One-time recovery codes (ADR-0025) — break-glass login only; never a
   * factor, never valid for re-auth, never counted for founding-complete.
   * ADDITIVE + OPTIONAL: present only once 2FA is active (auto-issued at the
   * account's first device enrolment); deleted when the last device is
   * legitimately removed or by admin `reset-totp` (which clears both).
   */
  recoveryCodes: RecoveryCodes.optional(),
  GSI1PK: z.string().optional(),
  GSI1SK: z.string().optional(),
});
export type AccountItem = z.infer<typeof AccountItem>;

/** The next `accountVersion` for a mutation of `acc` — a legacy row (no counter yet) starts at 1. */
export function nextAccountVersion(acc: Pick<AccountItem, 'accountVersion'>): number {
  return (acc.accountVersion ?? 0) + 1;
}

export const SessionItem = z.object({
  PK: z.string(),
  SK: z.string(),
  userId: z.string(),
  issuedAt: z.string(),
  lastSeenAt: z.string(),
  absoluteExpiresAt: z.string(),
  sessionVersion: z.number(),
  ttl: z.number(),
  /** Pre-session (TOTP not yet completed) — Task 5. `totp` = enrolled, verify; `enroll` = first-login enrollment. */
  pending: z.enum(['totp', 'enroll']).optional(),
  /**
   * Encrypted TOTP secret held pending confirmation. Two lives: (1) the
   * pre-session first-login enrollment hold (Task 5, paired with
   * `pending:'enroll'`); (2) the standing self-service device-add hold
   * (ADR-0024 §5) — now legal on a FULL session (no `pending`), paired with
   * {@link enrollOfferedAt} below instead of a `pending` marker.
   */
  enrollSecretEnc: z.string().optional(),
  /**
   * When the standing device-add secret above was minted (ADR-0024 §5).
   * ADDITIVE-OPTIONAL. The confirm route refuses once
   * `now - enrollOfferedAt > TOTP_PENDING_MS` (`auth/sessions.ts`) — the same
   * 5-minute window the first-login enrollment pre-session already enforces
   * via its own absolute expiry. Absent on the first-login enrollment hold
   * (that lane times out via the pre-session's `absoluteExpiresAt` instead).
   */
  enrollOfferedAt: z.string().optional(),
  /**
   * The re-authentication elevation stamp (ADR-0026): set by `POST
   * /auth/reauth` (password or a live TOTP code), read by sensitive
   * self-service routes as `now - reauthAt <= REAUTH_MS`
   * (`auth/sessions.ts#REAUTH_MS`, 10 minutes). ADDITIVE-OPTIONAL: absent on
   * every legacy/pre-existing session — fail closed, treated as "never
   * elevated," never as "elevated at epoch." Lives on THIS session item only
   * (per-session, dies with the session) — never crosses sessions, never
   * survives sign-out/revocation/a `sessionVersion` bump.
   */
  reauthAt: z.string().optional(),
  GSI1PK: z.string().optional(),
  GSI1SK: z.string().optional(),
});
export type SessionItem = z.infer<typeof SessionItem>;

export const TeamItem = z.object({
  PK: z.string(),
  SK: z.string(),
  id: z.string(),
  name: z.string(),
  serviceSlugs: z.array(z.string()),
  version: z.number().optional(),
  GSI1PK: z.string().optional(), // teamCollectionGsi(projectId) — teams are listed via GSI1
  GSI1SK: z.string().optional(),
});
export type TeamItem = z.infer<typeof TeamItem>;

export const PolicyItem = z.object({
  PK: z.string(),
  SK: z.string(), // 'CURRENT' or 'VERSION#<n>'
  low: z.number().int().min(1).max(5),
  medium: z.number().int().min(1).max(5),
  high: z.number().int().min(1).max(5),
  deleteMin: z.number().int().min(1).max(5),
  version: z.number().int(),
  changedBy: z.string().optional(),
  changedAt: z.string().optional(),
  configChangeId: z.string().optional(),
});
export type PolicyItem = z.infer<typeof PolicyItem>;

export const RiskOverrideItem = z.object({
  PK: z.string(),
  SK: z.string(),
  risk: RiskFloor,
  version: z.number().int(),
  setBy: z.string(),
  setAt: z.string(),
});
export type RiskOverrideItem = z.infer<typeof RiskOverrideItem>;

export const SettingItem = z.object({
  PK: z.string(),
  SK: z.string(),
  key: z.string(),
  value: z.unknown(),
  version: z.number().int(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type SettingItem = z.infer<typeof SettingItem>;

export const RequestItem = z.object({
  PK: z.string(),
  SK: z.string(),
  id: z.string(),
  requestUlid: z.string(),
  requester: z.string(),
  /**
   * The project this request belongs to. ADDITIVE + OPTIONAL: absent on legacy rows
   * (the storage key `requestKey(projectId, id)` already scopes them), so the read
   * projection (`routes/requests.ts#toChangeRequest`) injects the acting project's id
   * for a legacy row. Written on every new submit from `c.get('projectId')`. This is a
   * denormalized convenience for readers/exports — the key remains the source of truth.
   */
  projectId: z.string().optional(),
  teamId: z.string(),
  service: z.string(),
  operationId: z.string(),
  macd: Macd,
  targetAddress: z.string(),
  params: z.record(z.unknown()),
  justification: z.string(),
  exposure: z.string(),
  /**
   * Server-computed review tier from `exposure`, pinned at
   * submit. ADDITIVE: absent on pre-enforcement rows — `tierOf()` derives it from
   * `exposure`, fail-closed, so legacy open requests are enforced identically.
   */
  reviewTier: z.enum(['self_service', 'guardrails', 'engineer']).optional(),
  risk: RiskFloor,
  /**
   * Free-text by design (no caller validates against a fixed union — every value
   * below already worked this way; this just inventories them). Machine
   * (`APPROVED_COOLING` is entered ONLY for `schedule.kind ===
   * 'now'`; a windowed interim completion stays `AWAITING_DEPLOY_APPROVAL` with
   * cooling composed as an `applyGate` reason, never a second status):
   * AWAITING_CODE_REVIEW | NEEDS_ENGINEER (open, pre-quorum)
   *   → APPROVED_COOLING (interim quorum met, schedule.kind:'now' —
   *     cooling-off)
   *     → APPLIED | AWAITING_DEPLOY_APPROVAL (lazily, once `earliestApplyAt` elapses
   *       — `domain/cooling.ts`, no background timer; window-kind rows never reach
   *       APPROVED_COOLING going forward, but this settle path stays correct for any
   *       row a legacy build wrote)
   *     → CANCELLED (during the cooling window — POST /requests/:id/cancel)
   *   → AWAITING_DEPLOY_APPROVAL (schedule.kind:'window', interim or not; OR any
   *     schedule held by a freeze at quorum-met, event `held_frozen`)
   *     → WINDOW_EXPIRED (lazily, once the window closes with no apply — no
   *       background timer, `domain/schedule.ts#applyGate`/settleWindow; also
   *       entered EAGERLY at quorum-met when already infeasible, event
   *       `window_infeasible`)
   *       → AWAITING_DEPLOY_APPROVAL (POST /requests/:id/rewindow)
   *       → CANCELLED (POST /requests/:id/cancel)
   *     → CANCELLED (before or during the window — POST /requests/:id/cancel)
   *   → APPLIED (non-interim, schedule.kind:'now' quorum met — instant, unchanged;
   *     the Stage-0/1 "nothing has really applied yet" fiction, T-S6 retires it)
   *   → REJECTED (terminal)
   */
  status: z.string(),
  approvalsRequired: z.number().int(),
  approvals: z.array(Approval),
  schedule: Schedule,
  createdAt: z.string(),
  updatedAt: z.string(),
  prNumber: z.number().optional(),
  prUrl: z.string().optional(),
  /**
   * The structured `terraform plan` summary (the shared
   * `@app-lib/planSummary` contract the parser produces and the SPA renders).
   * Written ONLY by POST /requests/:id/plan-summary; absent until CI records a
   * plan. Was `z.string()` in the Stage-0 fiction (a terraform one-liner) —
   * no route ever wrote it, so no durable row carries the old shape.
   */
  planSummary: PlanSummarySchema.optional(),
  /**
   * Forces-replace confirmed-override lane: the exact resource address the requester
   * typed to confirm a destroy+recreate (layer 1). Written ONLY at submit and ONLY for a
   * forcesReplace op, where it is required to equal `targetAddress`; absent on every other
   * request. Carried onto the request so the reviewer sees the acknowledgement and the
   * (future) PR bundle can hand the executor its `confirmations.replace` binding. Storing
   * it never weakens PREVENT_DESTROY — that refuses in the executor regardless.
   */
  replaceConfirmation: z.string().optional(),
  /**
   * The multi-operation CHANGE SET (Phase B): the ordered list of operations this ONE
   * reviewed change enacts. Present ONLY for a true set (length ≥ 2); a single-op request
   * carries NONE and its top-level operationId/targetAddress/params ARE the one item
   * (`domain/changeset.ts#itemsOf` derives it), so single-op rows stay byte-identical. The
   * top-level fields mirror items[0] (the primary) so every existing single-op reader — the
   * projection, RequestDetail, the executor, catalogctl — keeps working unchanged; the
   * request-level `reviewTier`/`approvalsRequired` hold the STRICTEST-combined requirement
   * across all items. ADDITIVE + fail-closed: absent on every legacy row.
   */
  items: z.array(RequestSetItem).optional(),
  /**
   * Scheduled DRY-RUN auto-apply pin (0038). The reviewed plan is PINNED at approval so
   * the server-side scheduler can, at the maintenance window, re-plan and apply ONLY the
   * exact change humans reviewed — nothing that drifted since. `pinnedDiff` is the
   * reviewed plan text and `planDigest` is its sha256 (the drift anchor:
   * `domain/apply/scheduler.ts#isPinIntact` requires `sha256(pinnedDiff) === planDigest`,
   * and the window re-plan must reproduce `planDigest` or the auto-apply HALTS). Written
   * at approval time by a LATER step; the scheduler READS them. `appliedSha`/`evidenceUrl`
   * are stamped by the scheduler on a (dry-run) apply — `DRYRUN-…`/`dryrun://…` sentinels
   * today, real values once the terraform executor lands. ALL FOUR are ADDITIVE and
   * OPTIONAL: absent on every existing row, so nothing changes on deploy, and a request
   * with no pin can NEVER be auto-applied (isPinIntact fails closed → HALT).
   */
  pinnedDiff: z.string().optional(),
  planDigest: z.string().optional(),
  appliedSha: z.string().optional(),
  evidenceUrl: z.string().optional(),
  events: z.array(RequestEvent),
  policyVersion: z.number().int(),
  riskOverrideVersion: z.number().int().optional(),
  interimProfile: z.boolean().optional(),
  earliestApplyAt: z.string().optional(),
  /**
   * Quorum feasibility, snapshotted at submit — a submit-time reading of
   * `domain/feasibility.ts`'s `{eligibleApprovers, feasible, interimProfileWillApply}`.
   * A stale snapshot (the directory can change after submit) is fine for the general
   * ChangeRequest projection; GET /requests/:id/feasibility recomputes LIVE for
   * callers that need the current truth. ADDITIVE: absent on legacy rows.
   */
  eligibleApprovers: z.number().int().optional(),
  feasible: z.boolean().optional(),
  interimProfileWillApply: z.boolean().optional(),
  eventSeq: z.number().int().optional(),
  /**
   * ADR-0016 approval-to-apply bundle progress (POST /requests/:id/apply).
   * Additive-optional (deploy-inert): 'running' claims the bundle (idempotency
   * guard), 'triggered' = landed on main + gated-apply approval fired (sha set),
   * 'failed' = a step went red (re-runnable). Absent = never bundled.
   */
  bundle: z
    .object({
      state: z.enum(['running', 'triggered', 'failed']),
      sha: z.string().optional(),
      at: z.string().optional(),
    })
    .optional(),
  GSI1PK: z.string().optional(),
  GSI1SK: z.string().optional(),
});
export type RequestItem = z.infer<typeof RequestItem>;

export const ApprovalItem = z.object({
  PK: z.string(),
  SK: z.string(), // 'APPROVAL#<actorId>'
  user: z.string(),
  at: z.string(),
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;

export const RequestEventItem = z.object({
  PK: z.string(),
  SK: z.string(), // 'EVT#<seq(6)>'
  at: z.string(),
  type: z.string(),
  label: z.string(),
  actor: z.string().optional(),
});
export type RequestEventItem = z.infer<typeof RequestEventItem>;

/** How a pending change re-applies on ack (a single conditional TransactWrite). */
export const ApplySpec = z.object({
  op: z.enum(['put', 'update', 'delete']),
  pk: z.string(),
  sk: z.string(),
  item: z.record(z.unknown()).optional(), // op:put
  set: z.record(z.unknown()).optional(), // op:update
  ifNotExists: z.boolean().optional(),
  guardAttr: z.string().optional(), // drift guard (ifEquals)
  guardValue: z.unknown().optional(),
});
export type ApplySpec = z.infer<typeof ApplySpec>;

export const PendingConfigChangeItem = z.object({
  PK: z.string(),
  SK: z.string(),
  id: z.string(),
  kind: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  targetKey: z.string(),
  beforeVersion: z.number().optional(),
  apply: ApplySpec.optional(),
  /** Which project's AUDIT CHAIN this change's trail lands on when it is not
   * the acting scope (data-plane verbs audit to the TARGET project). Internal —
   * never serialized to clients (publicPendingChange omits it, like `apply`). */
  auditProjectId: z.string().optional(),
  proposedBy: z.string(),
  proposedAt: z.string(),
  status: z.enum(['PENDING', 'APPLIED', 'REJECTED', 'EXPIRED', 'SUPERSEDED']),
  expiresAt: z.string(),
  ackBy: z.string().optional(),
  ackAt: z.string().optional(),
  GSI1PK: z.string().optional(),
  GSI1SK: z.string().optional(),
});
export type PendingConfigChangeItem = z.infer<typeof PendingConfigChangeItem>;

export const AuditItem = z.object({
  PK: z.string(),
  SK: z.string(), // '<ulid>'
  id: z.string(),
  projectId: z.string(),
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  requestId: z.string().optional(),
  interimProfile: z.boolean().optional(),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditItem = z.infer<typeof AuditItem>;

export const ChainHeadItem = z.object({
  PK: z.string(),
  SK: z.string(),
  hash: z.string(),
  lastUlid: z.string(),
  count: z.number().int(),
});
export type ChainHeadItem = z.infer<typeof ChainHeadItem>;

/* ── projects registry (the onboarding trust surface) ───────────── */

/**
 * One prescan finding, exactly as `catalogctl onboard` emits it (prescan.go
 * `Finding`). `.strict()` everywhere below: the report is a Go-authored,
 * sha-bound artifact — an unexpected key means a different producer or a
 * tampered file, and the fail-closed answer is refusal, not tolerance.
 */
export const PrescanFinding = z
  .object({
    code: z.string().min(1).max(40),
    file: z.string().min(1).max(500),
    line: z.number().int().nonnegative(),
  })
  .strict();
export type PrescanFinding = z.infer<typeof PrescanFinding>;

/**
 * The `prescan-report.json` shape (prescan.go `Report`, key set golden-pinned by
 * catalogctl's `TestPrescanReportShape_IsTheWizardContract`). Findings drive the
 * verdict; the census fields are report data. The refine enforces the producer's
 * own invariant — findings ⟺ verdict reject — so a hand-edited "clean" report
 * that still lists findings can never reach a trust button.
 */
export const PrescanReport = z
  .object({
    repo: z.string().min(1).max(300),
    verdict: z.enum(['clean', 'reject']),
    findings: z.array(PrescanFinding).max(10000),
    resourceBlocks: z.number().int().nonnegative(),
    moduleBlocks: z.number().int().nonnegative(),
    tfJsonFiles: z.number().int().nonnegative(),
    fmtDirtyFiles: z.number().int().nonnegative(),
    providerPins: z.record(z.string().max(100)),
  })
  .strict()
  .refine((r) => (r.verdict === 'clean') === (r.findings.length === 0), {
    message: 'verdict must be reject iff findings exist',
  });
export type PrescanReport = z.infer<typeof PrescanReport>;

/** The uploaded pair, recorded verbatim: the trust-request triple the CLI wrote
 * (onboard.go — `{repo, commitSha, prescanSha256}`, the REAL schema) plus the
 * parsed report AND its raw bytes (`rawReport`), so the sha binding can be
 * re-verified at any later point. `rawReport` never serializes to clients —
 * see routes/projects.ts `publicProject`. */
export const ProjectTrustRequestRecord = z.object({
  repo: z.string(),
  commitSha: z.string(),
  prescanSha256: z.string(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  report: PrescanReport,
  rawReport: z.string(),
});
export type ProjectTrustRequestRecord = z.infer<typeof ProjectTrustRequestRecord>;

/** The trust block, verbatim (admin-and-multiproject.md): written ONLY by
 * the dual-controlled trust flow, never accepted from any request body. */
export const ProjectTrustBlock = z.object({
  trustedBy: z.string(),
  trustedAt: z.string(),
  preScanReportSha256: z.string(),
  commitSha: z.string(),
});
export type ProjectTrustBlock = z.infer<typeof ProjectTrustBlock>;

/** The go-live digest record. Written ONLY by the FIRST dual-controlled data
 * activation's ack (from the server's own digests over the activated version —
 * routes/projectData.ts); the api records digests, it is not a file server.
 * Mirrors {@link ProjectDataDigests}: `manifestsSha256` is present iff the
 * recorded version carried manifests. */
export const ProjectArtifacts = z.object({
  inventorySha256: z.string(),
  blocksSha256: z.string(),
  manifestsSha256: z.string().optional(),
  recordedBy: z.string(),
  recordedAt: z.string(),
});
export type ProjectArtifacts = z.infer<typeof ProjectArtifacts>;

export const ProjectStatus = z.enum(['draft', 'pending-trust', 'trusted', 'ready']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * HOST-AGNOSTIC repo reference (the evolution of the GitHub-only
 * `ProjectItem.github`). `host` names the forge; `baseUrl` is only for a
 * self-hosted instance (absent = the public host); `owner` may carry `/`-separated
 * group segments (GitLab subgroups). New rows store THIS shape (plus a `github`
 * mirror when host is github, so legacy readers keep working); legacy rows store
 * only `github` and are read through {@link repoRefOf} — never directly.
 */
export const RepoRef = z
  .object({
    host: z.enum(['github', 'gitlab']),
    /** Self-hosted forge origin (https only). Absent = github.com / gitlab.com. */
    baseUrl: z.string().url().startsWith('https://').max(200).optional(),
    owner: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/),
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  })
  .strict();
export type RepoRef = z.infer<typeof RepoRef>;

/**
 * THE READ-TIME BACK-COMPAT SHIM (single place the legacy shape is interpreted):
 * resolve either stored shape to one {@link RepoRef}. A `repo` field wins; a
 * legacy `github`-only row maps to host 'github'. Total for every valid stored
 * row; `undefined` only for a row that (impossibly) carries neither.
 */
export function repoRefOf(p: { repo?: RepoRef; github?: { owner: string; repo: string } }): RepoRef | undefined {
  if (p.repo) return p.repo;
  if (p.github) return { host: 'github', owner: p.github.owner, name: p.github.repo };
  return undefined;
}

/** The legacy `github` mirror for a {@link RepoRef} — only a github-hosted repo
 * has one (mirroring a GitLab repo into a `github` field would be a lie). */
export function githubMirrorOf(repo: RepoRef | undefined): { owner: string; repo: string } | undefined {
  if (!repo || repo.host !== 'github') return undefined;
  return { owner: repo.owner, repo: repo.name };
}

/**
 * A registered project. GLOBAL key space like identity — the registry
 * DEFINES the project namespace, so it cannot itself be project-scoped. Status is
 * a strict forward ladder: draft → pending-trust (artifact upload) → trusted
 * (dual-controlled trust-ack) → ready (the first data activation's 2-admin ack —
 * or the manual digest recording). Only `ready` projects join `knownProjects()`
 * (routable / bindable) — fail closed at every earlier rung.
 */
export const ProjectItem = z.object({
  PK: z.string(),
  SK: z.string(),
  id: z.string(),
  name: z.string(),
  /**
   * LEGACY GitHub-only repo shape. Now OPTIONAL: new rows carry `repo` (host-agnostic)
   * and, when the host is github, this mirror too — so every legacy reader keeps
   * working during migration. Read ONLY through `repoRefOf`, never directly.
   */
  github: z.object({ owner: z.string(), repo: z.string() }).optional(),
  /** The canonical host-agnostic repo reference. Absent on legacy rows (which
   * carry only `github`) — `repoRefOf` resolves either shape. */
  repo: RepoRef.optional(),
  /**
   * Which cloud this project's estate lives on (0039 S1 — the azure seam).
   * Optional and NEVER default-filled: absence means 'aws', the exact wire
   * convention the SPA already uses (types/project.ts `provider`), so every
   * row written before this field stays byte-identical (an aws row omits it).
   * An azure row carries the {@link subscriptionId}/{@link tenantId}/{@link location}
   * identity triple below IN PLACE OF {@link accountId}/{@link region}.
   */
  provider: z.enum(['aws', 'azure']).optional(),
  /** AWS account id, `^\d{12}$`. Present for an aws project (provider absent or
   * 'aws'); an azure project carries `subscriptionId`/`tenantId`/`location`
   * instead, so this is now OPTIONAL. */
  accountId: z.string().optional(),
  /** AWS region (aws projects) — present iff {@link accountId} is. */
  region: z.string().optional(),
  /** Azure subscription id (GUID) — present iff `provider === 'azure'`. */
  subscriptionId: z.string().optional(),
  /** Azure tenant/directory id (GUID) — present iff `provider === 'azure'`. */
  tenantId: z.string().optional(),
  /** Azure default location (allowlisted at register — routes/projects.ts
   * AZURE_LOCATION_ALLOWLIST) — present iff `provider === 'azure'`. */
  location: z.string().optional(),
  status: ProjectStatus,
  createdBy: z.string(),
  createdAt: z.string(),
  version: z.number().int(),
  trustRequest: ProjectTrustRequestRecord.optional(),
  trust: ProjectTrustBlock.optional(),
  artifacts: ProjectArtifacts.optional(),
  /**
   * The ACTIVE served-data version pointer — the ONLY source of truth for what
   * `GET /projects/:id/{manifests,inventory,blocks}` serves. Written ONLY by the
   * dual-controlled activate flow (never accepted from a request body); absent =
   * nothing is served (a staged upload alone serves nothing — fail closed).
   */
  dataActive: z
    .object({ version: z.number().int().positive(), activatedBy: z.string(), activatedAt: z.string() })
    .optional(),
  /**
   * Archive block. An archived project stops being routable/servable and refuses
   * uploads + token mints; the registry row and its audit history stay. Archiving
   * is tightening (immediate, one admin); UNarchiving is loosening (2-admin
   * envelope). ADDITIVE: absent on every existing row.
   */
  archived: z.object({ archivedBy: z.string(), archivedAt: z.string() }).optional(),
  GSI1PK: z.string().optional(),
  GSI1SK: z.string().optional(),
});
export type ProjectItem = z.infer<typeof ProjectItem>;

/**
 * The one-time boot SETTLEMENT marker (data-birth spec §9). Presence means the
 * legacy-store settlement (retro-register a pre-existing legacy deployment as a
 * normal ready project + materialize every bare account row's implicit binding
 * into an explicit `roles` map) has already run on this store — idempotency
 * guard against re-running on every boot/request. GLOBAL key (like the project
 * registry): settlement is a once-per-store event, not scoped to any project.
 */
export const SettlementItem = z.object({
  PK: z.string(),
  SK: z.string(),
  settledAt: z.string(),
  settledBy: z.string(),
});
export type SettlementItem = z.infer<typeof SettlementItem>;

/**
 * The instance display identity (ADR-0023: hybrid baked default + runtime
 * override). GLOBAL key — sibling namespace to the accounts partition and the
 * settlement marker, never project-scoped (instance naming is not an estate
 * concern). Seeded at most once, during the installer's one ephemeral
 * first-boot pass, from `CCP_INSTANCE_NAME`/`CCP_INSTANCE_TAGLINE`
 * (never overwrites an existing item — first-boot idempotence); edited
 * thereafter via `PUT /admin/instance` (immediate + audited, version-guarded
 * like every other admin-writable row — see `settingKey`'s CURRENT/version
 * pattern). Absence is a valid, meaningful state: no item yet ⇒ the SPA and
 * the TOTP issuer both fall back to their own baked-generic default.
 */
export const InstanceItem = z.object({
  PK: z.string(),
  SK: z.string(),
  name: z.string(),
  tagline: z.string(),
  version: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});
export type InstanceItem = z.infer<typeof InstanceItem>;

/* ── per-project served data (versions on disk; metadata rows here) ────────── */

/** The digest triple over a data bundle's parts. Each digest is sha256 over the
 * CANONICAL JSON of that part (recursive key-sorted, no whitespace — the exact
 * `domain/audit.ts#canonicalJson` rendering), so producer and verifier agree on
 * bytes without shipping raw file text. `manifestsSha256` is present iff the
 * bundle carried manifests. */
export const ProjectDataDigests = z
  .object({
    inventorySha256: z.string(),
    blocksSha256: z.string(),
    manifestsSha256: z.string().optional(),
  })
  .strict();
export type ProjectDataDigests = z.infer<typeof ProjectDataDigests>;

/**
 * One uploaded data VERSION's metadata (the registry row; the content lives on
 * disk under `<dataRoot>/<projectId>/v<version>/`, NEVER inside the store JSON).
 * Versions are immutable once staged — a re-upload creates the next version.
 * Whether a version is ACTIVE is derived from `ProjectItem.dataActive.version`;
 * these rows deliberately carry no mutable status of their own.
 */
export const ProjectDataVersionItem = z.object({
  PK: z.string(),
  SK: z.string(), // 'DATA#v<000001>'
  projectId: z.string(),
  version: z.number().int().positive(),
  uploadedAt: z.string(),
  /** Which upload token staged it: `upload-token:<tokenId>` (never a user id — this lane is CI). */
  uploadedVia: z.string(),
  /** Digests of the STORED content (post server-side redaction) — what is served. */
  digests: ProjectDataDigests,
  /** Digests the uploader claimed (verified against the uploaded bundle). Differ
   * from `digests` only when server-side redaction changed something. */
  uploadDigests: ProjectDataDigests,
  counts: z
    .object({
      resources: z.number().int().nonnegative(),
      blockAddresses: z.number().int().nonnegative(),
      blockChunks: z.number().int().nonnegative(),
      manifests: z.number().int().nonnegative(),
    })
    .strict(),
  /** The block chunk file bases this version stored — the serve-time allowlist
   * for `GET /projects/:id/blocks/:chunk` (no fs-derived paths, ever). */
  chunks: z.array(z.string()),
  /** Plain-language upload warnings (e.g. server-side redaction masked values
   * the uploaded bundle had not masked). */
  warnings: z.array(z.string()),
  sourceCommit: z.string().optional(),
  generatedAt: z.string().nullable().optional(),
  providerPins: z.record(z.string()).optional(),
});
export type ProjectDataVersionItem = z.infer<typeof ProjectDataVersionItem>;

/**
 * One CI upload token (the credential for `PUT /projects/:id/data`). The secret
 * half is argon2id-HASHED at rest (same posture as passwords) — the clear token is
 * shown exactly once at mint. Expiring and revocable (revoke = row deletion).
 */
export const ProjectUploadTokenItem = z.object({
  PK: z.string(),
  SK: z.string(), // 'UPLOADTOKEN#<tokenId>'
  tokenId: z.string(),
  projectId: z.string(),
  /** argon2id hash of the token's secret half. NEVER serialized to any client. */
  secretHash: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type ProjectUploadTokenItem = z.infer<typeof ProjectUploadTokenItem>;

/* ── drift telemetry: published reports (versions on disk; metadata rows here) ── */

/**
 * One published drift report VERSION's metadata (drift-portal spec §3.1) —
 * the envelope body lives on disk at `<dataRoot>/<projectId>/drift/v<N>.json`,
 * NEVER inside the store JSON (same split as {@link ProjectDataVersionItem}).
 * Immutable once staged; retention pruning (`CCP_DRIFT_KEEP`) deletes
 * whole rows, never edits one.
 */
export const DriftReportItem = z.object({
  PK: z.string(),
  SK: z.string(), // 'DRIFT#v<000001>'
  projectId: z.string(),
  version: z.number().int().positive(),
  uploadedAt: z.string(),
  /** Which upload token staged it: `upload-token:<tokenId>` — this lane is CI, never a user. */
  uploadedVia: z.string(),
  /** sha256 of the canonical JSON of the STORED (post-redaction) envelope — the idempotency key. */
  envelopeDigest: z.string(),
  capturedAt: z.string(),
  runId: z.string(),
  commit: z.string(),
  cadenceHours: z.number(),
  planExitCode: z.union([z.literal(0), z.literal(2)]),
  /** Per class + drifted total + security total — recomputed server-side
   * from the stored verdicts, never trusted from the classifier's own `counts`.
   * `unmanaged` (OOB provisioning spec §3.2 rule 4) is ADDITIVE — optional
   * so a row staged before that WI parses unchanged; every row staged from
   * here on always carries it (0 when the envelope had no sweep section). */
  counts: z
    .object({
      byClass: z.record(z.number().int().nonnegative()),
      drifted: z.number().int().nonnegative(),
      security: z.number().int().nonnegative(),
      unmanaged: z.number().int().nonnegative().optional(),
    })
    .strict(),
});
export type DriftReportItem = z.infer<typeof DriftReportItem>;

/**
 * The served-drift pointer (spec §3.1) — advanced in the SAME audited
 * transaction as the version stage. Its OWN row, deliberately NOT on
 * {@link ProjectItem}: telemetry must never contend with the registry's
 * dual-controlled `version` guard. Unlike project data there is no admin
 * activation step — drift describes reality and can trigger nothing by
 * itself, so the pointer advances the instant a report stages.
 */
export const DriftPointerItem = z.object({
  PK: z.string(),
  SK: z.string(), // 'DRIFT#latest'
  version: z.number().int().positive(),
  capturedAt: z.string(),
  planExitCode: z.union([z.literal(0), z.literal(2)]),
  driftedCount: z.number().int().nonnegative(),
  securityCount: z.number().int().nonnegative(),
  /** OOB provisioning spec §3.2 rule 4 — ADDITIVE, optional so a pointer
   * written before that WI parses unchanged; every pointer advance from
   * here on always carries it (0 when the report had no sweep section). */
  unmanagedCount: z.number().int().nonnegative().optional(),
});
export type DriftPointerItem = z.infer<typeof DriftPointerItem>;

/* ── drift telemetry: generated fix proposals (digest-keyed; body on disk) ──── */

/**
 * One generated drift-fix PROPOSAL's metadata (drift-portal spec §3.2, WI-6).
 * The full proposal doc (pinned verdict subset, attrs, unified diff/revert
 * table, request skeleton) lives on disk at
 * `<dataRoot>/<projectId>/drift/proposals/<digest>.json`, NEVER inside the
 * store JSON (same split as {@link DriftReportItem}). The digest IS the
 * storage key (§2.4 proposalDigest): regenerating identical drift is an
 * `ifNotExists` no-op; a changed drift is a new row (new digest).
 *
 * Status machine (§3.2): `open` → `submitted` (a request was created; pins
 * `requestId`) · `open` → `superseded` (the latest report no longer yields
 * this digest, or it re-yields it, cycling back to `open`). `submitted`
 * NEVER reverts to `open`/`superseded` — a superseded-while-submitted
 * proposal keeps its request; the request's own gate catches staleness (§7).
 */
export const DriftProposalItem = z.object({
  PK: z.string(),
  SK: z.string(), // 'DRIFTPROP#<proposalDigest>'
  projectId: z.string(),
  digest: z.string(),
  /** `'import'` — OOB provisioning-import spec §5.4 — is additive: a
   * proposal keyed on a sweep FINDING (no Terraform address of its own
   * pre-import) rather than a verdict. `'restore'` — L29, register 0009,
   * 2026-07-20-drift-restore-tranche.md §2.5 — is additive too: a proposal
   * re-asserting the code already on `main` over an out-of-band deletion,
   * address-keyed like adopt/revert. */
  flavor: z.enum(['adopt', 'revert', 'import', 'restore']),
  status: z.enum(['open', 'submitted', 'superseded']),
  addresses: z.array(z.string()),
  attrCount: z.number().int().nonnegative(),
  /** The report version this exact digest was FIRST generated from. */
  firstReportVersion: z.number().int().positive(),
  /** The newest report version that still yields this exact digest — bumped
   * on every regeneration that reproduces it; compared against the served
   * pointer's version at submit time (§4.3: `lastSeenReportVersion ==
   * pointer.version`, else `409 DRIFT_PROPOSAL_STALE`). */
  lastSeenReportVersion: z.number().int().positive(),
  /** The scratch checkout's HEAD sha the generation ran against. */
  baseCommit: z.string(),
  generatedAt: z.string(),
  /** Pinned once a submit creates a request from this proposal (§4.3). */
  requestId: z.string().optional(),
  /** OOB provisioning-import spec §5.4 — additive, import-only: the
   * finding's own identity (`arn` when derivable, else `null`), mirroring
   * what `addresses` gives adopt/revert. Informational (a proposal listing
   * can show it without opening the on-disk body); NEVER read to re-derive
   * eligibility — the pinned body's `importPayload` carries the full
   * identity for that (routes/drift.ts looks the CURRENT finding up fresh
   * from the stored sweep at submit time, never trusting this row). Absent
   * on every adopt/revert row. */
  arn: z.string().nullable().optional(),
  /** OOB provisioning-import spec §5.4 — additive, import-only, paired with
   * `arn` above. Absent on every adopt/revert row. */
  tfType: z.string().optional(),
});
export type DriftProposalItem = z.infer<typeof DriftProposalItem>;

/* ── key helpers ────────────────────────────────────────────────────────────── */

export type Key = { PK: string; SK: string };

const P = (projectId: string): string => `P#${projectId}#`;

/** Month partition key component (UTC), e.g. '202607'. */
export function yyyymm(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* GLOBAL identity keys — NOT project-scoped. */
export function accountKey(username: string): Key {
  return { PK: `ACCOUNT#${username}`, SK: 'META' };
}
export function sessionKey(tokenSha: string): Key {
  return { PK: `SESSION#${tokenSha}`, SK: 'META' };
}
export function sessionUserGsi(userId: string): string {
  return `SESSUSER#${userId}`;
}
/** GLOBAL registry key (the registry defines the project namespace). */
export function projectKey(id: string): Key {
  return { PK: `PROJECT#${id}`, SK: 'META' };
}
/** The GLOBAL settlement-marker row (data-birth spec §9) — one per store. */
export function settlementKey(): Key {
  return { PK: 'SETTLEMENT', SK: 'META' };
}
/** The GLOBAL instance-identity row (ADR-0023) — one per store, like
 * {@link settlementKey}; never project-scoped. */
export function instanceKey(): Key {
  return { PK: 'INSTANCE', SK: 'META' };
}
/** One uploaded data version's metadata row (content lives on disk). */
export function projectDataVersionKey(id: string, version: number): Key {
  return { PK: `PROJECT#${id}`, SK: `DATA#v${String(version).padStart(6, '0')}` };
}
/** SK prefix that lists a project's data versions in ascending order. */
export const PROJECT_DATA_SK_PREFIX = 'DATA#v';
/** One CI upload token row (secret argon2id-hashed at rest). */
export function uploadTokenKey(id: string, tokenId: string): Key {
  return { PK: `PROJECT#${id}`, SK: `UPLOADTOKEN#${tokenId}` };
}
/** One published drift report version's metadata row (content lives on disk). */
export function driftVersionKey(id: string, version: number): Key {
  return { PK: `PROJECT#${id}`, SK: `DRIFT#v${String(version).padStart(6, '0')}` };
}
/** SK prefix that lists a project's drift report versions in ascending order. */
export const DRIFT_VERSION_SK_PREFIX = 'DRIFT#v';
/** The served-drift pointer row — its own row, never on the registry item. */
export function driftPointerKey(id: string): Key {
  return { PK: `PROJECT#${id}`, SK: 'DRIFT#latest' };
}
/** One generated drift-fix proposal's metadata row (content lives on disk). */
export function driftProposalKey(id: string, digest: string): Key {
  return { PK: `PROJECT#${id}`, SK: `DRIFTPROP#${digest}` };
}
/** SK prefix that lists a project's drift proposals (any status). */
export const DRIFT_PROPOSAL_SK_PREFIX = 'DRIFTPROP#';

/* PROJECT-SCOPED keys — projectId is ALWAYS the first argument. */
export function teamKey(projectId: string, id: string): Key {
  return { PK: `${P(projectId)}TEAM#${id}`, SK: 'META' };
}
export function policyKey(projectId: string): Key {
  return { PK: `${P(projectId)}POLICY`, SK: 'CURRENT' };
}
export function policyVersionKey(projectId: string, n: number): Key {
  return { PK: `${P(projectId)}POLICY`, SK: `VERSION#${n}` };
}
export function riskOverrideKey(projectId: string, opId: string): Key {
  return { PK: `${P(projectId)}RISKOVR#${opId}`, SK: 'CURRENT' };
}
export function settingKey(projectId: string, key: string): Key {
  return { PK: `${P(projectId)}SETTING#${key}`, SK: 'CURRENT' };
}
export function requestKey(projectId: string, ulid: string): Key {
  return { PK: `${P(projectId)}REQ#${ulid}`, SK: 'META' };
}
/** Idempotency marker for a submit — scoped to (project, requester, client key), so a resubmit
 * carrying the same key resolves the FIRST request instead of creating a duplicate, and a key
 * can never collide across accounts or projects. Value: `{ requestId }`. */
export function requestIdempotencyKey(projectId: string, actor: string, key: string): Key {
  return { PK: `${P(projectId)}IDEMPOTENCY#${actor}#${key}`, SK: 'META' };
}
export function approvalKey(projectId: string, ulid: string, actor: string): Key {
  return { PK: `${P(projectId)}REQ#${ulid}`, SK: `APPROVAL#${actor}` };
}
export function eventKey(projectId: string, ulid: string, seq: number): Key {
  return { PK: `${P(projectId)}REQ#${ulid}`, SK: `EVT#${String(seq).padStart(6, '0')}` };
}
export function configChangeKey(projectId: string, ulid: string): Key {
  return { PK: `${P(projectId)}CONFIGCHANGE#${ulid}`, SK: 'META' };
}
export function auditKey(projectId: string, yyyymmStr: string, ulid: string): Key {
  return { PK: `${P(projectId)}AUDIT#${yyyymmStr}`, SK: ulid };
}
export function chainHead(projectId: string): Key {
  return { PK: `${P(projectId)}AUDIT`, SK: 'CHAINHEAD' };
}

/* GSI1 partition helpers (single global secondary index, namespaced by prefix). */
export function accountsGsi(): string {
  return 'ACCOUNTS'; // GLOBAL account directory (one across projects)
}
export function teamCollectionGsi(projectId: string): string {
  return `${P(projectId)}TEAM`;
}
export function requestCollectionGsi(projectId: string): string {
  return `${P(projectId)}REQ`;
}
export function pendingConfigGsi(projectId: string): string {
  return `${P(projectId)}CONFIGCHANGE#PENDING`;
}
export function projectCollectionGsi(): string {
  return 'PROJECTS'; // GLOBAL project registry (one namespace across the estate)
}
