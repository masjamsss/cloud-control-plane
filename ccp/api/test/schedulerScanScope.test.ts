import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { Item } from '../src/store/configStore';
import { requestCollectionGsi, requestKey } from '../src/store/schema';
import type { RequestItem } from '../src/store/schema';
import { DryRunExecutor, digestOf } from '../src/domain/apply/executor';
import { APPLYING, isDue, runDueApplies, SCHEDULER_SCANNED_STATUSES } from '../src/domain/apply/scheduler';

/**
 * PERF-14 — the scheduler tick read every request a project had EVER created, every
 * minute, to find a due set that is almost always empty.
 *
 * The finding's stated magnitude is stale: it describes "a full store scan", and the store
 * has since been partitioned, so `queryGSI1` already reads one project's partition rather
 * than the whole table. What survived is the part that actually costs: the seam deep-copies
 * every row it returns (isolation — callers must not hold a reference to live state), and
 * the scheduler then discarded almost all of them.
 *
 * Measured before deciding what to do, per this repo's own lesson about flat numbers: one
 * scan of a project holding 5,000 historical requests took **91 ms**, on the single-
 * threaded event loop, once a minute, per project, growing with history forever. That is
 * not the "allocation churn, not latency" the finding assumed — at twenty projects it is
 * seconds of blocked loop per minute — which is why this was worth fixing rather than
 * deferring to the status index that does not exist yet.
 *
 * The fix is a store-level filter applied BEFORE the copy, so the cost is proportional to
 * the answer instead of to the history. The tests below pin three things: the scan still
 * SEES everything it must act on (a perf fix that quietly narrows behaviour is a
 * correctness bug), the filter is honoured by the store, and the two are kept in agreement
 * by derivation rather than by a duplicated list.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const PINNED_DIGEST = digestOf(PINNED_DIFF);
const NOW = Date.parse('2026-08-01T01:00:00.000Z');

function row(id: string, status: string, over: Partial<RequestItem> = {}): Item {
  const k = requestKey(PROJECT, id);
  return {
    ...k,
    id,
    requester: 'sari',
    teamId: 'erp-basis',
    service: 'ec2',
    operationId: 'ebs-grow',
    macd: 'Change',
    targetAddress: `aws_ebs_volume.${id}`,
    params: {},
    justification: 'j',
    exposure: 'l1_with_guardrails',
    risk: 'LOW',
    status,
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-30T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-30T01:00:00.000Z' },
    ],
    schedule: { kind: 'window', at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' },
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    events: [],
    policyVersion: 1,
    planDigest: PINNED_DIGEST,
    pinnedDiff: PINNED_DIFF,
    GSI1PK: requestCollectionGsi(PROJECT),
    GSI1SK: id,
    ...over,
  } as unknown as Item;
}

describe('PERF-14 — the tick reads what it can act on, not the whole history', () => {
  it('THE PROPERTY THAT MUST NOT BREAK: a due request is still found among old history', async () => {
    // The risk of a perf fix like this is that it narrows behaviour by accident. Bury one
    // due request in a pile of terminal ones and it must still be applied.
    const store = new MemoryStore();
    for (let i = 0; i < 200; i++) await store.put(row(`old-${i}`, 'APPLIED'));
    await store.put(row('due-1', 'AWAITING_DEPLOY_APPROVAL'));
    for (let i = 0; i < 200; i++) await store.put(row(`cancelled-${i}`, 'CANCELLED'));

    const outcomes = await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), {});

    expect(outcomes.map((o) => o.requestId)).toEqual(['due-1']);
    expect(outcomes[0]!.result).toBe('applied');
  });

  it('a stranded APPLYING row is still swept — the OTHER status the tick must see', async () => {
    // The lease sweep is the half a status-narrowing fix is most likely to drop, because
    // it is the one that runs outside the due path entirely.
    const store = new MemoryStore();
    for (let i = 0; i < 100; i++) await store.put(row(`old-${i}`, 'APPLIED'));
    await store.put(
      row('stuck', APPLYING, { applyClaimedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() }),
    );

    const outcomes = await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), {});
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.result).toBe('halted');
    expect(outcomes[0]!.haltReason).toBe('APPLY_LEASE_EXPIRED');
  });

  it('the scanned set is DERIVED from isDue, not a second copy of the same list', async () => {
    // The comment in the scheduler promises this test exists. If someone teaches `isDue`
    // about a third status without adding it to the scan list, the tick would silently
    // never see it — a defect with no symptom except changes quietly not happening.
    const statuses = [
      'DRAFT', 'SUBMITTED', 'AWAITING_CODE_REVIEW', 'NEEDS_ENGINEER', 'APPROVED_COOLING',
      'AWAITING_DEPLOY_APPROVAL', 'APPLYING', 'APPLIED', 'CANCELLED', 'REJECTED',
      'WINDOW_EXPIRED', 'HALTED_DRIFT', 'HALTED_APPLY_FAILED',
    ];
    const dueStatuses = statuses.filter((status) =>
      isDue(
        {
          status,
          schedule: { kind: 'window', at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' },
        } as RequestItem,
        NOW,
      ),
    );

    for (const s of dueStatuses) {
      expect(SCHEDULER_SCANNED_STATUSES, `isDue accepts ${s}, so the scan must fetch it`).toContain(s);
    }
    // And the claimed-sweep half, which isDue does not speak for.
    expect(SCHEDULER_SCANNED_STATUSES).toContain(APPLYING);
  });

  it('THE COST PROPERTY: rows handed to the scheduler scale with the ANSWER, not the history', async () => {
    // A pure performance fix changes no behaviour, so a behavioural test cannot pin it —
    // every other test in this file passes with or without the filter. What CAN be pinned
    // is the thing the finding is about: how much the store is asked to copy. This counts
    // it, so reverting the fix fails here and nowhere else, which is exactly right.
    const store = new MemoryStore();
    for (let i = 0; i < 400; i++) await store.put(row(`old-${i}`, 'APPLIED'));
    await store.put(row('due-1', 'AWAITING_DEPLOY_APPROVAL'));

    let copied = 0;
    const counting = Object.create(store) as MemoryStore;
    counting.queryGSI1 = async (pk, opts) => {
      const out = await MemoryStore.prototype.queryGSI1.call(store, pk, opts);
      copied += out.length;
      return out;
    };

    await runDueApplies(counting, PROJECT, NOW, new DryRunExecutor(), {});

    expect(copied, 'one actionable row among 400 terminal ones must cost ONE copy').toBe(1);
  });

  it('a project of pure history costs one empty answer, not 400 copies', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 400; i++) await store.put(row(`old-${i}`, 'APPLIED'));

    const scanned = await store.queryGSI1(requestCollectionGsi(PROJECT), {
      where: { attr: 'status', in: SCHEDULER_SCANNED_STATUSES },
    });
    expect(scanned).toHaveLength(0);
    expect(await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), {})).toEqual([]);
  });
});

describe('PERF-14 — the store-level `where` filter', () => {
  it('narrows queryGSI1 by an attribute, and an absent filter changes nothing', async () => {
    const store = new MemoryStore();
    await store.put(row('a', 'APPLIED'));
    await store.put(row('b', 'AWAITING_DEPLOY_APPROVAL'));
    await store.put(row('c', APPLYING));

    const all = await store.queryGSI1(requestCollectionGsi(PROJECT));
    expect(all).toHaveLength(3);

    const some = await store.queryGSI1(requestCollectionGsi(PROJECT), {
      where: { attr: 'status', in: ['AWAITING_DEPLOY_APPROVAL', APPLYING] },
    });
    expect(some.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });

  it('still returns COPIES, so a caller cannot write through to the store', async () => {
    // The filter runs before the copy; it must not become a way to skip the copy.
    const store = new MemoryStore();
    await store.put(row('b', 'AWAITING_DEPLOY_APPROVAL'));

    const [got] = (await store.queryGSI1(requestCollectionGsi(PROJECT), {
      where: { attr: 'status', in: ['AWAITING_DEPLOY_APPROVAL'] },
    })) as RequestItem[];
    got!.status = 'MUTATED';
    (got!.events as unknown[]).push({ at: 'x', type: 'tampered', label: 'x' });

    const fresh = (await store.get(requestKey(PROJECT, 'b').PK, 'META')) as RequestItem;
    expect(fresh.status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(fresh.events).toHaveLength(0);
  });

  it('matches nothing when the attribute is absent or not a string', async () => {
    // Fail closed: a filter that silently matched rows missing the attribute would hand
    // the scheduler rows it has no rule for.
    const store = new MemoryStore();
    await store.put({ PK: `P#${PROJECT}#REQ#weird`, SK: 'META', id: 'weird', GSI1PK: requestCollectionGsi(PROJECT), GSI1SK: 'weird' } as Item);
    await store.put({ PK: `P#${PROJECT}#REQ#num`, SK: 'META', id: 'num', status: 7, GSI1PK: requestCollectionGsi(PROJECT), GSI1SK: 'num' } as unknown as Item);

    const got = await store.queryGSI1(requestCollectionGsi(PROJECT), {
      where: { attr: 'status', in: ['AWAITING_DEPLOY_APPROVAL', '7'] },
    });
    expect(got).toHaveLength(0);
  });

  it('works on query() as well as queryGSI1(), and composes with limit', async () => {
    const store = new MemoryStore();
    await store.put(row('a', 'APPLIED'));
    await store.put(row('b', 'AWAITING_DEPLOY_APPROVAL'));

    const viaPk = await store.query(`P#${PROJECT}#REQ#b`, undefined, { where: { attr: 'status', in: ['AWAITING_DEPLOY_APPROVAL'] } });
    expect(viaPk).toHaveLength(1);

    // `limit` counts MATCHING items here (documented divergence from DynamoDB, where
    // Limit counts items examined and the filter applies after).
    await store.put(row('c', 'AWAITING_DEPLOY_APPROVAL'));
    const limited = await store.queryGSI1(requestCollectionGsi(PROJECT), {
      where: { attr: 'status', in: ['AWAITING_DEPLOY_APPROVAL'] },
      limit: 1,
    });
    expect(limited).toHaveLength(1);
  });
});
