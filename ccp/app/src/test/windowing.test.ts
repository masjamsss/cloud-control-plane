import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_SIZE, windowSlice } from '@/lib/windowing';

/**
 * PERF-15 — the pure slicing law MyRequests' lanes, ApprovalsQueue's queue and
 * LeadDashboard's table all apply identically. `visible`/`hiddenCount` are what
 * every "Show more" affordance reads, so an off-by-one here would either hide
 * the last item behind a "Show more" that adds nothing, or show one too many.
 */
describe('windowSlice', () => {
  it('returns at most `size` items when the list is longer, with the exact overflow as hiddenCount', () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    const { visible, hiddenCount } = windowSlice(items, 50);
    expect(visible.length).toBe(50);
    expect(visible).toEqual(items.slice(0, 50));
    expect(hiddenCount).toBe(70);
  });

  it('returns everything, with hiddenCount 0, when the list is shorter than the window', () => {
    const items = [1, 2, 3];
    const { visible, hiddenCount } = windowSlice(items, DEFAULT_WINDOW_SIZE);
    expect(visible).toEqual(items);
    expect(hiddenCount).toBe(0);
  });

  it('a list exactly at the window size has hiddenCount 0, not an off-by-one', () => {
    const items = Array.from({ length: DEFAULT_WINDOW_SIZE }, (_, i) => i);
    const { visible, hiddenCount } = windowSlice(items, DEFAULT_WINDOW_SIZE);
    expect(visible.length).toBe(DEFAULT_WINDOW_SIZE);
    expect(hiddenCount).toBe(0);
  });

  it('an empty list is untouched', () => {
    expect(windowSlice([], DEFAULT_WINDOW_SIZE)).toEqual({ visible: [], hiddenCount: 0 });
  });

  it('clamps a non-positive size to at least 1 item rather than rendering nothing at all', () => {
    const items = [1, 2, 3];
    expect(windowSlice(items, 0).visible).toEqual([1]);
    expect(windowSlice(items, -5).visible).toEqual([1]);
  });

  it('DEFAULT_WINDOW_SIZE is a real positive size, not an unused placeholder', () => {
    expect(DEFAULT_WINDOW_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_WINDOW_SIZE)).toBe(true);
  });
});
