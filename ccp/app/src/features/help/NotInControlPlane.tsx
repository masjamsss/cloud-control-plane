import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { boundaryItems } from '@/lib/boundary';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { getInstanceIdentity } from '@/lib/instanceIdentity';
import './boundary.css';

/**
 * The out-of-tool boundary page: the
 * honest answer for ticket work that is real but is not a Terraform change.
 * Static content over lib/boundary.ts — the same items the command palette
 * indexes, so searching "reboot" lands here instead of on nothing. Kept
 * deliberately small: name the boundary, point at the runbook or console
 * path, offer the nearest thing the control plane does do, stop.
 */
export function NotInControlPlane(): JSX.Element {
  const identity = getInstanceIdentity();
  return (
    <div className="boundary">
      <Breadcrumbs items={[{ label: 'Catalog', to: '/' }, { label: 'Not in the Control Plane' }]} />

      <header className="boundary__head">
        <h1 className="boundary__title">Work that lives outside {identity.name}</h1>
        <p className="boundary__sub">
          Some tickets are real work but not infrastructure-definition changes, so {identity.name} never
          pretends to run them. Here is where each one actually happens.
        </p>
      </header>

      <ul className="boundary__list">
        {boundaryItems().map((item) => (
          <li className="boundary__item" key={item.id}>
            <h2 className="boundary__item-title">{item.title}</h2>
            <p className="boundary__item-why">{item.why}</p>
            <p className="boundary__item-where">{item.where}</p>
            {item.nearest && (
              <Link className="boundary__item-nearest" to={item.nearest.to}>
                {item.nearest.label}
              </Link>
            )}
          </li>
        ))}
      </ul>

      <footer className="boundary__foot">
        <p className="boundary__foot-note">
          Anything else that does end in an infrastructure change but is not in the catalog can
          still be requested — it routes to an engineer with the same approvals as everything else.
        </p>
        <Link className="boundary__foot-link" to="/services/request-new">
          Request something new
        </Link>
      </footer>
    </div>
  );
}

export default NotInControlPlane;
