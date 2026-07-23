import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import { accountKey, type AccountItem, type AuditItem } from '../src/store/schema';
import {
  initialStatusFor,
  reviewTierFor,
  strictestTier,
  tierOf,
} from '../src/domain/exposure';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * Server-side `exposure` enforcement (0014 dim-1 finding 4.2): exposure was parsed,
 * stored, and displayed but routed NOTHING in the real API. Per ADR-0008 exposure never
 * gates SUBMISSION; it maps to a review TIER, and the tier maps to the 0037 approval
 * LADDER (see approvalLadder.test.ts for the ladder itself). This file pins the
 * exposure→tier mapping and how it drives the engineer track + tighten-only recompute:
 *   engineer_only      → engineer   → NEEDS_ENGINEER track, ladder [L2, L3]
 *   l1_with_guardrails → guardrails → ladder [L2, L3]
 *   l1_self_service    → self_service → ladder [L2]
 *
 * Real catalog ops used (ccp/app/src/data/manifests/ebs.json):
 *   ebs-set-encrypted  engineer_only      HIGH  Change  (forcesReplace)
 *   ebs-grow           l1_with_guardrails MEDIUM Change
 *   ebs-gp2-to-gp3     l1_self_service    LOW   Change
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
const SELF_SERVICE_DRAFT = {
  operationId: 'ebs-gp2-to-gp3',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01' },
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
async function disable(store: ConfigStore, id: string): Promise<void> {
  const k = accountKey(id);
  const acc = (await store.get(k.PK, k.SK)) as AccountItem;
  await store.put({ ...acc, status: 'disabled' });
}

describe('exposure → review tier (pure domain)', () => {
  it('maps the three exposures and fails CLOSED to engineer on anything else', () => {
    expect(reviewTierFor('l1_self_service')).toBe('self_service');
    expect(reviewTierFor('l1_with_guardrails')).toBe('guardrails');
    expect(reviewTierFor('engineer_only')).toBe('engineer');
    expect(reviewTierFor('surprise_new_tier')).toBe('engineer');
    expect(reviewTierFor(undefined)).toBe('engineer');
  });

  it('tighten-only tier combinator + track routing + legacy-row fallback', () => {
    expect(strictestTier('self_service', 'engineer')).toBe('engineer');
    expect(strictestTier('guardrails', 'self_service')).toBe('guardrails');
    expect(initialStatusFor('engineer')).toBe('NEEDS_ENGINEER');
    expect(initialStatusFor('guardrails')).toBe('AWAITING_CODE_REVIEW');
    // pre-enforcement rows carry no reviewTier → derived from the pinned exposure
    expect(tierOf({ exposure: 'engineer_only' })).toBe('engineer');
    expect(tierOf({ exposure: 'l1_self_service', reviewTier: 'engineer' })).toBe('engineer');
  });
});

describe('engineer_only — requestable, engineer-authored, ladder [L2, L3] (ADR-0008 + 0037)', () => {
  it('submit is NEVER blocked: 201, routed to the engineer track with the [L2, L3] ladder stamped', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT);
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.status).toBe('NEEDS_ENGINEER');
    expect(created.reviewTier).toBe('engineer');
    expect(created.approvalsRequired).toBe(2); // the [L2, L3] ladder
    expect(created.approvalLadder).toEqual(['L2', 'L3']);
    expect(created.events.map((e: { type: string }) => e.type)).toContain('needs_engineer');
  });

  it('an approver may now sign the L2 step (widened from lead-only), but is refused at the final L3 step', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();

    // budi (approver) signs L2 — 0037 widened the engineer tier's first sign-off.
    const one = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('NEEDS_ENGINEER'); // 1/2 — still open
    expect(one.nextApprovalStep).toBe('L3');

    // a SECOND approver cannot fill the L3 (final) step — it is lead-only.
    const twoApprover = await approve(app, await sessionCookieFor(store, 'budi'), created.id); // same person → dedup
    expect(twoApprover.status).toBe(409); // ALREADY_APPROVED before the level check even matters
  });

  it('a plain approver is REFUSED at the L3 step (WRONG_APPROVAL_LEVEL) once L2 is signed', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'lina'), created.id); // a lead signs L2 → next is L3

    const res = await approve(app, await sessionCookieFor(store, 'budi'), created.id); // budi = approver at L3
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('WRONG_APPROVAL_LEVEL');
  });

  it('Lead approvals DO satisfy it: two distinct Leads complete the engineer track (lead may sign either step)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();

    const one = await (await approve(app, await sessionCookieFor(store, 'putra'), created.id)).json();
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('NEEDS_ENGINEER'); // 1/2 — still open on the engineer track

    const two = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(two.approvals).toHaveLength(2);
    expect(two.status).toBe('APPLIED');
  });

  it('no lead available → an approver still signs L2 but the L3 step can never be filled (no solo completion)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();
    await disable(store, 'putra');
    await disable(store, 'lina'); // no active lead remains anywhere

    // budi (approver) still signs L2 — the FIRST step is his to sign.
    const one = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('NEEDS_ENGINEER'); // 1/2, NOT a cooling completion
    expect(one.status).not.toBe('APPROVED_COOLING');
    expect(one.interimProfile).toBeUndefined();
    expect(one.nextApprovalStep).toBe('L3'); // stuck: needs a lead that isn't there
  });

  it('legacy rows (no reviewTier field) are enforced via their pinned exposure — ladder [L2, L3], unknown fails closed', async () => {
    const store = new MemoryStore();
    await seed(store);
    // pre-enforcement row: exposure recorded, reviewTier never stamped
    await seedRequests(store, 'sample', 'sari', 1, { status: 'NEEDS_ENGINEER', exposure: 'engineer_only' });
    // and a row whose exposure is garbage → engineer tier (fail closed)
    await seedRequests(store, 'sample', 'ghazi', 1, { status: 'AWAITING_CODE_REVIEW', exposure: 'not-a-real-exposure', operationId: 'no-such-op' });
    const app = createApp(store);
    const budi = await sessionCookieFor(store, 'budi');

    // Both are enforced as the engineer [L2, L3] ladder: an approver signs L2 (still open,
    // 1/2), and the request then needs a lead for the L3 step.
    const legacy = await (await approve(app, budi, 'seed-sari-0')).json();
    expect(legacy.approvalsRequired).toBe(2);
    expect(legacy.approvals).toHaveLength(1);
    expect(legacy.status).toBe('NEEDS_ENGINEER');
    expect(legacy.nextApprovalStep).toBe('L3');

    const garbage = await (await approve(app, budi, 'seed-ghazi-0')).json();
    expect(garbage.approvalsRequired).toBe(2);
    expect(garbage.nextApprovalStep).toBe('L3');
  });

  it('rejection stays open to any senior on the engineer track (refusal is fail-closed, never level-gated)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();
    const res = await app.request(`/requests/${created.id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie: await sessionCookieFor(store, 'budi'), 'x-ccp-project': 'sample' },
      body: JSON.stringify({ reason: 'wrong volume' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('REJECTED');
  });

  it('scope=pending is next-step-aware: an approver sees a riskier item while its L2 is unsigned; once L2 is signed only a lead sees the L3', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const sari = await sessionCookieFor(store, 'sari');
    const eng = await (await submit(app, sari, ENGINEER_DRAFT)).json();
    const grd = await (await submit(app, sari, GUARDRAILS_DRAFT)).json();

    // Both are at their L2 step → an approver (budi) now sees BOTH (0037 widened this).
    const budiBefore = await (await app.request('/requests?scope=pending', { headers: { cookie: await sessionCookieFor(store, 'budi'), 'x-ccp-project': 'sample' } })).json();
    expect(budiBefore.items.map((x: { id: string }) => x.id).sort()).toEqual([eng.id, grd.id].sort());

    // budi signs the guardrails L2 → its next step is L3 (lead-only).
    await approve(app, await sessionCookieFor(store, 'budi'), grd.id);

    // Now budi sees only the engineer item (still at L2); the guardrails item (at L3) drops out.
    const budiAfter = await (await app.request('/requests?scope=pending', { headers: { cookie: await sessionCookieFor(store, 'budi'), 'x-ccp-project': 'sample' } })).json();
    expect(budiAfter.items.map((x: { id: string }) => x.id)).toEqual([eng.id]);

    // A lead sees both: the engineer item (L2) and the guardrails item (now L3, lead-only).
    const forLina = await (await app.request('/requests?scope=pending', { headers: { cookie: await sessionCookieFor(store, 'lina'), 'x-ccp-project': 'sample' } })).json();
    expect(forLina.items.map((x: { id: string }) => x.id).sort()).toEqual([eng.id, grd.id].sort());
  });
});

describe('l1_with_guardrails — the [L2, L3] ladder (0003 §2: more than one signature, 0037: L2 then L3)', () => {
  it('a MEDIUM guardrails op requires two distinct approvals: an approver (L2) then a lead (L3)', async () => {
    const store = new MemoryStore();
    await seed(store); // policy {low:1, medium:1, high:2, deleteMin:2} — no longer drives the count
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    expect(created.reviewTier).toBe('guardrails');
    expect(created.approvalsRequired).toBe(2); // the ladder, independent of the risk quorum
    expect(created.status).toBe('AWAITING_CODE_REVIEW');

    const one = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(one.status).toBe('AWAITING_CODE_REVIEW'); // one signature is NOT enough

    const two = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(two.status).toBe('APPLIED'); // approver (L2) + lead (L3)
  });

  it('l1_self_service is untouched: ladder [L2], one approval completes', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), SELF_SERVICE_DRAFT)).json();
    expect(created.reviewTier).toBe('self_service');
    expect(created.approvalsRequired).toBe(1);
    const done = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(done.status).toBe('APPLIED');
  });
});

describe('the computed requirement is audited', () => {
  it('request-submit and request-approve entries carry exposure/reviewTier/approvalsRequired (+ the signed step)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), ENGINEER_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'putra'), created.id);

    const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
    const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];

    const submitted = entries.find((e) => e.action === 'request-submit' && e.requestId === created.id);
    expect(submitted).toBeTruthy();
    expect(submitted!.after).toMatchObject({
      status: 'NEEDS_ENGINEER',
      exposure: 'engineer_only',
      reviewTier: 'engineer',
      approvalsRequired: 2,
      risk: 'HIGH',
    });

    const approved = entries.find((e) => e.action === 'request-approve' && e.requestId === created.id);
    expect(approved).toBeTruthy();
    expect(approved!.after).toMatchObject({ reviewTier: 'engineer', approvalsRequired: 2, step: 'L2' });
  });
});
