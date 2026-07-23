import { beforeEach, describe, expect, it } from 'vitest';
import type { Team } from '@/types';
import type { AdminTeam, HttpApiClient } from '@/lib/httpApi';
import {
  createTeamVia,
  deleteTeamVia,
  loadTeams,
  renameTeamVia,
  setTeamServicesVia,
  toggleServiceVia,
} from '@/features/admin/teamsFlow';
import { TeamError, createTeam, getTeams, resetTeamsForTests } from '@/lib/teams';
import { resetStoreForTests as resetAccounts } from '@/lib/accounts';

/**
 * Proves the 0015 §B3 / 0014 P1 #4 fix: TeamsAdmin.tsx used to write every
 * team edit to lib/teams's localStorage regardless of `can('teams')` — so
 * once Lane B flipped that flag true in api mode, the control rendered
 * enabled (no advisory note) while still never reaching ccp-api. This
 * file is the honesty proof for the fix: `authoritative=true` routes every
 * read/write through the httpApi admin methods (asserted via a fake client,
 * mirroring authFlow.test.ts's approach — this repo has no jsdom, so a
 * component can't be "clicked"; the branching itself is what's under test);
 * `authoritative=false` is byte-for-byte the pre-existing lib/teams behavior.
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
    resetAccountTotp: notUsed,
    revokeAccountSessions: notUsed,
    ...over,
  } as unknown as HttpApiClient;
}

/** A hand-rolled spy (this repo doesn't use vitest's vi.fn — see
 * authFlow.test.ts's identical helper). Records every call's arguments. */
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

beforeEach(() => {
  resetTeamsForTests();
  resetAccounts();
});

