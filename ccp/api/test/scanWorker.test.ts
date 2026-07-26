import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryStore } from "../src/store/memoryStore";
import type { ConfigStore } from "../src/store/configStore";
import type {
  ProjectItem,
  ProjectOnboardTokenItem,
  ProjectScanJobItem,
} from "../src/store/schema";
import {
  ONBOARD_TOKEN_SK_PREFIX,
  projectCollectionGsi,
  projectKey,
  scanJobKey,
} from "../src/store/schema";
import { __resetKnownProjectsForTests } from "../src/projects";
import { __resetUploadRateLimitForTests } from "../src/middleware/rateLimit";
import { isScanWorkerLane } from "../src/middleware/session";
import { seed, sessionCookieFor } from "./helpers/seed";

/**
 * ADR-0033: the WORKER half of the server-side scan lane — the machine surface
 * the isolated scanner container talks to. Adversarial throughout, because this
 * is the one lane with no human on it:
 *
 *  - it must be completely inert on a deployment that did not arm the scanner,
 *    answering identically whether or not the caller holds the key;
 *  - the key check must come BEFORE any store access, so an unauthenticated
 *    caller cannot use the lane to probe what exists;
 *  - a claim must be exactly-once under concurrency;
 *  - the worker must never be able to name its own target, and must never be
 *    handed a target the deployment is not allowed to clone;
 *  - the lifecycle window must be re-checked at claim time, not just at queue
 *    time;
 *  - and nothing the worker reports may be believed: illegal transitions are
 *    refused and error text is scrubbed before it is stored or shown.
 */

const KEY = "w".repeat(48);
const WRONG = "x".repeat(48);

const bearer = (key: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
});

type Setup = {
  store: ConfigStore;
  app: ReturnType<typeof createApp>;
  putra: string;
};

