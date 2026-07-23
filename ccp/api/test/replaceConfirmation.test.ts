import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * The forces-replace confirmed-override lane (ccp-api half). A destroy+recreate op
 * (forcesReplace:true, always engineer_only) may only be submitted with the requester's
 * TYPED confirmation naming the exact resource (layer 1). Its review requirement is the
 * 0037 ladder [L2, L3] — the SAME ladder the operator chose for every riskier change,
 * REPLACING the older two-leads rule: a first approver (L2, approver-or-lead) then a
 * final approver (L3, lead). Nothing auto-applies. These lock:
 *   - confirmation required + bound to the target address (no stray/replayed value);
 *   - the [L2, L3] ladder (two distinct people, a lead for the final step);
 *   - level enforcement (an approver may sign L2 but is refused at the L3 step);
 *   - a requester still cannot approve at all (role-gated);
 *   - mass-assignment safety (status/approvals/approvalsRequired are server-computed);
 *   - full audit of the acknowledgement.
 *
 * Real catalog op: ebs-set-encrypted (engineer_only, HIGH, forcesReplace) from ebs.json.
 */

const TARGET = 'aws_ebs_volume.dwh01';
const REPLACE_DRAFT = {
  operationId: 'ebs-set-encrypted',
  targetAddress: TARGET,
  replaceConfirmation: TARGET,
  params: { volume: TARGET, encrypted: 'true' },
  justification: 'encrypt the DWH01 data volume — this destroys and recreates it',
  schedule: { kind: 'now' as const },
};
// A non-forces-replace op (self-service) — a stray confirmation on it must be ignored.
const PLAIN_DRAFT = {
  operationId: 'ebs-gp2-to-gp3',
  targetAddress: TARGET,
  params: { volume: TARGET },
  justification: 'migrate the volume to gp3 for the cost saving',
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

describe('forces-replace lane — layer 1: the typed confirmation is required and bound', () => {
  it('refuses a forces-replace submit with NO confirmation (422), and records nothing', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const { replaceConfirmation: _omit, ...noConfirm } = REPLACE_DRAFT;
    const res = await submit(app, await sessionCookieFor(store, 'sari'), noConfirm);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('REPLACE_CONFIRMATION_REQUIRED');
  });

  it('refuses a confirmation that names a DIFFERENT resource (no replay onto another target)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), {
      ...REPLACE_DRAFT,
      replaceConfirmation: 'aws_ebs_volume.some_other_volume',
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('REPLACE_CONFIRMATION_REQUIRED');
  });

  it('accepts a matching confirmation: 201, engineer track, and stores the confirmation', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), REPLACE_DRAFT);
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.status).toBe('NEEDS_ENGINEER');
    expect(created.reviewTier).toBe('engineer');
    expect(created.replaceConfirmation).toBe(TARGET);

    // Durable row carries it too (not just the 201 projection).
    const k = requestKey('sample', created.id);
    const stored = (await store.get(k.PK, k.SK)) as RequestItem;
    expect(stored.replaceConfirmation).toBe(TARGET);
  });

  it('a NON-forces-replace op ignores a stray confirmation (never stored)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), {
      ...PLAIN_DRAFT,
      replaceConfirmation: TARGET, // meaningless here — must be dropped
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.replaceConfirmation).toBeUndefined();
    const k = requestKey('sample', created.id);
    const stored = (await store.get(k.PK, k.SK)) as RequestItem;
    expect(stored.replaceConfirmation).toBeUndefined();
  });
});

