import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ARCH-6 — `ccp/api/src/store/planSummarySchema.ts` is a hand-maintained copy of
 * `ccp/app/src/lib/planSummary.ts`, carrying the instruction "keep this edited in lockstep
 * with it (same fields, same bounds)" and, until this file, nothing that checked it was.
 *
 * The copy is not a mistake — see `appLibBoundary.test.ts` for why importing the canonical
 * file through `@app-lib` silently stops the api typechecking against it in CI. A copy with
 * a parity test is the right answer for a zod schema at this seam. A copy with a comment is
 * not, and that is what this closes: `test/planSummary.test.ts` exercises the schema's
 * BEHAVIOUR against representative plans, which stays green no matter how far the two files
 * drift, because it only ever loads one of them.
 *
 * ## What "parity" means here, and why it is not byte equality
 *
 * The two files are deliberately not identical: the canonical one also carries the SPA's
 * rendering helpers (`isPlanSummary`, `planHeadline`, `actionLabel`) which the api has no
 * use for. The copy is a SUBSET. So the rule is asymmetric and stated over declarations:
 *
 *   every declaration in the api's copy must exist in the canonical file with an
 *   identical body, once comments and whitespace are normalised away.
 *
 * That is what makes it a rule rather than a list of fields (L-25): it pins the five size
 * bounds, the action enum, all four schemas and their inferred types today, and it pins
 * whatever is added tomorrow without anyone remembering to extend it. A field added to the
 * canonical schema and not to the copy fails; a bound loosened on either side fails.
 *
 * ## The one exemption, and why it is sound rather than convenient
 *
 * `PlanSummary` is declared differently on the two sides on purpose:
 *
 *   - api  : `export type PlanSummary = z.infer<typeof PlanSummarySchema>;`
 *   - app  : `export type { PlanSummary };` re-exported from the zod-FREE
 *            `@/types/planSummary`, and pinned to the schema by a compile-time
 *            bidirectional-`extends` guard.
 *
 * The app cannot derive it from zod, because `types/request.ts` is in the api's own import
 * closure and must stay zod-free. So equality is established transitively instead: the
 * schemas are textually identical (checked above), so their `z.infer`s are identical, and
 * the canonical file's guard pins its zod-free type to its schema. Both halves of that
 * argument are ASSERTED below rather than assumed — an exemption that rests on a mechanism
 * has to check the mechanism is still there, or it is just a hole with a paragraph over it.
 *
 * ## Read as text, never imported
 *
 * This test reads the canonical file with `readFileSync`. Importing it would pull zod
 * through the alias and reproduce the exact defect the seam exists to avoid — the parity
 * test would then be the thing that broke CI. That constraint is also why the check is
 * textual rather than a behavioural comparison of the two schemas: the api job cannot load
 * the canonical schema at all.
 */

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COPY = join(API_ROOT, 'src', 'store', 'planSummarySchema.ts');
const CANONICAL = join(API_ROOT, '..', 'app', 'src', 'lib', 'planSummary.ts');

/**
 * Strip comments without touching string contents. A naive `//` strip would eat the tail of
 * `.startsWith('https://')` — identically on both sides, so parity would still hold while
 * quietly checking less of the line that carries the runUrl rule.
 */
function stripComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    if (quote) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Top-level `const`/`type` declarations, as name -> normalised body. Bracket-balanced so a
 * multi-line `z.object({...})` is captured whole; `export` is normalised away so the check
 * is about the contract rather than each side's visibility choices.
 */
function declarations(src: string): Map<string, string> {
  const lines = stripComments(src).split('\n');
  const decls = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?(?:const|type)\s+([A-Za-z_$][\w$]*)/.exec(lines[i]!);
    if (!m) continue;
    let depth = 0;
    let text = '';
    let j = i;
    let done = false;
    while (j < lines.length && !done) {
      for (const ch of lines[j]!) {
        text += ch;
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (ch === ';' && depth === 0) {
          done = true;
          break;
        }
      }
      text += '\n';
      j++;
    }
    decls.set(m[1]!, text.replace(/^export\s+/, '').replace(/\s+/g, ' ').trim());
    i = j - 1;
  }
  return decls;
}

