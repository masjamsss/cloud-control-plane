import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCapture } from './exec';
import { resolveLaneRemote, type LaneProject, type LaneRemoteSource } from './laneRepo';

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
  /**
   * Where {@link remote} came from (ARCH-2) — `project-repo` when the acting estate
   * registered its own repository, `env-global` when the deployment's single-estate
   * `CCP_GIT_REMOTE` served it. Recorded in the run's audit evidence, because the
   * defect this closes was invisible precisely because nothing wrote the answer down.
   */
  remoteSource: LaneRemoteSource;
  /** Human-readable form of the same, for the audit payload. */
  remoteDetail: string;
  /** Target branch — `main`. */
  branch: string;
  /** Gate command: edits + verifies inside $BUNDLE_CHECKOUT; exit 0 = green. */
  gateCmd: string;
  /** Trigger command: satisfies the gated CI apply for $BUNDLE_SHA; exit 0 = fired. */
  triggerCmd: string;
}

/**
 * Is the lane armed AT ALL — flag plus both operator commands, from the environment
 * alone? Deliberately separate from {@link bundleConfig}: "this deployment never armed
 * the bundle" and "this deployment armed it but cannot resolve a repository for YOUR
 * estate" are different operator problems, and the route must answer the first without
 * reading the store (a disarmed deployment replies identically to every caller).
 *
 * Collapsing the two is how ARCH-2 stayed invisible — an operator hitting a
 * cross-estate misconfiguration was told the flags were off, and the flags were on.
 */
export function bundleArmed(env: Env = process.env): boolean {
  return env.CCP_BUNDLE === '1' && !!env.CCP_BUNDLE_GATE_CMD && !!env.CCP_BUNDLE_TRIGGER_CMD;
}

/**
 * Armed only when the flag AND every effect are explicitly configured.
 *
 * ARCH-2: the remote is resolved for `project` — its own registered repository when it
 * has one, the deployment-global `CCP_GIT_REMOTE` only as the single-estate fallback.
 * `project` is optional so the legacy call shape still type-checks; the route passes the
 * acting estate. A project whose registered repo is refused yields `null` here and a
 * specific reason from {@link resolveLaneRemote} — never a fallback to another estate.
 */
export function bundleConfig(
  env: Env = process.env,
  project?: LaneProject,
  extraHosts: readonly string[] = [],
): BundleConfig | null {
  if (!bundleArmed(env)) return null;
  const gateCmd = env.CCP_BUNDLE_GATE_CMD!;
  const triggerCmd = env.CCP_BUNDLE_TRIGGER_CMD!;
  const remote = resolveLaneRemote(project, env, extraHosts);
  if (!remote.ok) return null;
  return {
    remote: remote.remote,
    remoteSource: remote.source,
    remoteDetail: remote.detail,
    branch: env.CCP_GIT_BRANCH || 'main',
    gateCmd,
    triggerCmd,
  };
}

export { BUNDLE_LEASE_MS, bundleClaimLive } from './bundleClaim';

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
  steps: Array<{ step: 'prepare' | 'gate' | 'plan-digest' | 'commit' | 'trigger'; ok: boolean; detail: string }>;
  /** The landed commit on success. */
  sha?: string;
}

/** Sequential, stop-on-red, cleanup-always. Pure over the injected steps. */
/**
 * The line a gate command must print so the api can verify what it actually gated
 * (ARCH-3). Case-insensitive, anywhere in the gate's stdout, last one wins.
 */
const GATE_DIGEST_LINE = /^\s*ccp-plan-digest:\s*([0-9a-f]{64})\s*$/gim;

/**
 * Extract the plan digest a gate command reported. Pure, so the parsing is testable
 * without spawning anything.
 *
 * Returns `null` when the gate printed none — which is NOT the same as printing a wrong
 * one, and the caller treats the two differently.
 */
export function parseGateDigest(out: string): string | null {
  let last: string | null = null;
  for (const m of out.matchAll(GATE_DIGEST_LINE)) last = (m[1] ?? '').toLowerCase();
  return last;
}

