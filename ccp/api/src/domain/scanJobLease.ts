import type { ConfigStore, TransactWrite } from "../store/configStore";
import { ConditionError } from "../store/configStore";
import type { ChainHeadItem, ProjectScanJobItem } from "../store/schema";
import { chainHead, scanJobKey } from "../store/schema";
import { ApiError } from "../errors";
import type { AuditEntryInput } from "./audit";
import { CHAIN_RETRY_ATTEMPTS, chainRetryBackoff, recordIn } from "./audit";
import { isTerminalScanStatus, sanitizeScanError } from "./scanner";
import { nowIso, nowMs } from "../clock";

/**
 * THE SCAN-JOB CLAIM LEASE (OPS-4).
 *
 * A scan job leaves the queue partition the moment a worker claims it, and from then on
 * ONLY that worker can advance it: the sole writer of `/scan-jobs/:jobId/status` is the
 * worker holding the job. There is no other route — no cancel, no requeue, no janitor.
 * So a worker that dies between the claim and its terminal report (a `compose up -d
 * --build` during `self-update.sh`, a host reboot, an OOM kill — all routine) leaves the
 * row in `claimed`/`cloning`/`scanning` FOREVER. A restarted worker has no memory of the
 * job and just polls for new ones.
 *
 * That wedges more than the job: `POST /projects/:id/scan-jobs` refuses while ANY
 * non-terminal job exists, so the project can never be scanned again, and the wizard the
 * whole zero-touch import journey (ADR-0033) runs on shows a spinner with no end.
 *
 * The fix is a LEASE, settled LAZILY on read — the same write-on-read doctrine
 * `domain/cooling.ts#settleCooling` and `domain/schedule.ts#settleWindow` already use for
 * requests, and for the same reason: there is no background timer in this system, and a
 * recovery path an operator has to remember to run is not a recovery path. The two acts
 * that the wedge blocks — creating the next job and reading the job's progress — are the
 * two that settle it, so the wedge un-wedges itself at the moment it would otherwise be
 * felt.
 */

/**
 * How long a claimed job may go without reporting before it is declared dead.
 *
 * The worker's own clone bound is `DefaultCloneTimeout = 10m`
 * (`tools/catalogctl/internal/scanworker/worker.go`), after which it reports `failed`
 * itself; prescan and upload follow. 30 minutes is that plus a wide margin, so a slow
 * clone on a big repository is never mistaken for a dead worker — the failure this
 * guards against is a process that is GONE, which no amount of waiting will fix.
 */
export const SCAN_JOB_LEASE_MS = 30 * 60_000;

/**
 * Has this job's lease expired as of `nowMsValue`?
 *
 * `queued` is excluded on purpose: a queued job is not wedged, it is waiting, and it
 * stays claimable indefinitely (an unreachable worker costs nothing but a visible
 * queue). Terminal jobs are excluded because they are already done.
 *
 * The clock starts at `startedAt` — stamped by the claim — falling back to `createdAt`
 * for any row that somehow left `queued` without one. A non-terminal row whose
 * timestamps are unparseable is treated as EXPIRED rather than ignored: a job that
 * cannot be aged is precisely a job nothing can ever release, which is the wedge itself.
 */
export function scanJobLeaseExpired(
  job: Pick<ProjectScanJobItem, "status" | "startedAt" | "createdAt">,
  nowMsValue: number,
): boolean {
  if (job.status === "queued" || isTerminalScanStatus(job.status)) return false;
  const startedMs = Date.parse(job.startedAt ?? job.createdAt);
  if (!Number.isFinite(startedMs)) return true;
  return nowMsValue - startedMs >= SCAN_JOB_LEASE_MS;
}

/** The server-authored reason a lease-expired job carries, so the wizard says something true. */
export const SCAN_LEASE_EXPIRED_REASON =
  "The scan worker stopped reporting and its claim expired. No scan artifact was uploaded — start a new scan.";

/**
 * Lazily fail a job whose claim lease expired, and return the row's true current state.
 *
 * A no-op for anything still inside its lease, still queued, or already terminal — so
 * this is cheap to call on every read. Idempotent-safe in exactly the way `settleCooling`
 * is: the write is guarded on the status this call observed, and a lost guard means
 * someone else (the worker itself, finally reporting; a concurrent reader settling the
 * same row) already moved it — so we re-read and return that, rather than failing a read
 * because another read did the same lazy work first.
 */
export async function settleScanJobLease(
  store: ConfigStore,
  job: ProjectScanJobItem,
): Promise<ProjectScanJobItem> {
  if (!scanJobLeaseExpired(job, nowMs())) return job;

  const from = job.status;
  const now = nowIso();
  const error = sanitizeScanError(SCAN_LEASE_EXPIRED_REASON);
  const settled: ProjectScanJobItem = {
    ...job,
    status: "failed",
    finishedAt: now,
    error,
  };
  const entry: AuditEntryInput = {
    action: "scan-job-lease-expired",
    actor: "system:scan-lease",
    targetType: "project",
    targetId: job.projectId,
    before: { jobId: job.jobId, status: from },
    after: { jobId: job.jobId, status: "failed" },
  };

  const k = scanJobKey(job.projectId, job.jobId);
  const hKey = chainHead(job.projectId);
  for (let attempt = 0; attempt < CHAIN_RETRY_ATTEMPTS; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes } = recordIn(job.projectId, head, entry);
    const domain: TransactWrite[] = [
      {
        kind: "update",
        pk: k.PK,
        sk: k.SK,
        set: { status: "failed", finishedAt: now, error },
        ifEquals: { attr: "status", value: from },
      },
    ];
    try {
      await store.transact([...domain, ...writes]);
      return settled;
    } catch (e) {
      if (e instanceof ConditionError) {
        const fresh = (await store.get(k.PK, k.SK)) as ProjectScanJobItem | null;
        if (fresh && fresh.status !== from) return fresh; // the worker reported, or another reader settled it
        if (attempt < CHAIN_RETRY_ATTEMPTS - 1) { await chainRetryBackoff(attempt); continue; } // chain contention (a DIFFERENT write) → retry with backoff (PERF-11)
        throw new ApiError("CHAIN_CONTENTION");
      }
      throw e;
    }
  }
  return job;
}

/** Settle every row in a project's scan-job list. Sequential, not `Promise.all`:
 * concurrent transacts against the SAME per-project chain head would only self-contend —
 * the reasoning `routes/requests.ts`'s list-settle loop already documents. */
export async function settleScanJobLeases(
  store: ConfigStore,
  jobs: ProjectScanJobItem[],
): Promise<ProjectScanJobItem[]> {
  const out: ProjectScanJobItem[] = [];
  for (const j of jobs) out.push(await settleScanJobLease(store, j));
  return out;
}
