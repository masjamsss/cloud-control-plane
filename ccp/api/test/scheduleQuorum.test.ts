import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { type AuditItem } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seed, setSetting, sessionCookieFor } from './helpers/seed';

/**
 * T-S3 (0024 §2.2) — the quorum-met status decision at ladder completion: eager
 * WINDOW_EXPIRED for an already-closed window, and the freeze veto (held_frozen). 0037
 * removed the single-approver interim/cooling branch, so a completed ladder is always TWO
 * distinct signatures here (budi at L2, then a lead at L3); no cooling-off is ever stamped.
 */

const GUARDRAILS_DRAFT = {
  operationId: 'ebs-grow', // l1_with_guardrails → ladder [L2, L3]
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

function windowDraft(at: string, endAt: string) {
  return { ...GUARDRAILS_DRAFT, schedule: { kind: 'window' as const, at, endAt } };
}

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

async function auditActions(store: ConfigStore, action: string, requestId: string): Promise<AuditItem[]> {
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
  return entries.filter((e) => e.action === action && e.requestId === requestId);
}

const NOW = Date.parse('2026-07-12T12:00:00.000Z');

afterEach(() => __setNow(null));

describe('E10 — eager WINDOW_EXPIRED at ladder completion when the schedule is already infeasible', () => {
  it('a slow ladder completing AFTER the window already closed → WINDOW_EXPIRED, window-closed event', async () => {
    const store = new MemoryStore();
    await seed(store); // full estate → real L2 + L3
    const app = createApp(store);
    __setNow(() => NOW);

    const at = new Date(NOW + 35 * 60_000).toISOString(); // +35min (clears the 30min MIN_LEAD)
    const endAt = new Date(NOW + 95 * 60_000).toISOString(); // +95min
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), windowDraft(at, endAt))).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id); // L2 — 1 of 2, still open

    __setNow(() => NOW + 3 * 3600_000); // +3h — well past endAt; nobody re-read the request meanwhile
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json(); // L3 completes it

    expect(done.status).toBe('WINDOW_EXPIRED');
    expect(done.interimProfile).toBeUndefined();
    const infeasibleEvent = done.events.find((e: { type: string }) => e.type === 'window_infeasible');
    expect(infeasibleEvent).toBeTruthy();
    expect(infeasibleEvent.label).toBe('Approval completed after the window closed — re-window needed');
    expect(infeasibleEvent.label).not.toContain('cooling-off');

    const entries = await auditActions(store, 'request-approve', created.id);
    expect(entries).toHaveLength(2);
    expect((entries[1]!.after as { status: string }).status).toBe('WINDOW_EXPIRED');
  });

  it('precedence lock: infeasible AND frozen at once → WINDOW_EXPIRED wins, never held_frozen (a dead window stays dead regardless of freeze, §0.2)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);

    const at = new Date(NOW + 35 * 60_000).toISOString();
    const endAt = new Date(NOW + 95 * 60_000).toISOString();
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), windowDraft(at, endAt))).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id); // L2 — still open
    await setSetting(store, 'sample', 'freeze.global', true);

    __setNow(() => NOW + 3 * 3600_000); // past the window
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json(); // L3
    expect(done.status).toBe('WINDOW_EXPIRED');
    expect(done.events.some((e: { type: string }) => e.type === 'held_frozen')).toBe(false);
  });
});

describe('held_frozen — freeze vetoes the quorum-met APPLIED stamp (0024 §2.2 last row/§2.6.1)', () => {
  it('schedule "now": the ladder completes while frozen → AWAITING_DEPLOY_APPROVAL, NOT APPLIED', async () => {
    const store = new MemoryStore();
    await seed(store); // full estate → real L2 + L3
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id); // L2 — still open; submit already happened unfrozen

    await setSetting(store, 'sample', 'freeze.global', true); // freeze starts AFTER submit, mid-flight
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json(); // L3 completes

    expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(done.status).not.toBe('APPLIED');
    const heldEvent = done.events.find((e: { type: string }) => e.type === 'held_frozen');
    expect(heldEvent).toBeTruthy();
    expect(heldEvent.label).toContain('freeze');
    expect(done.events.some((e: { type: string }) => e.type === 'applied')).toBe(false);
  });

  it('schedule "window": the ladder completes while frozen → still AWAITING_DEPLOY_APPROVAL, but the event says held_frozen, not scheduled', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    __setNow(() => NOW);
    const at = new Date(NOW + 3600_000).toISOString();
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), windowDraft(at, new Date(NOW + 5 * 3600_000).toISOString()))).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id); // L2
    await setSetting(store, 'sample', 'freeze.global', true);

    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json(); // L3
    expect(done.status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(done.events.some((e: { type: string }) => e.type === 'held_frozen')).toBe(true);
    expect(done.events.some((e: { type: string }) => e.type === 'scheduled')).toBe(false);
  });

  it('approving DURING a freeze is still allowed (paperwork, not applies) — only the terminal status decision is gated', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    await setSetting(store, 'sample', 'freeze.global', true);

    const res = await approve(app, await sessionCookieFor(store, 'budi'), created.id); // L2 only
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.status).toBe('AWAITING_CODE_REVIEW'); // quorum not met yet — freeze is moot here
  });
});
