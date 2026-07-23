import type { ConfigStore } from '../store/configStore';
import { loadAccounts } from './config';
import { exportAuditChain } from './auditQuery';
import { CONTROL_SCOPE, knownProjects } from '../projects';

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
  /** Human-readable reasons the probe is not ready (empty when ready). */
  reasons: string[];
};

/**
 * Ready iff the store loaded AND holds ≥1 account AND every registered project's audit
 * chain verifies. A project with no activity (count 0) verifies trivially, so an idle
 * project never trips readiness — only an emptied directory or a broken hash chain does.
 */
export async function readiness(store: ConfigStore): Promise<Readiness> {
  const reasons: string[] = [];
  try {
    const accounts = (await loadAccounts(store)).length;
    const projects = knownProjects();
    const estates = projects.filter((id) => id !== CONTROL_SCOPE).length;

    const chains: ChainReadiness[] = [];
    for (const projectId of projects) {
      const doc = await exportAuditChain(store, projectId);
      chains.push({ projectId, count: doc.count, verified: doc.verified, message: doc.verification.message });
      if (!doc.verified) reasons.push(`audit chain for project '${projectId}' does not verify: ${doc.verification.message}`);
    }

    if (accounts === 0) reasons.push('store holds 0 accounts — an emptied/wiped store is not ready (a bootstrapped store has ≥1 admin).');

    return { ready: reasons.length === 0, storeLoaded: true, accounts, estates, chains, reasons };
  } catch (e) {
    // A throwing store (unreadable/corrupt beyond load) is the least-ready state of all.
    return {
      ready: false,
      storeLoaded: false,
      accounts: 0,
      estates: 0,
      chains: [],
      reasons: [`store read failed: ${(e as Error).message}`],
    };
  }
}
