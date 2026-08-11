import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ulid } from 'ulid';
import { record } from '../src/domain/audit';
import {
  exportAuditChain,
  monthOfAuditId,
  readAuditPage,
  verifyProjectChain,
  __resetChainVerificationCache,
} from '../src/domain/auditQuery';
import { auditKey, chainHead, yyyymm } from '../src/store/schema';
import type { AuditItem, ChainHeadItem } from '../src/store/schema';
import type { Item, QueryOptions } from '../src/store/configStore';
import { __setNow } from '../src/clock';

const PID = 'p';

/** Append `n` entries with the clock pinned to `iso`, returning their ids in order. */
async function appendAt(store: MemoryStore, iso: string, n: number, tag = 't'): Promise<string[]> {
  __setNow(() => Date.parse(iso));
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { id } = await record(store, PID, { action: 'test-entry', actor: 'tester', targetType: 'test', targetId: `${tag}-${i}` });
    ids.push(id);
  }
  return ids;
}

describe('readAuditPage — bounded, newest-first, cursor-stable', () => {
  afterEach(() => __setNow(null));

  it('pages the whole chain in newest-first order, across month partitions', async () => {
    const store = new MemoryStore();
    const may = await appendAt(store, '2026-05-10T00:00:00.000Z', 4, 'may');
    const jun = await appendAt(store, '2026-06-10T00:00:00.000Z', 3, 'jun');
    const jul = await appendAt(store, '2026-07-10T00:00:00.000Z', 2, 'jul');
    const newestFirst = [...may, ...jun, ...jul].reverse();
    __setNow(() => Date.parse('2026-07-20T00:00:00.000Z'));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await readAuditPage(store, PID, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((e) => e.id));
      if (!page.hasMore) break;
      cursor = page.items[page.items.length - 1]?.id;
    }
    expect(seen).toEqual(newestFirst);
  });

  it('reports hasMore only while entries remain', async () => {
    const store = new MemoryStore();
    const ids = await appendAt(store, '2026-07-10T00:00:00.000Z', 3);
    __setNow(() => Date.parse('2026-07-20T00:00:00.000Z'));

    expect((await readAuditPage(store, PID, { limit: 2 })).hasMore).toBe(true);
    expect((await readAuditPage(store, PID, { limit: 3 })).hasMore).toBe(false);
    expect((await readAuditPage(store, PID, { limit: 10 })).items).toHaveLength(3);

    const last = ids[ids.length - 1]!;
    const after = await readAuditPage(store, PID, { limit: 10, cursor: last });
    expect(after.items.map((e) => e.id)).toEqual([...ids].reverse().slice(1));
  });

  it('answers an unknown cursor with an empty page, never a replay from the top', async () => {
    const store = new MemoryStore();
    await appendAt(store, '2026-07-10T00:00:00.000Z', 3);
    __setNow(() => Date.parse('2026-07-20T00:00:00.000Z'));

    const page = await readAuditPage(store, PID, { limit: 10, cursor: 'NOT-A-REAL-ULID' });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('is empty on a chain that has never been written', async () => {
    const store = new MemoryStore();
    expect(await readAuditPage(store, PID, { limit: 10 })).toEqual({ items: [], hasMore: false });
  });
});

/**
 * PERF-8 — a page of the audit chain must cost the PAGE, not the chain.
 *
 * `GET /admin/audit` used to materialize every entry, reverse the lot, find the
 * cursor with a linear scan and slice `limit` rows out of the result — so paging
 * through history re-read the whole history once per page, cloning every row. The
 * `limit` parameter bounded the response body and none of the work.
 *
 * These tests measure the read rather than describing it, because "is this still
 * O(n)?" is not a question prose can answer and is exactly the property that
 * regresses silently.
 */
describe('PERF-8 — page cost tracks the page, not the chain', () => {
  afterEach(() => __setNow(null));

  /** Counts the rows the store actually hands back — the clone cost of a read. */
  class CountingStore extends MemoryStore {
    rowsRead = 0;
    override async query(pk: string, skPrefix?: string, opts?: QueryOptions): Promise<Item[]> {
      const out = await super.query(pk, skPrefix, opts);
      this.rowsRead += out.length;
      return out;
    }
  }

  const CHAIN = 600;
  const PAGE = 50;

  async function seed(store: MemoryStore, iso: string, n: number): Promise<string[]> {
    __setNow(() => Date.parse(iso));
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { id } = await record(store, PID, { action: 'seed', actor: 'tester', targetType: 'test', targetId: `s-${i}` });
      ids.push(id);
    }
    return ids;
  }

  it('reads a bounded number of rows for EVERY page, including deep ones', async () => {
    const store = new CountingStore();
    await seed(store, '2026-07-10T00:00:00.000Z', CHAIN);
    __setNow(() => Date.parse('2026-07-20T00:00:00.000Z'));

    // L-1 — assert the fixture is big enough for the defect to be VISIBLE. With a
    // chain only as long as a page, an O(chain) read and an O(page) read cost the
    // same and this test would pass against the code it is meant to catch.
    expect(CHAIN).toBeGreaterThanOrEqual(PAGE * 10);
    const head = (await store.get(chainHead(PID).PK, chainHead(PID).SK)) as ChainHeadItem;
    expect(head.count).toBe(CHAIN);

    // The bound: a page may read the page, the one extra row that answers `hasMore`,
    // and nothing that scales with the chain. Stated as a multiple of the PAGE so it
    // keeps meaning the same thing if the fixture is resized.
    const CEILING = PAGE * 2;
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let p = 0; p < 6; p++) {
      store.rowsRead = 0;
      const page = await readAuditPage(store, PID, { limit: PAGE, ...(cursor ? { cursor } : {}) });
      expect(page.items).toHaveLength(PAGE);
      expect(store.rowsRead).toBeLessThanOrEqual(CEILING);
      // The unfixed reader read the whole chain on every page — pin the gap explicitly
      // so a regression reports "read 600 to serve 50", not just "over budget".
      expect(store.rowsRead).toBeLessThan(CHAIN);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.items[page.items.length - 1]?.id;
    }
    // Cost is bounded AND the answer is still right: six distinct pages, newest-first.
    expect(new Set(seen).size).toBe(6 * PAGE);
  });

  it('locates a cursor without scanning the entries above it, across month partitions', async () => {
    const store = new CountingStore();
    // Months chosen to run FORWARD from anything earlier in this file: `ulid` is a
    // process-wide MONOTONIC factory, so it never emits a timestamp below the highest
    // it has already emitted — rewinding the clock under it produces ids stamped with
    // the old maximum, and the id would then name the wrong partition. That is a real
    // property (the fallback test below covers it), not something to fake around here.
    const may = await seed(store, '2027-05-10T00:00:00.000Z', 200);
    const jun = await seed(store, '2027-06-10T00:00:00.000Z', 200);
    await seed(store, '2027-07-10T00:00:00.000Z', 200);
    __setNow(() => Date.parse('2027-07-20T00:00:00.000Z'));

    // A cursor deep in the OLDEST partition: the linear-scan reader had to walk July
    // and June in full before it recognised this id.
    const deep = may[100]!;
    expect(monthOfAuditId(deep)).toBe('202705'); // the id locates its own partition

    store.rowsRead = 0;
    const page = await readAuditPage(store, PID, { limit: PAGE, cursor: deep });
    expect(store.rowsRead).toBeLessThanOrEqual(PAGE * 2);
    expect(page.items).toHaveLength(PAGE);
    // Resumed strictly after the cursor, newest-first, without leaking anything newer.
    expect(page.items.map((e) => e.id)).toEqual([...may].slice(50, 100).reverse());
    expect(page.items.some((e) => jun.includes(e.id))).toBe(false);
  });

  it('keeps an unknown cursor an EMPTY page — a resume point that never existed is not a page', async () => {
    const store = new MemoryStore();
    const ids = await seed(store, '2026-07-10T00:00:00.000Z', 20);
    __setNow(() => Date.parse('2026-07-20T00:00:00.000Z'));

    // A well-formed ULID that sorts INSIDE the chain but was never written. Resolving
    // a cursor by sort position (rather than by existence) would happily "resume" from
    // it and serve plausible-looking rows; on an evidence surface that is worse than
    // returning nothing, because nothing is obviously nothing.
    const real = ids[10]!;
    const fabricated = `${real.slice(0, 20)}ZZZZZZ`;
    expect(fabricated).not.toBe(real);
    expect(monthOfAuditId(fabricated)).toBe(monthOfAuditId(real)); // same partition, absent row

    expect(await readAuditPage(store, PID, { limit: PAGE, cursor: fabricated })).toEqual({ items: [], hasMore: false });
  });

  it('still finds a cursor whose id and partition were minted from different clocks', async () => {
    // The fast path assumes an entry lives in the partition its own id names. That
    // holds because `recordIn` mints the id from the same clock reading it stamps
    // `at` with — but NOT for rows written before that was true, and not across a
    // backward system-clock step (the ulid factory is monotonic, so it keeps the old
    // maximum while `at` moves back). Those rows must still be reachable: turning a
    // live cursor into an empty page would silently truncate the operator's view of
    // the history, which on an evidence surface is the worst outcome available.
    const store = new MemoryStore();
    const jan = await seed(store, '2028-01-10T00:00:00.000Z', 3);

    // One entry whose ID says March while its `at` — and therefore its partition —
    // stays January. Forged explicitly rather than relying on clock carry-over, so
    // the mismatch is a property of this test and not of the order it runs in.
    __setNow(() => Date.parse('2028-01-10T00:00:00.000Z'));
    const strayId = ulid(Date.parse('2028-03-01T00:00:00.000Z'));
    const { id: stray } = await record(
      store,
      PID,
      { action: 'seed', actor: 'tester', targetType: 'test', targetId: 'stray' },
      { idFn: () => strayId },
    );
    const after = await seed(store, '2028-04-10T00:00:00.000Z', 2);

    // L-1 — assert the setup fired: the id really does name a partition the row is
    // not in, so the fast path really is being made to miss.
    expect(monthOfAuditId(stray)).toBe('202803');
    const lives = auditKey(PID, '202801', stray);
    expect(await store.get(lives.PK, lives.SK)).not.toBeNull();

    __setNow(() => Date.parse('2028-05-01T00:00:00.000Z'));
    const page = await readAuditPage(store, PID, { limit: PAGE, cursor: stray });
    expect(page.items.map((e) => e.id)).toEqual([...jan].reverse());
    expect(page.items.some((e) => after.includes(e.id))).toBe(false);
  });

  it('rejects ids that are not ULIDs rather than decoding nonsense into a partition', () => {
    expect(monthOfAuditId('NOT-A-REAL-ULID')).toBeNull(); // wrong length
    expect(monthOfAuditId('')).toBeNull();
    // 'U' is deliberately absent from Crockford base32 (it is excluded to avoid
    // reading as 'V'). It sits in the RANDOM half here, which does not contribute to
    // the timestamp — so a decoder that validated only the 10 timestamp characters
    // would return a confident month for a string that is not a ULID at all.
    const notAUlid = `01JQABCDEF${'0'.repeat(15)}U`;
    expect(notAUlid).toHaveLength(26);
    expect(monthOfAuditId(notAUlid)).toBeNull();
  });
});

