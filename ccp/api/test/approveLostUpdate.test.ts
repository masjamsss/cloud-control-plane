import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError, type TransactWrite } from '../src/store/configStore';

/**
 * CONC-1 — two reviewers approving the same request near-simultaneously silently lost a
 * signature, corrupting the quorum ledger.
 *
 * Both handlers read the request, each computed `approvals = [...req.approvals, mine]`
 * from that read, and each wrote the whole row back with an UNCONDITIONAL put. Last
 * writer won, and the first signature vanished — on a 2-of-N request that can also leave
 * the ladder permanently unsatisfiable.
 *
 * These tests work at the store seam, which is where the defect lives: the missing
 * primitive was a conditional whole-row put. The first test fails without
 * `ifEquals` on `put` — with an unguarded put both writes succeed and the ledger ends up
 * with one approval instead of two.
 */
describe('CONC-1 — guarded whole-row put', () => {
  const PK = 'PROJ#p1';
  const SK = 'REQ#req-1';

  const seed = async (): Promise<MemoryStore> => {
    const store = new MemoryStore();
    await store.put({ PK, SK, status: 'AWAITING_APPROVAL', approvals: [], eventSeq: 0 });
    return store;
  };

  const approveWrite = (
    approvals: Array<{ user: string }>,
    readSeq: number | undefined,
    guarded: boolean,
  ): TransactWrite => {
    const item = { PK, SK, status: 'AWAITING_APPROVAL', approvals, eventSeq: (readSeq ?? 0) + 1 };
    return guarded ? { kind: 'put', item, ifEquals: { attr: 'eventSeq', value: readSeq } } : { kind: 'put', item };
  };

  it('refuses the second writer when the row moved, instead of losing the signature', async () => {
    const store = await seed();
    // Both reviewers read the same pre-image.
    const a = (await store.get(PK, SK))!;
    const b = (await store.get(PK, SK))!;
    expect(a.eventSeq).toBe(b.eventSeq);

    // Reviewer A lands first.
    await store.transact([approveWrite([{ user: 'alice' }], a.eventSeq as number, true)]);

    // Reviewer B computed from the STALE read. Guarded, this must be refused.
    await expect(
      store.transact([approveWrite([{ user: 'bob' }], b.eventSeq as number, true)]),
    ).rejects.toBeInstanceOf(ConditionError);

    const after = (await store.get(PK, SK))!;
    expect(after.approvals).toEqual([{ user: 'alice' }]);
    expect(after.eventSeq).toBe(1);
  });

  it('demonstrates the defect: an UNGUARDED put silently loses the first signature', async () => {
    const store = await seed();
    const a = (await store.get(PK, SK))!;
    const b = (await store.get(PK, SK))!;

    await store.transact([approveWrite([{ user: 'alice' }], a.eventSeq as number, false)]);
    await store.transact([approveWrite([{ user: 'bob' }], b.eventSeq as number, false)]);

    // Alice's approval is gone. This is the corruption the guard prevents, pinned here so
    // the difference between the two paths is a test rather than an argument.
    const after = (await store.get(PK, SK))!;
    expect(after.approvals).toEqual([{ user: 'bob' }]);
  });

  it('a guarded put fails closed against a deleted row', async () => {
    const store = await seed();
    const read = (await store.get(PK, SK))!;
    await store.delete(PK, SK);
    // DynamoDB fails a ConditionExpression against a missing item; a guarded put must not
    // resurrect a row deleted between the read and the write.
    await expect(
      store.transact([approveWrite([{ user: 'alice' }], read.eventSeq as number, true)]),
    ).rejects.toBeInstanceOf(ConditionError);
    expect(await store.get(PK, SK)).toBeNull();
  });

  it('applies NOTHING when a guarded put fails inside a multi-write batch', async () => {
    const store = await seed();
    const read = (await store.get(PK, SK))!;
    await store.transact([approveWrite([{ user: 'alice' }], read.eventSeq as number, true)]);

    await expect(
      store.transact([
        { kind: 'put', item: { PK, SK: 'AUDIT#1', note: 'should not land' } },
        approveWrite([{ user: 'bob' }], read.eventSeq as number, true),
      ]),
    ).rejects.toBeInstanceOf(ConditionError);

    // All-or-nothing: the audit row must not exist.
    expect(await store.get(PK, 'AUDIT#1')).toBeNull();
  });

  it('still honours ifNotExists on put', async () => {
    const store = await seed();
    await expect(
      store.transact([{ kind: 'put', item: { PK, SK }, ifNotExists: true }]),
    ).rejects.toBeInstanceOf(ConditionError);
  });
});
