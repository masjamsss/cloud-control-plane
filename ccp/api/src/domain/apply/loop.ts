import { isAbsolute } from 'node:path';
import type { ConfigStore } from '../../store/configStore';
import { knownProjects } from '../../projects';
import { nowMs } from '../../clock';
import { DryRunExecutor, type ApplyExecutor } from './executor';
import { TerraformExecutor, TerraformExecutorError } from './terraformExecutor';
import { ConsoleNotifier, type Notifier } from './notify';
import { runDueApplies } from './scheduler';

/**
 * 0038 T4 — the THIN background loop, and the OFF-BY-DEFAULT gate.
 *
 * The pure `runDueApplies` (scheduler.ts) is where all the logic lives; this file is
 * only the impure shell: an interval timer + the env flags + the executor wiring.
 * It is deliberately the ONE place that reads `process.env` and arms a timer, so the
 * pure core stays a deterministic table test.
 *
 * OFF BY DEFAULT is the load-bearing invariant: with `CCP_SCHEDULER` unset,
 * {@link maybeStartSchedulerLoop} returns `null` and arms NO timer — merging this
 * subsystem changes ZERO production behavior. An operator must explicitly set
 * `CCP_SCHEDULER=1` to turn it on. Further env switches, ALL off by default:
 *   - `CCP_APPLY_FROZEN=1`   — master freeze: every tick is an audited no-op.
 *   - `CCP_APPLY_AUTO_REVERT=1` — opt-in revert-attempt on apply-failure.
 *   - `CCP_EXECUTOR=terraform`  — PROOF-MILESTONE opt-in: swap the DryRunExecutor
 *     for the real {@link TerraformExecutor}, which then REQUIRES an explicit
 *     absolute `CCP_TF_ROOT`. Any other value (or unset) keeps dry-run. A
 *     misconfigured terraform selection (missing/relative root, a real estate root)
 *     REFUSES TO ARM THE LOOP AT ALL — it never silently falls back to dry-run,
 *     because a dry-run "APPLIED" under an operator who believes the real executor
 *     is on would be a lie.
 */

type Env = Record<string, string | undefined>;

const DEFAULT_INTERVAL_MS = 60_000;

export function schedulerEnabled(env: Env = process.env): boolean {
  return env.CCP_SCHEDULER === '1';
}

/** Which executor the env selects: 'terraform' ONLY on the exact opt-in value. */
export function executorKind(env: Env = process.env): 'dry-run' | 'terraform' {
  return env.CCP_EXECUTOR === 'terraform' ? 'terraform' : 'dry-run';
}

/**
 * Construct the selected executor, fail-closed. Dry-run needs nothing. The terraform
 * executor demands an explicit absolute `CCP_TF_ROOT` and then applies its own
 * constructor guards (real-estate roots refused — see terraformExecutor.ts). Throws
 * {@link TerraformExecutorError} on any misconfiguration; it NEVER falls back.
 */
export function selectExecutor(env: Env = process.env): ApplyExecutor {
  if (executorKind(env) === 'dry-run') return new DryRunExecutor();
  const root = env.CCP_TF_ROOT;
  if (root === undefined || root === '' || !isAbsolute(root)) {
    throw new TerraformExecutorError(
      'CCP_EXECUTOR=terraform requires CCP_TF_ROOT to be an explicit ABSOLUTE path to the target terraform root — refusing to guess',
    );
  }
  return new TerraformExecutor({ rootDir: root });
}

export function applyFrozen(env: Env = process.env): boolean {
  return env.CCP_APPLY_FROZEN === '1';
}

export function autoRevertEnabled(env: Env = process.env): boolean {
  return env.CCP_APPLY_AUTO_REVERT === '1';
}

export interface SchedulerHandle {
  stop(): void;
}

export interface LoopOptions {
  env?: Env;
  intervalMs?: number;
  notifier?: Notifier;
}

/**
 * Start the background auto-apply loop — but ONLY if `CCP_SCHEDULER=1`. Returns a
 * handle to stop it, or `null` when the flag is unset (the default: no timer, no work).
 *
 * Each tick re-reads `CCP_APPLY_FROZEN` / `CCP_APPLY_AUTO_REVERT` so an operator
 * can freeze or enable revert WITHOUT a redeploy. The executor is selected ONCE, here,
 * via {@link selectExecutor}: DryRunExecutor unless `CCP_EXECUTOR=terraform` is
 * explicitly set. A misconfigured terraform selection refuses to arm the loop entirely
 * (console.error + null) — held requests stay AWAITING; nothing pretends to apply.
 */
export function maybeStartSchedulerLoop(store: ConfigStore, options: LoopOptions = {}): SchedulerHandle | null {
  const env = options.env ?? process.env;
  if (!schedulerEnabled(env)) return null; // OFF BY DEFAULT — nothing armed

  let executor: ApplyExecutor;
  try {
    executor = selectExecutor(env);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[ccp:scheduler] REFUSING to arm the auto-apply loop —', e instanceof Error ? e.message : e);
    return null;
  }
  const notifier = options.notifier ?? new ConsoleNotifier();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Non-reentrancy guard (adversarial review Finding 1b): `setInterval` does NOT await
  // the callback, so a tick that outlasts the interval would otherwise overlap the next.
  // A real `executor.apply` can be slow — so if the previous tick is still in flight we
  // SKIP this one entirely. This is defense-in-depth atop the scheduler's own claim-first
  // single-apply guard; together they make an overlapping double-apply impossible.
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return; // previous tick still running — skip
    inFlight = true;
    try {
      const frozen = applyFrozen(env);
      const revertOnFailure = autoRevertEnabled(env);
      const now = nowMs();
      for (const projectId of knownProjects()) {
        try {
          await runDueApplies(store, projectId, now, executor, { notifier, frozen, revertOnFailure });
        } catch (e) {
          // A single project's failure must not kill the loop or leak into others.
          // eslint-disable-next-line no-console
          console.error(`[ccp:scheduler] tick failed for project ${projectId}:`, e);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Never keep the process alive just for this loop (matches server lifecycle expectations).
  if (typeof timer.unref === 'function') timer.unref();

  return { stop: () => clearInterval(timer) };
}
