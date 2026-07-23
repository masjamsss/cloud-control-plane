import type { ChangeRequest, ChangeSetDraft, ChangeSetItem, Exposure, ManifestOperation, Schedule } from '@/types';
import type { PendingEdit } from '@/lib/resourceEdits';

/**
 * The CLIENT half of the multi-operation change set (Phase B). Pure functions — no DOM, no
 * network — so the builders and the requirement preview are unit-testable directly (this app
 * has no jsdom; see src/test/setup.ts). The api is the AUTHORITY: it re-validates every item
 * atomically and re-computes the combined requirement server-side, and its response carries
 * the real `approvalLadder`/`reviewTier`. These helpers only decide what the SPA SHOWS
 * before submit and assemble the identity-free draft it sends — they never relax a gate.
 *
 * Two entry points build a change set, both submitting through the SAME
 * `api.submitChangeSet` seam:
 *   - {@link cartToChangeSet}: the resource-detail pending cart — several settings on ONE
 *     resource become one reviewed change (multi-edit, N ops × 1 target);
 *   - {@link bulkToChangeSet}: a bulk action chosen for many selected resources — one op ×
 *     N targets.
 */

export type ReviewTier = 'self_service' | 'guardrails' | 'engineer';
export type LadderStep = 'L2' | 'L3';

const TIER_RANK: Record<ReviewTier, number> = { self_service: 0, guardrails: 1, engineer: 2 };

/** Manifest exposure → review tier — the client mirror of the api's `reviewTierFor`.
 * Anything unrecognized fails CLOSED to the engineer tier, exactly like the server. */
export function reviewTierForExposure(exposure: Exposure | string | undefined): ReviewTier {
  switch (exposure) {
    case 'l1_self_service':
      return 'self_service';
    case 'l1_with_guardrails':
      return 'guardrails';
    case 'engineer_only':
      return 'engineer';
    default:
      return 'engineer';
  }
}

/** Tighten-only combinator: the stricter of two tiers wins (mirrors the api). */
export function strictestTier(a: ReviewTier, b: ReviewTier): ReviewTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** The two-level ladder for a tier — forces-replace always uses [L2, L3] (mirrors the api). */
export function ladderForTier(tier: ReviewTier, forcesReplace: boolean): LadderStep[] {
  if (forcesReplace) return ['L2', 'L3'];
  return tier === 'self_service' ? ['L2'] : ['L2', 'L3'];
}

export interface CombinedRequirement {
  tier: ReviewTier;
  ladder: LadderStep[];
  approvalsRequired: number;
  /** True when ANY item rebuilds its resource — floors the whole set to the replace ladder. */
  forcesReplace: boolean;
}

/** The minimal per-item facts the requirement preview needs. */
export interface RequirementInput {
  exposure?: Exposure | string;
  forcesReplace?: boolean;
}

/**
 * The STRICTEST-combined review requirement across a set — the client preview mirror of the
 * api's `currentRequirement`. The tier is the strictest of every item's exposure→tier, and
 * forces-replace on ANY item floors the whole set to the [L2, L3] replace ladder. An empty
 * set previews as the lowest bar (a caller never submits one; the console/cart gate that).
 */
export function combinedRequirement(items: RequirementInput[]): CombinedRequirement {
  let tier: ReviewTier = 'self_service';
  let forcesReplace = false;
  for (const it of items) {
    tier = strictestTier(tier, reviewTierForExposure(it.exposure));
    forcesReplace = forcesReplace || it.forcesReplace === true;
  }
  const ladder = ladderForTier(tier, forcesReplace);
  return { tier, ladder, approvalsRequired: ladder.length, forcesReplace };
}

/** Plain-language name for a review tier — the words the combined-requirement banner shows. */
export function tierLabel(tier: ReviewTier): string {
  switch (tier) {
    case 'self_service':
      return 'Self-service review';
    case 'guardrails':
      return 'Guardrailed review';
    case 'engineer':
      return 'Engineer-authored review';
  }
}

/** How the combined requirement reads as one line: the tier + how many distinct approvers. */
export function requirementSummary(req: CombinedRequirement): string {
  const n = req.approvalsRequired;
  return `${tierLabel(req.tier)} — ${n} approval${n === 1 ? '' : 's'}`;
}

/** The review tier's canonical exposure — the inverse of {@link reviewTierForExposure}, so the
 * strictest-combined tier of a set can drive an {@link AccessBadge} (which speaks Exposure). */
export function exposureForTier(tier: ReviewTier): Exposure {
  switch (tier) {
    case 'self_service':
      return 'l1_self_service';
    case 'guardrails':
      return 'l1_with_guardrails';
    case 'engineer':
      return 'engineer_only';
  }
}

/* ── change-set canonicalization (client mirror of api domain/changeset.ts) ─────────────── */

/**
 * The minimal request shape {@link itemsOf} reads — the top-level per-op fields plus the
 * optional `items` list. Accepts a full {@link ChangeRequest} or any Pick of it.
 */
export type ChangeSetSource = Pick<
  ChangeRequest,
  'items' | 'operationId' | 'service' | 'macd' | 'targetAddress' | 'params' | 'exposure' | 'replaceConfirmation'
>;

/**
 * The canonical, ALWAYS-non-empty ordered item list of a request — the CLIENT mirror of the
 * api's `domain/changeset.ts#itemsOf`, and the ONE place the SPA turns "a request is a list of
 * operations" into a value. When `items` is present (a true change set, length ≥ 2) it is
 * returned verbatim; otherwise a single item is synthesized from the top-level fields, so a
 * legacy/single-op request reads as `items.length === 1` — a strict special case of the set
 * path rather than a separate branch. This is what lets every set-aware surface iterate one
 * list and keep single-op rendering byte-identical. (The app's `ChangeRequest` carries no
 * top-level `reviewTier`, so the derived item omits it; consumers fold tier from `exposure`.)
 */
