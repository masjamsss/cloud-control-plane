import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryStore } from "../src/store/memoryStore";
import type { ConfigStore } from "../src/store/configStore";
import type { ProjectItem, ProjectScanJobItem } from "../src/store/schema";
import {
  SCAN_JOB_SK_PREFIX,
  projectCollectionGsi,
  projectKey,
} from "../src/store/schema";
import { __resetKnownProjectsForTests } from "../src/projects";
import { __resetUploadRateLimitForTests } from "../src/middleware/rateLimit";
import { seed, seedAccount, sessionCookieFor } from "./helpers/seed";

/**
 * ADR-0033: the operator half of the server-side scan lane — asking the control
 * plane to scan a repo itself. Adversarial throughout: the lane must be INERT
 * unless the deployment armed it, must refuse outside the pre-trust window, must
 * never fan out concurrent clones, and must refuse a repo it is not allowed to
 * reach — all before anything is queued.
 */

const KEY = "s".repeat(32);

function hdrs(cookie: string, json = false): Record<string, string> {
  const h: Record<string, string> = {
    cookie,
    "x-ccp-client": "ccp-spa",
    "x-ccp-project": "sample",
  };
  if (json) h["content-type"] = "application/json";
  return h;
}

type Setup = {
  store: ConfigStore;
  app: ReturnType<typeof createApp>;
  putra: string;
  lina: string;
  sari: string;
};

async function setup(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store);
  await seedAccount(store, {
    id: "root",
    role: "lead",
    teamId: "platform",
    isAdmin: true,
    projects: ["*"],
  });
  return {
    store,
    app: createApp(store),
    putra: await sessionCookieFor(store, "putra"), // lead + isAdmin
    lina: await sessionCookieFor(store, "lina"), // lead, NOT admin
    sari: await sessionCookieFor(store, "sari"), // requester
  };
}

async function plantProject(
  store: ConfigStore,
  patch: Partial<ProjectItem> = {},
  id = "acme",
): Promise<void> {
  const k = projectKey(id);
  await store.put({
    ...k,
    id,
    name: "Acme estate",
    repo: { host: "github", owner: "example-org", name: "terraform-example" },
    status: "draft",
    createdBy: "putra",
    createdAt: "2026-07-01T00:00:00.000Z",
    version: 1,
    GSI1PK: projectCollectionGsi(),
    GSI1SK: id,
    ...patch,
  } as ProjectItem as never);
}

async function createJob(
  s: Setup,
  cookie: string,
  id = "acme",
): Promise<Response> {
  return s.app.request(`/projects/${id}/scan-jobs`, {
    method: "POST",
    headers: hdrs(cookie, true),
  });
}

async function latest(
  s: Setup,
  cookie: string,
  id = "acme",
): Promise<Response> {
  return s.app.request(`/projects/${id}/scan-jobs/latest`, {
    headers: hdrs(cookie),
  });
}

const arm = (): void => {
  process.env.CCP_SCANNER = "1";
  process.env.CCP_SCANNER_KEY = KEY;
};

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
  delete process.env.CCP_SCANNER;
  delete process.env.CCP_SCANNER_KEY;
  delete process.env.CCP_FORGE_HOSTS;
});
afterEach(() => {
  delete process.env.CCP_SCANNER;
  delete process.env.CCP_SCANNER_KEY;
  delete process.env.CCP_FORGE_HOSTS;
});

describe("POST /projects/:id/scan-jobs — the lane is INERT unless armed", () => {
  it("refuses SCANNER_DISABLED when CCP_SCANNER is unset (the default deployment)", async () => {
    const s = await setup();
    await plantProject(s.store);
    const res = await createJob(s, s.putra);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "SCANNER_DISABLED",
    );
  });

  it("refuses when armed but the worker key is missing or too weak — a misconfig is a closed lane", async () => {
    const s = await setup();
    await plantProject(s.store);
    process.env.CCP_SCANNER = "1";
    for (const key of [undefined, "", "tooshort"]) {
      if (key === undefined) delete process.env.CCP_SCANNER_KEY;
      else process.env.CCP_SCANNER_KEY = key;
      const res = await createJob(s, s.putra);
      expect(res.status, String(key)).toBe(409);
    }
  });

  it("queues nothing when disabled — the refusal is not a partial write", async () => {
    const s = await setup();
    await plantProject(s.store);
    await createJob(s, s.putra);
    const rows = await s.store.query(projectKey("acme").PK, SCAN_JOB_SK_PREFIX);
    expect(rows).toHaveLength(0);
  });
});

