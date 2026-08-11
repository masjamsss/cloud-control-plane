import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { ulid } from 'ulid';
import { canApprove, canRequest } from '@app-lib/permissions';
import { PlanSummarySchema, type PlanCounts } from '../store/planSummarySchema';
import { initialStatusFor, ladderFor, nextLadderStep, reviewTierFor, strictestTier, tierOf, type LadderStep, type ReviewTier } from '../domain/exposure';
import type { AppEnv } from '../appEnv';
import type { ChainHeadItem, ProjectItem, RequestItem, RequestSetItem } from '../store/schema';
import { approvalKey, chainHead, projectKey, requestCollectionGsi, requestIdempotencyKey, requestKey } from '../store/schema';
import { itemsOf } from '../domain/changeset';
import type { TransactWrite } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import { apiError, ApiError } from '../errors';
import { requireSession } from '../middleware/session';
import { requireProjectMembership, requireRole } from '../middleware/authz';
import { toUser } from '../auth/account';
import { CONTROL_SCOPE, roleFor } from '../projects';
import { getOperation, validateParams } from '../manifests';
import type { ManifestOperation } from '@/types';
import { isSystemDriftOp } from '../domain/systemOps';
import { disabledOps, isFrozen, loadPolicy, loadTeams, resolveRisk } from '../domain/config';
import { checkSubmitRateLimit } from '../middleware/rateLimit';
import { recordIn, transactWithAudit, type AuditEntryInput } from '../domain/audit';
import { bundleArmed, bundleClaimLive, bundleConfig, realSteps, retriggerBundle, runBundle, type BundleOutcome } from '../domain/bundle';
import { resolveLaneRemote, type LaneProject } from '../domain/laneRepo';
import { resolveKnob } from '../domain/deploymentSettings';
import { coolingElapsed, settleCooling } from '../domain/cooling';
import { canSignStep } from '../domain/eligibility';
import { totpDevicesOf } from '../auth/totp';
import { computeFeasibility } from '../domain/feasibility';
import { currentRequirement } from '../domain/requirement';
import { applyGate, isWindowInfeasible, needsWindowSettlement, REWINDOW_STALE_MS, settleWindow, validateSchedule } from '../domain/schedule';
import { nowIso, nowMs } from '../clock';

// Schedule v2: shape-only zod, same as ever — `endAt` is now accepted
// (optional; `domain/schedule.ts#validateSchedule` fills/validates it, V5). This
// schema still admits garbage (`at: z.string()`, empty/past/non-RFC3339): shape
// parsing is NOT where V2-V6 enforcement lives — that is `validateSchedule`, called
// explicitly below, after this parse and before the item is built.
// Exported: routes/drift.ts's proposal-submit body reuses this SAME shape (WI-6) —
// one schedule shape, not a second hand-copied union that could drift from this one.
export const ScheduleSchema = z.union([
  z.object({ kind: z.literal('now') }),
  z.object({ kind: z.literal('window'), at: z.string(), endAt: z.string().optional() }),
]);

/** The most operations one reviewed change set may hold. A generous cap that still bounds
 * the review + audit surface (and the atomic validation loop) — a request over it is a
 * VALIDATION_FAILED, the same fail-closed answer as any other malformed submit. */
const MAX_CHANGE_SET_ITEMS = 100;

/** Explicit request-body-size ceiling for a submit (Hono has no default). Bounds the total
 * bytes a submit can carry — 100 items each with a large params blob still fits comfortably,
 * while a multi-megabyte body is refused before it is ever parsed. Over it → VALIDATION_FAILED,
 * the same fail-closed answer as the item-count cap. */
const MAX_SUBMIT_BODY_BYTES = 256 * 1024;

/** Ceiling on `GET /requests?limit=` — mirrors the same cap on `GET /admin/audit`. */
const MAX_LIST_PAGE = 1000;
/** How many GSI rows a paged list reads per round trip while filling a page. A
 *  `pending` page can reject most of what it reads, so the walk is chunked rather
 *  than assuming one read yields a full page. */
const LIST_SCAN_CHUNK = 500;

/** One operation inside a submitted change set — the client supplies ONLY the intent
 * (operationId/targetAddress/params) plus an optional forces-replace `replaceConfirmation`;
 * everything else (service/macd/exposure/tier/status/approvals) is server-computed per item,
 * exactly like the single-op body. */
const SubmitItem = z.object({
  operationId: z.string().min(1),
  targetAddress: z.string().min(1),
  params: z.record(z.unknown()),
  replaceConfirmation: z.string().optional(),
});

// SubmitDraft: identity-free — requester/teamId/risk/approvalsRequired are
// stripped and recomputed server-side. `schedule` is required.
//
// Two shapes, ONE handler (Phase B — the multi-operation change set):
//   · SINGLE-OP (legacy, unchanged): top-level operationId/targetAddress/params.
//   · CHANGE SET: `items: [{operationId, targetAddress, params, replaceConfirmation?}]` —
//     several operations reviewed and applied as ONE change (multi-edit on one resource, or
//     one action fanned across many targets). The handler normalizes both to a canonical
//     item list, validates EVERY item with the exact same per-op gates, and rejects the
//     WHOLE set if any item fails (atomic).
//
// `replaceConfirmation` is the ONLY field that carries a destructive acknowledgement: the
// requester's typed resource name for a forces-replace (destroy+recreate) op — present at
// top level (single-op) or per item (a set). It is OPTIONAL (a normal op never sends it and
// it is ignored), but for a forcesReplace op the handler REQUIRES it to equal that op's
// `targetAddress`. The mass-assignment discipline stays intact because
// status/approvals/approvalsRequired/reviewTier are still computed server-side and never
// read from the body, per item, and a non-matching or stray confirmation is rejected
// rather than stored.
const SubmitBody = z.object({
  operationId: z.string().min(1).optional(),
  targetAddress: z.string().min(1).optional(),
  params: z.record(z.unknown()).optional(),
  replaceConfirmation: z.string().optional(),
  items: z.array(SubmitItem).min(1).max(MAX_CHANGE_SET_ITEMS).optional(),
  justification: z.string().min(10),
  schedule: ScheduleSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const RejectBody = z.object({ reason: z.string().optional() });

// POST /:id/rewindow body — always kind:'window'; V2-V6 revalidated by
// `validateSchedule` exactly like submit (one rule set, one module).
const RewindowBody = z.object({ at: z.string(), endAt: z.string().optional() });

// POST /:id/link-pr body. `prNumber` optional — derived from a
// /pull/<n>-shaped URL tail when omitted (prNumberFromUrl below).
const LinkPrBody = z.object({
  prUrl: z.string().min(1).max(500),
  prNumber: z.number().int().min(1).optional(),
});

/** Statuses an approval/rejection may act on: the normal queue AND the engineer track. */
const OPEN_STATUSES = new Set(['AWAITING_CODE_REVIEW', 'NEEDS_ENGINEER']);
/**
 * Statuses POST /:id/cancel may act on — "stop this approved-but-unapplied
 * change", widened from (APPROVED_COOLING only) to also
 * cover AWAITING_DEPLOY_APPROVAL (before OR during its window — cancel does not
 * care which, unlike rewindow) and WINDOW_EXPIRED. Table-driven (
 * AS-MERGED, the check was a single hardcoded `!== 'APPROVED_COOLING'`, not
 * yet a Set — this is that promised one-line-per-status widening, made real).
 */
const CANCELLABLE_STATUSES = new Set([
  'APPROVED_COOLING',
  'AWAITING_DEPLOY_APPROVAL',
  'WINDOW_EXPIRED',
  // The scheduler's halt statuses (API-2). Before this, nothing in the API could move a
  // request out of `HALTED_DRIFT`/`HALTED_APPLY_FAILED`: approve/reject refuse them,
  // rewindow refuses them, the bundle refuses them, and the scheduler itself only ever
  // writes them. A halted change was unreachable by every verb the product ships, and
  // the only remedy was editing the store JSON by hand.
  //
  // Cancel is the RIGHT exit and deliberately the only one. A halt means the reviewed
  // plan can no longer be trusted (drift/corrupt pin/quorum shortfall) or that an apply
  // may have half-landed — the halt messages already say "routed to a fresh
  // plan/review". Re-windowing such a row straight back into auto-apply eligibility
  // would re-arm exactly the plan the halt refused, so rewindow is NOT widened; the
  // path out of a halt is cancel + resubmit, through the humans.
  'HALTED_DRIFT',
  'HALTED_APPLY_FAILED',
]);
/**
 * Statuses POST /:id/link-pr refuses: a terminally-refused request
 * has no fulfilling PR to point at. Everything else may gain (or correct) its
 * link — NEEDS_ENGINEER is the headline case (the requester's timeline
 * dead-ends without it), AWAITING_CODE_REVIEW is the Stage-2 PR pipeline, and
 * a late link onto an already-applied request is a legitimate record repair.
 */
const PR_UNLINKABLE_STATUSES = new Set(['REJECTED', 'CANCELLED']);
/**
 * Statuses POST /:id/plan-summary refuses: a terminally-refused
 * or withdrawn request has no plan to record. Everything else may gain (or
 * supersede, on a re-plan) its summary — mirrors PR_UNLINKABLE_STATUSES, with
 * WITHDRAWN added since a self-service withdrawal is equally terminal here.
 */
const PLAN_SUMMARY_UNRECORDABLE_STATUSES = new Set(['REJECTED', 'CANCELLED', 'WITHDRAWN']);

/** A compact human phrase for a plan's counts, destructive-first — the
 * timeline event label ("replaces 1, updates 2") and audit-friendly. */
function planCountPhrase(c: PlanCounts): string {
  const parts: string[] = [];
  if (c.replace) parts.push(`replaces ${c.replace}`);
  if (c.delete) parts.push(`destroys ${c.delete}`);
  if (c.update) parts.push(`updates ${c.update}`);
  if (c.create) parts.push(`creates ${c.create}`);
  return parts.length > 0 ? parts.join(', ') : 'no changes';
}

/**
 * API-12 — The PR number from a `/pull/123`-shaped URL tail, or undefined. Assumes the
 * URL already parsed (the route validates that before calling this).
 *
 * The doc comment above always said "/pull/123-shaped"; the regex did not — `/(\d{1,9})\/?$/`
 * matches ANY trailing digits, so `.../issues/42` (not a PR at all) and even a bare
 * `https://example.com/9999` both "derived" a number. `pathname` already strips the query
 * string and fragment, so this only needs the two shapes forges actually use:
 * GitHub/Bitbucket's `/pull/<n>` and GitLab's `/merge_requests/<n>`.
 */
function prNumberFromUrl(prUrl: string): number | undefined {
  const m = /\/(?:pull|merge_requests)\/(\d{1,9})\/?$/.exec(new URL(prUrl).pathname);
  return m ? Number(m[1]) : undefined;
}

/**
 * The 0037 approval ladder + next unsigned step for a STORED request, derived from its
 * pinned tier (`tierOf`) and whether it was a forces-replace op (pinned via
 * `replaceConfirmation` presence). Used for the queue's "pending for ME" filter and the
 * ChangeRequest projection the SPA renders. The approve handler re-derives the ladder
 * live via `currentRequirement` (tighten-only tier) before it actually gates a
 * signature — this display copy never relaxes that.
 */
function ladderStateOf(
  item: Pick<
    RequestItem,
    'reviewTier' | 'exposure' | 'replaceConfirmation' | 'approvals' | 'items' | 'operationId' | 'service' | 'macd' | 'targetAddress' | 'params'
  >,
): { ladder: LadderStep[]; next: LadderStep | null } {
  // Pinned forces-replace across the WHOLE set: ANY item that carries a typed
  // `replaceConfirmation` floors the set to the [L2, L3] replace ladder. For a single-op
  // request `itemsOf` is length 1, so this is exactly the old `replaceConfirmation !==
  // undefined` check — single-op display is unchanged.
  const forcesReplace = itemsOf(item).some((it) => it.replaceConfirmation !== undefined);
  const ladder = ladderFor(tierOf(item), forcesReplace);
  return { ladder, next: nextLadderStep(ladder, item.approvals.length) };
}

/** Strip storage-only fields → the §3 ChangeRequest projection, plus the computed 0037
 * ladder + next-step (not stored — a pure function of the pinned tier + approvals). The
 * acting `projectId` is injected so a legacy row (stored before request-tagging) still
 * reports the project it lives under — the storage key `requestKey(projectId, id)` is the
 * source of truth, so the read scope IS the row's project. */
const STORAGE_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'PK',
  'SK',
  'GSI1PK',
  'GSI1SK',
  'requestUlid',
  'eventSeq',
  'riskOverrideVersion',
]);

