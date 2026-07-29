import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor, setSetting } from './helpers/seed';
import { coolingTargetStatus, settleCooling } from '../src/domain/cooling';
import { isFrozenHold } from '../src/domain/frozenHold';

/**
 * API-19 — `settleCooling` stamped `APPLIED` during a change freeze, bypassing the veto
 * the approve handler enforces.
 *
 * "No request may RECORD an apply during a freeze" (0024 §2.2/§2.6.1) is binding, and the
 * approve handler treats it that way: at quorum-met it reads `isFrozen` and parks a
 * `kind:'now'` request in `AWAITING_DEPLOY_APPROVAL` with a `held_frozen` event instead of
 * stamping `APPLIED`.
 *
 * `settleCooling` makes the SAME decision at a different moment — when an interim-profile
 * request's 24h cooling-off elapses — through `coolingTargetStatus`, which read only
 * `schedule.kind`. It never consulted the freeze. So the next read that touched such a row
 * stamped it `APPLIED` on a frozen deployment, from any endpoint.
 *
 * The sharp edge: which of the two paths a request takes is decided by whether its risk
 * profile attached a cooling-off period at all — so it was precisely the HIGHER-risk
 * requests that bypassed the freeze.
 *
 * Found while wiring API-8's freeze-hold release, and fixed with it, because the two are
 * one rule: a frozen cooling settlement now writes the same `held_frozen` marker the
 * approve handler writes, which `settleFrozenHold` then releases when the freeze lifts.
 * One freeze rule, one marker, one exit — rather than two decisions that disagree.
 */

const PROJECT = 'sample';

async function coolingRow(store: ConfigStore, over: Partial<RequestItem> = {}): Promise<string> {
  await seedRequests(store, PROJECT, 'sari', 1, {
    status: 'APPROVED_COOLING',
    schedule: { kind: 'now' },
    earliestApplyAt: '2020-01-01T00:00:00.000Z', // long elapsed
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-01T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-02T00:00:00.000Z' },
    ],
    ...over,
  });
  return 'seed-sari-0';
}

const getReq = async (store: ConfigStore, id: string): Promise<RequestItem> => {
  const k = requestKey(PROJECT, id);
  return (await store.get(k.PK, k.SK)) as RequestItem;
};

const getOne = (app: ReturnType<typeof createApp>, cookie: string, id: string) =>
  app.request(`/requests/${id}`, { headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT } });

describe('API-19 — an elapsed cooling-off respects the change freeze', () => {
  it('THE DEFECT: a frozen deployment used to stamp APPLIED anyway', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, PROJECT, 'freeze.global', true);
    const id = await coolingRow(store);

    const settled = await settleCooling(store, PROJECT, await getReq(store, id), true);

    expect(settled.status, 'THE DEFECT: this was APPLIED — an apply recorded during a freeze').toBe('AWAITING_DEPLOY_APPROVAL');
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('through the REAL route, which is where the veto is actually bypassed', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, PROJECT, 'freeze.global', true);
    const id = await coolingRow(store);
    const app = createApp(store);

    const res = await getOne(app, await sessionCookieFor(store, 'sari'), id);
    expect((await res.json()).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('writes the SAME `held_frozen` marker the approve handler writes — so it has an exit', async () => {
    // This is what stops the fix from trading one dead end for another. Without the
    // marker the row would be parked in exactly the state API-8 exists to drain, and
    // `settleFrozenHold` would not recognise it.
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, PROJECT, 'freeze.global', true);
    const id = await coolingRow(store);

    await settleCooling(store, PROJECT, await getReq(store, id), true);

    const req = await getReq(store, id);
    expect(req.events.some((e) => e.type === 'held_frozen')).toBe(true);
    expect(isFrozenHold(req), 'and API-8 recognises it, so the freeze lifting releases it').toBe(true);
  });

  it('END TO END: cooling elapses under a freeze, the freeze lifts, the request completes', async () => {
    // The whole point. Under the defect step 1 applied it during the freeze; a fix that
    // only refused would have stranded it instead. Neither is acceptable.
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, PROJECT, 'freeze.global', true);
    const id = await coolingRow(store);
    const app = createApp(store);
    const cookie = await sessionCookieFor(store, 'sari');

    await getOne(app, cookie, id);
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');

    await setSetting(store, PROJECT, 'freeze.global', false);
    const res = await getOne(app, cookie, id);
    expect((await res.json()).status, 'one read after the unfreeze completes it').toBe('APPLIED');
  });

  it('an UNFROZEN deployment is unchanged — `kind:now` still settles straight to APPLIED', async () => {
    // The guard against a fix that breaks the ordinary path.
    const store = new MemoryStore();
    await seed(store);
    const id = await coolingRow(store);

    const settled = await settleCooling(store, PROJECT, await getReq(store, id), false);
    expect(settled.status).toBe('APPLIED');
    expect(settled.events.some((e) => e.type === 'applied')).toBe(true);
  });

  it('a WINDOWED cooling row is unaffected by the freeze either way', async () => {
    // It was already landing in AWAITING_DEPLOY_APPROVAL, and it must NOT gain a
    // `held_frozen` marker — the scheduler owns it, and API-8's release must never sweep
    // a windowed row to APPLIED outside its maintenance window.
    const store = new MemoryStore();
    await seed(store);
    const id = await coolingRow(store, { schedule: { kind: 'window', at: '2030-01-01T00:00:00.000Z', endAt: '2030-01-01T04:00:00.000Z' } });

    const settled = await settleCooling(store, PROJECT, await getReq(store, id), true);
    expect(settled.status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(settled.events.some((e) => e.type === 'held_frozen')).toBe(false);
    expect(settled.events.some((e) => e.type === 'scheduled')).toBe(true);
    expect(isFrozenHold(settled)).toBe(false);
  });

  it('coolingTargetStatus is the one place the decision lives, and it takes the freeze', () => {
    expect(coolingTargetStatus({ kind: 'now' }, false)).toBe('APPLIED');
    expect(coolingTargetStatus({ kind: 'now' }, true)).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(coolingTargetStatus({ kind: 'window', at: '2026-08-01T00:00:00.000Z' }, false)).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(coolingTargetStatus({ kind: 'window', at: '2026-08-01T00:00:00.000Z' }, true)).toBe('AWAITING_DEPLOY_APPROVAL');
  });
});
