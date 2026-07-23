import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { ulid } from 'ulid';
import { canApprove, canRequest } from '@app-lib/permissions';
import { PlanSummarySchema, type PlanCounts } from '../store/planSummarySchema';
import { initialStatusFor, ladderFor, nextLadderStep, reviewTierFor, strictestTier, tierOf, type LadderStep, type ReviewTier } from '../domain/exposure';
import type { AppEnv } from '../appEnv';
import type { ChainHeadItem, RequestItem, RequestSetItem } from '../store/schema';
import { approvalKey, chainHead, requestCollectionGsi, requestIdempotencyKey, requestKey } from '../store/schema';
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
import { bundleConfig, realSteps, runBundle } from '../domain/bundle';
import { settleCooling } from '../domain/cooling';
import { canSignStep } from '../domain/eligibility';
import { totpDevicesOf } from '../auth/totp';
import { computeFeasibility } from '../domain/feasibility';
import { currentRequirement } from '../domain/requirement';
import { applyGate, isWindowInfeasible, REWINDOW_STALE_MS, settleWindow, validateSchedule } from '../domain/schedule';
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
const CANCELLABLE_STATUSES = new Set(['APPROVED_COOLING', 'AWAITING_DEPLOY_APPROVAL', 'WINDOW_EXPIRED']);
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

/** The PR number from a `/pull/123`-shaped URL tail, or undefined. Assumes the
 * URL already parsed (the route validates that before calling this). */
