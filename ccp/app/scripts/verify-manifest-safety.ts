/**
 * OFFLINE catalog safety gate. Runs TWO independent checks over the shared
 * manifests; FAIL in EITHER → exit 1 (CI-blocking).
 *
 * (1) ForceNew gate (docs/proposals/0006 §5, completed by 0020; per-provider
 * since 0039 F2c).
 * For every catalog op that claims forcesReplace:false and writes attribute
 * path(s) — per the same extractOpAttrs the map builder uses — assert every
 * written attribute is not ForceNew per the committed provider map / human
 * adjudications for THAT op's own provider (aws_* ops only ever consult the
 * aws map/adjudications, azurerm_* ops only the azure ones — see
 * evaluateOpsByProvider). Adjudications take precedence over the map (they
 * carry the human-verified evidence); anything unknown stays a WARN so a
 * silent hole is always visible. A provider's map/adjudications file is
 * OPTIONAL on disk (loadMap/loadAdjudications below) — absent ⇒ {} ⇒ every
 * op of that provider is unresolved ⇒ fail-closed, never a guess (0039
 * global rule 2; doctrine 0010 §3, 0013d §6.4). Two op classes are out of
 * scope BY CONSTRUCTION and counted separately so the census stays honest:
 *   · '~ engineer-authored' escalation ops — no codemod attribute exists; the
 *     safety control is the engineer-review pipeline, not this gate.
 *   · '+ create' ops — they create a NEW resource; nothing can be replaced.
 *
 * (1b) Map-presence gate (Lane K — the F2-review hardening, plan §8 item).
 * "Absent map file" and "present-but-empty map file" are both {} by the time
 * evaluateOps sees them, but they are NOT the same state: an empty-but-
 * committed file means a human ran the map builder and it genuinely resolved
 * nothing (or the catalog has zero ops for that provider yet); an absent file
 * means the map was never built at all. The latter, when the provider DOES
 * have in-scope ops, is a hard FAIL rather than a WARN-per-key — see
 * evaluateMapPresence and loadMap's fileExisted flag below.
 *
 * (2) Catalog-genericity gate (see scanManifestBranding below).
 * The manifests are REUSED across many AWS accounts, so every human-readable
 * PROSE field must read the same on any account. This check FAILs if estate-
 * specific branding leaks back into prose. It is scoped to prose so real AWS
 * identifiers that legitimately contain such tokens (AWS-managed SSM document
 * names, IAM role ARNs, timezone values) live untouched in VALUE fields.
 *
 * Run: npx vite-node scripts/verify-manifest-safety.ts
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOpAttrs, type MapEntry, type OpLike } from './lib/forcenewShared';
import { providerOfType, type CloudProvider } from '../src/lib/providerDisplay';
import {
  BUILTIN_ESTATE_DENYLIST,
  loadEstateDenylist,
  type EstateDenylist,
} from './lib/estateDenylist';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = join(APP, 'src/data/manifests');
const MAP_PATH = join(APP, 'src/data/forcenew-map.json');
const ADJ_PATH = join(APP, 'src/data/forcenew-adjudications.json');
const AZURE_MAP_PATH = join(APP, 'src/data/forcenew-map-azure.json');
const AZURE_ADJ_PATH = join(APP, 'src/data/forcenew-adjudications-azure.json');

interface GateOp extends OpLike {
  id: string;
  forcesReplace: boolean;
  exposure: string;
}
export interface Adjudication {
  forceNew: boolean;
  verifiedBy: string;
  date: string;
  evidence: string;
}
export interface GateResult {
  fails: string[];
  warns: string[];
  passes: number;
  skipped: number;
  engineerAuthored: number;
  additiveCreate: number;
}

/** Tier 1 of the ForceNew gate's scoping (mirrors build-forcenew-map.ts's
 * `needed`-key filter's FIRST two lines exactly — same two fields, same
 * single source of truth): a catalog op is only a ForceNew-gate candidate
 * when its codemod claims forcesReplace:false and writes via set_attribute /
 * set_association_attribute. Everything else (append_block, forcesReplace:
 * true, …) is skipped and counted, not warned.
 *
 * NOTE this is coarser than "in scope" as the module doc above uses the
 * phrase: engineer-authored and '+ create' ops pass THIS filter (real
 * manifest data confirms both classes use codemodOp:'set_attribute',
 * forcesReplace:false) but are reclassified out of scope BY CONSTRUCTION
 * one tier down, in evaluateOps, via extractOpAttrs. Use isMapCheckedOp
 * below for "does this op actually consult the map". */
