import type { JSX } from 'react';
import type { ManifestOperation } from '@/types';
import { opTextLayers } from '@/lib/opText';
import './op-description.css';

/**
 * The surface an operation's explanation renders on. The AWS-console field NAME
 * is the headline, and each surface renders that itself (the request form's h1,
 * the add-new card's title, the action-picker detail h3) via {@link opHeadline}.
 * This component renders only what sits BENEATH that name — the demoted plain
 * summary + technical description:
 *  · form   — the request/elaboration form header (roomy; folded disclosure)
 *  · card   — the compact "Add new" resource card (a faint one-line summary)
 *  · detail — the action-picker detail pane (roomy; folded disclosure)
 */
export type OpDescriptionVariant = 'form' | 'card' | 'detail';

export interface OpDescriptionProps {
  op: Pick<ManifestOperation, 'consoleLabel' | 'title' | 'summary' | 'description'>;
  variant: OpDescriptionVariant;
}

/**
 * The demoted operation explanation — the ONE component every surface uses so the
 * "AWS name leads, description behind a single toggle" rule (lib/opText.ts) and
 * its rendering live in a single tested place. The prominent headline is the
 * surface's own AWS-name title element; this renders only what follows it:
 *
 *   · roomy surfaces (form, detail) → a SINGLE collapsed "What this does"
 *     disclosure whose body is the plain summary, with the raw technical
 *     description continuing beneath it (both folded into one toggle, never two).
 *   · compact card → the plain summary as a faint one-line description (a card
 *     sits inside an anchor, so it can host no interactive <details>).
 *
 * Colours come only from existing, contrast-gated text tokens (op-description.css),
 * so no new token pair is introduced and the WCAG gate keeps covering them. When
 * an op has neither summary nor a distinct description, nothing renders — the AWS
 * name headline stands alone, exactly as a console-fluent operator wants.
 */
export function OpDescription({ op, variant }: OpDescriptionProps): JSX.Element | null {
  const { summary, technicalDetail } = opTextLayers(op);

  // The compact card shows ONLY the plain summary as a faint one-liner beneath the
  // card's AWS-name headline — the technical detail lives on the operation's own
  // page (behind the folded toggle), never in the at-a-glance card.
  if (variant === 'card') {
    return summary !== undefined ? <span className="console__add-desc">{summary}</span> : null;
  }

  // The roomy surfaces (form, detail) fold the plain summary and the technical
  // description into ONE collapsed disclosure — the operator reads the AWS field
  // name first and opens "What this does" only when they want the explanation.
  if (summary === undefined && technicalDetail === undefined) return null;
  const blurbClass = variant === 'form' ? 'rq-blurb' : 'ap__detail-blurb';
  const techClass = variant === 'form' ? 'rq-tech' : 'ap__detail-tech';
  return (
    <div className={blurbClass}>
      <details className={techClass}>
        <summary className="op-tech__label">What this does</summary>
        {summary !== undefined && <span className="op-tech__body">{summary}</span>}
        {technicalDetail !== undefined && (
          <span className="op-tech__detail">{technicalDetail}</span>
        )}
      </details>
    </div>
  );
}

export default OpDescription;
