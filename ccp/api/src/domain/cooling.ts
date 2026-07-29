import type { ConfigStore, TransactWrite } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import type { AuditEntryInput } from './audit';
import { recordIn } from './audit';
import type { ChainHeadItem, RequestItem } from '../store/schema';
import { chainHead, requestKey } from '../store/schema';
import { ApiError } from '../errors';
import { nowIso, nowMs } from '../clock';

/**
 * Interim-profile cooling-off. `earliestApplyAt` was written at
 * approval time (`routes/requests.ts`) but read by nothing — status flipped straight
 * to APPLIED, so the 24h compensating control the signed risk acceptance leans on was
 * fiction. This module is the enforcement: an `APPROVED_COOLING` request only becomes
 * APPLIED/AWAITING_DEPLOY_APPROVAL once `now >= earliestApplyAt`, evaluated LAZILY on
 * every read/mutation that touches the request — there is no background timer.
 */

/** Has an APPROVED_COOLING request's cooling-off window elapsed as of `nowMsValue`? */
export function coolingElapsed(req: Pick<RequestItem, 'status' | 'earliestApplyAt'>, nowMsValue: number): boolean {
  return req.status === 'APPROVED_COOLING' && req.earliestApplyAt !== undefined && nowMsValue >= Date.parse(req.earliestApplyAt);
}

/**
 * Where an elapsed cooling request lands — driven by its ORIGINAL schedule, exactly
 * where a non-interim approval would have landed immediately (the interim profile only
 * DELAYS the interim path; it never changes the eventual destination).
 *
 * API-19 — AND BY THE FREEZE, which this used to ignore. "No request may RECORD an apply
 * during a freeze" (0024 §2.2/§2.6.1) is enforced by the approve handler at quorum-met:
 * it parks a `kind:'now'` request in `AWAITING_DEPLOY_APPROVAL` with a `held_frozen`
 * event rather than stamping `APPLIED`. This function makes the SAME decision at a
 * different time — when an interim request's cooling-off elapses — and read only
 * `schedule.kind`, so a frozen deployment stamped `APPLIED` here anyway.
 *
 * Which path a request took was decided by whether its risk profile attached a cooling
 * period, so it was precisely the HIGHER-risk requests that bypassed the freeze.
 *
 * `frozen` is a parameter, not a store read, for the same reason it is in
 * `settleFrozenHold`: the list endpoint settles N rows per request and must resolve the
 * freeze once for the page, not once per row.
 */
export function coolingTargetStatus(
  schedule: RequestItem['schedule'],
  frozen: boolean,
): 'APPLIED' | 'AWAITING_DEPLOY_APPROVAL' {
  if (schedule.kind === 'window') return 'AWAITING_DEPLOY_APPROVAL';
  return frozen ? 'AWAITING_DEPLOY_APPROVAL' : 'APPLIED';
}

/**
 * Lazily settle an APPROVED_COOLING request whose window has elapsed. Called from
 * every read/mutation that touches a request (GET one, GET list, cancel, feasibility)
 * so staleness never survives a round trip. Idempotent-safe: if a concurrent
 * settle/cancel already landed (the `ifEquals` guard loses), this re-reads and returns
 * the row's true current state instead of erroring — a read must never fail just
 * because someone else's concurrent read already did the same lazy work.
 */
export async function settleCooling(
  store: ConfigStore,
  projectId: string,
  req: RequestItem,
  frozen: boolean,
): Promise<RequestItem> {
  if (!coolingElapsed(req, nowMs())) return req;

  const target = coolingTargetStatus(req.schedule, frozen);
  const now = nowIso();
  // API-19 — a `kind:'now'` request held by the freeze gets the SAME `held_frozen` event
  // the approve handler writes, deliberately: that marker is what `settleFrozenHold`
  // (API-8) looks for, so this row now has an exit the moment the freeze lifts instead of
  // being parked in a state nothing drains. One freeze rule, one marker, one way out.
  const heldByFreeze = target === 'AWAITING_DEPLOY_APPROVAL' && req.schedule.kind === 'now';
  const label = heldByFreeze
    ? 'Cooling-off window elapsed — held: a change freeze is on'
    : req.schedule.kind === 'window'
      ? `Cooling-off window elapsed — scheduled to apply at ${req.schedule.at}`
      : 'Cooling-off window elapsed — APPLIED';
  const eventType = heldByFreeze ? 'held_frozen' : target === 'APPLIED' ? 'applied' : 'scheduled';
  const events = [...req.events, { at: now, type: eventType, label }];
  const entry: AuditEntryInput = {
    action: 'request-apply',
    actor: 'system:cooling-window-elapsed',
    targetType: 'request',
    targetId: req.id,
    requestId: req.id,
    before: { status: req.status },
    after: { status: target },
  };

  const k = requestKey(projectId, req.id);
  const hKey = chainHead(projectId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes } = recordIn(projectId, head, entry);
    const domain: TransactWrite[] = [
      { kind: 'update', pk: k.PK, sk: k.SK, set: { status: target, updatedAt: now, events }, ifEquals: { attr: 'status', value: 'APPROVED_COOLING' } },
    ];
    try {
      await store.transact([...domain, ...writes]);
      return { ...req, status: target, updatedAt: now, events };
    } catch (e) {
      if (e instanceof ConditionError) {
        const fresh = (await store.get(k.PK, k.SK)) as RequestItem | null;
        if (fresh && fresh.status !== 'APPROVED_COOLING') return fresh; // already settled/cancelled by someone else
        if (attempt === 0) continue; // chain contention (a DIFFERENT request's write) → retry once
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  return req;
}
