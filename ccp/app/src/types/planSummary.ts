/**
 * The pure-TypeScript shape of the `terraform plan` summary.
 *
 * NO runtime imports (no zod) on purpose: `types/request.ts` carries a
 * `planSummary?` field, and ccp-api typechecks the app's types (via
 * `@app-lib/permissions` → `@/types`) with ONLY its own node_modules — so a
 * type-holder must never transitively pull a zod-value file, or api-`tsc`
 * fails to resolve `zod` from the app dir and the whole request type collapses
 * to `unknown`. The runtime zod schema lives in `lib/planSummary.ts` and is
 * pinned to this shape by a compile-time drift guard there.
 */
export type PlanAction = 'create' | 'update' | 'replace' | 'delete';

export interface PlanAttrChange {
  attr: string;
  before: string;
  after: string;
}

export interface PlanResourceChange {
  address: string;
  type: string;
  action: PlanAction;
  /** replace only: attributes whose change forces the destroy-and-recreate. */
  forcedBy?: string[];
  /** update/replace only: the changed top-level attributes. */
  changed?: PlanAttrChange[];
}

export interface PlanCounts {
  create: number;
  update: number;
  replace: number;
  delete: number;
  noop: number;
}

export interface PlanSummary {
  resourceChanges: PlanResourceChange[];
  counts: PlanCounts;
  recordedAt?: string;
  runUrl?: string;
}
