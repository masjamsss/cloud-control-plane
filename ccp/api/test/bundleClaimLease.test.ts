import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, Item } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * ERR-2 / ERR-11 — the apply bundle's claim was neither exclusive nor releasable.
 *
 * ERR-2: `bundle.state:'running'` was written by the claim and only ever cleared by the
 * SAME handler's outcome write. Nothing else in the codebase writes `bundle`; there is no
 * reaper, no timeout and no admin route that resets it. A crash or restart mid-bundle — an
 * ordinary event, and one ERR-1's healthcheck interaction makes likely — left the request
 * answering `409 BUNDLE_RUNNING` on every future apply attempt FOREVER. A fully-approved
 * change became permanently un-appliable through the portal, recoverable only by editing
 * the store file by hand.
 *
 * ERR-11: the claim CAS guarded on `status`, an attribute the claim does not change. The
 * `bundle?.state === 'running'` pre-check above it is read-then-act, so two near-
 * simultaneous applies both passed it, both satisfied the status guard, and both ran full
 * bundles — two clones, two gate runs, two pushes. Only git's non-fast-forward rejection
 * prevented a double landing, and the loser then wrote `bundle-failed` over the winner's
 * `triggered`, leaving a corrupted-looking record after a benign double-click.
 *
 * Both are fixed the same way API-2 fixed `APPLYING`: the claim is guarded on the
 * attribute it itself advances (`eventSeq`), and it is LEASED rather than owned forever.
 */

const ENV_KEYS = ['CCP_BUNDLE', 'CCP_GIT_REMOTE', 'CCP_GIT_BRANCH', 'CCP_BUNDLE_GATE_CMD', 'CCP_BUNDLE_TRIGGER_CMD'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps.length = 0;
});

const temps: string[] = [];
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeOrigin(): string {
  const root = mkdtempSync(join(tmpdir(), 'bundle-lease-'));
  temps.push(root);
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' });
  writeFileSync(join(work, 'README.md'), 'seed\n');
  g(work, 'add', '-A');
  g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed');
  g(work, 'push', 'origin', 'HEAD:refs/heads/main');
  return bare;
}

/** Arm the bundle with commands that succeed but do nothing (or a caller's gate). */
function arm(gateCmd = 'true'): void {
  Object.assign(process.env, {
    CCP_BUNDLE: '1',
    CCP_GIT_REMOTE: makeOrigin(),
    CCP_BUNDLE_GATE_CMD: gateCmd,
    CCP_BUNDLE_TRIGGER_CMD: 'true',
  });
}

/**
 * `wrap` lets a test hand the ROUTE a decorated store while keeping the raw one to read
 * and to write the interleaving from — the only way to produce a real read-then-claim
 * race against a handler that cannot be suspended.
 */
async function seededApp(
  bundle?: RequestItem['bundle'],
  wrap?: (inner: ConfigStore) => ConfigStore,
): Promise<{
  store: ConfigStore;
  app: ReturnType<typeof createApp>;
  id: string;
}> {
  const store = new MemoryStore();
  await seed(store);
  await seedRequests(store, 'sample', 'sari', 1, {
    status: 'AWAITING_DEPLOY_APPROVAL',
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-01T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-02T00:00:00.000Z' },
    ],
    ...(bundle ? { bundle } : {}),
  });
  return { store, app: createApp(wrap ? wrap(store) : store), id: 'seed-sari-0' };
}

/** A store that runs `onGet` after every `get` — the interleaving the race needs. */
function racingStore(inner: ConfigStore, onGet: (pk: string, sk: string) => Promise<void>): ConfigStore {
  return {
    async get(pk: string, sk: string): Promise<Item | null> {
      const v = await inner.get(pk, sk);
      await onGet(pk, sk);
      return v;
    },
    put: (item, opts) => inner.put(item, opts),
    query: (pk, prefix, opts) => inner.query(pk, prefix, opts),
    queryGSI1: (gsi1pk, opts) => inner.queryGSI1(gsi1pk, opts),
    transact: (writes) => inner.transact(writes),
    delete: (pk, sk) => inner.delete(pk, sk),
  };
}

