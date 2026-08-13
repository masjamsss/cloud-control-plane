import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, TransactWrite } from '../src/store/configStore';
import { ConditionError } from '../src/store/configStore';
import { DomainConditionError, record, transactWithAudit } from '../src/domain/audit';
import { ApiError } from '../src/errors';
import { CONTROL_SCOPE } from '../src/projects';
import { chainHead, instanceKey, scanJobKey, teamCollectionGsi, teamKey } from '../src/store/schema';
import type { ProjectScanJobItem, TeamItem } from '../src/store/schema';
import { __resetKnownProjectsForTests } from '../src/projects';
import { seed, sessionCookieFor } from './helpers/seed';
import { getRacingStore, touchesKey, wrap, writeRacingStore } from './helpers/racingStore';

/**
 * CONC-15 / API-14 / R-10 — `transactWithAudit` conflated a caller's own domain condition
 * failing with the audit chain head moving.
 *
 * The store reports a refused batch as one undifferentiated `ConditionError`, so the
 * helper guessed from the SHAPE of the domain writes: a value guard meant STATE_CONFLICT,
 * anything else meant CHAIN_CONTENTION. Both guesses were wrong in one direction each — a
 * genuine `ifNotExists` collision (a duplicate username, a lost version-row race) was
 * reported as "the audit chain is busy; please retry" about something no retry can fix,
 * and a value-guarded caller that merely lost the chain head was told its own read was
 * stale when it was not.
 *
 * The fix asks the store WHICH condition failed. These tests pin the rule rather than the
 * four call sites the two reports happened to name.
 */

const PROJECT = 'p1';
const PK = `PROJ#${PROJECT}`;

const ENTRY = { action: 'test-write', actor: 'alice', targetType: 'thing', targetId: 't1' } as never;

/**
 * THE RULE, not the list (L-25): every condition primitive `TransactWrite` carries, in
 * every write kind that can carry it. A case here is a (setup, write) pair whose condition
 * is false at transact time for a reason that has NOTHING to do with the audit chain.
 *
 * `domain/audit.ts` additionally holds a COMPILE-TIME assertion that these two primitives
 * are all of them, so a third one cannot be added to the store seam without breaking the
 * build — a runtime table alone would silently stop covering the surface.
 */
const CONDITION_CASES: Array<{ name: string; sk: string; seed: (s: MemoryStore) => Promise<void>; write: (sk: string) => TransactWrite }> = [
  {
    name: "put + ifNotExists — the key was taken between the caller's read and its write",
    sk: 'DUP#1',
    seed: async (s) => void (await s.put({ PK, SK: 'DUP#1', who: 'winner' })),
    write: (sk) => ({ kind: 'put', item: { PK, SK: sk, who: 'loser' }, ifNotExists: true }),
  },
  {
    name: 'put + ifEquals — a whole-row replacement whose captured attribute moved',
    sk: 'ROW#1',
    seed: async (s) => void (await s.put({ PK, SK: 'ROW#1', version: 7 })),
    write: (sk) => ({ kind: 'put', item: { PK, SK: sk, version: 6 }, ifEquals: { attr: 'version', value: 5 } }),
  },
  {
    name: 'update + ifEquals — a CAS transition whose from-state is no longer current',
    sk: 'JOB#1',
    seed: async (s) => void (await s.put({ PK, SK: 'JOB#1', status: 'running' })),
    write: (sk) => ({ kind: 'update', pk: PK, sk, set: { status: 'done' }, ifEquals: { attr: 'status', value: 'queued' } }),
  },
  {
    name: 'delete + ifEquals — a guarded removal whose guard moved',
    sk: 'GONE#1',
    seed: async (s) => void (await s.put({ PK, SK: 'GONE#1', status: 'open' })),
    write: (sk) => ({ kind: 'delete', pk: PK, sk, ifEquals: { attr: 'status', value: 'closed' } }),
  },
  {
    name: 'ifEquals against a MISSING item — fail-closed, exactly as the store evaluates it',
    sk: 'DELETED#1',
    seed: async () => {}, // nothing planted: the row the caller read is gone
    write: (sk) => ({ kind: 'put', item: { PK, SK: sk, v: 2 }, ifEquals: { attr: 'v', value: 1 } }),
  },
];

