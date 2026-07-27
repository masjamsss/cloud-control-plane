import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError, type TransactWrite } from '../src/store/configStore';

/**
 * CONC-14 — team CRUD bumped `version` on every write but never guarded on it.
 *
 * The interesting case is not the rename race, it is `stripFromOthers`. Assigning a
 * service slug to a team strips it from whichever team held it, and the strip set is
 * computed from a read. Two concurrent set-services calls whose strip sets were computed
 * against each other's pre-image can therefore each write a row that still claims a slug
 * the other just took — leaving one slug owned by two teams, which is precisely the
 * single-ownership invariant the helper exists to maintain.
 */
describe('CONC-14 — guarded team writes', () => {
  const PK = 'PROJ#p1';
  const teamKey = (id: string): string => `TEAM#${id}`;

  const seed = async (): Promise<MemoryStore> => {
    const store = new MemoryStore();
    await store.put({ PK, SK: teamKey('a'), id: 'a', serviceSlugs: ['s3'], version: 1 });
    await store.put({ PK, SK: teamKey('b'), id: 'b', serviceSlugs: [], version: 1 });
    return store;
  };

  const guardedPut = (sk: string, item: Record<string, unknown>, v: unknown): TransactWrite => ({
    kind: 'put',
    item: { PK, SK: sk, ...item },
    ifEquals: { attr: 'version', value: v },
  });

  it('refuses a stolen-from write computed against a stale pre-image', async () => {
    const store = await seed();
    const aRead = (await store.get(PK, teamKey('a')))!;

    // Call 1: team b takes s3 from a. Both writes land.
    await store.transact([
      guardedPut(teamKey('a'), { id: 'a', serviceSlugs: [], version: 2 }, aRead.version),
      guardedPut(teamKey('b'), { id: 'b', serviceSlugs: ['s3'], version: 2 }, 1),
    ]);

    // Call 2 computed its strip set from the SAME pre-image of a, so it still believes a
    // owns s3. Guarded, it must be refused rather than writing a back with the slug.
    await expect(
      store.transact([
        guardedPut(teamKey('a'), { id: 'a', serviceSlugs: [], version: 2 }, aRead.version),
      ]),
    ).rejects.toBeInstanceOf(ConditionError);

    const a = (await store.get(PK, teamKey('a')))!;
    const b = (await store.get(PK, teamKey('b')))!;
    // Exactly one team owns s3.
    const owners = [a, b].filter((t) => (t.serviceSlugs as string[]).includes('s3'));
    expect(owners).toHaveLength(1);
    expect(owners[0].id).toBe('b');
  });

  it('demonstrates the defect: UNGUARDED writes leave one slug owned by two teams', async () => {
    const store = await seed();
    const aRead = (await store.get(PK, teamKey('a')))!;

    // Call 1: b takes s3 from a.
    await store.transact([
      { kind: 'put', item: { PK, SK: teamKey('a'), id: 'a', serviceSlugs: [], version: 2 } },
      { kind: 'put', item: { PK, SK: teamKey('b'), id: 'b', serviceSlugs: ['s3'], version: 2 } },
    ]);
    // Call 2, from the stale pre-image, writes a back still holding s3.
    await store.transact([
      {
        kind: 'put',
        item: { PK, SK: teamKey('a'), id: 'a', serviceSlugs: aRead.serviceSlugs, version: 2 },
      },
    ]);

    const a = (await store.get(PK, teamKey('a')))!;
    const b = (await store.get(PK, teamKey('b')))!;
    const owners = [a, b].filter((t) => (t.serviceSlugs as string[]).includes('s3'));
    expect(owners).toHaveLength(2); // ← the invariant is broken
  });

  it('lets a rename through when the team has not moved, and refuses when it has', async () => {
    const store = await seed();
    const read = (await store.get(PK, teamKey('a')))!;

    await store.transact([
      guardedPut(teamKey('a'), { id: 'a', name: 'renamed', serviceSlugs: ['s3'], version: 2 }, read.version),
    ]);
    expect((await store.get(PK, teamKey('a')))!.name).toBe('renamed');

    // A second rename from the same stale read must not win.
    await expect(
      store.transact([
        guardedPut(teamKey('a'), { id: 'a', name: 'other', serviceSlugs: ['s3'], version: 2 }, read.version),
      ]),
    ).rejects.toBeInstanceOf(ConditionError);
    expect((await store.get(PK, teamKey('a')))!.name).toBe('renamed');
  });
});
