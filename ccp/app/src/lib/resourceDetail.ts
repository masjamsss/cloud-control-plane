import type {
  Exposure,
  InventoryResource,
  Macd,
  ManifestOperation,
  ManifestParam,
  OpGroup,
} from '@/types';
import { OP_GROUPS } from '@/types/manifestSchema';
import { GROUP_LABELS } from '@/lib/actionPicker';
import { opTextLayers } from '@/lib/opText';
import { chipLabelFor, formatAttrValue, humanizeAttr, displayResourceLabel } from '@/lib/chipLabel';
import { stripProviderPrefix } from '@/lib/providerDisplay';

/**
 * Pure engine for the resource detail page: it GENERATES the page's tabbed
 * sections from the catalog (every op targeting the resource's type) and FILLS
 * each editable capability with the resource's CURRENT value from the inventory.
 * Nothing here touches the DOM — ResourceDetailView is a thin consumer — so the
 * generation and the op→current-value mapping are unit-testable without a DOM
 * (this app has no jsdom; see src/test/setup.ts).
 *
 * The join that fills a capability with its current value is target.attr →
 * resource.attributes[target.attr]. Its limits are real and surfaced honestly:
 *   · the bundled inventory carries a curated, significance-ordered SUBSET of
 *     each resource's attributes — an op whose attribute is not in that subset
 *     has no current value to show (the control renders un-prefilled, current
 *     shown as "—");
 *   · a few ops carry a synthetic scalar attr (a toggle that the executor maps
 *     onto a nested block) that is not an inventory key — same un-prefilled
 *     outcome, never a fabricated value;
 *   · block/map ops (tags, rules) have no single scalar attr, so they render as
 *     actions, not inline scalar edits.
 */

/** A humanized AWS resource type: `aws_db_instance` → "DB instance". Reuses the
 * shared acronym-aware humanizer, so the result never carries a snake_case
 * token (copyLint-safe if rendered as a label). */
export function humanizeResourceType(resourceType: string): string {
  return humanizeAttr(stripProviderPrefix(resourceType));
}

/**
 * Param roles whose value is NOT the operator-chosen "new value": the target
 * selector reads from inventory; const/discriminator/key/selector/reference are
 * the executor's machinery (see types/manifest.ts). What remains is the single
 * value an operator edits.
 */
const NON_VALUE_ROLES = new Set(['const', 'discriminator', 'key', 'selector', 'reference']);

/** The operator-editable value params of an op — the request inputs that are
 * neither the inventory target nor executor machinery. A scalar Change op has
 * exactly one; block/tuple ops may have more (a tag key + value). */
export function editableValueParams(op: Pick<ManifestOperation, 'params'>): ManifestParam[] {
  return op.params.filter(
    (p) => p.source !== 'inventory' && !(p.role !== undefined && NON_VALUE_ROLES.has(p.role)),
  );
}

/**
 * The inventory attribute an op reads its CURRENT value from (and writes on
 * apply): the authoritative `target.attr` when present, else the lone value
 * param's own `attr`. Undefined when neither names one (block/map ops, provision
 * creates) — there is then no single scalar current value to show.
 */
export function attrForOp(op: Pick<ManifestOperation, 'target' | 'params'>): string | undefined {
  if (op.target.attr) return op.target.attr;
  const vps = editableValueParams(op);
  if (vps.length === 1 && vps[0]!.attr) return vps[0]!.attr;
  return undefined;
}

/**
 * The resource's CURRENT value for an op, read from the inventory snapshot via
 * {@link attrForOp}. Undefined when the op has no scalar attr, or the attr is
 * simply not in this resource's captured attributes (the curated-subset limit
 * above) — callers must render that as "unknown", never as a default.
 */
export function currentValueForOp(
  op: Pick<ManifestOperation, 'target' | 'params'>,
  resource: InventoryResource,
): string | number | boolean | undefined {
  const attr = attrForOp(op);
  if (attr === undefined) return undefined;
  return resource.attributes[attr];
}

/** codemod verbs that set a single scalar attribute in place — the ops that can
 * be edited inline on the detail page (a control pre-filled with the current
 * value). Block/tuple/map/module verbs are actions, not inline scalar edits. */
const SCALAR_SETTERS = new Set(['set_attribute', 'set_association_attribute']);

/**
 * Whether a capability is an INLINE scalar edit — a Change that sets one scalar
 * attribute and takes exactly one scalar value param. Deterministic from the
 * op's shape (no per-op table), the same discipline the Add-split predicates
 * use (lib/actionPicker.ts). Everything else (Add, Delete, Move, block/map ops)
 * renders as an action that opens the dedicated request form.
 */
