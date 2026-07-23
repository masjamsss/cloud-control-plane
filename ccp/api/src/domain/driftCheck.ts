import { spawnSync } from 'node:child_process';

/**
 * "Start drift check" (owner refinement 4; spec addendum A7; plan §2-B1) —
 * the on-demand-run half of the two portal buttons. Mirrors
 * `domain/bundle.ts#BundleSteps`/`domain/driftProposals.ts#DriftGenSteps`:
 * an injected-command seam so `routes/drift.ts`'s `POST /:id/drift/check`
 * never shells out directly and tests use fakes, no network.
 *
 * The api NEVER runs terraform (AGENTS.md rule 1) — `CCP_DRIFT_CHECK_CMD`
 * is an OPERATOR command wired to the estate drift workflow's existing
 * `workflow_dispatch` (`drift.yml:46`, e.g. `gh workflow run drift.yml
 * -f project=$CCP_DRIFT_PROJECT`), not a plan/apply of any kind. The
 * report only "lands" later, through the normal `PUT /:id/drift` publish —
 * this button merely asks the workflow to run.
 *
 * OFF BY DEFAULT (the loop.ts/bundle.ts/drift.ts invariant):
 * {@link driftCheckConfig} returns null unless `CCP_DRIFT_CHECK_CMD` is
 * explicitly set — merging this changes ZERO production behavior.
 */

type Env = Record<string, string | undefined>;

export interface DriftCheckConfig {
  /** Operator command; run with env `CCP_DRIFT_PROJECT=<id>`. Exit 0 = fired. */
  cmd: string;
}

export function driftCheckConfig(env: Env = process.env): DriftCheckConfig | null {
  const cmd = env.CCP_DRIFT_CHECK_CMD;
  return cmd ? { cmd } : null;
}

export interface DriftCheckStepResult {
  ok: boolean;
  /** Captured stdout/stderr tail, or the refusal reason — audit evidence. */
  detail: string;
}

/** Injected-steps interface (the bundle-trigger pattern, spec A7) — tests
 * inject a fake; the real implementation spawns the operator's command. */
export interface DriftCheckSteps {
  trigger(projectId: string): DriftCheckStepResult | Promise<DriftCheckStepResult>;
}

const tail = (s: string, n = 400): string => (s.length > n ? `…${s.slice(-n)}` : s);

/** Production steps: the operator's shell command, env `CCP_DRIFT_PROJECT`. */
export function realDriftCheckSteps(cfg: DriftCheckConfig): DriftCheckSteps {
  return {
    trigger(projectId) {
      const r = spawnSync('bash', ['-lc', cfg.cmd], {
        env: { ...process.env, CCP_DRIFT_PROJECT: projectId },
        encoding: 'utf8',
        timeout: 5 * 60_000,
      });
      const detail = tail(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim());
      return { ok: r.status === 0, detail: detail || (r.status === 0 ? 'triggered' : `trigger exited ${r.status}`) };
    },
  };
}

/* ── one-in-flight-per-project guard (mirrors driftProposals.ts's genState) ── */

const inFlightProjects = new Set<string>();

/** Test hook: forget every project's in-flight state. */
export function __resetDriftCheckStateForTests(): void {
  inFlightProjects.clear();
}

export type DriftCheckOutcome = { ok: true; detail: string } | { ok: false; conflict: true } | { ok: false; conflict: false; detail: string };

/**
 * Run the injected trigger under a ONE-IN-FLIGHT-PER-PROJECT guard: a
 * concurrent call for the same project while one is already running is
 * refused outright (`conflict: true`, the route maps this to 409
 * `STATE_CONFLICT`) rather than queued or run twice — this is a single
 * on-demand click, not the queue-collapsing generation runner.
 */
export async function runDriftCheck(steps: DriftCheckSteps, projectId: string): Promise<DriftCheckOutcome> {
  if (inFlightProjects.has(projectId)) return { ok: false, conflict: true };
  inFlightProjects.add(projectId);
  try {
    const result = await steps.trigger(projectId);
    return result.ok ? { ok: true, detail: result.detail } : { ok: false, conflict: false, detail: result.detail };
  } finally {
    inFlightProjects.delete(projectId);
  }
}