export function itemsOf(req: ChangeSetSource): ChangeSetItem[] {
  if (req.items && req.items.length > 0) return req.items;
  return [
    {
      operationId: req.operationId,
      service: req.service,
      macd: req.macd,
      targetAddress: req.targetAddress,
      params: req.params,
      exposure: req.exposure,
      ...(req.replaceConfirmation !== undefined ? { replaceConfirmation: req.replaceConfirmation } : {}),
    },
  ];
}

/** How many operations a request enacts — 1 for a single-op request, N for a set. */
export function itemCountOf(req: ChangeSetSource): number {
  return req.items && req.items.length > 0 ? req.items.length : 1;
}

/** Whether a request is a true multi-operation change set (as opposed to single-op). */
export function isChangeSet(req: ChangeSetSource): boolean {
  return itemCountOf(req) > 1;
}

/**
 * The STRICTEST-combined review requirement across a set's stored items — the read-side mirror
 * of {@link combinedRequirement}. A stored item's forces-replace status is read from the
 * PINNED `replaceConfirmation` (present iff the op forces a destroy+recreate), exactly as the
 * api's `ladderStateOf` derives it — so what the approver is shown matches what the server
 * folded at submit and re-enforces at approve time.
 */
export function changeSetRequirement(items: ChangeSetItem[]): CombinedRequirement {
  return combinedRequirement(
    items.map((it) => ({ exposure: it.exposure, forcesReplace: it.replaceConfirmation !== undefined })),
  );
}

/* ── builders ─────────────────────────────────────────────────────────────────────────── */

/**
 * Build the change-set draft from the resource-detail pending cart (multi-edit, N ops × 1
 * target). Each cart edit already carries its FULL submittable params (value coerced +
 * inventory target bound — see resourceEdits.ts), so this is a straight projection. A
 * single shared `replaceConfirmation` (the resource address the operator typed) is attached
 * to every forces-replace item — the whole cart is one resource, so one confirmation covers
 * it; the server still re-checks each item's confirmation equals its own target.
 */
export function cartToChangeSet(
  cart: PendingEdit[],
  justification: string,
  schedule: Schedule,
  replaceConfirmation?: string,
): ChangeSetDraft {
  return {
    items: cart.map((e) => ({
      operationId: e.opId,
      targetAddress: e.targetAddress,
      params: e.params,
      ...(e.forcesReplace && replaceConfirmation ? { replaceConfirmation } : {}),
    })),
    justification,
    schedule,
  };
}

/** The combined requirement preview for a resource-detail cart. */
export function cartRequirement(cart: PendingEdit[]): CombinedRequirement {
  return combinedRequirement(cart.map((e) => ({ exposure: e.exposure, forcesReplace: e.forcesReplace })));
}

/**
 * Build the change-set draft for a BULK action — one op fanned across N selected targets.
 * The shared value params (entered once) are merged per item with that item's inventory
 * target param bound to its own address. Bulk excludes forces-replace ops (see
 * {@link isBulkableAction}), so no per-item confirmation is collected here.
 */
export function bulkToChangeSet(
  op: ManifestOperation,
  targetAddresses: string[],
  sharedParams: Record<string, unknown>,
  justification: string,
  schedule: Schedule,
): ChangeSetDraft {
  const targetParam = op.params.find((p) => p.source === 'inventory');
  return {
    items: targetAddresses.map((addr) => ({
      operationId: op.id,
      targetAddress: addr,
      params: { ...sharedParams, ...(targetParam ? { [targetParam.name]: addr } : {}) },
    })),
    justification,
    schedule,
  };
}

/** The combined requirement preview for a bulk action (one op, so the tier is that op's). */
export function bulkRequirement(op: ManifestOperation, targetCount: number): CombinedRequirement {
  return combinedRequirement(
    Array.from({ length: Math.max(targetCount, 1) }, () => ({ exposure: op.exposure, forcesReplace: op.forcesReplace })),
  );
}

/**
 * Whether an action may be applied in BULK. Forces-replace (destroy+recreate) ops are
 * EXCLUDED: each needs its own typed confirmation naming its exact target, which a blanket
 * bulk action must never auto-fill — they stay on the single-resource path where the
 * confirmation is collected properly. Everything else (a scalar change, a tag edit, a
 * delete) fans out safely. This is a client convenience gate; the server independently
 * enforces the per-item confirmation regardless of how a set was built.
 */
export function isBulkableAction(op: Pick<ManifestOperation, 'forcesReplace'>): boolean {
  return op.forcesReplace !== true;
}

/* ── bulk multi-select (pure list state) ──────────────────────────────────────────────── */

/** Toggle one resource address in the selection set, returning a NEW set (stable identity
 * for React). Adding an absent address selects it; toggling a present one deselects. */
export function toggleSelection(selected: ReadonlySet<string>, address: string): Set<string> {
  const next = new Set(selected);
  if (next.has(address)) next.delete(address);
  else next.add(address);
  return next;
}

/** Select every given address on top of the current selection (a group "select all"). */
export function selectAll(selected: ReadonlySet<string>, addresses: readonly string[]): Set<string> {
  const next = new Set(selected);
  for (const a of addresses) next.add(a);
  return next;
}

/** Deselect every given address (a group "clear"), leaving any others selected. */
export function deselectAll(selected: ReadonlySet<string>, addresses: readonly string[]): Set<string> {
  const next = new Set(selected);
  for (const a of addresses) next.delete(a);
  return next;
}

/** Whether every given address is currently selected (drives a group's select-all checkbox). */
export function allSelected(selected: ReadonlySet<string>, addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every((a) => selected.has(a));
}
