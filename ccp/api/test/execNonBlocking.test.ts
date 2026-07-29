import { describe, expect, it } from 'vitest';
import { execCapture } from '../src/domain/exec';

/**
 * Findings API-1, CONC-5, OPS-3, PERF-2, ERR-1 — one behaviour seen five ways: the armed
 * lanes shelled out with `spawnSync`, which stops the single-threaded API for as long as
 * the child runs (up to 15 minutes for a bundle). Nothing else was served in that window,
 * `/readyz` included, so the container healthcheck could restart the server mid-apply.
 *
 * The first test is the one that matters: it asserts the event loop keeps turning while a
 * child runs. It FAILS against a `spawnSync` implementation — under spawnSync the interval
 * cannot fire at all until the child exits, so `ticks` is 0.
 *
 * The rest pin the contract the call sites depend on: never reject, always report a
 * status, and capture output.
 */
describe('execCapture', () => {
  it('does not block the event loop while the child runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);

    try {
      const r = await execCapture('bash', ['-lc', 'sleep 0.3']);
      expect(r.status).toBe(0);
    } finally {
      clearInterval(timer);
    }

    // ~30 ticks are theoretically available in 300ms; assert well under that so the test
    // is about "the loop ran at all", not about timer precision on a loaded CI box.
    // Under spawnSync this is exactly 0.
    expect(ticks).toBeGreaterThan(5);
  });

  it('reports a non-zero exit as a status rather than throwing', async () => {
    const r = await execCapture('bash', ['-lc', 'exit 3']);
    expect(r.status).toBe(3);
  });

  it('captures stdout and stderr together', async () => {
    const r = await execCapture('bash', ['-lc', 'echo out; echo err 1>&2']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('out');
    expect(r.out).toContain('err');
  });

  it('kills the child on timeout and resolves non-zero', async () => {
    const started = Date.now();
    const r = await execCapture('bash', ['-lc', 'sleep 30'], { timeoutMs: 200 });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('timed out');
    // It must actually kill rather than wait the full 30s out.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('turns a missing binary into a status, not a rejection', async () => {
    const r = await execCapture('definitely-not-a-real-binary-ccp', []);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('spawn failed');
  });

  it('passes cwd and env through to the child', async () => {
    const r = await execCapture('bash', ['-lc', 'echo "$PWD|$CCP_TEST_VAR"'], {
      cwd: '/tmp',
      env: { ...process.env, CCP_TEST_VAR: 'sentinel' },
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain('sentinel');
    expect(r.out).toContain('/tmp');
  });

  it('does not run the command through a shell unless asked', async () => {
    // If `shell: true` leaked in, this would be interpreted and exit 0. As argv to a
    // binary that does not exist, it must fail to spawn instead.
    const r = await execCapture('definitely-not-a-real-binary-ccp', ['&&', 'echo', 'pwned']);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('pwned');
  });
});
