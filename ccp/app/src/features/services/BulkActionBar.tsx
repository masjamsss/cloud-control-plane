import { useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ManifestOperation } from '@/types';
import { bulkHref } from '@/lib/bulkRoute';
import { Button } from '@/components/ui/Button';
import './console.css';

export interface BulkActionBarProps {
  serviceSlug: string;
  /** The addresses currently selected in the list. */
  selectedAddresses: string[];
  /** The distinct resource types across the selection — a bulk action applies to exactly ONE. */
  selectedTypes: string[];
  /** The bulk-eligible actions common to the selection (already forces-replace-filtered);
   * empty when the selection spans more than one resource type. */
  actions: ManifestOperation[];
  /** Clear the whole selection. */
  onClear: () => void;
}

/**
 * The bulk-action bar (Phase B): once resources are multi-selected in the list, this pinned
 * bar states how many are selected and offers ONE action to apply to ALL of them — building
 * a change set (one op × N targets) that goes through the SAME review + submit as any other.
 *
 * A bulk action is inherently per-resource-type (an op targets one resource type), so the
 * bar only offers actions when the selection is a SINGLE type; a mixed selection gets an
 * honest note instead of a broken action list. Forces-replace ops are excluded upstream
 * (isBulkableAction) — a destroy+recreate needs its own typed confirmation per target and
 * stays on the single-resource path.
 */
export function BulkActionBar({
  serviceSlug,
  selectedAddresses,
  selectedTypes,
  actions,
  onClear,
}: BulkActionBarProps): JSX.Element | null {
  const navigate = useNavigate();
  const [chosen, setChosen] = useState('');

  if (selectedAddresses.length === 0) return null;

  const n = selectedAddresses.length;
  const multiType = selectedTypes.length > 1;
  const chosenOp = actions.find((op) => op.id === chosen);

  const apply = (): void => {
    if (!chosenOp) return;
    navigate(bulkHref(serviceSlug, chosenOp.id, selectedAddresses));
  };

  return (
    <div className="bulkbar" role="region" aria-label="Bulk actions">
      <div className="bulkbar__count">
        <strong>{n}</strong> selected
      </div>

      {multiType ? (
        <p className="bulkbar__note">
          Selected resources span more than one type. A bulk action applies to a single resource
          type — narrow the selection to one type to continue.
        </p>
      ) : actions.length === 0 ? (
        <p className="bulkbar__note">No bulk-eligible action for this resource type.</p>
      ) : (
        <div className="bulkbar__pick">
          <label className="bulkbar__label" htmlFor="bulkbar-action">
            Apply to all {n}:
          </label>
          <select
            id="bulkbar-action"
            className="bulkbar__select"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            <option value="">Choose an action…</option>
            {actions.map((op) => (
              <option key={op.id} value={op.id}>
                {op.title}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={!chosenOp} onClick={apply}>
            Review bulk change
          </Button>
        </div>
      )}

      <button type="button" className="bulkbar__clear" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

export default BulkActionBar;
