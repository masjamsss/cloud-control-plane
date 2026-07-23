import type { ManifestOperation } from '@/types';

/**
 * The FIVE drift SYSTEM operations (drift-portal spec §4.4/addendum A6,
 * WI-6 + the 2026-07-20 audit-fix program's C2 + the OOB provisioning-import
 * spec §6's import flavor, WI-S6 + the 2026-07-20-drift-restore-tranche
 * plan's L29 restore flavor, register 0009) — a shared, estate-generic
 * module (no customer/workload/account-specific wording — it must pass
 * `verify-source-genericity` once WI-7 vendors a copy into the app, exactly
 * like the catalog manifests it sits beside).
 *
 * Resolvable by `manifests.ts#getOperation` (so `requirement.ts`/the ladder
 * machinery can resolve them like any other op) but REFUSED by the normal
 * submit lane (`routes/requests.ts` ⇒ 422 `DRIFT_PROPOSAL_REQUIRED`). The
 * ONLY doors into a drift request are `POST
 * /projects/:id/drift/proposals/:digest/submit` (adopt/revert/import/restore)
 * and `POST /projects/:id/drift/security/:digest/legitimize` (legitimize) —
 * routes/drift.ts — both build params entirely server-side from pinned,
 * digest-keyed evidence, never manifest-bounds-validated (`params: []`
 * below is deliberate: the params SCHEMA is the pinned proposal/evidence
 * payload, not manifest bounds, per spec §4.4/A6). `target`/`codemodOp` are
 * likewise structural placeholders: ManifestOperation requires them, but
 * nothing in the drift submit/legitimize or ladder path reads them — the
 * actual edit (or no-edit) is catalogctl's job (WI-4/WI-5/WI-S5/L29) or, for
 * legitimize, an engineer's hand-authored Terraform, driven by the pinned
 * evidence, never by this manifest shape.
 *
 * Adopt/revert/import/restore ride `l1_with_guardrails` ⇒ the [L2, L3]
 * ladder (an approver-or-lead, then a lead). Legitimize rides
 * `engineer_only` ⇒ the ENGINEER review tier (`NEEDS_ENGINEER` initial
 * status, same [L2, L3] ladder + TOTP machinery — spec addendum A6): a
 * justified emergency change gets full-scrutiny engineer authorship, never
 * the low-friction adopt shortcut. All five ride EXISTING ladder machinery,
 * no new approval code (spec §4.4 table + A6, OOB spec §6, L29 §2.5).
 * `forcesReplace` is structurally false for all five: replacement-flavored
 * drift is never generable (§6.2), R10 (OOB spec §7.2) admits no
 * replace/create/destroy on an import plan, and R9 (L29 §2.3) admits no
 * replace/delete on a restore plan either — so the replace-confirmation lane
 * never applies. Team scoping does not apply (estate-scoped, not
 * service-team scoped) — the normal submit lane never reaches these ops to
 * enforce it anyway, since it refuses them outright.
 */

export const SYSTEM_DRIFT_ADOPT = 'system-drift-adopt';
export const SYSTEM_DRIFT_REVERT = 'system-drift-revert';
/** C2 (spec addendum A6) — the legitimize front door: converges code to a
 * justified emergency security-posture change via a full-scrutiny
 * engineer-tier request. Never carries a code edit itself (an engineer
 * authors the exact Terraform); fulfilled via the existing engineer/
 * manual-PR track (`link-pr` + the normal CI lane), whose no-op plan is the
 * runbook's adopt-PR pattern. In-portal bundle apply for this op is
 * fulfilled via that engineer track + linked PR; the bundle apply is the
 * closure step — its gate (R11, register 0009 L32) requires the plan already
 * be a clean no-op before it will run. */
