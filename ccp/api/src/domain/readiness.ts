import type { ConfigStore } from '../store/configStore';
import { loadAccounts } from './config';
import { verifyProjectChain } from './auditQuery';
import { CONTROL_SCOPE, knownProjects } from '../projects';
import { driftPointerKey, projectKey, type DriftPointerItem, type ProjectItem } from '../store/schema';
import { projectDataVersionExists, resolveProjectDataRoot } from './projectData';
import { driftReportExists } from './drift';

/**
 * Readiness that does NOT lie (`/healthz` stays green even with an
 * emptied store). This probes the STORE for real signal — that it loaded, holds at
 * least one account, and that every per-project audit chain still verifies — so an
 * emptied or corrupted store reads as explicitly NOT ready (503) instead of silently
 * green. Read-only; verification reuses the canonical exportAuditChain/verifyChain.
 *
 * `knownProjects()` always includes the reserved `@control` scope (data-birth spec
 * §5) — its chain is verified exactly like any estate's (idle/count-0 verifies
 * trivially, so a founded-but-still-blank instance stays green); `estates` is the
 * count of everything else — the real, onboarded accounts — so a first-run UI can
 * tell "founded, zero estates" (estates:0, ready:true) apart from "not ready".
 */

export type ChainReadiness = { projectId: string; count: number; verified: boolean; message: string };

export type Readiness = {
  ready: boolean;
  /** The store answered reads without throwing (loaded + reachable). */
  storeLoaded: boolean;
  /** GLOBAL account directory size. Zero = emptied/wiped store → not ready. */
  accounts: number;
  /** Ready, onboarded estates — `knownProjects()` minus the reserved `@control`
   * scope. Zero is a valid, ready state (a founded, freshly-blank instance). */
  estates: number;
  chains: ChainReadiness[];
  /** ARCH-9 — how many rows the store currently holds, or `null` when the backend
   * cannot answer cheaply ({@link ConfigStore.approxItemCount}). Informational
   * only: growth here is a trend to alert on externally, never a readiness gate
   * (a large store is not itself a fault). */
  storeItemCount: number | null;
  /** Human-readable reasons the probe is not ready (empty when ready). */
  reasons: string[];
};

/**
 * Ready iff the store loaded AND holds ≥1 account AND every registered project's audit
 * chain verifies AND every project's active served files are actually on disk (DATA-10).
 * A project with no activity (count 0) verifies trivially, so an idle project never trips
 * readiness — only an emptied directory or a broken hash chain does. `projectDataRoot`
 * defaults to the real deploy resolution ({@link resolveProjectDataRoot}); tests inject
 * their own temp root the same way `createApp`'s `projectDataRoot` option already does
 * for the serve routes.
 */
export async function readiness(store: ConfigStore, projectDataRoot: string = resolveProjectDataRoot()): Promise<Readiness> {
  const reasons: string[] = [];
  try {
    const accounts = (await loadAccounts(store)).length;
    const projects = knownProjects();
    const estates = projects.filter((id) => id !== CONTROL_SCOPE).length;

    const chains: ChainReadiness[] = [];
    for (const projectId of projects) {
      // `verifyProjectChain`, not `exportAuditChain`: the probe needs a verdict, not
      // the evidence document. Building the full `AuditEntry[]` projection only to
      // throw it away made every probe cost the whole chain, and a readiness probe
      // is the one endpoint that runs forever on a timer. The export endpoint and
      // the offline verifier still do the full, uncached walk.
      const chain = await verifyProjectChain(store, projectId);
      chains.push({ projectId, count: chain.count, verified: chain.verified, message: chain.message });
      if (!chain.verified) reasons.push(`audit chain for project '${projectId}' does not verify: ${chain.message}`);

      // DATA-10 — a `dataActive`/drift pointer that survived a disk-death restore while
      // its files did not (or were restored from a different backup generation) must not
      // read as ready: serves would fail closed to 404/report:null behind a green probe.
      // Cheap existence stats only — see projectDataVersionExists/driftReportExists's own
      // doc comments for why this is never a digest recompute on this hot, timer-driven path.
      const pk = projectKey(projectId);
      const project = (await store.get(pk.PK, pk.SK)) as ProjectItem | null;
      if (project?.dataActive && !projectDataVersionExists(projectDataRoot, projectId, project.dataActive.version)) {
        reasons.push(
          `project '${projectId}' has an ACTIVE served-data version (v${project.dataActive.version}) whose files are missing on disk — check the data root or restore the project-data backup alongside the store.`,
        );
      }
      const dk = driftPointerKey(projectId);
      const pointer = (await store.get(dk.PK, dk.SK)) as DriftPointerItem | null;
      if (pointer && !driftReportExists(projectDataRoot, projectId, pointer.version)) {
        reasons.push(
          `project '${projectId}' has a served drift report (v${pointer.version}) whose file is missing on disk — check the data root or restore the project-data backup alongside the store.`,
        );
      }
    }

    if (accounts === 0) reasons.push('store holds 0 accounts — an emptied/wiped store is not ready (a bootstrapped store has ≥1 admin).');

    // DATA-3 / ERR-10 — a store that can no longer make writes durable is NOT ready,
    // however well it answers reads. Its memory has diverged from disk by an unknown
    // amount, so every read it serves may be state a restart will not resurrect. This is
    // exactly what readiness is for: take the instance out of rotation rather than let it
    // keep serving confidently wrong answers behind a green probe.
    const durability = store.durabilityFault?.() ?? null;
    if (durability !== null) reasons.push(durability);

    // ARCH-9 — informational only (see the field's own doc comment): never added
    // to `reasons`, a big store is not a fault, just a trend worth an operator's
    // own external alert threshold.
    const storeItemCount = store.approxItemCount?.() ?? null;

    return { ready: reasons.length === 0, storeLoaded: true, accounts, estates, chains, storeItemCount, reasons };
  } catch (e) {
    // A throwing store (unreadable/corrupt beyond load) is the least-ready state of all.
    return {
      ready: false,
      storeLoaded: false,
      accounts: 0,
      estates: 0,
      chains: [],
      storeItemCount: null,
      reasons: [`store read failed: ${(e as Error).message}`],
    };
  }
}
