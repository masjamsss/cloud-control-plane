import type { ConfigStore, TransactWrite } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import type { AuditEntryInput } from './audit';
import { CHAIN_RETRY_ATTEMPTS, chainRetryBackoff, recordIn } from './audit';
import type { ChainHeadItem, RequestItem } from '../store/schema';
import { chainHead, requestKey } from '../store/schema';
import { ApiError } from '../errors';
import { nowIso } from '../clock';
import { currentRequirement } from './requirement';

/**
 * API-8 — the freeze-held `kind:'now'` request, and its way out.
 *
 * At quorum-met the approve handler stamps `APPLIED` for a `kind:'now'` schedule — but a
 * change freeze vetoes that stamp (no request may RECORD an apply during a freeze), so the
 * row is parked in `AWAITING_DEPLOY_APPROVAL` with a `held_frozen` event instead. That
 * park had no exit. Once the freeze lifted, nothing ever completed the request:
 * `settleWindow` returns immediately for `kind:'now'`, the scheduler's due filter only
 * considers rows whose maintenance window is open (a `kind:'now'` row has none), and the
 * apply bundle is disarmed by default. The row sat at "Fully approved — held" forever, and
 * cancel was its only exit.
 *
 * What makes it a defect rather than a policy is the arbitrariness: the SAME request
 * approved one minute after the unfreeze is stamped `APPLIED` instantly. Its terminal fate
 * depended entirely on which side of the freeze the last signature happened to land on.
 *
 * This is the missing sibling of `settleCooling`/`settleWindow`, and follows their
 * doctrine exactly: LAZY, on read, guarded, audited, idempotent-safe. There is no
 * background timer in this system, so a state that needs an external event to advance is a
 * state that needs to be settled by whoever next looks at it.
 */

/**
 * Is this row a freeze-hold waiting to be released? Pure and store-free ON PURPOSE — the
 * freeze itself is a store read, and the list path settles N rows per request. Screening
 * with this first means a list of a hundred healthy requests costs zero extra reads, and
 * the freeze is read once for the whole page rather than once per row.
 *
 * The `held_frozen` marker is the discriminator, not the status/schedule pair alone. Today
 * the freeze branch is the only way a `kind:'now'` row can be sitting in
 * `AWAITING_DEPLOY_APPROVAL`, so the two are equivalent — but only the marker says *why*
 * the row is there, and a future branch that parks a `now` row for some other reason must
 * not be silently swept into APPLIED by this.
 */
export function isFrozenHold(req: Pick<RequestItem, 'status' | 'schedule' | 'events'>): boolean {
  return (
    req.status === 'AWAITING_DEPLOY_APPROVAL' &&
    req.schedule.kind === 'now' &&
    req.events.some((e) => e.type === 'held_frozen')
  );
}

/**
 * Release a freeze-held `kind:'now'` request now that the freeze is off.
 *
 * `frozen` is passed IN rather than read here: the caller already knows it (and on a list
 * read has resolved it once for the whole page). A `true` is a no-op, so callers may call
 * unconditionally.
 *
 * Fail-closed on quorum. The row completed its ladder to get here, but the ladder can be
 * TIGHTENED afterwards, and `currentRequirement` is the same tighten-only helper the
 * approve and apply handlers consult. If the bar moved above what this request carries,
 * releasing it would stamp `APPLIED` on a change that no longer meets its own quorum —
 * so it stays held instead. Staying stranded is a worse user experience and a strictly
 * safer one, and unlike the original defect it is now a state a human can act on: the
 * request needs another approval, which the ladder will ask for.
 */
export async function settleFrozenHold(
  store: ConfigStore,
  projectId: string,
  req: RequestItem,
  frozen: boolean,
): Promise<RequestItem> {
  if (frozen || !isFrozenHold(req)) return req;
  const { required } = currentRequirement(req);
  if (req.approvals.length < required) return req;

  const now = nowIso();
  const events = [
    ...req.events,
    { at: now, type: 'applied', label: 'Change freeze lifted — the held approval completes: APPLIED' },
  ];
  const entry: AuditEntryInput = {
    action: 'request-apply',
    actor: 'system:freeze-lifted',
    targetType: 'request',
    targetId: req.id,
    requestId: req.id,
    before: { status: req.status, heldFrozen: true },
    after: { status: 'APPLIED' },
  };

  const k = requestKey(projectId, req.id);
  const hKey = chainHead(projectId);
  for (let attempt = 0; attempt < CHAIN_RETRY_ATTEMPTS; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes } = recordIn(projectId, head, entry);
    const domain: TransactWrite[] = [
      { kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'APPLIED', updatedAt: now, events }, ifEquals: { attr: 'status', value: 'AWAITING_DEPLOY_APPROVAL' } },
    ];
    try {
      await store.transact([...domain, ...writes]);
      return { ...req, status: 'APPLIED', updatedAt: now, events };
    } catch (e) {
      if (e instanceof ConditionError) {
        const fresh = (await store.get(k.PK, k.SK)) as RequestItem | null;
        // Someone else settled, cancelled or re-windowed it first — report the row's true
        // state rather than failing a READ because a concurrent read did the same work.
        if (fresh && fresh.status !== 'AWAITING_DEPLOY_APPROVAL') return fresh;
        if (attempt < CHAIN_RETRY_ATTEMPTS - 1) { await chainRetryBackoff(attempt); continue; } // chain contention (a DIFFERENT request's write) → retry with backoff (PERF-11)
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  return req;
}