export const SYSTEM_DRIFT_LEGITIMIZE = 'system-drift-legitimize';
/** OOB provisioning-import spec §5.1/§6 — the import front door: an
 * out-of-band (unmanaged) resource's pinned Terraform `import` block plus
 * its reviewed HCL skeleton land in code; the gated apply performs a
 * state-only import (R10, §7.2, requires the post-edit plan show ONLY that
 * import, zero add/change/destroy) — never a cloud-side creation. Generated
 * deterministically by `catalogctl drift-propose --enable-import`
 * (ADR-0007 — no AI); reachable only via a drift proposal submit, never a
 * manual request. Unlike adopt/revert, import is estate-scoped evidence keyed
 * on a sweep FINDING (arn, or tfType+liveId when arn is null), not a
 * Terraform address — routes/drift.ts re-derives eligibility from the
 * CURRENT stored sweep, never the client, exactly as it does for adopt/
 * revert's verdicts (spec §8 enforcement point 2). */
export const SYSTEM_DRIFT_IMPORT = 'system-drift-import';
/** L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2) — the
 * restore front door: taxonomy category E (runbook D4), an out-of-band
 * DELETION (a resource present in code+state was removed outside
 * Terraform; the plan wants `create`). Re-asserts the code already on
 * `main`, scoped to the deleted address(es) — the revert doctrine applied to
 * a deletion instead of an in-place change: NO code edit, no live values,
 * ever. The gated apply performs a scoped create (R9, §2.3, requires the
 * plan show ONLY the pinned address(es) creating — or already converged
 * out-of-band, a no-op — zero other changes). Generated deterministically by
 * `catalogctl drift-propose --enable-restore` (ADR-0007 — no AI); reachable
 * only via a drift proposal submit, never a manual request. */
export const SYSTEM_DRIFT_RESTORE = 'system-drift-restore';

/** `true` for any of the five drift system-op ids — the one predicate the
 * direct `POST /requests` refusal (and any other "is this a drift op"
 * check) shares. */
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
  autoEligible: false,
  group: 'danger-zone',
} as const satisfies Partial<ManifestOperation>;

/** The five system ops, in the same shape `getManifests()` rows carry so
 * `getOperation` can treat them identically to a catalog op everywhere else
 * (ladder derivation, risk resolution, request projection). */
