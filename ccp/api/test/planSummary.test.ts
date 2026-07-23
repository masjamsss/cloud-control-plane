import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import type { AuditItem } from '../src/store/schema';
import { seed, sessionCookieFor } from './helpers/seed';

/**
 * 0035 Docket B — POST /requests/:id/plan-summary: CI records the structured
 * `terraform plan` summary onto a request so L1/L2 see what it does to the live
 * estate before any apply. Modeled exactly on the W4 link-pr verb — Lead-only,
 * status-guarded, audited before/after — with the two properties the summary's
 * TRUST demands: a plain requester/approver cannot post one (authz), and no
 * request body field other than the validated summary is ever stored (mass
 * assignment). Fixture-driven, no live AWS.
 *
 * Real catalog op used (ccp/app/src/data/manifests/ebs.json):
 *   ebs-set-encrypted  engineer_only  HIGH  Change → NEEDS_ENGINEER
 */

const ENGINEER_DRAFT = {
  operationId: 'ebs-set-encrypted',
  targetAddress: 'aws_ebs_volume.dwh01',
  replaceConfirmation: 'aws_ebs_volume.dwh01', // ebs-set-encrypted forces a replace — confirmation required
  params: { volume: 'aws_ebs_volume.dwh01', encrypted: 'true' },
  justification: 'encrypt the DWH01 data volume per the security baseline',
  schedule: { kind: 'now' as const },
};

/** A well-formed summary: the engineer-track REPLACE the panel exists for. */
const SUMMARY = {
  resourceChanges: [
    {
      address: 'aws_ebs_volume.dwh01',
      type: 'aws_ebs_volume',
      action: 'replace',
      forcedBy: ['encrypted'],
      changed: [{ attr: 'encrypted', before: 'false', after: 'true' }],
    },
  ],
  counts: { create: 0, update: 0, replace: 1, delete: 0, noop: 0 },
  recordedAt: '2026-07-14T12:30:00.000Z',
  runUrl: 'https://github.com/masjamsss/cloud-control-plane/actions/runs/42',
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
function postSummary(app: Hono<AppEnv>, cookie: string, id: string, body: unknown) {
  return app.request(`/requests/${id}/plan-summary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}
function reject(app: Hono<AppEnv>, cookie: string, id: string) {
  return app.request(`/requests/${id}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify({ reason: 'not needed after all' }),
  });
}

async function auditActions(store: ConfigStore, action: string, requestId: string): Promise<AuditItem[]> {
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
  return entries.filter((e) => e.action === action && e.requestId === requestId);
}

async function harness() {
  const store = new MemoryStore();
  await seed(store);
  const app = createApp(store);
  return { store, app };
}

async function needsEngineerRequest(store: ConfigStore, app: Hono<AppEnv>): Promise<{ id: string }> {
  const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();
  expect(created.status).toBe('NEEDS_ENGINEER');
  return { id: created.id };
}

