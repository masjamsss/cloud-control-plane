import { afterEach, describe, expect, it } from 'vitest';
import type { AuthAccount } from '@/lib/httpApi';
import type { ProjectConfig } from '@/types/project';
import type { Team } from '@/types';
import {
  apiSessionScopes,
  authAccountToAccount,
  clearApiSession,
  getApiSessionAccount,
  setApiSessionAccount,
} from '@/lib/apiSession';
import { canApprove, canRequest } from '@/lib/permissions';
import { shellNavItems } from '@/components/ShellNav';
import { setProjectScopeForTests } from '@/lib/projectScope';
import { visibleProjects } from '@/features/projects/ProjectSwitcher';

/**
 * The client half of multi-account authorization: identity is GLOBAL (one server
 * session), but the role/team the app enforces is resolved for whichever ACCOUNT
 * (project) the app is currently scoped to. These prove the two pure seams that
 * make that real — the api-session bridge re-resolving per active account, and
 * the switcher filtering to the accounts the user actually holds a role on —
 * without a DOM (this repo renders to strings; there is no jsdom).
 */

function authAccount(over: Partial<AuthAccount> = {}): AuthAccount {
  return {
    id: 'dewi',
    username: 'dewi',
    displayName: 'Dewi',
    role: 'requester',
    teamId: 'platform',
    status: 'active',
    isAdmin: false,
    mustChangePassword: false,
    totpEnrolled: false,
    ...over,
  };
}

function project(id: string, name = id): ProjectConfig {
  return { id, name, github: { owner: 'o', repo: 'r' }, region: 'ap-southeast-1' } as ProjectConfig;
}

afterEach(() => {
  clearApiSession();
  setProjectScopeForTests('sample');
});

