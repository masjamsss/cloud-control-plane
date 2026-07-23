import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { RequestItem } from '../src/store/schema';
import { seedRequests } from './helpers/seed';
import { digestOf } from '../src/domain/apply/executor';
import { selectExecutor } from '../src/domain/apply/loop';
import { HALTED_DRIFT, runDueApplies } from '../src/domain/apply/scheduler';
import {
  isRealEstateRoot,
  normalizePlanText,
  TerraformExecutor,
  TerraformExecutorError,
} from '../src/domain/apply/terraformExecutor';

/**
 * PROOF MILESTONE — the real TerraformExecutor. Two layers:
 *  1. Guards that need NO terraform binary: the constructor's explicit-root +
 *     real-estate-deny, and apply()'s fail-closed pre-checks (pin intact, artifact
 *     present, approved-digest === artifact, planfile untampered, plan-only refusal).
 *     These are what make the executor safe BY CONSTRUCTION.
 *  2. A live integration block (skipped when terraform is not installed) that runs
 *     the REAL flow on an offline sandbox (builtin `terraform_data`, zero providers,
 *     zero network, zero AWS): plan → pin → scheduler replan/digest-match → apply
 *     actually creates the artifact; then the drift case → HALTED_DRIFT, no apply.
 *     This is the same flow scripts/proof-terraform-executor.ts demonstrates.
 */

const hasTerraform = spawnSync('terraform', ['version'], { stdio: 'ignore' }).status === 0;

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** The offline sandbox root: one builtin `terraform_data` resource whose local-exec
 * provisioner writes a visible artifact on CREATE. No providers, no backend, no AWS. */
function writeSandbox(dir: string, message: string): void {
  writeFileSync(
    join(dir, 'main.tf'),
    [
      '# Cloud Control Plane PROOF sandbox — builtin terraform_data only: no providers, no backend,',
      '# no AWS. Applying it writes proof-artifact.txt via a local-exec provisioner.',
      'variable "message" {',
      '  type = string',
      '}',
      '',
      'resource "terraform_data" "proof" {',
      '  input = var.message',
      '',
      '  provisioner "local-exec" {',
      '    command = "echo \\"ccp proof artifact: ${var.message}\\" > proof-artifact.txt"',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'terraform.tfvars'), `message = "${message}"\n`);
}

/* ── constructor guards (no terraform binary needed) ─────────────────────────── */

describe('constructor guards — explicit root only, real estate refused', () => {
  it('refuses a missing, relative, or nonexistent rootDir', () => {
    expect(() => new TerraformExecutor({ rootDir: '' })).toThrow(TerraformExecutorError);
    expect(() => new TerraformExecutor({ rootDir: 'relative/sandbox' })).toThrow(/ABSOLUTE/);
    expect(() => new TerraformExecutor({ rootDir: join(tmpdir(), 'ccp-does-not-exist-xyz') })).toThrow(/does not exist/);
  });

  it('REFUSES the real estate roots (environments/prod, importer/prod, importer/bootstrap) unless planOnly', () => {
    const base = scratch('ccp-tfexec-guard-');
    for (const seg of ['environments/prod', 'importer/prod', 'importer/bootstrap'] as const) {
      const root = join(base, seg);
      mkdirSync(root, { recursive: true });
      expect(isRealEstateRoot(root)).toBe(true);
      expect(() => new TerraformExecutor({ rootDir: root })).toThrow(/real estate root/);
      // planOnly:true may construct (the read-only real-estate plan the operator runs
      // with his own creds) — but apply stays refused unconditionally (next describe).
      expect(() => new TerraformExecutor({ rootDir: root, planOnly: true })).not.toThrow();
    }
    // …and a root UNDER a real estate root is refused too.
    const nested = join(base, 'environments/prod/eu-west-1');
    mkdirSync(nested, { recursive: true });
    expect(() => new TerraformExecutor({ rootDir: nested })).toThrow(/real estate root/);
  });

  it('selectExecutor(terraform) can NEVER hand back an apply-capable real-estate executor', () => {
    const base = scratch('ccp-tfexec-select-');
    const prodish = join(base, 'environments/prod');
    mkdirSync(prodish, { recursive: true });
    expect(() => selectExecutor({ CCP_EXECUTOR: 'terraform', CCP_TF_ROOT: prodish })).toThrow(/real estate root/);
  });

  it('a sandbox root constructs, and reports kind "terraform"', () => {
    const root = scratch('ccp-tfexec-ok-');
    const ex = new TerraformExecutor({ rootDir: root });
    expect(ex.kind).toBe('terraform');
  });
});

