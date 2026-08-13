import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { TransactWrite } from '../src/store/configStore';
import { ConditionError } from '../src/store/configStore';
import { CHAIN_WRITE_ATTEMPTS, chainBackoff, record, transactWithAudit, __setChainSleep } from '../src/domain/audit';
import { exportAuditChain } from '../src/domain/auditQuery';
import { requestKey } from '../src/store/schema';

/**
 * PERF-11 — chain-head contention must stop reaching the user as a 409.
 *
 * Every mutation in a project CASes the same CHAINHEAD row, and every call site
 * used to attempt exactly TWICE before throwing `CHAIN_CONTENTION` at whoever
 * clicked approve. One writer wins each round, so with N concurrent writers the
 * last one needs N attempts: at N=3 the two-attempt budget starts failing ordinary
 * users, which is the availability ceiling the finding measured.
 *
 * The tests below deliberately do NOT assert "no contention happened" — contention
 * is the correct behaviour of a chain that cannot fork. They assert that contention
 * happened AND that nobody saw it, and that every entry that was attempted is in
 * the chain afterwards. That last part is the point: the cheap way to make 409s go
 * away is to drop the audit append under load, and for an evidence store that is
 * strictly worse than the error it hides.
 */
describe('PERF-11 — chain-head contention is absorbed, not surfaced', () => {
  afterEach(() => __setChainSleep(null));

  /** Yields the event loop inside `transact`, so concurrent appends interleave the way
   *  they do around a real store's awaits — and counts the CASes that actually lost. */
  class ContendedStore extends MemoryStore {
    conditionFailures = 0;
    override async transact(writes: TransactWrite[]): Promise<void> {
      await new Promise((r) => setTimeout(r, 0));
      try {
        return await super.transact(writes);
      } catch (e) {
        if (e instanceof ConditionError) this.conditionFailures++;
        throw e;
      }
    }
  }

  it('absorbs concurrent appends: every entry lands, nobody gets a 409', async () => {
    const store = new ContendedStore();
    const WRITERS = 6;

    const results = await Promise.allSettled(
      Array.from({ length: WRITERS }, (_, i) =>
        record(store, 'p', { action: 'concurrent-append', actor: `u${i}`, targetType: 'test', targetId: `t${i}` }),
      ),
    );

    // L-1 — assert the SETUP fired. If nothing ever lost the chain-head CAS this test
    // proves nothing at all: it would pass just as well against the unfixed two-attempt
    // code, and against a build with no retry whatever.
    expect(store.conditionFailures).toBeGreaterThan(0);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    // And the chain really holds all of them, still verifying. A "fix" that quietly
    // dropped the losing appends would satisfy the assertion above and fail this one.
    const doc = await exportAuditChain(store, 'p');
    expect(doc.count).toBe(WRITERS);
    expect(doc.entries).toHaveLength(WRITERS);
    expect(doc.verified).toBe(true);
    expect(new Set(doc.entries.map((e) => e.actor)).size).toBe(WRITERS);
  });

  it('absorbs contention on the folded domain+audit path too', async () => {
    const store = new ContendedStore();
    const WRITERS = 5;

    const results = await Promise.allSettled(
      Array.from({ length: WRITERS }, (_, i) => {
        const k = requestKey('p', `REQ${i}`);
        // Unguarded fresh-key writes only: a caller carrying its OWN `ifEquals` is
        // deliberately refused rather than replayed, and that separation is not this
        // finding's to change.
        const domain: TransactWrite[] = [{ kind: 'put', item: { ...k, status: 'DRAFT' }, ifNotExists: true }];
        return transactWithAudit(store, 'p', domain, {
          action: 'request-submit',
          actor: `u${i}`,
          targetType: 'request',
          targetId: `REQ${i}`,
        });
      }),
    );

    expect(store.conditionFailures).toBeGreaterThan(0); // L-1: the race really raced
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect((await exportAuditChain(store, 'p')).count).toBe(WRITERS);
  });

  it('spends a bounded budget and then reports contention rather than retrying forever', async () => {
    __setChainSleep(async () => {});
    let attempts = 0;
    class AlwaysContendedStore extends MemoryStore {
      override async transact(): Promise<void> {
        attempts++;
        throw new ConditionError('simulated permanent race');
      }
    }
    const store = new AlwaysContendedStore();
    await expect(record(store, 'p', { action: 'x', actor: 'a', targetType: 't', targetId: 'i' })).rejects.toMatchObject({
      code: 'CHAIN_CONTENTION',
    });
    // The budget is spent exactly once, and it is the NAMED budget — not a literal
    // that quietly stops matching the policy the moment someone tunes it.
    expect(attempts).toBe(CHAIN_WRITE_ATTEMPTS);
  });

  it('backs off with FULL jitter, so writers that collided do not re-collide in lockstep', async () => {
    const waits: number[] = [];
    __setChainSleep(async (ms) => {
      waits.push(ms);
    });

    for (let attempt = 0; attempt < CHAIN_WRITE_ATTEMPTS - 1; attempt++) {
      expect(await chainBackoff(attempt)).toBe(true);
    }
    // The last attempt has no successor — the caller must surface the failure.
    expect(await chainBackoff(CHAIN_WRITE_ATTEMPTS - 1)).toBe(false);

    expect(waits).toHaveLength(CHAIN_WRITE_ATTEMPTS - 1);
    // Every wait is a draw from [0, ceiling), never the ceiling itself: a fixed
    // back-off re-synchronises exactly the writers that just collided, so they sleep
    // in step and collide again. Two draws being identical is possible; all of them
    // being identical is what a non-jittered implementation produces.
    expect(new Set(waits).size).toBeGreaterThan(1);
    // Ceilings double per lost round and then stop doubling — an unbounded ceiling
    // would turn a busy project into multi-second request latency.
    const ceilings = waits.map((_, i) => Math.min(64, 2 * 2 ** i));
    waits.forEach((w, i) => {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(ceilings[i]!);
    });
  });
});
