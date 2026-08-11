import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ARCH-6 — the api reaches into the app package through a tsconfig path alias, and
 * nothing checked what it reached or what came back with it.
 *
 * Two separate defects hide behind one alias, so there are two rules here.
 *
 * ## The hazard (RULE A) — why `planSummarySchema.ts` is a hand-copy
 *
 * `ccp/api/tsconfig.json` maps `@app-lib/* -> ../app/src/lib/*` and `@/* -> ../app/src/*`.
 * TypeScript happily follows that alias, but a BARE module specifier inside one of those
 * app files (`import { z } from 'zod'`) is resolved **from that file's own directory** —
 * `ccp/app/src/lib/` — walking up through `ccp/app/node_modules`, `ccp/node_modules`,
 * `<repo>/node_modules`. It never looks in `ccp/api/node_modules`. And `ccp-api.yml` runs
 * `npm ci` **only in `ccp/api`** (the api job installs nothing under `ccp/app`), so in CI
 * every one of those directories is empty.
 *
 * The api depends on zod itself, which is what makes this so easy to get wrong: the import
 * looks obviously fine from the api's package.json, and it works on a developer machine
 * where `ccp/app/node_modules` happens to exist from an earlier `npm ci`.
 *
 * What happens in CI is worse than a build break, and the word the finding uses is the
 * right one — it is SILENT. Reproduced while writing this test, by moving
 * `ccp/app/node_modules` aside and importing a zod value through the alias:
 *
 *   - dev shape (app deps present): a nonsense property access on the inferred type is a
 *     hard `TS2339 Property 'thisFieldDoesNotExist' does not exist on type '{...}'`.
 *   - CI shape (app deps absent): the SAME nonsense access produces **no error at all**.
 *     `z` is unresolved, so `z.object(...)` is `any`, so `z.infer<...>` is `any`, and the
 *     api's own files stop being checked against the contract entirely.
 *
 * The only errors CI reports are `TS2307: Cannot find module 'zod'` attributed to
 * `../app/src/lib/planSummary.ts` — a file outside the api's `include`, outside its
 * ownership, and outside where anyone debugging an api failure would look. The build does
 * go red today, but for the wrong reason and pointing at the wrong file; and it goes red
 * only because tsc still reports diagnostics in that imported file. Anything that stops it
 * doing so (a `@ts-nocheck`, an `exclude`, a `.d.ts` boundary under `skipLibCheck`) turns
 * the red into a green that is checking nothing.
 *
 * RULE A states the invariant that makes the alias safe, rather than listing zod:
 * **no file the api reaches through the alias may import a bare module specifier at all**
 * (L-25 — write the rule, not the list). Relative imports, other aliased app files and
 * `resolveJsonModule` JSON are all fine; they resolve without any `node_modules`. This is
 * checked over the TRANSITIVE closure, because the import that breaks the api need not be
 * in the file the api names: `@app-lib/policy` is dependency-free itself and pulls in
 * `lib/projectScope.ts`, which is where a stray dependency would actually sit.
 *
 * ## The coupling (RULE B) — the allowlist
 *
 * The second half of the finding is that "the app's `lib/` cannot be refactored without
 * auditing the api's import graph", because that graph was written down nowhere. RULE B
 * is the written-down version: the exact set of app modules the api is allowed to reach.
 * Widening it is a deliberate edit with a reviewer, not a side effect of an import.
 *
 * ## Scope, stated honestly
 *
 * This is ARCH-6's declared PARTIAL — "until the package lands, an allowlist lint + a
 * copy-parity test is the acceptable partial". It does not create `ccp/shared`; it makes
 * the seam that exists observable and its failure mode loud. See `docs/audit/FIXES.md`
 * § ARCH-6 for why the full extraction was not attempted here.
 */

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_SRC = resolve(API_ROOT, '..', 'app', 'src');

/**
 * The app modules `ccp/api` is allowed to reach through `@app-lib/*` / `@/*`.
 *
 * Every entry is server-relevant shared domain, not a UI helper — that is the standard a
 * new entry has to meet. Adding one means the api now depends on an app-package file, so
 * the addition belongs in review alongside a reason.
 */
const ALLOWED_APP_MODULES = [
  // Shared types. Type-only, zod-free by construction (`@/types/planSummary` exists
  // precisely so `types/request.ts` never pulls zod into the api's graph).
  '@/types',
  // The approval-authority predicates the SERVER enforces (canRequest/canApprove).
  '@app-lib/permissions',
  // Policy defaults + the approvals-required derivation shared with the SPA.
  '@app-lib/policy',
  // The param-activation predicate: the SPA renders by it, the api validates by it.
  '@app-lib/dependsOn',
  // The shared redactor — one rule set for what never leaves the estate.
  '@app-lib/redact',
  // ARCH-13's single home for the project-id grammar.
  '@app-lib/projectId',
  // ARCH-7's closed status vocabulary.
  '@app-lib/requestStatus',
  // Test-only: the cross-layer HCL skeleton parity suite renders with the SPA's own
  // renderer and its baseline fixtures, which is the entire point of that suite.
  '@/lib/hclSkeleton',
  '@/test/fixtures/skeletons/baselines/values',
];

/** Every `.ts`/`.tsx` file under a directory. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

/**
 * Module specifiers imported (or re-exported) by a file.
 *
 * A text scan rather than a real parse, for the same reason `statusVocabulary.test.ts`
 * scans: the thing being checked is what the module GRAPH looks like to tsc's resolver,
 * and the resolver's input is the specifier string. Type-only imports are deliberately
 * included — `import type { X } from 'zod'` fails resolution exactly as hard as a value
 * import does.
 */
