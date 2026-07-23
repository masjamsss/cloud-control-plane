/**
 * Shared, pure logic for the ForceNew verify gate (docs/proposals/0006 §5,
 * completed by 0020). The provider docs' "in-place" labels are unreliable and
 * `terraform providers schema -json` omits ForceNew entirely (0009 L1), so the
 * single authority is the compiled-and-reflected provider schema dump at
 * tools/schemadump/aws-v6.53.0-schema.json (0013d G0). This module holds:
 *
 *   1. extractOpAttrs — which attribute path(s) a catalog op writes, derived
 *      from the op's STRUCTURAL codemod fields (target.path, param.attr,
 *      param.role, discriminator segments) mirroring the Go executor's
 *      manifests.AttrFor, with the capability-parenthetical heuristic kept
 *      first for back-compat (it documents full nested paths on many ops).
 *   2. resolveAttrPath / collectSuffixMatches — verdict lookups against the
 *      schemadump reflection (exact walk, and leaf-suffix rescue for
 *      heuristically-derived keys whose block nesting was flattened away).
 *
 * Doctrine (0010 §3, 0013d §6.4): unresolved ⇒ treat AS ForceNew (fail-closed).
 * A verdict may only come from the dump or from an explicit human adjudication.
 */

/** Per-provider pins. Each MUST match that provider's estate versions.tf pin
 * and the dump metadata — the gate refuses a mismatched dump (build-forcenew-map).
 * azure's pin is the F1 spike tag (0039 S4 gate); no estate versions.tf exists
 * for azure yet (Azure onboarding is a separate, not-yet-built flow) — the aws
 * pin is the one load-bearing today. */
export const PROVIDER_TAGS = { aws: 'v6.53.0', azure: 'v4.81.0' } as const;
export type ForceNewProvider = keyof typeof PROVIDER_TAGS;
export const PROVIDER_TAG = PROVIDER_TAGS.aws; // legacy alias — existing imports unchanged

/**
 * tf-attr ← manifest-param renames. EXACT mirror of catalogctl's
 * internal/manifests/manifests.go renameTable (reversed naming kept for
 * history). Do NOT add entries here that the Go executor does not have —
 * the two tables must never drift, because this mirror exists to predict
 * what the executor will actually write. Param names that need a different
 * schema attribute belong in the manifest's explicit `attr` field.
 */
const REVERSE_RENAME: Record<string, Record<string, string>> = {
  aws_ebs_volume: { size_gib: 'size' },
};

export interface OpParamLike {
  name: string;
  source?: string;
  role?: string;
  attr?: string;
  refAttr?: string;
  path?: string[];
  segments?: Record<string, string>;
  enumSource?: string;
}

export interface OpLike {
  codemodOp: string;
  terraformCapability?: string;
  params?: OpParamLike[];
  target: { resourceType: string; path?: string[] };
}

const ATTR_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const SEGMENT_RE = /^[a-z0-9_]+$/;
const DISCRIMINATOR_RE = /^\{param:([a-z0-9_]+)\}$/;

/** Where an extracted attribute path came from — drives dump-resolution rules. */
export type AttrSource = 'capability' | 'structural';

export interface ExtractedAttr {
  path: string;
  source: AttrSource;
}

export type Extraction =
  /** Free-form escalation op — an engineer authors the Terraform; there is no
   * codemod attribute by construction. Out of the gate's scope, counted. */
  | { kind: 'engineer_authored' }
  /** `+ create` capability — the op CREATES a new resource; nothing existing
   * can be replaced by it. Out of the gate's scope, counted. */
  | { kind: 'additive_create' }
  | { kind: 'attrs'; attrs: ExtractedAttr[] }
  | { kind: 'unextractable' };

/**
 * Tier 1 — terraformCapability parenthetical, e.g. "~ update (a.b, c_d)".
 * Comma/semicolon segments are independent attr paths. Within a segment the
 * FIRST whitespace token is taken (annotations like "→ ENABLED" follow it),
 * but a bare single word is only accepted when it IS the whole segment:
 * "(instance)" → instance, while "(in place)" / "(rule priority, in-place)"
 * are prose and yield nothing. Tokens with '.' or '_' are unambiguous attr
 * names and accepted with trailing annotations.
 */
