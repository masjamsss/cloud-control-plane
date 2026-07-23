import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW_MS,
  MAX_HORIZON_MS,
  MAX_WINDOW_MS,
  MIN_LEAD_MS,
  applyGate,
  evaluateTime,
  isWindowInfeasible,
  validateSchedule,
  windowEndOf,
  type Schedule,
} from '../src/domain/schedule';

/**
 * T-S1 (0024 §2.1/§2.2/§3.2) — exhaustive table tests for the pure schedule gate.
 * Every scenario drives `now`/`earliestApplyAt`/`schedule` explicitly (no clock,
 * no I/O) so this file alone proves the composition rule holds at every boundary.
 *
 * `evaluateTime`'s table (below) is a line-for-line transcription of
 * `tools/catalogctl/internal/windowcheck/windowcheck_test.go`'s `TestEvaluate` —
 * kept here as a permanent, Go-toolchain-INDEPENDENT regression guard. The LIVE
 * cross-check against the real `catalogctl window-check` binary (best-effort, over
 * the shared `testdata/windows/*.yaml` fixtures) lives in
 * `scheduleWindowCheckParity.test.ts`.
 */

const ms = (iso: string): number => Date.parse(iso);

describe('validateSchedule — V1-V6 (0024 §2.1)', () => {
  const NOW = ms('2026-07-12T12:00:00.000Z');

  it('V1: kind "now" is always valid, untouched', () => {
    expect(validateSchedule({ kind: 'now' }, NOW)).toEqual({ ok: true, schedule: { kind: 'now' } });
  });

  it('V2: an unparseable `at` is SCHEDULE_INVALID', () => {
    expect(validateSchedule({ kind: 'window', at: 'banana' }, NOW)).toEqual({ ok: false, code: 'SCHEDULE_INVALID' });
    expect(validateSchedule({ kind: 'window', at: '' }, NOW)).toEqual({ ok: false, code: 'SCHEDULE_INVALID' });
  });

  it('V3: `at` before now+MIN_LEAD is SCHEDULE_TOO_SOON, at the boundary is fine', () => {
    const tooSoon = new Date(NOW + MIN_LEAD_MS - 1).toISOString();
    expect(validateSchedule({ kind: 'window', at: tooSoon }, NOW)).toEqual({ ok: false, code: 'SCHEDULE_TOO_SOON' });

    const exactly = new Date(NOW + MIN_LEAD_MS).toISOString();
    const result = validateSchedule({ kind: 'window', at: exactly }, NOW);
    expect(result.ok).toBe(true);
  });

  it('a submit at exactly `now` (the picker\'s old footgun default) is TOO_SOON', () => {
    const result = validateSchedule({ kind: 'window', at: new Date(NOW).toISOString() }, NOW);
    expect(result).toEqual({ ok: false, code: 'SCHEDULE_TOO_SOON' });
  });

  it('V4: `at` beyond now+MAX_HORIZON is SCHEDULE_TOO_FAR, at the boundary is fine', () => {
    const tooFar = new Date(NOW + MAX_HORIZON_MS + 1).toISOString();
    expect(validateSchedule({ kind: 'window', at: tooFar }, NOW)).toEqual({ ok: false, code: 'SCHEDULE_TOO_FAR' });

    const exactly = new Date(NOW + MAX_HORIZON_MS).toISOString();
    expect(validateSchedule({ kind: 'window', at: exactly }, NOW).ok).toBe(true);
  });

  it('V5: an omitted `endAt` defaults to `at + DEFAULT_WINDOW_MS`, computed and stored', () => {
    const at = new Date(NOW + MIN_LEAD_MS).toISOString();
    const result = validateSchedule({ kind: 'window', at }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok && result.schedule.kind === 'window') {
      expect(result.schedule.endAt).toBe(new Date(ms(at) + DEFAULT_WINDOW_MS).toISOString());
    }
  });

  it('V5: an explicit `endAt` at or before `at` is SCHEDULE_INVALID', () => {
    const at = new Date(NOW + MIN_LEAD_MS).toISOString();
    expect(validateSchedule({ kind: 'window', at, endAt: at }, NOW)).toEqual({ ok: false, code: 'SCHEDULE_INVALID' });
    const before = new Date(ms(at) - 1000).toISOString();
    expect(validateSchedule({ kind: 'window', at, endAt: before }, NOW)).toEqual({ ok: false, code: 'SCHEDULE_INVALID' });
  });

  it('V5: an explicit `endAt` spanning more than 24h is SCHEDULE_INVALID, exactly 24h is fine', () => {
    const at = new Date(NOW + MIN_LEAD_MS).toISOString();
    const tooLong = new Date(ms(at) + MAX_WINDOW_MS + 1).toISOString();
    expect(validateSchedule({ kind: 'window', at, endAt: tooLong }, NOW)).toEqual({ ok: false, code: 'SCHEDULE_INVALID' });

    const exactly24h = new Date(ms(at) + MAX_WINDOW_MS).toISOString();
    const result = validateSchedule({ kind: 'window', at, endAt: exactly24h }, NOW);
    expect(result).toEqual({ ok: true, schedule: { kind: 'window', at, endAt: exactly24h } });
  });

  it('V5: a garbled explicit `endAt` is SCHEDULE_INVALID', () => {
    const at = new Date(NOW + MIN_LEAD_MS).toISOString();
    expect(validateSchedule({ kind: 'window', at, endAt: 'not-a-date' }, NOW)).toEqual({ ok: false, code: 'SCHEDULE_INVALID' });
  });

  it('V6: both instants are normalized through Date().toISOString(), whatever the client sent', () => {
    // A non-canonical-but-valid RFC3339 offset form must come back as canonical UTC.
    const atMs = NOW + 2 * 60 * 60 * 1000;
    const nonCanonical = new Date(atMs).toISOString().replace('Z', '+00:00');
    const result = validateSchedule({ kind: 'window', at: nonCanonical }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok && result.schedule.kind === 'window') {
      expect(result.schedule.at).toBe(new Date(atMs).toISOString());
      expect(result.schedule.at.endsWith('Z')).toBe(true);
    }
  });
});

