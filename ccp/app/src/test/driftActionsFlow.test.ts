import { describe, expect, it } from 'vitest';
import { nextCheckState, nextGenerateState } from '@/features/drift/driftActionsFlow';

/**
 * Pure state-derivation for the two drift-page buttons (spec addendum A7 /
 * plan B1+B2). Pins the one behavior the plan calls out by name:
 * `DRIFT_DISARMED` becomes a STANDING disabled-with-reason state, distinct
 * from any other refusal (role/freeze/conflict), which stays a retryable
 * one-off error.
 */
describe('nextCheckState — "Start drift check" button state', () => {
  it('ok maps to requested, carrying the server timestamp verbatim', () => {
    expect(nextCheckState({ ok: true, at: '2026-07-20T09:00:00Z' })).toEqual({
      kind: 'requested',
      at: '2026-07-20T09:00:00Z',
    });
  });

  it('DRIFT_DISARMED maps to a standing disarmed state, not a one-off error', () => {
    expect(
      nextCheckState({
        ok: false,
        code: 'DRIFT_DISARMED',
        reason: 'On-demand drift checks are not armed on this deployment (CCP_DRIFT_CHECK_CMD unset).',
      }),
    ).toEqual({
      kind: 'disarmed',
      reason: 'On-demand drift checks are not armed on this deployment (CCP_DRIFT_CHECK_CMD unset).',
    });
  });

  it('any other refusal (role, freeze, in-flight conflict) maps to a retryable error', () => {
    expect(nextCheckState({ ok: false, code: 'STATE_CONFLICT', reason: 'A check is already running.' })).toEqual({
      kind: 'error',
      reason: 'A check is already running.',
    });
    expect(nextCheckState({ ok: false, reason: 'Only a lead or an admin can start a check.' })).toEqual({
      kind: 'error',
      reason: 'Only a lead or an admin can start a check.',
    });
  });
});

describe('nextGenerateState — "Fix the drift" generation-refresh state', () => {
  it('ok maps to done, carrying the report version', () => {
    expect(nextGenerateState({ ok: true, reportVersion: 7 })).toEqual({ kind: 'done', reportVersion: 7 });
  });

  it('DRIFT_DISARMED maps to a standing disarmed state', () => {
    expect(
      nextGenerateState({ ok: false, code: 'DRIFT_DISARMED', reason: 'Generation is not armed.' }),
    ).toEqual({ kind: 'disarmed', reason: 'Generation is not armed.' });
  });

  it('any other refusal maps to a retryable error', () => {
    expect(nextGenerateState({ ok: false, code: 'STATE_CONFLICT', reason: 'Nothing to generate from.' })).toEqual({
      kind: 'error',
      reason: 'Nothing to generate from.',
    });
  });
});
