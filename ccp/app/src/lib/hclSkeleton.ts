import type { ManifestOperation, ManifestParam } from '@/types';
import { isParamActive } from '@/lib/dependsOn';
import { redactHcl, type RedactOptions } from '@/lib/redact';

/**
 * The DRAFT HCL skeleton renderer.
 *
 * A pure, deterministic function of (operation, submitted params): no model,
 * no I/O, no template language. For a `draftSkeleton` create op it
 * renders the resource block(s) an engineer starts from — banner-first, so
 * un-reviewed status is unmistakable — using the SAME param conventions the
 * executor verbs use:
 *
 *   - `role:"key"`     → names the block (sanitized); writes its own
 *                        attribute only when the param declares an explicit
 *                        `attr` (a bucket's `bucket`, never a fictitious
 *                        `host_name` attribute).
 *   - `role:"reference"` + `refAttr` → the picked inventory ADDRESS becomes a
 *                        Terraform expression (`aws_subnet.app_a.id`), one per
 *                        item for list params. A value that is not shaped like
 *                        a resource address renders as a quoted literal — no
 *                        request byte is ever emitted as an expression.
 *   - `role:"const"`   → written straight from the manifest, always — the
 *                        machine-checkable guardrails (IMDSv2, encryption)
 *                        appear in the reviewed artifact without ever being
 *                        an input.
 *   - `param.path`     → the attribute lands in a nested block chain, e.g.
 *                        ["metadata_options"] → `metadata_options { … }`.
 *   - `attr:"tags.Name"` (dotted) → an entry in a MAP attribute, so the
 *                        estate's Name/Description/PIC tag section renders as
 *                        one `tags = { … }` literal.
 *   - omitted optional → omitted; params hidden by `dependsOn` → omitted
 *                        (same lib/dependsOn predicate the form and both
 *                        validators use).
 *   - the `engineer-decides` sentinel → a `# TODO:` line inside the block
 *                        instead of a bogus assignment.
 *
 * Multi-block shapes: a small deterministic idiom table keyed by the target
 * resource type encodes the estate idioms the master plan fixes as
 * normative — an EBS volume created against a host also emits its
 * `aws_volume_attachment`; an S3 bucket emits the estate's 20/20/20 idiom
 * (public-access block + encryption config + versioning-when-chosen + the
 * optional first expiry rule); an EFS share pairs with its backup-policy
 * resource when automatic backup is chosen; a security group renders its
 * optional single starter ingress rule only when a protocol was picked;
 * stateful creates carry `lifecycle { prevent_destroy = true }`. The golden
 * tests (src/test/hclSkeleton.test.ts + baselineSkeletons.test.ts) pin every
 * shape byte-for-byte.
 *
 * The output is display/review material and the engineer's starting file —
 * NEVER pipeline input: it is pinned into the request like the generated
 * diff, and the engineer copies it into the env tree, resolves the TODOs and
 * opens a normal PR (review is the gate). Everything passes
 * through redactHcl before leaving this module, with the op's
 * manifest-flagged sensitive attrs masked — same guard the diff renderer
 * applies.
 */

/* ── HCL document model ──────────────────────────────────────────────────── */

type HclValue =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'expr'; expr: string }
  | { kind: 'tuple'; items: HclValue[] }
  | { kind: 'map'; entries: [string, HclValue][] };

type BodyNode =
  | { kind: 'attr'; name: string; value: HclValue }
  | { kind: 'block'; name: string; body: BodyNode[] }
  | { kind: 'todo'; text: string };

interface HclBlock {
  type: string;
  name: string;
  body: BodyNode[];
}

/** The allowlist-sentinel meaning "an engineer fills this in after approval". */
export const ENGINEER_DECIDES = 'engineer-decides';

/* ── Sanitizers (no request byte ever becomes syntax) ────────────────────── */

/** A Terraform-safe local name from a request-supplied identity value. */
export function tfLocalName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  if (cleaned === '') return 'new_resource';
  return /^[0-9]/.test(cleaned) ? `r_${cleaned}` : cleaned;
}

/** Resource-address shape (`aws_subnet.app_a` / `azurerm_resource_group.main`)
 * — the ONLY value form that may render as a reference expression. Mirrors
 * the Go twin (tools/catalogctl/internal/idioms/idioms.go AddressShapeRe),
 * widened identically for the azure seam (0039 S1) — behavior-inert for aws. */
const ADDRESS_SHAPE = /^(?:aws|azurerm)_[a-z0-9_]+\.[A-Za-z_][A-Za-z0-9_-]*$/;
/** refAttr / attribute-identifier shape (manifest-authored, still checked). */
const IDENT_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A map key renders bare when identifier-shaped, quoted otherwise. */
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Comment-safe id: anything else is dropped from the banner line. */
const REQUEST_ID_SAFE = /[^A-Za-z0-9._-]/g;

function literal(value: unknown): HclValue {
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return { kind: 'literal', value };
  }
  return { kind: 'literal', value: String(value) };
}

/** Coerce a submitted scalar to its HCL form: numbers for number params,
 * booleans as-is, everything else a string literal. */
function scalarValue(param: ManifestParam, value: unknown): HclValue {
  if (param.type === 'number') {
    const n = Number(value);
    if (Number.isFinite(n)) return { kind: 'literal', value: n };
  }
  if (param.type === 'bool') {
    if (typeof value === 'boolean') return { kind: 'literal', value };
    if (value === 'true' || value === 'false') return { kind: 'literal', value: value === 'true' };
  }
  // Map values (a tag map / parameter map) render as an HCL block, not the
  // stringified object — String({}) is "[object Object]". renderValue already
  // has a 'map' case; without this a map param drafts as tags = "[object Object]".
  if (
    param.type === 'map' &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return {
      kind: 'map',
      entries: Object.entries(value as Record<string, unknown>).map(
        ([k, v]) => [k, scalarValue({ ...param, type: 'string' }, v)] as [string, HclValue],
      ),
    };
  }
  return literal(value);
}

/** A reference expression off a picked address — or a quoted literal when the
 * value is not address-shaped (fail-closed: never an expression). */
function referenceValue(value: unknown, refAttr: string | undefined): HclValue {
  const address = String(value ?? '');
  if (ADDRESS_SHAPE.test(address) && refAttr !== undefined && IDENT_SHAPE.test(refAttr)) {
    return { kind: 'expr', expr: `${address}.${refAttr}` };
  }
  return literal(address);
}

/* ── Rendering ───────────────────────────────────────────────────────────── */

