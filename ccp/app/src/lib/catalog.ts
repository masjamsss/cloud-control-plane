import type {
  Inventory,
  Macd,
  ManifestOperation,
  ManifestParam,
  RepeatedBlockSpec,
  RiskFloor,
  ServiceManifest,
} from '@/types';
import { CATEGORY_ORDER, getServiceMeta, type Category, type ServiceMeta } from './serviceMeta';
import { humanizeAttr } from './chipLabel';
import { resolveRisk } from './riskOverrides';
import { providerOfType, type CloudProvider } from './providerDisplay';
import { AZURE_SERVICES, azureServiceOf } from './azureServiceMap';
import { AWS_SERVICES, awsServiceOf } from './awsServiceMap';
import { isParamActive } from './dependsOn';
import { checkBounds } from './validation';

/* ── Service catalog derivation (service-first browse) ─────────────────────── */

export interface RiskCounts {
  LOW: number;
  MEDIUM: number;
  HIGH: number;
}

export interface ServiceSummary {
  service: string;
  meta: ServiceMeta;
  /** The manifest whose ops this tile shows — absent for an op-less service (one
   * that browses for full provisionable coverage but has no catalogued op). */
  manifest?: ServiceManifest;
  operations: ManifestOperation[];
  /** The representative provisionable type the service's "Provision" action
   * deep-links to (/provision/<service>?type=…). Absent only for the few services
   * with no provisionable type at all (ops-only — they show no Provision action). */
  primaryType?: string;
  counts: {
    total: number;
    selfService: number;
    guardrails: number;
    engineer: number;
    actionable: number; // selfService + guardrails
    resources: number; // live inventory resources this service manages
    risk: RiskCounts;
  };
}

export interface CategoryGroup {
  category: Category;
  services: ServiceSummary[];
}

export function riskMix(ops: ManifestOperation[]): RiskCounts {
  const mix: RiskCounts = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  for (const op of ops) mix[resolveRisk(op)] += 1;
  return mix;
}

/**
 * The catalog service KEY an operation belongs to: its named cloud service
 * (console/portal parity — e.g. aws 's3'/'athena', azure 'vm'/'sql'/'cosmos')
 * when the op targets a type the generated tile map knows, otherwise the
 * manifest's own service slug. Provider-agnostic on purpose: azureServiceOf only
 * maps azurerm_* types and awsServiceOf only maps aws_* types, so the two never
 * collide — an aws op resolves to its ~133-service tile, an azure op to its
 * ~135-service tile, and anything unknown falls through to `manifestService`
 * (the pre-parity behavior). Shared by beyondCatalog and palette so every browse
 * surface groups both providers identically.
 */
export function catalogServiceKey(resourceType: string, manifestService: string): string {
  return azureServiceOf(resourceType) ?? awsServiceOf(resourceType) ?? manifestService;
}

/** The generated named-service tile map for a provider — the full provisionable
 * service set the catalog browses (both with-ops and op-less services). */
function serviceMapFor(provider: CloudProvider): Record<string, { primaryType?: string }> {
  return provider === 'aws' ? AWS_SERVICES : AZURE_SERVICES;
}

interface ServiceAccumulator {
  ops: ManifestOperation[];
  /** Ops contributed per manifest — picks the dominant `.manifest` when a named
   * azure service's ops span more than one manifest file (e.g. 'vm' draws from
   * azure-compute and azure-other). */
  opsPerManifest: Map<ServiceManifest, number>;
}

/** The manifest that contributed the most of a service's ops (ties → first seen). */
function dominantManifest(opsPerManifest: Map<ServiceManifest, number>): ServiceManifest {
  let best: ServiceManifest | undefined;
  let bestCount = -1;
  for (const [manifest, count] of opsPerManifest) {
    if (count > bestCount) {
      best = manifest;
      bestCount = count;
    }
  }
  // Never empty: an accumulator only exists once ≥1 op has been pushed into it.
  return best!;
}

