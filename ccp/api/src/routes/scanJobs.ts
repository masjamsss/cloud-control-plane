import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../appEnv";
import type { ConfigStore } from "../store/configStore";
import { ConditionError } from "../store/configStore";
import type {
  ProjectForgeCredentialItem,
  ProjectItem,
  ProjectScanJobItem,
  RepoRef,
} from "../store/schema";
import {
  forgeCredentialKey,
  projectKey,
  repoRefOf,
  scanJobDoneGsi,
  scanJobKey,
  scanJobQueueGsi,
} from "../store/schema";
import { knobEnabled, resolveKnob } from "../domain/deploymentSettings";
import {
  buildCloneUrl,
  canTransitionScanStatus,
  isTerminalScanStatus,
  SCAN_ERROR_MAX,
  SCAN_JOB_STATUSES,
  sanitizeScanError,
  scannerWorkerKey,
  type ScanJobStatus,
} from "../domain/scanner";
import { isOnboardable, mintOnboardToken } from "../domain/onboardToken";
import {
  ForgeCredentialError,
  githubAppAuthHeader,
  githubAppCanServe,
  githubAppConfig,
  mintInstallationToken,
  openForgeTokenHeader,
  type FetchLike,
  type GithubAppConfig,
} from "../domain/forgeCredentials";
import { DomainConditionError, transactWithAudit } from "../domain/audit";
import { ApiError, apiError } from "../errors";
import { nowIso } from "../clock";
import { PROJECT_ID_RE } from "../projects";

/**
 * THE SCANNER WORKER LANE (ADR-0033) — the only surface the isolated scanner
 * container talks to. It is a MACHINE lane: no cookie, no session, no user; the
 * worker presents the deployment's shared `CCP_SCANNER_KEY` as a Bearer token.
 * Mounted at `/scan-jobs`, deliberately OUTSIDE `/projects`, so it inherits
 * none of that group's session + membership middleware and its own gate is the
 * only thing standing in front of it.
 *
 * WHY THIS SHAPE, AND WHAT IT REFUSES:
 *
 *  - OFF BY DEFAULT. Every route here returns SCANNER_DISABLED unless the
 *    deployment set `CCP_SCANNER=1` AND a >=32-char `CCP_SCANNER_KEY`
 *    (domain/scanner.ts). An armed scanner with no key is a misconfiguration
 *    and stays closed rather than open. Merging this file changes nothing on a
 *    deployment that did not opt in.
 *  - THE KEY CHECK IS TIMING-SAFE and runs before ANY store read, so an
 *    unauthenticated caller cannot use this lane to probe which projects exist
 *    or whether work is queued.
 *  - THE WORKER NEVER CHOOSES ITS TARGET. It cannot name a project, a job, or a
 *    URL to clone: it asks for "whatever is next" and the server picks, then
 *    rebuilds the clone URL server-side from the stored {@link repoRefOf}
 *    through `buildCloneUrl`'s allowlist. That is the SSRF answer — a
 *    compromised worker gains no ability to aim the control plane at an
 *    internal host, because the control plane does the aiming.
 *  - CLAIMING IS EXACTLY-ONCE. The claim is a compare-and-swap on
 *    `status === 'queued'` that simultaneously moves the row OUT of the queue
 *    index partition. Two workers polling at the same instant cannot both win;
 *    the loser moves on to the next row rather than duplicating a clone.
 *  - THE CREDENTIAL IS SHORT-LIVED AND NARROW. The claim response carries a
 *    freshly minted PRE-TRUST onboarding token (domain/onboardToken.ts) good
 *    for {@link CLAIM_TOKEN_TTL_MINUTES}, which authorizes exactly one verb:
 *    `PUT /projects/:id/trust-request`. It cannot upload project data, cannot
 *    read anything, and expires shortly after the scan should have finished.
 *  - THE LIFECYCLE GATE IS RE-CHECKED AT CLAIM TIME. A project that left the
 *    pre-trust window (or was archived) between queueing and claiming has its
 *    job failed here rather than scanned — the state at the moment of the act
 *    is what governs, never the state when the button was pressed.
 *  - NOTHING THE WORKER SAYS IS TRUSTED. Status reports must be legal forward
 *    transitions (`canTransitionScanStatus`), a terminal job can never be
 *    reopened, and error text is `sanitizeScanError`-scrubbed of control
 *    characters, URLs, and token-shaped strings before it is stored.
 *
 * The worker still never runs terraform — it produces the SAME prescan artifact
 * pair a local `catalogctl onboard` produces and uploads it over the SAME
 * pre-trust lane, so the two-admin trust ceremony downstream is untouched. This
 * removes the typing, not the human judgment.
 */

