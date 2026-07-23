import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import { accountKey, type AccountItem, type AuditItem } from '../src/store/schema';
import { computeFeasibility } from '../src/domain/feasibility';
import { runSettlement } from '../src/domain/settlement';
import { seed, sessionCookieFor, setPolicy } from './helpers/seed';

/**
 * 0021 F5/G5 — quorum-infeasibility surfacing, re-expressed for the 0037 ladder. Submit
 * computes the ladder but the request could still never complete: no bound/activated
 * signer besides the requester, or no LEAD for the ladder's L3 step. Response contract:
 * `{eligibleApprovers: number, feasible: boolean, interimProfileWillApply: boolean}`,
 * present on the submit response AND the stored ChangeRequest snapshot, plus a
 * LIVE-recomputed GET /requests/:id/feasibility. `feasible` now means "enough distinct
 * signers to fill every ladder step, including a lead for any L3 step".
 * `interimProfileWillApply` is retained on the wire but ALWAYS false (0037 disabled the
 * single-approver interim profile). Never gates submission (ADR-0008).
 */

const GUARDRAILS_DRAFT = {
  operationId: 'ebs-grow', // l1_with_guardrails → ladder [L2, L3]
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};
const ENGINEER_DRAFT = {
  operationId: 'ebs-set-encrypted', // engineer_only → ladder [L2, L3]
  targetAddress: 'aws_ebs_volume.dwh01',
  replaceConfirmation: 'aws_ebs_volume.dwh01',
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
function get(app: ReturnType<typeof createApp>, path: string, cookie: string) {
  return app.request(path, { headers: { cookie, 'x-ccp-project': 'sample' } });
}
async function disable(store: ConfigStore, id: string): Promise<void> {
  const k = accountKey(id);
  const acc = (await store.get(k.PK, k.SK)) as AccountItem;
  await store.put({ ...acc, status: 'disabled' });
}

describe('domain/feasibility.ts — computeFeasibility (ladder-aware, store-backed)', () => {
  // These tests call the domain function DIRECTLY — never through the HTTP app, so
  // `withSettlement` middleware never fires. seed()'s 4 accounts are deliberately
  // bare-legacy-shaped, so a live request would see them settled (materialized into
  // an explicit `roles` map) before anything reads them — simulate that same
  // one-time settlement explicitly, exactly where a real request's middleware
  // would have (data-birth spec §9, domain/settlement.ts).
  it('self_service [L2]: any one signer makes it feasible', async () => {
    const store = new MemoryStore();
    await seed(store); // budi + putra + lina all eligible
    await runSettlement(store);
    const f = await computeFeasibility(store, 'sample', ['L2'], 'sari');
    expect(f).toEqual({ eligibleApprovers: 3, feasible: true, interimProfileWillApply: false });
  });

  it('guardrails [L2, L3]: feasible with a lead + at least two distinct signers', async () => {
    const store = new MemoryStore();
    await seed(store);
    await runSettlement(store);
    const f = await computeFeasibility(store, 'sample', ['L2', 'L3'], 'sari');
    expect(f).toEqual({ eligibleApprovers: 3, feasible: true, interimProfileWillApply: false });
  });

  it('guardrails [L2, L3]: an L2 signer but NO lead → infeasible (the L3 step can never be filled)', async () => {
    const store = new MemoryStore();
    await seed(store);
    await disable(store, 'putra');
    await disable(store, 'lina'); // only budi (approver) remains
    await runSettlement(store);
    const f = await computeFeasibility(store, 'sample', ['L2', 'L3'], 'sari');
    expect(f).toEqual({ eligibleApprovers: 1, feasible: false, interimProfileWillApply: false });
  });

  it('guardrails [L2, L3]: exactly ONE person (a lone lead) → infeasible (two distinct steps need two people)', async () => {
    const store = new MemoryStore();
    await seed(store);
    await disable(store, 'budi');
    await disable(store, 'lina'); // only putra (lead) remains
    await runSettlement(store);
    const f = await computeFeasibility(store, 'sample', ['L2', 'L3'], 'sari');
    expect(f).toEqual({ eligibleApprovers: 1, feasible: false, interimProfileWillApply: false });
  });

  it('guardrails [L2, L3]: one lead + one approver (the minimum) → feasible', async () => {
    const store = new MemoryStore();
    await seed(store);
    await disable(store, 'lina'); // budi (approver) + putra (lead)
    await runSettlement(store);
    const f = await computeFeasibility(store, 'sample', ['L2', 'L3'], 'sari');
    expect(f).toEqual({ eligibleApprovers: 2, feasible: true, interimProfileWillApply: false });
  });

  it('infeasible: a lead\'s own engineer-tier request with no OTHER lead — an approver counts but cannot fill L3', async () => {
    const store = new MemoryStore();
    await seed(store);
    await disable(store, 'lina');
    await runSettlement(store);
    // putra is the sole remaining lead — HIS OWN request excludes him, leaving only budi.
    const f = await computeFeasibility(store, 'sample', ['L2', 'L3'], 'putra');
    expect(f).toEqual({ eligibleApprovers: 1, feasible: false, interimProfileWillApply: false });
  });
});

describe('POST /requests — submit response + persisted snapshot carry ladder feasibility', () => {
  it('feasible: full estate has a lead for L3 and enough distinct signers', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT);
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.approvalsRequired).toBe(2);
    expect(created.eligibleApprovers).toBe(3); // budi + putra + lina
    expect(created.feasible).toBe(true);
    expect(created.interimProfileWillApply).toBe(false);

    // persisted, not just returned — a plain GET sees the same snapshot.
    const read = await (await get(app, `/requests/${created.id}`, await sessionCookieFor(store, 'sari'))).json();
    expect(read.eligibleApprovers).toBe(3);
    expect(read.feasible).toBe(true);
  });

  it('infeasible via a missing lead: only an approver remains, so the L3 step can never be filled', async () => {
    const store = new MemoryStore();
    await seed(store);
    await disable(store, 'putra');
    await disable(store, 'lina');
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();
    expect(created.eligibleApprovers).toBe(1);
    expect(created.feasible).toBe(false);
    expect(created.interimProfileWillApply).toBe(false);
  });

  it('infeasible: submission is NEVER blocked (ADR-0008) but the response says so honestly', async () => {
    const store = new MemoryStore();
    await seed(store);
    await disable(store, 'lina'); // putra is the sole remaining lead
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'putra'), ENGINEER_DRAFT); // putra submits HIS OWN
    expect(res.status).toBe(201); // never gated
    const created = await res.json();
    expect(created.eligibleApprovers).toBe(1); // budi (approver) — counts, but cannot fill L3
    expect(created.feasible).toBe(false);
    expect(created.interimProfileWillApply).toBe(false);
  });

  it('the request-submit audit entry carries the feasibility fields (evidence, not just response sugar)', async () => {
    const store = new MemoryStore();
    await seed(store);
    await disable(store, 'putra');
    await disable(store, 'lina');
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), GUARDRAILS_DRAFT)).json();

    const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
    const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
    const submitted = entries.find((e) => e.action === 'request-submit' && e.requestId === created.id);
    expect(submitted!.after).toMatchObject({ eligibleApprovers: 1, feasible: false, interimProfileWillApply: false });
  });
});