function isInScopeOp(op: GateOp): boolean {
  return (
    (op.codemodOp === 'set_attribute' || op.codemodOp === 'set_association_attribute') &&
    op.forcesReplace === false
  );
}

/** Tier 2: does this op reach evaluateOps's map[key] lookup at all? Mirrors
 * build-forcenew-map.ts's FULL `needed`-key filter (isInScopeOp AND
 * extractOpAttrs resolves at least one real attribute path) — exactly the
 * population a fully-run map builder would emit keys for, and exactly the
 * population that produces a "WARN UNRESOLVED" when the map is present but
 * empty. engineer-authored, '+ create', and unextractable ops all fall out
 * here (none of them ever touch the map, so the map's absence can never be
 * blamed on them). This is the file's true "in-scope" population — the one
 * evaluateMapPresence below needs. */
function isMapCheckedOp(op: GateOp): boolean {
  if (!isInScopeOp(op)) return false;
  const ex = extractOpAttrs(op);
  return ex.kind === 'attrs' && ex.attrs.length > 0;
}

export function evaluateOps(
  ops: GateOp[],
  map: Record<string, MapEntry>,
  adjudications: Record<string, Adjudication>,
): GateResult {
  const r: GateResult = {
    fails: [],
    warns: [],
    passes: 0,
    skipped: 0,
    engineerAuthored: 0,
    additiveCreate: 0,
  };
  for (const op of ops) {
    if (!isInScopeOp(op)) {
      r.skipped++;
      continue;
    }
    const ex = extractOpAttrs(op);
    if (ex.kind === 'engineer_authored') {
      r.engineerAuthored++;
      continue;
    }
    if (ex.kind === 'additive_create') {
      r.additiveCreate++;
      continue;
    }
    if (ex.kind !== 'attrs' || ex.attrs.length === 0) {
      r.warns.push(`WARN UNEXTRACTABLE ${op.id}: cannot determine attribute path`);
      continue;
    }
    let clean = true;
    for (const attr of ex.attrs) {
      const key = `${op.target.resourceType}.${attr.path}`;
      const adj = adjudications[key];
      if (adj) {
        if (adj.forceNew) {
          r.fails.push(`FAIL FORCENEW ${op.id}: ${key} adjudicated ForceNew (${adj.evidence})`);
          clean = false;
        }
        continue;
      }
      const entry = map[key];
      if (!entry || entry.verdict === 'unresolved') {
        r.warns.push(`WARN UNRESOLVED ${op.id}: ${key} not in map — adjudicate or rebuild map`);
        clean = false;
        continue;
      }
      if (entry.verdict === 'force_new') {
        r.fails.push(`FAIL FORCENEW ${op.id}: ${key} is ForceNew per ${entry.file}@${entry.tag}`);
        clean = false;
      }
    }
    if (clean) r.passes++;
  }
  return r;
}

function emptyGateResult(): GateResult {
  return { fails: [], warns: [], passes: 0, skipped: 0, engineerAuthored: 0, additiveCreate: 0 };
}

function combineGateResults(a: GateResult, b: GateResult): GateResult {
  return {
    fails: [...a.fails, ...b.fails],
    warns: [...a.warns, ...b.warns],
    passes: a.passes + b.passes,
    skipped: a.skipped + b.skipped,
    engineerAuthored: a.engineerAuthored + b.engineerAuthored,
    additiveCreate: a.additiveCreate + b.additiveCreate,
  };
}

/**
 * Per-provider ForceNew gate dispatch (0039 F2c). Each op is routed to ITS
 * OWN provider's map/adjudications table by target.resourceType's prefix
 * (providerOfType) BEFORE evaluateOps ever sees it — an azurerm_ op can only
 * ever be resolved by the azure table, an aws_ op only by the aws table, even
 * if the wrong table happens to carry a same-named key (defense in depth on
 * top of the fact that resourceType prefixes make real cross-provider key
 * collisions impossible by construction). A provider whose table is {} (its
 * file was absent on disk — see loadMap/loadAdjudications below) simply never
 * resolves any of that provider's ops: every one is unresolved ⇒ fail-closed,
 * the exact same WARN-not-silently-guessed path evaluateOps already gives an
 * unknown key (0010 §3, 0013d §6.4). With zero azure ops in the catalog
 * (true today — Lane G lands the first azure manifest fixture), this reduces
 * to exactly evaluateOps(ops, maps.aws, adjudications.aws) in the SAME order:
 * AWS behavior is unchanged byte-for-byte.
 */
