import blockIndex from '@/data/blocks/index.json';
import { currentProjectId, SAMPLE_ESTATE_ID } from '@/lib/projectScope';
import { isApiMode } from '@/lib/apiSession';
import { fetchServerBlockChunk } from '@/lib/api';

/**
 * Lazy access to each resource's full HCL block source (extracted + redacted at
 * generation time by scripts/extract-blocks.mjs). Blocks ship as per-file JSON
 * chunks loaded on demand via dynamic import() — no network at all in mock
 * mode, no bundle bloat on initial load, and the standalone (no-network)
 * invariant is untouched: the ONE runtime read below goes through the
 * allowlisted API seam (lib/api's fetchServerBlockChunk), never a network
 * primitive held here.
 *
 * Project-aware, three sources in fail-closed order:
 *  1. the bundled SAMPLE's ({@link SAMPLE_ESTATE_ID}) own index/chunks
 *     (always build-time) — served only once the sample is explicitly
 *     loaded, never a runtime default (the sample is a labeled capture, not
 *     the privileged first estate);
 *  2. in api mode, any OTHER account's index/chunks from ccp-api's data
 *     plane (`GET /projects/:id/blocks/...` — the ACTIVE uploaded version) —
 *     this is now every real onboarded estate, the first one included, so
 *     onboarding an account needs no vendor-and-rebuild step;
 *  3. the vendored `src/data/projects/<id>/blocks/` copy (vendors `bootstrap`)
 *     when the server has nothing — else empty. Never another estate's blocks.
 */
export interface BlockSource {
  /** Repo-relative path of the .tf / .tf.json file the block lives in. */
  file: string;
  /** 1-based line where the block starts (always 1 for a `viewOnly` entry —
   * its rendering stands for the file's whole declaration of the resource). */
  line: number;
  /** The complete, already-redacted resource block text. Native HCL for a
   * .tf block; a pretty-printed JSON rendering for a .tf.json one. */
  source: string;
  /** True for a resource declared in JSON-syntax Terraform (.tf.json):
   * viewable here, but not editable — catalogctl refuses .tf.json edits by
   * design, so downstream surfaces must treat it as look-don't-touch. */
  viewOnly?: boolean;
}

const INDEX = blockIndex as Record<string, string>;

// Non-eager glob → each blocks/<file>.json becomes its own lazy chunk. index.json
// is excluded (it's statically imported above as the address→chunk map).
const CHUNKS = import.meta.glob<{ default: Record<string, BlockSource> }>([
  '../data/blocks/*.json',
  '!../data/blocks/index.json',
]);

// Vendored per-project blocks: the index is eager (small, needed synchronously
// to resolve an address → chunk key); chunks stay lazy exactly like the
// bundled default's. import.meta.glob patterns must be static string literals,
// so every project's index/chunks are globbed once and grouped by the `<id>`
// path segment at call time (no dynamic currentProjectId() interpolation).
const VENDORED_INDEXES = import.meta.glob<{ default: Record<string, string> }>(
  '../data/projects/*/blocks/index.json',
  { eager: true },
);
const VENDORED_CHUNKS = import.meta.glob<{ default: Record<string, BlockSource> }>([
  '../data/projects/*/blocks/*.json',
  '!../data/projects/*/blocks/index.json',
]);

function projectIdFromGlobKey(key: string): string | null {
  const m = /\/projects\/([^/]+)\//.exec(key);
  return m ? m[1]! : null;
}

function vendoredIndexFor(id: string): Record<string, string> | undefined {
  const key = Object.keys(VENDORED_INDEXES).find((k) => projectIdFromGlobKey(k) === id);
  return key ? VENDORED_INDEXES[key]!.default : undefined;
}

/** The active project's address→chunk index (bundled for the sample, else vendored). */
function activeIndex(): Record<string, string> {
  const id = currentProjectId();
  return id === SAMPLE_ESTATE_ID ? INDEX : (vendoredIndexFor(id) ?? {});
}

/** The active project's lazy loader for one chunk file, or undefined if absent. */
function activeChunkLoader(
  fileBase: string,
): (() => Promise<{ default: Record<string, BlockSource> }>) | undefined {
  const id = currentProjectId();
  if (id === SAMPLE_ESTATE_ID) return CHUNKS[`../data/blocks/${fileBase}.json`];
  return VENDORED_CHUNKS[`../data/projects/${id}/blocks/${fileBase}.json`];
}

// Cache key includes the project id so two projects' same-named chunk files
// (e.g. both happen to extract a "main" chunk) never collide. Server-loaded
// chunks share this cache under a `<id>:server:` prefix.
const cache = new Map<string, Record<string, BlockSource>>();