function renderValue(v: HclValue): string {
  switch (v.kind) {
    case 'literal': {
      if (typeof v.value === 'string') {
        // JSON escaping is HCL-compatible for quotes/backslashes/control
        // chars; `${` additionally becomes `$${` so a pasted value can never
        // open an interpolation. (Replacement is a function — in a string
        // replacement `$$` collapses to one `$` and would undo the escape.)
        return JSON.stringify(v.value).replace(/\$\{/g, () => '$${');
      }
      return String(v.value);
    }
    case 'expr':
      return v.expr;
    case 'tuple':
      return `[${v.items.map(renderValue).join(', ')}]`;
    case 'map': {
      if (v.entries.length === 0) return '{}';
      const inner = v.entries
        .map(([k, val]) => `    ${BARE_KEY.test(k) ? k : JSON.stringify(k)} = ${renderValue(val)}`)
        .join('\n');
      return `{\n${inner}\n  }`;
    }
  }
}

function renderBody(nodes: BodyNode[], depth: number): string[] {
  const pad = '  '.repeat(depth);
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'attr') {
      lines.push(`${pad}${node.name} = ${renderValue(node.value)}`);
    } else if (node.kind === 'todo') {
      lines.push(`${pad}# TODO: ${node.text}`);
    } else {
      lines.push(`${pad}${node.name} {`);
      lines.push(...renderBody(node.body, depth + 1));
      lines.push(`${pad}}`);
    }
  }
  return lines;
}

function renderBlock(block: HclBlock): string {
  return [`resource "${block.type}" "${block.name}" {`, ...renderBody(block.body, 1), '}'].join(
    '\n',
  );
}

/* ── The mechanical param→body build ─────────────────────────────────────── */

interface BuiltParam {
  param: ManifestParam;
  attr: string | null;
  /** Dotted-attr map placement: `tags.Name` → { mapAttr: 'tags', key: 'Name' }. */
  mapAttr: string | null;
  mapKey: string | null;
  value: HclValue | null;
  todo: string | null;
  /** A REPEATED nested block (param.repeated): the pre-rendered body of each
   * non-empty instance, in submission order. Non-null ⇒ this built param
   * contributes N `<blockName> { … }` sibling blocks instead of a scalar attr.
   * `value`/`attr` are null for a repeated param. */
  blocks: BodyNode[][] | null;
  /** The HCL block name the repeated instances render under (repeated only). */
  blockName: string | null;
}

function effectiveValue(param: ManifestParam, values: Record<string, unknown>): unknown {
  if (param.role === 'const') return param.const;
  const v = values[param.name];
  return v === undefined ? param.default : v;
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function buildParam(param: ManifestParam, values: Record<string, unknown>): BuiltParam | null {
  // Block-choice mechanics, never create values.
  if (param.role === 'selector' || param.role === 'discriminator') return null;
  if (!isParamActive(param, values)) return null;

  // A REPEATED nested block: the value is an array of instance records, each of
  // which folds through the SAME body builder the top-level block uses — so an
  // instance may carry references, lists, dotted tag maps, nested single blocks
  // and engineer-decides TODOs. Handled before the scalar/attr machinery: a
  // repeated param owns no scalar attribute of its own.
  if (param.repeated) return buildRepeatedParam(param, values);

  const attrName = param.attr ?? param.name;
  const isKey = param.role === 'key';
  // A key param names the block; it writes a value only via an explicit attr.
  if (isKey && param.attr === undefined) return null;

  const raw = effectiveValue(param, values);
  if (isEmptyValue(raw)) return null;

  const base: BuiltParam = {
    param,
    attr: attrName,
    mapAttr: null,
    mapKey: null,
    value: null,
    todo: null,
    blocks: null,
    blockName: null,
  };

  const dot = attrName.indexOf('.');
  if (dot > 0) {
    base.mapAttr = attrName.slice(0, dot);
    base.mapKey = attrName.slice(dot + 1);
    base.attr = null;
  }

  if (raw === ENGINEER_DECIDES) {
    base.todo = `${base.attr ?? base.mapKey ?? param.name} — engineer decides`;
    return base;
  }

  if (param.role === 'reference') {
    if (Array.isArray(raw)) {
      base.value = { kind: 'tuple', items: raw.map((item) => referenceValue(item, param.refAttr)) };
    } else {
      const ref = referenceValue(raw, param.refAttr);
      base.value = param.wrap === 'list' ? { kind: 'tuple', items: [ref] } : ref;
    }
    return base;
  }

  if (Array.isArray(raw)) {
    base.value = {
      kind: 'tuple',
      items: raw.map((item) => scalarValue({ ...param, type: 'string' }, item)),
    };
    return base;
  }

  const scalar = scalarValue(param, raw);
  base.value = param.wrap === 'list' ? { kind: 'tuple', items: [scalar] } : scalar;
  return base;
}

/**
 * Build a REPEATED nested-block param (param.repeated) into its N instance
 * bodies. Each submitted record is folded through the same `bodyFrom` the
 * top-level block uses — every param convention (attr/path/role/const/dotted
 * map/wrap/dependsOn/engineer-decides) applies RELATIVE to that instance, so an
 * instance is a full mini-block. An instance whose record is absent, not an
 * object, or builds to an empty body is dropped (the same "empty ⇒ omitted"
 * rule scalar params follow), so a blank row the requester added never emits a
 * hollow `block {}`. Zero surviving instances ⇒ null (no block at all). The
 * block name is `repeated.block ?? attr ?? name`. */
function buildRepeatedParam(
  param: ManifestParam,
  values: Record<string, unknown>,
): BuiltParam | null {
  const raw = effectiveValue(param, values);
  const list = Array.isArray(raw) ? raw : [];
  const bodies: BodyNode[][] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const built: BuiltParam[] = [];
    for (const sub of param.repeated!.fields) {
      const b = buildParam(sub, record);
      if (b) built.push(b);
    }
    const body = bodyFrom(built);
    if (body.length > 0) bodies.push(body);
  }
  if (bodies.length === 0) return null;
  return {
    param,
    attr: null,
    mapAttr: null,
    mapKey: null,
    value: null,
    todo: null,
    blocks: bodies,
    blockName: param.repeated!.block ?? param.attr ?? param.name,
  };
}

/** A child of a nested level, in first-contribution order: either a SINGLE
 * block (merged by name — several params at the same path build one shared
 * subtree) or a REPEATED block's N pre-built instance bodies (never merged —
 * each is its own sibling `<name> { … }`). */
type ChildSlot =
  | { kind: 'single'; seg: string }
  | { kind: 'repeated'; name: string; bodies: BodyNode[][] };

/** One level of the nested-path tree: attributes contributed at this depth,
 * then child blocks (single or repeated) in first-contribution order. */