/** How long the claim's onboarding token stays valid. Deliberately short: it
 * only has to outlive one clone + prescan + upload, and a worker that dies
 * mid-scan should not leave a usable credential lying around for a day. */
const CLAIM_TOKEN_TTL_MINUTES = 60;

/** How many queued rows one claim attempt will walk past before giving up.
 * Bounds the work a single poll can do when many jobs are contended or stale. */
const CLAIM_SCAN_LIMIT = 25;

/** The worker's own actor string in the audit chain — it is not a person, and
 * must never be attributable to the admin who queued the job. */
const WORKER_ACTOR = "scanner-worker";

/** Bounds a single GitHub App API call (ERR-9). Comfortably inside GitHub's
 * own usual response time, and short enough that the one retry below still
 * finishes well within a worker's poll interval. */
const GITHUB_APP_FETCH_TIMEOUT_MS = 20_000;

/** Fixed backoff before the one retry on a transient credential failure —
 * long enough to clear a passing blip, short enough not to make the worker
 * (and the operator watching the claim) wait noticeably longer. */
const CREDENTIAL_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const StatusBody = z
  .object({
    projectId: z.string().regex(PROJECT_ID_RE),
    status: z.enum(SCAN_JOB_STATUSES),
    /** Only meaningful with `status: 'failed'`; sanitized before storage. */
    error: z.string().max(4000).optional(),
  })
  .strict();

/** ULID — the shape every jobId has. */
const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The store's key type uses `PK`/`SK`; a conditional UPDATE write names them
 * `pk`/`sk`. One adapter so every call site spells the same key the same way. */
function toPkSk(k: { PK: string; SK: string }): { pk: string; sk: string } {
  return { pk: k.PK, sk: k.SK };
}

/**
 * Constant-time equality for the shared worker key. Length is compared first
 * (and `timingSafeEqual` requires equal lengths anyway); the early return on a
 * length mismatch leaks only the length, which the caller supplied.
 */
function keyMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Bearer value, or null when the header is absent/not a Bearer. */
function bearerOf(authorization: string | undefined): string | null {
  if (typeof authorization !== "string") return null;
  const m = /^Bearer\s+(\S+)$/.exec(authorization.trim());
  return m ? m[1]! : null;
}

/**
 * Mark a claimed job terminal because the SERVER refused to proceed (the
 * project left the pre-trust window, or its repo no longer resolves to an
 * allowed clone target). Recorded as a failure with a server-authored reason so
 * the operator sees why, rather than the job hanging in `claimed` forever.
 */
async function failClaimed(
  store: ConfigStore,
  job: ProjectScanJobItem,
  reason: string,
): Promise<void> {
  const jobKey = scanJobKey(job.projectId, job.jobId);
  await transactWithAudit(
    store,
    job.projectId,
    [
      {
        kind: "update",
        ...toPkSk(jobKey),
        set: {
          status: "failed",
          finishedAt: nowIso(),
          error: sanitizeScanError(reason),
        },
        ifEquals: { attr: "status", value: "claimed" },
      },
    ],
    {
      action: "scan-job-status",
      actor: WORKER_ACTOR,
      targetType: "project",
      targetId: job.projectId,
      after: { jobId: job.jobId, status: "failed" },
    },
  );
}

