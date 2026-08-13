import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { AccountItem, ProjectItem } from '../src/store/schema';
import { accountKey, projectKey, settlementKey } from '../src/store/schema';
import { runSettlement } from '../src/domain/settlement';
import { seed, sessionCookieFor, SAMPLE_PROJECT_ID } from './helpers/seed';
import { writeRacingStore } from './helpers/racingStore';

/**
 * CONC-13 — concurrent first-boot settlement escaped its own race handling.
 *
 * `runSettlement` acknowledges in a comment that two callers can both see "no marker" and
 * both start, and catches the loser's failure so the race is tolerated. But it caught only
 * `ConditionError`, which is what the LAST write of the pass throws (the marker's own
 * `ifNotExists`, written directly through the store). The two writes BEFORE it —
 * retro-registering the legacy project and materializing each bare account row — go
 * through `transactWithAudit`, which converts a refusal into an `ApiError`. So a loser that
 * lost at either of those steps escaped the very catch written to tolerate it, and the
 * early request that triggered settlement got a 500.
 *
 * Settlement runs from `withProject` on EVERY request until the marker lands, so the
 * window is exactly the traffic a cold instance is least able to explain away.
 */

const hdrs = (cookie: string): Record<string, string> => ({ cookie, 'x-ccp-project': SAMPLE_PROJECT_ID, 'x-ccp-client': 'ccp-spa' });

/** A bare (pre-multi-project) account row is what settlement materializes. */
const isBare = (a: AccountItem): boolean => !a.roles;

