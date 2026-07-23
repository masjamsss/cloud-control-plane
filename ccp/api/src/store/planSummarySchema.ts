import { z } from 'zod';

/**
 * The `terraform plan` summary contract, api-local copy.
 *
 * WHY A COPY, not `import … from '@app-lib/planSummary'`: the api typechecks with
 * ONLY its own node_modules installed (ccp-api.yml runs `npm ci` in ccp/api,
 * never in ccp/app). Importing a zod-VALUE file out of `../app/src/lib` makes
 * tsc resolve that file's own `import { z } from 'zod'` from the app dir, where no
 * node_modules exists in CI → the whole RequestItem type collapses to `unknown`.
 * Dependency-free app helpers (e.g. dependsOn) import fine; a zod schema cannot.
 *
 * Canonical source is `ccp/app/src/lib/planSummary.ts`; keep this edited in
 * lockstep with it (same fields, same bounds — headroom over the parser caps in
 * scripts/plan-summary.mjs). The happy-path + validation cases in
 * `test/planSummary.test.ts` exercise this schema against representative plans.
 */

export const PLAN_ACTIONS = ['create', 'update', 'replace', 'delete'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

const MAX_RESOURCE_CHANGES = 400;
const MAX_ATTR_CHANGES = 80;
const MAX_FORCED_BY = 40;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_VALUE_CHARS = 160;

const PlanActionSchema = z.enum(PLAN_ACTIONS);

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
  forcedBy: z.array(z.string().max(MAX_IDENTIFIER_CHARS)).max(MAX_FORCED_BY).optional(),
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
  recordedAt: z.string().max(40).optional(),
  runUrl: z
    .string()
    .max(500)
    .url()
    .refine((u) => u.startsWith('https://'), 'runUrl must be https')
    .optional(),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;
