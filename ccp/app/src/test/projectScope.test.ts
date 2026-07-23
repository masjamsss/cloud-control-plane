import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentProjectId,
  hasActiveProject,
  SAMPLE_ESTATE_ID,
  setProjectScopeForTests,
} from '@/lib/projectScope';
import { getTeams, createTeam } from '@/lib/teams';
import { getSettings, setChangeFreeze } from '@/lib/settings';
import { recordAudit, listAudit } from '@/lib/audit';

// These are the REAL exported names, verified against source: teams writer is
// createTeam(name, serviceSlugs) (returns a Team with a generated id); audit reader
// is listAudit(); recordAudit(actor, action, summary). If a name ever differs, the
// source file wins — the behaviors below are the contract.

describe('per-project store namespacing (R3 §5.3)', () => {
  beforeEach(() => {
    localStorage.clear();
    setProjectScopeForTests('sample');
  });

  it('teams written under project a are invisible under project b', () => {
    setProjectScopeForTests('a');
    createTeam('Team A', ['s3']);
    expect(getTeams().some((t) => t.name === 'Team A')).toBe(true);
    setProjectScopeForTests('b');
    expect(getTeams().some((t) => t.name === 'Team A')).toBe(false);
  });

  it('settings are scoped too', () => {
    setProjectScopeForTests('a');
    setChangeFreeze(true);
    setProjectScopeForTests('b');
    expect(getSettings().changeFreeze).toBe(false);
  });

  it('audit entries carry projectId', () => {
    setProjectScopeForTests('a');
    recordAudit('u1', 'Test action', 'summary');
    expect(listAudit()[0]?.projectId).toBe('a');
  });

  it('a legacy un-namespaced key migrates to sample exactly once', () => {
    localStorage.setItem(
      'gerbang.teams.v1',
      JSON.stringify([{ id: 'legacy', name: 'Legacy', serviceSlugs: [] }]),
    );
    setProjectScopeForTests('sample');
    expect(getTeams().some((t) => t.name === 'Legacy')).toBe(true);
    expect(localStorage.getItem('gerbang.teams.v1')).toBeNull();
    expect(localStorage.getItem('ccp.sample.teams.v1')).not.toBeNull();
  });
});

/**
 * Data-birth lane B item 1: NO unconditional bundled default — the bare/unset
 * scope is the empty string, distinguishable from a real id via
 * `hasActiveProject()`. This is what makes a pre-estate call (login) send NO
 * `x-ccp-project` header (lib/httpApi.ts's `request()`), instead of the
 * hardcoded 'sample' every request used to carry.
 */
describe('hasActiveProject — the unscoped/scoped distinction (data-birth lane B)', () => {
  afterEach(() => setProjectScopeForTests('sample')); // leave every other test's assumed default intact

  it('the bare scope (nothing set) is unscoped', () => {
    setProjectScopeForTests('');
    expect(hasActiveProject()).toBe(false);
    expect(currentProjectId()).toBe('');
  });

  it('scoping to a real id — including the sample estate itself — is active', () => {
    setProjectScopeForTests(SAMPLE_ESTATE_ID);
    expect(hasActiveProject()).toBe(true);
    expect(currentProjectId()).toBe(SAMPLE_ESTATE_ID);
  });

  it('scoping to any other estate id is active too', () => {
    setProjectScopeForTests('acme');
    expect(hasActiveProject()).toBe(true);
  });

  it('SAMPLE_ESTATE_ID is the bundled sample estate id, not a fresh label', () => {
    expect(SAMPLE_ESTATE_ID).toBe('sample');
  });
});
