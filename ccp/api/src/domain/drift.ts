import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { redactHcl, redactTfJson } from '@app-lib/redact';
import { canonicalJson } from './audit';

/**
 * Drift telemetry ingestion — the api-side half of WI-2,
 * docs/superpowers/specs/2026-07-20-ccp-drift-portal.md §2-§4. The estate
 * drift check (`drift.yml` + `scripts/drift/classify.py`) publishes its
 * classified `classification.json`, wrapped verbatim in the `ccp.drift/v1`
 * envelope (`scripts/drift/publish_envelope.py`, WI-1), over the SAME
 * upload-token lane project data already uses (`routes/projectData.ts` is the
 * template — gate order is byte-for-byte the same discipline). This module is
 * the pure-ish half: the tolerant envelope schema, the security-posture
 * predicate, the redaction re-run, digesting, and the on-disk version store.
 * `routes/drift.ts` is the HTTP wiring.
 *
 * TOLERANT PARSING (§2.1, binding): `class` is validated as a STRING, never a
 * closed enum — the eleven-id taxonomy (D1-D11, the drift runbook) is a
 * CONSUMER-side fail-closed contract (unknown class ⇒ needs-human, never
 * adopt-eligible), not a wire enum, so an additive classifier class can never
 * brick ingestion. Every verdict/changedAttr/etc. carries `.passthrough()` so
 * a field this schema doesn't yet know about rides along instead of being
 * silently dropped or refusing the whole upload.
 *
 * OFF BY DEFAULT (the loop.ts / bundle.ts invariant): {@link driftArmed} is
 * false unless `CCP_DRIFT=1` is explicitly set — merging this changes ZERO
 * production behavior. The PUT route then answers 409 DRIFT_DISARMED and the
 * GET route answers `{connected:false}` until an operator arms it (WI-8).
 */

type Env = Record<string, string | undefined>;

/* ── arming + size cap (§4.1, §10) ─────────────────────────────────────── */

export const MAX_DRIFT_BYTES = 4 * 1024 * 1024; // 4 MiB, §4.1 step 4
export const DEFAULT_DRIFT_KEEP = 90; // §3.1 retention default

export function driftArmed(env: Env = process.env): boolean {
  return env.CCP_DRIFT === '1';
}

/** Report versions retained per project (§3.1); `CCP_DRIFT_KEEP`, default
 * 90. A non-positive/unparseable override falls back to the default —
 * retention must never silently mean "keep nothing" or "keep everything". */
export function driftKeep(env: Env = process.env): number {
  const n = Number(env.CCP_DRIFT_KEEP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DRIFT_KEEP;
}

/* ── the ccp.drift/v1 envelope (§2.1) ───────────────────────────────── */

export const DRIFT_ENVELOPE_SCHEMA = 'ccp.drift/v1';

const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * One changed-attribute row (classify.py `changedAttrs[]`, additively
 * extended by WI-1 with `sensitive`/`liveJson`/`codeJson` — §2.2). `live`/
 * `code` are the classifier's DISPLAY strings (masked when sensitive,
 * truncated at 64 chars); `liveJson`/`codeJson` are the exact plan values,
 * present only when `sensitive` is false. `.passthrough()`: `forceNew`/
 * `forceNewWhy`/`noiseEqual`/`churn` and any future field ride along
 * unparsed — rendered, never keyed on, by every consumer.
 */
/**
 * F5/A8 (audit finding): a sensitive row must never carry machine values,
 * regardless of what the producer sent — a crafted envelope carrying values
 * on a `sensitive:true` row must never leak them into a proposal body, a
 * digest input, or served/pinned evidence. Strip `liveJson`/`codeJson`
 * UNCONDITIONALLY whenever `sensitive === true` by deleting the keys
 * (not spread-then-set-undefined, which would leave the key
 * present-but-undefined and still show up in `Object.keys` —
 * `domain/audit.ts#canonicalJson` iterates keys, not `JSON.stringify`).
 * `T` is left otherwise untouched (same static type in and out), so this
 * composes as a zod `.transform` without widening `DriftChangedAttr`'s
 * inferred shape into a discriminated union.
 */
