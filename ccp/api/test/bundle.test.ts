import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { bundleConfig, realSteps, runBundle, type BundleSteps, type StepResult } from '../src/domain/bundle';
import * as execMod from '../src/domain/exec';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * ADR-0016 — the approval-to-apply bundle. Covers: the off-by-default arming
 * contract, the stop-on-red orchestration, the REAL git workspace's CAS push
 * (against a local bare repo — no network), and the route surface
 * (disarmed / authz / status / happy path).
 */

const ENV_KEYS = ['CCP_BUNDLE', 'CCP_GIT_REMOTE', 'CCP_GIT_BRANCH', 'CCP_BUNDLE_GATE_CMD', 'CCP_BUNDLE_TRIGGER_CMD'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A bare origin with one seeded commit on main; returns { bare, seedClone }. */
function makeOrigin(): { bare: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'bundle-origin-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' });
  writeFileSync(join(work, 'README.md'), 'seed\n');
  g(work, 'add', '-A');
  g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed');
  g(work, 'push', 'origin', 'HEAD:refs/heads/main');
  return { bare, work };
}

describe('bundleConfig — off by default (the load-bearing invariant)', () => {
  it('unset ⇒ null; flag alone ⇒ null; fully configured ⇒ armed', async () => {
    expect(bundleConfig({})).toBeNull();
    expect(bundleConfig({ CCP_BUNDLE: '1' })).toBeNull();
    expect(bundleConfig({ CCP_BUNDLE: '1', CCP_GIT_REMOTE: 'r', CCP_BUNDLE_GATE_CMD: 'true' })).toBeNull();
    const cfg = bundleConfig({ CCP_BUNDLE: '1', CCP_GIT_REMOTE: 'r', CCP_BUNDLE_GATE_CMD: 'g', CCP_BUNDLE_TRIGGER_CMD: 't' });
    // `remoteSource`/`remoteDetail` are ARCH-2: WHICH estate's repository resolved, and
    // how. With no project passed there is nothing registered to prefer, so the
    // deployment-global remote serves it — the single-estate fallback, unchanged.
    expect(cfg).toEqual({ remote: 'r', remoteSource: 'env-global', remoteDetail: 'CCP_GIT_REMOTE', branch: 'main', gateCmd: 'g', triggerCmd: 't' });
  });
});

describe('runBundle — sequential, stop-on-red, cleanup-always', () => {
  function fakes(overrides: Partial<Record<'gate' | 'commit' | 'trigger', StepResult & { sha?: string }>>): { steps: BundleSteps; calls: string[] } {
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'bundle-fake-'));
    const steps: BundleSteps = {
      prepare: () => { calls.push('prepare'); return { dir, baseSha: 'a'.repeat(40) }; },
      gate: () => { calls.push('gate'); return overrides.gate ?? { ok: true, detail: 'green' }; },
      commit: () => { calls.push('commit'); return overrides.commit ?? { ok: true, sha: 'b'.repeat(40), detail: 'landed' }; },
      trigger: () => { calls.push('trigger'); return overrides.trigger ?? { ok: true, detail: 'fired' }; },
      cleanup: () => { calls.push('cleanup'); },
    };
    return { steps, calls };
  }

  it('a red gate stops the bundle BEFORE any commit', async () => {
    const { steps, calls } = fakes({ gate: { ok: false, detail: 'plan digest mismatch' } });
    const out = await runBundle(steps, '{}', 'msg');
    expect(out.ok).toBe(false);
    expect(calls).toEqual(['prepare', 'gate', 'cleanup']); // no commit, no trigger
    expect(out.steps.at(-1)).toMatchObject({ step: 'gate', ok: false });
  });

  it('a rejected CAS push stops the bundle BEFORE the trigger', async () => {
    const { steps, calls } = fakes({ commit: { ok: false, detail: 'push rejected (branch moved)' } });
    const out = await runBundle(steps, '{}', 'msg');
    expect(out.ok).toBe(false);
    expect(calls).toEqual(['prepare', 'gate', 'commit', 'cleanup']);
  });

  it('green end-to-end runs all steps in order and reports the landed sha', async () => {
    const { steps, calls } = fakes({});
    const out = await runBundle(steps, '{}', 'msg');
    expect(out.ok).toBe(true);
    expect(out.sha).toBe('b'.repeat(40));
    expect(calls).toEqual(['prepare', 'gate', 'commit', 'trigger', 'cleanup']);
  });
});

