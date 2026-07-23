import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import type { HttpApiClient } from '@/lib/httpApi';
import { canCancelRequest, cancelRequestVia, coolingTimeRemaining } from '@/features/requests/coolingFlow';

/**
 * Proves the SPA half of the ADR-0009 cooling-off cancel verb (0021 G1):
 * the cancel-button visibility rule (mirrors routes/requests.ts's own authz
 * exactly, for UI ergonomics — the server re-enforces it regardless), and
 * the 409-triggers-refetch policy. Mirrors teamsFlow.test.ts's / usersFlow.
 * test.ts's fake-client + hand-rolled spy approach (no jsdom in this repo —
 * see test/standalone.test.ts's exact dependency allowlist, and this repo
 * doesn't use vitest's vi.fn — see authFlow.test.ts's identical helper).
 */

function fakeClient(over: Partial<HttpApiClient> = {}): HttpApiClient {
  const notUsed = (): never => {
    throw new Error('fakeClient: method not stubbed for this test');
  };
  return {
    serverInfo: notUsed,
    listManifests: notUsed,
    getInventory: notUsed,
    listRequests: notUsed,
    getRequest: notUsed,
    submitRequest: notUsed,
    approveRequest: notUsed,
    rejectRequest: notUsed,
    listPendingApprovals: notUsed,
    listAllRequests: notUsed,
    cancelRequest: notUsed,
    getRequestFeasibility: notUsed,
    login: notUsed,
    completeTotp: notUsed,
    enrollTotp: notUsed,
    me: notUsed,
    logout: notUsed,
    listAuditEntries: notUsed,
    exportAudit: notUsed,
    listAdminTeams: notUsed,
    createAdminTeam: notUsed,
    renameAdminTeam: notUsed,
    setAdminTeamServices: notUsed,
    deleteAdminTeam: notUsed,
    listAdminAccounts: notUsed,
    createAdminAccount: notUsed,
    setAccountRole: notUsed,
    setAccountTeam: notUsed,
    setAccountStatus: notUsed,
    resetAccountPassword: notUsed,
    resetAccountTotp: notUsed,
    revokeAccountSessions: notUsed,
    ...over,
  } as unknown as HttpApiClient;
}

/** A hand-rolled spy (this repo doesn't use vitest's vi.fn). Records every call's arguments. */
function spy<T extends unknown[], R>(impl: (...args: T) => R): ((...args: T) => R) & { calls: T[] } {
  const fn = (...args: T): R => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [] as T[];
  return fn;
}

const COOLING: Pick<ChangeRequest, 'status' | 'requester'> = { status: 'APPROVED_COOLING', requester: 'sari' };

describe('canCancelRequest — mirrors routes/requests.ts POST /:id/cancel authz exactly', () => {
  it('the requester (owner) may cancel their own cooling request', () => {
    expect(canCancelRequest(COOLING, { id: 'sari', role: 'requester' })).toBe(true);
  });

  it('a Lead who is NOT the requester may also cancel (senior override)', () => {
    expect(canCancelRequest(COOLING, { id: 'budi', role: 'lead' })).toBe(true);
  });

  it('an admin who is NOT a Lead and NOT the requester may also cancel', () => {
    expect(canCancelRequest(COOLING, { id: 'nadia', role: 'approver', isAdmin: true })).toBe(true);
  });

  it('a plain approver who is neither the requester nor Lead/admin may NOT cancel', () => {
    expect(canCancelRequest(COOLING, { id: 'budi', role: 'approver' })).toBe(false);
  });

  it('a plain requester who is not the owner may NOT cancel', () => {
    expect(canCancelRequest(COOLING, { id: 'someone-else', role: 'requester' })).toBe(false);
  });

  it.each([
    'AWAITING_CODE_REVIEW',
    'NEEDS_ENGINEER',
    'APPLIED',
    'AWAITING_DEPLOY_APPROVAL',
    'REJECTED',
    'CANCELLED',
  ] as const)('valid ONLY while APPROVED_COOLING — %s refuses even the owner', (status) => {
    expect(canCancelRequest({ status, requester: 'sari' }, { id: 'sari', role: 'requester' })).toBe(false);
  });

  it('is false for the owner-as-Lead too, when not cooling — status gates before role/ownership', () => {
    expect(canCancelRequest({ status: 'APPLIED', requester: 'sari' }, { id: 'sari', role: 'lead', isAdmin: true })).toBe(
      false,
    );
  });
});

