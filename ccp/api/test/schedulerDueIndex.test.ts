import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, Item, QueryOptions } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { requestCollectionGsi, requestKey } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seedRequests } from './helpers/seed';
import { digestOf, DryRunExecutor } from '../src/domain/apply/executor';
import { RequestDueIndex } from '../src/domain/apply/dueIndex';
import { APPLYING, type ApplyOutcome, runDueApplies } from '../src/domain/apply/scheduler';

/**
 * PERF-14 — the tick used to read the project's ENTIRE request collection every 60
 * seconds, deep-cloning every row of history to find a due set that is almost always
 * empty. Measured before the fix on a MemoryStore at 20 projects x 500 requests: 45 ms per
 * tick, ~44 ms of it inside `queryGSI1`; at 20 x 2000, ~190 ms. Permanent allocation churn
 * that grows with history and never comes back down.
 *
 * The cost test below is written as a RULE rather than a number (L-25): **what a tick
 * reads must not grow with the project's completed history.** A threshold in milliseconds
 * would be flaky and would need re-tuning; "the same project with 20x the finished
 * requests costs the same per tick" is the actual property, and it fails loudly against
 * the unfixed code.
 *
 * The correctness tests are the other half, and they matter more: an index that is fast
 * and misses a request is worse than the scan it replaced, because a stranded approved
 * change fails silently. They pin membership-by-existence (a row is watched because it
 * EXISTS, never because some write path remembered to register it), the re-seed that
 * bounds any drift, and a straight differential against the unindexed path.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const PINNED_DIGEST = digestOf(PINNED_DIFF);
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const NOW = Date.parse('2026-08-01T01:00:00.000Z');

/** Counts what a tick actually READS: rows returned by the collection query, plus gets. */
function countingStore(inner: ConfigStore): ConfigStore & { rowsRead: number; gets: number; reset(): void } {
  const wrapper = {
    rowsRead: 0,
    gets: 0,
    reset(): void {
      wrapper.rowsRead = 0;
      wrapper.gets = 0;
    },
    async get(pk: string, sk: string): Promise<Item | null> {
      const v = await inner.get(pk, sk);
      if (sk === 'META' && pk.includes('#REQ#')) {
        wrapper.gets++;
        wrapper.rowsRead++;
      }
      return v;
    },
    put: (item: Item, opts?: Parameters<ConfigStore['put']>[1]) => inner.put(item, opts),
    query: (pk: string, prefix?: string, opts?: QueryOptions) => inner.query(pk, prefix, opts),
    async queryGSI1(gsi1pk: string, opts?: QueryOptions): Promise<Item[]> {
      const rows = await inner.queryGSI1(gsi1pk, opts);
      if (gsi1pk === requestCollectionGsi(PROJECT)) wrapper.rowsRead += rows.length;
      return rows;
    },
    transact: (writes: Parameters<ConfigStore['transact']>[0]) => inner.transact(writes),
    delete: (pk: string, sk: string) => inner.delete(pk, sk),
  };
  return wrapper;
}

/** `n` finished (APPLIED) requests — the history that used to be re-read every minute. */
async function seedHistory(store: ConfigStore, n: number): Promise<void> {
  await seedRequests(store, PROJECT, 'histo', n, { status: 'APPLIED', schedule: { kind: 'now' } });
}

/** One due, fully-approved, windowed request with an intact pin. */
async function seedDue(store: ConfigStore, requester = 'sari', over: Partial<RequestItem> = {}): Promise<string> {
  await seedRequests(store, PROJECT, requester, 1, {
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
    ...over,
  });
  return `seed-${requester}-0`;
}

async function getReq(store: ConfigStore, id: string): Promise<RequestItem> {
  const k = requestKey(PROJECT, id);
  const item = (await store.get(k.PK, k.SK)) as RequestItem | null;
  if (!item) throw new Error(`request ${id} not found`);
  return item;
}

afterEach(() => __setNow(null));