function stripSensitiveMachineValues<T extends { sensitive?: boolean; liveJson?: unknown; codeJson?: unknown }>(attr: T): T {
  if (attr.sensitive !== true) return attr;
  const next = { ...attr };
  delete next.liveJson;
  delete next.codeJson;
  return next;
}

const DriftChangedAttr = z
  .object({
    path: z.string().min(1).max(2_000),
    live: z.string().max(10_000).optional(),
    code: z.string().max(10_000).optional(),
    sensitive: z.boolean().optional(),
    /** Exact JSON plan values — present only when `sensitive` is false. */
    liveJson: z.unknown().optional(),
    codeJson: z.unknown().optional(),
    /** F8/A4: the raw diff-tuple segments (`[<string|int>...]`) — tolerant
     * wire shape (`z.unknown()`); normalized/validated in the port
     * (`domain/driftProposals.ts#normalizeSegments`), never here. Absent ⇒
     * legacy display-path rules; present-but-malformed ⇒ not expressible. */
    pathSegments: z.unknown().optional(),
  })
  .passthrough()
  // F5/A8: applied at EVERY parse through this schema — both ingest
  // (`DriftEnvelope.safeParse` in the PUT handler) and the stored-report
  // read-back (`parseStoredEnvelope`), so a pre-fix stored envelope is also
  // served stripped from here on, with no backfill migration needed.
  .transform(stripSensitiveMachineValues);
export type DriftChangedAttr = z.infer<typeof DriftChangedAttr>;

const DriftSecurityHit = z.object({ path: z.string(), why: z.string().optional() }).passthrough();
export type DriftSecurityHit = z.infer<typeof DriftSecurityHit>;

const DriftForceNewAttr = z
  .object({ path: z.string().optional(), verdict: z.string().optional(), why: z.string().optional() })
  .passthrough();

/**
 * One resource verdict. `address` and `class` are the only fields this
 * schema requires — the minimal semantic anchor role-projection and the
 * §2.3 security predicate need; everything else (§2.1: "known fields typed
 * ... unknown fields passed through") is optional/`.passthrough()` so a
 * leaner or richer classifier output still parses. `class` is a free STRING
 * (§2.1 binding) — see the module doc.
 */
const DriftVerdict = z
  .object({
    address: z.string().min(1).max(500),
    type: z.string().max(200).optional(),
    actions: z.array(z.string()).optional(),
    actionReason: z.string().nullable().optional(),
    class: z.string().min(1).max(100),
    riskTier: z.string().max(20).optional(),
    driftEvidence: z.boolean().optional(),
    changedAttrs: z.array(DriftChangedAttr).optional(),
    forceNewAttrs: z.array(DriftForceNewAttr).optional(),
    securityHits: z.array(DriftSecurityHit).optional(),
    computedUnknown: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
    /** Display prose — rendered, never parsed, never keyed on (§2.1). */
    recommendation: z.string().optional(),
    neverDo: z.string().optional(),
    executor: z.string().optional(),
  })
  .passthrough();
export type DriftVerdict = z.infer<typeof DriftVerdict>;

const DriftAbsorbedEntry = z
  .object({ address: z.string(), class: z.string().optional(), riskTier: z.string().optional() })
  .passthrough();
export type DriftAbsorbedEntry = z.infer<typeof DriftAbsorbedEntry>;

/**
 * classify.py's `classification.json`, wrapped verbatim (§2.1) under the
 * envelope's `report` key. Tolerant: `verdicts`/`absorbed` default to `[]` so
 * a lean or legacy producer still parses (a clean run publishes an empty
 * `verdicts` array — a positive, dated record, never "no signal").
 * `invisible_to_plan` keeps the classifier's own snake_case key byte-for-byte
 * — the GET projection (`routes/drift.ts`) is what renders it camelCase.
 */
