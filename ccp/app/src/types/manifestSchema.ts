import { z } from 'zod';
import type { ServiceManifest } from './manifest';

/**
 * Runtime validation for the service manifests — the single guard that replaces
 * the old `as unknown as ServiceManifest[]` cast. Every manifest is
 * parsed against this schema at load and in a test, so a malformed manifest fails
 * loudly (unknown codemodOp, missing riskFloor, bad enum) instead of silently.
 * Keep this in step with types/manifest.ts.
 */

const paramBounds = z
  .object({
    allowlist: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    maxLength: z.number().optional(),
    pattern: z.string().optional(),
    semantic: z.string().optional(),
    growOnly: z.boolean().optional(),
    cidrPolicy: z.string().optional(), // Machine-enforced CIDR guard (internal-only / no-public), catalogctl Validate
    maxPrefixLen: z.number().optional(), // Machine-enforced CIDR block-size floor (reject prefixes broader than /N), catalogctl Validate
  })
  .strict();

const manifestParamObject = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(['string', 'number', 'bool', 'list', 'map']),
    source: z.enum(['inventory', 'user_input', 'allowlist']),
    help: z.string().optional(),
    bounds: paramBounds.optional(),
    enumSource: z.string().optional(),
    required: z.boolean(),
    // A default may be a scalar, null, or (for list/map params) an array/object.
    default: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.unknown()),
        z.record(z.unknown()),
      ])
      .optional(),
    sensitive: z.boolean().optional(),
    group: z.string().optional(),
    tier: z.enum(['primary', 'advanced']).optional(),
    uiWidget: z.string().optional(),
    // Role marks a param's job: "selector" picks one sibling
    // repeated block along target.path by matching matchAttr; "reference" and
    // "const" write a resolved-address attribute or a manifest-fixed value
    // instead of a request-supplied one. "key" marks the attribute an
    // append_block sibling is deduped/conflict-checked on (tier 2: a
    // same-key different-content sibling refuses BLOCK_EXISTS instead of
    // silently landing beside it). "discriminator" marks a param
    // whose VALUE picks WHICH block/attr is edited, via segments — never a
    // value written to HCL. All optional/additive — a param with no role
    // behaves exactly as it did before this field existed.
    role: z.enum(['value', 'selector', 'reference', 'const', 'key', 'discriminator']).optional(),
    attr: z.string().optional(),
    refAttr: z.string().optional(),
    wrap: z.literal('list').optional(),
    matchAttr: z.string().optional(),
    const: z.unknown().optional(),
    // path places this param's attribute inside a SUB-BLOCK of the block
    // an append_block synthesizes, e.g. ["create_rule"] → the attr lands in
    // `create_rule { … }` rather than the new block's own body. Relative to the
    // synthesized block, not the resource (target.path addresses the block's
    // parent). Optional/additive.
    path: z.array(z.string()).optional(),
    // segments — the closed map from each allowed request value
    // (canonical string form) to the HCL identifier it selects, required iff
    // role=="discriminator". ResolveTarget (Go) emits ONLY these values — never
    // a raw request byte — so the map's co-domain IS the closed set of
    // reachable names. Optional/additive.
    segments: z.record(z.string()).optional(),
    // dependsOn — conditional visibility: the param renders and
    // validates only while the named controlling param holds (equals) / does
    // not hold (notEquals) the given value; exactly one operator. Hidden ⇒ the
    // value is ignored by validation on BOTH sides and stripped at submit
    // (lib/dependsOn.ts is the single shared predicate). Optional/additive:
    // absent preserves pre-existing behavior exactly.
    dependsOn: z
      .object({
        param: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
        notEquals: z.union([z.string(), z.number(), z.boolean()]).optional(),
      })
      .strict()
      .refine((d) => (d.equals !== undefined) !== (d.notEquals !== undefined), {
        message: 'dependsOn requires exactly one of equals / notEquals',
      })
      .optional(),
  });

/**
 * The full param schema: the base shape above PLUS the recursive `repeated`
 * field (a REPEATED nested block — types/manifest.ts RepeatedBlockSpec). Its
 * `fields` are themselves ManifestParams, so the schema is recursive and is
 * built with z.lazy; the `manifestParam` reference below is resolved only when a
 * manifest is parsed, by which point every const in this module is initialized.
 * `.strict()` still rejects any unknown key on a param (the guard the base had),
 * now including on each instance sub-field. Optional/additive: a param without
 * `repeated` validates exactly as it did before this field existed.
 */
