import { beforeEach, describe, expect, it } from 'vitest';
import { createHttpApiClient } from '@/lib/httpApi';
import { setProjectScopeForTests } from '@/lib/projectScope';

/**
 * Unit coverage for the account & security center's NEW HTTP client methods
 * (A2): the exact method/path/body each sends, and how each response shape
 * is parsed. Mirrors httpApiAdmin.test.ts's fake-`fetch` seam — no network,
 * no real ccp-api process (that end-to-end proof lives in
 * httpApi.integration.test.ts / the api package's own extensive route tests,
 * ccp/api/test/{totpDevices,recoveryCodes,reauth,accountSecurityRoutes}.test.ts).
 */
beforeEach(() => setProjectScopeForTests('sample'));

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}

function fakeFetch(handler: (call: Call) => { status: number; body?: unknown }): { fetch: typeof fetch; calls: Call[] } {
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

describe('POST /auth/reauth', () => {
  it('sends {password} verbatim and parses {ok, reauthAt}', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, reauthAt: '2026-07-22T10:00:00Z' } }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.reauth({ password: 'sekrit' });
    expect(calls[0]).toMatchObject({ url: '/auth/reauth', method: 'POST', body: { password: 'sekrit' } });
    expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    expect(calls[0]!.credentials).toBe('include');
    expect(result).toEqual({ ok: true, reauthAt: '2026-07-22T10:00:00Z' });
  });

  it('sends {code} verbatim for the TOTP branch', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, reauthAt: 'x' } }));
    const client = createHttpApiClient('', { fetch });
    await client.reauth({ code: '123456' });
    expect(calls[0]!.body).toEqual({ code: '123456' });
  });

  it('a 403 REAUTH_REQUIRED-shaped error surfaces the server reason', async () => {
    const { fetch } = fakeFetch(() => ({ status: 403, body: { code: 'REAUTH_REQUIRED', reason: 'Please confirm it is you before continuing.' } }));
    const client = createHttpApiClient('', { fetch });
    await expect(client.reauth({ password: 'wrong' })).rejects.toThrow('Please confirm it is you before continuing.');
  });
});

describe('multi-device TOTP self-service', () => {
  it('listTotpDevices: GET /auth/totp-devices', async () => {
    const rows = [{ id: 'd1', name: 'Phone', enrolledAt: '2026-01-01T00:00:00Z' }];
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: rows }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.listTotpDevices();
    expect(calls[0]).toMatchObject({ url: '/auth/totp-devices', method: 'GET' });
    expect(result).toEqual(rows);
  });

  it('beginAddTotpDevice: POST /auth/totp-devices with an empty body, parses {secret, otpauthUri}', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { secret: 'ABCD1234', otpauthUri: 'otpauth://totp/x' } }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.beginAddTotpDevice();
    expect(calls[0]).toMatchObject({ url: '/auth/totp-devices', method: 'POST', body: {} });
    expect(result).toEqual({ secret: 'ABCD1234', otpauthUri: 'otpauth://totp/x' });
  });

  it('confirmAddTotpDevice: POST /auth/totp-devices/confirm {code, name}, carries optional recoveryCodes', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { id: 'd1', name: 'My phone', enrolledAt: '2026-01-01T00:00:00Z', recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.confirmAddTotpDevice('123456', 'My phone');
    expect(calls[0]).toMatchObject({ url: '/auth/totp-devices/confirm', method: 'POST', body: { code: '123456', name: 'My phone' } });
    expect(result.recoveryCodes).toEqual(['AAAA-BBBB-CCCC-DDDD']);
  });

  it('removeTotpDevice: DELETE /auth/totp-devices/:id (url-encoded)', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    const client = createHttpApiClient('', { fetch });
    await client.removeTotpDevice('a b/c');
    expect(calls[0]).toMatchObject({ url: '/auth/totp-devices/a%20b%2Fc', method: 'DELETE' });
  });

  it('a 422 DEVICE_LIMIT/LAST_FACTOR surfaces the server reason on begin/remove', async () => {
    const { fetch } = fakeFetch(() => ({ status: 422, body: { code: 'DEVICE_LIMIT', reason: 'You already have 5 authenticator devices — remove one before adding another.' } }));
    const client = createHttpApiClient('', { fetch });
    await expect(client.beginAddTotpDevice()).rejects.toThrow('remove one before adding another');
  });
});

