import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { record } from '../src/domain/audit';
import { exportAuditChain, readAuditChronological } from '../src/domain/auditQuery';
import { __setNow } from '../src/clock';

/**
 * The audit chain is the evidence of record: `/readyz` returns 503 and
 * `/admin/audit/export` reports `verified: false` the moment it does not verify.
 * So the chain READER must be exactly as trustworthy as the writer — a reader bug
 * is indistinguishable, from the outside, from a tampered store.
 *
 * The reader walks month partitions backward from "now". Stepping back with
 * `date.setUTCMonth(m - 1)` is wrong on any day-of-month that the previous month
 * does not have: 31 March minus one month is 31 February, which JavaScript
 * normalizes forward to 3 March — so the walk yields March TWICE and the reader
 * accumulates that partition's entries twice. The duplicated block breaks the
 * prevHash linkage at the seam, and a perfectly intact chain reads as broken.
 *
 * That is date-triggered, so it hides: on 15 days of 2026 the walk duplicates a
 * partition, and on the rest it is fine.
 */
describe('audit chain month-partition walk (calendar correctness)', () => {
  afterEach(() => __setNow(null));

  /** Append `n` entries with the clock pinned to `iso`. */
  async function appendAt(store: MemoryStore, projectId: string, iso: string, n: number): Promise<void> {
    __setNow(() => Date.parse(iso));
    for (let i = 0; i < n; i++) {
      await record(store, projectId, { action: 'test-entry', actor: 'tester', targetType: 'test', targetId: `t-${iso}-${i}` });
    }
  }

  it('reads a chain spanning two months intact when read on the 31st', async () => {
    const store = new MemoryStore();
    await appendAt(store, 'p', '2026-06-10T00:00:00.000Z', 3);
    await appendAt(store, 'p', '2026-07-10T00:00:00.000Z', 2);

    // Read on 31 July: `setUTCMonth(6 - 1)` on 31 July is 31 June -> 1 July, so the
    // naive walk visits 202607, 202607, 202606 and reads July's entries twice.
    __setNow(() => Date.parse('2026-07-31T12:00:00.000Z'));

    const { entries } = await readAuditChronological(store, 'p');
    expect(entries.map((e) => e.id)).toHaveLength(5);
    expect(new Set(entries.map((e) => e.id)).size).toBe(5); // no duplicates

    const doc = await exportAuditChain(store, 'p');
    expect(doc.verification.message).toBe('ok: 5 entries intact');
    expect(doc.verified).toBe(true);
  });

  it('verifies an intact chain on EVERY day a month can end on', async () => {
    // 29/30/31 are exactly the days whose previous month may be shorter.
    for (const readDay of ['2026-01-31', '2026-03-29', '2026-03-30', '2026-03-31', '2026-05-31', '2026-08-31', '2026-10-31', '2026-12-31']) {
      const store = new MemoryStore();
      const readMonth = Number(readDay.slice(5, 7));
      // Two entries in the read month, three in the month before it.
      const prev = readMonth === 1 ? '2025-12-05' : `2026-${String(readMonth - 1).padStart(2, '0')}-05`;
      await appendAt(store, 'p', `${prev}T00:00:00.000Z`, 3);
      await appendAt(store, 'p', `${readDay.slice(0, 8)}01T00:00:00.000Z`, 2);

      __setNow(() => Date.parse(`${readDay}T12:00:00.000Z`));
      const doc = await exportAuditChain(store, 'p');
      expect(doc.verified, `chain read on ${readDay} must verify`).toBe(true);
      expect(doc.count, `entry count read on ${readDay}`).toBe(5);
      expect(doc.entries).toHaveLength(5);
    }
  });

  it('still sees entries stamped ahead of the reader (backward clock adjustment)', async () => {
    // An entry is stamped with the clock at WRITE time. A backward correction
    // (NTP, VM resume) taken just after a month boundary leaves entries in a
    // partition the reader would now call "the future" — invisible to a walk that
    // starts at the current month, which reads as a short chain and so a BROKEN one.
    const store = new MemoryStore();
    await appendAt(store, 'p', '2026-06-20T00:00:00.000Z', 2);
    await appendAt(store, 'p', '2026-07-01T00:00:05.000Z', 3); // written just after the boundary

    __setNow(() => Date.parse('2026-06-30T23:59:55.000Z')); // ...then the clock steps back
    const doc = await exportAuditChain(store, 'p');
    expect(doc.count).toBe(5);
    expect(doc.entries).toHaveLength(5);
    expect(doc.verified).toBe(true);
  });
});
