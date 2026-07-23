export type Macd = 'Add' | 'Move' | 'Change' | 'Delete';
export type Exposure = 'l1_self_service' | 'l1_with_guardrails' | 'engineer_only';
export type RiskFloor = 'LOW' | 'MEDIUM' | 'HIGH';
/** The binding action-picker taxonomy; see manifestSchema.ts for the
 * canonical enum (OP_GROUPS) and the group-assignment rules. */
export type OpGroup =
  | 'scale-performance'
  | 'availability-lifecycle'
  | 'connectivity-access'
  | 'protection-backup'
  | 'monitoring-alarms'
  | 'tags-naming'
  | 'danger-zone'
  | 'create';
export type ParamType = 'string' | 'number' | 'bool' | 'list' | 'map';
export type ParamSource = 'inventory' | 'user_input' | 'allowlist';
export type CodemodOp =
  | 'set_attribute'
  | 'append_block'
  | 'instantiate_module'
  | 'append_foreach_entry'
  | 'remove_block'
  | 'remove_foreach_entry'
  | 'moved_block'
  | 'set_association_attribute'
  // Additive: the executor verbs add (multi-attribute set, and
  // literal-tuple list-entry add/remove).
  | 'set_attributes'
  | 'append_list_entry'
  | 'remove_list_entry'
  // swap_child_block — additive: replaces whichever empty child of
  // a closed block-type choice set (target.path's parent) is present with the
  // one a role:"discriminator" param's segments map selects.
  | 'swap_child_block'
  // create_resource — additive: the draftSkeleton create verb authors
  // net-new top-level resource block(s) at EOF of the service file; replaces
  // instantiate_module on the resource-create baselines.
  | 'create_resource';

export interface ParamBounds {
  allowlist?: (string | number | boolean)[];
  min?: number;
  max?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  pattern?: string;
  semantic?: string;
  growOnly?: boolean;
}

export interface ManifestParam {
  name: string;
  label: string;
  type: ParamType;
  source: ParamSource;
  help?: string;
  bounds?: ParamBounds;
  enumSource?: string;
  required: boolean;
  default?: string | number | boolean;
  /* Optional presentation hints — the renderer is correct without any of them. */
  sensitive?: boolean;
  group?: string;
  tier?: 'primary' | 'advanced';
  uiWidget?: string;
  /* Role marks a param's job; the rest are
   * role-specific write hints. All optional/additive: a param with no role
   * behaves exactly as it did before this field existed.
   * - selector: value picks ONE sibling repeated block along target.path,
   *   matching matchAttr.
   * - reference: value is a resource address; refAttr names the attribute
   *   (arn|id|name, …) read off it and written.
   * - const: no request input — the executor writes `const` straight from the
   *   manifest.
   * - key: the attribute an append_block sibling is deduped/conflict-
   *   checked on (tier 2: a same-key different-content sibling refuses
   *   BLOCK_EXISTS instead of silently landing beside it).
   * - discriminator: value picks WHICH block/attr is edited, via
   *   segments — never a value written to HCL. Excluded from the value-provider
   *   set, so the op's true value param resolves unambiguously.
   * - wrap "list" wraps the resolved value in a 1-element tuple before writing. */
  role?: 'value' | 'selector' | 'reference' | 'const' | 'key' | 'discriminator';
  attr?: string;
  refAttr?: string;
  wrap?: 'list';
  matchAttr?: string;
  const?: unknown;
  /** Places this param's attribute inside a SUB-BLOCK of the block an
   * append_block synthesizes, e.g. ["create_rule"] → the attr lands in
   * `create_rule { … }` rather than the new block's own body. Relative to the
   * synthesized block, not the resource (TargetSelector.path addresses the
   * block's parent). Optional/additive. */
  path?: string[];
  /** Required iff role=="discriminator": the closed map from each
   * allowed request value (canonical string form) to the HCL identifier it
   * selects, e.g. {"JupyterServer":"jupyter_server_app_settings"}. The
   * request value is only ever a lookup key into this manifest-authored map;
   * no request byte can become an emitted name. Optional/additive. */
  segments?: Record<string, string>;
  /** Conditional visibility: this param renders (and validates,
   * client AND server) only while the named controlling param currently holds
   * (`equals`) / does not hold (`notEquals`) the given value — e.g. gp3 iops
   * only when volume_type == "gp3", provisioned MiB/s only when
   * throughput_mode == "provisioned". Exactly one of equals/notEquals. An
   * EMPTY controller value ('' / undefined / null) deactivates the dependent
   * param under BOTH operators (fail-closed to hidden). While inactive the
   * param is never required, its bounds are not applied, and its value is
   * stripped from the submitted request (lib/dependsOn.ts is the one
   * predicate both sides import). Optional/additive: absent preserves
   * pre-existing behavior exactly. */
  dependsOn?: ParamCondition;
  /** Marks this param as a REPEATED nested block — the provider nesting mode
   * `list`/`set`, a block that may appear 0..N times (an aws_security_group's
   * `ingress` rules, a dynamodb table's `attribute`/`global_secondary_index`,
   * a cloudfront distribution's `origin`/`ordered_cache_behavior`, an
   * autoscaling group's `tag`). Its SUBMITTED value is an ARRAY of records —
   * one per block instance, each keyed by the sub-schema's `fields[].name` —
   * and the draft renderer emits one `<block> { … }` per non-empty instance
   * (lib/hclSkeleton.ts). The form lets the requester add/remove instances
   * (components/SchemaForm/RepeatedBlockField.tsx). `bounds.minItems/maxItems`
   * bound the instance COUNT (reused, so validation is unchanged). A single
   * (non-repeated) nested block keeps the flat `path` idiom and is byte-for-byte
   * unaffected. Optional/additive: a param without `repeated` behaves exactly as
   * before this field existed. */
  repeated?: RepeatedBlockSpec;
}