function capabilityAttrs(op: OpLike): string[] {
  const m = /\(([^)]+)\)/.exec(op.terraformCapability ?? '');
  if (!m) return [];
  const out: string[] = [];
  for (const rawSeg of m[1]!.split(/[,;]/)) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    const tok = seg.split(/\s+/)[0]!;
    if (!ATTR_RE.test(tok)) continue;
    if (tok !== seg && !tok.includes('.') && !tok.includes('_')) continue; // prose word
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

/** Mirror of catalogctl manifests.AttrFor: explicit attr wins, else the
 * param name with the frozen `new_` prefix stripped and renameTable applied. */
export function attrFor(op: OpLike, p: OpParamLike): string {
  if (p.attr) return p.attr;
  let name = p.name.replace(/^new_/, '');
  name = REVERSE_RENAME[op.target.resourceType]?.[name] ?? name;
  return name;
}

/**
 * The op's resource-locator param: the one that picks WHICH resource is
 * edited. First param whose enumSource is `inventory://<target type>/address`,
 * falling back to the first inventory-sourced param.
 */
function locatorIndex(op: OpLike): number {
  const params = op.params ?? [];
  const want = `inventory://${op.target.resourceType}/address`;
  const exact = params.findIndex((p) => p.enumSource === want);
  if (exact >= 0) return exact;
  return params.findIndex((p) => p.source === 'inventory');
}

/** Params whose value is WRITTEN into HCL (0010 U1 / 0013a/b semantics):
 * everything except the locator and pure block-pickers (selector,
 * discriminator, key). Inventory-sourced params only write when they are
 * reference/const-role, carry an explicit attr, or follow the `new_` value
 * convention (e.g. routing-move's new_route_table_id). */
function writtenParams(op: OpLike): OpParamLike[] {
  const params = op.params ?? [];
  const locator = locatorIndex(op);
  return params.filter((p, i) => {
    if (i === locator) return false;
    if (p.role === 'selector' || p.role === 'discriminator' || p.role === 'key') return false;
    if (p.attr || p.role === 'reference' || p.role === 'const') return true;
    if (p.source === 'inventory') return p.name.startsWith('new_');
    return true;
  });
}

/** Expand target.path, fanning `{param:NAME}` discriminator segments out over
 * the named param's closed `segments` co-domain (0013b M0). Returns null when
 * a segment is invalid or a discriminator cannot be expanded — the op is then
 * unextractable (fail-visible), never silently guessed. */
function expandTargetPath(op: OpLike): string[][] | null {
  let prefixes: string[][] = [[]];
  for (const seg of op.target.path ?? []) {
    const disc = DISCRIMINATOR_RE.exec(seg);
    if (disc) {
      const p = (op.params ?? []).find((x) => x.name === disc[1]);
      const values = [...new Set(Object.values(p?.segments ?? {}))].sort();
      if (values.length === 0 || values.some((v) => !SEGMENT_RE.test(v))) return null;
      prefixes = prefixes.flatMap((pre) => values.map((v) => [...pre, v]));
    } else if (SEGMENT_RE.test(seg)) {
      prefixes = prefixes.map((pre) => [...pre, seg]);
    } else {
      return null;
    }
  }
  return prefixes;
}

/**
 * Every attribute path a catalog op writes (or an out-of-scope class).
 * Tier order:
 *   0. engineer-authored / `+ create` capability → out-of-scope classes.
 *   1. capability parenthetical (documents full nested paths; kept first so
 *      reference-role ops whose param NAME is UX-ish, e.g. cloudtrail's
 *      `bucket` → s3_bucket_name, key on the documented schema attr).
 *   2. structural: target.path (+ param.path) + attrFor(param) for every
 *      written param, discriminator segments fanned out closed-set.
 * A key extracted here is only a LOOKUP key — verdicts come exclusively from
 * the committed map / adjudications, so a misspelling can never pass silently.
 */
