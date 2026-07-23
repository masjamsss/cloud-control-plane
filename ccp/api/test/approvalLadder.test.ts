import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, type AccountItem, type AuditItem } from '../src/store/schema';
import { ladderFor, nextLadderStep, requiredApprovalsFor } from '../src/domain/exposure';
import { canSignStep } from '../src/domain/eligibility';
import { seed, seedRequests, sessionCookieFor, setPolicy } from './helpers/seed';

/**
 * 0037 Feature B — the static two-level approval ladder (L2 → L3) that replaces the
 * variable-quorum + single-approver-interim model. A request's requirement is an ordered
 * list of steps, each naming the minimum role, each signed by a DISTINCT person:
 *
 *   self_service                 → [L2]        one approver-or-lead
 *   guardrails / engineer        → [L2, L3]    an approver-or-lead, then a lead
 *   any op with forcesReplace     → [L2, L3]    the SAME ladder, whatever the tier
 *
 * Real catalog ops (ccp/app/src/data/manifests/ebs.json):
 *   ebs-gp2-to-gp3   l1_self_service     LOW   Change   (self_service → [L2])
 *   ebs-grow         l1_with_guardrails  MEDIUM Change  (guardrails   → [L2, L3])
 *   ebs-set-encrypted engineer_only      HIGH  Change   (engineer + forcesReplace → [L2, L3])
 *
 * Seeded estate: sari (requester), budi (approver), putra (lead+admin), lina (lead).
 */