const DriftReport = z
  .object({
    meta: z.record(z.unknown()).optional(),
    counts: z.record(z.unknown()).optional(),
    verdicts: z.array(DriftVerdict).default([]),
    absorbed: z.array(DriftAbsorbedEntry).default([]),
    invisible_to_plan: z.string().optional(),
  })
  .passthrough();
export type DriftReport = z.infer<typeof DriftReport>;

/* ── §2.4/§3.1 sweep: unmanaged-resource findings (OOB provisioning spec) ──
 * docs/superpowers/specs/2026-07-20-ccp-oob-provisioning-import.md — this
 * WI (S4) is api ingest/serve ONLY: the schema below, counts, and the
 * role-projected serve. The detector (statediff.py), the payload builder
 * (payloads.py), the generator, and the gate are OTHER WIs' files, untouched
 * here. TOLERANT PARSING applies identically to findings (module doc,
 * above): `class` is a free string, `.passthrough()` everywhere. */

/** §2.5's CloudTrail actor-enrichment sub-row — display evidence, prose,
 * rendered, never keyed on. `.passthrough()` like every other kit-shaped row. */
const DriftFindingActor = z
  .object({
    eventName: z.string().max(200).optional(),
    eventTime: z.string().max(64).optional(),
    who: z.string().max(500).optional(),
    sourceIp: z.string().max(100).optional(),
  })
  .passthrough();
export type DriftFindingActor = z.infer<typeof DriftFindingActor>;

/**
 * §2.6's generated import payload — the EXACT bytes that would land on
 * `main` (import block + HCL skeleton), pinned at generation time. Present
 * on a finding only when generation ran clean; §3.2 rule 3 below may still
 * strip it server-side (drop, never mask — masking would corrupt HCL that
 * must apply byte-for-byte at §7.1).
 */
const DriftImportPayload = z
  .object({
    address: z.string().min(1).max(500),
    targetFile: z.string().min(1).max(200),
    importBlock: z.string().min(1).max(10_000),
    skeletonHcl: z.string().min(1).max(10_000),
  })
  .passthrough();
export type DriftImportPayload = z.infer<typeof DriftImportPayload>;

/**
 * One unmanaged-resource FINDING (§2.4) — the sweep's per-resource row.
 * Unlike a verdict (identified by a Terraform `address`), a finding's
 * identity is `arn` when derivable, else the `tfType`+`liveId` pair — §2.4's
 * own documented fallback, and §3.2 rule 2's dedupe key ({@link
 * duplicateFindingKey}, below). `class`/`tfType`/`liveId` are the minimal
 * semantic anchor (the finding-row twin of `DriftVerdict`'s `address`+
 * `class`); everything else is optional/`.passthrough()` so a leaner or
 * richer kit output still parses.
 */
const DriftFinding = z
  .object({
    class: z.string().min(1).max(100),
    /** When derivable; else explicit `null` (§2.4) — never simply absent
     * from a well-formed row, but `.optional()` too for a lean producer. */
    arn: z.string().max(2_000).nullable().optional(),
    tfType: z.string().min(1).max(200),
    liveId: z.string().min(1).max(500),
    /** Name tag / kit label source, post-redaction (§2.4; re-redacted here too, §3.2 rule 3). */
    name: z.string().max(500).optional(),
    service: z.string().max(100).optional(),
    stateful: z.boolean().optional(),
    region: z.string().max(64).optional(),
    /** Advisory copy of the publisher's creation-security screen;
     * re-derived everywhere it matters (§5.2/§5.3) — never trusted alone. */
    securityFamily: z.boolean().optional(),
    actor: DriftFindingActor.nullable().optional(),
    importPayload: DriftImportPayload.nullable().optional(),
    payloadWithheldReason: z.string().max(2_000).nullable().optional(),
  })
  .passthrough();
export type DriftFinding = z.infer<typeof DriftFinding>;