interface NestedLevel {
  attrs: BodyNode[];
  children: Map<string, NestedLevel>;
  order: ChildSlot[];
}

/** Fold built params into a block body: TODO lines first (unresolved
 * decisions must be impossible to miss), then plain attrs in param order,
 * then map attrs (tags) in first-contribution order, then nested-path
 * blocks — a fixed, documented order so goldens are byte-stable.
 *
 * Nested paths merge as a TREE: params at ["rule"] and ["rule","lifecycle"]
 * land in ONE `rule { … lifecycle { … } }` (the backup-plan shape), never two
 * sibling `rule` blocks. At every level, attributes render before child
 * blocks; both keep first-contribution order. */
function bodyFrom(built: BuiltParam[]): BodyNode[] {
  const attrs: BodyNode[] = [];
  const maps = new Map<string, [string, HclValue][]>();
  const todos: BodyNode[] = [];
  const root: NestedLevel = { attrs: [], children: new Map(), order: [] };

  const descend = (path: string[]): NestedLevel => {
    let node = root;
    for (const seg of path) {
      let child = node.children.get(seg);
      if (!child) {
        child = { attrs: [], children: new Map(), order: [] };
        node.children.set(seg, child);
        node.order.push({ kind: 'single', seg });
      }
      node = child;
    }
    return node;
  };

  for (const b of built) {
    if (b.todo !== null) {
      todos.push({ kind: 'todo', text: b.todo });
      continue;
    }
    // A repeated-block param contributes its N instances as sibling blocks at
    // its path level (top level when no path), in first-contribution order
    // alongside any single-block children — never merged into one.
    if (b.blocks !== null) {
      const path = b.param.path ?? [];
      const level = path.length > 0 ? descend(path) : root;
      level.order.push({ kind: 'repeated', name: b.blockName!, bodies: b.blocks });
      continue;
    }
    if (b.value === null) continue;
    if (b.mapAttr !== null && b.mapKey !== null) {
      const entries = maps.get(b.mapAttr) ?? [];
      entries.push([b.mapKey, b.value]);
      maps.set(b.mapAttr, entries);
      continue;
    }
    const path = b.param.path ?? [];
    if (path.length > 0) {
      descend(path).attrs.push({ kind: 'attr', name: b.attr!, value: b.value });
      continue;
    }
    attrs.push({ kind: 'attr', name: b.attr!, value: b.value });
  }

  const renderLevel = (level: NestedLevel): BodyNode[] => [
    ...level.attrs,
    ...level.order.flatMap((slot): BodyNode[] =>
      slot.kind === 'single'
        ? [{ kind: 'block', name: slot.seg, body: renderLevel(level.children.get(slot.seg)!) }]
        : slot.bodies.map((body): BodyNode => ({ kind: 'block', name: slot.name, body })),
    ),
  ];

  const out: BodyNode[] = [...todos, ...attrs];
  for (const [mapAttr, entries] of maps) {
    out.push({ kind: 'attr', name: mapAttr, value: { kind: 'map', entries } });
  }
  out.push(...renderLevel(root));
  return out;
}

/* ── Estate idioms (normative multi-block shapes) ──────────── */

const PREVENT_DESTROY: BodyNode = {
  kind: 'block',
  name: 'lifecycle',
  body: [{ kind: 'attr', name: 'prevent_destroy', value: { kind: 'literal', value: true } }],
};

/** Stateful creates that carry `lifecycle { prevent_destroy = true }` from
 * birth — the committed estate's own idiom for these types. The azurerm_
 * entries are the Azure twins of aws_instance / aws_ebs_volume (0039 S1 lane
 * prov-compute): applied BY ANALOGY, since no Azure estate exists yet to
 * measure a committed .tf shape from the way the AWS entries were. */
const PREVENT_DESTROY_TYPES = new Set([
  'aws_instance',
  'aws_ebs_volume',
  'aws_db_instance',
  'azurerm_linux_virtual_machine',
  'azurerm_windows_virtual_machine',
  'azurerm_managed_disk',
  'azurerm_resource_group',
]);

/** The S3 public-access-block attribute set the estate pins 4×true. */
const PAB_ATTRS = new Set([
  'block_public_acls',
  'block_public_policy',
  'ignore_public_acls',
  'restrict_public_buckets',
]);

interface IdiomInput {
  op: ManifestOperation;
  values: Record<string, unknown>;
  localName: string;
  built: BuiltParam[];
}

/**
 * Compose the block list for one target resource type. The default idiom is
 * the single mechanical block; the named idioms add the companion blocks the
 * master plan fixes as this estate's create shapes. Deterministic
 * lookups only — an unknown type renders mechanically.
 */
function composeBlocks(input: IdiomInput): HclBlock[] {
  switch (input.op.target.resourceType) {
    case 'aws_ebs_volume':
      return ebsVolumeIdiom(input);
    case 'aws_s3_bucket':
      return s3BucketIdiom(input);
    case 'aws_efs_file_system':
      return efsFileSystemIdiom(input);
    case 'aws_security_group':
      return securityGroupIdiom(input);
    case 'azurerm_linux_virtual_machine':
      return azureVirtualMachineIdiom(input, 'azurerm_linux_virtual_machine');
    case 'azurerm_windows_virtual_machine':
      return azureVirtualMachineIdiom(input, 'azurerm_windows_virtual_machine');
    case 'azurerm_managed_disk':
      return azureManagedDiskIdiom(input);
    case 'azurerm_cosmosdb_account':
      return azureCosmosDbIdiom(input);
    case 'azurerm_linux_web_app':
    case 'azurerm_linux_function_app':
      // A web / function app's region MUST equal its App Service plan's — so it
      // is derived from the picked service_plan, not the resource group.
      return azureRgScopedIdiom(input, input.op.target.resourceType, 'service_plan');
    case 'aws_lambda_function': {
      // `inside_vpc` is a FORM-ONLY controller (it gates the vpc_config
      // pickers via dependsOn); it is not a provider attribute and never
      // renders. The gated params land in vpc_config {} when active.
      const body = bodyFrom(input.built.filter((b) => b.param.name !== 'inside_vpc'));
      return [{ type: input.op.target.resourceType, name: input.localName, body }];
    }
    default: {
      if (RG_SCOPED_LOCATION_TYPES.has(input.op.target.resourceType)) {
        return azureRgScopedIdiom(input, input.op.target.resourceType);
      }
      const body = bodyFrom(input.built);
      if (PREVENT_DESTROY_TYPES.has(input.op.target.resourceType)) body.push(PREVENT_DESTROY);
      return [{ type: input.op.target.resourceType, name: input.localName, body }];
    }
  }
}

