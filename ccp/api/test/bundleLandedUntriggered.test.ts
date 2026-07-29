import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { execCapture } from '../src/domain/exec';
import type { ConfigStore } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { auditKey, requestKey, yyyymm } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * ERR-12 — a trigger failure after a landed commit was an honest-but-dead-end half state,
 * and spawn timeouts were indistinguishable from `exit 1`.
 *
 * **The half state.** If `commit` succeeds the change IS on the deploy branch. If
 * `trigger` then fails, the run reported `ok:false` → `bundle.state:'failed'` → 502, and
 * the landed sha survived only inside the audit `steps`. The obvious next move — click
 * Apply again — re-cloned a branch that now CONTAINED the commit, re-ran the gate, found
 * nothing left to change, and died with *"commit failed (gate left no change?)"*. That
 * message is true and actively misleading: the operator's real remediation was "the
 * change already landed; fire the CI gate approval for sha X", which nothing anywhere
 * told them. Untangling it needed git archaeology.
 *
 * It is now its own state. `landed-untriggered` carries the sha on the request row, a
 * retry resumes at the trigger instead of re-running from the top, the response says so
 * in words, and cancel refuses it for the same reason it refuses `triggered` — the COMMIT
 * is the thing that cannot be taken back, and the trigger's failure does not change that.
 *
 * **The timeout half was already closed**, by the async-exec work (CONC-5/ERR-1/PERF-2):
 * `execCapture` resolves a timeout as status **124** with `timed out after Nms` appended
 * to the output, a spawn failure as `spawn failed: …`, and a signal kill as status 128.
 * The finding describes the `spawnSync` shape that mapped all of these onto a bare
 * `status:1`. Verified against the current code below rather than assumed (L-29), because
 * "already fixed elsewhere" is a claim that needs the same evidence as any other.
 */

const ENV_KEYS = ['CCP_BUNDLE', 'CCP_GIT_REMOTE', 'CCP_GIT_BRANCH', 'CCP_BUNDLE_GATE_CMD', 'CCP_BUNDLE_TRIGGER_CMD'] as const;
const saved: Record<string, string | undefined> = {};
const temps: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps.length = 0;
});

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeOrigin(): string {
  const root = mkdtempSync(join(tmpdir(), 'err12-'));
  temps.push(root);
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' });
  writeFileSync(join(work, 'README.md'), 'seed\n');
  g(work, 'add', '-A');
  g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed');
  g(work, 'push', 'origin', 'HEAD:refs/heads/main');
  return bare;
}

/** How many commits the deploy branch carries — the ground truth for "did it land". */
function originCommits(bare: string): number {
  return Number(execFileSync('git', ['rev-list', '--count', 'main'], { cwd: bare, encoding: 'utf8' }).trim());
}

/**
 * Arm with a gate that lands a real change and a trigger that FAILS — the exact shape of
 * the finding: the commit reaches the branch, the CI gate approval does not fire.
 *
 * `triggerFile` lets a later call flip the trigger to succeeding, so the retry can be
 * tested against the same origin without re-seeding.
 */
function armLandingGateFailingTrigger(): { origin: string; triggerOk: string } {
  const dir = mkdtempSync(join(tmpdir(), 'err12-ctl-'));
  temps.push(dir);
  const triggerOk = join(dir, 'trigger-ok');
  const origin = makeOrigin();
  Object.assign(process.env, {
    CCP_BUNDLE: '1',
    CCP_GIT_REMOTE: origin,
    // A gate that genuinely edits the checkout, so `commit` has something to land.
    CCP_BUNDLE_GATE_CMD: 'date +%s%N > "$BUNDLE_CHECKOUT/gated.txt"',
    // Fails until the sentinel exists.
    CCP_BUNDLE_TRIGGER_CMD: `test -e '${triggerOk}'`,
  });
  return { origin, triggerOk };
}

