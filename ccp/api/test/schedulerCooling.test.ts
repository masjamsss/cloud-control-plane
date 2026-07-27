import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seedRequests } from './helpers/seed';
import { digestOf, DryRunExecutor, type ApplyExecutor } from '../src/domain/apply/executor';
import { isDue, runDueApplies } from '../src/domain/apply/scheduler';
import { applyGate } from '../src/domain/schedule';

/**
 * API-7 — the auto-apply scheduler ignored `earliestApplyAt`.
 *
 * `windowOpen` called `evaluateTime(req.schedule, undefined, now)`, hard-coding away the
 * cooling-off gate that every HUMAN-facing read composes through `applyGate` and that the
 * store schema documents ("a windowed interim completion stays AWAITING_DEPLOY_APPROVAL
 * with cooling composed as an applyGate reason"). So a request still inside its
 * compensating-control delay was `isDue` the instant its maintenance window opened, and
 * the one lane that applies with no human present was the one lane that skipped the
 * delay — while the SPA, the apply gate and rewindow all still enforced it.
 *
 * The predicate already handled it: `evaluateTime` answers BEFORE_WINDOW, not IN_WINDOW,
 * while cooling. It was simply never asked.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const PINNED_DIGEST = digestOf(PINNED_DIFF);
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const NOW = Date.parse('2026-08-01T01:00:00.000Z'); // inside [00:00, 04:00)
/** Cooling runs until 03:00 — inside the same window, so the window alone says "go". */
const COOLING_UNTIL = '2026-08-01T03:00:00.000Z';
const AFTER_COOLING = Date.parse('2026-08-01T03:30:00.000Z');

async function seedCooling(store: ConfigStore, over: Partial<RequestItem> = {}): Promise<string> {
  await seedRequests(store, PROJECT, 'sari', 1, {
    status: 'AWAITING_DEPLOY_APPROVAL',
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    targetAddress: 'aws_ebs_volume.dwh01',
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-30T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-30T01:00:00.000Z' },
    ],
    schedule: WINDOW,
    planDigest: PINNED_DIGEST,
    pinnedDiff: PINNED_DIFF,
    earliestApplyAt: COOLING_UNTIL,
    ...over,
  });
  return 'seed-sari-0';
}

async function getReq(store: ConfigStore, id: string): Promise<RequestItem> {
  const item = (await store.get(`P#${PROJECT}#REQ#${id}`, 'META')) as RequestItem | null;
  if (!item) throw new Error(`request ${id} not found`);
  return item;
}

afterEach(() => __setNow(null));

describe('API-7 — the scheduler honours the cooling-off delay', () => {
  const base = {
    status: 'AWAITING_DEPLOY_APPROVAL',
    schedule: WINDOW,
    earliestApplyAt: COOLING_UNTIL,
  } as unknown as RequestItem;

  it('isDue is false while cooling, true once it elapses', () => {
    // THE REGRESSION: `isDue` used to be true at NOW, because the cooling instant was
    // dropped on the floor before the verdict was computed.
    expect(isDue(base, NOW)).toBe(false);
    expect(isDue(base, AFTER_COOLING)).toBe(true);
    // The same row with no cooling stamped is due immediately — nothing else changed.
    expect(isDue({ ...base, earliestApplyAt: undefined }, NOW)).toBe(true);
  });

  it('agrees with the human-facing applyGate instead of contradicting it', () => {
    // The whole defect was one predicate answering "apply now" while the gate every
    // person reads answered "cooling". They must give the same verdict at the same
    // instant, because they are the same question.
    expect(applyGate(base, false, NOW).reasons).toContain('COOLING');
    expect(isDue(base, NOW)).toBe(false);

    expect(applyGate(base, false, AFTER_COOLING).clear).toBe(true);
    expect(isDue(base, AFTER_COOLING)).toBe(true);
  });

  it('a still-cooling request is not claimed, applied, or touched at all', async () => {
    const store = new MemoryStore();
    const id = await seedCooling(store);
    const ex: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => {
        throw new Error('a cooling request must NEVER be auto-applied');
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, ex, {});

    expect(outcomes).toEqual([]); // not due → no work, no audit
    const after = await getReq(store, id);
    expect(after.status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(after.events).toHaveLength(0); // untouched, not merely un-applied
  });

  it('and IS applied once the cooling window elapses, inside the same maintenance window', async () => {
    const store = new MemoryStore();
    const id = await seedCooling(store);

    const outcomes = await runDueApplies(store, PROJECT, AFTER_COOLING, new DryRunExecutor(), {});

    expect(outcomes).toEqual([{ requestId: id, result: 'applied' }]);
    expect((await getReq(store, id)).status).toBe('APPLIED');
  });
});
