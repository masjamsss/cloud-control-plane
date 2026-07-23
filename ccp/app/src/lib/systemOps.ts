import type { ManifestOperation } from '@/types';

/**
 * The drift SYSTEM operations — vendored from the api's copy
 * (ccp/api/src/domain/systemOps.ts) so the SPA resolves the exact same
 * synthetic, estate-generic operations the api does. No customer-,
 * workload-, or account-specific wording: this file is scanned by the
 * source-genericity gate exactly like the catalog manifests it sits beside.
 *
 * Resolvable through `getOperation()` (lib/interpreter.ts), so every
 * existing request-facing surface (RequestDetail, MyRequests,
 * ApprovalsQueue, ChangeSetView) renders a drift-origin request's
 * title/description/exposure exactly like a catalog operation, with zero
 * changes to those files. The ONLY doors into a drift request are
 * submitting a generated proposal (adopt/revert/import/restore) or
 * starting a legitimize request, both from the Drift page — never a
 * manual request form. The api refuses all five ids on the normal submit
 * lane, and the mock mirrors that refusal for parity. `target`/
 * `codemodOp`/`params` are structural placeholders only: ManifestOperation
 * requires them, but nothing in the drift submit flow reads them — the
 * actual edit (or no-edit, or engineer-authored convergence, or import, or
 * restore) is catalogctl's/the engineer's job, driven entirely by the
 * pinned proposal, never by this shape.
 *
 * Adopt/revert/import/restore ride `l1_with_guardrails` exposure — the
 * guardrailed two-step ladder (a first approver, then a lead): two-person
 * review + 2FA via the EXISTING ladder machinery, no new approval code.
 * `forcesReplace` is structurally false for all five: replacement-flavored
 * drift is never generable, an import is pinned to a plan-verified
 * no-op-but-import (never a replace/create/destroy), a restore is pinned
 * to a plan-verified pure create or no-op (R9, restore-scoped-create —
 * never a replace/delete), and a legitimize request is a normal
 * engineer-authored change, never a forced replacement by construction.
 *
 * Legitimize (spec addendum A6, owner refinement 3 — "fixable in both
 * directions") rides `engineer_only` exposure instead: full-scrutiny
 * review, `NEEDS_ENGINEER` initial status, the SAME `[L2, L3]` ladder +
 * TOTP via the existing engineer track — an engineer authors the exact
 * Terraform converging code to the justified emergency change, a lead
 * records it via the normal link-pr flow, and the PR rides the ordinary CI
 * lane (whose plan is legitimately a no-op). The legitimize gate teaching
 * (L32) closes the loop: the in-portal bundle apply is fulfilled via this
 * engineer track + linked PR, never a separate button of its own — the
 * bundle apply is only the closure step, and its gate requires the plan
 * already be a clean no-op before it will run.
 *
 * Import (out-of-band provisioning spec: adopting an unmanaged resource
 * discovered by the account-wide sweep) also rides `l1_with_guardrails`,
 * but its `macd` is `'Add'` (a new resource block lands in code — an
 * import writes only state cloud-side) and its `riskFloor` is `'HIGH'`,
 * the SAME revert posture, not adopt's LOW: adopting an unknown actor's
 * resource into legitimacy is itself a posture judgment, so import submit
 * is approver/lead only, mirrored in lib/api.ts's mock exactly like
 * revert's role gate.
 *
 * Restore (drift restore tranche, L29 — a portal flavor for an
 * out-of-band DELETION, `oob_deletion`/D4) also rides `l1_with_guardrails`
 * and `macd: 'Add'` (cloud-side a resource comes back into existence — the
 * honest label; code-side nothing changes, since restore carries no edit
 * at all — it re-asserts the code already on main, scoped to the deleted
 * address). `riskFloor` is `'HIGH'` and `reversible` is `false` (re-creating
 * infrastructure is a real change, and undoing a restore is a real destroy
 * the portal will never perform) — submit is approver/lead only, mirrored
 * in lib/api.ts's mock exactly like revert/import's role gate. Unlike
 * import, restore carries no type-level security carve-out: it re-creates
 * from owned, reviewed code on main, the same safe direction as revert.
 */

export const SYSTEM_DRIFT_ADOPT = 'system-drift-adopt';
export const SYSTEM_DRIFT_REVERT = 'system-drift-revert';
export const SYSTEM_DRIFT_LEGITIMIZE = 'system-drift-legitimize';
export const SYSTEM_DRIFT_IMPORT = 'system-drift-import';
export const SYSTEM_DRIFT_RESTORE = 'system-drift-restore';

/** `true` for any of the five drift system-op ids — the one predicate
 * every "is this a drift op" check (submit refusal, getOperation fallback)
 * shares. */
