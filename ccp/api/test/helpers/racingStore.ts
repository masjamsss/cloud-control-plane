import type { ConfigStore, Item, TransactWrite } from '../../src/store/configStore';

/**
 * Store wrappers for ROUTE-LEVEL race tests (TEST-6).
 *
 * The mechanism is the one `test/sessionRevokeRace.test.ts` and
 * `test/pendingChangeCas.test.ts` established: wrap the store, and commit a COMPETING
 * write in the window between a handler's read and its write. These are the same wrappers
 * lifted out so a route test can drive a whole second HTTP request through the inner
 * store as the competitor, which is what makes the interleave a genuine route race rather
 * than a store-level simulation.
 *
 * Two rules learned the hard way here:
 *
 *  - **Delegate method by method.** `{...store}` copies own properties only, so spreading
 *    a `MemoryStore` drops every prototype method and the app 500s on the first write
 *    instead of racing anything.
 *  - **Prefer {@link writeRacingStore} when a read hook is ambiguous.** A handler is not
 *    the only thing that reads: first-boot settlement queries the team and request
 *    collections too, so a read hook keyed on a collection can fire long before the
 *    handler looks, letting the competitor win uncontested and the test pass against
 *    unfixed code (L-1). Every wrapper here exposes `fired()` so the interleave itself
 *    can be asserted.
 */

/** A full delegating `ConfigStore` with selected methods overridden. */
export function wrap(inner: ConfigStore, over: Partial<ConfigStore>): ConfigStore {
  return {
    get: (pk, sk) => inner.get(pk, sk),
    put: (item, opts) => inner.put(item, opts),
    query: (pk, prefix, opts) => inner.query(pk, prefix, opts),
    queryGSI1: (gsi1pk, opts) => inner.queryGSI1(gsi1pk, opts),
    transact: (writes: TransactWrite[]) => inner.transact(writes),
    delete: (pk, sk) => inner.delete(pk, sk),
    ...over,
  };
}

export type RacingStore = ConfigStore & { fired: () => boolean };

/** Runs `competing` ONCE, immediately after the first `get` of `key`. */
export function getRacingStore(inner: ConfigStore, key: { PK: string; SK: string }, competing: () => Promise<void>): RacingStore {
  let fired = false;
  return {
    ...wrap(inner, {
      async get(pk: string, sk: string): Promise<Item | null> {
        const v = await inner.get(pk, sk);
        if (!fired && pk === key.PK && sk === key.SK) {
          fired = true;
          await competing();
        }
        return v;
      },
    }),
    fired: () => fired,
  };
}

/** Does this write touch `key`, whatever its kind? */
export function touchesKey(w: TransactWrite, key: { PK: string; SK: string }): boolean {
  return w.kind === 'put' ? w.item.PK === key.PK && w.item.SK === key.SK : w.pk === key.PK && w.sk === key.SK;
}

/**
 * Runs `competing` ONCE, immediately BEFORE the first `transact` whose batch satisfies
 * `matches` — the read/write window, entered from the write end. Unambiguous in a way a
 * read hook often is not: only the handler under test writes the key it is about to write.
 */
export function writeRacingStore(inner: ConfigStore, matches: (writes: TransactWrite[]) => boolean, competing: () => Promise<void>): RacingStore {
  let fired = false;
  return {
    ...wrap(inner, {
      async transact(writes: TransactWrite[]): Promise<void> {
        if (!fired && matches(writes)) {
          fired = true;
          await competing();
        }
        return inner.transact(writes);
      },
    }),
    fired: () => fired,
  };
}
