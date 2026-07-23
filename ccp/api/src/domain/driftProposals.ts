import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConfigStore, TransactWrite } from '../store/configStore';
import type { DriftProposalItem } from '../store/schema';
import { DRIFT_PROPOSAL_SK_PREFIX, driftProposalKey } from '../store/schema';
import { record, transactWithAudit } from './audit';
import type { DriftFinding, DriftVerdict } from './drift';
import { isSecurityPosture, parseStoredEnvelope, readDriftReport } from './drift';
import { nowIso } from '../clock';

/**
 * Drift proposal store + the async generation seam — the api-side half of
 * WI-6, docs/superpowers/specs/2026-07-20-ccp-drift-portal.md §3.2/§6.2/
 * §6.3, extended by WI-S6, docs/superpowers/specs/2026-07-20-ccp-oob-provisioning-import.md
 * §6 for the `import` flavor. Four things live here, mirroring the split
 * `domain/drift.ts` (WI-2) and `domain/bundle.ts` (ADR-0016) already
 * established:
 *
 *  1. §6.2 THE ELIGIBILITY PARTITION, re-derived server-side — a from-scratch
 *     TypeScript port of catalogctl's `internal/driftpropose.ClassifyByFields`
 *     (tools/catalogctl/internal/driftpropose/partition.go). This is the "api
 *     TS re-check" the spec names: "one table, three implementations, one
 *     fixture" — `test/driftProposals.test.ts` proves this port agrees with
 *     `tools/catalogctl/testdata/driftpropose/eligibility-cases.json` on
 *     every case. Used by `routes/drift.ts`'s submit handler to RE-DERIVE
 *     eligibility from the STORED report verdicts at submit time, never
 *     trusting a proposal's own claimed flavor (§8 enforcement point 2).
 *     Extended by the 2026-07-20-drift-restore-tranche plan's L29 (register
 *     0009) with a `restore` bucket for out-of-band DELETIONS (taxonomy D4):
 *     the SAME "one table, three implementations, one fixture" doctrine, the
 *     SAME fixture file, one more bucket.
 *
 *  1b. OOB spec §5.2 THE FINDING PARTITION, import's own twin of the above —
 *     a from-scratch TypeScript port of `internal/driftpropose.ClassifyFinding`
 *     (tools/catalogctl/internal/driftpropose/finding.go), kept honest by the
 *     SAME "one table, three implementations, one fixture" doctrine against
 *     `tools/catalogctl/testdata/driftpropose/unmanaged-cases.json`. A
 *     finding has no Terraform address (that is its defining property, spec
 *     §3.1) so this is a SEPARATE partition, not a widened `DriftBucket` —
 *     used by `routes/drift.ts`'s submit handler to re-derive IMPORT
 *     eligibility from the CURRENT stored report's `sweep.findings`, never
 *     the proposal's own frozen copy (spec §5.3 screen 2).
 *
 *  2. The digest-keyed proposal STORE (§3.2): read/write the on-disk body
 *     (`<dataRoot>/<id>/drift/proposals/<digest>.json`) beside the
 *     `DriftProposalItem` metadata row, mirroring `domain/drift.ts`'s report
 *     version store. Extended, additively, for the `import` flavor's own
 *     pinned payload (OOB spec §5.1/§5.4).
 *
 *  3. §6.3 THE GENERATION SEAM: `DriftGenSteps`, a bundle-style injected
 *     command (mirrors `domain/bundle.ts#BundleSteps`) that spawns the
 *     operator-configured `CCP_DRIFT_GEN_CMD` (which itself runs
 *     `catalogctl drift-propose`) inside a scratch checkout, plus the pure
 *     orchestration (`runDriftGen`) and the async, non-reentrant, per-project
 *     scheduler (`scheduleDriftGeneration`) `routes/drift.ts`'s PUT handler
 *     fires after staging a report.
 *
 * PLACEMENT (binding, like bundle.ts): this file lives at
 * domain/driftProposals.ts, NOT domain/apply/ — the schedulerGating contract
 * test (INVARIANT #1) rightly forbids process spawns in the timer-driven
 * apply subsystem, and generation here is upload-triggered, never
 * timer-driven, exactly the bundle's reasoning for its own placement.
 *
 * OFF BY DEFAULT (the loop.ts/bundle.ts/drift.ts invariant):
 * {@link driftGenConfig} returns null unless `CCP_DRIFT_PROPOSALS=1` AND
 * `CCP_DRIFT_GEN_CMD` AND `CCP_GIT_REMOTE` are ALL explicitly set —
 * merging this changes ZERO production behavior until an operator arms it.
 * Generation failure is fail-open (spec §6.3): the report already staged and
 * responded 201; a failed/unarmed generation only means proposals don't
 * refresh — never un-stages the report. {@link driftImportArmed} (OOB spec
 * §9) is the SUBMIT-time twin: `CCP_DRIFT_IMPORT=1` gates import-flavor
 * submit ONLY — serve of findings rides `CCP_DRIFT` alone, generation
 * rides `--enable-import` inside the operator's own `CCP_DRIFT_GEN_CMD`.
 */

type Env = Record<string, string | undefined>;

/** OOB provisioning-import spec §9/§6: import-flavor SUBMIT requires
 * `CCP_DRIFT_IMPORT=1` in addition to the top-level `CCP_DRIFT` arming
 * `routes/drift.ts` already checks first — a distinct, narrower gate so an
 * operator can serve findings (and even adopt/revert) without yet arming the
 * import lane. Off by default, the same loop.ts/bundle.ts/drift.ts
 * invariant every other arming flag in this codebase follows. */
export function driftImportArmed(env: Env = process.env): boolean {
  return env.CCP_DRIFT_IMPORT === '1';
}

/** L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2.5/§3): the
 * restore-flavor SUBMIT's own, narrower gate — exactly the `driftImportArmed`
 * precedent, distinct env var. `routes/drift.ts` checks this ONLY once the
 * primary proposal's own flavor is known to be `restore`, in addition to the
 * top-level `CCP_DRIFT` arming already checked first. Off by default, the
 * same loop.ts/bundle.ts/drift.ts invariant every other arming flag in this
 * codebase follows; serve of the proposal rides `CCP_DRIFT` alone (the
 * import precedent — generation itself is armed separately, via
 * `--enable-restore` inside the operator's own `CCP_DRIFT_GEN_CMD`). */
export function driftRestoreArmed(env: Env = process.env): boolean {
  return env.CCP_DRIFT_RESTORE === '1';
}

/* ══════════════════════════════════════════════════════════════════════════
 * §6.2 — THE ELIGIBILITY PARTITION (checkout-independent; pure verdict fields)
 * ════════════════════════════════════════════════════════════════════════ */

