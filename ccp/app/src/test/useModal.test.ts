import { describe, expect, it } from 'vitest';
import { tabTrapTarget } from '@/lib/useModal';

/**
 * UI-6 — `tabTrapTarget` is the pure decision core of `useModal`'s Tab-cycle
 * trap, extracted specifically so it can be unit-tested without a DOM (this
 * repo has no jsdom/happy-dom or @testing-library/react — see TEST-7). The
 * DOM-touching parts of `useModal` itself (actual focus movement, the
 * keydown listener, focus restoration on close) are exercised only
 * indirectly, via the existing SSR/markup tests on each dialog's rendered
 * output (`accountSecurityUi.test.tsx`, `driftProposalUi.test.tsx`,
 * `driftResolutionFlow.test.tsx`, `unmanagedResources.test.tsx`,
 * `driftPanel.test.tsx`) — those confirm the `role="dialog"`/`aria-modal`/
 * `tabIndex={-1}` wiring is present on every drawer, not the runtime
 * focus-trap behavior itself. That is a stated scope boundary, not an
 * oversight: same gap TEST-7 already documents for the rest of this app's
 * interactive components.
 */
describe('tabTrapTarget (UI-6)', () => {
  it('no focusable items: always null (caller suppresses Tab unconditionally instead)', () => {
    expect(tabTrapTarget(0, null, false)).toBeNull();
    expect(tabTrapTarget(0, null, true)).toBeNull();
  });

  it('single item: it is simultaneously first and last, so Tab/Shift+Tab redirect back to it either way', () => {
    expect(tabTrapTarget(1, 0, false)).toBe('first');
    expect(tabTrapTarget(1, 0, true)).toBe('last');
  });

  it('Tab from the last item wraps to the first', () => {
    expect(tabTrapTarget(3, 2, false)).toBe('first');
  });

  it('Shift+Tab from the first item wraps to the last', () => {
    expect(tabTrapTarget(3, 0, true)).toBe('last');
  });

  it('Tab from a middle item is left alone (default browser behavior)', () => {
    expect(tabTrapTarget(3, 1, false)).toBeNull();
    expect(tabTrapTarget(3, 1, true)).toBeNull();
  });

  it('focus outside the container (escaped, or nothing focused): Tab pulls it back to the first item', () => {
    expect(tabTrapTarget(3, null, false)).toBe('first');
  });

  it('focus outside the container: Shift+Tab pulls it back to the last item', () => {
    expect(tabTrapTarget(3, null, true)).toBe('last');
  });

  it("focus inside the container but not one of the items (e.g. the container's own tabIndex={-1} fallback): left alone", () => {
    // -1 is neither index 0 nor itemCount-1 for any itemCount >= 1 — it must
    // fall through exactly like a middle item, not be treated as "outside".
    expect(tabTrapTarget(3, -1, false)).toBeNull();
    expect(tabTrapTarget(3, -1, true)).toBeNull();
  });

  it('two items: only the boundary-crossing direction from each item redirects, the other is left alone', () => {
    expect(tabTrapTarget(2, 0, false)).toBeNull(); // Tab from item 0 -> item 1, default behavior
    expect(tabTrapTarget(2, 1, false)).toBe('first'); // Tab from item 1 (last) wraps to item 0
    expect(tabTrapTarget(2, 1, true)).toBeNull(); // Shift+Tab from item 1 -> item 0, default behavior
    expect(tabTrapTarget(2, 0, true)).toBe('last'); // Shift+Tab from item 0 (first) wraps to item 1
  });
});