async function setup(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store);
  return {
    store,
    app: createApp(store),
    putra: await sessionCookieFor(store, "putra"), // lead + isAdmin
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

/** Queue a job through the real operator route, so the row is exactly what
 * production writes (queue-index membership included) — never hand-built. */
async function queueJob(s: Setup, id = "acme"): Promise<string> {
  const res = await s.app.request(`/projects/${id}/scan-jobs`, {
    method: "POST",
    headers: {
      cookie: s.putra,
      "x-ccp-client": "ccp-spa",
      "x-ccp-project": "sample",
      "content-type": "application/json",
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { jobId: string }).jobId;
}

async function claim(s: Setup, key = KEY): Promise<Response> {
  return s.app.request("/scan-jobs/claim", {
    method: "POST",
    headers: bearer(key),
  });
}

async function report(
  s: Setup,
  jobId: string,
  body: unknown,
  key = KEY,
): Promise<Response> {
  return s.app.request(`/scan-jobs/${jobId}/status`, {
    method: "POST",
    headers: bearer(key),
    body: JSON.stringify(body),
  });
}

const jobRow = async (
  store: ConfigStore,
  jobId: string,
  id = "acme",
): Promise<ProjectScanJobItem> => {
  const k = scanJobKey(id, jobId);
  return (await store.get(k.PK, k.SK)) as ProjectScanJobItem;
};

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

describe("the worker lane is INERT unless the deployment armed the scanner", () => {
  it("refuses SCANNER_DISABLED on the default deployment — with or without a key", async () => {
    const s = await setup();
    for (const key of [KEY, WRONG]) {
      const res = await claim(s, key);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(
        "SCANNER_DISABLED",
      );
    }
  });

  it("status reports are equally refused while disabled", async () => {
    const s = await setup();
    const res = await report(s, "01ARZ3NDEKTSV4RRFFQ69G5FAV", {
      projectId: "acme",
      status: "cloning",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "SCANNER_DISABLED",
    );
  });

  it("armed but with an unusable key stays closed — a misconfig is not an open door", async () => {
    const s = await setup();
    process.env.CCP_SCANNER = "1";
    for (const key of [undefined, "", "tooshort"]) {
      if (key === undefined) delete process.env.CCP_SCANNER_KEY;
      else process.env.CCP_SCANNER_KEY = key;
      const res = await claim(s, "whatever-the-worker-presents");
      expect(res.status).toBe(409);
    }
  });
});

describe("the worker key gate", () => {
  it("refuses a WRONG Bearer key with ONE generic code — no enumeration", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await queueJob(s);

    // Every one of these is Bearer-shaped, so it reaches the lane's own gate.
    // Near-misses included: a longer key, a truncated key, a different key.
    for (const presented of [WRONG, `${KEY}extra`, KEY.slice(0, -1), "x"]) {
      const res = await claim(s, presented);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe(
        "SCANNER_KEY_INVALID",
      );
    }
    // …and the queued job is untouched: a denied caller claimed nothing.
    const rows = (await s.store.queryGSI1(
      "SCANJOB#QUEUED",
    )) as ProjectScanJobItem[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
  });

  it("a call carrying NO Bearer credential never even reaches the lane", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await queueJob(s);

    // The CSRF exemption is Bearer-shaped-only (isScanWorkerLane), exactly like
    // the CI upload lane: without one, the request stays under the normal
    // browser rules and `withClientHeader` refuses it first. A closed door
    // either way — this pins WHICH door, so a later change that widens the
    // exemption to non-Bearer calls fails here instead of passing silently.
    const noBearer: Array<Record<string, string>> = [
      { "content-type": "application/json" }, // no Authorization at all
      { authorization: `Basic ${KEY}`, "content-type": "application/json" },
      { authorization: "Bearer", "content-type": "application/json" }, // no value
    ];
    for (const headers of noBearer) {
      const res = await s.app.request("/scan-jobs/claim", {
        method: "POST",
        headers,
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(
        "MISSING_CLIENT_HEADER",
      );
    }
    const rows = (await s.store.queryGSI1(
      "SCANJOB#QUEUED",
    )) as ProjectScanJobItem[];
    expect(rows[0]!.status).toBe("queued");
  });

  it("mints NO token for a denied caller", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await queueJob(s);
    await claim(s, WRONG);
    const tokens = await s.store.query(
      projectKey("acme").PK,
      ONBOARD_TOKEN_SK_PREFIX,
    );
    expect(tokens).toHaveLength(0);
  });
});

describe("POST /scan-jobs/claim", () => {
  it("204s when there is no work", async () => {
    const s = await setup();
    arm();
    const res = await claim(s);
    expect(res.status).toBe(204);
  });

  it("hands back the job with a SERVER-BUILT clone URL and a short-lived token", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const jobId = await queueJob(s);

    const res = await claim(s);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobId: string;
      projectId: string;
      cloneUrl: string;
      onboardToken: string;
      tokenExpiresAt: string;
    };
    expect(body.jobId).toBe(jobId);
    expect(body.projectId).toBe("acme");
    // Built from the STORED RepoRef through the allowlist — never from input.
    expect(body.cloneUrl).toBe(
      "https://github.com/example-org/terraform-example.git",
    );
    expect(body.onboardToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.[\w-]{20,}$/);
    // Short TTL: an hour, not the mint route's day.
    const ttlMs = Date.parse(body.tokenExpiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(50 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60_000 + 5_000);

    const row = await jobRow(s.store, jobId);
    expect(row.status).toBe("claimed");
    expect(row.startedAt).toBeTruthy();
    // It LEFT the queue partition — that is what makes a double-claim impossible.
    expect(row.GSI1PK).toBe("SCANJOB#TAKEN");
    expect(await s.store.queryGSI1("SCANJOB#QUEUED")).toHaveLength(0);
  });

  it("the minted token is a real, storable onboard token on the TARGET project", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await queueJob(s);
    const body = (await (await claim(s)).json()) as { onboardToken: string };

    const rows = (await s.store.query(
      projectKey("acme").PK,
      ONBOARD_TOKEN_SK_PREFIX,
    )) as ProjectOnboardTokenItem[];
    expect(rows).toHaveLength(1);
    // The tokenId half of the clear value addresses the stored row…
    expect(body.onboardToken.split(".")[0]).toBe(rows[0]!.tokenId);
    // …and only the hash was stored — the secret half appears nowhere.
    expect(rows[0]!.secretHash).not.toContain(body.onboardToken.split(".")[1]);
    expect(rows[0]!.secretHash.startsWith("$argon2")).toBe(true);
    expect(rows[0]!.createdBy).toBe("scanner-worker");
  });

  it("a second claim gets nothing — one job is handed out exactly once", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await queueJob(s);
    expect((await claim(s)).status).toBe(200);
    expect((await claim(s)).status).toBe(204);
  });

  it("CONCURRENT claims never hand the same job to two workers", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await queueJob(s);

    const results = await Promise.all([claim(s), claim(s), claim(s), claim(s)]);
    const won = results.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 200))
      expect(r.status).toBe(204);
  });

  it("is FIFO across projects — the oldest queued job goes first", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store, {}, "acme");
    await plantProject(s.store, { id: "beta", name: "Beta" }, "beta");
    const first = await queueJob(s, "acme");
    const second = await queueJob(s, "beta");
    expect(second > first).toBe(true); // ULIDs sort chronologically

    const a = (await (await claim(s)).json()) as { jobId: string };
    const b = (await (await claim(s)).json()) as { jobId: string };
    expect(a.jobId).toBe(first);
    expect(b.jobId).toBe(second);
  });
});

