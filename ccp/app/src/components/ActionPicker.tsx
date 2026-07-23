import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import type { InventoryResource, ManifestOperation } from '@/types';
import { deriveFormPlan, softWarnings } from '@/lib/catalog';
import { exposureLabel } from '@/lib/interpreter';
import {
  actionHref,
  filterAction,
  groupScopedActions,
  presentGroups,
  GROUP_LABELS,
} from '@/lib/actionPicker';
import { OpChips } from '@/components/ui/OpChips';
import { OpDescription } from '@/components/OpDescription';
import { opHeadline } from '@/lib/opText';
import '@/components/command-palette.css';
import './action-picker.css';

export interface ActionPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceSlug: string;
  resource: InventoryResource;
  actions: ManifestOperation[];
}

/** role:"const" params carry no request input — never show them in a
 * params summary. Mirrors RequestForm.tsx's isConstParam (kept local here
 * too: a 1-line predicate, not worth threading a shared import for). */
function isConstParam(p: { role?: string }): boolean {
  return p.role === 'const';
}

/** Field labels a requester would fill in, excluding the target (this
 * resource, already implied) and any implied-constant param. */
function paramsSummary(op: ManifestOperation): string[] {
  return deriveFormPlan(op)
    .sections.filter((s) => s.id !== 'target')
    .flatMap((s) => s.fields)
    .filter((f) => !isConstParam(f))
    .map((f) => f.label);
}

/**
 * The scoped action picker: a cmdk overlay pre-scoped to
 * ONE resource, reusing the CommandPalette shell (command-palette.css's
 * .cmdp classes). Rows are that resource type's Change/Delete/Move ops plus
 * the Add ops that operate on it (isResourceScopedAdd),
 * grouped under the fixed PICKER_GROUPS headers ("Create" leads with the
 * scoped Adds), each with a title + risk/exposure chip row. A detail pane shows
 * description/params/reversibility/review-path for the highlighted row
 * BEFORE Enter. A single resource type tops out around 48 ops today (well
 * within cmdk's own mount-everything default), so this uses cmdk's normal
 * automatic filtering — no virtualization needed here (contrast
 * CommandPalette.tsx, which does need it at 680+ ops estate-wide).
 */
export function ActionPicker({
  open,
  onOpenChange,
  serviceSlug,
  resource,
  actions,
}: ActionPickerProps): JSX.Element {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | undefined>(undefined);

  // Reopening (or targeting a different resource) starts from a clean slate:
  // no leftover search text, and re-derive the default highlight for the new
  // action set rather than keep a stale id from the previous resource.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlightedId(undefined);
  }, [open, resource.address]);

  const buckets = useMemo(() => groupScopedActions(actions), [actions]);
  const groupsPresent = useMemo(() => presentGroups(actions), [actions]);
  const highlighted = useMemo(
    () => actions.find((op) => op.id === highlightedId),
    [actions, highlightedId],
  );
  const displayName = resource.name ?? resource.address;

  const go = (op: ManifestOperation): void => {
    onOpenChange(false);
    navigate(actionHref(serviceSlug, op, resource));
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={`Actions for ${displayName}`}
      className="cmdp ap"
      shouldFilter
      filter={filterAction}
      value={highlightedId}
      onValueChange={setHighlightedId}
    >
      <Command.Input
        className="cmdp__input"
        placeholder={`Search actions for ${displayName}…`}
        value={query}
        onValueChange={setQuery}
      />
      <div className="ap__body">
        <Command.List className="cmdp__list ap__list">
          <Command.Empty className="cmdp__empty ap__empty">
            <p>No actions match “{query}”.</p>
            {groupsPresent.length > 0 && (
              <>
                <p className="ap__empty-hint">Browse by category:</p>
                <ul className="ap__empty-groups">
                  {groupsPresent.map((g) => (
                    <li key={g}>{GROUP_LABELS[g]}</li>
                  ))}
                </ul>
              </>
            )}
          </Command.Empty>

          {buckets.map(({ group, label, ops }) => (
            <Command.Group key={group} heading={label} className="cmdp__group">
              {ops.map((op) => (
                <Command.Item
                  key={op.id}
                  value={op.id}
                  // Fixed order [title, description, summary?] — filterAction
                  // (lib/actionPicker.ts) destructures this positionally.
                  keywords={[op.title, op.description, ...(op.summary ? [op.summary] : [])]}
                  onSelect={() => go(op)}
                  className="cmdp__item ap__item"
                >
                  <span className="cmdp__item-title">{op.title}</span>
                  <OpChips op={op} />
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>

        <div className="ap__detail" aria-live="polite">
          {highlighted ? (
            <>
              <h3 className="ap__detail-title">{opHeadline(highlighted)}</h3>
              <OpDescription op={highlighted} variant="detail" />
              <dl className="ap__detail-facts">
                <div className="ap__detail-fact">
                  <dt>Reversible</dt>
                  <dd>{highlighted.reversible ? 'Yes' : 'No'}</dd>
                </div>
                <div className="ap__detail-fact">
                  <dt>Review path</dt>
                  <dd>{exposureLabel(highlighted.exposure)}</dd>
                </div>
              </dl>
              {paramsSummary(highlighted).length > 0 && (
                <div className="ap__detail-params">
                  <span className="ap__detail-params-label">Fields on the request form</span>
                  <ul>
                    {paramsSummary(highlighted).map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                </div>
              )}
              {softWarnings(highlighted).length > 0 && (
                <ul className="ap__detail-warnings">
                  {softWarnings(highlighted).map((w) => (
                    <li key={w}>
                      <span aria-hidden="true">⚠</span> {w}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="ap__detail-empty">Highlight an action to see details.</p>
          )}
        </div>
      </div>
    </Command.Dialog>
  );
}

export default ActionPicker;
