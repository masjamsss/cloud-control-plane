import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * API-5 — cancel could race an in-flight bundle: the change applied and the request read
 * `CANCELLED`.
 *
 * `AWAITING_DEPLOY_APPROVAL` is cancellable and the bundle claim deliberately leaves
 * `status` untouched, so cancel's `ifEquals status=…` guard held while a bundle was
 * mid-flight. The bundle went on to land its CAS commit on `main` and satisfy the CI
 * apply gate; the durable record said the change was cancelled. The lead who clicked
 * cancel was told it had worked, on exactly the class of request this system exists to
 * govern.
 *
 * **The fix is a refusal, and that is not a smaller cancel — it is the only honest one.**
 * Nothing in this process could ever have stopped a commit that has already been pushed,
 * so the choice was never "stop it or don't"; it was "refuse, or claim to have stopped
 * it". Two durable facts gate it, not a guess:
 *
 *   - `bundle.state === 'running'` with a LIVE claim — a bundle is executing now. ERR-2's
 *     lease bounds the refusal to the lease window, so a run that died never wedges
 *     cancel; an expired claim is not a bundle.
 *   - `bundle.state === 'triggered'` — the commit landed and the gate fired. Not a race,
 *     just over. `POST /:id/apply` already refuses this row for the same reason.
 *
 * What is deliberately NOT claimed: this closes the window, it does not make the check
 * atomic. Between the read and the write a claim can still be taken. That sliver is
 * covered from the other end by CONC-6 — the bundle merges into the timeline instead of
 * replacing it, so a cancel that slips through is recorded alongside the outcome rather
 * than erasing it or being erased. See `test/bundleCrashRecovery.test.ts`.
 */

const ENV_KEYS = ['CCP_BUNDLE', 'CCP_GIT_REMOTE', 'CCP_GIT_BRANCH', 'CCP_BUNDLE_GATE_CMD', 'CCP_BUNDLE_TRIGGER_CMD'] as const;
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

function makeOrigin(): string {
  const root = mkdtempSync(join(tmpdir(), 'cancel-race-'));
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

/** A gate that blocks until released, so the cancel is issued while the bundle really runs. */
function armBlockingGate(): { started: string; release: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-gate-'));
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

async function waitFor(path: string, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (${path})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function seededApp(bundle?: RequestItem['bundle']): Promise<{ store: ConfigStore; app: ReturnType<typeof createApp>; id: string }> {
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
  return { store, app: createApp(store), id: 'seed-sari-0' };
}

const apply = async (app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/apply`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });

const cancel = async (app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/cancel`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });

const readRow = async (store: ConfigStore, id: string): Promise<RequestItem> => {
  const k = requestKey('sample', id);
  return (await store.get(k.PK, k.SK)) as RequestItem;
};

const HOUR = 60 * 60_000;

describe('API-5 — cancel refuses while a bundle is in flight', () => {
  it('THE DEFECT: a cancel issued mid-bundle used to succeed, and the change applied anyway', async () => {
    // The whole race, end to end, through the real routes: the bundle is provably
    // executing (it is blocked inside the gate command, in a real checkout, having
    // already claimed the row) when the requester clicks cancel.
    const { started, release } = armBlockingGate();
    const { store, app, id } = await seededApp();

    const inFlight = apply(app, await sessionCookieFor(store, 'lina'), id);
    await waitFor(started, 'the gate to start');
    expect((await readRow(store, id)).bundle?.state, 'the setup must really be mid-bundle').toBe('running');

    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status, 'the cancel must be refused, not silently accepted').toBe(409);
    expect((await res.json()).code).toBe('BUNDLE_RUNNING');

    writeFileSync(release, '');
    await inFlight;

    const row = await readRow(store, id);
    expect(row.status, 'THE DEFECT: this used to read CANCELLED for a change that applied').not.toBe('CANCELLED');
    expect(row.bundle?.state, 'and the change really did apply — that is what makes the lie a lie').toBe('triggered');
  });

  it('refuses a cancel on a request whose bundle already landed — not a race, just over', async () => {
    const { store, app, id } = await seededApp({ state: 'triggered', sha: 'a'.repeat(40), at: new Date().toISOString() });

    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe('BUNDLE_TRIGGERED');
    expect(body.reason, 'the operator is told what landed, so they can go find it').toContain('aaaaaaaaa');
    expect((await readRow(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('an EXPIRED claim does not block cancel — a dead run is not a bundle', async () => {
    // The refusal must be bounded by the same lease the apply route uses (ERR-2).
    // Otherwise a crashed bundle wedges cancel too, and cancel is the documented exit
    // from a stuck request — the wedge would close the only door out.
    const { store, app, id } = await seededApp({ state: 'running', at: new Date(Date.now() - 2 * HOUR).toISOString() });

    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status, 'a stale claim must not hold the request hostage').toBe(200);
    expect((await readRow(store, id)).status).toBe('CANCELLED');
  });

  it('a FAILED bundle leaves the request cancellable — the refusal is temporary by design', async () => {
    const { store, app, id } = await seededApp({ state: 'failed', at: new Date().toISOString() });

    expect((await cancel(app, await sessionCookieFor(store, 'sari'), id)).status).toBe(200);
    expect((await readRow(store, id)).status).toBe('CANCELLED');
  });

  it('a request with no bundle at all is unaffected — the ordinary cancel still works', async () => {
    // The guard must not have widened cancel's refusal surface for the 99% case.
    const { store, app, id } = await seededApp();

    expect((await cancel(app, await sessionCookieFor(store, 'sari'), id)).status).toBe(200);
    expect((await readRow(store, id)).status).toBe('CANCELLED');
  });
});

describe('API-5 — the property that makes the residual race possible, pinned', () => {
  it('cancel does NOT advance eventSeq, which is why the bundle guard cannot see it', async () => {
    // `test/bundleCrashRecovery.test.ts` models a cancel that slipped through the guard
    // by writing at the store, and its fixture is only faithful while this holds. If a
    // future change makes cancel bump `eventSeq`, that fixture becomes fiction and this
    // test is what says so — rather than the fixture quietly testing nothing.
    const { store, app, id } = await seededApp();
    const before = await readRow(store, id);

    expect((await cancel(app, await sessionCookieFor(store, 'sari'), id)).status).toBe(200);

    const after = await readRow(store, id);
    expect(after.status).toBe('CANCELLED');
    expect(after.eventSeq, 'cancel guards on `status` and advances no sequence').toBe(before.eventSeq);
    expect(after.events.some((e) => e.type === 'cancelled'), 'and it appends to the timeline').toBe(true);
  });
});