describe('PERF-14 — a tick costs what the project has OPEN, not what it has DONE', () => {
  it('the same open work costs the same per tick with 20 finished requests and with 400', async () => {
    const measure = async (historyRows: number): Promise<number> => {
      const inner = new MemoryStore();
      await seedHistory(inner, historyRows);
      await seedDue(inner, 'sari', { status: 'AWAITING_DEPLOY_APPROVAL', schedule: { kind: 'window', at: '2026-09-01T00:00:00.000Z', endAt: '2026-09-01T04:00:00.000Z' } });
      const store = countingStore(inner);
      const candidates = new RequestDueIndex();
      // Tick 1 seeds the index (one full scan, unavoidable and paid once).
      await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), { candidates });
      store.reset();
      // Tick 2 is the steady state — the one that repeats every 60 s forever.
      await runDueApplies(store, PROJECT, NOW + 60_000, new DryRunExecutor(), { candidates });
      return store.rowsRead;
    };

    const small = await measure(20);
    const large = await measure(400);

    // THE REGRESSION. Before the fix these were 21 and 401: every tick re-read (and
    // deep-cloned) the whole collection, so the steady-state cost was the history.
    expect(large).toBe(small);
    // Setup assertion (L-1): the unfixed shape really would have differed here, i.e. the
    // history is genuinely there to be re-read. Without this the equality above would
    // also hold for a store that had no rows at all.
    const inner = new MemoryStore();
    await seedHistory(inner, 400);
    expect((await inner.queryGSI1(requestCollectionGsi(PROJECT))).length).toBe(400);
  });

  it('the unindexed path is unchanged — it still reads the whole collection', async () => {
    const inner = new MemoryStore();
    await seedHistory(inner, 50);
    const store = countingStore(inner);
    await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), {});
    expect(store.rowsRead).toBe(50); // the behaviour every existing caller still gets
  });
});

describe('PERF-14 — the index cannot silently strand a request', () => {
  it('a request that becomes eligible LATER is still found — membership is by existence', async () => {
    const store = new MemoryStore();
    const candidates = new RequestDueIndex();
    // Submitted, nowhere near approved. The index sees it because it EXISTS, not because
    // any write path registered it.
    const id = await seedDue(store, 'sari', { status: 'AWAITING_CODE_REVIEW' });
    expect(await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), { candidates })).toEqual([]);

    // It completes its ladder — a status transition NOTHING told the index about.
    const row = await getReq(store, id);
    await store.put({ ...row, status: 'AWAITING_DEPLOY_APPROVAL' } as Item);

    const outcomes = await runDueApplies(store, PROJECT, NOW + 60_000, new DryRunExecutor(), { candidates });
    expect(outcomes).toEqual([{ requestId: id, result: 'applied' }]);
  });

  it('a request created AFTER the seed is picked up on the next tick', async () => {
    const store = new MemoryStore();
    const candidates = new RequestDueIndex();
    await seedHistory(store, 5);
    await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), { candidates }); // seed

    const id = await seedDue(store, 'sari'); // ulid-ordered after everything seen so far
    const outcomes = await runDueApplies(store, PROJECT, NOW + 60_000, new DryRunExecutor(), { candidates });
    expect(outcomes).toEqual([{ requestId: id, result: 'applied' }]);
  });

  it('a WINDOW_EXPIRED row stays watched — it is parked, not terminal, and rewindow revives it', async () => {
    const store = new MemoryStore();
    const candidates = new RequestDueIndex();
    const id = await seedDue(store, 'sari', { status: 'WINDOW_EXPIRED' });
    await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), { candidates });
    expect(candidates.stats(PROJECT).watched).toBe(1); // still tracked, not dropped as done

    // Re-windowed back into eligibility, again with nobody telling the index.
    const row = await getReq(store, id);
    await store.put({ ...row, status: 'AWAITING_DEPLOY_APPROVAL' } as Item);
    expect(await runDueApplies(store, PROJECT, NOW + 60_000, new DryRunExecutor(), { candidates })).toEqual([
      { requestId: id, result: 'applied' },
    ]);
  });

  it('a finished request leaves the watch set, which is what makes the cost bounded', async () => {
    const store = new MemoryStore();
    const candidates = new RequestDueIndex();
    const id = await seedDue(store, 'sari');
    await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), { candidates }); // applies it
    expect((await getReq(store, id)).status).toBe('APPLIED');
    await runDueApplies(store, PROJECT, NOW + 60_000, new DryRunExecutor(), { candidates });
    expect(candidates.stats(PROJECT).watched).toBe(0);
  });

  it('a row the incremental walk could not see is recovered by the re-seed, and the bound is the re-seed interval', async () => {
    const store = new MemoryStore();
    const candidates = new RequestDueIndex({ reseedEveryTicks: 1 }); // re-seed after ONE incremental tick
    await seedDue(store, 'histo', { status: 'APPLIED', schedule: { kind: 'now' } }); // id `seed-histo-0`
    await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), { candidates }); // seed; cursor = seed-histo-0
    expect(candidates.stats(PROJECT).seeds).toBe(1);

    // A row whose sort key sorts BELOW the cursor — the same-millisecond ULID hazard the
    // index documents, forced here rather than hoped against.
    const id = await seedDue(store, 'aaa');
    expect(id < 'seed-histo-0').toBe(true); // setup assertion: it really is out of order

    // The incremental walk cannot see it…
    expect(await runDueApplies(store, PROJECT, NOW + 60_000, new DryRunExecutor(), { candidates })).toEqual([]);
    // …and the re-seed does, on the very next tick. The drift is bounded, never permanent.
    expect(await runDueApplies(store, PROJECT, NOW + 120_000, new DryRunExecutor(), { candidates })).toEqual([
      { requestId: id, result: 'applied' },
    ]);
    expect(candidates.stats(PROJECT).seeds).toBe(2);
  });
});

