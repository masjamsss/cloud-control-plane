import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { seedRequests } from './helpers/seed';
import { digestOf, DryRunExecutor } from '../src/domain/apply/executor';
import { isDue, runDueApplies } from '../src/domain/apply/scheduler';
import { BUNDLE_LEASE_MS, bundleClaimLive } from '../src/domain/bundleClaim';

/**
 * ARCH-4 — the two apply lanes both act on `AWAITING_DEPLOY_APPROVAL`.
 *
 * The route-triggered bundle (`CCP_BUNDLE=1`) and the timer-driven scheduler
 * (`CCP_SCHEDULER=1`) are independent opt-ins with overlapping domains, and nothing at
 * arming time refuses the combination. Every bundle-eligible approved request is windowed
 * — it sits in exactly the status the scheduler claims. The bundle's claim writes
 * `bundle.state:'running'` and deliberately does NOT move `status`, and the scheduler's
 * due filter read only status + window, so neither lane could see the other.
 *
 * With both armed, a Lead's bundle click inside an open window raced the next tick: the
 * scheduler claimed `AWAITING_DEPLOY_APPROVAL → APPLYING` and ran its executor while the
 * bundle was mid-clone; the bundle then landed its commit and satisfied the CI deploy
 * gate, after which its result write lost its `ifEquals status` guard and surfaced as a
 * 500 — real, irreversible side effects with the record stuck at `state:'running'`.
 *
 * The other direction was already safe: `APPLYING` is not in the route's
 * `BUNDLE_ELIGIBLE` set, so a scheduler-claimed row refuses the bundle with a 409.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const NOW = Date.parse('2026-08-01T01:00:00.000Z'); // inside the window

async function seedDue(store: ConfigStore, over: Partial<RequestItem> = {}): Promise<string> {
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
    planDigest: digestOf(PINNED_DIFF),
    pinnedDiff: PINNED_DIFF,
    ...over,
  });
  return 'seed-sari-0';
}

const getReq = async (store: ConfigStore, id: string): Promise<RequestItem> =>
  (await store.get(`P#${PROJECT}#REQ#${id}`, 'META')) as RequestItem;

/** A bundle claim stamped `ageMs` ago. */
const claim = (ageMs: number): RequestItem['bundle'] =>
  ({ state: 'running', at: new Date(NOW - ageMs).toISOString() }) as RequestItem['bundle'];

describe('ARCH-4 — the scheduler keeps off a row the bundle is inside', () => {
  it('THE RACE: a due row with a LIVE bundle claim is not due', () => {
    const base = { status: 'AWAITING_DEPLOY_APPROVAL', schedule: WINDOW } as RequestItem;
    // Same row, same instant, same open window — the only difference is the claim.
    expect(isDue({ ...base, bundle: undefined }, NOW)).toBe(true);
    expect(isDue({ ...base, bundle: claim(60_000) }, NOW)).toBe(false);
  });

  it('…and runDueApplies really leaves it alone — no claim, no apply, no audit', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, { bundle: claim(60_000) });
    const outcomes = await runDueApplies(store, PROJECT, NOW, new DryRunExecutor());
    expect(outcomes).toEqual([]); // nothing due ⇒ the tick does no work at all
    const after = await getReq(store, id);
    expect(after.status).toBe('AWAITING_DEPLOY_APPROVAL'); // NOT claimed into APPLYING
    expect(after.bundle?.state).toBe('running'); // the bundle still owns it
  });

  it('CONTROL: the same row with no claim IS applied — the skip is the claim, not the fixture', async () => {
    // Without this, the test above would pass just as well against a seed that was never
    // due for some other reason (L-1).
    const store = new MemoryStore();
    const id = await seedDue(store);
    const outcomes = await runDueApplies(store, PROJECT, NOW, new DryRunExecutor());
    expect(outcomes.map((o) => o.result)).toEqual(['applied']);
    expect((await getReq(store, id)).status).not.toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('AN EXPIRED CLAIM DOES NOT WEDGE AUTO-APPLY — the check is the lease, not the flag', async () => {
    // A crashed bundle leaves `running` behind forever. Skipping on the bare flag would
    // reproduce ERR-2's permanent wedge one lane over: a fully-approved change that
    // neither lane will ever apply.
    const store = new MemoryStore();
    const id = await seedDue(store, { bundle: claim(BUNDLE_LEASE_MS + 60_000) });
    const outcomes = await runDueApplies(store, PROJECT, NOW, new DryRunExecutor());
    expect(outcomes.map((o) => o.result)).toEqual(['applied']);
    expect((await getReq(store, id)).status).not.toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('a claim with an unparseable timestamp counts as expired, never as an eternal owner', () => {
    expect(bundleClaimLive({ state: 'running', at: 'not-a-date' }, NOW)).toBe(false);
    expect(bundleClaimLive({ state: 'running' }, NOW)).toBe(false);
  });

  it('only a RUNNING claim blocks — a finished or failed bundle does not', () => {
    const base = { status: 'AWAITING_DEPLOY_APPROVAL', schedule: WINDOW } as RequestItem;
    for (const state of ['triggered', 'failed'] as const) {
      const bundle = { state, at: new Date(NOW).toISOString() } as RequestItem['bundle'];
      expect(bundleClaimLive(bundle, NOW), state).toBe(false);
      expect(isDue({ ...base, bundle }, NOW), state).toBe(true);
    }
  });

  it('the lease boundary is exclusive at exactly BUNDLE_LEASE_MS', () => {
    expect(bundleClaimLive(claim(BUNDLE_LEASE_MS - 1), NOW)).toBe(true);
    expect(bundleClaimLive(claim(BUNDLE_LEASE_MS), NOW)).toBe(false);
  });
});
