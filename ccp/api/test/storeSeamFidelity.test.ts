import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError, SeamViolationError, MAX_TRANSACT_WRITES, KEY_SEPARATOR, type Item, type TransactWrite } from '../src/store/configStore';
import * as S from '../src/store/schema';

/**
 * API-17 / DATA-14 / DATA-15 — the seam's job is to make a local pass PREDICT a
 * deployed one. Every case here is a write this store used to accept and DynamoDB
 * would have refused, indexed differently, or evaluated to a different answer; the
 * divergence is invisible precisely because the local run stays green.
 *
 * Keys are always built with the real key helpers (never hand-typed) so a fixture
 * cannot pass by describing a partition nothing writes to.
 */

const ULID = '01J0000000000000000000000A';

describe('API-17 (a) — ifEquals compares attribute VALUES, not references', () => {
  it('a guard captured from a read of an object-valued attribute still matches', async () => {
    const store = new MemoryStore();
    const k = S.accountKey('sari');
    const roles = { sample: { role: 'lead', teamId: 'platform' } };
    await store.put({ ...k, id: 'sari', roles });

    // The captured value comes from a READ, which is a deep clone — never the stored
    // object. Under reference equality this guard could not pass no matter what the
    // data said, which is the trap: the write fails as if it had lost a race.
    const captured = (await store.get(k.PK, k.SK))!.roles;
    expect(captured).not.toBe(roles); // L-1: prove the clone happened, or the test proves nothing
    expect(captured).toEqual(roles);

    await store.transact([
      { kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'active' }, ifEquals: { attr: 'roles', value: captured } },
    ]);
    expect((await store.get(k.PK, k.SK))?.status).toBe('active');
  });

  it('a guard on a DIFFERENT object value still fails closed', async () => {
    const store = new MemoryStore();
    const k = S.accountKey('budi');
    await store.put({ ...k, roles: { sample: { role: 'lead' } } });
    await expect(
      store.transact([
        { kind: 'update', pk: k.PK, sk: k.SK, set: { x: 1 }, ifEquals: { attr: 'roles', value: { sample: { role: 'requester' } } } },
      ]),
    ).rejects.toBeInstanceOf(ConditionError);
  });

  it('list order is significant, map key order is not — DynamoDB L vs M', async () => {
    const store = new MemoryStore();
    const k = S.teamKey('sample', 'app-platform');
    await store.put({ ...k, serviceSlugs: ['ec2', 'ebs'], meta: { a: 1, b: 2 } });
    const ok: TransactWrite = { kind: 'update', pk: k.PK, sk: k.SK, set: { n: 1 }, ifEquals: { attr: 'meta', value: { b: 2, a: 1 } } };
    await store.transact([ok]); // same map, different key order → equal
    await expect(
      store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { n: 2 }, ifEquals: { attr: 'serviceSlugs', value: ['ebs', 'ec2'] } }]),
    ).rejects.toBeInstanceOf(ConditionError); // same members, different order → NOT equal
  });
});

describe('API-17 (b) / DATA-14 (1) — transact mirrors TransactWriteItems limits', () => {
  it('refuses two writes aimed at the same item instead of applying both last-wins', async () => {
    const store = new MemoryStore();
    const k = S.requestKey('sample', ULID);
    await store.put({ ...k, id: ULID, status: 'SUBMITTED' });
    const dup = store.transact([
      { kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'APPROVED' } },
      { kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'CANCELLED' } },
    ]);
    await expect(dup).rejects.toBeInstanceOf(SeamViolationError);
    await expect(dup).rejects.toThrow(/more than one action on the same item/);
    // …and nothing landed: the refusal is a rejected batch, not a partial one.
    expect((await store.get(k.PK, k.SK))?.status).toBe('SUBMITTED');
  });

  it('refuses a batch longer than the 100-action limit, and accepts exactly 100', async () => {
    const store = new MemoryStore();
    const writes = (n: number): TransactWrite[] =>
      Array.from({ length: n }, (_, i) => ({ kind: 'put', item: { ...S.eventKey('sample', ULID, i), n: i } }) as TransactWrite);
    await store.transact(writes(MAX_TRANSACT_WRITES));
    await expect(store.transact(writes(MAX_TRANSACT_WRITES + 1))).rejects.toBeInstanceOf(SeamViolationError);
  });
});

