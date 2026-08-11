import type { ConfigStore, Item } from '../store/configStore';
import { accountKey, accountsGsi } from '../store/schema';

/**
 * DATA-11 — repair account rows whose `id` does not match the username their key
 * encodes.
 *
 * THE INVARIANT. An account row lives at `ACCOUNT#<username>` (`accountKey`).
 * Login looks an account up BY USERNAME, then mints a session carrying
 * `userId = account.id`; every subsequent request resolves that session through
 * `accountKey(session.userId)` (`auth/sessions.ts`). So `id` is not decorative —
 * it is the key the session round-trip closes on, and it must equal the username
 * in the PK or the round-trip does not close.
 *
 * A row where they disagree is in a state no verb can escape: the account passes
 * login (found by username) and then every session it mints resolves to a
 * nonexistent `ACCOUNT#<id>` row and returns `invalid`. It can authenticate and
 * can never hold a session, and no admin action fixes it — rename bumps a
 * different field, reset changes a credential.
 *
 * The v1 import wrote exactly this shape: it preserved the v1 document's `id`
 * while keying the row by username. That route now refuses such a document, but a
 * refusal does nothing for a store where the import already ran — this is the
 * path for those rows.
 *
 * THREE PROPERTIES, each of them deliberate:
 *
 *  - **No marker row.** Unlike REM-1's version stamp this is not a one-shot; it
 *    runs the check every boot. A marker is what makes a repair pass that could
 *    not reach everything never retry (R-12 is exactly that failure on the
 *    version stamp), and this pass is cheap — one GSI query over a set bounded by
 *    the number of humans — and rewrites only rows that violate the invariant.
 *  - **Value-preserving apart from the identity fields.** It rewrites `id` and
 *    `username` to the PK's username and touches nothing else, so it cannot roll
 *    back a credential, a session version or a role binding.
 *  - **Widening, never narrowing.** Every session an affected row could have
 *    minted was already unresolvable, so no live session is invalidated by this;
 *    the set of working states only grows. Rows referencing the old id elsewhere
 *    (audit actors, historical request authorship) are immutable evidence and are
 *    deliberately not rewritten — see RESIDUE R-97.
 */

const ACCOUNT_PK_PREFIX = 'ACCOUNT#';

/** The username an account row's PRIMARY KEY encodes, or null if it is not an
 *  account key at all. The key is the authority here: it is what every lookup
 *  addresses, so it is what the row's identity fields have to agree with. */
export function usernameOfAccountKey(pk: string): string | null {
  if (!pk.startsWith(ACCOUNT_PK_PREFIX)) return null;
  const username = pk.slice(ACCOUNT_PK_PREFIX.length);
  return username.length > 0 ? username : null;
}

/** Which identity fields on this row disagree with its key. Empty = healthy. */
export function accountIdentityDrift(row: Item): string[] {
  const username = usernameOfAccountKey(row.PK);
  if (username === null) return [];
  const drift: string[] = [];
  if (row.id !== username) drift.push('id');
  if (row.username !== username) drift.push('username');
  return drift;
}

export interface AccountIdentityRepairTally {
  /** Rows whose identity fields disagreed with their key and were rewritten. */
  repaired: number;
  /** The usernames repaired, for the boot log — an operator needs to know WHICH
   *  accounts changed, not just how many. */
  usernames: string[];
}

/**
 * Run the repair now on THIS store. Idempotent and safe on a blank store (no
 * account rows, nothing to check).
 */
export async function runAccountIdentityRepair(store: ConfigStore): Promise<AccountIdentityRepairTally> {
  const tally: AccountIdentityRepairTally = { repaired: 0, usernames: [] };
  for (const row of await store.queryGSI1(accountsGsi())) {
    const drift = accountIdentityDrift(row);
    if (drift.length === 0) continue;
    const username = usernameOfAccountKey(row.PK)!;
    // Rebuild the key from the key function rather than reusing row.PK/SK, so a
    // repair can never write to a hand-derived key.
    await store.put({ ...row, ...accountKey(username), id: username, username });
    tally.repaired += 1;
    tally.usernames.push(username);
  }
  return tally;
}
