import type {
  ChangeRequest,
  ChangeSetDraft,
  ChangeSetItem,
  Inventory,
  ManifestOperation,
  Role,
  Schedule,
  ServiceManifest,
  User,
} from '@/types';
import type { DriftFinding, DriftProposal, DriftReport, DriftSweep, DriftStatus } from '@/types/drift';
import type { PlanAction, PlanSummary } from '@/lib/planSummary';
import { config } from '@/config';
import { canApprove, approvalsRequiredFor } from '@/lib/permissions';
import { resolveName } from '@/lib/accounts';
import { resolveRisk } from '@/lib/riskOverrides';
import { getCurrentUser } from '@/lib/session';
import { getOperation } from '@/lib/interpreter';
import { generateDiff, isAttributeLevelOp, isSubBlockOp } from '@/lib/diff';
import { combinedRequirement, reviewTierForExposure } from '@/lib/changeSet';
import { classifyDrift, classifyFinding, isSecurityPosture } from '@/lib/driftEligibility';
import {
  SYSTEM_DRIFT_ADOPT,
  SYSTEM_DRIFT_IMPORT,
  SYSTEM_DRIFT_LEGITIMIZE,
  SYSTEM_DRIFT_RESTORE,
  SYSTEM_DRIFT_REVERT,
  SYSTEM_OPERATIONS,
  isSystemDriftOp,
} from '@/lib/systemOps';
import { manifests as bundledManifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';
import {
  currentProjectId,
  hasActiveProject,
  SAMPLE_ESTATE_ID,
  setProjectScope,
} from '@/lib/projectScope';
import { parseManifests } from '@/types/manifestSchema';
import { isChangeFrozen, isOpDisabled } from '@/lib/settings';
import { createHttpApiClient, type HttpApiClient } from '@/lib/httpApi';
import { isApiMode } from '@/lib/apiSession';
import {
  noCapabilities,
  SERVER_FLOWS,
  type ServerCapabilities,
  type ServerFlow,
  type ServerInfo,
} from '@/lib/serverInfo';

const inventory = inventoryData as unknown as Inventory;

/**
 * Mock/standalone default (data-birth spec, lane B item 4): with no real
 * backend, this build behaves like the long-standing demo always has — the
 * bundled SAMPLE estate ({@link SAMPLE_ESTATE_ID}) is the active scope from
 * first paint, so every existing mock flow, screenshot, and test walk stays
 * intact. This is an explicit, one-time act taken HERE (the standalone
 * client's own construction), not an unconditional default baked into
 * `lib/projectScope.ts` itself — a REAL backend (isApiMode) never runs this:
 * an api-mode install starts unscoped until an operator selects/onboards a
 * real estate or explicitly loads the sample (lib/legacyRoute.ts routes a
 * still-unscoped visit to the first-run surface instead). Guarded on
 * `hasActiveProject()` so it never clobbers a scope something else already
 * set (e.g. a test that scoped before importing this module).
 */
if (!isApiMode && !hasActiveProject()) setProjectScope(SAMPLE_ESTATE_ID);

/**
 * Vendored per-project catalogs: a project other than the bundled
 * default ships its manifests + inventory under `src/data/projects/<id>/...`
 * (`bootstrap` is vendored this way). Eager — small, and always needed once
 * a project is scoped. Globbed once for ALL projects (import.meta.glob patterns
 * must be static string literals — no dynamic currentProjectId() interpolation)
 * then grouped by the `<id>` path segment at call time.
 */
const vendoredManifestModules = import.meta.glob<{ default: unknown }>(
  '../data/projects/*/manifests/*.json',
  {
    eager: true,
  },
);
const vendoredInventoryModules = import.meta.glob<{ default: unknown }>(
  '../data/projects/*/inventory.json',
  {
    eager: true,
  },
);

function projectIdFromGlobKey(key: string): string | null {
  const m = /\/projects\/([^/]+)\//.exec(key);
  return m ? m[1]! : null;
}

function vendoredManifestsFor(id: string): ServiceManifest[] {
  const raws = Object.keys(vendoredManifestModules)
    .filter((key) => projectIdFromGlobKey(key) === id)
    .sort()
    .map((key) => vendoredManifestModules[key]!.default);
  return parseManifests(raws);
}

function vendoredInventoryFor(id: string): Inventory | undefined {
  const key = Object.keys(vendoredInventoryModules).find((k) => projectIdFromGlobKey(k) === id);
  return key ? (vendoredInventoryModules[key]!.default as unknown as Inventory) : undefined;
}

/** What a project with no data of its own gets: an explicitly empty
 * inventory. One stable instance — getInventory() may be read repeatedly. */
const EMPTY_INVENTORY: Inventory = { generatedAt: null, resources: [] };

/** The active project's manifests: the bundled SAMPLE's for
 * {@link SAMPLE_ESTATE_ID} (served only once explicitly loaded — mock/
 * standalone's default, or an operator's explicit "load sample data"), else
 * the vendored catalog for whichever project is scoped. Any other project
 * with nothing vendored gets an EMPTY catalog — never the sample's: the old
 * fallback silently showed one estate's resources under another project's
 * name (an injected/registered project with no vendored data). Resolution
 * rule: sample id → bundled; vendored id → vendored; anything else → empty
 * (projectRegistry.test.ts pins all three arms). */
function activeManifests(): ServiceManifest[] {
  const id = currentProjectId();
  if (id === SAMPLE_ESTATE_ID) return bundledManifests;
  return vendoredManifestsFor(id);
}

/** The active project's inventory — same resolution rule as
 * {@link activeManifests}: bundled for the sample, vendored when present,
 * else explicitly empty (never another project's estate). */
function activeInventory(): Inventory {
  const id = currentProjectId();
  if (id === SAMPLE_ESTATE_ID) return inventory;
  return vendoredInventoryFor(id) ?? EMPTY_INVENTORY;
}

/**
 * The result of a guarded mutation. A real `ccp-api` returns the same shape:
 * the actor is derived from the authenticated session on the server, never from a
 * client-supplied id, and separation-of-duties is re-checked server-side. `ok:false`
 * carries a human reason (wrong role / self-approval / already approved / no session).
 * `code` is the raw taxonomy code (e.g. `TOTP_ENROLLMENT_REQUIRED`,
 * `CANCEL_FORBIDDEN`, `STATE_CONFLICT`) — set only by the HTTP client,
 * so a caller can branch on a specific rejection instead of matching `reason` text;
 * the mock never sets it (its rejections have no server taxonomy behind them).
 */
export type MutationResult =
  { ok: true; request: ChangeRequest } | { ok: false; reason: string; code?: string };

// The server-info contract lives in its own dependency-free module (both
// clients import it without a cycle); re-exported here so existing importers of
// `@/lib/api` are unchanged.
export type { ServerInfo, ServerFlow, ServerCapabilities };
export { SERVER_FLOWS, noCapabilities };

/**
 * The outcome of a submit. Unlike a bare
 * `ChangeRequest`, this surfaces a server-side rejection so the UI can show the
 * reason inline. `code` buckets the taxonomy the real API returns: `FROZEN`
 * (estate frozen → HTTP 423), `OP_DISABLED`/`OUT_OF_BOUNDS` (→ 422), `FORBIDDEN`
 * (any other refusal — team scope, role, no session).
 */
export type SubmitResult =
  | { ok: true; request: ChangeRequest }
  | { ok: false; reason: string; code: 'FROZEN' | 'OP_DISABLED' | 'OUT_OF_BOUNDS' | 'FORBIDDEN' };

/**
 * The outcome of "Start drift check" (spec addendum A7 / plan B1,
 * `POST /projects/:id/drift/check`) — a fire-and-acknowledge trigger for
 * the operator-injected on-demand workflow run, NOT a request/proposal:
 * there is nothing here to approve. `ok:true` only means the trigger was
 * accepted; the report itself lands later, through the normal ingest PUT,
 * when the workflow publishes (the panel's own staleness display covers
 * arrival). `ok:false` carries the server's reason verbatim — disarmed
 * (names the unset env var), another check already in flight, frozen, or
 * the wrong role — so the button can render it as a standing
 * disabled-with-reason state instead of a one-off toast. `code` is the raw
 * taxonomy code when the http client has one (never set by the mock, same
 * doctrine as {@link MutationResult.code}).
 */
export type DriftCheckResult = { ok: true; at: string } | { ok: false; reason: string; code?: string };

/**
 * The outcome of the "Fix the drift" generation-refresh trigger (spec
 * addendum A7 / plan B2, `POST /projects/:id/drift/generate`) — schedules
 * the SAME idempotent, digest-keyed generation runner
 * {@link ApiClient.getDriftStatus}'s `proposals[]` already reflects, just
 * on demand instead of waiting for the next report. `ok:true` only means
 * generation was scheduled/ran — re-fetch {@link ApiClient.getDriftStatus}
 * to see its result. Same `ok:false` shape as {@link DriftCheckResult}.
 */
export type DriftGenerateResult =
  | { ok: true; reportVersion: number }
  | { ok: false; reason: string; code?: string };

function prUrl(n: number): string {
  return `https://github.com/${config.github.owner}/${config.github.repo}/pull/${n}`;
}

function userName(id: string): string {
  return resolveName(id);
}

/**
 * The mock's structured plan summary. The mock simulates the
 * whole Stage-2 pipeline (it fakes the PR too), so a submitted request gets
 * the summary shape CI would post — one change against the request's target.
 * Deterministic; api-mode gets the real thing from POST /requests/:id/plan-summary.
 *
 * The action is keyed off whole-resource-vs-attribute (`isAttributeLevelOp`),
 * NOT off MACD alone (OP-3 / LD-1): a tag add/remove op carries MACD
 * "Add"/"Delete" but never creates or destroys the target resource, so it
 * must render "update" — create/delete are reserved for an op that actually
 * provisions or tears down the whole resource. `op` is undefined only for a
 * request whose operation is not in the bundled catalog (the synthetic
 * "provision any type" beyond-catalog path) — falls back to the MACD-keyed
 * rule, the same fallback used for its approvals count just below.
 *
 * Round 3 of review-artifact-truthfulness: `isSubBlockOp` (lib/diff.ts) is
 * ALSO attribute-level for this badge, not just `isAttributeLevelOp`. Round 2
 * (#120) made the rendered diff TEXT honest for the 9 sub-block-scoped
 * remove_block/append_block ops (a tag, an ingress rule, a WAF rule, a policy
 * attachment, a dead-letter-queue config…) but deliberately left THIS
 * classifier untouched — isAttributeLevelOp's own docstring excludes
 * append_block/remove_block wholesale, since either codemod can ALSO be a
 * genuine whole-resource create/destroy (ebs-delete-volume). That left the
 * badge keyed off MACD alone for exactly those 9 ops: e.g.
 * autoscaling-remove-tag (MACD "Delete") showed plan action "delete" even
 * though the diff right next to it correctly showed only a tag block being
 * removed. `isSubBlockOp` is the SAME disambiguation #120 already proved out
 * for the diff text — reused here, not re-derived — and it already excludes
 * every genuine whole-resource remove_block op (isWholeResourceRemoveBlockOp,
 * which it calls internally), so ebs-delete-volume / cloudwatch-delete-alarm
 * / the whole-resource remove_block set, and create_resource/
 * instantiate_module (never matched by isSubBlockOp at all), keep rendering
 * "create"/"delete" exactly as before.
 */
function mockPlanSummaryFor(
  op: ManifestOperation | undefined,
  macd: ChangeRequest['macd'],
  targetAddress: string,
): PlanSummary {
  const action: PlanAction =
    op && (isAttributeLevelOp(op) || isSubBlockOp(op))
      ? 'update'
      : macd === 'Add'
        ? 'create'
        : macd === 'Delete'
          ? 'delete'
          : 'update';
  return {
    resourceChanges: [
      {
        address: targetAddress,
        type: targetAddress.split('.')[0] ?? targetAddress,
        action,
      },
    ],
    counts: {
      create: action === 'create' ? 1 : 0,
      update: action === 'update' ? 1 : 0,
      replace: 0,
      delete: action === 'delete' ? 1 : 0,
      noop: 0,
    },
  };
}

/**
 * The contract between the frontend and the backend. Fulfilled today by an
 * in-memory mock so the app runs standalone (no server, no AI); a real client
 * (ccp-api) swaps in behind this exact interface later.
 */
export interface ApiClient {
  /** Which backend answers, and whether it is authoritative. The app gates
   * advisory-only admin controls on `authoritative`. */
  serverInfo(): Promise<ServerInfo>;
  listManifests(): Promise<ServiceManifest[]>;
  getInventory(): Promise<Inventory>;
  listRequests(user: string): Promise<ChangeRequest[]>;
  getRequest(id: string): Promise<ChangeRequest | undefined>;
  /** Submit a drafted change. Returns a {@link SubmitResult} so a server-side
   * rejection (freeze / disabled op / out-of-bounds / forbidden) surfaces a
   * reason instead of throwing. */
  submitRequest(draft: ChangeRequest): Promise<SubmitResult>;
  /**
   * Submit a multi-operation CHANGE SET (Phase B) — several operations reviewed and applied
   * as ONE change (a multi-edit on one resource, or one action fanned across many targets),
   * sharing one justification + schedule + approval. Same {@link SubmitResult} contract as
   * {@link submitRequest}: the server validates EVERY item atomically (rejecting the whole
   * set if any fails), computes the STRICTEST-combined requirement, and returns the combined
   * ChangeRequest (its `items` list populated). A one-item draft is equivalent to a single
   * submit — the server normalizes it. Identity/status/approvals are server-computed.
   */
  submitChangeSet(draft: ChangeSetDraft): Promise<SubmitResult>;
  /**
   * Approve a request. The acting user is derived from the session inside the
   * implementation — callers do NOT pass an identity, so a client can never
   * assert who it is. Separation of duties (no self-approval, no double
   * approval, approver/lead only) is enforced here, not just in the UI.
   */
  approveRequest(id: string): Promise<MutationResult>;
  /** Reject a request (actor from session; approver/lead and not the requester). */
  rejectRequest(id: string, reason?: string): Promise<MutationResult>;
  listPendingApprovals(user: User): Promise<ChangeRequest[]>;
  listAllRequests(): Promise<ChangeRequest[]>;
  /**
   * The active project's latest drift status: the classifier's most
   * recently published report, role-projected (paths and counts for every
   * role; values, security evidence and recommendation prose Approver+
   * only — the field-tier table). `null` means NOT CONNECTED — drift
   * monitoring unarmed on this deployment, or no report has ever been
   * published for this project — and is never a stand-in for "no drift".
   * The mock always answers connected (per-flow parity, the same seeded-
   * demo-data doctrine as {@link seedRequests}); the not-connected state is
   * exercised by httpApi's 404/network mapping and by direct render tests.
   */
  getDriftStatus(): Promise<DriftStatus | null>;
  /**
   * Submit a generated drift-fix proposal as a normal portal request — the
   * ONLY way a drift system operation ever reaches the ladder (a manual
   * request can never name one; both clients refuse it in
   * submitRequest/submitChangeSet, mirroring the api's DRIFT_PROPOSAL_REQUIRED
   * refusal). `alsoDigests` batches additional ADOPT proposals into one
   * change-set request — a revert proposal always submits alone. Returns the
   * SAME {@link SubmitResult} contract as {@link submitRequest}, so a
   * server-side rejection (frozen estate, stale/already-submitted proposal, a
   * re-derived eligibility failure) surfaces a reason instead of throwing.
   */
  submitDriftProposal(
    digest: string,
    input: { justification: string; schedule: Schedule; alsoDigests?: string[] },
  ): Promise<SubmitResult>;
  /**
   * "Start drift check" (spec addendum A7 / plan B1): triggers the
   * operator-injected on-demand drift-check workflow for `projectId` — the
   * same bundle-trigger pattern the apply lane already uses (the api never
   * runs terraform itself; it only fires the injected command). Lead/admin
   * only — mirrored here for the button's own disabled state, re-enforced
   * server-side regardless. See {@link DriftCheckResult}.
   */
  startDriftCheck(projectId: string): Promise<DriftCheckResult>;
  /**
   * "Fix the drift" (spec addendum A7 / plan B2): refreshes generated
   * proposals over the CURRENT report on demand. Lead/admin only. See
   * {@link DriftGenerateResult}.
   */
  generateDriftProposals(projectId: string): Promise<DriftGenerateResult>;
  /**
   * C2 — the legitimize front door (spec addendum A6): starts a
   * full-scrutiny, engineer-tier request (`NEEDS_ENGINEER`, ladder
   * `[L2, L3]`) that converges code to a justified emergency
   * security-posture change, instead of reverting it. `digest` names the
   * row's OPEN REVERT proposal (the SAME digest a C1 revert would submit)
   * — legitimize and revert are two resolutions of the same generated
   * evidence; starting one never consumes the other, and both stay visible
   * until the next clean check closes the drift record. Approver/lead
   * only (same rule as revert submit — it concerns live security posture).
   * `justification` must cite the emergency (server-enforced minimum;
   * the UI supplies the template). Same {@link SubmitResult} contract as
   * {@link submitDriftProposal} — the created request is a normal
   * NEEDS_ENGINEER request, never a bundle/apply shortcut.
   */
  legitimizeDriftSecurity(
    digest: string,
    input: { justification: string; schedule: Schedule },
  ): Promise<SubmitResult>;
}

function seedRequests(): ChangeRequest[] {
  const t = (h: number, min: number): string =>
    new Date(Date.UTC(2026, 6, 6, h, min)).toISOString();
  return [
    {
      id: 'seed-applied-01',
      requester: 'dewi',
      teamId: 'platform',
      service: 'cloudwatch',
      operationId: 'cloudwatch-alarm-threshold',
      macd: 'Change',
      targetAddress: 'aws_cloudwatch_metric_alarm.legacy_host',
      params: { alarm: 'aws_cloudwatch_metric_alarm.legacy_host', new_threshold: 85 },
      justification: 'CPU alarm on legacy_host too noisy during month-end BW load; raise 80 → 85.',
      exposure: 'l1_self_service',
      risk: 'LOW',
      status: 'APPLIED',
      approvalsRequired: 1,
      approvals: [{ user: 'rizky', at: t(8, 20) }],
      schedule: { kind: 'now' },
      createdAt: t(8, 10),
      updatedAt: t(8, 31),
      prNumber: 207,
      prUrl: prUrl(207),
      planSummary: {
        resourceChanges: [
          {
            address: 'aws_cloudwatch_metric_alarm.legacy_host',
            type: 'aws_cloudwatch_metric_alarm',
            action: 'update',
            changed: [{ attr: 'threshold', before: '80', after: '85' }],
          },
        ],
        counts: { create: 0, update: 1, replace: 0, delete: 0, noop: 0 },
        recordedAt: t(8, 12),
      },
      events: [
        { at: t(8, 10), type: 'created', label: 'Requested by Dewi', actor: 'dewi' },
        { at: t(8, 11), type: 'pr_opened', label: 'PR #207 opened by ccp[bot]' },
        { at: t(8, 20), type: 'approved', label: 'Approved by Rizky (1/1)', actor: 'rizky' },
        { at: t(8, 31), type: 'applied', label: 'APPLIED — threshold is now 85' },
      ],
    },
    {
      id: 'seed-review-01',
      requester: 'dewi',
      teamId: 'platform',
      service: 'ebs',
      operationId: 'ebs-grow',
      macd: 'Change',
      targetAddress: 'aws_ebs_volume.app01_sdd',
      params: { volume: 'aws_ebs_volume.app01_sdd', new_size_gib: 250 },
      justification: 'Filesystem at 90% on APP01 /dev/sdd; grow 150 → 250 GiB.',
      exposure: 'l1_with_guardrails',
      risk: 'MEDIUM',
      status: 'AWAITING_CODE_REVIEW',
      approvalsRequired: 1,
      approvals: [],
      schedule: { kind: 'now' },
      createdAt: t(9, 40),
      updatedAt: t(9, 44),
      prNumber: 213,
      prUrl: prUrl(213),
      planSummary: {
        resourceChanges: [
          {
            address: 'aws_ebs_volume.app01_sdd',
            type: 'aws_ebs_volume',
            action: 'update',
            changed: [{ attr: 'size', before: '150', after: '250' }],
          },
        ],
        counts: { create: 0, update: 1, replace: 0, delete: 0, noop: 0 },
        recordedAt: t(9, 42),
      },
      events: [
        { at: t(9, 40), type: 'created', label: 'Requested by Dewi', actor: 'dewi' },
        { at: t(9, 41), type: 'pr_opened', label: 'PR #213 opened by ccp[bot]' },
        { at: t(9, 44), type: 'awaiting_review', label: 'Awaiting 1 approval' },
      ],
    },
    {
      id: 'seed-delete-01',
      requester: 'dewi',
      teamId: 'platform',
      service: 'ec2',
      operationId: 'ec2-remove-instance-tag',
      macd: 'Delete',
      targetAddress: 'aws_instance.app01',
      params: { instance: 'aws_instance.app01', tag_key: 'Temporary' },
      justification: 'Remove the leftover "Temporary" tag from APP01 after the migration.',
      exposure: 'l1_with_guardrails',
      risk: 'MEDIUM',
      status: 'AWAITING_CODE_REVIEW',
      approvalsRequired: 2,
      approvals: [{ user: 'rizky', at: t(10, 5) }],
      schedule: { kind: 'now' },
      createdAt: t(10, 0),
      updatedAt: t(10, 5),
      prNumber: 219,
      prUrl: prUrl(219),
      planSummary: {
        resourceChanges: [
          {
            address: 'aws_instance.app01',
            type: 'aws_instance',
            action: 'update',
            changed: [
              {
                attr: 'tags',
                before: '{"Name":"APP01","Temporary":"yes"}',
                after: '{"Name":"APP01"}',
              },
            ],
          },
        ],
        counts: { create: 0, update: 1, replace: 0, delete: 0, noop: 0 },
        recordedAt: t(10, 2),
      },
      events: [
        { at: t(10, 0), type: 'created', label: 'Requested by Dewi', actor: 'dewi' },
        { at: t(10, 1), type: 'pr_opened', label: 'PR #219 opened by ccp[bot]' },
        { at: t(10, 5), type: 'approved', label: 'Approved by Rizky (1/2)', actor: 'rizky' },
      ],
    },
    {
      id: 'seed-sched-01',
      requester: 'putra',
      teamId: 'platform',
      service: 's3',
      operationId: 's3-update-tags',
      macd: 'Change',
      targetAddress: 'aws_s3_bucket.app_backup',
      params: { bucket: 'aws_s3_bucket.app_backup', tags: { CostCenter: 'CostCenter-A' } },
      justification: 'Re-map the app-backup bucket to the Backup cost centre after the split.',
      exposure: 'l1_self_service',
      risk: 'LOW',
      status: 'AWAITING_CODE_REVIEW',
      approvalsRequired: 1,
      approvals: [],
      schedule: { kind: 'window', at: t(22, 0) },
      createdAt: t(11, 0),
      updatedAt: t(11, 2),
      prNumber: 221,
      prUrl: prUrl(221),
      planSummary: {
        resourceChanges: [
          {
            address: 'aws_s3_bucket.app_backup',
            type: 'aws_s3_bucket',
            action: 'update',
            changed: [{ attr: 'tags', before: '{}', after: '{"CostCenter":"CostCenter-A"}' }],
          },
        ],
        counts: { create: 0, update: 1, replace: 0, delete: 0, noop: 0 },
        recordedAt: t(11, 1),
      },
      events: [
        { at: t(11, 0), type: 'created', label: 'Requested by Putra', actor: 'putra' },
        { at: t(11, 1), type: 'pr_opened', label: 'PR #221 opened by ccp[bot]' },
        {
          at: t(11, 2),
          type: 'awaiting_review',
          label: 'Awaiting 1 approval · scheduled for 22:00',
        },
      ],
    },
    {
      // Demo seed: the engineer-track REPLACE — the one case the
      // plan summary exists FOR. The linked PR's plan proves a destroy-and-
      // recreate on a volume; the panel shows what that costs (consequence
      // table) and what else is wired to the address (committed-blocks scan).
      id: 'seed-replace-01',
      requester: 'dewi',
      teamId: 'platform',
      service: 'ebs',
      operationId: 'ebs-set-encrypted',
      macd: 'Change',
      targetAddress: 'aws_ebs_volume.app01_sdb',
      params: { volume: 'aws_ebs_volume.app01_sdb', encrypted: 'true' },
      justification:
        'Encrypt the APP01 install volume to close the unencrypted-disk audit finding.',
      exposure: 'engineer_only',
      risk: 'HIGH',
      status: 'NEEDS_ENGINEER',
      approvalsRequired: 2,
      approvals: [],
      schedule: { kind: 'now' },
      createdAt: t(12, 0),
      updatedAt: t(12, 30),
      prNumber: 224,
      prUrl: prUrl(224),
      planSummary: {
        resourceChanges: [
          {
            address: 'aws_ebs_volume.app01_sdb',
            type: 'aws_ebs_volume',
            action: 'replace',
            forcedBy: ['encrypted'],
            changed: [
              { attr: 'encrypted', before: 'false', after: 'true' },
              { attr: 'id', before: 'vol-0c0c0c0c0c0c0c002', after: '(known after apply)' },
            ],
          },
        ],
        counts: { create: 0, update: 0, replace: 1, delete: 0, noop: 0 },
        recordedAt: t(12, 30),
      },
      events: [
        { at: t(12, 0), type: 'created', label: 'Requested by Dewi', actor: 'dewi' },
        {
          at: t(12, 1),
          type: 'needs_engineer',
          label: 'Routed to an engineer to author and review the Terraform',
        },
        {
          at: t(12, 20),
          type: 'pr_linked',
          label: 'Engineering PR #224 linked by Putra',
          actor: 'putra',
        },
        { at: t(12, 30), type: 'plan_summary', label: 'Terraform plan recorded — replaces 1' },
      ],
    },
  ];
}

/**
 * The mock's deterministic drift snapshot (demo data — the same "fixed
 * seed timestamps" doctrine as {@link seedRequests}: byte-stable across
 * runs, not `Date.now()`-derived, so the staleness/relative-age rendering
 * it exercises is reproducible in tests regardless of when the demo runs).
 * Addresses are real bundled-inventory resources so a "view this resource"
 * jump would resolve. One benign in-place row (adopt-shaped), one
 * watchlisted security row (revert-only — never adoptable, the binding
 * invariant), one row already absorbed by an existing ignore rule.
 */
/**
 * A clearly-synthetic 12-digit placeholder account id for seeded ARNs — the
 * common AWS-documentation placeholder, never this (or any real) estate's
 * own account id. lib/api.ts is scanned by the source-genericity gate like
 * every other hand-authored app source file, so no real account id may
 * appear here even as demo data.
 */
const MOCK_SWEEP_ACCOUNT = '123456789012';

/**
 * The mock's deterministic unmanaged-resource sweep (out-of-band
 * provisioning spec, the SPA surface work item's "mock parity" bullet):
 * one import-eligible instance finding with a payload, one security-family
 * finding (never portal-importable — this is the adversarial case the
 * "no import affordance in the DOM" test proves against), and one
 * payload-withheld finding (secret-battery reason, verbatim per the spec's
 * own pinned text) whose actor lookup found nothing (the "lookup duty
 * still open" path). Fixed seed timestamps and estate-generic naming —
 * the region comes from project config (never a literal), same doctrine
 * as every other seeded artifact in this module — `verify-source-
 * genericity.ts` and `generalization.test.ts` both scan this file.
 */
function seedSweepFindings(): DriftFinding[] {
  const region = config.region;
  return [
    {
      class: 'unmanaged_resource',
      tfType: 'aws_instance',
      name: 'bastion-2',
      service: 'ec2',
      stateful: false,
      securityFamily: false,
      arn: `arn:aws:ec2:${region}:${MOCK_SWEEP_ACCOUNT}:instance/i-0abc123def456789a`,
      liveId: 'i-0abc123def456789a',
      region,
      actor: {
        eventName: 'RunInstances',
        eventTime: '2026-07-19T22:04:11Z',
        who: `arn:aws:sts::${MOCK_SWEEP_ACCOUNT}:assumed-role/break-glass/on-call-engineer`,
        sourceIp: '203.0.113.24',
      },
      importPayload: {
        address: 'aws_instance.oob_bastion_2',
        targetFile: 'oob-adopted.tf',
        importBlock: 'import {\n  to = aws_instance.oob_bastion_2\n  id = "i-0abc123def456789a"\n}\n',
        skeletonHcl:
          'resource "aws_instance" "oob_bastion_2" {\n  ami           = "ami-0abcd1234efgh5678"\n  instance_type = "t3.micro"\n  tags = {\n    Name = "bastion-2"\n  }\n}\n',
      },
      payloadWithheldReason: null,
    },
    {
      class: 'unmanaged_resource',
      tfType: 'aws_iam_role',
      name: 'oob-admin-role',
      service: 'iam',
      stateful: false,
      securityFamily: true,
      arn: `arn:aws:iam::${MOCK_SWEEP_ACCOUNT}:role/oob-admin-role`,
      liveId: 'oob-admin-role',
      region,
      actor: {
        eventName: 'CreateRole',
        eventTime: '2026-07-19T20:11:47Z',
        who: `arn:aws:sts::${MOCK_SWEEP_ACCOUNT}:assumed-role/break-glass/on-call-engineer`,
        sourceIp: '203.0.113.55',
      },
      importPayload: null,
      // Never actually read by classifyFinding (securityFamily wins first,
      // unconditionally — lib/driftEligibility.ts's classifyFinding), but a
      // real finding row can legitimately carry both, so the seed does too.
      payloadWithheldReason: 'type is creation-security — never a candidate for mechanical import',
    },
    {
      class: 'unmanaged_resource',
      tfType: 'aws_db_instance',
      name: 'oob-reporting-db',
      service: 'rds',
      stateful: true,
      securityFamily: false,
      arn: `arn:aws:rds:${region}:${MOCK_SWEEP_ACCOUNT}:db:oob-reporting-db`,
      liveId: 'oob-reporting-db',
      region,
      // No CloudTrail match within the lookup window — the mock's exercise
      // of the "lookup duty still open" path (the CloudTrail actor
      // enrichment work item's own escape hatch), never treated as "no
      // evidence needed."
      actor: null,
      importPayload: null,
      payloadWithheldReason:
        'generated config carries secret-shaped values — import via the kit runbook with secret handling (e.g. ignore_changes on the secret attribute), never through the portal',
    },
  ];
}

/** The mock's deterministic sweep section — wraps {@link seedSweepFindings}
 * with the envelope-level fields every tier sees (capturedAt, region,
 * coverage summary, counts) per the field-tier table. */
function seedDriftSweep(): DriftSweep {
  const findings = seedSweepFindings();
  return {
    method: 'importer-kit discover: 43 per-type listers + resourcegroupstaggingapi family sweep',
    capturedAt: '2026-07-20T03:15:41Z',
    region: config.region,
    findings,
    totalFindings: findings.length,
    ignoredCount: 4,
    coverage: { unrecognizedArnFamilies: { 'arn:aws:sns': 3, 'arn:aws:sqs': 1 } },
  };
}

function seedDriftReport(): DriftReport {
  const sweep = seedDriftSweep();
  return {
    version: 1,
    capturedAt: '2026-07-20T03:17:04Z',
    runId: '16234567890',
    commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3',
    cadenceHours: 6,
    planExitCode: 2,
    counts: {
      drifted: 3,
      security: 1,
      byClass: { benign_inplace: 1, security_posture: 1, oob_deletion: 1 },
      unmanaged: sweep.totalFindings,
    },
    sweep,
    verdicts: [
      {
        address: 'aws_instance.app01',
        type: 'aws_instance',
        actions: ['update'],
        class: 'benign_inplace',
        riskTier: 'low',
        driftEvidence: true,
        changedAttrs: [
          {
            path: 'tags.Owner',
            live: '"bi-team"',
            code: '"platform"',
            sensitive: false,
            liveJson: 'bi-team',
            codeJson: 'platform',
          },
        ],
        forceNewAttrs: [],
        securityHits: [],
        recommendation:
          'In-place, not security-watchlisted, not replacement-class: adopt the live value into code (a no-op change), or revert via the normal apply lane if the console change was unwanted. Read every changed attribute before choosing.',
        neverDo:
          'Never adopt a value you have not read; never use an ignore rule here — it blinds control-plane operations on this attribute.',
        executor: 'Deterministically generated proposal; human review and merge',
      },
      {
        address: 'aws_security_group.apm_agents',
        type: 'aws_security_group',
        actions: ['update'],
        class: 'security_posture',
        riskTier: 'high',
        driftEvidence: true,
        changedAttrs: [
          {
            path: 'ingress[0].cidr_blocks',
            live: '["0.0.0.0/0"]',
            code: '["10.0.0.0/16"]',
            sensitive: false,
            liveJson: ['0.0.0.0/0'],
            codeJson: ['10.0.0.0/16'],
          },
        ],
        forceNewAttrs: [],
        securityHits: [
          {
            path: 'ingress[0].cidr_blocks',
            why: 'network reachability — an ingress rule changed out-of-band',
          },
        ],
        recommendation:
          'A watchlisted security surface changed out-of-band. Capture evidence, then default to reverting the change in the cloud console. Adopting into code requires explicit owner sign-off recorded on the drift record.',
        neverDo:
          'Never silently adopt this into code; never suppress this attribute; never close the drift record without recorded evidence.',
        executor: 'Human review — revert in the console; adopting needs explicit owner sign-off',
      },
      {
        // Drift restore tranche (L29): an out-of-band deletion, seeded over
        // a bundled-inventory address (estate-generic — verify:safety
        // applies) — a resource present in code+state that a console
        // deletion removed, so the plan wants a pure create. driftEvidence
        // true + actions ['create'] + no securityHits ⇒ classifyDrift's
        // restore branch (lib/driftEligibility.ts).
        address: 'aws_flow_log.prod_vpc',
        type: 'aws_flow_log',
        actions: ['create'],
        class: 'oob_deletion',
        riskTier: 'high',
        driftEvidence: true,
        changedAttrs: [],
        forceNewAttrs: [],
        securityHits: [],
        recommendation:
          'This resource no longer exists in the account but is still declared in code — it was deleted out-of-band. Restore re-asserts the code already on main; capture the CloudTrail deletion event before approving, since a deleted flow log is also a security event.',
        neverDo:
          'Never assume the deletion was reviewed just because the plan is clean; never restore without capturing the deletion evidence first.',
        executor: 'Deterministically generated restore proposal; human review and approval',
      },
    ],
    absorbed: [{ address: 'aws_s3_bucket.app_backup', class: 'churn_absorbed', riskTier: 'info' }],
    invisibleToPlan:
      'Out-of-band CREATED resources are invisible to plan-based detection — that coverage relies on a separate account-wide sweep, never this report.',
  };
}

/** Fixed, obviously-synthetic 64-hex digests for the three seeded
 * verdict-sourced proposals — the same "fixed seed timestamps" doctrine as
 * {@link seedDriftReport}: a real digest is sha256 over the proposal's
 * canonical content (server/catalogctl only); the mock never computes one,
 * it just needs a stable, shape-valid key. Keyed by address so
 * {@link seedDriftProposals} stays a straight, defensive lookup instead of
 * assuming array order/count. */
const MOCK_DRIFT_PROPOSAL_DIGEST: Record<string, string> = {
  'aws_instance.app01': 'a1'.repeat(32),
  'aws_security_group.apm_agents': 'b2'.repeat(32),
  // Drift restore tranche (L29).
  'aws_flow_log.prod_vpc': 'c9'.repeat(32),
};

/** The mock's deterministic adopt diff — the runbook's tags pattern,
 * writing the live value into code (the classifier's direction convention:
 * in a drift plan `before` = refreshed live reality). Fixed text, same
 * doctrine as every other seeded artifact in this module. */
const MOCK_DRIFT_ADOPT_DIFF = `--- a/environments/prod/main.tf
+++ b/environments/prod/main.tf
@@ -2,7 +2,7 @@
 resource "aws_instance" "app01" {
   # …
   tags = {
-    Owner = "platform"
+    Owner = "bi-team"
   }
 }
`;

/**
 * The mock's deterministic drift-PROPOSAL simulation — generated over the
 * SAME seeded report through the shared eligibility partition
 * ({@link classifyDrift}), exactly like a real generation pass would from
 * the drifted verdicts {@link seedDriftReport} carries: one adopt proposal
 * (the benign tags row), one revert proposal (the watchlisted SG row), one
 * restore proposal (the deleted flow log row — drift restore tranche,
 * L29). Approver+ only — the mock's own role projection in {@link
 * createMockApiClient}'s getDriftStatus mirrors the api's field-tier rule,
 * never serving this to a Requester. A verdict the partition itself refuses
 * (there are none in the fixed seed today) is simply skipped, matching the
 * generator's own "ungenerable" bucket producing no proposal at all. The
 * restore row's `attrs` comes out empty (non-nil) with zero extra code
 * here — its verdict's own `changedAttrs` is `[]`, matching the real
 * generator's "Attrs: [] (empty, non-nil)" contract for restore for free.
 */
function seedDriftProposals(report: DriftReport): DriftProposal[] {
  const generatedAt = '2026-07-20T03:20:11Z';
  const out: DriftProposal[] = [];
  for (const v of report.verdicts) {
    const { bucket } = classifyDrift(v);
    if (bucket === 'ungenerable') continue;
    const digest = MOCK_DRIFT_PROPOSAL_DIGEST[v.address];
    if (!digest) continue; // defensive: no mapped digest for this address
    const attrs = (v.changedAttrs ?? [])
      .filter((a) => a.liveJson !== undefined)
      .map((a) => ({ address: v.address, path: a.path, liveJson: a.liveJson, codeJson: a.codeJson }));
    out.push({
      digest,
      flavor: bucket,
      status: 'open',
      addresses: [v.address],
      attrCount: attrs.length,
      generatedAt,
      lastSeenReportVersion: report.version,
      diff: bucket === 'adopt' ? MOCK_DRIFT_ADOPT_DIFF : null,
      attrs,
    });
  }
  return out;
}

/** Fixed, obviously-synthetic 64-hex digest for the one import-eligible
 * seeded finding — same "fixed seed timestamps" doctrine as
 * {@link MOCK_DRIFT_PROPOSAL_DIGEST}, keyed by the finding's pinned import
 * address (findings carry no Terraform address of their own to key on). */
const MOCK_DRIFT_IMPORT_DIGEST: Record<string, string> = {
  'aws_instance.oob_bastion_2': 'd4'.repeat(32),
};

/**
 * The mock's deterministic import-PROPOSAL simulation — generated over the
 * SAME seeded sweep through the shared finding partition
 * ({@link classifyFinding}), exactly like a real `catalogctl drift-propose
 * --enable-import` pass would: one import proposal for the one finding that
 * lands in the `import` bucket (the security-family and payload-withheld
 * findings are correctly ungenerable and produce no proposal at all — the
 * SAME "ungenerable bucket ⇒ no proposal" doctrine {@link seedDriftProposals}
 * already follows for verdicts).
 */
function seedImportProposals(sweep: DriftSweep): DriftProposal[] {
  const generatedAt = '2026-07-20T03:21:47Z';
  const out: DriftProposal[] = [];
  for (const f of sweep.findings) {
    const { bucket } = classifyFinding(f);
    if (bucket !== 'import') continue;
    const payload = f.importPayload;
    if (!payload) continue; // defensive: 'import' bucket implies a payload, but never trust that alone
    const digest = MOCK_DRIFT_IMPORT_DIGEST[payload.address];
    if (!digest) continue; // defensive: no mapped digest for this address
    out.push({
      digest,
      flavor: 'import',
      status: 'open',
      addresses: [payload.address],
      attrCount: 0,
      generatedAt,
      lastSeenReportVersion: 1,
      diff: null,
      attrs: [],
      arn: f.arn,
      tfType: f.tfType ?? undefined,
      importPayload: payload,
    });
  }
  return out;
}

/**
 * The mock's role projection for a drift report — mirrors the api's
 * server-side projection (the field-tier table) so mock mode is a faithful
 * stand-in, the same "mirror the authority, don't just gate the UI"
 * discipline {@link createMockApiClient}'s submit path already follows for
 * freeze/disabled-op. A Requester keeps presence (address, type, class,
 * risk, attr paths) but never values or security evidence; Approver/Lead
 * see the report unmodified. Sweep findings get the SAME allowlist
 * treatment, one level down — pinned EXACTLY against the api's own
 * `requesterFindingView` (ccp/api/src/routes/drift.ts):
 * {class, tfType, name, service, securityFamily, importPayloadPresent}
 * only. Notably NOT `stateful` (despite living on the same base row as
 * `service`) — the api's requester view omits it, so this mirrors that
 * omission exactly rather than assuming symmetry with the sibling field.
 * `importPayloadPresent` is COMPUTED here (`importPayload != null`), never
 * copied from a stored field — a real approver+ row carries no such field
 * at all, only the real `importPayload` body.
 */
function projectDriftReportForRole(report: DriftReport, role: Role): DriftReport {
  // A shallow copy even for the unfiltered roles: driftReport is now
  // mutable closure state (startDriftCheck/generateDriftProposals bump
  // capturedAt/version in place), so a caller that snapshotted an earlier
  // getDriftStatus() result must never see it silently change underneath
  // it — every call returns its OWN object, never a live alias.
  if (role !== 'requester') return { ...report };
  return {
    ...report,
    verdicts: report.verdicts.map((v) => ({
      address: v.address,
      type: v.type,
      actions: v.actions,
      class: v.class,
      riskTier: v.riskTier,
      driftEvidence: v.driftEvidence,
      changedAttrs: v.changedAttrs?.map((a) => ({ path: a.path })),
      forceNewAttrs: v.forceNewAttrs,
      // securityHits / recommendation / neverDo / executor: Approver+ only —
      // omitted entirely, never sent as an empty/redacted placeholder.
    })),
    // report.sweep itself (capturedAt/region/totalFindings/ignoredCount/
    // coverage) stays — every tier sees those (the field-tier table's
    // report-level row); only the FINDING rows are narrowed below.
    ...(report.sweep
      ? {
          sweep: {
            ...report.sweep,
            findings: report.sweep.findings.map((f) => ({
              class: f.class,
              tfType: f.tfType,
              name: f.name,
              service: f.service,
              securityFamily: f.securityFamily,
              importPayloadPresent: f.importPayload != null,
              // arn / liveId / region / stateful / actor / importPayload /
              // payloadWithheldReason: Approver+ only — omitted entirely,
              // never sent as an empty/redacted placeholder.
            })),
          },
        }
      : {}),
  };
}

export function createMockApiClient(): ApiClient {
  const requests: ChangeRequest[] = seedRequests();
  /**
   * The next mock PR number: one past the highest already in play, across the
   * seeds AND everything submitted this session — never a hardcoded literal
   * (LD-2: every submission was `const n = 222`, so two live requests in one
   * session both showed "PR #222 awaiting your approval" — a lead's
   * notification bell read as duplicate/corrupted data — and every request's
   * PR link resolved to the same real, unrelated repo PR). The seeded requests
   * already carry distinct numbers (#207-#224); this keeps every later one
   * distinct too.
   */
  const nextPrNumber = (): number => Math.max(0, ...requests.map((r) => r.prNumber ?? 0)) + 1;
  // Mutable, like `requests` above: startDriftCheck bumps `capturedAt`/
  // `version` in place (simulating a triggered check completing) so a
  // re-fetch of the drift page honestly reflects it — the SAME instance
  // getDriftStatus() below serves, never recomputed fresh from the static
  // seed on every read (that would make a "check requested" click
  // invisible).
  const driftReport: DriftReport = seedDriftReport();
  // Mutable, like `requests` above: submitDriftProposal flips a row's status
  // to 'submitted' in place so a re-fetch of the drift page honestly reflects
  // it (never re-derived fresh-as-'open' from the static seed on every read).
  // Derived from the SAME driftReport instance so generateDriftProposals can
  // re-run the partition over it after a startDriftCheck bump. Import
  // proposals ride the SAME array — one flat live surface, exactly like the
  // real store never separates flavors into different collections.
  const driftProposals: DriftProposal[] = [
    ...seedDriftProposals(driftReport),
    ...(driftReport.sweep ? seedImportProposals(driftReport.sweep) : []),
  ];

  return {
    async serverInfo() {
      // Advisory: the mock's stores are client-forgeable, so no admin write
      // flow is a source of truth — every flag stays false (per-flow honesty).
      return { mode: 'mock', capabilities: noCapabilities() };
    },
    async listManifests() {
      return activeManifests();
    },
    async getInventory() {
      return activeInventory();
    },
    async listRequests(user: string) {
      return requests.filter((r) => r.requester === user);
    },
    async getRequest(id: string) {
      return requests.find((r) => r.id === id);
    },
    async listAllRequests() {
      return [...requests];
    },
    async listPendingApprovals(user: User) {
      return requests.filter((r) => r.status === 'AWAITING_CODE_REVIEW' && canApprove(user, r));
    },
    async getDriftStatus(): Promise<DriftStatus | null> {
      const role = getCurrentUser().role;
      const richView = role === 'approver' || role === 'lead';
      return {
        report: projectDriftReportForRole(driftReport, role),
        // proposals[] is approver+ only (field-tier table) — absent entirely
        // for a Requester, never an empty-as-redacted placeholder.
        ...(richView ? { proposals: [...driftProposals] } : {}),
      };
    },
    async startDriftCheck(_projectId: string): Promise<DriftCheckResult> {
      // Mirror the server's fail-closed gates (spec addendum A7 / plan B1),
      // same discipline as every other guarded mutation in this client.
      if (isChangeFrozen()) {
        return {
          ok: false,
          code: 'FROZEN',
          reason: 'Change requests are frozen by an administrator right now.',
        };
      }
      const actor = getCurrentUser();
      if (actor.role !== 'lead' && actor.isAdmin !== true) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          reason: 'Only a lead or an admin can start an on-demand drift check.',
        };
      }
      // Mock parity (drift-portal spec, SPA surface section): the bundled
      // mock simulates the WHOLE pipeline, so a triggered check "completes"
      // immediately — publish a fresh snapshot of the same seeded
      // verdicts, exactly like the next scheduled workflow run would. A
      // real deployment also returns
      // instantly (202 requested) — the report itself lands later, through
      // the ingest PUT when the workflow publishes.
      const at = new Date().toISOString();
      driftReport.capturedAt = at;
      driftReport.version += 1;
      return { ok: true, at };
    },
    async generateDriftProposals(_projectId: string): Promise<DriftGenerateResult> {
      // Generation itself is not gated by the change freeze (spec addendum
      // A7 / plan B2: drift armed → project gates → role → generation
      // armed → pointer exists — no freeze step; it only refreshes
      // proposals, it never submits a request on its own).
      const actor = getCurrentUser();
      if (actor.role !== 'lead' && actor.isAdmin !== true) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          reason: 'Only a lead or an admin can refresh generated drift fixes.',
        };
      }
      // Mock parity: re-run the SAME partition-driven generation pass over
      // the current report — idempotent via digest, exactly like the real
      // non-reentrant runner (re-running over unchanged drift produces zero
      // new rows; an already-open row just has its lastSeenReportVersion
      // bumped, mirroring the reconcile sweep; a submitted/superseded row
      // is left alone).
      const fresh = [
        ...seedDriftProposals(driftReport),
        ...(driftReport.sweep ? seedImportProposals(driftReport.sweep) : []),
      ];
      for (const f of fresh) {
        const existing = driftProposals.find((p) => p.digest === f.digest);
        if (!existing) {
          driftProposals.push(f);
        } else if (existing.status === 'open') {
          existing.lastSeenReportVersion = driftReport.version;
        }
      }
      return { ok: true, reportVersion: driftReport.version };
    },
    async legitimizeDriftSecurity(
      digest: string,
      input: { justification: string; schedule: Schedule },
    ): Promise<SubmitResult> {
      // Mirror the server's fail-closed gates (spec addendum A6), same
      // discipline as submitDriftProposal below.
      if (isChangeFrozen()) {
        return {
          ok: false,
          code: 'FROZEN',
          reason: 'Change requests are frozen by an administrator right now.',
        };
      }
      const actor = getCurrentUser();
      if (actor.role !== 'approver' && actor.role !== 'lead') {
        return {
          ok: false,
          code: 'FORBIDDEN',
          reason: 'Only an approver or a lead can start a legitimize request for security-posture drift.',
        };
      }
      // :digest must name an OPEN, revert-flavored proposal (the same row
      // C1 would submit) — legitimize is C2's resolution of the same
      // generated evidence, never a separate proposal of its own.
      const proposal = driftProposals.find((p) => p.digest === digest);
      if (!proposal || proposal.status !== 'open' || proposal.flavor !== 'revert') {
        return {
          ok: false,
          code: 'FORBIDDEN',
          reason:
            'This security drift row no longer has an open revert proposal to legitimize — it may already be resolved or superseded.',
        };
      }
      // Eligibility re-derived from the STORED report, never trusted from
      // the proposal's own flavor label alone (the same doctrine
      // classifyDrift/isSecurityPosture enforce everywhere else): every
      // verdict covering this proposal's addresses must still be
      // security-posture.
      const coveredVerdicts = driftReport.verdicts.filter((v) => proposal.addresses.includes(v.address));
      if (coveredVerdicts.length === 0 || !coveredVerdicts.every((v) => isSecurityPosture(v))) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          reason: 'Re-derived eligibility failed: not every covered verdict is still security-posture drift.',
        };
      }
      const op = SYSTEM_OPERATIONS.find((o) => o.id === SYSTEM_DRIFT_LEGITIMIZE)!;
      const req = combinedRequirement([{ exposure: op.exposure, forcesReplace: false }]);
      const now = new Date().toISOString();
      const reqId = crypto.randomUUID();
      const submitted: ChangeRequest = {
        id: reqId,
        requester: actor.id,
        teamId: actor.teamId,
        service: op.service,
        operationId: op.id,
        macd: op.macd,
        targetAddress: proposal.addresses[0]!,
        params: {
          attrs: proposal.attrs,
          proposalDigest: proposal.digest,
          reportVersion: proposal.lastSeenReportVersion,
        },
        justification: input.justification,
        exposure: op.exposure,
        risk: resolveRisk(op),
        status: 'NEEDS_ENGINEER',
        approvalsRequired: req.approvalsRequired,
        approvals: [],
        schedule: input.schedule,
        createdAt: now,
        updatedAt: now,
        events: [
          {
            at: now,
            type: 'created',
            label: `Legitimize security-posture drift (auto-drafted; submitted by ${actor.name})`,
            actor: actor.id,
          },
          {
            at: now,
            type: 'needs_engineer',
            label: 'Routed to an engineer to author and review the Terraform',
          },
          {
            at: now,
            type: 'origin',
            label: `Origin: drift legitimize request from revert proposal ${digest}`,
            actor: 'system:drift-propose',
          },
        ],
      };
      requests.unshift(submitted);
      // The revert proposal is deliberately NOT consumed by a legitimize
      // request — it stays 'open' so C1 (revert) remains a live option
      // until the next clean check closes the drift record (addendum A6:
      // both resolutions stay visible; adjudication is the approver's).
      return { ok: true, request: submitted };
    },
    async submitDriftProposal(
      digest: string,
      input: { justification: string; schedule: Schedule; alsoDigests?: string[] },
    ): Promise<SubmitResult> {
      // Mirror the server's fail-closed gates so the mock is a faithful
      // stand-in — same discipline as submitRequest/submitChangeSet below.
      if (isChangeFrozen()) {
        return {
          ok: false,
          code: 'FROZEN',
          reason: 'Change requests are frozen by an administrator right now.',
        };
      }
      const actor = getCurrentUser();
      const primary = driftProposals.find((p) => p.digest === digest);
      if (!primary || primary.status !== 'open') {
        return {
          ok: false,
          code: 'FORBIDDEN',
          reason: 'This drift proposal is no longer open — it may already be submitted or superseded.',
        };
      }
      // Role gate (drift-portal spec, extended by the out-of-band
      // provisioning spec for import and the drift restore tranche for
      // restore, L29): adopt ⇒ any bound member; revert ⇒ approver/lead
      // only (it re-imposes code onto live security posture); import ⇒
      // approver/lead only (adopting an unknown actor's resource into
      // legitimacy is a posture judgment, the revert rule, not the adopt
      // rule); restore ⇒ approver/lead only (re-creating infrastructure is
      // the SAME posture judgment). A revert never batches; import/restore
      // each batch ONLY with their own flavor (never mixed with
      // adopt/revert/each other) — the every-item-same-op rule, generalized
      // below via `row.flavor !== primary.flavor`.
      if (primary.flavor === 'revert' || primary.flavor === 'import' || primary.flavor === 'restore') {
        if (actor.role !== 'approver' && actor.role !== 'lead') {
          return {
            ok: false,
            code: 'FORBIDDEN',
            reason:
              primary.flavor === 'revert'
                ? 'Only an approver or a lead can submit a security-posture revert.'
                : primary.flavor === 'import'
                  ? 'Only an approver or a lead can submit an unmanaged-resource import.'
                  : 'Only an approver or a lead can submit a drift restore.',
          };
        }
        if (primary.flavor === 'revert' && input.alsoDigests && input.alsoDigests.length > 0) {
          return { ok: false, code: 'FORBIDDEN', reason: 'A revert proposal always submits alone.' };
        }
      }
      const alsoRows: DriftProposal[] = [];
      for (const d of input.alsoDigests ?? []) {
        const row = driftProposals.find((p) => p.digest === d);
        if (!row || row.status !== 'open' || row.flavor !== primary.flavor) {
          return {
            ok: false,
            code: 'FORBIDDEN',
            reason: 'One of the batched drift proposals is no longer open.',
          };
        }
        alsoRows.push(row);
      }
      const rows = [primary, ...alsoRows];
      const isSet = rows.length > 1;

      // Import re-derives its pinned `finding` from the CURRENT stored
      // sweep, not from anything cached on the proposal row (the same
      // "current stored data, not the pinned proposal's own say-so"
      // doctrine legitimizeDriftSecurity already applies above) — a finding
      // the sweep no longer carries at all cannot be submitted.
      if (primary.flavor === 'import') {
        for (const row of rows) {
          const current = driftReport.sweep?.findings.find((f) => f.arn === row.arn);
          if (!current) {
            return {
              ok: false,
              code: 'FORBIDDEN',
              reason: 'This import proposal’s finding is no longer present in the current drift report.',
            };
          }
        }
      }

      const opId =
        primary.flavor === 'adopt'
          ? SYSTEM_DRIFT_ADOPT
          : primary.flavor === 'revert'
            ? SYSTEM_DRIFT_REVERT
            : primary.flavor === 'restore'
              ? SYSTEM_DRIFT_RESTORE
              : SYSTEM_DRIFT_IMPORT;
      const op = SYSTEM_OPERATIONS.find((o) => o.id === opId)!;
      const items: ChangeSetItem[] = rows.map((row) => ({
        operationId: opId,
        service: op.service,
        macd: op.macd,
        targetAddress: row.addresses[0]!,
        // Import pins {finding, importPayload, diff: null, proposalDigest,
        // reportVersion} (the out-of-band provisioning spec's submit-side
        // "pinned params" contract) — a different shape from adopt/revert's
        // {attrs, proposalDigest, reportVersion}, since an import carries no
        // attribute edits at all, only a whole new resource block.
        params:
          primary.flavor === 'import'
            ? {
                finding: driftReport.sweep?.findings.find((f) => f.arn === row.arn),
                importPayload: row.importPayload,
                diff: null,
                proposalDigest: row.digest,
                reportVersion: row.lastSeenReportVersion,
              }
            : { attrs: row.attrs, proposalDigest: row.digest, reportVersion: row.lastSeenReportVersion },
        exposure: op.exposure,
        reviewTier: reviewTierForExposure(op.exposure),
      }));
      const primaryItem = items[0]!;
      const req = combinedRequirement(items.map((it) => ({ exposure: it.exposure, forcesReplace: false })));
      const now = new Date().toISOString();
      const createdLabel = isSet
        ? `Drift ${primary.flavor} proposal — ${items.length} resources (auto-generated; submitted by ${actor.name})`
        : `Drift ${primary.flavor} proposal (auto-generated; submitted by ${actor.name})`;
      const reqId = crypto.randomUUID();
      const submitted: ChangeRequest = {
        id: reqId,
        requester: actor.id,
        teamId: actor.teamId,
        service: primaryItem.service!,
        operationId: primaryItem.operationId,
        macd: primaryItem.macd!,
        targetAddress: primaryItem.targetAddress,
        params: primaryItem.params,
        justification: input.justification,
        exposure: primaryItem.exposure!,
        risk: resolveRisk(op),
        status: 'AWAITING_CODE_REVIEW',
        approvalsRequired: req.approvalsRequired,
        approvals: [],
        ...(isSet ? { items } : {}),
        schedule: input.schedule,
        createdAt: now,
        updatedAt: now,
        events: [
          { at: now, type: 'created', label: createdLabel, actor: actor.id },
          {
            at: now,
            type: 'awaiting_review',
            label: `Awaiting ${req.approvalsRequired} approval${req.approvalsRequired > 1 ? 's' : ''}`,
          },
          {
            at: now,
            type: 'origin',
            label: `Origin: drift proposal ${digest}${isSet ? ` (+${items.length - 1} more)` : ''}`,
            actor: 'system:drift-propose',
          },
        ],
      };
      requests.unshift(submitted);
      for (const row of rows) {
        row.status = 'submitted';
        row.requestId = reqId;
      }
      return { ok: true, request: submitted };
    },
    async submitRequest(draft: ChangeRequest): Promise<SubmitResult> {
      // Mirror the server's fail-closed submit gates (requests.ts:69-74) so the mock
      // is a faithful stand-in: a frozen estate or a disabled op is rejected by the
      // authority itself, not only pre-checked in the UI.
      if (isChangeFrozen()) {
        return {
          ok: false,
          code: 'FROZEN',
          reason: 'Change requests are frozen by an administrator right now.',
        };
      }
      if (isOpDisabled(draft.operationId)) {
        return {
          ok: false,
          code: 'OP_DISABLED',
          reason: 'This operation has been disabled by an administrator.',
        };
      }
      // The direct lane is closed for a drift system op — submitDriftProposal
      // is the ONLY door in, mirroring the api's DRIFT_PROPOSAL_REQUIRED
      // refusal on POST /requests (a client can never hand-craft a drift
      // request with arbitrary params; pinned proposal content is the only
      // source).
      if (isSystemDriftOp(draft.operationId)) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          reason: 'Drift-fix requests are submitted only from the Drift page, never a manual request.',
        };
      }
      const now = new Date().toISOString();
      const op = getOperation(draft.operationId, bundledManifests);
      // Pin the generated diff to the request now: approvers render this
      // exact artifact, not one regenerated later from mutable inventory. Redacted.
      // When the op is not in the bundled catalog (the generic "provision any
      // type" path builds a synthetic create op the manifests don't carry), the
      // client has already rendered the same deterministic skeleton — preserve
      // it, exactly as the real server would pin the authored artifact. A truly
      // artifact-less op-less request (beyond-catalog) still pins nothing.
      const pinnedDiff = op ? generateDiff(op, draft.params, inventory) : draft.pinnedDiff;
      // Single source of truth: the editable approval policy (via the operation's
      // effective risk + MACD), never a hardcoded rule. Falls back to the draft's
      // resolved risk if the operation is not in the bundled manifests. Computed
      // BEFORE the engineer-only branch below so the handoff carries a real
      // target too (OP-1: the mock engineer-tier branch used to spread the
      // draft's own approvalsRequired/approvals — both undefined pre-submit —
      // so a request that promised "2 senior approvals" on the form landed on
      // RequestDetail reading "0 of 0 approvals — awaiting 0 reviewers").
      const approvalsRequired = op
        ? approvalsRequiredFor(op)
        : draft.risk === 'HIGH' || draft.macd === 'Delete'
          ? 2
          : 1;
      // Engineer-only requests are tracked for an engineer to author + review.
      if (draft.exposure === 'engineer_only' || draft.status === 'NEEDS_ENGINEER') {
        const handoff: ChangeRequest = {
          ...draft,
          status: 'NEEDS_ENGINEER',
          pinnedDiff,
          approvalsRequired,
          approvals: [],
          updatedAt: now,
          events: [
            ...draft.events,
            {
              at: now,
              type: 'needs_engineer',
              label: 'Routed to an engineer to author and review the Terraform',
            },
          ],
        };
        requests.unshift(handoff);
        return { ok: true, request: handoff };
      }
      const schedule = draft.schedule ?? { kind: 'now' };
      const n = nextPrNumber();
      const scheduleNote = schedule.kind === 'window' ? ` · scheduled for ${schedule.at}` : '';
      const submitted: ChangeRequest = {
        ...draft,
        status: 'AWAITING_CODE_REVIEW',
        approvalsRequired,
        approvals: [],
        schedule,
        pinnedDiff,
        updatedAt: now,
        prNumber: n,
        prUrl: prUrl(n),
        planSummary: { ...mockPlanSummaryFor(op, draft.macd, draft.targetAddress), recordedAt: now },
        events: [
          ...draft.events,
          { at: now, type: 'submitted', label: 'Submitted — Terraform generated, PR opened' },
          { at: now, type: 'pr_opened', label: `PR #${n} opened by ccp[bot]` },
          {
            at: now,
            type: 'awaiting_review',
            label: `Awaiting ${approvalsRequired} approval${approvalsRequired > 1 ? 's' : ''}${scheduleNote}`,
          },
        ],
      };
      requests.unshift(submitted);
      return { ok: true, request: submitted };
    },
    async submitChangeSet(draft: ChangeSetDraft): Promise<SubmitResult> {
      // Faithful stand-in for the server's Phase-B submit: mirror the fail-closed gates and
      // the STRICTEST-combined requirement so the standalone app behaves like the authority.
      if (isChangeFrozen()) {
        return {
          ok: false,
          code: 'FROZEN',
          reason: 'Change requests are frozen by an administrator right now.',
        };
      }
      // ATOMIC: resolve + gate EVERY item before building anything — one bad item rejects
      // the whole set and nothing is added.
      const resolved: Array<{ op: ManifestOperation; item: ChangeSetDraft['items'][number] }> = [];
      for (const it of draft.items) {
        // The direct lane is closed for a drift system op — checked BEFORE
        // getOperation's catalog-miss branch below, since getOperation now
        // resolves these ids too (so an op-not-found check alone would miss
        // them). Mirrors the api's DRIFT_PROPOSAL_REQUIRED refusal.
        if (isSystemDriftOp(it.operationId)) {
          return {
            ok: false,
            code: 'FORBIDDEN',
            reason: 'Drift-fix requests are submitted only from the Drift page, never a manual request.',
          };
        }
        const op = getOperation(it.operationId, bundledManifests);
        if (!op)
          return {
            ok: false,
            code: 'FORBIDDEN',
            reason: 'The change set names an operation that is not in the catalog.',
          };
        if (isOpDisabled(op.id))
          return {
            ok: false,
            code: 'OP_DISABLED',
            reason: 'One of these operations has been disabled by an administrator.',
          };
        resolved.push({ op, item: it });
      }
      const now = new Date().toISOString();
      const req = combinedRequirement(
        resolved.map((r) => ({ exposure: r.op.exposure, forcesReplace: r.op.forcesReplace })),
      );
      const isEngineer = req.tier === 'engineer';
      const status: ChangeRequest['status'] = isEngineer
        ? 'NEEDS_ENGINEER'
        : 'AWAITING_CODE_REVIEW';
      const items: ChangeSetItem[] = resolved.map((r) => ({
        operationId: r.op.id,
        service: r.op.service,
        macd: r.op.macd,
        targetAddress: r.item.targetAddress,
        params: r.item.params,
        exposure: r.op.exposure,
        reviewTier: reviewTierForExposure(r.op.exposure),
        ...(r.item.replaceConfirmation ? { replaceConfirmation: r.item.replaceConfirmation } : {}),
      }));
      const primary = resolved[0]!;
      const isSet = resolved.length > 1;
      const pinnedDiff = resolved
        .map((r) => generateDiff(r.op, r.item.params, inventory))
        .join('\n\n');
      // One combined plan summary — every item's change, and the summed counts.
      const counts = { create: 0, update: 0, replace: 0, delete: 0, noop: 0 };
      const resourceChanges = resolved.map((r) => {
        const s = mockPlanSummaryFor(r.op, r.op.macd, r.item.targetAddress);
        for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] += s.counts[k];
        return s.resourceChanges[0]!;
      });
      const actor = getCurrentUser();
      const n = nextPrNumber();
      const submitted: ChangeRequest = {
        id: crypto.randomUUID(),
        requester: actor.id,
        teamId: actor.teamId,
        service: primary.op.service,
        operationId: primary.op.id,
        macd: primary.op.macd,
        targetAddress: primary.item.targetAddress,
        params: primary.item.params,
        justification: draft.justification,
        exposure: primary.op.exposure,
        risk: resolveRisk(primary.op),
        status,
        approvalsRequired: req.approvalsRequired,
        approvals: [],
        schedule: draft.schedule,
        pinnedDiff,
        ...(isSet ? { items } : {}),
        // Single-item set: keep the top-level confirmation, matching the server's normalize.
        ...(!isSet && primary.item.replaceConfirmation
          ? { replaceConfirmation: primary.item.replaceConfirmation }
          : {}),
        createdAt: now,
        updatedAt: now,
        prNumber: n,
        prUrl: prUrl(n),
        planSummary: { resourceChanges, counts, recordedAt: now },
        events: [
          {
            at: now,
            type: 'created',
            label: `Request drafted in the portal${isSet ? ` — ${resolved.length} changes` : ''}`,
            actor: actor.id,
          },
          isEngineer
            ? {
                at: now,
                type: 'needs_engineer',
                label: 'Routed to an engineer to author and review the Terraform',
              }
            : { at: now, type: 'pr_opened', label: `PR #${n} opened by ccp[bot]` },
          ...(isEngineer
            ? []
            : [
                {
                  at: now,
                  type: 'awaiting_review',
                  label: `Awaiting ${req.approvalsRequired} approval${req.approvalsRequired > 1 ? 's' : ''}`,
                },
              ]),
        ],
      };
      requests.unshift(submitted);
      return { ok: true, request: submitted };
    },
    async approveRequest(id: string): Promise<MutationResult> {
      const req = requests.find((r) => r.id === id);
      if (!req) return { ok: false, reason: 'No such request.' };
      // The acting identity comes from the session, never from the caller.
      const actor = getCurrentUser();
      if (!actor || actor.id === 'anonymous') return { ok: false, reason: 'Not signed in.' };
      // Separation of duties, re-checked at the authority — not just in the UI.
      if (actor.role !== 'approver' && actor.role !== 'lead') {
        return { ok: false, reason: 'Only approvers and leads can approve.' };
      }
      if (req.requester === actor.id) {
        return { ok: false, reason: 'You cannot approve your own request.' };
      }
      if ((req.approvals ?? []).some((a) => a.user === actor.id)) {
        return { ok: false, reason: 'You have already approved this request.' };
      }
      if (req.status !== 'AWAITING_CODE_REVIEW') {
        return { ok: false, reason: 'This request is not awaiting approval.' };
      }
      const now = new Date().toISOString();
      const approvals = [...(req.approvals ?? []), { user: actor.id, at: now }];
      // Tighten-only re-gate: if the operation was reclassified to a
      // higher risk (or the policy tightened) after submit, the request needs the
      // higher count now — a later downgrade can never lower an open request's bar.
      const op = getOperation(req.operationId, bundledManifests);
      const currentRequired = op ? approvalsRequiredFor(op) : (req.approvalsRequired ?? 1);
      const required = Math.max(req.approvalsRequired ?? 1, currentRequired);
      req.approvalsRequired = required;
      req.approvals = approvals;
      req.updatedAt = now;
      req.events = [
        ...req.events,
        {
          at: now,
          type: 'approved',
          label: `Approved by ${userName(actor.id)} (${approvals.length}/${required})`,
          actor: actor.id,
        },
      ];
      if (approvals.length >= required) {
        // Mock parity: the mock has no window-enforcement state machine to
        // expire/eagerly-infeasibility-check/freeze-hold against, same "no mock
        // equivalent" posture as cooling-off above (httpApi.ts's
        // cancelRequest/rewindowRequest doc comments) — a windowed mock request
        // always lands AWAITING_DEPLOY_APPROVAL and stays there; it never
        // reaches WINDOW_EXPIRED. api-mode is where scheduling is enforced.
        const schedule = req.schedule ?? { kind: 'now' };
        if (schedule.kind === 'window') {
          req.status = 'AWAITING_DEPLOY_APPROVAL';
          req.events.push({
            at: now,
            type: 'scheduled',
            label: `Fully approved — scheduled to apply at ${schedule.at}`,
          });
        } else {
          req.status = 'APPLIED';
          req.events.push({ at: now, type: 'applied', label: 'Fully approved — APPLIED' });
        }
      }
      return { ok: true, request: req };
    },
    async rejectRequest(id: string, reason?: string): Promise<MutationResult> {
      const req = requests.find((r) => r.id === id);
      if (!req) return { ok: false, reason: 'No such request.' };
      const actor = getCurrentUser();
      if (!actor || actor.id === 'anonymous') return { ok: false, reason: 'Not signed in.' };
      if (actor.role !== 'approver' && actor.role !== 'lead') {
        return { ok: false, reason: 'Only approvers and leads can reject.' };
      }
      if (req.requester === actor.id) {
        return { ok: false, reason: 'You cannot reject your own request.' };
      }
      const now = new Date().toISOString();
      req.status = 'REJECTED';
      req.updatedAt = now;
      const suffix = reason && reason.trim() ? ` — ${reason.trim()}` : '';
      req.events = [
        ...req.events,
        {
          at: now,
          type: 'rejected',
          label: `Rejected by ${userName(actor.id)}${suffix}`,
          actor: actor.id,
        },
      ];
      return { ok: true, request: req };
    },
  };
}

