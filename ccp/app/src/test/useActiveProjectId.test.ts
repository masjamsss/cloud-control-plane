import { afterEach, describe, expect, it } from 'vitest';
import { resolveActiveProject, useActiveProjectId } from '@/lib/ProjectContext';
import { currentProjectId, setProjectScopeForTests } from '@/lib/projectScope';

/**
 * useActiveProjectId() is the refetch key every data-loading view puts in its
 * fetch effect's dependency array, so a project switch re-runs the fetch
 * (previously `[]` deps kept the old project's data until a hard reload).
 * The hook itself is one context read (`useProject().id`) — this repo has no
 * jsdom/RTL, so what is provable here is its KEY DERIVATION: the id it
 * returns is the `.id` of whatever `resolveActiveProject` resolved for the
 * route (that resolved config IS the context value ProjectProvider serves),
 * and that id is byte-equal to the ambient scope `api.ts` reads at call time.
 * That equality is the whole correctness argument: effect key changes ⇔ the
 * fetch layer answers for a different project.
 */

const INJECTED = {
  id: 'acme',
  name: 'Acme — EU',
  github: { owner: 'acme-co', repo: 'terraform-acme', mode: 'org' as const },
  region: 'eu-west-1',
  seedLead: { username: 'lead', displayName: 'Lead', teamId: 'core', defaultPassword: 'change-me' },
  teams: [{ id: 'core', name: 'Core', serviceSlugs: ['s3'] }],
};

afterEach(() => {
  delete (globalThis as { __CCP_PROJECTS__?: unknown }).__CCP_PROJECTS__;
  setProjectScopeForTests('sample');
});

describe('useActiveProjectId — key derivation (pure seam, no DOM)', () => {
  it('is exported as a hook for the views to share', () => {
    expect(typeof useActiveProjectId).toBe('function');
  });

  it('the default project resolves to the key "sample", matching the fetch scope', () => {
    const project = resolveActiveProject(undefined);
    expect(project.id).toBe('sample');
    expect(currentProjectId()).toBe(project.id);
  });

  it('a vendored project resolves to its own id, matching the fetch scope', () => {
    const project = resolveActiveProject('bootstrap');
    expect(project.id).toBe('bootstrap');
    expect(currentProjectId()).toBe(project.id);
  });

  it('an injected (runtime-registered) project resolves to its own id, matching the fetch scope', () => {
    (globalThis as { __CCP_PROJECTS__?: unknown[] }).__CCP_PROJECTS__ = [INJECTED];
    const project = resolveActiveProject('acme');
    expect(project.id).toBe('acme');
    expect(currentProjectId()).toBe(project.id);
  });

  it('a switch changes the key — and the fetch scope moves with it, every hop', () => {
    const first = resolveActiveProject('bootstrap');
    expect(currentProjectId()).toBe(first.id);
    const second = resolveActiveProject('sample');
    expect(second.id).not.toBe(first.id);
    expect(currentProjectId()).toBe(second.id);
  });
});