/**
 * Undo a claim after a TRANSIENT failure — a GitHub blip that survived the
 * one retry `resolveCloneAuth` already gave it — instead of terminally
 * failing the job over an outage that may already be over. Mirrors
 * `failClaimed`'s CAS shape exactly but reverses it: `claimed` back to
 * `queued`, restoring the queue GSI and dropping `startedAt`, so the row
 * looks exactly like one that was never claimed and the next poll (this
 * worker's next pass, or another worker's) gets a fresh attempt.
 */
async function releaseClaimed(
  store: ConfigStore,
  job: ProjectScanJobItem,
): Promise<void> {
  const jobKey = scanJobKey(job.projectId, job.jobId);
  await transactWithAudit(
    store,
    job.projectId,
    [
      {
        kind: "update",
        ...toPkSk(jobKey),
        set: {
          status: "queued",
          GSI1PK: scanJobQueueGsi(),
          startedAt: undefined,
        },
        ifEquals: { attr: "status", value: "claimed" },
      },
    ],
    {
      action: "scan-job-status",
      actor: WORKER_ACTOR,
      targetType: "project",
      targetId: job.projectId,
      after: { jobId: job.jobId, status: "queued" },
    },
  );
}

/**
 * `failClaimed` and `releaseClaimed` are themselves CAS-guarded audited
 * writes and can throw exactly like the claim step they undo does —
 * `ConditionError` on a lost race, `ApiError` on a chain-head conflict (see
 * the identical race-handling comment on the claim's own try/catch above).
 * Unwrapped, that throw would escape this route as a bare 500 while the job
 * stays stuck in `claimed` forever, which is the one thing this whole
 * handler exists to avoid. Every call site below goes through one of these
 * two wrappers instead of calling `failClaimed`/`releaseClaimed` directly.
 */
async function safeFailClaimed(
  store: ConfigStore,
  job: ProjectScanJobItem,
  reason: string,
): Promise<void> {
  try {
    await failClaimed(store, job, reason);
  } catch (e) {
    console.error(
      `scan-jobs: failClaimed failed for ${job.projectId}/${job.jobId}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

/** See {@link safeFailClaimed} — same wrapping, for `releaseClaimed`. */
async function safeReleaseClaimed(
  store: ConfigStore,
  job: ProjectScanJobItem,
): Promise<void> {
  try {
    await releaseClaimed(store, job);
  } catch (e) {
    console.error(
      `scan-jobs: releaseClaimed failed for ${job.projectId}/${job.jobId}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * The network seam for the GitHub App broker, overridable in tests so the whole
 * credential path is exercised without reaching github.com.
 */
const realAppFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    ...(init as RequestInit),
    // Bounded so a hung GitHub API call fails the credential fetch (and, via
    // the retry-once wrapper below, gets one more try) instead of leaving the
    // claim handler — and the worker polling it — hanging indefinitely.
    signal: AbortSignal.timeout(GITHUB_APP_FETCH_TIMEOUT_MS),
  });
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};
let appFetch: FetchLike = realAppFetch;
/** Inject a fake, or pass null to restore the REAL one. Restoring matters:
 * a fake left installed would silently follow the test file that set it into
 * every other file sharing the worker process. */
export function __setGithubAppFetchForTests(f: FetchLike | null): void {
  appFetch = f ?? realAppFetch;
}

/**
 * Resolve the credential the worker needs to clone THIS repository, or null for
 * a public one. Order matters and is the operator's own precedence:
 *
 *  1. A per-project sealed token, if the operator stored one. Explicit beats
 *     ambient — an operator who went to the trouble of supplying a token for
 *     this project meant it to be used, even on github.com where an App exists.
 *  2. Otherwise the GitHub App, if this deployment installed one and the repo is
 *     on github.com. A per-job installation token: one repository, one hour,
 *     `contents:read` only.
 *  3. Otherwise nothing — a public repository, which is how the scanner worked
 *     before any of this existed.
 *
 * Returns the ready-to-use `Authorization` header VALUE rather than the raw
 * secret, so the worker never has to know which scheme it got and no call site
 * can assemble the encoding wrongly.
 */