/** EBS create-against-a-host: the volume block plus its `aws_volume_attachment`
 * — the exact two-block shape the committed ebs.tf uses for all 352 volumes.
 * The `attach_to` reference feeds the volume's availability zone (the AZ is
 * asked once, via the host) and the attachment's instance id; `device_name`
 * belongs to the attachment, not the volume. */
function ebsVolumeIdiom({ op, values, localName, built }: IdiomInput): HclBlock[] {
  const attachTo = op.params.find((p) => p.name === 'attach_to');
  const attachAddress = attachTo ? String(values[attachTo.name] ?? '') : '';
  const attached = attachTo !== undefined && ADDRESS_SHAPE.test(attachAddress);

  const volumeBuilt = built.filter(
    (b) =>
      b.param.name !== 'attach_to' &&
      b.param.name !== 'device_name' &&
      b.param.name !== 'availability_zone',
  );
  const volumeBody = bodyFrom(volumeBuilt);
  if (attached) {
    volumeBody.unshift({
      kind: 'attr',
      name: 'availability_zone',
      value: { kind: 'expr', expr: `${attachAddress}.availability_zone` },
    });
  }
  volumeBody.push(PREVENT_DESTROY);
  const blocks: HclBlock[] = [{ type: 'aws_ebs_volume', name: localName, body: volumeBody }];

  if (attached) {
    const device = built.find((b) => b.param.name === 'device_name');
    const attachmentBody: BodyNode[] = [];
    if (device && device.value !== null) {
      attachmentBody.push({ kind: 'attr', name: 'device_name', value: device.value });
    }
    attachmentBody.push(
      {
        kind: 'attr',
        name: 'volume_id',
        value: { kind: 'expr', expr: `aws_ebs_volume.${localName}.id` },
      },
      { kind: 'attr', name: 'instance_id', value: { kind: 'expr', expr: `${attachAddress}.id` } },
    );
    blocks.push({ type: 'aws_volume_attachment', name: localName, body: attachmentBody });
  }
  return blocks;
}

/** The estate's bucket idiom (20/20/20 in inventory): bucket + public-access
 * block (const 4×true) + server-side encryption config + versioning when
 * chosen + a one-rule expiry lifecycle when a cleanup age is given — one
 * elaboration, up to five reviewable blocks. */
function s3BucketIdiom({ localName, built }: IdiomInput): HclBlock[] {
  const bucketRef: HclValue = { kind: 'expr', expr: `aws_s3_bucket.${localName}.id` };

  const pabBuilt = built.filter((b) => b.attr !== null && PAB_ATTRS.has(b.attr));
  const sseBuilt = built.filter((b) => b.param.name === 'encryption' || b.param.name === 'kms_key');
  const versioningParam = built.find((b) => b.param.name === 'versioning');
  const cleanupParam = built.find((b) => b.param.name === 'lifecycle_cleanup_days');
  const consumed = new Set<BuiltParam>(
    [...pabBuilt, ...sseBuilt, versioningParam, cleanupParam].filter(
      (b): b is BuiltParam => b !== undefined,
    ),
  );
  const bucketBuilt = built.filter((b) => !consumed.has(b));

  // The estate carries `lifecycle { prevent_destroy = true }` on EVERY bucket
  // (freeze-confirm — measured 20/20 in environments/prod/s3.tf), so the
  // create idiom emits it too, like the EBS-volume idiom. It is a const guard on
  // the bucket block; it adds no new inter-block reference (the injection-surface
  // inventory is unchanged).
  const bucketBody = bodyFrom(bucketBuilt);
  bucketBody.push(PREVENT_DESTROY);
  const blocks: HclBlock[] = [{ type: 'aws_s3_bucket', name: localName, body: bucketBody }];

  if (pabBuilt.length > 0) {
    blocks.push({
      type: 'aws_s3_bucket_public_access_block',
      name: localName,
      body: [{ kind: 'attr', name: 'bucket', value: bucketRef }, ...bodyFrom(pabBuilt)],
    });
  }

  const algorithm = sseBuilt.find((b) => b.param.name === 'encryption');
  if (algorithm && algorithm.value !== null) {
    const defaults: BodyNode[] = [{ kind: 'attr', name: 'sse_algorithm', value: algorithm.value }];
    const kms = sseBuilt.find((b) => b.param.name === 'kms_key');
    if (kms && kms.value !== null) {
      defaults.push({ kind: 'attr', name: 'kms_master_key_id', value: kms.value });
    }
    blocks.push({
      type: 'aws_s3_bucket_server_side_encryption_configuration',
      name: localName,
      body: [
        { kind: 'attr', name: 'bucket', value: bucketRef },
        {
          kind: 'block',
          name: 'rule',
          body: [
            { kind: 'block', name: 'apply_server_side_encryption_by_default', body: defaults },
          ],
        },
      ],
    });
  }

  const versioningOn =
    versioningParam !== undefined &&
    versioningParam.value !== null &&
    versioningParam.value.kind === 'literal' &&
    versioningParam.value.value === true;
  if (versioningOn) {
    blocks.push({
      type: 'aws_s3_bucket_versioning',
      name: localName,
      body: [
        { kind: 'attr', name: 'bucket', value: bucketRef },
        {
          kind: 'block',
          name: 'versioning_configuration',
          body: [{ kind: 'attr', name: 'status', value: { kind: 'literal', value: 'Enabled' } }],
        },
      ],
    });
  }

  // "Delete objects after (days)" → the bucket's first expiry rule, the same
  // one-rule shape the lifecycle-setup baseline emits. Blank ⇒ no block.
  if (cleanupParam && cleanupParam.value !== null) {
    blocks.push({
      type: 'aws_s3_bucket_lifecycle_configuration',
      name: localName,
      body: [
        { kind: 'attr', name: 'bucket', value: bucketRef },
        {
          kind: 'block',
          name: 'rule',
          body: [
            { kind: 'attr', name: 'id', value: { kind: 'literal', value: 'expire-objects' } },
            { kind: 'attr', name: 'status', value: { kind: 'literal', value: 'Enabled' } },
            {
              kind: 'block',
              name: 'expiration',
              body: [{ kind: 'attr', name: 'days', value: cleanupParam.value }],
            },
          ],
        },
      ],
    });
  }
  return blocks;
}

/** EFS file-system idiom (SINGLE-BLOCK, reconciled): ONE
 * `aws_efs_file_system` block (lifecycle-policy transition only when a real age
 * is chosen — the "never" sentinel is a form answer, not an HCL value).
 * `enable_backups` is NOT an `aws_efs_file_system` provider attribute and is
 * NEVER a co-emitted `aws_efs_backup_policy` block: the estate carries 0 backup
 * policies (environments/prod/efs.tf: 4 filesystems / 0 policies), and enabling
 * backups on a portal-created share is a follow-up engineer task via the
 * efs-*-backup-policy ops. It therefore drives a review TODO in BOTH the on and
 * off cases so the reviewer always sees the backup posture and its follow-up. */
