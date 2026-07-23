import type { RequestSetItem } from '../store/schema';
import { getOperation } from '../manifests';
import { ladderFor, reviewTierFor, strictestTier, type LadderStep, type ReviewTier } from './exposure';
import { itemsOf, type ChangeSetSource } from './changeset';

export type CurrentRequirement = { tier: ReviewTier; ladder: LadderStep[]; required: number };

/** The pinned tier of ONE change-set item: its stamped `reviewTier`, or (legacy/absent)
 * the fail-closed map from its pinned `exposure`. The per-item twin of `tierOf`. */
function tierOfItem(it: Pick<RequestSetItem, 'reviewTier' | 'exposure'>): ReviewTier {
  return (it.reviewTier as ReviewTier | undefined) ?? reviewTierFor(it.exposure);
}

/**
 * The tighten-only CURRENT effective tier + approval ladder for an already-stored
 * request (ADMIN-11/ADV-14: the bar can only RISE, never fall from what was stamped at
 * submit) — now computed across the WHOLE change set (Phase B). The set is the STRICTEST
 * of its items, and each item is itself the strictest of its pinned tier and its op's LIVE
 * exposure, so a manifest re-tier toward `engineer` on ANY item lengthens the ladder
 * ([L2]→[L2,L3]) but a re-tier the other way never shortens it. The ladder derived from
 * that combined tighten-only tier IS the bar — `required` is just `ladder.length`. This is
 * the exact requirement the approve handler re-gates each signature against; factored out
 * so the G5 feasibility endpoint answers "what would approve() need RIGHT NOW" from one,
 * non-driftable definition. A single-op request is `itemsOf` length 1, so this reduces
 * EXACTLY to the old single-item computation — nothing about single-op review changed.
 *
 * When an item's op is unknown (a legacy/removed catalog entry), that item's tier falls
 * back to its pinned `tierOfItem` — the only signal still available, fail-closed.
 *
 * Forces-replace is tighten-only on its OWN axis and floors the WHOLE set: if ANY item was
 * a destroy-and-recreate at submit (a pinned `replaceConfirmation`) OR any op's LIVE
 * `forcesReplace` flag is set, the set keeps the [L2,L3] ladder even if that op's flag is
 * later flipped to false or the op is re-tiered down. The live flag can only ADD
 * forces-replace, never remove a pinned one, so a confirmed destroy-and-recreate can never
 * shrink the set to a single approval.
 */
export function currentRequirement(req: ChangeSetSource): CurrentRequirement {
  let tier: ReviewTier = 'self_service';
  let forcesReplace = false;
  for (const it of itemsOf(req)) {
    const op = getOperation(it.operationId);
    const itemTier = op ? strictestTier(tierOfItem(it), reviewTierFor(op.exposure)) : tierOfItem(it);
    tier = strictestTier(tier, itemTier);
    forcesReplace = forcesReplace || (op ? op.forcesReplace === true : false) || it.replaceConfirmation !== undefined;
  }
  const ladder = ladderFor(tier, forcesReplace);
  return { tier, ladder, required: ladder.length };
}
