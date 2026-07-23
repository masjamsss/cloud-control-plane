import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminPolicy, AdminWriteOutcome, HttpApiClient } from '@/lib/httpApi';
import {
  describeConfigWrite,
  loadPolicyVia,
  localPolicyState,
  savePolicyVia,
} from '@/features/admin/policyFlow';
import { DEFAULT_POLICY, getPolicy, resetPolicyForTests, setPolicy } from '@/lib/policy';

/**
 * The policy flow's honesty proof (the teamsFlow.test.ts pattern):
 * `authoritative=true` routes every read/write through ccp-api's
 * GET/PUT /admin/policy (asserted via a fake client — no jsdom here, so the
 * branching itself is what's under test); `authoritative=false` is exactly
 * the pre-existing lib/policy localStorage behavior.
 */

function fakeClient(over: Partial<HttpApiClient> = {}): HttpApiClient {
  const notUsed = (): never => {
    throw new Error('fakeClient: method not stubbed for this test');
  };
  return {
    getAdminPolicy: notUsed,
    putAdminPolicy: notUsed,
    ...over,
  } as unknown as HttpApiClient;
}

/** Hand-rolled spy (repo convention — see teamsFlow.test.ts). */
function spy<T extends unknown[], R>(
  impl: (...args: T) => R,
): ((...args: T) => R) & { calls: T[] } {
  const fn = (...args: T): R => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [] as T[];
  return fn;
}

const NEVER_CALLED = (): never => {
  throw new Error('server must not be called when not authoritative');
};

beforeEach(resetPolicyForTests);

describe('localPolicyState', () => {
  it('is the synchronous local snapshot with version 0', () => {
    setPolicy({ high: 3 });
    expect(localPolicyState()).toEqual({ policy: { ...DEFAULT_POLICY, high: 3 }, version: 0 });
  });
});

describe('loadPolicyVia', () => {
  it('authoritative + client: reads GET /admin/policy and splits policy from version', async () => {
    const served: AdminPolicy = { low: 1, medium: 2, high: 3, deleteMin: 2, version: 7 };
    const getAdminPolicy = spy(async () => served);
    const result = await loadPolicyVia(true, fakeClient({ getAdminPolicy }));
    expect(getAdminPolicy.calls).toEqual([[]]);
    expect(result).toEqual({ policy: { low: 1, medium: 2, high: 3, deleteMin: 2 }, version: 7 });
  });

  it('not authoritative: falls back to lib/policy — the server is never called', async () => {
    const getAdminPolicy = spy(NEVER_CALLED);
    setPolicy({ deleteMin: 4 });
    const result = await loadPolicyVia(false, fakeClient({ getAdminPolicy }));
    expect(getAdminPolicy.calls).toEqual([]);
    expect(result).toEqual({ policy: getPolicy(), version: 0 });
  });
});

describe('savePolicyVia', () => {
  const next = { low: 1, medium: 1, high: 2, deleteMin: 3 };

  it('authoritative + client: PUTs the four tiers and returns the outcome verbatim', async () => {
    const putAdminPolicy = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    const outcome = await savePolicyVia(true, fakeClient({ putAdminPolicy }), next);
    expect(putAdminPolicy.calls).toEqual([[next]]);
    expect(outcome).toEqual({ applied: true });
    // The local store is untouched — the server owns the truth.
    expect(getPolicy()).toEqual(DEFAULT_POLICY);
  });

  it('authoritative: a dual-controlled downgrade (202) surfaces {applied:false, pendingId}', async () => {
    const putAdminPolicy = spy(async (): Promise<AdminWriteOutcome> => ({
      applied: false,
      pendingId: '01P',
    }));
    const outcome = await savePolicyVia(true, fakeClient({ putAdminPolicy }), next);
    expect(outcome).toEqual({ applied: false, pendingId: '01P' });
  });

  it('not authoritative: writes lib/policy and reports applied — the server is never called', async () => {
    const putAdminPolicy = spy(NEVER_CALLED);
    const outcome = await savePolicyVia(false, fakeClient({ putAdminPolicy }), next);
    expect(putAdminPolicy.calls).toEqual([]);
    expect(outcome).toEqual({ applied: true });
    expect(getPolicy()).toEqual(next);
  });
});

describe('describeConfigWrite — never claims an un-applied success', () => {
  it('applied → a plain past-tense sentence', () => {
    expect(describeConfigWrite({ applied: true }, 'Policy saved')).toBe('Policy saved.');
  });
  it('proposed → says so, and that a second admin must approve', () => {
    expect(describeConfigWrite({ applied: false, pendingId: 'x' }, 'Policy saved')).toBe(
      "Policy saved — proposed, pending a second admin's approval.",
    );
  });
});