/* ── the server-served source (api mode, any account but the sample) ─────────
 * The index is fetched ONCE per project and remembered — including a remembered
 * MISS (null), so a project with no active server data doesn't re-ask on every
 * block read and falls straight through to the vendored-or-empty rule. */
const serverIndexCache = new Map<string, Record<string, string> | null>();

function wantsServerBlocks(id: string): boolean {
  return isApiMode && id !== SAMPLE_ESTATE_ID;
}

async function serverIndexFor(id: string): Promise<Record<string, string> | null> {
  if (!serverIndexCache.has(id)) {
    const raw = await fetchServerBlockChunk(id, 'index');
    serverIndexCache.set(id, raw as Record<string, string> | null);
  }
  return serverIndexCache.get(id) ?? null;
}

async function serverChunkFor(
  id: string,
  fileBase: string,
): Promise<Record<string, BlockSource> | null> {
  const cacheKey = `${id}:server:${fileBase}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const raw = await fetchServerBlockChunk(id, fileBase);
  if (!raw) return null;
  const chunk = raw as Record<string, BlockSource>;
  cache.set(cacheKey, chunk);
  return chunk;
}

/** Test-only: forget the remembered server indexes (scope switches in tests). */
export function __resetServerBlocksForTests(): void {
  serverIndexCache.clear();
  cache.clear();
}

/** The full block for a resource address, or null when unknown (e.g. a brand-new
 * resource, or an estate change that outran the last extraction). */
export async function getBlockSource(address: string): Promise<BlockSource | null> {
  const id = currentProjectId();
  if (wantsServerBlocks(id)) {
    const sIndex = await serverIndexFor(id);
    if (sIndex) {
      const fileBase = sIndex[address];
      if (!fileBase) return null;
      const chunk = await serverChunkFor(id, fileBase);
      return chunk?.[address] ?? null;
    }
    // no active server data → the vendored-or-empty resolution below
  }
  const fileBase = activeIndex()[address];
  if (!fileBase) return null;
  const cacheKey = `${id}:${fileBase}`;
  let chunk = cache.get(cacheKey);
  if (!chunk) {
    const loader = activeChunkLoader(fileBase);
    if (!loader) return null;
    chunk = (await loader()).default;
    cache.set(cacheKey, chunk);
  }
  return chunk[address] ?? null;
}

/** Synchronous variant for already-loaded chunks (render paths after preload). */
export function peekBlockSource(address: string): BlockSource | null {
  const id = currentProjectId();
  if (wantsServerBlocks(id)) {
    const sIndex = serverIndexCache.get(id);
    if (sIndex) {
      const fileBase = sIndex[address];
      return fileBase ? (cache.get(`${id}:server:${fileBase}`)?.[address] ?? null) : null;
    }
    // index not fetched yet (or a remembered miss) → the local resolution below
    if (sIndex === null) {
      // remembered miss: fall through to vendored-or-empty
    } else {
      return null; // not loaded yet — peek never blocks
    }
  }
  const fileBase = activeIndex()[address];
  if (!fileBase) return null;
  return cache.get(`${id}:${fileBase}`)?.[address] ?? null;
}

/**
 * EVERY committed block of the active project, keyed by address — the corpus
 * the replace-dependents scan (lib/dependents.ts) searches for references to
 * a to-be-replaced address. Loads every chunk of the active project once
 * (same lazy loaders, same cache as getBlockSource) — on-demand only, from
 * the rare panel that needs a whole-estate answer, never on initial load.
 */
export async function allBlockSources(): Promise<Record<string, BlockSource>> {
  const id = currentProjectId();
  if (wantsServerBlocks(id)) {
    const sIndex = await serverIndexFor(id);
    if (sIndex) {
      const out: Record<string, BlockSource> = {};
      for (const fileBase of [...new Set(Object.values(sIndex))]) {
        const chunk = await serverChunkFor(id, fileBase);
        if (chunk) Object.assign(out, chunk);
      }
      return out;
    }
  }
  const fileBases = [...new Set(Object.values(activeIndex()))];
  const out: Record<string, BlockSource> = {};
  for (const fileBase of fileBases) {
    const cacheKey = `${id}:${fileBase}`;
    let chunk = cache.get(cacheKey);
    if (!chunk) {
      const loader = activeChunkLoader(fileBase);
      if (!loader) continue;
      chunk = (await loader()).default;
      cache.set(cacheKey, chunk);
    }
    Object.assign(out, chunk);
  }
  return out;
}
