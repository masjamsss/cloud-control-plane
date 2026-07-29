import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';
import { digestOf, DryRunExecutor, type ApplyExecutor } from '../src/domain/apply/executor';
import {
  APPLY_LEASE_MS,
  APPLYING,
  HALTED_APPLY_FAILED,
  HALTED_DRIFT,
  applyClaimExpired,
  runDueApplies,
} from '../src/domain/apply/scheduler';
import type { Notifier, SchedulerNotification } from '../src/domain/apply/notify';

/**
 * API-2 — `APPLYING`, `HALTED_DRIFT` and `HALTED_APPLY_FAILED` were states nothing could
 * leave. Approve/reject act only on the two open statuses, cancel on the three
 * approved-but-unapplied ones, rewindow on WINDOW_EXPIRED and a not-yet-open
 * AWAITING_DEPLOY_APPROVAL, the bundle on two, and the scheduler short-circuited every
 * `APPLYING` row as "claimed by a (possibly crashed) worker — NEVER re-apply". So:
 *
 *  - a worker that died between the claim and the outcome write left the request in
 *    `APPLYING` forever, and
 *  - a halted request was terminal in fact but not in name — not cancellable, not
 *    re-windowable, not re-appliable, and invisible to the requester's quota.
 *
 * The only documented remedy was editing the store JSON by hand.
 *
 * Two changes close it, and this file pins both. A CLAIM LEASE gives `APPLYING` an
 * automatic exit — no operator has to remember anything, which is the point: a recovery
 * verb nobody runs is not a recovery path. And CANCEL now accepts the halt statuses, so
 * the terminal-in-fact state is reachable through the product instead of through a text
 * editor.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const PINNED_DIGEST = digestOf(PINNED_DIFF);
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const NOW = Date.parse('2026-08-01T01:00:00.000Z'); // inside [00:00, 04:00)
const LONG_AFTER = Date.parse('2026-08-09T00:00:00.000Z'); // days later — the window is long shut
const AUDIT_PARTITION = '202608';

async function seedRow(store: ConfigStore, over: Partial<RequestItem> = {}): Promise<string> {
  await seedRequests(store, PROJECT, 'sari', 1, {
    status: 'AWAITING_DEPLOY_APPROVAL',
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    targetAddress: 'aws_ebs_volume.dwh01',
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-30T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-30T01:00:00.000Z' },
    ],
    schedule: WINDOW,
    planDigest: PINNED_DIGEST,
    pinnedDiff: PINNED_DIFF,
    ...over,
  });
  return 'seed-sari-0';
}

/** The exact shape a crashed worker leaves behind: claimed, stamped, never reported back. */
async function seedCrashedClaim(store: ConfigStore, claimedAtMs: number): Promise<string> {
  return seedRow(store, {
    status: APPLYING,
    applyClaimedAt: new Date(claimedAtMs).toISOString(),
    updatedAt: new Date(claimedAtMs).toISOString(),
  });
}

async function getReq(store: ConfigStore, id: string): Promise<RequestItem> {
  const item = (await store.get(`P#${PROJECT}#REQ#${id}`, 'META')) as RequestItem | null;
  if (!item) throw new Error(`request ${id} not found`);
  return item;
}

async function auditActions(store: ConfigStore, id: string): Promise<string[]> {
  const entries = (await store.query(`P#${PROJECT}#AUDIT#${AUDIT_PARTITION}`)) as AuditItem[];
  return entries.filter((e) => e.requestId === id).map((e) => e.action);
}

function recorder(): { notifier: Notifier; events: SchedulerNotification[] } {
  const events: SchedulerNotification[] = [];
  return { notifier: { notify: (n) => void events.push(n) }, events };
}

/** Fails the test if the scheduler ever tries to (re-)apply a claimed row. */
const neverApplies: ApplyExecutor = {
  replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
  apply: async () => {
    throw new Error('a claimed row must NEVER be re-applied');
  },
  revert: async () => ({ ok: true, detail: 'x' }),
};

async function cancel(app: Hono<AppEnv>, cookie: string, id: string): Promise<Response> {
  return app.request(`/requests/${id}/cancel`, {
    method: 'POST',
    headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT },
  });
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code?: string }).code ?? '';
}

afterEach(() => __setNow(null));

describe('applyClaimExpired — the lease predicate', () => {
  it('ages from applyClaimedAt, falls back to updatedAt, and expires an unusable stamp', () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const stale = new Date(NOW - APPLY_LEASE_MS - 1000).toISOString();

    expect(applyClaimExpired({ applyClaimedAt: fresh, updatedAt: stale }, NOW)).toBe(false);
    expect(applyClaimExpired({ applyClaimedAt: stale, updatedAt: fresh }, NOW)).toBe(true);
    // A row claimed by a build that predates the stamp: `updatedAt` is what the claim
    // has always written, so rows ALREADY wedged when this shipped recover too.
    expect(applyClaimExpired({ updatedAt: stale }, NOW)).toBe(true);
    expect(applyClaimExpired({ updatedAt: fresh }, NOW)).toBe(false);
    // Exactly at the boundary the lease is up (>=, not >).
    expect(applyClaimExpired({ updatedAt: new Date(NOW - APPLY_LEASE_MS).toISOString() }, NOW)).toBe(true);
    // Unusable stamp → expired: a row that cannot be aged is one nothing can release.
    expect(applyClaimExpired({ updatedAt: 'not-a-date' }, NOW)).toBe(true);
  });
});

