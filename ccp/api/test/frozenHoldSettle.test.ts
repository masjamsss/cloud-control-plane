import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { __setNow, nowIso } from '../src/clock';
import { seed, setSetting, sessionCookieFor } from './helpers/seed';
import { DryRunExecutor } from '../src/domain/apply/executor';
import { runDueApplies } from '../src/domain/apply/scheduler';

/**
 * API-8 — a `kind:'now'` request whose ladder completed DURING a change freeze was
 * parked in `AWAITING_DEPLOY_APPROVAL` with a `held_frozen` event, and nothing ever
 * completed it once the freeze lifted:
 *
 *  - `settleWindow` returns immediately for a schedule that is not `kind:'window'`,
 *  - the scheduler only ever considers windowed rows (`isDue` → `windowOpen`), and is
 *    off by default anyway,
 *  - `rewindow` refuses a non-window schedule outright,
 *  - the bundle is disarmed by default.
 *
 * So the identical change approved one minute after the unfreeze was stamped APPLIED
 * instantly, while the held one waited forever with cancel as its only exit. Its terminal
 * fate depended entirely on which side of the freeze the last signature landed.
 *
 * `settleFrozenHold` is the missing half of the quorum-met decision: the freeze DEFERRED
 * a status decision, and the deferral ends when the freeze does.
 */

const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const PROJECT = 'sample';