export function isInlineEditable(
  op: Pick<ManifestOperation, 'macd' | 'codemodOp' | 'params'>,
): boolean {
  if (op.macd !== 'Change') return false;
  if (!SCALAR_SETTERS.has(op.codemodOp)) return false;
  const vps = editableValueParams(op);
  if (vps.length !== 1) return false;
  const t = vps[0]!.type;
  return t === 'string' || t === 'number' || t === 'bool';
}

export type ControlKind = 'select' | 'toggle' | 'number' | 'text';

/** How to render one editable value param as an inline control, derived from its
 * type + bounds. Presentational spec only — no React. */
export interface ControlSpec {
  kind: ControlKind;
  /** Choices for a select/toggle, as canonical strings. */
  options?: string[];
  min?: number;
  max?: number;
  pattern?: string;
}

/** The inline control for one value param: a bounded allowlist becomes a select
 * (a two-value boolean allowlist a toggle), a number its stepped input, anything
 * else a text input carrying its pattern. */
export function controlFor(param: ManifestParam): ControlSpec {
  const b = param.bounds;
  if (b?.allowlist && b.allowlist.length > 0) {
    const options = b.allowlist.map(String);
    if (param.type === 'bool') return { kind: 'toggle', options };
    return { kind: 'select', options };
  }
  if (param.type === 'bool') return { kind: 'toggle', options: ['true', 'false'] };
  if (param.type === 'number') return { kind: 'number', min: b?.min, max: b?.max };
  return { kind: 'text', pattern: b?.pattern };
}

/** One catalog capability of a resource, generated + current-value-filled. */
export interface Capability {
  op: ManifestOperation;
  group: OpGroup;
  /** The prominent headline: the AWS-console field name (op.consoleLabel), else
   * the op title — opText.ts. Never a Terraform identifier. */
  headline: string;
  /** The plain "what this does" line (op.summary), folded into the card's single
   * disclosure beneath the headline. Absent when no summary is authored. */
  summary?: string;
  /** The raw technical description, shown beneath the summary in that same
   * disclosure. Absent when empty or identical to the summary. */
  technicalDetail?: string;
  macd: Macd;
  exposure: Exposure;
  /** A destroy-and-recreate change — flagged "rebuilds" in the UI. */
  forcesReplace: boolean;
  /** The inventory attribute this op reads/writes, when it names a scalar one. */
  attr?: string;
  /** The resource's current value for `attr`, or undefined when not in the
   * snapshot / no scalar attr (rendered as "—", never a fabricated default). */
  currentValue?: string | number | boolean;
  /** Whether this capability is an inline scalar edit (control + cart). */
  editable: boolean;
  /** The single value param + its control spec, present iff `editable`. */
  valueParam?: ManifestParam;
  control?: ControlSpec;
}

/** Build one capability from an op + the resource whose page it is on. */
export function buildCapability(op: ManifestOperation, resource: InventoryResource): Capability {
  const { headline, summary, technicalDetail } = opTextLayers(op);
  const attr = attrForOp(op);
  const currentValue = attr === undefined ? undefined : resource.attributes[attr];
  const editable = isInlineEditable(op);
  const valueParam = editable ? editableValueParams(op)[0] : undefined;
  return {
    op,
    group: op.group,
    headline,
    summary,
    technicalDetail,
    macd: op.macd,
    exposure: op.exposure,
    forcesReplace: op.forcesReplace,
    attr,
    currentValue,
    editable,
    valueParam,
    control: valueParam ? controlFor(valueParam) : undefined,
  };
}

/** The canonical string form of a current value, for pre-filling a control and
 * for change detection (a bool reads 'true'/'false', matching a toggle's
 * option strings; '' when there is no captured current value). */
export function currentControlValue(cap: Capability): string {
  if (cap.currentValue === undefined) return '';
  if (typeof cap.currentValue === 'boolean') return cap.currentValue ? 'true' : 'false';
  return String(cap.currentValue);
}

/** The read-only display of a capability's current value ("c5.xlarge", "Yes",
 * "256 MB", an ARN tail), or "—" when the snapshot doesn't carry it. Uses the
 * one shared value formatter so it matches the card chips and context rows. */
export function displayCurrent(cap: Capability): string {
  if (cap.currentValue === undefined || cap.attr === undefined) return '—';
  return formatAttrValue(cap.attr, cap.currentValue).value;
}

/** The display of a chosen control value, formatted to match the current-value
 * readout: a toggle reads Yes/No, a number carries its attribute's unit, others
 * pass through. Keeps "before → after" in one vocabulary in the pending cart. */
export function displayChoice(cap: Capability, value: string): string {
  if (value === '') return '—';
  if (cap.control?.kind === 'toggle') {
    if (value === 'true') return 'Yes';
    if (value === 'false') return 'No';
    return value;
  }
  if (cap.control?.kind === 'number' && cap.attr !== undefined) {
    const n = Number(value);
    if (!Number.isNaN(n)) return formatAttrValue(cap.attr, n).value;
  }
  return value;
}

