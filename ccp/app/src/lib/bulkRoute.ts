/**
 * The bulk-change route helpers (Phase B) — one op fanned across many selected targets. The
 * selected resource addresses ride the query string (comma-joined, encoded) so the flow
 * survives a refresh and is directly unit-testable. Terraform resource addresses never
 * contain a comma, so ',' is a safe, unambiguous separator. Pure — no DOM, no router.
 */

/** Build the bulk request-form URL for one op + the selected target addresses. */
export function bulkHref(serviceSlug: string, operationId: string, targets: readonly string[]): string {
  return `/services/${serviceSlug}/bulk/${operationId}?targets=${encodeURIComponent(targets.join(','))}`;
}

/** Parse the `?targets=` query back into distinct, order-preserving addresses (empty when
 * absent). De-duplicates so a repeated address can never fan out into two identical items. */
export function parseBulkTargets(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const addr = part.trim();
    if (addr.length > 0 && !seen.has(addr)) {
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}
