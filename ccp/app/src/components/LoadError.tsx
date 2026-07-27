import type { JSX } from 'react';
import { Button } from '@/components/ui/Button';
import './LoadError.css';

export interface LoadErrorProps {
  /** The reason to show — a server-authored one where there is one, else
   * `asyncGuard.NETWORK_FAILURE_MESSAGE`. */
  message: string;
  /** Re-runs the failed load. Omitted only where nothing can be retried. */
  onRetry?: () => void;
  /** What failed to load, e.g. "your requests". Read into the heading so a
   * screen-reader user hears WHICH pane is broken when several share a page. */
  what?: string;
}

/**
 * The one rendered dead-end for a failed initial load (FE-2 / UI-1).
 *
 * Before this existed, every non-admin page cleared `loading` only inside
 * its success branch, so a rejected fetch left "Loading…" on screen for
 * ever with no message and no way back. The admin screens already showed an
 * error banner; what none of them had was the RETRY, which is the thing
 * that turns a transient blip into a non-event instead of a page reload.
 *
 * `role="alert"` (not `status`) on purpose: this replaces the content the
 * user came for, so it is assertive, matching how the admin surfaces
 * already announce a failed load.
 */
export function LoadError({ message, onRetry, what }: LoadErrorProps): JSX.Element {
  return (
    <div className="loaderr" role="alert">
      <p className="loaderr__title">{what ? `Could not load ${what}.` : 'Could not load this page.'}</p>
      <p className="loaderr__reason">{message}</p>
      {onRetry ? (
        <Button variant="ghost" className="loaderr__retry" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export default LoadError;
