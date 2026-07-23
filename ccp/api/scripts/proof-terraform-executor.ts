/**
 * PROOF DRIVER — the end-to-end demonstration of the real TerraformExecutor on a
 * SANDBOX terraform root. Run it on any machine with terraform installed:
 *
 *   cd ccp/api
 *   npx tsx scripts/proof-terraform-executor.ts [sandbox-dir]
 *
 * It drives the operator's confirmed flow with REAL components at every step:
 *   1. writes an offline sandbox root (builtin `terraform_data` + local-exec — NO
 *      providers, NO backend, NO AWS) in a scratch dir;
 *   2. TerraformExecutor.plan() — real `terraform init` + `plan -out=planfile`,
 *      pinning the plan text + sha256 digest + planfile sha256;
 *   3. records the structured summary through the REAL POST /requests/:id/plan-summary
 *      route (the exact path CI uses), then GETs the request to show what the
 *      approver page (PlanSummaryPanel) renders BEFORE approving;
 *   4. pins the plan + simulates the completed approval ladder (the ladder itself is
 *      covered by approvalLadder tests) and lets the REAL scheduler
 *      (runDueApplies) re-plan, digest-compare, claim, and `terraform apply` the
 *      SAVED planfile — then shows the artifact the apply created;
 *   5. HALT-ON-DRIFT: plans+approves a second change, MUTATES the root out-of-band,
 *      and shows the scheduler halting with HALTED_DRIFT — apply never runs.
 *
 * Read-only real-estate variant (the step the operator runs with his own creds —
 * plan needs only read access and changes nothing):
 *
 *   npx tsx scripts/proof-terraform-executor.ts --plan-only /abs/path/to/estate/root
 *
 * planOnly constructs the executor with apply() hard-refused; real estate roots are
 * accepted ONLY in this mode. This driver never applies in --plan-only mode, and the
 * executor cannot.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { runDueApplies } from '../src/domain/apply/scheduler';
import { executorKind, selectExecutor } from '../src/domain/apply/loop';
import { TerraformExecutor } from '../src/domain/apply/terraformExecutor';
import { seed, seedRequests, sessionCookieFor } from '../test/helpers/seed';

// This driver runs standalone (test/setup.ts does not apply), so it configures the
// legacy estate id itself: seed() + live HTTP rely on the one-time settlement
// retro-registering it and binding the bare seed accounts onto it.
process.env.CCP_LEGACY_PROJECT_ID = 'sample';

const PROJECT = 'sample';
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const IN_WINDOW = Date.parse('2026-08-01T01:00:00.000Z');
const APPROVALS = [
  { user: 'budi', at: '2026-07-30T00:00:00.000Z' },
  { user: 'lina', at: '2026-07-30T01:00:00.000Z' },
];

function banner(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function indent(text: string, prefix = '  | '): string {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');
}

function writeSandbox(dir: string, message: string): void {
  writeFileSync(
    join(dir, 'main.tf'),
    [
      '# Cloud Control Plane PROOF sandbox — builtin terraform_data only: no providers, no',
      '# backend, no AWS. Applying it writes proof-artifact.txt via local-exec.',
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

/** The CI role: plan JSON → the structured summary, via the SAME zero-dependency
 * parser CI runs (ccp/app/scripts/plan-summary.mjs), invoked exactly as
 * terraform.yml's plan job does (positional file + --run-url). */
