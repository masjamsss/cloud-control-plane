import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { RequestItem } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seedRequests } from './helpers/seed';
import {
  applyFrozen,
  autoRevertEnabled,
  executorKind,
  maybeStartSchedulerLoop,
  schedulerEnabled,
  selectExecutor,
} from '../src/domain/apply/loop';
import { digestOf, DryRunExecutor } from '../src/domain/apply/executor';

/**
 * 0038 T4 — OFF BY DEFAULT. Merging this subsystem must change ZERO production
 * behavior until an operator explicitly sets `CCP_SCHEDULER=1`. These tests are
 * the proof: with the flag unset no loop starts, no timer is armed, and no request is
 * ever auto-processed. Plus the source-level proof of the #1 invariant: nothing in the
 * apply subsystem imports a process-spawner or an AWS SDK — EXCEPT the one sanctioned
 * file, `terraformExecutor.ts` (the proof-milestone real executor), which is itself
 * opt-in-only and real-estate-refusing (its own guards live in
 * terraformExecutor.test.ts). The scan below covers the WHOLE directory minus that
 * file, so any future file is banned by default.
 */

/** The ONE file allowed to spawn a process (`terraform`) — see its header for why
 * that is safe by construction (opt-in env, explicit root, real-estate deny). */
const SANCTIONED_SPAWNER = 'terraformExecutor.ts';

const APPLY_DIR = new URL('../src/domain/apply/', import.meta.url);
const APPLY_SRC = readdirSync(APPLY_DIR)
  .filter((f) => f.endsWith('.ts') && f !== SANCTIONED_SPAWNER)
  .map((f) => new URL(f, APPLY_DIR));

afterEach(() => __setNow(null));

describe('env-flag parsing — every switch defaults OFF', () => {
  it('schedulerEnabled is true ONLY when CCP_SCHEDULER === "1"', () => {
    expect(schedulerEnabled({})).toBe(false);
    expect(schedulerEnabled({ CCP_SCHEDULER: '0' })).toBe(false);
    expect(schedulerEnabled({ CCP_SCHEDULER: 'true' })).toBe(false);
    expect(schedulerEnabled({ CCP_SCHEDULER: '1' })).toBe(true);
  });

  it('applyFrozen is true ONLY when CCP_APPLY_FROZEN === "1"', () => {
    expect(applyFrozen({})).toBe(false);
    expect(applyFrozen({ CCP_APPLY_FROZEN: '1' })).toBe(true);
  });

  it('autoRevertEnabled (opt-in revert) is true ONLY when CCP_APPLY_AUTO_REVERT === "1"', () => {
    expect(autoRevertEnabled({})).toBe(false);
    expect(autoRevertEnabled({ CCP_APPLY_AUTO_REVERT: '1' })).toBe(true);
  });
});

