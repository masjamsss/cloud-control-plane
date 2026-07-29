import type { ApiClient, MutationResult } from '@/lib/api';
import { attempt } from '@/lib/asyncGuard';

/**
 * Approve/reject, SPA half. Pure, React-free so the failure rules are
 * unit-testable without mounting ApprovalsQueue (this repo has no jsdom —
 * see test/standalone.test.ts's exact dependency allowlist). Mirrors
 * features/requests/coolingFlow.ts / features/drift/proposalFlow.ts's
 * shape: the component stays a thin wrapper that calls these and renders
 * the result.
 *
 * Both NEVER REJECT (FE-1 / UI-4). `ApprovalsQueue.approve` used to do
 * `setBusyId(id); const result = await api.approveRequest(id); …;
 * setBusyId(null)` — a rejected fetch skipped the reset, so that card's
 * Approve AND Reject stayed disabled with no error line until a reload,
 * on the one surface where a stuck control means a change nobody can move.
 * Folding the rejection into the same `{ok:false, reason}` the server's own
 * refusals use puts it straight into the error slot the queue already
 * renders (`describeApproveError`, which passes any unrecognised code
 * through as its reason).
 */

/** Approve, honestly: the server's refusal, or a renderable "couldn't reach it". */
export async function approveRequestVia(
  client: Pick<ApiClient, 'approveRequest'>,
  id: string,
): Promise<MutationResult> {
  const outcome = await attempt(() => client.approveRequest(id));
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason, code: 'UNREACHABLE' };
}

/** Reject, honestly. Same guarantee as {@link approveRequestVia}. */
export async function rejectRequestVia(
  client: Pick<ApiClient, 'rejectRequest'>,
  id: string,
  reason?: string,
): Promise<MutationResult> {
  const outcome = await attempt(() => client.rejectRequest(id, reason));
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason, code: 'UNREACHABLE' };
}
