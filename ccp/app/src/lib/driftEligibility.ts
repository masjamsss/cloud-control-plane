import type { DriftFinding, DriftVerdict } from '@/types/drift';

/**
 * The drift-proposal eligibility partition — the app's own port of the SAME
 * table the Go generator (catalogctl drift-propose) and the api's
 * server-side re-check (ccp/api/src/domain/driftProposals.ts) both
 * implement: one table, three implementations, one shared fixture
 * (tools/catalogctl/testdata/driftpropose/eligibility-cases.json),
 * consumed byte-for-byte by every implementation's own test suite —
 * test/driftEligibilityParity.test.ts is this app's copy of that proof. A
 * case added to the fixture fails every implementation that disagrees.
 *
 * This is the checkout-INDEPENDENT half only — pure verdict fields, no
 * filesystem, no network — the same limitation the api's re-check carries;
 * only catalogctl's Go generator layers the checkout-dependent refinement
 * (does the address resolve, can the edit actually be spliced) on top.
 *
 * Used by the drift surface (features/drift/) to render an honest per-row
 * proposal state even when the server's generated proposals don't (yet, or
 * ever) cover an eligible-looking verdict. NEVER used to grant a submit
 * affordance on its own, and never trusted as the reason a verdict may
 * adopt: the server re-derives this from the stored report at submit time
 * regardless of what the client computed — this is advisory, defense in
 * depth, never the enforcement (the binding invariant: security-posture
 * drift is surfaced and reverted, never adopted).
 */

export type DriftBucket = 'adopt' | 'revert' | 'restore' | 'ungenerable';

export interface DriftEligibility {
  bucket: DriftBucket;
  reason: string;
}

/** The minimal verdict shape {@link classifyDrift} reads. */
export type ClassifiableVerdict = Pick<
  DriftVerdict,
  'class' | 'riskTier' | 'actions' | 'forceNewAttrs' | 'driftEvidence' | 'changedAttrs' | 'securityHits'
>;

/**
 * `isSecurityPosture(v) := v.class == 'security_posture' OR v.securityHits`
 * non-empty — the fail-closed union every enforcement point in this system
 * shares. Widens, never narrows: an unrecognized class is not itself
 * security-posture, but a present securityHits row always is, regardless of
 * what `class` says.
 */
export function isSecurityPosture(v: Pick<DriftVerdict, 'class' | 'securityHits'>): boolean {
  return v.class === 'security_posture' || (v.securityHits?.length ?? 0) > 0;
}

/**
 * The closed, versioned eleven-class enum the classifier emits (the drift
 * runbook's D1-D11 taxonomy), mapped to its runbook id for ungenerable
 * reason strings, plus a per-class enrichment `note` (the plan's
 * "Reason-string enrichment" contract, parity-pinned against the shared
 * fixture) naming the manual
 * path for a class that is never auto-generable. `benign_inplace` (adopt),
 * `security_posture` (revert-only, handled entirely by the
 * `isSecurityPosture` branch above), and `oob_deletion` (restore-eligible,
 * handled entirely by its own branch in {@link classifyDrift} below — the
 * drift restore tranche, L29) carry no note — none of the three ever
 * reaches the generic per-class ungenerable message below. An unrecognized
 * class id fails closed here too — ungenerable, never adopt-eligible — so
 * an additive classifier class can never brick this UI.
 *
 * DEVIATION FROM THE BYTE-PINNED TEXT (documented, deliberate): three of
 * these notes (D3, D3b, D7) are reworded from the plan's literal text.
 * The plan's originals cite the section-sign character and bare
 * proposal/register numbers (e.g. a four-digit register id followed by an
 * item letter, or a proposal number + subsection) — both are banned from
 * shipped app source by this app's own pre-existing copy-quality gates
 * (`src/test/copyLint.test.ts`'s "no spec-section notation or
 * proposal/register reference in rendered UI strings" rule) and, for the
 * section-sign character specifically, also by
 * `scripts/verify-source-genericity.ts` (`npm run verify:safety`) — both
 * wired into THIS lane's own acceptance. These reason strings are
 * operator-facing (rendered by the drift surface), so they are in scope for
 * both gates. Owner-settled 2026-07-20: the FIXTURE yields, not the app
 * gates — Lane A lands the same reworded text (verbatim, below) into the
 * shared fixture with its own A2 follow-up, so this stops being a
 * deviation once that lands. `provider_noise`'s note is reworded on the
 * same principle but has no fixture case yet to reconcile against.
 * `oob_deletion`'s (D4) note is RETIRED entirely by the drift restore
 * tranche (L29), not merely reworded: restore eligibility now has its own
 * dedicated branch in {@link classifyDrift}, with its own byte-pinned
 * reason strings (the shared fixture's `eligibility-cases.json`), so no
 * rewording deviation applies to it any longer.
 */