export type DriftBucket = 'adopt' | 'revert' | 'restore' | 'ungenerable';

/** The minimal verdict shape {@link classifyByFields} reads — a `Pick` of
 * `DriftVerdict` so a STORED report verdict (which may carry many more
 * passthrough fields) is accepted directly, with no reshaping. */
export type ClassifiableVerdict = Pick<DriftVerdict, 'class' | 'riskTier' | 'actions' | 'forceNewAttrs' | 'driftEvidence' | 'changedAttrs' | 'securityHits'>;

/**
 * The closed, versioned eleven-class enum (D1-D11, docs/runbooks/
 * drift-detection.md) classify.py emits, mapped to its runbook id AND its
 * enriched not-generable note — the exact TypeScript twin of
 * `internal/driftpropose/partition.go`'s `knownClasses` (reason-string
 * enrichment, plan §2 "Reason-string enrichment", byte-pinned; fixture is
 * the oracle). Stability contract (0027 §2.4.3): an unrecognized class id
 * fails closed (ungenerable, never adopt-eligible) at EVERY consumer, this
 * one included. `benign_inplace`/`security_posture`/`oob_deletion` carry an
 * empty `note` deliberately: `benign_inplace` never reaches the
 * not-generable message (it IS generable), `security_posture` is
 * intercepted earlier by the `isSecurityPosture` branch above, and
 * `oob_deletion` (L29, register 0009, 2026-07-20-drift-restore-tranche.md
 * §2.1) is intercepted by the `restore`-bucket branch below, BEFORE the
 * generic not-generable message ever consults this note — for all three,
 * `note` is structurally required by the map's shape but never interpolated
 * into any reason string.
 */
const KNOWN_CLASSES: Record<string, { id: string; note: string }> = {
  benign_inplace: { id: 'D1', note: '' },
  security_posture: { id: 'D2', note: '' },
  // NOTE (2026-07-20, coordinator-relayed): the three notes below were
  // reworded by Lane A/owner to drop "register 0009 Lxx" notation (the
  // app's copy-lint gate bans register-number citations in rendered
  // strings) — these are the NEW canonical strings; the eligibility-cases.json
  // fixture picks up the matching wording in the same Lane A change.
  replacement_forcenew: {
    id: 'D3',
    note: 'ADOPT arm is safe and human-preparable today (runbook D3 adopt-PR, docs/runbooks/drift-detection.md); a guided portal lane is tracked in the limitations register',
  },
  replacement_risk: {
    id: 'D3b',
    note: 'ADOPT arm is safe and human-preparable today (runbook D3b adopt-PR, docs/runbooks/drift-detection.md); a guided portal lane is tracked in the limitations register',
  },
  oob_deletion: { id: 'D4', note: '' },
  legit_churn: { id: 'D6', note: 'ignore_changes + registry row — an engineer PR per runbook D6' },
  provider_noise: { id: 'D7', note: "adopt the provider's canonical form per runbook D7 (phase-2 candidate, 0027 §3.4)" },
  state_anomaly: { id: 'D8', note: 'state surgery per docs/runbooks/state-recovery.md (runbook D8)' },
  moved_refactor: { id: 'D9', note: 'verify the moved{} no-op per runbook D9' },
  unapplied_config: { id: 'D10', note: 'merged code awaiting the normal apply lane (runbook D10) — not console drift' },
  churn_absorbed: { id: 'D11', note: 'already absorbed by an existing ignore_changes (runbook D11)' },
};

function actionsAreUpdate(actions: string[] | undefined): boolean {
  return !!actions && actions.length === 1 && actions[0] === 'update';
}

/** L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2.1) — the
 * restore-eligible shape's own action predicate, the exact `actionsAreUpdate`
 * twin for `actions == ["create"]` (a pure out-of-band-deletion restore). */
function actionsAreCreate(actions: string[] | undefined): boolean {
  return !!actions && actions.length === 1 && actions[0] === 'create';
}

/** Go's `%v` on a `[]string` — `["a","b"]` renders `[a b]`, `[]`/`nil` render
 * `[]`. Used only to reproduce partition.go's ungenerable reason strings
 * byte-for-byte against the shared fixture. */