describe("CONC-15 — the caller's own condition is reported as the caller's own condition", () => {
  for (const cse of CONDITION_CASES) {
    it(cse.name, async () => {
      const store = new MemoryStore();
      await cse.seed(store);
      const write = cse.write(cse.sk);

      const err = await transactWithAudit(store, PROJECT, [write], ENTRY).then(
        () => null,
        (e: unknown) => e,
      );

      // Setup fired: the batch really was refused for the caller's own reason (L-1).
      expect(err, 'the write must have been refused — otherwise this case proves nothing').not.toBeNull();
      expect(err).toBeInstanceOf(DomainConditionError);
      // …and it names WHICH write lost, so a caller carrying several can map the right code.
      expect((err as DomainConditionError).failed).toBe(write);
      // The old behaviour, in both of its directions.
      expect((err as ApiError).code).not.toBe('CHAIN_CONTENTION');
      expect((err as ApiError).code).toBe('STATE_CONFLICT');
    });
  }

  it('and NOTHING was written — not the domain row, not an audit entry', async () => {
    const store = new MemoryStore();
    await store.put({ PK, SK: 'ROW#1', version: 7 });
    await expect(
      transactWithAudit(store, PROJECT, [{ kind: 'put', item: { PK, SK: 'ROW#1', version: 6 }, ifEquals: { attr: 'version', value: 5 } }], ENTRY),
    ).rejects.toBeInstanceOf(DomainConditionError);
    expect((await store.get(PK, 'ROW#1'))!.version, 'the row that actually landed must survive').toBe(7);
    const hk = chainHead(PROJECT);
    expect(await store.get(hk.PK, hk.SK), 'a refused batch appends no audit entry').toBeNull();
  });
});