function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\n;])\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]!);
  }
  // Side-effect form: `import 'some-polyfill';`
  for (const m of text.matchAll(/(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

const isAliased = (spec: string) => spec.startsWith('@app-lib/') || spec.startsWith('@/');

/** `@app-lib/x -> <app>/src/lib/x`, `@/x -> <app>/src/x` — the tsconfig `paths` mapping. */
function aliasToPath(spec: string): string {
  return spec.startsWith('@app-lib/')
    ? join(APP_SRC, 'lib', spec.slice('@app-lib/'.length))
    : join(APP_SRC, spec.slice(2));
}

/** tsc's extension probing, in its order. */
function resolveFile(base: string): string | null {
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.json`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Aliased specifiers imported anywhere in the api, mapped to the api files importing them. */
function aliasEntryPoints(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of ['src', 'test', 'scripts']) {
    for (const file of walk(join(API_ROOT, dir))) {
      for (const spec of importSpecifiers(file)) {
        if (!isAliased(spec)) continue;
        const where = relative(API_ROOT, file);
        const list = found.get(spec);
        if (list) list.push(where);
        else found.set(spec, [where]);
      }
    }
  }
  return found;
}

/**
 * Every app file the api can reach through the alias, following relative and aliased
 * imports outward. `unresolved` collects specifiers that look like files but are not —
 * a broken alias must not be silently read as "nothing to check" (L-1).
 */
function aliasClosure(): { files: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue: string[] = [];

  for (const spec of aliasEntryPoints().keys()) {
    const p = resolveFile(aliasToPath(spec));
    if (p) queue.push(p);
    else unresolved.push(`${spec} (entry point)`);
  }

  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (file.endsWith('.json')) continue;
    for (const spec of importSpecifiers(file)) {
      if (spec.startsWith('.')) {
        const p = resolveFile(resolve(dirname(file), spec));
        if (p) queue.push(p);
        else unresolved.push(`${spec} (from ${relative(APP_SRC, file)})`);
      } else if (isAliased(spec)) {
        const p = resolveFile(aliasToPath(spec));
        if (p) queue.push(p);
        else unresolved.push(`${spec} (from ${relative(APP_SRC, file)})`);
      }
      // bare specifiers are RULE A's business, collected there
    }
  }
  return { files, unresolved };
}

describe('ARCH-6 — the @app-lib boundary is checked, not commented', () => {
  it('the scan finds the real import graph (sanity)', () => {
    // Every assertion below is of the form "nothing bad in this set". Each one passes
    // vacuously if the scan finds nothing, which is how a boundary check quietly stops
    // being a check (L-1). Pin the preconditions instead.
    const entries = aliasEntryPoints();
    expect(entries.size).toBeGreaterThan(5);
    expect([...entries.keys()]).toContain('@app-lib/permissions');

    const { files, unresolved } = aliasClosure();
    expect(unresolved, 'an import that resolves to nothing is an unchecked edge').toEqual([]);
    expect(files.size).toBeGreaterThan(10);

    // The closure must be TRANSITIVE, not just the directly-imported files. `projectScope`
    // is imported by no api file — it arrives via `@app-lib/policy` and
    // `lib/riskOverrides.ts`. If this stops holding, the walker has stopped walking and
    // RULE A is only checking the first hop, where the zod hazard already isn't.
    const reached = [...files].map((f) => relative(APP_SRC, f));
    expect(reached).toContain(join('lib', 'projectScope.ts'));
    expect(reached).not.toContain(join('lib', 'planSummary.ts')); // the copy exists so this stays true
  });

  it('RULE A — nothing the api reaches through the alias imports a package', () => {
    // THE HAZARD. A bare specifier here resolves from ccp/app, where the api's CI job
    // installs nothing — and the failure is a silent loss of typechecking in the api's own
    // files, not an error pointing at the offending import. See the header for the
    // reproduction. Stated as "no package at all" rather than "not zod" on purpose: the
    // next one will not be zod.
    const { files } = aliasClosure();
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) continue;
      for (const spec of importSpecifiers(file)) {
        if (spec.startsWith('.') || isAliased(spec)) continue;
        offenders.push(`${relative(APP_SRC, file)} imports '${spec}'`);
      }
    }
    expect(
      offenders,
      'A file ccp/api reaches through @app-lib/@ imports a package. That package resolves ' +
        'from ccp/app/node_modules, which the api CI job never installs — the api\'s types ' +
        'against this contract collapse to `any` and STOP BEING CHECKED, while the only ' +
        'error names a file in ccp/app. Either keep the file dependency-free, or do what ' +
        'store/planSummarySchema.ts does: an api-local copy pinned by a parity test.',
    ).toEqual([]);
  });

  it('RULE B — the api reaches only the app modules on the allowlist', () => {
    const reached = [...aliasEntryPoints().keys()].sort();
    const allowed = [...ALLOWED_APP_MODULES].sort();

    const unlisted = reached.filter((s) => !allowed.includes(s));
    expect(
      unlisted,
      'ccp/api now imports an app module that is not on the allowlist. This is the coupling ' +
        'ARCH-6 is about: every entry here is a file ccp/app cannot refactor freely. Add it ' +
        'to ALLOWED_APP_MODULES with a one-line reason, or keep the dependency out.',
    ).toEqual([]);

    const stale = allowed.filter((s) => !reached.includes(s));
    expect(
      stale,
      'An allowlist entry the api no longer imports. Delete it — a list that over-states ' +
        'the coupling stops being read, and this one exists to be read.',
    ).toEqual([]);
  });
});
