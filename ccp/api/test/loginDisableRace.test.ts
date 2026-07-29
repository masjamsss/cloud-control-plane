import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError } from '../src/store/configStore';

/**
 * CONC-3 — the auth lane wrote the account row with blind full-row puts.
 *
 * The headline scenario from the finding: an admin disables an account while a login for
 * it is mid-flight. The login read the row BEFORE the disable, then spent 50-200 ms inside
 * an argon2id verify — a deliberately slow yield, wide enough for the admin's commit to
 * land — and then put its stale row back. That restored `status:'active'`, the old
 * `sessionVersion` and the old `accountVersion` wholesale: the disable was silently undone
 * and the revoked sessions became valid again.
 *
 * These tests work at the store seam, where the missing primitive was: a guarded
 * standalone put. The first fails without `ifEquals` on `ConfigStore.put` — the stale
 * write succeeds and the account is active again.
 */
describe('CONC-3 — an admin disable survives an in-flight login', () => {
  const PK = 'ACCT#alice';
  const SK = 'PROFILE';

  const seed = async (): Promise<MemoryStore> => {
    const store = new MemoryStore();
    await store.put({
      PK,
      SK,
      status: 'active',
      sessionVersion: 1,
      accountVersion: 7,
      failedAttempts: 3,
    });
    return store;
  };

  it('refuses the stale login write instead of restoring the disabled row', async () => {
    const store = await seed();

    // The login handler's read, taken before the admin acts.
    const read = (await store.get(PK, SK))!;

    // The admin disables mid-verify, bumping both counters (this write is already guarded
    // in admin.ts and is not what is under test here).
    await store.put({
      ...read,
      status: 'disabled',
      sessionVersion: 2,
      accountVersion: (read.accountVersion as number) + 1,
    });

    // The login now writes its success row, computed from the stale read.
    const stale = {
      ...read,
      failedAttempts: 0,
      accountVersion: (read.accountVersion as number) + 1,
    };

    await expect(
      store.put(stale, { ifEquals: { attr: 'accountVersion', value: read.accountVersion } }),
    ).rejects.toBeInstanceOf(ConditionError);

    const after = (await store.get(PK, SK))!;
    expect(after.status).toBe('disabled'); // the disable stands
    expect(after.sessionVersion).toBe(2); // revoked sessions stay revoked
    expect(after.accountVersion).toBe(8);
  });

  it('demonstrates the defect: an UNGUARDED put silently undoes the disable', async () => {
    const store = await seed();
    const read = (await store.get(PK, SK))!;
    await store.put({ ...read, status: 'disabled', sessionVersion: 2, accountVersion: 8 });

    // Exactly the old code path: no condition.
    await store.put({ ...read, failedAttempts: 0 });

    const after = (await store.get(PK, SK))!;
    expect(after.status).toBe('active'); // ← the account is live again
    expect(after.sessionVersion).toBe(1); // ← revoked sessions are valid again
  });

  it('fails closed against an account deleted mid-flight', async () => {
    const store = await seed();
    const read = (await store.get(PK, SK))!;
    await store.delete(PK, SK);
    await expect(
      store.put({ ...read, failedAttempts: 0 }, { ifEquals: { attr: 'accountVersion', value: read.accountVersion } }),
    ).rejects.toBeInstanceOf(ConditionError);
    expect(await store.get(PK, SK)).toBeNull(); // not resurrected
  });

  it('lets the write through when nothing moved', async () => {
    const store = await seed();
    const read = (await store.get(PK, SK))!;
    await store.put(
      { ...read, failedAttempts: 0, accountVersion: (read.accountVersion as number) + 1 },
      { ifEquals: { attr: 'accountVersion', value: read.accountVersion } },
    );
    const after = (await store.get(PK, SK))!;
    expect(after.failedAttempts).toBe(0);
    expect(after.accountVersion).toBe(8);
  });
});
