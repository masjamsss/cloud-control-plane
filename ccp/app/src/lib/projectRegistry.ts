import type { ProjectConfig } from '@/types/project';
import { tryParseProject } from '@/types/projectSchema';
import { getProject } from '@/lib/project';

/**
 * The full set of projects this build can serve — what powers the
 * header switcher (ProjectSwitcher.tsx) and the router's scope resolution for
 * anything other than the bundled default (ProjectContext.tsx).
 *
 * Frozen mechanism (no fetch — the standalone/no-network invariant is
 * untouched): the registry is the union of —
 *   1. the bundled default (`getProject()`, today always the sample estate),
 *   2. anything vendored at BUILD TIME under `src/data/projects/<id>/project.json`
 *      (vendors `bootstrap` this way; drop another project dir in and it
 *      registers automatically, no edit here needed),
 *   3. anything injected at RUNTIME via `globalThis.__CCP_PROJECTS__` — the
 *      same no-network seam as the single-project override (`lib/project.ts`),
 *      widened to an array so a host can offer several imported repos at once.
 * De-duped by id, first occurrence wins (bundled > vendored > injected) — an
 * injected or vendored entry can never shadow the build's own default identity.
 */
declare global {
  interface Window {
    __CCP_PROJECTS__?: unknown[];
  }
  // eslint-disable-next-line no-var
  var __CCP_PROJECTS__: unknown[] | undefined;
}

// import.meta.glob patterns must be static string literals (no dynamic
// currentProjectId() interpolation), so every vendored project.json is
// discovered eagerly up front — the registry itself is small (id/name/etc.
// per project), unlike each project's (much larger) manifests/inventory/blocks.
const vendoredModules = import.meta.glob<{ default: unknown }>('../data/projects/*/project.json', {
  eager: true,
});

function vendoredProjects(): ProjectConfig[] {
  const out: ProjectConfig[] = [];
  for (const key of Object.keys(vendoredModules).sort()) {
    const parsed = tryParseProject(vendoredModules[key]!.default);
    if (parsed) {
      out.push(parsed);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[ccp] vendored project at ${key} failed validation; skipped.`);
    }
  }
  return out;
}

function injectedProjects(): ProjectConfig[] {
  const injected = (globalThis as { __CCP_PROJECTS__?: unknown }).__CCP_PROJECTS__;
  if (injected === undefined) return [];
  if (!Array.isArray(injected)) {
    // eslint-disable-next-line no-console
    console.warn('[ccp] window.__CCP_PROJECTS__ is not an array; ignored.');
    return [];
  }
  const out: ProjectConfig[] = [];
  for (const candidate of injected) {
    const parsed = tryParseProject(candidate);
    if (parsed) {
      out.push(parsed);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[ccp] an injected __CCP_PROJECTS__ entry failed validation; skipped.');
    }
  }
  return out;
}

function dedupeById(projects: ProjectConfig[]): ProjectConfig[] {
  const seen = new Set<string>();
  const out: ProjectConfig[] = [];
  for (const p of projects) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * Every project this build can serve, de-duped by id. Async to match the
 * ApiClient shape (`api.ts`'s other list* methods) — resolution itself is
 * synchronous today (no network), so a real backend can replace the internals
 * later without changing callers.
 */
export async function listProjects(): Promise<ProjectConfig[]> {
  return dedupeById([getProject(), ...vendoredProjects(), ...injectedProjects()]);
}

/**
 * Synchronous lookup of one non-default project by id — the seam
 * ProjectContext.tsx's `resolveActiveProject` uses for the router's
 * scope-must-be-set-before-render requirement (a `useMemo` callback cannot
 * await `listProjects()`). Only vendored + injected projects are searched; the
 * bundled default is resolved directly via `getProject()`, not through here.
 */
export function findRegisteredProject(id: string): ProjectConfig | undefined {
  return [...vendoredProjects(), ...injectedProjects()].find((p) => p.id === id);
}
