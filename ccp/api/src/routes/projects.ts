import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../appEnv';
import type { ProjectItem, ProjectTrustBlock, ProjectTrustRequestRecord } from '../store/schema';
import { PrescanReport, RepoRef, githubMirrorOf, projectCollectionGsi, projectKey, repoRefOf } from '../store/schema';
import type { ApplySpec } from '../store/schema';
import { apiError } from '../errors';
import { requireSession } from '../middleware/session';
import { requireAdmin, requireProjectMembership, requireRole } from '../middleware/authz';
import { isKnownProject, PROJECT_ID_RE, roleFor } from '../projects';
import { commitOrPropose, publicPendingChange } from '../domain/dualControl';
import { transactWithAudit } from '../domain/audit';
import { nowIso } from '../clock';
import { projectDataRoutes } from './projectData';
import { driftRoutes } from './drift';
import { resolveProjectDataRoot } from '../domain/projectData';
import { isUploadTokenLane } from '../middleware/session';

/**
 * The projects registry + onboarding trust surface. THE SECURITY
 * POSTURE IS THE POINT:
 *
 *  - FAIL-CLOSED TRUST: status is a strict forward ladder (draft → pending-trust
 *    → trusted → ready); every transition validates the previous rung; there is
 *    NO endpoint that auto-trusts. Findings review stays a human decision — the
 *    api only ever records it, and refuses to record it over a non-clean verdict
 *    (TRUST_VERDICT_NOT_CLEAN) even if a client renders a button anyway.
 *  - SHA BINDING: the uploaded prescan-report bytes must hash to the CLI-written
 *    `trustRequest.prescanSha256` (recomputed server-side at upload AND re-checked
 *    at trust time), so the Lead's ack is bound to the exact scanned bytes
 *    (onboard.go's binding, verified here rather than trusted).
 *  - DUAL CONTROL: trusting and deregistering are ALWAYS proposed (202) and
 *    applied only by a second distinct admin's ack through the standing
 *    PendingChanges machinery (domain/dualControl.ts) — never single-keystroke.
 *  - NO MASS ASSIGNMENT: every body schema is `.strict()`; `status`, `trust`,
 *    and `artifacts` are never accepted from any request body.
 *  - LEAST DISCLOSURE (read, security review): GET /projects is TWO-TIER. Only a
 *    lead+isAdmin caller (the manage tier — same as register/trust/deregister)
 *    sees the rich projection (trustRequest/parsed report/findings/uploadedBy/
 *    createdBy/artifacts). Every other bound session gets ONLY the documented
 *    any-session summary ({id, name, github, accountId,
 *    region, status, trust?}) — a plain requester with no relationship to a
 *    project can never read its prescan findings, uploader, or artifact digests.
 *    The gate is ROLE, not membership: leads/admins legitimately manage projects
 *    they are not bound to.
 *  - AUDIT ON EVERY WRITE: register/upload via transactWithAudit; trust/deregister
 *    via the dual-control propose/apply chain plus the named
 *    'Trusted repo for onboarding' event on apply (domain/projectsLifecycle.ts).
 *
 * The api never checks out repos and never runs terraform — the local
 * `catalogctl onboard` sandbox contract (assertNoCloudCreds, prescan before
 * trust before init) is unchanged and deliberately NOT moved server-side.
 * What it DOES now hold is each account's served DATA (inventory / blocks /
 * manifests), uploaded by that account's CI through the token-authed data
 * plane and served only after a 2-admin activation — see routes/projectData.ts
 * (mounted below), which is what killed the vendor-into-the-app rebuild step.
 */

/** Explicit AWS commercial-region allowlist ("region allowlist") —
 * fail-closed: an unlisted region string is refused, not normalized. */
export const REGION_ALLOWLIST = [
  'af-south-1',
  'ap-east-1',
  'ap-east-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-7',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'mx-central-1',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
] as const;

/** Explicit Azure location allowlist ("location allowlist" — the azure analogue
 * of REGION_ALLOWLIST, 0039 S1). Fail-closed: an unlisted location string is
 * refused, not normalized. Azure names its regions as one lowercase word
 * (`southeastasia`, `eastus2`) — the `azure-fixture` project's `southeastasia`
 * is here so an operator can onboard that exact subscription. */
