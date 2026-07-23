import { describe, expect, it } from 'vitest';
import { createHttpApiClient } from '@/lib/httpApi';

/**
 * Unit coverage for the request-lifecycle additions Lane A's merge added to
 * ccp-api (0021 G1/G3/G5): POST /requests/:id/cancel, GET
 * /requests/:id/feasibility, and TOTP_ENROLLMENT_REQUIRED now surfacing as a
 * `code` on approveRequest's MutationResult. Same technique as
 * httpApiAdmin.test.ts — an injected fake `fetch` (the same
 * {@link HttpApiOptions.fetch} seam httpApi.integration.test.ts uses against
 * a real server), proving exact method/path, `credentials:'include'`, the
 * `x-ccp-client` CSRF header on every mutation (never on a GET), and §8
 * error surfacing — without a network hop.
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}

/** A minimal fake `fetch`: records every call and answers with a canned response. */
function fakeFetch(handler: (call: Call) => { status: number; body?: unknown }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init.credentials,
    };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const CANCELLED_REQUEST = {
  id: '01J-cancel',
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

describe('httpApi — POST /requests/:id/cancel (0021 G1)', () => {
  it('POSTs the right path, carries credentials + the CSRF header, and returns ok:true on 200', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: CANCELLED_REQUEST }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.cancelRequest('01J-cancel');
    expect(result).toEqual({ ok: true, request: CANCELLED_REQUEST });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/requests/01J-cancel/cancel',
      method: 'POST',
      credentials: 'include',
    });
    expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
  });

  it('encodes the id in the path', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: CANCELLED_REQUEST }));
    const client = createHttpApiClient('', { fetch });
    await client.cancelRequest('has space/slash');
    expect(calls[0]!.url).toBe('/requests/has%20space%2Fslash/cancel');
  });

  it('403 CANCEL_FORBIDDEN → ok:false with the raw code and server reason', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: { code: 'CANCEL_FORBIDDEN', reason: 'Only the requester or a Lead/admin may cancel this request.' },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.cancelRequest('01J-cancel');
    expect(result).toEqual({
      ok: false,
      code: 'CANCEL_FORBIDDEN',
      reason: 'Only the requester or a Lead/admin may cancel this request.',
    });
  });

  it('409 STATE_CONFLICT → ok:false with the raw code (the caller decides whether to refetch)', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { code: 'STATE_CONFLICT', reason: 'This request is not in a state that allows that.' },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.cancelRequest('01J-cancel');
    expect(result).toEqual({
      ok: false,
      code: 'STATE_CONFLICT',
      reason: 'This request is not in a state that allows that.',
    });
  });

  it('404 (a request that does not exist) surfaces its own code, not a generic fallback', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 404,
      body: { code: 'NOT_FOUND', reason: 'No such request.' },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.cancelRequest('ghost');
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND', reason: 'No such request.' });
  });
});

describe('httpApi — GET /requests/:id/feasibility (0021 G5, LIVE)', () => {
  const FEASIBILITY = {
    requestId: '01J-feas',
    status: 'AWAITING_CODE_REVIEW',
    approvals: 0,
    approvalsRequired: 2,
    eligibleApprovers: 1,
    feasible: true,
    interimProfileWillApply: false,
  };

  it('GETs the right path with no CSRF header (GET is CSRF-exempt), returns the parsed body', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: FEASIBILITY }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.getRequestFeasibility('01J-feas');
    expect(result).toEqual(FEASIBILITY);
    expect(calls[0]).toMatchObject({ url: '/requests/01J-feas/feasibility', method: 'GET' });
    expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
  });

  it('404 → undefined (matches getRequest()\'s not-found convention, not a throw)', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: { code: 'NOT_FOUND', reason: 'No such request.' } }));
    const client = createHttpApiClient('', { fetch });
    expect(await client.getRequestFeasibility('ghost')).toBeUndefined();
  });

  it('any other rejection (e.g. 401) throws with the server reason', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 401,
      body: { code: 'NO_SESSION', reason: 'You are not signed in.' },
    }));
    const client = createHttpApiClient('', { fetch });
    await expect(client.getRequestFeasibility('01J-feas')).rejects.toThrow('You are not signed in.');
  });
});

describe('httpApi — approveRequest now surfaces the raw §8 code (0021 G3 fold-in)', () => {
  it('403 TOTP_ENROLLMENT_REQUIRED → ok:false with that exact code, not just the reason text', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: {
        code: 'TOTP_ENROLLMENT_REQUIRED',
        reason: 'Approval requires an enrolled authenticator on your account.',
      },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.approveRequest('01J-approve');
    expect(result).toEqual({
      ok: false,
      code: 'TOTP_ENROLLMENT_REQUIRED',
      reason: 'Approval requires an enrolled authenticator on your account.',
    });
  });

  it('a success still returns ok:true with no code field at all', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: CANCELLED_REQUEST }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.approveRequest('01J-approve');
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('code');
  });

  it('rejectRequest also surfaces the raw code (internal consistency with approve/cancel)', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { code: 'STATE_CONFLICT', reason: 'This request is not in a state that allows that.' },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.rejectRequest('01J-reject', 'no longer needed');
    expect(result).toEqual({
      ok: false,
      code: 'STATE_CONFLICT',
      reason: 'This request is not in a state that allows that.',
    });
  });
});

describe('httpApi — POST /requests/:id/link-pr (0033 A12/P6)', () => {
  const LINKED_REQUEST = {
    id: '01J-link',
    requester: 'sari',
    service: 'ebs',
    operationId: 'ebs-set-encrypted',
    macd: 'Change',
    targetAddress: 'aws_ebs_volume.app01',
    params: {},
    justification: 'encrypt the APP01 data volume per the security baseline',
    exposure: 'engineer_only',
    risk: 'HIGH',
    status: 'NEEDS_ENGINEER',
    prUrl: 'https://github.com/example-org/example-estate/pull/321',
    prNumber: 321,
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-15T00:00:00Z',
    events: [],
  };

  it('POSTs the URL body to the right path with credentials + the CSRF header; ok:true carries the linked request', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: LINKED_REQUEST }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.linkRequestPr('01J-link', {
      prUrl: 'https://github.com/example-org/example-estate/pull/321',
    });
    expect(result).toEqual({ ok: true, request: LINKED_REQUEST });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/requests/01J-link/link-pr',
      method: 'POST',
      credentials: 'include',
      body: { prUrl: 'https://github.com/example-org/example-estate/pull/321' },
    });
    expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
  });

  it('403 FORBIDDEN_ROLE (a non-Lead) → ok:false with the raw code and server reason', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: { code: 'FORBIDDEN_ROLE', reason: 'Only approvers and leads can do that.' },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.linkRequestPr('01J-link', { prUrl: 'https://github.com/x/y/pull/1' });
    expect(result).toEqual({
      ok: false,
      code: 'FORBIDDEN_ROLE',
      reason: 'Only approvers and leads can do that.',
    });
  });

  it('409 STATE_CONFLICT (terminal request) → ok:false with the raw code', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { code: 'STATE_CONFLICT', reason: 'This request is not in a state that allows that.' },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.linkRequestPr('01J-link', { prUrl: 'https://github.com/x/y/pull/1' });
    expect(result).toEqual({
      ok: false,
      code: 'STATE_CONFLICT',
      reason: 'This request is not in a state that allows that.',
    });
  });
});
