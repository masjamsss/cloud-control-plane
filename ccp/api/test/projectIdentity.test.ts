import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryStore } from "../src/store/memoryStore";
import type { ConfigStore } from "../src/store/configStore";
import type { AuditItem, ProjectItem } from "../src/store/schema";
import {
  isIdentityConfirmed,
  projectCollectionGsi,
  projectKey,
} from "../src/store/schema";
import { __resetKnownProjectsForTests } from "../src/projects";
import { __resetUploadRateLimitForTests } from "../src/middleware/rateLimit";
import { seed, seedAccount, sessionCookieFor } from "./helpers/seed";

/**
 * ADR-0033 Decision 5: PUT /projects/:id/identity (the human confirmation of
 * the scan-proposed cloud identity) and its fail-closed backstop —
 * POST /projects/:id/upload-tokens (the CI upload-token MINT) refuses
 * IDENTITY_UNCONFIRMED for a project with no confirmed identity, so a
 * project can never reach the data lane on an unconfirmed, machine-proposed
 * identity. Adversarial by construction like projects.test.ts /
 * projectData.test.ts: authz-denial per case, strict-body refusal, the
 * honest register-time-identity-counts-as-confirmed compatibility rule, and
 * least-disclosure (identityConfirmed is rich-tier only).
 */

function hdrs(
  cookie: string,
  opts: { json?: boolean; client?: boolean } = {},
): Record<string, string> {
  const h: Record<string, string> = { cookie };
  if (opts.client !== false) h["x-ccp-client"] = "ccp-spa";
  if (opts.json) h["content-type"] = "application/json";
  h["x-ccp-project"] = "sample";
  return h;
}

const sha256 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

const REGISTER = {
  id: "acme",
  name: "Acme estate",
  github: { owner: "acme-co", repo: "terraform-acme" },
  accountId: "123456789012",
  region: "ap-southeast-5",
};

const COMMIT = "abc123def4567890abc123def4567890abc123de";

function reportText(): string {
  return `${JSON.stringify(
    {
      repo: "terraform-acme",
      verdict: "clean",
      findings: [],
      resourceBlocks: 12,
      moduleBlocks: 0,
      tfJsonFiles: 0,
      fmtDirtyFiles: 0,
      providerPins: { aws: "~> 6.0" },
    },
    null,
    2,
  )}\n`;
}

type App = ReturnType<typeof createApp>;

type Setup = {
  store: ConfigStore;
  app: App;
  putra: string;
  lina: string;
  root: string;
  sari: string;
  budi: string;
};

async function setup(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store); // sari (requester) / budi (approver) / putra (lead+admin) / lina (lead, NOT admin)
  await seedAccount(store, {
    id: "root",
    role: "lead",
    teamId: "platform",
    isAdmin: true,
    projects: ["*"],
  });
  const app = createApp(store);
  return {
    store,
    app,
    putra: await sessionCookieFor(store, "putra"),
    lina: await sessionCookieFor(store, "lina"),
    root: await sessionCookieFor(store, "root"),
    sari: await sessionCookieFor(store, "sari"),
    budi: await sessionCookieFor(store, "budi"),
  };
}

/** register(REGISTER) → upload trust artifacts → propose trust → second-admin ack. Leaves 'acme' status 'trusted'. */
async function driveToTrusted(s: Setup): Promise<void> {
  const reg = await s.app.request("/projects", {
    method: "POST",
    headers: hdrs(s.putra, { json: true }),
    body: JSON.stringify(REGISTER),
  });
  expect(reg.status).toBe(201);
  const prescanReport = reportText();
  const up = await s.app.request("/projects/acme/trust-request", {
    method: "PUT",
    headers: hdrs(s.lina, { json: true }),
    body: JSON.stringify({
      trustRequest: {
        repo: "terraform-acme",
        commitSha: COMMIT,
        prescanSha256: sha256(prescanReport),
      },
      prescanReport,
    }),
  });
  expect(up.status).toBe(200);
  const propose = await s.app.request("/projects/acme/trust", {
    method: "POST",
    headers: hdrs(s.putra, { json: true }),
    body: JSON.stringify({
      commitSha: COMMIT,
      prescanSha256: sha256(prescanReport),
    }),
  });
  expect(propose.status).toBe(202);
  const pending = (await propose.json()) as { id: string };
  const ack = await s.app.request(`/admin/config-changes/${pending.id}/ack`, {
    method: "POST",
    headers: hdrs(s.root),
  });
  expect(ack.status).toBe(200);
}