describe('DATA-14 (2) — `ifEquals: { value: undefined }` is the seam spelling of attribute_not_exists', () => {
  const k = S.accountKey('lina');
  const guard = { attr: 'roles', value: undefined };

  it('passes when the attribute is ABSENT (the settlement roles guard)', async () => {
    const store = new MemoryStore();
    await store.put({ ...k, id: 'lina' }); // bare row, no `roles`
    await store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { roles: { sample: { role: 'lead' } } }, ifEquals: guard }]);
    expect((await store.get(k.PK, k.SK))?.roles).toEqual({ sample: { role: 'lead' } });
  });

  it('fails when the attribute is PRESENT — including when it is present and falsy', async () => {
    const store = new MemoryStore();
    await store.put({ ...k, id: 'lina', roles: {} });
    await expect(
      store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { x: 1 }, ifEquals: guard }]),
    ).rejects.toBeInstanceOf(ConditionError);
  });

  it('fails when the ITEM is missing — an adapter owes `attribute_not_exists(attr) AND attribute_exists(PK)`', async () => {
    const store = new MemoryStore();
    await expect(
      store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { x: 1 }, ifEquals: guard }]),
    ).rejects.toBeInstanceOf(ConditionError);
    expect(await store.get(k.PK, k.SK)).toBeNull(); // no ghost row conditioned into existence
  });
});

describe('DATA-14 (3) — clearing an attribute is REMOVE; SET-to-undefined is refused', () => {
  const k = S.configChangeKey('sample', ULID);
  const open = (): Item => ({ ...k, id: ULID, status: 'PENDING', GSI1PK: S.pendingConfigGsi('sample'), GSI1SK: ULID });

  it('remove drops the attribute and takes the row out of GSI1', async () => {
    const store = new MemoryStore();
    await store.put(open());
    expect(await store.queryGSI1(S.pendingConfigGsi('sample'))).toHaveLength(1);
    await store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'APPLIED' }, remove: ['GSI1PK'] }]);
    expect(await store.queryGSI1(S.pendingConfigGsi('sample'))).toEqual([]);
    const row = (await store.get(k.PK, k.SK))!;
    expect(row.status).toBe('APPLIED');
    expect('GSI1PK' in row).toBe(false); // GONE, not present-and-undefined
  });

  it('a removal survives the snapshot round trip that a stored proposal takes', async () => {
    // The reason this matters beyond seam purity: an ApplySpec is STORED on the pending
    // row and replayed at ack. `undefined` does not survive JSON, so the old idiom came
    // back from disk with the key simply missing and the ack silently cleared nothing.
    const spec = { op: 'update', pk: k.PK, sk: k.SK, set: { status: 'APPLIED' }, remove: ['GSI1PK'] };
    const legacy = { op: 'update', pk: k.PK, sk: k.SK, set: { status: 'APPLIED', GSI1PK: undefined } };
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
    expect('GSI1PK' in (JSON.parse(JSON.stringify(legacy)) as { set: object }).set).toBe(false);
  });

  it('refuses set: { attr: undefined } and names the attribute', async () => {
    const store = new MemoryStore();
    await store.put(open());
    const bad = store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'APPLIED', GSI1PK: undefined } }]);
    await expect(bad).rejects.toBeInstanceOf(SeamViolationError);
    await expect(bad).rejects.toThrow(/set\.GSI1PK is undefined/);
    expect((await store.get(k.PK, k.SK))?.status).toBe('PENDING'); // batch aborted whole
  });
});

describe('DATA-14 (4) — GSI1 is a composite-key index: half a key is not a member', () => {
  it('refuses a put that sets GSI1PK without GSI1SK', async () => {
    const store = new MemoryStore();
    const bad = store.put({ ...S.requestKey('sample', ULID), GSI1PK: S.requestCollectionGsi('sample') });
    await expect(bad).rejects.toBeInstanceOf(SeamViolationError);
    await expect(bad).rejects.toThrow(/composite-key index/);
  });

  it('refuses an update that would leave a row with GSI1PK and no GSI1SK', async () => {
    const store = new MemoryStore();
    const k = S.scanJobKey('sample', 'job1');
    await store.put({ ...k, jobId: 'job1' });
    await expect(
      store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { GSI1PK: S.scanJobQueueGsi() } }]),
    ).rejects.toBeInstanceOf(SeamViolationError);
    expect(await store.queryGSI1(S.scanJobQueueGsi())).toEqual([]);
  });

  it('a stale GSI1SK with no GSI1PK is fine — membership follows GSI1PK in both stores', async () => {
    const store = new MemoryStore();
    const k = S.configChangeKey('sample', ULID);
    await store.put({ ...k, GSI1PK: S.pendingConfigGsi('sample'), GSI1SK: ULID });
    await store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'APPLIED' }, remove: ['GSI1PK'] }]);
    expect(await store.queryGSI1(S.pendingConfigGsi('sample'))).toEqual([]);
    expect((await store.get(k.PK, k.SK))?.GSI1SK).toBe(ULID);
  });
});

