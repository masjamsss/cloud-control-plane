import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memoryStore';
import { FileStore } from '../src/store/fileStore';
import type { Item } from '../src/store/configStore';

/**
 * CONC-8 — snapshot serialization was synchronous O(store) on the event loop.
 *
 * Both halves of the finding's own recommendation were already done: the session idle
 * slide is granularity-limited (`SLIDE_GRANULARITY_MS`) so it no longer turns every
 * authenticated request into a mutation, and PR #6 coalesced the writes so a burst costs
 * one snapshot rather than one each. What was left is the part the triage flags: the
 * SERIALIZE step itself still blocks.
 *
 * Measured before deciding, at ~5 microseconds per row:
 *
 *   1,000 rows   1.1 MB     7.9 ms
 *   5,000 rows   5.4 MB    30.8 ms
 *  20,000 rows  21.5 MB   107.0 ms
 *  50,000 rows  53.7 MB   263.3 ms
 *
 * That is a hard stall of the whole single-threaded server on the durable-write path —
 * nothing is served during it, `/readyz` included, which is exactly how a slow snapshot
 * becomes an orchestrator restart in the middle of a write.
 *
 * The fix renders the snapshot in chunks and yields between them. Its safety rests on one
 * property of this store: items are REPLACED, never mutated in place, so an array of
 * references captured synchronously is an immutable point-in-time view. The tests below
 * pin that property directly, because if it ever stops holding, this optimisation becomes
 * a torn-snapshot bug and nothing else would catch it.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'conc8-'));
  dirs.push(d);
  return join(d, 'store.json');
}

function row(i: number): Item {
  return {
    PK: `P#sample#REQ#r-${String(i).padStart(6, '0')}`,
    SK: 'META',
    id: `r-${i}`,
    justification: 'j'.repeat(40),
    params: { n: i, s: 'x'.repeat(20) },
    events: [{ at: '2026-07-30T00:00:00.000Z', type: 't', label: `event ${i}` }],
    status: 'APPLIED',
    GSI1PK: 'REQS#sample',
    GSI1SK: `r-${i}`,
  };
}

/** Exposes the two serializers side by side so they can be compared over one store. */
class Probe extends MemoryStore {
  sync(): string {
    return this.serializeItems();
  }
}

async function filled(n: number): Promise<Probe> {
  const store = new Probe();
  for (let i = 0; i < n; i++) await store.put(row(i));
  return store;
}

describe('CONC-8 — the chunked snapshot is byte-identical to the synchronous one', () => {
  it('over a store that spans many chunks', async () => {
    // The whole safety argument in one assertion: `JSON.stringify([a,b,c])` is `[` plus
    // the element renderings joined by `,` plus `]`, so stripping each chunk's brackets
    // and re-joining reproduces it exactly. Asserted rather than argued.
    const store = await filled(5000);
    expect(await store.serializeItemsChunked(500)).toBe(store.sync());
  });

  it('at every awkward boundary: empty, one row, exactly one chunk, one over', async () => {
    for (const [n, chunk] of [[0, 10], [1, 10], [10, 10], [11, 10], [20, 10]] as const) {
      const store = await filled(n);
      expect(await store.serializeItemsChunked(chunk), `n=${n} chunk=${chunk}`).toBe(store.sync());
    }
  });

  it('an empty store is `[]`, not `[]` with a stray comma or an empty chunk', async () => {
    const store = await filled(0);
    expect(await store.serializeItemsChunked(10)).toBe('[]');
    expect(store.sync()).toBe('[]');
  });

  it('preserves key order across chunk boundaries', async () => {
    const store = await filled(300);
    const parsed = JSON.parse(await store.serializeItemsChunked(7)) as Item[];
    expect(parsed).toHaveLength(300);
    const keys = parsed.map((r) => r.PK);
    expect([...keys].sort(), 'the snapshot is key-ordered, and chunking must not disturb it').toEqual(keys);
  });
});