/** register(REGISTER) only — leaves 'acme' at 'draft', i.e. PRE-TRUST, which is
 * the only lifecycle window PUT /identity accepts. Used by the tests below whose
 * subject is the route's own behaviour (field clearing, disclosure tier) rather
 * than the lifecycle: they previously reached that behaviour through
 * driveToTrusted, which the status gate now (correctly) refuses. */
async function registerOnly(s: Setup): Promise<void> {
  const reg = await s.app.request("/projects", {
    method: "POST",
    headers: hdrs(s.putra, { json: true }),
    body: JSON.stringify(REGISTER),
  });
  expect(reg.status).toBe(201);
}

/** Plant a project row directly at an arbitrary status/archived combination —
 * for asserting the gate refuses the post-trust states. */
async function plantProjectAt(
  store: ConfigStore,
  patch: {
    status: ProjectItem["status"];
    archived?: { archivedBy: string; archivedAt: string };
  },
  id = "acme",
): Promise<void> {
  const k = projectKey(id);
  await store.put({
    ...k,
    id,
    name: "Acme estate",
    repo: { host: "github", owner: "acme-co", name: "terraform-acme" },
    github: { owner: "acme-co", repo: "terraform-acme" },
    createdBy: "putra",
    createdAt: "2026-07-01T00:00:00.000Z",
    version: 1,
    GSI1PK: projectCollectionGsi(),
    GSI1SK: id,
    ...patch,
  });
}

/** Move an EXISTING project to a status, preserving everything else on the row.
 * Distinct from {@link plantProjectAt}, which builds a fresh row from scratch
 * and would erase exactly the identity these cases are about. */
async function promoteStatus(
  store: ConfigStore,
  status: ProjectItem["status"],
  id = "acme",
): Promise<void> {
  const k = projectKey(id);
  const row = (await store.get(k.PK, k.SK)) as ProjectItem;
  expect(row, `no such project ${id}`).toBeTruthy();
  await store.put({ ...row, status });
}

async function putIdentity(
  s: Setup,
  cookie: string,
  body: unknown,
  id = "acme",
): Promise<Response> {
  return s.app.request(`/projects/${id}/identity`, {
    method: "PUT",
    headers: hdrs(cookie, { json: true }),
    body: JSON.stringify(body),
  });
}

async function mint(s: Setup, id = "acme"): Promise<Response> {
  return s.app.request(`/projects/${id}/upload-tokens`, {
    method: "POST",
    headers: hdrs(s.putra, { json: true }),
  });
}

// Registry-lifecycle writes (register/trust/identity-confirm) audit to the
// ACTING scope's chain, not the target project's — same convention
// projects.test.ts's own auditActions() documents; every call here uses the
// default x-ccp-project ('sample') set by hdrs() above.
async function auditActions(
  store: ConfigStore,
  projectId = "sample",
): Promise<string[]> {
  const yyyymmNow = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  const items = (await store.query(
    `P#${projectId}#AUDIT#${yyyymmNow}`,
  )) as AuditItem[];
  return items.map((i) => i.action);
}

/** Plant a 'trusted' project row DIRECTLY (bypassing register) with NO
 * identity fields and NO identityConfirmed — the state a FUTURE url-only
 * register would produce (this phase's real POST /projects cannot produce
 * it, since RegisterBody still requires the full identity). */
async function plantUnconfirmedProject(
  store: ConfigStore,
  id = "acme",
): Promise<void> {
  const k = projectKey(id);
  await store.put({
    ...k,
    id,
    name: "Acme estate",
    repo: { host: "github", owner: "acme-co", name: "terraform-acme" },
    github: { owner: "acme-co", repo: "terraform-acme" },
    status: "trusted",
    createdBy: "putra",
    createdAt: "2026-07-01T00:00:00.000Z",
    version: 1,
    GSI1PK: projectCollectionGsi(),
    GSI1SK: id,
  });
}

