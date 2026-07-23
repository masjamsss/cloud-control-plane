import type { ManifestOperation } from '@/types';

/**
 * The operator-facing text layers of an operation, after the console-name and
 * summary/description resolution. `headline` is the SHORT AWS-console field name
 * an operator reads first (with a title fallback); `summary` and `technicalDetail`
 * are the demoted explanation, folded into ONE disclosure beneath it.
 */
export interface OpTextLayers {
  /** The prominent line: the AWS Management Console field name (`consoleLabel`)
   * when authored, else the op `title`. Never a Terraform identifier. */
  headline: string;
  /** The plain "what this does" line (the op `summary`), shown inside the
   * single disclosure beneath the headline. Absent when no summary is authored. */
  summary?: string;
  /** The deeper technical detail (the raw `description`), shown beneath the
   * summary in the SAME disclosure. Absent when empty or identical to the summary,
   * so the same line never renders twice. */
  technicalDetail?: string;
}

/**
 * The prominent name an operator reads first: the AWS Management Console field
 * label (`consoleLabel`) when authored, else the op `title`. A blank/whitespace-
 * only label fails closed to the title (the pre-consoleLabel name), so a stray
 * empty string never renders an empty headline. Pure — the single source both the
 * render surfaces (request form, add-new cards, action-picker, resource detail)
 * and the resource-detail capability builder share, so the AWS-name-leads rule
 * lives in one tested place.
 */
export function opHeadline(op: Pick<ManifestOperation, 'consoleLabel' | 'title'>): string {
  const label = op.consoleLabel?.trim();
  return label ? label : op.title;
}

/**
 * Resolve an operation's display layers — the SINGLE source of the headline +
 * folded-detail model every render surface shares:
 *
 *   · headline        = consoleLabel (AWS field name) when authored, else title
 *   · summary         = the plain "what this does" line (op.summary), if any
 *   · technicalDetail = the raw op.description, shown beneath the summary in the
 *                       same disclosure, unless it is empty or equals the summary
 *
 * Blank/whitespace-only summary or description are treated as absent, so a stray
 * empty string never renders an empty line inside the disclosure. Pure — no React,
 * no I/O — so the resolution and the render that consumes it are unit-testable
 * without a DOM.
 */
export function opTextLayers(
  op: Pick<ManifestOperation, 'consoleLabel' | 'title' | 'summary' | 'description'>,
): OpTextLayers {
  const summary = op.summary?.trim() || undefined;
  const description = op.description?.trim() || undefined;
  const technicalDetail = description && description !== summary ? description : undefined;
  return { headline: opHeadline(op), summary, technicalDetail };
}
