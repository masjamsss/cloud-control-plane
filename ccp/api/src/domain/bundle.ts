import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCapture } from './exec';

/**
 * ADR-0016 — the approval-to-apply bundle: local gate → direct commit to `main`
 * (compare-and-swap on the gated SHA) → satisfy the gated CI apply. This module is
 * the pure-ish orchestration + the real effect implementations; the route
 * (`POST /requests/:id/apply`) wires them. Spec:
 * docs/superpowers/specs/2026-07-20-ccp-approval-to-apply-bundle.md.
 *
 * OFF BY DEFAULT is load-bearing (the loop.ts invariant): {@link bundleConfig}
 * returns null unless `CCP_BUNDLE=1` AND every effect is configured — merging
 * this changes ZERO production behavior until an operator arms it.
 *
 * The binding invariant (owner requirement): the plan must equal the approved
 * CCP change and NOTHING else. The gate command is where plan-check enforces
 * that (R-gates + plan digest); this module's contribution is the CAS commit —
 * the push lands only if the branch still points at the SHA the gate ran on, so
 * no third-party change can interleave between gate and land. Never force-pushes.
 *
 * This module NEVER runs `terraform apply` — the apply stays in gated CI
 * (AGENTS.md rule 1); the trigger merely satisfies that gate's approval.
 *
 * Placement note: this file lives at domain/bundle.ts, NOT domain/apply/ — the
 * schedulerGating contract test (INVARIANT #1) rightly forbids process spawns in
 * the timer-driven apply subsystem, and the bundle is a different lane: route-
 * triggered by an authenticated senior click, never by a timer.
 */

type Env = Record<string, string | undefined>;

export interface BundleConfig {
  /** Pushable clone URL (bot credential embedded or via credential helper). */
  remote: string;
  /** Target branch — `main`. */
  branch: string;
  /** Gate command: edits + verifies inside $BUNDLE_CHECKOUT; exit 0 = green. */
  gateCmd: string;
  /** Trigger command: satisfies the gated CI apply for $BUNDLE_SHA; exit 0 = fired. */
  triggerCmd: string;
}

/** Armed only when the flag AND every effect are explicitly configured. */
export function bundleConfig(env: Env = process.env): BundleConfig | null {
  if (env.CCP_BUNDLE !== '1') return null;
  const remote = env.CCP_GIT_REMOTE;
  const gateCmd = env.CCP_BUNDLE_GATE_CMD;
  const triggerCmd = env.CCP_BUNDLE_TRIGGER_CMD;
  if (!remote || !gateCmd || !triggerCmd) return null;
  return { remote, branch: env.CCP_GIT_BRANCH || 'main', gateCmd, triggerCmd };
}

export interface StepResult {
  ok: boolean;
  /** Captured stdout/stderr tail or the refusal reason — audit evidence. */
  detail: string;
}

/**
 * Either a value or a promise of it. The real steps are async (they shell out without
 * blocking the event loop — see domain/exec.ts); the test fakes are plain synchronous
 * objects. `runBundle` awaits every step, and awaiting a non-promise is a no-op, so both
 * satisfy this interface without the fakes having to pretend to be async.
 */
type Await<T> = T | Promise<T>;

/** The three effects + workspace lifecycle, injectable for tests. */
export interface BundleSteps {
  /** Clone the branch; returns the checkout dir + the SHA the gate will run on. */
  prepare(): Await<{ dir: string; baseSha: string } | { error: string }>;
  gate(dir: string, requestJsonPath: string): Await<StepResult>;
  /** Commit whatever the gate changed and CAS-push (ff from baseSha only). */
  commit(dir: string, baseSha: string, message: string): Await<StepResult & { sha?: string }>;
  trigger(sha: string): Await<StepResult>;
  cleanup(dir: string): Await<void>;
}

export interface BundleOutcome {
  ok: boolean;
  /** Step log in execution order — becomes the audit payload. */
  steps: Array<{ step: 'prepare' | 'gate' | 'commit' | 'trigger'; ok: boolean; detail: string }>;
  /** The landed commit on success. */
  sha?: string;
}

