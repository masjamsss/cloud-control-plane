import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { AppEnv } from '../appEnv';
import type { ChainHeadItem, DriftPointerItem, DriftProposalItem, DriftReportItem, ProjectItem, ProjectUploadTokenItem, RequestItem, RequestSetItem } from '../store/schema';
import {
  DRIFT_PROPOSAL_SK_PREFIX,
  DRIFT_VERSION_SK_PREFIX,
  chainHead,
  driftPointerKey,
  driftProposalKey,
  driftVersionKey,
  projectKey,
  requestCollectionGsi,
  requestKey,
  uploadTokenKey,
} from '../store/schema';
import { ApiError, apiError } from '../errors';

/**
 * `DRIFT_DISARMED` is deliberately NOT registered in `errors.ts`'s `ERRORS`
 * taxonomy map — it rides the same inline-literal pattern already
 * established by `BUNDLE_DISARMED` (routes/requests.ts, the structurally
 * identical off-by-default-lane refusal): the taxonomy map is a hand-pinned
 * enumeration (`test/errors.test.ts` asserts its exact per-status code set),
 * and registering another off-by-default-lane code there would touch that
 * committed test. The wire contract is identical either way: `409
 * {code:'DRIFT_DISARMED', reason}`.
 */
const DRIFT_DISARMED_REASON = 'Drift monitoring is not armed on this deployment (CCP_DRIFT unset).';
/** OOB provisioning-import spec §6/§9 — the import-flavor submit's OWN,
 * narrower arming reason: same code (`DRIFT_DISARMED`), a distinct reason
 * naming `CCP_DRIFT_IMPORT` specifically (the B1 precedent already
 * established by the drift-check/drift-generate 409s above — "no new error
 * taxonomy entry"). */
const DRIFT_IMPORT_DISARMED_REASON = 'Drift import is not armed on this deployment (CCP_DRIFT_IMPORT unset).';
/** L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2.5/§3) — the
 * restore-flavor submit's own, narrower arming reason, the exact
 * `DRIFT_IMPORT_DISARMED_REASON` precedent: same code (`DRIFT_DISARMED`), a
 * distinct reason naming `CCP_DRIFT_RESTORE` specifically. */
const DRIFT_RESTORE_DISARMED_REASON = 'Drift restore is not armed on this deployment (CCP_DRIFT_RESTORE unset).';
import { checkSubmitRateLimit, checkUploadRateLimit } from '../middleware/rateLimit';
import { isBoundToProject, roleFor } from '../projects';
import { verifyPassword } from '../auth/credentials';
import { toUser } from '../auth/account';
import type { TransactWrite } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import { recordIn, record, transactWithAudit } from '../domain/audit';
import type { DriftFinding, DriftVerdict } from '../domain/drift';
import {
  DriftEnvelope,
  MAX_DRIFT_BYTES,
  driftArmed,
  driftKeep,
  duplicateFindingKey,
  duplicateVerdictAddress,
  envelopeDigestOf,
  isSecurityPosture,
  parseStoredEnvelope,
  readDriftReport,
  removeDriftReport,
  rerunDriftRedaction,
  summarizeReport,
  writeDriftReport,
} from '../domain/drift';
import {
  addressEligibleFor,
  classifyFinding,
  driftGenConfig,
  driftImportArmed,
  driftRestoreArmed,
  findCurrentFinding,
  foldVerdictsByAddress,
  isValidProposalDigest,
  readDriftProposalBody,
  realDriftGenSteps,
  scheduleDriftGeneration,
} from '../domain/driftProposals';
import type { DriftProposalDoc } from '../domain/driftProposals';
import { driftCheckConfig, realDriftCheckSteps, runDriftCheck } from '../domain/driftCheck';
import { SYSTEM_DRIFT_ADOPT, SYSTEM_DRIFT_IMPORT, SYSTEM_DRIFT_LEGITIMIZE, SYSTEM_DRIFT_RESTORE, SYSTEM_DRIFT_REVERT } from '../domain/systemOps';
import { getOperation } from '../manifests';
import { initialStatusFor, ladderFor, reviewTierFor } from '../domain/exposure';
import { isFrozen, loadPolicy, resolveRisk } from '../domain/config';
import { computeFeasibility } from '../domain/feasibility';
import { validateSchedule } from '../domain/schedule';
import { ScheduleSchema, toChangeRequest } from './requests';
import { nowIso, nowMs } from '../clock';

/** B1/B2 (spec addendum A7): the two operator-role gates share this
 * predicate — lead or admin, the apply-route precedent
 * (`routes/requests.ts` `POST /:id/apply`). */
function isLeadOrAdmin(account: { isAdmin: boolean }, role: ReturnType<typeof roleFor>): boolean {
  return role === 'lead' || account.isAdmin === true;
}

/**
 * Drift telemetry: the token-lane report upload (WI-2 of
 * docs/superpowers/specs/2026-07-20-ccp-drift-portal.md) plus the
 * role-projected serve. Mounted INSIDE `projectRoutes()` beside
 * `projectDataRoutes` — `PUT /:id/drift` is the ONE additional token-authed
 * carve-out (see `middleware/session.ts#isUploadTokenLane`), everything else
 * (GET) rides the normal session+membership group gate.
 *
 * `PUT /:id/drift` is byte-for-byte the projectData upload discipline (same
 * token regexes, same per-tokenId rate limit before the argon2id verify,
 * same store lookup / expiry / wrong-project checks, one generic 401) with
 * ONE extra step prepended: the `CCP_DRIFT` arming gate (§4.1). Unlike
 * project data there is no admin-activation step — the served pointer
 * advances in the SAME audited transaction as the stage, because telemetry
 * describes reality and can trigger nothing by itself (spec §3.1).
 *
 * `GET /:id/drift` is a serve endpoint (target-bound session, not archived —
 * the same rule as `projectData.ts#serveActive`) that additionally role-
 * projects its response: a requester sees presence, taxonomy, and attribute
 * PATHS only; approver/lead see the full post-redaction row, including
 * values and security evidence (spec §4.2).
 */

const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const TOKEN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/; // ulid
const TOKEN_SECRET = /^[A-Za-z0-9_-]{20,100}$/; // 32 random bytes, base64url

/**
 * POST /:id/drift/proposals/:digest/submit body (spec §4.3) — identity-free:
 * everything besides justification/schedule/alsoDigests (params, ladder,
 * risk, targetAddress, …) is server-computed from the pinned proposal,
 * never accepted from the body (the same mass-assignment discipline as
 * requests.ts's SubmitBody). `alsoDigests` batches additional SAME-FLAVOR
 * proposals into one change-set — adopt+adopt, or (OOB provisioning spec
 * §6) import+import — (§4.3/§7's blast-radius mitigation); a revert
 * proposal always submits alone. Capped at 99 so primary+alsoDigests never
 * exceeds requests.ts's MAX_CHANGE_SET_ITEMS (100) — one shared practical
 * ceiling on how large one reviewed change may be.
 */
const SubmitProposalBody = z.object({
  justification: z.string().min(10),
  schedule: ScheduleSchema,
  alsoDigests: z.array(z.string().refine(isValidProposalDigest, 'not a valid proposal digest')).max(99).optional(),
});

