import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { RequestItem } from '../../store/schema';
import { digestOf, type ApplyExecutor, type ApplyResult, type PlanResult } from './executor';

/**
 * PROOF-MILESTONE terraform executor (local-server model) — the first executor that
 * runs REAL `terraform` behind the {@link ApplyExecutor} seam. It exists to prove the
 * operator's flow end-to-end on a SANDBOX root:
 *
 *   plan (init + `plan -out=<planfile>`, pin the plan text + its sha256)
 *   → the approver reviews THAT plan (plan-summary route → PlanSummaryPanel)
 *   → fully approved → the scheduler re-plans, compares digests, and applies the
 *     SAVED planfile — the plan approved IS the plan applied, or nothing is.
 *
 * ── THIS IS NOT THE PRODUCTION MULTI-ACCOUNT EXECUTOR ─────────────────────────────
 * The production executor still needs per-account scoped WRITE roles, the full
 * guardrail set (PREVENT_DESTROY, per-op tier re-checks, freeze integration at the
 * terraform layer), artifact storage that survives the api host, and a security
 * review before it ever touches real infrastructure. This file is the local proof of
 * the plan-pin/digest-gate/apply mechanics ONLY.
 *
 * ── SANCTIONED-SPAWN EXCEPTION ─────────────────────────────────────────────────────
 * This is the ONE file in `domain/apply/` allowed to spawn a process (`terraform`).
 * Every other file keeps INVARIANT #1 (no spawn / no AWS SDK / no network) and
 * `test/schedulerGating.test.ts` scans the whole directory MINUS this file to prove
 * it. The exception is safe by construction:
 *   1. OPT-IN — the loop constructs this executor only when `CCP_EXECUTOR=
 *      terraform` (see loop.ts#selectExecutor); default is the DryRunExecutor.
 *   2. EXPLICIT ROOT — it operates only on the absolute root it is handed
 *      (`CCP_TF_ROOT`); there is no default root, and never a hardcoded one.
 *   3. REAL-ESTATE DENY — a root that IS one of this repo's live estate roots
 *      (environments/prod, importer/prod, importer/bootstrap) is refused at
 *      construction unless `planOnly` is set — and a planOnly executor refuses
 *      `apply()` unconditionally. There is NO configuration of this class that can
 *      apply to the real estate.
 *   4. APPLY = SAVED PLAN ONLY — `apply()` runs `terraform apply <planfile>` on the
 *      artifact pinned at plan time, never a fresh plan. Before touching terraform it
 *      re-verifies the pin (sha256(pinnedDiff) === planDigest), that the pinned digest
 *      matches THIS executor's recorded plan text, and that the planfile bytes still
 *      hash to the sha256 recorded at plan time. Terraform adds its own independent
 *      net: applying a saved plan fails if live state changed since the plan.
 *   5. The scheduler's replan→digest-compare (HALTED_DRIFT) runs BEFORE any claim —
 *      `replan()` here is a fresh REAL `terraform plan`, so world drift between
 *      approval and the window halts the request instead of applying it.
 */

/** Path-segment pairs that identify this repo's REAL estate roots. A rootDir whose
 * resolved path contains any of these is refused for an apply-capable executor. */
const REAL_ESTATE_ROOT_SEGMENTS: ReadonlyArray<readonly [string, string]> = [
  ['environments', 'prod'],
  ['importer', 'prod'],
  ['importer', 'bootstrap'],
];

export class TerraformExecutorError extends Error {}

export interface TerraformExecutorConfig {
  /** Absolute path to the terraform root to operate on. REQUIRED — no default. */
  rootDir: string;
  /**
   * Plan-only mode: `plan()`/`replan()` work, `apply()`/`revert()` are refused
   * unconditionally. The ONLY mode in which a real-estate root is accepted — it is
   * how the operator proves "the executor plans the real estate" with read-only
   * creds, with apply impossible by construction.
   */
  planOnly?: boolean;
  /** The terraform binary (default: `terraform` on PATH). */
  terraformBin?: string;
  /** Where per-request plan artifacts live (default: `<rootDir>/.ccp-apply`). */
  workDir?: string;
  /** Per-terraform-invocation timeout (default: 10 minutes). */
  timeoutMs?: number;
}

/** What `plan()` produces and pins: the reviewed text, its digest, and the saved
 * planfile artifact (path + sha256) that `apply()` is later allowed to enact. */
