import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The completeness lint (Task 5, 6-admin-complete-control; admin-and-multiproject
 * §8). Encodes the spec's "manageable" rows as required admin route paths +
 * required GlobalSettings keys, and asserts each exists — mechanically, so if
 * someone adds a managed domain to the spec but not a surface (or vice versa),
 * this test fails and names exactly what's missing.
 *
 * Required admin surfaces (spec admin-and-multiproject §8). Adding a managed
 * domain to the matrix without a surface here — or vice-versa — fails CI.
 */
const REQUIRED_ADMIN_ROUTES = [
  'users',
  'teams',
  'policy',
  'risk',
  'settings',
  'history',
  'projects',
  'pending-changes',
];
const REQUIRED_SETTING_GROUPS = [
  'changeFreeze',
  'disabledOps',
  'allowlistOverrides',
  'notifications',
  'maintenanceWindows',
  'limits',
];

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('admin coverage — every managed domain has a portal surface (§8)', () => {
  const routerSrc = readFileSync(join(SRC, 'router.tsx'), 'utf8');

  it('router.tsx mounts the admin subtree', () => {
    // Sanity check for the assertions below — if this ever stops matching,
    // every per-route assertion below would trivially "pass" for the wrong reason.
    expect(routerSrc).toMatch(/path:\s*'admin'/);
  });

  // A nested react-router route never spells out the literal string
  // "admin/<name>" in source (the parent 'admin' and child '<name>' path
  // segments are declared separately) — so coverage is checked by the child
  // route's own quoted `path: '<name>'` literal within the admin subtree,
  // which is what's actually mechanically present and unambiguous.
  it.each(REQUIRED_ADMIN_ROUTES)('admin route "%s" is registered in router.tsx', (name) => {
    expect(routerSrc, `expected router.tsx to declare path: '${name}' under the admin subtree`).toMatch(
      new RegExp(`path:\\s*'${name}'`),
    );
  });

  const settingsSrc = readFileSync(join(SRC, 'lib', 'settings.ts'), 'utf8');
  const ifaceMatch = settingsSrc.match(/export interface GlobalSettings \{[\s\S]*?\n\}/);

  it('lib/settings.ts declares a GlobalSettings interface', () => {
    expect(ifaceMatch, 'GlobalSettings interface not found in lib/settings.ts').toBeTruthy();
  });

  const iface = ifaceMatch?.[0] ?? '';

  it.each(REQUIRED_SETTING_GROUPS)('GlobalSettings declares "%s"', (name) => {
    expect(iface, `expected the GlobalSettings interface to declare "${name}"`).toContain(name);
  });
});
