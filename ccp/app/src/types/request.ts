import type { Macd, Exposure, RiskFloor } from './manifest';
import type { PlanSummary } from '@/types/planSummary';

export type RequestStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'GENERATING'
  | 'CHECKS_RUNNING'
  | 'PLAN_READY'
  | 'AWAITING_CODE_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'CODE_APPROVED'
  | 'MERGED'
  | 'AWAITING_DEPLOY_APPROVAL'
  | 'APPLYING'
  | 'APPLIED'
  | 'NOOP'
  | 'APPLY_FAILED'
  | 'DIGEST_MISMATCH'
  | 'REJECTED'
  | 'NEEDS_ENGINEER'
  | 'WITHDRAWN'
  /**
   * Interim-profile cooling-off (api-mode only — the mock
   * has no cooling state machine and never produces this). Interim quorum
   * (fewer eligible approvers than required) was met, but the change does
   * not go live until `earliestApplyAt`; settles LAZILY to APPLIED or
   * AWAITING_DEPLOY_APPROVAL server-side on the next read/mutation (no
   * background timer). Cancellable during the window via POST
   * /requests/:id/cancel.
   */
  | 'APPROVED_COOLING'
  /** Cancelled during the APPROVED_COOLING window, or during/after a
   * maintenance window (api-mode only) — by the requester or a Lead/admin. */
  | 'CANCELLED'
  /**
   * (api-mode only — the mock has no window enforcement and
   * never produces this, same "no mock equivalent" posture as
   * APPROVED_COOLING). A maintenance window closed with no apply, either
   * lazily (the next read after `windowEndOf(schedule)` passes — no
   * background timer) or eagerly at quorum-met when already infeasible
   * (a cooling-off that would outlast its own window, or a window
   * already wholly past). Parked, not terminal: exits are
   * POST /requests/:id/rewindow and POST /requests/:id/cancel.
   */
  | 'WINDOW_EXPIRED';

export interface RequestEvent {
  at: string;
  type: string;
  label: string;
  actor?: string;
}

/**
 * When an approved change should apply. Schedule v2: `endAt` is
 * always stamped server-side for a fresh submit/rewindow (explicit, or
 * `at + 4h` default) — optional in the TYPE only because rows written before
 * this design omit it (`lib/httpApi.ts`'s `ChangeRequest` mapping carries
 * whatever the server sends verbatim; legacy rows simply lack the field).
 */
export type Schedule = { kind: 'now' } | { kind: 'window'; at: string; endAt?: string };

/** One recorded approval on a request. */
export interface Approval {
  user: string;
  at: string;
}

/**
 * A step in the two-level approval ladder. PURE TYPE — no zod, so it stays safe on the
 * api-reachable `@app-lib` path (the api typechecks these types with only its own
 * node_modules; a value import of zod here would collapse the whole request type to
 * `unknown`). L2 = a first approver (approver or lead); L3 = a final approver (lead only).
 * The runtime source of truth is the api's domain/exposure.ts#ladderFor.
 */
export type ApprovalStep = 'L2' | 'L3';

/**
 * One operation inside a multi-operation CHANGE SET (Phase B). A request may enact several
 * operations as ONE reviewed change — a multi-edit on one resource, or one action fanned
 * across many targets — sharing one justification + schedule + approval. The client submits
 * only the intent per item (`operationId`/`targetAddress`/`params`, plus a forces-replace
 * `replaceConfirmation`); the server computes and pins `service`/`macd`/`exposure`/
 * `reviewTier` per item and returns them on the read projection. PURE TYPE — no zod, so it
 * stays safe on the api-reachable `@app-lib`/`@/types` path.
 */
export interface ChangeSetItem {
  operationId: string;
  service?: string;
  macd?: Macd;
  targetAddress: string;
  params: Record<string, unknown>;
  exposure?: Exposure;
  reviewTier?: 'self_service' | 'guardrails' | 'engineer';
  /** The typed destroy+recreate acknowledgement for a forces-replace item — must equal
   * this item's `targetAddress` (server-enforced per item; never replayed onto another). */
  replaceConfirmation?: string;
}

/** The identity-free payload the client submits for a change set: only the per-item intent
 * plus the ONE shared justification + schedule. Everything server-authoritative
 * (requester/tier/status/approvals/the combined requirement) is computed, never sent. */