/**
 * Group every operation across the (provider-filtered) manifests by its
 * {@link catalogServiceKey}, yielding one ServiceSummary per named service. For
 * aws it fans the 47 manifests out into their 133 console services and for azure
 * the 16 manifests into their 135 portal services (an op's key is its target
 * type's named service, so ops fan across manifests — e.g. an ACM cert op on an
 * ALB listener cards under 'alb'). Resource counts are attributed
 * to the service that owns each declared resourceType, so a named service shows
 * only its own live resources.
 */
function summarizeByService(
  manifests: ServiceManifest[],
  resourceCounts: Map<string, number>,
  provider: CloudProvider,
): ServiceSummary[] {
  const byKey = new Map<string, ServiceAccumulator>();
  // Declared resourceTypes → their owning service key, so a service's resource
  // tally covers exactly the types it owns (not its whole source manifest's).
  const typesByKey = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    for (const type of manifest.resourceTypes) {
      const key = catalogServiceKey(type, manifest.service);
      (typesByKey.get(key) ?? typesByKey.set(key, new Set()).get(key)!).add(type);
    }
    for (const op of manifest.operations) {
      const key = catalogServiceKey(op.target.resourceType, manifest.service);
      let acc = byKey.get(key);
      if (!acc) {
        acc = { ops: [], opsPerManifest: new Map() };
        byKey.set(key, acc);
      }
      acc.ops.push(op);
      acc.opsPerManifest.set(manifest, (acc.opsPerManifest.get(manifest) ?? 0) + 1);
    }
  }

  const summaries: ServiceSummary[] = [];
  for (const [service, acc] of byKey) {
    const operations = acc.ops;
    const selfService = operations.filter((o) => o.exposure === 'l1_self_service').length;
    const guardrails = operations.filter((o) => o.exposure === 'l1_with_guardrails').length;
    const engineer = operations.filter((o) => o.exposure === 'engineer_only').length;
    const resources = [...(typesByKey.get(service) ?? [])].reduce(
      (n, t) => n + (resourceCounts.get(t) ?? 0),
      0,
    );
    summaries.push({
      service,
      meta: getServiceMeta(service, provider),
      manifest: dominantManifest(acc.opsPerManifest),
      operations,
      primaryType: serviceMapFor(provider)[service]?.primaryType,
      counts: {
        total: operations.length,
        selfService,
        guardrails,
        engineer,
        actionable: selfService + guardrails,
        resources,
        risk: riskMix(operations),
      },
    });
  }
  return summaries;
}

/** Count live inventory resources by resourceType (empty map when no inventory). */
function countByType(inventory?: Inventory): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of inventory?.resources ?? []) {
    counts.set(r.resourceType, (counts.get(r.resourceType) ?? 0) + 1);
  }
  return counts;
}

/**
 * Count live inventory resources by their named-service KEY, provider-scoped —
 * so an op-less service's tile shows its own live resource tally even though it
 * has no manifest declaring those types. Only the active provider's types count
 * (azureServiceOf maps only azurerm_*, awsServiceOf only aws_*), so the two never
 * cross. With-ops services keep their manifest-declared count (unchanged); this
 * feeds only the op-less summaries, whose slugs are disjoint from those.
 */
