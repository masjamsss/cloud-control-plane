import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import './route-error.css';

/** Styled 404 for unmatched routes — rendered inside the app shell. */
export function NotFound(): JSX.Element {
  return (
    <div className="routeerr">
      <div className="routeerr__content">
        <span className="routeerr__badge" aria-hidden="true">
          404
        </span>
        <h1 className="routeerr__title">Page not found</h1>
        <p className="routeerr__detail">
          That page doesn’t exist. It may have moved, or the link was mistyped.
        </p>
        <Link className="routeerr__link" to="/">
          ← Back to catalog
        </Link>
      </div>
    </div>
  );
}

export default NotFound;