export const AZURE_LOCATION_ALLOWLIST = [
  'australiaeast',
  'australiasoutheast',
  'brazilsouth',
  'canadacentral',
  'canadaeast',
  'centralindia',
  'centralus',
  'eastasia',
  'eastus',
  'eastus2',
  'francecentral',
  'germanywestcentral',
  'japaneast',
  'japanwest',
  'koreacentral',
  'northcentralus',
  'northeurope',
  'norwayeast',
  'southafricanorth',
  'southcentralus',
  'southeastasia',
  'southindia',
  'swedencentral',
  'switzerlandnorth',
  'uaenorth',
  'uksouth',
  'ukwest',
  'westeurope',
  'westus',
  'westus2',
  'westus3',
] as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;
/** Git object id: 7–64 lowercase hex (short sha through sha256-repo full sha). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;
/** An Azure identifier GUID (subscription id / tenant id) — the canonical
 * 8-4-4-4-12 hex form, case-insensitive (the portal shows lowercase). */
const AZURE_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The register body — PROVIDER-DISCRIMINATED identity (0039 S1). `provider` is
 * optional and absence means 'aws' (the wire convention), so every existing
 * aws-shaped body is byte-identical: `{…, accountId, region}` with no
 * `provider` key still validates exactly as before. An azure body sends
 * `{provider:'azure', subscriptionId, tenantId, location}` IN PLACE OF
 * accountId/region. `.strict()` still refuses any unknown key (mass-assignment
 * defence); the superRefine below refuses a body that mixes the two identity
 * shapes or omits the one its provider requires — fail closed, mirroring how
 * accountId/region were unconditionally required before.
 */
const RegisterBody = z
  .object({
    id: z.string().regex(PROJECT_ID_RE),
    name: z.string().min(2).max(100),
    /** LEGACY GitHub-only shape — still accepted during migration. */
    github: z
      .object({
        owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/),
        repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
      })
      .strict()
      .optional(),
    /** HOST-AGNOSTIC shape (github|gitlab, optional self-hosted baseUrl). */
    repo: RepoRef.optional(),
    /** Absent = 'aws' (the wire convention — an aws row never carries it). */
    provider: z.enum(['aws', 'azure']).optional(),
    /** AWS identity (provider absent/'aws'). */
    accountId: z.string().regex(/^\d{12}$/).optional(),
    region: z.enum(REGION_ALLOWLIST).optional(),
    /** Azure identity (provider 'azure') — subscription + tenant GUIDs + location. */
    subscriptionId: z.string().regex(AZURE_GUID).optional(),
    tenantId: z.string().regex(AZURE_GUID).optional(),
    location: z.enum(AZURE_LOCATION_ALLOWLIST).optional(),
  })
  .strict()
  // Exactly ONE repo shape per register — accepting both invites divergence.
  .refine((b) => (b.github !== undefined) !== (b.repo !== undefined), {
    message: 'send exactly one of github or repo',
  })
  // Exactly the identity shape the provider names — present, and not the other
  // cloud's. An aws body needs accountId+region and no azure field; an azure
  // body needs subscriptionId+tenantId+location and no aws field.
  .superRefine((b, ctx) => {
    const provider = b.provider ?? 'aws';
    const bad = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (provider === 'aws') {
      if (b.accountId === undefined) bad('accountId', 'an aws project needs an accountId');
      if (b.region === undefined) bad('region', 'an aws project needs a region');
      for (const k of ['subscriptionId', 'tenantId', 'location'] as const) {
        if (b[k] !== undefined) bad(k, `an aws project must not carry ${k}`);
      }
    } else {
      if (b.subscriptionId === undefined) bad('subscriptionId', 'an azure project needs a subscriptionId');
      if (b.tenantId === undefined) bad('tenantId', 'an azure project needs a tenantId');
      if (b.location === undefined) bad('location', 'an azure project needs a location');
      for (const k of ['accountId', 'region'] as const) {
        if (b[k] !== undefined) bad(k, `an azure project must not carry ${k}`);
      }
    }
  });

const TrustRequestBody = z
  .object({
    /** The CLI-written triple, verbatim (onboard.go — the REAL schema, P1). */
    trustRequest: z
      .object({
        repo: z.string().min(1).max(300),
        commitSha: z.string().regex(COMMIT_SHA),
        prescanSha256: z.string().regex(SHA256_HEX),
      })
      .strict(),
    /** RAW prescan-report.json file text — hashed byte-for-byte before parsing. */
    prescanReport: z.string().min(2).max(512 * 1024),
  })
  .strict();

const TrustBody = z
  .object({
    commitSha: z.string().regex(COMMIT_SHA),
    prescanSha256: z.string().regex(SHA256_HEX),
  })
  .strict();

