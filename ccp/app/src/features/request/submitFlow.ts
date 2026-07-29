import type { ChangeRequest, ChangeSetDraft } from '@/types';
import type { ApiClient, SubmitResult } from '@/lib/api';
import { attempt } from '@/lib/asyncGuard';

/**
 * Submit, SPA half. Pure, React-free so the failure rules are unit-testable
 * without mounting a form (this repo has no jsdom — see
 * test/standalone.test.ts's exact dependency allowlist). Mirrors
 * features/drift/proposalFlow.ts's shape exactly, including the
 * navigate-on-success injection: the four forms stay thin wrappers.
 *
 * NEVER REJECTS (FE-1 / UI-4). Every form did
 * `setSubmitting(true); void api.submitRequest(draft).then(result => …)`
 * with no rejection path, so a dropped connection left the Review step's
 * button reading "Submitting…" for ever — and for RequestForm the only way
 * out (a reload) DISCARDS the entire drafted request. Folding the rejection
 * into the same `{ok:false, reason}` the server's refusals use puts it in
 * the blocked-reason slot every one of those forms already renders, with
 * `submitting` reset, so the requester can simply press Submit again.
 */

/** Single-operation submit. */
export async function submitRequestVia(
  client: Pick<ApiClient, 'submitRequest'>,
  navigate: (path: string) => void,
  draft: ChangeRequest,
): Promise<SubmitResult> {
  return finish(await attempt(() => client.submitRequest(draft)), navigate);
}

/** Change-set (bulk / multi-edit cart) submit. Same guarantee. */
export async function submitChangeSetVia(
  client: Pick<ApiClient, 'submitChangeSet'>,
  navigate: (path: string) => void,
  draft: ChangeSetDraft,
): Promise<SubmitResult> {
  return finish(await attempt(() => client.submitChangeSet(draft)), navigate);
}

function finish(
  outcome: { ok: true; value: SubmitResult } | { ok: false; reason: string },
  navigate: (path: string) => void,
): SubmitResult {
  if (!outcome.ok) return { ok: false, reason: outcome.reason, code: 'UNREACHABLE' };
  if (outcome.value.ok) navigate('/requests/' + outcome.value.request.id);
  return outcome.value;
}