describe('recovery codes self-service', () => {
  it('getRecoveryCodesStatus: GET /auth/recovery-codes', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { remaining: 7, generatedAt: '2026-01-01T00:00:00Z' } }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.getRecoveryCodesStatus();
    expect(calls[0]).toMatchObject({ url: '/auth/recovery-codes', method: 'GET' });
    expect(result).toEqual({ remaining: 7, generatedAt: '2026-01-01T00:00:00Z' });
  });

  it('regenerateRecoveryCodes: POST /auth/recovery-codes/regenerate, parses the 10 fresh codes', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `CODE-${i}`);
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { codes, generatedAt: '2026-01-01T00:00:00Z' } }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.regenerateRecoveryCodes();
    expect(calls[0]).toMatchObject({ url: '/auth/recovery-codes/regenerate', method: 'POST' });
    expect(result.codes).toHaveLength(10);
  });
});

describe('active sessions self-service', () => {
  it('listOwnSessions: GET /auth/sessions', async () => {
    const rows = [{ id: 'sha1', issuedAt: 'a', lastSeenAt: 'b', current: true }];
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: rows }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.listOwnSessions();
    expect(calls[0]).toMatchObject({ url: '/auth/sessions', method: 'GET' });
    expect(result).toEqual(rows);
  });

  it('revokeOwnSession: DELETE /auth/sessions/:id', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, revoked: 1 } }));
    const client = createHttpApiClient('', { fetch });
    await client.revokeOwnSession('the-hash');
    expect(calls[0]).toMatchObject({ url: '/auth/sessions/the-hash', method: 'DELETE' });
  });

  it('revokeOwnOtherSessions: POST /auth/sessions/revoke-others, parses {revoked}', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, revoked: 3 } }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.revokeOwnOtherSessions();
    expect(calls[0]).toMatchObject({ url: '/auth/sessions/revoke-others', method: 'POST' });
    expect(result).toEqual({ revoked: 3 });
  });
});

describe('completeTotpRecovery (recovery-code login)', () => {
  it('POST /auth/totp/recovery {code}, parses recoveryLogin:true', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { user: { id: 'a', username: 'a', displayName: 'A', role: 'lead', teamId: 'x', status: 'active', isAdmin: false, mustChangePassword: false, totpEnrolled: true }, mustChangePassword: false, recoveryLogin: true },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.completeTotpRecovery('AAAA-BBBB-CCCC-DDDD');
    expect(calls[0]).toMatchObject({ url: '/auth/totp/recovery', method: 'POST', body: { code: 'AAAA-BBBB-CCCC-DDDD' } });
    expect(result.recoveryLogin).toBe(true);
  });

  it('a generic TOTP_REQUIRED failure surfaces the server reason (no enumeration)', async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { code: 'TOTP_REQUIRED', reason: 'A verification code is required.' } }));
    const client = createHttpApiClient('', { fetch });
    await expect(client.completeTotpRecovery('WRONG')).rejects.toThrow('A verification code is required.');
  });
});

describe('changePassword — keepOtherSessions', () => {
  it('omitted: body carries only currentPassword/newPassword (server default false)', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { user: { id: 'a', username: 'a', displayName: 'A', role: 'requester', teamId: 'x', status: 'active', isAdmin: false, mustChangePassword: false, totpEnrolled: false }, mustChangePassword: false },
    }));
    const client = createHttpApiClient('', { fetch });
    await client.changePassword('old', 'new-password-1');
    expect(calls[0]!.body).toEqual({ currentPassword: 'old', newPassword: 'new-password-1' });
  });

  it('true: sent explicitly', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { user: { id: 'a', username: 'a', displayName: 'A', role: 'requester', teamId: 'x', status: 'active', isAdmin: false, mustChangePassword: false, totpEnrolled: false }, mustChangePassword: false },
    }));
    const client = createHttpApiClient('', { fetch });
    await client.changePassword('old', 'new-password-1', true);
    expect(calls[0]!.body).toEqual({ currentPassword: 'old', newPassword: 'new-password-1', keepOtherSessions: true });
  });
});