describe('verifyProjectChain — incremental verification', () => {
  afterEach(() => __setNow(null));

  it('verifies a genesis chain and an appended suffix', async () => {
    const store = new MemoryStore();
    __setNow(() => Date.parse('2026-07-10T00:00:00.000Z'));
    expect(await verifyProjectChain(store, PID)).toEqual({ count: 0, verified: true, message: 'ok: 0 entries intact' });

    await appendAt(store, '2026-07-10T00:00:00.000Z', 3);
    expect(await verifyProjectChain(store, PID)).toMatchObject({ count: 3, verified: true });

    // Second call takes the memo path; third exercises memo + a fresh suffix.
    expect(await verifyProjectChain(store, PID)).toMatchObject({ count: 3, verified: true });
    await appendAt(store, '2026-07-11T00:00:00.000Z', 2);
    expect(await verifyProjectChain(store, PID)).toMatchObject({ count: 5, verified: true });
  });

  it('catches a broken link appended AFTER a verified prefix', async () => {
    const store = new MemoryStore();
    await appendAt(store, '2026-07-10T00:00:00.000Z', 3);
    __setNow(() => Date.parse('2026-07-11T00:00:00.000Z'));
    expect(await verifyProjectChain(store, PID)).toMatchObject({ verified: true }); // prefix memoized

    // Forge a fourth entry whose prevHash does not follow the real head, and advance
    // CHAINHEAD to match it — the shape a buggy appender would leave behind.
    const forged: AuditItem = {
      ...auditKey(PID, yyyymm(new Date(Date.parse('2026-07-11T00:00:00.000Z'))), 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
      id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      projectId: PID,
      at: '2026-07-11T00:00:00.000Z',
      actor: 'forger',
      action: 'forged',
      targetType: 'test',
      targetId: 'x',
      prevHash: 'deadbeef',
      hash: 'cafebabe',
    } as AuditItem;
    await store.put(forged);
    const hk = chainHead(PID);
    const head = (await store.get(hk.PK, hk.SK)) as ChainHeadItem;
    await store.put({ ...head, hash: 'cafebabe', count: 4, lastUlid: forged.id });

    const v = await verifyProjectChain(store, PID);
    expect(v.verified).toBe(false);
    expect(v.message).toContain('chain broken at ZZZZZZZZZZZZZZZZZZZZZZZZZZ');
  });

  it('re-verifies from genesis when the anchor entry no longer matches', async () => {
    const store = new MemoryStore();
    const ids = await appendAt(store, '2026-07-10T00:00:00.000Z', 3);
    __setNow(() => Date.parse('2026-07-11T00:00:00.000Z'));
    expect(await verifyProjectChain(store, PID)).toMatchObject({ verified: true });

    // Tamper with the LAST entry — the one the memo anchors on. The anchor check
    // fails, the memo is discarded, and the full walk reports the break.
    const lastId = ids[ids.length - 1]!;
    const k = auditKey(PID, yyyymm(new Date(Date.parse('2026-07-10T00:00:00.000Z'))), lastId);
    const stored = (await store.get(k.PK, k.SK)) as AuditItem;
    await store.put({ ...stored, actor: 'tampered' });

    expect(await verifyProjectChain(store, PID)).toMatchObject({ verified: false });
  });

  it('documents its limit: a rewritten PREFIX is caught by the export, not by the memo', async () => {
    const store = new MemoryStore();
    const ids = await appendAt(store, '2026-07-10T00:00:00.000Z', 4);
    __setNow(() => Date.parse('2026-07-11T00:00:00.000Z'));
    expect(await verifyProjectChain(store, PID)).toMatchObject({ verified: true });

    // Rewrite an entry in the MIDDLE of the already-verified prefix. Its stored
    // hash is untouched, so the anchor (the LAST entry) still matches and the memo
    // path skips it — the deliberate trade-off documented on verifyProjectChain.
    const midId = ids[1]!;
    const k = auditKey(PID, yyyymm(new Date(Date.parse('2026-07-10T00:00:00.000Z'))), midId);
    const stored = (await store.get(k.PK, k.SK)) as AuditItem;
    await store.put({ ...stored, actor: 'tampered' });

    expect(await verifyProjectChain(store, PID)).toMatchObject({ verified: true }); // memo path: not re-read

    // The evidence surfaces still verify EVERY entry, every time — they catch it.
    expect((await exportAuditChain(store, PID)).verified).toBe(false);
    // And so does the next probe in a fresh process (no memo).
    __resetChainVerificationCache(store);
    expect(await verifyProjectChain(store, PID)).toMatchObject({ verified: false });
  });
});