const AWS_BODY = { accountId: "123456789012", region: "ap-southeast-1" };
const AZURE_BODY = {
  provider: "azure",
  subscriptionId: "11111111-2222-3333-4444-555555555555",
  tenantId: "66666666-7777-8888-9999-000000000000",
  location: "southeastasia",
};
const GCP_BODY = {
  provider: "gcp",
  gcpProjectId: "example-prod-app",
  gcpRegion: "us-central1",
};

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
});

describe("isIdentityConfirmed (pure predicate)", () => {
  const base = {
    status: "draft",
    createdBy: "x",
    createdAt: "x",
    version: 1,
  } as unknown as ProjectItem;

  it("true when identityConfirmed is present, regardless of identity fields", () => {
    expect(
      isIdentityConfirmed({
        ...base,
        identityConfirmed: { confirmedBy: "a", confirmedAt: "b" },
      }),
    ).toBe(true);
  });
  it("true for an aws project with accountId+region (register-time identity)", () => {
    expect(
      isIdentityConfirmed({
        ...base,
        accountId: "123456789012",
        region: "us-east-1",
      }),
    ).toBe(true);
  });
  it("false for an aws-shaped project missing region", () => {
    expect(isIdentityConfirmed({ ...base, accountId: "123456789012" })).toBe(
      false,
    );
  });
  it("true for an azure project with the full subscription/tenant/location triple", () => {
    expect(
      isIdentityConfirmed({
        ...base,
        provider: "azure",
        subscriptionId: "s",
        tenantId: "t",
        location: "eastus",
      }),
    ).toBe(true);
  });
  it("false for an azure project missing tenantId", () => {
    expect(
      isIdentityConfirmed({
        ...base,
        provider: "azure",
        subscriptionId: "s",
        location: "eastus",
      }),
    ).toBe(false);
  });
  it("true for a gcp project with gcpProjectId+gcpRegion (ADR-0034 G1)", () => {
    expect(
      isIdentityConfirmed({
        ...base,
        provider: "gcp",
        gcpProjectId: "example-prod-app",
        gcpRegion: "us-central1",
      }),
    ).toBe(true);
  });
  it("false for a gcp project missing gcpRegion — and its aws fields never count", () => {
    expect(
      isIdentityConfirmed({
        ...base,
        provider: "gcp",
        gcpProjectId: "example-prod-app",
        // the exact fail-open the census flagged: before the exhaustive
        // switch, this row fell into the AWS arm and stray accountId/region
        // could have judged a gcp project "confirmed"
        accountId: "123456789012",
        region: "us-east-1",
      }),
    ).toBe(false);
  });
  it("false for a project with no identity fields and no confirmation at all", () => {
    expect(isIdentityConfirmed({ ...base })).toBe(false);
  });
});

describe("PUT /projects/:id/identity — authz (fail closed)", () => {
  it("no session → 401", async () => {
    const { app } = await setup();
    // x-ccp-client included so the CSRF gate (also 403, but a different
    // concern) doesn't shadow the session check this case targets.
    const res = await app.request("/projects/acme/identity", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ccp-client": "ccp-spa",
      },
      body: JSON.stringify(AWS_BODY),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("NO_SESSION");
  });

  it("requester / approver → 403 FORBIDDEN_ROLE", async () => {
    const s = await setup();
    await driveToTrusted(s);
    for (const cookie of [s.sari, s.budi]) {
      const res = await putIdentity(s, cookie, AWS_BODY);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("FORBIDDEN_ROLE");
    }
  });

  it("lead without isAdmin → 403 NOT_ADMIN", async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await putIdentity(s, s.lina, AWS_BODY);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_ADMIN");
  });

  it("missing CSRF client header → 403 MISSING_CLIENT_HEADER", async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await s.app.request("/projects/acme/identity", {
      method: "PUT",
      headers: hdrs(s.putra, { json: true, client: false }),
      body: JSON.stringify(AWS_BODY),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("MISSING_CLIENT_HEADER");
  });

  it("lead + isAdmin → 200", async () => {
    const s = await setup();
    await registerOnly(s); // pre-trust: the window PUT /identity accepts
    const res = await putIdentity(s, s.putra, AWS_BODY);
    expect(res.status).toBe(200);
  });
});

