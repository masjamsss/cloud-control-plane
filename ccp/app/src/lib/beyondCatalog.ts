import type { ChangeRequest, ManifestOperation, RequestEvent, ServiceManifest } from '@/types';
import { api, type ApiClient, type MutationResult } from '@/lib/api';
import { isChangeFrozen } from '@/lib/settings';
import { CATEGORY_ORDER, getServiceMeta, type Category } from '@/lib/serviceMeta';
import { catalogServiceKey } from '@/lib/catalog';
import { isProvisionAdd } from '@/lib/actionPicker';
import { RESOURCE_TYPE_PATTERNS, type CloudProvider } from '@/lib/providerDisplay';
import { getInstanceIdentity } from '@/lib/instanceIdentity';

/**
 * "Request something new" — the beyond-catalog tail, v2 (elaboration, not a
 * suggestion box). The catalog is generated from the estate's Terraform
 * modules, so it is always one step behind a genuinely new service or resource
 * type. v2's shape: the entry point is a TECHNOLOGY CHOOSER over the catalog's
 * own provision baselines (deriveTechnologyChooser below — a cataloged
 * technology routes into its real form, never into free text), and the
 * free-text tail survives only for genuinely uncataloged technology — and even
 * there it is STRUCTURED (workload, sizing, connectivity, data classification,
 * needed-by), so L2 reviews a spec sheet and L3 starts from a specification,
 * never from a 200-character aspiration. Routed to an engineer through the
 * SAME draft→review→approve pipeline everything else uses (api.submitRequest,
 * unchanged) — never a separate, second-class path.
 *
 * There is deliberately no manifest operation behind BEYOND_CATALOG_OP_ID:
 * getOperation() returns undefined for it everywhere, by design. The three
 * request-facing surfaces (RequestDetail, MyRequests, ApprovalsQueue) branch on
 * `operationId === BEYOND_CATALOG_OP_ID` and render the stored fields directly
 * instead of a generated diff — see describeBeyondCatalogRequest below.
 */
export const BEYOND_CATALOG_OP_ID = 'beyond-catalog-request';

export type BeyondKind = 'new_resource_uncatalogued' | 'enable_new_service';

/** Built per call (never a module-scope literal) so it reads the resolved
 * instance name at call time — brand.ts's baked default in mock mode/pre-
 * hydration, the live runtime name once resolved (lib/instanceIdentity.ts). */
export function beyondCatalogKindLabel(kind: BeyondKind): string {
  const labels: Record<BeyondKind, string> = {
    new_resource_uncatalogued: `A resource ${getInstanceIdentity().name} does not catalog yet`,
    enable_new_service: 'A whole new service',
  };
  return labels[kind];
}

/* ── The structured tail vocabulary ─────────────────────────────── */

/** Sizing units — numbers, not prose: storage, compute, request rate, message volume. */
export const SIZING_UNITS = ['GiB', 'vCPU', 'requests-per-second', 'messages-per-day'] as const;
export type SizingUnit = (typeof SIZING_UNITS)[number];

export const SIZING_UNIT_LABEL: Record<SizingUnit, string> = {
  GiB: 'GiB of storage',
  vCPU: 'vCPU',
  'requests-per-second': 'requests per second',
  'messages-per-day': 'messages per day',
};

/** How the workload is reached — the first question an engineer asks. */
export const CONNECTIVITY_OPTIONS = [
  'vpc-internal',
  'internet-facing',
  'on-prem-vpn',
  'unknown',
] as const;
export type Connectivity = (typeof CONNECTIVITY_OPTIONS)[number];

export const CONNECTIVITY_LABEL: Record<Connectivity, string> = {
  'vpc-internal': 'Inside the private network only',
  'internet-facing': 'Reachable from the internet',
  'on-prem-vpn': 'Reached from on-premises over the VPN',
  unknown: 'Not sure yet',
};

/** Data classification — the security-review prompt, asked at intake, not at PR time. */
export const DATA_CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const DATA_CLASSIFICATION_LABEL: Record<DataClassification, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

