import type { RouteObject } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeConfig } from '@/routeConfig';
import { FIRST_RUN_PATH } from '@/lib/legacyRoute';

/**
 * UI-9 — `/login`, the first-run surface, and the catch-all `LegacyRedirect`
 * route used to sit OUTSIDE the only `errorElement` in the tree (the one on
 * `/p/:projectId`): a throw during any of them fell through to React
 * Router's raw, unstyled default error screen. The fix wraps the whole tree
 * in a pathless root route carrying `errorElement`, so this test walks
 * `routeConfig` (the plain data — `router.tsx` itself can't be imported
 * outside a browser, since `createBrowserRouter` reaches for `window`
 * immediately, and this repo has no jsdom — see TEST-7) and asserts every
 * route, named or not, has an `errorElement` somewhere in its own ancestor
 * chain (inclusive).
 */

interface Located {
  route: RouteObject;
  path: string | undefined;
  protectedByErrorElement: boolean;
}

function walk(routes: RouteObject[], inherited: boolean): Located[] {
  const out: Located[] = [];
  for (const route of routes) {
    const protectedByErrorElement = inherited || route.errorElement !== undefined;
    out.push({ route, path: route.path, protectedByErrorElement });
    if (route.children) out.push(...walk(route.children, protectedByErrorElement));
  }
  return out;
}

const all = walk(routeConfig, false);

describe('routeConfig — every route sits under an errorElement (UI-9)', () => {
  it('the walk actually finds routes (a no-op walker would pass everything vacuously)', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it('/login is protected', () => {
    const login = all.find((r) => r.path === '/login');
    expect(login, '/login route must exist in routeConfig').toBeDefined();
    expect(login!.protectedByErrorElement).toBe(true);
  });

  it('the first-run route is protected', () => {
    const firstRun = all.find((r) => r.path === FIRST_RUN_PATH);
    expect(firstRun, `${FIRST_RUN_PATH} route must exist in routeConfig`).toBeDefined();
    expect(firstRun!.protectedByErrorElement).toBe(true);
  });

  it('/p/:projectId (and everything under it) is protected', () => {
    const projectRoute = all.find((r) => r.path === '/p/:projectId');
    expect(projectRoute).toBeDefined();
    expect(projectRoute!.protectedByErrorElement).toBe(true);
    // Spot-check a deep leaf, since /p/:projectId also carries its own
    // errorElement — the walk must not need it to still count as protected.
    const admin = all.find((r) => r.path === 'pending-changes');
    expect(admin).toBeDefined();
    expect(admin!.protectedByErrorElement).toBe(true);
  });

  it('the catch-all LegacyRedirect route ("*" at the top level) is protected', () => {
    const topLevelCatchAll = all.filter((r) => r.path === '*');
    // There are two "*" routes in this tree (the top-level LegacyRedirect
    // and the in-project NotFound) — both must be protected, but the
    // top-level one is the one UI-9 is specifically about.
    expect(topLevelCatchAll.length).toBeGreaterThanOrEqual(2);
    for (const route of topLevelCatchAll) {
      expect(route.protectedByErrorElement).toBe(true);
    }
  });

  it('every route in the tree is protected — no future route can silently opt out', () => {
    const unprotected = all.filter((r) => !r.protectedByErrorElement);
    expect(
      unprotected.map((r) => r.path),
      'every route must have an errorElement in its own ancestor chain',
    ).toEqual([]);
  });
});
