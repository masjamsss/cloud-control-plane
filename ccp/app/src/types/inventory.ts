export interface InventoryResource {
  address: string;
  resourceType: string;
  name?: string;
  service?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface Inventory {
  /** Committer date (ISO 8601) of the last commit to touch the scanned root
   * — git-derived, not wall-clock. Null when build-inventory.py
   * was run against a root outside any git work tree. */
  generatedAt: string | null;
  /** Full SHA of that same commit — pairs with generatedAt for display
   * ("Baseline as of {generatedAt} · {sourceCommit·7}"). */
  sourceCommit?: string | null;
  /** Human-readable provenance of the scan (build-inventory.py's --root summary). */
  source?: string;
  resources: InventoryResource[];
}
