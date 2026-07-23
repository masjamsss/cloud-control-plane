import { afterEach, describe, expect, it } from 'vitest';
import { getProject, resetProjectForTests } from '@/lib/project';
import { parseProject, tryParseProject } from '@/types/projectSchema';

/**
 * R3 reusability: the project config is resolved at runtime (bundled default, or
 * a `window.__CCP_PROJECT__` override) rather than compiled in, so the same
 * build can serve any imported repo.
 */
const OTHER_PROJECT = {
  id: 'acme',
  name: 'Acme — EU',
  github: { owner: 'acme-co', repo: 'terraform-acme', mode: 'org' as const },
  region: 'eu-west-1',
  seedLead: {
    username: 'lead',
    displayName: 'Lead',
    teamId: 'core',
    defaultPassword: 'change-me',
  },
  teams: [{ id: 'core', name: 'Core', serviceSlugs: ['s3', 'ec2'] }],
};

afterEach(() => {
  delete (globalThis as { __CCP_PROJECT__?: unknown }).__CCP_PROJECT__;
  resetProjectForTests();
});

describe('project config resolution (R3)', () => {
  it('falls back to the bundled default (this estate) with no override', () => {
    const p = getProject();
    expect(p.id).toBe('sample');
    expect(p.github.owner).toBe('example-org');
    expect(p.github.repo).toBe('example-estate');
    expect(p.region).toBe('us-east-1');
    expect(p.teams.length).toBeGreaterThan(0);
  });

  it('the bundled default validates against the schema', () => {
    // getProject() already parses; assert parseProject accepts it explicitly too.
    expect(() => parseProject(getProject())).not.toThrow();
  });

  it('a valid runtime override reconfigures the whole project', () => {
    (globalThis as { __CCP_PROJECT__?: unknown }).__CCP_PROJECT__ = OTHER_PROJECT;
    resetProjectForTests();
    const p = getProject();
    expect(p.id).toBe('acme');
    expect(p.github.owner).toBe('acme-co');
    expect(p.region).toBe('eu-west-1');
    expect(p.seedLead.username).toBe('lead');
    expect(p.teams[0]?.serviceSlugs).toContain('ec2');
  });

  it('an invalid override is ignored and the default is used (degrade, not crash)', () => {
    (globalThis as { __CCP_PROJECT__?: unknown }).__CCP_PROJECT__ = { id: 'broken' }; // missing fields
    resetProjectForTests();
    const p = getProject();
    expect(p.id).toBe('sample'); // fell back
  });

  it('tryParseProject rejects malformed configs without throwing', () => {
    expect(tryParseProject({ id: 'x' })).toBeNull();
    expect(tryParseProject({ ...OTHER_PROJECT, teams: [] })).toBeNull(); // teams must be non-empty
    expect(tryParseProject(OTHER_PROJECT)).not.toBeNull();
  });
});

/**
 * Task 5: timezone/timezoneLabel are OPTIONAL on ProjectConfig — the sample's
 * own project.json now sets them as data (JST is the sample estate's data, not
 * app code), but an older/foreign project.json predating this field must stay
 * valid.
 */
describe('project config — optional timezone/timezoneLabel (Task 5)', () => {
  it("the sample's bundled default carries JST as DATA, not as a code default", () => {
    const p = getProject();
    expect(p.timezone).toBe('Asia/Tokyo');
    expect(p.timezoneLabel).toBe('JST');
  });

  it('a config predating this field stays valid, with timezone left undefined', () => {
    expect(() => parseProject(OTHER_PROJECT)).not.toThrow();
    const p = parseProject(OTHER_PROJECT);
    expect(p.timezone).toBeUndefined();
    expect(p.timezoneLabel).toBeUndefined();
  });

  it('a runtime override may set its own timezone/timezoneLabel', () => {
    (globalThis as { __CCP_PROJECT__?: unknown }).__CCP_PROJECT__ = {
      ...OTHER_PROJECT,
      timezone: 'Europe/Paris',
      timezoneLabel: 'CET',
    };
    resetProjectForTests();
    const p = getProject();
    expect(p.timezone).toBe('Europe/Paris');
    expect(p.timezoneLabel).toBe('CET');
  });
});
