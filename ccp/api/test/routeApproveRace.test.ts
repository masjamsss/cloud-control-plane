import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { AppEnv } from '../src/appEnv';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { approvalKey, requestKey } from '../src/store/schema';
import { nowIso } from '../src/clock';
import { seed, sessionCookieFor } from './helpers/seed';
import { getRacingStore, writeRacingStore } from './helpers/racingStore';

/**
 * TEST-6 — the approve route's race handling had no route-level test.
 *
 * `POST /requests/:id/approve` carries carefully written concurrency control: a
 * per-approver dedupe row whose lost race is `409 ALREADY_APPROVED`, a whole-row write
 * guarded on `eventSeq` whose lost race is `409 STATE_CONFLICT` (CONC-1: retrying it
 * writes exactly the lost signature the guard prevented), and a retry that fires ONLY for
 * chain contention. Every branch of that was verified by reading. The store-level tests
 * (`approveLostUpdate.test.ts`) prove the PRIMITIVE works; nothing proved the handler uses
 * it correctly, and the two failures look identical from the outside — one signature in
 * the ledger either way.
 *
 * These drive two real HTTP approvals through one store, with the competitor committing in
 * the window between the loser's read and its write. The assertions are about the quorum
 * ledger, not just the status code: a ladder step is the governance record this product
 * exists to keep.
 */

const GUARDRAILS = {
  operationId: 'ebs-grow', // guardrails tier → a two-step ladder [L2, L3]
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

const hdrs = (cookie: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-ccp-client': 'ccp-spa',
  cookie,
  'x-ccp-project': 'sample',
});

const approve = async (app: Hono<AppEnv>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/approve`, { method: 'POST', headers: hdrs(cookie) });

/** Submit a guardrails request as sari and return its id. */
async function submitted(store: MemoryStore): Promise<string> {
  const sari = await sessionCookieFor(store, 'sari');
  const res = await createApp(store).request('/requests', { method: 'POST', headers: hdrs(sari), body: JSON.stringify(GUARDRAILS) });
  expect(res.status, 'the fixture request must actually have been submitted').toBe(201);
  return (await res.json()).id as string;
}

const rowOf = async (store: MemoryStore, id: string): Promise<RequestItem> =>
  (await store.get(requestKey('sample', id).PK, requestKey('sample', id).SK)) as RequestItem;

/** Every `request-approve` entry on the chain for this request — the ladder record. */
async function approveEntries(store: MemoryStore, id: string): Promise<AuditItem[]> {
  const month = nowIso().slice(0, 7).replace('-', '');
  const entries = (await store.query(`P#sample#AUDIT#${month}`)) as AuditItem[];
  return entries.filter((e) => e.action === 'request-approve' && e.requestId === id);
}

