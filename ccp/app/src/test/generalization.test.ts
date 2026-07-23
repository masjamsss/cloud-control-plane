import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEstateDenylist } from '../../scripts/lib/estateDenylist';

/**
 * The generalization lint (Task 6 — the last of the R3 reusability work).
 * src/data/ is where THIS estate's own facts belong (project.json, manifests,
 * inventory) — everywhere else, app code must read them as data, never embed
 * them as a literal. Task 5 moved the one remaining offender (a timezone literal
 * in lib/datetime.ts) into project data; this test makes the guarantee
 * mechanical and permanent, the same way standalone.test.ts does for the
 * no-LLM/no-network invariant — same walk/offenders pattern, copied structure.
 *
 * Exclusions (beyond src/test/, which standalone.test.ts also excludes):
 *   - src/data/    — project data is ALLOWED to be project-specific.
 *   - src/config.ts — the documented back-compat shim over project data
 *     (see its own docblock): it re-exports resolved project config under
 *     legacy names, but never itself hardcodes a literal.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'data' || name === 'test') return [];
      return walk(p);
    }
    if (p === join(SRC, 'config.ts')) return [];
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const files = walk(SRC);

/**
 * File → substrings to scrub from each line before matching. Empty today —
 * there are no sanctioned identifiers. Per Task 6 Step 1, a REAL offender found
 * by this test must be fixed by moving the literal into project data (the Task 5
 * pattern) — never by adding it here. Widening this set requires a STOP.
 */
const ALLOWED: Record<string, string[]> = {};

// The banned literals are NOT hardcoded here — they come from the resolved estate
// denylist (empty in the committed public built-in; real only in the untracked
// .estate-denylist.json). A public checkout therefore scans with an empty FORBIDDEN
// and the "no offenders" assertion passes trivially; the private deployment's CI
// materializes the denylist so this guard runs at full strength there. Sourcing them
// (instead of hardcoding masjamsss / the repo name / account / region / tz) is what
// keeps the guard real without naming a single estate value in committed test source.
// See scripts/lib/estateDenylist.ts.
const dl = loadEstateDenylist();
const FORBIDDEN = [...dl.estateTerms, ...dl.accountIds, ...dl.region];

describe('generalization lint — project literals are data, never code', () => {
  it('scans a real source tree (sanity)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no file outside src/data, src/test, or src/config.ts contains a project-specific literal', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(SRC.length + 1);
      const scrubList = ALLOWED[rel] ?? [];
      const text = readFileSync(f, 'utf8');
      for (const line of text.split('\n')) {
        // Only flag code, not prose in comments (same convention as standalone.test.ts).
        const code = line.split('//')[0]!;
        const scrubbed = scrubList.reduce((s, allowed) => s.split(allowed).join(''), code);
        for (const pat of FORBIDDEN) {
          if (scrubbed.includes(pat)) offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