function fmtActions(actions: string[] | undefined): string {
  return `[${(actions ?? []).join(' ')}]`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * F8/A4 — structured path segments (the exact TS twin of
 * internal/driftpropose/partition.go's NormalizeSegments/legacySegments/
 * shapeOf/ExpressibleSegments/PathExpressible). See that file's doc comments
 * for the full rationale; kept in lockstep here byte-for-byte since this is
 * the shared eligibility-cases.json fixture's other implementation.
 * ════════════════════════════════════════════════════════════════════════ */

type PathSegment = string | number;
type SegKind = 'legacy' | 'normalized' | 'malformed';

/** Spec addendum A4's normalization contract: absent ⇒ legacy (fall back to
 * the pre-F8 display-path rule); an array of >=1 elements, each a string or
 * a non-negative integer, ⇒ normalized; anything else (empty array, a
 * negative/fractional number, a boolean, an object, …) ⇒ malformed — never
 * expressible regardless of what the display path alone might otherwise
 * allow (fail-closed). Malformed is deliberately NOT the same outcome as
 * absent. `null` is treated the SAME as `undefined` (both "legacy") to
 * match Go's `NormalizeSegments([]any)`: `encoding/json` unmarshals a JSON
 * `null` into a nil slice exactly like an absent key — Go's zero value
 * cannot distinguish the two, so the TS port must not either (a producer
 * that emits `"pathSegments": null` — e.g. json.dumps of a dict with a
 * `None` value, rather than omitting the key — must still fall back
 * cleanly, not be wrongly refused as malformed). */
function normalizeSegments(raw: unknown): { segs: PathSegment[]; kind: SegKind } {
  if (raw === undefined || raw === null) return { segs: [], kind: 'legacy' };
  if (!Array.isArray(raw) || raw.length === 0) return { segs: [], kind: 'malformed' };
  const out: PathSegment[] = [];
  for (const el of raw) {
    if (typeof el === 'string') {
      out.push(el);
    } else if (typeof el === 'number' && Number.isInteger(el) && el >= 0) {
      out.push(el);
    } else {
      return { segs: [], kind: 'malformed' };
    }
  }
  return { segs: out, kind: 'normalized' };
}

/** The STRICT pre-F8 fallback rule (only reached when pathSegments is
 * wholly absent — SegLegacy): no bracket anywhere, at most two dot-parts.
 * Deliberately stricter than any bracket-aware/any-depth parse — this is
 * the ONE fallback expressibility uses, so a legacy envelope's adopt
 * behavior is byte-for-byte unchanged by F8. */
function legacySegments(path: string): PathSegment[] | null {
  if (!path || /[[\]]/.test(path)) return null;
  const parts = path.split('.');
  if (parts.length > 2) return null;
  return parts;
}

/** The three expressible shapes (spec addendum A4): `[s]` a top-level
 * scalar · `[s, s]` a map key (any key bytes — dotted/slashed/spaced keys
 * included, the segment carries the key verbatim, never re-split) ·
 * `[s, 0, s]` a single-instance nested-block leaf (W1; the index MUST be
 * the literal 0 — anything else is ambiguous and refused, register 0009
 * L28). Everything else (4+ segments, a non-zero index, wrong element
 * types) is not expressible. */
function shapeOf(segs: PathSegment[]): PathSegment[] | null {
  if (segs.length === 1) {
    return typeof segs[0] === 'string' ? segs : null;
  }
  if (segs.length === 2) {
    return typeof segs[0] === 'string' && typeof segs[1] === 'string' ? segs : null;
  }
  if (segs.length === 3) {
    return typeof segs[0] === 'string' && segs[1] === 0 && typeof segs[2] === 'string' ? segs : null;
  }
  return null;
}

/** Resolves the attribute's AUTHORITATIVE segment form and reports whether
 * it is a shape the adopt edit engine can mechanically write. Structured
 * `pathSegments` (§2.2/F8) are authoritative when present and well-formed;
 * ONLY when the row carries none at all does this fall back to
 * `legacySegments`'s pre-F8 display-path rule. */
function expressibleSegments(path: string, pathSegments: unknown): PathSegment[] | null {
  const { segs, kind } = normalizeSegments(pathSegments);
  if (kind === 'malformed') return null;
  if (kind === 'legacy') return legacySegments(path);
  return shapeOf(segs);
}

/**
 * Path expressible by the adopt edit engine — the exact twin of
 * `internal/driftpropose/partition.go`'s `PathExpressible`. `pathSegments`
 * is optional (legacy envelopes/tests carry none): absent falls back to the
 * pre-F8 `[s]`/`[s,s]`, no-bracket rule; present-but-malformed is never
 * expressible; present-and-well-formed is checked against the three F8
 * shapes (adds `[s,0,s]`, the W1 nested-block leaf, and any-byte map keys —
 * dotted/slashed/spaced tag keys included).
 */
export function pathExpressible(path: string, pathSegments?: unknown): boolean {
  return expressibleSegments(path, pathSegments) !== null;
}

/**
 * Partitions one verdict per spec §6.2's table, re-deriving every condition
 * from verdict FIELDS — the `class` label is never trusted alone (the same
 * doctrine as the ForceNew gate never trusting prose). This is the
 * checkout-INDEPENDENT half of catalogctl's `ClassifyByFields`: the
 * catalogctl-only checkout-dependent refinement (does the address resolve,
 * can the edit actually be spliced) is Go-only and never re-implemented here
 * — the api never edits HCL, it only re-derives ELIGIBILITY for the submit
 * gate (§4.3, §8 enforcement point 2).
 *
 * `isSecurityPosture` wins over every other screen (§8 enforcement point 1
 * doctrine, re-asserted here for enforcement point 2): an unknown-class
 * verdict that also carries a `securityHits` row is still routed here,
 * never reaching the adopt path below.
 */
export function classifyByFields(v: ClassifiableVerdict): { bucket: DriftBucket; reason: string } {
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
        reason: 'security-posture drift with forceNew attribute(s) present — replacement-flavored security drift is a human conversation, never a portal button (runbook D2/D3)',
      };
    }
    return { bucket: 'revert', reason: 'security-posture drift — revert-only' };
  }

  // F7 (LOW, prototype-safety): `in` walks the prototype chain, so a hostile
  // `class: "__proto__"`/`"constructor"`/`"toString"` verdict would pass this
  // screen and interpolate prototype junk into the reason below — divergent
  // from Go. `Object.hasOwn` checks only the object's OWN keys.
  if (!Object.hasOwn(KNOWN_CLASSES, v.class)) {
    return { bucket: 'ungenerable', reason: `unknown class ${JSON.stringify(v.class)} — fail-closed, needs-human (the eleven-class D1-D11 enum is closed)` };
  }

  // L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2.1): the
  // restore bucket, slotted AFTER the security-posture branch and the
  // unknown-class screen above, BEFORE the generic not-generable message
  // below. `oob_deletion` (D4, taxonomy category E): a resource present in
  // code+state was deleted out-of-band; the plan wants `create`. Restore
  // re-asserts the code already on `main`, scoped to the deleted
  // address(es) — no code edit, no live values, ever (the revert doctrine
  // applied to a deletion). No type-level carve-out here (unlike import's
  // creation_security_types refusal): restore re-creates from OWNED,
  // reviewed code on `main`, the same safe direction as revert — refusing
  // security-family types would leave the WORST deletions (flow log,
  // CloudTrail) without a portal path.
  if (v.class === 'oob_deletion') {
    if (!actionsAreCreate(v.actions)) {
      return {
        bucket: 'ungenerable',
        reason: `oob_deletion drift with actions ${fmtActions(v.actions)} (not a pure create) — not mechanically restorable, human decision required (runbook D4)`,
      };
    }
    if (!v.driftEvidence) {
      // classify.py itself routes evidence-less creates to D10; only a
      // forged envelope reaches this arm — reuse the EXISTING byte-pinned
      // D10 string verbatim, never a bespoke restore-flavored one.
      return { bucket: 'ungenerable', reason: 'no drift evidence — unapplied config, not drift (see runbook D10)' };
    }
    return { bucket: 'restore', reason: 'out-of-band deletion — restore-eligible (re-assert code; the plan re-creates the deleted resource)' };
  }

  if (v.class !== 'benign_inplace') {
    return { bucket: 'ungenerable', reason: `class ${JSON.stringify(v.class)} is not auto-generable in v1 — ${KNOWN_CLASSES[v.class]!.note}` };
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
      return { bucket: 'ungenerable', reason: `attribute ${JSON.stringify(a.path)} is sensitive or missing a machine (liveJson) value` };
    }
    if (!pathExpressible(a.path, a.pathSegments)) {
      return { bucket: 'ungenerable', reason: `attribute ${JSON.stringify(a.path)} has a value shape not expressible by the edit engine` };
    }
  }
  return { bucket: 'adopt', reason: 'benign in-place drift — adopt-eligible' };
}

