/**
 * Drift-on-the-portal types (drift-portal spec, slice 1 "See it"): what
 * `ApiClient.getDriftStatus()` returns and what the `/drift` surface
 * renders. Mirrors the classifier's `classification.json` (wrapped
 * verbatim into the publish envelope's `report` field) — the taxonomy
 * behind `class`/`riskTier` lives in the drift-detection runbook, not here.
 */

/**
 * One changed-attribute row. `live`/`code` are the classifier's masked
 * display strings; `liveJson`/`codeJson` are the exact plan values, present
 * only when `sensitive` is false. All four value fields are the Approver+
 * tier — a Requester-projected row carries `path` only (values follow
 * duty; the path itself is presence, shown at every tier).
 *
 * `pathSegments` (spec addendum A4 / plan F8) is the classifier's raw diff
 * tuple behind the lossy `path` display string — additive, emitted on
 * sensitive rows too (paths are not secret). Typed `unknown` deliberately:
 * the wire contract is tolerant (`z.unknown().optional()` on the api side),
 * so a malformed value must reach `normalizeSegments`/`pathExpressible`
 * (lib/driftEligibility.ts) unnarrowed rather than being trusted here as
 * `Array<string | number>`. Absent ⇒ the legacy display-path expressibility
 * rule; present-but-malformed ⇒ not expressible (fail closed) — never a
 * runtime crash either way.
 */
export interface DriftChangedAttr {
  path: string;
  live?: string;
  code?: string;
  sensitive?: boolean;
  liveJson?: unknown;
  codeJson?: unknown;
  pathSegments?: unknown;
}

/** A ForceNew evidence row — never carries a live/code value, so it renders
 * at every tier alongside the other attr paths. */
export interface DriftForceNewAttr {
  path: string;
  verdict: string;
  why?: string;
}

/** A security-watchlist evidence row — Approver+ only, same tier as the
 * recommendation/neverDo prose it accompanies. */
export interface DriftSecurityHit {
  path: string;
  why: string;
}

/**
 * One classified resource. `class`/`riskTier` are plain strings, not
 * closed unions, on purpose: the drift taxonomy is a closed, versioned
 * enum server-side, but every consumer — this client included — must fail
 * closed (render honestly, never assume adopt-eligible shape) on a class
 * it doesn't recognize, so an additive classifier class can never break
 * this type or this build.
 */
export interface DriftVerdict {
  address: string;
  type: string;
  actions: string[];
  class: string;
  riskTier: string;
  driftEvidence: boolean;
  /** Attr paths render at every tier; the value fields inside each row are
   * Approver+ (absent on a Requester-projected verdict). */
  changedAttrs?: DriftChangedAttr[];
  forceNewAttrs?: DriftForceNewAttr[];
  /** Approver+ only — absent/empty on a Requester-projected verdict. */
  securityHits?: DriftSecurityHit[];
  /** Display prose, Approver+ only — rendered verbatim, never parsed, never
   * keyed on. */
  recommendation?: string;
  neverDo?: string;
  executor?: string;
}

/** A drift-evidence row with no planned action — an existing ignore rule
 * already absorbs it. Informational only; carries no live/code value, so
 * it renders at every tier. */
export interface DriftAbsorbedEntry {
  address: string;
  class: string;
  riskTier: string;
}

export interface DriftCounts {
  drifted: number;
  security: number;
  byClass: Record<string, number>;
  /** Additive (out-of-band provisioning spec, the surfacing work item): =
   * `sweep.totalFindings`, 0 when the report carries no `sweep` section at
   * all. Optional here only for tolerance against an older stored/mock
   * report that predates the sweep — a reader must never assume 0 MEANS
   * "swept and clean"; presence of `DriftReport.sweep` is the only honest
   * signal for that (see DriftPanel's driftCardModel, which never lets an
   * absent sweep read as "no unmanaged resources"). */
  unmanaged?: number;
}

/**
 * CloudTrail evidence for one unmanaged-resource finding (out-of-band
 * provisioning spec, the CloudTrail actor enrichment work item) — the
 * matched `Create*` event's actor/time/source, pre-fetched as display
 * evidence for the D5/D2 evidence duty. Approver+ only, same tier as a
 * verdict's `securityHits`. Prose, rendered, never keyed on. Absent/`null`
 * on a finding means no matching event was found within the lookup window —
 * the submit flow must say the lookup duty is still open, never treat that
 * as "no evidence needed."
 */
export interface DriftFindingActor {
  eventName: string;
  eventTime: string;
  who: string;
  sourceIp?: string;
}

/**
 * The pinned import artifact for one import-eligible finding (out-of-band
 * provisioning spec, the import-payload generation work item) — the EXACT
 * bytes that land on `main` if this finding's generated proposal is
 * submitted and applied. Approver+ only; present only once generation ran
 * clean for this finding (see
 * `DriftFinding.importPayload`/`payloadWithheldReason`).
 */