const KNOWN_CLASSES: Record<string, { id: string; note?: string }> = {
  benign_inplace: { id: 'D1' },
  security_posture: { id: 'D2' },
  replacement_forcenew: {
    id: 'D3',
    note:
      'ADOPT arm is safe and human-preparable today (runbook D3 adopt-PR, docs/runbooks/drift-detection.md); a guided portal lane is tracked in the limitations register',
  },
  replacement_risk: {
    id: 'D3b',
    note:
      'ADOPT arm is safe and human-preparable today (runbook D3b adopt-PR, docs/runbooks/drift-detection.md); a guided portal lane is tracked in the limitations register',
  },
  // D4 — restore-eligible (a pure create with drift evidence) is handled by
  // its own branch in classifyDrift, BEFORE this map's generic per-class
  // message is ever consulted for this class, so this note is unreachable —
  // left empty (not deleted) so KNOWN_CLASSES stays the complete, closed
  // D1-D11 class→id map every reader depends on.
  oob_deletion: { id: 'D4' },
  legit_churn: {
    id: 'D6',
    note: 'ignore_changes + registry row — an engineer PR per runbook D6',
  },
  provider_noise: {
    id: 'D7',
    note: "adopt the provider's canonical form per runbook D7 (a phase-2 candidate per the drift-on-portal assessment)",
  },
  state_anomaly: {
    id: 'D8',
    note: 'state surgery per docs/runbooks/state-recovery.md (runbook D8)',
  },
  moved_refactor: {
    id: 'D9',
    note: 'verify the moved{} no-op per runbook D9',
  },
  unapplied_config: {
    id: 'D10',
    note: 'merged code awaiting the normal apply lane (runbook D10) — not console drift',
  },
  churn_absorbed: {
    id: 'D11',
    note: 'already absorbed by an existing ignore_changes (runbook D11)',
  },
};

function actionsAreUpdate(actions: string[] | undefined): boolean {
  return !!actions && actions.length === 1 && actions[0] === 'update';
}

/** The restore-flavor mirror of {@link actionsAreUpdate}: a pure create is
 * the ONLY plan shape a restore can ride (R9, restore-scoped-create). */
function actionsAreCreate(actions: string[] | undefined): boolean {
  return !!actions && actions.length === 1 && actions[0] === 'create';
}

/** Go's `%v` on a `[]string` — mirrored so the ungenerable reason strings
 * this function returns are byte-identical to the Go generator's and the
 * api's re-check (the shared fixture is what proves it). */
function fmtActions(actions: string[] | undefined): string {
  return `[${(actions ?? []).join(' ')}]`;
}

/**
 * The normalized shape of a `pathSegments` value (spec addendum A4 / plan
 * F8) — the same normalization contract in all three implementations
 * (Go generator, api TS re-check, this app port): absent ⇒ LEGACY (fall
 * back to the pre-F8 display-path rule below); a well-formed array (≥1
 * elements, each a string or a non-negative integer) ⇒ SEGMENTS; anything
 * else (not an array, empty, or any element of another shape — a negative
 * or fractional number, a boolean, an object, …) ⇒ MALFORMED. A malformed
 * value is never expressible — fail closed, never a runtime crash.
 */