const post = async (app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/apply`, {
    method: 'POST',
    headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
  });

const readRow = async (store: ConfigStore, id: string): Promise<RequestItem> => {
  const k = requestKey('sample', id);
  return (await store.get(k.PK, k.SK)) as RequestItem;
};

describe('ERR-2 — a running claim is leased, not owned forever', () => {
  it('refuses while the claim is LIVE — exclusivity is unchanged', async () => {
    arm();
    const { store, app, id } = await seededApp({ state: 'running', at: new Date().toISOString() });
    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BUNDLE_RUNNING');
  });

  it('THE DEFECT: an EXPIRED claim is taken over instead of wedging the request forever', async () => {
    // A crash mid-bundle leaves exactly this row. Before the lease, every future apply
    // answered 409 and the only fix was hand-editing the store.
    arm();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const { store, app, id } = await seededApp({ state: 'running', at: twoHoursAgo });

    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status, 'the request must be appliable again').not.toBe(409);

    const row = await readRow(store, id);
    expect(row.bundle?.state, 'the stale claim is gone').not.toBe('running');
  });

  it('records the takeover in the timeline — a silent one would hide a half-run bundle', async () => {
    // The abandoned run may have landed a commit before dying. Whoever reads this request
    // must see that a previous attempt did not report back, not just a clean second run.
    arm();
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const { store, app, id } = await seededApp({ state: 'running', at: old });
    await post(app, await sessionCookieFor(store, 'lina'), id);

    const row = await readRow(store, id);
    expect(row.events.some((e) => e.type === 'bundle-claim-expired')).toBe(true);
  });

  it('treats a claim with an unparseable/missing timestamp as expired', async () => {
    // A claim that cannot be aged is one nothing can ever release — the wedge itself.
    arm();
    const { store, app, id } = await seededApp({ state: 'running' });
    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).not.toBe(409);
  });

  it('leaves a `triggered` bundle alone — that is a finished run, not a stale claim', async () => {
    arm();
    const { store, app, id } = await seededApp({ state: 'triggered', sha: 'abc123', at: '2020-01-01T00:00:00.000Z' });
    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(409); // STATE_CONFLICT — already applied, never re-run
  });
});

describe('ERR-11 — the claim guards on what it actually changes', () => {
  it('a second apply against the pre-image row is refused, not run twice', async () => {
    // The double-run this prevents: both handlers pass the read-then-act pre-check, and
    // under the old `status` guard both also passed the CAS, because the claim does not
    // change status. Here the first claim advances eventSeq and the second is refused.
    arm();
    const { store, app, id } = await seededApp();
    const before = await readRow(store, id);

    const cookie = await sessionCookieFor(store, 'lina');
    await post(app, cookie, id);

    // Rewind ONLY the guarded attribute's expectation by replaying the stale pre-image's
    // claim — i.e. what the second in-flight handler would have written.
    const k = requestKey('sample', id);
    await expect(
      store.transact([
        {
          kind: 'update',
          pk: k.PK,
          sk: k.SK,
          set: { bundle: { state: 'running', at: new Date().toISOString() } },
          ifEquals: { attr: 'eventSeq', value: before.eventSeq },
        },
      ]),
    ).rejects.toThrow();
  });

  it('the claim advances eventSeq, so it can be guarded on at all', async () => {
    arm();
    const { store, app, id } = await seededApp();
    const before = await readRow(store, id);
    await post(app, await sessionCookieFor(store, 'lina'), id);
    const after = await readRow(store, id);
    expect(after.eventSeq).toBeGreaterThan(before.eventSeq ?? 0);
  });
});

/**
 * API-4 (defect 1) — the claim is a MUTUAL EXCLUSION, not a formality.
 *
 * The two ERR-11 cases above are necessary but not sufficient, and this file shipped
 * without noticing: both of them only establish that the claim *advances* `eventSeq`, and
 * one of them supplies its own `ifEquals` rather than exercising the route's. Reverting the
 * route's claim to the original `ifEquals {attr:'status'}` — the exact defect API-4 names —
 * left every test in this file, in `bundle.test.ts` and in `applyLaneExclusion.test.ts`
 * green. A guard nothing discriminates is a guard nobody is protecting.
 *
 * What actually has to hold is the property, not the attribute name: a request-row write
 * that lands between this handler's READ and its CLAIM must cost the handler the claim.
 * `status` cannot deliver that, because the claim does not move `status` — so a concurrent
 * claim leaves it exactly where the loser last saw it and the loser's CAS sails through.
 * That is how two applies ran two clones, two gate commands and two pushes against one
 * request, with only git's non-fast-forward rejection standing between them and a double
 * landing.
 *
 * The race is driven by a store wrapper because a route test cannot otherwise produce the
 * interleaving: the two handlers would have to be suspended between their read and their
 * write. The wrapper lands the competing write at exactly that point.
 */
describe('API-4 — a write between the read and the claim costs the handler the claim', () => {
  /** Fires the gate into a marker OUTSIDE the checkout, so it survives `cleanup(dir)`. */
  function gateMarker(): { cmd: string; ran: () => boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-gate-marker-'));
    temps.push(dir);
    const marker = join(dir, 'gate-ran');
    return {
      // Also edits the checkout, so an unraced run reaches `triggered` rather than
      // dying at "gate left no change" — the control below asserts the whole lane.
      cmd: `echo ran > '${marker}' && echo approved-edit > "$BUNDLE_CHECKOUT/change.tf"`,
      ran: () => existsSync(marker),
    };
  }

  it('THE RACE: the claim LOSES and the bundle never runs — no clone, no gate, no push', async () => {
    const gate = gateMarker();
    arm(gate.cmd);

    // One competing request-row write, landed the instant the handler has read the row.
    // It moves `eventSeq` and deliberately NOT `status` — precisely what a second apply's
    // own claim does, and the reason a status guard cannot see it.
    let raced = false;
    let racedSeq = -1;
    const k = requestKey('sample', 'seed-sari-0');
    let inner!: ConfigStore;
    const { store, app, id } = await seededApp(undefined, (s) => {
      inner = s;
      return racingStore(s, async (pk, sk) => {
        if (raced || pk !== k.PK || sk !== k.SK) return;
        raced = true;
        const row = (await inner.get(pk, sk)) as RequestItem;
        racedSeq = (row.eventSeq ?? 0) + 1;
        await inner.transact([
          { kind: 'update', pk, sk, set: { eventSeq: racedSeq }, ifEquals: { attr: 'eventSeq', value: row.eventSeq } },
        ]);
      });
    });

    const res = await post(app, await sessionCookieFor(store, 'lina'), id);

    // L-1 — the setup fired: without the interleaving every assertion below would hold
    // for the boring reason that nothing raced.
    expect(raced, 'the competing write must have landed inside the handler').toBe(true);
    expect(racedSeq).toBeGreaterThan(0);

    expect(res.status, 'a lost claim is reported, not run').toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');

    // The effects are what matter: the gate command is the first thing a claimed run
    // spawns, and it never got the chance.
    expect(gate.ran(), 'THE DEFECT: the gate ran on a request this handler never claimed').toBe(false);

    const row = await readRow(store, id);
    expect(row.bundle, 'no claim was written').toBeUndefined();
    expect(row.eventSeq, 'the row still carries the racer\'s write, unclobbered').toBe(racedSeq);
  });

  it('CONTROL: with nothing racing, the SAME fixture claims and runs the gate', async () => {
    // Proves the refusal above is caused by the race and not by the marker plumbing, the
    // gate command, or the fixture being un-appliable in the first place.
    const gate = gateMarker();
    arm(gate.cmd);
    const { store, app, id } = await seededApp();

    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status, 'an unraced apply is not refused').toBe(200);
    expect(gate.ran(), 'the gate must be able to run at all').toBe(true);
    expect((await readRow(store, id)).bundle?.state).toBe('triggered');
  });
});