describe('GET /requests/:id/feasibility — LIVE, not the submit-time snapshot', () => {
  it('reflects a directory change AFTER submit (the persisted snapshot does not)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const sari = await sessionCookieFor(store, 'sari');
    const created = await (await submit(app, sari, GUARDRAILS_DRAFT)).json();
    expect(created.feasible).toBe(true);
    expect(created.eligibleApprovers).toBe(3);

    // Both leads go away AFTER submit → no lead for the L3 step.
    await disable(store, 'putra');
    await disable(store, 'lina');

    const live = await (await get(app, `/requests/${created.id}/feasibility`, sari)).json();
    expect(live).toMatchObject({
      requestId: created.id,
      approvals: 0,
      approvalsRequired: 2,
      eligibleApprovers: 1,
      feasible: false,
      interimProfileWillApply: false,
    });

    // the STORED snapshot (general read) is unchanged — proves it really is a snapshot.
    const snapshot = await (await get(app, `/requests/${created.id}`, sari)).json();
    expect(snapshot.eligibleApprovers).toBe(3);
  });

  it('mirrors approve()\'s ladder requirement (a guardrails op needs 2 whatever the risk policy)', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setPolicy(store, 'sample', { low: 1, medium: 1, high: 2, deleteMin: 2 });
    const app = createApp(store);
    const sari = await sessionCookieFor(store, 'sari');
    const created = await (await submit(app, sari, GUARDRAILS_DRAFT)).json();
    expect(created.approvalsRequired).toBe(2); // the ladder, not the policy value

    const live = await (await get(app, `/requests/${created.id}/feasibility`, sari)).json();
    expect(live.approvalsRequired).toBe(2);
  });

  it('404 for a request that does not exist', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await get(app, '/requests/no-such-id/feasibility', await sessionCookieFor(store, 'sari'));
    expect(res.status).toBe(404);
  });
});