describe('POST /requests/:id/plan-summary — recording the CI plan', () => {
  it('happy path: a Lead records a summary; structured body + event + audit land, status unchanged', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);

    const res = await postSummary(app, await sessionCookieFor(store, 'putra'), id, SUMMARY);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The whole structured summary round-trips (not a string).
    expect(body.planSummary).toEqual(SUMMARY);
    expect(body.status).toBe('NEEDS_ENGINEER'); // recording never moves the status

    const evt = body.events.find((e: { type: string }) => e.type === 'plan_summary');
    expect(evt).toBeTruthy();
    expect(evt.label).toContain('replaces 1');
    expect(evt.label).toContain('Putra');

    const entries = await auditActions(store, 'request-plan-summary', id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('putra');
    expect((entries[0]!.before as { counts?: unknown }).counts).toBeUndefined();
    expect((entries[0]!.after as { counts: unknown }).counts).toEqual(SUMMARY.counts);
  });

  it('a re-plan supersedes the earlier summary and audits the counts delta', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const cookie = await sessionCookieFor(store, 'putra');
    await postSummary(app, cookie, id, SUMMARY);

    const noop = {
      resourceChanges: [],
      counts: { create: 0, update: 0, replace: 0, delete: 0, noop: 1 },
    };
    const res = await postSummary(app, cookie, id, noop);
    expect(res.status).toBe(200);
    expect((await res.json()).planSummary).toEqual(noop);

    const entries = await auditActions(store, 'request-plan-summary', id);
    expect(entries).toHaveLength(2);
    expect((entries[1]!.before as { counts: unknown }).counts).toEqual(SUMMARY.counts);
    expect((entries[1]!.after as { counts: unknown }).counts).toEqual(noop.counts);
  });

  it('authz: a plain approver is refused 403 FORBIDDEN_ROLE (the summary is a trusted artifact)', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const res = await postSummary(app, await sessionCookieFor(store, 'budi'), id, SUMMARY);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_ROLE');
  });

  it('authz: the requester (plain requester role) is refused 403 FORBIDDEN_ROLE', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const res = await postSummary(app, await sessionCookieFor(store, 'sari'), id, SUMMARY);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_ROLE');
  });

  it('mass assignment: injected non-summary fields are ignored — only the summary is stored', async () => {
    const { store, app } = await harness();
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();
    const id = created.id;

    // A hostile body: a valid summary plus fields that would escalate/rewrite the
    // request if the route trusted the body (status, approvals, identity, events).
    const hostile = {
      ...SUMMARY,
      id: 'evil-id',
      requester: 'attacker',
      status: 'APPLIED',
      approvalsRequired: 0,
      approvals: [{ user: 'attacker', at: '2026-01-01T00:00:00.000Z' }],
      prNumber: 9999,
      events: [{ at: '2026-01-01T00:00:00.000Z', type: 'hacked', label: 'pwned' }],
    };
    const res = await postSummary(app, await sessionCookieFor(store, 'putra'), id, hostile);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Every injected field is refused; the request is exactly as submitted…
    expect(body.id).toBe(id);
    expect(body.requester).toBe('sari');
    expect(body.status).toBe('NEEDS_ENGINEER');
    expect(body.approvalsRequired).toBe(created.approvalsRequired);
    expect(body.prNumber).toBeUndefined();
    expect(body.events.some((e: { type: string }) => e.type === 'hacked')).toBe(false);
    // …and only the validated summary was written.
    expect(body.planSummary).toEqual(SUMMARY);
  });

  it('validation: malformed summaries are refused 422 VALIDATION_FAILED', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const cookie = await sessionCookieFor(store, 'putra');
    const bad: unknown[] = [
      null,
      {},
      { resourceChanges: [] }, // missing counts
      { resourceChanges: 'x', counts: { create: 0, update: 0, replace: 0, delete: 0, noop: 0 } },
      {
        // an unknown action verb
        resourceChanges: [{ address: 'aws_x.y', type: 'aws_x', action: 'nuke' }],
        counts: { create: 0, update: 0, replace: 0, delete: 0, noop: 0 },
      },
      {
        // a non-https runUrl — the SPA renders it as an <a href>
        resourceChanges: [],
        counts: { create: 0, update: 0, replace: 0, delete: 0, noop: 0 },
        runUrl: 'http://insecure/run',
      },
    ];
    for (const body of bad) {
      const res = await postSummary(app, cookie, id, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('state: a REJECTED request is refused 409 STATE_CONFLICT (no plan to record)', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    await reject(app, await sessionCookieFor(store, 'lina'), id);
    const res = await postSummary(app, await sessionCookieFor(store, 'putra'), id, SUMMARY);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('an unknown request id is 404', async () => {
    const { store, app } = await harness();
    const res = await postSummary(app, await sessionCookieFor(store, 'putra'), 'no-such-id', SUMMARY);
    expect(res.status).toBe(404);
  });
});
