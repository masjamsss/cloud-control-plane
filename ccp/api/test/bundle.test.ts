import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { bundleConfig, realSteps, runBundle, type BundleSteps, type StepResult } from '../src/domain/bundle';
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
  it('unset ⇒ null; flag alone ⇒ null; fully configured ⇒ armed', () => {
    expect(bundleConfig({})).toBeNull();
    expect(bundleConfig({ CCP_BUNDLE: '1' })).toBeNull();
    expect(bundleConfig({ CCP_BUNDLE: '1', CCP_GIT_REMOTE: 'r', CCP_BUNDLE_GATE_CMD: 'true' })).toBeNull();
    const cfg = bundleConfig({ CCP_BUNDLE: '1', CCP_GIT_REMOTE: 'r', CCP_BUNDLE_GATE_CMD: 'g', CCP_BUNDLE_TRIGGER_CMD: 't' });
    expect(cfg).toEqual({ remote: 'r', branch: 'main', gateCmd: 'g', triggerCmd: 't' });
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

  it('a red gate stops the bundle BEFORE any commit', () => {
    const { steps, calls } = fakes({ gate: { ok: false, detail: 'plan digest mismatch' } });
    const out = runBundle(steps, '{}', 'msg');
    expect(out.ok).toBe(false);
    expect(calls).toEqual(['prepare', 'gate', 'cleanup']); // no commit, no trigger
    expect(out.steps.at(-1)).toMatchObject({ step: 'gate', ok: false });
  });

  it('a rejected CAS push stops the bundle BEFORE the trigger', () => {
    const { steps, calls } = fakes({ commit: { ok: false, detail: 'push rejected (branch moved)' } });
    const out = runBundle(steps, '{}', 'msg');
    expect(out.ok).toBe(false);
    expect(calls).toEqual(['prepare', 'gate', 'commit', 'cleanup']);
  });

  it('green end-to-end runs all steps in order and reports the landed sha', () => {
    const { steps, calls } = fakes({});
    const out = runBundle(steps, '{}', 'msg');
    expect(out.ok).toBe(true);
    expect(out.sha).toBe('b'.repeat(40));
    expect(calls).toEqual(['prepare', 'gate', 'commit', 'trigger', 'cleanup']);
  });
});

describe('realSteps — the git workspace (local bare origin; no network)', () => {
  it('green path: gate edit + evidence land on main as one commit', () => {
    const { bare } = makeOrigin();
    const steps = realSteps({ remote: bare, branch: 'main', gateCmd: 'echo gated-change > "$BUNDLE_CHECKOUT/changed.txt"', triggerCmd: 'true' });
    const out = runBundle(steps, '{"id":"REQ-1"}', 'ccp: apply REQ-1');
    expect(out.ok).toBe(true);
    // the bare's main advanced to the bundle commit, carrying edit + evidence
    const files = g(bare, 'ls-tree', '--name-only', 'main');
    expect(files).toContain('changed.txt');
    expect(files).toContain('.bundle-request.json');
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('ccp: apply REQ-1');
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });

  it('CAS: a commit that lands mid-bundle REJECTS the push (nothing slips in between)', () => {
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
    const out = runBundle(steps, '{}', 'bundle');
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
    expect(body.steps.map((s: { step: string; ok: boolean }) => `${s.step}:${s.ok}`)).toEqual(['prepare:true', 'gate:true', 'commit:true', 'trigger:true']);
    // the change really landed on the origin's main
    expect(g(bare, 'ls-tree', '--name-only', '-r', 'main')).toContain('environments/change.tf');
    // re-click ⇒ refused (already triggered)
    const again = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(again.status).toBe(409);
    rmSync(join(bare, '..'), { recursive: true, force: true });
  });
});
