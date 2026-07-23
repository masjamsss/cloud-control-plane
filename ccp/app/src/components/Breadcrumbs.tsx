import { Fragment } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import './Breadcrumbs.css';

export interface Crumb {
  label: string;
  to?: string;
}

export interface BreadcrumbsProps {
  items: Crumb[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps): JSX.Element {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol className="crumbs__list">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <Fragment key={i}>
              <li className="crumbs__item">
                {item.to && !isLast ? (
                  <Link className="crumbs__link" to={item.to}>
                    {item.label}
                  </Link>
                ) : (
                  <span
                    className="crumbs__current"
                    aria-current={isLast ? 'page' : undefined}
                  >
                    {item.label}
                  </span>
                )}
              </li>
              {!isLast && (
                <li className="crumbs__sep" aria-hidden="true">
                  ›
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumbs;
