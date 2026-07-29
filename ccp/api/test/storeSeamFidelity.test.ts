import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError, type Item } from '../src/store/configStore';
import { deepEquals } from '../src/store/clone';
import { createApp } from '../src/index';
import { seed, sessionCookieFor } from './helpers/seed';

/**
 * API-17 / DATA-14 / DATA-15 — the store seam's divergences from the DynamoDB semantics it
 * exists to mirror.
 *
 * The seam's stated goal is that a test passing against `MemoryStore` is a true statement
 * about the deployed backend. Where it quietly differs, that stops being true, and the
 * discovery happens in production. The two reports list the same divergences from two
 * angles; this file is the one place they are all pinned.
 *
 * Two were TRAPS and are now closed:
 *
 *  - `ifEquals` compared with `!==`, i.e. reference identity for objects. The store hands
 *    out CLONES, so the first caller to guard on an object or array would get a condition
 *    that can never pass — comparing its own copy against the store's original.
 *    `domain/settlement.ts` already writes that shape; it works only because the legacy
 *    rows it targets have no `roles` map yet.
 *  - `transact` accepted two writes to the same key (applying them last-wins, silently
 *    discarding one) and had no 100-action bound. DynamoDB rejects both outright.
 *
 * Three are CONVENTIONS this codebase depends on, and are now written into the
 * `ConfigStore` contract so a DynamoDB adapter must implement them rather than merely
 * permit them: `ifEquals: {value: undefined}` meaning "attribute absent",
 * `set: {attr: undefined}` meaning REMOVE, and the `GSI1SK`-falls-back-to-`SK` projection.
 * The tests below pin the BEHAVIOUR each convention relies on, so an adapter can be held
 * to them.
 *
 * DATA-15's first half — the `PK + ' ' + SK` composite key being aliasable — was already
 * closed (the separator is NUL). Its second half, arbitrary client bytes reaching a PK
 * through `idempotencyKey`, is closed here at the edge.
 */

const row = (pk: string, sk: string, extra: Record<string, unknown> = {}): Item => ({ PK: pk, SK: sk, ...extra });

describe('API-17 — `ifEquals` compares VALUES, not references', () => {
  it('THE TRAP: a guard on an object could never pass, because the store hands out clones', async () => {
    const store = new MemoryStore();
    const roles = { sample: { role: 'lead', teamId: 'platform' } };
    await store.put(row('ACC#lina', 'META', { roles }));

    // Exactly what `domain/settlement.ts` does: read the row, guard on the value read.
    const read = (await store.get('ACC#lina', 'META'))!;
    await expect(
      store.transact([
        { kind: 'update', pk: 'ACC#lina', sk: 'META', set: { bound: true }, ifEquals: { attr: 'roles', value: read.roles } }],
      ),
      'the guard must pass — it is the same VALUE, even though it is a different object',
    ).resolves.toBeUndefined();

    expect((await store.get('ACC#lina', 'META'))!.bound).toBe(true);
  });

  it('and still REFUSES when the value genuinely differs', async () => {
    // The complement: value equality must not become "anything object-shaped passes".
    const store = new MemoryStore();
    await store.put(row('ACC#lina', 'META', { roles: { sample: { role: 'lead' } } }));

    await expect(
      store.transact([
        { kind: 'update', pk: 'ACC#lina', sk: 'META', set: { bound: true }, ifEquals: { attr: 'roles', value: { sample: { role: 'requester' } } } },
      ]),
    ).rejects.toBeInstanceOf(ConditionError);
  });

  it('deepEquals: key order is insignificant, but an explicit-undefined key is not an absent one', () => {
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 }), 'a JSON snapshot need not preserve insertion order').toBe(true);
    expect(deepEquals([1, [2, { c: 3 }]], [1, [2, { c: 3 }]])).toBe(true);
    expect(deepEquals([1, 2], [2, 1]), 'arrays ARE ordered').toBe(false);
    expect(deepEquals({ a: undefined }, {}), 'set-to-null and absent are different things in DynamoDB').toBe(false);
    expect(deepEquals(undefined, undefined)).toBe(true);
    expect(deepEquals(null, undefined)).toBe(false);
    expect(deepEquals(1, '1')).toBe(false);
  });
});

