import type { ProjectConfig } from '@/types/project';
import { parseProject, tryParseProject } from '@/types/projectSchema';
import defaultProject from '@/data/project.json';

/**
 * Resolve the active project config. Resolution order:
 *
 *   1. `window.__CCP_PROJECT__` — a runtime override a static host can inject
 *      via an inline <script> BEFORE the bundle loads. This is the no-rebuild
 *      reuse seam: point the control plane at a different imported repo by serving a
 *      different project object, with the same compiled SPA. It is read, never
 *      fetched, so the standalone (no-network) invariant holds.
 *   2. The bundled `src/data/project.json` — the default estate this build ships
 *      with, validated the same way.
 *
 * An invalid override is ignored (with a console warning) and the bundled default
 * is used, so a bad injection degrades to a working app rather than a blank one.
 * Resolution is memoised: the project does not change within a running session.
 */
declare global {
  interface Window {
    __CCP_PROJECT__?: unknown;
  }
  // eslint-disable-next-line no-var
  var __CCP_PROJECT__: unknown;
}

let cached: ProjectConfig | null = null;

function resolveProject(): ProjectConfig {
  // Read via globalThis (=== window in the browser) so a host's inline-script
  // injection is picked up, and so it is reachable in non-DOM contexts too.
  const injected = (globalThis as { __CCP_PROJECT__?: unknown }).__CCP_PROJECT__;
  if (injected !== undefined) {
    const parsed = tryParseProject(injected);
    if (parsed) return parsed;
    // eslint-disable-next-line no-console
    console.warn('[ccp] window.__CCP_PROJECT__ failed validation; using bundled default.');
  }
  return parseProject(defaultProject);
}

/** The active project config for this session (memoised). */
export function getProject(): ProjectConfig {
  if (!cached) cached = resolveProject();
  return cached;
}

/** Test-only: drop the memoised project so the next getProject() re-resolves. */
export function resetProjectForTests(): void {
  cached = null;
}