describe('realSteps — the git workspace (local bare origin; no network)', () => {
  it('green path: gate edit + evidence land on main as one commit', async () => {
    const { bare } = makeOrigin();
    const steps = realSteps({ remote: bare, branch: 'main', gateCmd: 'echo gated-change > "$BUNDLE_CHECKOUT/changed.txt"', triggerCmd: 'true' });
    const out = await runBundle(steps, '{"id":"REQ-1"}', 'ccp: apply REQ-1');
    expect(out.ok).toBe(true);
    // the bare's main advanced to the bundle commit, carrying edit + evidence
    const files = g(bare, 'ls-tree', '--name-only', 'main');
    expect(files).toContain('changed.txt');
    expect(files).toContain('.bundle-request.json');
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('ccp: apply REQ-1');
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });

  it('CAS: a commit that lands mid-bundle REJECTS the push (nothing slips in between)', async () => {
    const { bare, work } = makeOrigin();
    let raced = false;
    const inner = realSteps({ remote: bare, branch: 'main', gateCmd: 'echo x > "$BUNDLE_CHECKOUT/x.txt"', triggerCmd: 'true' });
    const steps: BundleSteps = {
      ...inner,
      gate: (dir, reqPath) => {
        // interleave a third-party commit on main AFTER prepare, BEFORE our push
        writeFileSync(join(work, 'interloper.txt'), 'raced\n');
        g(work, 'add', '-A');
        g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'interloper');
        g(work, 'push', 'origin', 'HEAD:refs/heads/main');
        raced = true;
        return inner.gate(dir, reqPath);
      },
    };
    const out = await runBundle(steps, '{}', 'bundle');
    expect(raced).toBe(true);
    expect(out.ok).toBe(false);
    const commitStep = out.steps.find((s) => s.step === 'commit')!;
    expect(commitStep.ok).toBe(false);
    expect(commitStep.detail).toMatch(/push rejected/);
    // the interloper commit is untouched; our bundle commit did NOT land
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('interloper');
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });
});

/**
 * API-16 / ERR-13 — a workspace leak and two unchecked git results. The clone
 * itself and the rev-parse/add/commit failures around it are all real git
 * calls against the local bare origin above (no network); only the ONE step
 * each test needs to fail is intercepted via a spy on `execCapture` (real for
 * every OTHER call, including the clone that must actually create the
 * workspace this is testing gets cleaned up) — reproducing a genuinely
 * pathological git failure (e.g. a fresh clone whose HEAD somehow will not
 * resolve) is not otherwise reliably constructible with real git.
 */