describe('TEST-6 — two approvers racing on one request', () => {
  it('THE RACE: exactly ONE ladder step is recorded, and the loser is told its read was stale', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await submitted(store);
    const budi = await sessionCookieFor(store, 'budi'); // approver
    const lina = await sessionCookieFor(store, 'lina'); // lead
    const winner = createApp(store);

    // lina's approval commits between budi's read of the request row and budi's write.
    const racing = getRacingStore(store, requestKey('sample', id), async () => {
      expect((await approve(winner, lina, id)).status, "the winner's approval must have landed").toBe(200);
    });

    const loser = await approve(createApp(racing), budi, id);
    expect(racing.fired(), 'the interleave must have fired, or this test proves nothing').toBe(true);

    expect(loser.status).toBe(409);
    // Not CHAIN_CONTENTION: retrying would write budi's row snapshot over lina's
    // signature, which is exactly the corruption the guard exists to stop.
    expect((await loser.json()).code).toBe('STATE_CONFLICT');

    const row = await rowOf(store, id);
    expect(row.approvals.map((a) => a.user), 'the ledger holds exactly the signature that won').toEqual(['lina']);
    expect(await approveEntries(store, id), 'and the chain records exactly one approve').toHaveLength(1);
  });

  it('…and the loser can simply retry: the second approval then completes the ladder', async () => {
    // The refusal must be recoverable, not a dead end. Roles matter to which order works:
    // the [L2, L3] ladder's second step needs a LEAD, so budi (approver) signs L2 as the
    // winner and lina (lead) is the loser who retries into L3.
    const store = new MemoryStore();
    await seed(store);
    const id = await submitted(store);
    const budi = await sessionCookieFor(store, 'budi');
    const lina = await sessionCookieFor(store, 'lina');
    const winner = createApp(store);

    const racing = getRacingStore(store, requestKey('sample', id), async () => {
      expect((await approve(winner, budi, id)).status).toBe(200);
    });
    expect((await approve(createApp(racing), lina, id)).status).toBe(409);

    // Fresh read, same approver, no race: it lands.
    expect((await approve(createApp(store), lina, id)).status).toBe(200);
    const row = await rowOf(store, id);
    expect(row.approvals.map((a) => a.user).sort()).toEqual(['budi', 'lina']);
    expect(await approveEntries(store, id)).toHaveLength(2);
  });

  it('THE DOUBLE-CLICK: the same approver twice in flight is ALREADY_APPROVED, not a second signature', async () => {
    // The other race in this handler, and the reason the dedupe row exists: a double
    // click, or a retry after a slow response. It must be told apart from the stale-read
    // case above — one is "you already did this", the other is "someone else did".
    const store = new MemoryStore();
    await seed(store);
    const id = await submitted(store);
    const budi = await sessionCookieFor(store, 'budi');
    const winner = createApp(store);

    const racing = getRacingStore(store, requestKey('sample', id), async () => {
      expect((await approve(winner, budi, id)).status).toBe(200);
    });

    const second = await approve(createApp(racing), budi, id);
    expect(racing.fired()).toBe(true);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('ALREADY_APPROVED');

    const row = await rowOf(store, id);
    expect(row.approvals, 'one approver, one signature').toHaveLength(1);
    expect(await approveEntries(store, id)).toHaveLength(1);
    expect(await store.get(approvalKey('sample', id, 'budi').PK, approvalKey('sample', id, 'budi').SK)).not.toBeNull();
  });

  it('CHAIN CONTENTION ONLY: an unrelated write to the same project does NOT cost an approval', async () => {
    // The retry's whole reason for existing. Another request's activity moves the shared
    // per-project chain head; the approver's own row has not moved, so the handler must
    // retry rather than refuse. Refusing here would make every busy project reject
    // approvals at random.
    const store = new MemoryStore();
    await seed(store);
    const id = await submitted(store);
    const budi = await sessionCookieFor(store, 'budi');
    const sari = await sessionCookieFor(store, 'sari');
    const other = createApp(store);

    // Fire an unrelated audited write in the window before budi's approve transacts.
    const racing = writeRacingStore(
      store,
      (ws) => ws.some((w) => w.kind === 'put' && w.item.PK === requestKey('sample', id).PK),
      async () => {
        const res = await other.request('/requests', { method: 'POST', headers: hdrs(sari), body: JSON.stringify(GUARDRAILS) });
        expect(res.status, 'the unrelated submit must have landed and moved the chain head').toBe(201);
      },
    );

    const res = await approve(createApp(racing), budi, id);
    expect(racing.fired()).toBe(true);
    expect(res.status, 'chain contention is retried, not refused').toBe(200);
    expect((await rowOf(store, id)).approvals.map((a) => a.user)).toEqual(['budi']);
  });

  it('CONTROL: two approvers with no race both sign, and the ladder completes', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await submitted(store);
    const app = createApp(store);
    expect((await approve(app, await sessionCookieFor(store, 'budi'), id)).status).toBe(200);
    expect((await approve(app, await sessionCookieFor(store, 'lina'), id)).status).toBe(200);
    const row = await rowOf(store, id);
    expect(row.approvals).toHaveLength(2);
    expect(row.status, 'a completed [L2, L3] ladder applies').toBe('APPLIED');
  });
});