describe('cancelRequestVia — 409 STATE_CONFLICT triggers a refetch (0021 G1 lazy settlement)', () => {
  const request: ChangeRequest = {
    id: '01J',
    requester: 'sari',
    service: 'ebs',
    operationId: 'ebs-grow',
    macd: 'Change',
    targetAddress: 'aws_ebs_volume.app01',
    params: {},
    justification: 'grow the volume to 250 GiB for month-end load',
    exposure: 'l1_with_guardrails',
    risk: 'MEDIUM',
    status: 'CANCELLED',
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-11T00:00:00Z',
    events: [],
  };

  it('success: passes through ok:true verbatim and never calls getRequest', async () => {
    const cancelRequest = spy(async () => ({ ok: true as const, request }));
    const getRequest = spy(async () => {
      throw new Error('must not refetch on success');
    });
    const outcome = await cancelRequestVia(fakeClient({ cancelRequest, getRequest }), '01J');
    expect(outcome).toEqual({ ok: true, request });
    expect(cancelRequest.calls).toEqual([['01J']]);
    expect(getRequest.calls).toEqual([]);
  });

  it('CANCEL_FORBIDDEN: passes through as-is, no refetch (nothing to reconcile — the state didn\'t change)', async () => {
    const cancelRequest = spy(async () => ({
      ok: false as const,
      code: 'CANCEL_FORBIDDEN',
      reason: 'Only the requester or a Lead/admin may cancel this request.',
    }));
    const getRequest = spy(async () => {
      throw new Error('must not refetch on CANCEL_FORBIDDEN');
    });
    const outcome = await cancelRequestVia(fakeClient({ cancelRequest, getRequest }), '01J');
    expect(outcome).toEqual({
      ok: false,
      code: 'CANCEL_FORBIDDEN',
      reason: 'Only the requester or a Lead/admin may cancel this request.',
    });
    expect(getRequest.calls).toEqual([]);
  });

  it('STATE_CONFLICT: refetches the request and attaches it as `refetched`', async () => {
    const settled = { ...request, status: 'APPLIED' as const };
    const cancelRequest = spy(async () => ({
      ok: false as const,
      code: 'STATE_CONFLICT',
      reason: 'This request is not in a state that allows that.',
    }));
    const getRequest = spy(async (id: string) => {
      expect(id).toBe('01J');
      return settled;
    });
    const outcome = await cancelRequestVia(fakeClient({ cancelRequest, getRequest }), '01J');
    expect(outcome).toEqual({
      ok: false,
      code: 'STATE_CONFLICT',
      reason: 'This request is not in a state that allows that.',
      refetched: settled,
    });
    expect(getRequest.calls).toEqual([['01J']]);
  });

  it('STATE_CONFLICT where the refetch itself finds nothing: refetched is undefined, not thrown', async () => {
    const cancelRequest = spy(async () => ({
      ok: false as const,
      code: 'STATE_CONFLICT',
      reason: 'This request is not in a state that allows that.',
    }));
    const getRequest = spy(async () => undefined);
    const outcome = await cancelRequestVia(fakeClient({ cancelRequest, getRequest }), '01J');
    expect(outcome).toMatchObject({ ok: false, code: 'STATE_CONFLICT', refetched: undefined });
  });
});

describe('coolingTimeRemaining — human copy, deterministic via an injected `nowMs`', () => {
  const deadline = '2026-07-11T00:00:00.000Z';

  it('hours + minutes remaining', () => {
    const now = Date.parse('2026-07-10T00:15:00.000Z'); // 23h45m before deadline
    expect(coolingTimeRemaining(deadline, now)).toBe('23h 45m remaining');
  });

  it('minutes only, once under an hour', () => {
    const now = Date.parse('2026-07-10T23:40:00.000Z'); // 20m before deadline
    expect(coolingTimeRemaining(deadline, now)).toBe('20m remaining');
  });

  it('under a minute', () => {
    const now = Date.parse('2026-07-10T23:59:45.000Z');
    expect(coolingTimeRemaining(deadline, now)).toBe('less than a minute remaining');
  });

  it('already elapsed (lazy settlement has not caught up yet) — never a negative duration', () => {
    const now = Date.parse('2026-07-11T00:05:00.000Z');
    expect(coolingTimeRemaining(deadline, now)).toBe('elapsing shortly');
  });

  it('exactly at the deadline', () => {
    expect(coolingTimeRemaining(deadline, Date.parse(deadline))).toBe('elapsing shortly');
  });
});
