import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RequestItem } from '../src/store/schema';
import { digestOf } from '../src/domain/apply/executor';
import { normalizePlanText, TerraformExecutor, TerraformExecutorError } from '../src/domain/apply/terraformExecutor';

/**
 * ERR-5 — `TerraformExecutor.init()` memoized a REJECTED promise, so one transient
 * `terraform init` failure bricked the executor for the life of the process. The loop
 * builds the executor once (`loop.ts#maybeStartSchedulerLoop`), so the auto-apply lane
 * stayed dead until a restart while re-raising the same stale error every tick.
 *
 * The proof needs no terraform: a STUB binary that fails the first `init` and succeeds
 * afterwards is exactly the transient failure being modelled, and it records its own
 * invocations so the test can assert the retry really re-ran init (L-1) rather than
 * passing because some other layer papered over it.
 */

const PLAN_TEXT = 'stub plan: 1 to change, 0 to add, 0 to destroy';

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A `terraform` stand-in that appends every subcommand it is handed to `log`, and fails
 * `init` on exactly the first call. Every other subcommand succeeds, so the ONLY thing
 * that can make the second `replan()` fail is init not being retried.
 */
function stubTerraform(dir: string): { bin: string; log: string; invocations: () => string[] } {
  const log = join(dir, 'invocations.log');
  const bin = join(dir, 'terraform-stub.sh');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `echo "$1" >> ${JSON.stringify(log)}`,
      'case "$1" in',
      '  init)',
      `    n=$(grep -c '^init$' ${JSON.stringify(log)})`,
      '    if [ "$n" = "1" ]; then',
      '      echo "Error: Failed to query available provider packages" >&2',
      '      exit 1',
      '    fi',
      '    echo "Terraform has been successfully initialized!" ;;',
      '  plan) echo "stub plan written" ;;',
      `  show) echo ${JSON.stringify(PLAN_TEXT)} ;;`,
      '  *) echo "unexpected subcommand: $1" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  writeFileSync(log, '');
  return {
    bin,
    log,
    invocations: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0),
  };
}

const REQ = { id: 'req-err5' } as RequestItem;

describe('ERR-5 — a transient `terraform init` failure does not brick the executor', () => {
  it('the second call RETRIES init and succeeds', async () => {
    const root = scratch('ccp-err5-');
    const stub = stubTerraform(root);
    const ex = new TerraformExecutor({ rootDir: root, terraformBin: stub.bin, workDir: join(root, '.work') });

    // First call: init fails for real, and the failure is surfaced (not swallowed).
    await expect(ex.replan(REQ)).rejects.toThrow(TerraformExecutorError);

    // SETUP ASSERTION (L-1): the stub really ran and really refused. Without this a
    // stub that never executed would make the retry below pass for the wrong reason.
    expect(stub.invocations()).toEqual(['init']);

    // THE REGRESSION. Before the fix this rejected with the SAME cached init error —
    // `this.initDone` held the rejected promise and no later call ever re-ran init.
    const res = await ex.replan(REQ);
    expect(res.digest).toBe(digestOf(normalizePlanText(PLAN_TEXT)));

    // …and it succeeded by actually re-running init, not by skipping it.
    expect(stub.invocations()).toEqual(['init', 'init', 'plan', 'show']);
  });

  it('a SUCCESSFUL init is still memoized — later calls do not re-init', async () => {
    const root = scratch('ccp-err5-memo-');
    const stub = stubTerraform(root);
    const ex = new TerraformExecutor({ rootDir: root, terraformBin: stub.bin, workDir: join(root, '.work') });

    await expect(ex.replan(REQ)).rejects.toThrow(TerraformExecutorError); // burn the one scripted failure
    await ex.replan(REQ);
    await ex.replan(REQ);

    // Two inits total: the failed one and the retry. The third replan reused the
    // memoized success — clearing the field on rejection must not turn init into a
    // per-call `terraform init`, which is the obvious over-correction.
    expect(stub.invocations().filter((l) => l === 'init')).toEqual(['init', 'init']);
  });

  it('concurrent callers share ONE in-flight init, and all of them see the failure', async () => {
    const root = scratch('ccp-err5-conc-');
    const stub = stubTerraform(root);
    const ex = new TerraformExecutor({ rootDir: root, terraformBin: stub.bin, workDir: join(root, '.work') });

    const results = await Promise.allSettled([ex.replan(REQ), ex.replan(REQ), ex.replan(REQ)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    // One init for three concurrent callers — the memo still does its job on the way in.
    expect(stub.invocations().filter((l) => l === 'init')).toEqual(['init']);

    // And the executor is not poisoned: the next call retries and works.
    await expect(ex.replan(REQ)).resolves.toMatchObject({ digest: digestOf(normalizePlanText(PLAN_TEXT)) });
  });
});
