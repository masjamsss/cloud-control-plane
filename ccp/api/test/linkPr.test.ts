import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import type { AuditItem } from '../src/store/schema';
import { seed, sessionCookieFor } from './helpers/seed';

/**
 * 0033 A12/P6 — POST /requests/:id/link-pr: the engineer-track loop closer.
 * `prNumber`/`prUrl` have existed in the store schema (and rendered when
 * present) since day one, but NO route ever set them — a NEEDS_ENGINEER
 * request's timeline dead-ended. This verb records the fulfilling PR:
 * Lead-only, https-only, number derived from the URL tail when omitted,
 * audited with before/after, refused on terminally-refused statuses.
 *
 * Real catalog ops used (ccp/app/src/data/manifests/ebs.json):
 *   ebs-set-encrypted  engineer_only      HIGH   Change → NEEDS_ENGINEER
 *   ebs-grow           l1_with_guardrails MEDIUM Change → AWAITING_CODE_REVIEW
 */

const ENGINEER_DRAFT = {
  operationId: 'ebs-set-encrypted',
  targetAddress: 'aws_ebs_volume.dwh01',
  replaceConfirmation: 'aws_ebs_volume.dwh01', // ebs-set-encrypted forces a replace — confirmation required
  params: { volume: 'aws_ebs_volume.dwh01', encrypted: 'true' },
  justification: 'encrypt the DWH01 data volume per the security baseline',
  schedule: { kind: 'now' as const },
};
const GUARDRAILS_DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

const PR_URL = 'https://github.com/masjamsss/cloud-control-plane/pull/321';

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function submit(app: Hono<AppEnv>, cookie: string, body: unknown) {
  return app.request('/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}
function linkPr(app: Hono<AppEnv>, cookie: string, id: string, body: unknown) {
  return app.request(`/requests/${id}/link-pr`, {
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

describe('POST /requests/:id/link-pr — recording the fulfilling PR', () => {
  it('happy path: a Lead links a PR onto a NEEDS_ENGINEER request; URL + derived number + event + audit land', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);

    const res = await linkPr(app, await sessionCookieFor(store, 'putra'), id, { prUrl: PR_URL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prUrl).toBe(PR_URL);
    expect(body.prNumber).toBe(321); // derived from the /pull/321 tail
    expect(body.status).toBe('NEEDS_ENGINEER'); // linking never moves the status
    const evt = body.events.find((e: { type: string }) => e.type === 'pr_linked');
    expect(evt).toBeTruthy();
    expect(evt.label).toContain('#321');
    expect(evt.label).toContain('Putra');

    const entries = await auditActions(store, 'request-link-pr', id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('putra');
    expect((entries[0]!.after as { prUrl: string }).prUrl).toBe(PR_URL);
    expect((entries[0]!.after as { prNumber: number }).prNumber).toBe(321);
  });

  it('an explicit prNumber wins over the URL tail', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const res = await linkPr(app, await sessionCookieFor(store, 'putra'), id, { prUrl: PR_URL, prNumber: 999 });
    expect(res.status).toBe(200);
    expect((await res.json()).prNumber).toBe(999);
  });

  it('a URL with no numeric tail links URL-only (no stale/guessed number)', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const cookie = await sessionCookieFor(store, 'putra');
    // First link carries a number…
    await linkPr(app, cookie, id, { prUrl: PR_URL });
    // …the corrected link has none; the old number must NOT survive under the new URL.
    const res = await linkPr(app, cookie, id, { prUrl: 'https://github.com/masjamsss/cloud-control-plane/pulls' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prUrl).toBe('https://github.com/masjamsss/cloud-control-plane/pulls');
    expect(body.prNumber).toBeUndefined();
  });

  it('re-linking is allowed and audited with before/after (correcting a wrong URL)', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const cookie = await sessionCookieFor(store, 'putra');
    await linkPr(app, cookie, id, { prUrl: PR_URL });
    const res = await linkPr(app, cookie, id, { prUrl: 'https://github.com/masjamsss/cloud-control-plane/pull/322' });
    expect(res.status).toBe(200);
    expect((await res.json()).prNumber).toBe(322);

    const entries = await auditActions(store, 'request-link-pr', id);
    expect(entries).toHaveLength(2);
    expect((entries[1]!.before as { prNumber: number }).prNumber).toBe(321);
    expect((entries[1]!.after as { prNumber: number }).prNumber).toBe(322);
  });

  it('also serves the Stage-2 lane: an AWAITING_CODE_REVIEW request is linkable', async () => {
    const { store, app } = await harness();
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    expect(created.status).toBe('AWAITING_CODE_REVIEW');
    const res = await linkPr(app, await sessionCookieFor(store, 'putra'), created.id, { prUrl: PR_URL });
    expect(res.status).toBe(200);
  });

  it('authz: a plain approver is refused 403 FORBIDDEN_ROLE (Lead is the engineer-track authority)', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const res = await linkPr(app, await sessionCookieFor(store, 'budi'), id, { prUrl: PR_URL });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_ROLE');
  });

  it('authz: the requester (plain requester role) is refused 403 FORBIDDEN_ROLE', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const res = await linkPr(app, await sessionCookieFor(store, 'sari'), id, { prUrl: PR_URL });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_ROLE');
  });

  it('validation: a non-https URL is refused 422 (the SPA renders this as a link)', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    const cookie = await sessionCookieFor(store, 'putra');
    for (const prUrl of ['http://github.com/x/y/pull/1', 'javascript:alert(1)', 'not a url', '']) {
      const res = await linkPr(app, cookie, id, { prUrl });
      expect(res.status, prUrl).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('state: a REJECTED request is refused 409 STATE_CONFLICT (no fulfilling PR exists)', async () => {
    const { store, app } = await harness();
    const { id } = await needsEngineerRequest(store, app);
    await reject(app, await sessionCookieFor(store, 'lina'), id);
    const res = await linkPr(app, await sessionCookieFor(store, 'putra'), id, { prUrl: PR_URL });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
  });

  it('an unknown request id is 404', async () => {
    const { store, app } = await harness();
    const res = await linkPr(app, await sessionCookieFor(store, 'putra'), 'no-such-id', { prUrl: PR_URL });
    expect(res.status).toBe(404);
  });
});
