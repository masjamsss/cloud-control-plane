import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * TEST-12 — createResourceParity.test.ts and scheduleWindowCheckParity.test.ts each
 * `go build`ed their own copy of catalogctl into a fresh `mkdtempSync` dir on EVERY
 * vitest invocation, cold-GOCACHE or not. Measured directly (`go clean -cache` then
 * one file alone): an ~18s "collect" phase — the module-scope build running before any
 * test executes — collapsing to ~0.1s once a cached binary already exists at this
 * file's cache path. That 18s is paid at minimum ONCE per `npm test` run under the old
 * per-file-fresh-build code (worse if the two files' builds don't fully overlap in
 * GOCACHE) and, on a CI runner with no persisted GOCACHE between jobs, on every single
 * run. (createResourceParity.test.ts's OWN ~65s of test-body time — ~30
 * `spawnSync`-the-built-binary calls, one per case — is a separate cost this cache does
 * not touch; TEST-12's recommendation is "build once", not "make every case fast".)
 *
 * Both files now share this one cache: a build keyed on a content hash of
 * tools/catalogctl's own source (go.mod, go.sum, every *.go file — hashed rather than
 * `git rev-parse`'d so a DIRTY working tree, mid-edit, still invalidates the cache
 * correctly instead of silently testing stale bytes), landing at a stable path under
 * the OS tmp dir. A second `npm test` run — or the SECOND parity file in the same run
 * — that sees no source change reuses the binary instead of rebuilding it.
 *
 * Built to a fresh per-attempt tmp path first, then renamed into the cached path:
 * rename() is atomic on the filesystems this runs on (Linux CI, and typical local
 * dev), so a reader can never observe a partially-written binary at the cache path,
 * and two parity files racing to build the SAME unchanged source at worst both
 * compile once each and the second rename is a harmless overwrite with an
 * equivalent binary (Go build output need not be byte-identical to be correct).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../../..');
const CATALOGCTL_DIR = join(REPO_ROOT, 'tools/catalogctl');
const BIN_NAME = process.platform === 'win32' ? 'catalogctl.exe' : 'catalogctl';

/** sha256 of every go.mod/go.sum/*.go file under tools/catalogctl (path + content),
 * excluding testdata (fixtures, not build inputs). Deterministic regardless of
 * filesystem walk order (paths sorted at each directory level). */
function sourceHash(): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'testdata' || name.startsWith('.')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (name !== 'go.mod' && name !== 'go.sum' && extname(name) !== '.go') continue;
      hash.update(p.slice(CATALOGCTL_DIR.length));
      hash.update(readFileSync(p));
    }
  };
  walk(CATALOGCTL_DIR);
  return hash.digest('hex').slice(0, 16);
}

// Memoized per test-worker process too — vitest may run both parity files in the
// same worker, in which case the second call never even touches the filesystem cache.
let cached: string | null | undefined;

/** Builds (or reuses a cached build of) the real catalogctl binary; returns null
 * (never throws) if Go is unavailable or the build fails — both parity suites treat
 * that as "skip the live cross-check", never a failure (see either file's header). */
export function buildCatalogctlCached(): string | null {
  if (cached !== undefined) return cached;
  try {
    const key = sourceHash();
    const cacheDir = join(tmpdir(), 'ccp-catalogctl-parity-cache', `catalogctl-${key}`);
    const finalBin = join(cacheDir, BIN_NAME);
    if (existsSync(finalBin)) {
      cached = finalBin;
      return cached;
    }
    const buildDir = mkdtempSync(join(tmpdir(), 'catalogctl-build-'));
    const tmpBin = join(buildDir, BIN_NAME);
    const res = spawnSync('go', ['build', '-o', tmpBin, './cmd/catalogctl'], {
      cwd: CATALOGCTL_DIR,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (res.status !== 0 || !existsSync(tmpBin)) {
      cached = null;
      return cached;
    }
    mkdirSync(cacheDir, { recursive: true });
    try {
      renameSync(tmpBin, finalBin);
      cached = finalBin;
    } catch {
      // Cross-device link or a losing race on some platform — tmpBin itself is a
      // perfectly good binary, just not left behind for the next run to find.
      cached = tmpBin;
    }
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}