function efsFileSystemIdiom({ localName, built }: IdiomInput): HclBlock[] {
  const backups = built.find((b) => b.param.name === 'enable_backups');
  const isLiteral = (b: BuiltParam | undefined, v: unknown): boolean =>
    b !== undefined && b.value !== null && b.value.kind === 'literal' && b.value.value === v;

  const fsBuilt = built.filter(
    (b) =>
      b.param.name !== 'enable_backups' &&
      !(b.param.name === 'lifecycle_to_ia' && isLiteral(b, 'never')),
  );
  const body = bodyFrom(fsBuilt);
  if (isLiteral(backups, false)) {
    body.unshift({
      kind: 'todo',
      text: 'automatic backups are off for this share — the justification must say why',
    });
  } else if (isLiteral(backups, true)) {
    body.unshift({
      kind: 'todo',
      text: 'automatic backups are on for this share — author the aws_efs_backup_policy separately after it exists',
    });
  }
  return [{ type: 'aws_efs_file_system', name: localName, body }];
}

/** Security-group idiom: the group block, with the optional single starter
 * ingress rule only when a protocol was actually chosen — "none" (or an
 * empty answer) means no rule, so no partial `ingress` block ever renders. */
function securityGroupIdiom({ built, localName, op, values }: IdiomInput): HclBlock[] {
  const protocolParam = op.params.find((p) => p.name === 'first_rule_protocol');
  const protocol = protocolParam
    ? String(values[protocolParam.name] ?? protocolParam.default ?? '')
    : '';
  const withRule = protocol !== '' && protocol !== 'none';
  const groupBuilt = withRule ? built : built.filter((b) => (b.param.path ?? [])[0] !== 'ingress');
  return [{ type: 'aws_security_group', name: localName, body: bodyFrom(groupBuilt) }];
}

/* ── Azure idioms (0039 S1 lane prov-compute) ─────────────────────────────── */

/**
 * Every azurerm resource-group-scoped resource requires its OWN `location`
 * argument — there is no provider-level region the way AWS's `region` works.
 * Rather than ask the operator to re-type a region that must already match
 * the picked resource group (a mismatch Azure would reject at apply), this
 * derives BOTH `resource_group_name` and `location` from the SAME picked
 * `resource_group` reference param — the Azure twin of ebsVolumeIdiom's
 * `availability_zone` derivation from `attach_to`. Returns null when the
 * param is absent or not yet an address-shaped pick (fail-closed: never a
 * bogus expression in the draft).
 */
function deriveResourceGroupRefs(
  op: ManifestOperation,
  values: Record<string, unknown>,
): { nameExpr: HclValue; locationExpr: HclValue } | null {
  const rgParam = op.params.find((p) => p.name === 'resource_group');
  const rgAddress = rgParam ? String(values[rgParam.name] ?? '') : '';
  if (!ADDRESS_SHAPE.test(rgAddress)) return null;
  return {
    nameExpr: { kind: 'expr', expr: `${rgAddress}.name` },
    locationExpr: { kind: 'expr', expr: `${rgAddress}.location` },
  };
}

/**
 * The `location` expression for an azurerm resource-group-scoped create,
 * derived from an already-picked reference param's address (its `.location`
 * attribute) — never a re-typed region, never a hardcoded default. The plain
 * RG-scoped creates read it off `resource_group`; a web / function app reads it
 * off its picked `service_plan` (Azure requires the app's region to EQUAL the
 * plan's), so the source param name is caller-supplied. Returns null when that
 * param is absent or not yet an address-shaped pick (fail-closed: never a bogus
 * expression in the draft) — the same guard deriveResourceGroupRefs uses.
 */
function deriveLocationExpr(
  op: ManifestOperation,
  values: Record<string, unknown>,
  fromParam: string,
): HclValue | null {
  const p = op.params.find((x) => x.name === fromParam);
  const address = p ? String(values[p.name] ?? '') : '';
  if (!ADDRESS_SHAPE.test(address)) return null;
  return { kind: 'expr', expr: `${address}.location` };
}

/** Insert nodes right after any leading TODO lines and before the first real
 * attribute/block — preserves the module's "TODOs first" convention
 * (bodyFrom's own todos-first ordering) for attributes an idiom derives and
 * injects OUTSIDE the normal built-param fold. */
function insertAfterTodos(body: BodyNode[], toInsert: BodyNode[]): BodyNode[] {
  let i = 0;
  while (i < body.length && body[i]!.kind === 'todo') i++;
  return [...body.slice(0, i), ...toInsert, ...body.slice(i)];
}

/**
 * Linux/Windows virtual-machine idiom: unlike aws_instance, an azurerm_*_
 * virtual_machine has NO inline network configuration — `network_interface_
 * ids` is a required list of PRE-EXISTING azurerm_network_interface resource
 * ids. The create form's subnet + network-security-group picks (params
 * "subnet" / "nsg") synthesize that companion NIC — and, when an NSG was
 * picked, its azurerm_network_interface_security_group_association — exactly
 * as ebsVolumeIdiom synthesizes aws_volume_attachment alongside the volume.
 * `location` / `resource_group_name` on BOTH the NIC and the VM are derived
 * once from the same picked resource group (deriveResourceGroupRefs above),
 * never asked twice. "subnet" / "nsg" are excluded from the VM's own body —
 * they have no direct attribute on the VM itself, only on the companion
 * blocks this idiom builds by hand.
 */