describe('windowEndOf', () => {
  it('undefined for kind "now" — no window exists', () => {
    expect(windowEndOf({ kind: 'now' })).toBeUndefined();
  });

  it('the stored endAt, when present', () => {
    expect(windowEndOf({ kind: 'window', at: '2026-07-12T18:00:00.000Z', endAt: '2026-07-12T20:00:00.000Z' })).toBe(
      '2026-07-12T20:00:00.000Z',
    );
  });

  it('legacy rows without endAt: at + DEFAULT_WINDOW_MS (4h), so the gate is total', () => {
    const at = '2026-07-12T18:00:00.000Z';
    expect(windowEndOf({ kind: 'window', at })).toBe(new Date(ms(at) + DEFAULT_WINDOW_MS).toISOString());
  });

  it('undefined for an unparseable `at` (fail-closed at the caller, not a throw here)', () => {
    expect(windowEndOf({ kind: 'window', at: 'garbage' })).toBeUndefined();
  });
});

describe('evaluateTime — ported line-for-line from windowcheck_test.go TestEvaluate', () => {
  const wStart = '2026-07-12T18:00:00Z';
  const wEnd = '2026-07-12T22:00:00Z';
  const windowed = (start: string, end: string): Schedule => ({ kind: 'window', at: start, endAt: end });

  it.each([
    // name, schedule, earliestApplyAt, now, want verdict, want opensAt
    ['no window / no cooling', { kind: 'now' } as Schedule, undefined, '2026-01-01T00:00:00Z', 'NO_WINDOW', undefined],
    ['before window', windowed(wStart, wEnd), undefined, '2026-07-12T17:00:00Z', 'BEFORE_WINDOW', wStart],
    ['at start boundary is in-window', windowed(wStart, wEnd), undefined, wStart, 'IN_WINDOW', undefined],
    ['inside window', windowed(wStart, wEnd), undefined, '2026-07-12T19:30:00Z', 'IN_WINDOW', undefined],
    ['at end boundary is expired', windowed(wStart, wEnd), undefined, wEnd, 'WINDOW_EXPIRED', undefined],
    ['after window is expired', windowed(wStart, wEnd), undefined, '2026-07-12T23:00:00Z', 'WINDOW_EXPIRED', undefined],
    ['cooling not met, no window', { kind: 'now' } as Schedule, '2026-07-11T06:00:00Z', '2026-07-11T05:00:00Z', 'BEFORE_WINDOW', '2026-07-11T06:00:00Z'],
    ['cooling met at boundary, no window', { kind: 'now' } as Schedule, '2026-07-11T06:00:00Z', '2026-07-11T06:00:00Z', 'NO_WINDOW', undefined],
    ['cooling met, no window', { kind: 'now' } as Schedule, '2026-07-11T06:00:00Z', '2026-07-11T07:00:00Z', 'NO_WINDOW', undefined],
    ['in window but cooling not met', windowed(wStart, wEnd), '2026-07-12T19:00:00Z', '2026-07-12T18:30:00Z', 'BEFORE_WINDOW', '2026-07-12T19:00:00Z'],
    ['in window and cooling met', windowed(wStart, wEnd), '2026-07-12T19:00:00Z', '2026-07-12T19:00:00Z', 'IN_WINDOW', undefined],
    ['before both: opens_at is the later (cooling)', windowed(wStart, wEnd), '2026-07-12T19:00:00Z', '2026-07-12T17:00:00Z', 'BEFORE_WINDOW', '2026-07-12T19:00:00Z'],
    ['expiry beats cooling (both would refuse)', windowed(wStart, wEnd), '2026-07-12T19:00:00Z', '2026-07-12T22:30:00Z', 'WINDOW_EXPIRED', undefined],
    ['cooling after window end, still before end', windowed(wStart, wEnd), '2026-07-13T00:00:00Z', '2026-07-12T19:00:00Z', 'BEFORE_WINDOW', '2026-07-13T00:00:00Z'],
    ['cooling after window end, now past end', windowed(wStart, wEnd), '2026-07-13T00:00:00Z', '2026-07-12T22:30:00Z', 'WINDOW_EXPIRED', undefined],
    ['garbled window start', { kind: 'window', at: 'nope', endAt: wEnd } as Schedule, undefined, '2026-07-12T19:00:00Z', 'SCHEDULE_INVALID', undefined],
    ['start not before end', windowed(wEnd, wStart), undefined, '2026-07-12T19:00:00Z', 'SCHEDULE_INVALID', undefined],
    ['garbled earliest', { kind: 'now' } as Schedule, 'soon', '2026-07-12T19:00:00Z', 'SCHEDULE_INVALID', undefined],
  ] as const)('%s', (_name, schedule, earliestApplyAt, now, wantVerdict, wantOpens) => {
    const res = evaluateTime(schedule, earliestApplyAt, ms(now));
    expect(res.verdict).toBe(wantVerdict);
    // opensAt is always renormalized through toISOString() (V6-style — see
    // evaluateTime's doc comment), so compare by INSTANT, not exact string: Go's
    // RFC3339 renderer drops the (always-zero, in these fixtures) fractional
    // seconds JS's toISOString() always includes — a harmless, expected format
    // difference the live parity test (scheduleWindowCheckParity.test.ts)
    // deliberately does not assert on, comparing only the verdict token + exit code.
    if (wantOpens !== undefined) expect(Date.parse(res.opensAt!)).toBe(Date.parse(wantOpens));
  });

  it('opens_at is the later of cooling/start even when window is entirely in the future', () => {
    // earliest (19:00) < start (2026-07-13 00:00) here — start should win.
    const res = evaluateTime(windowed('2026-07-13T00:00:00Z', '2026-07-13T02:00:00Z'), '2026-07-12T19:00:00Z', ms('2026-07-12T12:00:00Z'));
    expect(res.verdict).toBe('BEFORE_WINDOW');
    expect(Date.parse(res.opensAt!)).toBe(ms('2026-07-13T00:00:00Z'));
  });
});