const SELF_SERVICE_DRAFT = {
  operationId: 'ebs-gp2-to-gp3',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01' },
  justification: 'migrate the volume to gp3 for the cost saving',
  schedule: { kind: 'now' as const },
};
const GUARDRAILS_DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};
const REPLACE_DRAFT = {
  operationId: 'ebs-set-encrypted',
  targetAddress: 'aws_ebs_volume.dwh01',
  replaceConfirmation: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', encrypted: 'true' },
  justification: 'encrypt the DWH01 data volume per the security baseline',
  schedule: { kind: 'now' as const },
};

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
function approve(app: Hono<AppEnv>, cookie: string, id: string, body?: unknown) {
  return app.request(`/requests/${id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function get(app: Hono<AppEnv>, path: string, cookie: string) {
  return app.request(path, { headers: { cookie, 'x-ccp-project': 'sample' } });
}
async function disable(store: ConfigStore, id: string): Promise<void> {
  const k = accountKey(id);
  const acc = (await store.get(k.PK, k.SK)) as AccountItem;
  await store.put({ ...acc, status: 'disabled' });
}
async function approveEntries(store: ConfigStore, requestId: string): Promise<AuditItem[]> {
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
  return entries.filter((e) => e.action === 'request-approve' && e.requestId === requestId);
}

describe('the ladder (pure domain)', () => {
  it('ladderFor: self_service = [L2]; guardrails/engineer = [L2, L3]; forcesReplace overrides to [L2, L3] whatever the tier', () => {
    expect(ladderFor('self_service')).toEqual(['L2']);
    expect(ladderFor('guardrails')).toEqual(['L2', 'L3']);
    expect(ladderFor('engineer')).toEqual(['L2', 'L3']);
    // the forces-replace override — even a self_service op destroy+recreate climbs to [L2, L3]
    expect(ladderFor('self_service', true)).toEqual(['L2', 'L3']);
    expect(ladderFor('guardrails', true)).toEqual(['L2', 'L3']);
    expect(ladderFor('engineer', true)).toEqual(['L2', 'L3']);
  });

  it('requiredApprovalsFor is ladder.length — the ONE definition (self_service 1; riskier + replace 2)', () => {
    expect(requiredApprovalsFor('self_service')).toBe(1);
    expect(requiredApprovalsFor('guardrails')).toBe(2);
    expect(requiredApprovalsFor('engineer')).toBe(2);
    expect(requiredApprovalsFor('self_service', true)).toBe(2);
  });

  it('nextLadderStep is positional: the Nth signature fills ladder[N-1]; null once full', () => {
    expect(nextLadderStep(['L2', 'L3'], 0)).toBe('L2');
    expect(nextLadderStep(['L2', 'L3'], 1)).toBe('L3');
    expect(nextLadderStep(['L2', 'L3'], 2)).toBeNull();
    expect(nextLadderStep(['L2'], 0)).toBe('L2');
    expect(nextLadderStep(['L2'], 1)).toBeNull();
  });

  it('canSignStep: L2 → approver|lead; L3 → lead only; requester signs neither', () => {
    expect(canSignStep('L2', 'approver')).toBe(true);
    expect(canSignStep('L2', 'lead')).toBe(true);
    expect(canSignStep('L3', 'approver')).toBe(false);
    expect(canSignStep('L3', 'lead')).toBe(true);
    expect(canSignStep('L2', 'requester')).toBe(false);
    expect(canSignStep('L3', 'requester')).toBe(false);
  });
});

describe('self_service — one L2 completes it', () => {
  it('a single approver signs L2 → APPLIED; the projection carries the ladder + null next-step', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), SELF_SERVICE_DRAFT)).json();
    expect(created.approvalsRequired).toBe(1);
    expect(created.approvalLadder).toEqual(['L2']);
    expect(created.nextApprovalStep).toBe('L2');

    const done = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(done.approvals).toHaveLength(1);
    expect(done.status).toBe('APPLIED');
    expect(done.nextApprovalStep).toBeNull();
    // NEVER cooling for a fresh completion.
    expect(done.status).not.toBe('APPROVED_COOLING');
    expect(done.interimProfile).toBeUndefined();
    expect(done.earliestApplyAt).toBeUndefined();
  });

  it('a lead may also sign the single L2 step (L2 → approver OR lead)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), SELF_SERVICE_DRAFT)).json();
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(done.status).toBe('APPLIED');
  });
});

describe('a riskier change — L2 then L3, two distinct people', () => {
  it('guardrails: approver signs L2 (1/2, next→L3), then a lead signs L3 → APPLIED', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    expect(created.approvalsRequired).toBe(2);
    expect(created.approvalLadder).toEqual(['L2', 'L3']);
    expect(created.nextApprovalStep).toBe('L2');

    const one = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('AWAITING_CODE_REVIEW'); // 1/2 — still open
    expect(one.nextApprovalStep).toBe('L3'); // now awaiting the final approver

    const two = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(two.approvals).toHaveLength(2);
    expect(two.status).toBe('APPLIED');
    expect(two.nextApprovalStep).toBeNull();
  });

  it('a lead may sign either step: a lead signs L2 first (recorded as the FIRST approver, still open), then a distinct lead signs L3', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();

    // putra is a lead but signs FIRST → fills L2 (positional), not L3. Request stays open.
    const one = await (await approve(app, await sessionCookieFor(store, 'putra'), created.id)).json();
    expect(one.status).toBe('AWAITING_CODE_REVIEW');
    expect(one.nextApprovalStep).toBe('L3');
    expect(one.events.at(-1).label).toContain('first approver (L2)');

    const two = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(two.status).toBe('APPLIED');
  });

  it('L3 can never be signed before L2 (strict order): the FIRST signature always targets L2, even from a lead', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    expect(created.nextApprovalStep).toBe('L2'); // never L3 while nothing is signed

    // lina is a lead (could satisfy L3 by role) but her first signature fills L2, leaving
    // L3 unsigned — so there is no path to a lone L3 signature "before" L2.
    const one = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('AWAITING_CODE_REVIEW'); // NOT complete on one lead
    expect(one.nextApprovalStep).toBe('L3');
    const approved = (await approveEntries(store, created.id))[0]!;
    expect((approved.after as { step: string }).step).toBe('L2'); // audited as the L2 step
  });

  it('an approver is REFUSED at the L3 step (WRONG_APPROVAL_LEVEL); the request is untouched', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'lina'), created.id); // L2 signed by a lead → next is L3

    const res = await approve(app, await sessionCookieFor(store, 'budi'), created.id); // budi = approver, at L3
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('WRONG_APPROVAL_LEVEL');

    const after = await (await get(app, `/requests/${created.id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(after.approvals).toHaveLength(1); // budi's refused signature was NOT recorded
    expect(after.status).toBe('AWAITING_CODE_REVIEW');
    expect(after.nextApprovalStep).toBe('L3');
  });

  it('the SAME person cannot sign both steps (distinct people) — the L3 step needs a different account', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'lina'), created.id); // lina signs L2

    // lina could satisfy L3 by ROLE, but she already signed → distinctness refuses her.
    const again = await approve(app, await sessionCookieFor(store, 'lina'), created.id);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_APPROVED');

    // a DISTINCT lead completes the L3 step.
    const done = await (await approve(app, await sessionCookieFor(store, 'putra'), created.id)).json();
    expect(done.status).toBe('APPLIED');
    expect(done.approvals).toHaveLength(2);
  });
});

describe('forces-replace follows the SAME ladder — one approver + one lead, NOT two leads', () => {
  it('an approver signs L2 of an engineer-tier forces-replace op (widened from lead-only), then a lead signs L3', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), REPLACE_DRAFT)).json();
    expect(created.reviewTier).toBe('engineer');
    expect(created.approvalsRequired).toBe(2);
    expect(created.approvalLadder).toEqual(['L2', 'L3']);
    expect(created.status).toBe('NEEDS_ENGINEER'); // still routed to an engineer to author the TF

    // budi (a plain APPROVER) may now sign L2 — the 0035 two-leads rule is gone.
    const one = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('NEEDS_ENGINEER'); // 1/2 — still open
    expect(one.nextApprovalStep).toBe('L3');

    const two = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(two.approvals).toHaveLength(2);
    expect(two.status).toBe('APPLIED');
  });
});

