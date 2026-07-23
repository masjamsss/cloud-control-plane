import { afterEach, describe, expect, it } from 'vitest';
import { findRegisteredProject, listProjects } from '@/lib/projectRegistry';
import { setProjectScopeForTests } from '@/lib/projectScope';
import { api } from '@/lib/api';
import { manifests as bundledManifests } from '@/data/manifests';
import bundledInventory from '@/data/inventory.json';

/**
 * R3 §5.4b: the project registry is the frozen no-network seam — the bundled
 * default plus anything vendored at build time under src/data/projects/<id>/
 * (Task 4 vendors `bootstrap` there) plus anything injected at runtime via
 * `globalThis.__CCP_PROJECTS__` (same seam as the single-project override,
 * A6). No fetch anywhere — the standalone invariant must stay green.
 */
const VALID_EXTRA = {
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

describe('project registry (R3 §5.4b)', () => {
  it('always includes the bundled default (sample)', async () => {
    const projects = await listProjects();
    expect(projects.some((p) => p.id === 'sample')).toBe(true);
  });

  it('a valid injected __CCP_PROJECTS__ entry appears in the registry', async () => {
    (globalThis as { __CCP_PROJECTS__?: unknown[] }).__CCP_PROJECTS__ = [VALID_EXTRA];
    const projects = await listProjects();
    expect(projects.some((p) => p.id === 'acme')).toBe(true);
  });

  it('an invalid injected entry is dropped, not thrown', async () => {
    (globalThis as { __CCP_PROJECTS__?: unknown[] }).__CCP_PROJECTS__ = [{ id: 'broken' }];
    expect(async () => listProjects()).not.toThrow();
    const projects = await listProjects();
    expect(projects.some((p) => p.id === 'broken')).toBe(false);
  });

  it('de-dup by id keeps the first — an injected impostor cannot shadow the bundled sample', async () => {
    (globalThis as { __CCP_PROJECTS__?: unknown[] }).__CCP_PROJECTS__ = [
      { ...VALID_EXTRA, id: 'sample', name: 'Imposter' },
    ];
    const projects = await listProjects();
    const samples = projects.filter((p) => p.id === 'sample');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.name).not.toBe('Imposter');
  });

  it('findRegisteredProject resolves an injected project synchronously (the ProjectProvider seam)', () => {
    (globalThis as { __CCP_PROJECTS__?: unknown[] }).__CCP_PROJECTS__ = [VALID_EXTRA];
    expect(findRegisteredProject('acme')?.name).toBe('Acme — EU');
  });

  it('findRegisteredProject returns undefined for an unknown id', () => {
    expect(findRegisteredProject('doesnotexist')).toBeUndefined();
  });

  it('the bootstrap project (vendored under src/data/projects/) is discoverable in the registry', async () => {
    const projects = await listProjects();
    const bootstrap = projects.find((p) => p.id === 'bootstrap');
    expect(bootstrap).toBeDefined();
    expect(bootstrap?.name).toBe('Bootstrap — importer sandbox');
    // Also reachable through the synchronous seam ProjectProvider uses.
    expect(findRegisteredProject('bootstrap')?.id).toBe('bootstrap');
  });
});

describe('api.ts project-aware data loading (R3 §5.4b)', () => {
  // Full coverage of this resolution rule against the real vendored bootstrap
  // catalog (manifests + inventory + blocks) lives in bootstrapProject.test.ts;
  // this pins the rule itself: default id → bundled; vendored id → vendored;
  // any other id → explicitly EMPTY — never the bundled default's estate
  // under another project's name (the silent wrong-estate fallback).
  it('the default project id reads the bundled catalog + inventory', async () => {
    setProjectScopeForTests('sample');
    expect(await api.listManifests()).toBe(bundledManifests);
    expect(await api.getInventory()).toBe(bundledInventory);
  });

  it('listManifests()/getInventory() read the vendored bootstrap catalog when scoped to it', async () => {
    setProjectScopeForTests('bootstrap');
    const manifests = await api.listManifests();
    const inventory = await api.getInventory();
    expect(manifests.map((m) => m.service).sort()).toEqual(['iam', 'kms', 's3']);
    expect(inventory.resources.length).toBeGreaterThan(0);
    expect(inventory.resources.every((r) => ['s3', 'kms', 'iam'].includes(r.service ?? ''))).toBe(true);
  });

  it('a registered project with NO vendored data gets an empty catalog, never the bundled default', async () => {
    (globalThis as { __CCP_PROJECTS__?: unknown[] }).__CCP_PROJECTS__ = [VALID_EXTRA];
    setProjectScopeForTests('acme');
    const manifests = await api.listManifests();
    const inventory = await api.getInventory();
    expect(manifests).toEqual([]);
    expect(inventory.resources).toEqual([]);
    expect(inventory).not.toBe(bundledInventory);
  });

  it('an entirely unknown project id gets the same empty state (fail-safe below the router)', async () => {
    // The router's resolveActiveProject would throw before this scope could be
    // reached in the app; the data layer must still never serve another
    // project's estate if scoped some other way.
    setProjectScopeForTests('ghost-no-such-project');
    expect(await api.listManifests()).toEqual([]);
    expect((await api.getInventory()).resources).toEqual([]);
  });
});