/**
 * POST /:id/drift/security/:digest/legitimize body (C2, spec addendum A6):
 * identity-free like SubmitProposalBody, but `justification` requires a
 * MUCH higher bar (min 40, not 10) — it must actually cite the emergency
 * (the UI provides the template with the CloudTrail-investigation duty).
 * No `alsoDigests`: legitimize is never batched, one security digest at a
 * time.
 */
const LegitimizeBody = z.object({
  justification: z.string().min(40),
  schedule: ScheduleSchema,
});

/** Statuses whose repo CI is legitimate — identical to projectData's
 * UPLOADABLE (only a trusted/ready project has a trusted producer). */
const UPLOADABLE = new Set<ProjectItem['status']>(['trusted', 'ready']);

async function loadProject(store: AppEnv['Variables']['store'], id: string): Promise<ProjectItem | null> {
  if (!PROJECT_ID.test(id)) return null;
  const k = projectKey(id);
  return (await store.get(k.PK, k.SK)) as ProjectItem | null;
}

async function listDriftVersions(store: AppEnv['Variables']['store'], id: string): Promise<DriftReportItem[]> {
  return (await store.query(`PROJECT#${id}`, DRIFT_VERSION_SK_PREFIX)) as DriftReportItem[];
}

/** Best-effort retention (spec §3.1): delete rows + files for every version
 * beyond the newest `keep`. Never touches the pointer — it always names the
 * LATEST version, which retention never removes. Not audited (routine
 * janitorial cleanup, not a reviewable action — same posture as no-audit-on-read). */
async function pruneDriftVersions(store: AppEnv['Variables']['store'], dataRoot: string, id: string, keep: number): Promise<void> {
  const rows = await listDriftVersions(store, id); // ascending by version (SK order)
  if (rows.length <= keep) return;
  const stale = rows.slice(0, rows.length - keep);
  for (const row of stale) {
    await store.delete(row.PK, row.SK);
    removeDriftReport(dataRoot, id, row.version);
  }
}

/** requester-tier verdict projection (spec §4.2 field-tier table): presence
 * and taxonomy WITHOUT values — address/type/class/riskTier/actions plus
 * attribute PATHS only. Approver/lead get the full stored (post-redaction) row. */
function requesterVerdictView(v: DriftVerdict): Record<string, unknown> {
  return {
    address: v.address,
    type: v.type,
    class: v.class,
    riskTier: v.riskTier,
    actions: v.actions,
    ...(v.changedAttrs !== undefined ? { changedAttrs: v.changedAttrs.map((a) => ({ path: a.path })) } : {}),
  };
}

/** requester-tier FINDING projection (OOB provisioning spec §3.3 field-tier
 * table) — taxonomy and PRESENCE without identifiers or evidence:
 * `tfType`/`name`/`service`/`class`/`securityFamily` plus whether an import
 * payload exists, never the raw `arn`/`liveId`/`actor`/`importPayload` body
 * or `payloadWithheldReason` detail. Approver/lead get the full stored
 * (post-redaction) row, unprojected — the same richView-gets-everything
 * rule {@link requesterVerdictView} documents for verdicts. */
function requesterFindingView(f: DriftFinding): Record<string, unknown> {
  return {
    class: f.class,
    tfType: f.tfType,
    name: f.name,
    service: f.service,
    securityFamily: f.securityFamily,
    importPayloadPresent: f.importPayload != null,
  };
}

/** `proposals[]` (spec §4.2, WI-6) — approver+ only, so this is never called
 * for a requester's projection. Merges the row's metadata with the stored
 * body's diff/attrs (the pinned verdict subset stays server-side — the GET
 * verdict rows above already carry the full post-redaction values for this
 * role). Excludes `superseded` rows: the live surface, not the archive
 * (superseded rows are retained per §3.2's retention rule, not served here). */
async function listRichProposals(store: AppEnv['Variables']['store'], dataRoot: string, id: string): Promise<Array<Record<string, unknown>>> {
  const rows = (await store.query(`PROJECT#${id}`, DRIFT_PROPOSAL_SK_PREFIX)) as DriftProposalItem[];
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.status === 'superseded') continue;
    const body = readDriftProposalBody(dataRoot, id, row.digest);
    out.push({
      digest: row.digest,
      flavor: row.flavor,
      status: row.status,
      addresses: row.addresses,
      attrCount: row.attrCount,
      generatedAt: row.generatedAt,
      lastSeenReportVersion: row.lastSeenReportVersion,
      ...(row.requestId !== undefined ? { requestId: row.requestId } : {}),
      diff: body?.diff ?? null,
      attrs: body?.attrs ?? [],
      // OOB provisioning spec §5.1 — import-only, additive: the pinned
      // identity + reviewed bytes generation produced. Absent for
      // adopt/revert (body.importPayload is never set for those flavors).
      ...(body?.importPayload !== undefined ? { importPayload: body.importPayload } : {}),
    });
  }
  return out;
}

