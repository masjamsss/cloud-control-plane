import { beforeEach, describe, expect, it } from 'vitest';
import { createHttpApiClient } from '@/lib/httpApi';
import { setProjectScopeForTests } from '@/lib/projectScope';

/**
 * Unit coverage for the 0014 P1 #4 admin methods on the HTTP client: audit
 * read/export, teams CRUD, and the targeted account-security actions
 * (reset-totp / revoke-sessions). httpApi.integration.test.ts already proves the
 * client's session/auth lifecycle against a REAL ccp-api process end to end;
 * that harness can't easily reach admin routes too (they sit behind the
 * password-change gate a fresh bootstrap account starts under), so this file
 * proves the same contract — exact method/path/query/body, `credentials:'include'`,
 * the `x-ccp-client` CSRF header on every mutation, and §8 error surfacing —
 * with an injected fake `fetch` (the same {@link HttpApiOptions.fetch} seam the
 * integration test uses, just without a network hop).
 *
 * Data-birth lane B: the http client no longer assumes an unconditional 'sample'
 * scope (that hardcoded default is exactly what made a blank real install's
 * every request, login included, carry a bogus estate header). This file's
 * "the active account" premise still holds — these methods DO carry whatever
 * scope is active — so it is made explicit here instead of implicit.
 */
beforeEach(() => setProjectScopeForTests('sample'));

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

/**
 * Data-birth lane B item 1 — the acceptance signal restated as a fast unit
 * test (httpApi.integration.test.ts proves the same fact end to end against
 * a REAL ccp-api, but that harness skips when ccp/api's deps are not
 * installed; this one always runs). Exercised via an ordinary admin GET —
 * the behavior lives in `request()` itself, not any one method.
 */
describe('acting-account header — sent only once an estate is scoped (data-birth lane B)', () => {
  it('unscoped (the pre-estate state, e.g. login) sends NO x-ccp-project header at all', async () => {
    setProjectScopeForTests('');
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    const client = createHttpApiClient('', { fetch });
    await client.listAdminTeams();
    expect(calls[0]!.headers).not.toHaveProperty('x-ccp-project');
  });

  it('once scoped, the very next call carries it again', async () => {
    setProjectScopeForTests('');
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    const client = createHttpApiClient('', { fetch });
    setProjectScopeForTests('acme');
    await client.listAdminTeams();
    expect(calls[0]!.headers['x-ccp-project']).toBe('acme');
  });

  it('an explicit per-call projectId override still wins even while otherwise unscoped', async () => {
    setProjectScopeForTests('');
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    const client = createHttpApiClient('', { fetch });
    await client.listAdminTeams({ projectId: 'acme' });
    expect(calls[0]!.headers['x-ccp-project']).toBe('acme');
  });
});

