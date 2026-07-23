import { describe, expect, it } from 'vitest';
import { BASELINE_STALE_DAYS, formatVintage, vintageAge } from '@/features/services/ServiceConsole';
import { projectCalendarAgeDays } from '@/lib/datetime';
import type { Inventory } from '@/types';

/**
 * 0027 P2-3: ServiceConsole.tsx:192 used to read "Live from the Terraform
 * baseline" for a build-time snapshot that once sat five days stale and
 * undetected (0027 §1.2) — an unqualified "live" is banned for snapshot data
 * (0027 §4 invariant 5). formatVintage is the fix's testable surface: it can
 * only ever claim the bundle's own capture vintage, never present-tense
 * currency.
 */
function inventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    generatedAt: '2026-07-12T21:08:56+07:00',
    sourceCommit: '5f69bac800ff4b760cca0f84cd35150cf2e21f11',
    source: 'environments/prod/*.tf (baseline capture, account 123456789012)',
    resources: [],
    ...overrides,
  };
}

describe('ServiceConsole formatVintage', () => {
  it('never says "live" anywhere in the label (0027 §4 invariant 5)', () => {
    const label = formatVintage(inventory());
    expect(label.toLowerCase()).not.toContain('live');
  });

  it('renders "Baseline as of <generatedAt> · <sourceCommit·7>" when both are present', () => {
    expect(formatVintage(inventory())).toBe('Baseline as of 2026-07-12T21:08:56+07:00 · 5f69bac');
  });

  it('drops the short SHA when sourceCommit is absent, but still states the date', () => {
    expect(formatVintage(inventory({ sourceCommit: undefined }))).toBe(
      'Baseline as of 2026-07-12T21:08:56+07:00',
    );
  });

  it('never fabricates a vintage: a null generatedAt (non-git root) says so honestly, not "Live"', () => {
    const label = formatVintage(inventory({ generatedAt: null, sourceCommit: null }));
    expect(label).toBe('Baseline (vintage unknown — not built from a git checkout)');
  });
});

/**
 * 0034 W1 age chips: the vintage line gains a relative-age chip, computed at
 * render time (no timers — the cooling panel's standing doctrine) and counted
 * on the PROJECT's calendar (JST for the bundled sample project), not the
 * viewer's. Warning tone starts at BASELINE_STALE_DAYS — the five-days-stale
 * incident measure the vintage line itself was born from (0027 §1.2).
 */
describe('projectCalendarAgeDays — day arithmetic on the project calendar (JST here)', () => {
  it('counts calendar days, not 24h blocks: 23:30 JST → 01:00 JST next day is 1 day', () => {
    expect(
      projectCalendarAgeDays('2026-07-13T23:30:00+09:00', new Date('2026-07-14T01:00:00+09:00')),
    ).toBe(1);
  });

  it('uses the JST date, not the UTC date: late-evening UTC is already "tomorrow" in Tokyo', () => {
    // 2026-07-13T18:00Z = 2026-07-14 03:00 JST; 2026-07-14T03:00Z = 12:00 JST the same day.
    // In UTC the dates differ (13th vs 14th) — in JST they do not.
    expect(
      projectCalendarAgeDays('2026-07-13T18:00:00Z', new Date('2026-07-14T03:00:00Z')),
    ).toBe(0);
  });

  it('clamps a future-dated (clock-skew) timestamp to 0, never a negative age', () => {
    expect(
      projectCalendarAgeDays('2026-07-16T00:00:00+09:00', new Date('2026-07-14T12:00:00+09:00')),
    ).toBe(0);
  });

  it('missing or invalid input yields null, never a fabricated age', () => {
    expect(projectCalendarAgeDays(undefined, new Date())).toBeNull();
    expect(projectCalendarAgeDays('not-a-date', new Date())).toBeNull();
  });
});

describe('vintageAge — the relative-age chip next to "Baseline as of …"', () => {
  const at = (now: string) => vintageAge(inventory(), new Date(now));

  it('same JST day reads "updated today", calm tone', () => {
    expect(at('2026-07-12T23:59:00+09:00')).toEqual({ label: 'updated today', stale: false });
  });

  it('one day reads "1 day old" (singular), calm tone', () => {
    expect(at('2026-07-13T08:00:00+09:00')).toEqual({ label: '1 day old', stale: false });
  });

  it('below the threshold stays calm ("4 days old")', () => {
    expect(at('2026-07-16T08:00:00+09:00')).toEqual({ label: '4 days old', stale: false });
  });

  it(`at the threshold (${BASELINE_STALE_DAYS} days — the incident measure) it turns warning-toned`, () => {
    expect(at('2026-07-17T08:00:00+09:00')).toEqual({ label: '5 days old', stale: true });
    expect(BASELINE_STALE_DAYS).toBe(5);
  });

  it('an unknown vintage renders NO chip — the line already states the truth, a chip must not invent one', () => {
    expect(vintageAge(inventory({ generatedAt: null }), new Date())).toBeNull();
  });
});