export function evaluateOpsByProvider(
  ops: GateOp[],
  maps: Record<CloudProvider, Record<string, MapEntry>>,
  adjudications: Record<CloudProvider, Record<string, Adjudication>>,
): GateResult {
  const providers: CloudProvider[] = ['aws', 'azure'];
  return providers.reduce((acc, provider) => {
    const providerOps = ops.filter((op) => providerOfType(op.target.resourceType) === provider);
    return combineGateResults(
      acc,
      evaluateOps(providerOps, maps[provider], adjudications[provider]),
    );
  }, emptyGateResult());
}

/** Per-provider disk state fed to evaluateMapPresence: whether that provider's
 * map FILE existed on disk (not whether it parsed to something non-empty —
 * that distinction is the whole point) and the path to name in the FAIL. */
export interface MapPresence {
  fileExisted: boolean;
  path: string;
}

/**
 * Map-presence hard-fail (Lane K — the F2-review hardening, plan §8 item).
 * evaluateOpsByProvider above already fails closed on a MISSING KEY (map
 * present but doesn't resolve this attribute ⇒ WARN) — but it cannot tell
 * "the map resolved nothing because it's empty by design" apart from "the
 * map was never built" because loadMap collapses both to {} before
 * evaluateOps ever runs. That collapse is correct for per-KEY resolution
 * (fail-closed either way) but wrong for a whole-FILE audit: a provider that
 * has in-scope ops and NO map file on disk means nobody ever ran
 * build-forcenew-map.ts for it, which is a hole in process, not just in
 * data — a WARN buried among ordinary unresolved-key WARNs is too easy to
 * miss. So this FAILs instead, once per affected provider, and ONLY when
 * that provider has ops isMapCheckedOp would actually check (an absent file
 * is a non-issue for a provider whose ops are all '+ create',
 * '~ engineer-authored', forcesReplace:true, or unextractable — none of
 * those ever consult the map, so there is nothing for the map to resolve
 * and nothing for its absence to hide). present-but-empty (fileExisted:
 * true) is deliberately EXEMPT here — that is the legitimate, already-
 * handled WARN-per-key path above.
 */
export function evaluateMapPresence(
  ops: GateOp[],
  presence: Record<CloudProvider, MapPresence>,
): string[] {
  const providers: CloudProvider[] = ['aws', 'azure'];
  const fails: string[] = [];
  for (const provider of providers) {
    const { fileExisted, path } = presence[provider];
    if (fileExisted) continue;
    const count = ops.filter(
      (op) => providerOfType(op.target.resourceType) === provider && isMapCheckedOp(op),
    ).length;
    if (count > 0) {
      fails.push(
        `FAIL MAP-ABSENT ${provider}: ${count} in-scope op(s) reference ${provider} but no map ` +
          `file exists at ${path} — run build-forcenew-map.ts --provider ${provider} first`,
      );
    }
  }
  return fails;
}

/** A provider's map/adjudications file is OPTIONAL: absent ⇒ {} ⇒ every op of
 * that provider is unresolved ⇒ fail-closed (0039 global rule 2). This was
 * already true for MAP_PATH; loadAdjudications extends the same existsSync
 * guard to the adjudications file (previously an unconditional read for AWS
 * — both files exist today, so this is not an observable behavior change,
 * only a defensive generalization needed for the azure side, which starts
 * with a real but empty forcenew-adjudications-azure.json).
 *
 * loadMap additionally threads WHETHER the file existed (Lane K): the parsed
 * `table` alone cannot distinguish absent-file from present-but-empty `{}`,
 * and evaluateMapPresence above needs exactly that distinction. */
export interface LoadedMap {
  table: Record<string, MapEntry>;
  fileExisted: boolean;
}
function loadMap(path: string): LoadedMap {
  const fileExisted = existsSync(path);
  return {
    table: fileExisted ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, MapEntry>) : {},
    fileExisted,
  };
}
function loadAdjudications(path: string): Record<string, Adjudication> {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Adjudication>)
    : {};
}

// ── (2) Catalog-genericity gate ──────────────────────────────────────────────
// The catalog is REUSED across accounts, so shared PROSE must be account-
// agnostic. We scan ONLY human-readable prose fields for estate-specific
// branding. Real AWS identifiers that legitimately contain estate-looking tokens
// — AWS-managed SSM document names, service-role ARNs, timezone values — live in
// VALUE fields (allowlist / default / enum / pattern / name / path / …) which are
// OUT OF SCOPE by construction: only the keys in PROSE_KEYS are ever inspected, so
// those identifiers never trip the gate.