function countByServiceKey(
  inventory: Inventory | undefined,
  provider: CloudProvider,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of inventory?.resources ?? []) {
    const key = provider === 'aws' ? awsServiceOf(r.resourceType) : azureServiceOf(r.resourceType);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * A browsable tile for a named service with NO catalogued op — the long tail of
 * provisionable services that "full coverage" adds. It carries no manifest and
 * `operations: []`, so its card renders a "Provision <service>" call-to-action
 * (ServiceCard) into the generic provision form rather than a dead/empty tile.
 */
function oplessSummary(
  slug: string,
  provider: CloudProvider,
  primaryType: string | undefined,
  resources: number,
): ServiceSummary {
  return {
    service: slug,
    meta: getServiceMeta(slug, provider),
    operations: [],
    primaryType,
    counts: {
      total: 0,
      selfService: 0,
      guardrails: 0,
      engineer: 0,
      actionable: 0,
      resources,
      risk: { LOW: 0, MEDIUM: 0, HIGH: 0 },
    },
  };
}

/**
 * True when EVERY resourceType a manifest declares belongs to `provider` —
 * the exact condition the single-provider manifest gate (scripts/
 * verify-manifest-safety.ts) enforces at CI time, so a well-formed manifest
 * always resolves unambiguously here. A manifest with zero resourceTypes
 * matches NEITHER provider (fail-closed, never a vacuous match for both) —
 * that shape does not occur in the shipped catalog today, but this seam
 * never guesses (0039 global rule 2).
 */
function manifestMatchesProvider(manifest: ServiceManifest, provider: CloudProvider): boolean {
  return (
    manifest.resourceTypes.length > 0 &&
    manifest.resourceTypes.every((rt) => providerOfType(rt) === provider)
  );
}

/**
 * Group services by category, sorted by CATEGORY_ORDER then display name. Ops
 * are grouped by their {@link catalogServiceKey}, so an aws project browses one
 * tile per named console service (133, fanned out of its 47 shared manifests)
 * and an azure project one tile per named portal service (135, fanned out of its
 * 16 shared manifests).
 *
 * Manifests are shared across projects of DIFFERING cloud providers — an aws
 * project must never be offered azure services and vice versa. `provider` is
 * the ACTIVE project's cloud provider (ServiceCatalog.tsx passes
 * `project.provider ?? 'aws'`, the same wire convention every other
 * provider-aware seam uses — see lib/beyondCatalog.ts); it defaults to 'aws' so
 * every pre-existing caller (all AWS-only projects before this seam) is
 * unaffected.
 */
export function deriveServiceCatalog(
  manifests: ServiceManifest[],
  inventory?: Inventory,
  provider: CloudProvider = 'aws',
): CategoryGroup[] {
  const resourceCounts = countByType(inventory);
  const providerManifests = manifests.filter((m) => manifestMatchesProvider(m, provider));
  // No manifests for this provider → an empty catalog (the "data hasn't loaded"
  // state). Full provisionable coverage is a property of a LOADED project, which
  // always ships its provider's shared manifests; deriving the full tile map off
  // zero manifests would fabricate a browsable catalog for an account with no
  // data, so this stays fail-closed (preserves the zero-manifest → zero-groups
  // invariant every no-data surface relies on).
  if (providerManifests.length === 0) return [];

  const summaries = summarizeByService(providerManifests, resourceCounts, provider);

  // Full provisionable coverage: every named service in the provider's tile map
  // browses — even one with no catalogued op. An op-less service gets an
  // `operations: []` summary here so its tile still renders (as a "Provision
  // <service>" call-to-action), turning the catalog from "services we curated
  // ops for" into "every top-level provisionable service".
  const covered = new Set(summaries.map((s) => s.service));
  const resourcesByKey = countByServiceKey(inventory, provider);
  for (const [slug, def] of Object.entries(serviceMapFor(provider))) {
    if (covered.has(slug)) continue;
    summaries.push(oplessSummary(slug, provider, def.primaryType, resourcesByKey.get(slug) ?? 0));
  }

  const groups: CategoryGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const services = summaries
      .filter((s) => s.meta.category === category)
      .sort((a, b) => a.meta.displayName.localeCompare(b.meta.displayName));
    if (services.length > 0) groups.push({ category, services });
  }
  return groups;
}

/* ── MACD verbs & glyphs ───────────────────────────────────────────────────── */

export function verbFor(macd: Macd): string {
  switch (macd) {
    case 'Add':
      return 'Request add';
    case 'Change':
      return 'Request change';
    case 'Delete':
      return 'Request deletion';
    case 'Move':
      return 'Request move';
    default:
      return 'Submit request';
  }
}

export function macdGlyph(macd: Macd): string {
  switch (macd) {
    case 'Add':
      return '+';
    case 'Change':
      return '~';
    case 'Move':
      return '→';
    case 'Delete':
      return '−';
    default:
      return '·';
  }
}

/* ── Form plan (deterministic layout engine) ───────────────────────────────── */

export type SectionId = 'target' | 'change' | 'options';

export interface FormSectionPlan {
  id: SectionId;
  title: string;
  collapsed: boolean;
  fields: ManifestParam[];
}

export interface FormPlan {
  sections: FormSectionPlan[];
  submitLabel: string;
  needsAck: boolean;
  warnings: string[];
}

