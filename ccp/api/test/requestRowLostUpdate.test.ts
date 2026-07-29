import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError, type ConfigStore, type TransactWrite } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { seedRequests } from './helpers/seed';

/**
 * DATA-1 — request-row writes lacked optimistic concurrency.
 *
 * Approve, reject, link-pr and plan-summary each read the `RequestItem`, build a FULL
 * REPLACEMENT row in memory, and used to write it back with an unguarded
 * `{ kind: 'put', item: updated }`. Cancel, rewindow, the bundle claim and `settleCooling`
 * all CAS correctly — these four did not. Two concurrent writers therefore each computed a
 * row from the same pre-image, and the second overwrote the first: an approval signature
 * silently dropped, a linked PR erased, a plan summary replaced by a stale one, and worst,
 * the quorum ledger left claiming fewer approvals than were actually given.
 *
 * `test/approveLostUpdate.test.ts` owns the APPROVE path and the guard's own mechanics
 * (fail-closed on a deleted row, all-or-nothing inside a batch). This file covers the
 * other three verbs the finding names, and the property that ties them together: every
 * full-replacement write of a request row is guarded on `eventSeq`, the attribute the row
 * itself advances.
 *
 * The tests drive the STORE rather than the routes on purpose. What DATA-1 is about is the
 * write, and a route test cannot produce the interleaving — the two handlers would have to
 * be suspended between their read and their write. Here the pre-image is captured
 * explicitly, which is exactly what a concurrent handler holds.
 */

const PROJECT = 'acme-prod';

async function seedOne(store: ConfigStore): Promise<RequestItem> {
  await seedRequests(store, PROJECT, 'req-user', 1);
  const k = requestKey(PROJECT, 'seed-req-user-0');
  return (await store.get(k.PK, k.SK)) as RequestItem;
}

/** The shape every one of the four handlers writes: a full row computed from a read. */
function replacement(req: RequestItem, changes: Partial<RequestItem>): TransactWrite {
  const updated = { ...req, ...changes, eventSeq: (req.eventSeq ?? 0) + 1 };
  return { kind: 'put', item: updated as never, ifEquals: { attr: 'eventSeq', value: req.eventSeq } };
}