describe('CONC-13 — a settlement pass that loses its race does not fail the request', () => {
  it('THE RACE at MATERIALIZE: the loser returns normally instead of throwing', async () => {
    const store = new MemoryStore();
    await seed(store);
    // L-1: settlement must have real work to do, or "it did not throw" is vacuous.
    const before = (await store.query(accountKey('sari').PK)) as unknown as AccountItem[];
    expect(before.some(isBare), 'the seeded rows must be bare, or there is nothing to materialize').toBe(true);

    // The loser reaches its first account write; a COMPLETE competing settlement lands in
    // that window, so the loser's `ifEquals roles: undefined` guard is already false.
    const racing = writeRacingStore(
      store,
      (ws) => ws.some((w) => w.kind === 'update' && w.pk.startsWith('ACCOUNT#')),
      async () => {
        await runSettlement(store);
      },
    );

    await expect(runSettlement(racing)).resolves.toBeDefined();
    expect(racing.fired(), 'the interleave must have fired, or this test proves nothing').toBe(true);

    // …and the estate really is settled: the winner's work stands.
    const k = settlementKey();
    expect(await store.get(k.PK, k.SK), 'the marker must be stamped').not.toBeNull();
    const after = (await store.get(accountKey('sari').PK, accountKey('sari').SK)) as unknown as AccountItem;
    expect(after.roles, 'the winner materialized the roles map').toBeDefined();
  });

  it('THE RACE at RETRO-REGISTER: the loser returns normally there too', async () => {
    // The other audited write in the pass, and the one that is NOT value-guarded — it is
    // an `ifNotExists` on the legacy project row, so before the fix it surfaced as
    // CHAIN_CONTENTION rather than STATE_CONFLICT. Both escaped the catch.
    const store = new MemoryStore();
    await seed(store);
    const pk = projectKey(SAMPLE_PROJECT_ID);
    expect(await store.get(pk.PK, pk.SK), 'no registry row yet — retro-register has work').toBeNull();

    const racing = writeRacingStore(
      store,
      (ws) => ws.some((w) => w.kind === 'put' && w.item.PK === pk.PK && w.item.SK === pk.SK),
      async () => {
        await runSettlement(store);
      },
    );

    await expect(runSettlement(racing)).resolves.toBeDefined();
    expect(racing.fired()).toBe(true);
    expect((await store.get(pk.PK, pk.SK)) as unknown as ProjectItem).not.toBeNull();
  });

  it('THE SYMPTOM: an early request during a concurrent first boot is answered, not 500ed', async () => {
    // The finding's actual impact. `ensureSettlement` runs from the session middleware, so
    // the loser's escape landed on a user's very first request against a cold instance.
    const store = new MemoryStore();
    await seed(store);
    const cookie = await sessionCookieFor(store, 'putra');

    const racing = writeRacingStore(
      store,
      (ws) => ws.some((w) => w.kind === 'update' && w.pk.startsWith('ACCOUNT#')),
      async () => {
        await runSettlement(store);
      },
    );

    const res = await createApp(racing).request('/requests?scope=mine', { headers: hdrs(cookie) });
    expect(racing.fired(), 'settlement must have raced during this request').toBe(true);
    expect(res.status, 'a lost settlement race is not this request’s problem').toBe(200);
  });

  it('does NOT claim settled when the marker is absent — a half-settled store re-attempts', async () => {
    // The finding's own recommendation is "also catch CHAIN_CONTENTION", and taken
    // literally that is incomplete: the pass caches `confirmedSettled` on the way out, so
    // swallowing a failure that stamped no marker would make `ensureSettlement`
    // short-circuit for the rest of the process's life on a store that is genuinely
    // half-settled — with no marker for a restart to notice either. The re-read of the
    // marker is what makes the fail-open safe.
    const store = new MemoryStore();
    await seed(store);

    // A competitor that materializes ONE account row and stops: enough to make the
    // loser's guard fail, not enough to finish the pass or stamp the marker.
    const k = accountKey('sari');
    const sari = (await store.get(k.PK, k.SK)) as unknown as AccountItem;
    const racing = writeRacingStore(
      store,
      (ws) => ws.some((w) => w.kind === 'update' && w.pk === k.PK),
      async () => {
        await store.put({ ...sari, roles: { [SAMPLE_PROJECT_ID]: { role: sari.role!, teamId: sari.teamId! } } } as never);
      },
    );

    await expect(runSettlement(racing)).resolves.toBeDefined();
    expect(racing.fired()).toBe(true);
    const mk = settlementKey();
    expect(await store.get(mk.PK, mk.SK), 'no marker — nobody finished the pass').toBeNull();

    // The next pass completes it. If the aborted pass had cached "settled", the only way
    // back would have been a process restart.
    const second = await runSettlement(store);
    expect(second).toBeDefined();
    expect(await store.get(mk.PK, mk.SK), 'the re-attempt stamps the marker').not.toBeNull();
    const budi = (await store.get(accountKey('budi').PK, accountKey('budi').SK)) as unknown as AccountItem;
    expect(budi.roles, 'and finishes the rows the aborted pass never reached').toBeDefined();
  });

  it('CONTROL: an uncontended settlement still settles everything exactly once', async () => {
    const store = new MemoryStore();
    await seed(store);
    const first = await runSettlement(store);
    expect(first.accountsMaterialized, 'the seeded bare rows must actually have been materialized').toBeGreaterThan(0);
    expect(first.retroRegistered).toBe(true);
    const second = await runSettlement(store);
    expect(second, 'a settled store is a no-op on the next pass').toEqual({ retroRegistered: false, accountsMaterialized: 0 });
  });

  it('CONTROL: a genuine failure is still a failure — the fail-open is not a blanket catch', async () => {
    // Only the three race shapes are tolerated. A store that cannot write at all must not
    // be mistaken for a lost race and silently marked settled.
    const store = new MemoryStore();
    await seed(store);
    const boom = new Error('store is on fire');
    const failing = {
      get: (pk: string, sk: string) => store.get(pk, sk),
      put: () => Promise.reject(boom),
      query: (pk: string, prefix?: string) => store.query(pk, prefix),
      queryGSI1: (g: string) => store.queryGSI1(g),
      transact: () => Promise.reject(boom),
      delete: (pk: string, sk: string) => store.delete(pk, sk),
    };
    await expect(runSettlement(failing)).rejects.toBe(boom);
  });
});
