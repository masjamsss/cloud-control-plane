import { statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildCatalogctlCached } from './helpers/catalogctlBuild';

/**
 * TEST-12 — createResourceParity.test.ts and scheduleWindowCheckParity.test.ts used to
 * each `go build` catalogctl into a fresh `mkdtempSync` dir on EVERY run: no reuse across
 * the two files in one `npm test` invocation, and none across separate invocations either.
 * This proves the fix's actual load-bearing property: a SECOND, independent call — from a
 * module instance that has never called `buildCatalogctlCached()` before, simulating a
 * separate vitest process finding the SAME cache directory a prior run left behind — reuses
 * the binary already on disk instead of rebuilding it.
 *
 * `vi.resetModules()` + a fresh dynamic import is what stands in for "a separate process"
 * here: it forces a brand-new module instance (so `catalogctlBuild.ts`'s in-memory
 * `cached` starts back at `undefined`, the same as a cold process), while the filesystem —
 * where the real persistence lives — is untouched. If the fix regressed to rebuilding on
 * every call, the second call below would write a NEW binary and its mtime would move;
 * with the fix, the second call finds the first call's binary already at the cache path and
 * returns it unchanged.
 */
describe('buildCatalogctlCached (TEST-12 shared build cache)', () => {
  it('a fresh module instance reuses the binary a prior instance already built, not a rebuild', async () => {
    const first = buildCatalogctlCached();
    if (first === null) {
      // Best-effort, same as both parity suites: no Go toolchain, nothing to prove here.
      return;
    }
    const mtimeBefore = statSync(first).mtimeMs;

    vi.resetModules();
    const fresh = await import('./helpers/catalogctlBuild');
    const second = fresh.buildCatalogctlCached();

    expect(second).toBe(first);
    expect(statSync(second!).mtimeMs).toBe(mtimeBefore);
  });
});