/* ══════════════════════════════════════════════════════════════════════════
 * OOB provisioning-import spec §5.2 — THE FINDING PARTITION (checkout-
 * independent; pure finding fields) — the TS re-check twin of catalogctl's
 * `internal/driftpropose.ClassifyFinding` (tools/catalogctl/internal/
 * driftpropose/finding.go). A finding has NO Terraform address (§3.1: "that
 * is its defining property") — it is a candidate for a NEW import proposal,
 * never an edit to an existing one, so none of {@link classifyByFields}'s
 * machinery applies to it; this is a SEPARATE, sibling partition, kept
 * honest by the SAME "one table, three implementations, one fixture"
 * doctrine against the shared fixture
 * tools/catalogctl/testdata/driftpropose/unmanaged-cases.json (a separate
 * file from eligibility-cases.json — spec §5.2: "the verdict fixture's
 * single-writer story is undisturbed").
 * ════════════════════════════════════════════════════════════════════════ */

/** The additive Bucket values §5.2's finding-partition table names — only
 * F-1..F-4 are reachable here (F-5 ignored / F-6 family-level-only never
 * become finding rows at all; F-7 invisible is never captured — see the
 * spec §5.2 table and §10's coverage doctrine); `ungenerable` is shared with
 * {@link DriftBucket} in name only (an unrecognized finding `class`, the
 * one condition outside F-1..F-4). */
export type FindingBucket = 'import' | 'creation_security' | 'type_unmapped' | 'payload_withheld' | 'ungenerable';

/** The minimal finding shape {@link classifyFinding} reads — a `Pick` of
 * `DriftFinding` (mirroring {@link ClassifiableVerdict}'s own doctrine) so a
 * STORED report finding (which may carry many more passthrough fields, e.g.
 * `name`/`service`/`actor`) is accepted directly, with no reshaping. */
export type ClassifiableFinding = Pick<DriftFinding, 'class' | 'tfType' | 'securityFamily' | 'importPayload' | 'payloadWithheldReason'>;

/** The constant class id every sweep finding carries
 * (importer/kit/statediff.py's FINDING_CLASS) — the L30/D5 unmanaged-
 * resource id, distinct from the eleven verdict classes {@link KNOWN_CLASSES}
 * enumerates. Exact TS twin of finding.go's `findingClass`. */
const FINDING_CLASS = 'unmanaged_resource';

/** Reports whether a finding's `importPayload` carries every sub-field F-1's
 * condition names (`importBlock` + `skeletonHcl` + `address` + `targetFile`,
 * spec §5.2) — the exact TS twin of finding.go's
 * `(*FindingImportPayload).complete()`: `p != nil` (here: not null/absent)
 * AND every field a non-empty string. A schema-level `min(1)` on
 * {@link DriftImportPayload}'s fields does NOT make this redundant — a
 * hand-built `ClassifiableFinding` (e.g. from the shared fixture, never
 * zod-parsed) can still carry an empty string, and this must treat that
 * exactly like Go does: incomplete, never a thrown validation error. */
function importPayloadComplete(p: ClassifiableFinding['importPayload']): boolean {
  return p != null && p.address !== '' && p.targetFile !== '' && p.importBlock !== '' && p.skeletonHcl !== '';
}

/**
 * Partitions one sweep finding per OOB spec §5.2's table (rows F-1..F-4),
 * re-deriving every condition from finding FIELDS — the `class`/
 * `securityFamily` label is never trusted alone (the same doctrine
 * {@link classifyByFields}'s own doc states for verdicts). Pure and
 * checkout-independent: the checkout-dependent refinements (§5.3's
 * `creation_security_types` re-derivation, the payload prescan, "address
 * already resolves in the checkout") are Go-only (`importwatchlist.go`,
 * `payloadprescan.go`, `importgen.go`) and never re-implemented here — the
 * api never touches a checkout, it only re-derives ELIGIBILITY for the
 * submit gate (§6, §5.3 screen 2).
 *
 * Order matters and is fixture-pinned: an unrecognized `class` wins over
 * everything (fail-closed) · an absent `tfType` (F-3, type-unmapped) wins
 * over `securityFamily` (a resource this map cannot name at all is not yet
 * known to BE creation-security) · `securityFamily` (F-2) wins over a
 * missing/incomplete `importPayload` (F-4) — a security-family finding is
 * never portal-importable regardless of what payload generation did or did
 * not produce.
 */
export function classifyFinding(f: ClassifiableFinding): { bucket: FindingBucket; reason: string } {
  if (f.class !== FINDING_CLASS) {
    return {
      bucket: 'ungenerable',
      reason: `finding class ${JSON.stringify(f.class)} is not ${JSON.stringify(FINDING_CLASS)} — fail-closed, needs-human (the finding partition only recognizes the constant unmanaged_resource class id)`,
    };
  }
  if (!f.tfType || f.tfType.trim() === '') {
    return {
      bucket: 'type_unmapped',
      reason: 'tfType is absent — this resource type is outside the services.json 43-type map; extend services.json (a data change + fixture) or use the manual kit import lane',
    };
  }
  if (f.securityFamily) {
    return {
      bucket: 'creation_security',
      reason: `tfType ${JSON.stringify(f.tfType)} is flagged securityFamily — creation-security types are never portal-importable; investigate per runbook D2/D5 (the actor evidence is the head start), then either delete-in-AWS (human + owner sign-off) or a manual engineer-tier kit-lane import PR`,
    };
  }
  if (!importPayloadComplete(f.importPayload)) {
    const withheld = f.payloadWithheldReason;
    const reason =
      withheld != null && withheld.trim() !== ''
        ? withheld
        : 'no import payload was generated for this finding — payload generation may not be armed for this sweep, this finding fell outside the 20-candidate cap, or it was excluded upstream; see the sweep run\'s payload step';
    return { bucket: 'payload_withheld', reason };
  }
  return { bucket: 'import', reason: 'unmanaged resource — import-eligible' };
}

/** A finding's identity key: `arn` when derivable, else `tfType`+`liveId`
 * (§2.4's documented fallback) — the exact TS twin of
 * `domain/drift.ts`'s own (unexported) `findingKey`, mirrored here rather
 * than exported/imported across modules for one small, stable, pure
 * function (the same small-mirror precedent the F8/A4 structured-path-
 * segments section above documents for its own Go twin). Used ONLY to look
 * a finding UP by identity in the CURRENT stored sweep — never as a store
 * key, never persisted. */
function findingIdentityKey(f: { arn?: string | null; tfType: string; liveId: string }): string {
  return f.arn != null && f.arn !== '' ? `arn:${f.arn}` : `type:${f.tfType}#id:${f.liveId}`;
}