describe("PUT /projects/:id/identity — validation (reuses the register validators, strictly)", () => {
  it("404 for an unknown project", async () => {
    const s = await setup();
    const res = await putIdentity(s, s.putra, AWS_BODY, "no-such-project");
    expect(res.status).toBe(404);
  });

  it("refuses a malformed body: bad accountId, unlisted region, mixed aws+azure fields, unknown key, missing required field", async () => {
    const s = await setup();
    await driveToTrusted(s);
    const bad = [
      { accountId: "12345", region: "ap-southeast-1" }, // not 12 digits
      { accountId: "123456789012", region: "mars-central-1" }, // not in REGION_ALLOWLIST
      { accountId: "123456789012" }, // missing region
      {
        accountId: "123456789012",
        region: "ap-southeast-1",
        tenantId: "11111111-2222-3333-4444-555555555555",
      }, // aws + azure field mixed
      { ...AZURE_BODY, subscriptionId: "not-a-guid" },
      { ...AZURE_BODY, location: "nowhereland" }, // not in AZURE_LOCATION_ALLOWLIST
      { ...AWS_BODY, extraField: "nope" }, // .strict() — mass assignment refused
      { ...GCP_BODY, gcpProjectId: "Bad-Case" }, // uppercase refused (ADR-0034 G1)
      { ...GCP_BODY, gcpRegion: "us-east-1" }, // an AWS region is not in GCP_REGION_ALLOWLIST
      { ...GCP_BODY, accountId: "123456789012" }, // gcp + aws field mixed
      { provider: "gcp", gcpProjectId: "example-prod-app" }, // missing gcpRegion
    ];
    for (const body of bad) {
      const res = await putIdentity(s, s.putra, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect((await res.json()).code, JSON.stringify(body)).toBe(
        "VALIDATION_FAILED",
      );
    }
  });

  it("refuses id/name/github/repo in the body — identity-confirm can only touch identity fields", async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await putIdentity(s, s.putra, {
      ...AWS_BODY,
      id: "someone-else",
      name: "Hijacked",
    });
    expect(res.status).toBe(422);
  });
});

