import type { ChangeRequest, ManifestOperation, RequestStatus } from '@/types';
import { isBeyondCatalogRequest } from '@/lib/beyondCatalog';
import { provisionResourceType } from '@/lib/providerCatalog';

/**
 * "Request again": a terminal request is re-drivable
 * without re-typing the form. The link reopens the SAME form (RequestForm for
 * catalog ops, the beyond-catalog tail otherwise) with `?from=<id>`; the form
 * pre-seeds its values from the earlier request's params and re-validates them
 * against the CURRENT manifest — a stale value (a narrowed allowlist, a
 * tightened bound, a dropped param) is flagged in the form, never smuggled
 * past validation. A fresh request id, a fresh justification, a fresh
 * schedule: only the PARAMS carry over.
 */

/** Statuses with no further server verb — the request's life is over, so
 * re-driving it means a NEW request. WINDOW_EXPIRED is deliberately absent:
 * its exits are rewindow/cancel, not a duplicate request. */
export const TERMINAL_REQUEST_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  'APPLIED',
  'NOOP',
  'REJECTED',
  'WITHDRAWN',
  'APPLY_FAILED',
  'DIGEST_MISMATCH',
  'CANCELLED',
]);

export function canRequestAgain(request: Pick<ChangeRequest, 'status'>): boolean {
  return TERMINAL_REQUEST_STATUSES.has(request.status);
}

/** The form URL a "Request again" link opens — the catalog op's own form, or
 * the beyond-catalog tail for that request kind. */
export function requestAgainPath(
  request: Pick<ChangeRequest, 'id' | 'service' | 'operationId'>,
): string {
  if (isBeyondCatalogRequest(request)) {
    return `/services/request-new?from=${encodeURIComponent(request.id)}`;
  }
  // A schema-generated provision reopens its own generated form, pre-seeded.
  const provisionType = provisionResourceType(request.operationId);
  if (provisionType) {
    return `/provision/${request.service}?type=${encodeURIComponent(provisionType)}&from=${encodeURIComponent(request.id)}`;
  }
  return `/services/${request.service}/${request.operationId}?from=${encodeURIComponent(request.id)}`;
}

/**
 * The params worth carrying from an earlier request into a fresh form:
 * only params the CURRENT manifest still declares (a renamed/removed param
 * silently drops), never role:"const" params (implied constants are the
 * manifest's to write, not the request's), and only when the earlier request
 * was for this very operation. Bounds are NOT checked here on purpose —
 * seeded values flow through the form's live validateParams exactly like
 * typed ones, so a now-out-of-bounds value is SHOWN and flagged rather than
 * dropped without a word.
 */
export function reusableParams(
  op: ManifestOperation,
  source: Pick<ChangeRequest, 'operationId' | 'params'>,
): Record<string, unknown> {
  if (source.operationId !== op.id) return {};
  const reuse: Record<string, unknown> = {};
  for (const p of op.params) {
    if (p.role === 'const') continue;
    const v = source.params[p.name];
    if (v !== undefined) reuse[p.name] = v;
  }
  return reuse;
}
