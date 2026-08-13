import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryStore } from "../src/store/memoryStore";
import type { ConfigStore } from "../src/store/configStore";
import type { ProjectItem, ProjectScanJobItem } from "../src/store/schema";
import {
  forgeCredentialKey,
  projectCollectionGsi,
  projectKey,
  scanJobKey,
} from "../src/store/schema";
import { __resetKnownProjectsForTests } from "../src/projects";
import { __resetUploadRateLimitForTests } from "../src/middleware/rateLimit";
import { __setGithubAppFetchForTests } from "../src/routes/scanJobs";
import type { FetchLike } from "../src/domain/forgeCredentials";
import { seed, sessionCookieFor } from "./helpers/seed";

/**
 * ADR-0033 Decision 1 at the route level: storing a private repo's read-only
 * token, and handing the worker access at claim time.
 *
 * The whole point of these cases is DISCLOSURE. A forge token is the one secret
 * in this system that grants access to something outside it, so:
 *
 *  - it lives on its own row, never on the project row every registry read
 *    serializes;
 *  - no endpoint ever reads it back — not the setter's own response, not the
 *    registry, not the audit trail;
 *  - only the scanner worker sees it, once per job, already assembled into the
 *    header it needs.
 */

const SEAL = "f".repeat(40);
const WORKER = "w".repeat(48);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const TOKEN = "synthetic-forge-token-not-a-real-one";

function hdrs(cookie: string): Record<string, string> {
  return {
    cookie,
    "x-ccp-client": "ccp-spa",
    "x-ccp-project": "sample",
    "content-type": "application/json",
  };
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

async function setCred(
  s: Setup,
  cookie: string,
  body: unknown = { username: "oauth2", token: TOKEN },
  id = "acme",
): Promise<Response> {
  return s.app.request(`/projects/${id}/forge-credential`, {
    method: "PUT",
    headers: hdrs(cookie),
    body: JSON.stringify(body),
  });
}

async function queueJob(s: Setup, id = "acme"): Promise<string> {
  const res = await s.app.request(`/projects/${id}/scan-jobs`, {
    method: "POST",
    headers: hdrs(s.putra),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { jobId: string }).jobId;
}

async function claim(s: Setup): Promise<Response> {
  return s.app.request("/scan-jobs/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${WORKER}` },
  });
}

const ENV_KEYS = [
  "CCP_SCANNER",
  "CCP_SCANNER_KEY",
  "CCP_FORGE_SEAL_KEY",
  "CCP_GITHUB_APP_ID",
  "CCP_GITHUB_APP_KEY",
  "CCP_GITHUB_APP_KEY_FILE",
];
const armScanner = (): void => {
  process.env.CCP_SCANNER = "1";
  process.env.CCP_SCANNER_KEY = WORKER;
};

beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
  ENV_KEYS.forEach((k) => delete process.env[k]);
});
afterEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  // Restore the real fetch — a fake left installed would follow this file into
  // every other test sharing the worker process.
  __setGithubAppFetchForTests(null);
});

