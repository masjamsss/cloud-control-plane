import { beforeEach, describe, expect, it } from 'vitest';
import {
  TeamError,
  createTeam,
  deleteTeam,
  getTeams,
  memberCount,
  ownerOf,
  renameTeam,
  resetTeamsForTests,
  setTeamServices,
  subscribeTeamsChanged,
  toggleService,
} from '@/lib/teams';
import { enroll, resetStoreForTests as resetAccounts } from '@/lib/accounts';

beforeEach(() => {
  resetTeamsForTests();
  resetAccounts();
});

describe('seed + create', () => {
  it('seeds the four default teams', () => {
    expect(
      getTeams()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['azure-platform', 'erp-basis', 'network-sec', 'platform']);
  });
  it('creates a team with a slugged id and rejects duplicate names', () => {
    const t = createTeam('Data Platform');
    expect(t.id).toBe('data-platform');
    expect(() => createTeam('data platform')).toThrow(TeamError);
  });
});

describe('rename', () => {
  it('renames and blocks a name collision', () => {
    createTeam('Data');
    renameTeam('data', 'Analytics');
    expect(getTeams().find((t) => t.id === 'data')?.name).toBe('Analytics');
    expect(() => renameTeam('data', 'Platform')).toThrow(TeamError);
  });
});

describe('single-ownership of services', () => {
  it('moves a service to the assigning team, removing it from its old owner', () => {
    // ec2 seeds under erp-basis
    expect(ownerOf('ec2')?.id).toBe('erp-basis');
    setTeamServices('platform', ['ec2']);
    expect(ownerOf('ec2')?.id).toBe('platform');
    expect(getTeams().find((t) => t.id === 'erp-basis')?.serviceSlugs).not.toContain('ec2');
  });
  it('toggleService adds then removes', () => {
    toggleService('platform', 's3'); // s3 already platform's — this removes it
    expect(ownerOf('s3')).toBeUndefined();
    toggleService('platform', 's3');
    expect(ownerOf('s3')?.id).toBe('platform');
  });
});

describe('delete guards', () => {
  it('deletes an empty, memberless team', () => {
    const t = createTeam('Temp');
    deleteTeam(t.id);
    expect(getTeams().find((x) => x.id === t.id)).toBeUndefined();
  });
  it('refuses to delete a team that still owns services', () => {
    expect(() => deleteTeam('erp-basis')).toThrow(TeamError);
  });
  it('refuses to delete a team that has members', async () => {
    const t = createTeam('Ops');
    await enroll(
      {
        username: 'budi',
        displayName: 'Budi',
        role: 'requester',
        teamId: t.id,
        password: 'password1',
      },
      'system',
    );
    expect(memberCount(t.id)).toBe(1);
    expect(() => deleteTeam(t.id)).toThrow(TeamError);
  });
});

describe('getTeams() — cached snapshot referential stability (0025 RX-4)', () => {
  it('returns the SAME array reference across repeated calls when nothing wrote in between', () => {
    const a = getTeams();
    const b = getTeams();
    expect(a).toBe(b);
  });

  it('returns a NEW reference after a write, but the SAME reference again afterward', () => {
    const before = getTeams();
    createTeam('Data');
    const afterWrite1 = getTeams();
    const afterWrite2 = getTeams();
    expect(afterWrite1).not.toBe(before);
    expect(afterWrite1).toBe(afterWrite2);
  });

  it('stays correctly sorted by name across cache hits and misses alike', () => {
    createTeam('Zeta');
    createTeam('Alpha');
    const names = getTeams().map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('subscribeTeamsChanged — the useTeams() external-store source (0025 RX-4)', () => {
  it('fires on create/rename/delete/toggle — every write', () => {
    let calls = 0;
    const unsubscribe = subscribeTeamsChanged(() => (calls += 1));
    const t = createTeam('Temp');
    expect(calls).toBe(1);
    renameTeam(t.id, 'Temporary');
    expect(calls).toBe(2);
    toggleService(t.id, 'ec2'); // moves ec2 onto this team
    expect(calls).toBe(3);
    toggleService(t.id, 'ec2'); // and back off, so delete below is unblocked
    expect(calls).toBe(4);
    deleteTeam(t.id);
    expect(calls).toBe(5);
    unsubscribe();
  });

  it('unsubscribing stops further notifications', () => {
    let calls = 0;
    const unsubscribe = subscribeTeamsChanged(() => (calls += 1));
    unsubscribe();
    createTeam('Ghost');
    expect(calls).toBe(0);
  });
});