describe("the lifecycle window is re-checked AT CLAIM TIME", () => {
  it("fails a job whose project left the pre-trust window after it was queued", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const jobId = await queueJob(s);
    // The two admins finished the trust ceremony while the job sat in the queue.
    await plantProject(s.store, { status: "trusted" });

    expect((await claim(s)).status).toBe(204); // nothing handed out
    const row = await jobRow(s.store, jobId);
    expect(row.status).toBe("failed");
    expect(row.finishedAt).toBeTruthy();
    expect(row.error).toBe("The project is no longer awaiting its first scan.");
    // No credential was minted for a job that was never going to run.
    expect(
      await s.store.query(projectKey("acme").PK, ONBOARD_TOKEN_SK_PREFIX),
    ).toHaveLength(0);
  });

  it("fails a job whose project was archived after it was queued", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const jobId = await queueJob(s);
    await plantProject(s.store, {
      archived: { archivedBy: "putra", archivedAt: "2026-07-02T00:00:00.000Z" },
    });

    expect((await claim(s)).status).toBe(204);
    expect((await jobRow(s.store, jobId)).status).toBe("failed");
  });

  it("fails a job whose repo host stopped being allowed, and never discloses the URL", async () => {
    const s = await setup();
    arm();
    process.env.CCP_FORGE_HOSTS = "git.internal.example";
    await plantProject(s.store, {
      repo: {
        host: "github",
        owner: "example-org",
        name: "terraform-example",
        baseUrl: "https://git.internal.example",
      },
    });
    const jobId = await queueJob(s);
    // The deployment's allowlist was narrowed while the job waited.
    delete process.env.CCP_FORGE_HOSTS;

    expect((await claim(s)).status).toBe(204);
    const row = await jobRow(s.store, jobId);
    expect(row.status).toBe("failed");
    expect(row.error).not.toContain("git.internal.example");
    expect(row.error).not.toContain("https://");
  });

  it("skips a dead job and hands out the NEXT healthy one in the same poll", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store, {}, "acme");
    await plantProject(s.store, { id: "beta", name: "Beta" }, "beta");
    const dead = await queueJob(s, "acme");
    const good = await queueJob(s, "beta");
    await plantProject(s.store, { status: "trusted" }, "acme");

    const res = await claim(s);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { jobId: string }).jobId).toBe(good);
    expect((await jobRow(s.store, dead, "acme")).status).toBe("failed");
  });
});