/** The sub-schema of a REPEATED nested block (ManifestParam.repeated). `fields`
 * is the schema for ONE instance — ordinary ManifestParams whose
 * `attr`/`path`/`role`/`type`/`bounds`/`dependsOn` all apply RELATIVE to that
 * instance's record (so an instance can carry references, lists, dotted tag
 * maps, nested single blocks, engineer-decides TODOs, and even nested repeated
 * blocks — the renderer folds each instance through the same body builder the
 * top-level block uses). */
export interface RepeatedBlockSpec {
  /** The provider nesting mode. Both render as repeated `block { … }`; the
   * distinction is provider-semantic (a `set` is unordered), not a render
   * difference — the renderer treats them identically. */
  mode: 'list' | 'set';
  /** The emitted HCL block name. Defaults to the param's `attr ?? name`, so a
   * param named `ingress` needs no `block`; supply it only when the form key
   * must differ from the block name. */
  block?: string;
  /** The sub-schema for ONE block instance. */
  fields: ManifestParam[];
}

/** The closed condition vocabulary for ManifestParam.dependsOn.
 * Comparison is by canonical string form (String(v)), matching how bounded
 * form values round-trip; exactly one operator per condition (zod-enforced). */
export interface ParamCondition {
  /** Name of the controlling param on the same operation. */
  param: string;
  /** Active only while String(controller) === String(equals). */
  equals?: string | number | boolean;
  /** Active only while the controller is non-empty AND differs from this. */
  notEquals?: string | number | boolean;
}

export interface TargetSelector {
  resourceType: string;
  /** The EXPLICIT, authoritative scalar attribute a set_attribute
   * op writes. When set, catalogctl uses it verbatim and never parses the write
   * target from the terraformCapability prose (retires the paren-attr hazard).
   * Carried on every flat set_attribute op in the core L1 services
   * (EC2/EBS/RDS/S3/EFS/Backup/SG/ALB); other services migrate as follow-up.
   * Optional/additive — absent keeps the prose-paren/AttrFor fallback. */
  attr?: string;
  block?: string;
  /** A nested-block path walked from the located top-level block, e.g.
   * ["metadata_options"] or ["rule","lifecycle"]. Optional/additive. */
  path?: string[];
  /** Marks an append_block target whose block may exist at most once at
   * the addressed level (provider MaxItems:1) — a second, non-deep-equal
   * instance refuses BLOCK_EXISTS (tier 3) instead of silently landing a
   * duplicate. Optional/additive. */
  singleton?: boolean;
  /** Attr-less sub-block chains the synthesized append_block must also
   * contain, e.g. [["override_action","count"]] renders
   * `override_action { count {} }`. Declarative, no template language.
   * Optional/additive. */
  emptyBlocks?: string[][];
  /** Opts a target.path descent into create-on-missing: a missing
   * intermediate NON-REPEATED block is appended on demand while walking the
   * path (e.g. an app-settings wrapper a fresh domain hasn't materialized
   * yet). Optional/additive; default false preserves the
   * PATH_NOT_FOUND-on-absent behavior exactly. */
  ensurePath?: boolean;
  /** Opts a MAP/LIST-attribute edit into create-on-absent (the
   * attribute-level analog of ensurePath): append_foreach_entry /
   * set_attribute(mergeMap) / append_list_entry create the missing target.block
   * attribute as an empty literal `{}` / `[]` and write the added/merged entry
   * into it, instead of the exit-1 "attribute not found". Optional/
   * additive; default false preserves that exit-1-on-absent behavior exactly.
   * The remove verbs are not gated by it — a remove of an absent key is a NOOP. */
  ensureAttr?: boolean;
  /** Disambiguates repeated sibling blocks by WHICH attribute each
   * carries rather than any attribute's value (efs lifecycle_policy: one
   * sibling holds transition_to_ia, another transition_to_archive — no
   * request input exists to key a role:"selector" on). Keyed by path segment:
   * matchPresence[s] = a means "while descending path segment s, select the
   * sibling whose body declares attribute a". Optional/additive; a segment
   * with no entry keeps the value-selector/single-child descent
   * exactly as it was. */
  matchPresence?: Record<string, string>;
}

