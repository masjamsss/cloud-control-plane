import type { RequestItem } from '../store/schema';

/**
 * Server-side `exposure` enforcement (exposure was parsed
 * and displayed but enforced NOWHERE outside the browser mock).
 *
 * The model is ADR-0008's: exposure NEVER gates submission — any severity is
 * requestable; it decides the REVIEW REQUIREMENT a request must satisfy. That
 * requirement is now the 0037 two-level ladder (`ladderFor` below): exposure maps
 * to a review TIER, and the tier maps to an ordered list of ladder steps.
 *
 *   l1_self_service    → self_service → [L2]      (one approver-or-lead)
 *   l1_with_guardrails → guardrails   → [L2, L3]  (an approver-or-lead, then a lead)
 *   engineer_only      → engineer     → [L2, L3]  (routed to NEEDS_ENGINEER so an
 *                        engineer authors the Terraform, but its first sign-off now
 *                        widens from lead-only to L2 — an approver may sign L2).
 *
 * Unknown/missing exposure fails CLOSED to the engineer tier.
 */

export type ReviewTier = 'self_service' | 'guardrails' | 'engineer';

const TIER_RANK: Record<ReviewTier, number> = { self_service: 0, guardrails: 1, engineer: 2 };

/** Manifest exposure → review tier. Anything unrecognized is engineer (fail closed). */
export function reviewTierFor(exposure: string | undefined): ReviewTier {
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

/** Tighten-only combinator: the stricter of two tiers wins. */
export function strictestTier(a: ReviewTier, b: ReviewTier): ReviewTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * The static two-level approval LADDER (0037 Feature B) — the single source of truth
 * for BOTH how many approvals a request needs AND which role signs each, replacing the
 * old variable risk/MACD quorum. An ordered list of steps, each naming the MINIMUM role
 * that may sign it (see `canSignStep` in domain/eligibility.ts), each signed by a
 * DISTINCT person:
 *
 *   L2 = a first approver  (role `approver` OR `lead`)
 *   L3 = a final approver  (role `lead` only)
 *
 *   self_service (low risk)         → [L2]        one approver-or-lead
 *   guardrails / engineer (riskier) → [L2, L3]    an approver-or-lead, then a lead
 *   any op with forcesReplace       → [L2, L3]    the SAME ladder, whatever the tier
 *                                                  (0037 replaces 0035's two-leads rule
 *                                                  for destroy+recreate — the operator
 *                                                  chose one uniform ladder).
 *
 * `isAdmin` is orthogonal to level (ADR-0011): admin is a capability, never a seniority.
 */
export type LadderStep = 'L2' | 'L3';

export function ladderFor(tier: ReviewTier, forcesReplace = false): LadderStep[] {
  if (forcesReplace) return ['L2', 'L3'];
  return tier === 'self_service' ? ['L2'] : ['L2', 'L3'];
}

/**
 * The next unsigned step given how many signatures are already recorded IN ORDER (the
 * Nth approval fills `ladder[N-1]`, so the next is `ladder[signedCount]`). `null` once
 * every step is signed. Positional by construction — this is what makes "L3 can't be
 * signed before L2" STRUCTURAL: the first signature always targets L2, never L3.
 */
export function nextLadderStep(ladder: LadderStep[], signedCount: number): LadderStep | null {
  return signedCount < ladder.length ? ladder[signedCount]! : null;
}

/**
 * The approval COUNT a request needs — re-expressed as `ladderFor(...).length` so the
 * ladder is the ONE definition (never a divergent count vs. role rule). self_service = 1;
 * every riskier tier and every forces-replace = 2.
 */
export function requiredApprovalsFor(tier: ReviewTier, forcesReplace = false): number {
  return ladderFor(tier, forcesReplace).length;
}

/** The status a fresh submission enters: the engineer track or the normal queue. */
export function initialStatusFor(tier: ReviewTier): 'NEEDS_ENGINEER' | 'AWAITING_CODE_REVIEW' {
  return tier === 'engineer' ? 'NEEDS_ENGINEER' : 'AWAITING_CODE_REVIEW';
}

/**
 * The tier a STORED request is under. Rows written before this enforcement carry
 * no `reviewTier` — derive it from their pinned `exposure` (same fail-closed map),
 * so legacy open requests are enforced identically to fresh ones.
 */
export function tierOf(req: Pick<RequestItem, 'reviewTier' | 'exposure'>): ReviewTier {
  return (req.reviewTier as ReviewTier | undefined) ?? reviewTierFor(req.exposure);
}