const NOW_DRAFT = {
  operationId: 'ebs-grow', // l1_with_guardrails → ladder [L2, L3]
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

async function submit(app: Hono<AppEnv>, cookie: string, body: unknown): Promise<Response> {
  return app.request('/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT },
    body: JSON.stringify(body),
  });
}
async function approve(app: Hono<AppEnv>, cookie: string, id: string): Promise<Response> {
  return app.request(`/requests/${id}/approve`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT } });
}
async function read(app: Hono<AppEnv>, cookie: string, path: string): Promise<Response> {
  return app.request(path, { headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT } });
}
async function rewindow(app: Hono<AppEnv>, cookie: string, id: string, at: string): Promise<Response> {
  return app.request(`/requests/${id}/rewindow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT },
    body: JSON.stringify({ at }),
  });
}

async function getRow(store: ConfigStore, id: string): Promise<RequestItem> {
  const k = requestKey(PROJECT, id);
  const item = (await store.get(k.PK, k.SK)) as RequestItem | null;
  if (!item) throw new Error(`request ${id} not found`);
  return item;
}

async function auditActions(store: ConfigStore, requestId: string): Promise<string[]> {
  const yyyymm = nowIso().slice(0, 7).replace('-', '');
  const entries = (await store.query(`P#${PROJECT}#AUDIT#${yyyymm}`)) as AuditItem[];
  return entries.filter((e) => e.requestId === requestId).map((e) => e.action);
}

/** Drive a `kind:'now'` request to quorum WHILE the project is frozen — the exact row
 * API-8 describes, produced through the real routes rather than hand-seeded. */
async function heldByFreeze(): Promise<{ store: MemoryStore; app: Hono<AppEnv>; id: string; sari: string; lina: string }> {
  const store = new MemoryStore();
  await seed(store);
  const app = createApp(store);
  __setNow(() => NOW);
  const sari = await sessionCookieFor(store, 'sari');
  const lina = await sessionCookieFor(store, 'lina');
  const created = (await (await submit(app, sari, NOW_DRAFT)).json()) as { id: string };
  await approve(app, await sessionCookieFor(store, 'budi'), created.id); // L2, unfrozen
  await setSetting(store, PROJECT, 'freeze.global', true); // freeze starts mid-flight
  const done = (await (await approve(app, lina, created.id)).json()) as { status: string; events: Array<{ type: string }> };

  // Setup assertion (L-1): the row really is the freeze-held shape. Every claim below
  // is about THIS state, and a seed that quietly landed APPLIED would prove nothing.
  expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');
  expect(done.events.some((e) => e.type === 'held_frozen')).toBe(true);
  return { store, app, id: created.id, sari, lina };
}

afterEach(() => __setNow(null));

describe('API-8 — the freeze-held `kind:"now"` request has a path once the freeze lifts', () => {
  it('while the freeze is ON it stays held — the settle must not undo the veto', async () => {
    const { store, app, id, sari } = await heldByFreeze();

    const res = await read(app, sari, `/requests/${id}`);
    expect(((await res.json()) as { status: string }).status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect((await getRow(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('once the freeze lifts, the next read stamps APPLIED with an audited, honest event', async () => {
    const { store, app, id, sari } = await heldByFreeze();
    await setSetting(store, PROJECT, 'freeze.global', false);

    // THE REGRESSION. Before the fix this read returned AWAITING_DEPLOY_APPROVAL, and so
    // did every read after it, forever: settleWindow bails on a non-window schedule, the
    // scheduler only looks at windowed rows, rewindow refuses a `kind:'now'` row and the
    // bundle is disarmed. Cancel was the only exit from a FULLY APPROVED change.
    const res = await read(app, sari, `/requests/${id}`);
    const body = (await res.json()) as { status: string; events: Array<{ type: string; label: string }> };
    expect(body.status).toBe('APPLIED');

    const row = await getRow(store, id);
    expect(row.status).toBe('APPLIED');
    expect(row.events.at(-1)?.type).toBe('applied');
    expect(row.events.at(-1)?.label).toContain('freeze');
    expect(await auditActions(store, id)).toContain('request-frozen-hold-applied');
  });

  it('the LIST read settles it too, and settling twice writes one entry', async () => {
    const { store, app, id, sari } = await heldByFreeze();
    await setSetting(store, PROJECT, 'freeze.global', false);

    const first = (await (await read(app, sari, '/requests?scope=mine')).json()) as { items: Array<{ id: string; status: string }> };
    expect(first.items.find((x) => x.id === id)?.status).toBe('APPLIED');
    await read(app, sari, `/requests/${id}`); // a second settle attempt

    expect(await auditActions(store, id)).toEqual(
      expect.arrayContaining(['request-frozen-hold-applied']),
    );
    expect((await auditActions(store, id)).filter((a) => a === 'request-frozen-hold-applied')).toHaveLength(1);
    expect((await getRow(store, id)).events.filter((e) => e.type === 'applied')).toHaveLength(1);
  });

  it('a WINDOWED request held by the same freeze is NOT swept up — it still waits for its window', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const sari = await sessionCookieFor(store, 'sari');
    const at = new Date(NOW + 3600_000).toISOString();
    const created = (await (
      await submit(app, sari, { ...NOW_DRAFT, schedule: { kind: 'window' as const, at, endAt: new Date(NOW + 5 * 3600_000).toISOString() } })
    ).json()) as { id: string };
    await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    await setSetting(store, PROJECT, 'freeze.global', true);
    await approve(app, await sessionCookieFor(store, 'lina'), created.id);
    await setSetting(store, PROJECT, 'freeze.global', false);

    // A window is a REAL wait the requester asked for, not a deferral the freeze caused.
    // Stamping it APPLIED on unfreeze would apply a change outside its maintenance window.
    expect(((await (await read(app, sari, `/requests/${created.id}`)).json()) as { status: string }).status).toBe(
      'AWAITING_DEPLOY_APPROVAL',
    );
    expect((await getRow(store, created.id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
    // …and the lane that owns windowed rows still owns it, unchanged.
    expect(await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), {})).toEqual([]);
  });

  it('the held row is still cancellable, and a cancel beats a later settle', async () => {
    const { store, app, id, sari } = await heldByFreeze();

    const cancelled = await app.request(`/requests/${id}/cancel`, {
      method: 'POST',
      headers: { 'x-ccp-client': 'ccp-spa', cookie: sari, 'x-ccp-project': PROJECT },
    });
    expect(cancelled.status).toBe(200);
    await setSetting(store, PROJECT, 'freeze.global', false);

    // The settle is guarded on the status it read: a CANCELLED row is never resurrected.
    expect(((await (await read(app, sari, `/requests/${id}`)).json()) as { status: string }).status).toBe('CANCELLED');
    expect((await getRow(store, id)).status).toBe('CANCELLED');
  });

  it('rewindow still refuses the `kind:"now"` row — the settle is its exit, not a new verb', async () => {
    const { app, id, sari } = await heldByFreeze();
    const res = await rewindow(app, sari, id, new Date(NOW + 4 * 3600_000).toISOString());
    expect(res.status).toBe(409);
  });
});