export type NormalizedSegments =
  | { kind: 'legacy' }
  | { kind: 'segments'; segments: Array<string | number> }
  | { kind: 'malformed' };

export function normalizeSegments(pathSegments: unknown): NormalizedSegments {
  if (pathSegments === undefined) return { kind: 'legacy' };
  if (!Array.isArray(pathSegments) || pathSegments.length === 0) return { kind: 'malformed' };
  const segments: Array<string | number> = [];
  for (const el of pathSegments) {
    if (typeof el === 'string') segments.push(el);
    else if (typeof el === 'number' && Number.isInteger(el) && el >= 0) segments.push(el);
    else return { kind: 'malformed' };
  }
  return { kind: 'segments', segments };
}

/**
 * Whether one changed-attribute path is expressible by the adopt edit
 * engine — re-derived per addendum A4, `(path, pathSegments?)`.
 *
 * `pathSegments` ABSENT (LEGACY, pre-F8 envelopes): the original
 * display-path rule — no brackets, at most two dot-parts
 * (`path.split('.').length <= 2`) — unchanged, so a legacy envelope with no
 * `pathSegments` at all behaves exactly as it did before F8.
 *
 * `pathSegments` PRESENT: the structured shapes F8/W1 unlock — `[s]` a
 * top-level scalar · `[s, s]` a map key, ANY key bytes (dotted, slashed, or
 * spaced keys — e.g. `kubernetes.io/role/elb`, `Cost Center` — are now
 * expressible, where the legacy dot-split rule would have mis-split them)
 * · `[s, 0, s]` a single-instance nested-block leaf, index MUST be the
 * literal integer `0` (any other index, or a 4th+ segment, is an ambiguous
 * repeated-block/deep shape — register 0009 L28 — refused, never guessed).
 * Malformed segments (see {@link normalizeSegments}) are never expressible.
 */
export function pathExpressible(path: string, pathSegments?: unknown): boolean {
  const normalized = normalizeSegments(pathSegments);
  if (normalized.kind === 'malformed') return false;
  if (normalized.kind === 'legacy') {
    if (!path || /[[\]]/.test(path)) return false;
    return path.split('.').length <= 2;
  }
  const segs = normalized.segments;
  if (segs.length === 1) return typeof segs[0] === 'string';
  if (segs.length === 2) return typeof segs[0] === 'string' && typeof segs[1] === 'string';
  if (segs.length === 3) {
    return typeof segs[0] === 'string' && segs[1] === 0 && typeof segs[2] === 'string';
  }
  return false;
}

/**
 * Partitions one verdict into adopt / revert / restore / ungenerable,
 * re-deriving every condition from verdict FIELDS — the `class` label is
 * never trusted alone (the same doctrine as the ForceNew gate never
 * trusting prose). `isSecurityPosture` is checked FIRST and
 * unconditionally: a security verdict can structurally never reach the
 * `adopt` (or `restore`) branch below, no matter what its `class` or any
 * other field says — including a forged `securityHits` row on an
 * `oob_deletion`-classed verdict, an honest classifier can never emit
 * (`changedAttrs` is structurally `[]` on a pure create), but this
 * function still refuses it the same way it refuses any other
 * security-posture shape.
 */