/**
 * The CURRENT stored sweep row matching `identity` (§5.3 screen 2's own
 * words: "the finding still present, by arn/type+id") — `routes/drift.ts`'s
 * submit handler calls this with the identity pinned on an import
 * proposal's stored `importPayload` (arn/tfType/liveId) to re-derive
 * eligibility from LIVE data, never the proposal's own frozen copy.
 * `undefined` when no current finding matches (the resource was resolved,
 * removed from a later sweep, or never existed) — every caller treats that
 * as ineligible, the same fail-closed doctrine `addressEligibleFor` gives a
 * vanished verdict address.
 */
export function findCurrentFinding(findings: readonly DriftFinding[], identity: { arn: string | null; tfType: string; liveId: string }): DriftFinding | undefined {
  const key = findingIdentityKey(identity);
  return findings.find((candidate) => findingIdentityKey(candidate) === key);
}

/* ══════════════════════════════════════════════════════════════════════════
 * F6/A8 — fold ALL verdicts per address at submit (no last-wins map)
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Fold verdicts by address, preserving every row for a repeated address
 * (F6/A8): `routes/drift.ts`'s submit re-check used to build
 * `new Map(verdicts.map(v => [v.address, v]))` — last-wins, so a
 * duplicate-address envelope could hide a security twin behind a later
 * benign row for the SAME address. `PUT /:id/drift` now also REFUSES a
 * duplicate-address envelope outright at ingest
 * (`domain/drift.ts#duplicateVerdictAddress`, 422 `VALIDATION_FAILED`); this
 * fold is the belt-and-braces defense for whatever is already stored
 * (pre-fix reports, or any other honest path that could carry >1 row per
 * address).
 */
export function foldVerdictsByAddress(verdicts: readonly DriftVerdict[]): Map<string, DriftVerdict[]> {
  const byAddress = new Map<string, DriftVerdict[]>();
  for (const v of verdicts) {
    const list = byAddress.get(v.address);
    if (list) list.push(v);
    else byAddress.set(v.address, [v]);
  }
  return byAddress;
}

/**
 * `true` iff `address` has >=1 verdict in `byAddress` AND EVERY one of them
 * classifies to `flavor` (§6.2's {@link classifyByFields}) — any twin that
 * disagrees (a security row hidden behind a benign one, or the reverse)
 * refuses the WHOLE address, never picks a side.
 */
export function addressEligibleFor(byAddress: Map<string, DriftVerdict[]>, address: string, flavor: DriftBucket): boolean {
  const verdicts = byAddress.get(address);
  if (!verdicts || verdicts.length === 0) return false;
  return verdicts.every((v) => classifyByFields(v).bucket === flavor);
}

/* ══════════════════════════════════════════════════════════════════════════
 * §3.2 / §6.1 — the generated-proposal shapes (catalogctl's proposals.json)
 * ════════════════════════════════════════════════════════════════════════ */

const DriftProposalAttrSchema = z.object({
  address: z.string(),
  path: z.string(),
  liveJson: z.unknown().optional(),
  codeJson: z.unknown().optional(),
  /** F8/A4: always populated by the generator (from the verdict's own
   * segments, or derived from the legacy display-path parse) — tolerant
   * wire shape, not re-validated here (the generator is the authority). */
  pathSegments: z.unknown().optional(),
});
export type DriftProposalAttr = z.infer<typeof DriftProposalAttrSchema>;

/** OOB provisioning-import spec §2.6/§5.1 — the `import` flavor's OWN
 * payload shape (catalogctl's `ImportProposalPayload`, digest.go/proposal.go):
 * the reviewed live-resource identity (`arn`/`tfType`/`liveId`, feeding the
 * §5.4 digest formula alongside a hash of `importBlock`/`skeletonHcl`) plus
 * the exact bytes destined for `oob-adopted.tf`. Deliberately DISTINCT from
 * `domain/drift.ts`'s `DriftImportPayload` (the finding's own nested 4-field
 * `{address, targetFile, importBlock, skeletonHcl}` shape, no identity) —
 * `address` is not repeated here either (Go's own doc: "it already is
 * Proposal.Addresses[0] / RequestItem.TargetAddress"). `arn` is a required
 * key, nullable value — Go's `*string` marshals `null`, never an absent
 * key. */
const DriftImportProposalPayloadSchema = z.object({
  arn: z.string().nullable(),
  tfType: z.string(),
  liveId: z.string(),
  targetFile: z.string(),
  importBlock: z.string(),
  skeletonHcl: z.string(),
});
export type DriftImportProposalPayload = z.infer<typeof DriftImportProposalPayloadSchema>;

const DriftRequestSkeletonSchema = z.object({
  items: z
    .array(
      z.object({
        operationId: z.string(),
        targetAddress: z.string(),
        params: z.object({
          /** adopt/revert only. OOB spec §5.1: the import flavor's own
           * skeleton params carry NO `attrs` key at all (Go's
           * `RequestParams.Attrs` is `omitempty` on a nil slice) — optional,
           * not required, so a well-formed import skeleton still parses. */
          attrs: z.array(DriftProposalAttrSchema).optional(),
          /** import only, additive (§5.1) — the generator's draft copy of
           * the reviewed payload; `routes/drift.ts` re-derives + re-pins its
           * OWN copy from the persisted body at submit time, never trusting
           * this draft alone (§8). */
          importPayload: DriftImportProposalPayloadSchema.optional(),
          proposalDigest: z.string(),
          reportVersion: z.number().int().nonnegative(),
        }),
      }),
    )
    .min(1),
});

const DIGEST_RE = /^[0-9a-f]{64}$/;

const DriftGeneratedProposalSchema = z.object({
  digest: z.string().regex(DIGEST_RE),
  /** `'restore'` — L29, register 0009, 2026-07-20-drift-restore-tranche.md
   * §2.2/§2.5 — is additive: a proposal re-asserting the code already on
   * `main` over an out-of-band DELETION, carrying no attrs/diff of its own
   * (mirrors `'import'`'s own additive-flavor precedent). */
  flavor: z.enum(['adopt', 'revert', 'import', 'restore']),
  addresses: z.array(z.string()).min(1),
  /** import/restore: always `[]` (a payload or a bare re-assert, not
   * attribute edits — spec §5.1 / L29 §2.2). */
  attrs: z.array(DriftProposalAttrSchema),
  /** import only, additive (§5.1: "ImportPayload is additive and
   * import-only... nil + omitempty keeps every existing proposal
   * byte-identical" — Go's own doc for `Proposal.ImportPayload`). Absent for
   * adopt/revert. */
  importPayload: DriftImportProposalPayloadSchema.optional(),
  diff: z.string().nullable(),
  requestSkeleton: DriftRequestSkeletonSchema,
});

const DriftUngenerableSchema = z.object({ address: z.string(), class: z.string(), reason: z.string() });

/** `--out proposals.json`'s whole document (spec §6.1). Tolerant: unknown
 * top-level fields pass through nothing extra is required beyond schema. */
