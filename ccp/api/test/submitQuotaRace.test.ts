import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { AppEnv } from '../src/appEnv';
import type { RequestItem } from '../src/store/schema';
import { requestCollectionGsi } from '../src/store/schema';
import { claimSubmitSlot, submitGateKey } from '../src/middleware/rateLimit';
import { seed, seedRequests, sessionCookieFor, setSetting } from './helpers/seed';
import { writeRacingStore } from './helpers/racingStore';

/**
 * CONC-12 — the store-backed submit rate limiter was check-then-insert.
 *
 * `checkSubmitRateLimit` counted the requester's rows and returned yes/no; the request row
 * was then written LATER, in a different transaction. So N concurrent submits by one
 * requester each counted a snapshot that did not include the others, all N passed, and
 * both `submissionsPerHour` and `maxOpen` could be exceeded by the concurrency factor. The
 * check was right about a store that had stopped changing.
 *
 * The fix is not a counter — nothing can decrement one when a request closes, and
 * `maxOpen` needs exactly that. The count is instead made part of the transaction: a
 * per-(project, requester) gate row is bumped under an `ifEquals` captured BEFORE the walk
 * and written in the SAME all-or-nothing batch as the request. A competing submit either
 * committed before the count (so it is counted) or bumps the gate (so this batch aborts
 * and re-counts). There is no interleaving where two submits are both admitted on a count
 * that saw neither.
 */

const DRAFT = {
  operationId: 'ebs-gp2-to-gp3',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01' },
  justification: 'migrate the volume to gp3 for the cost saving',
  schedule: { kind: 'now' as const },
};

const hdrs = (cookie: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-ccp-client': 'ccp-spa',
  cookie,
  'x-ccp-project': 'sample',
});

const submit = async (app: Hono<AppEnv>, cookie: string, body: unknown = DRAFT): Promise<Response> =>
  app.request('/requests', { method: 'POST', headers: hdrs(cookie), body: JSON.stringify(body) });

const rowsFor = async (store: MemoryStore, requester: string): Promise<RequestItem[]> =>
  ((await store.queryGSI1(requestCollectionGsi('sample'))) as RequestItem[]).filter((r) => r.requester === requester);

/**
 * A store whose FIRST submit transaction is preceded by a whole competing submit through
 * the inner store — the read/write window of the loser's own handler.
 *
 * Keyed on the REQUEST ROW put, not on the gate write: the gate write is part of the fix,
 * and a hook that only fires when the fix is present cannot be run against code without
 * it. Only a submit writes a `…#REQ#<ulid>` row, so this still cannot fire during
 * first-boot settlement (which also walks the request collection).
 */
function racingOnSubmit(store: MemoryStore, competing: () => Promise<Response>): ReturnType<typeof writeRacingStore> {
  return writeRacingStore(
    store,
    (ws) => ws.some((w) => w.kind === 'put' && w.item.PK.startsWith('P#sample#REQ#')),
    async () => {
      const res = await competing();
      expect(res.status, 'the competing submit must actually have landed, or there was no race').toBe(201);
    },
  );
}