export function toChangeRequest(item: RequestItem, projectId: string): Record<string, unknown> {
  // Copied field-by-field rather than rest-destructured-then-spread. The obvious
  // `const {PK, ..., ...rest} = item; return {...rest, extras}` builds TWO full
  // copies of every request — and this runs once per row of every list response,
  // where it was the single largest cost in the endpoint. One pass, one object,
  // same key order (`projectId`, when stored, keeps its original position).
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(item)) {
    if (!STORAGE_ONLY_FIELDS.has(k)) out[k] = (item as Record<string, unknown>)[k];
  }
  out.projectId = item.projectId ?? projectId;
  const { ladder, next } = ladderStateOf(item);
  out.approvalLadder = ladder;
  out.nextApprovalStep = next;
  return out;
}

/**
 * F1(b) (audit finding): the `.bundle-request.json` payload the apply route
 * writes for the LOCAL gate to read (`domain/bundle.ts#runBundle`) —
 * extracted from what was an inline `JSON.stringify` literal so the apply
 * route and the cross-layer seam tests
 * (`ccp/api/test/driftBundleSeam.test.ts`) share ONE serializer instead
 * of two shapes that could silently drift apart (the exact failure mode F1
 * found: `plancheck/driftgate.go` reads `.bundle-request.json`'s top-level
 * `operationId`/`params` only, so a batched drift-adopt change-set — whose
 * top-level fields mirror `items[0]`, the primary — had every item AFTER
 * the first silently ungated). `items` is included ONLY when the request
 * actually carries a change set (`RequestSetItem[]`, Phase B) — additive
 * for every non-drift, non-batched consumer, which ignores an `items` field
 * it doesn't look for, exactly as before this fix.
 */
export function bundleRequestPayload(req: RequestItem, projectId: string): Record<string, unknown> {
  return {
    id: req.id,
    projectId,
    operationId: req.operationId,
    targetAddress: req.targetAddress,
    params: req.params,
    approvals: req.approvals,
    status: req.status,
    // ARCH-3: the gate is told which plan was approved, so it can report a digest the api
    // can check. Absent on every request today (API-3 — no pin-writer is deployed).
    ...(req.planDigest !== undefined ? { planDigest: req.planDigest } : {}),
    ...(req.items ? { items: req.items } : {}),
  };
}