describe('API-2 — a crashed apply worker no longer wedges the request in APPLYING', () => {
  it('a claim past its lease is halted with APPLY_LEASE_EXPIRED, audited and notified', async () => {
    const store = new MemoryStore();
    const id = await seedCrashedClaim(store, NOW - APPLY_LEASE_MS - 60_000);
    const { notifier, events } = recorder();

    const outcomes = await runDueApplies(store, PROJECT, NOW, neverApplies, { notifier });

    // THE REGRESSION. Before the fix this was `[{ requestId: id, result: 'skipped-moved' }]`
    // on this tick and on every tick after it, forever, with the row left at APPLYING.
    expect(outcomes).toEqual([{ requestId: id, result: 'halted', haltReason: 'APPLY_LEASE_EXPIRED' }]);
    expect((await getReq(store, id)).status).toBe(HALTED_APPLY_FAILED);
    expect(await auditActions(store, id)).toContain('scheduler-apply-lease-expired');
    expect(events.map((e) => e.kind)).toContain('apply-lease-expired');
  });

  it('the sweep is NOT window-filtered — a stranded row is found days after its window shut', async () => {
    const store = new MemoryStore();
    const id = await seedCrashedClaim(store, NOW);

    // This is the realistic case, and the one a window-filtered sweep can never see: by
    // the time anyone notices, the maintenance window closed long ago.
    const outcomes = await runDueApplies(store, PROJECT, LONG_AFTER, neverApplies, {});

    expect(outcomes).toEqual([{ requestId: id, result: 'halted', haltReason: 'APPLY_LEASE_EXPIRED' }]);
    expect((await getReq(store, id)).status).toBe(HALTED_APPLY_FAILED);
  });

  it('a LIVE claim is never robbed — inside the lease the row is untouched', async () => {
    const store = new MemoryStore();
    const id = await seedCrashedClaim(store, NOW - 60_000);

    const outcomes = await runDueApplies(store, PROJECT, NOW, neverApplies, {});

    expect(outcomes).toEqual([{ requestId: id, result: 'skipped-moved' }]);
    expect((await getReq(store, id)).status).toBe(APPLYING);
  });

  it('a freeze does not block the lease sweep — a frozen deployment still un-wedges', async () => {
    const store = new MemoryStore();
    const id = await seedCrashedClaim(store, NOW - APPLY_LEASE_MS - 60_000);

    // The freeze exists to stop APPLIES. Releasing a dead claim applies nothing, and a
    // freeze left on for a week would otherwise re-create the permanent wedge.
    const outcomes = await runDueApplies(store, PROJECT, NOW, neverApplies, { frozen: true });

    expect(outcomes).toEqual([{ requestId: id, result: 'halted', haltReason: 'APPLY_LEASE_EXPIRED' }]);
    expect((await getReq(store, id)).status).toBe(HALTED_APPLY_FAILED);
  });

  it('the claim the scheduler itself writes carries the stamp the lease reads', async () => {
    const store = new MemoryStore();
    const id = await seedRow(store);
    let seen: string | undefined;
    const ex: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async (r) => {
        seen = r.applyClaimedAt; // the in-flight row the executor is handed
        return { ok: true, detail: 'dry-run' };
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };

    await runDueApplies(store, PROJECT, NOW, ex, {});

    expect(seen).toBe(new Date(NOW).toISOString());
    expect((await getReq(store, id)).applyClaimedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('API-2 — the halt statuses have an exit', () => {
  for (const halted of [HALTED_DRIFT, HALTED_APPLY_FAILED]) {
    it(`the requester can cancel a ${halted} request`, async () => {
      const store = new MemoryStore();
      await seed(store);
      const app = createApp(store);
      const id = await seedRow(store, { status: halted });
      __setNow(() => NOW);

      const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);

      // THE REGRESSION. Before the fix every verb refused this row: cancel answered
      // STATE_CONFLICT because CANCELLABLE_STATUSES held only the three
      // approved-but-unapplied statuses, and nothing else in the API reads HALTED_*.
      expect(res.status).toBe(200);
      expect((await getReq(store, id)).status).toBe('CANCELLED');
      expect(await auditActions(store, id)).toContain('request-cancel');
    });

    it(`a Lead can cancel someone else's ${halted} request`, async () => {
      const store = new MemoryStore();
      await seed(store);
      const app = createApp(store);
      const id = await seedRow(store, { status: halted });
      __setNow(() => NOW);

      expect((await cancel(app, await sessionCookieFor(store, 'lina'), id)).status).toBe(200);
    });
  }

  it('an end-to-end wedge clears: crash → lease expiry → cancel, with no store surgery', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const id = await seedCrashedClaim(store, NOW);
    __setNow(() => LONG_AFTER);

    // Nobody may cancel while a worker might still be running: APPLYING stays refused.
    expect(await codeOf(await cancel(app, await sessionCookieFor(store, 'sari'), id))).toBe('STATE_CONFLICT');

    await runDueApplies(store, PROJECT, LONG_AFTER, new DryRunExecutor(), {});

    expect((await cancel(app, await sessionCookieFor(store, 'sari'), id)).status).toBe(200);
    expect((await getReq(store, id)).status).toBe('CANCELLED');
  });

  it('APPLYING itself is still NOT cancellable — the lease is the only way out', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const id = await seedCrashedClaim(store, NOW);
    __setNow(() => NOW + 60_000);

    // Cancelling a row a live worker owns is how a change applies while the record says
    // CANCELLED (API-5). The lease is deliberately the only exit from APPLYING.
    expect(await codeOf(await cancel(app, await sessionCookieFor(store, 'lina'), id))).toBe('STATE_CONFLICT');
    expect((await getReq(store, id)).status).toBe(APPLYING);
  });
});