const repeatedBlock = z
  .object({
    mode: z.enum(['list', 'set']),
    block: z.string().optional(),
    fields: z.array(z.lazy(() => manifestParam)),
  })
  .strict();

const manifestParam: z.ZodTypeAny = manifestParamObject
  .extend({ repeated: repeatedBlock.optional() })
  .strict();

const targetSelector = z
  .object({
    resourceType: z.string().min(1),
    // attr — the EXPLICIT, authoritative scalar attribute a
    // set_attribute op writes. When set, catalogctl's edit.attrName / nestedAttrName
    // and the plancheck verifier use it verbatim and NEVER parse the write target out
    // of the free-text terraformCapability prose (the retired paren-attr hazard).
    // The core L1 services (EC2/EBS/RDS/S3/EFS/Backup/SG/ALB) carry it on every flat
    // set_attribute op; the remaining services are migrated as follow-up. Optional/
    // additive — an op without it keeps the prose-paren/AttrFor fallback exactly.
    attr: z.string().optional(),
    block: z.string().optional(),
    // path — a nested-block path walked from the located top-level
    // block, e.g. ["metadata_options"] or ["rule","lifecycle"]. Optional/additive.
    path: z.array(z.string()).optional(),
    // singleton marks an append_block target whose block may exist at
    // most once at the addressed level (provider MaxItems:1) — a second,
    // non-deep-equal instance refuses BLOCK_EXISTS (tier 3) instead of
    // silently landing a duplicate. Optional/additive.
    singleton: z.boolean().optional(),
    // emptyBlocks are attr-less sub-block chains the synthesized
    // append_block must also contain, e.g. [["override_action","count"]] renders
    // `override_action { count {} }`. Declarative, no template language.
    // Optional/additive.
    emptyBlocks: z.array(z.array(z.string())).optional(),
    // ensurePath opts a target.path descent into create-on-missing:
    // a missing intermediate NON-REPEATED block is appended on demand while
    // walking the path (e.g. the app-settings wrapper a fresh domain hasn't
    // materialized yet). Optional/additive; default false preserves the
    // PATH_NOT_FOUND-on-absent behavior exactly.
    ensurePath: z.boolean().optional(),
    // ensureAttr opts a MAP/LIST-attribute edit into create-on-absent —
    // the attribute-level analog of ensurePath's block create-on-missing. When set,
    // append_foreach_entry / set_attribute(mergeMap) / append_list_entry treat a
    // MISSING target attribute (target.block naming the map/list) as an empty literal
    // `{}` / `[]` and write the added/merged entry into it, instead of the
    // exit-1 "attribute not found". Used by the tag-map ops on resources that declare
    // no `tags` literal (dynamodb/cloudwatch/cloudtrail/sns/…). Optional/additive;
    // default false preserves the exit-1-on-absent behavior exactly. The remove verbs
    // are NOT gated by it — a remove of an absent map/list key is a NOOP regardless.
    ensureAttr: z.boolean().optional(),
    // matchPresence disambiguates repeated sibling blocks by WHICH
    // attribute each carries rather than any attribute's value (efs
    // lifecycle_policy: one sibling holds transition_to_ia, another
    // transition_to_archive — no request input exists to key a role:"selector"
    // on). Keyed by path segment: matchPresence[s] = a means "while descending
    // path segment s, select the sibling whose body declares attribute a".
    // Optional/additive; a segment with no entry keeps the
    // value-selector/single-child descent exactly as it was.
    matchPresence: z.record(z.string()).optional(),
  })
  .strict();

// The binding action-picker taxonomy. Fixed 8-group order; every op
// gets exactly one. "create" is exclusive to macd:"Add" ops (service-scoped
// picker only, never per-resource); "danger-zone" is exclusive to Delete/Move
// ops plus any forcesReplace:true Change op (destroy+recreate is destructive
// regardless of macd). Landed optional first, backfilled, then flipped
// required — see scripts/backfill-groups.ts.
const opGroup = z.enum([
  'scale-performance',
  'availability-lifecycle',
  'connectivity-access',
  'protection-backup',
  'monitoring-alarms',
  'tags-naming',
  'danger-zone',
  'create',
]);

/** The 8 group values in fixed display order. Reused by the
 * backfill script and the opTaxonomy lint test so there is one source of truth. */
export const OP_GROUPS = opGroup.options;

