import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Schedule } from '@/types';
import {
  DEFAULT_WINDOW_MS,
  MAX_HORIZON_MS,
  MAX_WINDOW_MS,
  MIN_LEAD_MS,
  SchedulePicker,
  defaultWindowAt,
  isoToLocalInput,
  localInputToIso,
  scheduleError,
} from '@/features/request/SchedulePicker';

/**
 * 0024 §2.1/§4.1 — the SPA's V2-V5 mirror + the past-instant footgun fix.
 * `scheduleError`/`defaultWindowAt`/the local<->ISO helpers are pure (tested
 * directly, no render); the component itself gets a render-shape pass via
 * renderToStaticMarkup (no jsdom in this repo — test/standalone.test.ts's
 * exact dependency allowlist), the same pattern requestDetail.test.ts uses
 * for CoolingPanel/WindowPanel.
 */

describe('defaultWindowAt — kills the past-instant footgun default', () => {
  it('is always at least MIN_LEAD_MS out', () => {
    const now = Date.parse('2026-07-12T12:07:00.000Z');
    const at = defaultWindowAt(now);
    expect(Date.parse(at) - now).toBeGreaterThanOrEqual(MIN_LEAD_MS);
  });

  it('lands on a clean half-hour boundary', () => {
    const now = Date.parse('2026-07-12T12:07:00.000Z');
    const at = new Date(defaultWindowAt(now));
    expect(at.getUTCMinutes() % 30).toBe(0);
    expect(at.getUTCSeconds()).toBe(0);
  });

  it('when now+MIN_LEAD already lands exactly on a boundary, does not push an extra 30m out', () => {
    const now = Date.parse('2026-07-12T12:00:00.000Z'); // +30min = 12:30, already a boundary
    const at = defaultWindowAt(now);
    expect(at).toBe('2026-07-12T12:30:00.000Z');
  });
});

describe('scheduleError — the V2-V5 mirror (courtesy; the server is the enforcement)', () => {
  const NOW = Date.parse('2026-07-12T12:00:00.000Z');

  it('kind "now" never errors', () => {
    expect(scheduleError({ kind: 'now' }, NOW)).toBeUndefined();
  });

  it('an empty `at` errors — the picker\'s own old ONLY check, still covered', () => {
    expect(scheduleError({ kind: 'window', at: '' }, NOW)).toBe('Pick a date and time.');
  });

  it('a garbled `at` errors', () => {
    expect(scheduleError({ kind: 'window', at: 'banana' }, NOW)).toBe('Pick a valid date and time.');
  });

  it('V3: too soon errors, at the boundary is fine', () => {
    const tooSoon = new Date(NOW + MIN_LEAD_MS - 1000).toISOString();
    expect(scheduleError({ kind: 'window', at: tooSoon }, NOW)).toMatch(/30 minutes/);
    const exactly = new Date(NOW + MIN_LEAD_MS).toISOString();
    expect(scheduleError({ kind: 'window', at: exactly }, NOW)).toBeUndefined();
  });

  it('the picker\'s literal old default (at = now) is caught as too soon', () => {
    expect(scheduleError({ kind: 'window', at: new Date(NOW).toISOString() }, NOW)).toMatch(/30 minutes/);
  });

  it('V4: too far errors, at the boundary is fine', () => {
    const tooFar = new Date(NOW + MAX_HORIZON_MS + 1000).toISOString();
    expect(scheduleError({ kind: 'window', at: tooFar }, NOW)).toMatch(/90 days/);
    const exactly = new Date(NOW + MAX_HORIZON_MS).toISOString();
    expect(scheduleError({ kind: 'window', at: exactly }, NOW)).toBeUndefined();
  });

  it('V5: endAt at/before at errors', () => {
    const at = new Date(NOW + MIN_LEAD_MS).toISOString();
    expect(scheduleError({ kind: 'window', at, endAt: at }, NOW)).toMatch(/end after it starts/);
  });

  it('V5: endAt spanning more than 24h errors, exactly 24h is fine', () => {
    const at = new Date(NOW + MIN_LEAD_MS).toISOString();
    const tooLong = new Date(Date.parse(at) + MAX_WINDOW_MS + 1000).toISOString();
    expect(scheduleError({ kind: 'window', at, endAt: tooLong }, NOW)).toMatch(/24 hours/);
    const exactly24h = new Date(Date.parse(at) + MAX_WINDOW_MS).toISOString();
    expect(scheduleError({ kind: 'window', at, endAt: exactly24h }, NOW)).toBeUndefined();
  });

  it('no endAt at all is fine (server defaults it, V5)', () => {
    const at = new Date(NOW + MIN_LEAD_MS).toISOString();
    expect(scheduleError({ kind: 'window', at }, NOW)).toBeUndefined();
  });
});

describe('isoToLocalInput / localInputToIso — round-trip through the datetime-local value', () => {
  it('round-trips a UTC instant', () => {
    const iso = '2026-07-12T18:30:00.000Z';
    const local = isoToLocalInput(iso);
    expect(localInputToIso(local)).toBe(new Date(iso).toISOString());
  });

  it('localInputToIso(\'\') is undefined, not a throw', () => {
    expect(localInputToIso('')).toBeUndefined();
  });

  it('isoToLocalInput of a garbled string is empty, not a throw', () => {
    expect(isoToLocalInput('not-a-date')).toBe('');
  });
});

describe('SchedulePicker — render shape', () => {
  const noop = (): void => {};

  it('kind "now": the now option is checked, no date/duration inputs render', () => {
    const html = renderToStaticMarkup(React.createElement(SchedulePicker, { value: { kind: 'now' }, onChange: noop }));
    expect(html).toContain('Apply right after approval');
    expect(html).not.toContain('datetime-local');
  });

  it('kind "window" with a valid schedule: shows the datetime input, duration select (4h span pre-selected), and a preview', () => {
    const at = '2026-08-01T15:00:00.000Z';
    const endAt = new Date(Date.parse(at) + DEFAULT_WINDOW_MS).toISOString(); // exactly a 4h span
    const schedule: Schedule = { kind: 'window', at, endAt };
    const html = renderToStaticMarkup(React.createElement(SchedulePicker, { value: schedule, onChange: noop }));
    expect(html).toContain('datetime-local');
    expect(html).toContain('<select');
    expect(html).toContain('4 hours');
    expect(html).toContain(`value="${DEFAULT_WINDOW_MS}" selected`);
    expect(html).toMatch(/=.*→/); // the "= start → end" preview line
    expect(html).not.toContain('aria-invalid="true"');
  });

  it('kind "window" with an invalid (too-soon) schedule: shows the inline error, aria-invalid on the input', () => {
    const schedule: Schedule = { kind: 'window', at: new Date(Date.now() + 60_000).toISOString() };
    const html = renderToStaticMarkup(React.createElement(SchedulePicker, { value: schedule, onChange: noop }));
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/30 minutes/);
  });

  it('kind "window" with an empty `at`: no preview, no crash', () => {
    const schedule: Schedule = { kind: 'window', at: '' };
    const html = renderToStaticMarkup(React.createElement(SchedulePicker, { value: schedule, onChange: noop }));
    expect(html).toContain('datetime-local');
    expect(html).not.toMatch(/=.*→/);
  });
});
