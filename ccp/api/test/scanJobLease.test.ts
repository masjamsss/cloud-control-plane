import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryStore } from "../src/store/memoryStore";
import type { ConfigStore } from "../src/store/configStore";
import type {
  AuditItem,
  ProjectItem,
  ProjectScanJobItem,
} from "../src/store/schema";
import {
  SCAN_JOB_SK_PREFIX,
  projectCollectionGsi,
  projectKey,
  scanJobDoneGsi,
  scanJobKey,
} from "../src/store/schema";
import { __resetKnownProjectsForTests } from "../src/projects";
import { __resetUploadRateLimitForTests } from "../src/middleware/rateLimit";
import { __setNow } from "../src/clock";
import { seed, seedAccount, sessionCookieFor } from "./helpers/seed";
import {
  SCAN_JOB_LEASE_MS,
  scanJobLeaseExpired,
} from "../src/domain/scanJobLease";

/**
 * OPS-4 — a scan job whose worker died stayed `claimed`/`cloning`/`scanning` FOREVER, and
 * that wedged the whole project.
 *
 * The claim CAS moves the row out of the queue partition, and from then on the only
 * writer is `/scan-jobs/:jobId/status` — the worker holding the job. There was no lease,
 * no timeout, no janitor, and no operator-facing cancel or requeue (the scan-job routes
 * are exactly: create, latest, claim, status). A restarted worker has no memory of its
 * claim and just polls for new work. Meanwhile `POST /projects/:id/scan-jobs` refuses
 * while ANY non-terminal job exists — so ONE container restart mid-scan permanently
 * blocked the paste-a-URL onboarding ADR-0033 exists for, and the wizard user saw a
 * spinner with no end. Worker death mid-job is routine: `self-update.sh` rebuilds the
 * scanner nightly, hosts reboot, containers OOM.
 *
 * The fix is a claim lease settled lazily on read — the write-on-read doctrine
 * `settleCooling`/`settleWindow` already use, chosen for the same reason: this system has
 * no background timer, and a documented manual recovery is not a recovery path. The two
 * acts the wedge blocks (create the next job, read this one's progress) are the two that
 * settle it.
 */

const KEY = "s".repeat(32);
const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const CLAIMED_AT = "2026-08-01T11:00:00.000Z"; // an hour earlier — well past the lease

function hdrs(cookie: string): Record<string, string> {
  return { cookie, "x-ccp-client": "ccp-spa", "x-ccp-project": "sample" };
}

type Setup = {
  store: ConfigStore;
  app: ReturnType<typeof createApp>;
  putra: string;
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
  };
}

async function plantProject(store: ConfigStore, id = "acme"): Promise<void> {
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
  } as ProjectItem as never);
}

/** A job a worker claimed and never reported on again. */
async function plantStuckJob(
  store: ConfigStore,
  status: ProjectScanJobItem["status"],
  startedAt: string | undefined = CLAIMED_AT,
  id = "acme",
  jobId = "01JZZZZZZZZZZZZZZZZZZZZZZ1",
): Promise<string> {
  await store.put({
    ...scanJobKey(id, jobId),
    jobId,
    projectId: id,
    status,
    createdBy: "putra",
    createdAt: "2026-08-01T10:59:00.000Z",
    ...(startedAt ? { startedAt } : {}),
    GSI1PK: scanJobDoneGsi(),
    GSI1SK: jobId,
  } as ProjectScanJobItem as never);
  return jobId;
}

async function jobsOf(
  store: ConfigStore,
  id = "acme",
): Promise<ProjectScanJobItem[]> {
  return (await store.query(
    projectKey(id).PK,
    SCAN_JOB_SK_PREFIX,
  )) as ProjectScanJobItem[];
}

async function auditActions(
  store: ConfigStore,
  id = "acme",
): Promise<string[]> {
  const entries = (await store.query(`P#${id}#AUDIT#202608`)) as AuditItem[];
  return entries.map((e) => e.action);
}

async function createJob(s: Setup, id = "acme"): Promise<Response> {
  return s.app.request(`/projects/${id}/scan-jobs`, {
    method: "POST",
    headers: { ...hdrs(s.putra), "content-type": "application/json" },
  });
}