export interface PlannedChange extends PlanResult {
  /** The saved `terraform plan -out` artifact — the ONLY thing apply() will run. */
  planfilePath: string;
  /** sha256 hex of the planfile bytes, re-verified before apply (tamper check). */
  planfileSha: string;
  /** `terraform show -json` of the planfile — feeds the plan-summary route. */
  planJsonPath: string;
  /** The live `terraform plan` stdout (the run log, for evidence capture). */
  runOutput: string;
}

const execFileAsync = promisify(execFile);

/** Normalize plan text so the SAME plan digests identically across runs: the pinned
 * rendering and every re-plan go through this one function before `digestOf`. */
export function normalizePlanText(text: string): string {
  return `${text.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

export class TerraformExecutor implements ApplyExecutor {
  readonly kind = 'terraform';
  private readonly rootDir: string;
  private readonly planOnly: boolean;
  private readonly terraformBin: string;
  private readonly workDir: string;
  private readonly timeoutMs: number;
  private initDone: Promise<void> | null = null;

  constructor(config: TerraformExecutorConfig) {
    if (!config.rootDir || !isAbsolute(config.rootDir)) {
      throw new TerraformExecutorError('rootDir must be an explicit ABSOLUTE path — there is no default terraform root');
    }
    const root = resolve(config.rootDir);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new TerraformExecutorError(`rootDir does not exist or is not a directory: ${root}`);
    }
    this.planOnly = config.planOnly === true;
    if (isRealEstateRoot(root) && !this.planOnly) {
      throw new TerraformExecutorError(
        `REFUSED: ${root} is a real estate root — this proof executor can never be apply-capable there (planOnly:true permits read-only plan, nothing else)`,
      );
    }
    this.rootDir = root;
    this.terraformBin = config.terraformBin ?? 'terraform';
    this.workDir = config.workDir !== undefined ? resolve(config.workDir) : join(root, '.ccp-apply');
    this.timeoutMs = config.timeoutMs ?? 10 * 60_000;
  }

  /** `terraform init` once per executor instance (idempotent, local-state roots only
   * in this proof — a backend/credential story is production-executor work). */
  private init(): Promise<void> {
    this.initDone ??= this.tf(['init', '-input=false', '-no-color']).then(() => undefined);
    return this.initDone;
  }

  private async tf(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(this.terraformBin, args, {
        cwd: this.rootDir,
        timeout: this.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: process.env,
      });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      const detail = (err.stderr ?? '').trim() || (err.stdout ?? '').trim() || err.message || String(e);
      throw new TerraformExecutorError(`terraform ${args[0]} failed: ${tail(detail)}`);
    }
  }

  /** Per-request artifact dir. The request id is path-sanitized (fail closed). */
  private artifactDir(requestId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(requestId) || requestId.startsWith('.')) {
      throw new TerraformExecutorError(`refusing artifact dir for unsafe request id: ${JSON.stringify(requestId)}`);
    }
    const dir = join(this.workDir, requestId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * The PLAN phase (played by CI in the real product): `terraform plan -out=` the
   * saved planfile, render its canonical text (`terraform show`, not the streamed
   * plan chatter), and record text + digest + planfile sha256 as the pin/artifact
   * pair. The caller pins `{diff, digest}` onto the request (pinnedDiff/planDigest)
   * and feeds `planJsonPath` through plan-summary.mjs to the plan-summary route.
   */
  async plan(req: Pick<RequestItem, 'id'>): Promise<PlannedChange> {
    await this.init();
    const dir = this.artifactDir(req.id);
    const planfilePath = join(dir, 'tfplan');
    const run = await this.tf(['plan', '-input=false', '-no-color', `-out=${planfilePath}`]);
    const diff = normalizePlanText((await this.tf(['show', '-no-color', planfilePath])).stdout);
    const planJson = (await this.tf(['show', '-json', planfilePath])).stdout;
    const planfileSha = digestOf(readFileSync(planfilePath));
    const planJsonPath = join(dir, 'plan.json');
    writeFileSync(join(dir, 'plan.txt'), diff);
    writeFileSync(planJsonPath, planJson);
    writeFileSync(join(dir, 'tfplan.sha256'), `${planfileSha}\n`);
    return { diff, digest: digestOf(diff), planfilePath, planfileSha, planJsonPath, runOutput: run.stdout };
  }

  /**
   * A fresh REAL `terraform plan` (never touching the pinned artifact) rendered and
   * digested exactly like the pin. The scheduler compares this digest against the
   * approved `planDigest` — any drift (config or live state) HALTS before any claim.
   */
  async replan(req: RequestItem): Promise<PlanResult> {
    await this.init();
    const replanfile = join(this.artifactDir(req.id), 'replan.tfplan');
    await this.tf(['plan', '-input=false', '-no-color', `-out=${replanfile}`]);
    const diff = normalizePlanText((await this.tf(['show', '-no-color', replanfile])).stdout);
    return { diff, digest: digestOf(diff) };
  }

  /**
   * Apply the SAVED planfile ONLY — never a fresh plan. Every pre-check is fail
   * closed and returns `{ok:false}` (the scheduler retries once — these refusals are
   * deterministic — then lands HALTED_APPLY_FAILED with the reason surfaced).
   */
  async apply(req: RequestItem): Promise<ApplyResult> {
    if (this.planOnly) {
      return { ok: false, dryRun: false, detail: 'REFUSED: plan-only executor — apply is disabled by construction' };
    }
    // 1. Pin intact (never trust the caller): the approved digest must be the sha256
    //    of the approved text.
    if (typeof req.pinnedDiff !== 'string' || req.pinnedDiff.length === 0 || digestOf(req.pinnedDiff) !== req.planDigest) {
      return { ok: false, dryRun: false, detail: 'REFUSED: pinned plan missing or corrupt — nothing trustworthy to apply' };
    }
    let dir: string;
    try {
      dir = this.artifactDir(req.id);
    } catch (e) {
      return { ok: false, dryRun: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const planfilePath = join(dir, 'tfplan');
    const planTxtPath = join(dir, 'plan.txt');
    const shaPath = join(dir, 'tfplan.sha256');
    // 2. The plan artifact this executor recorded at plan time must exist…
    if (!existsSync(planfilePath) || !existsSync(planTxtPath) || !existsSync(shaPath)) {
      return { ok: false, dryRun: false, detail: `REFUSED: no recorded plan artifact for ${req.id} — plan() must produce the planfile before any apply` };
    }
    // 3. …its text must BE the approved plan (the digest the humans approved)…
    const recordedText = normalizePlanText(readFileSync(planTxtPath, 'utf8'));
    if (digestOf(recordedText) !== req.planDigest) {
      return { ok: false, dryRun: false, detail: 'PLAN CHANGED SINCE APPROVAL: the approved digest does not match the recorded plan artifact — refusing to apply' };
    }
    // 4. …and the planfile bytes must still hash to the sha256 recorded at plan time.
    const planfileSha = digestOf(readFileSync(planfilePath));
    if (`${planfileSha}\n` !== readFileSync(shaPath, 'utf8')) {
      return { ok: false, dryRun: false, detail: 'REFUSED: planfile bytes were modified since plan time — refusing to apply a tampered artifact' };
    }
    // 5. Apply THE SAVED PLAN. Terraform independently refuses a stale saved plan
    //    (live state moved since plan) — a second net under the scheduler's replan gate.
    try {
      const run = await this.tf(['apply', '-input=false', '-no-color', planfilePath]);
      const logPath = join(dir, 'apply.log');
      writeFileSync(logPath, run.stdout);
      return {
        ok: true,
        dryRun: false,
        detail: `terraform apply of the approved planfile succeeded — ${lastLine(run.stdout)}`,
        appliedSha: planfileSha,
        evidenceUrl: `file://${logPath}`,
      };
    } catch (e) {
      // No retry loop here (the scheduler owns retry-once); capture and surface.
      return { ok: false, dryRun: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Deliberately unimplemented in the proof: a failed real apply demands a HUMAN.
   * (The scheduler only calls this behind the opt-in `revertOnFailure` flag.) */
  async revert(req: RequestItem): Promise<ApplyResult> {
    return { ok: false, dryRun: false, detail: `REFUSED: revert is not implemented in the proof executor — ${req.id} stays halted for a human` };
  }
}

/** Does this resolved absolute path contain a real-estate segment pair? */
export function isRealEstateRoot(root: string): boolean {
  const segments = resolve(root).split(sep);
  return REAL_ESTATE_ROOT_SEGMENTS.some(([a, b]) => segments.some((s, i) => s === a && segments[i + 1] === b));
}

function tail(text: string, lines = 12): string {
  const all = text.trimEnd().split('\n');
  return all.slice(-lines).join('\n');
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split('\n').filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? '';
}
