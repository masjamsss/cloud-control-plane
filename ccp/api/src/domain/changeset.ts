import type { RequestItem, RequestSetItem } from '../store/schema';

/**
 * The change-set canonicalization seam (Phase B). One function — {@link itemsOf} —
 * is the SINGLE place the "a request is an ordered list of operations" model is
 * expressed, and it is what makes single-op a strict special case (`items.length === 1`)
 * of the multi-op path rather than a separate branch:
 *
 *   - a MULTI-op request stores its operations in `items` (length ≥ 2);
 *   - a SINGLE-op request stores NONE, and its top-level operationId/targetAddress/params
 *     ARE the one item — derived here on read.
 *
 * Every consumer (the combined requirement, the pinned-ladder display, the audit summary)
 * iterates `itemsOf(req)` and so treats both shapes identically. This is why the
 * single-op wire/store behaviour is byte-identical to before: nothing new is persisted for
 * it, and the derived one-item list reproduces exactly the fields the old single-op code
 * read directly.
 */

/** The minimal request shape {@link itemsOf} reads — the top-level per-op fields plus the
 * optional `items` list. Accepts a full {@link RequestItem} or any Pick of it. */
export type ChangeSetSource = Pick<
  RequestItem,
  'items' | 'operationId' | 'service' | 'macd' | 'targetAddress' | 'params' | 'exposure' | 'reviewTier' | 'replaceConfirmation'
>;

/**
 * The canonical, ALWAYS-non-empty ordered item list of a request. When `items` is present
 * (a true change set) it is returned verbatim; otherwise a single item is synthesized from
 * the top-level fields so a single-op request reads as `items.length === 1`. The derived
 * item carries the top-level `reviewTier`/`replaceConfirmation` ONLY when set, matching how
 * a real stored item omits absent optionals — so a set built from single items and a
 * single-op request are indistinguishable to every downstream combinator.
 */
export function itemsOf(req: ChangeSetSource): RequestSetItem[] {
  if (req.items && req.items.length > 0) return req.items;
  return [
    {
      operationId: req.operationId,
      service: req.service,
      macd: req.macd,
      targetAddress: req.targetAddress,
      params: req.params,
      exposure: req.exposure,
      ...(req.reviewTier !== undefined ? { reviewTier: req.reviewTier } : {}),
      ...(req.replaceConfirmation !== undefined ? { replaceConfirmation: req.replaceConfirmation } : {}),
    },
  ];
}

/** How many operations a request enacts — 1 for a single-op request, N for a set. */
export function itemCountOf(req: ChangeSetSource): number {
  return req.items && req.items.length > 0 ? req.items.length : 1;
}

/** Whether a request is a true multi-operation change set (as opposed to single-op). */
export function isChangeSet(req: ChangeSetSource): boolean {
  return itemCountOf(req) > 1;
}