async function seededApp(bundle?: RequestItem['bundle']): Promise<{ store: ConfigStore; app: ReturnType<typeof createApp>; id: string }> {
  const store = new MemoryStore();
  await seed(store);
  await seedRequests(store, 'sample', 'sari', 1, {
    status: 'AWAITING_DEPLOY_APPROVAL',
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-01T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-02T00:00:00.000Z' },
    ],
    ...(bundle ? { bundle } : {}),
  });
  return { store, app: createApp(store), id: 'seed-sari-0' };
}

const apply = async (app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/apply`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });

const cancel = async (app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/cancel`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });

const readRow = async (store: ConfigStore, id: string): Promise<RequestItem> => {
  const k = requestKey('sample', id);
  return (await store.get(k.PK, k.SK)) as RequestItem;
};

async function bundleEntries(store: ConfigStore): Promise<Array<Record<string, unknown>>> {
  const pk = auditKey('sample', yyyymm(new Date()), 'x').PK;
  const rows = (await store.query(pk)) as Array<Record<string, unknown>>;
  return rows.filter((r) => r.action === 'request-bundle');
}

describe('ERR-12 — a landed commit whose trigger failed is its own state, not "failed"', () => {
  it('THE DEFECT: the sha used to survive only inside the audit steps', async () => {
    const { origin } = armLandingGateFailingTrigger();
    const { store, app, id } = await seededApp();
    const before = originCommits(origin);

    const res = await apply(app, await sessionCookieFor(store, 'lina'), id);

    // The setup must really have landed something, or this test proves nothing (L-1).
    expect(originCommits(origin), 'the commit must actually be on the branch').toBe(before + 1);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { bundle: { state: string; sha?: string }; code?: string; reason?: string };
    expect(body.bundle.state, 'not the undifferentiated `failed` any more').toBe('landed-untriggered');
    expect(body.bundle.sha, 'THE DEFECT: the sha is on the request row, not only in the steps').toMatch(/^[0-9a-f]{40}$/);
    expect(body.code).toBe('BUNDLE_LANDED_UNTRIGGERED');
    expect(body.reason, 'the remediation is in the response, not left to archaeology').toMatch(/run Apply again/i);

    const row = await readRow(store, id);
    expect(row.bundle?.state).toBe('landed-untriggered');
    expect(row.bundle?.sha).toBe(body.bundle.sha);
    expect(
      row.events.some((e) => e.type === 'bundle-landed-untriggered' && /LANDED/.test(e.label)),
      'the timeline says the change is on the branch',
    ).toBe(true);
  });

  it('THE DEFECT: the retry used to re-clone and die at "gate left no change?"', async () => {
    // The whole point of the state. Under the old behaviour the second Apply re-ran the
    // full sequence against a branch that already contained the commit, so the gate had
    // nothing left to do and `commit` failed with a message about the gate.
    const { origin, triggerOk } = armLandingGateFailingTrigger();
    const { store, app, id } = await seededApp();
    const cookie = await sessionCookieFor(store, 'lina');

    expect((await apply(app, cookie, id)).status).toBe(502);
    const landed = (await readRow(store, id)).bundle?.sha;
    const afterFirst = originCommits(origin);

    // The operator fixes whatever broke the trigger and clicks Apply again.
    writeFileSync(triggerOk, '');
    const res = await apply(app, cookie, id);

    expect(res.status, 'the retry must succeed, not report a confusing commit failure').toBe(200);
    const body = (await res.json()) as { ok: boolean; bundle: { state: string; sha?: string }; steps: Array<{ step: string; ok: boolean; detail: string }> };
    expect(body.ok).toBe(true);
    expect(body.bundle.state).toBe('triggered');
    expect(body.bundle.sha, 'it fires the gate for the sha that ACTUALLY landed').toBe(landed);
    expect(originCommits(origin), 'and it lands NOTHING new — the change was already there').toBe(afterFirst);

    const trigger = body.steps.find((s) => s.step === 'trigger');
    expect(trigger?.ok).toBe(true);
    expect(body.steps.find((s) => s.step === 'commit')?.detail, 'the skipped steps say why they were skipped').toMatch(/already landed/);
    expect(body.steps.find((s) => s.step === 'gate')?.detail).toMatch(/skipped/);
  });

  it("THE FINDING'S LITERAL SYMPTOM: an idempotent gate made the retry die at \"gate left no change?\"", async () => {
    // The gate in the other tests rewrites a timestamp, so a retry always has something
    // to commit — under the unfixed code that retry DOUBLE-LANDS the same change, which
    // is its own bug. A realistic gate is idempotent: it edits the tree to a desired
    // state, so re-running it against a branch that already contains the commit leaves
    // nothing, and `commit` fails with a message about the gate. That is the exact
    // sentence the finding quotes, and the reason it needed archaeology: nothing in it
    // mentions the change that had already landed.
    const { origin, triggerOk } = armLandingGateFailingTrigger();
    process.env.CCP_BUNDLE_GATE_CMD = 'echo desired-state > "$BUNDLE_CHECKOUT/gated.txt"';
    const { store, app, id } = await seededApp();
    const cookie = await sessionCookieFor(store, 'lina');

    expect((await apply(app, cookie, id)).status).toBe(502);
    const landed = (await readRow(store, id)).bundle?.sha;
    const afterFirst = originCommits(origin);
    expect(landed, 'the setup must have landed a commit').toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(triggerOk, '');
    const res = await apply(app, cookie, id);
    const body = (await res.json()) as { ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }>; bundle: { state: string; sha?: string } };

    expect(res.status, 'the retry resumes instead of re-running into a dead end').toBe(200);
    expect(
      body.steps.some((st) => /gate left no change/.test(st.detail)),
      'THE DEFECT: this misleading message is what the operator used to get',
    ).toBe(false);
    expect(body.bundle.state).toBe('triggered');
    expect(body.bundle.sha).toBe(landed);
    expect(originCommits(origin), 'and no second commit for the same change').toBe(afterFirst);
  });

  it('does not re-gate the landed sha — a second opinion on an applied plan is not wanted', async () => {
    // If the retry re-ran the gate and the gate said no, the operator would be left with
    // a change on the branch and a tool refusing to finish it.
    const { triggerOk } = armLandingGateFailingTrigger();
    const { store, app, id } = await seededApp();
    const cookie = await sessionCookieFor(store, 'lina');
    expect((await apply(app, cookie, id)).status).toBe(502);

    // Arm a gate that would now FAIL. The retry must not consult it at all.
    process.env.CCP_BUNDLE_GATE_CMD = 'exit 1';
    writeFileSync(triggerOk, '');

    const res = await apply(app, cookie, id);
    expect(res.status, 'the retry ignores the gate entirely').toBe(200);
    expect((await readRow(store, id)).bundle?.state).toBe('triggered');
  });

  it('a genuinely failed run — nothing landed — is still plain `failed`', async () => {
    // The new state must not swallow the ordinary failure. A gate that edits nothing
    // never reaches a commit, so there is no sha and nothing to resume.
    const { origin } = armLandingGateFailingTrigger();
    process.env.CCP_BUNDLE_GATE_CMD = 'exit 1'; // red gate: stops before commit
    const { store, app, id } = await seededApp();
    const before = originCommits(origin);

    const res = await apply(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { bundle: { state: string }; code?: string };
    expect(body.bundle.state).toBe('failed');
    expect(body.code, 'no landed-untriggered remediation for a run that landed nothing').toBeUndefined();
    expect(originCommits(origin), 'and nothing reached the branch').toBe(before);
  });

  it('the audit entry records the half state, so a reader of the chain sees it too', async () => {
    armLandingGateFailingTrigger();
    const { store, app, id } = await seededApp();
    await apply(app, await sessionCookieFor(store, 'lina'), id);

    const entries = await bundleEntries(store);
    expect(entries).toHaveLength(1);
    const after = entries[0]!.after as { bundle: { state: string; sha?: string } };
    expect(after.bundle.state).toBe('landed-untriggered');
    expect(after.bundle.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('ERR-12 — cancel refuses a landed-untriggered request (the commit is what cannot be undone)', () => {
  it('THE TRAP: "the bundle failed, so cancelling is safe" — it is not, the change is on the branch', async () => {
    const { store, app, id } = await seededApp({ state: 'landed-untriggered', sha: 'b'.repeat(40), at: new Date().toISOString() });

    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe('BUNDLE_TRIGGERED');
    expect(body.reason, 'and it names the sha and both exits').toMatch(/bbbbbbbbb/);
    expect(body.reason).toMatch(/re-run Apply|revert/i);
    expect((await readRow(store, id)).status, 'the request is not cancelled').toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('apply and cancel agree about whether the change is on the branch', async () => {
    // The two verbs reading the same state differently is the bug class here: apply
    // treats `landed-untriggered` as resumable (so: it landed), and cancel must not
    // simultaneously treat it as "nothing happened".
    const { triggerOk } = armLandingGateFailingTrigger();
    const { store, app, id } = await seededApp();
    const cookie = await sessionCookieFor(store, 'lina');
    await apply(app, cookie, id);

    expect((await cancel(app, await sessionCookieFor(store, 'sari'), id)).status).toBe(409);
    writeFileSync(triggerOk, '');
    expect((await apply(app, cookie, id)).status).toBe(200);
  });
});

describe('ERR-12 — a spawn timeout is distinguishable from `exit 1` (verified, closed by the async-exec work)', () => {
  it('a TIMEOUT reports status 124 and says so, not a bare `exit 1`', async () => {
    const r = await execCapture('bash', ['-c', 'sleep 5'], { timeoutMs: 120 });
    expect(r.status, 'the finding\'s shape mapped this onto 1, losing the distinction').toBe(124);
    expect(r.status).not.toBe(1);
    expect(r.out).toMatch(/timed out after 120ms/);
  });

  it('a real `exit 1` is still status 1 — the two are genuinely different values', async () => {
    const r = await execCapture('bash', ['-c', 'exit 1'], { timeoutMs: 5_000 });
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/timed out/);
  });

  it('a spawn failure names itself rather than looking like a command that ran and failed', async () => {
    const r = await execCapture('/nonexistent/definitely-not-a-binary', [], { timeoutMs: 5_000 });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/spawn failed/);
  });

  it('the bundle passes the exec layer\'s text through VERBATIM, so the timeout note reaches the operator', async () => {
    // The exec layer being right is not the property ERR-12 is about — what matters is
    // what an operator reads in the audit `steps` afterwards. The gate step's real
    // timeout is 15 minutes, which no test can wait for, so the chain is verified in two
    // links instead: `execCapture` APPENDS the timeout note to `out` (asserted above),
    // and `gate()` reports `out` verbatim as `detail` (asserted here). A timeout
    // therefore arrives in the audit trail with its own words and its own status.
    const { realSteps } = await import('../src/domain/bundle');
    const dir = mkdtempSync(join(tmpdir(), 'err12-gate-'));
    temps.push(dir);
    const steps = realSteps({ remote: 'unused', branch: 'main', gateCmd: 'echo MARKER-9f3a; exit 7', triggerCmd: 'true' });

    const r = await steps.gate(dir, join(dir, 'req.json'));
    expect(r.ok).toBe(false);
    expect(r.detail, 'the command output is the detail, not a synthesised "exit N"').toContain('MARKER-9f3a');

    // And when the command produces NO output, the status still reaches the detail — so
    // a silent timeout reads as `gate exit 124`, never as `gate exit 1`.
    const quiet = realSteps({ remote: 'unused', branch: 'main', gateCmd: 'exit 7', triggerCmd: 'true' });
    expect((await quiet.gate(dir, join(dir, 'req.json'))).detail).toBe('gate exit 7');
  });
});
