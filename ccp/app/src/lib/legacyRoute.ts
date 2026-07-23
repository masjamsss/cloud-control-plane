import { currentProjectId, hasActiveProject, SAMPLE_ESTATE_ID } from '@/lib/projectScope';
import { apiSessionScopes, isApiMode } from '@/lib/apiSession';

/**
 * Where an unscoped visit lands — the first-run / "onboard your estate"
 * surface (data-birth spec, lane B item 3). A blank real install (or an
 * account not yet bound to a concrete estate) must never fall through to a
 * bundled sample shell nobody earned.
 */
export const FIRST_RUN_PATH = '/onboarding';

/**
 * Pure decision for an UNSCOPED visit (no active project — `hasActiveProject()`
 * is false), parameterized on api-mode + the signed-in account's own scopes
 * rather than reading the build-time `isApiMode` constant directly, so both
 * branches are testable without faking it (the same seam
 * `features/admin/projectsFlow.ts`'s `loadServerProjectsVia` uses).
 *
 *  - mock/standalone (`apiMode` false): always the bundled SAMPLE
 *    ({@link SAMPLE_ESTATE_ID}) — every existing demo flow, screenshot, and
 *    test walk stays intact (lane B item 4).
 *  - a real backend: the signed-in account lands on a concrete estate it
 *    already holds a role on (`ownedScopes` — the server's own `roles` map,
 *    cached at login/me; sorted for determinism when there is more than
 *    one). Holding none outright — nobody has onboarded anything yet, or the
 *    account is bound only via the founding all-projects wildcard — lands on
 *    the first-run surface instead of guessing.
 */
export function unscopedLandingPath(
  suffix: string,
  apiMode: boolean,
  ownedScopes: readonly string[],
): string {
  if (!apiMode) return `/p/${SAMPLE_ESTATE_ID}${suffix}`;
  const concrete = ownedScopes.filter((s) => s !== '*').sort();
  return concrete.length > 0 ? `/p/${concrete[0]}${suffix}` : FIRST_RUN_PATH;
}

/**
 * Map a (single-project) path to its `/p/:projectId` equivalent under
 * whichever project is CURRENTLY scoped — so an in-app absolute link (e.g. a
 * NavLink's `to="/requests"`, or an old bookmark) lands back in the project the
 * user was actually looking at. A path that is already project-scoped is
 * returned unchanged. Nothing scoped yet (a fresh api-mode load before an
 * estate is selected/active) resolves via {@link unscopedLandingPath} instead
 * of asserting a project nobody chose.
 *
 * Lives in its own module (router.tsx re-exports it) rather than directly in
 * router.tsx: router.tsx's top-level `createBrowserRouter` call requires a DOM
 * (`document`), so it cannot be imported from a plain-Node test — this sibling
 * module has no such dependency and is what projectRoutes.test.ts imports.
 */
export function legacyPathToProjectPath(path: string): string {
  if (path.startsWith('/p/')) return path; // already scoped — unchanged
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (!hasActiveProject()) return unscopedLandingPath(suffix, isApiMode, apiSessionScopes());
  return `/p/${currentProjectId()}${suffix}`;
}
