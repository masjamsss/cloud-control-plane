import type { JSX } from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import './route-error.css';

/**
 * The shared route errorElement. A thrown loader/render error renders this
 * friendly card instead of React Router's raw stack-trace page. Fail-soft: the
 * user always has a way back to the catalog.
 */
export function RouteError(): JSX.Element {
  const error = useRouteError();

  let title = 'Something went wrong';
  let detail = 'An unexpected error occurred while loading this page.';
  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    detail = typeof error.data === 'string' ? error.data : detail;
  } else if (error instanceof Error) {
    detail = error.message;
  }

  return (
    <div className="routeerr" role="alert">
      <div className="routeerr__content">
        <span className="routeerr__badge" aria-hidden="true">
          Error
        </span>
        <h1 className="routeerr__title">{title}</h1>
        <p className="routeerr__detail">{detail}</p>
        <Link className="routeerr__link" to="/">
          ← Back to catalog
        </Link>
      </div>
    </div>
  );
}

export default RouteError;
