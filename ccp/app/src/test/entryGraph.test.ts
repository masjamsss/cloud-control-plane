import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * PERF-5 — what the first paint has to download, checked at the source level.
 *
 * The entry chunk was 3,767 kB (665 kB gzip) because `lib/api.ts` and `lib/httpApi.ts`
 * statically imported `@/data/manifests`, which eagerly globs 115 manifest JSONs
 * (3.9 MB on disk) and zod-parses them at module-evaluation time. Every visitor paid
 * for the whole catalog before anything rendered — including the login page, which
 * cannot use a catalog it has no session for.
 *
 * The fix (a dynamic import behind `lib/bundledCatalog.ts`, plus route-splitting the
 * heavy leaves) is one edit away from silently coming undone: re-adding a plain
 * `import { manifests } from '@/data/manifests'` to any entry-graph module puts all
 * 3.9 MB back, and nothing would say so — the app would still work, still typecheck,
 * still pass 2,700 tests, just three times heavier. So the property gets a test.
 *
 * The graph walked here is the STATIC one — `import x from` / `export … from` plus
 * eager `import.meta.glob` — because those are exactly the two things Rollup folds
 * into the importing chunk. `import()` and non-eager globs are deliberately NOT
 * followed: they are the mechanism of the fix, not a leak in it.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(SRC, 'main.tsx');

/** Bytes of bundled JSON the entry graph may pull in before first paint. The
 * point of the number is that it is nowhere near 3.9 MB; the headroom over
 * today's actual figure is deliberate, so ordinary data edits don't fail the
 * suite while a re-eagerized catalog still does by an order of magnitude. */
const ENTRY_JSON_BUDGET_BYTES = 400 * 1024;

/** `@/x` → `src/x`; everything else relative to the importing file. Bare
 * specifiers (react, zod, …) resolve to nothing — node_modules is not the
 * subject here, and following it would walk the whole dependency tree. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Strip block and line comments so a specifier quoted in prose is not followed. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every specifier that lands in the SAME chunk as `file`.
 *
 * `import type` is excluded: it is erased before Rollup sees it, so following it
 * would report bytes that never ship. `import(` is excluded for the same reason
 * in reverse — it is precisely the boundary this test exists to keep.
 */
function staticImportsOf(file: string): string[] {
  const text = stripComments(readFileSync(file, 'utf8'));
  const specs: string[] = [];
  const re = /(?:^|\s)(?:import|export)(\s[\s\S]*?)?\sfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const clause = m[1] ?? '';
    if (/^\s+type\s/.test(clause)) continue; // `import type { X } from` — erased
    specs.push(m[2]!);
  }
  // Side-effect-only imports (`import './x.css'`) have no `from`.
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(text)) !== null) specs.push(m[1]!);
  return specs;
}

/** Files pulled in by `import.meta.glob(pattern, { eager: true })` in `file`. */
function eagerGlobFilesOf(file: string): string[] {
  const text = stripComments(readFileSync(file, 'utf8'));
  const out: string[] = [];
  // Match a whole glob call, non-greedy to the first `)` that closes it. The
  // patterns in this codebase are static literals (Vite requires it), so the
  // literals inside the call are the whole story.
  const call = /import\.meta\.glob\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text)) !== null) {
    const body = m[1]!;
    if (!/eager\s*:\s*true/.test(body)) continue; // lazy → its own chunk, not ours
    for (const lit of body.matchAll(/['"]([^'"]+)['"]/g)) {
      const pattern = lit[1]!;
      if (pattern.startsWith('!')) continue; // negation, not a source of files
      if (!pattern.includes('*')) continue; // an option key, not a pattern
      for (const hit of globSync(pattern, { cwd: dirname(file) })) {
        out.push(resolve(dirname(file), hit));
      }
    }
  }
  return out;
}

/** Everything Rollup would fold into the entry chunk, reachable from main.tsx. */
function entryGraph(): Set<string> {
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue; // JSON is a leaf
    for (const spec of staticImportsOf(file)) {
      const target = resolveSpecifier(spec, file);
      if (target && !seen.has(target)) queue.push(target);
    }
    for (const target of eagerGlobFilesOf(file)) {
      if (!seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

const graph = entryGraph();
const rel = (f: string): string => relative(SRC, f);

describe('PERF-5 — the first-paint graph', () => {
  /**
   * The walk has to be able to fail (L-1). A resolver that silently returned
   * null for everything would make every assertion below pass by finding
   * nothing — so pin modules that MUST be reachable from main.tsx, including
   * one behind an `@/` alias and one behind a directory index.
   */
  it('actually walks the entry graph', () => {
    expect(existsSync(ENTRY), `${ENTRY} must exist`).toBe(true);
    expect(graph.size).toBeGreaterThan(50);
    for (const must of ['router.tsx', 'lib/api.ts', 'lib/httpApi.ts', 'components/AppShell.tsx']) {
      expect([...graph].map(rel), `${must} should be on the entry graph`).toContain(must);
    }
  });

  it('the bundled sample catalog is NOT on the entry graph', () => {
    const catalog = [...graph].map(rel).filter((f) => f.startsWith('data/manifests/'));
    expect(
      catalog,
      'Something statically imports @/data/manifests again — that folds 3.9 MB of manifest JSON ' +
        'plus a full zod parse back into the entry chunk, for every visitor including the login ' +
        'page. Load it through lib/bundledCatalog.ts (dynamic import) instead.',
    ).toEqual([]);
  });

  it('the heavy leaf routes are code-split, not folded into the entry', () => {
    const eager = [...graph]
      .map(rel)
      .filter((f) =>
        /^features\/(drift\/DriftPage|approvals\/ApprovalsQueue|requests\/RequestDetail|services\/(ResourceDetail|ServiceConsole)|request\/(RequestForm|BulkRequestForm|BeyondCatalogForm|ProvisionService)|dashboard\/LeadDashboard|admin\/)/.test(
          f,
        ),
      );
    expect(
      eager,
      'These pages are 350–950 lines each and most sessions never open them; the router must ' +
        'reach them through lazy(() => import(…)), not a static import.',
    ).toEqual([]);
  });

  it('bundled JSON on the entry graph stays within the first-paint budget', () => {
    const jsonFiles = [...graph].filter((f) => f.endsWith('.json'));
    const bytes = jsonFiles.reduce((n, f) => n + statSync(f).size, 0);
    const breakdown = jsonFiles
      .map((f) => `${rel(f)} ${(statSync(f).size / 1024).toFixed(0)}kB`)
      .sort()
      .join('\n');
    expect(
      bytes,
      `entry-graph JSON is ${(bytes / 1024).toFixed(0)} kB, over the ${ENTRY_JSON_BUDGET_BYTES / 1024} kB budget:\n${breakdown}`,
    ).toBeLessThan(ENTRY_JSON_BUDGET_BYTES);
  });
});