async function resolveCloneAuth(
  store: ConfigStore,
  projectId: string,
  repo: RepoRef,
): Promise<string | null> {
  const k = forgeCredentialKey(projectId);
  const stored = (await store.get(
    k.PK,
    k.SK,
  )) as ProjectForgeCredentialItem | null;
  if (stored) return openForgeTokenHeader(stored.sealed);

  if (!githubAppCanServe(repo)) return null;
  const cfg = githubAppConfig();
  if (cfg === null) return null;
  const minted = await mintInstallationTokenWithRetry(repo, cfg, appFetch);
  return githubAppAuthHeader(minted.token);
}

/**
 * `mintInstallationToken`, retried exactly ONCE, and only on a `transient`
 * {@link ForgeCredentialError} — a GitHub blip or network hiccup, per its own
 * classification (domain/forgeCredentials.ts). A permanent failure (404 not
 * installed, any other 4xx, a malformed response) is never retried: it will
 * fail exactly the same way a second time, and retrying it would just make
 * the operator wait longer to see the fix-it-yourself message. The retry
 * redoes the WHOLE two-call sequence rather than just the call that failed,
 * since a fresh JWT/lookup pair is cheap and simpler than threading partial
 * state back in.
 */
async function mintInstallationTokenWithRetry(
  repo: RepoRef,
  cfg: GithubAppConfig,
  fetchLike: FetchLike,
): Promise<{ token: string; expiresAt: string }> {
  try {
    return await mintInstallationToken(repo, cfg, fetchLike);
  } catch (e) {
    if (!(e instanceof ForgeCredentialError) || !e.transient) throw e;
    await sleep(CREDENTIAL_RETRY_DELAY_MS);
    return await mintInstallationToken(repo, cfg, fetchLike);
  }
}