export function extractOpAttrs(op: OpLike): Extraction {
  const cap = (op.terraformCapability ?? '').trim();
  if (cap === '~ engineer-authored') return { kind: 'engineer_authored' };
  if (cap.startsWith('+ create')) return { kind: 'additive_create' };

  const capAttrs = capabilityAttrs(op);
  if (capAttrs.length > 0) {
    return { kind: 'attrs', attrs: capAttrs.map((path) => ({ path, source: 'capability' })) };
  }

  const prefixes = expandTargetPath(op);
  if (prefixes === null) return { kind: 'unextractable' };
  const attrs: ExtractedAttr[] = [];
  for (const p of writtenParams(op)) {
    const attr = attrFor(op, p);
    for (const prefix of prefixes) {
      const path = [...prefix, ...(p.path ?? []), attr].join('.');
      if (!ATTR_RE.test(path)) continue;
      if (!attrs.some((a) => a.path === path)) attrs.push({ path, source: 'structural' });
    }
  }
  return attrs.length > 0 ? { kind: 'attrs', attrs } : { kind: 'unextractable' };
}

// ── schemadump resolution ────────────────────────────────────────────────────

export interface DumpAttr {
  force_new?: boolean;
  block?: { attributes?: Record<string, DumpAttr> };
}

export interface DumpResource {
  framework?: boolean;
  framework_unreflected?: boolean;
  has_customize_diff?: boolean;
  attributes?: Record<string, DumpAttr>;
}

export interface DumpFile {
  metadata?: { provider_tag?: string };
  resources: Record<string, DumpResource>;
}

export interface ResolvedVerdict {
  forceNew: boolean;
  /** Dot-path of dump nodes walked, e.g. "root_block_device.block.volume_size". */
  nodePath: string;
}

/**
 * Exact walk of a dotted attribute path through the reflected schema tree.
 * The verdict ORs force_new along the WHOLE chain: a ForceNew parent block
 * replaces the resource however innocent the leaf inside it is (fail-closed;
 * stricter than the old Go-text scan, which looked at the leaf scope only).
 */
export function resolveAttrPath(res: DumpResource, attrPath: string): ResolvedVerdict | null {
  let attrs = res.attributes;
  let forceNew = false;
  const walked: string[] = [];
  for (const seg of attrPath.split('.')) {
    const node = attrs?.[seg];
    if (!node) return null;
    forceNew = forceNew || node.force_new === true;
    walked.push(seg);
    attrs = node.block?.attributes;
  }
  return { forceNew, nodePath: walked.join('.') };
}

/**
 * All full attribute paths in the reflected tree whose trailing SEGMENTS equal
 * `attrPath` — the rescue for heuristic keys recorded with block levels
 * flattened away (the 0013d B1 class, e.g. `cross_region_copy_rule.cmk_arn`
 * for policy_details.schedule.cross_region_copy_rule.cmk_arn). Each match
 * carries the chain-OR verdict from the resource root, so a consumer taking
 * the OR over all matches stays fail-closed under ambiguity.
 */
export function collectSuffixMatches(res: DumpResource, attrPath: string): ResolvedVerdict[] {
  const want = attrPath.split('.');
  const out: ResolvedVerdict[] = [];
  const visit = (
    attrs: Record<string, DumpAttr> | undefined,
    prefix: string[],
    fnSoFar: boolean,
  ): void => {
    if (!attrs) return;
    for (const [name, node] of Object.entries(attrs)) {
      const full = [...prefix, name];
      const fn = fnSoFar || node.force_new === true;
      if (
        full.length >= want.length &&
        want.every((w, i) => full[full.length - want.length + i] === w)
      ) {
        out.push({ forceNew: fn, nodePath: full.join('.') });
      }
      visit(node.block?.attributes, full, fn);
    }
  };
  visit(res.attributes, [], false);
  return out.sort((a, b) => a.nodePath.localeCompare(b.nodePath));
}

export interface MapEntry {
  verdict: 'force_new' | 'in_place' | 'unresolved';
  /** Provenance file the verdict came from ('' when unresolved). */
  file: string;
  /** Provider tag the verdict was derived at. */
  tag: string;
  /** Schemadump node(s) proving the verdict: an exact walked path, or
   * "suffix-match: a | b" listing every leaf-suffix hit that was OR-ed. */
  path?: string;
  /** Why an unresolved row is unresolved (framework_unreflected,
   * not_in_schema — resource has_customize_diff, …). */
  note?: string;
}