describe("POST /scan-jobs/:jobId/status — nothing the worker says is trusted", () => {
  async function claimed(): Promise<{ s: Setup; jobId: string }> {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const jobId = await queueJob(s);
    expect((await claim(s)).status).toBe(200);
    return { s, jobId };
  }

  it("walks the happy path claimed → cloning → scanning → uploaded", async () => {
    const { s, jobId } = await claimed();
    for (const status of ["cloning", "scanning", "uploaded"] as const) {
      const res = await report(s, jobId, { projectId: "acme", status });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe(status);
    }
    const row = await jobRow(s.store, jobId);
    expect(row.status).toBe("uploaded");
    expect(row.finishedAt).toBeTruthy();
    expect(row.error).toBeUndefined();
  });

  it("refuses a BACKWARD or skipping transition", async () => {
    const { s, jobId } = await claimed();
    for (const status of ["queued", "scanning", "uploaded"] as const) {
      const res = await report(s, jobId, { projectId: "acme", status });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(
        "STATE_CONFLICT",
      );
    }
    expect((await jobRow(s.store, jobId)).status).toBe("claimed");
  });

  it("cannot resurrect a TERMINAL job", async () => {
    const { s, jobId } = await claimed();
    expect(
      (await report(s, jobId, { projectId: "acme", status: "failed" })).status,
    ).toBe(200);
    for (const status of ["cloning", "scanning", "uploaded", "failed"] as const)
      expect(
        (await report(s, jobId, { projectId: "acme", status })).status,
      ).toBe(409);
  });

  it("scrubs worker error text of control characters, URLs and token-shaped strings", async () => {
    const { s, jobId } = await claimed();
    const nasty =
      "clone failed[31m for https://tok:pw@github.com/example-org/x.git" +
      " using 01ARZ3NDEKTSV4RRFFQ69G5FAV.AbCdEfGhIjKlMnOpQrStUv\nretrying";
    const res = await report(s, jobId, {
      projectId: "acme",
      status: "failed",
      error: nasty,
    });
    expect(res.status).toBe(200);
    const stored = (await jobRow(s.store, jobId)).error!;
    expect(stored).not.toContain("https://");
    expect(stored).not.toContain("github.com");
    expect(stored).not.toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(stored).not.toMatch(/[ -]/);
    expect(stored).toContain("[url]");
    expect(stored).toContain("[token]");
    expect(stored.length).toBeLessThanOrEqual(500);
  });

  it("a failure with no reason still records one, never an empty string", async () => {
    const { s, jobId } = await claimed();
    await report(s, jobId, { projectId: "acme", status: "failed" });
    expect((await jobRow(s.store, jobId)).error).toBe(
      "The scan failed without a reported reason.",
    );
  });

  it("refuses an unknown status, extra fields, a bad projectId, or non-JSON", async () => {
    const { s, jobId } = await claimed();
    const bodies: unknown[] = [
      { projectId: "acme", status: "done" },
      { projectId: "acme", status: "cloning", sneaky: true },
      { projectId: "acme", status: "cloning", startedAt: "now" },
      { projectId: "../etc", status: "cloning" },
      { status: "cloning" },
    ];
    for (const b of bodies)
      expect((await report(s, jobId, b)).status).toBe(422);

    const res = await s.app.request(`/scan-jobs/${jobId}/status`, {
      method: "POST",
      headers: bearer(KEY),
      body: "not json",
    });
    expect(res.status).toBe(422);
    expect((await jobRow(s.store, jobId)).status).toBe("claimed");
  });

  it("404s for an unknown job or a malformed jobId, without saying which", async () => {
    const { s } = await claimed();
    for (const id of ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "nope", "../../projects"]) {
      const res = await s.app.request(
        `/scan-jobs/${encodeURIComponent(id)}/status`,
        {
          method: "POST",
          headers: bearer(KEY),
          body: JSON.stringify({ projectId: "acme", status: "cloning" }),
        },
      );
      expect(res.status).toBe(404);
    }
  });

  it("cannot reach another project's job by naming the wrong projectId", async () => {
    const { s, jobId } = await claimed();
    await plantProject(s.store, { id: "beta", name: "Beta" }, "beta");
    const res = await report(s, jobId, {
      projectId: "beta",
      status: "cloning",
    });
    expect(res.status).toBe(404); // the key is (projectId, jobId) — no such row
    expect((await jobRow(s.store, jobId)).status).toBe("claimed");
  });
});

describe("the CSRF exemption is exactly these two paths", () => {
  it("covers claim and status, and nothing else under /scan-jobs", () => {
    const auth = "Bearer k";
    expect(isScanWorkerLane("POST", "/scan-jobs/claim", auth)).toBe(true);
    expect(
      isScanWorkerLane(
        "POST",
        "/scan-jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV/status",
        auth,
      ),
    ).toBe(true);
    // Not a Bearer, wrong method, or an adjacent path: NOT exempt.
    expect(isScanWorkerLane("POST", "/scan-jobs/claim", undefined)).toBe(false);
    expect(isScanWorkerLane("POST", "/scan-jobs/claim", "Basic k")).toBe(false);
    expect(isScanWorkerLane("GET", "/scan-jobs/claim", auth)).toBe(false);
    expect(isScanWorkerLane("POST", "/scan-jobs", auth)).toBe(false);
    expect(isScanWorkerLane("POST", "/scan-jobs/x/status/extra", auth)).toBe(
      false,
    );
    expect(isScanWorkerLane("POST", "/projects/acme/data", auth)).toBe(false);
  });

  it("the real app accepts the worker with NO x-ccp-client and NO session", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await queueJob(s);
    const res = await s.app.request("/scan-jobs/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` }, // no cookie, no client header
    });
    expect(res.status).toBe(200);
  });

  it("but a session-shaped call with no Bearer is still CSRF-gated", async () => {
    const s = await setup();
    arm();
    const res = await s.app.request("/scan-jobs/claim", { method: "POST" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "MISSING_CLIENT_HEADER",
    );
  });
});