export function isSystemDriftOp(operationId: string): boolean {
  return (
    operationId === SYSTEM_DRIFT_ADOPT ||
    operationId === SYSTEM_DRIFT_REVERT ||
    operationId === SYSTEM_DRIFT_LEGITIMIZE ||
    operationId === SYSTEM_DRIFT_IMPORT ||
    operationId === SYSTEM_DRIFT_RESTORE
  );
}

const shared = {
  macd: 'Change',
  codemodOp: 'set_attribute',
  target: { resourceType: 'drift' },
  params: [],
  exposure: 'l1_with_guardrails',
  forcesReplace: false,
  reversible: true,
  downtime: 'none',
  // The retired auto-apply-eligibility flag is deliberately left unset — it
  // is an optional field precisely so a synthesized in-memory operation
  // never has to carry it (see ManifestOperation's own doc comment); any
  // runtime source file naming that field at all fails this repo's own
  // mechanical retirement scan.
  group: 'danger-zone',
} as const satisfies Partial<ManifestOperation>;

/** The five system ops, in the same shape a catalog manifest operation
 * carries, so getOperation() can treat them identically to a real catalog
 * op everywhere downstream (ladder derivation, risk resolution, request
 * projection). */
export const SYSTEM_OPERATIONS: ManifestOperation[] = [
  {
    ...shared,
    id: SYSTEM_DRIFT_ADOPT,
    service: 'drift',
    title: 'Adopt benign drift (system-generated)',
    description:
      'Machine-generated adopt fix for benign in-place drift: sets the drifted attribute(s) to the live value the drift check observed, so code matches reality. Generated deterministically — no AI — by the drift-proposal generator; reachable only by submitting a generated proposal, never a manual request.',
    riskFloor: 'LOW',
    terraformCapability: '~ update (adopts the live value into code)',
  },
  {
    ...shared,
    id: SYSTEM_DRIFT_REVERT,
    service: 'drift',
    title: 'Revert security-posture drift (system-generated)',
    description:
      'Machine-generated revert for security-posture drift: carries no code edit — the gated apply re-imposes the code already on main over the console change. Security-posture drift is never adoptable from the portal; reachable only by submitting a generated proposal, never a manual request.',
    riskFloor: 'HIGH',
    terraformCapability: '~ apply the code already on main, scoped to the drifted addresses (no edit)',
  },
  {
    ...shared,
    id: SYSTEM_DRIFT_LEGITIMIZE,
    service: 'drift',
    exposure: 'engineer_only',
    title: 'Legitimize security-posture drift (engineer-authored)',
    description:
      'Starts a full-scrutiny request to converge code to a justified emergency console change instead of reverting it: an engineer authors the exact Terraform, a lead records it, and the change rides the normal review lane. Reachable only from a security drift row that already carries an open revert proposal, never a manual request; the revert option stays available until the next clean check closes the drift record.',
    riskFloor: 'HIGH',
    terraformCapability:
      '~ engineer-authored (converges code to the live emergency change; the bundle apply is the closure step once the linked PR lands and the plan is a clean no-op)',
  },
  {
    ...shared,
    id: SYSTEM_DRIFT_IMPORT,
    service: 'drift',
    macd: 'Add',
    title: 'Import an unmanaged resource (system-generated)',
    description:
      'Machine-generated import for a resource the account-wide sweep found live but unmanaged: writes a declarative import block plus the generated Terraform skeleton for the exact resource, so code catches up to reality without recreating anything. Generated deterministically — no AI — by the drift-proposal generator; reachable only by submitting a generated import proposal, never a manual request. The gate requires the resulting plan show only that import at a no-op, nothing else — never a create, update, or destroy anywhere.',
    riskFloor: 'HIGH',
    terraformCapability: '~ import (adds a state-only import plus its generated resource block; never a create/update/destroy)',
  },
  {
    ...shared,
    id: SYSTEM_DRIFT_RESTORE,
    service: 'drift',
    macd: 'Add',
    reversible: false,
    title: 'Restore an out-of-band deletion (system-generated)',
    description:
      'Machine-generated restore for a resource that was deleted out-of-band: re-asserts the code already on main, scoped to the deleted address — no code edit, no live values, ever. Generated deterministically — no AI — by the drift-proposal generator; reachable only by submitting a generated restore proposal, never a manual request. The gate requires the resulting plan show only a pure create (or an already-converged no-op) at the pinned address, nothing else.',
    riskFloor: 'HIGH',
    terraformCapability:
      '~ create (re-creates the deleted resource from the code already on main; no edit, no live values)',
  },
];
