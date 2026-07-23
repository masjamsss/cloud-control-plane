import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import type { HttpApiClient } from '@/lib/httpApi';
import {
  canCancelWindowedRequest,
  canRewindowRequest,
  cancelWindowedRequestVia,
  rewindowRequestVia,
  windowCountdown,
  windowGateSummary,
} from '@/features/requests/windowFlow';

/**
 * Proves the SPA half of 0024 §2.2-§2.5 (the pure, React-free `windowFlow.ts`
 * module — RequestDetail.tsx's `WindowPanel` just wires this and renders the
 * result). Mirrors `coolingFlow.test.ts`'s fake-client + hand-rolled-spy
 * approach exactly (no jsdom in this repo — test/standalone.test.ts's exact
 * dependency allowlist; this repo doesn't use vitest's vi.fn — authFlow.test.ts's
 * identical helper).
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
    rewindowRequest: notUsed,
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

function spy<T extends unknown[], R>(impl: (...args: T) => R): ((...args: T) => R) & { calls: T[] } {
  const fn = (...args: T): R => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [] as T[];
  return fn;
}

const EXPIRED: Pick<ChangeRequest, 'status' | 'requester'> = { status: 'WINDOW_EXPIRED', requester: 'sari' };
const WAITING: Pick<ChangeRequest, 'status' | 'requester'> = { status: 'AWAITING_DEPLOY_APPROVAL', requester: 'sari' };

describe('canCancelWindowedRequest — mirrors the widened POST /:id/cancel authz+state rule (0024 §2.5/C5)', () => {
  it('the requester may cancel a WINDOW_EXPIRED request', () => {
    expect(canCancelWindowedRequest(EXPIRED, { id: 'sari', role: 'requester' })).toBe(true);
  });

  it('the requester may cancel an AWAITING_DEPLOY_APPROVAL request', () => {
    expect(canCancelWindowedRequest(WAITING, { id: 'sari', role: 'requester' })).toBe(true);
  });

  it('a Lead who is NOT the requester may also cancel (senior override)', () => {
    expect(canCancelWindowedRequest(EXPIRED, { id: 'budi', role: 'lead' })).toBe(true);
  });

  it('an admin who is NOT a Lead and NOT the requester may also cancel', () => {
    expect(canCancelWindowedRequest(WAITING, { id: 'nadia', role: 'approver', isAdmin: true })).toBe(true);
  });

  it('a plain approver who is neither the requester nor Lead/admin may NOT cancel', () => {
    expect(canCancelWindowedRequest(EXPIRED, { id: 'budi', role: 'approver' })).toBe(false);
  });

  it.each(['AWAITING_CODE_REVIEW', 'NEEDS_ENGINEER', 'APPLIED', 'APPROVED_COOLING', 'REJECTED', 'CANCELLED'] as const)(
    'valid only while AWAITING_DEPLOY_APPROVAL or WINDOW_EXPIRED — %s refuses even the owner (APPROVED_COOLING is CoolingPanel\'s own predicate)',
    (status) => {
      expect(canCancelWindowedRequest({ status, requester: 'sari' }, { id: 'sari', role: 'requester' })).toBe(false);
    },
  );
});

describe('canRewindowRequest — narrower than cancel: refuses mid-window and kind:"now" (0024 §2.4)', () => {
  const nowMs = Date.parse('2026-07-12T12:00:00.000Z');
  const beforeWindow: ChangeRequest['schedule'] = { kind: 'window', at: '2026-07-12T18:00:00Z', endAt: '2026-07-12T22:00:00Z' };
  const openWindow: ChangeRequest['schedule'] = { kind: 'window', at: '2026-07-12T10:00:00Z', endAt: '2026-07-12T22:00:00Z' };

  it('the requester may re-window a WINDOW_EXPIRED request', () => {
    expect(
      canRewindowRequest({ status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined }, { id: 'sari', role: 'requester' }, nowMs),
    ).toBe(true);
  });

  it('the requester may re-window an AWAITING_DEPLOY_APPROVAL request BEFORE its window opens', () => {
    expect(
      canRewindowRequest({ status: 'AWAITING_DEPLOY_APPROVAL', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined }, { id: 'sari', role: 'requester' }, nowMs),
    ).toBe(true);
  });

  it('refuses an AWAITING_DEPLOY_APPROVAL request whose window is CURRENTLY open — cancel is the verb for that', () => {
    expect(
      canRewindowRequest({ status: 'AWAITING_DEPLOY_APPROVAL', requester: 'sari', schedule: openWindow, earliestApplyAt: undefined }, { id: 'sari', role: 'requester' }, nowMs),
    ).toBe(false);
  });

  it('refuses a schedule.kind:"now" request even if AWAITING_DEPLOY_APPROVAL (freeze-held — nothing to move)', () => {
    expect(
      canRewindowRequest({ status: 'AWAITING_DEPLOY_APPROVAL', requester: 'sari', schedule: { kind: 'now' }, earliestApplyAt: undefined }, { id: 'sari', role: 'requester' }, nowMs),
    ).toBe(false);
  });

  it('a plain approver who is neither requester nor Lead/admin may NOT re-window', () => {
    expect(
      canRewindowRequest({ status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined }, { id: 'budi', role: 'approver' }, nowMs),
    ).toBe(false);
  });

  it('a Lead who is NOT the requester may re-window (senior override)', () => {
    expect(
      canRewindowRequest({ status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined }, { id: 'budi', role: 'lead' }, nowMs),
    ).toBe(true);
  });
});

describe('cancelWindowedRequestVia — 409 STATE_CONFLICT triggers a refetch (lazy settlement)', () => {
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
    const outcome = await cancelWindowedRequestVia(fakeClient({ cancelRequest, getRequest }), '01J');
    expect(outcome).toEqual({ ok: true, request });
    expect(cancelRequest.calls).toEqual([['01J']]);
    expect(getRequest.calls).toEqual([]);
  });

  it('CANCEL_FORBIDDEN: passes through as-is, no refetch', async () => {
    const cancelRequest = spy(async () => ({ ok: false as const, code: 'CANCEL_FORBIDDEN', reason: 'no' }));
    const getRequest = spy(async () => {
      throw new Error('must not refetch on CANCEL_FORBIDDEN');
    });
    const outcome = await cancelWindowedRequestVia(fakeClient({ cancelRequest, getRequest }), '01J');
    expect(outcome).toEqual({ ok: false, code: 'CANCEL_FORBIDDEN', reason: 'no' });
    expect(getRequest.calls).toEqual([]);
  });

  it('STATE_CONFLICT: refetches the request and attaches it as `refetched`', async () => {
    const settled = { ...request, status: 'WINDOW_EXPIRED' as const };
    const cancelRequest = spy(async () => ({ ok: false as const, code: 'STATE_CONFLICT', reason: 'conflict' }));
    const getRequest = spy(async (id: string) => {
      expect(id).toBe('01J');
      return settled;
    });
    const outcome = await cancelWindowedRequestVia(fakeClient({ cancelRequest, getRequest }), '01J');
    expect(outcome).toEqual({ ok: false, code: 'STATE_CONFLICT', reason: 'conflict', refetched: settled });
  });
});

describe('rewindowRequestVia — same STATE_CONFLICT-refetches policy, passes {at, endAt} through', () => {
  it('success: forwards {at, endAt} verbatim and passes through ok:true', async () => {
    const request = { id: '01J' } as ChangeRequest;
    const rewindowRequest = spy(async (_id: string, _input: { at: string; endAt?: string }) => ({ ok: true as const, request }));
    const outcome = await rewindowRequestVia(fakeClient({ rewindowRequest }), '01J', '2026-07-13T00:00:00Z', '2026-07-13T02:00:00Z');
    expect(outcome).toEqual({ ok: true, request });
    expect(rewindowRequest.calls).toEqual([['01J', { at: '2026-07-13T00:00:00Z', endAt: '2026-07-13T02:00:00Z' }]]);
  });

  it('SCHEDULE_TOO_SOON: passes through as-is, no refetch', async () => {
    const rewindowRequest = spy(async () => ({ ok: false as const, code: 'SCHEDULE_TOO_SOON', reason: 'too soon' }));
    const getRequest = spy(async () => {
      throw new Error('must not refetch on a validation rejection');
    });
    const outcome = await rewindowRequestVia(fakeClient({ rewindowRequest, getRequest }), '01J', '2026-07-12T12:01:00Z');
    expect(outcome).toEqual({ ok: false, code: 'SCHEDULE_TOO_SOON', reason: 'too soon' });
    expect(getRequest.calls).toEqual([]);
  });

  it('STATE_CONFLICT: refetches and attaches `refetched`', async () => {
    const settled = { id: '01J', status: 'CANCELLED' } as ChangeRequest;
    const rewindowRequest = spy(async () => ({ ok: false as const, code: 'STATE_CONFLICT', reason: 'conflict' }));
    const getRequest = spy(async () => settled);
    const outcome = await rewindowRequestVia(fakeClient({ rewindowRequest, getRequest }), '01J', '2026-07-13T00:00:00Z');
    expect(outcome).toEqual({ ok: false, code: 'STATE_CONFLICT', reason: 'conflict', refetched: settled });
  });
});

describe('windowGateSummary — the display-only mirror of applyGate\'s decision', () => {
  const start = '2026-07-12T18:00:00Z';
  const end = '2026-07-12T22:00:00Z';
  const schedule: ChangeRequest['schedule'] = { kind: 'window', at: start, endAt: end };

  it('before the window and no cooling: before_window', () => {
    expect(windowGateSummary(schedule!, undefined, Date.parse('2026-07-12T17:00:00Z'))).toBe('before_window');
  });

  it('inside the window: open', () => {
    expect(windowGateSummary(schedule!, undefined, Date.parse('2026-07-12T19:00:00Z'))).toBe('open');
  });

  it('past the window end: expired', () => {
    expect(windowGateSummary(schedule!, undefined, Date.parse('2026-07-12T23:00:00Z'))).toBe('expired');
  });

  it('cooling not yet met, even though inside the window bounds: cooling', () => {
    expect(windowGateSummary(schedule!, '2026-07-12T20:00:00Z', Date.parse('2026-07-12T19:00:00Z'))).toBe('cooling');
  });

  it('expiry beats cooling — WINDOW_EXPIRED wins even if cooling also unmet', () => {
    expect(windowGateSummary(schedule!, '2026-07-13T00:00:00Z', Date.parse('2026-07-12T23:00:00Z'))).toBe('expired');
  });

  it('a legacy row with no endAt defaults to at+4h, mirroring windowEndOf', () => {
    const legacy: ChangeRequest['schedule'] = { kind: 'window', at: start };
    expect(windowGateSummary(legacy!, undefined, Date.parse('2026-07-12T21:59:00Z'))).toBe('open');
    expect(windowGateSummary(legacy!, undefined, Date.parse('2026-07-12T22:01:00Z'))).toBe('expired');
  });
});

describe('windowCountdown — human copy, deterministic via an injected nowMs', () => {
  const target = '2026-07-12T22:00:00.000Z';

  it('hours + minutes', () => {
    expect(windowCountdown(target, Date.parse('2026-07-12T20:15:00.000Z'))).toBe('1h 45m');
  });

  it('minutes only, once under an hour', () => {
    expect(windowCountdown(target, Date.parse('2026-07-12T21:40:00.000Z'))).toBe('20m');
  });

  it('under a minute', () => {
    expect(windowCountdown(target, Date.parse('2026-07-12T21:59:45.000Z'))).toBe('less than a minute');
  });

  it('already elapsed — never a negative duration', () => {
    expect(windowCountdown(target, Date.parse('2026-07-12T22:05:00.000Z'))).toBe('any moment now');
  });

  it('exactly at the target', () => {
    expect(windowCountdown(target, Date.parse(target))).toBe('any moment now');
  });
});