export function driftRoutes(dataRoot: string): Hono<AppEnv> {
  const p = new Hono<AppEnv>();

  /* ── PUT /:id/drift — the token-authed CI drift upload (§4.1) ────────── */
  p.put('/:id/drift', async (c) => {
    const store = c.get('store');
    const id = c.req.param('id');

    // 1. ARMING gate — first (deploy-inert on merge, the loop.ts/bundle.ts
    //    invariant): an unconfigured deployment refuses before any token or
    //    argon2 work.
    if (!driftArmed()) return c.json({ code: 'DRIFT_DISARMED', reason: DRIFT_DISARMED_REASON }, 409);

    // 2. TOKEN GATE — byte-for-byte the projectData discipline
    //    (routes/projectData.ts PUT /:id/data): same regexes, same
    //    per-tokenId rate limit BEFORE the argon2id verify, same store
    //    lookup / expiry / wrong-project checks, one generic 401 (no
    //    enumeration). The SAME per-project upload token the data lane
    //    mints — its power is describing reality to the portal (data OR
    //    drift), nothing else; no new credential kind is introduced.
    const auth = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{20,100})$/.exec(auth);
    if (!m || !TOKEN_ID.test(m[1]!) || !TOKEN_SECRET.test(m[2]!)) return apiError(c, 'UPLOAD_TOKEN_INVALID');
    const [, tokenId, secret] = m;
    if (!PROJECT_ID.test(id)) return apiError(c, 'UPLOAD_TOKEN_INVALID');
    const rate = checkUploadRateLimit(tokenId!);
    if (!rate.ok) return apiError(c, 'RATE_LIMITED', { retryAfter: rate.retryAfterSeconds });
    const tKey = uploadTokenKey(id, tokenId!);
    const token = (await store.get(tKey.PK, tKey.SK)) as ProjectUploadTokenItem | null;
    if (!token || token.projectId !== id) return apiError(c, 'UPLOAD_TOKEN_INVALID');
    if (Date.parse(token.expiresAt) <= nowMs()) return apiError(c, 'UPLOAD_TOKEN_INVALID');
    if (!(await verifyPassword(token.secretHash, secret!))) return apiError(c, 'UPLOAD_TOKEN_INVALID');

    // 3. Project state gate.
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!UPLOADABLE.has(project.status) || project.archived) return apiError(c, 'STATE_CONFLICT');

    // 4. SIZE CAP before parsing — Content-Length first (refuse unread), then
    //    the actual byte length (a chunked body carries no length header).
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DRIFT_BYTES) {
      return apiError(c, 'UPLOAD_TOO_LARGE', { maxBytes: MAX_DRIFT_BYTES });
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_DRIFT_BYTES) {
      return apiError(c, 'UPLOAD_TOO_LARGE', { maxBytes: MAX_DRIFT_BYTES });
    }

    // 5. Parse + tolerant zod validate, then bind projectId to :id (like a digest binding).
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return apiError(c, 'VALIDATION_FAILED', { field: 'body', problem: 'not valid JSON' });
    }
    const parsed = DriftEnvelope.safeParse(raw);
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', { field: 'body', problem: 'not a ccp.drift/v1 envelope' });
    if (parsed.data.projectId !== id) {
      return apiError(c, 'VALIDATION_FAILED', { field: 'projectId', problem: 'must equal the :id in the path' });
    }
    // F6/A8 ingest hardening: a duplicate-address envelope could hide a
    // security twin behind a later benign row for the SAME address if
    // anything ever last-wins-folded it — refused outright here, rather
    // than silently keeping only one row. The tolerant-parse doctrine
    // (§2.1) covers unknown FIELDS, not ambiguous ADDRESSES — no honest
    // classifier emits duplicates (one verdict per resource_changes entry).
    const dupAddress = duplicateVerdictAddress(parsed.data.report.verdicts);
    if (dupAddress !== null) {
      return apiError(c, 'VALIDATION_FAILED', { field: 'report.verdicts', problem: 'duplicate address' });
    }
    // OOB provisioning spec §3.2 rule 2: the finding-keyspace twin of the
    // duplicate-address refusal above — two findings sharing an `arn` (or,
    // when arn is null, the same `tfType`+`liveId`) could hide one's import
    // payload/actor evidence behind the other's. No sweep ⇒ nothing to check.
    if (parsed.data.sweep) {
      const dupFinding = duplicateFindingKey(parsed.data.sweep.findings);
      if (dupFinding !== null) {
        return apiError(c, 'VALIDATION_FAILED', { field: 'sweep.findings', problem: 'duplicate finding key' });
      }
    }

    // 6. REDACTION RE-RUN — the server stores its own redaction output.
    const { envelope: stored, warnings } = rerunDriftRedaction(parsed.data);
    const envelopeDigest = envelopeDigestOf(stored);
    const counts = summarizeReport(stored.report, stored.sweep);

    // 7/8. DEDUPE + STAGE. F10 (LOW, concurrent-dedupe race): the dedupe
    //    check now runs INSIDE the allocation retry loop, re-read fresh on
    //    EVERY attempt — a concurrent identical upload that loses the
    //    version-row race (attempt 0 ⇒ CHAIN_CONTENTION) must see the
    //    WINNER's just-staged version on its retry and dedupe against it,
    //    never stage a second, duplicate version. (This also fixes the
    //    stale-`currentPointer` rollback bug the old pre-loop-single-read
    //    had: a retry's rollback now restores the pointer value THAT
    //    ATTEMPT actually observed, not a snapshot from before a
    //    concurrent winner moved it.) Otherwise stage as the next version +
    //    advance the pointer in the SAME audited transaction (no separate
    //    activation step, unlike project data). ROW-FIRST allocation:
    //    winning the version row's `ifNotExists` put IS the version claim
    //    (one retry on CHAIN_CONTENTION, exactly the projectData loop).
    const pKeyObj = driftPointerKey(id);
    const uploadedVia = `upload-token:${tokenId}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const currentPointer = (await store.get(pKeyObj.PK, pKeyObj.SK)) as DriftPointerItem | null;
      if (currentPointer) {
        const latestKey = driftVersionKey(id, currentPointer.version);
        const latestRow = (await store.get(latestKey.PK, latestKey.SK)) as DriftReportItem | null;
        if (latestRow && latestRow.envelopeDigest === envelopeDigest) {
          return c.json({ version: latestRow.version, deduplicated: true }, 200);
        }
      }
      const existing = await listDriftVersions(store, id);
      const version = (existing.length > 0 ? existing[existing.length - 1]!.version : 0) + 1;
      const versionItem: DriftReportItem = {
        ...driftVersionKey(id, version),
        projectId: id,
        version,
        uploadedAt: nowIso(),
        uploadedVia,
        envelopeDigest,
        capturedAt: stored.capturedAt,
        runId: stored.runId,
        commit: stored.commit,
        cadenceHours: stored.cadenceHours,
        planExitCode: stored.planExitCode,
        counts,
      };
      const pointerItem: DriftPointerItem = {
        ...pKeyObj,
        version,
        capturedAt: stored.capturedAt,
        planExitCode: stored.planExitCode,
        driftedCount: counts.drifted,
        securityCount: counts.security,
        unmanagedCount: counts.unmanaged,
      };
      try {
        // Audit to the TARGET project's chain — this lane has no acting
        // scope (a Bearer token, not a session), same rule as project-data-upload.
        await transactWithAudit(
          store,
          id,
          [
            { kind: 'put', item: versionItem as never, ifNotExists: true },
            { kind: 'put', item: pointerItem as never },
          ],
          {
            action: 'drift-report-upload',
            actor: uploadedVia,
            targetType: 'project',
            targetId: id,
            after: { version, envelopeDigest, planExitCode: stored.planExitCode, counts },
          },
        );
      } catch (e) {
        // A lost version race surfaces as chain contention — re-read the
        // tail and try the next number.
        if (e instanceof ApiError && e.code === 'CHAIN_CONTENTION' && attempt === 0) continue;
        throw e;
      }
      try {
        await writeDriftReport(dataRoot, id, version, stored);
      } catch (e) {
        // Nothing half-exists: undo the row AND the pointer advance together.
        await store.delete(versionItem.PK, versionItem.SK);
        if (currentPointer) await store.put(currentPointer as never);
        else await store.delete(pKeyObj.PK, pKeyObj.SK);
        throw e;
      }
      if (warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[ccp:drift] ${id} v${version}: ${warnings.join(' ')}`);
      }
      await pruneDriftVersions(store, dataRoot, id, driftKeep());

      // §6.3: schedule proposal generation — fire-and-forget (never awaited),
      // so the CI PUT never blocks on a git clone; a generation failure never
      // un-stages the report already committed above (fail-open, slice 2).
      // Off by default: driftGenConfig() is null unless CCP_DRIFT_PROPOSALS
      // + CCP_DRIFT_GEN_CMD + CCP_GIT_REMOTE are ALL set (§10).
      const genCfg = driftGenConfig();
      if (genCfg) {
        scheduleDriftGeneration({ store, dataRoot, steps: realDriftGenSteps(genCfg) }, id, version);
      }

      return c.json({ version }, 201);
    }
    return apiError(c, 'STATE_CONFLICT');
  });

  /* ── GET /:id/drift — status + role-projected verdicts (§4.2) ────────── */
  p.get('/:id/drift', async (c) => {
    const store = c.get('store');
    const account = c.get('account')!;
    // A bare Context (no path generic) types param() as possibly-undefined;
    // '' fails the PROJECT_ID shape check in loadProject → 404, fail closed.
    const id = c.req.param('id') ?? '';
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    // The caller must hold a binding ON THE TARGET project (":id" — not
    // merely the acting scope the group gate already checked), the
    // serve-endpoint rule (projectData.ts#serveActive).
    if (!isBoundToProject(account, id)) return apiError(c, 'PROJECT_SCOPE');
    if (project.archived) return c.json({ code: 'NOT_FOUND', reason: 'This project is archived.' }, 404);

    // connected:false ⇔ drift disarmed OR no report ever stored (§4.2) —
    // never a 409/403: presence is honesty, not a gated capability.
    if (!driftArmed()) return c.json({ connected: false });

    const pKeyObj = driftPointerKey(id);
    const pointer = (await store.get(pKeyObj.PK, pKeyObj.SK)) as DriftPointerItem | null;
    if (!pointer) return c.json({ connected: false });

    const rawText = readDriftReport(dataRoot, id, pointer.version);
    const parsed = rawText === null ? null : parseStoredEnvelope(rawText);
    if (parsed === null) {
      // Fail closed, never a partial render (§4.2 invariant 10) — logged so
      // an operator notices the stored file went missing or stopped parsing.
      // eslint-disable-next-line no-console
      console.error(`[ccp:drift] ${id} v${pointer.version}: stored report missing or fails schema validation on read`);
      return c.json({ connected: true, report: null });
    }

    const vKey = driftVersionKey(id, pointer.version);
    const versionRow = (await store.get(vKey.PK, vKey.SK)) as DriftReportItem | null;
    const counts = versionRow?.counts ?? summarizeReport(parsed.report, parsed.sweep);

    // Role tier resolved on the TARGET project (":id"), not the acting
    // scope — an account's authority over THIS estate governs what it sees
    // about it. Fails closed toward the restricted view for anything that
    // is not explicitly approver/lead.
    const role = roleFor(account, id);
    const richView = role === 'approver' || role === 'lead';
    const verdicts = richView ? parsed.report.verdicts : parsed.report.verdicts.map(requesterVerdictView);
    // OOB provisioning spec §3.3: `sweep` joins the field-tier table.
    // `null` (not omitted) when the envelope carries no sweep section —
    // distinct from "swept, zero findings" (spec §4's SPA copy leans on
    // exactly this null-vs-empty-object distinction: "not swept" vs "no
    // unmanaged resources"). Summary fields (method/capturedAt/region/
    // totalFindings/ignoredCount/coverage) are the SAME for every role —
    // only `findings[]` rows are role-projected, richView unprojected
    // (verbatim, like verdicts above) vs requester's presence-only view.
    const sweep = parsed.sweep
      ? {
          method: parsed.sweep.method,
          capturedAt: parsed.sweep.capturedAt,
          region: parsed.sweep.region,
          totalFindings: parsed.sweep.totalFindings ?? parsed.sweep.findings.length,
          ignoredCount: parsed.sweep.ignoredCount,
          coverage: parsed.sweep.coverage,
          findings: richView ? parsed.sweep.findings : parsed.sweep.findings.map(requesterFindingView),
        }
      : null;

    return c.json({
      connected: true,
      report: {
        version: pointer.version,
        capturedAt: parsed.capturedAt,
        runId: parsed.runId,
        commit: parsed.commit,
        cadenceHours: parsed.cadenceHours,
        planExitCode: parsed.planExitCode,
        counts,
        verdicts,
        absorbed: parsed.report.absorbed,
        invisibleToPlan: parsed.report.invisible_to_plan,
        sweep,
      },
      // proposals[] — approver+ only (spec §4.2 field-tier table, WI-6).
      ...(richView ? { proposals: await listRichProposals(store, dataRoot, id) } : {}),
    });
  });

  /* ── POST /:id/drift/proposals/:digest/submit — the ONLY door into a drift
   * request (§4.3, WI-6; extended by OOB provisioning-import spec §6/WI-S6
   * for the `import` flavor and by the 2026-07-20-drift-restore-tranche
   * plan's L29 (register 0009) for the `restore` flavor — no new route, no
   * new error code either time). Server-side, in order: drift armed →
   * import additionally requires CCP_DRIFT_IMPORT, restore additionally
   * requires CCP_DRIFT_RESTORE (409 DRIFT_DISARMED, flavor-naming reason
   * either way) → the proposal (+ every batched alsoDigests proposal,
   * SAME-FLAVOR-only: adopt+adopt, import+import, or restore+restore, revert
   * never batches) exists, is 'open', and is fresh (lastSeenReportVersion ==
   * the served pointer's version, else 409 DRIFT_PROPOSAL_STALE) →
   * eligibility RE-DERIVED from the STORED report — verdicts for
   * adopt/revert/restore, `sweep.findings` (by arn/type+id) for import —
   * never the proposal's own claim (§8 enforcement point 2; any mismatch ⇒
   * 422 DRIFT_NOT_ADOPTABLE) → build the request entirely server-side from
   * the pinned skeleton(s)/CURRENT finding (client input is justification +
   * schedule + alsoDigests ONLY) → the normal submit internals (freeze,
   * submit rate limit, ladder derivation, feasibility snapshot, audit) →
   * mark every submitted proposal row `submitted{requestId}` in the SAME
   * atomic transact as the request (so a lost race is caught, never a
   * silent double-submit), plus a best-effort per-digest
   * `drift-proposal-submitted` evidence event alongside the standard
   * `request-submit` audit (§4.6). ── */
  p.post('/:id/drift/proposals/:digest/submit', async (c) => {
    const store = c.get('store');
    const account = c.get('account')!;
    const id = c.req.param('id') ?? '';
    const digest = c.req.param('digest') ?? '';

    // 1. ARMING — first, same doctrine as PUT.
    if (!driftArmed()) return c.json({ code: 'DRIFT_DISARMED', reason: DRIFT_DISARMED_REASON }, 409);

    // 2. Project + TARGET-bound membership (the write/serve rule; mirrors GET).
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!isBoundToProject(account, id)) return apiError(c, 'PROJECT_SCOPE');
    if (project.archived) return c.json({ code: 'NOT_FOUND', reason: 'This project is archived.' }, 404);

    // 3. The primary proposal must exist (a malformed/unknown digest is a
    //    404, distinct from a real-but-stale row, which is 409 below).
    if (!isValidProposalDigest(digest)) return c.json({ code: 'NOT_FOUND', reason: 'No such drift proposal.' }, 404);
    const primaryKey = driftProposalKey(id, digest);
    const primary = (await store.get(primaryKey.PK, primaryKey.SK)) as DriftProposalItem | null;
    if (!primary) return c.json({ code: 'NOT_FOUND', reason: 'No such drift proposal.' }, 404);

    // 3b. IMPORT ARMING (OOB spec §6/§9) — flavor-specific, once the primary
    //     row's own flavor is known: `CCP_DRIFT_IMPORT=1` in addition to
    //     the top-level arming step 1 already passed. Same code, distinct
    //     reason (the B1 precedent) — never gates adopt/revert/restore.
    if (primary.flavor === 'import' && !driftImportArmed()) {
      return c.json({ code: 'DRIFT_DISARMED', reason: DRIFT_IMPORT_DISARMED_REASON }, 409);
    }

    // 3c. RESTORE ARMING (L29, register 0009, 2026-07-20-drift-restore-
    //     tranche.md §2.5/§3) — the exact 3b precedent, once the primary
    //     row's own flavor is known: `CCP_DRIFT_RESTORE=1` in addition to
    //     the top-level arming step 1 already passed. Same code, distinct
    //     reason — never gates adopt/revert/import.
    if (primary.flavor === 'restore' && !driftRestoreArmed()) {
      return c.json({ code: 'DRIFT_DISARMED', reason: DRIFT_RESTORE_DISARMED_REASON }, 409);
    }

    // 4. Body.
    const parsedBody = SubmitProposalBody.safeParse(await c.req.json().catch(() => null));
    if (!parsedBody.success) return apiError(c, 'VALIDATION_FAILED');
    const { justification, schedule: scheduleInput, alsoDigests } = parsedBody.data;
    const allDigests = [digest, ...(alsoDigests ?? [])];
    if (new Set(allDigests).size !== allDigests.length) return apiError(c, 'VALIDATION_FAILED'); // no duplicates

    // 5. ROLE (§4.3, extended by OOB spec §6 and L29 §2.5): adopt ⇒ any
    //    bound member (membership already proven by #2 — a defined role IS
    //    proof); revert, import, AND restore ⇒ approver/lead only
    //    ("adopting an unknown actor's resource into legitimacy is a
    //    posture judgment — the revert rule, not the adopt rule"; restoring
    //    infrastructure joins the same posture-judgment tier). A revert
    //    proposal always submits alone, never batched; import and restore
    //    MAY batch (same-flavor-only, enforced at step 6 below — the §7
    //    blast-radius mitigation extended to both).
    const role = roleFor(account, id);
    if (primary.flavor === 'revert' || primary.flavor === 'import' || primary.flavor === 'restore') {
      if (role !== 'approver' && role !== 'lead') return apiError(c, 'FORBIDDEN_ROLE');
    }
    if (primary.flavor === 'revert' && alsoDigests && alsoDigests.length > 0) return apiError(c, 'VALIDATION_FAILED');

    // 6. Load every batched row and check FRESHNESS against the served
    //    pointer: 'open' and lastSeenReportVersion == pointer.version, else
    //    a proposal from a stale snapshot is never submittable (§4.3). A
    //    batch is SAME-FLAVOR-only (adopt+adopt, OOB spec §6's
    //    import+import, or L29 §2.5's restore+restore — "mixing flavors in
    //    one request stays refused, preserving the gate's every-item-same-op
    //    rule"); revert's alsoDigests was already refused above, so this
    //    loop never runs for revert.
    const rows: DriftProposalItem[] = [primary];
    for (const d of alsoDigests ?? []) {
      const k = driftProposalKey(id, d);
      const row = (await store.get(k.PK, k.SK)) as DriftProposalItem | null;
      if (!row) return c.json({ code: 'NOT_FOUND', reason: 'No such drift proposal.' }, 404);
      if (row.flavor !== primary.flavor) return apiError(c, 'VALIDATION_FAILED'); // batch is same-flavor-only
      rows.push(row);
    }
    const isSet = rows.length > 1;

    const pointerKeyObj = driftPointerKey(id);
    const pointer = (await store.get(pointerKeyObj.PK, pointerKeyObj.SK)) as DriftPointerItem | null;
    if (!pointer) return apiError(c, 'DRIFT_PROPOSAL_STALE'); // no report at all — nothing can be "current"
    for (const row of rows) {
      if (row.status !== 'open' || row.lastSeenReportVersion !== pointer.version) {
        return apiError(c, 'DRIFT_PROPOSAL_STALE');
      }
    }

    // 7. ELIGIBILITY RE-DERIVED from the STORED report, never the proposal's
    //    own claim (§8 enforcement point 2 — the authoritative server-side
    //    gate: a forged/relabeled adopt over a security verdict, or an
    //    import over a since-flagged-security-family finding, is refused
    //    here even if the generator or the row were tampered).
    const rawText = readDriftReport(dataRoot, id, pointer.version);
    const report = rawText === null ? null : parseStoredEnvelope(rawText);
    if (report === null) return apiError(c, 'DRIFT_NOT_ADOPTABLE');

    // 8. The pinned skeleton(s)/bodies — params are SERVER-AUTHORED from the
    //    stored body, never client-supplied (§4.4); read once, used by BOTH
    //    the eligibility re-derivation below (import needs the body's own
    //    pinned identity to look the CURRENT finding up) and the pinned-
    //    params build.
    const bodies = rows.map((row) => readDriftProposalBody(dataRoot, id, row.digest));
    if (bodies.some((b) => b === null)) return apiError(c, 'DRIFT_NOT_ADOPTABLE'); // body missing — fail closed

    // Verdict-address eligibility (adopt/revert/restore) vs finding
    // eligibility (import, OOB spec §5.3 screen 2) — a proposal batch is
    // same-flavor-only (step 6), so exactly one branch below applies to
    // every row in `rows`.
    let verdictsByAddress: Map<string, DriftVerdict[]> | null = null;
    const currentFindings: DriftFinding[] = [];
    if (primary.flavor === 'import') {
      const sweepFindings = report.sweep?.findings ?? [];
      for (let i = 0; i < rows.length; i++) {
        const body = bodies[i] as DriftProposalDoc;
        const payload = body.importPayload;
        if (!payload) return apiError(c, 'DRIFT_NOT_ADOPTABLE'); // malformed stored body — fail closed
        const current = findCurrentFinding(sweepFindings, { arn: payload.arn, tfType: payload.tfType, liveId: payload.liveId });
        // "finding still present (by arn/type+id), not flagged securityFamily,
        // payload intact" (§5.3 screen 2) — classifyFinding checks all three
        // at once; a vanished/re-flagged/payload-withheld finding is refused.
        if (!current || classifyFinding(current).bucket !== 'import') return apiError(c, 'DRIFT_NOT_ADOPTABLE');
        currentFindings.push(current);
      }
    } else {
      // F6/A8: folded per address (never a last-wins `Map`) — an address is
      // eligible for a row's flavor only if it has >=1 verdict AND EVERY
      // verdict for it classifies to that flavor; a duplicate-address
      // envelope's security twin can never hide behind a benign one here.
      verdictsByAddress = foldVerdictsByAddress(report.report.verdicts);
      for (const row of rows) {
        // row.flavor is 'adopt' | 'revert' | 'restore' here — step 6's
        // same-flavor-only batching guarantees every row shares
        // primary.flavor, and this whole branch is reached only when
        // primary.flavor !== 'import'. `addressEligibleFor` (§6.2/L29 §2.5)
        // is already generic over `DriftBucket` — restore needed no new
        // branch here, only the type it re-derives against widening.
        const flavor = row.flavor as 'adopt' | 'revert' | 'restore';
        for (const addr of row.addresses) {
          if (!addressEligibleFor(verdictsByAddress, addr, flavor)) return apiError(c, 'DRIFT_NOT_ADOPTABLE');
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
    const op = getOperation(opId)!; // always resolvable — manifests.ts#getOperation (WI-6/WI-S6)
    const tier = reviewTierFor(op.exposure);
    // F1(a)/A2 — the pinned params contract, per item. adopt/revert/restore
    // (L29 §2.5 — restore rides the EXISTING non-import shape verbatim, zero
    // param-builder changes beyond the opId map above): {attrs, verdicts,
    // diff, proposalDigest, reportVersion} — `verdicts` are THIS item's
    // addresses' rows from the step-7 re-check above (the CURRENT stored
    // report, never the proposal body's frozen copy — enforcement point 3
    // receives exactly what point 2 just verified); `diff` is the reviewed
    // edit bytes for adopt (evidence only, never byte-compared at the gate),
    // null for revert (§6.4 — no edit) and restore (L29 §2.2 — no edit
    // either; `body.diff` is already null on a restore body, so this falls
    // out for free); `attrs` is `skeletonItem.params.attrs ?? []`, which for
    // restore is always `[]` (§2.2 — a bare re-assert, no attribute edits).
    // import (OOB spec §5.1/§6): {finding, importPayload, diff:null,
    // proposalDigest, reportVersion} — `finding` is the CURRENT stored sweep
    // row just re-verified above (playing exactly `verdicts`' role);
    // `importPayload` (the {address, targetFile, importBlock, skeletonHcl}
    // shape drift-edit's digest recompute reads) is the ORIGINAL,
    // digest-pinned bytes from the stored body — never re-derived from the
    // current finding, exactly like `diff: body.diff` is never re-derived
    // for adopt (the digest was computed from THESE bytes at generation
    // time; the freshness gate at step 6 guarantees they still match the
    // current finding's own payload, since a changed payload would be a new
    // digest).
    const items: RequestSetItem[] = rows.map((row, i) => {
      const body = bodies[i] as DriftProposalDoc;
      const skeletonItem = body.requestSkeleton.items[0]!;
      if (primary.flavor === 'import') {
        const finding = currentFindings[i]!;
        const payload = body.importPayload!; // guaranteed non-null — checked in the eligibility loop above
        return {
          operationId: op.id,
          service: op.service,
          macd: op.macd,
          targetAddress: skeletonItem.targetAddress,
          params: {
            finding,
            importPayload: { address: skeletonItem.targetAddress, targetFile: payload.targetFile, importBlock: payload.importBlock, skeletonHcl: payload.skeletonHcl },
            diff: null,
            proposalDigest: row.digest,
            reportVersion: row.lastSeenReportVersion,
          },
          exposure: op.exposure,
          reviewTier: tier,
        };
      }
      const itemVerdicts = row.addresses.flatMap((addr) => verdictsByAddress!.get(addr) ?? []);
      return {
        operationId: op.id,
        service: op.service,
        macd: op.macd,
        targetAddress: skeletonItem.targetAddress,
        // reportVersion is the FRESH, just-verified-equal-to-pointer version —
        // not the frozen body's own copy (catalogctl's Go zero value at
        // generation time; the api is the one that pins this, per §6.1).
        params: {
          attrs: skeletonItem.params.attrs ?? [],
          verdicts: itemVerdicts,
          diff: body.diff,
          proposalDigest: row.digest,
          reportVersion: row.lastSeenReportVersion,
        },
        exposure: op.exposure,
        reviewTier: tier,
      };
    });
    const primaryItem = items[0]!;

    // 9. THE NORMAL SUBMIT INTERNALS (§4.3) — same gates, same order as
    //    routes/requests.ts's POST /requests.
    if (await isFrozen(store, id)) return apiError(c, 'GLOBAL_FREEZE');
    if (!(await checkSubmitRateLimit(store, id, account.id)).ok) return apiError(c, 'RATE_LIMITED');

    const scheduleResult = validateSchedule(scheduleInput, nowMs());
    if (!scheduleResult.ok) return apiError(c, scheduleResult.code);
    const schedule = scheduleResult.schedule;

    const ladder = ladderFor(tier, false); // forcesReplace is structurally false for all four drift ops this route handles (§4.4/OOB spec §6/L29 §2.5)
    const approvalsRequired = ladder.length;
    const feasibility = await computeFeasibility(store, id, ladder, account.id);
    const { risk, version: riskOverrideVersion } = await resolveRisk(store, id, op);
    const { version: policyVersion } = await loadPolicy(store, id);

    const reqId = ulid();
    const now = nowIso();
    // isSet is only ever true for adopt, import, or restore (revert never
    // batches, step 5/6 above) — `primary.flavor` names the right verb
    // either way.
    const createdLabel = isSet
      ? `Drift ${primary.flavor} proposal — ${items.length} resources (auto-generated; submitted by ${account.displayName})`
      : `Drift ${primary.flavor} proposal (auto-generated; submitted by ${account.displayName})`;
    const reqItem: RequestItem = {
      ...requestKey(id, reqId),
      id: reqId,
      requestUlid: reqId,
      requester: account.id,
      projectId: id,
      teamId: toUser(account, id).teamId,
      // Top-level fields mirror the PRIMARY item (items[0]), same convention
      // as every other change set (routes/requests.ts).
      service: primaryItem.service,
      operationId: primaryItem.operationId,
      macd: primaryItem.macd,
      targetAddress: primaryItem.targetAddress,
      params: primaryItem.params,
      justification,
      exposure: primaryItem.exposure,
      reviewTier: tier,
      risk,
      status: initialStatusFor(tier), // always AWAITING_CODE_REVIEW — guardrails, never engineer
      approvalsRequired,
      approvals: [],
      ...(isSet ? { items } : {}),
      schedule,
      createdAt: now,
      updatedAt: now,
      events: [
        { at: now, type: 'created', label: createdLabel, actor: account.id },
        { at: now, type: 'awaiting_review', label: `Awaiting ${approvalsRequired} approval${approvalsRequired > 1 ? 's' : ''}` },
        {
          at: now,
          type: 'origin',
          label: `Origin: drift proposal ${digest}${isSet ? ` (+${items.length - 1} more)` : ''}`,
          actor: 'system:drift-propose',
        },
      ],
      policyVersion,
      riskOverrideVersion,
      ...feasibility,
      GSI1PK: requestCollectionGsi(id),
      GSI1SK: reqId,
    };

    // The request PUT and EVERY batched proposal's submitted-flip ride ONE
    // atomic transact — a lost race (someone else submitted the same
    // proposal in between) aborts the WHOLE thing, never a half-created
    // request. `ifEquals: status=='open'` is each proposal's own dedupe
    // guard, exactly the doctrine requests.ts's approve handler documents
    // for why it hand-rolls this loop instead of transactWithAudit: a
    // dedupe-condition failure must be told apart from chain contention.
    const domainWrites: TransactWrite[] = [
      { kind: 'put', item: reqItem as never, ifNotExists: true },
      ...rows.map(
        (row): TransactWrite => ({
          kind: 'update',
          pk: row.PK,
          sk: row.SK,
          set: { status: 'submitted', requestId: reqId },
          ifEquals: { attr: 'status', value: 'open' },
        }),
      ),
    ];
    const entry = {
      action: 'request-submit',
      actor: account.id,
      targetType: 'request',
      targetId: reqId,
      requestId: reqId,
      after: {
        status: reqItem.status,
        approvalsRequired,
        risk,
        exposure: primaryItem.exposure,
        reviewTier: tier,
        origin: { kind: 'drift-proposal', digest, alsoDigests: alsoDigests ?? [] },
        ...feasibility,
      },
    };

    const hKey = chainHead(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
      const { writes: auditWrites } = recordIn(id, head, entry);
      try {
        await store.transact([...domainWrites, ...auditWrites]);
        break;
      } catch (e) {
        if (e instanceof ConditionError) {
          if (attempt === 0) {
            const fresh = await Promise.all(rows.map((row) => store.get(row.PK, row.SK)));
            const stillOpen = fresh.every((f) => (f as DriftProposalItem | null)?.status === 'open');
            if (!stillOpen) return apiError(c, 'DRIFT_PROPOSAL_STALE'); // a real race, not chain contention
            continue; // chain contention → retry once against the fresh head
          }
          throw new ApiError('CHAIN_CONTENTION');
        }
        throw e;
      }
    }

    // Best-effort per-digest evidence event ALONGSIDE the standard
    // request-submit audit above (§4.6) — never blocks or fails the
    // response; the request already committed atomically.
    for (const row of rows) {
      try {
        await record(store, id, {
          action: 'drift-proposal-submitted',
          actor: account.id,
          targetType: 'drift-proposal',
          targetId: row.digest,
          requestId: reqId,
          after: { digest: row.digest, flavor: row.flavor, requestId: reqId },
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[ccp:drift] ${id}: drift-proposal-submitted audit failed for ${row.digest}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return c.json(toChangeRequest(reqItem, id), 201);
  });

  /* ── POST /:id/drift/security/:digest/legitimize — C2, the legitimize front
   * door (spec addendum A6). From a security-posture drift row the operator
   * may choose REVERT (the submit route above, unchanged) or LEGITIMIZE: a
   * justified emergency change converged into code via a full-scrutiny
   * engineer-tier request. `:digest` must name an OPEN, FRESH,
   * REVERT-flavored proposal (security rows always carry the revert
   * proposal; a security verdict with no revert proposal — i.e.
   * security-ungenerable — stays human-routed per runbook D2, out of this
   * route's reach). Eligibility is RE-DERIVED from the stored report: EVERY
   * verdict on the row's addresses must be security-posture, else 422
   * DRIFT_NOT_ADOPTABLE (the code's §4.5 meaning generalizes to "re-derived
   * eligibility for the requested drift action failed"). The revert
   * proposal row is deliberately NOT consumed — it stays `open`; both paths
   * remain visible until the next clean run closes the loop. ── */
  p.post('/:id/drift/security/:digest/legitimize', async (c) => {
    const store = c.get('store');
    const account = c.get('account')!;
    const id = c.req.param('id') ?? '';
    const digest = c.req.param('digest') ?? '';

    // 1. ARMING — same doctrine as PUT/submit.
    if (!driftArmed()) return c.json({ code: 'DRIFT_DISARMED', reason: DRIFT_DISARMED_REASON }, 409);

    // 2. Project + TARGET-bound membership (mirrors GET/submit).
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!isBoundToProject(account, id)) return apiError(c, 'PROJECT_SCOPE');
    if (project.archived) return c.json({ code: 'NOT_FOUND', reason: 'This project is archived.' }, 404);

    // 3. ROLE — approver/lead only (§4.3's revert rule: it concerns live
    //    security posture, same tier either resolution).
    const role = roleFor(account, id);
    if (role !== 'approver' && role !== 'lead') return apiError(c, 'FORBIDDEN_ROLE');

    // 4. The digest must name a REAL, REVERT-flavored proposal — an
    //    adopt-flavored digest (or an unknown one) is simply "no such
    //    revert proposal at this digest" from this route's point of view.
    if (!isValidProposalDigest(digest)) return c.json({ code: 'NOT_FOUND', reason: 'No such drift proposal.' }, 404);
    const primaryKey = driftProposalKey(id, digest);
    const row = (await store.get(primaryKey.PK, primaryKey.SK)) as DriftProposalItem | null;
    if (!row || row.flavor !== 'revert') return c.json({ code: 'NOT_FOUND', reason: 'No such drift proposal.' }, 404);

    // 5. Body.
    const parsedBody = LegitimizeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsedBody.success) return apiError(c, 'VALIDATION_FAILED');
    const { justification, schedule: scheduleInput } = parsedBody.data;

    // 6. FRESHNESS — the same staleness rule as submit: 'open' AND
    //    lastSeenReportVersion == the served pointer's version.
    const pointerKeyObj = driftPointerKey(id);
    const pointer = (await store.get(pointerKeyObj.PK, pointerKeyObj.SK)) as DriftPointerItem | null;
    if (!pointer || row.status !== 'open' || row.lastSeenReportVersion !== pointer.version) {
      return apiError(c, 'DRIFT_PROPOSAL_STALE');
    }

    // 7. ELIGIBILITY RE-DERIVED: every verdict on the row's addresses must
    //    be security-posture — never trust the row's own flavor claim.
    const rawText = readDriftReport(dataRoot, id, pointer.version);
    const report = rawText === null ? null : parseStoredEnvelope(rawText);
    if (report === null) return apiError(c, 'DRIFT_NOT_ADOPTABLE');
    const verdictsByAddress = foldVerdictsByAddress(report.report.verdicts);
    for (const addr of row.addresses) {
      const verdicts = verdictsByAddress.get(addr);
      if (!verdicts || verdicts.length === 0 || !verdicts.every((v) => isSecurityPosture(v))) {
        return apiError(c, 'DRIFT_NOT_ADOPTABLE');
      }
    }

    // 8. The pinned evidence — F1(a)/A2 shape: the engineer's exact live
    //    values to converge code to. `diff` is always null (legitimize
    //    never carries a code edit — an engineer authors the Terraform).
    const body = readDriftProposalBody(dataRoot, id, digest);
    if (body === null) return apiError(c, 'DRIFT_NOT_ADOPTABLE');
    const verdicts = row.addresses.flatMap((addr) => verdictsByAddress.get(addr) ?? []);

    const op = getOperation(SYSTEM_DRIFT_LEGITIMIZE)!; // always resolvable — manifests.ts#getOperation
    const tier = reviewTierFor(op.exposure); // 'engineer' — engineer_only exposure

    // 9. THE NORMAL SUBMIT INTERNALS (§4.3) — same gates as the adopt/revert submit.
    if (await isFrozen(store, id)) return apiError(c, 'GLOBAL_FREEZE');
    if (!(await checkSubmitRateLimit(store, id, account.id)).ok) return apiError(c, 'RATE_LIMITED');

    const scheduleResult = validateSchedule(scheduleInput, nowMs());
    if (!scheduleResult.ok) return apiError(c, scheduleResult.code);
    const schedule = scheduleResult.schedule;

    const ladder = ladderFor(tier, false); // forcesReplace structurally false (§4.4)
    const approvalsRequired = ladder.length;
    const feasibility = await computeFeasibility(store, id, ladder, account.id);
    const { risk, version: riskOverrideVersion } = await resolveRisk(store, id, op);
    const { version: policyVersion } = await loadPolicy(store, id);

    const reqId = ulid();
    const now = nowIso();
    const targetAddress = body.requestSkeleton.items[0]!.targetAddress;
    const status = initialStatusFor(tier); // NEEDS_ENGINEER — engineer tier always routes here
    const reqItem: RequestItem = {
      ...requestKey(id, reqId),
      id: reqId,
      requestUlid: reqId,
      requester: account.id,
      projectId: id,
      teamId: toUser(account, id).teamId,
      service: op.service,
      operationId: op.id,
      macd: op.macd,
      targetAddress,
      params: { attrs: body.attrs, verdicts, diff: null, proposalDigest: digest, reportVersion: row.lastSeenReportVersion },
      justification,
      exposure: op.exposure,
      reviewTier: tier,
      risk,
      status,
      approvalsRequired,
      approvals: [],
      schedule,
      createdAt: now,
      updatedAt: now,
      events: [
        { at: now, type: 'created', label: `Legitimize request for security-posture drift (auto-generated; submitted by ${account.displayName})`, actor: account.id },
        { at: now, type: 'needs_engineer', label: 'Routed to an engineer to author and review the Terraform' },
        { at: now, type: 'origin', label: `Origin: drift-legitimize ${digest}`, actor: 'system:drift-propose' },
      ],
      policyVersion,
      riskOverrideVersion,
      ...feasibility,
      GSI1PK: requestCollectionGsi(id),
      GSI1SK: reqId,
    };

    // The revert proposal row is deliberately NOT touched (stays 'open') —
    // only the new request is written, under the standard audit-chain
    // transact (no dedupe-condition on a proposal row to race here, unlike
    // submit, since nothing about the proposal changes).
    await transactWithAudit(store, id, [{ kind: 'put', item: reqItem as never, ifNotExists: true }], {
      action: 'drift-legitimize-requested',
      actor: account.id,
      targetType: 'request',
      targetId: reqId,
      requestId: reqId,
      after: { digest, status, approvalsRequired, risk, exposure: op.exposure, reviewTier: tier, ...feasibility },
    });

    return c.json(toChangeRequest(reqItem, id), 201);
  });

  /* ── POST /:id/drift/check — B1, "Start drift check" (owner refinement 4;
   * spec addendum A7). On-demand run of the estate drift workflow via the
   * operator-injected CCP_DRIFT_CHECK_CMD (the bundle-trigger pattern);
   * the api NEVER runs terraform. The report only lands later, through the
   * normal PUT publish — this just asks the workflow to run. ── */
  p.post('/:id/drift/check', async (c) => {
    const store = c.get('store');
    const account = c.get('account')!;
    const id = c.req.param('id') ?? '';

    // 1. ARMING.
    if (!driftArmed()) return c.json({ code: 'DRIFT_DISARMED', reason: DRIFT_DISARMED_REASON }, 409);

    // 2. Project exists / target-bound / not archived.
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!isBoundToProject(account, id)) return apiError(c, 'PROJECT_SCOPE');
    if (project.archived) return c.json({ code: 'NOT_FOUND', reason: 'This project is archived.' }, 404);

    // 3. ROLE — lead or admin (the apply-route precedent, requests.ts
    //    POST /:id/apply). An inline, non-taxonomy code (like APPLY_FORBIDDEN
    //    / DRIFT_DISARMED) so `test/errors.test.ts`'s hand-pinned taxonomy
    //    set stays untouched.
    if (!isLeadOrAdmin(account, roleFor(account, id))) {
      return c.json({ code: 'DRIFT_CHECK_FORBIDDEN', reason: 'Only a Lead or admin may start a drift check.' }, 403);
    }

    // 4. GLOBAL_FREEZE gate.
    if (await isFrozen(store, id)) return apiError(c, 'GLOBAL_FREEZE');

    // 5. Check lane armed — same code as arming, distinct reason (no new
    //    error-code taxonomy entry, spec A7).
    const cfg = driftCheckConfig();
    if (!cfg) {
      return c.json(
        { code: 'DRIFT_DISARMED', reason: 'On-demand drift checks are not armed on this deployment (CCP_DRIFT_CHECK_CMD unset).' },
        409,
      );
    }

    // 6/7. One in-flight per project, then run the injected trigger. The
    // http response is 202 either way once dispatched (fire-and-forget,
    // the bundle-trigger precedent) — only STATE_CONFLICT (the in-flight
    // guard) short-circuits it; a trigger-command failure is captured in
    // the audit `detail` for operators, never surfaced as a 5xx.
    const outcome = await runDriftCheck(realDriftCheckSteps(cfg), id);
    let detail: string;
    if (outcome.ok) {
      detail = outcome.detail;
    } else if (outcome.conflict) {
      return apiError(c, 'STATE_CONFLICT');
    } else {
      detail = outcome.detail;
    }

    const at = nowIso();
    await record(store, id, {
      action: 'drift-check-requested',
      actor: account.id,
      targetType: 'project',
      targetId: id,
      after: { ok: outcome.ok, detail },
    });

    return c.json({ requested: true, at }, 202);
  });

  /* ── POST /:id/drift/generate — B2, "Fix the drift" refresh half (owner
   * refinement 4; spec addendum A7). Exposes the §6.3 generation runner on
   * demand — idempotent via digests, the same non-reentrant queue-collapsing
   * runner the PUT handler already fires automatically. Deliberately NO
   * freeze gate (unlike B1): generation only produces PROPOSAL rows, never a
   * request — the same posture as the automatic post-upload trigger, which
   * has never checked freeze either. ── */
  p.post('/:id/drift/generate', async (c) => {
    const store = c.get('store');
    const account = c.get('account')!;
    const id = c.req.param('id') ?? '';

    // 1. ARMING.
    if (!driftArmed()) return c.json({ code: 'DRIFT_DISARMED', reason: DRIFT_DISARMED_REASON }, 409);

    // 2. Project gates.
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!isBoundToProject(account, id)) return apiError(c, 'PROJECT_SCOPE');
    if (project.archived) return c.json({ code: 'NOT_FOUND', reason: 'This project is archived.' }, 404);

    // 3. ROLE — lead or admin (same rule as the check button).
    if (!isLeadOrAdmin(account, roleFor(account, id))) {
      return c.json({ code: 'DRIFT_GENERATE_FORBIDDEN', reason: 'Only a Lead or admin may refresh drift fix proposals.' }, 403);
    }

    // 4. Generation armed — CCP_DRIFT_PROPOSALS + CCP_DRIFT_GEN_CMD +
    //    CCP_GIT_REMOTE all set (§10), else 409 DRIFT_DISARMED naming them.
    const genCfg = driftGenConfig();
    if (!genCfg) {
      return c.json(
        {
          code: 'DRIFT_DISARMED',
          reason: 'Drift fix generation is not armed on this deployment (CCP_DRIFT_PROPOSALS + CCP_DRIFT_GEN_CMD + CCP_GIT_REMOTE unset).',
        },
        409,
      );
    }

    // 5. The pointer must exist — nothing to generate from otherwise.
    const pKeyObj = driftPointerKey(id);
    const pointer = (await store.get(pKeyObj.PK, pKeyObj.SK)) as DriftPointerItem | null;
    if (!pointer) return apiError(c, 'STATE_CONFLICT');

    // 6. Audit, THEN schedule (fire-and-forget — never awaited, same
    //    discipline as the PUT handler's automatic trigger).
    await record(store, id, {
      action: 'drift-generation-requested',
      actor: account.id,
      targetType: 'project',
      targetId: id,
      after: { reportVersion: pointer.version },
    });
    scheduleDriftGeneration({ store, dataRoot, steps: realDriftGenSteps(genCfg) }, id, pointer.version);

    return c.json({ scheduled: true, reportVersion: pointer.version }, 202);
  });

  return p;
}