describe('CONC-15 — a moved CHAIN HEAD keeps its own, retryable code', () => {
  it('a value-guarded caller whose guard still holds is told CHAIN_CONTENTION, not STATE_CONFLICT', async () => {
    const store = new MemoryStore();
    await store.put({ PK, SK: 'ROW#2', version: 1 });
    const hk = chainHead(PROJECT);

    // Move the head — and ONLY the head — between the helper's head read and its transact.
    const racing = getRacingStore(store, hk, async () => {
      await record(store, PROJECT, { action: 'unrelated', actor: 'bob', targetType: 'thing', targetId: 'other' });
    });

    const err = await transactWithAudit(
      racing,
      PROJECT,
      [{ kind: 'put', item: { PK, SK: 'ROW#2', version: 2 }, ifEquals: { attr: 'version', value: 1 } }],
      ENTRY,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(racing.fired(), 'the interleave must actually have fired, or this test proves nothing').toBe(true);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(DomainConditionError);
    // Before the fix this said STATE_CONFLICT — "this request is not in a state that
    // allows that" — about a row that had not moved at all.
    expect((err as ApiError).code).toBe('CHAIN_CONTENTION');
    // CONC-9's property, unchanged and load-bearing: a guarded write is REFUSED on
    // contention, never replayed. Replaying it is the CONC-1 lost update.
    expect((await store.get(PK, 'ROW#2'))!.version, 'the guarded write must not have been replayed').toBe(1);
  });

  it('CONTROL: an UNGUARDED fresh-key write still retries through the same contention and succeeds', async () => {
    // Without this the test above would be satisfied by a helper that simply refuses
    // everything on contention, which would break the shape the helper exists for.
    const store = new MemoryStore();
    const hk = chainHead(PROJECT);
    const racing = getRacingStore(store, hk, async () => {
      await record(store, PROJECT, { action: 'unrelated', actor: 'bob', targetType: 'thing', targetId: 'other' });
    });
    await transactWithAudit(racing, PROJECT, [{ kind: 'put', item: { PK, SK: 'FRESH#1', ok: true }, ifNotExists: true }], ENTRY);
    expect(racing.fired()).toBe(true);
    expect(await store.get(PK, 'FRESH#1')).not.toBeNull();
  });

  it('CONTROL: an uncontended guarded write still lands — the diagnosis is not refusing everything', async () => {
    const store = new MemoryStore();
    await store.put({ PK, SK: 'ROW#3', version: 1 });
    await transactWithAudit(store, PROJECT, [{ kind: 'put', item: { PK, SK: 'ROW#3', version: 2 }, ifEquals: { attr: 'version', value: 1 } }], ENTRY);
    expect((await store.get(PK, 'ROW#3'))!.version).toBe(2);
  });

  it('a non-condition store failure is still an unhandled error, not a conflict', async () => {
    const store = new MemoryStore();
    const boom = new Error('disk on fire');
    const failing = wrap(store, { transact: () => Promise.reject(boom) });
    await expect(transactWithAudit(failing, PROJECT, [{ kind: 'put', item: { PK, SK: 'X#1' } }], ENTRY)).rejects.toBe(boom);
  });
});

/* ── the same defect where the reports found it: through the HTTP surface ─────── */

const SPA = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' };
const hdrs = (cookie: string): Record<string, string> => ({ ...SPA, cookie, 'x-ccp-project': 'sample' });

describe('API-14 — the concurrent answer is the sequential answer', () => {
  it('two admins enrolling the SAME username: the loser gets DUPLICATE_USERNAME, not CHAIN_CONTENTION', async () => {
    const store = new MemoryStore();
    await seed(store);
    const putra = await sessionCookieFor(store, 'putra'); // lead + isAdmin
    const winner = createApp(store);

    const body = JSON.stringify({
      username: 'newbie',
      displayName: 'Newbie',
      role: 'requester',
      teamId: 'erp-basis',
      password: 'correct horse battery staple',
    });

    // The loser's handler reads the account key (its duplicate fast-path), and the winner
    // commits the whole enrol in that window — the exact interleave the read cannot see.
    let raced = false;
    const racing = getRacingStore(store, { PK: 'ACCOUNT#newbie', SK: 'META' }, async () => {
      raced = true;
      const first = await winner.request('/admin/accounts', { method: 'POST', headers: hdrs(putra), body });
      expect(first.status, 'the winner must actually have enrolled').toBe(201);
    });

    const loser = await createApp(racing).request('/admin/accounts', { method: 'POST', headers: hdrs(putra), body });
    expect(raced, 'the interleave must have fired, or this test proves nothing').toBe(true);
    expect(loser.status).toBe(409);
    expect((await loser.json()).code).toBe('DUPLICATE_USERNAME');
  });

  it('two admins creating the SAME team name: the loser gets DUPLICATE_TEAM', async () => {
    const store = new MemoryStore();
    await seed(store);
    const putra = await sessionCookieFor(store, 'putra');
    const winner = createApp(store);
    const body = JSON.stringify({ name: 'Payments Platform' });

    // Both handlers list the teams to check the name and derive the id from that
    // snapshot, so both derive the SAME id. The winner commits in the window between the
    // loser's read and its write, and the loser's row `ifNotExists` loses.
    const teamK = teamKey('sample', 'payments-platform');
    const racing = writeRacingStore(store, (ws) => ws.some((w) => touchesKey(w, teamK)), async () => {
      const first = await winner.request('/admin/teams', { method: 'POST', headers: hdrs(putra), body });
      expect(first.status, 'the winner must actually have created the team').toBe(201);
    });

    const loser = await createApp(racing).request('/admin/teams', { method: 'POST', headers: hdrs(putra), body });
    expect(racing.fired(), 'the interleave must have fired at the WRITE, or this test proves nothing').toBe(true);
    expect((await store.queryGSI1(teamCollectionGsi('sample')) as TeamItem[]).filter((t) => t.id === 'payments-platform')).toHaveLength(1);
    expect(loser.status).toBe(409);
    expect((await loser.json()).code).toBe('DUPLICATE_TEAM');
  });

  it('PUT /admin/instance under a concurrent rename reports ADR-0023’s INSTANCE_STALE', async () => {
    const store = new MemoryStore();
    await seed(store);
    const putra = await sessionCookieFor(store, 'putra');
    const winner = createApp(store);
    const k = instanceKey();
    await store.put({ ...k, name: 'Original', version: 1, updatedBy: 'putra', updatedAt: '2026-07-01T00:00:00.000Z' });

    let raced = false;
    const racing = getRacingStore(store, k, async () => {
      raced = true;
      const first = await winner.request('/admin/instance', {
        method: 'PUT',
        headers: hdrs(putra),
        body: JSON.stringify({ name: 'Winner' }),
      });
      expect(first.status, 'the winning rename must have landed').toBe(200);
    });

    const loser = await createApp(racing).request('/admin/instance', {
      method: 'PUT',
      headers: hdrs(putra),
      body: JSON.stringify({ name: 'Loser' }),
    });
    expect(raced).toBe(true);
    expect(loser.status).toBe(409);
    // The route has always MEANT to say this — it mapped CHAIN_CONTENTION to get here,
    // and CONC-9 silently stopped that mapping from ever matching.
    expect((await loser.json()).code).toBe('INSTANCE_STALE');
    expect((await store.get(k.PK, k.SK))!.name, "the winner's rename must stand").toBe('Winner');
  });
});

describe('CONC-15 — the scan-job status route’s conflict arm is live code again', () => {
  const KEY = 's'.repeat(32);
  beforeEach(() => {
    __resetKnownProjectsForTests();
    process.env.CCP_SCANNER = '1';
    process.env.CCP_SCANNER_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.CCP_SCANNER;
    delete process.env.CCP_SCANNER_KEY;
  });

  const report = async (app: ReturnType<typeof createApp>, jobId: string, status: string): Promise<Response> =>
    app.request(`/scan-jobs/${jobId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ projectId: 'acme', status }),
    });

  async function plantJob(store: ConfigStore, jobId: string): Promise<void> {
    const k = scanJobKey('acme', jobId);
    await store.put({
      ...k,
      jobId,
      projectId: 'acme',
      status: 'claimed',
      requestedBy: 'putra',
      requestedAt: '2026-07-01T00:00:00.000Z',
    } as unknown as ProjectScanJobItem as never);
  }

  it('a transition that lost to a concurrent report is STATE_CONFLICT, not "the audit chain is busy"', async () => {
    const store = new MemoryStore();
    await seed(store);
    const jobId = '01J0000000000000000000000A';
    await plantJob(store, jobId);
    const winner = createApp(store);

    // Both reports are legal FROM `claimed` (claimed → cloning, claimed → failed). The
    // loser validates against that read; the winner moves the job to a terminal state in
    // the window between the read and the guarded write.
    let raced = false;
    const racing = getRacingStore(store, scanJobKey('acme', jobId), async () => {
      raced = true;
      const first = await report(winner, jobId, 'failed');
      expect(first.status, 'the winning report must have landed').toBe(200);
    });

    const loser = await report(createApp(racing), jobId, 'cloning');
    expect(raced, 'the interleave must have fired').toBe(true);
    expect(loser.status).toBe(409);
    // Before the fix the handler tested for `ConditionError`, which `transactWithAudit`
    // has never thrown, so the worker was told CHAIN_CONTENTION and invited to retry a
    // transition that can never succeed again.
    expect((await loser.json()).code).toBe('STATE_CONFLICT');
    const jk = scanJobKey('acme', jobId);
    expect(((await store.get(jk.PK, jk.SK)) as ProjectScanJobItem).status, "the winner's terminal report must stand").toBe('failed');
  });

  it('a report that lost only the CHAIN HEAD is told CHAIN_CONTENTION — a retry can fix that one', async () => {
    // The discriminating half. Before the fix the helper reported EVERY refusal of a
    // value-guarded write as STATE_CONFLICT, so a worker whose transition was perfectly
    // valid — the job had not moved at all, some unrelated action had appended to the
    // project's chain — was told "this request is not in a state that allows that" and
    // stopped. The two answers demand opposite things of the worker.
    const store = new MemoryStore();
    await seed(store);
    const jobId = '01J0000000000000000000000C';
    await plantJob(store, jobId);

    const hk = chainHead('acme');
    const racing = getRacingStore(store, hk, async () => {
      await record(store, 'acme', { action: 'unrelated', actor: 'someone', targetType: 'project', targetId: 'acme' });
    });

    const res = await report(createApp(racing), jobId, 'cloning');
    expect(racing.fired(), 'the chain head must actually have moved').toBe(true);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHAIN_CONTENTION');
    const jk = scanJobKey('acme', jobId);
    expect(((await store.get(jk.PK, jk.SK)) as ProjectScanJobItem).status, 'and nothing was written').toBe('claimed');
  });

  it('CONTROL: an uncontended report still lands', async () => {
    const store = new MemoryStore();
    await seed(store);
    const jobId = '01J0000000000000000000000B';
    await plantJob(store, jobId);
    expect((await report(createApp(store), jobId, 'cloning')).status).toBe(200);
  });
});

describe('CONC-15 — the store’s own ConditionError is untouched', () => {
  it('a bare store.transact still reports a refusal as ConditionError', async () => {
    // The helper's taxonomy is a HELPER concern; the seam below it keeps its own error,
    // which several hand-rolled loops (approve, ackPending, submit) still branch on.
    const store = new MemoryStore();
    await store.put({ PK, SK: 'SEAM#1', v: 1 });
    await expect(store.transact([{ kind: 'put', item: { PK, SK: 'SEAM#1', v: 2 }, ifEquals: { attr: 'v', value: 9 } }])).rejects.toBeInstanceOf(
      ConditionError,
    );
  });

  it('the control-scope helper is the same helper — settlement and admin share this path', async () => {
    const store = new MemoryStore();
    await store.put({ PK: 'PROJECT#dup', SK: 'META', id: 'dup' });
    await expect(
      transactWithAudit(store, CONTROL_SCOPE, [{ kind: 'put', item: { PK: 'PROJECT#dup', SK: 'META', id: 'dup' }, ifNotExists: true }], ENTRY),
    ).rejects.toBeInstanceOf(DomainConditionError);
  });
});