function azureVirtualMachineIdiom(
  { op, values, localName, built }: IdiomInput,
  vmType: 'azurerm_linux_virtual_machine' | 'azurerm_windows_virtual_machine',
): HclBlock[] {
  const rg = deriveResourceGroupRefs(op, values);
  const subnetParam = op.params.find((p) => p.name === 'subnet');
  const nsgParam = op.params.find((p) => p.name === 'nsg');
  const subnetAddress = subnetParam ? String(values[subnetParam.name] ?? '') : '';
  const nsgAddress = nsgParam ? String(values[nsgParam.name] ?? '') : '';
  const hasSubnet = ADDRESS_SHAPE.test(subnetAddress);
  const hasNsg = ADDRESS_SHAPE.test(nsgAddress);
  const nicRef: HclValue = { kind: 'expr', expr: `azurerm_network_interface.${localName}.id` };

  const nicBody: BodyNode[] = [
    { kind: 'attr', name: 'name', value: { kind: 'literal', value: `${localName}-nic` } },
  ];
  if (rg) {
    nicBody.push(
      { kind: 'attr', name: 'location', value: rg.locationExpr },
      { kind: 'attr', name: 'resource_group_name', value: rg.nameExpr },
    );
  }
  const ipConfigBody: BodyNode[] = [
    { kind: 'attr', name: 'name', value: { kind: 'literal', value: 'internal' } },
  ];
  if (hasSubnet) {
    ipConfigBody.push({
      kind: 'attr',
      name: 'subnet_id',
      value: { kind: 'expr', expr: `${subnetAddress}.id` },
    });
  }
  ipConfigBody.push({
    kind: 'attr',
    name: 'private_ip_address_allocation',
    value: { kind: 'literal', value: 'Dynamic' },
  });
  nicBody.push({ kind: 'block', name: 'ip_configuration', body: ipConfigBody });

  const blocks: HclBlock[] = [
    { type: 'azurerm_network_interface', name: localName, body: nicBody },
  ];

  if (hasNsg) {
    blocks.push({
      type: 'azurerm_network_interface_security_group_association',
      name: localName,
      body: [
        { kind: 'attr', name: 'network_interface_id', value: nicRef },
        {
          kind: 'attr',
          name: 'network_security_group_id',
          value: { kind: 'expr', expr: `${nsgAddress}.id` },
        },
      ],
    });
  }

  const vmBuilt = built.filter((b) => b.param.name !== 'subnet' && b.param.name !== 'nsg');
  const vmDerived: BodyNode[] = [];
  if (rg) vmDerived.push({ kind: 'attr', name: 'location', value: rg.locationExpr });
  vmDerived.push({
    kind: 'attr',
    name: 'network_interface_ids',
    value: { kind: 'tuple', items: [nicRef] },
  });
  const vmBody = insertAfterTodos(bodyFrom(vmBuilt), vmDerived);
  if (PREVENT_DESTROY_TYPES.has(vmType)) vmBody.push(PREVENT_DESTROY);
  blocks.push({ type: vmType, name: localName, body: vmBody });

  return blocks;
}

/** Managed-disk idiom: a single block, `location` derived from the picked
 * resource group like the VM idiom above (no NIC/attachment concept — this
 * estate's managed-disk create is a standalone data disk, mirroring
 * ebs-create-volume's own size/type/encryption scope, not its VM-attachment
 * scope). */
function azureManagedDiskIdiom({ op, values, localName, built }: IdiomInput): HclBlock[] {
  const rg = deriveResourceGroupRefs(op, values);
  const derived: BodyNode[] = rg
    ? [{ kind: 'attr', name: 'location', value: rg.locationExpr }]
    : [];
  const body = insertAfterTodos(bodyFrom(built), derived);
  if (PREVENT_DESTROY_TYPES.has('azurerm_managed_disk')) body.push(PREVENT_DESTROY);
  return [{ type: 'azurerm_managed_disk', name: localName, body }];
}

/**
 * azurerm resource-group-scoped SINGLE-block creates whose required `location`
 * is DERIVED from the picked resource group (deriveLocationExpr off
 * `resource_group`) — the same fix the VM / managed-disk idioms above already
 * apply, extended (0039 S1 review-fix I4a) to every plain RG-scoped create so
 * no draft carries a hardcoded region or asks the operator to re-type one that
 * must match the resource group. Cosmos (its geo_location needs the same
 * derived region) and the web/function apps (region derived from the picked
 * service_plan, not the RG) have their own routing in composeBlocks; the VMs
 * keep their multi-block idioms above.
 */
const RG_SCOPED_LOCATION_TYPES = new Set([
  'azurerm_virtual_network',
  'azurerm_public_ip',
  'azurerm_lb',
  'azurerm_storage_account',
  'azurerm_key_vault',
  'azurerm_mssql_server',
  'azurerm_postgresql_flexible_server',
  'azurerm_mysql_flexible_server',
  'azurerm_redis_cache',
  'azurerm_log_analytics_workspace',
  'azurerm_service_plan',
  'azurerm_kubernetes_cluster',
  'azurerm_container_registry',
  'azurerm_container_group',
]);

/**
 * Generic RG-scoped single-block idiom: render the one resource block, deriving
 * its `location` from the named reference param (default `resource_group`).
 * `location` is injected right after any leading TODO lines and before the
 * first real attribute — matching the VM / managed-disk idioms' placement so
 * the derived region is impossible to miss. When the source pick is absent /
 * not address-shaped it renders mechanically with no location (fail-closed,
 * exactly the VM idiom's behavior), the same not-yet-picked state in which
 * resource_group_name is also still unresolved.
 */
function azureRgScopedIdiom(
  { op, values, localName, built }: IdiomInput,
  resourceType: string,
  fromParam = 'resource_group',
): HclBlock[] {
  const loc = deriveLocationExpr(op, values, fromParam);
  const derived: BodyNode[] = loc ? [{ kind: 'attr', name: 'location', value: loc }] : [];
  const body = insertAfterTodos(bodyFrom(built), derived);
  if (PREVENT_DESTROY_TYPES.has(resourceType)) body.push(PREVENT_DESTROY);
  return [{ type: resourceType, name: localName, body }];
}

/**
 * Cosmos DB account idiom: like the generic RG-scoped idiom (top-level
 * `location` derived from the picked resource group) but it ALSO synthesizes
 * the required `geo_location { location; failover_priority }` block off the
 * SAME derived region — a single-region account's write region is its own
 * region, so it is derived, never a second hardcoded / re-typed region. The
 * `consistency_policy` block and every other attribute render mechanically
 * from the manifest params.
 */
function azureCosmosDbIdiom({ op, values, localName, built }: IdiomInput): HclBlock[] {
  const loc = deriveLocationExpr(op, values, 'resource_group');
  const derived: BodyNode[] = loc ? [{ kind: 'attr', name: 'location', value: loc }] : [];
  const body = insertAfterTodos(bodyFrom(built), derived);
  const geoBody: BodyNode[] = [];
  if (loc) geoBody.push({ kind: 'attr', name: 'location', value: loc });
  geoBody.push({ kind: 'attr', name: 'failover_priority', value: { kind: 'literal', value: 0 } });
  body.push({ kind: 'block', name: 'geo_location', body: geoBody });
  return [{ type: 'azurerm_cosmosdb_account', name: localName, body }];
}

/* ── Public API ──────────────────────────────────────────────────────────── */

export interface SkeletonOptions {
  /** The request id the banner cites; sanitized to id-safe characters. */
  requestId?: string;
}