/* ── apply() pre-checks — every one fails CLOSED before terraform is touched ──── */

describe('apply() pre-checks — refuse before terraform is ever spawned', () => {
  const REQ = (over: Partial<RequestItem>): RequestItem => ({ id: 'req-1', ...over }) as RequestItem;

  /** An executor over an empty sandbox; pre-check failures return before any spawn,
   * so these tests run fine on a machine with no terraform at all. */
  function bareExecutor(): { ex: TerraformExecutor; root: string; artDir: string } {
    const root = scratch('ccp-tfexec-apply-');
    const ex = new TerraformExecutor({ rootDir: root });
    return { ex, root, artDir: join(root, '.ccp-apply', 'req-1') };
  }

  /** Hand-write a recorded plan artifact (what plan() would have produced). */
  function writeArtifact(artDir: string, planText: string, planfileBytes = 'PLANFILE-BYTES'): void {
    mkdirSync(artDir, { recursive: true });
    writeFileSync(join(artDir, 'plan.txt'), normalizePlanText(planText));
    writeFileSync(join(artDir, 'tfplan'), planfileBytes);
    writeFileSync(join(artDir, 'tfplan.sha256'), `${digestOf(planfileBytes)}\n`);
  }

  it('plan-only executor refuses apply unconditionally', async () => {
    const root = scratch('ccp-tfexec-planonly-');
    const ex = new TerraformExecutor({ rootDir: root, planOnly: true });
    const diff = normalizePlanText('some plan');
    const res = await ex.apply(REQ({ pinnedDiff: diff, planDigest: digestOf(diff) }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/plan-only/);
  });

  it('missing/corrupt pin → refused (never trusts the caller)', async () => {
    const { ex } = bareExecutor();
    expect((await ex.apply(REQ({}))).ok).toBe(false);
    expect((await ex.apply(REQ({ pinnedDiff: 'x', planDigest: 'not-its-digest' }))).detail).toMatch(/pinned plan missing or corrupt/);
  });

  it('no recorded plan artifact → refused (plan() must run first)', async () => {
    const { ex } = bareExecutor();
    const diff = normalizePlanText('a reviewed plan');
    const res = await ex.apply(REQ({ pinnedDiff: diff, planDigest: digestOf(diff) }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no recorded plan artifact/);
  });

  it('approved digest != recorded plan artifact → "PLAN CHANGED SINCE APPROVAL", refused', async () => {
    const { ex, artDir } = bareExecutor();
    writeArtifact(artDir, 'the plan the EXECUTOR recorded');
    const approved = normalizePlanText('the plan the HUMANS approved (different!)');
    const res = await ex.apply(REQ({ pinnedDiff: approved, planDigest: digestOf(approved) }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/PLAN CHANGED SINCE APPROVAL/);
  });

  it('planfile bytes tampered after plan time → refused', async () => {
    const { ex, artDir } = bareExecutor();
    const diff = 'the reviewed plan';
    writeArtifact(artDir, diff);
    writeFileSync(join(artDir, 'tfplan'), 'TAMPERED-BYTES'); // sha256 no longer matches the record
    const pinned = normalizePlanText(diff);
    const res = await ex.apply(REQ({ pinnedDiff: pinned, planDigest: digestOf(pinned) }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/modified since plan time/);
  });

  it('an unsafe request id can never escape the artifact dir', async () => {
    const { ex } = bareExecutor();
    const diff = normalizePlanText('plan');
    const res = await ex.apply(REQ({ id: '../../etc', pinnedDiff: diff, planDigest: digestOf(diff) }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/unsafe request id/);
  });

  it('revert is refused (a halted real apply demands a human)', async () => {
    const { ex } = bareExecutor();
    const res = await ex.revert(REQ({}));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/not implemented/);
  });
});

/* ── LIVE integration — real terraform on the offline sandbox ─────────────────── */

describe.skipIf(!hasTerraform)('LIVE (terraform required): plan → pin → digest-gated apply, and halt-on-drift', () => {
  const PROJECT = 'sample';
  const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
  const IN_WINDOW = Date.parse('2026-08-01T01:00:00.000Z');
  const APPROVALS = [
    { user: 'budi', at: '2026-07-30T00:00:00.000Z' },
    { user: 'lina', at: '2026-07-30T01:00:00.000Z' },
  ];

  it(
    'the approved plan applies EXACTLY (artifact created); a mutated root HALTS with DRIFT and applies nothing',
    async () => {
      const root = scratch('ccp-tf-live-');
      writeSandbox(root, 'sandbox-v1');
      const ex = new TerraformExecutor({ rootDir: root });

      // PLAN (the CI role): real `terraform init` + `plan -out` + canonical rendering.
      const planned = await ex.plan({ id: 'seed-sari-0' });
      expect(planned.diff).toMatch(/terraform_data\.proof/);
      expect(planned.diff).toMatch(/will be created/);
      expect(planned.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(planned.planfileSha).toMatch(/^[0-9a-f]{64}$/);

      // Determinism anchor: an untouched world re-plans to the SAME digest.
      const replanSame = await ex.replan({ id: 'seed-sari-0' } as RequestItem);
      expect(replanSame.digest).toBe(planned.digest);

      // PIN + full approval + open window, then the REAL scheduler drives the REAL executor.
      const store = new MemoryStore();
      await seedRequests(store, PROJECT, 'sari', 1, {
        status: 'AWAITING_DEPLOY_APPROVAL',
        operationId: 'ebs-grow',
        targetAddress: 'terraform_data.proof',
        approvalsRequired: 2,
        approvals: APPROVALS,
        schedule: WINDOW,
        pinnedDiff: planned.diff,
        planDigest: planned.digest,
      });
      const outcomes = await runDueApplies(store, PROJECT, IN_WINDOW, ex, {});
      expect(outcomes).toEqual([{ requestId: 'seed-sari-0', result: 'applied' }]);

      const req = (await store.get(`P#${PROJECT}#REQ#seed-sari-0`, 'META')) as RequestItem;
      expect(req.status).toBe('APPLIED');
      expect(req.appliedSha).toBe(planned.planfileSha); // the applied artifact IS the recorded one

      // The apply REALLY ran: the provisioner wrote the artifact.
      const artifact = readFileSync(join(root, 'proof-artifact.txt'), 'utf8');
      expect(artifact).toContain('ccp proof artifact: sandbox-v1');

      // ── HALT-ON-DRIFT ── a second change is planned+approved, then the ROOT MUTATES
      // between approval and the window: the re-plan digest differs → HALTED_DRIFT,
      // apply() is never called, nothing changes.
      writeFileSync(join(root, 'terraform.tfvars'), 'message = "sandbox-v2"\n');
      const planned2 = await ex.plan({ id: 'seed-budi-0' });
      expect(planned2.digest).not.toBe(planned.digest);
      await seedRequests(store, PROJECT, 'budi', 1, {
        status: 'AWAITING_DEPLOY_APPROVAL',
        operationId: 'ebs-grow',
        targetAddress: 'terraform_data.proof',
        approvalsRequired: 2,
        approvals: APPROVALS,
        schedule: WINDOW,
        pinnedDiff: planned2.diff,
        planDigest: planned2.digest,
      });
      // …the world moves AFTER approval (someone edits the root out-of-band):
      writeFileSync(join(root, 'terraform.tfvars'), 'message = "sandbox-v3-mutated"\n');

      const outcomes2 = await runDueApplies(store, PROJECT, IN_WINDOW, ex, {});
      expect(outcomes2).toEqual([{ requestId: 'seed-budi-0', result: 'halted', haltReason: 'DRIFT' }]);
      const req2 = (await store.get(`P#${PROJECT}#REQ#seed-budi-0`, 'META')) as RequestItem;
      expect(req2.status).toBe(HALTED_DRIFT);
      // No apply ran for the drifted request: no apply log, artifact still v1.
      expect(existsSync(join(root, '.ccp-apply', 'seed-budi-0', 'apply.log'))).toBe(false);
      expect(readFileSync(join(root, 'proof-artifact.txt'), 'utf8')).toContain('sandbox-v1');
    },
    120_000, // real terraform init/plan/apply — generous, typically a few seconds
  );
});
