import type { JSX } from 'react';
import './route-skeleton.css';

/** Suspense fallback for lazily-loaded routes — a calm, layout-shaped shimmer.
 * Roughly traces the Ledger shape most routes land in (Home's numbered
 * section rail beside divider rows), not a card grid. */
export function RouteSkeleton(): JSX.Element {
  return (
    <div className="rskel" aria-hidden="true">
      <div className="rskel__title" />
      <div className="rskel__section">
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
