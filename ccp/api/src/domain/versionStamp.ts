import type { ConfigStore, Item } from '../store/configStore';
import {
  accountsGsi,
  projectCollectionGsi,
  requestCollectionGsi,
  teamCollectionGsi,
} from '../store/schema';

/**
 * REM-1 — stamp the optimistic-concurrency attributes onto rows written before they
 * existed.
 *
 * The guards added for CONC-1/2/3/14 compare the attribute value the handler read:
 * `eventSeq` on a request row, `accountVersion` on an account row, `version` on a team
 * row. On a row that predates those fields the value is `undefined`, so two concurrent
 * readers both capture `undefined`, both guards compare `undefined !== undefined` → false,
 * and BOTH writes are allowed. The lost update the guard exists to prevent still happens,
 * exactly once per row.
 *
 * That is not a small caveat: it means every guard in this codebase is inert against the
 * data that already exists, which is the only data a running deployment has.
 *
 * This stamps a `0` on every row that lacks its attribute, after which the guards work
 * normally. It is:
 *
 *  - **idempotent**, via its own marker row written LAST — the same fail-closed ordering
 *    the boot settlement uses, so a crash midway leaves the marker absent and the next
 *    boot simply redoes the (harmless, value-preserving) stamping;
 *  - **value-preserving** — it only ever adds a missing attribute, never overwrites one
 *    that is present, so it cannot roll a live counter backwards;
 *  - **unguarded, deliberately** — it runs at boot before serving, and it is the thing
 *    establishing the attribute the guards need. Guarding it on the value it is about to
 *    create would be circular.
 *
 * A blank store is a no-op: there are no rows, nothing is stamped, and the marker is
 * written so it never scans again.
 */

/** Marker row. Presence means this store has already been stamped. */
export function versionStampMarker(): { PK: string; SK: string } {
  return { PK: 'VERSIONSTAMP', SK: 'META' };
}

export interface VersionStampTally {
  requests: number;
  accounts: number;
  teams: number;
}

/** Stamp `attr: 0` on rows that lack it. Returns how many were changed. */
async function stampMissing(store: ConfigStore, rows: Item[], attr: string): Promise<number> {
  let n = 0;
  for (const row of rows) {
    if (row[attr] !== undefined) continue;
    await store.put({ ...row, [attr]: 0 });
    n += 1;
  }
  return n;
}

/**
 * Run the stamping now on THIS store. Idempotent via the marker; safe on a blank store.
 */
export async function runVersionStamp(store: ConfigStore): Promise<VersionStampTally | null> {
  const marker = versionStampMarker();
  if (await store.get(marker.PK, marker.SK)) return null; // already stamped — inert

  const tally: VersionStampTally = { requests: 0, accounts: 0, teams: 0 };

  // Accounts live in one global collection.
  tally.accounts = await stampMissing(store, await store.queryGSI1(accountsGsi()), 'accountVersion');

  // Requests and teams are per-project, so walk the global project registry.
  const projects = await store.queryGSI1(projectCollectionGsi());
  for (const p of projects) {
    const projectId = String(p.id ?? p.SK ?? '');
    if (!projectId) continue;
    tally.requests += await stampMissing(
      store,
      await store.queryGSI1(requestCollectionGsi(projectId)),
      'eventSeq',
    );
    tally.teams += await stampMissing(
      store,
      await store.queryGSI1(teamCollectionGsi(projectId)),
      'version',
    );
  }

  // Marker LAST: a crash before this point leaves it absent and the next boot redoes the
  // work, which is harmless because stamping only ever fills in a missing attribute.
  await store.put({ ...marker, at: new Date().toISOString(), ...tally });
  return tally;
}