describe('realSteps — API-16 / ERR-13: the workspace leak and the two unchecked git results', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prepare() cleans up the clone when rev-parse HEAD fails, same as it already does on a clone failure', async () => {
    const { bare } = makeOrigin();
    const real = execMod.execCapture;
    let leakedDir: string | undefined;
    vi.spyOn(execMod, 'execCapture').mockImplementation(async (file, args, opts) => {
      if (file === 'git' && args[0] === 'rev-parse') {
        leakedDir = opts?.cwd;
        return { status: 1, out: 'fatal: fake rev-parse failure' };
      }
      return real(file, args, opts);
    });
    const steps = realSteps({ remote: bare, branch: 'main', gateCmd: 'true', triggerCmd: 'true' });
    const result = await steps.prepare();
    expect('error' in result).toBe(true);
    expect(leakedDir, 'the rev-parse call never happened — the test itself is broken').toBeTruthy();
    expect(existsSync(leakedDir!), `clone workspace ${leakedDir} was left behind`).toBe(false);
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });

  it("commit() refuses when `git add` fails, rather than committing whatever the index already held", async () => {
    const { bare } = makeOrigin();
    const real = execMod.execCapture;
    vi.spyOn(execMod, 'execCapture').mockImplementation(async (file, args, opts) => {
      if (file === 'git' && args[0] === 'add') return { status: 128, out: 'fatal: fake add failure' };
      return real(file, args, opts);
    });
    const steps = realSteps({ remote: bare, branch: 'main', gateCmd: 'echo x > "$BUNDLE_CHECKOUT/x.txt"', triggerCmd: 'true' });
    const out = await runBundle(steps, '{}', 'bundle');
    expect(out.ok).toBe(false);
    const commitStep = out.steps.find((s) => s.step === 'commit')!;
    expect(commitStep.ok).toBe(false);
    expect(commitStep.detail).toContain('git add failed');
    // nothing landed on main — the failed add must not have been silently skipped past
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('seed');
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });

  it('commit() refuses rather than recording a malformed sha when the post-commit rev-parse fails', async () => {
    const { bare } = makeOrigin();
    const real = execMod.execCapture;
    let commitLanded = false;
    let revParseCalls = 0;
    vi.spyOn(execMod, 'execCapture').mockImplementation(async (file, args, opts) => {
      if (file === 'git' && args[0] === 'rev-parse') {
        revParseCalls++;
        // The FIRST rev-parse is prepare()'s own baseSha read — must stay real,
        // or this test would never reach commit() at all. Only the SECOND
        // (commit()'s post-commit read) is the one under test here.
        if (revParseCalls >= 2) return { status: 0, out: 'not-a-real-sha (fake malformed output)' };
      }
      if (file === 'git' && args.includes('commit')) commitLanded = true;
      return real(file, args, opts);
    });
    const steps = realSteps({ remote: bare, branch: 'main', gateCmd: 'echo x > "$BUNDLE_CHECKOUT/x.txt"', triggerCmd: 'true' });
    const out = await runBundle(steps, '{}', 'bundle');
    expect(commitLanded, 'the test never reached the commit it means to test').toBe(true);
    expect(out.ok).toBe(false);
    const commitStep = out.steps.find((s) => s.step === 'commit')!;
    expect(commitStep.ok).toBe(false);
    expect(commitStep.detail).toContain('did not resolve to a real sha');
    expect(out.sha).toBeUndefined(); // never handed a bogus sha up to the caller
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });
});