describe('PERF-14 — indexed and unindexed ticks decide identically', () => {
  it('a scripted sequence of submits, approvals, claims and cancels produces the same outcomes both ways', async () => {
    const build = async (): Promise<MemoryStore> => {
      const store = new MemoryStore();
      await seedHistory(store, 7);
      await seedDue(store, 'sari'); // due now
      await seedDue(store, 'budi', { status: 'AWAITING_CODE_REVIEW', approvals: [] }); // not approved
      await seedDue(store, 'lina', { schedule: { kind: 'window', at: '2026-09-01T00:00:00.000Z', endAt: '2026-09-01T04:00:00.000Z' } }); // future window
      await seedDue(store, 'putra', { status: APPLYING, applyClaimedAt: new Date(NOW - 10_000).toISOString() }); // live claim
      await seedDue(store, 'rina', { status: APPLYING, applyClaimedAt: '2026-07-01T00:00:00.000Z' }); // dead claim
      await seedDue(store, 'tono', { pinnedDiff: undefined, planDigest: undefined }); // no pin → held
      return store;
    };

    const plain = await build();
    const indexed = await build();
    const candidates = new RequestDueIndex({ reseedEveryTicks: 2 });

    const ticks = [NOW, NOW + 60_000, NOW + 120_000, NOW + 180_000];
    const runs: Array<{ plain: ApplyOutcome[]; indexed: ApplyOutcome[] }> = [];
    for (const [i, t] of ticks.entries()) {
      if (i === 2) {
        // Mid-run change on both stores: the un-approved row completes its ladder.
        for (const s of [plain, indexed]) {
          const row = await getReq(s, 'seed-budi-0');
          await s.put({ ...row, status: 'AWAITING_DEPLOY_APPROVAL' } as Item);
        }
      }
      runs.push({
        plain: await runDueApplies(plain, PROJECT, t, new DryRunExecutor(), {}),
        indexed: await runDueApplies(indexed, PROJECT, t, new DryRunExecutor(), { candidates }),
      });
    }

    const sort = (o: ApplyOutcome[]): ApplyOutcome[] => [...o].sort((a, b) => a.requestId.localeCompare(b.requestId));
    for (const [i, r] of runs.entries()) {
      expect(sort(r.indexed), `tick ${i}`).toEqual(sort(r.plain));
    }

    // Setup assertion (L-1): the scenario really exercised the interesting outcomes. An
    // all-empty run would compare equal and prove nothing.
    const kinds = new Set(runs.flatMap((r) => r.plain.map((o) => o.result)));
    expect(kinds).toEqual(new Set(['applied', 'skipped-moved', 'halted', 'held-no-plan']));

    // And the two stores ended in the same state, not just with the same return values.
    for (const id of ['seed-sari-0', 'seed-budi-0', 'seed-lina-0', 'seed-putra-0', 'seed-rina-0', 'seed-tono-0']) {
      expect((await getReq(indexed, id)).status, id).toBe((await getReq(plain, id)).status);
    }
  });
});
