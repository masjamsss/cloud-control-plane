import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectProvider } from '@/lib/ProjectContext';
import { currentProjectId, hasActiveProject, setProjectScopeForTests } from '@/lib/projectScope';
import LoginPage from '@/features/auth/LoginPage';

/**
 * Day-zero regression: a fresh boot must leave the ambient project scope EMPTY
 * so the very first `/auth/login` — and every other pre-estate call — rides with
 * NO `x-ccp-project` header. The server then applies its header-less `@control`
 * default (middleware/session.ts `withProject`), which is a KNOWN scope and lets
 * login through.
 *
 * The bug this guards: `main.tsx` used to wrap the whole app in a global
 * `<ProjectProvider>` with no `:projectId`. That resolves the bundled SAMPLE
 * estate and writes `'sample'` to the scope DURING render (ProjectProvider uses
 * useMemo, not useEffect), so login carried `x-ccp-project: sample`. On a fresh
 * real backend there is no `sample` project, so `withProject` (correctly) rejects
 * that header with 422 `{field:'x-ccp-project'}` — and the first admin can never
 * sign in. The whole 2631-test suite passed with that bug live: nothing asserted
 * the unscoped boot state, which is the gap this file closes. Project scope is
 * now set per route by `ProjectRoute`'s `<ProjectProvider projectId>` under
 * `/p/:projectId` — the only subtree that reads it via `useProject()`.
 *
 * No jsdom in this repo (see useActiveProjectId.test.ts): "render" is
 * renderToStaticMarkup under MemoryRouter, which exercises the render-phase
 * scope write exactly as the browser's first paint does.
 */
afterEach(() => setProjectScopeForTests('sample'));

describe('fresh-boot project scope — day-zero login is unscoped', () => {
  it('rendering the login screen pins NO project scope (unscoped → no header → @control default)', () => {
    setProjectScopeForTests('');
    renderToStaticMarkup(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(currentProjectId()).toBe('');
    expect(hasActiveProject()).toBe(false);
  });

  it('positive control: a global no-projectId ProjectProvider WOULD pin "sample" (the removed bug)', () => {
    setProjectScopeForTests('');
    renderToStaticMarkup(
      <MemoryRouter initialEntries={['/login']}>
        <ProjectProvider>
          <LoginPage />
        </ProjectProvider>
      </MemoryRouter>,
    );
    // Proves the mechanism: wrapping the pre-estate tree in the old global
    // provider re-pins the sample estate — which is why main.tsx must not.
    expect(currentProjectId()).toBe('sample');
  });
});