describe("PUT /projects/:id/forge-credential", () => {
  it("stores it sealed on its OWN row and never echoes the token back", async () => {
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    await plantProject(s.store);

    const res = await setCred(s, s.putra);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The response confirms WHICH identity is stored, never the secret.
    expect(JSON.parse(body)).toEqual({ username: "oauth2" });
    expect(body).not.toContain(TOKEN);

    const k = forgeCredentialKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as { sealed: string } | null;
    expect(row).toBeTruthy();
    expect(row!.sealed).not.toContain(TOKEN);
    expect(row!.sealed).not.toContain("synthetic-forge");

    // …and NOT on the project row, which every registry read serializes.
    const pk = projectKey("acme");
    const project = JSON.stringify(await s.store.get(pk.PK, pk.SK));
    expect(project).not.toContain(TOKEN);
    expect(project).not.toContain("sealed");
  });

  it("the registry read never carries it, on either tier", async () => {
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    await plantProject(s.store);
    await setCred(s, s.putra);
    for (const cookie of [s.putra, s.sari]) {
      const res = await s.app.request("/projects", { headers: hdrs(cookie) });
      const text = await res.text();
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("sealed");
    }
  });

  it("the audit trail records that one was stored, never the token", async () => {
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    await plantProject(s.store);
    await setCred(s, s.putra);
    const rows = await s.store.query(`PROJECT#acme`);
    const audit = JSON.stringify(
      (await s.store.query("AUDIT#acme#202607")).concat(rows),
    );
    expect(audit).not.toContain(TOKEN);
  });

  it("REFUSES when the deployment has no seal key — never a weaker fallback", async () => {
    const s = await setup();
    await plantProject(s.store);
    const res = await setCred(s, s.putra);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(
      "FORGE_CREDENTIAL_REFUSED",
    );
    const k = forgeCredentialKey("acme");
    expect(await s.store.get(k.PK, k.SK)).toBeNull();
  });

  it("needs lead + admin, and refuses a strict-body violation", async () => {
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    await plantProject(s.store);
    expect((await setCred(s, s.lina)).status).toBe(403); // lead, not admin
    expect((await setCred(s, s.sari)).status).toBe(403); // requester
    for (const bad of [
      {},
      { username: "oauth2" },
      { token: TOKEN },
      { username: "oauth2", token: TOKEN, extra: 1 },
      { username: "has:colon", token: TOKEN },
      { username: "has space", token: TOKEN },
      { username: "oauth2", token: "short" },
    ]) {
      expect((await setCred(s, s.putra, bad)).status, JSON.stringify(bad)).toBe(
        422,
      );
    }
  });

  it("404s an unknown project and refuses an archived one", async () => {
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    expect((await setCred(s, s.putra)).status).toBe(404);
    await plantProject(s.store, {
      archived: { archivedBy: "putra", archivedAt: "2026-07-02T00:00:00.000Z" },
    });
    expect((await setCred(s, s.putra)).status).toBe(409);
  });

  it("replacing it overwrites — a rotated token does not need a delete first", async () => {
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    await plantProject(s.store);
    await setCred(s, s.putra);
    await setCred(s, s.putra, { username: "gitlab-ci", token: "synthetic-rotated-token" });
    const k = forgeCredentialKey("acme");
    const row = (await s.store.get(k.PK, k.SK)) as unknown as {
      username: string;
    };
    expect(row.username).toBe("gitlab-ci");
  });
});

describe("DELETE /projects/:id/forge-credential", () => {
  it("removes the row outright — a removed secret is not tombstoned", async () => {
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    await plantProject(s.store);
    await setCred(s, s.putra);
    const res = await s.app.request("/projects/acme/forge-credential", {
      method: "DELETE",
      headers: hdrs(s.putra),
    });
    expect(res.status).toBe(200);
    const k = forgeCredentialKey("acme");
    expect(await s.store.get(k.PK, k.SK)).toBeNull();
  });

  it("404s when there is none, and needs lead + admin", async () => {
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    await plantProject(s.store);
    async function del(cookie: string): Promise<Response> {
      return s.app.request("/projects/acme/forge-credential", {
        method: "DELETE",
        headers: hdrs(cookie),
      });
    }
    expect((await del(s.putra)).status).toBe(404);
    expect((await del(s.lina)).status).toBe(403);
  });
});