/**
 * The envelope's additive top-level `sweep` section (§3.1) — the
 * unmanaged-resource findings feed, published alongside `report` in the
 * SAME envelope. Absent ⇒ a producer that has not upgraded to the sweep (a
 * legacy/un-upgraded upload keeps parsing exactly as before — §3.1's
 * "byte-identical when absent" contract). `findings` defaults to `[]` so a
 * clean sweep (nothing found) still parses as a positive, dated record —
 * the same "verified clean, not no signal" doctrine `DriftReport.verdicts`
 * already carries. `coverage` is the kit manifest's coverage block, carried
 * fully opaque (`z.unknown()`) — never interpreted here beyond passthrough.
 */
const DriftSweep = z
  .object({
    method: z.string().max(500).optional(),
    capturedAt: z.string().max(64).optional(),
    region: z.string().max(64).optional(),
    findings: z.array(DriftFinding).default([]),
    /** TRUE count even when `findings` detail is capped (§3.1) — never
     * derived from `findings.length` alone. */
    totalFindings: z.number().int().nonnegative().optional(),
    ignoredCount: z.number().int().nonnegative().optional(),
    coverage: z.unknown().optional(),
  })
  .passthrough();
export type DriftSweep = z.infer<typeof DriftSweep>;

export const DriftEnvelope = z.object({
  schema: z.literal(DRIFT_ENVELOPE_SCHEMA),
  /** Bound to the PUT path's `:id`, checked by the caller (like a digest binding). */
  projectId: z.string().regex(PROJECT_ID),
  environment: z.string().min(1).max(100),
  capturedAt: z.string().min(1).max(64),
  runId: z.string().min(1).max(200),
  commit: z.string().min(1).max(200),
  cadenceHours: z.number().finite().positive().max(8_760),
  /** 0 = verified clean · 2 = drift. Exit 1 never publishes (§2.1). */
  planExitCode: z.union([z.literal(0), z.literal(2)]),
  report: DriftReport,
  /** §3.1 — additive, optional; absent ⇒ a producer that has not upgraded
   * to the sweep (OOB provisioning spec §3.1's "byte-identical when
   * absent" contract). */
  sweep: DriftSweep.optional(),
});
export type DriftEnvelope = z.infer<typeof DriftEnvelope>;

/** Parse a stored envelope's raw text; `null` on any parse/schema failure —
 * the caller serves the fail-closed `{connected:true, report:null}` shape
 * (§4.2: "a stored envelope that fails schema validation on read is served
 * as absent ... and logged — fail closed, never partially rendered"). */
export function parseStoredEnvelope(raw: string): DriftEnvelope | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = DriftEnvelope.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/* ── §2.3 the fail-closed security-posture predicate ───────────────────── */

/**
 * `isSecurityPosture(v) := v.class == 'security_posture' OR v.securityHits`
 * non-empty — the fail-closed union of §2.3, used identically at every
 * enforcement point (this WI only needs it for the `counts.security` tally;
 * later WIs reuse it verbatim for proposal eligibility, §6.2/§8). Widens,
 * never narrows: an unrecognized `class` is not itself security-posture, but
 * a present `securityHits` row always is, regardless of what `class` says.
 */
export function isSecurityPosture(v: Pick<DriftVerdict, 'class' | 'securityHits'>): boolean {
  return v.class === 'security_posture' || (v.securityHits?.length ?? 0) > 0;
}

/* ── envelope digest (idempotency spine, §2.4) ─────────────────────────── */

/** sha256 over the canonical JSON of the WHOLE (stored, post-redaction)
 * envelope — the dedupe key (§4.1 step 7): a byte-identical re-publish is a
 * no-op, computed AFTER redaction so a redacted-but-otherwise-identical
 * re-upload still dedupes. */
export function envelopeDigestOf(envelope: DriftEnvelope): string {
  return createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex');
}

/* ── derived counts (per class + drifted total + security total, §3.1) ──── */

export type DriftCounts = { byClass: Record<string, number>; drifted: number; security: number; unmanaged: number };

