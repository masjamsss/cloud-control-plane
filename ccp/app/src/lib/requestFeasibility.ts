/**
 * Quorum-feasibility HONESTY for api-mode (SPA half). `lib/quorum.ts`
 * estimates feasibility from the LOCAL account directory (`lib/accounts`'s
 * localStorage) — a legitimate ground truth in mock-mode, since the mock IS
 * that directory. Against a real ccp-api, that estimate is not just
 * stale, it can be flatly WRONG: the server's eligibility filter
 * additionally requires project-binding and activation, which
 * `eligibleApproverCount()` knows nothing about. So in api-mode, feasibility
 * must come from the server's own fields — the submit-time snapshot
 * (types/request.ts's `ChangeRequest.eligibleApprovers/feasible/
 * interimProfileWillApply`) or the LIVE `GET /requests/:id/feasibility`
 * (lib/httpApi.ts's `getRequestFeasibility`) — never local math.
 *
 * `hasFeasibility` is the presence-based guard that lets callers stay
 * mode-agnostic: the mock's ChangeRequest objects never carry these three
 * keys at all, so "are they present" IS "did this come from the server,"
 * without needing to import `isApiMode` here too.
 */

export interface FeasibilityFields {
  eligibleApprovers: number;
  feasible: boolean;
  interimProfileWillApply: boolean;
}

/** True only when every feasibility field is actually present. */
export function hasFeasibility(
  source: Partial<FeasibilityFields> | undefined | null,
): source is FeasibilityFields {
  return (
    !!source &&
    typeof source.eligibleApprovers === 'number' &&
    typeof source.feasible === 'boolean' &&
    typeof source.interimProfileWillApply === 'boolean'
  );
}

export interface FeasibilityNotice {
  tone: 'infeasible';
  text: string;
}

/**
 * Human copy for the infeasibility notice, expressed for the two-level
 * ladder. NEVER a submission gate — purely informational, the same
 * rule the server follows (domain/feasibility.ts never refuses a submit). Null
 * when the ladder can be completed (`feasible`). The single-approver interim
 * profile was removed, so there is no longer an "interim" notice — a
 * riskier change simply waits for both ladder steps to be signable.
 */
export function feasibilityNotice(f: FeasibilityFields): FeasibilityNotice | null {
  if (!f.feasible) {
    return {
      tone: 'infeasible',
      text: 'This change cannot be fully approved yet: there are not enough eligible approvers — including a lead for the final approval — enrolled and project-bound. Nothing was blocked; it stays open until they are.',
    };
  }
  return null;
}
