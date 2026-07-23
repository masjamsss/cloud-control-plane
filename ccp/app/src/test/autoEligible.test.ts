import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0008: autoEligible is retired — it may exist in DATA (manifests) and in the
 * schema that tolerates it, but NO runtime code path may read it. This test makes
 * the retirement mechanical instead of remembered.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// Files allowed to mention autoEligible: the type/schema layer that tolerates the
// field. (The walk skips test/ and data/.)
const ALLOWED = new Set<string>(['types/manifest.ts', 'types/manifestSchema.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      return name === 'test' || name === 'data' ? [] : walk(p);
    }
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('ADR-0008 — autoEligible is inert', () => {
  it('no runtime source file reads autoEligible', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = f.slice(SRC.length + 1);
      if (ALLOWED.has(rel)) continue;
      if (readFileSync(f, 'utf8').includes('autoEligible')) offenders.push(rel);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
