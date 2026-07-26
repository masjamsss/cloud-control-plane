import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { monotonicFactory } from "ulid";
import type { AppEnv } from "../appEnv";
import type {
  ProjectItem,
  ProjectOnboardTokenItem,
  ProjectScanJobItem,
  ProjectTrustBlock,
  ProjectTrustRequestRecord,
} from "../store/schema";
import {
  CiProvenance,
  PrescanReport,
  RepoRef,
  SCAN_JOB_SK_PREFIX,
  githubMirrorOf,
  onboardTokenKey,
  projectCollectionGsi,
  projectKey,
  repoRefOf,
  scanJobKey,
  scanJobQueueGsi,
} from "../store/schema";
import {
  buildCloneUrl,
  isTerminalScanStatus,
  scannerEnabled,
  scannerWorkerKey,
} from "../domain/scanner";
import type { ApplySpec } from "../store/schema";
import { apiError } from "../errors";
import { requireSession } from "../middleware/session";
import {
  requireAdmin,
  requireProjectMembership,
  requireRole,
} from "../middleware/authz";
import { checkUploadRateLimit } from "../middleware/rateLimit";
import { verifyPassword } from "../auth/credentials";
import { isKnownProject, PROJECT_ID_RE, roleFor } from "../projects";
import { commitOrPropose, publicPendingChange } from "../domain/dualControl";
import { isOnboardable, mintOnboardToken } from "../domain/onboardToken";
import { transactWithAudit } from "../domain/audit";
import { nowIso, nowMs } from "../clock";
import { projectDataRoutes } from "./projectData";
import { driftRoutes } from "./drift";
import { resolveProjectDataRoot } from "../domain/projectData";
import { isOnboardTokenLane, isUploadTokenLane } from "../middleware/session";

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
 *
 * EASY FIRST IMPORT (spec `docs/superpowers/specs/2026-07-24-easy-first-import.md`
 * §3 A-ii/A-iii, ADR-0031, Phase 1): the FIRST scan's artifact pair can now also
 * travel over a machine lane instead of a human paste. `POST/DELETE
 * /:id/onboard-tokens` mint/revoke a NARROW, PRE-TRUST-ONLY credential — a
 * separate type and key namespace from the CI upload token above, legal only
 * while draft/pending-trust (the EXACT INVERSE of the upload token's gate,
 * so the two credentials' lifetimes never overlap). It authorizes EXACTLY
 * ONE verb: `PUT /:id/trust-request` may now ALSO be called with
 * `Authorization: Bearer <tokenId>.<secret>` instead of a session — the
 * handler runs its own fail-closed token gate before any body work, then
 * falls through to the SAME validation pipeline a session upload always ran
 * (sha binding, strict parse, artifact-disagreement refusal, status gate).
 * The two-admin trust ceremony below is completely untouched either way.
 */

/** Explicit AWS commercial-region allowlist ("region allowlist") —
 * fail-closed: an unlisted region string is refused, not normalized. */
export const REGION_ALLOWLIST = [
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "mx-central-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
] as const;

/** Explicit Azure location allowlist ("location allowlist" — the azure analogue
 * of REGION_ALLOWLIST, 0039 S1). Fail-closed: an unlisted location string is
 * refused, not normalized. Azure names its regions as one lowercase word
 * (`southeastasia`, `eastus2`) — the `azure-fixture` project's `southeastasia`
 * is here so an operator can onboard that exact subscription. */
export const AZURE_LOCATION_ALLOWLIST = [
  "australiaeast",
  "australiasoutheast",
  "brazilsouth",
  "canadacentral",
  "canadaeast",
  "centralindia",
  "centralus",
  "eastasia",
  "eastus",
  "eastus2",
  "francecentral",
  "germanywestcentral",
  "japaneast",
  "japanwest",
  "koreacentral",
  "northcentralus",
  "northeurope",
  "norwayeast",
  "southafricanorth",
  "southcentralus",
  "southeastasia",
  "southindia",
  "swedencentral",
  "switzerlandnorth",
  "uaenorth",
  "uksouth",
  "ukwest",
  "westeurope",
  "westus",
  "westus2",
  "westus3",
] as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;
/** Git object id: 7–64 lowercase hex (short sha through sha256-repo full sha). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;
/** AWS account id — 12 digits. Shared by RegisterBody and IdentityBody below
 * (ADR-0033 Decision 5: reuse, never duplicate this regex). */
const AWS_ACCOUNT_ID = /^\d{12}$/;
/** An Azure identifier GUID (subscription id / tenant id) — the canonical
 * 8-4-4-4-12 hex form, case-insensitive (the portal shows lowercase). */
const AZURE_GUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The provider-discriminated identity FIELDS shared by RegisterBody (identity
 * typed at register time) and IdentityBody (ADR-0033 Decision 5, `PUT
 * /:id/identity` — identity confirmed after the scan proposes it). Both embed
 * this shape and apply {@link refineIdentityShape}, so the two can never drift
 * apart on what counts as a valid aws/azure identity. */
const IdentityFields = {
  /** Absent = 'aws' (the wire convention — an aws body never carries it). */
  provider: z.enum(["aws", "azure"]).optional(),
  /** AWS identity (provider absent/'aws'). */
  accountId: z.string().regex(AWS_ACCOUNT_ID).optional(),
  region: z.enum(REGION_ALLOWLIST).optional(),
  /** Azure identity (provider 'azure') — subscription + tenant GUIDs + location. */
  subscriptionId: z.string().regex(AZURE_GUID).optional(),
  tenantId: z.string().regex(AZURE_GUID).optional(),
  location: z.enum(AZURE_LOCATION_ALLOWLIST).optional(),
} as const;

/**
 * Exactly the identity shape the provider names — present, and not the other
 * cloud's. An aws body needs accountId+region and no azure field; an azure
 * body needs subscriptionId+tenantId+location and no aws field. Shared
 * `superRefine` body for RegisterBody and IdentityBody (ADR-0033 Decision 5)
 * — ONE rule, so the register-time and confirm-time identity shapes can never
 * silently diverge.
 */
function refineIdentityShape(
  b: {
    provider?: "aws" | "azure";
    accountId?: string;
    region?: string;
    subscriptionId?: string;
    tenantId?: string;
    location?: string;
  },
  ctx: z.RefinementCtx,
): void {
  const provider = b.provider ?? "aws";
  const bad = (path: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  if (provider === "aws") {
    if (b.accountId === undefined)
      bad("accountId", "an aws project needs an accountId");
    if (b.region === undefined) bad("region", "an aws project needs a region");
    for (const k of ["subscriptionId", "tenantId", "location"] as const) {
      if (b[k] !== undefined) bad(k, `an aws project must not carry ${k}`);
    }
  } else {
    if (b.subscriptionId === undefined)
      bad("subscriptionId", "an azure project needs a subscriptionId");
    if (b.tenantId === undefined)
      bad("tenantId", "an azure project needs a tenantId");
    if (b.location === undefined)
      bad("location", "an azure project needs a location");
    for (const k of ["accountId", "region"] as const) {
      if (b[k] !== undefined) bad(k, `an azure project must not carry ${k}`);
    }
  }
}

/** The six identity keys. A register body that carries NONE of them is
 * DEFERRING its identity to the scan's proposal + a human confirm; a body that
 * carries ANY of them is typing one now, and must type a complete, unmixed
 * one. Named once so the deferral test and the refine below cannot drift. */
const IDENTITY_KEYS = [
  "provider",
  "accountId",
  "region",
  "subscriptionId",
  "tenantId",
  "location",
] as const;

function carriesAnyIdentity(b: Record<string, unknown>): boolean {
  return IDENTITY_KEYS.some((k) => b[k] !== undefined);
}

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
    ...IdentityFields,
  })
  .strict()
  // Exactly ONE repo shape per register — accepting both invites divergence.
  .refine((b) => (b.github !== undefined) !== (b.repo !== undefined), {
    message: "send exactly one of github or repo",
  })
  // IDENTITY IS OPTIONAL AT REGISTER (Decision 5, the url-only register this
  // schema's own comments were written in anticipation of). A body carrying
  // NO identity key at all defers it: the scan proposes the values with
  // file:line provenance and an admin confirms them through
  // `PUT /:id/identity`. That project is NOT identity-confirmed
  // (schema.ts#isIdentityConfirmed returns false for it), so the fail-closed
  // backstop on upload-token mint refuses it IDENTITY_UNCONFIRMED until a
  // human has actually looked — the deferral moves WHEN identity is decided,
  // never WHETHER a person decides it.
  //
  // A body carrying ANY identity key still gets the FULL, unchanged rule:
  // complete for its provider and not mixed with the other cloud's. Half an
  // identity is a mistake, not a deferral, so `{provider:'azure'}` alone is
  // refused exactly as before.
  .superRefine((b, ctx) => {
    if (!carriesAnyIdentity(b)) return;
    refineIdentityShape(b, ctx);
  });