function summarize(planJsonPath: string, runUrl: string): unknown {
  const parser = fileURLToPath(new URL('../../app/scripts/plan-summary.mjs', import.meta.url));
  return JSON.parse(execFileSync(process.execPath, [parser, planJsonPath, '--run-url', runUrl], { encoding: 'utf8' }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── read-only real-estate mode: plan and NOTHING else ─────────────────────────
  if (args[0] === '--plan-only') {
    const root = args[1];
    if (!root) throw new Error('usage: proof-terraform-executor.ts --plan-only /abs/path/to/root');
    banner(`PLAN-ONLY (read-only) against ${root} — apply is refused by construction`);
    const ex = new TerraformExecutor({ rootDir: resolve(root), planOnly: true, workDir: mkdtempSync(join(tmpdir(), 'ccp-planonly-')) });
    const planned = await ex.plan({ id: 'plan-only-probe' });
    console.log(indent(planned.diff));
    console.log(`\n  plan digest  : sha256 ${planned.digest}`);
    console.log(`  planfile sha : sha256 ${planned.planfileSha}`);
    const refused = await ex.apply({ id: 'plan-only-probe', pinnedDiff: planned.diff, planDigest: planned.digest } as RequestItem);
    console.log(`  apply attempt: ok=${String(refused.ok)} — ${refused.detail}`);
    return;
  }

  banner('STEP 0 — preconditions');
  console.log(indent(execFileSync('terraform', ['version'], { encoding: 'utf8' })));
  console.log(`  default executor selection (flag off): ${executorKind({})} — ${selectExecutor({}).constructor.name}`);

  // ── the sandbox root (a scratch dir, NEVER an estate root) ────────────────────
  const root = args[0] !== undefined ? resolve(args[0]) : mkdtempSync(join(tmpdir(), 'ccp-proof-'));
  mkdirSync(root, { recursive: true });
  writeSandbox(root, 'sandbox-v1');
  banner(`STEP 1 — sandbox terraform root at ${root}`);
  console.log(indent(readFileSync(join(root, 'main.tf'), 'utf8')));
  console.log(indent(`terraform.tfvars: ${readFileSync(join(root, 'terraform.tfvars'), 'utf8').trim()}`));

  // The executor, exactly as the loop would construct it from env flags.
  const ex = selectExecutor({ CCP_EXECUTOR: 'terraform', CCP_TF_ROOT: root }) as TerraformExecutor;
  console.log(`  selected executor: ${ex.kind} (CCP_EXECUTOR=terraform, CCP_TF_ROOT=${root})`);

  // ── the api + a seeded request (requester sari; leads putra/lina; approver budi)
  const store = new MemoryStore();
  await seed(store);
  const app = createApp(store);
  const REQ_ID = 'seed-sari-0';
  await seedRequests(store, PROJECT, 'sari', 1, {
    status: 'AWAITING_CODE_REVIEW', // PR open — the plan lands now, BEFORE approval
    operationId: 'ebs-grow',
    targetAddress: 'terraform_data.proof',
    approvalsRequired: 2,
    approvals: [],
    schedule: WINDOW,
  });

  banner('STEP 2 — TerraformExecutor.plan(): real `terraform init` + `terraform plan -out=planfile`');
  const planned = await ex.plan({ id: REQ_ID });
  console.log('  --- live `terraform plan` output ---');
  console.log(indent(planned.runOutput));
  console.log('  --- canonical plan text (terraform show of the SAVED planfile) — this is what gets pinned ---');
  console.log(indent(planned.diff));
  console.log(`  plan digest (sha256 of the plan text) : ${planned.digest}`);
  console.log(`  planfile sha256 (the saved artifact)  : ${planned.planfileSha}`);

  banner('STEP 3 — the plan surfaces on the approver page via the REAL plan-summary route');
  const summary = summarize(planned.planJsonPath, 'https://github.com/masjamsss/cloud-control-plane/actions/runs/0');
  console.log('  structured summary from app/scripts/plan-summary.mjs (the CI parser):');
  console.log(indent(JSON.stringify(summary, null, 2)));
  const leadCookie = await sessionCookieFor(store, 'putra');
  const post = await app.request(`/requests/${REQ_ID}/plan-summary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie: leadCookie },
    body: JSON.stringify(summary),
  });
  console.log(`  POST /requests/${REQ_ID}/plan-summary → ${post.status}`);
  if (post.status !== 200) throw new Error(`plan-summary POST failed: ${await post.text()}`);

  const view = (await (
    await app.request(`/requests/${REQ_ID}`, { headers: { 'x-ccp-client': 'ccp-spa', cookie: await sessionCookieFor(store, 'budi') } })
  ).json()) as { planSummary?: unknown; events: Array<{ type: string; label: string }> };
  console.log('  GET /requests/:id as the APPROVER (budi) — planSummary now on the request');
  console.log(indent(JSON.stringify(view.planSummary, null, 2)));
  console.log(`  timeline event: ${view.events.find((e) => e.type === 'plan_summary')?.label ?? '(none)'}`);
  console.log('  (PlanSummaryPanel renders exactly this planSummary field on RequestDetail + the approvals queue)');

  banner('STEP 4 — pin the approved plan, complete the ladder, and let the REAL scheduler apply the SAVED planfile');
  // The pin + completed two-level ladder + open window (approval mechanics are
  // covered by approvalLadder/dualControl tests — this proof exercises the executor).
  const k = requestKey(PROJECT, REQ_ID);
  const cur = (await store.get(k.PK, k.SK)) as RequestItem;
  await store.put({
    ...cur,
    status: 'AWAITING_DEPLOY_APPROVAL',
    approvals: APPROVALS,
    pinnedDiff: planned.diff,
    planDigest: planned.digest,
  } as RequestItem);
  console.log(`  request ${REQ_ID}: AWAITING_DEPLOY_APPROVAL, approvals 2/2, plan pinned (digest ${planned.digest.slice(0, 16)}…)`);
  console.log(`  window open at ${new Date(IN_WINDOW).toISOString()} → scheduler tick (replan → digest compare → claim → apply)`);

  const outcomes = await runDueApplies(store, PROJECT, IN_WINDOW, ex, {});
  console.log(`  scheduler outcome: ${JSON.stringify(outcomes)}`);
  const applied = (await store.get(k.PK, k.SK)) as RequestItem;
  console.log(`  request status   : ${applied.status}`);
  console.log(`  appliedSha       : ${applied.appliedSha} (== planfile sha256 above: ${String(applied.appliedSha === planned.planfileSha)})`);
  console.log(`  evidenceUrl      : ${applied.evidenceUrl}`);
  console.log('  --- live `terraform apply` output (the apply log) ---');
  console.log(indent(readFileSync(new URL(applied.evidenceUrl!), 'utf8')));
  console.log('  --- the apply REALLY happened: the sandbox artifact exists ---');
  console.log(`  ${join(root, 'proof-artifact.txt')}:`);
  console.log(indent(readFileSync(join(root, 'proof-artifact.txt'), 'utf8')));
  console.log('  timeline:');
  for (const e of applied.events) console.log(`    - [${e.type}] ${e.label}`);

  banner('STEP 5 — HALT-ON-DRIFT: the root mutates between approval and the window');
  const REQ2_ID = 'seed-budi-0';
  writeFileSync(join(root, 'terraform.tfvars'), 'message = "sandbox-v2"\n');
  console.log('  change under review: message sandbox-v1 → sandbox-v2 (tfvars edited, plan taken):');
  const planned2 = await ex.plan({ id: REQ2_ID });
  console.log(indent(planned2.diff));
  console.log(`  approved digest: ${planned2.digest}`);
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
  writeFileSync(join(root, 'terraform.tfvars'), 'message = "sandbox-v3-mutated"\n');
  console.log('  !! OUT-OF-BAND MUTATION after approval: terraform.tfvars now says sandbox-v3-mutated');

  const outcomes2 = await runDueApplies(store, PROJECT, IN_WINDOW, ex, {});
  console.log(`  scheduler outcome: ${JSON.stringify(outcomes2)}`);
  const halted = (await store.get(requestKey(PROJECT, REQ2_ID).PK, requestKey(PROJECT, REQ2_ID).SK)) as RequestItem;
  console.log(`  request status   : ${halted.status}`);
  for (const e of halted.events) console.log(`    - [${e.type}] ${e.label}`);
  console.log(`  apply.log for ${REQ2_ID} exists: ${String(existsSync(join(root, '.ccp-apply', REQ2_ID, 'apply.log')))} (apply was never called)`);
  console.log(`  artifact untouched: ${readFileSync(join(root, 'proof-artifact.txt'), 'utf8').trim()}`);

  banner('DONE — plan approved == plan applied, or nothing is');
  console.log(`  sandbox root kept for inspection: ${root}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