/** Every param an op renders, flattened across REPEATED-block sub-schemas so
 * redaction (sensitive) and never-mask (const/key) derivations see a repeated
 * block's instance fields too — a `sensitive` sub-field inside an `ingress`
 * rule must still mask, a const guardrail inside a repeated block must still
 * show. A non-repeated op flattens to exactly `op.params` (unchanged). */
function flattenParams(params: ManifestParam[]): ManifestParam[] {
  const out: ManifestParam[] = [];
  for (const p of params) {
    out.push(p);
    if (p.repeated) out.push(...flattenParams(p.repeated.fields));
  }
  return out;
}

/** Attribute names to mask in the rendered skeleton (params flagged
 * `sensitive` in the manifest) — same derivation the diff renderer uses. */
function sensitiveAttrsOf(op: ManifestOperation): string[] {
  const flagged = flattenParams(op.params).filter((p) => p.sensitive);
  return flagged.map((p) => p.attr ?? p.name).concat(flagged.map((p) => p.name));
}

/** Attribute leaf names the redactor's attribute-NAME rule must not hide —
 * sensitive-flagged attrs still win inside redactHcl:
 *   - `role:"const"` params: manifest constants, not request input
 *     (`http_tokens = "required"` is a guardrail the reviewer must SEE).
 *   - `role:"key"` params: the resource's IDENTITY — bounded display names,
 *     never credentials — even when the provider attr trips the name
 *     heuristic (an EFS share's `creation_token` is a name, not a token). */
function neverMaskAttrsOf(op: ManifestOperation): string[] {
  return flattenParams(op.params)
    .filter((p) => (p.role === 'const' || p.role === 'key') && !p.sensitive)
    .map((p) => {
      const attr = p.attr ?? p.name;
      const dot = attr.lastIndexOf('.');
      return dot >= 0 ? attr.slice(dot + 1) : attr;
    });
}

/**
 * Render the DRAFT skeleton for a create operation from its submitted params.
 * Deterministic; safe to call at render time; output is redacted before it
 * leaves this function.
 */
export function renderHclSkeleton(
  op: ManifestOperation,
  values: Record<string, unknown>,
  opts: SkeletonOptions = {},
): string {
  const keyParam = op.params.find((p) => p.role === 'key');
  const localName = tfLocalName(keyParam ? values[keyParam.name] : undefined);

  const built: BuiltParam[] = [];
  for (const p of op.params) {
    const b = buildParam(p, values);
    if (b) built.push(b);
  }

  const blocks = composeBlocks({ op, values, localName, built });

  const id = opts.requestId?.replace(REQUEST_ID_SAFE, '') ?? '';
  const origin = id !== '' ? `request ${id}` : 'a portal request';
  const banner = [
    `# DRAFT — generated from ${origin}; an engineer must review,`,
    '# complete the TODOs, and own this block. NOT applied by any pipeline.',
  ];
  const todos = (op.decisions ?? []).map((d) => `# TODO: ${d}`);

  const text = [
    banner.join('\n'),
    ...(todos.length > 0 ? [todos.join('\n')] : []),
    ...blocks.map(renderBlock),
  ].join('\n\n');

  // Never render an unredacted secret — same guard as the diff renderer —
  // while const guardrails and key-param identity stay visible.
  return redactHcl(text, {
    sensitiveAttrs: sensitiveAttrsOf(op),
    neverMaskAttrs: neverMaskAttrsOf(op),
  });
}

/* ── Append-op honest preview ─────────────────────────── */

/**
 * The append-class codemodOps whose review artifact is an ADDED block / entry /
 * association, not an in-place attribute edit. For a `macd:"Add"` op of one of
 * these shapes the generated diff must show the REAL addition — the appended
 * block or entry with the operator's picked values and references — never the
 * whole target resource (the old fabricating fallback rendered
 * `resource "<target>" { … }`, which read as *re-creating the DB* / *redefining
 * the whole SG*) and never an empty `{ }` (inventory-sourced params were
 * dropped, so the picked subnet / SG / certificate appeared nowhere).
 */
const APPEND_CODEMODS = new Set<string>([
  'append_block',
  'append_foreach_entry',
  'append_list_entry',
  'set_association_attribute',
]);

/** True for an Add op whose diff renders as an append delta. Change/Move ops of
 * the same codemod (cloudfront-associate-waf `~ web_acl_id`, efs-toggle-backup-
 * policy `~ status`, routing-move-subnet-association) are in-place edits and keep
 * the in-place renderer — only `macd:"Add"` is a genuine addition. */
export function isAppendOp(op: ManifestOperation): boolean {
  return op.macd === 'Add' && APPEND_CODEMODS.has(op.codemodOp);
}

/**
 * Per-op write hints the MOCK preview supplies so an appended block names the
 * real provider attributes / references catalogctl emits, WITHOUT editing the
 * shipped manifest (generateDiff is the deterministic stand-in for catalogctl's
 * real output — diff.ts docstring). Keyed op.id → param.name → the fields
 * merged over the manifest param before it is built. s3-add-lifecycle-rule is
 * absent on purpose: its params already carry attr/path/role, so the shared
 * builder renders its `rule { … }` honestly with no hint.
 */
const APPEND_OVERRIDES: Record<string, Record<string, Partial<ManifestParam>>> = {
  'ebs-create-snapshot': {
    volume: { role: 'reference', refAttr: 'id', attr: 'volume_id' },
    snapshot_name: { role: 'key', attr: 'tags.Name' },
    description_tag: { attr: 'description' },
  },
  'rds-create-manual-snapshot': {
    db: { role: 'reference', refAttr: 'identifier', attr: 'db_instance_identifier' },
    snapshot_identifier: { role: 'key', attr: 'db_snapshot_identifier' },
  },
  'sg-add-internal-ingress-rule': {
    cidr_block: { attr: 'cidr_blocks', wrap: 'list' },
  },
  'acm-attach-sni-certificate': {
    listener: { role: 'reference', refAttr: 'arn', attr: 'listener_arn' },
    certificate: { role: 'reference', refAttr: 'arn', attr: 'certificate_arn' },
  },
  'efs-add-mount-target': {
    file_system: { role: 'reference', refAttr: 'id', attr: 'file_system_id' },
    subnet_id: { role: 'reference', refAttr: 'id', attr: 'subnet_id' },
    security_group_ids: { role: 'reference', refAttr: 'id', attr: 'security_groups' },
  },
};

type AppendShapeKind = 'resource' | 'subblock' | 'mapentry' | 'listentry';