/** Sequential, stop-on-red, cleanup-always. Pure over the injected steps. */
export async function runBundle(
  steps: BundleSteps,
  requestJson: string,
  message: string,
): Promise<BundleOutcome> {
  const log: BundleOutcome['steps'] = [];
  const prep = await steps.prepare();
  if ('error' in prep) {
    log.push({ step: 'prepare', ok: false, detail: prep.error });
    return { ok: false, steps: log };
  }
  log.push({ step: 'prepare', ok: true, detail: `base ${prep.baseSha.slice(0, 9)}` });
  try {
    const reqPath = join(prep.dir, '.bundle-request.json');
    writeFileSync(reqPath, requestJson);
    const gate = await steps.gate(prep.dir, reqPath);
    log.push({ step: 'gate', ok: gate.ok, detail: gate.detail });
    if (!gate.ok) return { ok: false, steps: log };

    const commit = await steps.commit(prep.dir, prep.baseSha, message);
    log.push({ step: 'commit', ok: commit.ok, detail: commit.detail });
    if (!commit.ok || !commit.sha) return { ok: false, steps: log };

    const trig = await steps.trigger(commit.sha);
    log.push({ step: 'trigger', ok: trig.ok, detail: trig.detail });
    return { ok: trig.ok, steps: log, sha: commit.sha };
  } finally {
    await steps.cleanup(prep.dir);
  }
}

/* ── real effect implementations ────────────────────────────────────────────── */

const tail = (s: string, n = 400): string => (s.length > n ? `…${s.slice(-n)}` : s);

async function sh(
  cmd: string,
  cwd: string,
  extraEnv: Record<string, string>,
): Promise<{ status: number; out: string }> {
  const r = await execCapture('bash', ['-lc', cmd], {
    cwd,
    env: { ...process.env, ...extraEnv },
    timeoutMs: 15 * 60_000,
  });
  return { status: r.status, out: tail(r.out.trim()) };
}

async function git(args: string[], cwd: string): Promise<{ status: number; out: string }> {
  const r = await execCapture('git', args, { cwd, timeoutMs: 5 * 60_000 });
  return { status: r.status, out: tail(r.out.trim()) };
}

/** Production steps: git workspace (CAS push, never force) + operator commands. */
export function realSteps(cfg: BundleConfig): BundleSteps {
  return {
    async prepare() {
      const dir = mkdtempSync(join(tmpdir(), 'ccp-bundle-'));
      const clone = await git(['clone', '--depth', '1', '--branch', cfg.branch, cfg.remote, dir], tmpdir());
      if (clone.status !== 0) {
        rmSync(dir, { recursive: true, force: true });
        return { error: `clone failed: ${clone.out}` };
      }
      const head = await git(['rev-parse', 'HEAD'], dir);
      if (head.status !== 0) return { error: `rev-parse failed: ${head.out}` };
      return { dir, baseSha: head.out.trim() };
    },
    async gate(dir, requestJsonPath) {
      const r = await sh(cfg.gateCmd, dir, { BUNDLE_CHECKOUT: dir, BUNDLE_REQUEST: requestJsonPath });
      return { ok: r.status === 0, detail: r.out || (r.status === 0 ? 'gate green' : `gate exit ${r.status}`) };
    },
    async commit(dir, baseSha, message) {
      // The request-evidence file rides the same commit as the gated edit.
      await git(['add', '-A'], dir);
      const c = await git(['-c', 'user.name=ccp-bundle', '-c', 'user.email=ccp-bundle@localhost', 'commit', '-m', message], dir);
      if (c.status !== 0) return { ok: false, detail: `commit failed (gate left no change?): ${c.out}` };
      const sha = (await git(['rev-parse', 'HEAD'], dir)).out.trim();
      // CAS: a plain ff push from a clone of baseSha — the remote rejects it if the
      // branch moved (someone landed in the middle). Never --force anything.
      const p = await git(['push', 'origin', `HEAD:refs/heads/${cfg.branch}`], dir);
      if (p.status !== 0) return { ok: false, detail: `push rejected (branch moved past ${baseSha.slice(0, 9)}? re-run to re-gate): ${p.out}` };
      return { ok: true, sha, detail: `landed ${sha.slice(0, 9)} on ${cfg.branch}` };
    },
    async trigger(sha) {
      const r = await sh(cfg.triggerCmd, tmpdir(), { BUNDLE_SHA: sha });
      return { ok: r.status === 0, detail: r.out || (r.status === 0 ? 'gate approval fired' : `trigger exit ${r.status}`) };
    },
    cleanup(dir) {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
