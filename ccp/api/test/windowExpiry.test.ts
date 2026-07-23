import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import type { AuditItem } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seed, sessionCookieFor, setSetting } from './helpers/seed';

/**
 * T-S4 (0024 §2.3/§2.5) — lazy WINDOW_EXPIRED stamping on read (write-on-read, no
 * background timer — mirrors cooling.test.ts's own "lazy settlement" describe
 * block for the cooling half) and the widened POST /:id/cancel valid-state set
 * (0024 §6.4-C5). `scheduleQuorum.test.ts` already covers the EAGER quorum-met
 * WINDOW_EXPIRED path (E10); this file covers the LAZY read-time path.
 */

const WINDOW_DRAFT = (at: string, endAt: string) => ({
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'window' as const, at, endAt },
});

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
function cancel(app: Hono<AppEnv>, cookie: string, id: string) {
  return app.request(`/requests/${id}/cancel`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });
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

/** A fully-approved, non-interim, windowed request sitting in AWAITING_DEPLOY_APPROVAL. */
async function windowedRequest(store: ConfigStore, app: Hono<AppEnv>, at: string, endAt: string): Promise<{ id: string }> {
  const created = await (await submit(app, await sessionCookieFor(store, 'sari'), WINDOW_DRAFT(at, endAt))).json();
  await approve(app, await sessionCookieFor(store, 'budi'), created.id);
  const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
  expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');
  return { id: created.id };
}

afterEach(() => __setNow(null));

describe('lazy WINDOW_EXPIRED settlement — no background timer, evaluated on read/transition', () => {
  it('before the window closes, GET /:id still reports AWAITING_DEPLOY_APPROVAL', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);

    __setNow(() => Date.parse(endAt) - 1000);
    const read = await (await get(app, `/requests/${id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(read.status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('GET /:id past the window end settles to WINDOW_EXPIRED and records request-window-expired', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);

    __setNow(() => Date.parse(endAt) + 1000);
    const read = await (await get(app, `/requests/${id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(read.status).toBe('WINDOW_EXPIRED');
    expect(read.events.some((e: { type: string }) => e.type === 'window_expired')).toBe(true);

    const entries = await auditActions(store, 'request-window-expired', id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('system:window-elapsed');
    expect((entries[0]!.before as { status: string }).status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect((entries[0]!.after as { status: string }).status).toBe('WINDOW_EXPIRED');
  });

  it('the list endpoint (scope=mine) ALSO settles an elapsed window', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);

    __setNow(() => Date.parse(endAt) + 1000);
    const list = await (await get(app, '/requests?scope=mine', await sessionCookieFor(store, 'sari'))).json();
    const item = list.items.find((x: { id: string }) => x.id === id);
    expect(item.status).toBe('WINDOW_EXPIRED');
  });

  it('the feasibility endpoint ALSO settles an elapsed window before answering', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);

    __setNow(() => Date.parse(endAt) + 1000);
    const feas = await (await get(app, `/requests/${id}/feasibility`, await sessionCookieFor(store, 'sari'))).json();
    expect(feas.status).toBe('WINDOW_EXPIRED');
  });

  it('a freeze-held schedule:"now" row in AWAITING_DEPLOY_APPROVAL never expires — no window exists to close', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const draft = {
      operationId: 'ebs-grow',
      targetAddress: 'aws_ebs_volume.dwh01',
      params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
      justification: 'grow the volume to 250 GiB for month-end load',
      schedule: { kind: 'now' as const },
    };
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), draft)).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    await setSetting(store, 'sample', 'freeze.global', true);
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');

    __setNow(() => NOW + 365 * 24 * 3600_000); // a year later — still no window to expire
    const read = await (await get(app, `/requests/${created.id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(read.status).toBe('AWAITING_DEPLOY_APPROVAL');
  });
});

describe('POST /requests/:id/cancel — widened valid-state set (0024 §2.5/§6.4-C5)', () => {
  it('cancellable BEFORE the window opens (AWAITING_DEPLOY_APPROVAL) — a neutral label, not the cooling-specific one', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);

    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('CANCELLED');
    const cancelledEvent = body.events.find((e: { type: string }) => e.type === 'cancelled');
    expect(cancelledEvent.label).toBe('Cancelled by Sari');
    expect(cancelledEvent.label).not.toContain('cooling-off');
  });

  it('cancellable DURING an open window (AWAITING_DEPLOY_APPROVAL, now within [start,end))', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);

    __setNow(() => Date.parse(at) + 1000); // now inside the window
    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('CANCELLED');
  });

  it('cancellable AFTER the window expired (WINDOW_EXPIRED) — settles then cancels in one call', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);

    __setNow(() => Date.parse(endAt) + 1000); // past close; nobody read it in between
    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('CANCELLED');

    const entries = await auditActions(store, 'request-cancel', id);
    expect((entries[0]!.before as { status: string }).status).toBe('WINDOW_EXPIRED');
  });

  it('a Lead who is NOT the requester may cancel a WINDOW_EXPIRED request (same senior-override authz as cooling)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);
    __setNow(() => Date.parse(endAt) + 1000);

    const res = await cancel(app, await sessionCookieFor(store, 'putra'), id); // lead+admin, not requester
    expect(res.status).toBe(200);
  });

  it('a plain approver who is neither requester nor Lead/admin → 403 CANCEL_FORBIDDEN, even for WINDOW_EXPIRED', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);
    __setNow(() => Date.parse(endAt) + 1000);

    const res = await cancel(app, await sessionCookieFor(store, 'budi'), id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CANCEL_FORBIDDEN');
  });

  it('guard: still cannot cancel a still-open (pre-quorum) windowed request', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), WINDOW_DRAFT(at, endAt))).json();
    const res = await cancel(app, await sessionCookieFor(store, 'sari'), created.id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('guard: still cannot cancel an already-CANCELLED request twice — exactly one audit entry', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const endAt = new Date(NOW + 2 * 3600_000).toISOString();
    const { id } = await windowedRequest(store, app, at, endAt);
    const sari = await sessionCookieFor(store, 'sari');

    const first = await cancel(app, sari, id);
    expect(first.status).toBe(200);
    const second = await cancel(app, sari, id);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('STATE_CONFLICT');

    const entries = await auditActions(store, 'request-cancel', id);
    expect(entries).toHaveLength(1);
  });
});
