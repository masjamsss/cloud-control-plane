import type { JSX } from 'react';
import './route-skeleton.css';

/**
 * Suspense fallback for lazily-loaded routes — a calm, layout-shaped shimmer.
 * Roughly traces the Ledger shape most routes land in (Home's numbered
 * section rail beside divider rows), not a card grid.
 *
 * UI-12 — the shimmer bars were `aria-hidden="true"` on the whole container:
 * correct for the decorative bars themselves (there is nothing for a screen
 * reader to read off an empty gradient div), but it hid the ENTIRE loading
 * state, so assistive tech got no signal a route was loading at all — just
 * silence, then the page. `role="status"` + `aria-busy="true"` (a live
 * region with an implicit polite announcement) plus a visually-hidden
 * "Loading…" text fixes that; the shimmer bars keep their own
 * `aria-hidden="true"` since they're still purely decorative.
 */
export function RouteSkeleton(): JSX.Element {
  return (
    <div className="rskel" role="status" aria-busy="true">
      <span className="rskel__sr-only">Loading…</span>
      <div className="rskel__title" aria-hidden="true" />
      <div className="rskel__section" aria-hidden="true">
        <div className="rskel__rail" />
        <div className="rskel__rows">
          <div className="rskel__row" />
          <div className="rskel__row" />
          <div className="rskel__row rskel__row--short" />
        </div>
      </div>
    </div>
  );
}

export default RouteSkeleton;