function prNumberFromUrl(prUrl: string): number | undefined {
  const m = /\/(\d{1,9})\/?$/.exec(new URL(prUrl).pathname);
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
export function toChangeRequest(item: RequestItem, projectId: string): Record<string, unknown> {
  const { PK, SK, GSI1PK, GSI1SK, requestUlid, eventSeq, riskOverrideVersion, ...rest } = item;
  void PK;
  void SK;
  void GSI1PK;
  void GSI1SK;
  void requestUlid;
  void eventSeq;
  void riskOverrideVersion;
  const { ladder, next } = ladderStateOf(item);
  return { ...rest, projectId: item.projectId ?? projectId, approvalLadder: ladder, nextApprovalStep: next };
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

    const fetched = (await store.queryGSI1(requestCollectionGsi(projectId))) as RequestItem[];
    // Lazy cooling-off + window-expiry settlement: sequential,
    // not Promise.all — concurrent transacts against the SAME per-project chain head
    // would just self-contend. Cooling settles FIRST so a request that just left
    // APPROVED_COOLING can be re-evaluated for window expiry in this SAME touch.
    const all: RequestItem[] = [];
    for (const x of fetched) all.push(await settleWindow(store, projectId, await settleCooling(store, projectId, x)));
    const user = toUser(account, projectId);
    let items: RequestItem[];
    if (scope === 'mine') items = all.filter((x) => x.requester === account.id);
    else if (scope === 'pending')
      // pending-for-ME (0037): open, generally approvable (not mine, not already signed),
      // AND my role can sign the request's NEXT ladder step. So an approver sees a riskier
      // change only while its first step (L2) is unsigned; once L2 is signed the next step
      // is L3 (lead-only) and the approver no longer sees it as theirs.
      items = all.filter((x) => {
        const { next } = ladderStateOf(x);
        return OPEN_STATUSES.has(x.status) && canApprove(user, x as never) && next !== null && canSignStep(next, actingRole);
      });
    else items = all;

    return c.json({ items: items.map((x) => toChangeRequest(x, projectId)) });
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
      const infeasible = isWindowInfeasible(req.schedule, undefined, nowMs());
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
        { kind: 'put', item: updated },
      ];
      try {
        await store.transact([...domain, ...auditWrites]);
        return c.json(toChangeRequest(updated, projectId));
      } catch (e) {
        if (e instanceof ConditionError) {
          if (await store.get(aKey.PK, aKey.SK)) return apiError(c, 'ALREADY_APPROVED'); // lost the dedupe race
          if (attempt === 0) continue; // chain contention → retry once
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
    await transactWithAudit(store, projectId, [{ kind: 'put', item: updated }], entry);
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
    await transactWithAudit(store, projectId, [{ kind: 'put', item: updated }], entry);
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
    await transactWithAudit(store, projectId, [{ kind: 'put', item: updated }], entry);
    return c.json(toChangeRequest(updated, projectId));
  });

  // ADR-0016: statuses the bundle may act on — fully approved, unapplied. A
  // pre-quorum, cooling, terminal, or already-applied request is refused.
  const BUNDLE_ELIGIBLE = new Set(['AWAITING_CODE_REVIEW', 'AWAITING_DEPLOY_APPROVAL']);

  // POST /requests/:id/apply — ADR-0016: the approval-to-apply bundle. One click on
  // a fully approved request runs, server-side: local gate (plan == the approved
  // change and NOTHING else) → CAS commit to main → satisfy the gated CI apply.
  // OFF BY DEFAULT: with the bundle env unset this returns BUNDLE_DISARMED and the
  // deploy is inert. Spec: docs/superpowers/specs/2026-07-20-…-apply-bundle.md.
  r.post('/:id/apply', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const account = c.get('account')!;
    const cfg = bundleConfig();
    if (!cfg) return c.json({ code: 'BUNDLE_DISARMED', reason: 'The approval-to-apply bundle is not armed on this deployment (CCP_BUNDLE + git/gate/trigger config).' }, 409);

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
    if (req.bundle?.state === 'running') return c.json({ code: 'BUNDLE_RUNNING', reason: 'A bundle for this request is already in flight.' }, 409);
    if (req.bundle?.state === 'triggered') return apiError(c, 'STATE_CONFLICT');

    // Claim (idempotency guard) — CAS on the observed status; a lost race means a
    // concurrent bundle/cancel/settle won, and we report it rather than double-run.
    const now = nowIso();
    try {
      await store.transact([
        { kind: 'update', pk: k.PK, sk: k.SK, set: { bundle: { state: 'running', at: now }, updatedAt: now }, ifEquals: { attr: 'status', value: req.status } },
      ]);
    } catch (e) {
      if (e instanceof ConditionError) return apiError(c, 'STATE_CONFLICT');
      throw e;
    }

    // The bundle itself (gate → CAS commit → trigger). Never terraform apply here.
    const outcome = runBundle(
      realSteps(cfg),
      JSON.stringify(bundleRequestPayload(req, projectId)),
      `ccp: apply request ${req.id} (${req.operationId} on ${req.targetAddress})\n\nApproved in the portal (ADR-0016 bundle); plan gated + digest-pinned.\nRequested-by: ${req.requester}; bundle-run-by: ${account.id}`,
    );

    const done = nowIso();
    const bundle = outcome.ok ? { state: 'triggered' as const, sha: outcome.sha, at: done } : { state: 'failed' as const, at: done };
    const events = [
      ...req.events,
      { at: done, type: outcome.ok ? 'bundle-triggered' : 'bundle-failed', label: outcome.ok ? `Apply bundle landed ${outcome.sha?.slice(0, 9)} and satisfied the deploy gate` : `Apply bundle failed at ${outcome.steps.find((s) => !s.ok)?.step ?? '?'}`, actor: account.id },
    ];
    // One chained audit entry carrying the full per-step evidence (gate output tail,
    // landed SHA, trigger result) — the bundle's audit trail of record.
    const entry: AuditEntryInput = {
      action: 'request-bundle',
      actor: account.id,
      targetType: 'request',
      targetId: req.id,
      requestId: req.id,
      before: { status: req.status, bundle: req.bundle ?? null },
      after: { status: req.status, bundle, steps: outcome.steps },
    };
    const hKey = chainHead(projectId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
      const { writes } = recordIn(projectId, head, entry);
      try {
        await store.transact([
          { kind: 'update', pk: k.PK, sk: k.SK, set: { bundle, updatedAt: done, events }, ifEquals: { attr: 'status', value: req.status } },
          ...writes,
        ]);
        break;
      } catch (e) {
        if (e instanceof ConditionError && attempt === 0) continue; // chain contention → retry once
        if (e instanceof ConditionError) throw new ApiError('CHAIN_CONTENTION');
        throw e;
      }
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
