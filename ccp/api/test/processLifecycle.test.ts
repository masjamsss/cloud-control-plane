import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createShutdown, DEFAULT_DRAIN_MS } from '../src/shutdown';

/**
 * ERR-8 / OPS-8 — process lifecycle: PID 1, SIGTERM, and what a boot failure reports.
 *
 * Three separate defects, each with its own section below:
 *
 *  1. The container ran `npm` as PID 1, four processes above the node that runs
 *     server.ts. Docker signals PID 1 only, so SIGTERM killed npm and the api never saw
 *     it — which silently made CONC-7's writer-lock handback dead code IN THE SHIPPED
 *     IMAGE while its unit test stayed green.
 *  2. Even when the signal arrived, the handler called `process.exit(0)` immediately:
 *     no drain, and the scheduler's tick left mid-flight.
 *  3. `void start()` had no catch. Since OPS-2 the resulting rejection reached a
 *     deliberately non-exiting handler, so a fatal boot failure logged a stack and then
 *     **exited 0** — a failed start reported to every supervisor as a successful one.
 *
 * These are checked as RULES rather than as the three known instances (L-25): the PID-1
 * check rejects any launch chain that puts a process manager in front of node, not just
 * the `npm` spelling that was there.
 */

const API_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCKERFILE = join(API_DIR, 'Dockerfile');
const COMPOSE = join(API_DIR, '..', 'docker-compose.yml');

const tmpDirs: string[] = [];
const kids: ChildProcess[] = [];
afterAll(() => {
  for (const k of kids) if (k.exitCode === null) k.kill('SIGKILL');
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccp-lifecycle-'));
  tmpDirs.push(d);
  return d;
}

/* ── 1. the shipped entrypoint puts node itself at PID 1 ─────────────────────── */

describe('the container entrypoint is the api process, not a process manager in front of it', () => {
  /**
   * The RULE, not the list. Any of `npm`, `yarn`, `pnpm`, `sh -c`, `bash -c` as the CMD
   * head re-introduces the same defect under a different spelling, and each one has the
   * same consequence: Docker's SIGTERM lands on something that is not the api.
   */
  const PROCESS_MANAGERS = ['npm', 'npx', 'yarn', 'pnpm', 'sh', 'bash', '/bin/sh', '/bin/bash'];

  function shippedCmd(): string[] {
    const text = readFileSync(DOCKERFILE, 'utf8');
    // The last CMD wins in a Dockerfile, and only the exec (JSON array) form avoids an
    // implicit `/bin/sh -c` wrapper — so a shell-form CMD fails this by construction.
    const matches = [...text.matchAll(/^CMD\s+(\[[^\]]*\])/gm)];
    expect(matches.length, 'the Dockerfile must declare an exec-form CMD — a shell-form CMD is itself the defect (it runs under /bin/sh -c)').toBeGreaterThan(0);
    return JSON.parse(matches[matches.length - 1]![1]!) as string[];
  }

  it('the CMD head is not a process manager', () => {
    const cmd = shippedCmd();
    expect(cmd.length, 'setup check: the parsed CMD must be non-empty').toBeGreaterThan(0);
    const head = cmd[0]!;
    expect(
      PROCESS_MANAGERS,
      `CMD starts with "${head}", which makes IT pid 1: docker signals pid 1 only, so the api never receives SIGTERM and its shutdown handlers are dead code in the image`,
    ).not.toContain(head);
  });

  it('the CMD launches the api entrypoint directly', () => {
    // Pins the other half: not a process manager AND actually our server, so a CMD that
    // ran some unrelated binary could not pass the check above by accident.
    expect(shippedCmd().join(' ')).toContain('src/server.ts');
  });

  /**
   * The `api:` service block alone.
   *
   * Scoped deliberately, and the negative run is why: the first version of the check below
   * grepped the WHOLE compose file for `stop_grace_period:` and PASSED against the unfixed
   * file — it was matching the `scanner` service's own `30s`, which has nothing to do with
   * the api. A green test protecting nothing, found only by running it against the code it
   * was supposed to fail on.
   */
  function apiServiceBlock(): string {
    const text = readFileSync(COMPOSE, 'utf8');
    const start = text.indexOf('\n  api:\n');
    expect(start, 'setup: compose must declare an `api` service at the usual indent').toBeGreaterThan(-1);
    const after = text.slice(start + 1);
    const head = '  api:'.length;
    const next = /\n {2}[A-Za-z0-9_-]+:/.exec(after.slice(head));
    const block = next === null ? after : after.slice(0, head + next.index);
    // Setup assertions: this really is the api block, and it really does stop there.
    expect(block, 'setup: the slice must be the api service').toContain('image: ccp-api:local');
    expect(block, 'setup: the slice must not have run on into a later service').not.toContain('ccp-scanner:local');
    return block;
  }

  it('compose gives the api longer to stop than the api gives itself to drain', () => {
    // A grace period below the drain budget means docker SIGKILLs the process part-way
    // through the very shutdown this batch added — the drain would look implemented and
    // never complete. Docker's DEFAULT is 10s, which is below DEFAULT_DRAIN_MS, so this
    // has to be set explicitly rather than left out.
    const m = /stop_grace_period:\s*(\d+)s/.exec(apiServiceBlock());
    expect(m, 'the api service must set stop_grace_period explicitly — the 10s default is below the drain budget').not.toBeNull();
    expect(Number(m![1]) * 1000).toBeGreaterThan(DEFAULT_DRAIN_MS);
  });

  it('the api container gets a real init to reap the children the armed lanes spawn', () => {
    expect(apiServiceBlock(), 'the armed lanes spawn `docker run` from inside this container; node at PID 1 does not reap orphaned grandchildren').toMatch(/^\s*init:\s*true\s*$/m);
  });
});

