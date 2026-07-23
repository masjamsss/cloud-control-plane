import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { InventoryResource, ManifestOperation } from '@/types';
import { MacdTag } from '@/components/ui/MacdTag';
import { actionHref, pinnedActions } from '@/lib/actionPicker';
import { displayResourceLabel, resourceChips } from '@/lib/chipLabel';
import type { ChildSummaryEntry } from '@/lib/resourceFamily';
import './console.css';

export interface ResourceRowProps {
  serviceSlug: string;
  resource: InventoryResource;
  /**
   * Every action scoped to this resource's type: its Change/Delete/Move ops
   * plus the Add ops that operate on it (snapshot it, add a rule, tag it).
   * The menu itself only ever renders the
   * ≤5 pinned "Common" subset directly — the rest (every danger-zone op, and
   * every resource-scoped Add, none of which is pinnable) is reachable only
   * through "All actions…", which opens the full grouped picker onto this
   * exact list. Never one-click for a dangerous op, always findable.
   */
  actions: ManifestOperation[];
  /**
   * Opens the scoped picker for this resource. Lifted to the service
   * console rather than owned per-row: VirtualRows can render hundreds of
   * ResourceRows at once, so there is ONE shared ActionPicker instance, not
   * one cmdk overlay per row.
   */
  onOpenPicker: (resource: InventoryResource, actions: ManifestOperation[]) => void;
  /**
   * Bulk multi-select (Phase B), OPTIONAL — when omitted the row renders exactly as before
   * (no checkbox). When present, a leading checkbox lets the operator pick this resource into
   * a bulk change set; `selected` reflects the console's selection state and `onToggle`
   * flips it. Lives OUTSIDE the row's Link (a checkbox must never nest in an anchor).
   */
  selection?: { selected: boolean; onToggle: (address: string) => void };
  /**
   * The config entries rolled up under this resource, aggregated per type
   * (lib/resourceFamily.ts) — rendered as one "Includes" line so the row
   * says what drilling in will show (policy, encryption, versioning…).
   * Optional and empty-safe: rows without rollups render exactly as before.
   */
  childSummary?: ChildSummaryEntry[];
}

/**
 * Presentational row for one inventory resource: its name, address, a few key
 * current settings, and a small menu of the actions available for its type
 * (change/delete/move, plus the Add ops scoped to it). The
 * menu itself is capped at the ≤5 pinned "Common" ops plus one
 * "All actions… (N)" item that
 * opens the full scoped picker — the flat, unbounded list this replaces
 * could run to 42 items (aws_dlm_lifecycle_policy) with no risk/exposure
 * shown at selection time.
 *
 * Humanized rendering: the primary label prefers the
 * friendly name and never shows a raw snake_case identifier (the exact
 * Terraform address keeps that role, one line below, in mono); the setting
 * chips render through the shared chipLabel map (labels + units, "Memory
 * 256 MB" not "memory_size 256"); ARN values show their meaningful tail with
 * the full ARN on hover. All pure lookups — see lib/chipLabel.ts.
 */
export function ResourceRow({
  serviceSlug,
  resource,
  actions,
  onOpenPicker,
  selection,
  childSummary,
}: ResourceRowProps): JSX.Element {
  const chips = resourceChips(resource);
  const displayName = displayResourceLabel(resource);
  const pinned = pinnedActions(actions);
  // Every row opens the resource's detail page — its full catalog of managed
  // capabilities filled with current state (0034 resource-centric editing,
  // Phase A). The whole main area is the link; the Actions menu stays a sibling
  // so no interactive control nests inside the anchor. `?target=` is not needed
  // here — the detail route reads the address from its own path segment.
  const detailHref = `/services/${serviceSlug}/resources/${encodeURIComponent(resource.address)}`;

  return (
    <div className={selection?.selected ? 'rr rr--selected' : 'rr'}>
      {selection && (
        <label className="rr__select" title={`Select ${displayName} for a bulk change`}>
          <input
            type="checkbox"
            className="rr__select-box"
            checked={selection.selected}
            aria-label={`Select ${displayName} for a bulk change`}
            onChange={() => selection.onToggle(resource.address)}
          />
        </label>
      )}
      <Link className="rr__open" to={detailHref} aria-label={`Open ${displayName}`}>
        <div className="rr__main">
          <div className="rr__name">{displayName}</div>
          <div className="rr__addr">{resource.address}</div>
          {chips.length > 0 && (
            <dl className="rr__chips">
              {chips.map((chip) => (
                <div className="rr__chip" key={chip.attr}>
                  <dt className="rr__chip-k">{chip.label}</dt>
                  <dd className="rr__chip-v" title={chip.full}>
                    {chip.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {childSummary !== undefined && childSummary.length > 0 && (
            <div className="rr__includes">
              <span className="rr__includes-label">Includes</span>
              {childSummary.map((entry) => (
                <span className="rr__includes-item" key={entry.resourceType}>
                  {entry.count > 1 ? `${entry.label} (${entry.count})` : entry.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </Link>

      <div className="rr__actions">
        {actions.length === 0 ? (
          <span
            className="rr__noactions"
            title="No change, delete, or move operations for this resource type"
          >
            Read-only
          </span>
        ) : (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="rr__menu-btn">
              Actions
              <span className="rr__menu-caret" aria-hidden="true">
                ▾
              </span>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="rr__menu-list" align="end" sideOffset={4}>
                {pinned.length > 0 && <div className="rr__menu-label">Common</div>}
                {pinned.map((op) => (
                  <DropdownMenu.Item asChild key={op.id}>
                    <Link className="rr__menu-item" to={actionHref(serviceSlug, op, resource)}>
                      <MacdTag macd={op.macd} />
                      <span className="rr__menu-item-title">{op.title}</span>
                    </Link>
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Item asChild>
                  <button
                    type="button"
                    className={
                      pinned.length > 0 ? 'rr__menu-item rr__menu-item--all' : 'rr__menu-item'
                    }
                    onClick={() => onOpenPicker(resource, actions)}
                  >
                    All actions… ({actions.length})
                  </button>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
    </div>
  );
}

export default ResourceRow;
