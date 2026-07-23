import type { ApprovalStep } from '@/types';

/**
 * The two-level approval ladder — the CLIENT half (0037 Feature B). The api is the
 * authority: `domain/eligibility.ts#canSignStep` re-enforces every rule server-side, and
 * `routes/requests.ts` computes `nextApprovalStep` on the request. These helpers only
 * decide what the SPA SHOWS — the friendly ladder-progress phrase and whether to OFFER
 * the Approve button — never what is permitted.
 *
 * UX audit (2026-07-21, F-03/F-04/S-08) — the ApprovalLadder redesign. The queue's old
 * footer collapsed progress/who/what's-next/schedule into one 12px mono string; this file
 * grew the pure, framework-agnostic pieces `components/ui/ApprovalLadder.tsx` renders as a
 * shared segmented stepper across the queue card, the request-detail box, and the
 * my-requests row pill. Kept side-effect-free on purpose (no `resolveName`/`formatProjectTime`
 * imports here — those touch localStorage/Intl) so the segment-shaping logic stays directly
 * unit-testable the same way `canSignApprovalStep`/`ladderStatusText` already are; the
 * component injects the actual name/time formatters at render time.
 */

/**
 * Can this role sign the given step? Mirrors the server's `canSignStep`: L2 (a first
 * approver) admits `approver` or `lead`; L3 (the final approver) is `lead` only. `isAdmin`
 * is never consulted — admin is a capability, not an approval seniority.
 */
export function canSignApprovalStep(step: ApprovalStep, role: string): boolean {
  return step === 'L3' ? role === 'lead' : role === 'approver' || role === 'lead';
}

/**
 * Plain-language progress for the queue + detail views — friendly labels, no codenames.
 * `null` when there is nothing to add: either the request is fully signed (`nextStep`
 * null), or it came from a backend that doesn't carry the field (`nextStep` undefined, in
 * which case callers fall back to the N-of-M count).
 */
export function ladderStatusText(nextStep: ApprovalStep | null | undefined): string | null {
  if (nextStep === 'L2') return 'Waiting for the first approver (L2)';
  if (nextStep === 'L3') return 'Waiting for the final approver (L3)';
  return null;
}

/**
 * The short WHAT-KIND-OF-SIGNER label for the ladder's active (next-to-sign)
 * segment — `ladderStatusText`'s two-to-four-word sibling for a stepper
 * label rather than a full sentence. `null`/undefined (fully signed, or a
 * backend that doesn't carry the field — mock-mode) get the same graceful
 * "Approval" fallback `ladderStatusText` already uses, never a blank label.
 */
export function nextSignerLabel(nextStep: ApprovalStep | null | undefined): string {
  if (nextStep === 'L2') return 'First approver';
  if (nextStep === 'L3') return 'Final approver';
  return 'Approval';
}

/** One recorded signature, the minimal shape the ladder needs (structurally
 * compatible with `types/request.ts`'s `Approval` — kept local so this file
 * takes no value-import from `@/types` beyond the `ApprovalStep` type). */
export interface LadderApproval {
  user: string;
  at: string;
}

export type LadderSegmentState = 'done' | 'active' | 'todo';

/** One dot on the stepper: a signed step, the next (active) step, or a
 * further-out (todo) step. `sub` is the smaller second line under `label`
 * (a signer's timestamp, or the "you can sign this" / SoD hint on the
 * active step) — omitted, never empty-string, when there is nothing to say. */
export interface LadderSegment {
  key: string;
  state: LadderSegmentState;
  label: string;
  sub?: string;
}

/** "Approvals: 1 of 2 recorded" — the ladder's accessible name (the outer
 * element's `aria-label`) and the seed for the row-size tooltip below.
 * `required` is clamped to >= 0 so a bad/negative value never renders "of -1". */
export function ladderAriaLabel(have: number, required: number): string {
  return `Approvals: ${have} of ${Math.max(0, required)} recorded`;
}

/**
 * The compact `size='row'` pill's tooltip (MyRequests) — the N-of-M count,
 * plus `ladderStatusText`'s who's-next phrase when there is one, so the
 * ONE piece of ladder detail row-size doesn't have room for still surfaces
 * on hover/focus instead of being dropped entirely.
 */
export function ladderRowTooltip(
  have: number,
  required: number,
  nextStep: ApprovalStep | null | undefined,
): string {
  const r = Math.max(0, required);
  const base = `${have} of ${r} ${r === 1 ? 'approval' : 'approvals'}`;
  const status = ladderStatusText(nextStep);
  return status ? `${base} — ${status}` : base;
}

