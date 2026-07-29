import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { auditKey, chainHead, requestKey, yyyymm } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * CONC-6 — the bundle claim had no exception path and no race path.
 *
 * ERR-2 and ERR-11 fixed the claim's ACQUISITION (leased, guarded on the attribute it
 * advances). This file is about what happens AFTER the bundle runs — the two ways the
 * outcome could fail to be recorded at all, both of them after the CI trigger has
 * already fired, which is the worst possible moment to lose the record:
 *
 *  1. `runBundle` THROWS. `mkdtempSync` on a vanished TMPDIR, `writeFileSync` ENOSPC on
 *     the request-evidence file, an unexpected error inside any step. There was no
 *     catch, so the response was a bare 500 and the row kept `bundle.state:'running'`.
 *     ERR-2's lease means that now clears itself after an hour rather than never — a
 *     real improvement, and still an hour in which a fully approved request answers
 *     `BUNDLE_RUNNING` for a bundle that is not running.
 *
 *  2. A CANCEL COMMITS WHILE THE BUNDLE RUNS. `AWAITING_DEPLOY_APPROVAL` is cancellable
 *     and the claim deliberately does not move `status`, so this is not exotic: a
 *     bundle can legitimately run for half an hour, and cancel is exactly the verb an
 *     operator reaches for when they realise a change should not land. The finding
 *     described the outcome write being REFUSED (it was guarded `ifEquals status=…`
 *     then). ERR-11 changed that guard to `eventSeq`, which cancel never touches, so
 *     the write now succeeds — and the residual defect moved rather than closing:
 *     `set` REPLACES `events`, and the array being written was computed from the
 *     pre-bundle snapshot, so the `cancelled` entry was silently erased. A CANCELLED
 *     request whose timeline never mentions the cancellation.
 *
 *  3. Anything else that moves the row past this run's claim (a lease takeover by a
 *     second apply) still refuses the row update, correctly — and used to throw
 *     CHAIN_CONTENTION with nothing written.
 *
 * The tests below drive the REAL route with a real git remote and a real gate command,
 * because the whole finding is about the ordering of external effects against store
 * writes; a unit test over the steps could not observe it. The bundle is provably mid-run
 * when the racing write happens — the gate command blocks on a sentinel file, so there
 * are no sleeps and no timing assumptions.
 *
 * The racing write itself is at the store rather than through `POST /:id/cancel`, because
 * **API-5 now refuses that call while a claim is live**. What is left after that guard is
 * the read-then-act sliver behind it, which no route test can produce — the two handlers
 * would have to be suspended between their read and their write. `cancelBehindTheGuard`
 * below performs exactly the write the cancel handler performs, and
 * `test/cancelBundleRace.test.ts` pins that shape against the real route so the fixture
 * cannot drift.
 */

const ENV_KEYS = ['CCP_BUNDLE', 'CCP_GIT_REMOTE', 'CCP_GIT_BRANCH', 'CCP_BUNDLE_GATE_CMD', 'CCP_BUNDLE_TRIGGER_CMD', 'TMPDIR'] as const;
const saved: Record<string, string | undefined> = {};
const temps: string[] = [];

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

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A real bare repo the bundle can clone from and CAS-push to. */
function makeOrigin(): string {
  const root = mkdtempSync(join(tmpdir(), 'bundle-conc6-'));
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

/**
 * Arm the bundle with a gate that BLOCKS until the test releases it, and that leaves a
 * change behind so `commit` has something to land (a gate that edits nothing fails).
 *
 * Returns the two sentinel paths: `started` appears the moment the gate is running
 * inside the checkout, `release` is what the test writes to let it finish. This is what
 * makes the concurrency tests deterministic — no sleeps, no timing assumptions.
 */
function armBlockingGate(): { started: string; release: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-gate-'));
  temps.push(dir);
  const started = join(dir, 'started');
  const release = join(dir, 'release');
  Object.assign(process.env, {
    CCP_BUNDLE: '1',
    CCP_GIT_REMOTE: makeOrigin(),
    CCP_BUNDLE_GATE_CMD: `touch '${started}'; while [ ! -e '${release}' ]; do sleep 0.02; done; echo gated > "$BUNDLE_CHECKOUT/gated.txt"`,
    CCP_BUNDLE_TRIGGER_CMD: 'true',
  });
  return { started, release };
}

/** Arm with a gate that returns immediately (for the exception path). */
function armFastGate(): void {
  Object.assign(process.env, {
    CCP_BUNDLE: '1',
    CCP_GIT_REMOTE: makeOrigin(),
    CCP_BUNDLE_GATE_CMD: 'echo gated > "$BUNDLE_CHECKOUT/gated.txt"',
    CCP_BUNDLE_TRIGGER_CMD: 'true',
  });
}

async function waitFor(path: string, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (${path})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function seededApp(): Promise<{ store: ConfigStore; app: ReturnType<typeof createApp>; id: string }> {
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
  });
  return { store, app: createApp(store), id: 'seed-sari-0' };
}

