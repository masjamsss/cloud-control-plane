import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, Item } from '../src/store/configStore';
import { runBundle, type BundleSteps } from '../src/domain/bundle';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { projectKey, requestKey, yyyymm } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * CONC-6 — the bundle claim had no exception path and no raced-outcome path.
 *
 * Three gaps, all downstream of one design choice: the claim (`bundle.state:'running'`)
 * was written before the multi-minute run and cleared only by the SAME handler's outcome
 * write, and that outcome write was a single all-or-nothing transact.
 *
 *   1. **No exception path.** A throw anywhere in the run — the finding's own example is
 *      `writeFileSync` hitting ENOSPC while dropping the request evidence into the
 *      checkout — escaped the route uncaught. The caller got a 500 and the row kept its
 *      `running` claim. Nothing in this system clears a stuck claim on the row's behalf,
 *      so every later apply answered `409 BUNDLE_RUNNING`. ERR-2's lease later bounded
 *      that to an hour, but an hour of a fully-approved change being un-appliable is
 *      still the defect, and a lease is a backstop for CRASHES — not a licence to leave
 *      recoverable failures to it.
 *
 *   2. **A raced outcome write lost the record of a fired deploy.** The row update and
 *      the audit entry rode one transact guarded on the request row. When that guard
 *      lost, the code retried with the SAME stale guard — which for a row that really has
 *      moved can never succeed — and then threw `CHAIN_CONTENTION`. By then the gate had
 *      run, a commit was on `main` and the CI apply had been triggered. The chain
 *      recorded NOTHING AT ALL: a live deploy in flight with no evidence it existed.
 *
 *   3. The caller could not tell any of this apart from ordinary chain contention, and
 *      "the chain is busy; please retry" is a dangerous thing to say about a bundle,
 *      because retrying re-runs the whole thing.
 *
 * The fix separates the two facts. A state transition may lose a race; a fired deploy is
 * a FACT and is recorded either way.
 */

const ENV_KEYS = ['CCP_BUNDLE', 'CCP_GIT_REMOTE', 'CCP_GIT_BRANCH', 'CCP_BUNDLE_GATE_CMD', 'CCP_BUNDLE_TRIGGER_CMD', 'TMPDIR'] as const;
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
  const root = mkdtempSync(join(tmpdir(), 'bundle-outcome-'));
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

function arm(gateCmd = 'echo approved-edit > "$BUNDLE_CHECKOUT/change.tf"'): void {
  Object.assign(process.env, {
    CCP_BUNDLE: '1',
    CCP_GIT_REMOTE: makeOrigin(),
    CCP_BUNDLE_GATE_CMD: gateCmd,
    CCP_BUNDLE_TRIGGER_CMD: 'true',
  });
}

async function seededApp(wrap?: (inner: ConfigStore) => ConfigStore): Promise<{
  store: ConfigStore;
  app: ReturnType<typeof createApp>;
  id: string;
}> {
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
  });
  return { store, app: createApp(wrap ? wrap(store) : store), id: 'seed-sari-0' };
}

const post = async (app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/apply`, {
    method: 'POST',
    headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
  });

const readRow = async (store: ConfigStore, id: string): Promise<RequestItem> => {
  const k = requestKey('sample', id);
  return (await store.get(k.PK, k.SK)) as RequestItem;
};

const bundleAuditEntries = async (store: ConfigStore): Promise<AuditItem[]> => {
  const entries = (await store.query(`P#sample#AUDIT#${yyyymm(new Date())}`)) as AuditItem[];
  return entries.filter((e) => e.action === 'request-bundle');
};

/** A store that runs `onGet` after every `get` — the interleaving the race needs. */
function racingStore(inner: ConfigStore, onGet: (pk: string, sk: string) => Promise<void>): ConfigStore {
  return {
    async get(pk: string, sk: string): Promise<Item | null> {
      const v = await inner.get(pk, sk);
      await onGet(pk, sk);
      return v;
    },
    put: (item, opts) => inner.put(item, opts),
    query: (pk, prefix, opts) => inner.query(pk, prefix, opts),
    queryGSI1: (gsi1pk, opts) => inner.queryGSI1(gsi1pk, opts),
    transact: (writes) => inner.transact(writes),
    delete: (pk, sk) => inner.delete(pk, sk),
  };
}

