import { beforeEach, describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import { createMockApiClient, type ApiClient } from '@/lib/api';
import { enroll, ensureSeeded, resetStoreForTests } from '@/lib/accounts';
import { login, signOut } from '@/lib/auth';
import { resetPolicyForTests, setPolicy } from '@/lib/policy';
import { SEED_LEAD } from '@/config';

/**
 * These tests exercise the API authority, NOT the UI. They prove that
 * separation of duties and the approval count are enforced inside the mutation
 * (the shape a real ccp-api must keep), so a client can never forge an
 * approval by asserting an identity or a count.
 */

async function seedPeople(): Promise<void> {
  resetStoreForTests();
  resetPolicyForTests();
  signOut();
  await ensureSeeded(); // full engineer roster — alice (lead/admin), bob (lead), etc.
  await enroll(
    { username: 'dewi', displayName: 'Dewi', role: 'requester', teamId: 'erp-basis', password: 'sunflower7' },
    SEED_LEAD.username,
  );
  await enroll(
    { username: 'rizky', displayName: 'Rizky', role: 'approver', teamId: 'erp-basis', password: 'password1' },
    SEED_LEAD.username,
  );
}

function draft(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'test-req-01',
    requester: 'dewi',
    teamId: 'erp-basis',
    service: 'ebs',
    operationId: 'ebs-grow',
    macd: 'Change',
    targetAddress: 'aws_ebs_volume.erp_app03_data',
    params: { volume: 'aws_ebs_volume.erp_app03_data', new_size_gib: 200 },
    justification: 'grow the volume for month-end load',
    exposure: 'l1_with_guardrails',
    risk: 'MEDIUM',
    status: 'DRAFT',
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
    events: [{ at: '2026-07-10T00:00:00Z', type: 'created', label: 'drafted', actor: 'dewi' }],
    ...overrides,
  };
}

/** Submit and unwrap the SubmitResult to its ChangeRequest (throws on rejection). */
async function submit(client: ApiClient, d: ChangeRequest): Promise<ChangeRequest> {
  const res = await client.submitRequest(d);
  if (!res.ok) throw new Error(res.reason);
  return res.request;
}

beforeEach(seedPeople);

describe('approveRequest — actor comes from the session, never the caller', () => {
  it('rejects when nobody is signed in', async () => {
    const api = createMockApiClient();
    signOut();
    const res = await api.approveRequest('seed-review-01');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not signed in/i);
  });

  it('a requester (wrong role) cannot approve', async () => {
    const api = createMockApiClient();
    await login('dewi', 'sunflower7');
    const res = await api.approveRequest('seed-review-01');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/approvers and leads/i);
  });

  it('you cannot approve your own request', async () => {
    const api = createMockApiClient();
    await login('rizky', 'password1');
    const mine = await submit(api, draft({ id: 'mine-01', requester: 'rizky' }));
    const res = await api.approveRequest(mine.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/your own request/i);
  });

  it('you cannot approve the same request twice', async () => {
    const api = createMockApiClient();
    await login('rizky', 'password1');
    // seed-delete-01 already carries rizky's approval (needs 2).
    const res = await api.approveRequest('seed-delete-01');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/already approved/i);
  });

  it('a valid approval succeeds and a 1-of-1 request applies', async () => {
    const api = createMockApiClient();
    await login('rizky', 'password1');
    const res = await api.approveRequest('seed-review-01'); // requester dewi, needs 1
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.status).toBe('APPLIED');
      expect(res.request.approvals?.some((a) => a.user === 'rizky')).toBe(true);
    }
  });
});

describe('rejectRequest — same authority checks + reason', () => {
  it('records the reason and the actor from the session', async () => {
    const api = createMockApiClient();
    await login('rizky', 'password1');
    const res = await api.rejectRequest('seed-review-01', 'volume already resized manually');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.status).toBe('REJECTED');
      const last = res.request.events.at(-1);
      expect(last?.actor).toBe('rizky');
      expect(last?.label).toMatch(/volume already resized manually/);
    }
  });

  it('a requester cannot reject', async () => {
    const api = createMockApiClient();
    await login('dewi', 'sunflower7');
    const res = await api.rejectRequest('seed-review-01', 'no');
    expect(res.ok).toBe(false);
  });
});

describe('submitRequest — approval count comes from the editable policy, not a hardcoded rule', () => {
  it('a MEDIUM change needs 1 approval under the default policy', async () => {
    const api = createMockApiClient();
    await login('dewi', 'sunflower7');
    const submitted = await submit(api, draft());
    expect(submitted.approvalsRequired).toBe(1);
  });

  it('raising the MEDIUM policy to 2 makes a new MEDIUM change need 2', async () => {
    setPolicy({ medium: 2 });
    const api = createMockApiClient();
    await login('dewi', 'sunflower7');
    const submitted = await submit(api, draft({ id: 'test-req-02' }));
    expect(submitted.approvalsRequired).toBe(2);
    // And one approval must NOT apply it.
    await login('rizky', 'password1');
    const res = await api.approveRequest(submitted.id);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.request.status).toBe('AWAITING_CODE_REVIEW');
  });
});

describe('approveRequest — tighten-only re-gate on reclassification (ADV-14)', () => {
  it('a policy tightening after submit raises the open request bar (not applied on the old count)', async () => {
    const api = createMockApiClient();
    await login('dewi', 'sunflower7');
    const submitted = await submit(api, draft({ id: 'regate-01' })); // MEDIUM, needs 1
    expect(submitted.approvalsRequired).toBe(1);

    setPolicy({ medium: 2 }); // tighten AFTER submit

    await login('rizky', 'password1');
    const res = await api.approveRequest(submitted.id);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.approvalsRequired).toBe(2); // re-gated up
      expect(res.request.status).toBe('AWAITING_CODE_REVIEW'); // 1 of 2 → not applied
    }
  });

  it('a later loosening never lowers an already-required count', async () => {
    setPolicy({ medium: 2 });
    const api = createMockApiClient();
    await login('dewi', 'sunflower7');
    const submitted = await submit(api, draft({ id: 'regate-02' })); // needs 2
    expect(submitted.approvalsRequired).toBe(2);

    setPolicy({ medium: 1 }); // loosen after submit

    await login('rizky', 'password1');
    const res = await api.approveRequest(submitted.id);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.approvalsRequired).toBe(2); // stays at 2 (tighten-only)
      expect(res.request.status).toBe('AWAITING_CODE_REVIEW');
    }
  });
});