export interface BuildLadderSegmentsInput {
  /** `request.approvalsRequired` — may be 0/undefined (an engineer-tier
   * request that hasn't had a real requirement set yet, or a legacy row);
   * clamped to >= 0, never trusted negative. */
  required: number;
  approvals: LadderApproval[];
  nextStep?: ApprovalStep | null;
  /** The existing `mayApprove` computation — whether THIS viewer could sign
   * the next step right now. */
  viewerCanSign: boolean;
  /** SoD context for when `viewerCanSign` is false: is this the viewer's
   * OWN request (a second reviewer must sign, never them)? Gives that
   * silently-disabled-button state a visible reason instead of nothing. */
  viewerIsOwnRequest?: boolean;
  /** Injected, not imported — keeps this function pure/side-effect-free and
   * directly unit-testable without a localStorage-backed account store. */
  resolveName: (id: string) => string;
  formatTime: (iso: string) => string;
}

/**
 * The stepper's segment list: "Submitted" (always done), one done segment
 * per recorded approval (signer name + when, via the injected formatters),
 * then the remaining unsigned steps — the first (`active`) carries WHAT KIND
 * of signer comes next (`nextSignerLabel`) and, when there is something to
 * say, whether THIS viewer can act; any further steps are generic `todo`
 * placeholders (the ladder doesn't know their kind past the next one).
 *
 * Graceful 0-of-0/awaiting state: when `required` is 0 (clamped) AND nothing
 * has been signed yet, there is no "N remaining" to enumerate — rather than
 * silently stopping after "Submitted" (which would read as "nothing else is
 * needed," i.e. falsely complete), one `todo` segment names the gap honestly.
 * This is the only branch a caller passing a not-yet-computed
 * `approvalsRequired` (an engineer-tier request mid-fix elsewhere) hits —
 * everything else degrades to ordinary done/active/todo segments.
 */
export function buildLadderSegments(input: BuildLadderSegmentsInput): LadderSegment[] {
  const { approvals, nextStep, viewerCanSign, viewerIsOwnRequest, resolveName, formatTime } = input;
  const required = Math.max(0, input.required);
  const have = approvals.length;

  const segments: LadderSegment[] = [{ key: 'submitted', state: 'done', label: 'Submitted' }];

  approvals.forEach((a, i) => {
    segments.push({
      key: `signed-${i}-${a.user}`,
      state: 'done',
      label: resolveName(a.user),
      sub: formatTime(a.at),
    });
  });

  const pending = Math.max(0, required - have);
  if (pending === 0 && required === 0 && have === 0) {
    segments.push({
      key: 'awaiting-requirement',
      state: 'todo',
      label: 'Awaiting requirement',
      sub: 'the approvals needed have not been set yet',
    });
    return segments;
  }

  for (let i = 0; i < pending; i += 1) {
    const isNext = i === 0;
    segments.push({
      key: `pending-${i}`,
      state: isNext ? 'active' : 'todo',
      label: isNext ? nextSignerLabel(nextStep) : 'Approval',
      sub: isNext ? nextStepSub(viewerCanSign, viewerIsOwnRequest) : undefined,
    });
  }

  return segments;
}

/** The active segment's sub-label: gives the SoD gate a visible home instead
 * of a silently disabled button. `undefined` (no sub-label at all) when the
 * viewer can't sign AND it isn't their own request either — e.g. wrong role
 * or wrong ladder seniority — where naming every possible reason would be
 * guessing; the server error on an actual attempt stays the authority. */
function nextStepSub(
  viewerCanSign: boolean,
  viewerIsOwnRequest: boolean | undefined,
): string | undefined {
  if (viewerCanSign) return 'you can sign this';
  if (viewerIsOwnRequest) return 'your own request — a second reviewer signs';
  return undefined;
}

/**
 * The `aria-live` announcement after a successful approve (S-09: approvals
 * "silently drop the card" with no async confirmation for a screen-reader
 * user). Takes the mutation's OWN returned counts (never re-derived from
 * stale pre-mutation state) so "remaining" is always the post-approve truth.
 */
export function approveAnnouncement(have: number, required: number): string {
  const remaining = Math.max(0, Math.max(0, required) - have);
  if (remaining === 0) return 'Request approved — fully signed.';
  return `Request approved — ${remaining} ${remaining === 1 ? 'approval' : 'approvals'} remaining.`;
}