/**
 * The shared client singleton. Defaults to the in-memory mock so the app runs
 * fully standalone (no backend, no network, no AI — the standalone invariant). When
 * `VITE_API_BASE` is set at build time, it swaps in the real ccp-api HTTP
 * client behind this exact `ApiClient` seam (ADVISORY → AUTHORITATIVE).
 * Catalog reads in api mode: the bundled default estate stays build-time; a
 * NON-default account's manifests/inventory come from ccp-api's data plane
 * at runtime (no rebuild to onboard an account), with these injected getters
 * as the vendored-or-empty fallback. The request lifecycle + admin go to the
 * server as before.
 */
const httpClient: HttpApiClient | null = isApiMode
  ? createHttpApiClient(import.meta.env.VITE_API_BASE ?? '', {
      getManifests: activeManifests,
      getInventory: activeInventory,
    })
  : null;

export const api: ApiClient = httpClient ?? createMockApiClient();

/**
 * The session-capable client when running against ccp-api, else null. The
 * base {@link ApiClient} surface has no identity methods (login / TOTP / me /
 * logout) — those live only on the HTTP client — so LoginPage drives the server
 * session through THIS, and falls back to the local PBKDF2 session (lib/auth) when
 * it's null (mock mode). One construction, shared with {@link api}.
 */
export const authClient: HttpApiClient | null = httpClient;

/**
 * Server-served block data for a NON-default account in api mode (chunk
 * 'index' = the address→chunk map; anything else = one chunk file). Kept HERE —
 * behind the allowlisted API seam — so lib/blockSource can read the server's
 * data plane without ever holding a network primitive itself (the standalone
 * invariant). Mock mode (and any failure) resolves null, and the caller falls
 * back to its vendored-or-empty rule — never another estate's blocks.
 */
export async function fetchServerBlockChunk(
  projectId: string,
  chunk: string,
): Promise<Record<string, unknown> | null> {
  if (!httpClient) return null;
  try {
    return await httpClient.getProjectBlocksChunk(projectId, chunk);
  } catch {
    return null;
  }
}
