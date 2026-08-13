import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { deployProblems, deployWarnings } from '../src/deploy';

/**
 * Task 2 — production start + config surface. The pure preflight (deployProblems)
 * is the decision logic; a spawned process proves the entrypoint actually FAILS
 * CLOSED (non-zero exit) on an insecure config rather than serving.
 */

const PROD = { NODE_ENV: 'production' } as const;
// A fully-good production baseline: durable store (no CCP_STORE), CORS set,
// Secure default ON, TOTP key present. Individual cases break exactly one thing.
const GOOD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  CCP_CORS_ORIGIN: 'https://ccp.example.com',
  CCP_TOTP_KEY: 'a-stable-high-entropy-key',
};

describe('deployProblems (production preflight)', () => {
  it('development is always deployable (no constraints)', () => {
    expect(deployProblems({ NODE_ENV: 'development' })).toEqual([]);
    expect(deployProblems({})).toEqual([]);
    // even a memory store / no CORS is fine in dev
    expect(deployProblems({ NODE_ENV: 'development', CCP_STORE: 'memory' })).toEqual([]);
  });

  it('a fully-configured production env is deployable', () => {
    expect(deployProblems(GOOD)).toEqual([]);
  });

  it('refuses a non-durable memory store in production', () => {
    const p = deployProblems({ ...GOOD, CCP_STORE: 'memory' });
    expect(p.some((x) => /CCP_STORE=memory/.test(x))).toBe(true);
  });

  it('refuses Secure cookies explicitly disabled in production', () => {
    const p = deployProblems({ ...GOOD, CCP_SECURE_COOKIES: 'false' });
    expect(p.some((x) => /CCP_SECURE_COOKIES/.test(x))).toBe(true);
  });

  it('refuses an empty CORS origin unless same-origin is acknowledged', () => {
    const noCors = { ...PROD, CCP_TOTP_KEY: 'k' };
    expect(deployProblems(noCors).some((x) => /CCP_CORS_ORIGIN/.test(x))).toBe(true);
    // explicit same-origin escape hatch clears exactly that problem
    expect(deployProblems({ ...noCors, CCP_SAME_ORIGIN: '1' }).some((x) => /CCP_CORS_ORIGIN/.test(x))).toBe(false);
  });

  it('refuses SameSite=None without Secure', () => {
    const p = deployProblems({ ...GOOD, CCP_COOKIE_SAMESITE: 'None', CCP_SECURE_COOKIES: 'false' });
    expect(p.some((x) => /SAMESITE=None requires Secure/i.test(x))).toBe(true);
  });

  it('refuses a missing TOTP key in production', () => {
    const { CCP_TOTP_KEY: _omit, ...noKey } = GOOD;
    expect(deployProblems(noKey).some((x) => /CCP_TOTP_KEY/.test(x))).toBe(true);
  });
});

/* ── ARCH-11: arming-flag combination warnings (advisory, never fatal) ──────── */