describe('DATA-15 — a key can never carry the composite-key separator', () => {
  const store = (): MemoryStore => new MemoryStore();

  it('refuses the aliasing pair rather than letting one row overwrite the other', async () => {
    // Without the guard these two DISTINCT rows share one stored key:
    //   ('A' + SEP + 'B', 'C')  vs  ('A', 'B' + SEP + 'C')
    const s = store();
    const left: Item = { PK: `A${KEY_SEPARATOR}B`, SK: 'C', which: 'left' };
    const right: Item = { PK: 'A', SK: `B${KEY_SEPARATOR}C`, which: 'right' };
    expect(`${left.PK}${KEY_SEPARATOR}${left.SK}`).toBe(`${right.PK}${KEY_SEPARATOR}${right.SK}`); // the collision, made explicit
    await expect(s.put(left)).rejects.toBeInstanceOf(SeamViolationError);
    await expect(s.put(right)).rejects.toBeInstanceOf(SeamViolationError);
  });

  it('refuses an empty or non-string key component (DynamoDB rejects both)', async () => {
    const s = store();
    await expect(s.put({ PK: '', SK: 'META' })).rejects.toThrow(/must not be empty/);
    await expect(s.put({ PK: 'ACCOUNT#x', SK: '' })).rejects.toThrow(/must not be empty/);
    await expect(s.put({ SK: 'META' } as unknown as Item)).rejects.toThrow(/PK must be a string/);
    await expect(s.put({ PK: 'ACCOUNT#x' } as unknown as Item)).rejects.toThrow(/SK must be a string/);
  });

  it('the guard covers every write verb, not just put', async () => {
    const s = store();
    const pk = `P#sample#REQ#${KEY_SEPARATOR}`;
    await expect(s.transact([{ kind: 'put', item: { PK: pk, SK: 'META' } }])).rejects.toBeInstanceOf(SeamViolationError);
    await expect(s.transact([{ kind: 'update', pk, sk: 'META', set: { a: 1 } }])).rejects.toBeInstanceOf(SeamViolationError);
    await expect(s.transact([{ kind: 'delete', pk, sk: 'META' }])).rejects.toBeInstanceOf(SeamViolationError);
  });
});

describe('DATA-15 — the idempotency PK stays unambiguous whatever the client sends', () => {
  it('the (actor, key) join is injective because the key cannot contain #', () => {
    // The attack, spelled out: without a charset, actor `sari` + key `budi#x` builds the
    // SAME partition key as actor `sari#budi` + key `x` — one account writing into (and
    // reading) another's idempotency slot. The builder refuses the key that makes the
    // two spellings meet, so the collision is not constructible rather than merely rare.
    const collide = (): unknown => S.requestIdempotencyKey('sample', 'sari', 'budi#x');
    expect(collide).toThrow(/not a safe key component/);
    expect(S.requestIdempotencyKey('sample', 'sari#budi', 'x').PK).toBe('P#sample#IDEMPOTENCY#sari#budi#x');
  });

  it('rejects every key shape that could reach a key builder from the wire', () => {
    for (const bad of ['a b', 'a#b', `a${KEY_SEPARATOR}b`, 'a\nb', '', 'x'.repeat(201), 'ünïcode']) {
      expect(S.IDEMPOTENCY_KEY_RE.test(bad)).toBe(false);
    }
    for (const good of ['01J0000000000000000000000A', 'a-b_c.d:e', 'x'.repeat(200)]) {
      expect(S.IDEMPOTENCY_KEY_RE.test(good)).toBe(true);
    }
  });
});