describe('loadTeams', () => {
  it('authoritative + client: lists from ccp-api, sorted by name — not lib/teams', async () => {
    const served: AdminTeam[] = [
      { id: 'b', name: 'Bravo', serviceSlugs: ['s3'] },
      { id: 'a', name: 'Alpha', serviceSlugs: [] },
    ];
    const listAdminTeams = spy(async () => served);
    const result = await loadTeams(true, fakeClient({ listAdminTeams }));
    expect(listAdminTeams.calls).toEqual([[]]);
    expect(result.map((t) => t.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('not authoritative: falls back to lib/teams — the server is never called', async () => {
    const listAdminTeams = spy(NEVER_CALLED);
    const result = await loadTeams(false, fakeClient({ listAdminTeams }));
    expect(listAdminTeams.calls).toEqual([]);
    expect(result).toEqual(getTeams());
  });

  it('authoritative but no client (defensive): still falls back to lib/teams', async () => {
    expect(await loadTeams(true, null)).toEqual(getTeams());
  });
});

describe('createTeamVia', () => {
  it('authoritative: calls client.createAdminTeam with the trimmed name and returns its record', async () => {
    const created: AdminTeam = { id: 'platform-2', name: 'Platform 2', serviceSlugs: [] };
    const createAdminTeam = spy(async () => created);
    const t = await createTeamVia(true, fakeClient({ createAdminTeam }), '  Platform 2  ');
    expect(createAdminTeam.calls).toEqual([['Platform 2']]);
    expect(t).toEqual(created);
  });

  it('authoritative: a too-short name is rejected locally — the server is never called', async () => {
    const createAdminTeam = spy(NEVER_CALLED);
    await expect(createTeamVia(true, fakeClient({ createAdminTeam }), 'a')).rejects.toBeInstanceOf(
      TeamError,
    );
    expect(createAdminTeam.calls).toEqual([]);
  });

  it('not authoritative: writes to lib/teams — the server is never called', async () => {
    const createAdminTeam = spy(NEVER_CALLED);
    const t = await createTeamVia(false, fakeClient({ createAdminTeam }), 'Local Only Co');
    expect(createAdminTeam.calls).toEqual([]);
    expect(t.name).toBe('Local Only Co');
    expect(getTeams().some((x) => x.id === t.id)).toBe(true);
  });
});

describe('renameTeamVia', () => {
  it('authoritative: calls client.renameAdminTeam(id, trimmedName)', async () => {
    const renameAdminTeam = spy(async () => ({
      id: 'platform',
      name: 'Core Platform',
      serviceSlugs: [],
    }));
    await renameTeamVia(true, fakeClient({ renameAdminTeam }), 'platform', '  Core Platform  ');
    expect(renameAdminTeam.calls).toEqual([['platform', 'Core Platform']]);
  });

  it('authoritative: a too-short name is rejected locally — the server is never called', async () => {
    const renameAdminTeam = spy(NEVER_CALLED);
    await expect(
      renameTeamVia(true, fakeClient({ renameAdminTeam }), 'platform', 'x'),
    ).rejects.toBeInstanceOf(TeamError);
    expect(renameAdminTeam.calls).toEqual([]);
  });

  it('not authoritative: renames via lib/teams — the server is never called', async () => {
    const renameAdminTeam = spy(NEVER_CALLED);
    const [team] = getTeams();
    await renameTeamVia(false, fakeClient({ renameAdminTeam }), team!.id, 'Renamed Co');
    expect(renameAdminTeam.calls).toEqual([]);
    expect(getTeams().some((t) => t.name === 'Renamed Co')).toBe(true);
  });
});

describe('setTeamServicesVia', () => {
  it('authoritative: calls client.setAdminTeamServices(id, slugs) verbatim', async () => {
    const setAdminTeamServices = spy(async () => ({
      id: 'platform',
      name: 'Platform',
      serviceSlugs: ['s3'],
    }));
    await setTeamServicesVia(true, fakeClient({ setAdminTeamServices }), 'platform', ['s3']);
    expect(setAdminTeamServices.calls).toEqual([['platform', ['s3']]]);
  });

  it('not authoritative: sets via lib/teams — the server is never called', async () => {
    const setAdminTeamServices = spy(NEVER_CALLED);
    const [team] = getTeams();
    await setTeamServicesVia(false, fakeClient({ setAdminTeamServices }), team!.id, ['ec2']);
    expect(setAdminTeamServices.calls).toEqual([]);
    expect(getTeams().find((t) => t.id === team!.id)?.serviceSlugs).toEqual(['ec2']);
  });
});

describe('toggleServiceVia — computes the next owned set from the ALREADY-LOADED team', () => {
  it('authoritative: adds the slug via setAdminTeamServices when not yet owned', async () => {
    const setAdminTeamServices = spy(async () => ({
      id: 't',
      name: 'T',
      serviceSlugs: ['s3', 'ec2'],
    }));
    const team: Team = { id: 't', name: 'T', serviceSlugs: ['s3'] };
    await toggleServiceVia(true, fakeClient({ setAdminTeamServices }), team, 'ec2');
    expect(setAdminTeamServices.calls).toEqual([['t', ['s3', 'ec2']]]);
  });

  it('authoritative: removes the slug via setAdminTeamServices when already owned', async () => {
    const setAdminTeamServices = spy(async () => ({ id: 't', name: 'T', serviceSlugs: [] }));
    const team: Team = { id: 't', name: 'T', serviceSlugs: ['s3'] };
    await toggleServiceVia(true, fakeClient({ setAdminTeamServices }), team, 's3');
    expect(setAdminTeamServices.calls).toEqual([['t', []]]);
  });

  it('not authoritative: toggles via lib/teams — the server is never called', async () => {
    const setAdminTeamServices = spy(NEVER_CALLED);
    const [team] = getTeams();
    await toggleServiceVia(false, fakeClient({ setAdminTeamServices }), team!, 'ec2');
    expect(setAdminTeamServices.calls).toEqual([]);
    expect(getTeams().find((t) => t.id === team!.id)?.serviceSlugs).toContain('ec2');
  });
});

describe('deleteTeamVia', () => {
  it('authoritative: calls client.deleteAdminTeam(id)', async () => {
    const deleteAdminTeam = spy(async () => undefined);
    await deleteTeamVia(true, fakeClient({ deleteAdminTeam }), 'platform');
    expect(deleteAdminTeam.calls).toEqual([['platform']]);
  });

  it('not authoritative: deletes via lib/teams — the server is never called', async () => {
    const deleteAdminTeam = spy(NEVER_CALLED);
    const created = createTeam('Temp Team'); // no services/members — deletable
    await deleteTeamVia(false, fakeClient({ deleteAdminTeam }), created.id);
    expect(deleteAdminTeam.calls).toEqual([]);
    expect(getTeams().some((t) => t.id === created.id)).toBe(false);
  });
});