export function classifyDrift(v: ClassifiableVerdict): DriftEligibility {
  if (isSecurityPosture(v)) {
    if (!actionsAreUpdate(v.actions)) {
      return {
        bucket: 'ungenerable',
        reason: `security-posture drift with actions ${fmtActions(v.actions)} (not a pure in-place update) — not mechanically revertible, human decision required (runbook D2)`,
      };
    }
    if ((v.forceNewAttrs?.length ?? 0) > 0) {
      return {
        bucket: 'ungenerable',
        reason:
          'security-posture drift with forceNew attribute(s) present — replacement-flavored security drift is a human conversation, never a portal button (runbook D2/D3)',
      };
    }
    return { bucket: 'revert', reason: 'security-posture drift — revert-only' };
  }

  // F7 / hostile-class-proto: prototype-safe lookup — `v.class in
  // KNOWN_CLASSES` would let `__proto__`/`constructor`/`toString` resolve
  // through the prototype chain and pass this screen; `Object.hasOwn` never
  // does, mirroring the Go generator's own hardening.
  if (!Object.hasOwn(KNOWN_CLASSES, v.class)) {
    return {
      bucket: 'ungenerable',
      reason: `unknown class ${JSON.stringify(v.class)} — fail-closed, needs-human (the eleven-class D1-D11 enum is closed)`,
    };
  }

  // Drift restore tranche (L29): oob_deletion gets its own carve-out here,
  // BEFORE the generic per-class ungenerable message below — a resource
  // present in code+state that a console deletion removed. The revert
  // doctrine applied to deletions: restore re-asserts the code already on
  // main, scoped to the deleted address; no code edit, no live values,
  // ever. Order is pinned by the shared fixture: wrong actions is checked
  // BEFORE missing evidence, so a genuinely-eligible-shaped deletion still
  // carrying a freshness problem gets the sharper "not a pure create"
  // reason rather than the generic evidence one.
  if (v.class === 'oob_deletion') {
    if (!actionsAreCreate(v.actions)) {
      return {
        bucket: 'ungenerable',
        reason: `oob_deletion drift with actions ${fmtActions(v.actions)} (not a pure create) — not mechanically restorable, human decision required (runbook D4)`,
      };
    }
    if (!v.driftEvidence) {
      return { bucket: 'ungenerable', reason: 'no drift evidence — unapplied config, not drift (see runbook D10)' };
    }
    return {
      bucket: 'restore',
      reason: 'out-of-band deletion — restore-eligible (re-assert code; the plan re-creates the deleted resource)',
    };
  }

  if (v.class !== 'benign_inplace') {
    // security_posture never reaches here (isSecurityPosture returns above,
    // unconditionally) — oob_deletion never reaches here either (the
    // branch above intercepts it first) — every class arriving here
    // carries a `note`.
    const known = KNOWN_CLASSES[v.class]!;
    return {
      bucket: 'ungenerable',
      reason: `class ${JSON.stringify(v.class)} is not auto-generable in v1 — ${known.note}`,
    };
  }
  if (v.riskTier !== 'low') {
    return { bucket: 'ungenerable', reason: `riskTier ${JSON.stringify(v.riskTier ?? '')} is not low` };
  }
  if (!actionsAreUpdate(v.actions)) {
    return { bucket: 'ungenerable', reason: `actions ${fmtActions(v.actions)} are not exactly [update]` };
  }
  if ((v.forceNewAttrs?.length ?? 0) > 0) {
    return { bucket: 'ungenerable', reason: 'forceNew attribute(s) present — not generable in v1 (see runbook D3b)' };
  }
  if (!v.driftEvidence) {
    return { bucket: 'ungenerable', reason: 'no drift evidence — unapplied config, not drift (see runbook D10)' };
  }
  if (!v.changedAttrs || v.changedAttrs.length === 0) {
    return { bucket: 'ungenerable', reason: 'no changed attributes to adopt' };
  }
  for (const a of v.changedAttrs) {
    if (a.sensitive === true || a.liveJson === undefined) {
      return {
        bucket: 'ungenerable',
        reason: `attribute ${JSON.stringify(a.path)} is sensitive or missing a machine (liveJson) value`,
      };
    }
    if (!pathExpressible(a.path, a.pathSegments)) {
      return {
        bucket: 'ungenerable',
        reason: `attribute ${JSON.stringify(a.path)} has a value shape not expressible by the edit engine`,
      };
    }
  }
  return { bucket: 'adopt', reason: 'benign in-place drift — adopt-eligible' };
}