describe("POST /projects/:id/scan-jobs — authz", () => {
  it("refuses a requester and a non-admin lead, and an anonymous caller", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    for (const cookie of [s.sari, s.lina]) {
      expect([401, 403]).toContain((await createJob(s, cookie)).status);
    }
    const anon = await s.app.request("/projects/acme/scan-jobs", {
      method: "POST",
      headers: { "x-ccp-client": "ccp-spa", "x-ccp-project": "sample" },
    });
    expect([401, 403]).toContain(anon.status);
  });
});

describe("POST /projects/:id/scan-jobs — lifecycle and target gates", () => {
  it("queues for a draft project and returns the job id", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const res = await createJob(s, s.putra);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { jobId: string; status: string };
    expect(body.status).toBe("queued");
    expect(body.jobId).toBeTruthy();
  });

  it("refuses once the project is past the pre-trust window, or archived", async () => {
    for (const patch of [
      { status: "trusted" as const },
      { status: "ready" as const },
      {
        status: "draft" as const,
        archived: { archivedBy: "putra", archivedAt: "2026-07-02T00:00:00Z" },
      },
    ]) {
      const s = await setup();
      arm();
      await plantProject(s.store, patch);
      const res = await createJob(s, s.putra);
      expect(res.status, JSON.stringify(patch)).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(
        "STATE_CONFLICT",
      );
    }
  });

  it("allows only ONE job in flight — a second click cannot fan out clones", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    expect((await createJob(s, s.putra)).status).toBe(201);
    const second = await createJob(s, s.putra);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe(
      "STATE_CONFLICT",
    );
  });

  it("allows a new job once the previous one reached a terminal state", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const first = (await (await createJob(s, s.putra)).json()) as {
      jobId: string;
    };
    const k = projectKey("acme");
    const row = (await s.store.get(
      k.PK,
      `${SCAN_JOB_SK_PREFIX}${first.jobId}`,
    )) as ProjectScanJobItem;
    await s.store.put({ ...row, status: "failed", error: "boom" } as never);
    expect((await createJob(s, s.putra)).status).toBe(201);
  });

  it("refuses a repo host this deployment may not clone from — checked BEFORE queueing", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store, {
      repo: {
        host: "github",
        baseUrl: "https://git.internal.test",
        owner: "example-org",
        name: "terraform-example",
      },
    } as Partial<ProjectItem>);
    const res = await createJob(s, s.putra);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(
      "SCAN_TARGET_REFUSED",
    );
    expect(
      await s.store.query(projectKey("acme").PK, SCAN_JOB_SK_PREFIX),
    ).toHaveLength(0);
  });

  it("accepts that same host once the deployment allowlists it", async () => {
    const s = await setup();
    arm();
    process.env.CCP_FORGE_HOSTS = "git.internal.test";
    await plantProject(s.store, {
      repo: {
        host: "github",
        baseUrl: "https://git.internal.test",
        owner: "example-org",
        name: "terraform-example",
      },
    } as Partial<ProjectItem>);
    expect((await createJob(s, s.putra)).status).toBe(201);
  });

  it("404s for a project that does not exist", async () => {
    const s = await setup();
    arm();
    expect((await createJob(s, s.putra, "nope")).status).toBe(404);
  });
});

describe("GET /projects/:id/scan-jobs/latest", () => {
  it("404s before any job, then reports the queued job", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    expect((await latest(s, s.putra)).status).toBe(404);
    await createJob(s, s.putra);
    const res = await latest(s, s.putra);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("queued");
    expect(body.createdAt).toBeTruthy();
  });

  it("returns the NEWEST job when several exist", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const first = (await (await createJob(s, s.putra)).json()) as {
      jobId: string;
    };
    const k = projectKey("acme");
    const row = (await s.store.get(
      k.PK,
      `${SCAN_JOB_SK_PREFIX}${first.jobId}`,
    )) as ProjectScanJobItem;
    await s.store.put({ ...row, status: "uploaded" } as never);
    const second = (await (await createJob(s, s.putra)).json()) as {
      jobId: string;
    };
    const body = (await (await latest(s, s.putra)).json()) as {
      jobId: string;
    };
    expect(body.jobId).toBe(second.jobId);
    expect(body.jobId).not.toBe(first.jobId);
  });

  it("never discloses a clone URL or a token, even on a failed job", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const j = (await (await createJob(s, s.putra)).json()) as { jobId: string };
    const k = projectKey("acme");
    const row = (await s.store.get(
      k.PK,
      `${SCAN_JOB_SK_PREFIX}${j.jobId}`,
    )) as ProjectScanJobItem;
    await s.store.put({
      ...row,
      status: "failed",
      error: "clone failed",
    } as never);
    const text = await (await latest(s, s.putra)).text();
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain(KEY);
  });

  it("is rich-tier: a requester cannot read it", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await createJob(s, s.putra);
    expect([401, 403]).toContain((await latest(s, s.sari)).status);
  });
});