describe('API-17 / DATA-14 — `transact` rejects what DynamoDB rejects', () => {
  it('THE TRAP: two actions on the same item used to apply last-wins, silently dropping one', async () => {
    // A lost update produced by the very mechanism that exists to prevent lost updates.
    const store = new MemoryStore();
    await store.put(row('P#sample#REQ#r1', 'META', { n: 0 }));

    await expect(
      store.transact([
        { kind: 'update', pk: 'P#sample#REQ#r1', sk: 'META', set: { a: 1 } },
        { kind: 'update', pk: 'P#sample#REQ#r1', sk: 'META', set: { b: 2 } },
      ]),
    ).rejects.toThrow(/same item/);

    const after = (await store.get('P#sample#REQ#r1', 'META'))!;
    expect(after.a, 'all-or-nothing: NEITHER write landed').toBeUndefined();
    expect(after.b).toBeUndefined();
  });

  it('catches the duplicate across DIFFERENT action kinds too', async () => {
    const store = new MemoryStore();
    await store.put(row('X', 'Y'));
    await expect(
      store.transact([
        { kind: 'put', item: row('X', 'Y', { v: 1 }) },
        { kind: 'delete', pk: 'X', sk: 'Y' },
      ]),
    ).rejects.toThrow(/same item/);
  });

  it('is NOT a ConditionError — a duplicate key is a bug, and callers retry ConditionErrors', async () => {
    // This distinction is the load-bearing part. Every retry loop in the codebase treats
    // ConditionError as "someone got there first"; dressing a programming error as
    // contention would bury it in a retry loop forever.
    const store = new MemoryStore();
    await store.transact([{ kind: 'put', item: row('A', 'B') }]);
    const err = await store
      .transact([
        { kind: 'update', pk: 'A', sk: 'B', set: { a: 1 } },
        { kind: 'update', pk: 'A', sk: 'B', set: { b: 2 } },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConditionError);
  });

  it('rejects a batch over the 100-action TransactWriteItems limit', async () => {
    const store = new MemoryStore();
    const writes = Array.from({ length: 101 }, (_, i) => ({ kind: 'put' as const, item: row('P', `S#${i}`) }));
    await expect(store.transact(writes)).rejects.toThrow(/exceeds the 100-item/);

    // 100 exactly is fine — an off-by-one here would break real callers.
    await expect(store.transact(writes.slice(0, 100))).resolves.toBeUndefined();
  });

  it('distinct keys in one batch are unaffected — the check must not break ordinary batches', async () => {
    const store = new MemoryStore();
    await expect(
      store.transact([
        { kind: 'put', item: row('P', 'S#1') },
        { kind: 'put', item: row('P', 'S#2') },
        { kind: 'update', pk: 'P', sk: 'S#1', set: { x: 1 } },
      ]),
      'a put and an update of the SAME key is still two actions on one item',
    ).rejects.toThrow(/same item/);

    // Same PK, different SK: different items, and a perfectly ordinary batch.
    await expect(
      store.transact([
        { kind: 'put', item: row('P', 'S#1') },
        { kind: 'put', item: row('P', 'S#2') },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe('DATA-14 — the three conventions a DynamoDB adapter must implement', () => {
  it('CONVENTION 1: `ifEquals {value: undefined}` means the attribute is ABSENT', async () => {
    // settlement.ts binds a legacy row only while it still has no `roles` map. An adapter
    // emitting `roles = :undefined` instead of `attribute_not_exists(roles)` would break
    // this — so the behaviour is pinned here, on the seam, for it to be held to.
    const store = new MemoryStore();
    await store.put(row('ACC#bare', 'META', { id: 'bare' }));

    await expect(
      store.transact([{ kind: 'update', pk: 'ACC#bare', sk: 'META', set: { roles: { sample: {} } }, ifEquals: { attr: 'roles', value: undefined } }]),
      'absent attribute + undefined guard = pass',
    ).resolves.toBeUndefined();

    await expect(
      store.transact([{ kind: 'update', pk: 'ACC#bare', sk: 'META', set: { x: 1 }, ifEquals: { attr: 'roles', value: undefined } }]),
      'and once it is present the guard must FAIL — that is the whole point',
    ).rejects.toBeInstanceOf(ConditionError);
  });

  it('CONVENTION 2: `undefined` in `set` REMOVES the attribute and its index placement', async () => {
    // dualControl takes a terminal proposal OUT of the pending index this way. Implemented
    // as a SET of null, the row would stay indexed and every sweep would keep finding it.
    const store = new MemoryStore();
    await store.put(row('P#sample#PROP#p1', 'META', { status: 'PENDING', GSI1PK: 'PENDING#sample', GSI1SK: 'p1' }));
    expect(await store.queryGSI1('PENDING#sample')).toHaveLength(1);

    await store.transact([{ kind: 'update', pk: 'P#sample#PROP#p1', sk: 'META', set: { status: 'APPLIED', GSI1PK: undefined } }]);

    expect(await store.queryGSI1('PENDING#sample'), 'the row must leave the index, not linger in it').toHaveLength(0);
    expect((await store.get('P#sample#PROP#p1', 'META'))!.status, 'while the row itself survives').toBe('APPLIED');
  });

  it('CONVENTION 3: an indexed row with no GSI1SK sorts by its own SK and is RETURNED', async () => {
    // A real composite-key GSI omits such rows entirely. Pinning it means an adapter author
    // is told to project a GSI1SK for every indexed row rather than discovering that a list
    // endpoint silently lost items.
    const store = new MemoryStore();
    await store.put(row('P#sample#X', 'B', { GSI1PK: 'IDX' }));
    await store.put(row('P#sample#X', 'A', { GSI1PK: 'IDX' }));
    await store.put(row('P#sample#X', 'C', { GSI1PK: 'IDX', GSI1SK: 'A0' }));

    // Sort keys in play: 'A' (SK fallback), 'A0' (the explicit GSI1SK of the row whose
    // SK is 'C'), 'B' (SK fallback). Ascending: A < A0 < B.
    const got = await store.queryGSI1('IDX');
    expect(got.map((r) => r.SK), 'all three present, ordered by the effective sort key').toEqual(['A', 'C', 'B']);
  });
});

describe('DATA-15 — client bytes cannot reach a partition key unconstrained', () => {
  /** A submit body that is otherwise VALID, so the only thing under test is the key. */
  const DRAFT = {
    operationId: 'ebs-grow',
    targetAddress: 'aws_ebs_volume.dwh01',
    params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
    justification: 'grow the volume to 250 GiB for month-end load',
    schedule: { kind: 'now' as const },
  };

  const submit = async (app: ReturnType<typeof createApp>, cookie: string, idempotencyKey: string) =>
    app.request('/requests', {
      method: 'POST',
      headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample', 'content-type': 'application/json' },
      body: JSON.stringify({ ...DRAFT, idempotencyKey }),
    });

  it('THE CONTROL: a good key really does submit — otherwise this suite proves nothing', async () => {
    // The first draft of these tests used an invalid body, so EVERY submit returned 422
    // and both tests below passed against the unfixed code. L-1, caught by the negative
    // test. This assertion is what makes the refusals below mean something.
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), 'good-key-1');
    expect(res.status, 'a valid submit with a clean key is created').toBe(201);
  });

  it('THE DEFECT: a key carrying the store\'s own delimiters used to be accepted into a PK', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const cookie = await sessionCookieFor(store, 'sari');

    // Written as ESCAPES, never literal control bytes: a raw NUL would make this file
    // `data` to git and grep, and the store's own separator comment says why that matters.
    const bad = ['a#b', 'a b', 'a\u0000b', 'a\nb', 'P#sample#REQ#x', 'a/b'];
    for (const key of bad) {
      const res = await submit(app, cookie, key);
      expect(res.status, `${JSON.stringify(key)} must be refused at the edge`).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('ordinary opaque tokens still work — a uuid, a ulid, a nonce', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const cookie = await sessionCookieFor(store, 'sari');

    for (const ok of ['3f9a1c2e-4b5d-6789-abcd-ef0123456789', '01J0000000000000000000000A', 'req_client.42:v1']) {
      const res = await submit(app, cookie, ok);
      expect(res.status, `${ok} is a perfectly good idempotency key`).toBe(201);
    }
  });
});