describe('applyGate — the SPA-facing gate: FROZEN composed, COOLING/BEFORE_WINDOW never short-circuited', () => {
  const NOW = ms('2026-07-12T12:00:00.000Z');

  it('kind "now", no earliestApplyAt, not frozen: clear, no reasons', () => {
    expect(applyGate({ schedule: { kind: 'now' }, earliestApplyAt: undefined }, false, NOW)).toEqual({ clear: true, reasons: [] });
  });

  it('kind "now", frozen: FROZEN alone, no opensAt', () => {
    expect(applyGate({ schedule: { kind: 'now' }, earliestApplyAt: undefined }, true, NOW)).toEqual({ clear: false, reasons: ['FROZEN'] });
  });

  it('kind "now", cooling active: COOLING with opensAt = earliestApplyAt', () => {
    const earliestApplyAt = new Date(NOW + 3600_000).toISOString();
    expect(applyGate({ schedule: { kind: 'now' }, earliestApplyAt }, false, NOW)).toEqual({
      clear: false,
      reasons: ['COOLING'],
      opensAt: earliestApplyAt,
    });
  });

  it('kind "now", frozen AND cooling: BOTH reported (never short-circuited)', () => {
    const earliestApplyAt = new Date(NOW + 3600_000).toISOString();
    const v = applyGate({ schedule: { kind: 'now' }, earliestApplyAt }, true, NOW);
    expect(v.clear).toBe(false);
    expect(v.reasons).toEqual(['FROZEN', 'COOLING']);
    expect(v.opensAt).toBe(earliestApplyAt);
  });

  it('kind "now", earliestApplyAt garbled: SCHEDULE_INVALID (fail closed, E9)', () => {
    expect(applyGate({ schedule: { kind: 'now' }, earliestApplyAt: 'soon' }, false, NOW)).toEqual({
      clear: false,
      reasons: ['SCHEDULE_INVALID'],
    });
  });

  it('kind "window", before start, no cooling: BEFORE_WINDOW with opensAt = start', () => {
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 3600_000 + DEFAULT_WINDOW_MS).toISOString();
    expect(applyGate({ schedule: { kind: 'window', at, endAt }, earliestApplyAt: undefined }, false, NOW)).toEqual({
      clear: false,
      reasons: ['BEFORE_WINDOW'],
      opensAt: at,
    });
  });

  it('kind "window", in window, no cooling: clear', () => {
    const at = new Date(NOW - 3600_000).toISOString();
    const endAt = new Date(NOW + 3600_000).toISOString();
    expect(applyGate({ schedule: { kind: 'window', at, endAt }, earliestApplyAt: undefined }, false, NOW)).toEqual({
      clear: true,
      reasons: [],
    });
  });

  it('kind "window", in window, frozen: FROZEN alone (window itself is open)', () => {
    const at = new Date(NOW - 3600_000).toISOString();
    const endAt = new Date(NOW + 3600_000).toISOString();
    expect(applyGate({ schedule: { kind: 'window', at, endAt }, earliestApplyAt: undefined }, true, NOW)).toEqual({
      clear: false,
      reasons: ['FROZEN'],
    });
  });

  it('kind "window", cooling AND before-start BOTH shut: both reported, opensAt is the later', () => {
    const at = new Date(NOW + 2 * 3600_000).toISOString(); // window opens in 2h
    const endAt = new Date(NOW + 4 * 3600_000).toISOString();
    const earliestApplyAt = new Date(NOW + 3 * 3600_000).toISOString(); // cooling ends in 3h — LATER than start
    const v = applyGate({ schedule: { kind: 'window', at, endAt }, earliestApplyAt }, false, NOW);
    expect(v.clear).toBe(false);
    expect(v.reasons).toEqual(['COOLING', 'BEFORE_WINDOW']);
    expect(v.opensAt).toBe(earliestApplyAt); // later of (earliest, start)
  });

  it('kind "window", cooling ends before start opens: opensAt is still the later (start)', () => {
    const earliestApplyAt = new Date(NOW + 1 * 3600_000).toISOString(); // cooling ends in 1h
    const at = new Date(NOW + 2 * 3600_000).toISOString(); // window opens in 2h — LATER
    const endAt = new Date(NOW + 4 * 3600_000).toISOString();
    const v = applyGate({ schedule: { kind: 'window', at, endAt }, earliestApplyAt }, false, NOW);
    expect(v.clear).toBe(false);
    expect(v.reasons).toEqual(['COOLING', 'BEFORE_WINDOW']);
    expect(v.opensAt).toBe(at);
  });

  it('kind "window", expired: WINDOW_EXPIRED ALONE — never joined by COOLING even if cooling also unmet (expiry precedes cooling)', () => {
    const at = new Date(NOW - 4 * 3600_000).toISOString();
    const endAt = new Date(NOW - 3600_000).toISOString(); // already closed
    const earliestApplyAt = new Date(NOW + 3600_000).toISOString(); // cooling ALSO still not met
    const v = applyGate({ schedule: { kind: 'window', at, endAt }, earliestApplyAt }, false, NOW);
    expect(v).toEqual({ clear: false, reasons: ['WINDOW_EXPIRED'] });
  });

  it('kind "window", expired AND frozen: both WINDOW_EXPIRED and FROZEN reported (freeze never masks expiry, §0.2)', () => {
    const at = new Date(NOW - 4 * 3600_000).toISOString();
    const endAt = new Date(NOW - 3600_000).toISOString();
    const v = applyGate({ schedule: { kind: 'window', at, endAt }, earliestApplyAt: undefined }, true, NOW);
    expect(v.reasons).toEqual(['FROZEN', 'WINDOW_EXPIRED']);
    expect(v.clear).toBe(false);
  });

  it('kind "window", malformed (start >= end): SCHEDULE_INVALID', () => {
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW - 3600_000).toISOString();
    expect(applyGate({ schedule: { kind: 'window', at, endAt }, earliestApplyAt: undefined }, false, NOW)).toEqual({
      clear: false,
      reasons: ['SCHEDULE_INVALID'],
    });
  });
});

