import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * FE-14 — `handleStartCheck`/`handleGenerate`'s post-trigger
 * `void refreshStatus()` had no `active` flag and no project check, unlike
 * the page's main status effect. A late response after a project switch (or
 * unmount) mid-flight wrote stale/foreign state — `getDriftStatus()` reads
 * the *current* scope at call time, so the write could land under the WRONG
 * project's page. Fixed with a ref-based guard mirroring the main effect's
 * own scoped `active` flag: `refreshStatus` captures the project id right
 * before its request goes out and discards the response if that project (or
 * mountedness) no longer matches by the time it resolves.
 *
 * DriftPage itself can't be driven through a real trigger→response→
 * project-switch race without jsdom (none in this repo — see TEST-7) and its
 * data loading runs in effects, which `renderToStaticMarkup` never fires —
 * so this is pinned at the source level, the same technique router.tsx's own
 * registration tests already use.
 */
describe('DriftPage — refreshStatus discards a stale (post-switch/unmount) response (FE-14)', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(SRC, 'features/drift/DriftPage.tsx'), 'utf8');

  it('refreshStatus captures the project id before the request, and checks it (plus mountedness) after', () => {
    const start = source.indexOf('const refreshStatus = async');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('};', start));
    expect(body).toContain('const forProjectId = projectIdRef.current');
    expect(body).toMatch(
      /if \(!mountedRef\.current \|\| projectIdRef\.current !== forProjectId\) return;/,
    );
    // The guard runs BEFORE the state write, not after.
    const guardIdx = body.indexOf('!mountedRef.current');
    const writeIdx = body.indexOf('setStatus(outcome.value)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(guardIdx);
  });

  it('mountedRef flips false on unmount — a cleanup-only effect, [] deps', () => {
    expect(source).toMatch(/mountedRef\.current = false;\s*\},\s*\[\],?\s*\);/);
  });

  it('projectIdRef tracks the CURRENT project every render (no dependency array — always fresh)', () => {
    const idx = source.indexOf('projectIdRef.current = projectId;');
    expect(idx).toBeGreaterThan(-1);
  });

  it('both post-trigger call sites (Start check, Fix the drift/generate) go through refreshStatus, not a bare getDriftStatus() call', () => {
    // If a future edit added a THIRD trigger handler that called
    // api.getDriftStatus() directly (bypassing the guard), this would still
    // pass — so instead assert there are exactly the two known callers of
    // the guarded helper and no OTHER site calls the unguarded API method
    // outside refreshStatus itself and the main effect.
    const refreshCalls = (source.match(/void refreshStatus\(\)/g) ?? []).length;
    expect(refreshCalls).toBe(2);
    const rawApiCalls = (source.match(/api\.getDriftStatus\(\)/g) ?? []).length;
    // The main effect's own call + refreshStatus's own call = 2 total sites
    // that ever touch the raw client method; every trigger handler goes
    // through refreshStatus instead of calling it directly.
    expect(rawApiCalls).toBe(2);
  });
});