describe('deployWarnings (ARCH-11 — dead sub-flag combinations)', () => {
  it('a blank env has nothing to warn about', () => {
    expect(deployWarnings({})).toEqual([]);
  });

  it('warns on each of the three drift sub-flags armed without the top-level CCP_DRIFT', () => {
    expect(deployWarnings({ CCP_DRIFT_PROPOSALS: '1' }).some((w) => /CCP_DRIFT_PROPOSALS=1/.test(w) && /CCP_DRIFT is not/.test(w))).toBe(true);
    expect(deployWarnings({ CCP_DRIFT_IMPORT: '1' }).some((w) => /CCP_DRIFT_IMPORT=1/.test(w) && /CCP_DRIFT is not/.test(w))).toBe(true);
    expect(deployWarnings({ CCP_DRIFT_RESTORE: '1' }).some((w) => /CCP_DRIFT_RESTORE=1/.test(w) && /CCP_DRIFT is not/.test(w))).toBe(true);
    // all three at once — all three warnings, not just the first
    const all = deployWarnings({ CCP_DRIFT_PROPOSALS: '1', CCP_DRIFT_IMPORT: '1', CCP_DRIFT_RESTORE: '1' });
    expect(all).toHaveLength(3);
  });

  it('CCP_DRIFT=1 clears every one of the three drift sub-flag warnings', () => {
    expect(
      deployWarnings({
        CCP_DRIFT: '1',
        CCP_DRIFT_PROPOSALS: '1',
        CCP_DRIFT_IMPORT: '1',
        CCP_DRIFT_RESTORE: '1',
      }),
    ).toEqual([]);
  });

  it('warns on CCP_EXECUTOR=terraform without CCP_SCHEDULER, and names the bundle as the actual bundle-lane knob', () => {
    const w = deployWarnings({ CCP_EXECUTOR: 'terraform' });
    expect(w.some((x) => /CCP_EXECUTOR=terraform/.test(x) && /CCP_SCHEDULER/.test(x) && /CCP_BUNDLE_TRIGGER_CMD/.test(x))).toBe(true);
  });

  it('CCP_SCHEDULER=1 clears the executor warning', () => {
    expect(deployWarnings({ CCP_EXECUTOR: 'terraform', CCP_SCHEDULER: '1' })).toEqual([]);
  });

  it('a dry-run executor (unset/anything but "terraform") never warns, scheduler armed or not', () => {
    expect(deployWarnings({ CCP_EXECUTOR: 'dry-run' })).toEqual([]);
    expect(deployWarnings({})).toEqual([]);
  });

  it('warns on a half-armed bundle — missing exactly one of the two command vars', () => {
    const gateOnly = deployWarnings({ CCP_BUNDLE: '1', CCP_BUNDLE_GATE_CMD: 'echo gate' });
    expect(gateOnly.some((w) => /CCP_BUNDLE_TRIGGER_CMD/.test(w) && !/CCP_BUNDLE_GATE_CMD is not/.test(w))).toBe(true);

    const triggerOnly = deployWarnings({ CCP_BUNDLE: '1', CCP_BUNDLE_TRIGGER_CMD: 'echo trigger' });
    expect(triggerOnly.some((w) => /CCP_BUNDLE_GATE_CMD/.test(w))).toBe(true);

    const neither = deployWarnings({ CCP_BUNDLE: '1' });
    expect(neither.some((w) => /CCP_BUNDLE_GATE_CMD and CCP_BUNDLE_TRIGGER_CMD/.test(w) && /are not/.test(w))).toBe(true);
  });

  it('a fully-armed bundle (all three) never warns', () => {
    expect(
      deployWarnings({
        CCP_BUNDLE: '1',
        CCP_BUNDLE_GATE_CMD: 'echo gate',
        CCP_BUNDLE_TRIGGER_CMD: 'echo trigger',
      }),
    ).toEqual([]);
  });

  it('CCP_BUNDLE unset never warns even with the command vars present (nothing armed to begin with)', () => {
    expect(
      deployWarnings({ CCP_BUNDLE_GATE_CMD: 'echo gate', CCP_BUNDLE_TRIGGER_CMD: 'echo trigger' }),
    ).toEqual([]);
  });

  it('warns when a GitHub App is configured but the scanner is not armed', () => {
    expect(deployWarnings({ CCP_GITHUB_APP_ID: '123456' }).some((w) => /GitHub App/.test(w) && /CCP_SCANNER/.test(w))).toBe(true);
    expect(deployWarnings({ CCP_GITHUB_APP_KEY: 'pem' }).some((w) => /GitHub App/.test(w))).toBe(true);
    expect(deployWarnings({ CCP_GITHUB_APP_KEY_FILE: '/path' }).some((w) => /GitHub App/.test(w))).toBe(true);
  });

  it('a fully-armed scanner (key >=32 chars) clears the GitHub App warning', () => {
    expect(
      deployWarnings({
        CCP_GITHUB_APP_ID: '123456',
        CCP_SCANNER: '1',
        CCP_SCANNER_KEY: 's'.repeat(32),
      }),
    ).toEqual([]);
  });

  it('CCP_SCANNER=1 with a too-short key still warns — armed-but-unusable is the same as unarmed', () => {
    expect(
      deployWarnings({
        CCP_GITHUB_APP_ID: '123456',
        CCP_SCANNER: '1',
        CCP_SCANNER_KEY: 'tooshort',
      }).some((w) => /GitHub App/.test(w)),
    ).toBe(true);
  });

  it('a sealed per-project forge token ahead of arming the scanner is NOT warned about — a legitimate prepare-now-arm-later workflow (the credential PUT route is not gated on CCP_SCANNER)', () => {
    expect(deployWarnings({ CCP_FORGE_SEAL_KEY: 'f'.repeat(40) })).toEqual([]);
  });

  it('runs in every NODE_ENV, unlike the production-only preflight above', () => {
    expect(deployWarnings({ NODE_ENV: 'development', CCP_DRIFT_PROPOSALS: '1' })).toHaveLength(1);
    expect(deployWarnings({ NODE_ENV: 'production', CCP_DRIFT_PROPOSALS: '1' })).toHaveLength(1);
    expect(deployWarnings({ CCP_DRIFT_PROPOSALS: '1' })).toHaveLength(1); // NODE_ENV unset
  });

  it('never throws — this is advisory only, unlike deployProblems/assertDeployable', () => {
    expect(() => deployWarnings({ CCP_BUNDLE: '1', CCP_EXECUTOR: 'terraform' })).not.toThrow();
  });
});

