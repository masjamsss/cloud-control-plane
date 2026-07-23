import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { type AuditItem } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { REWINDOW_STALE_MS } from '../src/domain/schedule';
import { seed, seedRequests, sessionCookieFor, setSetting } from './helpers/seed';

/**
 * T-S4 (0024 §2.4) — POST /requests/:id/rewindow: the exit from WINDOW_EXPIRED
 * (and a before-window re-time of AWAITING_DEPLOY_APPROVAL), same actor set as
 * Lane A's cancel, V2-V6 revalidated, refuses mid-window moves and stale
 * approvals, approvals survive untouched.
 */

const WINDOW_DRAFT = (at: string, endAt: string) => ({
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'window' as const, at, endAt },
});
const NOW_DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function submit(app: Hono<AppEnv>, cookie: string, body: unknown) {
  return app.request('/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}
function approve(app: Hono<AppEnv>, cookie: string, id: string) {
  return app.request(`/requests/${id}/approve`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });
}
function rewindow(app: Hono<AppEnv>, cookie: string, id: string, at: string, endAt?: string) {
  return app.request(`/requests/${id}/rewindow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(endAt !== undefined ? { at, endAt } : { at }),
  });
}
function get(app: Hono<AppEnv>, path: string, cookie: string) {
  return app.request(path, { headers: { cookie, 'x-ccp-project': 'sample' } });
}

async function auditActions(store: ConfigStore, action: string, requestId: string): Promise<AuditItem[]> {
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
  return entries.filter((e) => e.action === action && e.requestId === requestId);
}

const NOW = Date.parse('2026-07-12T12:00:00.000Z');

async function expiredRequest(store: ConfigStore, app: Hono<AppEnv>): Promise<{ id: string }> {
  const at = new Date(NOW + 3600_000).toISOString();
  const endAt = new Date(NOW + 2 * 3600_000).toISOString();
  const created = await (await submit(app, await sessionCookieFor(store, 'sari'), WINDOW_DRAFT(at, endAt))).json();
  await approve(app, await sessionCookieFor(store, 'budi'), created.id);
  await approve(app, await sessionCookieFor(store, 'lina'), created.id);
  __setNow(() => Date.parse(endAt) + 1000); // settle it to WINDOW_EXPIRED on the next touch
  return { id: created.id };
}

afterEach(() => __setNow(null));

describe('POST /requests/:id/rewindow — exiting WINDOW_EXPIRED', () => {
  it('happy path: the requester re-windows an expired request back to AWAITING_DEPLOY_APPROVAL', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);

    const newAt = new Date(NOW + 4 * 3600_000).toISOString();
    const newEnd = new Date(NOW + 5 * 3600_000).toISOString();
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), id, newAt, newEnd);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(body.schedule).toEqual({ kind: 'window', at: newAt, endAt: newEnd });
    expect(body.events.some((e: { type: string }) => e.type === 'rewindowed')).toBe(true);

    const entries = await auditActions(store, 'request-rewindow', id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('sari');
    expect((entries[0]!.before as { status: string }).status).toBe('WINDOW_EXPIRED');
    expect((entries[0]!.after as { status: string }).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('approvals SURVIVE unmoved — the digest binding, not the wall-clock, is what quorum bound to', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);
    const before = await (await get(app, `/requests/${id}`, await sessionCookieFor(store, 'sari'))).json();

    const newAt = new Date(NOW + 4 * 3600_000).toISOString();
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), id, newAt);
    const after = await res.json();
    expect(after.approvals).toEqual(before.approvals);
    expect(after.approvalsRequired).toBe(before.approvalsRequired);
  });

  it('a Lead who is NOT the requester may also re-window (senior override, same set as cancel)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);
    const newAt = new Date(NOW + 4 * 3600_000).toISOString();
    const res = await rewindow(app, await sessionCookieFor(store, 'putra'), id, newAt);
    expect(res.status).toBe(200);
  });

  it('a plain approver who is neither requester nor Lead/admin → 403 REWINDOW_FORBIDDEN', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);
    const newAt = new Date(NOW + 4 * 3600_000).toISOString();
    const res = await rewindow(app, await sessionCookieFor(store, 'budi'), id, newAt);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REWINDOW_FORBIDDEN');
  });

  it('re-validates V2-V6: a too-soon new `at` is refused SCHEDULE_TOO_SOON', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), id, new Date(NOW + 60_000).toISOString());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_TOO_SOON');
  });

  it('re-validates V2-V6: a garbled `at` is refused SCHEDULE_INVALID', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), id, 'banana');
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_INVALID');
  });

  it('refuses re-arming an equally-doomed window: a LEGACY cooling deadline would STILL outlast the new window', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    // 0037 never stamps earliestApplyAt on new requests, but the rewindow guard must still
    // refuse re-arming a window that ends before a LEGACY row's cooling deadline. Seed such
    // a pre-0037 row directly: interim-completed + windowed, its window already closed
    // (WINDOW_EXPIRED) but its cooling-off deadline still +24h out.
    await seedRequests(store, 'sample', 'sari', 1, {
      status: 'WINDOW_EXPIRED',
      interimProfile: true,
      earliestApplyAt: new Date(NOW + 24 * 3600_000).toISOString(),
      exposure: 'l1_with_guardrails',
      operationId: 'ebs-grow',
      approvalsRequired: 2,
      approvals: [{ user: 'budi', at: new Date(NOW).toISOString() }], // recent → not stale
      schedule: { kind: 'window', at: new Date(NOW - 2 * 3600_000).toISOString(), endAt: new Date(NOW - 3600_000).toISOString() },
    });
    __setNow(() => NOW);

    // Rewindow to a short window that still ends long before the SAME (unmoved)
    // earliestApplyAt — still infeasible.
    const newAt = new Date(NOW + 6 * 3600_000).toISOString();
    const newEnd = new Date(NOW + 7 * 3600_000).toISOString();
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), 'seed-sari-0', newAt, newEnd);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_INVALID');
  });

  it('refuses a schedule.kind:"now" request (a freeze-held row has no window to move)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), NOW_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    await setSetting(store, 'sample', 'freeze.global', true);
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');

    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), created.id, new Date(NOW + 3600_000).toISOString());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('refuses a request that is still open (pre-quorum) — 409 STATE_CONFLICT', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), WINDOW_DRAFT(at, endAt))).json();
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), created.id, new Date(NOW + 5 * 3600_000).toISOString());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('refuses moving the goalposts mid-window: an AWAITING_DEPLOY_APPROVAL request whose window is CURRENTLY open', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 5 * 3600_000).toISOString();
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), WINDOW_DRAFT(at, endAt))).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');

    __setNow(() => Date.parse(at) + 1000); // now inside the window
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), created.id, new Date(NOW + 6 * 3600_000).toISOString());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('allows re-timing BEFORE the window opens (AWAITING_DEPLOY_APPROVAL, still cooling/before-start)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 5 * 3600_000).toISOString();
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), WINDOW_DRAFT(at, endAt))).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');

    // still BEFORE the window (now unchanged) — rewindow should be allowed.
    const newAt = new Date(NOW + 10 * 3600_000).toISOString();
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), created.id, newAt);
    expect(res.status).toBe(200);
    expect((await res.json()).schedule.at).toBe(newAt);
  });

  it('staleness: refuses re-windowing a request whose last approval is more than 30 days old', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);

    __setNow(() => NOW + REWINDOW_STALE_MS + 3600_000); // 30d + 1h since the last approval
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), id, new Date(NOW + REWINDOW_STALE_MS + 2 * 3600_000).toISOString());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_STALE_APPROVAL');
  });

  it('staleness boundary: exactly at 30 days is still fine (only STRICTLY over refuses)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);
    const before = await (await get(app, `/requests/${id}`, await sessionCookieFor(store, 'sari'))).json();
    const lastApprovalAt = Date.parse(before.approvals.at(-1).at);

    __setNow(() => lastApprovalAt + REWINDOW_STALE_MS);
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), id, new Date(lastApprovalAt + REWINDOW_STALE_MS + 3600_000).toISOString());
    expect(res.status).toBe(200);
  });

  it('cancelling a request that does not exist → 404', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await rewindow(app, await sessionCookieFor(store, 'sari'), 'no-such-id', new Date(Date.now() + 3600_000).toISOString());
    expect(res.status).toBe(404);
  });

  it('idempotent-safe under a race: two concurrent rewindows both targeting the SAME (fresh) status succeed once each, sequentially — no double-apply', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const { id } = await expiredRequest(store, app);

    const at1 = new Date(NOW + 4 * 3600_000).toISOString();
    const r1 = await rewindow(app, await sessionCookieFor(store, 'sari'), id, at1);
    expect(r1.status).toBe(200);

    // A second rewindow immediately after (now AWAITING_DEPLOY_APPROVAL, before its
    // new window opens) should ALSO succeed — rewindow is repeatable, not one-shot.
    const at2 = new Date(NOW + 20 * 3600_000).toISOString();
    const r2 = await rewindow(app, await sessionCookieFor(store, 'sari'), id, at2);
    expect(r2.status).toBe(200);
    expect((await r2.json()).schedule.at).toBe(at2);

    const entries = await auditActions(store, 'request-rewindow', id);
    expect(entries).toHaveLength(2);
  });
});
