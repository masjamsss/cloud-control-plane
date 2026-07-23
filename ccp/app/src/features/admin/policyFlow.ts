import { getPolicy, setPolicy, type ApprovalPolicy } from '@/lib/policy';
import type { AdminWriteOutcome, HttpApiClient } from '@/lib/httpApi';

/**
 * Approval policy's ADVISORY → AUTHORITATIVE branch (the pattern
 * teamsFlow/usersFlow established, applied to the policy flow). `can('policy')`
 * flips true the instant ccp-api serves GET/PUT /admin/policy — this module
 * is the one place that decides which backend a policy read/write reaches,
 * pulled out of ApprovalPolicyAdmin so it's unit-testable without mounting a
 * component (no jsdom in this repo — see test/standalone.test.ts).
 *
 * `authoritative` is always exactly `can('policy')` (components/AdvisoryGate);
 * `client` is `lib/api`'s `authClient` (null in mock mode). When both are
 * truthy the read is GET /admin/policy and the write PUT /admin/policy —
 * dual-controlled server-side (api): raising a tier applies immediately,
 * lowering one returns 202 and waits for a second admin's ack, surfaced as
 * {@link AdminWriteOutcome} so the UI never claims an un-applied save.
 * Otherwise this is the exact pre-existing lib/policy localStorage behavior.
 */

export interface PolicyState {
  policy: ApprovalPolicy;
  /** The server POLICY item's guard version; 0 locally (and before first write). */
  version: number;
}

/** The local store's snapshot — synchronous, so a mock build (and a server
 * render) shows the stored policy on first paint, exactly as it always has. */
export function localPolicyState(): PolicyState {
  return { policy: getPolicy(), version: 0 };
}

export async function loadPolicyVia(
  authoritative: boolean,
  client: HttpApiClient | null,
): Promise<PolicyState> {
  if (authoritative && client) {
    const p = await client.getAdminPolicy();
    return {
      policy: { low: p.low, medium: p.medium, high: p.high, deleteMin: p.deleteMin },
      version: p.version,
    };
  }
  return localPolicyState();
}

export async function savePolicyVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  next: ApprovalPolicy,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) {
    return client.putAdminPolicy({
      low: next.low,
      medium: next.medium,
      high: next.high,
      deleteMin: next.deleteMin,
    });
  }
  setPolicy(next);
  return { applied: true };
}

/** Honest outcome copy for a dual-controlled config write (api) — never
 * claims an immediate success that is actually still awaiting a second
 * admin's ack. Mirrors usersFlow's describeAccountWrite verbatim so every
 * admin surface speaks the same sentence. */
export function describeConfigWrite(outcome: AdminWriteOutcome, appliedLabel: string): string {
  return outcome.applied
    ? `${appliedLabel}.`
    : `${appliedLabel} — proposed, pending a second admin's approval.`;
}
