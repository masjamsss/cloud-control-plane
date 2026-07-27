import type { Schedule } from '@/types';
import type { ApiClient, SubmitResult } from '@/lib/api';
import { attempt } from '@/lib/asyncGuard';

/**
 * Submit-from-proposal, SPA half. Pure, React-free so the "submit navigates
 * to the created request" behavior is unit-testable without mounting
 * DriftPage (this repo has no jsdom — see test/standalone.test.ts's exact
 * dependency allowlist). Mirrors features/requests/coolingFlow.ts /
 * windowFlow.ts's shape: the component stays a thin wrapper that calls this
 * and renders the result.
 */

export interface SubmitDriftProposalInput {
  justification: string;
  schedule: Schedule;
  alsoDigests?: string[];
}

/**
 * Submit a generated drift proposal and, on success, navigate to the
 * created request — the same {@link SubmitResult} contract every other
 * submit path returns, so a caller can render the server's rejection
 * reason inline exactly like RequestForm.tsx already does. `navigate` is
 * injected (rather than calling `useNavigate()` here) so this stays testable
 * with a plain spy, no router/DOM required.
 *
 * NEVER REJECTS (FE-1). A dropped connection used to propagate out of here
 * as a promise rejection, so DriftPage's nine `.then(result => …)` call
 * sites never ran their failure branch and left `submitting` true — every
 * drawer's Submit button stuck on "Submitting…" until a page reload. The
 * failure is folded into the SAME `{ok:false, reason}` the server's own
 * refusals use, because every one of those call sites already renders it.
 */
export async function submitDriftProposalVia(
  client: Pick<ApiClient, 'submitDriftProposal'>,
  navigate: (path: string) => void,
  digest: string,
  input: SubmitDriftProposalInput,
): Promise<SubmitResult> {
  const outcome = await attempt(() => client.submitDriftProposal(digest, input));
  if (!outcome.ok) return { ok: false, reason: outcome.reason, code: 'UNREACHABLE' };
  const result = outcome.value;
  if (result.ok) navigate('/requests/' + result.request.id);
  return result;
}

export interface LegitimizeDriftSecurityInput {
  justification: string;
  schedule: Schedule;
}

/**
 * C2 — start a legitimize request for a security-posture drift row and, on
 * success, navigate to the created (NEEDS_ENGINEER) request. Mirrors
 * {@link submitDriftProposalVia} exactly (same {@link SubmitResult}
 * contract, same navigate-on-success shape) and shares its never-rejects
 * guarantee; kept as its own function because it calls a DIFFERENT seam method
 * ({@link ApiClient.legitimizeDriftSecurity}) with a different eventual
 * fulfillment (an engineer authors the Terraform — no diff is pinned here),
 * not because the client-side flow differs.
 */
export async function legitimizeDriftSecurityVia(
  client: Pick<ApiClient, 'legitimizeDriftSecurity'>,
  navigate: (path: string) => void,
  digest: string,
  input: LegitimizeDriftSecurityInput,
): Promise<SubmitResult> {
  const outcome = await attempt(() => client.legitimizeDriftSecurity(digest, input));
  if (!outcome.ok) return { ok: false, reason: outcome.reason, code: 'UNREACHABLE' };
  const result = outcome.value;
  if (result.ok) navigate('/requests/' + result.request.id);
  return result;
}
