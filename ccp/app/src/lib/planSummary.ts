import { z } from 'zod';
import type { PlanSummary } from '@/types/planSummary';

/**
 * The shared `terraform plan` summary contract.
 *
 * ONE schema, three consumers:
 *   • scripts/plan-summary.mjs produces this shape from `terraform show -json`
 *     (its size caps stay UNDER the bounds here, so a legitimate plan is never
 *     refused for size — the caps below carry deliberate headroom).
 *   • ccp-api validates POST /requests/:id/plan-summary against it and
 *     stores it (imported as `@app-lib/planSummary`, the same physical schema).
 *   • the SPA guards untrusted/legacy values with {@link isPlanSummary} before
 *     PlanSummaryPanel renders them.
 *
 * Values arrive already redacted by the parser — sensitive attributes as
 * "(sensitive)", not-yet-known ones as "(known after apply)" — so nothing here
 * needs to redact again; these are plain display strings.
 */

/** The one verb per resource. `no-op` changes are counted, never listed, so
 * they never appear as a resource-change action. */
export const PLAN_ACTIONS = ['create', 'update', 'replace', 'delete'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/* Size bounds — each carries headroom over the parser's own caps
 * (MAX_RESOURCE_CHANGES 300, MAX_ATTR_CHANGES 60, MAX_FORCED_BY 30,
 * MAX_VALUE_CHARS 120 in scripts/plan-summary.mjs) so parser output always
 * validates, while still bounding what the api will durably store. */
const MAX_RESOURCE_CHANGES = 400;
const MAX_ATTR_CHANGES = 80;
const MAX_FORCED_BY = 40;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_VALUE_CHARS = 160;

const PlanActionSchema = z.enum(PLAN_ACTIONS);

/** One `attr: before → after` line. Both sides are pre-rendered strings. */
export const PlanAttrChangeSchema = z.object({
  attr: z.string().min(1).max(MAX_IDENTIFIER_CHARS),
  before: z.string().max(MAX_VALUE_CHARS),
  after: z.string().max(MAX_VALUE_CHARS),
});
export type PlanAttrChange = z.infer<typeof PlanAttrChangeSchema>;

export const PlanResourceChangeSchema = z.object({
  address: z.string().min(1).max(MAX_IDENTIFIER_CHARS),
  type: z.string().min(1).max(MAX_IDENTIFIER_CHARS),
  action: PlanActionSchema,
  /** replace only: the attributes whose change forces the destroy-and-recreate. */
  forcedBy: z.array(z.string().max(MAX_IDENTIFIER_CHARS)).max(MAX_FORCED_BY).optional(),
  /** update/replace only: the changed top-level attributes. */
  changed: z.array(PlanAttrChangeSchema).max(MAX_ATTR_CHANGES).optional(),
});
export type PlanResourceChange = z.infer<typeof PlanResourceChangeSchema>;

export const PlanCountsSchema = z.object({
  create: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  replace: z.number().int().nonnegative(),
  delete: z.number().int().nonnegative(),
  noop: z.number().int().nonnegative(),
});
export type PlanCounts = z.infer<typeof PlanCountsSchema>;

export const PlanSummarySchema = z.object({
  resourceChanges: z.array(PlanResourceChangeSchema).max(MAX_RESOURCE_CHANGES),
  counts: PlanCountsSchema,
  /** When CI recorded the plan (ISO). Absent on the mock's instant seeds. */
  recordedAt: z.string().max(40).optional(),
  /** The CI run the plan came from — rendered as an <a href>, so https-only. */
  runUrl: z
    .string()
    .max(500)
    .url()
    .refine((u) => u.startsWith('https://'), 'runUrl must be https')
    .optional(),
});
// The canonical PlanSummary shape is the zod-free `@/types/planSummary` (so
// `types/request.ts` — which the api typechecks — never pulls zod). This schema
// is pinned to it: if the two drift, `_planSummaryDriftGuard` fails to compile.
export type { PlanSummary };
type _SchemaMatchesShape =
  z.infer<typeof PlanSummarySchema> extends PlanSummary
    ? PlanSummary extends z.infer<typeof PlanSummarySchema>
      ? true
      : never
    : never;
const _planSummaryDriftGuard: _SchemaMatchesShape = true;
void _planSummaryDriftGuard;

/**
 * Type guard for an unknown/legacy value (rows stored a plain string;
 * a mock or api may hand back anything). True only for a fully-valid summary —
 * the SPA renders the honest pending note otherwise, never a partial fake.
 */
export function isPlanSummary(value: unknown): value is PlanSummary {
  return PlanSummarySchema.safeParse(value).success;
}

/** The short action word for a resource row's badge. */
const ACTION_LABEL: Record<PlanAction, string> = {
  create: 'Create',
  update: 'Update',
  replace: 'Replace',
  delete: 'Destroy',
};
export function actionLabel(action: PlanAction): string {
  return ACTION_LABEL[action];
}

/** The verb form used inside a sentence ("This plan will …"). */
const ACTION_VERB: Record<PlanAction, string> = {
  create: 'create',
  update: 'update',
  replace: 'replace',
  delete: 'destroy',
};

/** Oxford-comma join: ['a','b','c'] → 'a, b, and c'. */
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * The one-line, plain-language headline. `nounForType` (lib/replaceConsequences)
 * turns a resource type into a human noun so a single-resource plan reads
 * "This plan will replace one volume." rather than in counts. A no-op plan says
 * so honestly; a multi-resource plan lists the verbs in destructive-first order.
 */
export function planHeadline(summary: PlanSummary, nounForType: (type: string) => string): string {
  const c = summary.counts;
  const total = c.create + c.update + c.replace + c.delete;
  if (total === 0) {
    return 'No changes — this plan leaves the live environment exactly as it is.';
  }
  const only = summary.resourceChanges[0];
  if (total === 1 && only) {
    return `This plan will ${ACTION_VERB[only.action]} one ${nounForType(only.type)}.`;
  }
  const clauses: string[] = [];
  if (c.replace) clauses.push(`replace ${c.replace}`);
  if (c.delete) clauses.push(`destroy ${c.delete}`);
  if (c.update) clauses.push(`update ${c.update}`);
  if (c.create) clauses.push(`create ${c.create}`);
  return `This plan will ${joinClauses(clauses)} — ${total} resources in all.`;
}