/**
 * Declared on both sides but not textually comparable. Exactly one entry, justified in the
 * header and mechanically re-checked by the test below it.
 */
const STRUCTURALLY_PINNED = new Set(['PlanSummary']);

describe('ARCH-6 — the planSummary copy is pinned to its canonical source', () => {
  const copy = declarations(readFileSync(COPY, 'utf8'));
  const canonical = declarations(readFileSync(CANONICAL, 'utf8'));

  it('both files parse into real declaration sets (sanity)', () => {
    // The comparison below iterates the copy's declarations. An extractor that silently
    // matched nothing — a syntax change, a move to a class, a regex that stopped firing —
    // would make every assertion pass over an empty set (L-1).
    expect(copy.size).toBeGreaterThan(10);
    expect(canonical.size).toBeGreaterThan(10);
    for (const required of ['PLAN_ACTIONS', 'PlanSummarySchema', 'MAX_RESOURCE_CHANGES']) {
      expect(copy.has(required), `copy is missing ${required}`).toBe(true);
      expect(canonical.has(required), `canonical is missing ${required}`).toBe(true);
    }
    // And the extractor must capture BODIES, not just names — a bracket-balancing bug that
    // truncated at the first line would still populate the map, and every schema would
    // then compare equal as `const X = z.object({`.
    expect(copy.get('PlanSummarySchema')).toContain('resourceChanges');
    expect(copy.get('PlanSummarySchema')).toContain('runUrl');
  });

  it('every declaration in the api copy is byte-identical in the canonical source', () => {
    const drifted: string[] = [];
    for (const [name, body] of copy) {
      if (STRUCTURALLY_PINNED.has(name)) continue;
      const other = canonical.get(name);
      if (other === undefined) {
        drifted.push(`${name}: absent from ccp/app/src/lib/planSummary.ts`);
      } else if (other !== body) {
        drifted.push(`${name}:\n    api copy: ${body}\n    canonical: ${other}`);
      }
    }
    expect(
      drifted,
      'ccp/api/src/store/planSummarySchema.ts has drifted from its canonical source ' +
        'ccp/app/src/lib/planSummary.ts. They are two copies of ONE wire contract — the ' +
        'parser (scripts/plan-summary.mjs) produces it, the api validates and stores it, ' +
        'the SPA renders it. Edit both, or the api will accept a summary the SPA cannot ' +
        'render (or refuse one it can).',
    ).toEqual([]);
  });

  it('the PlanSummary exemption still rests on the two pins that justify it', () => {
    // Pin 1 — the api's type IS its schema's inferred type, so the textual schema parity
    // above carries it. If someone hand-writes the interface instead, parity no longer
    // implies type equality and this exemption is unsound.
    expect(
      copy.get('PlanSummary'),
      'the api copy must derive PlanSummary from its own schema, not restate it',
    ).toContain('z.infer<typeof PlanSummarySchema>');

    // Pin 2 — the canonical file's compile-time guard, which ties the zod-free
    // `@/types/planSummary` to the same schema in BOTH directions. Matched on the shape of
    // the guard rather than its variable name: what has to survive is the bidirectional
    // extends-check, not what it is called.
    const canonicalSrc = stripComments(readFileSync(CANONICAL, 'utf8')).replace(/\s+/g, ' ');
    expect(
      canonicalSrc,
      'the canonical file no longer pins its zod-free PlanSummary type to PlanSummarySchema, ' +
        'so schema parity no longer proves the two PlanSummary types agree',
    ).toContain('z.infer<typeof PlanSummarySchema> extends PlanSummary');
    expect(canonicalSrc).toContain('PlanSummary extends z.infer<typeof PlanSummarySchema>');
  });
});