describe('httpApi admin methods (0014 P1 #4)', () => {
  describe('audit — GET /admin/audit, GET /admin/audit/export', () => {
    it('listAuditEntries with no opts hits the bare path (no query string)', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { items: [] } }));
      const client = createHttpApiClient('', { fetch });
      const page = await client.listAuditEntries();
      expect(page).toEqual({ items: [] });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        url: '/admin/audit',
        method: 'GET',
        credentials: 'include',
      });
      // GET is CSRF-exempt server-side (withClientHeader) — mirrors every existing GET.
      expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
    });

    it('listAuditEntries encodes limit + cursor as query params', async () => {
      const entry = {
        id: '01J',
        at: '2026-07-10T00:00:00Z',
        actor: 'putra',
        action: 'team-create',
        targetType: 'team',
        targetId: 'platform',
        prevHash: '',
        hash: 'h1',
      };
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { items: [entry], cursor: '01J' },
      }));
      const client = createHttpApiClient('https://api.example', { fetch });
      const page = await client.listAuditEntries({ limit: 50, cursor: 'abc' });
      expect(page.items).toEqual([entry]);
      expect(page.cursor).toBe('01J');
      expect(calls[0]!.url).toBe('https://api.example/admin/audit?limit=50&cursor=abc');
    });

    it('exportAudit GETs /admin/audit/export and returns the verification document', async () => {
      const doc = {
        projectId: 'sample',
        head: 'h9',
        count: 3,
        verified: true,
        verification: { code: 0 as const, message: 'ok: 3 entries intact' },
        entries: [],
      };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: doc }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.exportAudit()).toEqual(doc);
      expect(calls[0]).toMatchObject({ url: '/admin/audit/export', method: 'GET' });
    });

    it('a non-admin caller (403 NOT_ADMIN) rejects with the server reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 403,
        body: { code: 'NOT_ADMIN', reason: 'Admin capability is required for that.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.listAuditEntries()).rejects.toThrow(
        'Admin capability is required for that.',
      );
    });
  });

  describe('teams CRUD — GET/POST/PATCH/DELETE /admin/teams[/:id][/services]', () => {
    it('listAdminTeams GETs /admin/teams (default: the active account, x-ccp-project sent)', async () => {
      const teams = [{ id: 'platform', name: 'Platform', serviceSlugs: ['s3'] }];
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: teams }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.listAdminTeams()).toEqual(teams);
      expect(calls[0]).toMatchObject({
        url: '/admin/teams',
        method: 'GET',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
      // The acting-account header rides on every request ONCE SCOPED (this
      // describe's beforeEach scopes to 'sample'), GETs included.
      expect(calls[0]!.headers['x-ccp-project']).toBe('sample');
    });

    it("listAdminTeams({ projectId }) overrides x-ccp-project to read ANOTHER account's teams", async () => {
      // Teams are per account; the assignment panel's team picker reads the
      // chosen account's list via this override, not the active account's.
      const teams = [{ id: 'erp-basis', name: 'ERP Basis', serviceSlugs: ['ec2'] }];
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: teams }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.listAdminTeams({ projectId: 'acme' })).toEqual(teams);
      expect(calls[0]).toMatchObject({ url: '/admin/teams', method: 'GET' });
      expect(calls[0]!.headers['x-ccp-project']).toBe('acme');
    });

    it('createAdminTeam POSTs {name} — credentials + CSRF header carried, no serviceSlugs key when omitted', async () => {
      const created = { id: 'platform', name: 'Platform', serviceSlugs: [] };
      const { fetch, calls } = fakeFetch(() => ({ status: 201, body: created }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.createAdminTeam('Platform')).toEqual(created);
      expect(calls[0]).toMatchObject({
        url: '/admin/teams',
        method: 'POST',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.body).toEqual({ name: 'Platform' });
      expect(calls[0]!.body).not.toHaveProperty('serviceSlugs');
    });

    it('createAdminTeam includes serviceSlugs when given', async () => {
      const created = { id: 'erp-basis', name: 'ERP Basis', serviceSlugs: ['ec2', 'ebs'] };
      const { fetch, calls } = fakeFetch(() => ({ status: 201, body: created }));
      const client = createHttpApiClient('', { fetch });
      await client.createAdminTeam('ERP Basis', ['ec2', 'ebs']);
      expect(calls[0]!.body).toEqual({ name: 'ERP Basis', serviceSlugs: ['ec2', 'ebs'] });
    });

    it('a duplicate name (409 DUPLICATE_TEAM) rejects with the server reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 409,
        body: { code: 'DUPLICATE_TEAM', reason: 'That team name is already taken.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.createAdminTeam('Platform')).rejects.toThrow(
        'That team name is already taken.',
      );
    });

    it('renameAdminTeam PATCHes /admin/teams/:id with {name}', async () => {
      const updated = { id: 'platform', name: 'Core Platform', serviceSlugs: [] };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: updated }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.renameAdminTeam('platform', 'Core Platform')).toEqual(updated);
      expect(calls[0]).toMatchObject({ url: '/admin/teams/platform', method: 'PATCH' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.body).toEqual({ name: 'Core Platform' });
    });

    it('setAdminTeamServices PUTs /admin/teams/:id/services with {serviceSlugs}', async () => {
      const updated = { id: 'platform', name: 'Platform', serviceSlugs: ['s3', 'ec2'] };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: updated }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAdminTeamServices('platform', ['s3', 'ec2'])).toEqual(updated);
      expect(calls[0]).toMatchObject({ url: '/admin/teams/platform/services', method: 'PUT' });
      expect(calls[0]!.body).toEqual({ serviceSlugs: ['s3', 'ec2'] });
    });

    it('deleteAdminTeam DELETEs /admin/teams/:id and resolves with no body on 204', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 204 }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.deleteAdminTeam('platform')).resolves.toBeUndefined();
      expect(calls[0]).toMatchObject({
        url: '/admin/teams/platform',
        method: 'DELETE',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('deleteAdminTeam refused while members/services exist (409 TEAM_NOT_EMPTY) rejects with the reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 409,
        body: {
          code: 'TEAM_NOT_EMPTY',
          reason: "Move this team's members and services before deleting it.",
        },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.deleteAdminTeam('platform')).rejects.toThrow(/before deleting it/);
    });

    it('team ids are URL-encoded in every path', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { id: 'a b', name: 'x', serviceSlugs: [] },
      }));
      const client = createHttpApiClient('', { fetch });
      await client.renameAdminTeam('a b', 'x');
      expect(calls[0]!.url).toBe('/admin/teams/a%20b');
    });
  });

  describe('accounts CRUD (B1) — GET/POST/PATCH /admin/accounts[/:id][/reset-password]', () => {
    const account = {
      id: 'sari',
      username: 'sari',
      displayName: 'Sari',
      role: 'requester',
      teamId: 'erp-basis',
      status: 'active',
      isAdmin: false,
      mustChangePassword: false,
      totpEnrolled: false,
      createdAt: '2026-07-01T00:00:00Z',
      createdBy: 'system',
    };

    it('listAdminAccounts GETs /admin/accounts', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [account] }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.listAdminAccounts()).toEqual([account]);
      expect(calls[0]).toMatchObject({
        url: '/admin/accounts',
        method: 'GET',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
    });

    it('createAdminAccount POSTs the input verbatim; 201 (tightening) → {applied:true, account}', async () => {
      const created = {
        ...account,
        id: 'nia',
        username: 'nia',
        displayName: 'Nia',
        mustChangePassword: true,
        createdBy: 'putra',
      };
      const { fetch, calls } = fakeFetch(() => ({ status: 201, body: created }));
      const client = createHttpApiClient('', { fetch });
      const input = {
        username: 'nia',
        displayName: 'Nia',
        role: 'requester' as const,
        teamId: 'erp-basis',
        password: 'satu-dua-tiga-empat',
      };
      expect(await client.createAdminAccount(input)).toEqual({ applied: true, account: created });
      expect(calls[0]).toMatchObject({
        url: '/admin/accounts',
        method: 'POST',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.body).toEqual(input);
    });

    it('createAdminAccount: 202 (dual-controlled senior enrol) → {applied:false, pendingId}; the outcome carries no hash/credential material', async () => {
      const pendingBody = {
        id: '01J',
        kind: 'role-grant-senior',
        before: null,
        after: { mustChangePassword: true },
        targetKey: 'ACCOUNT#zed',
        proposedBy: 'putra',
        proposedAt: '2026-07-11T00:00:00Z',
        status: 'PENDING',
        expiresAt: '2026-07-14T00:00:00Z',
      };
      const { fetch } = fakeFetch(() => ({ status: 202, body: pendingBody }));
      const client = createHttpApiClient('', { fetch });
      const out = await client.createAdminAccount({
        username: 'zed',
        displayName: 'Zed',
        role: 'lead',
        teamId: 'platform',
        password: 'satu-dua-tiga-empat',
      });
      expect(out).toEqual({ applied: false, pendingId: '01J' });
      expect(JSON.stringify(out)).not.toContain('argon2id');
    });

    it('createAdminAccount: a duplicate username (409 DUPLICATE_USERNAME) rejects with the server reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 409,
        body: { code: 'DUPLICATE_USERNAME', reason: 'That username is already taken.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(
        client.createAdminAccount({
          username: 'nia',
          displayName: 'Nia',
          role: 'requester',
          teamId: 'erp-basis',
          password: 'satu-dua-tiga-empat',
        }),
      ).rejects.toThrow('That username is already taken.');
    });

    it('setAccountRole PATCHes /admin/accounts/:id with the per-account setRole verb (active account); 200 (tightening) → {applied:true}', async () => {
      // The server no longer accepts a bare {role}: PATCH is per-account VERBS.
      // The single-account back-compat method aims setRole at the ACTIVE account
      // (default 'sample') — the same scope the x-ccp-project header carries.
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAccountRole('sari', 'lead')).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({
        url: '/admin/accounts/sari',
        method: 'PATCH',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.headers['x-ccp-project']).toBe('sample');
      expect(calls[0]!.body).toEqual({ setRole: { projectId: 'sample', role: 'lead' } });
    });

    it('setAccountRole: 202 (dual-controlled promotion) → {applied:false, pendingId}', async () => {
      const { fetch } = fakeFetch(() => ({ status: 202, body: { id: '01K', status: 'PENDING' } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAccountRole('sari', 'lead')).toEqual({
        applied: false,
        pendingId: '01K',
      });
    });

    it('setAccountTeam PATCHes /admin/accounts/:id with the per-account setTeam verb (active account)', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAccountTeam('sari', 'platform')).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({ url: '/admin/accounts/sari', method: 'PATCH' });
      expect(calls[0]!.body).toEqual({ setTeam: { projectId: 'sample', teamId: 'platform' } });
    });

    /* ── the per-account role + scope verbs (multi-account assignment) ───────── */

    it('setAccountRoleOn PATCHes a setRole verb targeting the CHOSEN account, with team, carrying x-ccp-project', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAccountRoleOn('sari', 'acme', 'approver', 'erp-basis')).toEqual({
        applied: true,
      });
      expect(calls[0]).toMatchObject({ url: '/admin/accounts/sari', method: 'PATCH' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.headers['x-ccp-project']).toBe('sample');
      expect(calls[0]!.body).toEqual({
        setRole: { projectId: 'acme', role: 'approver', teamId: 'erp-basis' },
      });
    });

    it('setAccountRoleOn omits teamId when none is given', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      await client.setAccountRoleOn('sari', 'acme', 'requester');
      expect(calls[0]!.body).toEqual({ setRole: { projectId: 'acme', role: 'requester' } });
    });

    it('setAccountRoleOn: a senior grant that returns 202 → {applied:false, pendingId} (dual-control)', async () => {
      const { fetch } = fakeFetch(() => ({ status: 202, body: { id: '01Q', status: 'PENDING' } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAccountRoleOn('sari', 'acme', 'lead')).toEqual({
        applied: false,
        pendingId: '01Q',
      });
    });

    it('setAccountTeamOn PATCHes a setTeam verb targeting the chosen account', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      await client.setAccountTeamOn('sari', 'acme', 'platform');
      expect(calls[0]!.body).toEqual({ setTeam: { projectId: 'acme', teamId: 'platform' } });
    });

    it('revokeAccountRoleOn PATCHes a revoke verb targeting the chosen account', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      await client.revokeAccountRoleOn('sari', 'acme');
      expect(calls[0]!.body).toEqual({ revoke: { projectId: 'acme' } });
    });

    it('setAccountStatus PATCHes /admin/accounts/:id with {status}', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAccountStatus('budi', 'disabled')).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({ url: '/admin/accounts/budi', method: 'PATCH' });
      expect(calls[0]!.body).toEqual({ status: 'disabled' });
    });

    it('resetAccountPassword POSTs {newPassword}; 200 (tightening) → {applied:true}, and the response is never the hash', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      const out = await client.resetAccountPassword('sari', 'baru-sekali-delapan');
      expect(out).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({
        url: '/admin/accounts/sari/reset-password',
        method: 'POST',
      });
      expect(calls[0]!.body).toEqual({ newPassword: 'baru-sekali-delapan' });
    });

    it('resetAccountPassword: 202 (dual-controlled — senior target) → {applied:false, pendingId}, no hash anywhere in the outcome', async () => {
      const { fetch } = fakeFetch(() => ({ status: 202, body: { id: '01M', status: 'PENDING' } }));
      const client = createHttpApiClient('', { fetch });
      const out = await client.resetAccountPassword('budi', 'baru-sekali-delapan');
      expect(out).toEqual({ applied: false, pendingId: '01M' });
      expect(JSON.stringify(out)).not.toContain('argon2id');
      expect(JSON.stringify(out).toLowerCase()).not.toContain('hash');
    });

    it('a non-admin caller (403 NOT_ADMIN) rejects every accounts-CRUD method with the server reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 403,
        body: { code: 'NOT_ADMIN', reason: 'Admin capability is required for that.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.listAdminAccounts()).rejects.toThrow(
        'Admin capability is required for that.',
      );
      await expect(client.setAccountRole('sari', 'lead')).rejects.toThrow(
        'Admin capability is required for that.',
      );
      await expect(client.resetAccountPassword('sari', 'baru-sekali-delapan')).rejects.toThrow(
        'Admin capability is required for that.',
      );
    });

    it('account ids are URL-encoded in every accounts-CRUD path', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      await client.setAccountStatus('a/b', 'disabled');
      expect(calls[0]!.url).toBe('/admin/accounts/a%2Fb');
      await client.resetAccountPassword('a/b', 'baru-sekali-delapan');
      expect(calls[1]!.url).toBe('/admin/accounts/a%2Fb/reset-password');
    });

    it('renameAccount PATCHes /admin/accounts/:id with ONLY {displayName} — never bundled with a verb', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.renameAccount('sari', 'Sari Wijaya')).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({ url: '/admin/accounts/sari', method: 'PATCH' });
      expect(calls[0]!.body).toEqual({ displayName: 'Sari Wijaya' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('deleteAccount DELETEs /admin/accounts/:id (CSRF header on) and returns the sessions-revoked result', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { ok: true, deleted: true, sessionsRevoked: 2 },
      }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.deleteAccount('dewi')).toEqual({
        ok: true,
        deleted: true,
        sessionsRevoked: 2,
      });
      expect(calls[0]).toMatchObject({ url: '/admin/accounts/dewi', method: 'DELETE' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.credentials).toBe('include');
    });

    it('deleteAccount surfaces the fail-closed refusals as thrown reasons (SELF_DELETE / LAST_LEAD_GUARD)', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 422,
        body: { code: 'LAST_LEAD_GUARD', reason: 'That would remove the last active Lead/admin.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.deleteAccount('putra')).rejects.toThrow(
        'That would remove the last active Lead/admin.',
      );
    });
  });

  describe('approval policy — GET/PUT /admin/policy', () => {
    it('getAdminPolicy GETs /admin/policy and returns the policy + version', async () => {
      const policy = { low: 1, medium: 1, high: 2, deleteMin: 2, version: 3 };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: policy }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.getAdminPolicy()).toEqual(policy);
      expect(calls[0]).toMatchObject({
        url: '/admin/policy',
        method: 'GET',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
    });

    it('putAdminPolicy PUTs the four tiers verbatim; 200 (tightening) → {applied:true}', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { low: 1, medium: 2, high: 2, deleteMin: 2, version: 4 },
      }));
      const client = createHttpApiClient('', { fetch });
      const next = { low: 1, medium: 2, high: 2, deleteMin: 2 };
      expect(await client.putAdminPolicy(next)).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({
        url: '/admin/policy',
        method: 'PUT',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.body).toEqual(next);
    });

    it('putAdminPolicy: 202 (dual-controlled downgrade) → {applied:false, pendingId}', async () => {
      const { fetch } = fakeFetch(() => ({ status: 202, body: { id: '01P', status: 'PENDING' } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.putAdminPolicy({ low: 1, medium: 1, high: 1, deleteMin: 1 })).toEqual({
        applied: false,
        pendingId: '01P',
      });
    });

    it('putAdminPolicy: out-of-range values (422 POLICY_OUT_OF_RANGE) reject with the server reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 422,
        body: { code: 'POLICY_OUT_OF_RANGE', reason: 'Policy values must be between 1 and 5.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(
        client.putAdminPolicy({ low: 0, medium: 1, high: 2, deleteMin: 2 }),
      ).rejects.toThrow('Policy values must be between 1 and 5.');
    });
  });

  describe('settings — GET /admin/settings, PUT /admin/settings/:key', () => {
    it('getAdminSettings GETs /admin/settings and returns the four-key map verbatim', async () => {
      const wire = {
        'freeze.global': true,
        'catalog.disabled-ops': ['ebs-grow'],
        'rate.limits': { submissionsPerHour: 50, maxOpen: 20 },
        'allowlist.restrictions': ['op::param::a'],
      };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: wire }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.getAdminSettings()).toEqual(wire);
      expect(calls[0]).toMatchObject({
        url: '/admin/settings',
        method: 'GET',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
    });

    it('putAdminSetting PUTs {value} to /admin/settings/:key; 200 (e.g. freeze ON) → {applied:true}', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { ok: true, key: 'freeze.global', value: true },
      }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.putAdminSetting('freeze.global', true)).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({ url: '/admin/settings/freeze.global', method: 'PUT' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.body).toEqual({ value: true });
    });

    it('putAdminSetting: 202 (e.g. lifting a freeze) → {applied:false, pendingId} — never a claimed success', async () => {
      const { fetch } = fakeFetch(() => ({ status: 202, body: { id: '01S', status: 'PENDING' } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.putAdminSetting('freeze.global', false)).toEqual({
        applied: false,
        pendingId: '01S',
      });
    });

    it('setting keys are URL-encoded in the path', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      await client.putAdminSetting('rate.limits', { submissionsPerHour: 60, maxOpen: 20 });
      expect(calls[0]!.url).toBe('/admin/settings/rate.limits');
      await client.putAdminSetting('a key/with#odd', 1);
      expect(calls[1]!.url).toBe('/admin/settings/a%20key%2Fwith%23odd');
    });
  });

  describe('risk overrides — GET /admin/risk, PUT/DELETE /admin/risk/:opId', () => {
    it('listAdminRiskOverrides GETs /admin/risk and returns the {opId: risk} map', async () => {
      const map = { 'ebs-grow': 'HIGH' as const };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: map }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.listAdminRiskOverrides()).toEqual(map);
      expect(calls[0]).toMatchObject({ url: '/admin/risk', method: 'GET', credentials: 'include' });
      expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
    });

    it('setAdminRiskOverride PUTs {risk}; 200 (raise = tightening) → {applied:true}', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { ok: true, opId: 'ebs-grow', risk: 'HIGH' },
      }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAdminRiskOverride('ebs-grow', 'HIGH')).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({ url: '/admin/risk/ebs-grow', method: 'PUT' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.body).toEqual({ risk: 'HIGH' });
    });

    it('setAdminRiskOverride: 202 (reduction) → {applied:false, pendingId}', async () => {
      const { fetch } = fakeFetch(() => ({ status: 202, body: { id: '01R', status: 'PENDING' } }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAdminRiskOverride('ebs-grow', 'LOW')).toEqual({
        applied: false,
        pendingId: '01R',
      });
    });

    it('clearAdminRiskOverride DELETEs /admin/risk/:opId; 200 or 202 both surface honestly', async () => {
      const { fetch, calls } = fakeFetch((call) =>
        call.url.endsWith('tightening-clear')
          ? { status: 200, body: { ok: true } }
          : { status: 202, body: { id: '01C', status: 'PENDING' } },
      );
      const client = createHttpApiClient('', { fetch });
      expect(await client.clearAdminRiskOverride('tightening-clear')).toEqual({ applied: true });
      expect(await client.clearAdminRiskOverride('loosening-clear')).toEqual({
        applied: false,
        pendingId: '01C',
      });
      expect(calls[0]).toMatchObject({ method: 'DELETE' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('an unknown operation (422 VALIDATION_FAILED) rejects with the server reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 422,
        body: { code: 'VALIDATION_FAILED', reason: 'The request could not be validated.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.setAdminRiskOverride('no-such-op', 'HIGH')).rejects.toThrow(
        'The request could not be validated.',
      );
    });

    it('op ids are URL-encoded in every risk path', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      await client.setAdminRiskOverride('a/b', 'HIGH');
      expect(calls[0]!.url).toBe('/admin/risk/a%2Fb');
      await client.clearAdminRiskOverride('a/b');
      expect(calls[1]!.url).toBe('/admin/risk/a%2Fb');
    });
  });

  describe('catalog enable/disable — PUT /admin/catalog/:opId', () => {
    it('setAdminCatalogEnabled PUTs {enabled}; disable (tightening) → {applied:true}', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { ok: true, opId: 'ebs-grow', enabled: false },
      }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAdminCatalogEnabled('ebs-grow', false)).toEqual({ applied: true });
      expect(calls[0]).toMatchObject({ url: '/admin/catalog/ebs-grow', method: 'PUT' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
      expect(calls[0]!.body).toEqual({ enabled: false });
    });

    it('setAdminCatalogEnabled: re-enable (loosening) → 202 {applied:false, pendingId}', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 202,
        body: { id: '01E', status: 'PENDING' },
      }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.setAdminCatalogEnabled('ebs-grow', true)).toEqual({
        applied: false,
        pendingId: '01E',
      });
      expect(calls[0]!.body).toEqual({ enabled: true });
    });

    it('op ids are URL-encoded', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const client = createHttpApiClient('', { fetch });
      await client.setAdminCatalogEnabled('a/b', false);
      expect(calls[0]!.url).toBe('/admin/catalog/a%2Fb');
    });
  });

  describe('dual-control queue — GET /admin/config-changes, POST :id/ack|reject', () => {
    const pending = {
      id: '01J',
      kind: 'policy-downgrade',
      before: { high: 2 },
      after: { high: 1 },
      targetKey: 'POLICY',
      proposedBy: 'putra',
      proposedAt: '2026-07-11T00:00:00Z',
      status: 'PENDING' as const,
      expiresAt: '2026-07-14T00:00:00Z',
    };

    it('listAdminConfigChanges GETs /admin/config-changes', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [pending] }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.listAdminConfigChanges()).toEqual([pending]);
      expect(calls[0]).toMatchObject({
        url: '/admin/config-changes',
        method: 'GET',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
    });

    it('ackAdminConfigChange POSTs .../ack and returns the APPLIED item', async () => {
      const applied = {
        ...pending,
        status: 'APPLIED' as const,
        ackBy: 'gita',
        ackAt: '2026-07-11T01:00:00Z',
      };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: applied }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.ackAdminConfigChange('01J')).toEqual(applied);
      expect(calls[0]).toMatchObject({ url: '/admin/config-changes/01J/ack', method: 'POST' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('acking your own proposal (403 SELF_ACK) rejects with the server reason — surfaced to the UI verbatim', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 403,
        body: { code: 'SELF_ACK', reason: 'You cannot acknowledge your own proposal.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.ackAdminConfigChange('01J')).rejects.toThrow(
        'You cannot acknowledge your own proposal.',
      );
    });

    it('a drifted target (409 STALE_PROPOSAL) rejects with the server reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 409,
        body: {
          code: 'STALE_PROPOSAL',
          reason: 'The target changed since this proposal was made.',
        },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.ackAdminConfigChange('01J')).rejects.toThrow(
        'The target changed since this proposal was made.',
      );
    });

    it('rejectAdminConfigChange POSTs .../reject and returns the REJECTED item', async () => {
      const rejected = {
        ...pending,
        status: 'REJECTED' as const,
        ackBy: 'putra',
        ackAt: '2026-07-11T01:00:00Z',
      };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: rejected }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.rejectAdminConfigChange('01J')).toEqual(rejected);
      expect(calls[0]).toMatchObject({ url: '/admin/config-changes/01J/reject', method: 'POST' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('change ids are URL-encoded in the decision paths', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: pending }));
      const client = createHttpApiClient('', { fetch });
      await client.ackAdminConfigChange('a/b');
      expect(calls[0]!.url).toBe('/admin/config-changes/a%2Fb/ack');
      await client.rejectAdminConfigChange('a/b');
      expect(calls[1]!.url).toBe('/admin/config-changes/a%2Fb/reject');
    });
  });

  describe('account security — POST /admin/accounts/:id/reset-totp, /revoke-sessions', () => {
    it('resetAccountTotp POSTs and returns {ok, totpReset, sessionsRevoked}', async () => {
      const result = { ok: true as const, totpReset: true as const, sessionsRevoked: 2 };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: result }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.resetAccountTotp('dewi')).toEqual(result);
      expect(calls[0]).toMatchObject({
        url: '/admin/accounts/dewi/reset-totp',
        method: 'POST',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('revokeAccountSessions POSTs and returns {ok, sessionsRevoked}', async () => {
      const result = { ok: true as const, sessionsRevoked: 1 };
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: result }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.revokeAccountSessions('dewi')).toEqual(result);
      expect(calls[0]).toMatchObject({
        url: '/admin/accounts/dewi/revoke-sessions',
        method: 'POST',
        credentials: 'include',
      });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('an unknown account (404 NOT_FOUND) rejects with the server reason', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 404,
        body: { code: 'NOT_FOUND', reason: 'No such account.' },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(client.resetAccountTotp('ghost')).rejects.toThrow('No such account.');
      await expect(client.revokeAccountSessions('ghost')).rejects.toThrow('No such account.');
    });

    it('account ids are URL-encoded', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { ok: true, sessionsRevoked: 0 },
      }));
      const client = createHttpApiClient('', { fetch });
      await client.revokeAccountSessions('a/b');
      expect(calls[0]!.url).toBe('/admin/accounts/a%2Fb/revoke-sessions');
    });
  });

  describe('projects registry + trust surface — /projects (W5/N2)', () => {
    const project = {
      id: 'acme',
      name: 'Acme estate',
      github: { owner: 'acme-co', repo: 'terraform-acme' },
      accountId: '123456789012',
      region: 'ap-southeast-1',
      status: 'draft' as const,
      createdBy: 'putra',
      createdAt: '2026-07-15T00:00:00Z',
    };

    it('listServerProjects GETs /projects (CSRF-exempt like every GET)', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [project] }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.listServerProjects()).toEqual([project]);
      expect(calls[0]).toMatchObject({ url: '/projects', method: 'GET', credentials: 'include' });
      expect(calls[0]!.headers['x-ccp-client']).toBeUndefined();
    });

    it('registerProject POSTs the draft with the CSRF header and returns the created project', async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 201, body: project }));
      const client = createHttpApiClient('', { fetch });
      const input = {
        id: 'acme',
        name: 'Acme estate',
        github: { owner: 'acme-co', repo: 'terraform-acme' },
        accountId: '123456789012',
        region: 'ap-southeast-1',
      };
      expect(await client.registerProject(input)).toEqual(project);
      expect(calls[0]).toMatchObject({ url: '/projects', method: 'POST', body: input });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('uploadProjectTrustRequest PUTs the artifact pair with the report text VERBATIM (never re-serialized)', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 200,
        body: { ...project, status: 'pending-trust' },
      }));
      const client = createHttpApiClient('', { fetch });
      const rawReport = '{\n  "repo": "terraform-acme",\n  "verdict": "clean"\n}\n'; // exact bytes matter — the server hashes them
      await client.uploadProjectTrustRequest('acme', {
        trustRequest: {
          repo: 'terraform-acme',
          commitSha: 'abc123def456',
          prescanSha256: 'f'.repeat(64),
        },
        prescanReport: rawReport,
      });
      expect(calls[0]).toMatchObject({ url: '/projects/acme/trust-request', method: 'PUT' });
      expect((calls[0]!.body as { prescanReport: string }).prescanReport).toBe(rawReport);
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('proposeProjectTrust surfaces the ALWAYS-202 dual-control outcome as {applied:false, pendingId}', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 202,
        body: { id: 'pend-1', kind: 'project-trust' },
      }));
      const client = createHttpApiClient('', { fetch });
      const outcome = await client.proposeProjectTrust('acme', {
        commitSha: 'abc123def456',
        prescanSha256: 'f'.repeat(64),
      });
      expect(outcome).toEqual({ applied: false, pendingId: 'pend-1' });
      expect(calls[0]).toMatchObject({ url: '/projects/acme/trust', method: 'POST' });
    });

    it('the fail-closed refusals surface the server reason (TRUST_VERDICT_NOT_CLEAN, PRESCAN_SHA_MISMATCH)', async () => {
      const { fetch } = fakeFetch(() => ({
        status: 422,
        body: {
          code: 'TRUST_VERDICT_NOT_CLEAN',
          reason: 'The prescan verdict is not clean — a rejected repo can never be trusted.',
        },
      }));
      const client = createHttpApiClient('', { fetch });
      await expect(
        client.proposeProjectTrust('acme', {
          commitSha: 'x'.repeat(12),
          prescanSha256: 'f'.repeat(64),
        }),
      ).rejects.toThrow('never be trusted');
    });

    it('deregisterProject DELETEs and reports the pending two-admin envelope', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 202,
        body: { id: 'pend-2', kind: 'project-deregister' },
      }));
      const client = createHttpApiClient('', { fetch });
      expect(await client.deregisterProject('acme')).toEqual({
        applied: false,
        pendingId: 'pend-2',
      });
      expect(calls[0]).toMatchObject({ url: '/projects/acme', method: 'DELETE' });
      expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    });

    it('project ids are URL-encoded', async () => {
      const { fetch, calls } = fakeFetch(() => ({
        status: 202,
        body: { id: 'pend-9', kind: 'project-deregister' },
      }));
      const client = createHttpApiClient('', { fetch });
      await client.deregisterProject('a/b');
      expect(calls[0]!.url).toBe('/projects/a%2Fb');
    });
  });
});