/** Classify the addition from the codemod + target selector alone. */
function appendShapeKind(op: ManifestOperation): { kind: AppendShapeKind; blockType: string } {
  const rt = op.target.resourceType;
  const block = op.target.block;
  if (op.codemodOp === 'append_block') {
    // A block naming a resource type (`aws_ebs_snapshot`) is a NEW top-level
    // resource; a bare block name (`ingress`, `rule`) is a nested sub-block
    // appended into the located parent.
    if (block && /^aws_[a-z0-9_]+$/.test(block)) return { kind: 'resource', blockType: block };
    return { kind: 'subblock', blockType: block ?? rt };
  }
  if (op.codemodOp === 'append_list_entry') return { kind: 'listentry', blockType: block ?? rt };
  if (op.codemodOp === 'append_foreach_entry') {
    // An entry into a MAP attribute (`tags`) — or, with no block, a NEW resource
    // the for_each materializes (an EFS mount target).
    return block ? { kind: 'mapentry', blockType: block } : { kind: 'resource', blockType: rt };
  }
  // set_association_attribute (macd Add) → a NEW association resource.
  return { kind: 'resource', blockType: rt };
}

/** Merge the mock's per-op write hints over a manifest param (client-side only —
 * the shipped manifest is never mutated). */
function withAppendOverride(op: ManifestOperation, p: ManifestParam): ManifestParam {
  const o = APPEND_OVERRIDES[op.id]?.[p.name];
  return o ? { ...p, ...o } : p;
}

/** Leaf attr names of const/key params, computed over the (overridden) params so
 * the never-mask set matches the attributes actually rendered. */
function neverMaskLeaves(params: ManifestParam[]): string[] {
  return params
    .filter((p) => (p.role === 'const' || p.role === 'key') && !p.sensitive)
    .map((p) => {
      const attr = p.attr ?? p.name;
      const dot = attr.lastIndexOf('.');
      return dot >= 0 ? attr.slice(dot + 1) : attr;
    });
}

/** Resolve one value param to its HCL form: a reference expression for a
 * role:"reference" or any inventory-sourced address (default refAttr `id`),
 * otherwise a scalar literal. */
function appendValueHcl(param: ManifestParam, raw: unknown): HclValue {
  if (param.role === 'reference' || param.source === 'inventory') {
    return referenceValue(raw, param.refAttr ?? 'id');
  }
  return scalarValue(param, raw);
}

/** The local name for a new association / foreach resource that has no key param:
 * the local part of the first reference param's picked address. */
function refLocalName(params: ManifestParam[], values: Record<string, unknown>): string {
  for (const p of params) {
    if (p.role === 'reference') {
      const addr = String(values[p.name] ?? '');
      if (ADDRESS_SHAPE.test(addr)) return tfLocalName(addr.split('.')[1]);
    }
  }
  return tfLocalName(undefined);
}

/** Decorate every rendered HCL line as an addition (`+`, preserving indentation)
 * so DiffView paints the appended block/entry green. Redaction has already run on
 * the plain text, so this is purely cosmetic. */
function asAddition(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^(\s*)/, '$1+ '))
    .join('\n');
}

/**
 * Render the honest `+` preview for an append-class Add op: the exact block /
 * entry catalogctl appends, with the operator's picked values and references —
 * NOT the whole target resource and NOT an empty `{ }`. Deterministic; safe at
 * render time; output redacted before it leaves this function. The manifest is
 * read, never mutated: per-op provider-attribute hints live in APPEND_OVERRIDES.
 */
export function renderAppendDelta(op: ManifestOperation, values: Record<string, unknown>): string {
  const params = op.params.map((p) => withAppendOverride(op, p));
  const { kind, blockType } = appendShapeKind(op);

  // The located parent (nested block / map / list shapes) is the inventory param
  // that is NOT a reference; references belong in the appended body.
  const parentParam =
    kind === 'resource'
      ? undefined
      : params.find((p) => p.source === 'inventory' && p.role !== 'reference');
  const parentAddress = parentParam ? String(values[parentParam.name] ?? '') : '';

  // Body params: everything but the located parent. In a NEW resource an
  // un-annotated inventory param is a foreign-key reference (default refAttr id).
  const bodyParams = params
    .filter((p) => p !== parentParam)
    .map((p) =>
      kind === 'resource' && p.source === 'inventory' && p.role !== 'reference'
        ? ({
            ...p,
            role: 'reference',
            refAttr: p.refAttr ?? 'id',
            attr: p.attr ?? p.name,
          } as ManifestParam)
        : p,
    );

  const redactOpts: RedactOptions = {
    sensitiveAttrs: sensitiveAttrsOf(op),
    neverMaskAttrs: neverMaskLeaves(params),
  };

  let plain: string;
  let header: string;

  if (kind === 'mapentry') {
    // append_foreach_entry into a map attribute (tags): a `<block> = { k = v }`
    // entry. The non-const value params are (key, value) in first-declared order.
    const vps = bodyParams.filter((p) => p.role !== 'const');
    const keyParam = vps[0];
    const valParam = vps[1] ?? vps[0];
    const key = keyParam ? String(values[keyParam.name] ?? '') : '';
    const valHcl = valParam ? appendValueHcl(valParam, values[valParam.name]) : literal('');
    const keyTok = BARE_KEY.test(key) ? key : JSON.stringify(key);
    plain = `${blockType} = {\n  ${keyTok} = ${renderValue(valHcl)}\n}`;
    header = `# ${op.terraformCapability}  (${op.macd}) — new ${blockType} entry on ${parentAddress}`;
  } else if (kind === 'listentry') {
    const vps = bodyParams.filter((p) => p.role !== 'const');
    const vp = vps[0];
    const hcl = vp ? appendValueHcl(vp, values[vp.name]) : literal('');
    plain = `${blockType} = ${renderValue({ kind: 'tuple', items: [hcl] })}`;
    header = `# ${op.terraformCapability}  (${op.macd}) — new ${blockType} entry appended to ${parentAddress}`;
  } else {
    const built: BuiltParam[] = [];
    for (const p of bodyParams) {
      const b = buildParam(p, values);
      if (b) built.push(b);
    }
    const body = bodyFrom(built);
    if (kind === 'subblock') {
      plain = [`${blockType} {`, ...renderBody(body, 1), '}'].join('\n');
      header = `# ${op.terraformCapability}  (${op.macd}) — new ${blockType} block appended to ${parentAddress}`;
    } else {
      const keyParam = params.find((p) => p.role === 'key');
      const localName = keyParam
        ? tfLocalName(values[keyParam.name])
        : refLocalName(bodyParams, values);
      plain = renderBlock({ type: blockType, name: localName, body });
      header = `# ${op.terraformCapability}  (${op.macd})`;
    }
  }

  return `${header}\n${asAddition(redactHcl(plain, redactOpts))}`;
}
