import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, Item, QueryOptions } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { seed, seedRequests, sessionCookieFor, setSetting, SAMPLE_PROJECT_ID } from './helpers/seed';
import { ulid } from 'ulid';
import { checkSubmitRateLimit } from '../src/middleware/rateLimit';
import { requestCollectionGsi, SUBMIT_QUOTA_SK_PREFIX, submitQuotaPk } from '../src/store/schema';
import { DEFAULT_RATE_LIMITS } from '../src/domain/config';

/**
 * maxOpen quota vs the request-status lifecycle (coordinator scope addition to
 * the 0021 lane wave). `middleware/rateLimit.ts` keeps its OWN open-status list,
 * separate from requests.ts's approve/reject OPEN_STATUSES — when Lane A's
 * G1 work added `APPROVED_COOLING` (interim quorum met, awaiting
 * `earliestApplyAt`) and `CANCELLED`, this list silently stopped counting a
 * cooling request against its requester's maxOpen quota, letting a requester
 * queue unbounded cooling requests. These tests pin the quota semantics per
 * status:
 *
 *   counts   — AWAITING_CODE_REVIEW (in-flight), APPROVED_COOLING (approved
 *              but NOT yet applied: still occupying reviewer/deploy attention
 *              until the window elapses or it is cancelled)
 *   released — CANCELLED (terminal), APPLIED (terminal)
 */

const DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function submit(app: Hono<AppEnv>, cookie: string, body: unknown) {
  return app.request('/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}

/** Estate with maxOpen=1 and exactly ONE pre-existing request for sari in `status`. */
async function setupWithOne(status: string): Promise<{ app: Hono<AppEnv>; store: ConfigStore; sari: string }> {
  const store = new MemoryStore();
  await seed(store);
  await setSetting(store, 'sample', 'rate.limits', { maxOpen: 1 }); // submissionsPerHour keeps its default (50)
  await seedRequests(store, 'sample', 'sari', 1, { status });
  const app = createApp(store);
  return { app, store, sari: await sessionCookieFor(store, 'sari') };
}

describe('maxOpen quota: which request statuses occupy a slot', () => {
  it('an APPROVED_COOLING request still counts toward maxOpen — cooling is not a quota escape', async () => {
    const { app, sari } = await setupWithOne('APPROVED_COOLING');
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('control: a classic open status (AWAITING_CODE_REVIEW) fills the quota the same way', async () => {
    const { app, sari } = await setupWithOne('AWAITING_CODE_REVIEW');
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
  });

  it('a CANCELLED request does NOT count — terminal statuses release the slot', async () => {
    const { app, sari } = await setupWithOne('CANCELLED');
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(201); // quota free again: the cancel released it
  });

  it('an APPLIED request does NOT count either (existing terminal-status behaviour, pinned)', async () => {
    const { app, sari } = await setupWithOne('APPLIED');
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(201);
  });

  it("the quota is per-requester: sari's APPROVED_COOLING request does not consume budi's slot", async () => {
    const { app, store } = await setupWithOne('APPROVED_COOLING');
    const budi = await sessionCookieFor(store, 'budi');
    const res = await submit(app, budi, DRAFT);
    expect(res.status).toBe(201);
  });
});

/**
 * `rate.limits` is operator-set JSON behind PUT /admin/settings/:key with no value
 * schema, so a cap of zero is reachable — and it means "admit nothing", which is a
 * way to freeze submissions. It has to fail CLOSED even for a requester with no
 * prior requests, where there is nothing to count and a per-row check never fires.
 */
describe('a zero cap admits nothing (fail-closed)', () => {
  it('blocks with submissionsPerHour: 0 and no prior requests', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, SAMPLE_PROJECT_ID, 'rate.limits', { submissionsPerHour: 0 });
    expect(await checkSubmitRateLimit(store, SAMPLE_PROJECT_ID, 'sari', ulid())).toEqual({ ok: false });
  });

  it('blocks with maxOpen: 0 and no prior requests', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, SAMPLE_PROJECT_ID, 'rate.limits', { maxOpen: 0 });
    expect(await checkSubmitRateLimit(store, SAMPLE_PROJECT_ID, 'sari', ulid())).toEqual({ ok: false });
  });

  it('still admits a submission under a normal cap', async () => {
    const store = new MemoryStore();
    await seed(store);
    // A claim, not a bare yes: the writes it carries (the quota pointer AND the
    // gate-CAS bump, CONC-12) are what make the answer survive to the transact.
    const admission = await checkSubmitRateLimit(store, SAMPLE_PROJECT_ID, 'sari', ulid());
    expect(admission.ok).toBe(true);
  });
});

