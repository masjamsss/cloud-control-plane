import type { PlanSummary } from '@/lib/planSummary';

/**
 * Types the zero-dependency plan-summary parser (plan-summary.mjs) for its
 * TypeScript consumers (src/test/planSummary.test.ts). The runtime stays pure
 * JS so CI's plan job runs it with the runner's own node — no build step — but
 * its output is pinned here to the same shared contract the api validates.
 */
export function summarizePlan(plan: unknown): PlanSummary;
