import type { JSX } from 'react';
import './console.css';

/**
 * Service-page orientation. Every service console opens
 * with one line that says what the page is and what to do next — the owner's
 * acceptance: an operator who has never seen the control plane can state the next step
 * unprompted. One component, rendered above "Your resources" on every
 * service page (there is exactly one ServiceConsole for all services, so
 * mounting it there covers the whole catalog). Static copy, no props — the
 * three facts it states (pick a resource, use its Actions menu, review is
 * the gate) hold for every service by construction.
 */
export function OrientationNote(): JSX.Element {
  return (
    <p className="console__orientation">
      Pick a resource below, then choose an action from its Actions menu. Changes go to review
      before anything is applied.
    </p>
  );
}

export default OrientationNote;
