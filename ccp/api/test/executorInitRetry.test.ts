import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerraformExecutor, TerraformExecutorError } from '../src/domain/apply/terraformExecutor';
import type { RequestItem } from '../src/store/schema';

/**
 * ERR-5 — `init()` memoized a REJECTED promise, so one transient failure bricked the
 * executor until the process restarted.
 *
 * ```ts
 * this.initDone ??= this.tf(['init', …]).then(() => undefined);
 * ```
 *
 * `??=` caches whatever the promise settles to. A first `terraform init` that failed for
 * any transient reason — a registry blip, a momentary state lock, DNS not up yet on a
 * cold boot — was cached as a rejection, and every later `plan`/`replan`/`apply` re-awaited
 * that same stale rejection forever. The executor is constructed once at loop start, so
 * the whole auto-apply lane was dead until someone noticed and restarted the process, and
 * the only symptom was the identical boot-time error repeating every tick.
 *
 * This drives the REAL executor with a stub `terraform` binary rather than mocking `init`,
 * because the defect is in the caching, not in what init does — a mock of the thing being
 * cached could not tell a re-run from a replayed rejection. The stub counts its own
 * invocations on disk, so "did init actually run a second time?" is answered by evidence
 * rather than by inference from the outcome.
 *
 * No real terraform needed, and nothing here touches a network or an estate.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * A stub `terraform` that fails `init` for the first `failInits` calls and succeeds after,
 * recording every subcommand it is asked to run.
 *
 * `plan` and `show` always succeed so a `replan()` that gets past init completes — which
 * is the point: the test must be able to distinguish "init was retried and worked" from
 * "init was retried and something else broke".
 */
function stubTerraform(failInits: number): { bin: string; log: string; initCount: () => number } {
  const dir = scratch('err5-bin-');
  const bin = join(dir, 'terraform');
  const log = join(dir, 'calls.log');
  const state = join(dir, 'init-attempts');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      `echo "$1" >> '${log}'`,
      'if [ "$1" = "init" ]; then',
      `  n=$(cat '${state}' 2>/dev/null || echo 0)`,
      '  n=$((n + 1))',
      `  echo "$n" > '${state}'`,
      `  if [ "$n" -le ${failInits} ]; then`,
      '    echo "Error: failed to query available provider packages" >&2',
      '    exit 1',
      '  fi',
      '  exit 0',
      'fi',
      '# plan writes the -out file so the executor has an artifact to show',
      'if [ "$1" = "plan" ]; then',
      '  for a in "$@"; do case "$a" in -out=*) printf "planfile" > "${a#-out=}";; esac; done',
      '  exit 0',
      'fi',
      'if [ "$1" = "show" ]; then',
      '  echo "  # terraform_data.proof will be created"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    log,
    initCount: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l === 'init').length : 0),
  };
}

function makeExecutor(bin: string): TerraformExecutor {
  const root = scratch('err5-root-');
  writeFileSync(join(root, 'main.tf'), 'resource "terraform_data" "proof" {}\n');
  return new TerraformExecutor({ rootDir: root, terraformBin: bin, planOnly: true, workDir: join(root, '.ccp-apply') });
}

const req = { id: 'seed-sari-0' } as RequestItem;

describe('ERR-5 — a failed init is retried, not cached forever', () => {
  it('THE DEFECT: after one transient init failure the executor used to be dead until restart', async () => {
    const tf = stubTerraform(1); // exactly one blip, then healthy
    const ex = makeExecutor(tf.bin);

    // First call: the blip. It must surface as a real failure — this is not a fix that
    // hides the error.
    await expect(ex.replan(req)).rejects.toBeInstanceOf(TerraformExecutorError);
    expect(tf.initCount(), 'the setup must really have run init once').toBe(1);

    // Second call on the SAME executor instance — the one the loop holds for its whole
    // lifetime. Under the defect this re-awaited the cached rejection and never re-ran
    // anything.
    await expect(ex.replan(req), 'the executor must recover on its own').resolves.toMatchObject({
      digest: expect.any(String),
    });
    expect(tf.initCount(), 'THE DEFECT: init was never attempted a second time').toBe(2);
  });

  it('a SUCCESSFUL init is still memoized — the fix must not turn init into a per-call cost', async () => {
    // The memo exists for a reason: `terraform init` on every plan/replan/apply would be
    // a real regression. Only the failure path is un-cached.
    const tf = stubTerraform(0);
    const ex = makeExecutor(tf.bin);

    await expect(ex.replan(req)).resolves.toBeTruthy();
    await expect(ex.replan(req)).resolves.toBeTruthy();
    await expect(ex.replan(req)).resolves.toBeTruthy();

    expect(tf.initCount(), 'three replans, one init').toBe(1);
  });

  it('a PERSISTENT init failure keeps failing loudly — it is not silently swallowed', async () => {
    // Retrying must not become "eventually pretend it worked". Each attempt reports the
    // real terraform error, and each attempt is a real attempt.
    const tf = stubTerraform(99);
    const ex = makeExecutor(tf.bin);

    for (let i = 0; i < 3; i++) {
      await expect(ex.replan(req)).rejects.toThrow(/terraform init failed/);
    }
    expect(tf.initCount(), 'every call retried rather than replaying a cached rejection').toBe(3);
  });

  it('concurrent callers during one blip share a SINGLE init attempt, and all fail together', async () => {
    // The memo's other job. Three requests coming due in the same tick must not each
    // launch their own `terraform init` against the same root — that is a lock fight, and
    // it would be a new defect introduced by fixing this one.
    const tf = stubTerraform(1);
    const ex = makeExecutor(tf.bin);

    const results = await Promise.allSettled([ex.replan(req), ex.replan(req), ex.replan(req)]);
    expect(results.every((r) => r.status === 'rejected'), 'one blip is one failure, shared').toBe(true);
    expect(tf.initCount(), 'three concurrent callers, ONE init attempt').toBe(1);

    // And the shared failure still leaves the executor retryable.
    await expect(ex.replan(req)).resolves.toBeTruthy();
    expect(tf.initCount()).toBe(2);
  });

  it('the retry actually re-runs init rather than skipping straight to plan', async () => {
    // A fix that cleared the memo but left init un-rerun would pass the first test by
    // accident, because plan/show succeed in the stub. Assert the ORDER of subcommands.
    const tf = stubTerraform(1);
    const ex = makeExecutor(tf.bin);

    await expect(ex.replan(req)).rejects.toThrow();
    await expect(ex.replan(req)).resolves.toBeTruthy();

    const calls = readFileSync(tf.log, 'utf8').trim().split('\n');
    expect(calls[0]).toBe('init');
    expect(calls[1], 'the second attempt begins with init, not plan').toBe('init');
    expect(calls.slice(2), 'and only then does the real work happen').toContain('plan');
  });
});