describe("PUT /projects/:id/identity — happy path (single-admin, immediate, repeatable)", () => {
  it("confirms an aws identity: response + stored row carry identityConfirmed and the identity fields; audited", async () => {
    const s = await setup();
    await registerOnly(s); // pre-trust: the window PUT /identity accepts
    const res = await putIdentity(s, s.putra, AWS_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accountId).toBe("123456789012");
    expect(body.region).toBe("ap-southeast-1");
    expect(body.identityConfirmed).toMatchObject({ confirmedBy: "putra" });

    const k = projectKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as ProjectItem;
    expect(row.identityConfirmed?.confirmedBy).toBe("putra");
    expect(isIdentityConfirmed(row)).toBe(true);

    expect(await auditActions(s.store)).toContain("project-identity-confirm");
  });

  it("is REPEATABLE — a second confirm overwrites confirmedBy/confirmedAt", async () => {
    const s = await setup();
    await registerOnly(s); // pre-trust: the window PUT /identity accepts
    const first = await putIdentity(s, s.putra, AWS_BODY);
    const firstConfirmedAt = (
      (await first.json()) as { identityConfirmed: { confirmedAt: string } }
    ).identityConfirmed.confirmedAt;

    const second = await putIdentity(s, s.root, AWS_BODY);
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      identityConfirmed: { confirmedBy: string; confirmedAt: string };
    };
    expect(body.identityConfirmed.confirmedBy).toBe("root");
    expect(typeof body.identityConfirmed.confirmedAt).toBe("string");
    expect(firstConfirmedAt).toBeTruthy();
  });

  it("switching provider aws → azure CLEARS the stale aws fields (never leaves both shapes on the row)", async () => {
    const s = await setup();
    await registerOnly(s); // registered aws (draft): accountId/region already set
    const res = await putIdentity(s, s.putra, AZURE_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.provider).toBe("azure");
    expect(body.subscriptionId).toBe(AZURE_BODY.subscriptionId);
    expect(body.accountId).toBeUndefined();
    expect(body.region).toBeUndefined();

    const k = projectKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as ProjectItem;
    expect(row.accountId).toBeUndefined();
    expect(row.region).toBeUndefined();
    expect(row.subscriptionId).toBe(AZURE_BODY.subscriptionId);
  });

  it("confirms a gcp identity and a switch to gcp clears every other cloud's fields (ADR-0034 G1)", async () => {
    const s = await setup();
    await registerOnly(s); // registered aws (draft): accountId/region already set
    const res = await putIdentity(s, s.putra, GCP_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.provider).toBe("gcp");
    expect(body.gcpProjectId).toBe(GCP_BODY.gcpProjectId);
    expect(body.gcpRegion).toBe(GCP_BODY.gcpRegion);
    expect(body.accountId).toBeUndefined();
    expect(body.region).toBeUndefined();
    expect(body.subscriptionId).toBeUndefined();

    const k = projectKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as ProjectItem;
    expect(row.accountId).toBeUndefined();
    expect(row.region).toBeUndefined();
    expect(row.gcpProjectId).toBe(GCP_BODY.gcpProjectId);
    expect(isIdentityConfirmed(row)).toBe(true);
  });

  it("least disclosure: identityConfirmed is RICH-TIER only, absent from the thin ProjectSummary", async () => {
    const s = await setup();
    await registerOnly(s);
    await putIdentity(s, s.putra, AWS_BODY);

    const rich = (await (
      await s.app.request("/projects", { headers: hdrs(s.putra) })
    ).json()) as Array<Record<string, unknown>>;
    expect(rich.find((p) => p.id === "acme")?.identityConfirmed).toBeTruthy();

    const thin = (await (
      await s.app.request("/projects", { headers: hdrs(s.sari) })
    ).json()) as Array<Record<string, unknown>>;
    expect(
      thin.find((p) => p.id === "acme")?.identityConfirmed,
    ).toBeUndefined();
  });
});

describe("PUT /projects/:id/identity — lifecycle gate (settable only BEFORE the trust decision)", () => {
  // The identity IS which cloud account every future request for this project
  // targets. Left open post-trust, ONE admin could silently re-point a trusted —
  // or live, account-bound 'ready' — project at a different account while the
  // recorded two-admin trust decision still stood as if it had vouched for that
  // configuration. Same refusal the trust-request upload already gives for
  // re-aiming a trusted/ready binding; the deliberate path is deregister
  // (dual-controlled) + a fresh onboard.
  it("accepts at draft", async () => {
    const s = await setup();
    await registerOnly(s);
    expect((await putIdentity(s, s.putra, AWS_BODY)).status).toBe(200);
  });

  it("accepts at pending-trust", async () => {
    const s = await setup();
    await plantProjectAt(s.store, { status: "pending-trust" });
    expect((await putIdentity(s, s.putra, AWS_BODY)).status).toBe(200);
  });

  it("REFUSES once trusted — reached through the real two-admin ceremony, not a planted row", async () => {
    const s = await setup();
    await driveToTrusted(s);
    const res = await putIdentity(s, s.putra, AZURE_BODY);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "STATE_CONFLICT",
    );
    // and the stored identity is untouched — no partial write slipped through
    const k = projectKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as ProjectItem;
    expect(row.accountId).toBe(REGISTER.accountId);
    expect(row.subscriptionId).toBeUndefined();
  });

  it("REFUSES once ready (a live, account-bound scope)", async () => {
    const s = await setup();
    await plantProjectAt(s.store, { status: "ready" });
    const res = await putIdentity(s, s.putra, AWS_BODY);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "STATE_CONFLICT",
    );
  });

  it("REFUSES an archived project even at an otherwise-settable status", async () => {
    const s = await setup();
    await plantProjectAt(s.store, {
      status: "draft",
      archived: { archivedBy: "putra", archivedAt: "2026-07-02T00:00:00Z" },
    });
    const res = await putIdentity(s, s.putra, AWS_BODY);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "STATE_CONFLICT",
    );
  });

  it("a refused call writes NO audit event", async () => {
    const s = await setup();
    await driveToTrusted(s);
    const before = await auditActions(s.store);
    await putIdentity(s, s.putra, AWS_BODY);
    expect(await auditActions(s.store)).toEqual(before);
  });
});