/** Non-blocking, honest warnings surfaced beside the form and on review. */
export function softWarnings(op: ManifestOperation): string[] {
  const w: string[] = [];
  if (op.forcesReplace) w.push('This will replace the resource (destroy + recreate).');
  if (!op.reversible) w.push('This change is irreversible.');
  if (op.downtime && op.downtime !== 'none') w.push(`Causes ${op.downtime} downtime.`);
  return w;
}

/**
 * Deterministically lay a manifest operation out into sections — Target (inventory
 * params), Change (required user-input/allowlist), Additional configuration
 * (optional/advanced, collapsed). Justification is handled by the form shell.
 * One engine renders a 1-field op and a 15-field op with no bespoke code.
 */
export function deriveFormPlan(op: ManifestOperation): FormPlan {
  const target: ManifestParam[] = [];
  const change: ManifestParam[] = [];
  const options: ManifestParam[] = [];

  for (const p of op.params) {
    if (p.source === 'inventory') {
      target.push(p);
    } else if (p.tier === 'advanced' || (!p.required && p.tier !== 'primary')) {
      options.push(p);
    } else {
      change.push(p);
    }
  }

  const sections: FormSectionPlan[] = [];
  if (target.length > 0)
    sections.push({ id: 'target', title: 'Target resource', collapsed: false, fields: target });
  if (change.length > 0)
    sections.push({ id: 'change', title: 'Change', collapsed: false, fields: change });
  if (options.length > 0)
    sections.push({
      id: 'options',
      title: 'Additional configuration',
      collapsed: true,
      fields: options,
    });

  // (The old `layout: 'single' | 'stepped'` field is deliberately GONE — it
  // was computed here and consumed nowhere. Multi-field baselines
  // structure themselves with grouped fieldsets instead: groupFields below.)
  return {
    sections,
    submitLabel: verbFor(op.macd),
    needsAck: resolveRisk(op) !== 'LOW',
    warnings: softWarnings(op),
  };
}

/* ── Grouped fieldsets (param.group finally renders) ─────────────── */

export interface FieldGroup {
  /** The manifest's group slug, or null for the leading ungrouped run. */
  id: string | null;
  /** Operator-facing legend, or null for the ungrouped run (rendered bare). */
  legend: string | null;
  fields: ManifestParam[];
}

/**
 * The legend for a param-group slug — deterministic humanization via the
 * shared chip-label word map, so "iam-storage" reads "IAM storage" and
 * "identity" reads "Identity" with no per-manifest display table.
 */
export function legendFor(group: string): string {
  return humanizeAttr(group.replace(/-/g, '_'));
}

/**
 * Partition a section's fields into rendering groups by `param.group`, in
 * first-appearance order. Ungrouped params render exactly as they always
 * have (no wrapper — an op with no param groups produces one anonymous group
 * and byte-identical markup to before this existed); each named group
 * becomes a <fieldset> with a legend in SchemaForm. Pure layout — values,
 * validation and ordering are untouched.
 */
