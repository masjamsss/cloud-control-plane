import type { JSX } from 'react';
import type { RequestStatus } from '@/types';
import { STATUS_SPEC } from '@/lib/statusCopy';
import './ui.css';

export interface StatusBadgeProps {
  status: RequestStatus;
}

// UI-10: the tone/label table (and the requestStatusLabel() helper other consumers use)
// moved to lib/statusCopy.ts — lib/palette.ts needs the same mapping, and lib/ importing
// FROM a component file would be the wrong direction. This component reads it, not owns it.

/**
 * Request lifecycle chip: an 8px dot + label. The dot carries the tone —
 * APPLIED/NOOP low, failures/REJECTED high, awaiting/changes med, in-flight
 * info, draft/withdrawn muted — so status never blurs into the Risk axis.
 */
export function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  const spec = STATUS_SPEC[status];
  return (
    <span className={`status-badge status-badge--${spec.tone}`} title={status}>
      <span className="status-badge__dot" aria-hidden="true" />
      {spec.label}
    </span>
  );
}
