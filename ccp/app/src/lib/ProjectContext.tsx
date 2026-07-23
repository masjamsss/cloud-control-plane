import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { JSX } from 'react';
import type { ProjectConfig } from '@/types/project';
import { getProject } from '@/lib/project';
import { currentProjectId, setProjectScope, SAMPLE_ESTATE_ID } from '@/lib/projectScope';
import { findRegisteredProject } from '@/lib/projectRegistry';

/**
 * Makes the active project config available to the component tree, so
 * the UI reads project identity — name, region, repo — as data rather than
 * importing hardcoded constants. The value is the resolved project for the
 * current route; a different imported repo means a different provider value,
 * not a recompile.
 */
const ProjectContext = createContext<ProjectConfig | null>(null);

/**
 * Resolve the ProjectConfig for a route's `:projectId` AND set the ambient
 * project scope (projectScope.ts) that every store reads at call time — in
 * that order, synchronously, so no store read during this render (or any
 * child's) can observe a stale scope. Exported as a test seam (pure, no DOM):
 * callers assert `currentProjectId()` after calling this directly, without
 * rendering anything.
 *
 * The sample estate (the bundled default project) always resolves via
 * `getProject()`; any other id is looked up in the project registry —
 * vendored (build-time, e.g. `bootstrap`) or injected at runtime. An
 * id that resolves to neither throws "No project named X", which the router's
 * errorElement on the `/p/:projectId` route renders.
 */
export function resolveActiveProject(projectId?: string): ProjectConfig {
  const id = projectId ?? SAMPLE_ESTATE_ID;
  const config = id === SAMPLE_ESTATE_ID ? getProject() : findRegisteredProject(id);
  if (!config) {
    throw new Error(`No project named ${id}`);
  }
  setProjectScope(id);
  return config;
}

export function ProjectProvider({
  children,
  projectId,
}: {
  children: ReactNode;
  /** The route's :projectId. Omitted (or the sample estate id) resolves the bundled default. */
  projectId?: string;
}): JSX.Element {
  // This component is deliberately NOT opted into the
  // React Compiler pilot. The annotation-mode config (vite.config.ts) only
  // compiles functions carrying "use memo", so this fence is redundant today
  // — but it's added anyway as the documented, defense-in-depth decision
  // record: the useMemo below is a load-bearing render-phase scope-write, not
  // a perf cache (setProjectScope must run DURING render, before children
  // render), and must never be silently reordered/cached differently if
  // compilationMode ever changes from 'annotation' to 'infer'/'all'.
  'use no memo';
  // useMemo, not useEffect: this must run DURING render, synchronously, before
  // children render — an effect fires too late, after children may already
  // have read a (possibly stale-scoped) store.
  const project = useMemo(() => resolveActiveProject(projectId), [projectId]);
  // React 19: a context object can be rendered directly as its own
  // provider (`<ProjectContext>`) — `.Provider` still works and is kept
  // available, but this is the new, shorter form.
  return <ProjectContext value={project}>{children}</ProjectContext>;
}

export function useProject(): ProjectConfig {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within a ProjectProvider');
  return ctx;
}

/**
 * The ACTIVE project's id, as an effect/memo dependency for per-project data
 * loads. Every view that fetches project-scoped data (manifests, inventory,
 * requests) keys its fetch effect on this, so switching projects re-runs the
 * fetch against the newly scoped project — previously those effects ran once
 * per mount (`[]` deps) and a switch kept showing the old project's data until
 * a hard reload. The id is derived from the SAME resolution the fetch layer
 * scopes by: `resolveActiveProject` returns this exact id after writing it to
 * the ambient scope (projectScope.ts) that `api.ts` reads at call time, so an
 * effect keyed on it always fetches under a matching scope
 * (useActiveProjectId.test.ts proves that derivation without a DOM).
 *
 * Reads the context when under a ProjectProvider (the app always is — that is
 * what subscribes a view to switches) and falls back to the ambient scope in
 * a provider-less tree (this repo's no-jsdom server-render tests): the same
 * id by construction, since the provider writes the scope from this exact
 * resolution before any child renders.
 */
export function useActiveProjectId(): string {
  const ctx = useContext(ProjectContext);
  return ctx ? ctx.id : currentProjectId();
}