/**
 * PERF-10 — `checkSubmitRateLimit` used to read the project's ENTIRE request
 * collection on every submit to count one requester's handful. These tests
 * measure the read rather than describing it (the pattern this repo already
 * uses for the same class of defect in `auditPaging.test.ts`'s PERF-8 tests),
 * because "is this still O(project history)?" is not a question prose answers.
 */
describe('PERF-10 — the submit-path rate limiter reads a bounded amount, not the whole project history', () => {
  /** Counts calls to queryGSI1 against the REQUEST-COLLECTION gsi1pk specifically —
   *  the full-history scan the fix replaces with a per-requester index. Scoped to
   *  that one key so an unrelated GSI1 read elsewhere on the submit path (there are
   *  several) cannot be mistaken for the scan this finding is about. */
  class CountingStore extends MemoryStore {
    requestCollectionScans = 0;
    override async queryGSI1(gsi1pk: string, opts?: QueryOptions): Promise<Item[]> {
      const out = await super.queryGSI1(gsi1pk, opts);
      if (gsi1pk === requestCollectionGsi(SAMPLE_PROJECT_ID)) this.requestCollectionScans += 1;
      return out;
    }
  }

  it('materializes the index once per requester, then never re-scans the request collection again', async () => {
    const store = new CountingStore();
    await seed(store);
    // 300 requests for sari, all OLD (outside the hourly window) and TERMINAL
    // (APPLIED releases the maxOpen slot) — a real deployment's history, none of
    // it relevant to either cap, all of it costly to scan under the old code.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 300, { status: 'APPLIED', createdAt: old, updatedAt: old });
    const app = createApp(store);
    const sari = await sessionCookieFor(store, 'sari');

    // L-1 — assert the fixture is big enough for the defect to be visible, and
    // large enough relative to the default caps (50/hour, 20 open) that scanning
    // it is a real cost and not noise.
    expect(300).toBeGreaterThan(DEFAULT_RATE_LIMITS.submissionsPerHour + DEFAULT_RATE_LIMITS.maxOpen);

    store.requestCollectionScans = 0;
    const res1 = await submit(app, sari, DRAFT);
    expect(res1.status).toBe(201);
    // First submit for a never-before-seen requester MUST still scan once — an
    // index that cannot tell "nothing indexed yet" from "nothing open" would
    // silently stop enforcing maxOpen for exactly the requesters who already had
    // open work (the fail-open this finding's fix explicitly guards against).
    expect(store.requestCollectionScans).toBe(1);

    // Old + terminal rows are pruned rather than carried forward forever: the
    // requester's partition should hold the marker plus ONE pointer (just
    // admitted), not the 300 that were scanned to get there.
    const partitionRows = await store.query(submitQuotaPk(SAMPLE_PROJECT_ID, 'sari'), SUBMIT_QUOTA_SK_PREFIX);
    expect(partitionRows).toHaveLength(1);

    // Steady state: a second submit by the SAME requester must not re-scan the
    // request collection at all. This is the property the finding is about.
    store.requestCollectionScans = 0;
    const res2 = await submit(app, sari, DRAFT);
    expect(res2.status).toBe(201);
    expect(store.requestCollectionScans).toBe(0);
  });

  it('a rate-limited submit leaves no orphan pointer — admission and the request row are one atomic fact', async () => {
    const store = new CountingStore();
    await seed(store);
    await setSetting(store, SAMPLE_PROJECT_ID, 'rate.limits', { maxOpen: 1 });
    await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 1, { status: 'AWAITING_CODE_REVIEW' });
    const app = createApp(store);
    const sari = await sessionCookieFor(store, 'sari');

    const before = await store.query(submitQuotaPk(SAMPLE_PROJECT_ID, 'sari'), SUBMIT_QUOTA_SK_PREFIX);
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(429);
    // A refused submit must not have written a pointer for a request that was
    // never created — that would over-count and lock the requester out of a
    // slot they never used. `SubmitAdmission`'s writes only ever ride the
    // caller's own transact, so a 429 (returned before that transact runs)
    // cannot have written anything.
    const after = await store.query(submitQuotaPk(SAMPLE_PROJECT_ID, 'sari'), SUBMIT_QUOTA_SK_PREFIX);
    expect(after).toEqual(before);
  });
});