/* ── the entrypoint really refuses to boot (spawned process, non-zero exit) ──── */

const API_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const TSX_BIN = join(API_DIR, 'node_modules', '.bin', 'tsx');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Spawn `tsx src/server.ts` with `env`, resolve with its exit code + captured stderr. */
function spawnServer(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  const proc = spawn(TSX_BIN, ['src/server.ts'], { cwd: API_DIR, env: { ...process.env, ...env } });
  let stderr = '';
  proc.stderr?.on('data', (b: Buffer) => (stderr += b.toString()));
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ code: proc.exitCode, stderr });
    }, 15_000);
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stderr });
    });
  });
}

describe('server entrypoint fails closed on an insecure production config', () => {
  it('NODE_ENV=production with Secure cookies OFF exits non-zero with a clear message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-deploy-'));
    tmpDirs.push(dir);
    const { code, stderr } = await spawnServer({
      NODE_ENV: 'production',
      CCP_SECURE_COOKIES: 'false', // the insecure downgrade
      CCP_CORS_ORIGIN: 'https://ccp.example.com',
      CCP_TOTP_KEY: 'k',
      CCP_DATA_DIR: dir,
      PORT: '0',
    });
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stderr).toMatch(/refusing to start/i);
    expect(stderr).toMatch(/CCP_SECURE_COOKIES/);
  }, 20_000);
});

/** Spawn `tsx src/server.ts`, wait for it to report it is listening (stdout
 * matches `readyRe`) or a fixed timeout, then kill it and WAIT for it to
 * actually exit (never resolve while the child, and the port it bound,
 * might still be alive — `PORT=0` does NOT pick a random port here, it
 * falls back to the fixed default via `Number(env.PORT) || 8801`, so a
 * still-listening leftover from one call could collide with the next)
 * before resolving with everything captured on stderr (ARCH-11's warnings
 * go there, alongside every other server.ts console.warn/error) up to that
 * point. Used to prove the wiring in server.ts, not just the pure
 * `deployWarnings` function. Each caller passes its OWN distinct `port` for
 * the same reason — never share one across tests. */
function spawnServerUntilReady(
  env: NodeJS.ProcessEnv,
  port: number,
  readyRe: RegExp = /ccp-api (dev )?on :/,
): Promise<{ stderr: string }> {
  const proc = spawn(TSX_BIN, ['src/server.ts'], {
    cwd: API_DIR,
    env: { ...process.env, ...env, PORT: String(port) },
  });
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (b: Buffer) => (stdout += b.toString()));
  proc.stderr?.on('data', (b: Buffer) => (stderr += b.toString()));
  return new Promise((resolve) => {
    let killed = false;
    const t = setTimeout(() => {
      if (!killed) {
        killed = true;
        proc.kill('SIGKILL');
      }
    }, 8_000);
    const poll = setInterval(() => {
      if (!killed && readyRe.test(stdout)) {
        killed = true;
        clearInterval(poll);
        proc.kill('SIGTERM');
      }
    }, 50);
    proc.on('exit', () => {
      clearInterval(poll);
      clearTimeout(t);
      resolve({ stderr });
    });
  });
}

describe('server entrypoint prints ARCH-11 warnings at boot without refusing to start', () => {
  it('a dead drift sub-flag warns on stderr but the server still comes up (memory store, dev)', async () => {
    const { stderr } = await spawnServerUntilReady(
      {
        CCP_STORE: 'memory',
        CCP_DRIFT_PROPOSALS: '1', // CCP_DRIFT deliberately left unset
      },
      18901,
    );
    expect(stderr).toMatch(/config warning/i);
    expect(stderr).toMatch(/CCP_DRIFT_PROPOSALS=1/);
  }, 15_000);

  it('a fully-coherent config prints no config warnings', async () => {
    const { stderr } = await spawnServerUntilReady({ CCP_STORE: 'memory' }, 18902);
    expect(stderr).not.toMatch(/config warning/i);
  }, 15_000);
});