export interface BeyondCatalogInput {
  kind: BeyondKind;
  /** Free text, 2-40 chars, lowercase slug-ish. */
  service: string;
  /** Optional; must match the active project's cloud provider's resource-type
   * shape when present (aws_[a-z0-9_]+ or azurerm_[a-z0-9_]+ — see
   * RESOURCE_TYPE_PATTERNS in lib/providerDisplay). */
  resourceType?: string;
  /** What runs on it, 10-500 chars. */
  workload: string;
  /** Optional capacity number; requires a unit when present. */
  sizingCapacity?: number;
  sizingUnit?: SizingUnit;
  /** Optional instance count, 1-100. */
  instanceCount?: number;
  /** Required; the form preselects 'unknown' — an honest answer, never a silent one. */
  connectivity: Connectivity;
  /** Required with NO default — a deliberate choice the requester must make. */
  dataClassification: DataClassification;
  /** Optional date (YYYY-MM-DD), today or later. */
  neededBy?: string;
  /** What is needed, 10-2000 chars. */
  summary: string;
  /** Why, >=20 chars. */
  justification: string;
}

const SERVICE_PATTERN = /^[a-z0-9-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_SUMMARY = 10;
/** The old 200-char cap asked for an entire technology in a tweet. */
const MAX_SUMMARY = 2000;
export const BEYOND_CATALOG_MAX_SUMMARY = MAX_SUMMARY;
const MIN_WORKLOAD = 10;
const MAX_WORKLOAD = 500;
export const MIN_BEYOND_CATALOG_JUSTIFICATION = 20;

/** Today as a YYYY-MM-DD string (UTC) — injectable for deterministic tests. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isIn<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

/**
 * Deterministic bounds checking for the beyond-catalog tail — the same
 * "law" pattern as lib/validation.ts's checkBounds: no model, no I/O, a plain
 * lookup a client and (conceptually) a server can both run. `today` is
 * injectable so the needed-by rule is testable without a clock. `provider`
 * is the active project's cloud provider (0039 S1 lane C) — it picks which
 * resource-type shape `resourceType` is checked against; defaults to 'aws'
 * so every pre-existing caller (all AWS-only projects today) is unaffected.
 */
export function validateBeyondCatalogInput(
  input: BeyondCatalogInput,
  today: string = todayIsoDate(),
  provider: CloudProvider = 'aws',
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (input.kind !== 'new_resource_uncatalogued' && input.kind !== 'enable_new_service') {
    errors.kind = 'Choose what kind of request this is.';
  }

  const service = input.service?.trim() ?? '';
  if (service.length < 2 || service.length > 40 || !SERVICE_PATTERN.test(service)) {
    errors.service =
      'Service must be 2–40 characters: lowercase letters, numbers, and hyphens only (e.g. redshift).';
  }

  const resourceType = input.resourceType?.trim();
  if (resourceType && !RESOURCE_TYPE_PATTERNS[provider].test(resourceType)) {
    errors.resourceType = `Resource type must be an ${provider === 'azure' ? 'azurerm_*' : 'aws_*'} resource type, e.g. ${provider === 'azure' ? 'azurerm_storage_account' : 'aws_redshift_cluster'}.`;
  }

  const workload = input.workload?.trim() ?? '';
  if (workload.length < MIN_WORKLOAD || workload.length > MAX_WORKLOAD) {
    errors.workload = `Describe what runs on it in ${MIN_WORKLOAD}–${MAX_WORKLOAD} characters.`;
  }

  if (input.sizingCapacity !== undefined) {
    if (
      typeof input.sizingCapacity !== 'number' ||
      !Number.isFinite(input.sizingCapacity) ||
      input.sizingCapacity <= 0 ||
      input.sizingCapacity > 1_000_000
    ) {
      errors.sizingCapacity = 'Capacity must be a number between 1 and 1,000,000.';
    } else if (!isIn(SIZING_UNITS, input.sizingUnit)) {
      errors.sizingUnit = 'Pick what the capacity number measures.';
    }
  } else if (input.sizingUnit !== undefined && !isIn(SIZING_UNITS, input.sizingUnit)) {
    errors.sizingUnit = 'Pick what the capacity number measures.';
  }

  if (input.instanceCount !== undefined) {
    if (
      typeof input.instanceCount !== 'number' ||
      !Number.isInteger(input.instanceCount) ||
      input.instanceCount < 1 ||
      input.instanceCount > 100
    ) {
      errors.instanceCount = 'Instance count must be a whole number between 1 and 100.';
    }
  }

  if (!isIn(CONNECTIVITY_OPTIONS, input.connectivity)) {
    errors.connectivity = 'Choose how this workload is reached — "Not sure yet" is a valid answer.';
  }

  if (!isIn(DATA_CLASSIFICATIONS, input.dataClassification)) {
    errors.dataClassification =
      'Choose the data classification — a reviewer needs it to route the security questions.';
  }

  const neededBy = input.neededBy?.trim();
  if (neededBy) {
    const parses = DATE_PATTERN.test(neededBy) && !Number.isNaN(Date.parse(neededBy));
    if (!parses) {
      errors.neededBy = 'Enter the date as YYYY-MM-DD.';
    } else if (neededBy < today) {
      errors.neededBy = 'The needed-by date cannot be in the past.';
    }
  }

  const summary = input.summary?.trim() ?? '';
  if (summary.length < MIN_SUMMARY || summary.length > MAX_SUMMARY) {
    errors.summary = `Summarize what’s needed in ${MIN_SUMMARY}–${MAX_SUMMARY} characters.`;
  }

  const justification = input.justification?.trim() ?? '';
  if (justification.length < MIN_BEYOND_CATALOG_JUSTIFICATION) {
    errors.justification = `Explain why this is needed (at least ${MIN_BEYOND_CATALOG_JUSTIFICATION} characters).`;
  }

  return errors;
}

/**
 * Assemble the frozen DRAFT ChangeRequest for a beyond-catalog request. Same
 * shape family as interpreter.ts's buildRequestDraft, but there is no
 * ManifestOperation to read macd/exposure/risk from — they are fixed: this
 * always needs an engineer to author the Terraform, so it is always
 * engineer_only/HIGH, regardless of kind. The structured tail fields land in
 * `params` (the record's existing Record<string, unknown> — no schema change),
 * where describeBeyondCatalogRequest re-reads them as the reviewer's spec sheet.
 */
export function buildBeyondCatalogDraft(
  input: BeyondCatalogInput,
  requester: string,
): ChangeRequest {
  const now = new Date().toISOString();
  const params: Record<string, unknown> = { kind: input.kind };
  if (input.resourceType) params.resourceType = input.resourceType;
  params.workload = input.workload;
  if (input.sizingCapacity !== undefined) {
    params.sizingCapacity = input.sizingCapacity;
    params.sizingUnit = input.sizingUnit;
  }
  if (input.instanceCount !== undefined) params.instanceCount = input.instanceCount;
  params.connectivity = input.connectivity;
  params.dataClassification = input.dataClassification;
  if (input.neededBy) params.neededBy = input.neededBy;
  params.summary = input.summary;

  const events: RequestEvent[] = [
    {
      at: now,
      type: 'created',
      label: 'Beyond-catalog request drafted in the portal',
      actor: requester,
    },
  ];

  return {
    id: crypto.randomUUID(),
    requester,
    service: input.service,
    operationId: BEYOND_CATALOG_OP_ID,
    macd: 'Add',
    targetAddress: '(new)',
    params,
    justification: input.justification,
    exposure: 'engineer_only',
    risk: 'HIGH',
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    events,
  };
}

/**
 * FROZEN RULE: beyond-catalog requests are allowed from ANY team — the service
 * doesn't exist yet, so team scoping (canRequest) cannot apply. In its place,
 * a per-user cap bounds the queue an engineer can be handed.
 */
export const MAX_OPEN_BEYOND_CATALOG_REQUESTS = 3;

/**
 * Beyond-catalog requests always carry engineer_only exposure, so
 * api.submitRequest always routes them straight to NEEDS_ENGINEER (never
 * AWAITING_CODE_REVIEW) — that is the one "open" state this kind can be in
 * before an engineer picks it up. Counts only this operation id.
 */
export function openBeyondCatalogCount(requests: ChangeRequest[]): number {
  return requests.filter(
    (r) => r.operationId === BEYOND_CATALOG_OP_ID && r.status === 'NEEDS_ENGINEER',
  ).length;
}

const FREEZE_MESSAGE =
  'Change requests are frozen by an administrator right now. Try again once the freeze is lifted.';

function capMessage(): string {
  return `You already have ${MAX_OPEN_BEYOND_CATALOG_REQUESTS} open beyond-catalog requests. Wait for one to reach an engineer before submitting another.`;
}

/**
 * The beyond-catalog submit path. It flows through api.submitRequest UNCHANGED
 * — same MutationResult shape approveRequest/rejectRequest use — with two
 * checks in front of it that mirror how the rest of the app already gates a
 * submission: the change-freeze switch (RequestForm.tsx checks isChangeFrozen()
 * before calling api.submitRequest; this does the same, since api.submitRequest
 * itself does not enforce freeze for any request kind today) and the per-user
 * open-request cap above (replacing the team check FROZEN RULE removes).
 *
 * `client` defaults to the shared api singleton; tests inject a fresh
 * createMockApiClient() for isolation from other suites' state. `provider`
 * (0039 S1 lane C) is the active project's cloud provider, forwarded to
 * validateBeyondCatalogInput so a resourceType is checked against the right
 * shape; defaults to 'aws' for callers that predate the multi-provider seam.
 */
export async function submitBeyondCatalogRequest(
  input: BeyondCatalogInput,
  requester: string,
  client: ApiClient = api,
  provider: CloudProvider = 'aws',
): Promise<MutationResult> {
  const errors = validateBeyondCatalogInput(input, undefined, provider);
  const firstError = Object.values(errors)[0];
  if (firstError) return { ok: false, reason: firstError };

  if (isChangeFrozen()) return { ok: false, reason: FREEZE_MESSAGE };

  const existing = await client.listRequests(requester);
  if (openBeyondCatalogCount(existing) >= MAX_OPEN_BEYOND_CATALOG_REQUESTS) {
    return { ok: false, reason: capMessage() };
  }

  const draft = buildBeyondCatalogDraft(input, requester);
  const submitted = await client.submitRequest(draft);
  // submitRequest now returns a SubmitResult; a server-side rejection (freeze /
  // disabled op / bounds) surfaces here as a MutationResult failure.
  if (!submitted.ok) return { ok: false, reason: submitted.reason };
  return { ok: true, request: submitted.request };
}

export function isBeyondCatalogRequest(request: Pick<ChangeRequest, 'operationId'>): boolean {
  return request.operationId === BEYOND_CATALOG_OP_ID;
}

/**
 * The standing note shown on every beyond-catalog panel (RequestDetail,
 * ApprovalsQueue): there is no Terraform to review here, on purpose.
 */
export const BEYOND_CATALOG_NOTE =
  'No Terraform is generated for this request — an engineer authors it after approval; the approval here authorizes the work, not a diff.';

export interface BeyondCatalogSummary {
  kindLabel: string;
  service: string;
  resourceType?: string;
  summary: string;
  /** Structured tail rows (v2) — absent on requests submitted before them. */
  workload?: string;
  /** Formatted, e.g. "500 GiB of storage · 3 instances". */
  sizing?: string;
  connectivity?: string;
  dataClassification?: string;
  neededBy?: string;
}

/** "500 GiB of storage · 3 instances" from the stored sizing params, or undefined. */
function formatSizing(params: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const capacity = params.sizingCapacity;
  const unit = params.sizingUnit;
  if (typeof capacity === 'number' && isIn(SIZING_UNITS, unit)) {
    parts.push(`${capacity} ${SIZING_UNIT_LABEL[unit]}`);
  }
  const count = params.instanceCount;
  if (typeof count === 'number') {
    parts.push(`${count} instance${count === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Shape the stored params into the fields the "Beyond-catalog request" panel
 * renders — v2 requests yield the full spec sheet; v1 requests yield exactly
 * the rows they carried. Returns null for any other request — callers branch
 * on this. */
export function describeBeyondCatalogRequest(request: ChangeRequest): BeyondCatalogSummary | null {
  if (!isBeyondCatalogRequest(request)) return null;
  const kind = request.params.kind;
  const kindLabel =
    kind === 'new_resource_uncatalogued' || kind === 'enable_new_service'
      ? beyondCatalogKindLabel(kind)
      : 'Beyond-catalog request';
  const { resourceType, summary, workload, connectivity, dataClassification, neededBy } =
    request.params;
  return {
    kindLabel,
    service: request.service,
    resourceType: typeof resourceType === 'string' ? resourceType : undefined,
    summary: typeof summary === 'string' ? summary : '',
    workload: typeof workload === 'string' ? workload : undefined,
    sizing: formatSizing(request.params),
    connectivity: isIn(CONNECTIVITY_OPTIONS, connectivity)
      ? CONNECTIVITY_LABEL[connectivity]
      : undefined,
    dataClassification: isIn(DATA_CLASSIFICATIONS, dataClassification)
      ? DATA_CLASSIFICATION_LABEL[dataClassification]
      : undefined,
    neededBy: typeof neededBy === 'string' ? neededBy : undefined,
  };
}

/** A readable title for surfaces that would otherwise fall back to the raw
 * operationId slug (getOperation() has nothing to return op.title from). */
export function beyondCatalogTitle(
  request: Pick<ChangeRequest, 'operationId' | 'service' | 'params'>,
): string {
  if (request.operationId !== BEYOND_CATALOG_OP_ID) return request.operationId;
  return request.params.kind === 'enable_new_service'
    ? `Enable ${request.service}`
    : `New resource in ${request.service}`;
}

/* ── The technology chooser ──────────────────────────────── */

export interface TechnologyChoice {
  service: string;
  /** The service's display name (serviceMeta). */
  displayName: string;
  op: ManifestOperation;
}

export interface TechnologyChooserGroup {
  category: Category;
  choices: TechnologyChoice[];
}

/**
 * The deterministic technology chooser: one card per PROVISION create baseline
 * (`group:'create'` ops that stand up a new top-level resource — the same
 * isProvisionAdd split the service console's "Add new" grid uses, lifted
 * estate-wide), grouped by serviceMeta category in the catalog's own order.
 * A lookup over the manifests — no inference, no model. Tag-adds
 * and rule-adds are not technologies; they stay on their service consoles.
 */
export function deriveTechnologyChooser(manifests: ServiceManifest[]): TechnologyChooserGroup[] {
  const byCategory = new Map<Category, TechnologyChoice[]>();
  for (const manifest of manifests) {
    for (const op of manifest.operations) {
      if (op.group !== 'create' || !isProvisionAdd(op)) continue;
      // A provision baseline belongs to its named service (portal parity), not
      // its source manifest — so an azure VM baseline cards under 'Virtual
      // Machines', a disk baseline under 'Managed Disks'. AWS keys are unchanged.
      const service = catalogServiceKey(op.target.resourceType, manifest.service);
      const meta = getServiceMeta(service);
      let list = byCategory.get(meta.category);
      if (!list) {
        list = [];
        byCategory.set(meta.category, list);
      }
      list.push({ service, displayName: meta.displayName, op });
    }
  }
  const groups: TechnologyChooserGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const choices = byCategory.get(category);
    if (!choices || choices.length === 0) continue;
    choices.sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.op.title.localeCompare(b.op.title),
    );
    groups.push({ category, choices });
  }
  return groups;
}

/* ── The cataloged-service redirect (routing rule) ────────────────── */

export interface CatalogedRedirect {
  service: string;
  displayName: string;
  /** The provision baselines the banner links to (may be empty — the service
   * page is still the honest destination for its Change/rule ops). */
  ops: ManifestOperation[];
}

/**
 * Non-blocking redirect intelligence for the tail form: when the typed
 * `service` slug matches a cataloged service, tell the requester the baseline
 * exists one click away. Matched against the DERIVED service key of every op
 * ({@link catalogServiceKey}) — so a typed 'ec2' resolves its manifest slug and
 * a typed 'vm' resolves its named azure service, never assuming the browsable
 * service equals a manifest slug. No inference; never blocks submission.
 */
export function catalogedRedirect(
  service: string,
  manifests: ServiceManifest[],
): CatalogedRedirect | null {
  const slug = service.trim().toLowerCase();
  if (!slug) return null;
  let matched = false;
  const ops: ManifestOperation[] = [];
  for (const manifest of manifests) {
    for (const op of manifest.operations) {
      if (catalogServiceKey(op.target.resourceType, manifest.service) !== slug) continue;
      matched = true;
      if (op.group === 'create' && isProvisionAdd(op)) ops.push(op);
    }
  }
  if (!matched) return null;
  return { service: slug, displayName: getServiceMeta(slug).displayName, ops };
}
