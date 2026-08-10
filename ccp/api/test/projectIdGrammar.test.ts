import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ID_RE as apiProjectIdRe } from '../src/projects';
import { PROJECT_ID_RE as appProjectIdRe } from '@app-lib/projectId';

/**
 * ARCH-13 — five verbatim copies of `/^[a-z][a-z0-9-]{1,31}$/` had drifted
 * into existence (`projects.ts`, `routes/drift.ts`, `routes/projectData.ts`,
 * `domain/drift.ts`, and the app's `lib/projectOnboarding.ts`); any future
 * change to the grammar would have needed all five edited in lockstep or
 * path-validation and registration would silently disagree. The api cannot
 * be imported by the app, so the only place a SINGLE, both-sides-reachable
 * home can live is `ccp/app/src/lib/` (the `@app-lib/*` alias — the same
 * direction `@app-lib/redact` already uses) — `projects.ts` now re-exports
 * `PROJECT_ID_RE` from there rather than declaring its own copy.
 */
describe('PROJECT_ID_RE — one home, re-exported (ARCH-13)', () => {
  it("the api's projects.ts re-export IS the app-lib constant — same object, not a copy", () => {
    // Reference equality: a `.source`/`.flags` string comparison would pass
    // even for two independently-declared regexes with identical patterns —
    // exactly the shape ARCH-13 found. Only a re-export (not a redeclaration)
    // guarantees they can never drift apart again.
    expect(apiProjectIdRe).toBe(appProjectIdRe);
  });

  it('matches valid ids and rejects invalid ones (sanity — still the same grammar)', () => {
    // Minimum length is 2: [a-z] then {1,31} more chars.
    for (const ok of ['ab', 'acme', 'my-project-1', 'a'.repeat(32)]) {
      expect(apiProjectIdRe.test(ok), ok).toBe(true);
    }
    for (const bad of ['', 'a', 'A', '1abc', '-abc', 'a'.repeat(33), '@control', '*']) {
      expect(apiProjectIdRe.test(bad), bad).toBe(false);
    }
  });
});

/**
 * No OTHER file in ccp/api/src declares its own copy of this pattern — a
 * structural guard so a future contributor reaching for "just inline the
 * regex, it's one line" is caught the same way the original five were,
 * mirroring this repo's existing per-file source-scan convention
 * (openapi.test.ts's DOC-13 check, statusVocabulary.test.ts).
 */
describe('no re-duplicated PROJECT_ID pattern anywhere else in ccp/api/src (ARCH-13)', () => {
  const API_SRC = new URL('../src', import.meta.url).pathname;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(name) ? [p] : [];
    });
  }

  it('the literal pattern appears exactly once in ccp/api/src — inside projectId.ts is not reachable from here, so ZERO occurrences in the api tree is the expected count', () => {
    // The pattern's canonical text form, exactly as every one of the five
    // duplicates spelled it. The api's own copy is gone (re-exported
    // instead); the app's canonical copy lives in ccp/app/src/lib/projectId.ts,
    // outside this walk's root.
    const needle = /\/\^\[a-z\]\[a-z0-9-\]\{1,31\}\$\//;
    const offenders: string[] = [];
    for (const file of walk(API_SRC)) {
      if (needle.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