describe('CONC-8 — it actually yields, and the capture is still atomic', () => {
  it('THE POINT: the event loop turns between chunks', async () => {
    // Without this the fix is theatre. A macrotask (setImmediate) is what lets pending
    // I/O run; awaiting a resolved promise would chunk the work and yield nothing,
    // because microtasks drain before the loop turns.
    const store = await filled(2000);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);

    await store.serializeItemsChunked(100); // 20 chunks
    clearInterval(timer);

    expect(ticks, 'a timer must have fired DURING the serialization').toBeGreaterThan(0);
  });

  it('THE CONTROL: the synchronous serializer yields nothing — otherwise the test above proves nothing', async () => {
    const store = await filled(2000);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);

    store.sync();
    clearInterval(timer);

    expect(ticks, 'the whole finding: this blocks, so no timer can fire').toBe(0);
  });

  it('a mutation landing MID-serialize does not tear the snapshot', async () => {
    // The property the chunking rests on: stored items are replaced, never mutated in
    // place, so the captured references are a point-in-time view. A row changed during
    // the serialize must appear with its OLD value — a consistent snapshot of time T —
    // rather than a mix of old and new rows within one file.
    const store = await filled(1000);

    const serializing = store.serializeItemsChunked(50); // ~20 chunks, plenty of yields
    // Land real mutations while it runs: one update, one insert, one delete.
    await store.put({ ...row(0), status: 'MUTATED_DURING_SERIALIZE' });
    await store.put(row(99999));
    await store.delete(row(1).PK, 'META');

    const parsed = JSON.parse(await serializing) as Item[];
    expect(parsed, 'the snapshot has the row count it had at capture time').toHaveLength(1000);
    expect(parsed.find((r) => r.PK === row(0).PK)!.status, 'the OLD value, not a torn mix').toBe('APPLIED');
    expect(parsed.some((r) => r.PK === row(99999).PK), 'a row added after capture is not in it').toBe(false);
    expect(parsed.some((r) => r.PK === row(1).PK), 'a row deleted after capture is still in it').toBe(true);
  });
});

describe('CONC-8 — FileStore still persists correctly through the chunked path', () => {
  it('a snapshot written in chunks reloads to exactly the same store', async () => {
    // The property that actually matters: durability is unchanged. Big enough to span
    // many chunks, so the reload is exercising the joined output rather than one chunk.
    const file = tempFile();
    const store = new FileStore(file);
    // Written CONCURRENTLY, not in a sequential loop: 3,000 sequential puts each await
    // their own full-snapshot fsync (R-32 — sequential write latency is O(store size)),
    // which is minutes, not a test. Concurrent writes coalesce, which is also the
    // realistic shape and exercises the waiter-claiming path this change touches.
    await Promise.all(Array.from({ length: 3000 }, (_, i) => store.put(row(i))));

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Item[];
    expect(onDisk).toHaveLength(3000);

    const reloaded = new FileStore(file);
    await reloaded.load();
    expect(await reloaded.get(row(0).PK, 'META')).toEqual(await store.get(row(0).PK, 'META'));
    expect(await reloaded.get(row(2999).PK, 'META')).toEqual(await store.get(row(2999).PK, 'META'));
    expect((await reloaded.queryGSI1('REQS#sample')).length).toBe(3000);
  });

  it('the file is valid JSON at rest — never a half-written chunk', async () => {
    // writeAtomic still renames a complete temp file into place; the chunking happens
    // entirely before any byte is written. This asserts the two did not get entangled.
    const file = tempFile();
    const store = new FileStore(file);
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < 500; i++) writes.push(store.put(row(i)));
    await Promise.all(writes);

    const text = readFileSync(file, 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    expect((JSON.parse(text) as Item[]).length).toBe(500);
  });

  it('a mutation during a flush is covered by the NEXT flush, not lost', async () => {
    // The coalescing contract: waiters claimed at time T are covered by a snapshot of
    // time T, and anything later queues its own flush. Chunking must not break that —
    // it is the difference between "eventually durable" and "silently dropped".
    const file = tempFile();
    const store = new FileStore(file);
    for (let i = 0; i < 400; i++) await store.put(row(i));

    const first = store.put({ ...row(0), status: 'FIRST' });
    const second = store.put({ ...row(1), status: 'SECOND' });
    await Promise.all([first, second]);

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Item[];
    expect(onDisk.find((r) => r.PK === row(0).PK)!.status).toBe('FIRST');
    expect(onDisk.find((r) => r.PK === row(1).PK)!.status, 'both are durable once both promises resolve').toBe('SECOND');
  });
});