export const ProposalsDocSchema = z.object({
  schema: z.literal('ccp.drift-proposals/v1'),
  baseCommit: z.string(),
  proposals: z.array(DriftGeneratedProposalSchema).default([]),
  ungenerable: z.array(DriftUngenerableSchema).default([]),
});
export type ProposalsDoc = z.infer<typeof ProposalsDocSchema>;
export type GeneratedProposal = ProposalsDoc['proposals'][number];

/** The full persisted proposal doc (spec §3.2 body): the generated
 * proposal's own fields plus the PINNED VERDICT SUBSET (the stored report's
 * verdicts for `addresses`, at generation time) — kept for the approver
 * detail drawer / evidence duty; never re-trusted at submit (§4.3 always
 * re-derives eligibility live from the CURRENT stored report). `verdicts` is
 * always `[]` for an `import` proposal (a brand-new, unmanaged resource
 * never appears in `report.verdicts`, which is drift on ALREADY-managed
 * addresses) — `importPayload` is import's own evidence field instead (OOB
 * spec §5.1/§5.4), never re-trusted at submit either: `routes/drift.ts`
 * re-derives the CURRENT finding from the stored report's `sweep.findings`
 * live (§5.3 screen 2), exactly as `verdicts` is re-derived live for
 * adopt/revert. A `restore` proposal's `verdicts` behaves like adopt/revert's
 * (the pinned subset for its address, at generation time) — restore is
 * address-keyed, not finding-keyed, so it needs no import-style twin field
 * (L29 §2.2/§2.5). */
export interface DriftProposalDoc {
  digest: string;
  flavor: 'adopt' | 'revert' | 'import' | 'restore';
  addresses: string[];
  attrs: DriftProposalAttr[];
  diff: string | null;
  importPayload?: DriftImportProposalPayload;
  requestSkeleton: GeneratedProposal['requestSkeleton'];
  verdicts: DriftVerdict[];
}

/**
 * F10 (LOW): the on-disk schema for a stored proposal body — the generated-
 * proposal schema (§6.1) plus `verdicts`, tolerantly typed
 * (`z.array(z.unknown())`, since a verdict's own shape is `DriftVerdict`'s
 * tolerant/passthrough contract, not re-validated here). Read-time
 * validation closes the finding: `readDriftProposalBody` used to
 * `JSON.parse(...) as DriftProposalDoc` — an unvalidated cast that let a
 * corrupt/truncated/hand-edited file on disk 500 the submit route instead of
 * failing closed. Any mismatch now returns `null`, which every caller
 * already treats as "proposal ineligible" (422, never a 500).
 */
const DriftProposalDocSchema = DriftGeneratedProposalSchema.extend({ verdicts: z.array(z.unknown()) });

/* ── the on-disk proposal-body store (temp + rename, same discipline as drift.ts) ── */

const driftProposalsDir = (root: string, projectId: string): string => join(root, projectId, 'drift', 'proposals');
const driftProposalPath = (root: string, projectId: string, digest: string): string => join(driftProposalsDir(root, projectId), `${digest}.json`);

/** Write one proposal's full body atomically (temp file + rename) —
 * `<dataRoot>/<id>/drift/proposals/<digest>.json` (§3.2). Written ONCE, at
 * first generation of a digest — the digest already pins the content, so a
 * later regeneration that reproduces it never needs to rewrite the file. */
export async function writeDriftProposalBody(root: string, projectId: string, digest: string, body: DriftProposalDoc): Promise<void> {
  const dir = driftProposalsDir(root, projectId);
  await mkdir(dir, { recursive: true });
  const finalPath = driftProposalPath(root, projectId, digest);
  const tmp = `${finalPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, finalPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read one proposal's stored body, or `null` if absent/unreadable/corrupt
 * (fail closed — callers must treat a missing body as ineligible). Digest
 * MUST already be validated against {@link DIGEST_RE} by the caller — this
 * function never accepts an unvalidated path segment from a request.
 *
 * F10 (LOW): the stored body is now schema-validated
 * ({@link DriftProposalDocSchema}), not just `JSON.parse(...) as
 * DriftProposalDoc` — a corrupt/truncated/hand-edited file on disk returns
 * `null` here (the existing fail-closed 422 path every caller already
 * takes) instead of feeding malformed data downstream and 500ing the submit
 * route. */
export function readDriftProposalBody(root: string, projectId: string, digest: string): DriftProposalDoc | null {
  try {
    const raw = readFileSync(driftProposalPath(root, projectId, digest), 'utf8');
    const parsed = DriftProposalDocSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as DriftProposalDoc) : null;
  } catch {
    return null;
  }
}

/** Digest shape guard — the ONE place a client-supplied `:digest` path
 * segment is validated before it ever reaches a filesystem path or a store
 * key (path-traversal / injection defense-in-depth). */
export function isValidProposalDigest(digest: string): boolean {
  return DIGEST_RE.test(digest);
}

/* ══════════════════════════════════════════════════════════════════════════
 * §6.3 — the generation seam: config, injected steps, pure orchestration
 * ════════════════════════════════════════════════════════════════════════ */

/** Armed only when `CCP_DRIFT_PROPOSALS=1` AND `CCP_DRIFT_GEN_CMD` AND
 * `CCP_GIT_REMOTE` (shared with the bundle) are ALL explicitly set. */
export function driftProposalsArmed(env: Env = process.env): boolean {
  return env.CCP_DRIFT_PROPOSALS === '1';
}

export interface DriftGenConfig {
  /** Pushable/clonable checkout URL — shared with the bundle (CCP_GIT_REMOTE). */
  remote: string;
  /** Branch to check out — shared with the bundle; default 'main'. */
  branch: string;
  /** Operator command: runs `catalogctl drift-propose` inside $DRIFT_CHECKOUT,
   * reading $DRIFT_ENVELOPE, writing $DRIFT_OUT. Exit 0 = green. */
  genCmd: string;
}

export function driftGenConfig(env: Env = process.env): DriftGenConfig | null {
  if (!driftProposalsArmed(env)) return null;
  const remote = env.CCP_GIT_REMOTE;
  const genCmd = env.CCP_DRIFT_GEN_CMD;
  if (!remote || !genCmd) return null;
  return { remote, branch: env.CCP_GIT_BRANCH || 'main', genCmd };
}

export interface DriftGenStepResult {
  ok: boolean;
  /** Captured stdout/stderr tail, or the refusal reason — audit evidence. */
  detail: string;
}

/** Injected-steps interface, mirroring `domain/bundle.ts#BundleSteps` — tests
 * use fakes and a local fixture checkout, no network. */
export interface DriftGenSteps {
  /** Clone the branch into a scratch dir (mirrors the bundle's `prepare()`). */
  prepare(): { dir: string } | { error: string };
  /** Run the operator's CCP_DRIFT_GEN_CMD with env DRIFT_CHECKOUT=dir,
   * DRIFT_ENVELOPE=envelopePath, DRIFT_OUT=<a path this picks>; ok ⇒ the
   * `proposals.json` TEXT read back from DRIFT_OUT. */
  generate(dir: string, envelopePath: string): DriftGenStepResult & { out?: string };
  cleanup(dir: string): void;
}

export interface DriftGenRunOutcome {
  ok: boolean;
  detail: string;
  doc?: ProposalsDoc;
}

/**
 * Sequential, cleanup-always — the pure orchestration `domain/
 * bundle.ts#runBundle` mirrors. Writes the envelope text to a scratch file
 * (like the bundle writes `.bundle-request.json`) so the generator command
 * reads it via `$DRIFT_ENVELOPE`, then validates its output against
 * {@link ProposalsDocSchema} — a malformed/non-JSON generator output is a
 * refusal, never a crash.
 */
export function runDriftGen(steps: DriftGenSteps, envelopeText: string): DriftGenRunOutcome {
  const prep = steps.prepare();
  if ('error' in prep) return { ok: false, detail: prep.error };
  try {
    const envPath = join(prep.dir, '.drift-envelope.json');
    writeFileSync(envPath, envelopeText, 'utf8');
    const gen = steps.generate(prep.dir, envPath);
    if (!gen.ok || gen.out === undefined) return { ok: false, detail: gen.detail || 'generator produced no output' };
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(gen.out);
    } catch {
      return { ok: false, detail: 'generator output is not valid JSON' };
    }
    const parsed = ProposalsDocSchema.safeParse(parsedJson);
    if (!parsed.success) return { ok: false, detail: 'generator output does not match the ccp.drift-proposals/v1 shape' };
    return { ok: true, detail: gen.detail || 'generated', doc: parsed.data };
  } finally {
    steps.cleanup(prep.dir);
  }
}