describe('no NEW request ever enters APPROVED_COOLING (the solo-approval interim exception is disabled)', () => {
  it('a riskier change with only ONE eligible approver stalls at 1/2 — never a cooling completion', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setPolicy(store, 'sample', { low: 1, medium: 2, high: 2, deleteMin: 2 });
    await disable(store, 'putra');
    await disable(store, 'lina'); // no lead remains → the L3 step can never be filled
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    // feasibility is honest that this cannot complete (an L3 step with no lead available).
    expect(created.feasible).toBe(false);
    expect(created.interimProfileWillApply).toBe(false);

    const done = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(done.approvals).toHaveLength(1);
    expect(done.status).toBe('AWAITING_CODE_REVIEW'); // NOT APPROVED_COOLING
    expect(done.status).not.toBe('APPROVED_COOLING');
    expect(done.interimProfile).toBeUndefined();
    expect(done.earliestApplyAt).toBeUndefined();
    expect(done.nextApprovalStep).toBe('L3'); // still waiting for a lead that isn't there
  });

  it('no request-approve audit entry across the ladder ever carries interimProfile', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    await approve(app, await sessionCookieFor(store, 'budi'), created.id);
    await approve(app, await sessionCookieFor(store, 'lina'), created.id);
    const entries = await approveEntries(store, created.id);
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.interimProfile).toBeUndefined();
  });
});

describe('mass-assignment safety — approve/submit never take client-set status/approvals/level/requester', () => {
  it('approve ignores a hostile body entirely (status/approvals/approvalsRequired/step are all server-computed)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    // budi tries to jump the ladder with an injected body — every field must be ignored.
    const done = await (
      await approve(app, await sessionCookieFor(store, 'budi'), created.id, {
        status: 'APPLIED',
        approvals: [{ user: 'sari', at: '2020-01-01T00:00:00.000Z' }],
        approvalsRequired: 1,
        step: 'L3',
        nextApprovalStep: null,
        reviewTier: 'self_service',
      })
    ).json();
    expect(done.status).toBe('AWAITING_CODE_REVIEW'); // 1/2 — not the injected APPLIED
    expect(done.approvals).toHaveLength(1); // only budi's real signature
    expect(done.approvals[0].user).toBe('budi'); // not the injected sari
    expect(done.approvalsRequired).toBe(2); // the ladder, not the injected 1
    expect(done.reviewTier).toBe('guardrails'); // not the injected self_service
    expect(done.nextApprovalStep).toBe('L3'); // server-computed
  });

  it('submit ignores client-set status/approvals/approvalsRequired/level/requester; the server computes the ladder', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), {
      ...GUARDRAILS_DRAFT,
      status: 'APPLIED',
      approvals: [{ user: 'sari', at: '2020-01-01T00:00:00.000Z' }],
      approvalsRequired: 1,
      approvalLadder: ['L2'],
      nextApprovalStep: 'L3',
      reviewTier: 'self_service',
      requester: 'putra',
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.status).toBe('AWAITING_CODE_REVIEW'); // not the injected APPLIED
    expect(created.approvals).toHaveLength(0); // not the injected pre-approval
    expect(created.approvalsRequired).toBe(2); // the guardrails ladder, not the injected 1
    expect(created.approvalLadder).toEqual(['L2', 'L3']); // server-computed, not the injected [L2]
    expect(created.nextApprovalStep).toBe('L2'); // server-computed, not the injected L3
    expect(created.reviewTier).toBe('guardrails'); // not the injected self_service
    expect(created.requester).toBe('sari'); // the session user, not the injected putra
  });
});

describe('legacy APPROVED_COOLING rows still settle (disable, do not rip out)', () => {
  it('a row already mid-cooling settles via settleCooling on the next read, exactly as before', async () => {
    const store = new MemoryStore();
    await seed(store);
    // A row a pre-0037 build could have written: interim quorum met, parked in
    // APPROVED_COOLING with an earliestApplyAt already in the past.
    await seedRequests(store, 'sample', 'sari', 1, {
      status: 'APPROVED_COOLING',
      interimProfile: true,
      earliestApplyAt: '2020-01-01T00:00:00.000Z', // already elapsed
      approvalsRequired: 2,
      approvals: [{ user: 'budi', at: '2020-01-01T00:00:00.000Z' }],
      schedule: { kind: 'now' },
    });
    const app = createApp(store);
    // The next read lazily settles it to APPLIED (cooling.ts#settleCooling is untouched).
    const read = await (await get(app, '/requests/seed-sari-0', await sessionCookieFor(store, 'sari'))).json();
    expect(read.status).toBe('APPLIED');
  });
});