describe('api-session bridge — role/team resolved for the ACTIVE account', () => {
  it('a user with a role on TWO accounts resolves the RIGHT one as the active scope changes', () => {
    setApiSessionAccount(
      authAccount({
        role: 'lead', // the server-resolved scalar for whatever header it saw
        teamId: 'platform',
        roles: {
          sample: { role: 'lead', teamId: 'platform' },
          acme: { role: 'requester', teamId: 'erp-basis' },
        },
      }),
    );

    setProjectScopeForTests('sample');
    expect(getApiSessionAccount()).toMatchObject({ role: 'lead', teamId: 'platform' });

    // Switching accounts re-resolves WITHOUT re-hitting the server.
    setProjectScopeForTests('acme');
    expect(getApiSessionAccount()).toMatchObject({ role: 'requester', teamId: 'erp-basis' });
  });

  it('the `*` wildcard binding covers every account (lead everywhere)', () => {
    const wildcard = authAccount({ roles: { '*': { role: 'lead', teamId: 'platform' } } });
    // Resolved against ANY account id, the wildcard yields the same lead binding.
    expect(authAccountToAccount(wildcard, 'anything')).toMatchObject({ role: 'lead', teamId: 'platform' });
    expect(authAccountToAccount(wildcard, 'sample')).toMatchObject({ role: 'lead' });
  });

  it('a legacy/single-account projection with no roles map falls back to the resolved scalar', () => {
    const account = authAccountToAccount(authAccount({ role: 'approver', teamId: 'erp-basis' }), 'sample');
    expect(account).toMatchObject({ role: 'approver', teamId: 'erp-basis' });
  });

  /**
   * FE-9 — the fail-open. `role: (binding?.role ?? a.role)` fired whenever the
   * binding was missing, INCLUDING when the roles map existed and simply had no
   * entry for the active project. Switching to a project you hold no role on
   * therefore rendered you with the role the LOGIN scope resolved.
   *
   * Written as the rule ("a map with no entry yields the no-role floor"), not as
   * the one reported case, and asserted through the permission helpers the app
   * actually gates on — a test that only compared the `role` string would still
   * pass if a later change made `requester` approve things.
   */
  describe('FE-9 — no binding on the active project fails CLOSED', () => {
    const lead = authAccount({
      role: 'lead', // what the server resolved for the scope the login request used
      teamId: 'platform',
      roles: { sample: { role: 'lead', teamId: 'platform' } },
    });

    it('does not inherit the login scope’s role on a project with no binding', () => {
      // Precondition (L-1): the scalar fallback the bug used really is 'lead',
      // so a passing assertion below cannot be "there was nothing to inherit".
      expect(lead.role).toBe('lead');
      expect(lead.roles?.acme).toBeUndefined();

      const onSample = authAccountToAccount(lead, 'sample');
      expect(onSample).toMatchObject({ role: 'lead', teamId: 'platform' });

      const onAcme = authAccountToAccount(lead, 'acme');
      expect(onAcme.role).not.toBe('lead');
      expect(onAcme).toMatchObject({ role: 'requester', teamId: '' });
    });

    it('the affordances that key off the resolved role all close', () => {
      const onAcme = authAccountToAccount(lead, 'acme');
      const user = { id: onAcme.id, name: onAcme.displayName, role: onAcme.role, teamId: onAcme.teamId };
      const teams: Team[] = [{ id: 'platform', name: 'Platform', serviceSlugs: ['orders'] }];

      // Approvals: the queue/detail gate and the nav item.
      expect(canApprove(user, { requester: 'someone-else', approvals: [] } as never)).toBe(false);
      expect(shellNavItems({ role: onAcme.role }).map((n) => n.to)).not.toContain('/approvals');
      // Requesting: no team → owns no services → cannot request.
      expect(canRequest(user, 'orders', teams)).toBe(false);
      // Manage tier / drift operator controls (role === 'lead').
      expect(onAcme.role === 'lead').toBe(false);

      // …and the SAME account on the project it IS bound to keeps every one of
      // them, so the test is proving a scope boundary rather than a blanket deny.
      const onSample = authAccountToAccount(lead, 'sample');
      const boundUser = { id: onSample.id, name: onSample.displayName, role: onSample.role, teamId: onSample.teamId };
      expect(canApprove(boundUser, { requester: 'someone-else', approvals: [] } as never)).toBe(true);
      expect(shellNavItems({ role: onSample.role }).map((n) => n.to)).toContain('/approvals');
      expect(canRequest(boundUser, 'orders', teams)).toBe(true);
    });

    it('a binding with no teamId does not borrow the login scope’s team either', () => {
      const teamless = authAccount({
        role: 'lead',
        teamId: 'platform',
        roles: { acme: { role: 'approver' } }, // role but no team on acme
      });
      expect(authAccountToAccount(teamless, 'acme')).toMatchObject({ role: 'approver', teamId: '' });
    });

    it('an absent roles map still uses the server-resolved scalar (legacy backend)', () => {
      // The fallback is not deleted — it is narrowed to the case it was written
      // for. A backend that serves no map has no other source of truth.
      const legacy = authAccount({ role: 'approver', teamId: 'erp-basis' });
      expect(legacy.roles).toBeUndefined();
      expect(authAccountToAccount(legacy, 'anything')).toMatchObject({ role: 'approver', teamId: 'erp-basis' });
    });

    it('getApiSessionAccount reflects it after a project switch (no server round-trip)', () => {
      setApiSessionAccount(lead);
      setProjectScopeForTests('sample');
      expect(getApiSessionAccount()?.role).toBe('lead');
      setProjectScopeForTests('acme');
      expect(getApiSessionAccount()?.role).toBe('requester');
    });
  });

  it('apiSessionScopes lists the accounts the user holds a role on (empty when signed out)', () => {
    expect(apiSessionScopes()).toEqual([]);
    setApiSessionAccount(authAccount({ roles: { sample: { role: 'lead' }, acme: { role: 'requester' } } }));
    expect(apiSessionScopes().sort()).toEqual(['acme', 'sample']);
  });
});

describe('visibleProjects — the switcher only lists accounts you have a role on', () => {
  const all = [project('sample', 'Sample'), project('acme', 'Acme'), project('beta', 'Beta')];

  it('filters to the scoped accounts, always keeping the active one', () => {
    expect(visibleProjects(all, ['sample', 'acme'], 'sample').map((p) => p.id)).toEqual(['sample', 'acme']);
  });

  it('a `*` scope (all accounts) shows every registered account', () => {
    expect(visibleProjects(all, ['*'], 'sample')).toEqual(all);
  });

  it('an empty scope set (mock/legacy — no per-account map) shows everything, unchanged', () => {
    expect(visibleProjects(all, [], 'sample')).toEqual(all);
  });

  it('the active account is retained even if it is not in the scope set (deep-linked)', () => {
    expect(visibleProjects(all, ['acme'], 'beta').map((p) => p.id).sort()).toEqual(['acme', 'beta']);
  });
});
