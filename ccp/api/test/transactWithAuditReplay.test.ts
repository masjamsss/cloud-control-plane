import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { transactWithAudit } from '../src/domain/audit';
import { ApiError } from '../src/errors';

/**
 * CONC-2 — reject, link-pr and plan-summary wrote a full replacement request row through
 * `transactWithAudit` with no row condition, and the helper replayed those same
 * `domainWrites` on its internal retry.
 *
 * The retry exists for audit-chain contention, which any concurrent write to the same
 * PROJECT can trigger — not even the same request. So a write to request B could make the
 * helper replay a stale full-row snapshot of request A, silently discarding whatever had
 * landed on A in between.
 *
 * These tests pin the two halves:
 *   1. a guarded domain write is never replayed — the helper refuses instead;
 *   2. the unguarded `ifNotExists`-on-a-fresh-key case still retries, because that is
 *      what the helper was built for and replaying it is safe.
 */
describe('CONC-2 — transactWithAudit must not replay a guarded write', () => {
  const PROJECT = 'p1';
  const PK = `PROJ#${PROJECT}`;
  const SK = 'REQ#req-1';

  const entry = {
    action: 'request-reject',
    actor: 'alice',
    targetType: 'request',
    targetId: 'req-1',
  } as never;

  it('refuses rather than replaying a stale row when the guard fails', async () => {
    const store = new MemoryStore();
    await store.put({ PK, SK, status: 'AWAITING_APPROVAL', eventSeq: 0 });

    // The handler's read.
    const read = (await store.get(PK, SK))!;

    // Someone else lands first, moving the row.
    await store.put({ PK, SK, status: 'AWAITING_APPROVAL', eventSeq: 1, note: 'landed' });

    // The handler's write, computed from the stale read and guarded on it.
    const stale = { PK, SK, status: 'REJECTED', eventSeq: (read.eventSeq as number) + 1 };

    await expect(
      transactWithAudit(
        store,
        PROJECT,
        [{ kind: 'put', item: stale, ifEquals: { attr: 'eventSeq', value: read.eventSeq } }],
        entry,
      ),
    ).rejects.toBeInstanceOf(ApiError);

    // The row that actually landed must survive untouched — no replay, no rejection
    // written over it.
    const after = (await store.get(PK, SK))!;
    expect(after.status).toBe('AWAITING_APPROVAL');
    expect(after.note).toBe('landed');
    expect(after.eventSeq).toBe(1);
  });

  it('reports the refusal as a state conflict, not chain contention', async () => {
    const store = new MemoryStore();
    await store.put({ PK, SK, eventSeq: 5 });
    try {
      await transactWithAudit(
        store,
        PROJECT,
        [
          {
            kind: 'put',
            item: { PK, SK, eventSeq: 6 },
            ifEquals: { attr: 'eventSeq', value: 4 }, // never matches
          },
        ],
        entry,
      );
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      // The caller must be told its read was stale — telling it "chain contention" invites
      // a blind retry of the same stale row.
      expect((e as ApiError).code).toBe('STATE_CONFLICT');
    }
  });

  it('still retries an unguarded ifNotExists write, which is what the helper is for', async () => {
    const store = new MemoryStore();
    // A fresh-key write with no value guard: safe to replay, and must still succeed.
    const res = await transactWithAudit(
      store,
      PROJECT,
      [{ kind: 'put', item: { PK, SK: 'REQ#new' }, ifNotExists: true }],
      entry,
    );
    expect(res.id).toBeTruthy();
    expect(await store.get(PK, 'REQ#new')).not.toBeNull();
  });
});
