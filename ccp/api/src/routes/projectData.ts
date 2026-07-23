import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { AppEnv } from '../appEnv';
import type { ApplySpec, ProjectDataVersionItem, ProjectItem, ProjectUploadTokenItem } from '../store/schema';
import { PROJECT_DATA_SK_PREFIX, projectDataVersionKey, projectKey, uploadTokenKey } from '../store/schema';
import { ApiError, apiError } from '../errors';
import { requireAdmin, requireRole } from '../middleware/authz';
import { checkUploadRateLimit } from '../middleware/rateLimit';
import { isBoundToProject, refreshKnownProjects } from '../projects';
import { hashPassword, verifyPassword } from '../auth/credentials';
import { commitOrPropose, publicPendingChange } from '../domain/dualControl';
import { transactWithAudit } from '../domain/audit';
import {
  MAX_UPLOAD_BYTES,
  UploadBundle,
  bundleProblem,
  digestsOf,
  readProjectDataFile,
  rerunRedaction,
  writeProjectDataVersion,
  type ServedFile,
} from '../domain/projectData';
import { nowIso, nowMs } from '../clock';

/**
 * The per-account DATA plane of the projects registry: CI upload tokens, the
 * token-authed data upload, staged-version listing, dual-controlled activation
 * (whose FIRST ack is the project's go-live: trusted → ready + artifacts),
 * archive/unarchive, and the serve endpoints the app reads at runtime (killing
 * the vendor-and-rebuild step). Mounted INSIDE `projectRoutes()` so the
 * registry's session+membership group gate applies to every route here EXCEPT
 * the one deliberate carve-out: `PUT /:id/data` authenticates with an upload
 * TOKEN (the CI has no session, no cookie, no CSRF surface) and its handler
 * fails closed without a valid one.
 *
 * AUTHZ TABLE (server-enforced, mirrors the trust surface's tiers):
 *  - mint/revoke token, list versions, activate, archive/unarchive: lead+isAdmin
 *    (the manage tier — same as register/trust/deregister).
 *  - PUT /:id/data: a live, unexpired upload token for EXACTLY that project,
 *    rate limited PER TOKEN ID before the argon2id verify (DoS hardening —
 *    tokenId is semi-public; see middleware/rateLimit.ts).
 *  - GET manifests/inventory/blocks: any session BOUND TO THE TARGET project
 *    (":id", not just the acting scope) — an account with no relationship to an
 *    estate can never read its resource data. Fail closed.
 *
 * AUDIT: every data-plane action here lands on the TARGET project's chain
 * (the path ":id"), NOT the caller's acting scope — a tenant reviewing their
 * own trail sees the token mints, uploads, and activations performed against
 * them. (The registry lifecycle — register/trust/deregister — stays on the
 * acting scope's chain: that is the operator control plane's own record.)
 */

const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const TOKEN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/; // ulid
const TOKEN_SECRET = /^[A-Za-z0-9_-]{20,100}$/; // 32 random bytes, base64url

const MintBody = z
  .object({
    /** Token lifetime in minutes; default 24h, max 7 days — CI mints fresh ones. */
    ttlMinutes: z.number().int().min(5).max(10_080).optional(),
  })
  .strict();

const DEFAULT_TTL_MINUTES = 24 * 60;

/** Statuses whose repo CI is legitimate: the repo has passed the human trust
 * review. Draft/pending-trust projects have no trusted producer yet. */
const UPLOADABLE = new Set<ProjectItem['status']>(['trusted', 'ready']);

async function loadProject(store: AppEnv['Variables']['store'], id: string): Promise<ProjectItem | null> {
  if (!PROJECT_ID.test(id)) return null;
  const k = projectKey(id);
  return (await store.get(k.PK, k.SK)) as ProjectItem | null;
}

async function listVersionRows(
  store: AppEnv['Variables']['store'],
  id: string,
): Promise<ProjectDataVersionItem[]> {
  return (await store.query(`PROJECT#${id}`, PROJECT_DATA_SK_PREFIX)) as ProjectDataVersionItem[];
}

/** Client projection of one version row (never PK/SK). */
function publicVersion(v: ProjectDataVersionItem, activeVersion: number | undefined): Record<string, unknown> {
  return {
    version: v.version,
    status: v.version === activeVersion ? 'active' : 'staged',
    uploadedAt: v.uploadedAt,
    uploadedVia: v.uploadedVia,
    digests: v.digests,
    uploadDigests: v.uploadDigests,
    counts: v.counts,
    chunks: v.chunks,
    warnings: v.warnings,
    ...(v.sourceCommit !== undefined ? { sourceCommit: v.sourceCommit } : {}),
    ...(v.generatedAt !== undefined ? { generatedAt: v.generatedAt } : {}),
    ...(v.providerPins !== undefined ? { providerPins: v.providerPins } : {}),
  };
}