export function scanJobRoutes(): Hono<AppEnv> {
  const s = new Hono<AppEnv>();

  /**
   * Both routes share this gate. Order matters and is fail-closed:
   * armed-check FIRST (a disabled deployment answers identically to every
   * caller, authorized or not), then the timing-safe key compare, then — and
   * only then — any store access.
   */
  async function authorize(
    store: ConfigStore,
    auth: string | undefined,
  ): Promise<"disabled" | "denied" | "ok"> {
    const expected = scannerWorkerKey();
    // Armed by the PORTAL toggle or the deployment's environment — the same
    // single precedence every other reader uses. The store read here is the
    // settings row, not anything about a project, so a disabled deployment
    // still discloses nothing about what exists.
    if (!(await knobEnabled(store, "scanner.enabled")) || expected === null)
      return "disabled";
    const presented = bearerOf(auth);
    if (presented === null || !keyMatches(presented, expected)) return "denied";
    return "ok";
  }

  /* ── POST /scan-jobs/claim — "give me the next repository to scan" ──────────
   * 200 with the work packet, or 204 when the queue is empty. The worker polls;
   * it never receives a push, so an unreachable worker costs nothing but a
   * queued job that stays queued and visible to the operator. */
  s.post("/claim", async (c) => {
    const gate = await authorize(c.get("store"), c.req.header("authorization"));
    if (gate === "disabled") return apiError(c, "SCANNER_DISABLED");
    if (gate === "denied") return apiError(c, "SCANNER_KEY_INVALID");

    const store = c.get("store");
    // Oldest first: GSI1SK is the ULID jobId, and queryGSI1 returns ascending,
    // so the queue is FIFO without storing a separate ordering field.
    const queued = (await store.queryGSI1(
      scanJobQueueGsi(),
    )) as ProjectScanJobItem[];

    for (const row of queued.slice(0, CLAIM_SCAN_LIMIT)) {
      if (row.status !== "queued") continue; // stale index entry; the CAS below would refuse it anyway

      // THE CLAIM. One conditional write does both halves atomically: flip
      // 'queued' → 'claimed' and move the row out of the queue partition. The
      // condition is what makes a double-claim unrepresentable rather than
      // merely unlikely.
      try {
        await transactWithAudit(
          store,
          row.projectId,
          [
            {
              kind: "update",
              ...toPkSk(scanJobKey(row.projectId, row.jobId)),
              set: {
                status: "claimed",
                startedAt: nowIso(),
                GSI1PK: scanJobDoneGsi(),
              },
              ifEquals: { attr: "status", value: "queued" },
            },
          ],
          {
            action: "scan-job-claim",
            actor: WORKER_ACTOR,
            targetType: "project",
            targetId: row.projectId,
            after: { jobId: row.jobId, status: "claimed" },
          },
        );
      } catch (e) {
        // Either another worker won the race (the ifEquals failed) or the
        // project's audit chain head moved under us. Since CONC-15
        // transactWithAudit CAN tell them apart (DomainConditionError vs
        // CHAIN_CONTENTION) — this site simply does not need it to: BOTH mean
        // "not this job, not right now". The row is untouched, so it stays
        // queued and the next poll (or the next row in this same pass) picks it
        // up. Nothing is lost either way, which is why treating them alike here
        // is a choice rather than a limitation. `DomainConditionError` is an
        // `ApiError`, so both arms below still cover it.
        if (e instanceof ConditionError || e instanceof ApiError) continue;
        throw e;
      }

      // ── claimed. Now re-verify the target as it stands RIGHT NOW. ──
      const claimed: ProjectScanJobItem = { ...row, status: "claimed" };
      const pk = projectKey(row.projectId);
      const project = (await store.get(pk.PK, pk.SK)) as ProjectItem | null;
      if (!project || !isOnboardable(project)) {
        // Queued while pre-trust, claimed after it moved on (or was archived):
        // scanning now would upload a first-scan artifact into a window that has
        // closed. Fail the job and look for other work.
        await safeFailClaimed(
          store,
          claimed,
          "The project is no longer awaiting its first scan.",
        );
        continue;
      }
      const repo = repoRefOf(project);
      const extraHosts = ((await resolveKnob(store, "scanner.forgeHosts"))
        .value ?? []) as string[];
      const target = repo
        ? buildCloneUrl(repo, process.env, extraHosts)
        : { ok: false as const };
      if (!repo || !target.ok) {
        await safeFailClaimed(
          store,
          claimed,
          "This project's repository host is not one this deployment is allowed to clone from.",
        );
        continue;
      }

      // The forge credential for a PRIVATE repo, resolved fresh per job — a
      // per-job GitHub App installation token (already retried once on a
      // transient blip inside resolveCloneAuth), or the operator's sealed
      // token opened in memory. Null for a public repo. A PERMANENT failure
      // here fails THIS job with the reason (a misinstalled App is the
      // operator's fix, and a job hanging in `claimed` would tell them
      // nothing); a failure still marked TRANSIENT after the retry releases
      // the claim instead, so the job gets a fresh attempt rather than being
      // terminally failed by an outage that may already be over.
      let cloneAuthHeader: string | null;
      try {
        cloneAuthHeader = await resolveCloneAuth(store, row.projectId, repo);
      } catch (e) {
        if (e instanceof ForgeCredentialError) {
          if (e.transient) {
            await safeReleaseClaimed(store, claimed);
          } else {
            await safeFailClaimed(store, claimed, e.message);
          }
          continue;
        }
        await safeFailClaimed(
          store,
          claimed,
          "Could not obtain repository access.",
        );
        continue;
      }

      // The onboarding token is minted LAST — after every refusal has had its
      // chance — so a job that was never going to run never produces one.
      const token = await mintOnboardToken(
        store,
        row.projectId,
        WORKER_ACTOR,
        CLAIM_TOKEN_TTL_MINUTES,
      );
      return c.json({
        jobId: row.jobId,
        projectId: row.projectId,
        cloneUrl: target.url,
        onboardToken: token.token,
        tokenExpiresAt: token.expiresAt,
        // Present ONLY for a private repo. The worker passes it to git through
        // the environment, never argv — see internal/scanworker/clone.go.
        ...(cloneAuthHeader ? { cloneAuthHeader } : {}),
      });
    }

    // Nothing to do. 204 rather than an empty 200 body so a polling worker can
    // branch on the status line alone.
    return c.body(null, 204);
  });

  /* ── POST /scan-jobs/:jobId/status — the worker reports progress ────────────
   * The job row is keyed by (projectId, jobId), so the body names the project
   * the claim handed back. Every transition is validated against the STORED
   * status, never the one the worker claims to be leaving. */
  s.post("/:jobId/status", async (c) => {
    const gate = await authorize(c.get("store"), c.req.header("authorization"));
    if (gate === "disabled") return apiError(c, "SCANNER_DISABLED");
    if (gate === "denied") return apiError(c, "SCANNER_KEY_INVALID");

    const jobId = c.req.param("jobId");
    if (!JOB_ID_RE.test(jobId))
      return c.json({ code: "NOT_FOUND", reason: "No such scan job." }, 404);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return apiError(c, "VALIDATION_FAILED", {
        field: "body",
        problem: "not valid JSON",
      });
    }
    const parsed = StatusBody.safeParse(raw);
    if (!parsed.success) return apiError(c, "VALIDATION_FAILED");
    const { projectId, status } = parsed.data;

    const store = c.get("store");
    const k = scanJobKey(projectId, jobId);
    const job = (await store.get(k.PK, k.SK)) as ProjectScanJobItem | null;
    if (!job)
      return c.json({ code: "NOT_FOUND", reason: "No such scan job." }, 404);

    const from = job.status as ScanJobStatus;
    if (!canTransitionScanStatus(from, status))
      return apiError(c, "STATE_CONFLICT");

    const terminal = isTerminalScanStatus(status);
    const set: Record<string, unknown> = { status };
    if (terminal) set.finishedAt = nowIso();
    if (status === "failed") {
      // Untrusted text from a process that just ran against a hostile
      // repository — scrubbed at this boundary, not at the render.
      const cleaned = sanitizeScanError(parsed.data.error);
      set.error =
        cleaned.length > 0
          ? cleaned
          : "The scan failed without a reported reason.";
    }

    try {
      await transactWithAudit(
        store,
        projectId,
        [
          {
            kind: "update",
            ...toPkSk(k),
            set,
            // Guard on the status we validated against: a concurrent report
            // cannot interleave and land an out-of-order write.
            ifEquals: { attr: "status", value: from },
          },
        ],
        {
          action: "scan-job-status",
          actor: WORKER_ACTOR,
          targetType: "project",
          targetId: projectId,
          after: { jobId, status },
        },
      );
    } catch (e) {
      // CONC-15: this arm used to test for `ConditionError`, which
      // `transactWithAudit` has never thrown — so a genuinely lost transition
      // (a concurrent report already moved the job off `from`) reached the
      // worker as CHAIN_CONTENTION, "the audit chain is busy; please retry",
      // inviting a retry of a transition that can never succeed again. The
      // status guard losing IS a state conflict, and is now reported as one.
      if (e instanceof DomainConditionError) return apiError(c, "STATE_CONFLICT");
      throw e;
    }
    return c.json({ jobId, status });
  });

  return s;
}

/** Re-exported for the OpenAPI/doc surface and tests — the cap the worker's
 * error string is held to once sanitized. */
export { SCAN_ERROR_MAX };