export const SYSTEM_OPERATIONS: ManifestOperation[] = [
  {
    ...shared,
    id: SYSTEM_DRIFT_ADOPT,
    service: 'drift',
    title: 'Adopt benign drift (system-generated)',
    description:
      'Machine-generated adopt fix for benign in-place drift (runbook D1): sets the drifted attribute(s) to the live value the drift check observed, so code matches reality. Generated deterministically by catalogctl drift-propose (ADR-0007 — no AI); reachable only via a drift proposal submit, never a manual request.',
    riskFloor: 'LOW',
    terraformCapability: '~ update (adopts the live value into code)',
  },
  {
    ...shared,
    id: SYSTEM_DRIFT_REVERT,
    service: 'drift',
    title: 'Revert security-posture drift (system-generated)',
    description:
      'Machine-generated revert for security-posture drift (runbook D2): carries no code edit — the gated apply re-imposes the code already on main over the console change. Security-posture drift is never adoptable from the portal (drift-portal spec §8); reachable only via a drift proposal submit, never a manual request.',
    riskFloor: 'HIGH',
    terraformCapability: '~ apply HEAD, scoped to the drifted addresses (no edit)',
  },
  {
    ...shared,
    id: SYSTEM_DRIFT_LEGITIMIZE,
    service: 'drift',
    title: 'Legitimize a justified emergency change (engineer review)',
    // engineer_only OVERRIDES shared.exposure (l1_with_guardrails) — this op
    // is the one drift system op that is NOT [L2,L3]-guardrails; it routes
    // to NEEDS_ENGINEER so a human engineer authors the exact Terraform
    // (spec addendum A6). The guard against a low-friction shortcut is the
    // engineer tier + full ladder, never concealment.
    exposure: 'engineer_only',
    description:
      'Converges code to a justified emergency security-posture change (runbook D2): an engineer authors the Terraform matching the live value; the plan is legitimately a no-op (the runbook adopt-PR pattern). Reachable only via POST /projects/:id/drift/security/:digest/legitimize, never a manual request; the drift-adopt shortcut stays permanently closed (fourth screen, §8) — this is the guarded full-scrutiny front door instead.',
    riskFloor: 'HIGH',
    terraformCapability: '~ engineer-authored update (converges code to the live, justified value)',
  },
  {
    ...shared,
    id: SYSTEM_DRIFT_IMPORT,
    service: 'drift',
    // macd OVERRIDES shared.macd ('Change') — an import lands a NEW resource
    // block in code (OOB spec §6: "a new resource block lands in code;
    // cloud-side an import writes only state"), the one drift system op that
    // is structurally an addition, not a change to something already there.
    macd: 'Add',
    // reversible OVERRIDES shared.reversible (true) — adopt/revert just flip
    // a value between live and code, either direction, cheaply. Undoing an
    // import is not that: it means removing the import block AND the
    // resource block (runbook D5's D4 interlock note) or actually deleting
    // the live resource (AGENTS.md rule 2 — human, always, never a portal
    // write). riskFloor HIGH below reflects the same asymmetry.
    reversible: false,
    title: 'Import an out-of-band resource (system-generated)',
    description:
      'Machine-generated import for an out-of-band (unmanaged) resource (OOB provisioning spec, runbook D5): a Terraform import block plus the reviewed HCL skeleton for that resource land in code; the gated apply performs a state-only import (R10 requires the plan show ONLY that import, zero add/change/destroy) — never a cloud-side creation. Generated deterministically by catalogctl drift-propose --enable-import (ADR-0007 — no AI); reachable only via a drift proposal submit, never a manual request.',
    // riskFloor HIGH (not adopt's LOW): this is the revert posture, not the
    // adopt one — adopting an unknown actor's resource into legitimacy is a
    // posture judgment (spec §6), and F-2 (creation-security types) is
    // permanently excluded from this lane regardless (spec §8 invariant 1).
    riskFloor: 'HIGH',
    terraformCapability: '~ import (state write only; a new resource block lands in code)',
  },
  {
    ...shared,
    id: SYSTEM_DRIFT_RESTORE,
    service: 'drift',
    // macd OVERRIDES shared.macd ('Change') — a restore brings a resource
    // back into existence cloud-side (an out-of-band deletion reversed);
    // code-side nothing changes (the code being re-asserted was never
    // removed) — the same "cloud-side creation" reasoning import's own macd
    // override documents above, applied to the opposite starting point (a
    // deletion, not an unmanaged resource).
    macd: 'Add',
    // reversible OVERRIDES shared.reversible (true) — adopt/revert just flip
    // a value between live and code, cheaply, either direction. Undoing a
    // restore is not that: it means actually destroying the resource again
    // (AGENTS.md rule 2 — human, always, never a portal write), the same
    // asymmetry import's own reversible override documents.
    reversible: false,
    title: 'Restore an out-of-band-deleted resource (system-generated)',
    description:
      'Machine-generated restore for an out-of-band deletion (runbook D4): re-asserts the code already on main, scoped to the deleted address(es) — no code edit, no live values, ever (the revert doctrine applied to a deletion). The gated apply performs a scoped create (R9 requires the plan show ONLY the pinned address(es) creating, or already converged out-of-band as a no-op — zero other changes) — never adopts unreviewed content. Generated deterministically by catalogctl drift-propose --enable-restore (ADR-0007 — no AI); reachable only via a drift proposal submit, never a manual request.',
    // riskFloor HIGH (not adopt's LOW): re-creating infrastructure is a real
    // change — the revert/import posture, never adopt's LOW (register 0009 L29).
    riskFloor: 'HIGH',
    terraformCapability: '~ create (re-asserts the deleted resource from the code already on main)',
  },
];