async function latest(s: Setup, id = "acme"): Promise<Response> {
  return s.app.request(`/projects/${id}/scan-jobs/latest`, {
    headers: hdrs(s.putra),
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
  __setNow(() => NOW);
});
afterEach(() => {
  delete process.env.CCP_SCANNER;
  delete process.env.CCP_SCANNER_KEY;
  __setNow(null);
});

describe("scanJobLeaseExpired — the lease predicate", () => {
  const at = (ms: number): string => new Date(ms).toISOString();

  it("ages only the non-terminal, non-queued states", () => {
    const stale = at(NOW - SCAN_JOB_LEASE_MS - 1000);
    for (const status of ["claimed", "cloning", "scanning"] as const) {
      expect(
        scanJobLeaseExpired({ status, startedAt: stale, createdAt: stale }, NOW),
        status,
      ).toBe(true);
    }
    // A queued job is WAITING, not wedged — it stays claimable indefinitely, and an
    // unreachable worker costs nothing but a visible queue.
    expect(
      scanJobLeaseExpired(
        { status: "queued", createdAt: stale, startedAt: undefined },
        NOW,
      ),
    ).toBe(false);
    for (const status of ["uploaded", "failed"] as const) {
      expect(
        scanJobLeaseExpired({ status, startedAt: stale, createdAt: stale }, NOW),
        status,
      ).toBe(false);
    }
  });

  it("does not expire a worker that is still inside its lease", () => {
    const fresh = at(NOW - SCAN_JOB_LEASE_MS + 1000);
    expect(
      scanJobLeaseExpired(
        { status: "cloning", startedAt: fresh, createdAt: fresh },
        NOW,
      ),
    ).toBe(false);
    // The lease covers the worker's own 10-minute clone bound with wide margin.
    expect(SCAN_JOB_LEASE_MS).toBeGreaterThan(10 * 60_000);
  });

  it("falls back to createdAt, and expires a row it cannot age at all", () => {
    const stale = at(NOW - SCAN_JOB_LEASE_MS - 1000);
    expect(
      scanJobLeaseExpired(
        { status: "claimed", startedAt: undefined, createdAt: stale },
        NOW,
      ),
    ).toBe(true);
    // A non-terminal row with no usable timestamp is exactly a row nothing can ever
    // release — the wedge itself. It expires rather than being ignored forever.
    expect(
      scanJobLeaseExpired(
        { status: "scanning", startedAt: "nonsense", createdAt: "nonsense" },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("OPS-4 — a dead worker no longer wedges the project", () => {
  for (const status of ["claimed", "cloning", "scanning"] as const) {
    it(`POST /scan-jobs settles a stranded '${status}' job and queues the next one`, async () => {
      const s = await setup();
      arm();
      await plantProject(s.store);
      await plantStuckJob(s.store, status);

      const res = await createJob(s);

      // THE REGRESSION. Before the fix this was 409 STATE_CONFLICT — forever, for this
      // project, with no route able to change it. The only remedy was hand-crafting a
      // worker-keyed status POST with the deployment's shared secret.
      expect(res.status).toBe(201);
      const jobs = await jobsOf(s.store);
      expect(jobs).toHaveLength(2);
      const stranded = jobs.find((j) => j.jobId.startsWith("01JZ"))!;
      expect(stranded.status).toBe("failed");
      expect(stranded.finishedAt).toBe(new Date(NOW).toISOString());
      expect(stranded.error).toMatch(/claim expired/i);
      expect(await auditActions(s.store)).toContain("scan-job-lease-expired");
    });
  }

  it("GET /scan-jobs/latest turns the endless spinner into an honest failure", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await plantStuckJob(s.store, "scanning");

    const body = (await (await latest(s)).json()) as {
      status: string;
      error?: string;
    };

    // Before the fix the wizard read `scanning` on every poll, forever.
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/start a new scan/i);
    expect((await jobsOf(s.store))[0]!.status).toBe("failed"); // settled, not just projected
  });

  it("a job still INSIDE its lease is untouched, and still blocks a second scan", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await plantStuckJob(
      s.store,
      "cloning",
      new Date(NOW - 60_000).toISOString(),
    );

    // One at a time is a real invariant (a repeated click must not fan out clones); the
    // lease must not become a way around it.
    const res = await createJob(s);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("STATE_CONFLICT");
    expect((await jobsOf(s.store))[0]!.status).toBe("cloning");
    expect(await auditActions(s.store)).not.toContain("scan-job-lease-expired");
  });

  it("a queued job is never lease-expired — the worker may be minutes away", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await plantStuckJob(s.store, "queued", undefined);

    expect((await createJob(s)).status).toBe(409); // still in flight, correctly
    expect((await jobsOf(s.store))[0]!.status).toBe("queued");
  });

  it("settling is idempotent: a second read neither rewrites the row nor re-audits", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    await plantStuckJob(s.store, "claimed");

    await latest(s);
    const first = (await jobsOf(s.store))[0]!;
    __setNow(() => NOW + 3600_000);
    await latest(s);
    const second = (await jobsOf(s.store))[0]!;

    expect(second.finishedAt).toBe(first.finishedAt); // not re-stamped
    expect(
      (await auditActions(s.store)).filter(
        (a) => a === "scan-job-lease-expired",
      ),
    ).toHaveLength(1);
  });

  it("the worker's own late report still wins if it beats the lease", async () => {
    const s = await setup();
    arm();
    await plantProject(s.store);
    const jobId = await plantStuckJob(
      s.store,
      "scanning",
      new Date(NOW - 60_000).toISOString(),
    );

    const res = await s.app.request(`/scan-jobs/${jobId}/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: "acme", status: "uploaded" }),
    });

    expect(res.status).toBe(200);
    expect((await jobsOf(s.store))[0]!.status).toBe("uploaded");
    // And a terminal job is never re-opened by the lease afterwards.
    __setNow(() => NOW + 10 * SCAN_JOB_LEASE_MS);
    await latest(s);
    expect((await jobsOf(s.store))[0]!.status).toBe("uploaded");
  });
});