describe("IDENTITY_UNCONFIRMED — the fail-closed backstop on upload-token mint", () => {
  it("a project registered the OLD way (identity typed at register time) mints FINE — no behavior change for existing/today projects", async () => {
    const s = await setup();
    await driveToTrusted(s); // register-time accountId/region present; NO explicit PUT /identity call
    const res = await mint(s);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tokenId: string; token: string };
    expect(body.tokenId).toBeTruthy();
  });

  it("a project with NO confirmed identity (simulating a future url-only register) refuses mint with 422 IDENTITY_UNCONFIRMED", async () => {
    const s = await setup();
    await plantUnconfirmedProject(s.store);
    const res = await mint(s);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("IDENTITY_UNCONFIRMED");
  });

  it("confirming identity in the PRE-TRUST review window unblocks the mint once trusted", async () => {
    // The intended url-only flow, in order: register (no identity) → scan
    // uploads → pending-trust → an admin CONFIRMS the proposed identity at the
    // review step → two admins trust → mint works. Confirmation belongs in that
    // pre-trust window, which is exactly what PUT /identity's gate allows.
    const s = await setup();
    await plantProjectAt(s.store, { status: "pending-trust" }); // planted WITHOUT identity
    const confirm = await putIdentity(s, s.putra, AWS_BODY);
    expect(confirm.status).toBe(200);

    // Reach trusted (the ceremony itself is covered by its own tests; here we
    // isolate the subject — that a CONFIRMED identity is what unblocks mint).
    const k = projectKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as ProjectItem;
    await s.store.put({ ...row, status: "trusted" });

    const unblocked = await mint(s);
    expect(unblocked.status).toBe(201);
  });

  it("a trusted project that never confirmed its identity is a DEAD END — mint refuses and the post-trust edit is refused too", async () => {
    // Defense in depth: this state is unreachable through the intended flow
    // (identity is confirmed pre-trust, above). If a row ever reaches it, the
    // recovery is the deliberate dual-controlled path — deregister + a fresh
    // onboard — NOT a single admin re-pointing a trusted project's cloud
    // account. When the url-only register lands, trust itself should require a
    // confirmed identity so this state cannot arise at all.
    const s = await setup();
    await plantUnconfirmedProject(s.store); // status 'trusted', no identity
    expect((await mint(s)).status).toBe(422);
    const late = await putIdentity(s, s.putra, AWS_BODY);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { code: string }).code).toBe(
      "STATE_CONFLICT",
    );
    expect((await mint(s)).status).toBe(422); // still blocked — no way around it
  });

  it("archived / wrong-status still refuse STATE_CONFLICT BEFORE identity is even considered", async () => {
    const s = await setup();
    // 'acme' never registered at all → draft/pending-trust is never reached; use a fresh, never-trusted id.
    const reg = await s.app.request("/projects", {
      method: "POST",
      headers: hdrs(s.putra, { json: true }),
      body: JSON.stringify({ ...REGISTER, id: "draftproj" }),
    });
    expect(reg.status).toBe(201);
    const res = await mint(s, "draftproj"); // still 'draft' — not UPLOADABLE regardless of identity
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STATE_CONFLICT");
  });
});

/**
 * Decision 5's other half, now built: REGISTER MAY DEFER THE IDENTITY. A body
 * carrying no identity key at all is the url-only register — the scan proposes
 * the values and a human confirms them. What must hold either way is that a
 * person decides: the deferred project is NOT identity-confirmed, so the data
 * lane stays shut behind IDENTITY_UNCONFIRMED until somebody looks.
 */
