import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';
import { CHAIN_RETRY_ATTEMPTS, chainRetryDelayMs, record, type AuditEntryInput } from '../src/domain/audit';

/**
 * PERF-11 — the per-project chain head serialized every write and surfaced contention as a
 * user-facing 409 after a single retry.
 *
 * Every mutation in a project CASes the same `CHAINHEAD` row. That is the integrity choice
 * and it is the right one — a hash chain that could fork would not be evidence — but it
 * means concurrent mutations in one project collide routinely: between the head read and
 * the transact there are several awaits and, on `FileStore`, a whole snapshot write. Two
 * attempts is a very small budget against a window that wide. Three ordinary actors (two
 * approvers, plus the lazy-settle loop of somebody's `GET /requests`) were enough for the
 * third writer to lose twice and be handed `409 CHAIN_CONTENTION` for a normal approve
 * click.
 *
 * The direction to fail in is not in doubt — the finding says so, and the triage repeats
 * it: the chain is the product's evidence store, so a fix that DROPPED entries under load
 * would be worse than the 409. Retrying more is the safe direction: every one of these
 * loops re-reads the head and rebuilds its writes from scratch, so an extra attempt costs
 * one read and can never produce a duplicate or a stale write.
 *
 * The jitter is the part that is easy to get subtly wrong, so it has its own tests below.
 */

const PROJECT = 'sample';

describe('PERF-11 — concurrent writers on one project do not get 409s', () => {
  it('THE DEFECT: enough concurrent audited writes used to exhaust a 2-attempt budget', async () => {
    // Driven at `record` rather than through routes, because what is under test is the
    // chain-head CAS itself: N writers all reading the same head and racing to CAS it.
    // Under the old budget the third and later writers of a burst could lose twice.
    const store = new MemoryStore();
    const entry = (n: number): AuditEntryInput => ({ action: `act-${n}`, actor: 'a', targetType: 'session', targetId: `t-${n}` });

    const N = 12;
    const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => record(store, PROJECT, entry(i))));

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected, `all ${N} writers must land; ${rejected.length} were told the chain was busy`).toHaveLength(0);
  });

  it('THE PROPERTY THAT MUST NOT BREAK: every write actually landed, exactly once', async () => {
    // The failure mode a retry budget could introduce is worse than the one it fixes: an
    // entry written twice, or a chain whose count disagrees with its entries. A retry is
    // only safe because each attempt rebuilds from a fresh head — this asserts that held.
    const store = new MemoryStore();
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        record(store, PROJECT, { action: `act-${i}`, actor: 'a', targetType: 'session', targetId: `t-${i}` }),
      ),
    );

    const head = (await store.get(`P#${PROJECT}#AUDIT`, 'CHAINHEAD')) as { count: number } | null;
    expect(head?.count, 'the chain head counts every write').toBe(N);

    // The partition is derived from the entry's own `at`, so read the month the writes
    // actually landed in rather than a hardcoded one — a fixture that names the wrong
    // month reads as "no entries" and would pass this assertion for the wrong reason.
    const month = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    const entries = await store.query(`P#${PROJECT}#AUDIT#${month}`);
    expect(entries, 'and there are exactly that many entries — no duplicates from a replay').toHaveLength(N);
    expect(new Set(entries.map((e) => e.action)).size, 'each write is distinct').toBe(N);
  });

  it('a real burst of approvals through the ROUTES does not 409 anybody', async () => {
    // The user-visible shape the finding describes: several people acting on one project
    // at once. Each approve is an audited write against the same chain head.
    const store = new MemoryStore();
    await seed(store);
    await seedRequests(store, PROJECT, 'sari', 6, { status: 'AWAITING_CODE_REVIEW' });
    const app = createApp(store);
    const budi = await sessionCookieFor(store, 'budi');

    // Warm the one-time legacy settlement FIRST. Without this the burst races the
    // settlement rather than the approve write, and the test measures API-20 instead of
    // PERF-11 — the same trap the API-8 race test fell into. One request is enough.
    await app.request('/requests?scope=mine', { headers: { 'x-ccp-client': 'ccp-spa', cookie: budi, 'x-ccp-project': PROJECT } });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.request(`/requests/seed-sari-${i}/approve`, {
          method: 'POST',
          headers: { 'x-ccp-client': 'ccp-spa', cookie: budi, 'x-ccp-project': PROJECT },
        }),
      ),
    );

    const conflicts = results.filter((r) => r.status === 409);
    expect(conflicts, 'six concurrent approvals, zero "the audit chain is busy"').toHaveLength(0);
    expect(results.every((r) => r.status === 200), 'and they all actually approved').toBe(true);
  });

  it('the budget is still BOUNDED — this is not an unlimited retry loop', async () => {
    // A retry budget with no end is its own defect: a genuinely wedged chain would hang
    // the request instead of reporting. `test/audit.test.ts` pins the exact boundary
    // against the constant; this asserts the constant itself is a sane, finite number.
    expect(CHAIN_RETRY_ATTEMPTS).toBeGreaterThan(2);
    expect(CHAIN_RETRY_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe('PERF-11 — the backoff is FULL jitter, which is the part that matters', () => {
  it('THE SUBTLE WRONG FIX: a fixed backoff marches the losers into the next collision together', async () => {
    // Every loser of a collision is awake at the same instant by construction. Backing off
    // by a fixed amount re-synchronises them — the retry storm the backoff exists to
    // prevent, one tick later. Randomising the WHOLE interval is what spreads them, so a
    // delay that ignores its random source is not a smaller fix, it is the wrong one.
    const alwaysHalf = () => 0.5;
    const spread = new Set(Array.from({ length: 200 }, () => chainRetryDelayMs(3)));
    expect(spread.size, 'real calls must produce a SPREAD of delays, not one value').toBeGreaterThan(5);

    // And it is full jitter — random over [0, ceiling) — not ceiling ± a wobble.
    expect(chainRetryDelayMs(3, () => 0)).toBe(0);
    expect(chainRetryDelayMs(3, alwaysHalf)).toBeLessThan(chainRetryDelayMs(3, () => 0.99));
  });

  it('grows with the attempt and is capped', async () => {
    // Exponential so a busy chain is not hammered; capped so the last attempt is not a
    // multi-second stall on a request a human is waiting for.
    const ceiling = (n: number) => chainRetryDelayMs(n, () => 0.999) + 1;
    expect(ceiling(1)).toBeGreaterThan(ceiling(0));
    expect(ceiling(4)).toBeGreaterThan(ceiling(2));
    expect(ceiling(30), 'capped, not doubling forever into a hung request').toBeLessThanOrEqual(121);
  });

  it('never returns a negative or fractional delay', async () => {
    for (let a = 0; a < 8; a++) {
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const ms = chainRetryDelayMs(a, () => r);
        expect(Number.isInteger(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