const manifestOperation = z
  .object({
    id: z.string().min(1),
    service: z.string().min(1),
    macd: z.enum(['Add', 'Move', 'Change', 'Delete']),
    codemodOp: z.enum([
      'set_attribute',
      'append_block',
      'instantiate_module',
      'append_foreach_entry',
      'remove_block',
      'remove_foreach_entry',
      'moved_block',
      'set_association_attribute',
      // Additive: the executor verbs add (multi-attribute set, and
      // literal-tuple list-entry add/remove).
      'set_attributes',
      'append_list_entry',
      'remove_list_entry',
      // swap_child_block — additive: replaces whichever empty child
      // of a closed block-type choice set (target.path's parent) is present
      // with the one a role:"discriminator" param's segments map selects.
      'swap_child_block',
      // create_resource — additive: the draftSkeleton create verb authors
      // net-new top-level resource block(s) at EOF of the service file (the closed
      // idiom table). Replaces instantiate_module on the resource-create baselines so
      // the tool AUTHORS the diff instead of refusing NO_MODULE_SOURCE; exposure stays
      // engineer_only (creates still route to engineer review).
      'create_resource',
    ]),
    title: z.string().min(1),
    // summary — the optional PLAIN operator headline (types/manifest.ts). It is
    // the prominent layer an operator reads first; `description` stays as the
    // technical detail beneath it, and an op without a summary falls back to
    // rendering `description` as the headline. Bounded to a one-line headline
    // (~140 chars); min(1) rejects an empty headline. Optional/additive — a
    // summary-less op validates and renders exactly as before this field landed.
    summary: z.string().min(1).max(140).optional(),
    // consoleLabel — the optional AWS Management Console field name the SPA leads
    // each operation headline with (types/manifest.ts). Short by nature (a console
    // field label), so bounded to 60 chars; min(1) rejects an empty label. Absent
    // ⇒ the headline falls back to `title`, so a label-less op renders exactly as
    // before. Generic AWS knowledge held to the same prose bans as the rest of the
    // catalog (verify:safety). Optional/additive.
    consoleLabel: z.string().min(1).max(60).optional(),
    description: z.string(),
    target: targetSelector,
    params: z.array(manifestParam),
    riskFloor: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    reversible: z.boolean(),
    downtime: z.string(),
    exposure: z.enum(['l1_self_service', 'l1_with_guardrails', 'engineer_only']),
    forcesReplace: z.boolean(),
    // Inert/historical. Accepted for back-compat; never drives routing.
    autoEligible: z.boolean(),
    terraformCapability: z.string(),
    // Required: scripts/backfill-groups.ts has assigned all 680
    // catalog ops a group (landed optional first, backfilled, then flipped —
    // never a broken intermediate state).
    group: opGroup,
    // Display-priority rank (1 = highest) within a resourceType's
    // "Common" shortlist; never present on Delete/Move/engineer_only/
    // forcesReplace ops (lint-enforced in opTaxonomy.test.ts, not by the schema,
    // since the forbidden-combination rule spans multiple fields).
    pinned: z.number().int().min(1).max(5).optional(),
    // Ticket-vocabulary search terms, additive and search-only
    // (palette/catalog haystacks; never rendered). copyLint holds them to the
    // same notation bans as rendered prose so search data can't rot either.
    keywords: z.array(z.string().min(1)).optional(),
    // draftSkeleton — this create op's request carries a generated,
    // clearly-DRAFT HCL skeleton for the engineer (lib/hclSkeleton.ts, a pure
    // function of target+params). Absent ⇒ no skeleton. Optional/additive.
    draftSkeleton: z.boolean().optional(),
    // decisions — the engineer decisions the op deliberately does
    // NOT capture as params; rendered as a TODO checklist (skeleton, request
    // detail, PR body). Operator-plain strings, held to the same copyLint
    // notation bans as rendered prose. Optional/additive.
    decisions: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ServiceManifestSchema = z
  .object({
    service: z.string().min(1),
    scope: z.enum(['estate', 'greenfield', 'expansion']),
    resourceTypes: z.array(z.string()),
    summary: z.string(),
    operations: z.array(manifestOperation),
  })
  .strict();

export const ManifestArraySchema = z.array(ServiceManifestSchema);

/** Parse + validate a set of raw manifests, returning typed ServiceManifests.
 * Throws a descriptive ZodError naming the offending service/operation/field. */
export function parseManifests(raw: unknown[]): ServiceManifest[] {
  return ManifestArraySchema.parse(raw) as ServiceManifest[];
}