/**
 * Does the gate's self-reported digest satisfy the request's pinned one (ARCH-3)?
 *
 * ADR-0016 makes "the plan must equal the approved change" an Owner requirement, binding.
 * As built, the api spawned the operator's shell string and trusted EXIT 0: the R-gates,
 * the digest pin, and even which tool ran at all were the operator's command. The product's
 * central safety property — "what was reviewed is exactly what runs" — held only on
 * deployments whose operator wrote the right command, and a typo'd or weakened gate
 * produced a green bundle with nothing in-product violated and no way to tell from the
 * audit trail.
 *
 * This is the api re-checking the property itself rather than delegating it.
 *
 *  - No pin on the request  → nothing to verify. Today that is EVERY request (API-3: the
 *    pin-writer does not exist), so this must not refuse, or the bundle stops working
 *    entirely. Reported honestly as unverified rather than silently treated as passing.
 *  - Pinned and the gate reports a MATCHING digest → verified.
 *  - Pinned and the gate reports a DIFFERENT digest → refuse. This is the finding's whole
 *    subject: the plan that would land is not the plan that was approved.
 *  - Pinned and the gate reports NOTHING → refuse. Accepting silence would make the check
 *    optional, and an optional safety check is one an operator's command can skip by
 *    omission — which is the defect wearing a different hat (L-1).
 */
export type DigestVerdict =
  | { ok: true; state: 'verified' | 'unpinned'; detail: string }
  | { ok: false; detail: string };

export function verifyGateDigest(pinned: string | undefined, gateOut: string): DigestVerdict {
  const reported = parseGateDigest(gateOut);
  if (pinned === undefined || pinned === '') {
    return {
      ok: true,
      state: 'unpinned',
      detail: reported
        ? `gate reported ${reported.slice(0, 12)}… but the request carries no pinned plan — NOT verified`
        : 'request carries no pinned plan — digest NOT verified (no pin-writer is deployed)',
    };
  }
  if (reported === null) {
    return {
      ok: false,
      detail:
        `request pins plan ${pinned.slice(0, 12)}… but the gate reported no digest. ` +
        'The gate command must print "ccp-plan-digest: <sha256>" so the api can verify that ' +
        'what it gated is what was approved.',
    };
  }
  if (reported !== pinned.toLowerCase()) {
    return {
      ok: false,
      detail: `PLAN MISMATCH — approved ${pinned.slice(0, 12)}…, gate produced ${reported.slice(0, 12)}…`,
    };
  }
  return { ok: true, state: 'verified', detail: `plan digest verified (${pinned.slice(0, 12)}…)` };
}

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

    // ARCH-3 — the api verifies the reviewed-plan property itself, BEFORE committing,
    // instead of inferring it from the operator command's exit code.
    const pinned = (JSON.parse(requestJson) as { planDigest?: string }).planDigest;
    const verdict = verifyGateDigest(pinned, gate.detail);
    log.push({ step: 'plan-digest', ok: verdict.ok, detail: verdict.detail });
    if (!verdict.ok) return { ok: false, steps: log };

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
  // `-c`, NOT `-lc` (ARCH-3). A login shell sources the operator's profile files into a
  // security gate's environment, so what the gate does depends on shell dotfiles nobody
  // reviewed alongside the command. The gate gets exactly the environment this code hands
  // it and nothing else.
  const r = await execCapture('bash', ['-c', cmd], {
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

/**
 * Production steps: git workspace (CAS push, never force) + operator commands.
 *
 * Takes only the four fields it actually uses, not the whole {@link BundleConfig}:
 * `remoteSource`/`remoteDetail` are audit metadata for the route, and requiring a
 * caller to invent them just to build a workspace would be the type asking for
 * something it does not need.
 */
export function realSteps(
  cfg: Pick<BundleConfig, 'remote' | 'branch' | 'gateCmd' | 'triggerCmd'>,
): BundleSteps {
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