describe('a full-replacement request write cannot clobber a concurrent one (DATA-1)', () => {
  it('the SECOND writer is refused when the row moved — reject vs link-pr', async () => {
    const store = new MemoryStore();
    const req = await seedOne(store);

    // Both handlers read the same pre-image, as two in-flight requests would.
    const rejectWrite = replacement(req, { status: 'REJECTED' });
    const linkPrWrite = replacement(req, { prUrl: 'https://forge.example/o/r/pull/7', prNumber: 7 });

    await store.transact([rejectWrite]);
    await expect(store.transact([linkPrWrite])).rejects.toThrow(ConditionError);

    const k = requestKey(PROJECT, req.id);
    const after = (await store.get(k.PK, k.SK)) as RequestItem;
    expect(after.status, 'the first write must survive').toBe('REJECTED');
    expect(after.prUrl, 'the loser must not have landed').toBeUndefined();
  });

  it('demonstrates the defect: WITHOUT the guard the second write silently erases the first', async () => {
    // The same interleaving with the guard removed — the shape these four handlers had.
    // This is what "silently loses updates" means concretely.
    const store = new MemoryStore();
    const req = await seedOne(store);

    await store.transact([{ kind: 'put', item: { ...req, status: 'REJECTED', eventSeq: 1 } as never }]);
    await store.transact([{ kind: 'put', item: { ...req, prUrl: 'https://forge.example/o/r/pull/7', eventSeq: 1 } as never }]);

    const k = requestKey(PROJECT, req.id);
    const after = (await store.get(k.PK, k.SK)) as RequestItem;
    expect(after.status, 'the rejection is gone, with nothing reporting it').not.toBe('REJECTED');
    expect(after.prUrl).toBe('https://forge.example/o/r/pull/7');
  });

  it('plan-summary cannot overwrite a status decision it never saw', async () => {
    // The nastiest ordering: CI posts a plan summary from a row it read before an
    // approval landed. Unguarded, the summary write reinstates the pre-approval status.
    const store = new MemoryStore();
    const req = await seedOne(store);
    const stale = { ...req };

    await store.transact([replacement(req, { status: 'APPROVED_COOLING' })]);

    const summaryWrite = replacement(stale, {
      planSummary: { counts: { add: 1, change: 0, destroy: 0 } } as never,
    });
    await expect(store.transact([summaryWrite])).rejects.toThrow(ConditionError);

    const k = requestKey(PROJECT, req.id);
    expect(((await store.get(k.PK, k.SK)) as RequestItem).status).toBe('APPROVED_COOLING');
  });

  it('a writer that re-reads succeeds — the guard refuses stale writes, not concurrency', async () => {
    // The guard must not make the second verb impossible, only make it re-read first.
    // A guard that blocked legitimate sequential work would be swapped out for the bug.
    const store = new MemoryStore();
    const req = await seedOne(store);
    const k = requestKey(PROJECT, req.id);

    await store.transact([replacement(req, { status: 'REJECTED' })]);
    const fresh = (await store.get(k.PK, k.SK)) as RequestItem;
    await store.transact([replacement(fresh, { prUrl: 'https://forge.example/o/r/pull/7' })]);

    const after = (await store.get(k.PK, k.SK)) as RequestItem;
    expect(after.status).toBe('REJECTED');
    expect(after.prUrl).toBe('https://forge.example/o/r/pull/7');
  });

  it('every request row carries the eventSeq the guard reads', async () => {
    // The guard is only as good as the attribute EXISTING, and this is the assertion that
    // keeps it existing. The submit route now writes `eventSeq: 0` at creation and the
    // seed fixture mirrors it; without that, the guard on a request's FIRST concurrent
    // write — the approve/approve race on a freshly-submitted change — protects nothing.
    // REM-1's boot stamp covers rows that predate the field; this covers rows created
    // after boot, which the boot stamp by definition cannot reach.
    const store = new MemoryStore();
    const req = await seedOne(store);
    expect(typeof req.eventSeq, 'a seeded row must carry eventSeq').toBe('number');
  });

  it('KNOWN SEAM HAZARD: a row with no eventSeq at all is guarded by nothing', async () => {
    // Not a fix — a demonstration, kept executable so the hazard cannot be forgotten.
    //
    // `ifEquals` compares `cur[attr] !== value`. When the attribute is ABSENT and the
    // captured value is therefore also `undefined`, that is `undefined !== undefined` —
    // false — so the guard passes for EVERY concurrent writer at once. DynamoDB does the
    // opposite: a condition on a missing attribute does not match.
    //
    // Making the seam fail closed is the right fix and is NOT done here: 14 test files and
    // several real paths (versionStamp among them) deliberately guard on absent attributes
    // to back-fill them, so the change needs its own pass over every `ifEquals` call site
    // rather than being smuggled in with this one. Tracked as residue on DATA-1.
    const store = new MemoryStore();
    await seedRequests(store, PROJECT, 'legacy', 1);
    const k = requestKey(PROJECT, 'seed-legacy-0');
    const raw = (await store.get(k.PK, k.SK)) as RequestItem;
    const { eventSeq: _dropped, ...withoutSeq } = raw;
    await store.put(withoutSeq as RequestItem);

    const a = (await store.get(k.PK, k.SK)) as RequestItem;
    const b = (await store.get(k.PK, k.SK)) as RequestItem;
    await store.put({ ...a, status: 'REJECTED' }, { ifEquals: { attr: 'eventSeq', value: a.eventSeq } });
    await store.put({ ...b, status: 'APPROVED_COOLING' }, { ifEquals: { attr: 'eventSeq', value: b.eventSeq } });

    // Both guarded writes succeeded. The rejection is gone and nothing reported it.
    expect(((await store.get(k.PK, k.SK)) as RequestItem).status).toBe('APPROVED_COOLING');
  });
});
