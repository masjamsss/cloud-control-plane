import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, Item, TransactWrite } from '../src/store/configStore';
import type { PendingConfigChangeItem } from '../src/store/schema';
import { configChangeKey, pendingConfigGsi } from '../src/store/schema';
import { ackPending, rejectPending, sweepExpired } from '../src/domain/dualControl';
import { ApiError } from '../src/errors';
import { __setNow } from '../src/clock';
import { seed } from './helpers/seed';

/**
 * CONC-9 / DATA-8 — the pending-change status transitions had no CAS.
 *
 * `ackPending` and `rejectPending` both read the row, verify `status === 'PENDING'` in
 * memory, and then wrote the transition unconditionally; `sweepExpired` blind-put the
 * whole row. So the three ways a proposal can leave PENDING could each overwrite either
 * of the others.
 *
 * The ack case is the sharp one, and it survived a retry loop that looks like it should
 * have caught it. `ackPending` transacts `[apply, pending → APPLIED]` and retries on
 * chain contention. A reject committing in between changes the PENDING ROW and nothing
 * else — so the retry's re-check, which examined only the apply TARGET's guard, still
 * passed. The config change applied and the row flipped REJECTED → APPLIED: an admin's
 * explicit refusal overridden by a racing ack, with the audit chain recording both.
 */

const PROJECT = 'sample';

/** A store that runs `after` once, following the first `get` of `pk`/`sk`. */
function racingStore(inner: ConfigStore, target: { PK: string; SK: string }, after: () => Promise<void>): ConfigStore {
  let fired = false;
  return {
    async get(pk: string, sk: string): Promise<Item | null> {
      const v = await inner.get(pk, sk);
      if (!fired && pk === target.PK && sk === target.SK) {
        fired = true;
        await after();
      }
      return v;
    },
    put: (item, opts) => inner.put(item, opts),
    query: (pk, prefix, opts) => inner.query(pk, prefix, opts),
    queryGSI1: (gsi1pk, opts) => inner.queryGSI1(gsi1pk, opts),
    transact: (writes: TransactWrite[]) => inner.transact(writes),
    delete: (pk, sk) => inner.delete(pk, sk),
  };
}

/** A PENDING proposal whose apply is a simple guarded update on a settings row. */
async function seedPending(store: MemoryStore, over: Partial<PendingConfigChangeItem> = {}): Promise<string> {
  const id = 'pc-1';
  const k = configChangeKey(PROJECT, id);
  await store.put({ PK: `P#${PROJECT}#SETTING#demo`, SK: 'META', value: 'before' } as unknown as Item);
  await store.put({
    ...k,
    id,
    projectId: PROJECT,
    kind: 'setting',
    targetKey: 'demo',
    before: { value: 'before' },
    after: { value: 'after' },
    apply: {
      op: 'update',
      pk: `P#${PROJECT}#SETTING#demo`,
      sk: 'META',
      set: { value: 'after' },
      guardAttr: 'value',
      guardValue: 'before',
    },
    proposedBy: 'putra',
    proposedAt: '2026-07-01T00:00:00.000Z',
    status: 'PENDING',
    expiresAt: '2026-07-04T00:00:00.000Z',
    // Built from the real key function, not hand-typed. The first version guessed the
    // partition name and the sweep found nothing, which the CONTROL test below caught —
    // without it, "the sweep did not overwrite an acked row" would have been true because
    // the sweep never looked at the row at all (L-1).
    GSI1PK: pendingConfigGsi(PROJECT),
    GSI1SK: id,
    ...over,
  } as unknown as Item);
  return id;
}

const readPending = async (store: MemoryStore, id: string): Promise<PendingConfigChangeItem> =>
  (await store.get(configChangeKey(PROJECT, id).PK, configChangeKey(PROJECT, id).SK)) as unknown as PendingConfigChangeItem;

const targetValue = async (store: MemoryStore): Promise<unknown> =>
  ((await store.get(`P#${PROJECT}#SETTING#demo`, 'META')) as unknown as { value: unknown }).value;

