import type { JSX } from 'react';
import type { ChangeSetItem, Inventory, ServiceManifest } from '@/types';
import { getOperation } from '@/lib/interpreter';
import { generateDiff, plainSummary } from '@/lib/diff';
import { changeSetRequirement, requirementSummary } from '@/lib/changeSet';
import { useFullBlockDiff } from '@/components/useFullBlockDiff';
import { FullBlockDiff } from '@/components/FullBlockDiff';
import { DiffView } from '@/components/DiffView';
import { MacdTag } from '@/components/ui/MacdTag';
import { AccessBadge } from '@/components/ui/AccessBadge';
import './change-set.css';

/**
 * The multi-operation change set, rendered in full for an approver (Phase B review-integrity
 * fix). A change set holds several operations approved and applied as ONE change; the pre-fix
 * approver surfaces rendered only the PRIMARY operation (items[0], via the request's top-level
 * fields), so an approver could sign N operations while shown one. This view is the disclosure
 * remedy — the SINGLE place every approver-facing surface (RequestDetail, the approvals queue)
 * renders the WHOLE set: the combined requirement the server enforces, plus EVERY item's
 * operation, target, plain-language summary and its own Terraform/block diff.
 *
 * Presentation only — no gate. The server re-validates every item atomically and re-computes
 * the strictest-combined requirement; {@link changeSetRequirement} mirrors that fold so what
 * the approver reads matches what is enforced. Used only for a true set (length ≥ 2); single-op
 * requests keep their exact prior rendering.
 */

/** One operation in the set — its own component so {@link useFullBlockDiff} (an effect-backed
 * hook) is called once at a stable position per item, never inside a loop. */
function ChangeSetItemRow({
  item,
  index,
  manifests,
  inventory,
}: {
  item: ChangeSetItem;
  index: number;
  manifests: ServiceManifest[];
  inventory: Inventory;
}): JSX.Element {
  const op = getOperation(item.operationId, manifests);
  const title = op?.title ?? item.operationId;
  const macd = op?.macd ?? item.macd;
  const targetName = inventory.resources.find((r) => r.address === item.targetAddress)?.name;
  const summary = op ? plainSummary(op, item.params, inventory) : undefined;
  // Each item gets its OWN diff (the request-level pinnedDiff only ever covered item[0]).
  // The block source is immutable in the bundle so useFullBlockDiff is deterministic here.
  const diff = op ? generateDiff(op, item.params, inventory) : undefined;
  const blockDiff = useFullBlockDiff(op, item.params, item.targetAddress);

  return (
    <li className="cs-item">
      <div className="cs-item__head">
        <span className="cs-item__num" aria-hidden="true">
          {index + 1}
        </span>
        <span className="cs-item__title">{title}</span>
        <span className="cs-item__badges">
          {macd && <MacdTag macd={macd} />}
          {item.exposure && <AccessBadge exposure={item.exposure} />}
        </span>
      </div>

      <div className="cs-item__target">
        {targetName ? <span className="cs-item__target-name">{targetName}</span> : null}
        <span className="rq__mono">{item.targetAddress}</span>
      </div>

      {summary && <p className="cs-item__summary">{summary}</p>}

      {(blockDiff || diff) && (
        // Open by default: an approver reviews a set item's diff the same way they review a
        // single change — never sight-unseen.
        <details className="cs-item__diff" open>
          <summary className="cs-item__diff-summary">
            {blockDiff ? 'The block being changed' : 'Generated Terraform'}
          </summary>
          {blockDiff ? <FullBlockDiff diff={blockDiff} /> : diff ? <DiffView diff={diff} /> : null}
        </details>
      )}
    </li>
  );
}

export interface ChangeSetViewProps {
  items: ChangeSetItem[];
  manifests: ServiceManifest[];
  inventory: Inventory;
}

/** The combined requirement banner + every item in the set. */
export function ChangeSetView({ items, manifests, inventory }: ChangeSetViewProps): JSX.Element {
  const requirement = changeSetRequirement(items);
  return (
    <div className="cs">
      <p className="cs__requirement">
        <span className="cs__requirement-label">Combined review</span>
        <span className="cs__requirement-value">{requirementSummary(requirement)}</span>
        {requirement.forcesReplace && (
          <span className="cs__requirement-flag">includes a destroy &amp; recreate</span>
        )}
      </p>
      <ol className="cs__list">
        {items.map((item, i) => (
          <ChangeSetItemRow key={i} item={item} index={i} manifests={manifests} inventory={inventory} />
        ))}
      </ol>
    </div>
  );
}