describe('forces-replace lane — layer 2: the [L2, L3] ladder (two distinct people)', () => {
  it('requires 2 approvals and stays engineer-tier (routed to NEEDS_ENGINEER)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), REPLACE_DRAFT)).json();
    expect(created.approvalsRequired).toBe(2);
    expect(created.approvalLadder).toEqual(['L2', 'L3']);
    expect(created.reviewTier).toBe('engineer');
  });

  it('two distinct Leads complete it (a lead may sign either step); a single Lead is not enough', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), REPLACE_DRAFT)).json();

    const one = await (await approve(app, await sessionCookieFor(store, 'putra'), created.id)).json(); // lead signs L2
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('NEEDS_ENGINEER'); // 1/2 — still open

    const two = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json(); // lead signs L3
    expect(two.approvals).toHaveLength(2);
    expect(two.status).toBe('APPLIED');
  });

  it('the 2-step ladder holds whatever the risk policy (a lowered high:1 never shrinks it)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const { setPolicy } = await import('./helpers/seed');
    await setPolicy(store, 'sample', { low: 1, medium: 1, high: 1, deleteMin: 1 }, 2);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), REPLACE_DRAFT)).json();
    expect(created.approvalsRequired).toBe(2); // the ladder, not the lowered policy
  });
});

describe('forces-replace lane — level enforcement on approval', () => {
  it('an approver MAY sign the L2 step (widened from lead-only), but is refused at the final L3 step', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), REPLACE_DRAFT)).json();

    // budi (approver) now signs the first step — the 0035 two-leads rule is replaced.
    const one = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('NEEDS_ENGINEER'); // 1/2 — still open
    expect(one.nextApprovalStep).toBe('L3');

    // a DIFFERENT approver at the final (L3) step is refused — that step is lead-only.
    // Explicit `roles` (not the bare legacy shape): this account is added AFTER the
    // app has already served requests (submit/approve above), so this store's
    // one-time settlement (domain/settlement.ts) has already run — a bare row added
    // at this point would never be materialized (see changeSet.test.ts's identical note).
    await seedAccount(store, { id: 'dewi', role: 'approver', teamId: 'app-platform', isAdmin: false, roles: { sample: { role: 'approver', teamId: 'app-platform' } } });
    const res = await approve(app, await sessionCookieFor(store, 'dewi'), created.id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('WRONG_APPROVAL_LEVEL');

    const after = await (
      await app.request(`/requests/${created.id}`, { headers: { cookie: await sessionCookieFor(store, 'sari'), 'x-ccp-project': 'sample' } })
    ).json();
    expect(after.approvals).toHaveLength(1); // dewi's refused signature was NOT recorded
    expect(after.status).toBe('NEEDS_ENGINEER');
  });

  it('a requester (non-senior) cannot approve at all (role-gated)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), REPLACE_DRAFT)).json();
    const res = await approve(app, await sessionCookieFor(store, 'sari'), created.id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_ROLE');
  });
});

describe('forces-replace lane — mass-assignment safety', () => {
  it('ignores body-supplied status/approvals/approvalsRequired/reviewTier; the server computes them', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), {
      ...REPLACE_DRAFT,
      // Hostile extras — none may ride into the stored row.
      status: 'APPLIED',
      approvalsRequired: 1,
      approvals: [{ user: 'sari', at: '2020-01-01T00:00:00.000Z' }],
      reviewTier: 'self_service',
      exposure: 'l1_self_service',
      interimProfile: true,
      requester: 'putra',
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.status).toBe('NEEDS_ENGINEER'); // not the injected APPLIED
    expect(created.approvalsRequired).toBe(2); // not the injected 1
    expect(created.approvals).toHaveLength(0); // not the injected pre-approval
    expect(created.reviewTier).toBe('engineer'); // not the injected self_service
    expect(created.exposure).toBe('engineer_only'); // from the manifest, not the body
    expect(created.requester).toBe('sari'); // the session user, not the injected putra
    expect(created.interimProfile).toBeUndefined();
  });
});

describe('forces-replace lane — audit', () => {
  it('the submit entry records the acknowledgement (forcesReplace + the confirmed resource)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), REPLACE_DRAFT)).json();

    const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
    const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
    const submitted = entries.find((e) => e.action === 'request-submit' && e.requestId === created.id);
    expect(submitted).toBeTruthy();
    expect(submitted!.after).toMatchObject({
      status: 'NEEDS_ENGINEER',
      exposure: 'engineer_only',
      reviewTier: 'engineer',
      approvalsRequired: 2,
      forcesReplace: true,
      replaceConfirmation: TARGET,
    });
  });
});
