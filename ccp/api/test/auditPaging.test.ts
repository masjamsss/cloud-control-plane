import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { record } from '../src/domain/audit';
import { exportAuditChain, readAuditPage, verifyProjectChain, __resetChainVerificationCache } from '../src/domain/auditQuery';
import { auditKey, chainHead, yyyymm } from '../src/store/schema';
import type { AuditItem, ChainHeadItem } from '../src/store/schema';
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