describe('CONC-6 — a throwing run is an OUTCOME, not an exception', () => {
  /** Fake steps whose named stage throws instead of returning a StepResult. */
  function throwingAt(stage: 'prepare' | 'gate' | 'commit' | 'trigger'): { steps: BundleSteps; calls: string[] } {
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'bundle-throw-'));
    temps.push(dir);
    const boom = (s: string): never => {
      throw new Error(`ENOSPC: no space left on device, ${s}`);
    };
    const steps: BundleSteps = {
      prepare: () => {
        calls.push('prepare');
        if (stage === 'prepare') boom('prepare');
        return { dir, baseSha: 'a'.repeat(40) };
      },
      gate: () => {
        calls.push('gate');
        if (stage === 'gate') boom('gate');
        return { ok: true, detail: 'green' };
      },
      commit: () => {
        calls.push('commit');
        if (stage === 'commit') boom('commit');
        return { ok: true, sha: 'b'.repeat(40), detail: 'landed' };
      },
      trigger: () => {
        calls.push('trigger');
        if (stage === 'trigger') boom('trigger');
        return { ok: true, detail: 'fired' };
      },
      cleanup: () => {
        calls.push('cleanup');
      },
    };
    return { steps, calls };
  }

  it('THE DEFECT: a step that throws returns a failed outcome instead of propagating', async () => {
    for (const stage of ['prepare', 'gate', 'commit', 'trigger'] as const) {
      const { steps, calls } = throwingAt(stage);
      // The assertion that matters: this call RESOLVES. Before the fix it rejected, and
      // the route had no catch, so the claim it had already written stayed `running`.
      const out = await runBundle(steps, '{}', 'msg');
      expect(out.ok, `${stage}: a throw is a failed run`).toBe(false);
      // L-1 — the stage really was reached; a fake that never ran would report `ok:false`
      // for the boring reason that nothing happened.
      expect(calls, `${stage}: the throwing step must actually have been called`).toContain(stage);
      const last = out.steps.at(-1)!;
      expect(last.step, `${stage}: the throw is attributed to the stage that raised it`).toBe(stage);
      expect(last.detail).toMatch(/threw:.*ENOSPC/);
    }
  });

  it('keeps the steps that already succeeded — a partial run is evidence, not noise', async () => {
    const { steps } = throwingAt('commit');
    const out = await runBundle(steps, '{}', 'msg');
    expect(out.steps.map((s) => `${s.step}:${s.ok}`)).toEqual([
      'prepare:true',
      'gate:true',
      'plan-digest:true',
      'commit:false',
    ]);
  });

  it('a throw AFTER the commit landed still reports the sha — the change IS on the branch', async () => {
    // ERR-12's invariant, on the exception path: `sha` means "a commit landed", never
    // "the run succeeded". Losing it here would strand a landed change with no record of
    // which commit it was.
    const { steps } = throwingAt('trigger');
    const out = await runBundle(steps, '{}', 'msg');
    expect(out.ok).toBe(false);
    expect(out.sha, 'the landed commit must survive the throw').toBe('b'.repeat(40));
  });

  it('still cleans up the workspace when a step throws', async () => {
    const { steps, calls } = throwingAt('gate');
    await runBundle(steps, '{}', 'msg');
    expect(calls.at(-1)).toBe('cleanup');
  });

  it('a cleanup that itself throws does not turn a recorded outcome back into an exception', async () => {
    const { steps } = throwingAt('gate');
    const brittle: BundleSteps = {
      ...steps,
      cleanup: () => {
        throw new Error('EBUSY: device or resource busy, rmdir');
      },
    };
    const out = await runBundle(brittle, '{}', 'msg');
    expect(out.ok).toBe(false);
    expect(out.steps.at(-1)?.step).toBe('gate');
  });
});