/**
 * Prose keys whose values are shown verbatim to a requester. `decisions` is the
 * review-checklist array-of-strings; the rest are string fields. Every other
 * key (allowlist, default, enum, pattern, name, path, keywords, resourceTypes,
 * service, scope, …) is a VALUE/structural field and is deliberately excluded.
 */
const PROSE_KEYS = new Set<string>([
  'description',
  'help',
  'summary',
  'consoleLabel',
  'label',
  'title',
  'notes',
  'semantic',
  'decisions',
]);

// Estate-branding tokens that must never appear in shared catalog prose come from
// the resolved denylist (empty in the committed built-in; real only in the untracked
// .estate-denylist.json — see ./lib/estateDenylist.ts). Matched case-insensitively on
// whole-word boundaries, so an estate term as a whole word (e.g. "ACME host" /
// "acme-daily") trips, but a longer identifier token that merely contains it (no
// word boundary around the substring) would not — and it lives in a VALUE field
// regardless.

export interface BrandingViolation {
  file: string;
  /** dotted JSON location, e.g. `operations[3].params[2].help` */
  field: string;
  /** the offending token, as it appears in the text */
  term: string;
  text: string;
}

/**
 * Walk one parsed manifest and report every PROSE field that contains a
 * branding term. Recurses through the whole tree but only inspects string
 * leaves that sit under a PROSE_KEYS key (directly, or as elements of a prose
 * array such as `decisions`); value/structural fields are never inspected.
 */
