import { createHash } from 'node:crypto';
import type { RequestItem } from '../../store/schema';

/**
 * 0038 T2 — the ApplyExecutor seam for scheduled auto-apply. This is the RISKIEST
 * subsystem in Cloud Control Plane: the first thing that will EVENTUALLY change live production
 * at a scheduled time with no human present. So the ONLY executor that ships here is
 * {@link DryRunExecutor} — it runs NO terraform and makes NO AWS call. The real
 * terraform executor is a LATER, human-gated step (see the stub note below).
 *
 * Design mirror: the scheduler ({@link ../apply/scheduler}) depends on this INTERFACE,
 * never a concrete executor, exactly as `routes/requests.ts` depends on the pure
 * `domain/schedule.ts` gate rather than reaching into store internals. Swapping in the
 * real terraform executor later is a one-line construction change with ZERO scheduler
 * edits — the decision logic (drift halt, retry-once, freeze) is executor-agnostic.
 */

/** The pinned, reviewed plan a scheduled apply is allowed to enact. `digest` is the drift anchor. */
export interface PlanResult {
  /** The plan diff text (the reviewed change). */
  diff: string;
  /** sha256 hex of the plan the executor would enact (for DryRun: the pinned digest). */
  digest: string;
}

/** The outcome of an apply/revert. `ok:false` (or a thrown error) is a failure. */
export interface ApplyResult {
  ok: boolean;
  /** Human-readable outcome — the "DRY-RUN — would apply" marker lives here. */
  detail: string;
  /** Recorded onto the request as `appliedSha`; a `DRYRUN-…` sentinel for dry-run,
   * the applied planfile's sha256 for the real terraform executor. */
  appliedSha?: string;
  /** Evidence link recorded onto the request; `dryrun://…` sentinel or a real
   * apply-log location. */
  evidenceUrl?: string;
  /** TRUE only when nothing real was executed. The scheduler stamps this into the
   * audit so a dry-run APPLIED can never masquerade as a real one (or vice versa).
   * Optional for test fakes; absent is audited as NOT dry-run. */
  dryRun?: boolean;
}

/**
 * The three operations a scheduled auto-apply drives. All async so a real executor
 * (which shells to terraform) drops in behind the SAME interface with no scheduler
 * change.
 *
 * ── THE REAL EXECUTOR NOW EXISTS — AS A PROOF MILESTONE ONLY ──────────────────────
 * `./terraformExecutor.ts#TerraformExecutor` implements this interface over REAL
 * `terraform` for the local-server proof: replan() is a fresh `terraform plan`,
 * apply() enacts ONLY the planfile saved and digest-pinned at plan time. It is the
 * ONE sanctioned process-spawning file in this directory, is opt-in via
 * `CCP_EXECUTOR=terraform` + an explicit `CCP_TF_ROOT`, and refuses the real
 * estate roots by construction — see its header. It is NOT the production
 * multi-account executor. NOTHING ELSE here — this file, the scheduler, the loop,
 * the notifier — may `spawn`/`exec`/`child_process` or import an AWS SDK; the
 * source-level test in `test/schedulerGating.test.ts` enforces it directory-wide
 * minus that one file.
 */
export interface ApplyExecutor {
  /** Optional honest self-description ('dry-run' | 'terraform') — surfaced in the
   * request timeline so an operator can tell what actually ran. */
  readonly kind?: string;
  replan(req: RequestItem): Promise<PlanResult>;
  apply(req: RequestItem): Promise<ApplyResult>;
  revert(req: RequestItem): Promise<ApplyResult>;
}

/**
 * The ONE digest function — sha256 hex of the plan text (mirrors `domain/audit.ts`'s
 * `node:crypto` usage). Used both to PIN a reviewed plan and to check a pin is intact.
 * Accepts a Buffer for artifact (planfile) bytes — same function, same anchor.
 */
export function digestOf(diff: string | Buffer): string {
  return createHash('sha256').update(diff).digest('hex');
}

/**
 * The ONLY executor that ships. Performs NO terraform and NO AWS call:
 *  - `replan` returns the request's ALREADY-PINNED plan/digest verbatim — a "re-plan"
 *    that reads the pin, not the world. So with the DryRunExecutor the drift check
 *    always MATCHES (there is no live state to drift against); real drift is only
 *    observable once the real executor lands. Tests inject a drifting executor to
 *    exercise the halt-on-drift path.
 *  - `apply` records a clearly-marked "DRY-RUN — would apply" result and does NOTHING.
 *  - `revert` is likewise a dry-run stub.
 */
export class DryRunExecutor implements ApplyExecutor {
  readonly kind = 'dry-run';

  async replan(req: RequestItem): Promise<PlanResult> {
    // Verbatim pin readback: NO terraform, NO AWS. `digest` is the approved digest as
    // stored; integrity of that pin is checked by the scheduler (isPinIntact), not here.
    return { diff: req.pinnedDiff ?? '', digest: req.planDigest ?? '' };
  }

  async apply(req: RequestItem): Promise<ApplyResult> {
    return {
      ok: true,
      dryRun: true,
      detail: `DRY-RUN — would apply ${req.id} (${req.targetAddress}); no terraform run, no AWS call`,
      appliedSha: `DRYRUN-${req.planDigest ?? 'nodigest'}`,
      evidenceUrl: `dryrun://apply/${req.id}`,
    };
  }

  async revert(req: RequestItem): Promise<ApplyResult> {
    return {
      ok: true,
      dryRun: true,
      detail: `DRY-RUN — would revert ${req.id}; no terraform run, no AWS call`,
      appliedSha: `DRYRUN-REVERT-${req.planDigest ?? 'nodigest'}`,
      evidenceUrl: `dryrun://revert/${req.id}`,
    };
  }
}