/**
 * The provider-discriminated identity fields for the wire (0039 S1). An aws
 * project serializes `{accountId, region}` with NO `provider` key (byte-identical
 * to before); an azure project serializes `{provider:'azure', subscriptionId,
 * tenantId, location}` and omits accountId/region. Shared by both projections so
 * the thin and rich tiers never diverge on identity.
 */
function identityProjection(p: ProjectItem): Record<string, unknown> {
  if (p.provider === 'azure') {
    return {
      provider: 'azure',
      subscriptionId: p.subscriptionId,
      tenantId: p.tenantId,
      location: p.location,
    };
  }
  return { accountId: p.accountId, region: p.region };
}

/**
 * The client-safe projection. `rawReport` (the uploaded bytes) and PK/SK/GSI keys
 * never serialize; the parsed report DOES — the wizard's verdict/findings/census
 * render reads the server's stored truth, not a client-side re-parse.
 */
export function publicProject(p: ProjectItem): Record<string, unknown> {
  const trustRequest = p.trustRequest
    ? {
        repo: p.trustRequest.repo,
        commitSha: p.trustRequest.commitSha,
        prescanSha256: p.trustRequest.prescanSha256,
        uploadedBy: p.trustRequest.uploadedBy,
        uploadedAt: p.trustRequest.uploadedAt,
        report: p.trustRequest.report,
      }
    : undefined;
  // Repo shapes are served THROUGH the shim during migration: `repo` is always
  // present (derived for a legacy github-only row); the legacy `github` mirror
  // is present only when the host really is github (never a lie for gitlab).
  const repo = repoRefOf(p);
  const github = githubMirrorOf(repo);
  return {
    id: p.id,
    name: p.name,
    ...(github ? { github } : {}),
    ...(repo ? { repo } : {}),
    ...identityProjection(p),
    status: p.status,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    ...(trustRequest ? { trustRequest } : {}),
    ...(p.trust ? { trust: p.trust } : {}),
    ...(p.artifacts ? { artifacts: p.artifacts } : {}),
    ...(p.dataActive ? { dataActive: p.dataActive } : {}),
    ...(p.archived ? { archived: p.archived } : {}),
  };
}

/**
 * The LEAST-DISCLOSURE projection for a non-manage-tier session (security
 * review): exactly the documented "any session" registry shape.
 * It OMITS `trustRequest` (parsed report, findings with file+line, uploadedBy),
 * `createdBy`, `createdAt`, and `artifacts` — a plain requester with no
 * relationship to a project must not read its prescan findings or artifact
 * digests. `trust` (already the documented any-session field) is kept: it is the
 * public "is this repo trusted, at what commit" fact, not the review internals.
 */
