import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUEST_STATUSES, isKnownRequestStatus, occupiesQuotaSlot } from '@app-lib/requestStatus';
import { APPLYING, HALTED_DRIFT, HALTED_APPLY_FAILED } from '../src/domain/apply/scheduler';
import { PENDING_CHANGE_STATUSES } from '../src/store/schema';

/**
 * ARCH-7 — the request-status vocabulary is a contract, so something has to check it.
 *
 * The server stored status as free text and the SPA declared a 21-value union, and the two
 * drifted in both directions: the scheduler wrote `HALTED_DRIFT`/`HALTED_APPLY_FAILED`,
 * which appeared nowhere in `ccp/app/src`, while the union carried ~10 statuses the api
 * never writes. It was all recorded as a known tension and left there while new statuses
 * kept accreting — because nothing failed when they did.
 *
 * That is what this file is. The union is now one closed set (`@app-lib/requestStatus`),
 * and these tests fail when either side moves without it.
 */

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(name) ? [p] : [];
  });
}

/**
 * Every SCREAMING_SNAKE string literal the api source assigns to a `status` field or
 * declares as a status constant. Deliberately a text scan rather than a type query: the
 * store schema types status as `z.string()`, so the type system has nothing to ask, which
 * is the finding's root cause and the reason a scan is the honest instrument here.
 */
function statusLiteralsInApiSource(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(API_SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bstatus:\s*'([A-Z][A-Z_]{3,})'/g)) {
      if (!found.has(m[1]!)) found.set(m[1]!, file.slice(API_SRC.length + 1));
    }
    // A SELF-NAMED constant — `export const APPLYING = 'APPLYING'` — which is how this
    // codebase declares a status it also needs a symbol for. Requiring name === value is
    // what separates those from an env-var alias like
    // `const TAKEOVER_ENV = 'CCP_DATA_LOCK_TAKEOVER'`, which this check flagged as a
    // stray status the first time one appeared. Same rule-not-list discipline as the
    // vocabulary set below (L-25): the pattern describes the shape, not the names.
    for (const m of text.matchAll(/^(?:export )?const ([A-Z][A-Z_]{3,}) = '([A-Z][A-Z_]{3,})';$/gm)) {
      if (m[1] !== m[2]) continue;
      if (!found.has(m[2]!)) found.set(m[2]!, file.slice(API_SRC.length + 1));
    }
  }
  return found;
}

describe('ARCH-7 — one closed status vocabulary', () => {
  it('scans a real source tree (sanity)', () => {
    // Without this the assertion below passes by finding nothing (L-1).
    const found = statusLiteralsInApiSource();
    expect(found.size).toBeGreaterThan(5);
    expect([...found.keys()]).toContain('AWAITING_DEPLOY_APPROVAL');
  });

  it('every status literal the api writes belongs to SOME declared closed vocabulary', () => {
    // Not just the request one. `PendingConfigChangeItem` has its own five, and it shares
    // the literal `APPLIED` with requests while meaning something else entirely — so
    // "a SCREAMING_SNAKE status literal" cannot tell the two apart on its own. The rule
    // is therefore about declaration, not about one set: a new entity with its own
    // statuses has to name them somewhere this test can read (L-25 — write the rule, not
    // the list). Both strays this check found on its first run were exactly that case.
    const declared = new Set<string>([...REQUEST_STATUSES, ...PENDING_CHANGE_STATUSES]);
    const strays = [...statusLiteralsInApiSource()]
      .filter(([s]) => !declared.has(s))
      .map(([s, where]) => `${s} (${where})`);
    expect(
      strays,
      'The api writes a status the SPA cannot type. That is exactly how HALTED_DRIFT and ' +
        'HALTED_APPLY_FAILED shipped: the client rendered statuses that were absent from ' +
        'its own union. Add it to REQUEST_STATUSES in ccp/app/src/lib/requestStatus.ts, ' +
        'and decide there whether it occupies a quota slot.',
    ).toEqual([]);
  });

  it('the statuses the finding named are now typed', () => {
    for (const s of [HALTED_DRIFT, HALTED_APPLY_FAILED, APPLYING]) {
      expect(isKnownRequestStatus(s), s).toBe(true);
    }
  });

  it('the closed set has no duplicates', () => {
    expect(new Set(REQUEST_STATUSES).size).toBe(REQUEST_STATUSES.length);
  });
});

describe('ARCH-7 — quota occupancy is derived, and fails closed', () => {
  it('THE FAIL-OPEN: the four statuses the hand-maintained list had missed all occupy a slot', () => {
    // Each is non-terminal — mid-apply, waiting on a human, or parked with two exits —
    // and each silently released the requester's slot.
    for (const s of ['APPLYING', 'HALTED_DRIFT', 'HALTED_APPLY_FAILED', 'WINDOW_EXPIRED']) {
      expect(occupiesQuotaSlot(s), s).toBe(true);
    }
  });

  it('the five the old list DID hold still occupy a slot — no behaviour was traded away', () => {
    for (const s of [
      'AWAITING_CODE_REVIEW',
      'AWAITING_DEPLOY_APPROVAL',
      'CHANGES_REQUESTED',
      'NEEDS_ENGINEER',
      'APPROVED_COOLING',
    ]) {
      expect(occupiesQuotaSlot(s), s).toBe(true);
    }
  });

  it('terminal statuses still release the slot', () => {
    for (const s of ['APPLIED', 'REJECTED', 'CANCELLED', 'NOOP', 'WITHDRAWN', 'DRAFT']) {
      expect(occupiesQuotaSlot(s), s).toBe(false);
    }
  });

  it('an UNKNOWN status occupies a slot — the inversion is the point', () => {
    // The old list was of OPEN statuses, so anything it had not heard of released the
    // slot. This one is of TERMINAL statuses, so anything new holds it until someone
    // decides otherwise. Same forgetting, opposite consequence.
    expect(occupiesQuotaSlot('SOME_STATUS_ADDED_NEXT_QUARTER')).toBe(true);
  });
});