const apply = async (app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/apply`, {
    method: 'POST',
    headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
  });

/**
 * A cancel that slipped through API-5's front-door guard — written at the STORE, because
 * the route now refuses while a claim is live and a route test therefore cannot produce
 * this interleaving at all (the same reason `requestRowLostUpdate.test.ts` drives the
 * store).
 *
 * This is byte-for-byte the write `POST /:id/cancel` performs: `status`, `updatedAt` and
 * `events` set, guarded on the observed `status`, and — the property that makes the race
 * possible — **no `eventSeq` bump**, so the bundle's `ifEquals eventSeq=claimSeq` guard
 * cannot see it. `test/cancelBundleRace.test.ts` pins that shape against the real handler,
 * so this fixture cannot quietly drift away from what the route does.
 */
async function cancelBehindTheGuard(store: ConfigStore, id: string): Promise<void> {
  const k = requestKey('sample', id);
  const req = await readRow(store, id);
  await store.transact([
    {
      kind: 'update',
      pk: k.PK,
      sk: k.SK,
      set: {
        status: 'CANCELLED',
        updatedAt: new Date().toISOString(),
        events: [...req.events, { at: new Date().toISOString(), type: 'cancelled', label: 'Cancelled by Sari', actor: 'sari' }],
      },
      ifEquals: { attr: 'status', value: req.status },
    },
  ]);
}

const readRow = async (store: ConfigStore, id: string): Promise<RequestItem> => {
  const k = requestKey('sample', id);
  return (await store.get(k.PK, k.SK)) as RequestItem;
};

/** The `request-bundle` entries in this month's chain partition, ULID-ordered. */
async function bundleAuditEntries(store: ConfigStore): Promise<Array<Record<string, unknown>>> {
  const pk = auditKey('sample', yyyymm(new Date()), 'x').PK;
  const rows = (await store.query(pk)) as Array<Record<string, unknown>>;
  return rows.filter((r) => r.action === 'request-bundle');
}

describe('CONC-6 gap 1 — a THROWN bundle still reaches a terminal state', () => {
  it('THE DEFECT: a throw used to leave `bundle.state:running` and answer 500', async () => {
    // A real, un-simulated throw from the very first line of `prepare`: `mkdtempSync`
    // against a TMPDIR that does not exist. This is the ENOSPC/EACCES class the finding
    // names, and it happens BEFORE `runBundle`'s own try/finally, so nothing inside the
    // module catches it.
    armFastGate();
    const { store, app, id } = await seededApp();
    process.env.TMPDIR = join(tmpdir(), 'ccp-conc6-does-not-exist', 'nor-this');

    const res = await apply(app, await sessionCookieFor(store, 'lina'), id);

    expect(res.status, 'a failed bundle is a 502, not an opaque 500').toBe(502);
    const body = (await res.json()) as { ok: boolean; bundle: { state: string }; steps: Array<{ detail: string }> };
    expect(body.ok).toBe(false);
    expect(body.bundle.state).toBe('failed');
    expect(body.steps[0]?.detail, 'the error is carried, not swallowed').toMatch(/threw before reporting a step/);

    const row = await readRow(store, id);
    expect(row.bundle?.state, 'the claim must NOT be left running').toBe('failed');
  });

  it('a request whose bundle threw is immediately re-appliable — no hour-long wedge', async () => {
    armFastGate();
    const { store, app, id } = await seededApp();
    const goodTmp = process.env.TMPDIR;
    process.env.TMPDIR = join(tmpdir(), 'ccp-conc6-does-not-exist');

    const cookie = await sessionCookieFor(store, 'lina');
    expect((await apply(app, cookie, id)).status).toBe(502);

    // The operator fixes the disk and retries at once. Under the defect this answered
    // 409 BUNDLE_RUNNING until the lease aged out an hour later.
    if (goodTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = goodTmp;
    const second = await apply(app, cookie, id);
    expect(second.status, 'the retry must actually run').toBe(200);
    expect((await readRow(store, id)).bundle?.state).toBe('triggered');
  });

  it('the throw is recorded in the audit chain, not only in the response', async () => {
    armFastGate();
    const { store, app, id } = await seededApp();
    process.env.TMPDIR = join(tmpdir(), 'ccp-conc6-does-not-exist');

    await apply(app, await sessionCookieFor(store, 'lina'), id);

    const entries = await bundleAuditEntries(store);
    expect(entries, 'a fired-or-failed bundle always leaves an entry').toHaveLength(1);
    expect((entries[0]!.after as { bundle: { state: string } }).bundle.state).toBe('failed');
  });
});

describe('CONC-6 gap 2 — a cancel that lands mid-bundle is not erased', () => {
  it('THE DEFECT: the outcome write replaced `events` with a pre-bundle snapshot', async () => {
    const { release, started } = armBlockingGate();
    const { store, app, id } = await seededApp();

    // Start the bundle and wait until the gate is provably executing inside the
    // checkout — the claim is written, the clone is done, and we are mid-run.
    const inFlight = apply(app, await sessionCookieFor(store, 'lina'), id);
    await waitFor(started, 'the gate to start');
    expect((await readRow(store, id)).bundle?.state, 'the setup must really be mid-bundle').toBe('running');

    // A cancel commits while it runs. API-5 now refuses this at the front door; what is
    // left is the read-then-act sliver behind that guard, which is what this models.
    const beforeCancel = await readRow(store, id);
    await cancelBehindTheGuard(store, id);
    const mid = await readRow(store, id);
    expect(mid.status, 'the cancel must really have landed — otherwise this proves nothing').toBe('CANCELLED');
    expect(mid.events.some((e) => e.type === 'cancelled')).toBe(true);
    expect(mid.eventSeq, 'and it must NOT have moved eventSeq, or the bundle would simply be refused and this would be testing gap 3').toBe(beforeCancel.eventSeq);

    writeFileSync(release, '');
    await inFlight;

    const row = await readRow(store, id);
    expect(row.status, 'the cancel stands').toBe('CANCELLED');
    expect(
      row.events.filter((e) => e.type === 'cancelled'),
      'THE DEFECT: the bundle outcome used to overwrite `events` with the pre-bundle array, deleting this',
    ).toHaveLength(1);
    expect(
      row.events.some((e) => e.type === 'bundle-triggered'),
      'and the deploy that DID fire is on the timeline too',
    ).toBe(true);
  });

  it('the bundle still reaches a terminal state over a cancel — the deploy fired', async () => {
    // Cancelling does not un-fire a CI trigger. `bundle` must record what happened.
    const { release, started } = armBlockingGate();
    const { store, app, id } = await seededApp();

    const inFlight = apply(app, await sessionCookieFor(store, 'lina'), id);
    await waitFor(started, 'the gate to start');
    await cancelBehindTheGuard(store, id);
    writeFileSync(release, '');

    const res = await inFlight;
    expect(res.status).toBe(200);
    const row = await readRow(store, id);
    expect(row.bundle?.state).toBe('triggered');
    expect(row.bundle?.sha, 'a real commit landed').toMatch(/^[0-9a-f]{40}$/);
  });

  it('the audit entry reports the status the row ACTUALLY settled to', async () => {
    // Recording `after.status: 'AWAITING_DEPLOY_APPROVAL'` for a request that is
    // cancelled by the time the entry is written would make the chain lie about the
    // one thing a reader consults it for.
    const { release, started } = armBlockingGate();
    const { store, app, id } = await seededApp();

    const inFlight = apply(app, await sessionCookieFor(store, 'lina'), id);
    await waitFor(started, 'the gate to start');
    await cancelBehindTheGuard(store, id);
    writeFileSync(release, '');
    await inFlight;

    const entries = await bundleAuditEntries(store);
    expect(entries).toHaveLength(1);
    const after = entries[0]!.after as { status: string; bundle: { state: string } };
    expect(after.status).toBe('CANCELLED');
    expect(after.bundle.state).toBe('triggered');
    expect((entries[0]!.before as { status: string }).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });
});

describe('CONC-6 gap 3 — a row that moved past the claim still gets its evidence recorded', () => {
  it('THE DEFECT: CHAIN_CONTENTION used to be thrown with NOTHING written after the trigger fired', async () => {
    const { release, started } = armBlockingGate();
    const { store, app, id } = await seededApp();

    const inFlight = apply(app, await sessionCookieFor(store, 'lina'), id);
    await waitFor(started, 'the gate to start');

    // Move the row past this run's claim — what a lease takeover by a second apply does.
    // The bundle's `ifEquals eventSeq=claimSeq` guard will now refuse, correctly.
    const k = requestKey('sample', id);
    const mid = await readRow(store, id);
    await store.transact([
      { kind: 'update', pk: k.PK, sk: k.SK, set: { eventSeq: (mid.eventSeq ?? 0) + 5 }, ifEquals: { attr: 'eventSeq', value: mid.eventSeq } },
    ]);

    writeFileSync(release, '');
    const res = await inFlight;

    expect(res.status, 'a specific 409, not a 500 and not a silent 200').toBe(409);
    const body = (await res.json()) as { code: string; ok: boolean; steps: Array<{ step: string; ok: boolean }> };
    expect(body.code).toBe('BUNDLE_ROW_MOVED');
    expect(body.ok, 'the bundle itself really did succeed — that is the whole problem').toBe(true);
    expect(body.steps.some((s) => s.step === 'trigger' && s.ok), 'the deploy gate was satisfied').toBe(true);

    // THE FIX: the evidence lands anyway, flagged as an orphan.
    const entries = await bundleAuditEntries(store);
    expect(entries, 'a fired trigger must never be unrecorded').toHaveLength(1);
    const after = entries[0]!.after as { requestRowMoved?: boolean; bundle: { state: string; sha?: string } };
    expect(after.requestRowMoved).toBe(true);
    expect(after.bundle.state).toBe('triggered');
    expect(after.bundle.sha, 'the landed commit is named, so an operator can find it').toMatch(/^[0-9a-f]{40}$/);
  });

  it('the orphan entry is chained like any other — the audit chain stays continuous', async () => {
    const { release, started } = armBlockingGate();
    const { store, app, id } = await seededApp();

    const hk = chainHead('sample');
    const headBefore = (await store.get(hk.PK, hk.SK)) as { count: number; hash: string } | null;

    const inFlight = apply(app, await sessionCookieFor(store, 'lina'), id);
    await waitFor(started, 'the gate to start');
    const k = requestKey('sample', id);
    const mid = await readRow(store, id);
    await store.transact([
      { kind: 'update', pk: k.PK, sk: k.SK, set: { eventSeq: (mid.eventSeq ?? 0) + 5 }, ifEquals: { attr: 'eventSeq', value: mid.eventSeq } },
    ]);
    writeFileSync(release, '');
    await inFlight;

    const headAfter = (await store.get(hk.PK, hk.SK)) as { count: number; hash: string; lastUlid: string } | null;
    expect(headAfter?.count ?? 0, 'the chain head advanced — the entry is linked, not appended loose').toBe((headBefore?.count ?? 0) + 1);
    expect(headAfter?.hash, 'and it is hash-chained, so it cannot be back-dated').not.toBe(headBefore?.hash);

    const entries = await bundleAuditEntries(store);
    expect(entries).toHaveLength(1);
    expect(headAfter?.lastUlid, 'the head points AT the orphan entry').toBe(entries[0]!.SK);
  });

  it('the row itself is left alone — the winner of the race is not overwritten', async () => {
    const { release, started } = armBlockingGate();
    const { store, app, id } = await seededApp();

    const inFlight = apply(app, await sessionCookieFor(store, 'lina'), id);
    await waitFor(started, 'the gate to start');
    const k = requestKey('sample', id);
    const mid = await readRow(store, id);
    await store.transact([
      { kind: 'update', pk: k.PK, sk: k.SK, set: { eventSeq: (mid.eventSeq ?? 0) + 5, status: 'APPLIED' }, ifEquals: { attr: 'eventSeq', value: mid.eventSeq } },
    ]);
    writeFileSync(release, '');
    await inFlight;

    const row = await readRow(store, id);
    expect(row.status, "the other writer's state stands").toBe('APPLIED');
    expect(row.eventSeq).toBe((mid.eventSeq ?? 0) + 5);
  });
});