export interface ManifestOperation {
  id: string;
  service: string;
  macd: Macd;
  codemodOp: CodemodOp;
  title: string;
  /** Optional PLAIN operator headline — the first line an operator reads, in
   * plain language with no Terraform identifiers. It is the PROMINENT layer;
   * `description` stays as the SECONDARY technical detail rendered beneath it.
   * When absent, `description` is rendered as the headline (fallback), so an op
   * without a summary looks exactly as it did before this field existed. Length
   * is capped (~140 chars) so it stays a one-line headline; the plain wording is
   * held to the same notation bans as the rest of the rendered prose (copyLint).
   * Optional/additive. */
  summary?: string;
  /** Optional AWS Management Console field name for the setting this op changes
   * (e.g. Lambda memory → `Memory (MB)`, EC2 → `Instance type`). It is the SHORT
   * name a console-fluent operator scans for, and the SPA leads every operation
   * headline with it. When absent, the headline falls back to `title`, so a tail
   * service op looks exactly as it did before this field existed. Generic AWS
   * knowledge — it must stay estate-agnostic (verify:safety scans it as prose).
   * Optional/additive. */
  consoleLabel?: string;
  description: string;
  target: TargetSelector;
  params: ManifestParam[];
  riskFloor: RiskFloor;
  reversible: boolean;
  downtime: string;
  exposure: Exposure;
  forcesReplace: boolean;
  /**
   * @deprecated INERT / historical (no auto-apply). Retained only so the
   * existing manifest JSON validates; it MUST NEVER drive routing or approvals —
   * every change is human-approved regardless of this flag. Optional so that
   * synthesized in-memory operations (the schema-generated provision forms)
   * never have to write the retired field at all (autoEligible.test.ts proves
   * the no-runtime-read rule mechanically).
   */
  autoEligible?: boolean;
  terraformCapability: string;
  /** Required: every catalog op has one (backfilled by
   * scripts/backfill-groups.ts). */
  group: OpGroup;
  /** Display-priority rank (1 = highest) in a resourceType's "Common"
   * shortlist. Never present on Delete/Move/engineer_only/forcesReplace ops. */
  pinned?: number;
  /** Ticket-vocabulary search terms ("disk full", "open port"),
   * authored from the Day-2 scenario catalog's trigger phrases. Additive and
   * search-only: matched by the palette/catalog search haystacks, never
   * rendered as prose. Lower-case operator phrases, no notation. */
  keywords?: string[];
  /** Phase-1 elaboration: this create op's request carries a
   * generated, clearly-draft HCL skeleton for the engineer (rendered by
   * lib/hclSkeleton.ts; a pure function of target+params — safe).
   * Absent ⇒ no skeleton. Optional/additive. */
  draftSkeleton?: boolean;
  /** The engineer decisions this op deliberately does NOT capture
   * as params. Rendered as a TODO checklist in the skeleton, the request
   * detail, and the PR body. Declarative operator-plain strings; never
   * interpolated into HCL values. Optional/additive. */
  decisions?: string[];
}

export interface ServiceManifest {
  service: string;
  scope: 'estate' | 'greenfield' | 'expansion';
  resourceTypes: string[];
  summary: string;
  operations: ManifestOperation[];
}