export function publicProjectSummary(p: ProjectItem): Record<string, unknown> {
  const repo = repoRefOf(p);
  const github = githubMirrorOf(repo);
  return {
    id: p.id,
    name: p.name,
    ...(github ? { github } : {}),
    ...(repo ? { repo } : {}),
    ...identityProjection(p),
    status: p.status,
    ...(p.trust ? { trust: p.trust } : {}),
    // The archive flag is an existence-level fact every client needs to grey
    // the project out; the review internals stay rich-tier only.
    ...(p.archived ? { archived: p.archived } : {}),
  };
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function projectRoutes(opts: { dataRoot?: string } = {}): Hono<AppEnv> {
  const p = new Hono<AppEnv>();
  // Registry READS need any bound session; each write names its own stricter
  // gate below. Membership is checked against the
  // ACTING project (the x-ccp-project scope the caller operates from).
  // THE ONE CARVE-OUT: the CI upload-token lane (`PUT /projects/:id/data` or
  // `.../drift` with a Bearer upload token) is not a browser session — each
  // handler enforces its own fail-closed token gate (routes/projectData.ts,
  // routes/drift.ts), so the session + membership pair steps aside for
  // exactly that lane and nothing else.
  p.use('*', async (c, next) => {
    if (isUploadTokenLane(c.req.method, c.req.path, c.req.header('authorization'))) return next();
    return requireSession(c, next);
  });
  p.use('*', async (c, next) => {
    if (isUploadTokenLane(c.req.method, c.req.path, c.req.header('authorization'))) return next();
    return requireProjectMembership(c, next);
  });
  const dataRoot = opts.dataRoot ?? resolveProjectDataRoot();
  // The per-account data plane (upload tokens, token-authed upload, versions,
  // activate, archive/unarchive, and the serve endpoints).
  p.route('/', projectDataRoutes(dataRoot));
  // Drift telemetry (WI-2): token-authed report upload + role-projected
  // serve — mounted the same way, beside projectDataRoutes.
  p.route('/', driftRoutes(dataRoot));

  /* ── GET /projects — the registry (any bound session; TWO-TIER shape) ────── */
  p.get('/', async (c) => {
    const account = c.get('account')!;
    // Manage tier (lead+isAdmin — the register/trust/deregister tier) sees the
    // rich projection; every other bound session sees ONLY the documented
    // any-session summary, so a plain requester can never read another project's
    // prescan findings, uploader, or artifacts (security review, fail closed).
    // The lead check is PER PROJECT: the caller's role on the acting project.
    const manageTier = roleFor(account, c.get('projectId')) === 'lead' && account.isAdmin === true;
    const project = manageTier ? publicProject : publicProjectSummary;
    const items = (await c.get('store').queryGSI1(projectCollectionGsi())) as ProjectItem[];
    return c.json(items.map(project));
  });

  /* ── POST /projects — register a draft (lead + isAdmin) ───────── */
  p.post('/', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const parsed = RegisterBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const { id } = parsed.data;
    // The reserved control scope (@control) can never collide — it fails the
    // PROJECT_ID_RE grammar by construction. Any READY project is known
    // without needing a fresh store read; a store row of ANY status ALSO
    // collides (draft/pending-trust/trusted rows exist but aren't yet known).
    const k = projectKey(id);
    if (isKnownProject(id) || (await store.get(k.PK, k.SK))) return apiError(c, 'DUPLICATE_PROJECT');

    // Canonical storage regardless of which shape was sent: always the
    // host-agnostic `repo`, plus the legacy `github` mirror when the host is
    // github (so every legacy reader keeps working during migration).
    const repo = parsed.data.repo ?? repoRefOf({ github: parsed.data.github })!;
    const github = githubMirrorOf(repo);
    // Provider-discriminated identity: an azure project stores its subscription/
    // tenant/location triple (and `provider:'azure'`); an aws project stores
    // accountId/region and — the wire convention — NO `provider` key, so the
    // stored row stays byte-identical to every pre-azure register.
    const identity: Partial<ProjectItem> =
      parsed.data.provider === 'azure'
        ? {
            provider: 'azure',
            subscriptionId: parsed.data.subscriptionId,
            tenantId: parsed.data.tenantId,
            location: parsed.data.location,
          }
        : { accountId: parsed.data.accountId, region: parsed.data.region };
    const item: ProjectItem = {
      ...k,
      id,
      name: parsed.data.name,
      repo,
      ...(github ? { github } : {}),
      ...identity,
      status: 'draft',
      createdBy: actor,
      createdAt: nowIso(),
      version: 1,
      GSI1PK: projectCollectionGsi(),
      GSI1SK: id,
    };
    await transactWithAudit(
      store,
      c.get('projectId'),
      [{ kind: 'put', item: item as never, ifNotExists: true }],
      { action: 'project-register', actor, targetType: 'project', targetId: id, after: publicProject(item) },
    );
    return c.json(publicProject(item), 201);
  });

  /* ── PUT /projects/:id/trust-request — upload the local run's artifacts ─── */
  p.put('/:id/trust-request', requireRole('lead'), async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const parsed = TrustRequestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const k = projectKey(id);
    const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    // Only a not-yet-trusted project accepts (re-)uploads. Re-aiming a TRUSTED or
    // READY project's binding would silently invalidate a recorded human decision —
    // the deliberate path is deregister (dual-controlled) + a fresh onboard.
    if (project.status !== 'draft' && project.status !== 'pending-trust') {
      return apiError(c, 'STATE_CONFLICT');
    }

    const { trustRequest, prescanReport } = parsed.data;
    // 1. THE BINDING: recompute sha256 over the exact uploaded bytes.
    const computed = sha256Hex(prescanReport);
    if (computed !== trustRequest.prescanSha256) {
      return apiError(c, 'PRESCAN_SHA_MISMATCH', { computed, expected: trustRequest.prescanSha256 });
    }
    // 2. Only then parse + strictly validate what those bytes claim to be.
    let reportJson: unknown;
    try {
      reportJson = JSON.parse(prescanReport);
    } catch {
      return apiError(c, 'VALIDATION_FAILED', { field: 'prescanReport', problem: 'not valid JSON' });
    }
    const report = PrescanReport.safeParse(reportJson);
    if (!report.success) {
      return apiError(c, 'VALIDATION_FAILED', { field: 'prescanReport', problem: 'not a prescan-report.json' });
    }
    // 3. The two artifacts must describe the SAME scan.
    if (report.data.repo !== trustRequest.repo) {
      return apiError(c, 'VALIDATION_FAILED', { field: 'repo', problem: 'trust-request and prescan-report disagree' });
    }

    const record: ProjectTrustRequestRecord = {
      repo: trustRequest.repo,
      commitSha: trustRequest.commitSha,
      prescanSha256: trustRequest.prescanSha256,
      uploadedBy: actor,
      uploadedAt: nowIso(),
      report: report.data,
      rawReport: prescanReport,
    };
    const updated: ProjectItem = {
      ...project,
      status: 'pending-trust',
      trustRequest: record,
      version: project.version + 1,
    };
    await transactWithAudit(store, c.get('projectId'), [{ kind: 'put', item: updated as never }], {
      action: 'project-trust-request',
      actor,
      targetType: 'project',
      targetId: id,
      before: { status: project.status },
      after: {
        status: 'pending-trust',
        commitSha: record.commitSha,
        prescanSha256: record.prescanSha256,
        verdict: report.data.verdict,
        findings: report.data.findings.length,
      },
    });
    return c.json(publicProject(updated));
  });

  /* ── POST /projects/:id/trust — the dual-controlled trust decision ──────── */
  p.post('/:id/trust', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const parsed = TrustBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const k = projectKey(id);
    const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);
    if (project.status !== 'pending-trust' || !project.trustRequest) return apiError(c, 'STATE_CONFLICT');

    const tr = project.trustRequest;
    // The confirmer must echo the STORED binding — a mismatch means they are
    // confirming something other than what was uploaded.
    if (parsed.data.commitSha !== tr.commitSha || parsed.data.prescanSha256 !== tr.prescanSha256) {
      return apiError(c, 'VALIDATION_FAILED', { field: 'commitSha/prescanSha256', problem: 'does not match the stored trust request' });
    }
    // Defense in depth: re-verify the stored bytes still hash to the binding.
    if (sha256Hex(tr.rawReport) !== tr.prescanSha256) {
      return apiError(c, 'PRESCAN_SHA_MISMATCH', { expected: tr.prescanSha256 });
    }
    // FAIL-CLOSED VERDICT RULE: a reject verdict never reaches a trust ack.
    if (tr.report.verdict !== 'clean') {
      return apiError(c, 'TRUST_VERDICT_NOT_CLEAN', { verdict: tr.report.verdict, findings: tr.report.findings.length });
    }

    const trust: ProjectTrustBlock = {
      trustedBy: actor,
      trustedAt: nowIso(),
      preScanReportSha256: tr.prescanSha256,
      commitSha: tr.commitSha,
    };
    // ALWAYS dual-control (loosening): the proposer's decision applies only via a
    // SECOND distinct admin's ack; the version guard makes a re-upload between
    // propose and ack fail STALE_PROPOSAL instead of trusting different bytes.
    const apply: ApplySpec = {
      op: 'update',
      pk: k.PK,
      sk: k.SK,
      set: { status: 'trusted', trust, version: project.version + 1 },
      guardAttr: 'version',
      guardValue: project.version,
    };
    const res = await commitOrPropose(store, c.get('projectId'), actor, {
      classification: 'loosening',
      kind: 'project-trust',
      targetKey: `PROJECT#${id}`,
      before: { status: project.status },
      after: { status: 'trusted', trust },
      apply,
      audit: { action: 'Trusted repo for onboarding', actor, targetType: 'project', targetId: id, after: { trust } },
    });
    /* istanbul ignore next — 'loosening' can never take the 200 branch */
    if (res.status === 200) return c.json({ ok: true });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── DELETE /projects/:id — deregister (always dual-controlled) ─────────── */
  p.delete('/:id', requireRole('lead'), requireAdmin, async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const k = projectKey(id);
    const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
    if (!project) return c.json({ code: 'NOT_FOUND', reason: 'No such project.' }, 404);

    const apply: ApplySpec = { op: 'delete', pk: k.PK, sk: k.SK, guardAttr: 'version', guardValue: project.version };
    const res = await commitOrPropose(store, c.get('projectId'), actor, {
      classification: 'loosening', // deregistering is destructive — ALWAYS a 2-admin envelope
      kind: 'project-deregister',
      targetKey: `PROJECT#${id}`,
      before: publicProject(project),
      after: null,
      apply,
      audit: { action: 'project-deregister', actor, targetType: 'project', targetId: id, before: publicProject(project) },
    });
    /* istanbul ignore next — 'loosening' can never take the 200 branch */
    if (res.status === 200) return c.json({ ok: true });
    return c.json(publicPendingChange(res.pending), 202);
  });

  return p;
}
