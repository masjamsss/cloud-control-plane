import type { ChangeRequest } from '@/types';
import type { HttpApiClient } from '@/lib/httpApi';

/**
 * Cooling-off, SPA half. Pure, React-free so every rule is
 * unit-testable without mounting RequestDetail (this repo has no jsdom — see
 * test/standalone.test.ts's exact dependency allowlist). Mirrors
 * features/admin/teamsFlow.ts / usersFlow.ts's shape: the component stays a
 * thin wrapper that calls these and renders the result.
 */

/**
 * Client-side mirror of routes/requests.ts's POST /:id/cancel authz rule —
 * for UI ergonomics ONLY (show/hide the Cancel button). The server
 * re-enforces this authoritatively regardless of what this predicate says:
 * a client that disagrees just gets a clean 403 CANCEL_FORBIDDEN back, never
 * a forged cancel. Valid only while APPROVED_COOLING; the requester
 * (withdrawing their own change) or a Lead/admin (senior override) — a plain
 * approver who is neither is refused, same as everywhere else self-approval
 * is refused to a non-senior.
 */
export function canCancelRequest(
  request: Pick<ChangeRequest, 'status' | 'requester'>,
  currentUser: { id: string; role: string; isAdmin?: boolean },
): boolean {
  if (request.status !== 'APPROVED_COOLING') return false;
  const isOwner = request.requester === currentUser.id;
  const isSeniorOverride = currentUser.role === 'lead' || currentUser.isAdmin === true;
  return isOwner || isSeniorOverride;
}

export type CancelOutcome =
  | { ok: true; request: ChangeRequest }
  | { ok: false; reason: string; code?: string; refetched?: ChangeRequest };

/**
 * Cancel via ccp-api, honestly. A 409 STATE_CONFLICT commonly means the
 * cooling window settled LAZILY (no background timer; the next
 * read/mutation settles it) out from under this click, e.g. between the page
 * load and the button press. Re-fetch so the caller can show the request's
 * true current state instead of a stale "cancel failed" that leaves the UI
 * looking wrong (still "cooling" with a live Cancel button, when the request
 * actually already applied). Any other rejection (CANCEL_FORBIDDEN, a
 * vanished request) is returned as-is — no refetch needed to explain those.
 */
export async function cancelRequestVia(client: HttpApiClient, id: string): Promise<CancelOutcome> {
  const result = await client.cancelRequest(id);
  if (result.ok) return result;
  if (result.code === 'STATE_CONFLICT') {
    const refetched = await client.getRequest(id);
    return { ok: false, reason: result.reason, code: result.code, refetched };
  }
  return result;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Human "time remaining" until `earliestApplyAt` — no client timer (matches
 * the server's own "lazily settled, no background timer" philosophy):
 * this is computed once at render time from an injectable `nowMs` (a
 * real default; tests pass an explicit value), not re-ticked in the
 * background. A manual refresh naturally re-settles via the next GET.
 */
export function coolingTimeRemaining(earliestApplyAt: string, nowMs = Date.now()): string {
  const remaining = Date.parse(earliestApplyAt) - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return 'elapsing shortly';
  const hours = Math.floor(remaining / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
  if (hours === 0 && minutes === 0) return 'less than a minute remaining';
  if (hours === 0) return `${minutes}m remaining`;
  return `${hours}h ${minutes}m remaining`;
}