describe("register with a DEFERRED identity (the url-only form)", () => {
  const URL_ONLY = {
    id: "acme",
    name: "Acme estate",
    repo: { host: "github", owner: "acme-co", name: "terraform-acme" },
  };

  async function registerUrlOnly(
    s: Setup,
    body: unknown = URL_ONLY,
  ): Promise<Response> {
    return s.app.request("/projects", {
      method: "POST",
      headers: hdrs(s.putra, { json: true }),
      body: JSON.stringify(body),
    });
  }

  it("accepts a body with NO identity key and stores NO identity fields", async () => {
    const s = await setup();
    expect((await registerUrlOnly(s)).status).toBe(201);

    const k = projectKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as ProjectItem;
    expect(row.status).toBe("draft");
    // Not "set to undefined" — genuinely absent, so the row is honestly
    // "identity unknown" rather than pretending to an empty answer.
    for (const key of [
      "provider",
      "accountId",
      "region",
      "subscriptionId",
      "tenantId",
      "location",
      "gcpProjectId",
      "gcpRegion",
    ])
      expect(row).not.toHaveProperty(key);
    expect(row.identityConfirmed).toBeUndefined();
    expect(isIdentityConfirmed(row)).toBe(false);
  });

  it("that project can still be scanned and reach trust review", async () => {
    // The deferral must not block onboarding — only the DATA lane.
    const s = await setup();
    await registerUrlOnly(s);
    const report = reportText();
    const res = await s.app.request("/projects/acme/trust-request", {
      method: "PUT",
      headers: hdrs(s.putra, { json: true }),
      body: JSON.stringify({
        trustRequest: {
          repo: "terraform-acme",
          commitSha: COMMIT,
          prescanSha256: sha256(report),
        },
        prescanReport: report,
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending-trust");
  });

  it("but the DATA lane stays shut until a human confirms — IDENTITY_UNCONFIRMED", async () => {
    const s = await setup();
    await registerUrlOnly(s);
    // Move it to 'trusted' so the mint's own status gate is satisfied and the
    // ONLY thing left standing between it and a token is the identity check.
    await promoteStatus(s.store, "trusted");
    const res = await mint(s);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("IDENTITY_UNCONFIRMED");
  });

  it("…and opens once an admin confirms the identity, pre-trust", async () => {
    const s = await setup();
    await registerUrlOnly(s);
    expect((await putIdentity(s, s.putra, AWS_BODY)).status).toBe(200);
    await promoteStatus(s.store, "trusted");
    expect((await mint(s)).status).toBe(201);
  });

  it("HALF an identity is a mistake, not a deferral — still refused", async () => {
    const s = await setup();
    for (const partial of [
      { accountId: "123456789012" }, // no region
      { region: "ap-southeast-1" }, // no accountId
      { provider: "azure" }, // named a cloud, gave nothing
      {
        provider: "azure",
        subscriptionId: "11111111-2222-3333-4444-555555555555",
      },
      {
        accountId: "123456789012",
        region: "ap-southeast-1",
        location: "southeastasia",
      }, // mixed
      { provider: "gcp" }, // named a cloud, gave nothing (ADR-0034 G1)
      { provider: "gcp", gcpRegion: "us-central1" }, // no gcpProjectId
      { gcpProjectId: "example-prod-app", region: "ap-southeast-1" }, // mixed gcp + aws
    ]) {
      const res = await registerUrlOnly(s, { ...URL_ONLY, ...partial });
      expect(res.status, JSON.stringify(partial)).toBe(422);
    }
  });

  it("a COMPLETE identity at register still counts as confirmed — nothing regressed", async () => {
    const s = await setup();
    await registerOnly(s); // the classic body, identity typed by a human
    const k = projectKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as ProjectItem;
    expect(isIdentityConfirmed(row)).toBe(true);
    await promoteStatus(s.store, "trusted");
    expect((await mint(s)).status).toBe(201);
  });
});