describe('isWindowInfeasible — 0024 §2.2 row 4 / E10 eager check', () => {
  const NOW = ms('2026-07-12T12:00:00.000Z');

  it('kind "now": never infeasible (no window to miss)', () => {
    expect(isWindowInfeasible({ kind: 'now' }, new Date(NOW + 1000).toISOString(), NOW)).toBe(false);
  });

  it('cooling ends comfortably before window end: feasible', () => {
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 4 * 3600_000).toISOString();
    const earliestApplyAt = new Date(NOW + 2 * 3600_000).toISOString();
    expect(isWindowInfeasible({ kind: 'window', at, endAt }, earliestApplyAt, NOW)).toBe(false);
  });

  it('E10: cooling ends AFTER window end — infeasible the instant it is created', () => {
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 4 * 3600_000).toISOString();
    const earliestApplyAt = new Date(NOW + 5 * 3600_000).toISOString(); // after endAt
    expect(isWindowInfeasible({ kind: 'window', at, endAt }, earliestApplyAt, NOW)).toBe(true);
  });

  it('cooling ends exactly at window end — infeasible (no instant satisfies BOTH t>=earliest AND t<end)', () => {
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 4 * 3600_000).toISOString();
    expect(isWindowInfeasible({ kind: 'window', at, endAt }, endAt, NOW)).toBe(true);
  });

  it('no cooling at all, window already wholly past: infeasible (slow non-interim quorum)', () => {
    const at = new Date(NOW - 4 * 3600_000).toISOString();
    const endAt = new Date(NOW - 3600_000).toISOString();
    expect(isWindowInfeasible({ kind: 'window', at, endAt }, undefined, NOW)).toBe(true);
  });

  it('window still open, no cooling: feasible', () => {
    const at = new Date(NOW - 3600_000).toISOString();
    const endAt = new Date(NOW + 3600_000).toISOString();
    expect(isWindowInfeasible({ kind: 'window', at, endAt }, undefined, NOW)).toBe(false);
  });

  it('malformed window: not infeasible here — SCHEDULE_INVALID is applyGate/validateSchedule\'s job', () => {
    expect(isWindowInfeasible({ kind: 'window', at: 'garbage' }, undefined, NOW)).toBe(false);
  });
});