/**
 * The out-of-band provisioning spec's FINDING-partition table (distinct
 * from {@link classifyDrift}'s VERDICT partition above: a finding has no
 * Terraform address, and is never itself drift on a managed resource — it
 * is a live-but-unmanaged resource the account-wide sweep saw). The app's
 * own port of the SAME table the Go generator
 * (tools/catalogctl/internal/driftpropose/finding.go's ClassifyFinding) and
 * the api's server-side re-check both implement — one table, three
 * implementations, one shared fixture
 * (tools/catalogctl/testdata/driftpropose/unmanaged-cases.json), consumed
 * byte-for-byte by every implementation's own test suite —
 * test/driftFindingEligibilityParity.test.ts is this app's copy of that
 * proof. Only five of the table's buckets are ever produced here — the F-1
 * (import) .. F-4 (payload_withheld) rows the Go doc enumerates, plus the
 * defensive `ungenerable` fallback for a finding whose `class` isn't the
 * constant `unmanaged_resource` id (mirrors classifyDrift's own unknown-
 * class fail-closed branch). A finding that would land in "ignored",
 * "family-level-only", or "invisible" never becomes a finding row at all
 * (those are filtered, or never captured, upstream of the envelope) — see
 * DriftSweep's own doc for where those three buckets surface instead
 * (counts / coverage / the standing footer, never a finding).
 */
export type FindingBucket = 'import' | 'creation_security' | 'type_unmapped' | 'payload_withheld' | 'ungenerable';

export interface FindingEligibility {
  bucket: FindingBucket;
  reason: string;
}

/** The constant class id every sweep finding carries
 * (importer/kit/statediff.py's FINDING_CLASS) — mirrors
 * tools/catalogctl/internal/driftpropose/finding.go's `findingClass`. */
const FINDING_CLASS = 'unmanaged_resource';

/** The minimal finding shape {@link classifyFinding} reads — the
 * checkout-INDEPENDENT half only (the same limitation
 * {@link ClassifiableVerdict} carries above): whether the pinned address
 * already resolves in the checkout is a Go-only refinement layered on top
 * by catalogctl's generator, never expressible from these fields alone.
 * Mirrors the Go `Finding` struct's own field set exactly (class, tfType,
 * securityFamily, importPayload, payloadWithheldReason) — deliberately
 * `importPayload` itself, never a separate "present" boolean: that flag
 * (`importPayloadPresent`) exists ONLY on a requester-projected wire row
 * (see DriftFinding's own doc) and this function never runs against one
 * (findingProposalStateFor short-circuits to `null` before ever calling
 * this when `proposals` — an approver+-only field — is absent). */
export type ClassifiableFinding = Pick<
  DriftFinding,
  'class' | 'tfType' | 'securityFamily' | 'importPayload' | 'payloadWithheldReason'
>;

/** Mirrors `FindingImportPayload.complete()` (finding.go): every one of
 * the four sub-fields F-1's own condition names must be non-empty. Treats
 * a MISSING sub-field the same as an empty one — the Go struct's plain
 * (non-pointer) `string` fields zero-value to `""` when a key is absent
 * from JSON, so "missing" and "empty" are indistinguishable there; this
 * mirrors that exactly rather than letting JS's `undefined` slip through
 * as "truthy" (i.e. wrongly "complete"). */
function findingPayloadComplete(payload: DriftFinding['importPayload']): boolean {
  const nonEmpty = (s: string | undefined): boolean => (s ?? '') !== '';
  return (
    !!payload &&
    nonEmpty(payload.address) &&
    nonEmpty(payload.targetFile) &&
    nonEmpty(payload.importBlock) &&
    nonEmpty(payload.skeletonHcl)
  );
}