/* ── real effect implementation ─────────────────────────────────────────── */

const tail = (s: string, n = 400): string => (s.length > n ? `…${s.slice(-n)}` : s);

/** Production steps: a shallow git clone + the operator's shell command. */
export function realDriftGenSteps(cfg: DriftGenConfig): DriftGenSteps {
  return {
    prepare() {
      const dir = mkdtempSync(join(tmpdir(), 'ccp-driftgen-'));
      const clone = spawnSync('git', ['clone', '--depth', '1', '--branch', cfg.branch, cfg.remote, dir], { encoding: 'utf8', timeout: 5 * 60_000 });
      if (clone.status !== 0) {
        rmSync(dir, { recursive: true, force: true });
        return { error: `clone failed: ${tail(`${clone.stdout ?? ''}${clone.stderr ?? ''}`.trim())}` };
      }
      return { dir };
    },
    generate(dir, envelopePath) {
      // A SIBLING of the scratch checkout (never inside it — keeps a stray
      // untracked file out of $DRIFT_CHECKOUT's git tree), cleaned up here
      // regardless of outcome; `cleanup(dir)` only removes `dir` itself.
      const out = `${dir}-out.json`;
      try {
        const r = spawnSync('bash', ['-lc', cfg.genCmd], {
          cwd: dir,
          env: { ...process.env, DRIFT_CHECKOUT: dir, DRIFT_ENVELOPE: envelopePath, DRIFT_OUT: out },
          encoding: 'utf8',
          timeout: 10 * 60_000,
        });
        const detail = tail(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim());
        if (r.status !== 0) return { ok: false, detail: detail || `generator exited ${r.status}` };
        try {
          return { ok: true, detail: detail || 'generator green', out: readFileSync(out, 'utf8') };
        } catch (e) {
          return { ok: false, detail: `generator exited 0 but DRIFT_OUT is unreadable: ${e instanceof Error ? e.message : String(e)}` };
        }
      } finally {
        rmSync(out, { force: true });
      }
    },
    cleanup(dir) {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * §6.3 — ingest ⇒ store ⇒ reconcile, and the non-reentrant per-project runner
 * ════════════════════════════════════════════════════════════════════════ */

export interface DriftGenDeps {
  store: ConfigStore;
  dataRoot: string;
  steps: DriftGenSteps;
}

export interface DriftGenTally {
  reportVersion: number;
  open: number;
  reused: number;
  superseded: number;
  ungenerable: number;
}

export type DriftGenResult = { ok: true; tally: DriftGenTally } | { ok: false; detail: string };

/**
 * ONE generation pass for `projectId` at `reportVersion`: read the stored
 * (post-redaction) envelope back off disk, run the injected steps, and
 * reconcile the output into the proposal store. Exported standalone (not
 * just via {@link scheduleDriftGeneration}) so tests can `await` a
 * deterministic single pass instead of racing a fire-and-forget background
 * task. Never throws — a failure is reported in the return value AND
 * audited (`drift-proposals-failed`); fail-open (§6.3): the report already
 * staged and responded before this ever runs.
 */
export async function generateDriftProposalsOnce(deps: DriftGenDeps, projectId: string, reportVersion: number): Promise<DriftGenResult> {
  const { store, dataRoot, steps } = deps;
  try {
    const rawText = readDriftReport(dataRoot, projectId, reportVersion);
    if (rawText === null) {
      // The version was pruned (retention) before generation got to it —
      // nothing to do; not a failure worth an audit entry (routine).
      return { ok: false, detail: 'report version no longer on disk (pruned)' };
    }
    const parsed = parseStoredEnvelope(rawText);
    if (parsed === null) {
      const detail = 'stored report failed schema validation on read';
      await auditGenFailure(store, projectId, reportVersion, detail);
      return { ok: false, detail };
    }
    const outcome = runDriftGen(steps, rawText);
    if (!outcome.ok || !outcome.doc) {
      await auditGenFailure(store, projectId, reportVersion, outcome.detail);
      return { ok: false, detail: outcome.detail };
    }
    const tally = await reconcileProposals(store, dataRoot, projectId, reportVersion, outcome.doc, parsed.report.verdicts);
    return { ok: true, tally };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await auditGenFailure(store, projectId, reportVersion, detail).catch(() => undefined);
    return { ok: false, detail };
  }
}

async function auditGenFailure(store: ConfigStore, projectId: string, reportVersion: number, detail: string): Promise<void> {
  await record(store, projectId, {
    action: 'drift-proposals-failed',
    actor: 'system:drift-propose',
    targetType: 'project',
    targetId: projectId,
    after: { reportVersion, detail },
  });
}

/**
 * Ingest ⇒ store ⇒ reconcile (spec §6.3): for each generated proposal,
 * `ifNotExists` on its digest (a brand new row ⇒ write the body + row; an
 * existing NON-submitted row ⇒ reopen/bump `lastSeenReportVersion`; an
 * existing `submitted` row ⇒ left alone); every previously-`open` row whose
 * digest is ABSENT from the fresh output ⇒ `superseded`. One audited
 * `drift-proposals-generated` entry per run.
 */
async function reconcileProposals(
  store: ConfigStore,
  dataRoot: string,
  projectId: string,
  reportVersion: number,
  doc: ProposalsDoc,
  verdicts: DriftVerdict[],
): Promise<DriftGenTally> {
  const existingRows = (await store.query(`PROJECT#${projectId}`, DRIFT_PROPOSAL_SK_PREFIX)) as DriftProposalItem[];
  const byDigest = new Map(existingRows.map((r) => [r.digest, r]));
  // Defensive: catalogctl's own digest formula (§2.4) never produces a
  // collision within one honest run, but the generator is an external
  // process — de-dupe (first occurrence wins) so a malformed/adversarial
  // output can never queue two `ifNotExists` puts for the SAME key in one
  // transact (which the store would reject as a whole-batch failure anyway;
  // this just avoids paying that retry-then-fail cost for free).
  const freshProposals = [...new Map(doc.proposals.map((p) => [p.digest, p])).values()];
  const freshDigests = new Set(freshProposals.map((p) => p.digest));
  const now = nowIso();
  const writes: TransactWrite[] = [];
  let open = 0;
  let reused = 0;

  for (const p of freshProposals) {
    const existing = byDigest.get(p.digest);
    const key = driftProposalKey(projectId, p.digest);
    if (!existing) {
      // `verdictSubset` is vacuously `[]` for an import proposal — a
      // brand-new, unmanaged resource's address never matches an EXISTING
      // verdict's address (verdicts are drift on already-managed
      // addresses); the finding-side evidence lives in `p.importPayload`
      // instead (OOB spec §5.1), re-derived live at submit, never pinned
      // here as a frozen finding copy.
      const verdictSubset = verdicts.filter((v) => p.addresses.includes(v.address));
      // File written BEFORE the row transacts — the digest is the row's key,
      // so a row can only exist once its body is safely on disk (same
      // ordering discipline as writeDriftReport/the report version stage).
      await writeDriftProposalBody(dataRoot, projectId, p.digest, {
        digest: p.digest,
        flavor: p.flavor,
        addresses: p.addresses,
        attrs: p.attrs,
        diff: p.diff,
        ...(p.importPayload ? { importPayload: p.importPayload } : {}),
        requestSkeleton: p.requestSkeleton,
        verdicts: verdictSubset,
      });
      const row: DriftProposalItem = {
        ...key,
        projectId,
        digest: p.digest,
        flavor: p.flavor,
        status: 'open',
        addresses: p.addresses,
        attrCount: p.attrs.length,
        firstReportVersion: reportVersion,
        lastSeenReportVersion: reportVersion,
        baseCommit: doc.baseCommit,
        generatedAt: now,
        // OOB spec §5.4 — additive row fields, import-only: informational
        // mirror of `p.importPayload`'s own identity, so a proposal listing
        // can show it without opening the on-disk body. `arn` is pinned even
        // when `null` (present-but-null is distinct from "not an import
        // row" — the row simply omits the key entirely for adopt/revert).
        ...(p.importPayload ? { arn: p.importPayload.arn, tfType: p.importPayload.tfType } : {}),
      };
      writes.push({ kind: 'put', item: row as never, ifNotExists: true });
      open += 1;
    } else if (existing.status !== 'submitted') {
      // Reconfirmed (still/again `open`) — bump the freshness pointer. A
      // previously-`superseded` row whose digest reappeared (drift cycled
      // back to a shape it already proposed) reopens on the SAME row: the
      // digest already pins the content, so nothing about it changed.
      writes.push({ kind: 'update', pk: key.PK, sk: key.SK, set: { status: 'open', lastSeenReportVersion: reportVersion } });
      reused += 1;
    }
    // status === 'submitted': the request already rides its own lifecycle —
    // left completely alone, per the status machine (§3.2).
  }

  let superseded = 0;
  for (const row of existingRows) {
    if (row.status === 'open' && !freshDigests.has(row.digest)) {
      writes.push({ kind: 'update', pk: row.PK, sk: row.SK, set: { status: 'superseded' } });
      superseded += 1;
    }
  }

  const tally: DriftGenTally = { reportVersion, open, reused, superseded, ungenerable: doc.ungenerable.length };
  await transactWithAudit(store, projectId, writes, {
    action: 'drift-proposals-generated',
    actor: 'system:drift-propose',
    targetType: 'project',
    targetId: projectId,
    after: tally,
  });
  return tally;
}

/* ── the non-reentrant, per-project async runner (fire-and-forget from the route) ── */

interface GenState {
  running: boolean;
  /** The latest report version that arrived while a run was in flight —
   * intermediate versions COLLAPSE (each new arrival overwrites this),
   * so only the latest matters once the in-flight run finishes. */
  queuedVersion: number | null;
}

const genState = new Map<string, GenState>();

/** Test hook: forget every project's in-flight/queued generation state. */
export function __resetDriftGenStateForTests(): void {
  genState.clear();
}

/**
 * Schedule generation for `projectId` at `reportVersion` — fire-and-forget
 * from the caller's point of view (the PUT route calls this WITHOUT
 * awaiting it, so the CI upload never blocks on a git clone). Non-reentrant
 * PER PROJECT: if a run is already in flight for this project, the new
 * version is QUEUED (replacing any previously-queued version — intermediate
 * reports collapse) instead of starting a second concurrent run.
 */
export function scheduleDriftGeneration(deps: DriftGenDeps, projectId: string, reportVersion: number): void {
  let state = genState.get(projectId);
  if (!state) {
    state = { running: false, queuedVersion: null };
    genState.set(projectId, state);
  }
  if (state.running) {
    state.queuedVersion = reportVersion;
    return;
  }
  state.running = true;
  void runQueueDrainingLoop(deps, projectId, reportVersion, state);
}

async function runQueueDrainingLoop(deps: DriftGenDeps, projectId: string, firstVersion: number, state: GenState): Promise<void> {
  let current: number | null = firstVersion;
  while (current !== null) {
    const result = await generateDriftProposalsOnce(deps, projectId, current);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`[ccp:drift] ${projectId} v${current}: proposal generation failed — ${result.detail}`);
    }
    current = state.queuedVersion;
    state.queuedVersion = null;
  }
  state.running = false;
}