/**
 * `PUT /projects/:id/identity` body (ADR-0033 Decision 5) — the SAME
 * provider-discriminated identity shape RegisterBody validates (same fields,
 * same {@link refineIdentityShape} rule), on its own so this route never
 * accepts `id`/`name`/`github`/`repo` (mass-assignment defence — identity
 * confirm can only ever touch identity fields).
 */
const IdentityBody = z
  .object(IdentityFields)
  .strict()
  .superRefine(refineIdentityShape);

/** The provider-discriminated identity fields to WRITE onto a ProjectItem for
 * one validated {@link IdentityBody} parse (ADR-0033 Decision 5). UNLIKE the
 * register path's own identity construction (which builds a brand-new item
 * and so never needs to erase anything), this one EXPLICITLY clears the other
 * cloud's fields — `PUT /:id/identity` updates an EXISTING row, and a switch
 * of provider must not leave stale azure fields on an now-aws project (or vice
 * versa); an explicit `undefined` clears a key the same way `unarchive`
 * already relies on (routes/projectData.ts). */
function identityFieldsFor(
  body: z.infer<typeof IdentityBody>,
): Partial<ProjectItem> {
  if (body.provider === "azure") {
    return {
      provider: "azure",
      subscriptionId: body.subscriptionId,
      tenantId: body.tenantId,
      location: body.location,
      accountId: undefined,
      region: undefined,
    };
  }
  return {
    provider: undefined,
    accountId: body.accountId,
    region: body.region,
    subscriptionId: undefined,
    tenantId: undefined,
    location: undefined,
  };
}

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
    prescanReport: z
      .string()
      .min(2)
      .max(512 * 1024),
    /** OPTIONAL CI-run provenance (easy-first-import spec §3 A-iii) — see
     * {@link CiProvenance}. Malformed → the whole body is refused (same
     * `.strict()`/no-mass-assignment posture as every field on this route);
     * omitted → treated as absent, byte-identical to before this field existed. */
    ci: CiProvenance.optional(),
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
  if (p.provider === "azure") {
    return {
      provider: "azure",
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
        ...(p.trustRequest.ci ? { ci: p.trustRequest.ci } : {}),
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
    // ADR-0033 Decision 5 — rich-tier only (same least-disclosure posture as
    // uploadedBy/createdBy above: who confirmed the identity and when is
    // review-internal, not a fact every bound session needs).
    ...(p.identityConfirmed ? { identityConfirmed: p.identityConfirmed } : {}),
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

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/* ── the pre-trust onboarding token (easy-first-import spec §3 A-ii) ─────────
 * A SEPARATE credential from the CI upload token (projectData.ts): own regex
 * shapes, own key namespace (schema.ts#onboardTokenKey), own status gate —
 * fail-closed, the two must never be cross-usable (I10). */

/**
 * MONOTONIC ulid for scan-job ids — same reason domain/audit.ts uses one: the
 * jobId IS the sort key, in the project's SK range (`latest` reads the last row)
 * AND in the worker queue's GSI (which is claimed oldest-first). Plain `ulid()`
 * randomizes the low bits within a millisecond, so two jobs minted in the same
 * tick could sort backwards — making "latest" and "FIFO" true only most of the
 * time. Monotonic makes the documented order actually hold.
 */
const jobUlid = monotonicFactory();

const ONBOARD_TOKEN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/; // ulid
const ONBOARD_TOKEN_SECRET = /^[A-Za-z0-9_-]{20,100}$/; // 32 random bytes, base64url

const OnboardMintBody = z
  .object({
    /** Token lifetime in minutes; default 24h, max 7 days — mirrors the CI upload token's knobs. */
    ttlMinutes: z.number().int().min(5).max(10_080).optional(),
  })
  .strict();

const ONBOARD_DEFAULT_TTL_MINUTES = 24 * 60;

export function projectRoutes(opts: { dataRoot?: string } = {}): Hono<AppEnv> {
  const p = new Hono<AppEnv>();
  // Registry READS need any bound session; each write names its own stricter
  // gate below. Membership is checked against the
  // ACTING project (the x-ccp-project scope the caller operates from).
  // THE CARVE-OUTS: the CI upload-token lane (`PUT /projects/:id/data` or
  // `.../drift` with a Bearer upload token) and the PRE-TRUST onboard-token
  // lane (`PUT /projects/:id/trust-request` with a Bearer onboard token,
  // easy-first-import spec §3 A-iii) are not browser sessions — each handler
  // enforces its own fail-closed token gate (routes/projectData.ts,
  // routes/drift.ts, and inline below), so the session + membership pair
  // steps aside for exactly those two lanes and nothing else.
  function isTokenLane(c: Context<AppEnv>): boolean {
    const auth = c.req.header("authorization");
    return (
      isUploadTokenLane(c.req.method, c.req.path, auth) ||
      isOnboardTokenLane(c.req.method, c.req.path, auth)
    );
  }
  p.use("*", async (c, next) => {
    if (isTokenLane(c)) return next();
    return requireSession(c, next);
  });
  p.use("*", async (c, next) => {
    if (isTokenLane(c)) return next();
    return requireProjectMembership(c, next);
  });
  const dataRoot = opts.dataRoot ?? resolveProjectDataRoot();
  // The per-account data plane (upload tokens, token-authed upload, versions,
  // activate, archive/unarchive, and the serve endpoints).
  p.route("/", projectDataRoutes(dataRoot));
  // Drift telemetry (WI-2): token-authed report upload + role-projected
  // serve — mounted the same way, beside projectDataRoutes.
  p.route("/", driftRoutes(dataRoot));

  /* ── GET /projects — the registry (any bound session; TWO-TIER shape) ────── */
  p.get("/", async (c) => {
    const account = c.get("account")!;
    // Manage tier (lead+isAdmin — the register/trust/deregister tier) sees the
    // rich projection; every other bound session sees ONLY the documented
    // any-session summary, so a plain requester can never read another project's
    // prescan findings, uploader, or artifacts (security review, fail closed).
    // The lead check is PER PROJECT: the caller's role on the acting project.
    const manageTier =
      roleFor(account, c.get("projectId")) === "lead" &&
      account.isAdmin === true;
    const project = manageTier ? publicProject : publicProjectSummary;
    const items = (await c
      .get("store")
      .queryGSI1(projectCollectionGsi())) as ProjectItem[];
    return c.json(items.map(project));
  });

  /* ── POST /projects — register a draft (lead + isAdmin) ───────── */
  p.post("/", requireRole("lead"), requireAdmin, async (c) => {
    const store = c.get("store");
    const actor = c.get("account")!.id;
    const parsed = RegisterBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, "VALIDATION_FAILED");
    const { id } = parsed.data;
    // The reserved control scope (@control) can never collide — it fails the
    // PROJECT_ID_RE grammar by construction. Any READY project is known
    // without needing a fresh store read; a store row of ANY status ALSO
    // collides (draft/pending-trust/trusted rows exist but aren't yet known).
    const k = projectKey(id);
    if (isKnownProject(id) || (await store.get(k.PK, k.SK)))
      return apiError(c, "DUPLICATE_PROJECT");

    // Canonical storage regardless of which shape was sent: always the
    // host-agnostic `repo`, plus the legacy `github` mirror when the host is
    // github (so every legacy reader keeps working during migration).
    const repo = parsed.data.repo ?? repoRefOf({ github: parsed.data.github })!;
    const github = githubMirrorOf(repo);
    // Provider-discriminated identity: an azure project stores its subscription/
    // tenant/location triple (and `provider:'azure'`); an aws project stores
    // accountId/region and — the wire convention — NO `provider` key, so the
    // stored row stays byte-identical to every pre-azure register.
    // A deferred identity writes NO identity keys at all — not keys set to
    // undefined. The row is then honestly "identity unknown", which is what
    // isIdentityConfirmed reads to keep the data lane closed until a human
    // confirms the scan's proposal.
    const identity: Partial<ProjectItem> = !carriesAnyIdentity(parsed.data)
      ? {}
      : parsed.data.provider === "azure"
        ? {
            provider: "azure",
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
      status: "draft",
      createdBy: actor,
      createdAt: nowIso(),
      version: 1,
      GSI1PK: projectCollectionGsi(),
      GSI1SK: id,
    };
    await transactWithAudit(
      store,
      c.get("projectId"),
      [{ kind: "put", item: item as never, ifNotExists: true }],
      {
        action: "project-register",
        actor,
        targetType: "project",
        targetId: id,
        after: publicProject(item),
      },
    );
    return c.json(publicProject(item), 201);
  });

  /* ── POST /projects/:id/onboard-tokens — mint a pre-trust onboarding token ──
   * (lead+isAdmin). Legal ONLY while draft/pending-trust — the exact inverse
   * of the upload token's trusted/ready gate (projectData.ts) — refused for
   * trusted/ready/archived. The token authorizes exactly one verb: the Bearer
   * lane on PUT /:id/trust-request below. */
  p.post(
    "/:id/onboard-tokens",
    requireRole("lead"),
    requireAdmin,
    async (c) => {
      const store = c.get("store");
      const actor = c.get("account")!.id;
      const id = c.req.param("id");
      // An empty body means "defaults"; a present body must validate strictly.
      const bodyText = await c.req.text();
      let raw: unknown = {};
      if (bodyText.trim().length > 0) {
        try {
          raw = JSON.parse(bodyText);
        } catch {
          return apiError(c, "VALIDATION_FAILED", {
            field: "body",
            problem: "not valid JSON",
          });
        }
      }
      const parsed = OnboardMintBody.safeParse(raw);
      if (!parsed.success) return apiError(c, "VALIDATION_FAILED");

      const k = projectKey(id);
      const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
      if (!project)
        return c.json({ code: "NOT_FOUND", reason: "No such project." }, 404);
      // Fail closed: only a project that has NOT yet passed trust review has a
      // legitimate pre-trust CI producer; an archived project mints nothing.
      if (!isOnboardable(project)) return apiError(c, "STATE_CONFLICT");

      // The mint itself is shared with the scanner worker's claim lane
      // (domain/onboardToken.ts) so both produce an identically-hardened
      // credential; the status gate above stays HERE, where it is enforced.
      // The clear token is shown exactly ONCE — only its argon2id hash is stored.
      const minted = await mintOnboardToken(
        store,
        id,
        actor,
        parsed.data.ttlMinutes ?? ONBOARD_DEFAULT_TTL_MINUTES,
      );
      return c.json(minted, 201);
    },
  );

  /* ── DELETE /projects/:id/onboard-tokens/:tokenId — revoke (lead+isAdmin) ──
   * Soft-revoke (unlike the upload token's hard delete): the row survives,
   * stamped `revokedAt`, mirroring `ProjectItem.archived` — the Bearer lane's
   * gate below checks `revokedAt` as its own explicit fail-closed step. */
  p.delete(
    "/:id/onboard-tokens/:tokenId",
    requireRole("lead"),
    requireAdmin,
    async (c) => {
      const store = c.get("store");
      const actor = c.get("account")!.id;
      const id = c.req.param("id");
      const tokenId = c.req.param("tokenId");
      if (!PROJECT_ID_RE.test(id) || !ONBOARD_TOKEN_ID.test(tokenId)) {
        return c.json(
          { code: "NOT_FOUND", reason: "No such onboarding token." },
          404,
        );
      }
      const k = onboardTokenKey(id, tokenId);
      const row = (await store.get(
        k.PK,
        k.SK,
      )) as ProjectOnboardTokenItem | null;
      if (!row || row.revokedAt)
        return c.json(
          { code: "NOT_FOUND", reason: "No such onboarding token." },
          404,
        );
      const revokedAt = nowIso();
      // Audit to the TARGET project's chain (same rule as mint).
      await transactWithAudit(
        store,
        id,
        [{ kind: "update", pk: k.PK, sk: k.SK, set: { revokedAt } }],
        {
          action: "onboard-token-revoke",
          actor,
          targetType: "project",
          targetId: id,
          before: { tokenId, expiresAt: row.expiresAt },
          after: { revokedAt },
        },
      );
      return c.json({ ok: true, revoked: true });
    },
  );

  /* ── POST /projects/:id/scan-jobs — ask the control plane to scan this
   * project's repository itself (ADR-0033) ──────────────────────────────────
   * lead + isAdmin. Records the INTENT only: a separate, isolated worker does
   * the cloning and parsing. Refusals, in order, are all fail-closed:
   *   - the scanner lane is not armed on this deployment (SCANNER_DISABLED) —
   *     checked FIRST so a disabled deployment leaks nothing about the project;
   *   - the project is past the pre-trust window, or archived (STATE_CONFLICT);
   *   - a job is already in flight for this project (STATE_CONFLICT) — one at a
   *     time, so a repeated click cannot fan out clones;
   *   - the repo cannot be turned into an allowed clone target
   *     (SCAN_TARGET_REFUSED). This is validated HERE, at creation, so an
   *     operator learns immediately instead of the job failing opaquely later —
   *     and the URL is rebuilt again at claim time, never stored on the row. */
  p.post("/:id/scan-jobs", requireRole("lead"), requireAdmin, async (c) => {
    const store = c.get("store");
    const actor = c.get("account")!.id;
    const id = c.req.param("id");

    if (!scannerEnabled() || scannerWorkerKey() === null)
      return apiError(c, "SCANNER_DISABLED");

    const k = projectKey(id);
    const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
    if (!project)
      return c.json({ code: "NOT_FOUND", reason: "No such project." }, 404);
    if (!isOnboardable(project)) return apiError(c, "STATE_CONFLICT");

    const repo = repoRefOf(project);
    if (!repo) return apiError(c, "SCAN_TARGET_REFUSED");
    // Prove the target resolves before queueing anything. The result is
    // deliberately DISCARDED — the worker gets a freshly-built URL at claim
    // time, so nothing derived from a credentialed or host-specific string is
    // ever persisted.
    if (!buildCloneUrl(repo).ok) return apiError(c, "SCAN_TARGET_REFUSED");

    const existing = (await store.query(
      k.PK,
      SCAN_JOB_SK_PREFIX,
    )) as ProjectScanJobItem[];
    if (existing.some((j) => !isTerminalScanStatus(j.status)))
      return apiError(c, "STATE_CONFLICT");

    const jobId = jobUlid();
    const item: ProjectScanJobItem = {
      ...scanJobKey(id, jobId),
      jobId,
      projectId: id,
      status: "queued",
      createdBy: actor,
      createdAt: nowIso(),
      // Enters the queue partition; the claim's compare-and-swap moves it out.
      GSI1PK: scanJobQueueGsi(),
      GSI1SK: jobId,
    };
    await transactWithAudit(
      store,
      id,
      [{ kind: "put", item: item as never, ifNotExists: true }],
      {
        action: "scan-job-create",
        actor,
        targetType: "project",
        targetId: id,
        after: { jobId, status: "queued" },
      },
    );
    return c.json({ jobId, status: "queued" }, 201);
  });

  /* ── GET /projects/:id/scan-jobs/latest — the wizard's progress read ───────
   * lead + isAdmin (rich tier). Returns the most recent job only. `error` is
   * already sanitized at write time; nothing here carries a clone URL or a
   * token, so the response cannot disclose how the deployment reaches the
   * forge. ULID jobIds sort chronologically, so the last row is the newest. */
  p.get(
    "/:id/scan-jobs/latest",
    requireRole("lead"),
    requireAdmin,
    async (c) => {
      const store = c.get("store");
      const id = c.req.param("id");
      const rows = (await store.query(
        projectKey(id).PK,
        SCAN_JOB_SK_PREFIX,
      )) as ProjectScanJobItem[];
      const latest = rows[rows.length - 1];
      if (!latest)
        return c.json({ code: "NOT_FOUND", reason: "No scan job." }, 404);
      return c.json({
        jobId: latest.jobId,
        status: latest.status,
        createdAt: latest.createdAt,
        ...(latest.startedAt ? { startedAt: latest.startedAt } : {}),
        ...(latest.finishedAt ? { finishedAt: latest.finishedAt } : {}),
        ...(latest.error ? { error: latest.error } : {}),
      });
    },
  );

  /* ── PUT /projects/:id/trust-request — upload the run's artifacts, either a
   * session (the existing local-run lane) OR a pre-trust onboard-token Bearer
   * (the CI lane, easy-first-import spec §3 A-iii) ─────────────────────────── */
  p.put(
    "/:id/trust-request",
    // The onboard-token Bearer lane has no session to hold a role — the token
    // itself (verified inside the handler, before any body work) IS the
    // authorization for exactly that lane, mirroring PUT /:id/data's own
    // route-level absence of requireRole (projectData.ts). Every
    // session-based caller is completely unaffected: requireRole('lead') runs
    // exactly as it always has.
    async (c, next) => {
      if (
        isOnboardTokenLane(
          c.req.method,
          c.req.path,
          c.req.header("authorization"),
        )
      )
        return next();
      return requireRole("lead")(c, next);
    },
    async (c) => {
      const store = c.get("store");
      const id = c.req.param("id");

      // ── the onboard-token Bearer lane's OWN fail-closed gate, entirely
      // BEFORE any body work — the SAME order as the CI upload lane
      // (projectData.ts PUT /:id/data): header shape -> per-tokenId rate
      // limit -> store lookup -> project binding -> not-revoked -> expiry ->
      // argon2id verify -> project status gate. A separate token type/
      // namespace from the upload token (onboardTokenKey, never
      // uploadTokenKey) — the two are never cross-usable (I10). Once this
      // whole gate passes, `tokenActor` is set and control falls through to
      // the pre-existing validation pipeline below, UNCHANGED.
      let tokenActor: string | undefined;
      const authHeader = c.req.header("authorization") ?? "";
      if (isOnboardTokenLane(c.req.method, c.req.path, authHeader)) {
        const m =
          /^Bearer\s+([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{20,100})$/.exec(
            authHeader,
          );
        if (
          !m ||
          !ONBOARD_TOKEN_ID.test(m[1]!) ||
          !ONBOARD_TOKEN_SECRET.test(m[2]!)
        )
          return apiError(c, "ONBOARD_TOKEN_INVALID");
        const [, tokenId, secret] = m;
        if (!PROJECT_ID_RE.test(id))
          return apiError(c, "ONBOARD_TOKEN_INVALID");
        // Rate limit BEFORE any store read or argon2id work — tokenId is
        // semi-public (DoS hardening, same posture as the upload lane).
        const rate = checkUploadRateLimit(tokenId!);
        if (!rate.ok)
          return apiError(c, "RATE_LIMITED", {
            retryAfter: rate.retryAfterSeconds,
          });
        const tKey = onboardTokenKey(id, tokenId!);
        const token = (await store.get(
          tKey.PK,
          tKey.SK,
        )) as ProjectOnboardTokenItem | null;
        // One generic refusal for unknown/wrong-project/revoked/expired/wrong-secret — no enumeration.
        if (!token || token.projectId !== id)
          return apiError(c, "ONBOARD_TOKEN_INVALID");
        if (token.revokedAt) return apiError(c, "ONBOARD_TOKEN_INVALID");
        if (Date.parse(token.expiresAt) <= nowMs())
          return apiError(c, "ONBOARD_TOKEN_INVALID");
        if (!(await verifyPassword(token.secretHash, secret!)))
          return apiError(c, "ONBOARD_TOKEN_INVALID");
        // Defense in depth (mirrors the upload lane's own "a valid token
        // cannot bypass the project state gate" posture, projectData.test.ts):
        // re-check status BEFORE any body work, even though the unchanged
        // pipeline below checks it again right after.
        const pk = projectKey(id);
        const preCheck = (await store.get(pk.PK, pk.SK)) as ProjectItem | null;
        if (!preCheck)
          return c.json({ code: "NOT_FOUND", reason: "No such project." }, 404);
        if (preCheck.status !== "draft" && preCheck.status !== "pending-trust")
          return apiError(c, "STATE_CONFLICT");
        tokenActor = `onboard-token:${tokenId}`;
      }

      const actor = tokenActor ?? c.get("account")!.id;
      const parsed = TrustRequestBody.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) return apiError(c, "VALIDATION_FAILED");

      const k = projectKey(id);
      const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
      if (!project)
        return c.json({ code: "NOT_FOUND", reason: "No such project." }, 404);
      // Only a not-yet-trusted project accepts (re-)uploads. Re-aiming a TRUSTED or
      // READY project's binding would silently invalidate a recorded human decision —
      // the deliberate path is deregister (dual-controlled) + a fresh onboard.
      if (project.status !== "draft" && project.status !== "pending-trust") {
        return apiError(c, "STATE_CONFLICT");
      }

      const { trustRequest, prescanReport, ci } = parsed.data;
      // 1. THE BINDING: recompute sha256 over the exact uploaded bytes.
      const computed = sha256Hex(prescanReport);
      if (computed !== trustRequest.prescanSha256) {
        return apiError(c, "PRESCAN_SHA_MISMATCH", {
          computed,
          expected: trustRequest.prescanSha256,
        });
      }
      // 2. Only then parse + strictly validate what those bytes claim to be.
      let reportJson: unknown;
      try {
        reportJson = JSON.parse(prescanReport);
      } catch {
        return apiError(c, "VALIDATION_FAILED", {
          field: "prescanReport",
          problem: "not valid JSON",
        });
      }
      const report = PrescanReport.safeParse(reportJson);
      if (!report.success) {
        return apiError(c, "VALIDATION_FAILED", {
          field: "prescanReport",
          problem: "not a prescan-report.json",
        });
      }
      // 3. The two artifacts must describe the SAME scan.
      if (report.data.repo !== trustRequest.repo) {
        return apiError(c, "VALIDATION_FAILED", {
          field: "repo",
          problem: "trust-request and prescan-report disagree",
        });
      }

      const record: ProjectTrustRequestRecord = {
        repo: trustRequest.repo,
        commitSha: trustRequest.commitSha,
        prescanSha256: trustRequest.prescanSha256,
        uploadedBy: actor,
        uploadedAt: nowIso(),
        report: report.data,
        rawReport: prescanReport,
        ...(ci ? { ci } : {}),
      };
      const updated: ProjectItem = {
        ...project,
        status: "pending-trust",
        trustRequest: record,
        version: project.version + 1,
      };
      // Data-plane-shaped write over a Bearer token has no acting scope
      // (exactly the upload lane's own reasoning, projectData.ts) -> audits
      // to the TARGET project's chain. A normal session upload keeps
      // auditing to the ACTING scope's chain, unchanged.
      const auditProjectId = tokenActor ? id : c.get("projectId");
      await transactWithAudit(
        store,
        auditProjectId,
        [{ kind: "put", item: updated as never }],
        {
          action: "project-trust-request",
          actor,
          targetType: "project",
          targetId: id,
          before: { status: project.status },
          after: {
            status: "pending-trust",
            commitSha: record.commitSha,
            prescanSha256: record.prescanSha256,
            verdict: report.data.verdict,
            findings: report.data.findings.length,
          },
        },
      );
      return c.json(publicProject(updated));
    },
  );

  /* ── POST /projects/:id/trust — the dual-controlled trust decision ──────── */
  p.post("/:id/trust", requireRole("lead"), requireAdmin, async (c) => {
    const store = c.get("store");
    const actor = c.get("account")!.id;
    const id = c.req.param("id");
    const parsed = TrustBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, "VALIDATION_FAILED");

    const k = projectKey(id);
    const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
    if (!project)
      return c.json({ code: "NOT_FOUND", reason: "No such project." }, 404);
    if (project.status !== "pending-trust" || !project.trustRequest)
      return apiError(c, "STATE_CONFLICT");

    const tr = project.trustRequest;
    // The confirmer must echo the STORED binding — a mismatch means they are
    // confirming something other than what was uploaded.
    if (
      parsed.data.commitSha !== tr.commitSha ||
      parsed.data.prescanSha256 !== tr.prescanSha256
    ) {
      return apiError(c, "VALIDATION_FAILED", {
        field: "commitSha/prescanSha256",
        problem: "does not match the stored trust request",
      });
    }
    // Defense in depth: re-verify the stored bytes still hash to the binding.
    if (sha256Hex(tr.rawReport) !== tr.prescanSha256) {
      return apiError(c, "PRESCAN_SHA_MISMATCH", {
        expected: tr.prescanSha256,
      });
    }
    // FAIL-CLOSED VERDICT RULE: a reject verdict never reaches a trust ack.
    if (tr.report.verdict !== "clean") {
      return apiError(c, "TRUST_VERDICT_NOT_CLEAN", {
        verdict: tr.report.verdict,
        findings: tr.report.findings.length,
      });
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
      op: "update",
      pk: k.PK,
      sk: k.SK,
      set: { status: "trusted", trust, version: project.version + 1 },
      guardAttr: "version",
      guardValue: project.version,
    };
    const res = await commitOrPropose(store, c.get("projectId"), actor, {
      classification: "loosening",
      kind: "project-trust",
      targetKey: `PROJECT#${id}`,
      before: { status: project.status },
      after: { status: "trusted", trust },
      apply,
      audit: {
        action: "Trusted repo for onboarding",
        actor,
        targetType: "project",
        targetId: id,
        after: { trust },
      },
    });
    /* istanbul ignore next — 'loosening' can never take the 200 branch */
    if (res.status === 200) return c.json({ ok: true });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── PUT /projects/:id/identity — record the admin-confirmed cloud identity
   * (ADR-0033 Decision 5) ───────────────────────────────────────────────────
   * Single-admin, IMMEDIATE write — mirrors register's own guard+apply shape
   * (requireRole('lead')+requireAdmin, transactWithAudit), deliberately NOT
   * the two-admin dual-control ceremony POST /:id/trust uses: the ADR scopes
   * "two-admin ceremony... untouched" to trust and the first data activation
   * only (Decision item 6) — this is a new route, not one of those two, so it
   * follows the OTHER existing single-admin pattern this surface already has
   * (register). Body is the SAME provider-discriminated shape RegisterBody
   * validates (IdentityBody, same regex/allowlist validators, same
   * refineIdentityShape rule) — reused, never duplicated. Callable repeatedly
   * to correct a mistake WHILE STILL PRE-TRUST: each call OVERWRITES the stored
   * identity fields (identityFieldsFor explicitly clears the other cloud's
   * fields on a provider switch) and re-stamps identityConfirmed with the
   * latest confirmer/time.
   *
   * GATED to draft/pending-trust (isOnboardable), and refused for an archived
   * project. This is NOT harmless metadata: the identity IS which cloud account
   * every future request for this project targets. Leaving it open post-trust
   * would let ONE admin silently re-point a trusted — or live, account-bound
   * `ready` — project at a different account, while the recorded two-admin
   * trust decision still stood as if it had vouched for that configuration.
   * That is the identical failure the trust-request upload already refuses a
   * few hundred lines above ("Re-aiming a TRUSTED or READY project's binding
   * would silently invalidate a recorded human decision"), and the identity is
   * part of that same binding — so it takes the same answer: the deliberate
   * path is deregister (dual-controlled) + a fresh onboard.
   * See isIdentityConfirmed (schema.ts) for how a
   * project registered the OLD way (identity typed at register time — still
   * how POST /projects works this phase) already counts as confirmed WITHOUT
   * ever calling this route; Audit: project-identity-confirm. */
  p.put("/:id/identity", requireRole("lead"), requireAdmin, async (c) => {
    const store = c.get("store");
    const actor = c.get("account")!.id;
    const id = c.req.param("id");
    const parsed = IdentityBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, "VALIDATION_FAILED");

    const k = projectKey(id);
    const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
    if (!project)
      return c.json({ code: "NOT_FOUND", reason: "No such project." }, 404);
    // Fail closed: identity is part of the binding two admins trust, so it is
    // settable only BEFORE that decision exists (see the docblock above).
    if (!isOnboardable(project)) return apiError(c, "STATE_CONFLICT");

    const identityConfirmed = { confirmedBy: actor, confirmedAt: nowIso() };
    const updated: ProjectItem = {
      ...project,
      ...identityFieldsFor(parsed.data),
      identityConfirmed,
      version: project.version + 1,
    };
    await transactWithAudit(
      store,
      c.get("projectId"),
      [{ kind: "put", item: updated as never }],
      {
        action: "project-identity-confirm",
        actor,
        targetType: "project",
        targetId: id,
        before: identityProjection(project),
        after: { ...identityProjection(updated), ...identityConfirmed },
      },
    );
    return c.json(publicProject(updated));
  });

  /* ── DELETE /projects/:id — deregister (always dual-controlled) ─────────── */
  p.delete("/:id", requireRole("lead"), requireAdmin, async (c) => {
    const store = c.get("store");
    const actor = c.get("account")!.id;
    const id = c.req.param("id");
    const k = projectKey(id);
    const project = (await store.get(k.PK, k.SK)) as ProjectItem | null;
    if (!project)
      return c.json({ code: "NOT_FOUND", reason: "No such project." }, 404);

    const apply: ApplySpec = {
      op: "delete",
      pk: k.PK,
      sk: k.SK,
      guardAttr: "version",
      guardValue: project.version,
    };
    const res = await commitOrPropose(store, c.get("projectId"), actor, {
      classification: "loosening", // deregistering is destructive — ALWAYS a 2-admin envelope
      kind: "project-deregister",
      targetKey: `PROJECT#${id}`,
      before: publicProject(project),
      after: null,
      apply,
      audit: {
        action: "project-deregister",
        actor,
        targetType: "project",
        targetId: id,
        before: publicProject(project),
      },
    });
    /* istanbul ignore next — 'loosening' can never take the 200 branch */
    if (res.status === 200) return c.json({ ok: true });
    return c.json(publicPendingChange(res.pending), 202);
  });

  return p;
}