describe('CONC-6 — the route never returns holding its own claim', () => {
  it('THE DEFECT: a workspace that cannot be created leaves a TERMINAL state, not a stuck claim', async () => {
    // A real, deterministic version of the finding's own example. `realSteps.prepare`
    // opens the workspace with `mkdtempSync(join(tmpdir(), …))`; pointing TMPDIR at a
    // path that does not exist makes that throw ENOENT — the same shape as the ENOSPC the
    // finding describes, and reached through the real route with the real steps.
    arm();
    const { store, app, id } = await seededApp();
    const cookie = await sessionCookieFor(store, 'lina');
    const gone = join(mkdtempSync(join(tmpdir(), 'bundle-notmp-')), 'does-not-exist');
    temps.push(gone);

    process.env.TMPDIR = gone;
    const res = await post(app, cookie, id);
    process.env.TMPDIR = saved.TMPDIR;

    // Not a 500: a failed run is a reported outcome with per-step evidence.
    expect(res.status, 'a throw is reported as a failed bundle, not an internal error').toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // L-1 — the workspace really was what failed. Without this the test would pass just
    // as happily if the request had been refused for some unrelated reason.
    expect(body.steps.at(-1), 'the run must have died in prepare').toMatchObject({ step: 'prepare', ok: false });
    expect(body.steps.at(-1).detail).toMatch(/threw:/);

    const row = await readRow(store, id);
    expect(row.bundle?.state, 'the claim must be released to a terminal state').toBe('failed');

    // The consequence the finding is actually about: the request is still appliable.
    // Before the fix this second call answered 409 BUNDLE_RUNNING — forever.
    const again = await post(app, cookie, id);
    expect(again.status, 'a failed run must not wedge the next apply').not.toBe(409);
  });
});

describe('CONC-6 — a fired deploy is recorded even when the request row refuses the outcome', () => {
  it('THE DEFECT: the audit entry lands, and the caller gets a specific code', async () => {
    // The row moves out from under the running bundle. The interleaving is landed on the
    // project-row read, which the handler performs AFTER writing its claim and BEFORE
    // running the bundle (ARCH-2's per-estate remote resolution) — so what follows is a
    // genuine "the row changed while the bundle ran", with real effects on the far side.
    arm();
    const k = requestKey('sample', 'seed-sari-0');
    let stolen = false;
    let inner!: ConfigStore;
    const { store, app, id } = await seededApp((s) => {
      inner = s;
      return racingStore(s, async (pk, sk) => {
        if (stolen || pk !== projectKey('sample').PK || sk !== projectKey('sample').SK) return;
        const row = (await inner.get(k.PK, k.SK)) as RequestItem | null;
        if (row?.bundle?.state !== 'running') return; // only once the claim exists
        stolen = true;
        // Somebody else takes the row: a lease takeover writes a NEW claim, which is
        // exactly what this run must refuse to overwrite.
        await inner.transact([
          {
            kind: 'update',
            pk: k.PK,
            sk: k.SK,
            set: { bundle: { state: 'running', at: '2099-01-01T00:00:00.000Z' }, eventSeq: (row.eventSeq ?? 0) + 1 },
            ifEquals: { attr: 'eventSeq', value: row.eventSeq },
          },
        ]);
      });
    });

    const res = await post(app, await sessionCookieFor(store, 'lina'), id);

    // L-1 — the race really happened.
    expect(stolen, 'the row must have been taken over while the bundle ran').toBe(true);

    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code, 'not CHAIN_CONTENTION — that says "retry", and retrying re-runs the deploy').toBe(
      'BUNDLE_OUTCOME_CONTENDED',
    );
    expect(body.details.steps.at(-1), 'the caller is handed the evidence of what ran').toMatchObject({ step: 'trigger', ok: true });

    // THE POINT: the deploy fired, so the chain says so — even though no request-row
    // transition was possible. Before the fix this was empty.
    const entries = await bundleAuditEntries(store);
    expect(entries, 'a fired deploy must be in the audit chain').toHaveLength(1);
    const after = entries[0]!.after as Record<string, unknown>;
    expect(after.requestRowUpdated, 'and it must say the row did not take the transition').toBe(false);
    expect((after.bundle as { sha?: string }).sha, 'carrying the commit that landed').toMatch(/^[0-9a-f]{40}$/);

    // The other run's claim is untouched — this run must never report its result as that
    // run's, which is what an unconditional write would have done.
    const row = await readRow(store, id);
    expect(row.bundle?.at).toBe('2099-01-01T00:00:00.000Z');
  });

  it('CONTROL: with nothing racing, the same fixture records the outcome ON the row', async () => {
    // Proves the assertions above are driven by the race and not by a fixture that could
    // never record an outcome in the first place.
    arm();
    const { store, app, id } = await seededApp();
    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(200);

    const row = await readRow(store, id);
    expect(row.bundle?.state).toBe('triggered');
    const entries = await bundleAuditEntries(store);
    expect(entries).toHaveLength(1);
    expect((entries[0]!.after as Record<string, unknown>).requestRowUpdated).toBeUndefined();
  });
});