/** The operator label for the field a capability changes: the attribute's chip
 * label when it names one, else the value param's own label, else the op title.
 * Always plain words (chipLabelFor humanizes) — never a raw snake_case attr. */
export function fieldLabelFor(cap: Capability): string {
  if (cap.attr !== undefined) return chipLabelFor(cap.attr);
  if (cap.valueParam) return cap.valueParam.label;
  return cap.op.title;
}

/** A read-only inventory fact with no editable op behind it — a "context" row. */
export interface ContextRow {
  attr: string;
  label: string;
  value: string;
  full?: string;
}

/** The attributes already shown inline as a capability's current value — so the
 * context list can exclude them and not repeat a value the operator edits above. */
export function claimedAttrs(caps: Capability[]): Set<string> {
  const claimed = new Set<string>();
  for (const c of caps) {
    if (c.editable && c.attr !== undefined && c.currentValue !== undefined) claimed.add(c.attr);
  }
  return claimed;
}

/** The resource's inventory attributes that no inline capability owns, as
 * labelled + formatted read-only rows (the console "Details" facts). */
export function contextRows(resource: InventoryResource, claimed: Set<string>): ContextRow[] {
  return Object.entries(resource.attributes)
    .filter(([attr]) => !claimed.has(attr))
    .map(([attr, raw]) => ({ attr, label: chipLabelFor(attr), ...formatAttrValue(attr, raw) }));
}

/** One key fact in the summary strip (id/type/IPs/zone…). */
export interface SummaryFact {
  attr: string;
  label: string;
  value: string;
  full?: string;
}

/** The always-visible summary strip at the top of the page. */
export interface SummaryStrip {
  displayName: string;
  address: string;
  /** Humanized type ("Instance"). */
  resourceType: string;
  /** Raw Terraform type ("aws_instance"), the mono technical layer. */
  rawType: string;
  service?: string;
  facts: SummaryFact[];
}

/** How many significance-ordered facts the summary strip surfaces. */
export const SUMMARY_FACT_COUNT = 4;

/** Build the summary strip: display label + address + humanized type + the first
 * few significance-ordered facts (the inventory builder's ordering puts a
 * resource's most identifying attributes first — id/ip/zone for a host). */
export function buildSummary(resource: InventoryResource): SummaryStrip {
  const facts = Object.entries(resource.attributes)
    .slice(0, SUMMARY_FACT_COUNT)
    .map(([attr, raw]) => ({ attr, label: chipLabelFor(attr), ...formatAttrValue(attr, raw) }));
  return {
    displayName: displayResourceLabel(resource),
    address: resource.address,
    resourceType: humanizeResourceType(resource.resourceType),
    rawType: resource.resourceType,
    service: resource.service,
    facts,
  };
}

/** One tabbed section of the detail page. */
export interface DetailTab {
  /** 'details' for the context tab, else the OpGroup id. */
  id: string;
  label: string;
  kind: 'context' | 'capabilities';
  /** Populated for a capability tab. */
  capabilities: Capability[];
  /** Populated for the context ('details') tab. */
  contextRows: ContextRow[];
}

/** The whole generated page model: summary + tabs, with the counts the header
 * and cart read. */
export interface ResourceSections {
  summary: SummaryStrip;
  tabs: DetailTab[];
  capabilityCount: number;
  editableCount: number;
}

/**
 * GENERATE the page from the manifest: turn every op targeting the resource
 * (already gathered + admin-filtered by the caller) into a capability, then
 * group them into a leading read-only "Details" tab (the context facts) plus one
 * tab per present op group, in the catalog's fixed group order. Nothing is
 * hand-listed — a resource type with no ops in a group simply has no tab for it.
 */
export function buildResourceSections(
  resource: InventoryResource,
  ops: ManifestOperation[],
): ResourceSections {
  const caps = ops.map((op) => buildCapability(op, resource));
  const claimed = claimedAttrs(caps);
  const tabs: DetailTab[] = [
    {
      id: 'details',
      label: 'Details',
      kind: 'context',
      capabilities: [],
      contextRows: contextRows(resource, claimed),
    },
  ];
  for (const group of OP_GROUPS) {
    const inGroup = caps.filter((c) => c.group === group);
    if (inGroup.length > 0) {
      tabs.push({
        id: group,
        label: GROUP_LABELS[group],
        kind: 'capabilities',
        capabilities: inGroup,
        contextRows: [],
      });
    }
  }
  return {
    summary: buildSummary(resource),
    tabs,
    capabilityCount: caps.length,
    editableCount: caps.filter((c) => c.editable).length,
  };
}