export function scanManifestBranding(
  file: string,
  root: unknown,
  denylist: EstateDenylist = BUILTIN_ESTATE_DENYLIST,
): BrandingViolation[] {
  const out: BrandingViolation[] = [];
  // No estate terms in the resolved denylist (the public built-in) → nothing to scan
  // for, so a fresh public checkout reports zero branding violations. The private
  // deployment's CI materializes the real terms and the ratchet keeps full strength.
  if (denylist.estateTerms.length === 0) return out;
  const brandingRe = new RegExp(`\\b(?:${denylist.estateTerms.join('|')})\\b`, 'i');
  const walk = (value: unknown, field: string, inProse: boolean): void => {
    if (typeof value === 'string') {
      if (inProse) {
        const m = brandingRe.exec(value);
        if (m) out.push({ file, field, term: m[0], text: value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${field}[${i}]`, inProse));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walk(v, field ? `${field}.${k}` : k, PROSE_KEYS.has(k));
      }
    }
  };
  walk(root, '', false);
  return out;
}

// ── (3) Hardcoded-value gate ─────────────────────────────────────────────────
// The genericity gate above deliberately exempts VALUE fields — but an
// allowed-value field (a param's `allowlist`, `default`, or `const`) that bakes
// in an account-bound identifier pins the WHOLE catalog to one AWS account: no
// other account can ever pick that value. Those params must be inventory-driven
// (`source:"inventory"` + `enumSource:"inventory://<type>/address"` +
// role:"reference") so every account offers ITS OWN resources. This check FAILs
// on any allowed-value string that carries a 12-digit account id or an
// account-bound ARN. Legitimately-generic AWS identifiers stay allowed by
// construction: AWS-managed policy ARNs carry the literal `aws` account segment
// (arn:aws:iam::aws:policy/…), and service principals (backup.amazonaws.com) or
// AWS-managed SSM document names are not ARNs and carry no account id, so none
// of them can trip either rule. `pattern` (a validation regex, not a value) and
// prose fields are out of scope — the branding gate owns prose.

/** Param keys whose string contents are OFFERED OR WRITTEN as values —
 * `bounds.allowlist` entries, a param `default`, and a role:"const" fixed
 * value. Everything else (pattern/semantic/enumSource/prose/…) is not an
 * allowed-value channel and is deliberately not inspected here. */
const VALUE_KEYS = new Set<string>(['allowlist', 'default', 'const']);

/** A whole-token 12-digit run — the shape of an AWS account id, inside or
 * outside an ARN. No legitimate generic catalog value contains one. */
const ACCOUNT_ID_RE = /\b\d{12}\b/;

/** First ARN in the string, capturing its account segment
 * (arn:partition:service:region:ACCOUNT:resource). */
const ARN_RE = /\barn:[a-z][a-z0-9-]*:[a-z0-9-]*:[a-z0-9-]*:([a-z0-9*-]*):/i;

/** True for an ARN whose account segment is the literal `aws` — an AWS-managed
 * identifier (arn:aws:iam::aws:policy/ReadOnlyAccess) that reads the same on
 * every account. The ONLY sanctioned ARN form in an allowed-value field. */
export function isAccountGenericArn(value: string): boolean {
  const m = ARN_RE.exec(value);
  return m !== null && m[1] === 'aws';
}

/** A GUID literal in a manifest value field — an Azure tenant/subscription id baked into
 * shared catalog data (the Azure twin of ACCOUNT_ID_RE). */
const GUID_LITERAL_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** A subscription-scoped ARM resource id (the Azure twin of ARN_RE). */
const ARM_RESOURCE_ID_RE = /\/subscriptions\/[0-9a-fA-F-]{36}(\/|\b)/;

export interface HardcodedValueViolation {
  file: string;
  /** dotted JSON location, e.g. `operations[3].params[2].bounds.allowlist[1]` */
  field: string;
  /** why it failed, for the CI log */
  reason: string;
  text: string;
}

/**
 * Walk one parsed manifest and report every allowed-value string that is
 * account-bound. Same walker shape as scanManifestBranding, keyed on
 * VALUE_KEYS instead of PROSE_KEYS.
 */
export function scanHardcodedValues(file: string, root: unknown): HardcodedValueViolation[] {
  const out: HardcodedValueViolation[] = [];
  const walk = (value: unknown, field: string, inValue: boolean): void => {
    if (typeof value === 'string') {
      if (!inValue) return;
      if (ACCOUNT_ID_RE.test(value)) {
        out.push({ file, field, reason: 'carries a 12-digit AWS account id', text: value });
      } else if (ARN_RE.test(value) && !isAccountGenericArn(value)) {
        out.push({ file, field, reason: 'is an account-bound ARN', text: value });
      } else if (ARM_RESOURCE_ID_RE.test(value)) {
        // Checked BEFORE the bare-GUID rule below: an ARM resource id's
        // subscription segment is itself a GUID, so testing GUID_LITERAL_RE
        // first would report the wrong (bare-GUID) reason for a full ARM path.
        out.push({ file, field, reason: 'is a subscription-scoped ARM resource id', text: value });
      } else if (GUID_LITERAL_RE.test(value)) {
        // A literal Azure subscription/tenant id must never be baked into shared
        // catalog data — the Azure twin of the account-id check above.
        out.push({
          file,
          field,
          reason: 'carries a literal Azure subscription/tenant id',
          text: value,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${field}[${i}]`, inValue));
      return;
    }
    if (value !== null && typeof value === 'object') {
      // `inValue` propagates DOWN: once inside an allowed-value field, every
      // nested member (a map default's entries, a list default's items) is
      // still a value — unlike prose keys, which never nest.
      for (const [k, v] of Object.entries(value)) {
        walk(v, field ? `${field}.${k}` : k, inValue || VALUE_KEYS.has(k));
      }
    }
  };
  walk(root, '', false);
  return out;
}

// ── (4) Single-provider manifest gate (0039 S1 lane L, beside the branding
// gate above) ─────────────────────────────────────────────────────────────
// Manifests are shared across projects on DIFFERING cloud providers now
// (0039 S1 azure seam) — lib/catalog.ts's deriveServiceCatalog filters a
// project's catalog by providerOfType(resourceType) vs the active project's
// own provider (project.provider ?? 'aws'), so an aws project never lists
// azure services and vice versa. That filter is only sound if every
// manifest's resourceTypes are homogeneous: a manifest naming BOTH aws_* and
// azurerm_* resource types would leak through whichever provider's filter
// happens to evaluate it, for whichever of its ops touch the OTHER
// provider's resource type. This check FAILs the build on any manifest whose
// resourceTypes mix providers — the same fail-closed posture as the other
// two gates above, never a silent guess.

export interface MixedProviderViolation {
  file: string;
  /** Every distinct provider found (always length >= 2 when non-null — a
   * single-provider or empty resourceTypes list returns null instead). */
  providers: CloudProvider[];
  resourceTypes: string[];
}

/**
 * Null for a manifest whose resourceTypes are all one provider (the required
 * shape) or empty (nothing to mix); a violation report otherwise, naming
 * every provider found and the exact resourceTypes list so the CI log points
 * straight at the offending manifest.
 */
export function scanMixedProviderManifest(
  file: string,
  resourceTypes: string[],
): MixedProviderViolation | null {
  if (resourceTypes.length === 0) return null;
  const providers = [...new Set(resourceTypes.map(providerOfType))];
  if (providers.length <= 1) return null;
  return { file, providers, resourceTypes };
}

const clip = (s: string): string => (s.length > 160 ? `${s.slice(0, 157)}…` : s);

function main(): void {
  const ops: GateOp[] = [];
  const brandingViolations: BrandingViolation[] = [];
  const valueViolations: HardcodedValueViolation[] = [];
  const mixedProviderViolations: MixedProviderViolation[] = [];
  const denylist = loadEstateDenylist();
  const files = readdirSync(MANIFESTS).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(MANIFESTS, f), 'utf8')) as {
      operations?: GateOp[];
      resourceTypes?: string[];
    };
    ops.push(...(m.operations ?? []));
    brandingViolations.push(...scanManifestBranding(f, m, denylist));
    valueViolations.push(...scanHardcodedValues(f, m));
    const mixed = scanMixedProviderManifest(f, m.resourceTypes ?? []);
    if (mixed) mixedProviderViolations.push(mixed);
  }
  const awsMap = loadMap(MAP_PATH);
  const azureMap = loadMap(AZURE_MAP_PATH);
  const maps: Record<CloudProvider, Record<string, MapEntry>> = {
    aws: awsMap.table,
    azure: azureMap.table,
  };
  const adjudications: Record<CloudProvider, Record<string, Adjudication>> = {
    aws: loadAdjudications(ADJ_PATH),
    azure: loadAdjudications(AZURE_ADJ_PATH),
  };

  const res = evaluateOpsByProvider(ops, maps, adjudications);
  for (const w of res.warns) console.log(w);
  for (const f of res.fails) console.error(f);
  console.log(
    `forcenew-gate: ${res.passes} pass · ${res.fails.length} FAIL · ${res.warns.length} warn · ` +
      `${res.skipped} out-of-scope · ${res.engineerAuthored} engineer-authored · ` +
      `${res.additiveCreate} create-class (total ${ops.length} ops)`,
  );

  const mapPresenceFails = evaluateMapPresence(ops, {
    aws: { fileExisted: awsMap.fileExisted, path: MAP_PATH },
    azure: { fileExisted: azureMap.fileExisted, path: AZURE_MAP_PATH },
  });
  for (const f of mapPresenceFails) console.error(f);
  console.log(
    `map-presence gate: ${mapPresenceFails.length === 0 ? 'clean' : `${mapPresenceFails.length} FAIL`}`,
  );

  for (const v of brandingViolations) {
    console.error(
      `FAIL BRANDING ${v.file} → ${v.field}: prose contains "${v.term}" — "${clip(v.text)}"`,
    );
  }
  console.log(
    `catalog-genericity: ${
      brandingViolations.length === 0
        ? `${files.length} manifests clean`
        : `${brandingViolations.length} FAIL`
    } (prose fields: ${[...PROSE_KEYS].join(', ')})`,
  );

  for (const v of valueViolations) {
    console.error(
      `FAIL HARDCODED-VALUE ${v.file} → ${v.field}: ${v.reason} — "${clip(v.text)}" (make it inventory-driven)`,
    );
  }
  console.log(
    `hardcoded-value gate: ${
      valueViolations.length === 0
        ? `${files.length} manifests clean`
        : `${valueViolations.length} FAIL`
    } (value fields: ${[...VALUE_KEYS].join(', ')})`,
  );

  for (const v of mixedProviderViolations) {
    console.error(
      `FAIL MIXED-PROVIDER ${v.file}: resourceTypes mix providers (${v.providers.join(', ')}) — ${v.resourceTypes.join(', ')}`,
    );
  }
  console.log(
    `single-provider gate: ${
      mixedProviderViolations.length === 0
        ? `${files.length} manifests clean`
        : `${mixedProviderViolations.length} FAIL`
    }`,
  );

  if (
    res.fails.length > 0 ||
    mapPresenceFails.length > 0 ||
    brandingViolations.length > 0 ||
    valueViolations.length > 0 ||
    mixedProviderViolations.length > 0
  ) {
    process.exit(1);
  }
}

// vite-node executes the module directly (process.argv[1] is vite-node's own
// bin path there, not this file, so it cannot be used to detect direct-run).
// Vitest sets process.env.VITEST='true' in its worker; skip main() only then,
// so `import { evaluateOps }` in tests never triggers the FS read / exit(1).
if (!process.env.VITEST) main();