describe("the claim hands the worker exactly the access it needs", () => {
  it("a PUBLIC repo gets no credential at all", async () => {
    armScanner();
    const s = await setup();
    await plantProject(s.store);
    await queueJob(s);
    const body = (await (await claim(s)).json()) as Record<string, unknown>;
    expect(body.cloneUrl).toBeTruthy();
    // Absent, not empty — a public clone must be byte-identical to before.
    expect(body).not.toHaveProperty("cloneAuthHeader");
  });

  it("a stored token becomes the ready-to-use Basic header", async () => {
    armScanner();
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    const s = await setup();
    await plantProject(s.store);
    await setCred(s, s.putra);
    await queueJob(s);

    const body = (await (await claim(s)).json()) as { cloneAuthHeader: string };
    expect(body.cloneAuthHeader).toBe(
      `Basic ${Buffer.from(`oauth2:${TOKEN}`).toString("base64")}`,
    );
  });

  it("the GitHub App mints a per-job token when there is no stored one", async () => {
    armScanner();
    process.env.CCP_GITHUB_APP_ID = "123456";
    process.env.CCP_GITHUB_APP_KEY = privateKey;
    let mintBody = "";
    const fake: FetchLike = async (url, init) => {
      if (url.endsWith("/installation"))
        return { status: 200, json: async () => ({ id: 42 }) };
      mintBody = init.body ?? "";
      return { status: 201, json: async () => ({ token: "ghs_perjob" }) };
    };
    __setGithubAppFetchForTests(fake);

    const s = await setup();
    await plantProject(s.store);
    await queueJob(s);
    const body = (await (await claim(s)).json()) as { cloneAuthHeader: string };
    expect(body.cloneAuthHeader).toBe(
      `Basic ${Buffer.from("x-access-token:ghs_perjob").toString("base64")}`,
    );
    // Narrowed to the one repository — the whole point of a per-job token.
    expect(JSON.parse(mintBody).repositories).toEqual(["terraform-example"]);
  });

  it("an EXPLICIT stored token wins over the App — the operator meant it", async () => {
    armScanner();
    process.env.CCP_FORGE_SEAL_KEY = SEAL;
    process.env.CCP_GITHUB_APP_ID = "123456";
    process.env.CCP_GITHUB_APP_KEY = privateKey;
    let appCalled = false;
    __setGithubAppFetchForTests(async () => {
      appCalled = true;
      return { status: 200, json: async () => ({ id: 42 }) };
    });

    const s = await setup();
    await plantProject(s.store);
    await setCred(s, s.putra);
    await queueJob(s);
    const body = (await (await claim(s)).json()) as { cloneAuthHeader: string };
    expect(body.cloneAuthHeader).toContain("Basic ");
    expect(appCalled).toBe(false);
  });

  it("an App that cannot see the repo FAILS the job with the operator's fix", async () => {
    armScanner();
    process.env.CCP_GITHUB_APP_ID = "123456";
    process.env.CCP_GITHUB_APP_KEY = privateKey;
    __setGithubAppFetchForTests(async () => ({
      status: 404,
      json: async () => ({}),
    }));

    const s = await setup();
    await plantProject(s.store);
    const jobId = await queueJob(s);
    // Nothing handed out, and the job is terminal with a reason rather than
    // spinning in `claimed` while the operator wonders.
    expect((await claim(s)).status).toBe(204);
    const k = scanJobKey("acme", jobId);
    const job = (await s.store.get(k.PK, k.SK)) as ProjectScanJobItem;
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/not installed/i);
  });

  it("no onboarding token is minted for a job whose credential failed", async () => {
    armScanner();
    process.env.CCP_GITHUB_APP_ID = "123456";
    process.env.CCP_GITHUB_APP_KEY = privateKey;
    __setGithubAppFetchForTests(async () => ({
      status: 404,
      json: async () => ({}),
    }));
    const s = await setup();
    await plantProject(s.store);
    await queueJob(s);
    await claim(s);
    expect(
      await s.store.query(projectKey("acme").PK, "ONBOARDTOKEN#"),
    ).toHaveLength(0);
  });

  describe("ERR-9: a GitHub blip is not the same as a broken App install", () => {
    it("retries once on a transient (5xx) failure and succeeds on the second try", async () => {
      armScanner();
      process.env.CCP_GITHUB_APP_ID = "123456";
      process.env.CCP_GITHUB_APP_KEY = privateKey;
      let calls = 0;
      __setGithubAppFetchForTests(async (url) => {
        calls++;
        if (calls === 1) return { status: 503, json: async () => ({}) }; // GitHub blip
        if (url.endsWith("/installation"))
          return { status: 200, json: async () => ({ id: 42 }) };
        return { status: 201, json: async () => ({ token: "ghs_retried" }) };
      });

      const s = await setup();
      await plantProject(s.store);
      await queueJob(s);
      const body = (await (await claim(s)).json()) as { cloneAuthHeader: string };
      expect(body.cloneAuthHeader).toBe(
        `Basic ${Buffer.from("x-access-token:ghs_retried").toString("base64")}`,
      );
      expect(calls).toBeGreaterThan(1); // the first, failed attempt really happened
    });

    it("retries once on a raw network throw and succeeds on the second try", async () => {
      armScanner();
      process.env.CCP_GITHUB_APP_ID = "123456";
      process.env.CCP_GITHUB_APP_KEY = privateKey;
      let calls = 0;
      __setGithubAppFetchForTests(async (url) => {
        calls++;
        if (calls === 1) throw new Error("fetch failed: ECONNRESET");
        if (url.endsWith("/installation"))
          return { status: 200, json: async () => ({ id: 42 }) };
        return { status: 201, json: async () => ({ token: "ghs_retried2" }) };
      });

      const s = await setup();
      await plantProject(s.store);
      await queueJob(s);
      const body = (await (await claim(s)).json()) as { cloneAuthHeader: string };
      expect(body.cloneAuthHeader).toBe(
        `Basic ${Buffer.from("x-access-token:ghs_retried2").toString("base64")}`,
      );
    });

    it("releases the claim back to the queue — never terminally fails the job — when a transient failure survives the retry", async () => {
      armScanner();
      process.env.CCP_GITHUB_APP_ID = "123456";
      process.env.CCP_GITHUB_APP_KEY = privateKey;
      __setGithubAppFetchForTests(async () => ({
        status: 503,
        json: async () => ({}),
      }));

      const s = await setup();
      await plantProject(s.store);
      const jobId = await queueJob(s);
      expect((await claim(s)).status).toBe(204); // nothing handed out this poll

      const k = scanJobKey("acme", jobId);
      const row = (await s.store.get(k.PK, k.SK)) as ProjectScanJobItem;
      // Back to exactly the state a freshly queued job is in — not "failed".
      expect(row.status).toBe("queued");
      expect(row.finishedAt).toBeUndefined();
      expect(row.error).toBeUndefined();
      expect(await s.store.queryGSI1("SCANJOB#QUEUED")).toHaveLength(1);

      // And it really is claimable again once the outage clears.
      __setGithubAppFetchForTests(async (url) => {
        if (url.endsWith("/installation"))
          return { status: 200, json: async () => ({ id: 42 }) };
        return { status: 201, json: async () => ({ token: "ghs_recovered" }) };
      });
      const recovered = (await (await claim(s)).json()) as {
        cloneAuthHeader: string;
      };
      expect(recovered.cloneAuthHeader).toBe(
        `Basic ${Buffer.from("x-access-token:ghs_recovered").toString("base64")}`,
      );
    });

    it("a permanent failure (404 not installed) is never retried and still fails the job", async () => {
      armScanner();
      process.env.CCP_GITHUB_APP_ID = "123456";
      process.env.CCP_GITHUB_APP_KEY = privateKey;
      let calls = 0;
      __setGithubAppFetchForTests(async () => {
        calls++;
        return { status: 404, json: async () => ({}) };
      });

      const s = await setup();
      await plantProject(s.store);
      const jobId = await queueJob(s);
      expect((await claim(s)).status).toBe(204);
      expect(calls).toBe(1); // no retry wasted on a refusal a second try can't fix

      const k = scanJobKey("acme", jobId);
      const row = (await s.store.get(k.PK, k.SK)) as ProjectScanJobItem;
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/not installed/i);
    });
  });
});
