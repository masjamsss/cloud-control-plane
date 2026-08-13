import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { BUNDLE_LEASE_MS } from '../src/domain/bundleClaim';
import { requestKey } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor, SAMPLE_PROJECT_ID } from './helpers/seed';

/**
 * API-5 — cancel could race an in-flight bundle. `AWAITING_DEPLOY_APPROVAL` is
 * cancellable, and the bundle claim (API-4) deliberately leaves `status` untouched, so a
 * cancel issued while a bundle is mid-flight used to succeed unconditionally: the durable
 * record said CANCELLED while the bundle went on to land the commit on `main` and fire the
 * CI apply trigger. Fixed by refusing cancel while the SAME claim `/apply` itself checks
 * (ERR-2) is LIVE — an expired claim (a crashed run) does not block it, for the same
 * reason a crashed run must not wedge `/apply` either.
 */

function cancel(app: ReturnType<typeof createApp>, cookie: string, id: string) {
  return app.request(`/requests/${id}/cancel`, {
    method: 'POST',
    headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': SAMPLE_PROJECT_ID },
  });
}

async function setup(bundle: { state: 'running' | 'triggered' | 'failed'; at: string; sha?: string } | undefined) {
  const store = new MemoryStore();
  await seed(store);
  const id = 'seed-sari-0';
  await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 1, {
    status: 'AWAITING_DEPLOY_APPROVAL',
    ...(bundle !== undefined ? { bundle } : {}),
  });
  const app = createApp(store);
  const sari = await sessionCookieFor(store, 'sari');
  return { store, app, sari, id };
}

describe('API-5 — cancel refuses while an apply bundle is actively in flight', () => {
  it('a LIVE claim (bundle just started) blocks cancel with BUNDLE_RUNNING', async () => {
    const { app, sari, id } = await setup({ state: 'running', at: new Date().toISOString() });
    const res = await cancel(app, sari, id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BUNDLE_RUNNING');
  });

  it('THE DEFECT: without the guard, the request would have been cancelled out from under a running bundle', async () => {
    // Same fixture as above, but asserts the row is UNCHANGED — pinning that the refusal
    // really did stop the write, not just that the response looked like a refusal.
    const { store, app, sari, id } = await setup({ state: 'running', at: new Date().toISOString() });
    const key = requestKey(SAMPLE_PROJECT_ID, id);
    const before = (await store.get(key.PK, key.SK)) as { status?: string } | null;
    await cancel(app, sari, id);
    const after = (await store.get(key.PK, key.SK)) as { status?: string } | null;
    expect(after?.status).toBe(before?.status);
    expect(after?.status).not.toBe('CANCELLED');
  });

  it('an EXPIRED claim (crashed run, past the lease) does NOT block cancel', async () => {
    // L-1: the fixture must actually be past the lease, or this proves nothing.
    const staleAt = new Date(Date.now() - (BUNDLE_LEASE_MS + 60_000)).toISOString();
    expect(Date.now() - Date.parse(staleAt)).toBeGreaterThan(BUNDLE_LEASE_MS);
    const { app, sari, id } = await setup({ state: 'running', at: staleAt });
    const res = await cancel(app, sari, id);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('CANCELLED');
  });

  it('a request with NO bundle claim at all cancels normally (control)', async () => {
    const { app, sari, id } = await setup(undefined);
    const res = await cancel(app, sari, id);
    expect(res.status).toBe(200);
  });

  it('a bundle already TRIGGERED (finished, not running) does not block cancel', async () => {
    // bundle.state:'triggered' is a terminal outcome, not a live claim — nothing is still
    // in flight, so this guard (specifically about a claim still running) must not fire.
    const { app, sari, id } = await setup({ state: 'triggered', sha: 'deadbeef', at: new Date().toISOString() });
    const res = await cancel(app, sari, id);
    expect(res.status).toBe(200);
  });
});