/** Recomputed server-side from the stored verdicts — never trusted from the
 * classifier's own (untyped, tolerant) `report.counts` claim, the same
 * doctrine as `digestsOf` never trusting an uploader's claimed digest.
 * `unmanaged` (OOB provisioning spec §3.2 rule 4) = `sweep.totalFindings`,
 * 0 when the envelope carries no sweep section at all — a legacy/
 * un-upgraded producer's upload still gets an honest, present zero, never
 * an absent field. */
export function summarizeReport(report: DriftReport, sweep?: DriftSweep): DriftCounts {
  // F7 (LOW, prototype-safety): a plain `{}` inherits `Object.prototype`, so a
  // verdict carrying `class: "__proto__"` (or "constructor"/"toString") would
  // silently write onto the PROTOTYPE instead of an own key, dropping that
  // class's count and polluting every OTHER Record<string,number> literal
  // sharing the prototype. `Object.create(null)` has no prototype chain to
  // collide with — the same fail-closed doctrine as `classifyByFields`'s
  // `Object.hasOwn` (domain/driftProposals.ts).
  const byClass: Record<string, number> = Object.create(null) as Record<string, number>;
  let security = 0;
  for (const v of report.verdicts) {
    byClass[v.class] = (byClass[v.class] ?? 0) + 1;
    if (isSecurityPosture(v)) security += 1;
  }
  return { byClass, drifted: report.verdicts.length, security, unmanaged: sweep?.totalFindings ?? 0 };
}

/* ── F6/A8 ingest hardening: no duplicate verdict addresses ────────────── */

/**
 * The first duplicated `address` across `verdicts`, or `null` — F6/A8: a
 * duplicate-address envelope could hide a security twin behind a later
 * benign row for the SAME address if anything ever last-wins-folded it
 * (routes/drift.ts's submit re-check folds ALL verdicts per address instead,
 * §"fold ALL verdicts per address at submit" — this is the complementary
 * ingest-side refusal). No honest classifier emits duplicates: it classifies
 * once per `resource_changes` entry, one entry per address.
 */
export function duplicateVerdictAddress(verdicts: readonly Pick<DriftVerdict, 'address'>[]): string | null {
  const seen = new Set<string>();
  for (const v of verdicts) {
    if (seen.has(v.address)) return v.address;
    seen.add(v.address);
  }
  return null;
}

/* ── OOB provisioning spec §3.2 rule 2: no duplicate finding keys ──────── */

/** A finding's identity key: `arn` when derivable, else `tfType`+`liveId`
 * (§2.4's own documented fallback). */
function findingKey(f: Pick<DriftFinding, 'arn' | 'tfType' | 'liveId'>): string {
  return f.arn != null && f.arn !== '' ? `arn:${f.arn}` : `type:${f.tfType}#id:${f.liveId}`;
}

/**
 * The first duplicated finding KEY across `sweep.findings`, or `null` —
 * §3.2 rule 2, the A8 duplicate-address doctrine ({@link
 * duplicateVerdictAddress}, above) applied to the finding keyspace: two
 * findings sharing a key could hide one's import payload/actor evidence
 * behind the other's if anything ever last-wins-folded them. Refused
 * outright at ingest — no honest sweep run emits duplicates (statediff.py
 * walks a manifest keyed the same way).
 */
