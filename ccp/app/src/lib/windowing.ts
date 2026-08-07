/**
 * PERF-15 — bound how many rows a request-history view actually renders, so an
 * estate with thousands of change requests doesn't force the browser to lay out
 * one DOM node per row/card on every load and every re-sort. Location cited by
 * the finding: `MyRequests.tsx` (lane lists), `ApprovalsQueue.tsx` (queue
 * cards), `LeadDashboard.tsx` (the all-requests table) — all three map an
 * unbounded array straight into JSX with no cap.
 *
 * Deliberately simple, TESTABLE windowing (cap + "Show more"), not
 * `VirtualRows`-style virtualization — the finding's own text offers both as
 * alternatives ("windowing (or VirtualRows-style virtualization, already in the
 * codebase)"). `VirtualRows.tsx` is tightly coupled to service-console-specific
 * row types, is not a drop-in for a grouped lane list or a `<table>`, and has
 * ZERO test coverage today: this repo ships no `@testing-library/react` and no
 * jsdom/happy-dom test environment (see `package.json` devDependencies, and the
 * separate finding TEST-7 tracking that gap), so a `useVirtualizer`-based
 * rewrite of these three screens could not be regression-tested at all here. The
 * slicing law below is pure and fully covered instead.
 *
 * `windowSlice` is the ONE shared implementation all three screens apply
 * identically, each keeping its own "how many are currently shown" state
 * (per-lane for MyRequests, one counter for ApprovalsQueue/LeadDashboard) and
 * resetting it to `DEFAULT_WINDOW_SIZE` whenever its own filters change — so a
 * new filter always starts windowed again rather than staying pinned open at
 * whatever count a previous, larger result set had reached.
 */
export const DEFAULT_WINDOW_SIZE = 50;

export interface WindowedSlice<T> {
  /** The items to actually render right now. */
  visible: T[];
  /** How many items past `visible` are being held back. */
  hiddenCount: number;
}

/** Pure: the first `size` items of `items`, and how many remain. `size` is
 * clamped to at least 1 so a caller can never end up rendering nothing at all. */
export function windowSlice<T>(items: readonly T[], size: number): WindowedSlice<T> {
  const clamped = Math.max(1, size);
  const visible = items.slice(0, clamped);
  return { visible, hiddenCount: Math.max(0, items.length - visible.length) };
}