describe('off by default — with CCP_SCHEDULER unset, no loop and nothing is processed', () => {
  it('maybeStartSchedulerLoop returns null (no timer) when the flag is unset', () => {
    const store = new MemoryStore();
    const handle = maybeStartSchedulerLoop(store, { env: {} });
    expect(handle).toBeNull();
  });

  it('a due request sits untouched — constructing the loop with the flag off processes NOTHING', async () => {
    const store = new MemoryStore();
    const diff = 'plan x';
    await seedRequests(store, 'sample', 'sari', 1, {
      status: 'AWAITING_DEPLOY_APPROVAL',
      schedule: { kind: 'window', at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' },
      planDigest: digestOf(diff),
      pinnedDiff: diff,
      approvalsRequired: 1,
      approvals: [{ user: 'budi', at: '2026-07-30T00:00:00.000Z' }],
    });
    __setNow(() => Date.parse('2026-08-01T01:00:00.000Z')); // squarely in-window

    const handle = maybeStartSchedulerLoop(store, { env: {} }); // flag OFF
    expect(handle).toBeNull();
    // give any (erroneously-armed) timer a tick — there must be none
    await new Promise((r) => setTimeout(r, 20));

    const req = (await store.get('P#sample#REQ#seed-sari-0', 'META')) as RequestItem | null;
    expect(req?.status).toBe('AWAITING_DEPLOY_APPROVAL'); // never auto-processed
  });

  it('with the flag ON a handle IS returned and can be stopped (no throw)', () => {
    const store = new MemoryStore();
    const handle = maybeStartSchedulerLoop(store, { env: { CCP_SCHEDULER: '1' }, intervalMs: 60_000 });
    expect(handle).not.toBeNull();
    expect(() => handle?.stop()).not.toThrow();
  });
});

/** Strip block + line comments (protecting `://` in the dry-run sentinels) so the scan
 *  only sees EXECUTABLE code — prose that documents the banned tokens must not trip it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('INVARIANT #1 (source-level): the apply subsystem never spawns a process, imports an AWS SDK, or does network I/O — except the ONE sanctioned executor file', () => {
  it('no process-spawn / AWS-SDK / dynamic-import / require / fetch / raw-socket in the executable code of domain/apply/* (minus terraformExecutor.ts)', () => {
    // The scan is directory-wide so a NEW file is banned by default; only the
    // explicitly-named terraformExecutor.ts (opt-in, root-guarded) is exempt.
    expect(APPLY_SRC.length).toBeGreaterThanOrEqual(4); // executor/scheduler/loop/notify at minimum
    for (const url of APPLY_SRC) {
      const code = stripComments(readFileSync(url, 'utf8'));
      // process spawners + AWS SDKs
      expect(code).not.toMatch(/child_process/);
      expect(code).not.toMatch(/@aws-sdk/);
      expect(code).not.toMatch(/\baws-sdk\b/);
      expect(code).not.toMatch(/\bspawn(Sync)?\s*\(/);
      expect(code).not.toMatch(/\bexec(Sync|File)?\s*\(/);
      // dynamic module loading (a back door to any of the above)
      expect(code).not.toMatch(/\bimport\s*\(/);
      expect(code).not.toMatch(/\brequire\s*\(/);
      // network egress (Finding 2 — close the guard gap)
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/node:(net|http|https|dgram|tls)/);
    }
  });
});

describe('executor selection is OPT-IN — dry-run unless CCP_EXECUTOR is EXACTLY "terraform"', () => {
  it('executorKind defaults to dry-run for unset/empty/near-miss values', () => {
    expect(executorKind({})).toBe('dry-run');
    expect(executorKind({ CCP_EXECUTOR: '' })).toBe('dry-run');
    expect(executorKind({ CCP_EXECUTOR: '1' })).toBe('dry-run');
    expect(executorKind({ CCP_EXECUTOR: 'Terraform' })).toBe('dry-run'); // exact match only
    expect(executorKind({ CCP_EXECUTOR: 'terraform' })).toBe('terraform');
  });

  it('selectExecutor with the flag off constructs the DryRunExecutor (never terraform)', () => {
    expect(selectExecutor({})).toBeInstanceOf(DryRunExecutor);
    expect(selectExecutor({ CCP_TF_ROOT: '/tmp/somewhere' })).toBeInstanceOf(DryRunExecutor); // a root alone changes nothing
  });

  it('selectExecutor(terraform) FAILS CLOSED without an explicit absolute CCP_TF_ROOT', () => {
    expect(() => selectExecutor({ CCP_EXECUTOR: 'terraform' })).toThrow(/CCP_TF_ROOT/);
    expect(() => selectExecutor({ CCP_EXECUTOR: 'terraform', CCP_TF_ROOT: '' })).toThrow(/CCP_TF_ROOT/);
    expect(() => selectExecutor({ CCP_EXECUTOR: 'terraform', CCP_TF_ROOT: 'relative/root' })).toThrow(/CCP_TF_ROOT/);
  });

  it('a misconfigured terraform selection REFUSES TO ARM the loop (null, no timer) — never a silent dry-run fallback', () => {
    const store = new MemoryStore();
    const handle = maybeStartSchedulerLoop(store, {
      env: { CCP_SCHEDULER: '1', CCP_EXECUTOR: 'terraform' }, // no CCP_TF_ROOT
    });
    expect(handle).toBeNull();
  });
});
