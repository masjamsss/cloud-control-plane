import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError } from '../src/store/configStore';
import { runVersionStamp, versionStampMarker } from '../src/domain/versionStamp';
import {
  accountsGsi,
  projectCollectionGsi,
  requestCollectionGsi,
  teamCollectionGsi,
} from '../src/store/schema';

/**
 * REM-1 — the optimistic-concurrency guards cannot bite on rows written before the
 * attributes they compare existed.
 *
 * The last test is the point of the whole file: it reproduces the lost update on an
 * unstamped row, then shows the same sequence being refused after stamping. Everything
 * else guards the migration's own safety properties — idempotence, value preservation,
 * and marker-last ordering.
 */
describe('REM-1 — version stamping', () => {
  const PROJECT = 'p1';

  const seedLegacy = async (): Promise<MemoryStore> => {
    const store = new MemoryStore();
    // A project in the global registry.
    await store.put({ PK: 'PROJECT#p1', SK: 'META', id: PROJECT, GSI1PK: projectCollectionGsi(), GSI1SK: 'p1' });
    // Rows as they exist before the guards: no eventSeq / accountVersion / version.
    await store.put({ PK: `PROJ#${PROJECT}`, SK: 'REQ#r1', GSI1PK: requestCollectionGsi(PROJECT), GSI1SK: 'r1', approvals: [] });
    await store.put({ PK: `PROJ#${PROJECT}`, SK: 'TEAM#t1', GSI1PK: teamCollectionGsi(PROJECT), GSI1SK: 't1', serviceSlugs: [] });
    await store.put({ PK: 'ACCT#alice', SK: 'PROFILE', GSI1PK: accountsGsi(), GSI1SK: 'alice', status: 'active' });
    return store;
  };

  it('stamps a 0 on every row that lacks its attribute', async () => {
    const store = await seedLegacy();
    const tally = await runVersionStamp(store);
    expect(tally).toEqual({ requests: 1, accounts: 1, teams: 1 });

    expect((await store.get(`PROJ#${PROJECT}`, 'REQ#r1'))!.eventSeq).toBe(0);
    expect((await store.get(`PROJ#${PROJECT}`, 'TEAM#t1'))!.version).toBe(0);
    expect((await store.get('ACCT#alice', 'PROFILE'))!.accountVersion).toBe(0);
  });

  it('never overwrites an attribute that is already present', async () => {
    const store = await seedLegacy();
    await store.put({ PK: 'ACCT#bob', SK: 'PROFILE', GSI1PK: accountsGsi(), GSI1SK: 'bob', accountVersion: 42 });

    await runVersionStamp(store);
    // A live counter must not be rolled back to 0 by the migration.
    expect((await store.get('ACCT#bob', 'PROFILE'))!.accountVersion).toBe(42);
  });

  it('is idempotent and inert once the marker exists', async () => {
    const store = await seedLegacy();
    const first = await runVersionStamp(store);
    expect(first).not.toBeNull();

    const marker = versionStampMarker();
    expect(await store.get(marker.PK, marker.SK)).not.toBeNull();

    // Second run does nothing at all, not even a rescan-with-zero-changes.
    expect(await runVersionStamp(store)).toBeNull();
  });

  it('is a no-op on a blank store, and still marks it', async () => {
    const store = new MemoryStore();
    expect(await runVersionStamp(store)).toEqual({ requests: 0, accounts: 0, teams: 0 });
    const marker = versionStampMarker();
    expect(await store.get(marker.PK, marker.SK)).not.toBeNull();
  });

  it('makes the guard bite: the lost update is possible before stamping, refused after', async () => {
    const store = await seedLegacy();
    const PK = `PROJ#${PROJECT}`;
    const SK = 'REQ#r1';

    // BEFORE stamping: two readers both capture `undefined`, so both guards pass and the
    // second write silently discards the first. This is REM-1.
    const a = (await store.get(PK, SK))!;
    const b = (await store.get(PK, SK))!;
    await store.put({ ...a, approvals: ['alice'] }, { ifEquals: { attr: 'eventSeq', value: a.eventSeq } });
    await store.put({ ...b, approvals: ['bob'] }, { ifEquals: { attr: 'eventSeq', value: b.eventSeq } });
    expect((await store.get(PK, SK))!.approvals).toEqual(['bob']); // alice lost

    // Reset and stamp.
    await store.put({ PK, SK, GSI1PK: requestCollectionGsi(PROJECT), GSI1SK: 'r1', approvals: [] });
    await runVersionStamp(store);

    // AFTER stamping: the same sequence is refused.
    const c = (await store.get(PK, SK))!;
    const d = (await store.get(PK, SK))!;
    expect(c.eventSeq).toBe(0);
    await store.put(
      { ...c, approvals: ['alice'], eventSeq: 1 },
      { ifEquals: { attr: 'eventSeq', value: c.eventSeq } },
    );
    await expect(
      store.put({ ...d, approvals: ['bob'], eventSeq: 1 }, { ifEquals: { attr: 'eventSeq', value: d.eventSeq } }),
    ).rejects.toBeInstanceOf(ConditionError);
    expect((await store.get(PK, SK))!.approvals).toEqual(['alice']); // alice survives
  });
});