export function requestRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Session first, then the account↔project binding: EVERY request route (submit,
  // list, read, approve, reject) is project-scoped, so an account not bound to the
  // resolved project gets 403 PROJECT_SCOPE before any handler runs.
  r.use('*', requireSession, requireProjectMembership);
  // Estate-only surface (data-birth spec §5): the reserved `@control` scope has no
  // data plane, no requests. A '*'-bound founding admin legitimately passes the
  // membership gate above (the wildcard binds everywhere, incl. `@control`) but
  // still needs an onboarded account's scope to submit/approve/read a change —
  // refused here, distinctly from PROJECT_SCOPE (which means "not bound at all").
  r.use('*', async (c, next) => {
    if (c.get('projectId') === CONTROL_SCOPE) return apiError(c, 'CONTROL_SCOPE');
    await next();
  });

  // POST /requests — submit. An explicit body-size ceiling (Hono has none by default) refuses
  // an oversized body before it is parsed; over it is a VALIDATION_FAILED, same fail-closed
  // answer as the >100-items cap.
  r.post('/', bodyLimit({ maxSize: MAX_SUBMIT_BODY_BYTES, onError: (c) => apiError(c, 'VALIDATION_FAILED') }), async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;

    const parsed = SubmitBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const draft = parsed.data;

    // Idempotent resubmit: a submit carrying an `idempotencyKey` already seen for THIS
    // (project, requester) returns the request the first submit created, instead of creating a
    // duplicate. Checked BEFORE any gate so a resubmit resolves regardless of the current freeze
    // state — the request already exists. The atomic marker write below closes the concurrent
    // race; this read is the common sequential-resubmit path.
    if (draft.idempotencyKey !== undefined) {
      const mk = requestIdempotencyKey(projectId, account.id, draft.idempotencyKey);
      const marker = await store.get(mk.PK, mk.SK);
      if (marker) {
        const rk = requestKey(projectId, String(marker.requestId));
        const prior = (await store.get(rk.PK, rk.SK)) as RequestItem | null;
        if (prior) return c.json(toChangeRequest(prior, projectId), 200);
      }
    }

    // Normalize the two accepted shapes to ONE canonical item list (Phase B). A change set
    // supplies `items`; the legacy single-op shape requires all three top-level fields
    // (exactly as before). Anything else is malformed — a single-op body missing a field
    // fails here just as it failed the old required-field schema.
    const rawItems =
      draft.items ??
      (draft.operationId !== undefined && draft.targetAddress !== undefined && draft.params !== undefined
        ? [{ operationId: draft.operationId, targetAddress: draft.targetAddress, params: draft.params, replaceConfirmation: draft.replaceConfirmation }]
        : undefined);
    if (rawItems === undefined) return apiError(c, 'VALIDATION_FAILED');
    const isSet = rawItems.length > 1;

    if (await isFrozen(store, projectId)) return apiError(c, 'GLOBAL_FREEZE');

    const teams = await loadTeams(store, projectId);
    const disabled = await disabledOps(store, projectId);

    /** One item proven against every per-op submit gate, with the manifest facts pinned. */
    type ValidatedItem = {
      op: ManifestOperation;
      targetAddress: string;
      params: Record<string, unknown>;
      forcesReplace: boolean;
      replaceConfirmation?: string;
    };

    // ATOMIC validation (Phase B safety invariant): EVERY item passes the SAME per-op gates
    // the single-op path always enforced — op exists, not disabled, in the requester's team
    // scope, params within bounds, and (for a forces-replace op) a typed confirmation naming
    // that item's EXACT target. The FIRST failure rejects the WHOLE set with that item's
    // code and NOTHING is written, so a change set is all-or-nothing. A single-op request is
    // one item, so its gate sequence and error codes are byte-identical to before.
    //
    // Forces-replace confirmed-override lane (layer 1): an op that plans a destroy+recreate
    // REQUIRES the requester's explicit typed confirmation, recorded on the request, naming
    // the exact resource being replaced — a well-formedness rule (any op stays requestable),
    // bound to that item's `targetAddress` so a confirmation can never be a stray or
    // copy-pasted value for a different resource. PREVENT_DESTROY is enforced downstream
    // (executor + Terraform) and is never overridable by this confirmation.
    const validated: ValidatedItem[] = [];
    for (const it of rawItems) {
      const op = getOperation(it.operationId);
      if (!op) return apiError(c, 'VALIDATION_FAILED');
      // The direct lane is closed for the drift system ops (drift-portal spec
      // §4.3/§8 enforcement point 2b): no client can hand-craft a drift
      // request with arbitrary params — pinned proposal content (via
      // POST …/drift/proposals/:digest/submit, routes/drift.ts) is the ONLY
      // source. Checked per item so a change set can't smuggle one in either.
      if (isSystemDriftOp(op.id)) return apiError(c, 'DRIFT_PROPOSAL_REQUIRED');
      if (disabled.includes(op.id)) return apiError(c, 'OP_DISABLED');
      if (!canRequest(toUser(account, projectId), op.service, teams)) return apiError(c, 'TEAM_SCOPE');
      const bounds = validateParams(op, it.params);
      if (!bounds.ok) return apiError(c, bounds.code);
      const forcesReplace = op.forcesReplace === true;
      if (forcesReplace && it.replaceConfirmation !== it.targetAddress) {
        return apiError(c, 'REPLACE_CONFIRMATION_REQUIRED');
      }
      validated.push({
        op,
        targetAddress: it.targetAddress,
        params: it.params,
        forcesReplace,
        ...(forcesReplace ? { replaceConfirmation: it.replaceConfirmation } : {}),
      });
    }

    // Schedule + rate-limit are per-SUBMIT: ONE shared schedule and ONE shared approval for
    // the whole set, validated once (unchanged). Submit-time schedule validation rejects a
    // past/imminent `at`, fat-finger horizons, and malformed windows the shape-only
    // ScheduleSchema does not catch; `schedule` below is the NORMALIZED result.
    const scheduleResult = validateSchedule(draft.schedule, nowMs());
    if (!scheduleResult.ok) return apiError(c, scheduleResult.code);
    const schedule = scheduleResult.schedule;

    if (!(await checkSubmitRateLimit(store, projectId, account.id)).ok) return apiError(c, 'RATE_LIMITED');

    // The COMBINED review requirement is the STRICTEST across all items (tighten-only,
    // ADR-0008): the strictest exposure→tier of any item, with forces-replace floored ON if
    // ANY item is a destroy+recreate. The set is never weaker than its strictest single
    // item; a single-op request (one item) reduces to exactly the old computation. Exposure
    // NEVER gates submission — it sets the review requirement; the tier maps to the 0037
    // ladder, the single source of truth for both the count and who signs each step.
    let reviewTier: ReviewTier = 'self_service';
    let anyForcesReplace = false;
    for (const v of validated) {
      reviewTier = strictestTier(reviewTier, reviewTierFor(v.op.exposure));
      anyForcesReplace = anyForcesReplace || v.forcesReplace;
    }
    const ladder = ladderFor(reviewTier, anyForcesReplace);
    const approvalsRequired = ladder.length;
    const status = initialStatusFor(reviewTier);
    // Quorum feasibility (0021 F5/G5): can the combined ladder be completed by enough
    // distinct eligible signers (G2-filtered, requester excluded), incl. a lead for any L3
    // step? NEVER gates submission — informational; snapshotted on the row AND returned here.
    const feasibility = await computeFeasibility(store, projectId, ladder, account.id);

    const primary = validated[0]!;
    // Risk is display-only now (it no longer varies the count); the request-level risk is the
    // primary item's resolved risk, same source (per-op override + policy) as ever.
    const { risk, version: riskOverrideVersion } = await resolveRisk(store, projectId, primary.op);
    const { version: policyVersion } = await loadPolicy(store, projectId);

    // The stored `items` list — PRESENT only for a true set (≥2); a single-op request stores
    // NONE (top-level fields ARE the one item, byte-identical). Each item pins the
    // server-computed manifest facts (service/macd/exposure) and its OWN reviewTier so the
    // tighten-only re-gate can re-evaluate every item independently.
    const storedItems: RequestSetItem[] = validated.map((v) => ({
      operationId: v.op.id,
      service: v.op.service,
      macd: v.op.macd,
      targetAddress: v.targetAddress,
      params: v.params,
      exposure: v.op.exposure,
      reviewTier: reviewTierFor(v.op.exposure),
      ...(v.replaceConfirmation !== undefined ? { replaceConfirmation: v.replaceConfirmation } : {}),
    }));

    const id = ulid();
    const now = nowIso();
    const createdLabel = isSet
      ? `Requested by ${account.displayName} — ${validated.length} changes`
      : `Requested by ${account.displayName}`;
    const item: RequestItem = {
      ...requestKey(projectId, id),
      id,
      requestUlid: id,
      requester: account.id, // ALWAYS the session user — body identity is ignored
      projectId, // tag the row with its project (denormalized; the key already scopes it)
      teamId: toUser(account, projectId).teamId, // the requester's team ON this project
      // Top-level fields mirror the PRIMARY item (items[0]) so every single-op reader keeps
      // working; the request-level reviewTier/approvalsRequired hold the combined bar.
      service: primary.op.service,
      operationId: primary.op.id,
      macd: primary.op.macd,
      targetAddress: primary.targetAddress,
      params: primary.params,
      justification: draft.justification,
      exposure: primary.op.exposure,
      reviewTier,
      risk,
      status,
      approvalsRequired,
      approvals: [],
      // Single-op forces-replace records its confirmation at TOP level (byte-identical to
      // before). A set records confirmations PER ITEM (storedItems), never at top level, so
      // a stray top-level body value can never ride along.
      ...(!isSet && primary.forcesReplace ? { replaceConfirmation: primary.replaceConfirmation } : {}),
      ...(isSet ? { items: storedItems } : {}),
      schedule,
      createdAt: now,
      updatedAt: now,
      events: [
        { at: now, type: 'created', label: createdLabel, actor: account.id },
        reviewTier === 'engineer'
          ? { at: now, type: 'needs_engineer', label: 'Routed to an engineer to author and review the Terraform' }
          : { at: now, type: 'awaiting_review', label: `Awaiting ${approvalsRequired} approval${approvalsRequired > 1 ? 's' : ''}` },
      ],
      policyVersion,
      riskOverrideVersion,
      // DATA-1: born WITH the attribute its own concurrency guard compares.
      //
      // Every full-replacement write below guards on `ifEquals: {attr:'eventSeq', …}`, and
      // `ifEquals` compares the stored value to the captured one. On a row that has no
      // `eventSeq` at all, that comparison is `undefined !== undefined` — false — so the
      // guard PASSES for every concurrent writer at once. The guard existed and protected
      // nothing, for exactly the window that matters most: the FIRST pair of concurrent
      // approvals on a freshly-submitted request, before any write has bumped the counter.
      //
      // REM-1's boot stamp back-fills rows that predate the field; this is the other half,
      // so a row created after boot is never in that state either.
      eventSeq: 0,
      ...feasibility,
      GSI1PK: requestCollectionGsi(projectId),
      GSI1SK: id,
    };

    // The COMPUTED requirement is part of the evidence: exposure + tier + quorum. Audited as
    // ONE entry for the whole set (Phase B) — a single-op entry is byte-identical to before;
    // a set additionally records its item count + per-item (op, target, forces-replace ack).
    const entry: AuditEntryInput = {
      action: 'request-submit',
      actor: account.id,
      targetType: 'request',
      targetId: id,
      requestId: id,
      after: {
        status,
        approvalsRequired,
        risk,
        exposure: primary.op.exposure,
        reviewTier,
        // Evidence that a destructive override was acknowledged, and for which resource
        // (single-op — the top-level form, byte-identical to before).
        ...(!isSet && primary.forcesReplace ? { forcesReplace: true, replaceConfirmation: primary.replaceConfirmation } : {}),
        // A set records the whole ordered change: what it enacts, on what, and any per-item
        // destructive acknowledgement.
        ...(isSet
          ? {
              itemCount: validated.length,
              items: validated.map((v) => ({
                operationId: v.op.id,
                targetAddress: v.targetAddress,
                ...(v.forcesReplace ? { forcesReplace: true, replaceConfirmation: v.replaceConfirmation } : {}),
              })),
            }
          : {}),
        ...feasibility,
      },
    };
    // Persist the request (+ the idempotency marker, if a key was supplied) and its audit entry
    // as ONE atomic batch. A fresh-ULID request put never collides, so the ONLY domain
    // condition that can fail besides the chain head is the marker `ifNotExists` — a collision
    // means a concurrent/duplicate submit already created THIS set, so we return that existing
    // request (idempotent) rather than a second copy. This is why submit hand-rolls the loop
    // instead of `transactWithAudit`: it must tell a marker duplicate apart from chain
    // contention. Without a key, this is byte-identical to the previous single-write submit.
    const marker =
      draft.idempotencyKey !== undefined
        ? { ...requestIdempotencyKey(projectId, account.id, draft.idempotencyKey), requestId: id }
        : undefined;
    const hKey = chainHead(projectId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
      const { writes: auditWrites } = recordIn(projectId, head, entry);
      const domain: TransactWrite[] = [
        { kind: 'put', item, ifNotExists: true },
        ...(marker ? [{ kind: 'put' as const, item: marker, ifNotExists: true }] : []),
      ];
      try {
        await store.transact([...domain, ...auditWrites]);
        return c.json(toChangeRequest(item, projectId), 201);
      } catch (e) {
        if (e instanceof ConditionError) {
          // A duplicate submit (same key already committed) → return the existing request.
          if (marker) {
            const dup = (await store.get(marker.PK, marker.SK)) as { requestId?: unknown } | null;
            if (dup) {
              const rk = requestKey(projectId, String(dup.requestId));
              const prior = (await store.get(rk.PK, rk.SK)) as RequestItem | null;
              if (prior) return c.json(toChangeRequest(prior, projectId), 200);
            }
          }
          if (attempt === 0) continue; // else it was chain contention → retry once
          throw new ApiError('CHAIN_CONTENTION');
        }
        throw e;
      }
    }
    throw new ApiError('CHAIN_CONTENTION');
  });

  // GET /requests?scope=mine|pending|all
  r.get('/', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;
    const scope = c.req.query('scope');
    if (scope !== 'mine' && scope !== 'pending' && scope !== 'all') return apiError(c, 'VALIDATION_FAILED');

    const actingRole = roleFor(account, projectId); // role ON this project
    if ((scope === 'pending' || scope === 'all') && actingRole !== 'approver' && actingRole !== 'lead') {
      return apiError(c, 'FORBIDDEN_ROLE');
    }

    // Pagination (declared in openapi/ccp-api.yaml since the contract was written —
    // the `cursor` parameter and the response's `cursor` field were both specified
    // and neither was ever honoured, so this endpoint returned the estate's ENTIRE
    // request history in one response, forever, and grew without bound).
    //
    // Opt-in, so nothing that calls it today changes: WITHOUT `limit` the response
    // is exactly what it always was — every matching request, no cursor. WITH
    // `limit` the GSI partition is walked in chunks and the walk stops as soon as
    // the page is full, so page cost tracks the page and not the estate.
    const limRaw = Number(c.req.query('limit'));
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), MAX_LIST_PAGE) : undefined;
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && limit === undefined) return apiError(c, 'VALIDATION_FAILED', { field: 'limit' });

    const user = toUser(account, projectId);
    // The scope predicate, applied AFTER settlement — settling can change a row's
    // status, which `pending` reads.
    const matches = (x: RequestItem): boolean => {
      if (scope === 'mine') return x.requester === account.id;
      if (scope === 'all') return true;
      // pending-for-ME (0037): open, generally approvable (not mine, not already signed),
      // AND my role can sign the request's NEXT ladder step. So an approver sees a riskier
      // change only while its first step (L2) is unsigned; once L2 is signed the next step
      // is L3 (lead-only) and the approver no longer sees it as theirs.
      const { next } = ladderStateOf(x);
      return OPEN_STATUSES.has(x.status) && canApprove(user, x as never) && next !== null && canSignStep(next, actingRole);
    };

    // Lazy cooling-off + window-expiry settlement: sequential,
    // not Promise.all — concurrent transacts against the SAME per-project chain head
    // would just self-contend. Cooling settles FIRST so a request that just left
    // APPROVED_COOLING can be re-evaluated for window expiry in this SAME touch.
    //
    // Screened by the settlers' OWN synchronous preconditions so a row that needs
    // nothing costs nothing. Both settlers are already no-ops for such a row, but
    // `await`-ing a no-op still allocates a promise and yields the microtask queue
    // once per settler per row — 2N turns to do no work on a list of N. The
    // screened rows still go through the FULL cooling→window chain, because
    // settling cooling can hand a row straight into a window that has expired.
    const settleNow = nowMs();
    const settle = async (x: RequestItem): Promise<RequestItem> =>
      coolingElapsed(x, settleNow) || needsWindowSettlement(x, settleNow)
        ? settleWindow(store, projectId, await settleCooling(store, projectId, x))
        : x;

    const gsi = requestCollectionGsi(projectId);

    if (limit === undefined) {
      // Unpaged: byte-for-byte the historical response.
      const fetched = (await store.queryGSI1(gsi)) as RequestItem[];
      const items: RequestItem[] = [];
      for (const x of fetched) {
        const s = await settle(x);
        if (matches(s)) items.push(s);
      }
      return c.json({ items: items.map((x) => toChangeRequest(x, projectId)) });
    }

    // Paged. `scope=pending`/`mine` may reject most of what it reads, so the
    // partition is walked in chunks until the page fills rather than assumed to
    // yield `limit` matches per read. One extra match is collected to decide
    // `cursor` without a second pass.
    const page: RequestItem[] = [];
    let after = cursor;
    let exhausted = false;
    while (page.length <= limit && !exhausted) {
      const batch = (await store.queryGSI1(gsi, { limit: LIST_SCAN_CHUNK, ...(after !== undefined ? { after } : {}) })) as RequestItem[];
      if (batch.length < LIST_SCAN_CHUNK) exhausted = true;
      if (batch.length === 0) break;
      after = batch[batch.length - 1]!.GSI1SK ?? batch[batch.length - 1]!.id;
      for (const x of batch) {
        const s = await settle(x);
        if (matches(s)) page.push(s);
        if (page.length > limit) break;
      }
    }

    const hasMore = page.length > limit;
    if (hasMore) page.length = limit;
    const next = hasMore ? page[page.length - 1]?.id : undefined;
    return c.json({ items: page.map((x) => toChangeRequest(x, projectId)), ...(next ? { cursor: next } : {}) });
  });

  // GET /requests/:id
  r.get('/:id', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const k = requestKey(projectId, c.req.param('id'));
    let item = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!item) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);
    item = await settleCooling(store, projectId, item); // lazy cooling-off settlement
    item = await settleWindow(store, projectId, item); // lazy window-expiry settlement
    return c.json(toChangeRequest(item, projectId));
  });

  // GET /requests/:id/feasibility — LIVE-recomputed quorum feasibility.
  // Unlike the `eligibleApprovers`/`feasible`/`interimProfileWillApply` fields on the
  // ChangeRequest projection (a submit-time snapshot), this always answers "what
  // would approve() need/see RIGHT NOW" — the directory can change after submit.
  r.get('/:id/feasibility', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const k = requestKey(projectId, c.req.param('id'));
    let req = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!req) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);
    req = await settleCooling(store, projectId, req);
    req = await settleWindow(store, projectId, req);

    const { ladder, required } = currentRequirement(req);
    const feasibility = await computeFeasibility(store, projectId, ladder, req.requester);
    return c.json({
      requestId: req.id,
      status: req.status,
      approvals: req.approvals.length,
      approvalsRequired: required,
      ...feasibility,
    });
  });

  // POST /requests/:id/approve
  r.post('/:id/approve', requireRole('approver', 'lead'), async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;
    const k = requestKey(projectId, c.req.param('id'));
    const req = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!req) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);

    if (!OPEN_STATUSES.has(req.status)) return apiError(c, 'STATE_CONFLICT');
    if (req.requester === account.id) return apiError(c, 'SELF_APPROVAL');

    // Belt-and-braces: an account may only ACT as approver if
    // TOTP-enrolled. Granting role=approver/lead or isAdmin should already bump
    // sessionVersion (forcing re-login through the TOTP gate) — this refuses the
    // action outright even if that primary defense is ever bypassed or races.
    if (totpDevicesOf(account).length === 0) {
      return c.json({ code: 'TOTP_ENROLLMENT_REQUIRED', reason: 'Approval requires an enrolled authenticator on your account.' }, 403);
    }

    // Tighten-only re-gate (ADMIN-11/ADV-14): the bar can only rise, never fall. The
    // requirement is the 0037 LADDER, derived from the strictest of the pinned and live
    // tiers (a manifest re-tier toward engineer lengthens [L2]→[L2,L3]; it never
    // shortens). Shared with the G5 feasibility endpoint so the two never drift.
    const { tier, ladder } = currentRequirement(req);
    const required = ladder.length;

    // Distinct people (0037): the existing approvalKey dedup enforces that a person who
    // already signed ANY step cannot sign another — distinctness across the whole ladder.
    const aKey = approvalKey(projectId, req.requestUlid, account.id);
    if (await store.get(aKey.PK, aKey.SK)) return apiError(c, 'ALREADY_APPROVED');

    // Strict order + per-step role (0037): the NEXT unsigned step is POSITIONAL (the Nth
    // signature fills ladder[N-1]), so L3 can never be signed before L2 exists. The
    // signer's role must satisfy that next step — an approver at an L3 (final) step is
    // REFUSED outright (WRONG_APPROVAL_LEVEL), not merely insufficient. `next` is non-null
    // here: the request is OPEN, so at least one step is still unsigned.
    const next = nextLadderStep(ladder, req.approvals.length);
    if (next === null) return apiError(c, 'STATE_CONFLICT');
    if (!canSignStep(next, roleFor(account, projectId))) return apiError(c, 'WRONG_APPROVAL_LEVEL');

    const now = nowIso();
    const approvals = [...req.approvals, { user: account.id, at: now }];
    const met = approvals.length >= required;
    const stepWord = next === 'L3' ? 'final approver (L3)' : 'first approver (L2)';

    const updated: RequestItem = {
      ...req,
      // Bumped on every write so a concurrent writer's guard can detect that the row
      // moved. `eventSeq` has been in the schema since the beginning and was never used.
      eventSeq: (req.eventSeq ?? 0) + 1,
      approvals,
      approvalsRequired: required,
      reviewTier: tier, // persist the tighten-only effective tier
      updatedAt: now,
      events: [
        ...req.events,
        {
          at: now,
          type: 'approved',
          label: `Approved by ${account.displayName} as ${stepWord} (${approvals.length}/${required})`,
          actor: account.id,
        },
      ],
    };
    if (met) {
      // 0037: no interim/cooling entry point remains — a completed ladder is one (self-
      // service) or two DISTINCT signatures, never a lone approval + a 24h wait. The
      // request lands exactly where a completed change always did (ADR-0008 unchanged:
      // nothing auto-applies; the MERGED/apply pipeline is downstream).
      //
      // Eager infeasibility (0024 §2.2/E10): a windowed request whose window already
      // closed before quorum completed is a doomed wait — surfaced NOW, not after a
      // silent stall. With no cooling-off ever stamped, this only fires for a window
      // already wholly past (a slow quorum completing after close).
      //
      // `req.earliestApplyAt` is passed, not `undefined` (API-7): rewindow feeds this
      // same predicate the row's cooling-off, and a row whose cooling cannot elapse
      // before its window closes is exactly as doomed at quorum-met as it is at
      // rewindow. Feeding one call site the field and the other `undefined` meant the
      // same question got two answers.
      const infeasible = isWindowInfeasible(req.schedule, req.earliestApplyAt, nowMs());
      // Freeze vetoes the quorum-met APPLIED stamp (0024 §2.2/§2.6.1): no request may
      // RECORD an apply during a freeze. Approving itself stays allowed (paperwork, not
      // applies); only THIS status decision is gated.
      const frozenNow = !infeasible && (await isFrozen(store, projectId));

      if (infeasible) {
        updated.status = 'WINDOW_EXPIRED';
        updated.events.push({
          at: now,
          type: 'window_infeasible',
          label: 'Approval completed after the window closed — re-window needed',
        });
      } else if (frozenNow) {
        updated.status = 'AWAITING_DEPLOY_APPROVAL';
        updated.events.push({ at: now, type: 'held_frozen', label: 'Fully approved — held: a change freeze is on' });
      } else if (req.schedule.kind === 'window') {
        updated.status = 'AWAITING_DEPLOY_APPROVAL';
        updated.events.push({ at: now, type: 'scheduled', label: `Fully approved — scheduled to apply at ${req.schedule.at}` });
      } else {
        updated.status = 'APPLIED';
        updated.events.push({ at: now, type: 'applied', label: 'Fully approved — APPLIED' });
      }
    }

    const entry: AuditEntryInput = {
      action: 'request-approve',
      actor: account.id,
      targetType: 'request',
      targetId: req.id,
      requestId: req.id,
      before: { approvals: req.approvals.length, status: req.status },
      after: { approvals: approvals.length, status: updated.status, approvalsRequired: required, reviewTier: tier, step: next },
    };

    const hKey = chainHead(projectId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
      const { writes: auditWrites } = recordIn(projectId, head, entry);
      const domain: TransactWrite[] = [
        { kind: 'put', item: { ...aKey, user: account.id, at: now }, ifNotExists: true },
        // Guarded on the eventSeq this handler read. `updated` was computed from that
        // read — it carries `approvals = [...req.approvals, mine]` — so writing it
        // unconditionally overwrites any signature that landed in between, and the
        // quorum ledger silently loses an approval (CONC-1). The guard turns that
        // lost update into a refusal.
        { kind: 'put', item: updated, ifEquals: { attr: 'eventSeq', value: req.eventSeq } },
      ];
      try {
        await store.transact([...domain, ...auditWrites]);
        return c.json(toChangeRequest(updated, projectId));
      } catch (e) {
        if (e instanceof ConditionError) {
          if (await store.get(aKey.PK, aKey.SK)) return apiError(c, 'ALREADY_APPROVED'); // lost the dedupe race
          // Which condition failed? If the request row moved, `updated` is stale and
          // retrying would write exactly the corruption the guard just prevented — the
          // old code's `continue` did precisely that. Refuse instead; the client re-reads
          // and re-submits against the state that actually landed.
          const fresh = (await store.get(k.PK, k.SK)) as RequestItem | null;
          if (!fresh || fresh.eventSeq !== req.eventSeq) return apiError(c, 'STATE_CONFLICT');
          if (attempt === 0) continue; // chain contention only → retry once, still fresh
          throw new ApiError('CHAIN_CONTENTION');
        }
        throw e;
      }
    }
    throw new ApiError('CHAIN_CONTENTION');
  });

  // POST /requests/:id/reject { reason? }  (reason optional — api.ts parity)
  r.post('/:id/reject', requireRole('approver', 'lead'), async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;
    const parsed = RejectBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const k = requestKey(projectId, c.req.param('id'));
    const req = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!req) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);
    // Rejection stays open to any senior on BOTH tracks (refusal is fail-closed;
    // only approval is tier-gated).
    if (!OPEN_STATUSES.has(req.status)) return apiError(c, 'STATE_CONFLICT');
    if (req.requester === account.id) return apiError(c, 'SELF_APPROVAL');

    const now = nowIso();
    const reason = parsed.data.reason?.trim();
    const updated: RequestItem = {
      ...req,
      // Bumped on every write so a concurrent writer's guard sees the row moved (CONC-2).
      eventSeq: (req.eventSeq ?? 0) + 1,
      status: 'REJECTED',
      updatedAt: now,
      events: [
        ...req.events,
        { at: now, type: 'rejected', label: `Rejected by ${account.displayName}${reason ? ` — ${reason}` : ''}`, actor: account.id },
      ],
    };
    const entry: AuditEntryInput = {
      action: 'request-reject',
      actor: account.id,
      targetType: 'request',
      targetId: req.id,
      requestId: req.id,
      before: { status: req.status },
      after: { status: 'REJECTED' },
    };
    await transactWithAudit(
      store,
      projectId,
      // Guarded on the eventSeq this handler read: the row is a full replacement computed
      // from that read, so an unguarded put silently discards anything that landed in
      // between (CONC-2).
      [{ kind: 'put', item: updated, ifEquals: { attr: 'eventSeq', value: req.eventSeq } }],
      entry,
    );
    return c.json(toChangeRequest(updated, projectId));
  });

  // POST /requests/:id/link-pr {prUrl, prNumber?} — record the
  // fulfilling engineering PR on the request, closing the NEEDS_ENGINEER loop
  // ("did anything happen?" gets a link, and 'Authored & reviewed' stops being
  // a dead phase — 0034 §3.5). Lead-only: recording the fulfilling PR is a
  // trusted act (the engineer track's final sign-off is a lead's L3 anyway), and
  // the api has no separate engineer role. Sets the additive `prNumber`/`prUrl`
  // fields that have been
  // in the store schema (and rendered when present) since day one — this is
  // the first route that writes them. Re-linking is allowed (a wrong URL must
  // be correctable) and audited with before/after; status never changes here.
  r.post('/:id/link-pr', requireRole('lead'), async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;
    const parsed = LinkPrBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    // https-only and URL-parseable: the SPA renders this as an <a href>, so a
    // non-https scheme (javascript:, http:, file:) is refused at the source.
    let url: URL;
    try {
      url = new URL(parsed.data.prUrl);
    } catch {
      return apiError(c, 'VALIDATION_FAILED');
    }
    if (url.protocol !== 'https:') return apiError(c, 'VALIDATION_FAILED');

    const k = requestKey(projectId, c.req.param('id'));
    const req = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!req) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);
    if (PR_UNLINKABLE_STATUSES.has(req.status)) return apiError(c, 'STATE_CONFLICT');

    const prNumber = parsed.data.prNumber ?? prNumberFromUrl(parsed.data.prUrl);
    const now = nowIso();
    const updated: RequestItem = {
      ...req,
      // Bumped on every write so a concurrent writer's guard sees the row moved (CONC-2).
      eventSeq: (req.eventSeq ?? 0) + 1,
      prUrl: parsed.data.prUrl,
      updatedAt: now,
      events: [
        ...req.events,
        {
          at: now,
          type: 'pr_linked',
          label: `Engineering PR ${prNumber !== undefined ? `#${prNumber} ` : ''}linked by ${account.displayName}`,
          actor: account.id,
        },
      ],
    };
    // Never carry a stale number under a new URL: the number is set from THIS
    // link (explicit or derived) or not at all.
    if (prNumber !== undefined) updated.prNumber = prNumber;
    else delete updated.prNumber;

    const entry: AuditEntryInput = {
      action: 'request-link-pr',
      actor: account.id,
      targetType: 'request',
      targetId: req.id,
      requestId: req.id,
      before: { prNumber: req.prNumber, prUrl: req.prUrl },
      after: { prNumber: updated.prNumber, prUrl: updated.prUrl },
    };
    await transactWithAudit(
      store,
      projectId,
      // Guarded on the eventSeq this handler read: the row is a full replacement computed
      // from that read, so an unguarded put silently discards anything that landed in
      // between (CONC-2).
      [{ kind: 'put', item: updated, ifEquals: { attr: 'eventSeq', value: req.eventSeq } }],
      entry,
    );
    return c.json(toChangeRequest(updated, projectId));
  });

  // POST /requests/:id/plan-summary {resourceChanges, counts, recordedAt?, runUrl?}
  // — (visibility): CI records the structured `terraform plan`
  // summary onto the request once its PR plans, so the requester (RequestDetail)
  // and the reviewer (approvals queue) see what the change does to the LIVE estate
  // — every replace annotated with what it costs — BEFORE any apply. The approval gate
  // already guarantees nothing applies pre-approval; this is the visibility half.
  //
  // Lead-only, mirroring link-pr (the api has no separate automation role): a plan
  // summary is a TRUSTED artifact the reviewer weighs, so a plain requester or
  // approver must never be able to POST a benign-looking summary over a destructive
  // plan. The CI poster authenticates as a provisioned lead-role service identity
  // (a HUMAN provisioning step — see your deployment's own runbook for it).
  //
  // Mass-assignment-safe: the body is parsed to the summary schema and ONLY the
  // validated summary is stored — status, approvals, prNumber, events, etc. are
  // never taken from the request body (same discipline as SubmitBody stripping
  // identity). Refused on terminally-refused/withdrawn statuses; a re-plan
  // supersedes an earlier summary (idempotent overwrite). Audited before/after.
  r.post('/:id/plan-summary', requireRole('lead'), async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;
    const parsed = PlanSummarySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const k = requestKey(projectId, c.req.param('id'));
    const req = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!req) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);
    if (PLAN_SUMMARY_UNRECORDABLE_STATUSES.has(req.status)) return apiError(c, 'STATE_CONFLICT');

    const summary = parsed.data;
    const now = nowIso();
    const updated: RequestItem = {
      ...req,
      // Bumped on every write so a concurrent writer's guard sees the row moved (CONC-2).
      eventSeq: (req.eventSeq ?? 0) + 1,
      planSummary: summary,
      updatedAt: now,
      events: [
        ...req.events,
        {
          at: now,
          type: 'plan_summary',
          label: `Terraform plan recorded by ${account.displayName} — ${planCountPhrase(summary.counts)}`,
          actor: account.id,
        },
      ],
    };

    // Audit the counts delta, not the whole summary (the durable record holds
    // the full object; the chain stays small and diff-legible).
    const entry: AuditEntryInput = {
      action: 'request-plan-summary',
      actor: account.id,
      targetType: 'request',
      targetId: req.id,
      requestId: req.id,
      before: { counts: req.planSummary?.counts },
      after: { counts: summary.counts },
    };
    await transactWithAudit(
      store,
      projectId,
      // Guarded on the eventSeq this handler read: the row is a full replacement computed
      // from that read, so an unguarded put silently discards anything that landed in
      // between (CONC-2).
      [{ kind: 'put', item: updated, ifEquals: { attr: 'eventSeq', value: req.eventSeq } }],
      entry,
    );
    return c.json(toChangeRequest(updated, projectId));
  });

  // ADR-0016: statuses the bundle may act on. A cooling, terminal, or already-applied
  // request is refused here — but NOT a pre-quorum one, which is ARCH-1: this set's old
  // comment claimed "fully approved" and `AWAITING_CODE_REVIEW` **is** the pre-quorum
  // status. `initialStatusFor` puts every fresh non-engineer submission there, and the
  // approve handler moves a quorum-met request OUT of it. So the status was never the
  // quorum signal, and status alone can never be one.
  //
  // The set stays a coarse pre-filter and the real gate is the explicit approvals check in
  // the handler. `AWAITING_CODE_REVIEW` is kept because a request CAN legitimately reach
  // quorum and remain there in a multi-item ladder edge case; what must not happen is
  // applying it without checking, which is now impossible.
  const BUNDLE_ELIGIBLE = new Set(['AWAITING_CODE_REVIEW', 'AWAITING_DEPLOY_APPROVAL']);

  /** ARCH-4/ERR-2: one definition of "a live bundle claim", shared with the scheduler's
   * due filter (domain/bundle.ts). The route reads it as "is another apply already in
   * flight"; the scheduler reads it as "keep off this row". */
  const bundleClaimExpired = (bundle: RequestItem['bundle'], now: number): boolean =>
    bundle?.state === 'running' && !bundleClaimLive(bundle, now);

  // POST /requests/:id/apply — ADR-0016: the approval-to-apply bundle. One click on
  // a fully approved request runs, server-side: local gate (plan == the approved
  // change and NOTHING else) → CAS commit to main → satisfy the gated CI apply.
  // OFF BY DEFAULT: with the bundle env unset this returns BUNDLE_DISARMED and the
  // deploy is inert. Spec: docs/superpowers/specs/2026-07-20-…-apply-bundle.md.
  r.post('/:id/apply', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;

    // Arming first, from the environment alone — the cheapest, most caller-independent
    // answer there is. A deployment that never armed the bundle replies identically to
    // every caller without touching the store, which is the property that kept ARCH-2's
    // per-estate resolution (two reads, below) off the disarmed path.
    if (!bundleArmed()) return c.json({ code: 'BUNDLE_DISARMED', reason: 'The approval-to-apply bundle is not armed on this deployment (CCP_BUNDLE + git/gate/trigger config).' }, 409);

    const k = requestKey(projectId, c.req.param('id'));
    let req = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!req) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);
    req = await settleCooling(store, projectId, req);
    req = await settleWindow(store, projectId, req);

    // Senior-only, same tier as the deploy approval it satisfies (lead/admin).
    if (roleFor(account, projectId) !== 'lead' && account.isAdmin !== true) {
      return c.json({ code: 'APPLY_FORBIDDEN', reason: 'Only a Lead or admin may run the apply bundle.' }, 403);
    }
    if (await isFrozen(store, projectId)) return apiError(c, 'GLOBAL_FREEZE');
    if (!BUNDLE_ELIGIBLE.has(req.status)) return apiError(c, 'STATE_CONFLICT');

    // ARCH-1 — THE QUORUM CHECK. ADR-0016's whole premise is that the portal ladder IS the
    // human review of the change, so the bundle may only act on a request that has actually
    // completed it. The handler checked role, freeze, status and bundle state, and never
    // `approvals.length` against the ladder — so on an armed deployment a Lead or admin
    // calling this on a ZERO-APPROVAL request ran the full bundle: gate, commit to main,
    // deploy-gate trigger. The only remaining defence was whatever the operator happened to
    // wire into CCP_BUNDLE_GATE_CMD, and the shipped UNAPPROVED refusal lives in
    // `pr-prepare`, not in the documented drift-edit/plan-check gate recipe.
    //
    // `currentRequirement` is the same tighten-only helper the approve handler uses, so the
    // bar here is the live one — a tier raised after submission applies, and a request
    // approved under a laxer ladder does not sneak through on its old count.
    const { required } = currentRequirement(req);
    if (req.approvals.length < required) {
      return c.json(
        {
          code: 'STATE_CONFLICT',
          reason: `This change has ${req.approvals.length} of ${required} required approvals — the apply bundle acts only on a fully approved request.`,
        },
        409,
      );
    }
    // ERR-2: refuse only while the claim is LIVE. An expired claim belongs to a run that
    // never reported back, and taking it over here — on the very act the wedge blocks — is
    // the same lazy-settle doctrine settleCooling/settleWindow/scanJobLease already use:
    // there is no background timer in this system, and a recovery an operator has to know
    // to perform is not a recovery.
    const claimExpired = bundleClaimExpired(req.bundle, nowMs());
    if (req.bundle?.state === 'running' && !claimExpired) {
      return c.json({ code: 'BUNDLE_RUNNING', reason: 'A bundle for this request is already in flight.' }, 409);
    }
    if (req.bundle?.state === 'triggered') return apiError(c, 'STATE_CONFLICT');
    // ERR-12 — captured BEFORE the claim below overwrites `bundle`, and read from THIS
    // closure's `req`, not re-read later: the claim write only ever updates `events` on
    // the local `req` (see below), so this stays valid across it. A landed-untriggered
    // request skips prepare/gate/commit entirely and resumes from the trigger alone —
    // see `retriggerBundle`'s doc comment for why re-running the earlier steps is wrong,
    // not just wasteful.
    //
    // ALSO true for a `running` claim that has EXPIRED (claimExpired) if that claim
    // itself carries a `sha` — a crash during a PREVIOUS retrigger attempt (see the
    // claim write below, which carries `sha` forward into `running` for exactly this
    // case) leaves the row looking like an ordinary stuck claim, and losing "this was a
    // resume" here would silently fall back to a full re-run that re-attempts a commit
    // for a change already on the branch — the exact confusion this finding is about.
    const resumeSha =
      req.bundle?.state === 'landed-untriggered' || (req.bundle?.state === 'running' && claimExpired)
        ? req.bundle.sha
        : undefined;

    // Claim (idempotency guard) — CAS on `eventSeq`, which THIS WRITE ADVANCES (ERR-11).
    //
    // It used to guard on `status`, an attribute the claim does not change, so the guard
    // could not discriminate: two near-simultaneous applies both passed the read-then-act
    // pre-check above, both satisfied the status guard, and both ran full bundles — two
    // clones, two gate runs. Only git's non-fast-forward rejection stopped a double
    // landing, and the loser then recorded `bundle-failed` over the winner's `triggered`.
    //
    // Guarding on the attribute the claim itself moves is what makes it a claim. DATA-1
    // made `eventSeq` present on every row, without which this guard would be the same
    // no-op in a different place.
    const now = nowIso();
    const claimSeq = (req.eventSeq ?? 0) + 1;
    const takeoverEvent = claimExpired
      ? [{ at: now, type: 'bundle-claim-expired', label: 'A previous apply bundle never reported back — its claim expired and this attempt took it over', actor: account.id }]
      : [];
    try {
      await store.transact([
        {
          kind: 'update',
          pk: k.PK,
          sk: k.SK,
          set: {
            // ERR-12 — carry `sha` forward into the claim when this run IS a resume
            // (`resumeSha` set). Without it, a crash mid-retrigger leaves a `running`
            // claim with no memory of the landed commit, and the NEXT attempt — seeing
            // only an expired claim, not the sha behind it — would fall back to a full
            // re-run and re-attempt a commit for a change already on the branch.
            bundle: { state: 'running', at: now, ...(resumeSha !== undefined ? { sha: resumeSha } : {}) },
            updatedAt: now,
            eventSeq: claimSeq,
            ...(takeoverEvent.length > 0 ? { events: [...req.events, ...takeoverEvent] } : {}),
          },
          ifEquals: { attr: 'eventSeq', value: req.eventSeq },
        },
      ]);
    } catch (e) {
      if (e instanceof ConditionError) return apiError(c, 'STATE_CONFLICT');
      throw e;
    }
    if (takeoverEvent.length > 0) req = { ...req, events: [...req.events, ...takeoverEvent] };

    // ARCH-2 — WHICH estate's repository this run clones. The remote used to come from
    // one deployment-global `CCP_GIT_REMOTE` regardless of the acting project, so the
    // moment a second estate was onboarded an armed deployment cloned estate A's repo
    // for estate B's requests. The registry has stored each project's repo all along.
    //
    // Resolved HERE — after role, freeze, status and quorum — so a caller who is not
    // entitled to run a bundle never causes a registry read, and the disarmed answer
    // above stays store-free.
    const pk = projectKey(projectId);
    const project = (await store.get(pk.PK, pk.SK)) as ProjectItem | null;
    // A project row that has vanished is not a licence to clone somebody else's repo:
    // it resolves as "registers nothing", which the CCP_GIT_PROJECT pin then refuses.
    const laneProject: LaneProject = project ?? { id: projectId };
    const extraHosts = ((await resolveKnob(store, 'scanner.forgeHosts')).value ?? []) as string[];
    const cfg = bundleConfig(process.env, laneProject, extraHosts);
    if (!cfg) {
      // Armed (checked above) and still no config ⇒ the remote is what failed, for THIS
      // estate. Reporting that as "disarmed" is what made the cross-estate clone
      // invisible: the operator would go looking at flags that were set correctly.
      const remote = resolveLaneRemote(laneProject, process.env, extraHosts);
      return c.json(
        { code: 'BUNDLE_REPO_UNRESOLVED', reason: `The apply bundle cannot resolve a repository for this estate: ${remote.ok ? 'unknown' : remote.detail}` },
        409,
      );
    }

    // The bundle itself (gate → CAS commit → trigger). Never terraform apply here.
    //
    // CONC-6 — `runBundle` is TOTAL: it reports a failed run rather than throwing, so
    // there is always an outcome to write a terminal state from (see domain/bundle.ts).
    // This catch is defence in depth for everything OUTSIDE it — payload serialisation,
    // building `realSteps` — because the one thing this handler must never do is return
    // while the row still carries the `running` claim it just wrote. Before this, a throw
    // anywhere in here escaped to the error handler as a 500 and left the claim behind;
    // nothing in this system clears a stuck claim on the row's behalf, so one throw
    // blocked one-click apply for that request until ERR-2's lease aged it out an hour
    // later — and before ERR-2, forever.
    let outcome: BundleOutcome;
    try {
      // ERR-12 — a landed-untriggered resume skips prepare/gate/commit and fires the
      // trigger alone for the sha a PREVIOUS run already landed. `resumeSha` can only be
      // set here if `req.bundle.state` really was 'landed-untriggered' a moment ago (see
      // where it is captured, above) — the `undefined` arm is unreachable in practice and
      // exists only so a future refactor cannot make this branch on an ambient string.
      outcome = resumeSha !== undefined
        ? await retriggerBundle(realSteps(cfg), resumeSha)
        : await runBundle(
            realSteps(cfg),
            JSON.stringify(bundleRequestPayload(req, projectId)),
            `ccp: apply request ${req.id} (${req.operationId} on ${req.targetAddress})\n\nApproved in the portal (ADR-0016 bundle); plan gated + digest-pinned.\nRequested-by: ${req.requester}; bundle-run-by: ${account.id}`,
          );
    } catch (e) {
      outcome = {
        ok: false,
        steps: [{ step: resumeSha !== undefined ? 'trigger' : 'prepare', ok: false, detail: `the apply bundle threw before reporting an outcome: ${e instanceof Error ? e.message : String(e)}` }],
        ...(resumeSha !== undefined ? { sha: resumeSha } : {}),
      };
    }

    const done = nowIso();
    // ERR-12 — a failed run that nonetheless has `outcome.sha` means commit succeeded and
    // something after it (trigger, or a throw at/after that point) did not: the change IS
    // on `main`. That is 'landed-untriggered', not 'failed' — the distinction a retry
    // needs to skip straight back to the trigger step instead of re-attempting a commit
    // that can now only fail (the change is already there).
    const bundle = outcome.ok
      ? { state: 'triggered' as const, sha: outcome.sha, at: done }
      : outcome.sha !== undefined
        ? { state: 'landed-untriggered' as const, sha: outcome.sha, at: done }
        : { state: 'failed' as const, at: done };
    const outcomeEvent = {
      at: done,
      type: outcome.ok ? 'bundle-triggered' : bundle.state === 'landed-untriggered' ? 'bundle-landed-untriggered' : 'bundle-failed',
      label: outcome.ok
        ? `Apply bundle landed ${outcome.sha?.slice(0, 9)} and satisfied the deploy gate`
        : bundle.state === 'landed-untriggered'
          ? `Apply bundle landed ${outcome.sha?.slice(0, 9)} on main but the deploy-gate trigger failed — retry will resume from the trigger, not re-commit`
          : `Apply bundle failed at ${outcome.steps.find((s) => !s.ok)?.step ?? '?'}`,
      actor: account.id,
    };

    /**
     * One chained audit entry carrying the full per-step evidence (gate output tail,
     * landed SHA, trigger result) — the bundle's audit trail of record.
     *
     * `live` is the row as it is at the moment of writing, not the pre-image this handler
     * read minutes ago: recording `before`/`after` from a stale snapshot would describe a
     * request that no longer exists. `reachedRow` says whether the request row itself
     * took the transition, which is the one thing a reader of this chain cannot otherwise
     * work out (CONC-6).
     */
    const outcomeEntry = (live: RequestItem | null, reachedRow: boolean): AuditEntryInput => ({
      action: 'request-bundle',
      actor: account.id,
      targetType: 'request',
      targetId: req.id,
      requestId: req.id,
      before: { status: req.status, bundle: req.bundle ?? null },
      // ARCH-2 — WHICH estate's repository this run acted on, in the audit trail of
      // record. The cross-estate clone was possible for years because the answer lived
      // only in one process's environment; a reader of this chain could not have told
      // that a request for estate B landed in estate A's repo.
      after: {
        status: live?.status ?? req.status,
        bundle,
        steps: outcome.steps,
        remote: { source: cfg.remoteSource, detail: cfg.remoteDetail, branch: cfg.branch },
        ...(reachedRow
          ? {}
          : {
              requestRowUpdated: false,
              note: 'this outcome was recorded on its own, because it could not be written together with the request row — the steps above are what actually executed, whatever the request row now says',
            }),
      },
    });

    // ── recording the outcome (CONC-6) ──────────────────────────────────────────
    //
    // Two facts, and they are NOT the same kind of fact:
    //
    //   * the REQUEST ROW's bundle state is a STATE TRANSITION. It may legitimately lose
    //     to a concurrent writer, and forcing it would overwrite that writer.
    //   * the AUDIT ENTRY records that a deploy FIRED. A gate ran, a commit landed on
    //     `main`, a CI apply was triggered. Nothing a later writer does makes any of that
    //     untrue, so it must not be conditional on the row's guard.
    //
    // The old loop coupled them into one transact and, on a lost guard, retried with the
    // SAME stale guard — which for a row that really has moved can never succeed — then
    // threw CHAIN_CONTENTION. The trigger had already fired and the chain recorded
    // NOTHING AT ALL: a live deploy in flight with no evidence anywhere that it existed.
    const hKey = chainHead(projectId);
    const OUTCOME_ATTEMPTS = 3;

    /**
     * Does the row still carry THIS run's claim? `bundle.at` is the claim's identity: a
     * takeover (ERR-2) writes a new one, and this run's outcome must never land on top of
     * a later run's claim — that would report one bundle's result as another's.
     */
    const claimIsMine = (row: RequestItem | null): boolean =>
      row?.bundle?.state === 'running' && row.bundle.at === now;

    let recordedRow = false;
    let claimLost = false;
    for (let attempt = 0; attempt < OUTCOME_ATTEMPTS && !recordedRow; attempt++) {
      // Re-read on EVERY attempt, and re-derive everything from what is read. `events` is
      // a full-array replacement, so deriving it once from the pre-image silently erases
      // whatever landed while the bundle ran — a cancel's own timeline entry, a window
      // settling. The outcome is APPENDED to the timeline as it actually is, never
      // written over it.
      const live = (await store.get(k.PK, k.SK)) as RequestItem | null;
      if (!claimIsMine(live)) {
        claimLost = true;
        break;
      }
      const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
      const { writes } = recordIn(projectId, head, outcomeEntry(live, true));
      try {
        await store.transact([
          {
            kind: 'update',
            pk: k.PK,
            sk: k.SK,
            set: {
              bundle,
              updatedAt: done,
              events: [...live!.events, outcomeEvent],
              eventSeq: (live!.eventSeq ?? 0) + 1,
            },
            // Guarded on the seq read THIS iteration, not on the one the claim wrote:
            // "nothing moved since I looked a moment ago". Ownership of the run is
            // established separately and explicitly by `claimIsMine` above, so the guard
            // no longer has to carry both meanings — which is what made a lost race
            // unrecoverable rather than merely worth re-reading.
            ifEquals: { attr: 'eventSeq', value: live!.eventSeq },
          },
          ...writes,
        ]);
        recordedRow = true;
      } catch (e) {
        if (!(e instanceof ConditionError)) throw e;
        // Either the row moved or the chain head did. Both are answered by going round
        // again with FRESH reads — never by retrying a stale guard.
      }
    }

    if (!recordedRow) {
      // The transition could not be attached to the request row. The deploy still fired,
      // so the chain still gets the entry — marked as not having reached the row.
      let recordedAudit = false;
      for (let attempt = 0; attempt < OUTCOME_ATTEMPTS && !recordedAudit; attempt++) {
        const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
        const live = (await store.get(k.PK, k.SK)) as RequestItem | null;
        const { writes } = recordIn(projectId, head, outcomeEntry(live, false));
        try {
          await store.transact(writes);
          recordedAudit = true;
        } catch (e) {
          if (!(e instanceof ConditionError)) throw e;
        }
      }
      if (!recordedAudit) throw new ApiError('CHAIN_CONTENTION');

      // The claim can only still be ours if what defeated the combined write was the
      // CHAIN, not the row. Release it to its terminal state so a transient chain jam
      // cannot leave a fully-approved request wedged at `running` for the length of
      // ERR-2's lease — the wedge is the defect, and the lease is a backstop for crashes,
      // not a substitute for releasing a claim this handler is still holding. Row only:
      // the audit entry for this exact outcome landed a moment ago, so this write carries
      // no fact the chain does not already have.
      if (!claimLost) {
        const live = (await store.get(k.PK, k.SK)) as RequestItem | null;
        if (claimIsMine(live)) {
          try {
            await store.transact([
              {
                kind: 'update',
                pk: k.PK,
                sk: k.SK,
                set: { bundle, updatedAt: done, events: [...live!.events, outcomeEvent], eventSeq: (live!.eventSeq ?? 0) + 1 },
                ifEquals: { attr: 'eventSeq', value: live!.eventSeq },
              },
            ]);
          } catch (e) {
            // Lost again ⇒ somebody else now owns the row; the lease covers it.
            if (!(e instanceof ConditionError)) throw e;
          }
        }
      }

      // A SPECIFIC code, carrying the evidence. `CHAIN_CONTENTION` said "the chain is
      // busy, please retry" about a deploy that had already fired — an answer that is
      // both wrong and dangerous to act on, since retrying re-runs the whole bundle.
      return c.json(
        {
          code: 'BUNDLE_OUTCOME_CONTENDED',
          reason: claimLost
            ? 'The bundle ran, but this request moved on while it was running (its claim was taken over or the row changed), so its bundle state was not updated. The full outcome is recorded in the audit chain — read it before re-running anything.'
            : 'The bundle ran, but the audit chain was too busy to attach the outcome to this request. The full outcome is recorded in the audit chain — read it before re-running anything.',
          details: { bundle, steps: outcome.steps },
        },
        409,
      );
    }

    return c.json({ ok: outcome.ok, status: req.status, bundle, steps: outcome.steps }, outcome.ok ? 200 : 502);
  });

  // POST /requests/:id/cancel — the cooling-off cancel verb,
  // WIDENED to every "approved but unapplied" status —
  // CANCELLABLE_STATUSES, table-driven. An open pre-quorum request or any terminal
  // state is still refused. Authz UNCHANGED: the requester (withdrawing
  // their own change) OR a Lead/admin (senior override) — a plain approver who is
  // neither is refused, same as SELF_APPROVAL is refused to a non-senior elsewhere.
  r.post('/:id/cancel', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;
    const k = requestKey(projectId, c.req.param('id'));
    let req = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!req) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);

    // Settle first: a cooling window that already elapsed (→ APPLIED/AWAITING_
    // DEPLOY_APPROVAL) or a maintenance window that already closed (→
    // WINDOW_EXPIRED, itself STILL cancellable) is reflected before the state
    // check, even if nobody has read this request since it was approved (no
    // background timer).
    req = await settleCooling(store, projectId, req);
    req = await settleWindow(store, projectId, req);
    if (!CANCELLABLE_STATUSES.has(req.status)) return apiError(c, 'STATE_CONFLICT');

    // API-5 — `AWAITING_DEPLOY_APPROVAL` is cancellable, and the bundle claim (API-4)
    // leaves `status` untouched, so a cancel issued while a bundle is mid-flight used to
    // succeed unconditionally: the bundle would go on to land the commit and fire the CI
    // apply trigger AFTER the request was already recorded CANCELLED. Refused, not merely
    // confirmed — the finding's own two options — because a lead clicking cancel on a
    // request that is actively, irreversibly landing a change on `main` needs the current
    // truth ("this is applying right now"), not a chance to click through a confirmation
    // dialog built from the same stale status this defect is about. Same claim-liveness
    // rule the /apply route uses (ERR-2): an EXPIRED claim belongs to a run that crashed
    // and never reported back, and refusing cancel on ITS behalf would wedge the request
    // exactly the way a stuck claim already did before API-4/CONC-6 — so only a LIVE
    // claim blocks the cancel; an expired one does not.
    if (req.bundle?.state === 'running' && !bundleClaimExpired(req.bundle, nowMs())) {
      return c.json({ code: 'BUNDLE_RUNNING', reason: 'The apply bundle for this request is in flight — it cannot be cancelled until it finishes.' }, 409);
    }

    const isOwner = req.requester === account.id;
    const isSeniorOverride = roleFor(account, projectId) === 'lead' || account.isAdmin === true;
    if (!isOwner && !isSeniorOverride) {
      return c.json({ code: 'CANCEL_FORBIDDEN', reason: 'Only the requester or a Lead/admin may cancel this request.' }, 403);
    }

    const now = nowIso();
    const label =
      req.status === 'APPROVED_COOLING'
        ? `Cancelled by ${account.displayName} during the cooling-off window`
        : `Cancelled by ${account.displayName}`;
    const events = [...req.events, { at: now, type: 'cancelled', label, actor: account.id }];
    const entry: AuditEntryInput = {
      action: 'request-cancel',
      actor: account.id,
      targetType: 'request',
      targetId: req.id,
      requestId: req.id,
      before: { status: req.status },
      after: { status: 'CANCELLED' },
    };

    // Guard on the OBSERVED status (whichever of CANCELLABLE_STATUSES it settled
    // to above), not a fixed literal — `ifEquals` supports one exact value, and
    // this verb now has more than one valid prior status.
    const priorStatus = req.status;
    const hKey = chainHead(projectId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
      const { writes } = recordIn(projectId, head, entry);
      const domain: TransactWrite[] = [
        { kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'CANCELLED', updatedAt: now, events }, ifEquals: { attr: 'status', value: priorStatus } },
      ];
      try {
        await store.transact([...domain, ...writes]);
        return c.json(toChangeRequest({ ...req, status: 'CANCELLED', updatedAt: now, events }, projectId));
      } catch (e) {
        if (e instanceof ConditionError) {
          // Idempotent-safe: a losing race (a concurrent cancel/rewindow, or a
          // window elapsing and settling underneath us) is reported honestly,
          // never double-applied.
          if (attempt === 0) {
            const fresh = (await store.get(k.PK, k.SK)) as RequestItem | null;
            if (fresh && fresh.status !== priorStatus) return apiError(c, 'STATE_CONFLICT');
            continue; // else it was chain contention (a DIFFERENT request) → retry once
          }
          throw new ApiError('CHAIN_CONTENTION');
        }
        throw e;
      }
    }
    throw new ApiError('CHAIN_CONTENTION');
  });

  // POST /requests/:id/rewindow {at, endAt?} — Exits WINDOW_EXPIRED (the
  // main reason it exists) and re-times an AWAITING_DEPLOY_APPROVAL request BEFORE
  // its window opens (never during — "moving the goalposts mid-window is how you
  // get an apply that was in-window at dispatch and out-of-window on paper"; cancel
  // is the verb for during-window stops instead). Approvals SURVIVE unmoved: the
  // quorum is bound to the plan digest, never the wall-clock (digest-reverify at
  // merge re-proves it) — only `schedule` and `status` change here.
  r.post('/:id/rewindow', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;
    const parsed = RewindowBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const k = requestKey(projectId, c.req.param('id'));
    let req = (await store.get(k.PK, k.SK)) as RequestItem | null;
    if (!req) return c.json({ code: 'NOT_FOUND', reason: 'No such request.' }, 404);

    req = await settleCooling(store, projectId, req);
    req = await settleWindow(store, projectId, req);

    // Valid state: WINDOW_EXPIRED (any time), or AWAITING_DEPLOY_APPROVAL with a
    // window that has NOT yet opened. A schedule.kind:'now' row (a freeze-held
    // request) has no window to move — refused, same as everything else
    // outside this verb's remit.
    if (req.schedule.kind !== 'window') return apiError(c, 'STATE_CONFLICT');
    if (req.status !== 'WINDOW_EXPIRED') {
      if (req.status !== 'AWAITING_DEPLOY_APPROVAL') return apiError(c, 'STATE_CONFLICT');
      const reasons = applyGate(req, false, nowMs()).reasons; // frozen is irrelevant to "is it currently open"
      const stillClosed = reasons.includes('BEFORE_WINDOW') || reasons.includes('COOLING');
      if (!stillClosed) return apiError(c, 'STATE_CONFLICT'); // currently open — refuse, don't move the goalposts mid-window
    }

    const isOwner = req.requester === account.id;
    const isSeniorOverride = roleFor(account, projectId) === 'lead' || account.isAdmin === true;
    if (!isOwner && !isSeniorOverride) {
      return c.json({ code: 'REWINDOW_FORBIDDEN', reason: 'Only the requester or a Lead/admin may re-window this request.' }, 403);
    }

    // Staleness: a digest guard proves the PLAN didn't drift, not that
    // the WORLD didn't — a month-old approval re-aimed at a new window must go back
    // through the humans instead. No approvals yet (still pre-quorum somehow, or a
    // legacy row) never triggers this.
    const lastApprovalAt = req.approvals.at(-1)?.at;
    if (lastApprovalAt !== undefined && nowMs() - Date.parse(lastApprovalAt) > REWINDOW_STALE_MS) {
      return apiError(c, 'SCHEDULE_STALE_APPROVAL');
    }

    const validated = validateSchedule({ kind: 'window', at: parsed.data.at, endAt: parsed.data.endAt }, nowMs());
    if (!validated.ok) return apiError(c, validated.code);
    const newSchedule = validated.schedule;
    // Refuse re-arming an equally-doomed window (the SAME eager check quorum-met
    // uses, E10) — never accept a rewindow that can only leave WINDOW_EXPIRED again.
    if (isWindowInfeasible(newSchedule, req.earliestApplyAt, nowMs())) {
      return apiError(c, 'SCHEDULE_INVALID', { reason: 'cooling-off would not elapse before this window closes' });
    }

    const now = nowIso();
    const oldAt = req.schedule.at;
    const newAt = newSchedule.kind === 'window' ? newSchedule.at : '';
    const priorStatus = req.status;
    const events = [
      ...req.events,
      { at: now, type: 'rewindowed', label: `Re-windowed by ${account.displayName}: ${oldAt} → ${newAt}`, actor: account.id },
    ];
    const updated: RequestItem = { ...req, schedule: newSchedule, status: 'AWAITING_DEPLOY_APPROVAL', updatedAt: now, events };
    const entry: AuditEntryInput = {
      action: 'request-rewindow',
      actor: account.id,
      targetType: 'request',
      targetId: req.id,
      requestId: req.id,
      before: { status: priorStatus, schedule: req.schedule },
      after: { status: 'AWAITING_DEPLOY_APPROVAL', schedule: newSchedule },
    };

    const hKey = chainHead(projectId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
      const { writes } = recordIn(projectId, head, entry);
      const domain: TransactWrite[] = [
        {
          kind: 'update',
          pk: k.PK,
          sk: k.SK,
          set: { schedule: newSchedule, status: 'AWAITING_DEPLOY_APPROVAL', updatedAt: now, events },
          ifEquals: { attr: 'status', value: priorStatus },
        },
      ];
      try {
        await store.transact([...domain, ...writes]);
        return c.json(toChangeRequest(updated, projectId));
      } catch (e) {
        if (e instanceof ConditionError) {
          if (attempt === 0) {
            const fresh = (await store.get(k.PK, k.SK)) as RequestItem | null;
            if (fresh && fresh.status !== priorStatus) return apiError(c, 'STATE_CONFLICT');
            continue; // else it was chain contention (a DIFFERENT request) → retry once
          }
          throw new ApiError('CHAIN_CONTENTION');
        }
        throw e;
      }
    }
    throw new ApiError('CHAIN_CONTENTION');
  });

  return r;
}