export function duplicateFindingKey(findings: readonly Pick<DriftFinding, 'arn' | 'tfType' | 'liveId'>[]): string | null {
  const seen = new Set<string>();
  for (const f of findings) {
    const key = findingKey(f);
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/* ── server-side redaction re-run (§4.1 step 6) ────────────────────────── */

export type DriftRedactionResult = { envelope: DriftEnvelope; warnings: string[] };

const REDACTED_FIELDS = ['live', 'code', 'liveJson', 'codeJson'] as const;

/** Mask one changed-value by the SAME shared rules module the projectData
 * lane re-runs (`@app-lib/redact`), keyed on the attribute PATH so both the
 * name rule (a path reading as secret-bearing, e.g. `master_password`) and
 * the value-shape rule apply — identical treatment to `rerunRedaction`'s
 * inventory-attribute pass in `domain/projectData.ts`. */
function redactByPath(path: string, value: unknown): unknown {
  const wrapped = redactTfJson({ [path]: value }) as Record<string, unknown>;
  return wrapped[path];
}

/* ── OOB provisioning spec §3.2 rule 3: sweep-string redaction + the
 * import-payload drop-don't-mask rule ─────────────────────────────────── */

const ACTOR_PROSE_FIELDS = ['eventName', 'who', 'sourceIp'] as const;

/** Redact one finding's tag-derived display string (`name`) and CloudTrail
 * actor prose (§3.2 rule 3: "extends to sweep strings — name, tag-derived
 * fields, actor prose") — masking, by PATH, the SAME `redactByPath`
 * discipline as the changed-attribute re-run above. Returns the row
 * unchanged (`changed:false`) when nothing needed masking, so a clean
 * upload survives byte-for-byte. */
function redactFindingStrings(f: DriftFinding): { finding: DriftFinding; changed: boolean } {
  let changed = false;
  let name = f.name;
  if (typeof name === 'string') {
    const redacted = redactByPath('name', name) as string;
    if (redacted !== name) {
      name = redacted;
      changed = true;
    }
  }
  let actor = f.actor;
  if (actor) {
    const nextActor = { ...actor } as Record<string, unknown>;
    let actorChanged = false;
    for (const field of ACTOR_PROSE_FIELDS) {
      const value = nextActor[field];
      if (typeof value !== 'string') continue;
      const redacted = redactByPath(field, value);
      if (redacted !== value) {
        nextActor[field] = redacted;
        actorChanged = true;
      }
    }
    if (actorChanged) {
      actor = nextActor as unknown as DriftFindingActor;
      changed = true;
    }
  }
  if (!changed) return { finding: f, changed: false };
  return { finding: { ...f, name, actor }, changed: true };
}

/** §2.6 step 4's exact publisher-side reason, reused verbatim server-side —
 * one canonical string for the whole feature, never a second invented one. */
export const PAYLOAD_WITHHELD_SECRET_REASON =
  'generated config carries secret-shaped values — import via the kit runbook with secret handling (e.g. ignore_changes on the secret attribute), never through the portal';

/**
 * §3.2 rule 3's "drop, don't mask": a secret-battery hit on
 * `importBlock`/`skeletonHcl` text strips the WHOLE payload instead of
 * rewriting it — masking would corrupt HCL that must apply byte-for-byte at
 * apply time (spec §7.1's exact-bytes append). Screened with the SAME
 * line-based HCL rules the display/archive lane shares (`redactHcl`,
 * `@app-lib/redact`, `catalog/redaction-rules.json`) — the publisher
 * already screened with the Python secret battery (§2.6 step 4); this is
 * the server refusing to trust the producer, the same posture as the
 * changed-attribute re-run above and §4.1 step 6 of the parent spec.
 */
function screenImportPayloadSecrets(f: DriftFinding): { finding: DriftFinding; withheld: boolean } {
  const payload = f.importPayload;
  if (!payload) return { finding: f, withheld: false };
  const hit = redactHcl(payload.importBlock) !== payload.importBlock || redactHcl(payload.skeletonHcl) !== payload.skeletonHcl;
  if (!hit) return { finding: f, withheld: false };
  return {
    finding: { ...f, importPayload: null, payloadWithheldReason: PAYLOAD_WITHHELD_SECRET_REASON },
    withheld: true,
  };
}

/**
 * Re-run redaction over every `live`/`code`/`liveJson`/`codeJson` string
 * before anything is stored — the classifier's `(sensitive)` masking is NOT
 * treated as a complete secret barrier (0027 §2.4.4). Idempotent: an
 * already-masked value passes through unchanged, so a clean upload survives
 * byte-for-byte and `warnings` stays empty. Extends identically to the
 * sweep (OOB provisioning spec §3.2 rule 3) when the envelope carries one —
 * a legacy/un-upgraded envelope with no `sweep` key is passed through
 * WITHOUT introducing one: `canonicalJson`'s `Object.keys` walk (the digest
 * spine, {@link envelopeDigestOf}) treats a present-but-`undefined` key
 * differently from an absent one ({@link stripSensitiveMachineValues}'s own
 * doc comment states the same trap), so the conditional spread below is
 * load-bearing, not decorative.
 */
export function rerunDriftRedaction(envelope: DriftEnvelope): DriftRedactionResult {
  let maskedRows = 0;
  const verdicts = envelope.report.verdicts.map((v) => {
    if (!v.changedAttrs || v.changedAttrs.length === 0) return v;
    let rowChanged = false;
    const changedAttrs = v.changedAttrs.map((attr) => {
      const next = { ...attr } as Record<string, unknown>;
      for (const field of REDACTED_FIELDS) {
        const value = next[field];
        if (value === undefined) continue;
        const redacted = redactByPath(attr.path, value);
        if (canonicalJson(redacted) !== canonicalJson(value)) {
          next[field] = redacted;
          rowChanged = true;
        }
      }
      return next as unknown as DriftChangedAttr;
    });
    if (rowChanged) maskedRows += 1;
    return { ...v, changedAttrs };
  });

  let maskedFindingRows = 0;
  let withheldPayloadCount = 0;
  const sweep = envelope.sweep
    ? {
        ...envelope.sweep,
        findings: envelope.sweep.findings.map((f) => {
          const { finding: afterStrings, changed } = redactFindingStrings(f);
          if (changed) maskedFindingRows += 1;
          const { finding: afterPayload, withheld } = screenImportPayloadSecrets(afterStrings);
          if (withheld) withheldPayloadCount += 1;
          return afterPayload;
        }),
      }
    : undefined;

  const warnings: string[] = [];
  if (maskedRows > 0) {
    warnings.push(
      `The server masked values in ${maskedRows} changed-attribute row(s) the upload had not masked. The masked copy is what is stored and served — check the classifier's sensitivity map.`,
    );
  }
  if (maskedFindingRows > 0) {
    warnings.push(
      `The server masked values in ${maskedFindingRows} unmanaged-resource finding(s) the upload had not masked. The masked copy is what is stored and served.`,
    );
  }
  if (withheldPayloadCount > 0) {
    warnings.push(
      `The server withheld the import payload on ${withheldPayloadCount} unmanaged-resource finding(s) — the generated config carried secret-shaped values the upload had not screened out. The finding is still stored and served; only the import payload was dropped.`,
    );
  }
  return {
    envelope: {
      ...envelope,
      report: { ...envelope.report, verdicts },
      ...(sweep !== undefined ? { sweep } : {}),
    },
    warnings,
  };
}

/* ── the on-disk version store (temp + rename, same discipline as projectData) ── */

const driftDir = (root: string, projectId: string): string => join(root, projectId, 'drift');
const driftReportPath = (root: string, projectId: string, version: number): string =>
  join(driftDir(root, projectId), `v${version}.json`);

/** Write one staged drift report atomically (temp file + rename) — the
 * envelope BODY (post-redaction), `<dataRoot>/<id>/drift/v<n>.json` (§3.1). */
export async function writeDriftReport(root: string, projectId: string, version: number, envelope: DriftEnvelope): Promise<void> {
  const dir = driftDir(root, projectId);
  await mkdir(dir, { recursive: true });
  const finalPath = driftReportPath(root, projectId, version);
  const tmp = `${finalPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, finalPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read one stored report's raw JSON text, or null if absent/unreadable
 * (fail closed — the caller serves `connected:true, report:null`). */
export function readDriftReport(root: string, projectId: string, version: number): string | null {
  try {
    return readFileSync(driftReportPath(root, projectId, version), 'utf8');
  } catch {
    return null;
  }
}

/** Best-effort removal of one pruned version's file (retention, §3.1). */
export function removeDriftReport(root: string, projectId: string, version: number): void {
  rmSync(driftReportPath(root, projectId, version), { force: true });
}
