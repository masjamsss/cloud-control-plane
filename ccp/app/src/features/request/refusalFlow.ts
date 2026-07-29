import type { GlobalSettings } from '@/lib/settings';
import type { Schedule } from '@/types';

/**
 * When a server refusal stops applying, SPA half (FE-3).
 *
 * Pure and React-free, following the `*Flow.ts` doctrine this repo already sets
 * (`features/requests/coolingFlow.ts`, `features/drift/proposalFlow.ts`): there is no
 * jsdom here, so a rule that lives inside a component cannot be tested at all.
 *
 * THE DEFECT. `RequestForm` stored the server's refusal in `blockedReason` and never
 * cleared it — no `setBlockedReason(null)` existed anywhere in the file, and the
 * route-change reseed reset values, touched, justification, schedule and confirmation but
 * not this. `ReviewStep` disables submit whenever `blocked !== undefined`, so:
 *
 *  - Server refuses `OUT_OF_BOUNDS` because an admin narrowed an allowlist after the form
 *    loaded. The requester clicks Edit, fixes the parameter, returns to Review — and the
 *    button is still dead, explaining a value that is no longer in the form. The one way
 *    out is leaving the route, which DISCARDS THE ENTIRE DRAFTED REQUEST.
 *  - Server refuses because of a change freeze. The admin lifts the freeze. The live gate
 *    clears, the stale copy does not, and the button stays dead citing a freeze that
 *    ended.
 *
 * THE SHAPE OF THE FIX. Keeping the refusal blocking is right — the server decided, and
 * re-sending an identical draft would only be refused again. The bug is that it outlived
 * what it was a verdict ABOUT. So the refusal is stored together with a key describing the
 * state it judged, and is simply *not applicable* once that key changes. Nothing has to
 * remember to clear it, which is what made the original wrong: clearing is not an action
 * anyone takes, it is a consequence of the draft changing.
 *
 * Deriving rather than clearing in an effect also removes an ordering hazard — an effect
 * keyed on the draft can race the `setBlockedReason` that follows an awaited submit and
 * erase the message the requester needs to read.
 */

/** A server refusal, paired with the state it was a verdict about. */
export interface DraftRefusal {
  reason: string;
  /** {@link draftKey} at the moment the server refused. */
  forKey: string;
}

/**
 * Everything the server weighed. Both halves matter, and for different reasons: the DRAFT
 * because a refusal of these values says nothing about different ones, and the live
 * SETTINGS because a refusal can be about the world rather than the draft — a freeze the
 * requester cannot act on and must not keep paying for once it is lifted.
 */
export interface DraftState {
  values: Record<string, unknown>;
  schedule: Schedule;
  justification: string;
  replaceConfirmation: string;
  settings: Pick<GlobalSettings, 'changeFreeze' | 'disabledOps'>;
}

/**
 * A stable identity for the judged state.
 *
 * `JSON.stringify` on the draft is deliberate and sufficient here: these are plain
 * request parameters that already round-trip through JSON to reach the server, so
 * anything the server can have judged is representable. Key ORDER is normalised, because
 * re-seeding a form rebuilds `values` and two identical drafts must not read as different
 * ones — that would clear a refusal the requester has not addressed.
 *
 * `disabledOps` is sorted for the same reason: the settings snapshot's array order is not
 * a meaningful change.
 */
export function draftKey(state: DraftState): string {
  return JSON.stringify([
    stable(state.values),
    stable(state.schedule as unknown as Record<string, unknown>),
    state.justification,
    state.replaceConfirmation,
    state.settings.changeFreeze,
    [...state.settings.disabledOps].sort(),
  ]);
}

function stable(o: Record<string, unknown>): Array<[string, unknown]> {
  return Object.keys(o)
    .sort()
    .map((k) => [k, o[k]] as [string, unknown]);
}

/**
 * The refusal to render and block on, or `undefined` when it no longer applies.
 *
 * `undefined` rather than `null` because that is what `ReviewStep`'s `blocked` prop takes,
 * and its disabled rule is `blocked !== undefined` — so an expired refusal re-enables
 * submit by construction, with no second place to keep in sync.
 */
export function activeRefusal(refusal: DraftRefusal | null, currentKey: string): string | undefined {
  if (refusal === null) return undefined;
  return refusal.forKey === currentKey ? refusal.reason : undefined;
}