export function projectDataRoutes(dataRoot: string): Hono<AppEnv> {
  const p = new Hono<AppEnv>();

  /* ── POST /:id/upload-tokens — mint a CI upload token (lead+isAdmin) ─────── */
  p.post('/:id/upload-tokens', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    // An empty body means "defaults"; a present body must validate strictly.
    const bodyText = await c.req.text();
    let raw: unknown = {};
    if (bodyText.trim().length > 0) {
      try {
        raw = JSON.parse(bodyText);
      } catch {
        return apiError(c, 'VALIDATION_FAILED', { field: 'body', problem: 'not valid JSON' });
      }
    }
    const parsed = MintBody.safeParse(raw);
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    // Fail closed: only a project whose repo has passed the human trust review
    // has a legitimate CI producer; an archived project mints nothing.
    if (!UPLOADABLE.has(project.status) || project.archived) return apiError(c, 'STATE_CONFLICT');

    const tokenId = ulid();
    const secret = randomBytes(32).toString('base64url');
    const secretHash = await hashPassword(secret); // argon2id, same posture as passwords
    const ttlMinutes = parsed.data.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    const expiresAt = new Date(nowMs() + ttlMinutes * 60_000).toISOString();
    const item: ProjectUploadTokenItem = {
      ...uploadTokenKey(id, tokenId),
      tokenId,
      projectId: id,
      secretHash,
      createdBy: actor,
      createdAt: nowIso(),
      expiresAt,
    };
    // AUDIT TO THE TARGET (security review): a data-plane action against `id`
    // must land on `id`'s chain — the tenant reviewing their own trail sees
    // every credential minted against them, not just actions they performed.
    await transactWithAudit(
      store,
      id,
      [{ kind: 'put', item: item as never, ifNotExists: true }],
      {
        action: 'upload-token-mint',
        actor,
        targetType: 'project',
        targetId: id,
        after: { tokenId, expiresAt },
      },
    );
    // The clear token is shown exactly ONCE — only its argon2id hash is stored.
    return c.json({ tokenId, token: `${tokenId}.${secret}`, expiresAt }, 201);
  });

  /* ── DELETE /:id/upload-tokens/:tokenId — revoke (lead+isAdmin) ──────────── */
  p.delete('/:id/upload-tokens/:tokenId', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const tokenId = c.req.param('tokenId');
    if (!PROJECT_ID.test(id) || !TOKEN_ID.test(tokenId)) {
      return c.json({ code: 'NOT_FOUND', reason: 'No such upload token.' }, 404);
    }
    const k = uploadTokenKey(id, tokenId);
    const row = (await store.get(k.PK, k.SK)) as ProjectUploadTokenItem | null;
    if (!row) return c.json({ code: 'NOT_FOUND', reason: 'No such upload token.' }, 404);
    // Audit to the TARGET project's chain (same rule as mint).
    await transactWithAudit(store, id, [{ kind: 'delete', pk: k.PK, sk: k.SK }], {
      action: 'upload-token-revoke',
      actor,
      targetType: 'project',
      targetId: id,
      before: { tokenId, expiresAt: row.expiresAt },
    });
    return c.json({ ok: true, revoked: true });
  });

  /* ── PUT /:id/data — the token-authed CI upload (stages a new version) ───── */
  p.put('/:id/data', async (c) => {
    const store = c.get('store');
    const id = c.req.param('id');

    // 1. TOKEN GATE first — before any body handling, and required on EVERY
    //    path into this handler (a session never substitutes for a token).
    const auth = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{20,100})$/.exec(auth);
    if (!m || !TOKEN_ID.test(m[1]!) || !TOKEN_SECRET.test(m[2]!)) return apiError(c, 'UPLOAD_TOKEN_INVALID');
    const [, tokenId, secret] = m;
    if (!PROJECT_ID.test(id)) return apiError(c, 'UPLOAD_TOKEN_INVALID');
    // 1b. RATE LIMIT before any store read or argon2id work (DoS hardening):
    //     tokenId is semi-public, and every well-formed attempt below this line
    //     costs a full 19 MiB / timeCost-2 verify — so the lane is throttled
    //     PER TOKEN ID (a small burst, then a slow refill). Requests that fail
    //     the shape checks above never reach the expensive path and need no
    //     bucket. Over → 429 with Retry-After; nothing is enumerated.
    const rate = checkUploadRateLimit(tokenId!);
    if (!rate.ok) return apiError(c, 'RATE_LIMITED', { retryAfter: rate.retryAfterSeconds });
    const tKey = uploadTokenKey(id, tokenId!);
    const token = (await store.get(tKey.PK, tKey.SK)) as ProjectUploadTokenItem | null;
    // One generic refusal for unknown/expired/revoked/wrong-project — no enumeration.
    if (!token || token.projectId !== id) return apiError(c, 'UPLOAD_TOKEN_INVALID');
    if (Date.parse(token.expiresAt) <= nowMs()) return apiError(c, 'UPLOAD_TOKEN_INVALID');
    if (!(await verifyPassword(token.secretHash, secret!))) return apiError(c, 'UPLOAD_TOKEN_INVALID');

    // 2. Project state gate.
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!UPLOADABLE.has(project.status) || project.archived) return apiError(c, 'STATE_CONFLICT');

    // 3. SIZE CAP before parsing — Content-Length first (refuse unread), then
    //    the actual byte length (a chunked body carries no length header).
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return apiError(c, 'UPLOAD_TOO_LARGE', { maxBytes: MAX_UPLOAD_BYTES });
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_UPLOAD_BYTES) {
      return apiError(c, 'UPLOAD_TOO_LARGE', { maxBytes: MAX_UPLOAD_BYTES });
    }

    // 4. Parse + strict-validate the bundle.
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return apiError(c, 'VALIDATION_FAILED', { field: 'body', problem: 'not valid JSON' });
    }
    const parsed = UploadBundle.safeParse(raw);
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', { field: 'body', problem: 'not a data bundle' });
    const structural = bundleProblem(parsed.data);
    if (structural) return apiError(c, 'VALIDATION_FAILED', structural);

    // 5. DIGEST BINDING: recompute sha256 over the canonical JSON of each part
    //    and compare with the uploader's claim. Fail closed on the first mismatch.
    const claimed = parsed.data.digests;
    const computed = digestsOf(parsed.data);
    if ((parsed.data.manifests !== undefined) !== (claimed.manifestsSha256 !== undefined)) {
      return apiError(c, 'DATA_DIGEST_MISMATCH', { part: 'manifests', problem: 'manifests and manifestsSha256 must be present together' });
    }
    for (const part of ['inventorySha256', 'blocksSha256', 'manifestsSha256'] as const) {
      if (claimed[part] !== undefined && claimed[part] !== computed[part]) {
        return apiError(c, 'DATA_DIGEST_MISMATCH', { part, computed: computed[part], expected: claimed[part] });
      }
    }

    // 6. REDACTION RE-RUN — the server stores its own redaction output.
    const redaction = rerunRedaction(parsed.data);
    if (redaction.problem) return apiError(c, 'VALIDATION_FAILED', redaction.problem);
    const stored = redaction.bundle;
    const storedDigests = digestsOf(stored);

    // 7. STAGE as the next version. ROW-FIRST allocation: winning the metadata
    //    row's `ifNotExists` put IS the version-number claim (one retry on a
    //    race), and only the winner writes files. A file-write failure then
    //    deletes the row — either way nothing half-exists, and a version row is
    //    only ever trusted when its files landed (serve fails closed regardless).
    const uploadedVia = `upload-token:${tokenId}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await listVersionRows(store, id);
      const version = (existing.length > 0 ? existing[existing.length - 1]!.version : 0) + 1;
      const item: ProjectDataVersionItem = {
        ...projectDataVersionKey(id, version),
        projectId: id,
        version,
        uploadedAt: nowIso(),
        uploadedVia,
        digests: storedDigests,
        uploadDigests: claimed,
        counts: {
          resources: stored.inventory.resources.length,
          blockAddresses: Object.keys(stored.blocks.index).length,
          blockChunks: Object.keys(stored.blocks.chunks).length,
          manifests: stored.manifests?.length ?? 0,
        },
        chunks: Object.keys(stored.blocks.chunks).sort(),
        warnings: redaction.warnings,
        ...(stored.inventory.sourceCommit != null ? { sourceCommit: stored.inventory.sourceCommit } : {}),
        generatedAt: stored.inventory.generatedAt,
        ...(stored.summary?.providerPins ? { providerPins: stored.summary.providerPins } : {}),
      };
      try {
        // Audit to the TARGET project's chain — the upload lane has no acting
        // scope anyway (a Bearer token, not a session), so the header-scope
        // default was doubly wrong here.
        await transactWithAudit(
          store,
          id,
          [{ kind: 'put', item: item as never, ifNotExists: true }],
          {
            action: 'project-data-upload',
            actor: uploadedVia,
            targetType: 'project',
            targetId: id,
            after: { version, digests: storedDigests, counts: item.counts, warnings: redaction.warnings.length },
          },
        );
      } catch (e) {
        // A lost version race surfaces as chain contention (the ifNotExists put
        // aborts the audited transact) — re-read the tail and try the next number.
        if (e instanceof ApiError && e.code === 'CHAIN_CONTENTION' && attempt === 0) continue;
        throw e;
      }
      try {
        await writeProjectDataVersion(dataRoot, id, version, stored);
      } catch (e) {
        await store.delete(item.PK, item.SK); // no files → no staged row
        throw e;
      }
      // Staged, NOT served: activation is a separate dual-controlled step.
      return c.json({ version, status: 'staged', digests: storedDigests, uploadDigests: claimed, warnings: redaction.warnings }, 201);
    }
    return apiError(c, 'STATE_CONFLICT');
  });

  /* ── GET /:id/data — list staged+active versions (lead+isAdmin) ──────────── */
  p.get('/:id/data', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const id = c.req.param('id');
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    const rows = await listVersionRows(store, id);
    const activeVersion = project.dataActive?.version;
    return c.json({
      ...(activeVersion !== undefined ? { activeVersion } : {}),
      versions: rows.map((v) => publicVersion(v, activeVersion)),
    });
  });

  /* ── POST /:id/data/:version/activate — 2-admin envelope, then served ────── */
  p.post('/:id/data/:version/activate', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const versionRaw = c.req.param('version');
    if (!/^\d{1,6}$/.test(versionRaw)) return apiError(c, 'VALIDATION_FAILED', { field: 'version' });
    const version = Number(versionRaw);

    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!UPLOADABLE.has(project.status) || project.archived) return apiError(c, 'STATE_CONFLICT');
    if (project.dataActive?.version === version) return apiError(c, 'STATE_CONFLICT');
    const vKey = projectDataVersionKey(id, version);
    const row = (await store.get(vKey.PK, vKey.SK)) as ProjectDataVersionItem | null;
    if (!row) return c.json({ code: 'NOT_FOUND', reason: 'No such staged data version.' }, 404);

    const k = projectKey(id);
    const now = nowIso();
    const dataActive = { version, activatedBy: actor, activatedAt: now };
    // The FIRST activation doubles as go-live: a 'trusted' project also becomes
    // 'ready' (routable, selectable, bindable) and gains its `artifacts` record,
    // derived from the SERVER's own digests over the activated version — never a
    // hand-typed body. Version rows are immutable once staged, so the digests
    // captured at propose time cannot drift before the ack. An already-'ready'
    // project just moves the served-data pointer, exactly as before.
    const goesReady = project.status === 'trusted';
    const goLive = goesReady
      ? { status: 'ready' as const, artifacts: { ...row.digests, recordedBy: actor, recordedAt: now } }
      : {};
    // ALWAYS dual-control (loosening): activating changes what every user of the
    // account is served — and the first one takes the project live. The version
    // guard makes any interleaved registry write (re-trust, archive, another
    // activation, a manual complete) fail the ack with STALE_PROPOSAL.
    const apply: ApplySpec = {
      op: 'update',
      pk: k.PK,
      sk: k.SK,
      set: { dataActive, ...goLive, version: project.version + 1 },
      guardAttr: 'version',
      guardValue: project.version,
    };
    const res = await commitOrPropose(store, c.get('projectId'), actor, {
      classification: 'loosening',
      kind: 'project-data-activate',
      targetKey: `PROJECT#${id}`,
      before: { dataActive: project.dataActive ?? null, ...(goesReady ? { status: project.status } : {}) },
      // The second admin acks the WHOLE effect: on a first activation the
      // `after` discloses that the ack takes the project live — status 'ready',
      // artifacts recorded — not merely a data swap.
      after: { dataActive, digests: row.digests, counts: row.counts, warnings: row.warnings, ...goLive },
      apply,
      audit: {
        action: 'project-data-activate',
        actor,
        targetType: 'project',
        targetId: id,
        after: { dataActive, ...(goesReady ? { status: 'ready' } : {}) },
      },
      // Data-plane action → the trail (propose/apply/named event) lands on the
      // TARGET project's chain; the pending record stays in the acting scope.
      auditProjectId: id,
    });
    /* istanbul ignore next — 'loosening' can never take the 200 branch */
    if (res.status === 200) return c.json({ ok: true });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── POST /:id/archive — tightening: applies immediately, one admin ──────── */
  p.post('/:id/archive', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (project.archived) return apiError(c, 'STATE_CONFLICT');

    const k = projectKey(id);
    const archived = { archivedBy: actor, archivedAt: nowIso() };
    const apply: ApplySpec = {
      op: 'update',
      pk: k.PK,
      sk: k.SK,
      set: { archived, version: project.version + 1 },
      guardAttr: 'version',
      guardValue: project.version,
    };
    const res = await commitOrPropose(store, c.get('projectId'), actor, {
      classification: 'tightening', // removing access applies immediately
      kind: 'project-archive',
      targetKey: `PROJECT#${id}`,
      before: { archived: null },
      after: { archived },
      apply,
      audit: { action: 'project-archive', actor, targetType: 'project', targetId: id, after: { archived } },
      auditProjectId: id, // data-plane action → the target project's chain
    });
    // Archiving removes routability NOW — resync the known-projects cache.
    await refreshKnownProjects(store);
    /* istanbul ignore next — 'tightening' always takes the 200 branch */
    if (res.status !== 200) return c.json(publicPendingChange(res.pending), 202);
    const after = (await store.get(k.PK, k.SK)) as ProjectItem;
    return c.json({ ok: true, id, archived: after.archived });
  });

  /* ── POST /:id/unarchive — loosening: 2-admin envelope ───────────────────── */
  p.post('/:id/unarchive', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!project.archived) return apiError(c, 'STATE_CONFLICT');

    const k = projectKey(id);
    const apply: ApplySpec = {
      op: 'update',
      pk: k.PK,
      sk: k.SK,
      // The store's update semantics: setting the attr to undefined clears it.
      set: { archived: undefined, version: project.version + 1 },
      guardAttr: 'version',
      guardValue: project.version,
    };
    const res = await commitOrPropose(store, c.get('projectId'), actor, {
      classification: 'loosening', // restoring access needs the second admin
      kind: 'project-unarchive',
      targetKey: `PROJECT#${id}`,
      before: { archived: project.archived },
      after: { archived: null },
      apply,
      audit: { action: 'project-unarchive', actor, targetType: 'project', targetId: id, before: { archived: project.archived } },
      auditProjectId: id, // data-plane action → the target project's chain
    });
    /* istanbul ignore next — 'loosening' can never take the 200 branch */
    if (res.status === 200) return c.json({ ok: true });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── the serve endpoints — the ACTIVE version only, target-bound sessions ── */

  /**
   * Shared gate for the three reads: the caller must hold a binding ON THE
   * TARGET project (":id" — not merely the acting scope, which the group
   * middleware already checked), the project must not be archived, and only an
   * ACTIVATED version is ever served. Returns the served file text or a Response.
   */
  async function serveActive(c: Context<AppEnv>, file: ServedFile): Promise<Response> {
    const store = c.get('store');
    const account = c.get('account')!;
    // A bare Context (no path generic) types param() as possibly-undefined;
    // '' fails the PROJECT_ID shape check in loadProject → 404, fail closed.
    const id = c.req.param('id') ?? '';
    const project = await loadProject(store, id);
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (!isBoundToProject(account, id)) return apiError(c, 'PROJECT_SCOPE');
    // Archived or never-activated → there is no served data. Fail closed.
    if (project.archived || !project.dataActive) {
      return c.json({ code: 'NOT_FOUND', reason: 'This project has no active data to serve.' }, 404);
    }
    const version = project.dataActive.version;
    if (file.kind === 'blocks-chunk') {
      const vKey = projectDataVersionKey(id, version);
      const row = (await store.get(vKey.PK, vKey.SK)) as ProjectDataVersionItem | null;
      // The stored chunk list is the serve-time allowlist — never the filesystem.
      if (!row || !row.chunks.includes(file.chunk)) {
        return c.json({ code: 'NOT_FOUND', reason: 'No such block chunk.' }, 404);
      }
    }
    const text = readProjectDataFile(dataRoot, id, version, file);
    if (text === null) {
      // Manifests are optional per version; everything else vanishing is a
      // served-data integrity problem — still a fail-closed 404, never a partial.
      return c.json({ code: 'NOT_FOUND', reason: 'This project has no such data file.' }, 404);
    }
    return c.newResponse(text, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  }

  p.get('/:id/manifests', async (c) => serveActive(c, { kind: 'manifests' }));
  p.get('/:id/inventory', async (c) => serveActive(c, { kind: 'inventory' }));
  p.get('/:id/blocks/:chunk', async (c) => {
    const chunk = c.req.param('chunk');
    return serveActive(c, chunk === 'index' ? { kind: 'blocks-index' } : { kind: 'blocks-chunk', chunk });
  });

  return p;
}
