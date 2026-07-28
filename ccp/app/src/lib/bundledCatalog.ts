import type { ServiceManifest } from '@/types';

/**
 * The bundled sample catalog, off the first-paint critical path (PERF-5).
 *
 * `@/data/manifests` eagerly globs 115 manifest JSONs (3.9 MB on disk) and runs a
 * full zod deep-parse at module-evaluation time. That is the right shape for the
 * module itself — a malformed manifest must fail loudly, not via a blind cast — but
 * both costs used to be paid by EVERY visitor before anything rendered, because
 * `lib/api.ts` and `lib/httpApi.ts` imported it statically and both are on the entry
 * graph. The login page, which cannot use a catalog it has no session for, paid for
 * the whole thing.
 *
 * Importing it dynamically moves the JSON into its own chunk and the parse to first
 * use. Nothing about the module changes: `manifests` stays a plain synchronous
 * export, which is what the 45 test files that import it directly depend on, and
 * what the admin subtree (already code-split) keeps using.
 *
 * The promise — not the resolved array — is what's memoized, so N concurrent callers
 * share one import instead of racing to start their own. The ES module registry would
 * dedupe the fetch anyway; this dedupes the `.then` chain and gives every caller the
 * same array identity.
 */
let pending: Promise<ServiceManifest[]> | null = null;

export function loadBundledManifests(): Promise<ServiceManifest[]> {
  pending ??= import('@/data/manifests').then((m) => m.manifests);
  return pending;
}
