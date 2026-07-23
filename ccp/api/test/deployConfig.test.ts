import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { deployProblems } from '../src/deploy';

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