export function groupFields(fields: ManifestParam[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  const named = new Map<string, FieldGroup>();
  let anonymous: FieldGroup | null = null;
  for (const f of fields) {
    const id = f.group ?? null;
    let g: FieldGroup | null | undefined = id === null ? anonymous : named.get(id);
    if (!g) {
      g = { id, legend: id === null ? null : legendFor(id), fields: [] };
      if (id === null) anonymous = g;
      else named.set(id, g);
      groups.push(g);
    }
    g.fields.push(f);
  }
  return groups;
}

/* ── current → new (impact panel) ──────────────────────────────────────────── */

export interface TargetCurrent {
  attr: string;
  current: string | number | boolean | undefined;
}

/**
 * Resolve the attribute a change touches and its current value, for the
 * "current → new" impact line. The touched attribute is derivable by stripping
 * a `new_` prefix from the change param name (same convention validateParams uses).
 */
export function resolveTargetCurrent(
  op: ManifestOperation,
  values: Record<string, unknown>,
  inventory: Inventory,
): TargetCurrent | null {
  const targetParam = op.params.find((p) => p.source === 'inventory');
  if (!targetParam) return null;
  const address = String(values[targetParam.name] ?? '');
  const resource = inventory.resources.find((r) => r.address === address);
  if (!resource) return null;

  const changeParam = op.params.find(
    (p) => p.source !== 'inventory' && (p.name.startsWith('new_') || p.name === 'target_type'),
  );
  if (!changeParam) return null;
  const attr = changeParam.name.replace(/^new_/, '').replace(/^target_/, '');
  return { attr, current: resource.attributes[attr] };
}

export const riskLabel: Record<RiskFloor, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

/* ── Repeated-block form state (list/set nested blocks) ─────────────────────── */

/**
 * The pure state helpers a repeated-block field (a param with `repeated`) drives
 * its add/remove/edit with. A repeated param's submitted value is an ARRAY of
 * records — one per block instance — and these functions are the ONLY things
 * that shape that array, so the component stays a thin, DOM-only shell and the
 * mutation logic is unit-tested with no renderer. Every helper is pure: it
 * returns a NEW array/record and never mutates its input, so React state updates
 * stay referentially honest.
 */

/** Coerce a stored repeated value to an array of instance records — undefined /
 * a non-array / non-object entries all fold away, so the field always renders a
 * clean list (fail-closed: a malformed value shows zero rows, never throws). */
export function readRepeatedInstances(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is Record<string, unknown> => e !== null && typeof e === 'object' && !Array.isArray(e),
  );
}

/** A fresh instance seeded with the sub-schema's non-const defaults — the same
 * default-seeding the top-level form applies (const params are executor-written,
 * never seeded as input). */
export function seedRepeatedInstance(spec: RepeatedBlockSpec): Record<string, unknown> {
  const init: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (f.role === 'const') continue;
    if (f.default !== undefined) init[f.name] = f.default;
  }
  return init;
}

/** Append one seeded instance. */
export function addRepeatedInstance(
  value: unknown,
  spec: RepeatedBlockSpec,
): Record<string, unknown>[] {
  return [...readRepeatedInstances(value), seedRepeatedInstance(spec)];
}

/** Drop the instance at `index` (a no-op if out of range). */
export function removeRepeatedInstance(value: unknown, index: number): Record<string, unknown>[] {
  return readRepeatedInstances(value).filter((_, i) => i !== index);
}

/** Set one sub-field of the instance at `index`, returning a new array. */
export function updateRepeatedInstance(
  value: unknown,
  index: number,
  subName: string,
  subValue: unknown,
): Record<string, unknown>[] {
  return readRepeatedInstances(value).map((row, i) =>
    i === index ? { ...row, [subName]: subValue } : row,
  );
}

/**
 * The bounds/required errors of ONE instance, keyed by sub-field name — the same
 * required-then-checkBounds law the top-level form applies, run against the
 * instance record (so a sub-field's `dependsOn` reads its instance siblings).
 * Empty object ⇒ the instance is valid. Shared by the field (inline display) and
 * validateParams (submit gate) so the two never disagree. A nested repeated
 * sub-field flags its parent when any of ITS instances is invalid (recursive).
 */
export function repeatedInstanceErrors(
  spec: RepeatedBlockSpec,
  instance: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of spec.fields) {
    if (f.role === 'const') continue;
    if (!isParamActive(f, instance)) continue;
    const v = instance[f.name];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (f.required && empty) {
      errors[f.name] = `${f.label} is required`;
      continue;
    }
    if (empty) continue;
    if (f.repeated) {
      const rows = readRepeatedInstances(v);
      if (rows.some((r) => Object.keys(repeatedInstanceErrors(f.repeated!, r)).length > 0)) {
        errors[f.name] = `${f.label} has an entry that needs attention`;
      }
      continue;
    }
    const err = checkBounds(f, v);
    if (err) errors[f.name] = err;
  }
  return errors;
}

/** True when every instance of a repeated param validates (used by the submit
 * gate to aggregate a single error onto the param key). */
export function repeatedBlockValid(
  spec: RepeatedBlockSpec,
  instances: Record<string, unknown>[],
): boolean {
  return instances.every((r) => Object.keys(repeatedInstanceErrors(spec, r)).length === 0);
}
