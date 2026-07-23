import type { DriftCheckResult, DriftGenerateResult } from '@/lib/api';

/**
 * Pure state-derivation for the drift page's two operator buttons ("Start
 * drift check" / "Fix the drift", spec addendum A7 / plan B1+B2). React-free
 * so the "disabled-with-reason when disarmed" behavior is unit-testable
 * without mounting DriftPage (this repo has no jsdom — see
 * test/standalone.test.ts's exact dependency allowlist). Mirrors
 * features/drift/proposalFlow.ts's shape: the component stays a thin
 * wrapper that calls the seam method, folds the result through one of the
 * functions below, and renders the resulting state.
 *
 * Both buttons share the same shape of outcome: a one-off success (render
 * it, then let the next click try again), a DISARMED refusal (render a
 * STANDING disabled state with the server's own reason — the button stops
 * inviting further clicks until the project changes), or any other refusal
 * (role/freeze/conflict — a retryable inline error, the button stays
 * enabled). `code` is compared to the literal string `'DRIFT_DISARMED'`
 * rather than imported as a constant: these two routes are the only api
 * surface that can produce it client-side, and errors.ts's codes are an
 * api-side enum this app does not vendor.
 */

export type DriftCheckButtonState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'requested'; at: string }
  | { kind: 'disarmed'; reason: string }
  | { kind: 'error'; reason: string };

export function nextCheckState(result: DriftCheckResult): DriftCheckButtonState {
  if (result.ok) return { kind: 'requested', at: result.at };
  if (result.code === 'DRIFT_DISARMED') return { kind: 'disarmed', reason: result.reason };
  return { kind: 'error', reason: result.reason };
}

export type DriftGenerateButtonState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'done'; reportVersion: number }
  | { kind: 'disarmed'; reason: string }
  | { kind: 'error'; reason: string };

export function nextGenerateState(result: DriftGenerateResult): DriftGenerateButtonState {
  if (result.ok) return { kind: 'done', reportVersion: result.reportVersion };
  if (result.code === 'DRIFT_DISARMED') return { kind: 'disarmed', reason: result.reason };
  return { kind: 'error', reason: result.reason };
}