export interface DriftImportPayload {
  address: string;
  targetFile: string;
  importBlock: string;
  skeletonHcl: string;
}

/**
 * One unmanaged-resource finding (out-of-band provisioning spec, the
 * finding-row shape — mirrors the api's `domain/drift.ts` `DriftFinding`
 * zod shape and the Go generator's `driftpropose.Finding` struct field for
 * field) — a live resource the sweep saw with NO Terraform address (that
 * absence is its defining property, unlike a {@link DriftVerdict}, which
 * always names one). Every finding carries the constant
 * `class: 'unmanaged_resource'` (kept a plain string, the same fail-open
 * doctrine as {@link DriftVerdict.class}).
 *
 * Field-tier rule (mirrored here the same way {@link DriftVerdict}'s own
 * fields are — pinned exactly against the api's own `requesterFindingView`
 * projection): Requester keeps PRESENCE — `class`/`tfType`/`name`/
 * `service`/`securityFamily`/whether a payload exists
 * (`importPayloadPresent`, synthesized ONLY on a requester-projected row —
 * see its own doc) — but never an identifier or evidence body. `arn`/
 * `liveId`/`region`/`stateful`/`actor`/`importPayload` bodies/
 * `payloadWithheldReason` detail are Approver+ only (an approver+ row
 * carries the REAL `importPayload`/`stateful` instead, unprojected). This
 * is an explicit ALLOWLIST at the projection site (lib/api.ts's mock, the
 * api server-side), never a denylist — see DriftVerdict's own field-tier
 * comment for the same doctrine.
 */
export interface DriftFinding {
  class: string;
  /** Required non-empty on the wire (api zod: `min(1)`) — typed here as a
   * plain `string`, matching the Go `Finding.TfType` domain field exactly
   * (never `| null`); `lib/driftEligibility.ts`'s `classifyFinding` still
   * defensively treats an empty/whitespace-only value as "absent" (the
   * type-unmapped bucket), the SAME defensive-despite-the-schema posture
   * this app already takes on other wire fields. */
  tfType: string;
  /** Optional on the wire (a lean producer may omit it) — every tier when
   * present. */
  name?: string;
  service?: string;
  /** Advisory copy of the publisher's creation-security screen —
   * re-derived from this same field everywhere it matters (never trusted
   * as the enforcement; see lib/driftEligibility.ts's classifyFinding).
   * Optional on the wire; MISSING is treated as `false` (not
   * security-family) — the SAME zero-value-on-absence semantics the Go
   * struct's plain (non-pointer) `bool` field carries, deliberately NOT a
   * fail-closed-to-true default, so this app's classification stays
   * byte-parity with the Go/api implementations rather than inventing its
   * own stricter rule. */
  securityFamily?: boolean;
  /** Requester-projection ONLY (api route's `requesterFindingView`,
   * `importPayload != null` computed at serve time) — an approver+ row
   * never carries this field; it carries the real `importPayload` instead,
   * from which presence is directly derivable. Never read by
   * `classifyFinding`, which always runs on an unprojected (approver+)
   * row in this app (see driftProposalState.ts's findingProposalStateFor —
   * it never runs at all when `proposals` is absent, i.e. Requester
   * tier). */
  importPayloadPresent?: boolean;
  /** Approver+ only from here down (present on an unprojected row; a
   * requester-projected row omits every field below entirely). */
  arn?: string | null;
  liveId?: string;
  region?: string;
  stateful?: boolean;
  actor?: DriftFindingActor | null;
  importPayload?: DriftImportPayload | null;
  payloadWithheldReason?: string | null;
}

/** Family-level-only sightings outside the sweep's instance-level types
 * (out-of-band provisioning spec's "two nets", honestly stated) — an ARN
 * family (e.g. `"arn:aws:sns"`) to the count the account-wide tagging sweep
 * saw, never instance-diffed. Rendered as a coverage note, never a
 * finding. The api stores/serves `coverage` fully opaque (`z.unknown()` —
 * this engine never reads it either); this shape is this app's own
 * assumption about the kit manifest's coverage block, so every reader
 * guards it defensively rather than trusting the field's presence or
 * exact shape. */
export interface DriftSweepCoverage {
  unrecognizedArnFamilies?: Record<string, number>;
}

/**
 * The envelope's additive `sweep` section (out-of-band provisioning spec,
 * the surfacing work item), as served for this project's report. ABSENT
 * ENTIRELY when this deployment has never armed or run the
 * unmanaged-resource sweep — presence itself is the signal every render
 * site keys on: a report with no `sweep` must never be read as "no
 * unmanaged resources" (see DriftPanel's driftCardModel and the standing
 * "unmanaged: not swept" copy). `method`/`capturedAt`/`region`/
 * `ignoredCount` are optional on the wire (the api passes them through
 * verbatim, un-defaulted); `totalFindings` is always present as served
 * (the api falls back to `findings.length` itself); `findings` always an
 * array (defaults to `[]` server-side — a swept-and-clean report still
 * parses as a positive, dated record, never "no signal").
 */
