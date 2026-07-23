import type { ChangeRequest, Schedule } from '@/types';
import type { HttpApiClient } from '@/lib/httpApi';

/**
 * SPA half. Pure, React-free so every rule is unit-testable
 * without mounting RequestDetail (this repo has no jsdom — see
 * test/standalone.test.ts's exact dependency allowlist). Mirrors
 * `features/requests/coolingFlow.ts`'s exact shape (the merged pattern
 * this design explicitly asks to be mirrored): the component stays a thin
 * wrapper that calls these and renders the result. Kept in its OWN file rather
 * than folded into coolingFlow.ts — the two verbs (cancel is shared, rewindow is
 * new) apply to disjoint status sets and disjoint UI panels (APPROVED_COOLING's
 * CoolingPanel vs. the window states' WindowPanel below); coolingFlow.ts's own
 * `canCancelRequest`/its tests are untouched by this file.
 */

/**
 * Client-side mirror of `routes/requests.ts`'s widened POST /:id/cancel authz
 * rule for UI ergonomics ONLY — the server re-enforces this
 * authoritatively regardless of what this predicate says. Valid while
 * AWAITING_DEPLOY_APPROVAL (before or during its window) or WINDOW_EXPIRED; NOT
 * APPROVED_COOLING (that status has its OWN panel/predicate, coolingFlow.ts's
 * `canCancelRequest`, unwidened by this file on purpose — see its file header).
 */
export function canCancelWindowedRequest(
  request: Pick<ChangeRequest, 'status' | 'requester'>,
  currentUser: { id: string; role: string; isAdmin?: boolean },
): boolean {
  if (request.status !== 'AWAITING_DEPLOY_APPROVAL' && request.status !== 'WINDOW_EXPIRED') return false;
  return isRequesterOrSenior(request, currentUser);
}

/**
 * Client-side mirror of `routes/requests.ts`'s POST /:id/rewindow authz + state
 * rule. Narrower than cancel: refused once the window is CURRENTLY
 * open (moving the goalposts mid-window — cancel is the verb for that instead),
 * and refused for a `schedule.kind:'now'` row (nothing to re-time). `nowMs` is
 * injectable (real default; tests pass an explicit value) — matches
 * `coolingTimeRemaining`'s "no client timer, computed once at render" doctrine.
 */
export function canRewindowRequest(
  request: Pick<ChangeRequest, 'status' | 'requester' | 'schedule' | 'earliestApplyAt'>,
  currentUser: { id: string; role: string; isAdmin?: boolean },
  nowMs: number = Date.now(),
): boolean {
  if (request.schedule?.kind !== 'window') return false;
  if (request.status !== 'AWAITING_DEPLOY_APPROVAL' && request.status !== 'WINDOW_EXPIRED') return false;
  if (request.status === 'AWAITING_DEPLOY_APPROVAL') {
    const summary = windowGateSummary(request.schedule, request.earliestApplyAt, nowMs);
    if (summary === 'open') return false; // currently open — cancel instead, never move the goalposts mid-window
  }
  return isRequesterOrSenior(request, currentUser);
}

function isRequesterOrSenior(
  request: Pick<ChangeRequest, 'requester'>,
  currentUser: { id: string; role: string; isAdmin?: boolean },
): boolean {
  const isOwner = request.requester === currentUser.id;
  const isSeniorOverride = currentUser.role === 'lead' || currentUser.isAdmin === true;
  return isOwner || isSeniorOverride;
}

export type CancelOutcome =
  | { ok: true; request: ChangeRequest }
  | { ok: false; reason: string; code?: string; refetched?: ChangeRequest };

/**
 * Cancel via ccp-api, honestly — identical shape/rationale to
 * `coolingFlow.ts#cancelRequestVia` (a 409 STATE_CONFLICT commonly means lazy
 * settlement — cooling OR window expiry — landed between page load and the
 * click; re-fetch so the caller can show the TRUE current state). Re-implemented
 * here rather than imported so this file has no dependency on coolingFlow.ts at
 * all (the two panels stay fully decoupled); the logic is intentionally
 * byte-identical.
 */
export async function cancelWindowedRequestVia(client: HttpApiClient, id: string): Promise<CancelOutcome> {
  const result = await client.cancelRequest(id);
  if (result.ok) return result;
  if (result.code === 'STATE_CONFLICT') {
    const refetched = await client.getRequest(id);
    return { ok: false, reason: result.reason, code: result.code, refetched };
  }
  return result;
}

export type RewindowOutcome =
  | { ok: true; request: ChangeRequest }
  | { ok: false; reason: string; code?: string; refetched?: ChangeRequest };

/** Re-window via ccp-api. Same STATE_CONFLICT-refetches-honestly policy as cancel. */
export async function rewindowRequestVia(client: HttpApiClient, id: string, at: string, endAt?: string): Promise<RewindowOutcome> {
  const result = await client.rewindowRequest(id, { at, endAt });
  if (result.ok) return result;
  if (result.code === 'STATE_CONFLICT') {
    const refetched = await client.getRequest(id);
    return { ok: false, reason: result.reason, code: result.code, refetched };
  }
  return result;
}

/**
 * The display-only state a window is in RIGHT NOW — a deliberately SIMPLE
 * client-side mirror of `domain/schedule.ts#applyGate`'s essential decision
 * (never the source of truth; the server re-enforces on every mutation and
 * lazily settles on every read). `'cooling'` and `'before_window'` are reported
 * distinctly, matching applyGate's own COOLING/BEFORE_WINDOW split, though in
 * practice this codebase surfaces them with the SAME "opens in…" copy.
 */
export type WindowGateSummary = 'cooling' | 'before_window' | 'open' | 'expired';

export function windowGateSummary(schedule: Schedule, earliestApplyAt: string | undefined, nowMs: number): WindowGateSummary {
  if (schedule.kind !== 'window') return 'open'; // no window — never called with a WindowPanel-relevant status anyway
  const startMs = Date.parse(schedule.at);
  const endMs = Date.parse(schedule.endAt ?? '') || startMs + 4 * 60 * 60 * 1000; // mirrors windowEndOf's at+4h legacy default
  if (nowMs >= endMs) return 'expired';
  if (earliestApplyAt !== undefined) {
    const earliestMs = Date.parse(earliestApplyAt);
    if (Number.isFinite(earliestMs) && nowMs < earliestMs) return 'cooling';
  }
  if (nowMs < startMs) return 'before_window';
  return 'open';
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Human "opens/closes in…" copy for the WindowPanel countdown — no client
 * timer (matches the server's own "lazily settled, no background timer"
 * philosophy): computed once at render time, re-settles naturally on
 * the next GET (a manual refresh, or the page's own effect re-running).
 */
export function windowCountdown(targetIso: string, nowMs: number): string {
  const remaining = Date.parse(targetIso) - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return 'any moment now';
  const hours = Math.floor(remaining / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
  if (hours === 0 && minutes === 0) return 'less than a minute';
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