describe('POST /requests/:id/apply — the route surface', () => {
  async function seededApp(status: string) {
    const store = new MemoryStore();
    await seed(store);
    await seedRequests(store, 'sample', 'sari', 1, {
      status,
      exposure: 'l1_with_guardrails',
      operationId: 'ebs-grow',
      approvalsRequired: 2,
      approvals: [
        { user: 'budi', at: '2026-07-01T00:00:00.000Z' },
        { user: 'lina', at: '2026-07-02T00:00:00.000Z' },
      ],
      schedule: { kind: 'now' },
    });
    return { store, app: createApp(store), id: 'seed-sari-0' };
  }
  // data-birth: a header-less request now acts on the reserved `@control` scope,
  // not an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
  const post = (app: ReturnType<typeof createApp>, cookie: string, id: string) =>
    app.request(`/requests/${id}/apply`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });

  it('disarmed (env unset) ⇒ 409 BUNDLE_DISARMED and NOTHING runs — deploy-inert', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const { store, app, id } = await seededApp('AWAITING_DEPLOY_APPROVAL');
    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BUNDLE_DISARMED');
  });

  it('armed: a plain approver is refused (senior-only, the deploy-approval tier)', async () => {
    const { bare } = makeOrigin();
    Object.assign(process.env, { CCP_BUNDLE: '1', CCP_GIT_REMOTE: bare, CCP_BUNDLE_GATE_CMD: 'true', CCP_BUNDLE_TRIGGER_CMD: 'true' });
    const { store, app, id } = await seededApp('AWAITING_DEPLOY_APPROVAL');
    const res = await post(app, await sessionCookieFor(store, 'budi'), id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('APPLY_FORBIDDEN');
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });

  it('armed: a pre-quorum request is refused (STATE_CONFLICT)', async () => {
    const { bare } = makeOrigin();
    Object.assign(process.env, { CCP_BUNDLE: '1', CCP_GIT_REMOTE: bare, CCP_BUNDLE_GATE_CMD: 'true', CCP_BUNDLE_TRIGGER_CMD: 'true' });
    const { store, app, id } = await seededApp('AWAITING_CODE_REVIEW');
    // flip to an open status to prove the eligibility set is enforced
    const { requestKey } = await import('../src/store/schema');
    const k = requestKey('sample', id);
    await store.transact([{ kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'NEEDS_ENGINEER' }, ifEquals: { attr: 'status', value: 'AWAITING_CODE_REVIEW' } }]);
    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(409);
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });

  it('ARCH-2: an estate whose OWN repo will not resolve is refused — it never borrows the global remote', async () => {
    // The finding's exact impact, offline: the deployment's `CCP_GIT_REMOTE` is a
    // perfectly good checkout, and this estate must still NOT be applied from it.
    // Before the fix the bundle would have cloned it happily and gated inside another
    // estate's Terraform.
    const { bare } = makeOrigin();
    Object.assign(process.env, {
      CCP_BUNDLE: '1',
      CCP_GIT_REMOTE: bare,
      CCP_BUNDLE_GATE_CMD: 'echo should-never-run > "$BUNDLE_CHECKOUT/leaked.txt"',
      CCP_BUNDLE_TRIGGER_CMD: 'true',
    });
    const { store, app, id } = await seededApp('AWAITING_DEPLOY_APPROVAL');
    // This estate registers a repo on a forge host the deployment does not allow.
    // Let the app settle/retro-register `sample` the way a real deployment does, THEN
    // give that row a repository of its own. Fabricating the row here instead would
    // bypass the known-project registry and 422 before the handler ever ran.
    const { projectKey } = await import('../src/store/schema');
    const cookie = await sessionCookieFor(store, 'lina');
    await app.request('/requests', { headers: { cookie, 'x-ccp-project': 'sample' } });
    const pk = projectKey('sample');
    const project = (await store.get(pk.PK, pk.SK)) as Record<string, unknown> | null;
    // The check must be able to fail: with no row the route takes the env-global arm and
    // every assertion below would pass for the wrong reason (L-1).
    expect(project, 'the sample project row must exist for this test to mean anything').not.toBeNull();
    await store.put({
      ...project!,
      // A forge host this deployment does not allowlist — stands in for "this estate's
      // repo is not the deployment's repo", which is the property under test.
      repo: { host: 'gitlab', baseUrl: 'https://git.internal.example', owner: 'infra', name: 'estate-b' },
    } as never);

    const res = await post(app, cookie, id);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('BUNDLE_REPO_UNRESOLVED');
    expect(body.reason).toMatch(/deliberately NOT used as a fallback/);
    // Nothing ran against the deployment's remote — the gate would have left this file.
    expect(g(bare, 'ls-tree', '--name-only', '-r', 'main')).not.toContain('leaked.txt');
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });

  it('happy path: gate → CAS land on main → trigger; request marked triggered with the sha', async () => {
    const { bare } = makeOrigin();
    Object.assign(process.env, {
      CCP_BUNDLE: '1',
      CCP_GIT_REMOTE: bare,
      CCP_BUNDLE_GATE_CMD: 'echo approved-edit > "$BUNDLE_CHECKOUT/environments/change.tf" 2>/dev/null || { mkdir -p "$BUNDLE_CHECKOUT/environments" && echo approved-edit > "$BUNDLE_CHECKOUT/environments/change.tf"; }',
      CCP_BUNDLE_TRIGGER_CMD: 'true',
    });
    const { store, app, id } = await seededApp('AWAITING_DEPLOY_APPROVAL');
    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.bundle.state).toBe('triggered');
    expect(body.bundle.sha).toMatch(/^[0-9a-f]{40}$/);
    // `plan-digest` sits between gate and commit (ARCH-3): the api re-checks the plan
    // property itself rather than inferring it from the gate command's exit code. This
    // request carries no pin (API-3 — no pin-writer is deployed), so the step passes as
    // `unpinned` and says so in its detail rather than claiming verification.
    expect(body.steps.map((s: { step: string; ok: boolean }) => `${s.step}:${s.ok}`)).toEqual(['prepare:true', 'gate:true', 'plan-digest:true', 'commit:true', 'trigger:true']);
    expect(body.steps.find((s: { step: string }) => s.step === 'plan-digest').detail).toMatch(/NOT verified/);
    // the change really landed on the origin's main
    expect(g(bare, 'ls-tree', '--name-only', '-r', 'main')).toContain('environments/change.tf');
    // re-click ⇒ refused (already triggered)
    const again = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(again.status).toBe(409);
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });
});
