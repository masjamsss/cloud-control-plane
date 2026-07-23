import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, type AccountItem, type AuditItem } from '../src/store/schema';
import { coolingElapsed, coolingTargetStatus } from '../src/domain/cooling';
import { __setNow } from '../src/clock';
import { seed, seedAccount, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * 0021 F1/G1 — the ADR-0009 24h cooling-off state machine, enforced. 0037 DISABLED the
 * single-approver interim profile at its entry point: a NEW request can no longer enter
 * APPROVED_COOLING (a riskier change needs both ladder steps signed by two distinct
 * people). But the cooling STATE MACHINE (settleCooling + the cancel verb) stays intact
 * so any LEGACY row a pre-0037 build already parked mid-cooling still settles/cancels
 * correctly — "disable, don't rip out". These tests seed such legacy rows directly.
 */

const GUARDRAILS_DRAFT = {
  operationId: 'ebs-grow', // l1_with_guardrails → ladder [L2, L3]
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};
const WINDOW_DRAFT = { ...GUARDRAILS_DRAFT, schedule: { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z' } };

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE). This suite predates that concept
// and always meant "act on the sample estate".
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

/**
 * Seed a LEGACY APPROVED_COOLING row (as a pre-0037 interim completion would have left
 * it): one recorded approval, interimProfile flag, an earliestApplyAt deadline. Returns
 * its id (`seed-sari-0`).
 */
async function seedCoolingRow(
  store: ConfigStore,
  earliestApplyAt: string,
  schedule: { kind: 'now' } | { kind: 'window'; at: string; endAt?: string } = { kind: 'now' },
): Promise<string> {
  await seedRequests(store, 'sample', 'sari', 1, {
    status: 'APPROVED_COOLING',
    interimProfile: true,
    earliestApplyAt,
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    approvalsRequired: 2,
    approvals: [{ user: 'budi', at: '2020-01-01T00:00:00.000Z' }],
    schedule,
  });
  return 'seed-sari-0';
}

async function auditActions(store: ConfigStore, action: string, requestId: string): Promise<AuditItem[]> {
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
  return entries.filter((e) => e.action === action && e.requestId === requestId);
}

afterEach(() => __setNow(null));

describe('domain/cooling.ts — pure helpers', () => {
  it('coolingElapsed is true only for APPROVED_COOLING past its earliestApplyAt', () => {
    expect(coolingElapsed({ status: 'APPROVED_COOLING', earliestApplyAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-01-01T00:00:01.000Z'))).toBe(true);
    expect(coolingElapsed({ status: 'APPROVED_COOLING', earliestApplyAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2025-12-31T23:59:59.000Z'))).toBe(false);
    expect(coolingElapsed({ status: 'APPLIED', earliestApplyAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2027-01-01T00:00:00.000Z'))).toBe(false);
    expect(coolingElapsed({ status: 'APPROVED_COOLING', earliestApplyAt: undefined }, Date.now())).toBe(false);
  });

  it('coolingTargetStatus follows the ORIGINAL schedule', () => {
    expect(coolingTargetStatus({ kind: 'now' })).toBe('APPLIED');
    expect(coolingTargetStatus({ kind: 'window', at: '2026-08-01T00:00:00.000Z' })).toBe('AWAITING_DEPLOY_APPROVAL');
  });
});

describe('0037: a completed ladder never enters APPROVED_COOLING (the interim entry point is gone)', () => {
  it('two distinct signers, schedule "now" → APPLIED (never cooling)', async () => {
    const store = new MemoryStore();
    await seed(store); // full estate → real 2-of-2 ladder
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id); // L2
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json(); // L3
    expect(done.interimProfile).toBeUndefined();
    expect(done.status).toBe('APPLIED');
  });

  it('two distinct signers, schedule "window" → AWAITING_DEPLOY_APPROVAL (never cooling)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), WINDOW_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(done.status).not.toBe('APPROVED_COOLING');
  });

  it('a thin bench (one eligible approver, no lead) never produces cooling — it stalls at 1/2', async () => {
    const store = new MemoryStore();
    await seed(store);
    for (const id of ['putra', 'lina']) {
      const k = accountKey(id);
      const acc = (await store.get(k.PK, k.SK)) as AccountItem;
      await store.put({ ...acc, status: 'disabled' });
    }
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    const done = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(done.status).toBe('AWAITING_CODE_REVIEW');
    expect(done.status).not.toBe('APPROVED_COOLING');
    expect(done.interimProfile).toBeUndefined();
    expect(done.earliestApplyAt).toBeUndefined();
  });
});

describe('lazy settlement of a LEGACY cooling row — no background timer, evaluated on read', () => {
  it('before the deadline, GET /:id still reports APPROVED_COOLING', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2026-07-20T00:00:00.000Z'); // future deadline
    const app = createApp(store);
    __setNow(() => Date.parse('2026-07-16T00:00:00.000Z')); // before the deadline
    const read = await (await get(app, `/requests/${id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(read.status).toBe('APPROVED_COOLING');
  });

  it('GET /:id past earliestApplyAt settles to APPLIED (schedule "now") and records request-apply', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2020-01-01T00:00:00.000Z'); // already elapsed
    const app = createApp(store);
    const read = await (await get(app, `/requests/${id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(read.status).toBe('APPLIED');

    const applyEntries = await auditActions(store, 'request-apply', id);
    expect(applyEntries).toHaveLength(1);
    expect((applyEntries[0]!.before as { status: string }).status).toBe('APPROVED_COOLING');
    expect((applyEntries[0]!.after as { status: string }).status).toBe('APPLIED');
  });

  it('GET /:id past earliestApplyAt settles to AWAITING_DEPLOY_APPROVAL (schedule "window")', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2020-01-01T00:00:00.000Z', { kind: 'window', at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' });
    const app = createApp(store);
    const read = await (await get(app, `/requests/${id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(read.status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('the list endpoint (scope=mine) ALSO settles an elapsed legacy cooling row', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2020-01-01T00:00:00.000Z');
    const app = createApp(store);
    const list = await (await get(app, '/requests?scope=mine', await sessionCookieFor(store, 'sari'))).json();
    const item = list.items.find((x: { id: string }) => x.id === id);
    expect(item.status).toBe('APPLIED');
  });
});

describe('POST /requests/:id/cancel — the cooling-window cancel verb (legacy rows)', () => {
  it('happy path: the requester cancels their own cooling request → CANCELLED + audited', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2026-07-20T00:00:00.000Z'); // still cooling
    const app = createApp(store);
    __setNow(() => Date.parse('2026-07-16T00:00:00.000Z')); // freeze before the deadline (else wall-clock elapses it)

    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('CANCELLED');
    expect(body.events.some((e: { type: string }) => e.type === 'cancelled')).toBe(true);

    const entries = await auditActions(store, 'request-cancel', id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('sari');
    expect((entries[0]!.before as { status: string }).status).toBe('APPROVED_COOLING');
    expect((entries[0]!.after as { status: string }).status).toBe('CANCELLED');
  });

  it('a Lead who is NOT the requester may also cancel', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2026-07-20T00:00:00.000Z');
    const app = createApp(store);
    __setNow(() => Date.parse('2026-07-16T00:00:00.000Z')); // freeze before the deadline (else wall-clock elapses it)
    const res = await cancel(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('CANCELLED');
  });

  it('an admin who is NOT a Lead may also cancel (requester + Lead/admin authz)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2026-07-20T00:00:00.000Z');
    await seedAccount(store, { id: 'nadia', role: 'approver', teamId: 'app-platform', isAdmin: true });
    const app = createApp(store);
    __setNow(() => Date.parse('2026-07-16T00:00:00.000Z')); // freeze before the deadline (else wall-clock elapses it)
    const res = await cancel(app, await sessionCookieFor(store, 'nadia'), id);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('CANCELLED');
  });

  it('a plain approver who is neither the requester nor Lead/admin → 403 CANCEL_FORBIDDEN', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2026-07-20T00:00:00.000Z');
    const app = createApp(store);
    __setNow(() => Date.parse('2026-07-16T00:00:00.000Z')); // freeze before the deadline (else wall-clock elapses it)
    const res = await cancel(app, await sessionCookieFor(store, 'budi'), id); // budi = plain approver
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CANCEL_FORBIDDEN');
  });

  it('guard: cannot cancel an already-APPLIED (completed) request', async () => {
    const store = new MemoryStore();
    await seed(store); // full estate → real ladder, no cooling
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(done.status).toBe('APPLIED');

    const res = await cancel(app, await sessionCookieFor(store, 'sari'), created.id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('guard: cannot cancel a still-open (pre-quorum) request', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    const res = await cancel(app, await sessionCookieFor(store, 'sari'), created.id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('guard: cannot cancel a REJECTED request', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    await app.request(`/requests/${created.id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie: await sessionCookieFor(store, 'budi') },
      body: JSON.stringify({}),
    });
    const res = await cancel(app, await sessionCookieFor(store, 'sari'), created.id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('guard: a window that elapsed since the last read settles-then-refuses (lazy, not stale)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2020-01-01T00:00:00.000Z'); // already elapsed
    const app = createApp(store);

    // Nobody reads the request in between — cancel itself must settle it first.
    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');

    const read = await (await get(app, `/requests/${id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(read.status).toBe('APPLIED');
  });

  it('idempotent-safe: cancelling twice succeeds once, then cleanly conflicts — exactly one audit entry', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await seedCoolingRow(store, '2026-07-20T00:00:00.000Z'); // still cooling
    const app = createApp(store);
    __setNow(() => Date.parse('2026-07-16T00:00:00.000Z')); // freeze before the deadline (else wall-clock elapses it)
    const sari = await sessionCookieFor(store, 'sari');

    const first = await cancel(app, sari, id);
    expect(first.status).toBe(200);
    const second = await cancel(app, sari, id);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('STATE_CONFLICT');

    const entries = await auditActions(store, 'request-cancel', id);
    expect(entries).toHaveLength(1);
  });

  it('cancelling a request that does not exist → 404', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await cancel(app, await sessionCookieFor(store, 'sari'), 'no-such-id');
    expect(res.status).toBe(404);
  });
});
