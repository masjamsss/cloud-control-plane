import type { DriftFinding, DriftProposal, DriftVerdict } from '@/types/drift';
import { classifyDrift, classifyFinding } from '@/lib/driftEligibility';

/**
 * The per-row proposal state the `/drift` verdict table renders — one of
 * the drift-portal surface's five states: a live matching proposal (adopt,
 * revert, or restore — the drift restore tranche, L29), a verdict the
 * partition itself refuses (ungenerable), or an eligible-looking verdict
 * with no matching proposal at all (most plausibly because proposal
 * generation isn't armed on this deployment — the honest default
 * explanation the portal states plainly rather than guessing).
 */
export type DriftProposalState =
  | { kind: 'adopt'; proposal: DriftProposal }
  | { kind: 'revert'; proposal: DriftProposal }
  | { kind: 'restore'; proposal: DriftProposal }
  | { kind: 'ungenerable'; reason: string }
  | { kind: 'not-armed' };

/**
 * Derives one verdict's proposal state. `proposals` absent (the Requester
 * tier never receives it — the field-tier rule, same as attribute values
 * and security evidence) renders nothing at all: `null`, not a guessed
 * state built from partial data.
 *
 * THE BINDING INVARIANT, re-derived here defensively: the bucket driving
 * which proposal is matched comes from {@link classifyDrift} over the
 * VERDICT's own fields, never from a candidate proposal's own `flavor`
 * label. Because `classifyDrift` checks security-posture first and
 * unconditionally, this function can structurally never return `{kind:
 * 'adopt'}` for a security-posture verdict — not even if `proposals`
 * contained a forged or stale row claiming `flavor: 'adopt'` for that
 * address. Security-posture drift is surfaced and reverted, never adopted;
 * this is advisory defense in depth on top of the server's own
 * enforcement, never a substitute for it.
 */
export function driftProposalStateFor(
  verdict: DriftVerdict,
  proposals: DriftProposal[] | undefined,
): DriftProposalState | null {
  if (proposals === undefined) return null;
  const { bucket, reason } = classifyDrift(verdict);
  if (bucket === 'ungenerable') return { kind: 'ungenerable', reason };
  const match = proposals.find(
    (p) => p.status !== 'superseded' && p.flavor === bucket && p.addresses.includes(verdict.address),
  );
  return match ? { kind: bucket, proposal: match } : { kind: 'not-armed' };
}

/**
 * The per-row state the unmanaged-resources section renders — one level
 * down from {@link DriftProposalState}, for a FINDING instead of a verdict
 * (out-of-band provisioning spec). A live matching import proposal
 * (`import`), a finding the partition itself refuses for a structural
 * reason (`creation_security` / `type_unmapped` / `payload_withheld` /
 * `ungenerable` — the UI collapses the latter three into ONE non-clickable,
 * reason-carrying chip, since none of them is ever actionable from the
 * portal; `creation_security` renders distinctly, its own safety-relevant
 * state), or an import-eligible-looking finding with no matching proposal
 * yet (`not-armed`, most plausibly because import generation isn't armed
 * on this deployment — the same honest default explanation
 * {@link driftProposalStateFor} states for verdicts).
 */
export type FindingProposalState =
  | { kind: 'import'; proposal: DriftProposal }
  | { kind: 'creation_security'; reason: string }
  | { kind: 'type_unmapped'; reason: string }
  | { kind: 'payload_withheld'; reason: string }
  | { kind: 'ungenerable'; reason: string }
  | { kind: 'not-armed' };

/**
 * Derives one finding's proposal state. `proposals` absent (the Requester
 * tier never receives it) renders nothing at all: `null`, matching
 * {@link driftProposalStateFor}'s own doctrine exactly.
 *
 * THE BINDING INVARIANT, re-derived here defensively, one level down: the
 * bucket driving which proposal is matched comes from
 * {@link classifyFinding} over the FINDING's own fields, never from a
 * candidate proposal's own `flavor` label. Because `classifyFinding` checks
 * `securityFamily` first and unconditionally, this function can
 * structurally never return `{kind: 'import'}` for a security-family
 * finding — not even if `proposals` contained a forged or stale row
 * claiming `flavor: 'import'` for that finding's address. The SPA never
 * renders an import affordance on a security-family finding; this is
 * advisory defense in depth on top of the server's own three independent
 * screens, never a substitute for them.
 *
 * Matched by `importPayload.address` — a finding carries no Terraform
 * address of its own to key on until import-payload generation names one
 * (see `DriftFinding`'s own doc comment); a finding with no payload can
 * never reach the `import` branch of `classifyFinding` in the first place,
 * so this lookup only ever runs for a finding that HAS an address to
 * match on.
 */
export function findingProposalStateFor(
  finding: DriftFinding,
  proposals: DriftProposal[] | undefined,
): FindingProposalState | null {
  if (proposals === undefined) return null;
  const { bucket, reason } = classifyFinding(finding);
  if (bucket !== 'import') return { kind: bucket, reason };
  const address = finding.importPayload?.address;
  const match =
    address !== undefined
      ? proposals.find((p) => p.status !== 'superseded' && p.flavor === 'import' && p.addresses.includes(address))
      : undefined;
  return match ? { kind: 'import', proposal: match } : { kind: 'not-armed' };
}