describe('CONC-12 — concurrent submits cannot breach a cap between them', () => {
  it('maxOpen: 1 — two in-flight submits by one requester produce ONE request, not two', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'rate.limits', { maxOpen: 1 });
    const sari = await sessionCookieFor(store, 'sari');
    const winner = createApp(store);

    const racing = racingOnSubmit(store, () => submit(winner, sari));
    const loser = await submit(createApp(racing), sari);

    expect(racing.fired(), 'the interleave must have fired, or this test proves nothing').toBe(true);
    expect(loser.status, 'the second submit must be refused — the first already filled the only slot').toBe(429);
    expect((await loser.json()).code).toBe('RATE_LIMITED');
    expect(await rowsFor(store, 'sari'), 'exactly one request may exist under maxOpen:1').toHaveLength(1);
  });

  it('submissionsPerHour: 1 — the same, for the other cap', async () => {
    // Both caps are decided by the same walk, so both were breached the same way; pinning
    // only one would leave the other free to regress.
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'rate.limits', { submissionsPerHour: 1 });
    const sari = await sessionCookieFor(store, 'sari');
    const winner = createApp(store);

    const racing = racingOnSubmit(store, () => submit(winner, sari));
    const loser = await submit(createApp(racing), sari);

    expect(racing.fired()).toBe(true);
    expect(loser.status).toBe(429);
    expect(await rowsFor(store, 'sari')).toHaveLength(1);
  });

  it('under a cap with room, the loser is ADMITTED on its retry rather than spuriously refused', async () => {
    // The gate aborting a batch must not become its own denial: with maxOpen:5 the
    // re-count finds room and the second submit succeeds. Without this, "cannot breach a
    // cap" would be satisfied by a limiter that refuses every concurrent submit.
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'rate.limits', { maxOpen: 5 });
    const sari = await sessionCookieFor(store, 'sari');
    const winner = createApp(store);

    const racing = racingOnSubmit(store, () => submit(winner, sari));
    const loser = await submit(createApp(racing), sari);

    expect(racing.fired()).toBe(true);
    expect(loser.status).toBe(201);
    expect(await rowsFor(store, 'sari')).toHaveLength(2);
  });

  it('the gate is PER REQUESTER: budi’s concurrent submit does not contend with sari’s', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'rate.limits', { maxOpen: 1 });
    const sari = await sessionCookieFor(store, 'sari');
    const budi = await sessionCookieFor(store, 'budi');
    const winner = createApp(store);

    const racing = racingOnSubmit(store, () => submit(winner, budi));
    const res = await submit(createApp(racing), sari);

    expect(racing.fired()).toBe(true);
    expect(res.status, "budi's submit must not consume sari's slot").toBe(201);
    expect(await rowsFor(store, 'sari')).toHaveLength(1);
    expect(await rowsFor(store, 'budi')).toHaveLength(1);
  });

  it('CONTROL: sequential submits under the cap still work, and the cap still bites at the limit', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'rate.limits', { maxOpen: 2 });
    const sari = await sessionCookieFor(store, 'sari');
    const app = createApp(store);
    expect((await submit(app, sari)).status).toBe(201);
    expect((await submit(app, sari)).status).toBe(201);
    const third = await submit(app, sari);
    expect(third.status).toBe(429);
    expect((await third.json()).code).toBe('RATE_LIMITED');
  });

  it('CONTROL: a pre-existing over-cap estate is still refused on the FIRST submit', async () => {
    // The gate must not accidentally admit a submission just because the gate row is
    // absent (the first-submit `ifNotExists` shape).
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'rate.limits', { maxOpen: 1 });
    await seedRequests(store, 'sample', 'sari', 1, { status: 'AWAITING_APPROVAL' });
    const sari = await sessionCookieFor(store, 'sari');
    expect((await submit(createApp(store), sari)).status).toBe(429);
    expect(await store.get(submitGateKey('sample', 'sari').PK, submitGateKey('sample', 'sari').SK), 'a refused submit claims nothing').toBeNull();
  });
});

describe('CONC-12 — the claim itself', () => {
  it('is a CAS on the gate row: the guard captures the value read BEFORE the walk', async () => {
    const store = new MemoryStore();
    await seed(store);
    const gk = submitGateKey('sample', 'sari');

    const first = await claimSubmitSlot(store, 'sample', 'sari');
    expect(first.ok).toBe(true);
    // No row yet → the claim IS the row's creation, because `ifEquals` is fail-closed
    // against a missing item and could never stand in for it.
    expect(first.ok && first.write).toEqual({ kind: 'put', item: { ...gk, seq: 1 }, ifNotExists: true });

    await store.transact([first.ok ? first.write : { kind: 'put', item: gk }]);

    const second = await claimSubmitSlot(store, 'sample', 'sari');
    expect(second.ok && second.write).toEqual({
      kind: 'update',
      pk: gk.PK,
      sk: gk.SK,
      set: { seq: 2 },
      ifEquals: { attr: 'seq', value: 1 },
    });

    // Two claims taken from the same pre-image cannot both commit — that is the whole
    // property, at the seam.
    const third = await claimSubmitSlot(store, 'sample', 'sari');
    await store.transact([second.ok ? second.write : { kind: 'put', item: gk }]);
    await expect(store.transact([third.ok ? third.write : { kind: 'put', item: gk }])).rejects.toThrow();
  });

  it('a zero cap still admits nothing, and claims nothing', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'rate.limits', { submissionsPerHour: 0 });
    expect(await claimSubmitSlot(store, 'sample', 'sari')).toEqual({ ok: false });
  });
});