/* ── 2. the drain sequence ───────────────────────────────────────────────────── */

describe('SIGTERM drains rather than cutting the process off at the knees', () => {
  /** A fake http server that records the order of calls and defers its close callback. */
  function fakeServer(): {
    calls: string[];
    finishClose: () => void;
    close: (cb?: () => void) => void;
    closeIdleConnections: () => void;
    closeAllConnections: () => void;
  } {
    const calls: string[] = [];
    let cb: (() => void) | undefined;
    return {
      calls,
      finishClose: () => cb?.(),
      close: (f) => {
        calls.push('close');
        cb = f;
      },
      closeIdleConnections: () => calls.push('closeIdleConnections'),
      closeAllConnections: () => calls.push('closeAllConnections'),
    };
  }

  it('stops the scheduler, stops accepting, drains, and releases the writer lock LAST', () => {
    const server = fakeServer();
    const order: string[] = [];
    const exits: number[] = [];
    const shutdown = createShutdown({
      server,
      scheduler: { stop: () => order.push('scheduler.stop') },
      releaseStore: () => order.push('releaseStore'),
      exit: (c) => exits.push(c),
      log: () => {},
    });

    shutdown('SIGTERM');
    // Setup assertion (L-1): the drain must actually be IN PROGRESS here, or the
    // ordering assertions below would pass against a handler that did nothing.
    expect(server.calls, 'setup: close() must have been called').toContain('close');
    expect(exits, 'the process must NOT have exited while requests are still in flight').toEqual([]);
    expect(order, 'the scheduler is stopped before anything else, so no new tick claims work').toEqual(['scheduler.stop']);

    server.finishClose(); // the last in-flight request completes
    expect(exits).toEqual([0]);
    expect(order, 'the writer lock is handed back only after in-flight writes are done').toEqual(['scheduler.stop', 'releaseStore']);
  });

  it('hangs up IDLE keep-alive sockets, or a single idle proxy connection burns the whole deadline', () => {
    const server = fakeServer();
    createShutdown({ server, exit: () => {}, log: () => {} })('SIGTERM');
    expect(server.calls).toContain('closeIdleConnections');
  });

  it('cuts the connection and still releases the lock when the drain overruns', async () => {
    const server = fakeServer();
    const exits: number[] = [];
    let released = false;
    const lines: string[] = [];
    createShutdown({
      server,
      releaseStore: () => {
        released = true;
      },
      deadlineMs: 20,
      exit: (c) => exits.push(c),
      log: (l) => lines.push(l),
    })('SIGTERM');

    expect(exits, 'setup: nothing may have exited before the deadline elapses').toEqual([]);
    await new Promise((r) => setTimeout(r, 80));

    expect(server.calls).toContain('closeAllConnections');
    expect(released, 'a timed-out drain must still hand the writer lock back, or the next boot inherits a lock it cannot prove is dead').toBe(true);
    expect(lines.join('\n')).toMatch(/deadline/i);
    // 0, not non-zero: this shutdown was REQUESTED. A failure code would make an
    // on-failure supervisor restart a process an operator deliberately stopped.
    expect(exits).toEqual([0]);
  });

  it('a second signal is an escape hatch, not a no-op', () => {
    const server = fakeServer();
    const exits: number[] = [];
    const shutdown = createShutdown({ server, exit: (c) => exits.push(c), log: () => {} });
    shutdown('SIGTERM');
    expect(exits, 'setup: the first signal must start a drain rather than exit').toEqual([]);
    shutdown('SIGTERM');
    expect(exits, 'an operator who signals twice is saying they will not wait').toEqual([0]);
  });

  it('a throwing scheduler stop does not abort the drain', () => {
    const server = fakeServer();
    const exits: number[] = [];
    const shutdown = createShutdown({
      server,
      scheduler: {
        stop: () => {
          throw new Error('tick exploded');
        },
      },
      exit: (c) => exits.push(c),
      log: () => {},
    });
    expect(() => shutdown('SIGTERM')).not.toThrow();
    expect(server.calls, 'the http drain must still happen').toContain('close');
    server.finishClose();
    expect(exits).toEqual([0]);
  });
});

