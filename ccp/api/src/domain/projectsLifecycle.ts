import type { ConfigStore } from "../store/configStore";
import type {
  PendingConfigChangeItem,
  ProjectRetirementItem,
} from "../store/schema";
import { projectRetirementKey } from "../store/schema";
import { record } from "./audit";
import { nowIso } from "../clock";
import { refreshKnownProjects } from "../projects";
import { removeProjectData, resolveProjectDataRoot } from "./projectData";

/**
 * Post-ack lifecycle for project-kind dual-control changes. The
 * generic ack machinery (domain/dualControl.ts) applies the write and audits
 * 'config-apply'; this hook adds the project-specific consequences:
 *
 *  1. `project-trust` apply → the NAMED audit event specifies,
 *     'Trusted repo for onboarding', carrying the trust block (trustedBy is the
 *     PROPOSING lead — the human who read the findings; the acker is the second
 *     control and is this entry's actor).
 *  2. `project-deregister` apply → the known-projects cache must drop a ready
 *     project immediately (fail-closed routing), so resync from the store; the
 *     project's satellite rows (upload tokens, data-version metadata) and its
 *     on-disk served data are removed with it — a deregistered project must not
 *     leave a live upload credential or servable files behind.
 *  3. `project-data-activate` apply → the NAMED audit event ('Activated project
 *     data for serving') so the served-data switch reads plainly in the trail;
 *     and because the FIRST activation's apply also flips the project 'ready'
 *     (go-live — routes/projectData.ts), the known-projects cache resyncs so
 *     the newly ready project is routable at ack time, not a hydration later.
 *  4. `project-unarchive` apply → the project may be routable again; resync.
 *
 * Reject/expiry need nothing: an unapplied proposal changed no state.
 */
export async function afterProjectConfigApply(
  store: ConfigStore,
  projectId: string,
  applied: PendingConfigChangeItem,
  ackerId: string,
  opts: { dataRoot?: string } = {},
): Promise<void> {
  if (applied.status !== "APPLIED") return;
  const targetId = applied.targetKey.replace(/^PROJECT#/, "");
  if (applied.kind === "project-trust") {
    await record(store, projectId, {
      action: "Trusted repo for onboarding",
      actor: ackerId,
      targetType: "project",
      targetId,
      after: applied.after,
    });
  }
  if (applied.kind === "project-data-activate") {
    // Data-plane action → the TARGET project's chain (the same chain its
    // config-propose/config-apply pair landed on), so the tenant's own trail
    // shows what was switched into service for them.
    await record(store, applied.auditProjectId ?? projectId, {
      action: "Activated project data for serving",
      actor: ackerId,
      targetType: "project",
      targetId,
      after: applied.after,
    });
    // A FIRST activation's apply also set status 'ready' (go-live) — resync so
    // the project is routable/bindable the moment the second admin acks. (On a
    // re-activation this is a harmless idempotent re-read.)
    await refreshKnownProjects(store);
  }
  if (applied.kind === "project-deregister") {
    // Satellite cleanup, fail closed. THE RULE IS THE PARTITION, NOT A PREFIX
    // LIST (API-9): everything a project accumulates lives under `PROJECT#<id>`,
    // so deregistration deletes what it FINDS there rather than the three
    // prefixes someone remembered. The old list named UPLOADTOKEN#, ONBOARDTOKEN#
    // and DATA#v, and by the time the audit ran it had been outgrown four times
    // over — FORGECRED (the sealed forge credential), SCANJOB#, DRIFT#v… /
    // DRIFT#latest and DRIFTPROP# all survived their project. A satellite row
    // type invented tomorrow is swept by this loop on the day it is invented.
    //
    // (The META row itself was the dual-controlled delete the ack just applied,
    // so it is already gone; if a store somehow still carries it, sweeping it
    // here is the same fail-closed outcome.)
    const pk = `PROJECT#${targetId}`;
    const survivors = await store.query(pk);
    for (const row of survivors) await store.delete(row.PK, row.SK);
    removeProjectData(opts.dataRoot ?? resolveProjectDataRoot(), targetId);
    // RETIRE THE ID. A complete sweep still cannot make id reuse safe: the
    // project-scoped partitions (`P#<id>#REQ…`, `#AUDIT…`, `#TEAM…`, `#POLICY`)
    // are NOT under this PK and cannot even be enumerated through the store seam
    // (query is by exact PK; there is no scan), and the audit chain must survive
    // as evidence in any case. So the id is retired rather than recycled — the
    // tombstone is written LAST, after the sweep, and `POST /projects` refuses
    // any id whose partition is non-empty. See RESIDUE R-96.
    const tomb: ProjectRetirementItem = {
      ...projectRetirementKey(targetId),
      projectId: targetId,
      retiredAt: nowIso(),
      retiredBy: ackerId,
      sweptRows: survivors.length,
    };
    await store.put(tomb);
    await refreshKnownProjects(store);
  }
  if (applied.kind === "project-unarchive") {
    await refreshKnownProjects(store);
  }
}