/**
 * Partitions one unmanaged-resource finding into import / creation_security
 * / type_unmapped / payload_withheld / ungenerable, re-deriving every
 * condition from the finding's own FIELDS — mirroring {@link classifyDrift}'s
 * doctrine exactly, one level down, and BYTE-FOR-BYTE mirroring
 * ClassifyFinding's own check order (finding.go), pinned by the shared
 * fixture:
 *
 * 1. `class` must be the constant `unmanaged_resource` id — fail-closed,
 *    checked FIRST (prototype-safe: a plain `!==` string compare, never an
 *    object-key lookup, so a hostile `class: '__proto__'` value is exactly
 *    as ungenerable as any other unrecognized string).
 * 2. `tfType` empty/whitespace-only ⇒ `type_unmapped` — checked BEFORE
 *    `securityFamily`, so an unmapped-type finding reads as type_unmapped
 *    even when ALSO flagged securityFamily (the fixture's
 *    "type-unmapped-wins-over-security-family" case: without a known type,
 *    "is this a creation-security TYPE" cannot even be asked).
 * 3. `securityFamily` truthy ⇒ `creation_security` — a finding whose type is
 *    a creation-security type can structurally never reach the `import`
 *    branch below, no matter what any other field (payload presence, a
 *    withheld reason, or any candidate proposal's own `flavor` label) says;
 *    the SPA never renders an import affordance on a security-family
 *    finding, and this ordering is why that holds even when a
 *    `payloadWithheldReason` is ALSO present (the fixture's
 *    "creation-security-wins-over-missing-payload" case) — this is
 *    defense-in-depth, the same doctrine {@link classifyDrift} documents for
 *    security-posture verdicts, never the enforcement itself (spec: three
 *    independent screens, this is the advisory copy of the first).
 * 4. `importPayload` missing or incomplete ⇒ `payload_withheld`, reason =
 *    the finding's own `payloadWithheldReason` when it carries one, else a
 *    fixed mechanical fallback (idle/uncapped/excluded — never guessed
 *    beyond that).
 * 5. Otherwise ⇒ `import`.
 *
 * `securityFamily` MISSING (not just `false`) is treated as NOT
 * security-family — the same zero-value-on-absence the Go struct's plain
 * `bool` field carries (see DriftFinding's own doc) — deliberately, so this
 * stays byte-parity with the reference rather than inventing a stricter
 * client-only default.
 */
export function classifyFinding(f: ClassifiableFinding): FindingEligibility {
  if (f.class !== FINDING_CLASS) {
    return {
      bucket: 'ungenerable',
      reason: `finding class ${JSON.stringify(f.class)} is not ${JSON.stringify(FINDING_CLASS)} — fail-closed, needs-human (the finding partition only recognizes the constant unmanaged_resource class id)`,
    };
  }
  if ((f.tfType ?? '').trim() === '') {
    return {
      bucket: 'type_unmapped',
      reason:
        'tfType is absent — this resource type is outside the services.json 43-type map; extend services.json (a data change + fixture) or use the manual kit import lane',
    };
  }
  if (f.securityFamily) {
    return {
      bucket: 'creation_security',
      reason: `tfType ${JSON.stringify(f.tfType)} is flagged securityFamily — creation-security types are never portal-importable; investigate per runbook D2/D5 (the actor evidence is the head start), then either delete-in-AWS (human + owner sign-off) or a manual engineer-tier kit-lane import PR`,
    };
  }
  if (!findingPayloadComplete(f.importPayload)) {
    const withheld = f.payloadWithheldReason;
    const reason =
      withheld && withheld.trim() !== ''
        ? withheld
        : "no import payload was generated for this finding — payload generation may not be armed for this sweep, this finding fell outside the 20-candidate cap, or it was excluded upstream; see the sweep run's payload step";
    return { bucket: 'payload_withheld', reason };
  }
  return { bucket: 'import', reason: 'unmanaged resource — import-eligible' };
}
