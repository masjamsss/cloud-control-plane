import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * 0021 F3/G3 fold-in — "approve-time TOTP check". F3's root fix (bumping
 * sessionVersion when role/isAdmin rises, forcing re-login through the TOTP gate)
 * lives in admin.ts/dualControl.ts (Lane B). This is the belt-and-braces half that
 * belongs to the approve handler itself: whatever the session says, an account may
 * only ACT as approver if TOTP-enrolled right now.
 */

const DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};
const ENGINEER_DRAFT = {
  operationId: 'ebs-set-encrypted',
  targetAddress: 'aws_ebs_volume.dwh01',
  replaceConfirmation: 'aws_ebs_volume.dwh01', // ebs-set-encrypted forces a replace — confirmation required
  params: { volume: 'aws_ebs_volume.dwh01', encrypted: 'true' },
  justification: 'encrypt the DWH01 data volume per the security baseline',
  schedule: { kind: 'now' as const },
};

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function submit(app: ReturnType<typeof createApp>, cookie: string, body: unknown) {
  return app.request('/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}
function approve(app: ReturnType<typeof createApp>, cookie: string, id: string) {
  return app.request(`/requests/${id}/approve`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });
}

describe('approve() belt-and-braces TOTP guard', () => {
  it('an approver with an enrolled role but NO TOTP factor → 403 TOTP_ENROLLMENT_REQUIRED', async () => {
    const store = new MemoryStore();
    await seed(store);
    await seedAccount(store, { id: 'unverified', role: 'approver', teamId: 'app-platform', isAdmin: false, totp: false });
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), DRAFT)).json();

    const res = await approve(app, await sessionCookieFor(store, 'unverified'), created.id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('TOTP_ENROLLMENT_REQUIRED');

    // and the request is genuinely untouched — no partial approval recorded.
    const after = await (
      await app.request(`/requests/${created.id}`, { headers: { cookie: await sessionCookieFor(store, 'sari'), 'x-ccp-project': 'sample' } })
    ).json();
    expect(after.approvals).toHaveLength(0);
  });

  it('a TOTP-enrolled approver (the default seed fixture) still succeeds', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), DRAFT)).json();
    const res = await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    expect(res.status).toBe(200);
  });

  it('ordering: state/self-approval checks still run BEFORE the TOTP check', async () => {
    const store = new MemoryStore();
    await seed(store);
    await seedAccount(store, { id: 'unverified', role: 'approver', teamId: 'app-platform', isAdmin: false, totp: false });
    const app = createApp(store);
    // unverified requests their own change, then tries to approve it — SELF_APPROVAL
    // must win even though they would ALSO fail the TOTP check.
    const created = await (await submit(app, await sessionCookieFor(store, 'unverified'), DRAFT)).json();
    const res = await approve(app, await sessionCookieFor(store, 'unverified'), created.id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SELF_APPROVAL');
  });

  it('ordering: the TOTP check runs BEFORE the engineer-tier WHO-CAN-APPROVE check', async () => {
    const store = new MemoryStore();
    await seed(store);
    await seedAccount(store, { id: 'newlead', role: 'lead', teamId: 'platform', isAdmin: false, totp: false });
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();
    // newlead has the RIGHT role for the engineer track but no TOTP — the belt-and-
    // braces check must catch this before the tier check would even matter.
    const res = await approve(app, await sessionCookieFor(store, 'newlead'), created.id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('TOTP_ENROLLMENT_REQUIRED');
  });
});
