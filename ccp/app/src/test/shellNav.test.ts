import { describe, expect, it } from 'vitest';
import { ADMIN_TABS, shellNavItems } from '@/components/ShellNav';
import { projectScopedPath } from '@/lib/legacyRoute';

/**
 * UI-3 — no nav link was ever the active one, and every nav click unmounted the app.
 *
 * The whole shell lives under `/p/:projectId`, but both navigation surfaces were built
 * from UNSCOPED absolute `to` values (`/requests`, `/admin/users`). React Router resolves
 * `isActive` against the target, so with the location always `/p/<id>/…` **no** NavLink
 * could ever match: `.shell__link--active`, `.shell__navmenu-item[aria-current='page']`
 * and `.admin__tab--active` were dead CSS, and `aria-current="page"` was emitted nowhere.
 * A user got no "where am I" signal in any nav — a WCAG 2.4.8 / SC 1.3.1 regression.
 *
 * The second half was worse than cosmetic: clicking an unscoped path matched the
 * top-level `*` route, which unmounted the entire `/p` subtree (AppShell included) so
 * `LegacyRedirect` could rewrite the path, then remounted everything — a skeleton flash
 * and a full refetch of shell data on every top-nav click.
 *
 * What is pinned here is the property that fixes both: **every** nav target resolves under
 * `/p/:projectId`. It is asserted over the whole set rather than a sample, because one
 * unscoped entry reintroduces the unmount for that link alone and would be invisible
 * against a spot check. No jsdom in this repo (see test/standalone.test.ts's dependency
 * allowlist), which is why the nav item sets are pure exports.
 */

const PROJECT = 'acme-prod';
const ROLES = ['requester', 'approver', 'lead'] as const;

function everyNavTarget(): string[] {
  const items = ROLES.flatMap((role) => [
    ...shellNavItems({ role }),
    ...shellNavItems({ role, isAdmin: true }),
  ]);
  return [...new Set([...items.map((i) => i.to), ...ADMIN_TABS.map((t) => t.to)])];
}

describe('every navigation target is project-scoped (UI-3)', () => {
  it('resolves every primary-nav and admin-tab target under /p/:projectId', () => {
    // The whole property, over the whole set. A single unscoped entry is the bug.
    for (const to of everyNavTarget()) {
      const scoped = projectScopedPath(PROJECT, to);
      expect(scoped, `${to} must be scoped`).toMatch(new RegExp(`^/p/${PROJECT}(/|$)`));
    }
  });

  it('scopes the index route WITHOUT a trailing slash, or `end` never matches', () => {
    // `/p/<id>/` would not match a NavLink with `end`, which is the entire point of
    // scoping it — the Home link would stay inactive and the fix would be half-done.
    expect(projectScopedPath(PROJECT, '/')).toBe('/p/acme-prod');
  });

  it('is idempotent — re-scoping an already-scoped path must not double the prefix', () => {
    const once = projectScopedPath(PROJECT, '/requests');
    expect(projectScopedPath(PROJECT, once)).toBe(once);
    expect(once).toBe('/p/acme-prod/requests');
  });

  it('leaves paths unscoped when there is no active project, rather than emitting /p//x', () => {
    expect(projectScopedPath('', '/requests')).toBe('/requests');
  });

  it('normalises a target that omits its leading slash', () => {
    expect(projectScopedPath(PROJECT, 'requests')).toBe('/p/acme-prod/requests');
  });
});

describe('the nav sets themselves', () => {
  it('gates Approvals and Dashboard by role, and Admin by capability', () => {
    // Admin is a governance CAPABILITY, not the Lead role — the two are independent, and
    // conflating them is how a lead silently gains admin nav or an admin loses it.
    const labels = (u: { role: string; isAdmin?: boolean }): string[] =>
      shellNavItems(u).map((i) => i.label);

    expect(labels({ role: 'requester' })).toEqual(['Home', 'My requests', 'Drift']);
    expect(labels({ role: 'approver' })).toContain('Approvals');
    expect(labels({ role: 'approver' })).not.toContain('Dashboard');
    expect(labels({ role: 'lead' })).toContain('Dashboard');
    expect(labels({ role: 'lead' })).not.toContain('Admin');
    expect(labels({ role: 'requester', isAdmin: true })).toContain('Admin');
  });

  it('marks ONLY the index route `end` — the one link that would otherwise match everything', () => {
    // Without `end`, Home is active on every page, which is the same "no signal" outcome
    // the finding describes, arrived at from the opposite direction.
    const home = shellNavItems({ role: 'lead' }).find((i) => i.to === '/');
    expect(home?.end).toBe(true);
    for (const item of shellNavItems({ role: 'lead', isAdmin: true })) {
      if (item.to !== '/') expect(item.end, `${item.to} must not be end-matched`).toBeUndefined();
    }
  });

  it('has no duplicate targets in either surface', () => {
    const tabs = ADMIN_TABS.map((t) => t.to);
    expect(new Set(tabs).size).toBe(tabs.length);
    const nav = shellNavItems({ role: 'lead', isAdmin: true }).map((i) => i.to);
    expect(new Set(nav).size).toBe(nav.length);
  });
});
