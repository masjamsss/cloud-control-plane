import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DOC-9 — `ccp/README.md:139-143` designates `ccp/api/README.md` as "the place
 * every environment variable the api reads is documented," but four operator-
 * facing arming/freeze knobs (CCP_APPLY_FROZEN, CCP_APPLY_AUTO_REVERT,
 * CCP_DRIFT_IMPORT, CCP_DRIFT_CHECK_CMD) were readable only in code comments
 * or a different doc entirely. This test derives BOTH sides mechanically —
 * every `process.env.CCP_*` / `env.CCP_*` reference under `src/`, and every
 * `CCP_*` token across the deploy-reference surfaces this repo actually
 * ships — so the completeness claim is enforced, not re-asserted by hand at
 * the next env var addition (L-25).
 *
 * A var counts as "documented" if it appears in ANY of: this api's own
 * README, either .env.example, or docker-compose.yml — mirroring how DOC-9
 * itself judged the gap (the scanner/forge/instance families are covered in
 * the compose/env-example surfaces, not this README, and that was fine).
 */

function findTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      findTsFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

describe('DOC-9: every CCP_* env var the api reads is documented somewhere operator-facing', () => {
  it('has no CCP_* var referenced in src/ that is absent from every deploy-reference surface', () => {
    const apiRoot = join(__dirname, '..');
    const repoRoot = join(apiRoot, '..', '..');

    const srcDir = join(apiRoot, 'src');
    const files = findTsFiles(srcDir);
    const varRe = /(?:process\.env\.|env\.)(CCP_[A-Z_]+)/g;

    const fromCode = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(varRe)) {
        if (m[1]) fromCode.add(m[1]);
      }
    }
    expect(fromCode.size).toBeGreaterThan(10); // extractor sanity (L-1)

    const docSurfaces = [
      join(apiRoot, 'README.md'),
      join(repoRoot, 'ccp', '.env.example'),
      join(apiRoot, '.env.example'),
      join(repoRoot, 'ccp', 'docker-compose.yml'),
    ];
    const tokenRe = /CCP_[A-Z_]+/g;
    const fromDocs = new Set<string>();
    for (const path of docSurfaces) {
      const text = readIfExists(path);
      for (const m of text.matchAll(tokenRe)) {
        fromDocs.add(m[0]);
      }
    }
    expect(fromDocs.size).toBeGreaterThan(10); // extractor sanity (L-1)

    const undocumented = [...fromCode].filter((v) => !fromDocs.has(v));
    expect(
      undocumented,
      `these env vars are read in src/ but appear in none of ${docSurfaces.map((p) => p.replace(repoRoot, '')).join(', ')}`,
    ).toEqual([]);
  });
});