export interface DriftSweep {
  method?: string;
  capturedAt?: string;
  region?: string;
  /** Sorted by arn/id (deterministic), detail-capped server-side at 200 —
   * see `totalFindings` for the TRUE count. */
  findings: DriftFinding[];
  /** Always present as served — the api resolves this itself
   * (`?? findings.length`) even when the stored envelope left it unset. */
  totalFindings: number;
  ignoredCount?: number;
  coverage?: DriftSweepCoverage;
}

/** The project's latest published drift snapshot. */
export interface DriftReport {
  version: number;
  capturedAt: string;
  runId: string;
  commit: string;
  cadenceHours: number;
  /** 0 = verified clean · 2 = drift (exit 1 never publishes). */
  planExitCode: number;
  counts: DriftCounts;
  verdicts: DriftVerdict[];
  absorbed: DriftAbsorbedEntry[];
  /** The standing plan-based-detection completeness caveat — display-verbatim
   * prose, every tier, always rendered alongside a report (never omitted
   * just because nothing drifted). */
  invisibleToPlan: string;
  /** Additive (out-of-band provisioning spec, the surfacing work item): the
   * unmanaged-resource sweep section. See {@link DriftSweep}'s own doc for
   * the absence rule. */
  sweep?: DriftSweep;
}

/**
 * One pinned attribute row on a generated proposal — the exact machine
 * values the fix reads/writes, distinct from a verdict's `changedAttrs`
 * (display strings, every tier). Present only inside a `DriftProposal`,
 * which is itself Approver+ only.
 *
 * `pathSegments` (addendum A4): the generator always populates this (from
 * the verdict's own segments, or derived from the legacy display-path
 * parse) once armed — but stays optional on this type for the same
 * tolerant-wire reason as {@link DriftChangedAttr.pathSegments}: an older
 * stored proposal, or the mock, may omit it, and no reader here may assume
 * presence.
 */
export interface DriftProposalAttr {
  address: string;
  path: string;
  liveJson?: unknown;
  codeJson?: unknown;
  pathSegments?: unknown;
}

/**
 * One generated fix — adopt (the mechanical edit that makes code match
 * live reality), revert (no edit; re-imposes code over the console
 * change), import (out-of-band provisioning spec, additive: a
 * declarative `import` block + generated HCL skeleton for an eligible
 * unmanaged-resource finding — no verdict/address exists yet, so
 * `addresses` names the ADDRESS THE IMPORT WOULD CREATE), or restore
 * (drift restore tranche L29, additive: re-asserts the code already on
 * main, scoped to the address(es) an out-of-band deletion removed — no
 * code edit, no live values, ever; `attrs` is always empty, non-nil). A
 * security-posture verdict can only ever pair with a `revert` row — never
 * `adopt` — enforced server-side and never re-derived from this row's own
 * `flavor` label alone by any consumer (see `lib/driftEligibility.ts`).
 * The same non-trust doctrine applies to a security-family FINDING and
 * `import`: `lib/driftEligibility.ts`'s `classifyFinding` re-derives
 * eligibility from the finding's own fields, never from a proposal's
 * `flavor` label.
 */
export interface DriftProposal {
  digest: string;
  flavor: 'adopt' | 'revert' | 'import' | 'restore';
  status: 'open' | 'submitted' | 'superseded';
  addresses: string[];
  attrCount: number;
  generatedAt: string;
  lastSeenReportVersion: number;
  /** Present once a submit created a request from this proposal. */
  requestId?: string;
  /** Unified edit diff (adopt); always `null` for revert/import/restore —
   * none of the three carries an in-place edit (revert/restore have no
   * edit at all; import's payload is a whole new block, not a diff against
   * anything). */
  diff: string | null;
  attrs: DriftProposalAttr[];
  /** Import flavor only, additive — the finding identity this proposal
   * pins, so the SPA can match a generated import proposal back to its
   * originating finding without a Terraform address to key on up front
   * (a finding has none; `addresses[0]` only exists once import-payload
   * generation named one). `undefined` for adopt/revert. */
  arn?: string | null;
  tfType?: string;
  /** Import flavor only — the pinned artifact this proposal would write
   * verbatim. `undefined`/`null` for adopt/revert (no import artifact
   * applies to either). */
  importPayload?: DriftImportPayload | null;
}

/**
 * `ApiClient.getDriftStatus()`'s connected-case payload. `null` (not this
 * type) is how "not connected" is signalled — drift monitoring unarmed on
 * this deployment, or no report has ever been published for the project —
 * so a `DriftStatus` value always carries a real report.
 */
export interface DriftStatus {
  report: DriftReport;
  /** Generated fix proposals — Approver+ only (the same field-tier rule as
   * verdict values/security evidence): absent entirely for a Requester-
   * projected status, never an empty-as-redacted placeholder. Excludes
   * `superseded` rows — the live surface, not the archive. */
  proposals?: DriftProposal[];
}