export interface ChangeSetDraft {
  items: Array<Pick<ChangeSetItem, 'operationId' | 'targetAddress' | 'params' | 'replaceConfirmation'>>;
  justification: string;
  schedule: Schedule;
}

export interface ChangeRequest {
  id: string;
  requester: string;
  /**
   * The project this request belongs to (api-mode only — the server tags every new
   * submit and injects it for legacy rows from the storage key). Additive + optional:
   * the mock never sets it and existing single-project readers ignore it. The per-project
   * client that consumes this lands in a later lane; nothing in the app reads it yet.
   */
  projectId?: string;
  service: string;
  operationId: string;
  macd: Macd;
  targetAddress: string;
  params: Record<string, unknown>;
  justification: string;
  exposure: Exposure;
  risk: RiskFloor;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  prNumber?: number;
  prUrl?: string;
  /**
   * The structured `terraform plan` summary CI records once the request's PR
   * plans (POST /requests/:id/plan-summary, the same additive
   * lane as prNumber/prUrl). Rendered by PlanSummaryPanel on RequestDetail and
   * the approvals queue; absent until the plan job runs (the UI shows an
   * honest pending note, never a fake).
   */
  planSummary?: PlanSummary;
  /**
   * Forces-replace confirmed-override lane: the exact resource address the requester
   * typed to confirm a destroy+recreate. Set at submit only for a forcesReplace op (the
   * server requires it to equal targetAddress and records it); absent everywhere else.
   */
  replaceConfirmation?: string;
  /**
   * The multi-operation CHANGE SET (Phase B): the ordered operations this ONE reviewed
   * change enacts, present only for a true set (length >= 2). A single-op request carries
   * NONE — its top-level operationId/targetAddress/params ARE the one item. The top-level
   * reviewTier/approvalsRequired hold the STRICTEST-combined requirement across all items.
   */
  items?: ChangeSetItem[];
  events: RequestEvent[];
  /* --- roles / approvals / scheduling (rebuild) --- */
  teamId?: string;
  approvalsRequired?: number;
  approvals?: Approval[];
  schedule?: Schedule;
  /**
   * The generated Terraform diff, pinned at submit time. Approvers
   * render THIS exact artifact — not a diff regenerated from mutable inventory —
   * so "the senior approves this exact diff" is literally true. Already redacted.
   */
  pinnedDiff?: string;
  /**
   * Evidence chain. Populated by the CI pipeline once it exists —
   * the approved commit SHA, the plan digest that binds "reviewed = applied", the
   * SHA that actually applied, and the Object-Lock evidence link. Shown as pending
   * until the pipeline is armed; kept on the record so one request id resolves the
   * whole chain.
   */
  headSha?: string;
  planDigest?: string;
  appliedSha?: string;
  evidenceUrl?: string;
  /**
   * Interim-profile fields (api-mode only — ccp-api
   * stamps these; the mock never sets any of them). `interimProfile` +
   * `earliestApplyAt` are set exactly when a single distinct approval
   * completed quorum with fewer eligible approvers than required, putting
   * the request into APPROVED_COOLING until the deadline lazily settles it.
   */
  interimProfile?: boolean;
  earliestApplyAt?: string;
  /**
   * Quorum-feasibility snapshot, stamped at submit time and
   * returned as top-level fields on both the 201 submit response and every
   * subsequent read of this request (api-mode only — see
   * lib/httpApi.ts#getRequestFeasibility for the LIVE-recomputed
   * equivalent, which can differ if the approver directory changed since
   * submit). Never a submission gate — informational.
   */
  eligibleApprovers?: number;
  feasible?: boolean;
  interimProfileWillApply?: boolean;
  /**
   * The two-level approval ladder and the next unsigned step, computed server-side from
   * the request's review tier + approvals (api-mode only — the mock never sets them).
   * `approvalLadder` is the ordered list of steps a distinct person must each sign;
   * `nextApprovalStep` is the step a new signature would fill (`null` once every step is
   * signed). The SPA renders these as plain-language progress ("Waiting for the first
   * approver (L2)") and only offers Approve to a viewer whose role can sign the next step.
   */
  approvalLadder?: ApprovalStep[];
  nextApprovalStep?: ApprovalStep | null;
}
