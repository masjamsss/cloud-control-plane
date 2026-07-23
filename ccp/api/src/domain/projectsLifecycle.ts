import type { ConfigStore } from '../store/configStore';
import type { PendingConfigChangeItem } from '../store/schema';
import { PROJECT_DATA_SK_PREFIX } from '../store/schema';
import { record } from './audit';
import { refreshKnownProjects } from '../projects';
import { removeProjectData, resolveProjectDataRoot } from './projectData';

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
  if (applied.status !== 'APPLIED') return;
  const targetId = applied.targetKey.replace(/^PROJECT#/, '');
  if (applied.kind === 'project-trust') {
    await record(store, projectId, {
      action: 'Trusted repo for onboarding',
      actor: ackerId,
      targetType: 'project',
      targetId,
      after: applied.after,
    });
  }
  if (applied.kind === 'project-data-activate') {
    // Data-plane action → the TARGET project's chain (the same chain its
    // config-propose/config-apply pair landed on), so the tenant's own trail
    // shows what was switched into service for them.
    await record(store, applied.auditProjectId ?? projectId, {
      action: 'Activated project data for serving',
      actor: ackerId,
      targetType: 'project',
      targetId,
      after: applied.after,
    });
    // A FIRST activation's apply also set status 'ready' (go-live) — resync so
    // the project is routable/bindable the moment the second admin acks. (On a
    // re-activation this is a harmless idempotent re-read.)
    await refreshKnownProjects(store);
  }
  if (applied.kind === 'project-deregister') {
    // Satellite cleanup, fail closed: no upload token survives its project, no
    // stale metadata rows, no servable files. (The META row itself was the
    // dual-controlled delete the ack just applied.)
    const pk = `PROJECT#${targetId}`;
    for (const prefix of ['UPLOADTOKEN#', PROJECT_DATA_SK_PREFIX]) {
      const rows = await store.query(pk, prefix);
      for (const row of rows) await store.delete(row.PK, row.SK);
    }
    removeProjectData(opts.dataRoot ?? resolveProjectDataRoot(), targetId);
    await refreshKnownProjects(store);
  }
  if (applied.kind === 'project-unarchive') {
    await refreshKnownProjects(store);
  }
}
