import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import { accountKey, type AccountItem } from '../src/store/schema';
import { canSignStep, isEligibleApprover, eligibleApprovers } from '../src/domain/eligibility';
import { __setKnownProjects } from '../src/projects';
import { runSettlement } from '../src/domain/settlement';
import { seed, seedAccount, setPolicy, sessionCookieFor } from './helpers/seed';

/**
 * 0021 F2/G2 — the eligible-SIGNER filter (project-binding + activation), plus the 0037
 * per-step `canSignStep` rule. The filter is now TIER-INDEPENDENT: a candidate signer is
 * any active, project-bound, activated approver-or-lead who isn't the requester (every
 * ladder's L2 admits approver-or-lead). Whether the ladder can COMPLETE — its L3 step
 * needs a lead — is `computeFeasibility`'s concern, exercised through the live path below.
 */

// `projects: ['sample']` (arm 2 — a membership list, NOT retired) rather than bare
// (arm 3, retired to `{}`, data-birth spec §5): these tests are about the
// isEligibleApprover RULES (role/status/activation/self-exclusion), not about the
// legacy-shim fallback specifically — that gets its own dedicated test below. Arm
// 2 still reads `role`/`teamId` live off the object, so a post-hoc override like
// `{...base, role: 'lead'}` resolves correctly.
function account(over: Partial<AccountItem> & { id: string }): AccountItem {
  return {
    username: over.id,
    displayName: over.id,
    role: 'approver',
    teamId: 'platform',
    projects: ['sample'],
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    totp: { secretEnc: 'enc', enrolledAt: '2026-07-11T00:00:00.000Z' },
    ...over,
  } as AccountItem;
}

describe('domain/eligibility.ts — canSignStep (the ladder WHO, pure)', () => {
  it('L2 admits approver OR lead; L3 is lead-only; a requester signs neither', () => {
    expect(canSignStep('L2', 'approver')).toBe(true);
    expect(canSignStep('L2', 'lead')).toBe(true);
    expect(canSignStep('L3', 'approver')).toBe(false);
    expect(canSignStep('L3', 'lead')).toBe(true);
    expect(canSignStep('L2', 'requester')).toBe(false);
    expect(canSignStep('L3', 'requester')).toBe(false);
  });
});

describe('domain/eligibility.ts — isEligibleApprover (candidate signer, pure, tier-independent)', () => {
  const base = account({ id: 'candidate' });

  it('a fully-qualifying approver counts', () => {
    expect(isEligibleApprover(base, 'sample', 'requester-x')).toBe(true);
  });

  it('an approver counts regardless of the request risk — the L2 step admits approver-or-lead (0037 widening)', () => {
    // (pre-0037 this filter excluded approvers on the engineer track; the ladder's L2 no longer does)
    expect(isEligibleApprover(base, 'sample', 'requester-x')).toBe(true);
    expect(isEligibleApprover({ ...base, role: 'lead' }, 'sample', 'requester-x')).toBe(true);
  });

  it('excludes a requester-role account (cannot sign any ladder step)', () => {
    expect(isEligibleApprover({ ...base, role: 'requester' }, 'sample', 'requester-x')).toBe(false);
  });

  it('excludes disabled accounts', () => {
    expect(isEligibleApprover({ ...base, status: 'disabled' }, 'sample', 'requester-x')).toBe(false);
  });

  it('excludes the requester themself', () => {
    expect(isEligibleApprover(base, 'sample', 'candidate')).toBe(false);
  });

  it('excludes an account NOT bound to the request project (F2 miscount #1)', () => {
    expect(isEligibleApprover({ ...base, projects: ['other'] }, 'sample', 'requester-x')).toBe(false);
    expect(isEligibleApprover({ ...base, projects: ['other'] }, 'other', 'requester-x')).toBe(true);
    expect(isEligibleApprover({ ...base, projects: ['*'] }, 'anything', 'requester-x')).toBe(true);
  });

  it('a bare legacy row (no `roles`, no `projects`) is a member of NOTHING (arm 3 retired, data-birth spec §5) — real rows never reach here unmaterialized (domain/settlement.ts runs before every request)', () => {
    const { projects: _omit, ...legacy } = { ...base, projects: undefined as unknown as string[] };
    void _omit;
    expect(isEligibleApprover(legacy as AccountItem, 'sample', 'requester-x')).toBe(false);
    expect(isEligibleApprover(legacy as AccountItem, 'other', 'requester-x')).toBe(false);
  });

  it('excludes an unactivated account: mustChangePassword still set (F2 miscount #2a)', () => {
    expect(isEligibleApprover({ ...base, mustChangePassword: true }, 'sample', 'requester-x')).toBe(false);
  });

  it('excludes an unactivated account: TOTP never enrolled (F2 miscount #2b)', () => {
    const { totp: _omit, ...noTotp } = base;
    void _omit;
    expect(isEligibleApprover(noTotp as AccountItem, 'sample', 'requester-x')).toBe(false);
  });
});