/* ── 3. the real process: signals reach it, boot failures exit non-zero ──────── */

/**
 * Spawn the entrypoint the SHIPPED IMAGE spawns, in its own process group.
 *
 * `setsid`-equivalent isolation via `detached: true` matters: without it a signal sent to
 * the test runner's group would reach the child too, and the test would pass without
 * proving the child handles anything. Signalling `child.pid` alone is what `docker stop`
 * does to PID 1.
 */
function spawnEntrypoint(env: NodeJS.ProcessEnv): ChildProcess {
  const proc = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
    cwd: API_DIR,
    env: { ...process.env, ...env },
    detached: true,
  });
  kids.push(proc);
  return proc;
}

function collect(proc: ChildProcess): { out: () => string } {
  let buf = '';
  proc.stdout?.on('data', (b: Buffer) => (buf += b.toString()));
  proc.stderr?.on('data', (b: Buffer) => (buf += b.toString()));
  return { out: () => buf };
}

function exitOf(proc: ChildProcess, ms: number): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: null, signal: 'TIMEOUT' }), ms);
    proc.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('the real process, signalled the way docker signals PID 1', () => {
  it('SIGTERM shuts it down cleanly and hands the writer lock back', async () => {
    const dir = tempDataDir();
    const proc = spawnEntrypoint({ CCP_DATA_DIR: dir, PORT: '0', NODE_ENV: 'development' });
    const log = collect(proc);

    const up = await waitFor(() => /ccp-api dev on/.test(log.out()), 30_000);
    expect(up, `setup: the api must actually boot before SIGTERM proves anything — got:\n${log.out()}`).toBe(true);
    // Setup assertion: the writer lock must EXIST, or "the lock is gone afterwards" is
    // vacuously true and this test would protect nothing.
    expect(existsSync(join(dir, 'ccp.json.lock')), 'setup: the FileStore writer lock must be held while running').toBe(true);

    proc.kill('SIGTERM');
    const { code, signal } = await exitOf(proc, 30_000);

    expect(signal, 'the process must exit on its own, not be killed').toBeNull();
    expect(code, 'a requested shutdown is a success').toBe(0);
    expect(log.out(), 'the shutdown must be visible to an operator reading container logs').toMatch(/shutdown complete/);
    expect(
      existsSync(join(dir, 'ccp.json.lock')),
      'the writer lock survived SIGTERM — the next boot then has to clear a lock it cannot prove is dead',
    ).toBe(false);
  }, 60_000);

  it('a fatal boot failure exits NON-ZERO instead of reporting success', async () => {
    const dir = tempDataDir();
    // A corrupt-but-present store file: the exact case ERR-8 names. It is neither a
    // DeployConfigError nor a SettlementConfigError, so it took the uncaught path.
    writeFileSync(join(dir, 'ccp.json'), 'this is not json');

    const proc = spawnEntrypoint({ CCP_DATA_DIR: dir, PORT: '0', NODE_ENV: 'development' });
    const log = collect(proc);
    const { code, signal } = await exitOf(proc, 30_000);

    expect(signal, 'setup: the process must exit by itself within the timeout').toBeNull();
    // Setup assertion: prove the boot failed for the REASON we planted, not some other
    // startup error that would make a non-zero exit meaningless as evidence.
    expect(log.out(), 'setup: the corrupt store must be what failed the boot').toMatch(/not valid JSON|JSON/i);
    expect(code, 'exit 0 here tells docker/k8s/systemd/install.sh that a failed start succeeded').not.toBe(0);
    expect(log.out()).toMatch(/refusing to start|during BOOT/i);
  }, 60_000);
});
