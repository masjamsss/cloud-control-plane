import { afterEach, describe, expect, it } from 'vitest';
import type { AuthAccount } from '@/lib/httpApi';
import type { ProjectConfig } from '@/types/project';
import {
  apiSessionScopes,
  authAccountToAccount,
  clearApiSession,
  getApiSessionAccount,
  setApiSessionAccount,
} from '@/lib/apiSession';
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