describe('domain/eligibility.ts — eligibleApprovers (loads + filters the live directory)', () => {
  it('counts only the qualifying subset of a mixed directory (both roles, activated, bound)', async () => {
    const store = new MemoryStore();
    await seed(store); // sari (requester), budi (approver, totp), putra+lina (lead, totp)
    await seedAccount(store, { id: 'unbound', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['other'] });
    await seedAccount(store, { id: 'unactivated', role: 'approver', teamId: 'app-platform', isAdmin: false, totp: false });
    // this calls the domain function DIRECTLY — never through the HTTP app, so
    // `withSettlement` never fires; simulate it explicitly (see feasibility.test.ts's
    // identical note).
    await runSettlement(store);

    const result = await eligibleApprovers(store, 'sample', 'sari');
    expect(result.map((a) => a.id).sort()).toEqual(['budi', 'lina', 'putra']);
  });
});

describe('the F2 filter, exercised through the live approve/feasibility path (0037 ladder)', () => {
  afterEach(() => __setKnownProjects(['sample']));

  const DRAFT = {
    operationId: 'ebs-grow', // l1_with_guardrails → ladder [L2, L3]
    targetAddress: 'aws_ebs_volume.dwh01',
    params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
    justification: 'grow the volume to 250 GiB for month-end load',
    schedule: { kind: 'now' as const },
  };

  async function submit(app: ReturnType<typeof createApp>, cookie: string) {
    return (
      await app.request('/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
        body: JSON.stringify(DRAFT),
      })
    ).json();
  }
  function approve(app: ReturnType<typeof createApp>, cookie: string, id: string) {
    return app.request(`/requests/${id}/approve`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });
  }

  it("an approver bound to a DIFFERENT project doesn't count toward THIS project's feasibility (and no solo completion)", async () => {
    __setKnownProjects(['sample', 'other']);
    const store: ConfigStore = new MemoryStore();
    await seed(store);
    await setPolicy(store, 'sample', { low: 1, medium: 2, high: 2, deleteMin: 2 });
    // disable both leads so the L3 step has no eligible signer at all
    for (const id of ['putra', 'lina']) {
      const k = accountKey(id);
      const acc = (await store.get(k.PK, k.SK)) as AccountItem;
      await store.put({ ...acc, status: 'disabled' });
    }
    await seedAccount(store, { id: 'elsewhere', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['other'] });
    const app = createApp(store);

    const created = await submit(app, await sessionCookieFor(store, 'sari'));
    expect(created.approvalsRequired).toBe(2);
    // Only budi counts (elsewhere is bound to 'other'); with no lead, the L3 step is
    // unfillable → infeasible, honestly.
    expect(created.eligibleApprovers).toBe(1);
    expect(created.feasible).toBe(false);
    expect(created.interimProfileWillApply).toBe(false);

    // budi signs L2, but the change does NOT complete on one distinct signer (no cooling).
    const done = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(done.approvals).toHaveLength(1);
    expect(done.status).toBe('AWAITING_CODE_REVIEW');
    expect(done.status).not.toBe('APPROVED_COOLING');
    expect(done.interimProfile).toBeUndefined();
  });

  it('a minted-but-never-activated approver does not count toward feasibility either', async () => {
    const store: ConfigStore = new MemoryStore();
    await seed(store);
    await setPolicy(store, 'sample', { low: 1, medium: 2, high: 2, deleteMin: 2 });
    for (const id of ['putra', 'lina']) {
      const k = accountKey(id);
      const acc = (await store.get(k.PK, k.SK)) as AccountItem;
      await store.put({ ...acc, status: 'disabled' });
    }
    // freshly enrolled: mustChangePassword still true, no TOTP yet — a real "just created" row.
    await seedAccount(store, { id: 'fresh', role: 'approver', teamId: 'app-platform', isAdmin: false, totp: false });
    const app = createApp(store);

    const created = await submit(app, await sessionCookieFor(store, 'sari'));
    // eligible = {budi} = 1 (NOT 2 — "fresh" must not count), no lead → infeasible.
    expect(created.eligibleApprovers).toBe(1);
    expect(created.feasible).toBe(false);
  });

  it('regression: enough ACTIVATED, project-bound signers (incl. a lead for L3) complete the ladder cleanly — never cooling', async () => {
    const store: ConfigStore = new MemoryStore();
    await seed(store); // budi + putra + lina, all activated by default, all bound to sample
    await setPolicy(store, 'sample', { low: 1, medium: 2, high: 2, deleteMin: 2 });
    const app = createApp(store);

    const created = await submit(app, await sessionCookieFor(store, 'sari'));
    expect(created.feasible).toBe(true);
    await approve(app, await sessionCookieFor(store, 'budi'), created.id); // L2
    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json(); // L3
    expect(done.interimProfile).toBeUndefined();
    expect(done.status).toBe('APPLIED');
  });
});
