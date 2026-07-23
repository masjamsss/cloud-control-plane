import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIRST_RUN_PATH, legacyPathToProjectPath, unscopedLandingPath } from '@/lib/legacyRoute';
import { resolveActiveProject } from '@/lib/ProjectContext';
import { currentProjectId, setProjectScopeForTests } from '@/lib/projectScope';

// Pure-logic, no DOM: router.tsx itself calls createBrowserRouter at module
// load, which requires `document` and so cannot be imported here — see
// src/lib/legacyRoute.ts's docblock. router.tsx re-exports the same function
// for production callers; this file exercises the underlying module directly.

describe('legacy path → /p/:projectId redirect (R3 §5.4a)', () => {
  beforeEach(() => setProjectScopeForTests('sample'));

  it('redirects a bare legacy path to the default project', () => {
    expect(legacyPathToProjectPath('/services/ec2')).toBe('/p/sample/services/ec2');
  });

  it('redirects the root path to the default project root', () => {
    expect(legacyPathToProjectPath('/')).toBe('/p/sample/');
  });

  it('leaves an already project-scoped path unchanged', () => {
    expect(legacyPathToProjectPath('/p/sample/approvals')).toBe('/p/sample/approvals');
  });

  it('redirects into whichever project is currently scoped, not always sample', () => {
    setProjectScopeForTests('acme');
    expect(legacyPathToProjectPath('/requests')).toBe('/p/acme/requests');
  });
});

describe('ProjectProvider scope resolution (R3 §5.4a) — pure seam, no DOM', () => {
  afterEach(() => setProjectScopeForTests('sample'));

  it('resolves and scopes the default project when no id is given', () => {
    const project = resolveActiveProject(undefined);
    expect(project.id).toBe('sample');
    expect(currentProjectId()).toBe('sample');
  });

  it('resolves and scopes "sample" explicitly', () => {
    setProjectScopeForTests('a'); // prove it actually changes scope, not a no-op
    const project = resolveActiveProject('sample');
    expect(project.id).toBe('sample');
    expect(currentProjectId()).toBe('sample');
  });

  it('throws "No project named X" for an unknown id — the router error-boundary path', () => {
    expect(() => resolveActiveProject('doesnotexist')).toThrow('No project named doesnotexist');
  });
});

/**
 * Data-birth lane B item 3: where an UNSCOPED visit lands. Parameterized on
 * api-mode + the account's own scopes (not the build-time `isApiMode`
 * constant) so both branches are provable without faking it — see
 * lib/legacyRoute.ts's doc comment.
 */
describe('unscopedLandingPath — mock/standalone vs a real backend (data-birth lane B)', () => {
  it('mock/standalone always lands on the bundled sample, regardless of the account', () => {
    expect(unscopedLandingPath('/', false, [])).toBe('/p/sample/');
    expect(unscopedLandingPath('/requests', false, ['acme'])).toBe('/p/sample/requests');
  });

  it('a real backend lands a concretely-bound account on its estate', () => {
    expect(unscopedLandingPath('/', true, ['acme'])).toBe('/p/acme/');
  });

  it('sorted for determinism when bound to more than one estate', () => {
    expect(unscopedLandingPath('/', true, ['zed', 'acme'])).toBe('/p/acme/');
  });

  it('the all-projects wildcard alone is not a landable estate — first-run instead', () => {
    expect(unscopedLandingPath('/', true, ['*'])).toBe(FIRST_RUN_PATH);
  });

  it('no scopes at all (nothing onboarded, nothing bound) — first-run', () => {
    expect(unscopedLandingPath('/', true, [])).toBe(FIRST_RUN_PATH);
  });

  it('the wildcard is filtered out even alongside a real concrete scope', () => {
    expect(unscopedLandingPath('/', true, ['*', 'acme'])).toBe('/p/acme/');
  });
});

// legacyPathToProjectPath composes hasActiveProject() + unscopedLandingPath()
// with the real (build-time) isApiMode + apiSessionScopes() — both proven
// independently above/in multiAccountSession.test.ts; this suite runs
// mock-mode (no VITE_API_BASE), so only that composed branch is provable
// end to end here without faking the build-time constant.
describe('legacyPathToProjectPath — the unscoped branch end to end (data-birth lane B)', () => {
  afterEach(() => setProjectScopeForTests('sample'));

  it('nothing scoped yet lands on the bundled sample (this test suite runs mock-mode)', () => {
    setProjectScopeForTests('');
    expect(legacyPathToProjectPath('/')).toBe('/p/sample/');
    expect(legacyPathToProjectPath('/requests')).toBe('/p/sample/requests');
  });

  it('an already-scoped path is untouched even while otherwise unscoped', () => {
    setProjectScopeForTests('');
    expect(legacyPathToProjectPath('/p/acme/requests')).toBe('/p/acme/requests');
  });
});