describe('CONC-9 / DATA-8 — a resolved proposal cannot be re-resolved', () => {
  it('THE RACE: a reject landing mid-ack refuses the ack — the change does not apply', async () => {
    __setNow(() => Date.parse('2026-07-02T00:00:00.000Z'));
    const store = new MemoryStore();
    await seed(store);
    const id = await seedPending(store);
    const k = configChangeKey(PROJECT, id);

    const racing = racingStore(store, k, async () => {
      await rejectPending(store, PROJECT, 'lina', id);
    });

    await expect(ackPending(racing, PROJECT, 'lina', id)).rejects.toThrow(ApiError);
    const row = await readPending(store, id);
    expect(row.status, "the admin's refusal must stand").toBe('REJECTED');
    expect(await targetValue(store), 'the config change must NOT have applied').toBe('before');
  });

  it('…and reports STATE_CONFLICT, not CHAIN_CONTENTION — no retry can fix a resolved proposal', async () => {
    __setNow(() => Date.parse('2026-07-02T00:00:00.000Z'));
    const store = new MemoryStore();
    await seed(store);
    const id = await seedPending(store);
    const racing = racingStore(store, configChangeKey(PROJECT, id), async () => {
      await rejectPending(store, PROJECT, 'lina', id);
    });
    await expect(ackPending(racing, PROJECT, 'lina', id)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
  });

  it('THE MIRROR: a reject cannot overwrite a concurrent ack', async () => {
    __setNow(() => Date.parse('2026-07-02T00:00:00.000Z'));
    const store = new MemoryStore();
    await seed(store);
    const id = await seedPending(store);
    const racing = racingStore(store, configChangeKey(PROJECT, id), async () => {
      await ackPending(store, PROJECT, 'lina', id);
    });

    await expect(rejectPending(racing, PROJECT, 'budi', id)).rejects.toThrow(ApiError);
    const row = await readPending(store, id);
    // Recording an applied change as REJECTED is the worse half of this defect: the
    // config really did change, and the record said somebody refused it.
    expect(row.status).toBe('APPLIED');
    expect(await targetValue(store)).toBe('after');
  });

  it('THE SWEEP: an ack landing mid-sweep is not overwritten with EXPIRED', async () => {
    // The blind whole-row put was the worst-placed of the three: the sweep walks rows it
    // read in a previous step, so its write is stale by construction.
    __setNow(() => Date.parse('2026-07-05T00:00:00.000Z')); // past expiresAt
    const store = new MemoryStore();
    await seed(store);
    const id = await seedPending(store);
    await ackPending(store, PROJECT, 'lina', id); // resolves it before the sweep writes

    const swept = await sweepExpired(store, PROJECT, Date.parse('2026-07-05T00:00:00.000Z'));
    expect(swept, 'a resolved proposal is not this pass to expire').toBe(0);
    expect((await readPending(store, id)).status).toBe('APPLIED');
  });

  it('CONTROL: the sweep still expires a genuinely stale PENDING row', async () => {
    // Without this the test above would pass against a sweep that expires nothing at all.
    __setNow(() => Date.parse('2026-07-05T00:00:00.000Z'));
    const store = new MemoryStore();
    await seed(store);
    const id = await seedPending(store);
    const swept = await sweepExpired(store, PROJECT, Date.parse('2026-07-05T00:00:00.000Z'));
    expect(swept).toBe(1);
    expect((await readPending(store, id)).status).toBe('EXPIRED');
  });

  it('CONTROL: an uncontended ack still applies — the guards are not refusing everything', async () => {
    __setNow(() => Date.parse('2026-07-02T00:00:00.000Z'));
    const store = new MemoryStore();
    await seed(store);
    const id = await seedPending(store);
    const out = await ackPending(store, PROJECT, 'lina', id);
    expect(out.status).toBe('APPLIED');
    expect(await targetValue(store)).toBe('after');
  });

  it('CONTROL: an uncontended reject still rejects', async () => {
    __setNow(() => Date.parse('2026-07-02T00:00:00.000Z'));
    const store = new MemoryStore();
    await seed(store);
    const id = await seedPending(store);
    expect((await rejectPending(store, PROJECT, 'lina', id)).status).toBe('REJECTED');
    expect(await targetValue(store)).toBe('before');
  });
});
