import type { ConfigStore, TransactWrite } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import type { AuditEntryInput } from './audit';
import { recordIn } from './audit';
import type { ChainHeadItem, RequestItem } from '../store/schema';
import { chainHead, requestKey } from '../store/schema';
import { ApiError } from '../errors';
import { nowIso, nowMs } from '../clock';

/**
 * Scheduling enforcement: from recorded window to enforced window. This
 * module owns ALL schedule arithmetic (mirrors how `domain/exposure.ts` owns tier
 * logic, `domain/cooling.ts` owns the cooling-off enforcement this module
 * composes with). Every PURE export is a function of explicit inputs — `now` is
 * always a parameter, never read from a clock internally — so every scenario is a
 * deterministic table test (testability mandate) and callers drive time
 * through `clock.ts#nowMs()`/`__setNow` at the call site, not in here. The one
 * exception is {@link settleWindow} (T-S4), a store-mutating write-on-read settle —
 * co-located here rather than split into its own file for the SAME reason
 * `domain/cooling.ts` keeps `settleCooling` beside `coolingElapsed`: the settle
 * logic and the pure gate it settles against must never drift apart.
 *
 * `applyGate`/`evaluateTime` are a from-scratch TypeScript port of
 * `tools/catalogctl/internal/windowcheck/windowcheck.go`'s `Evaluate` — the
 * AUTHORITATIVE encoding of the composition rule the CI pipeline enforces.
 * The two must never diverge: `test/scheduleWindowCheckParity.test.ts` cross-checks
 * this port against the real `catalogctl window-check` binary, verdict-for-verdict,
 * over the shared `tools/catalogctl/testdata/windows/*.yaml` fixtures.
 *
 * The pure surface is deliberately independent of `store/schema.ts`'s `RequestItem`
 * (T-S1 had no dependency on the Schedule-v2 store shape T-S2 landed) — this
 * module's `Schedule` is the source of truth `store/schema.ts`'s zod shape was made
 * to MATCH, not the other way round. Callers (routes/requests.ts) pass a
 * `RequestItem` structurally where `{schedule, earliestApplyAt}` is expected.
 */

/** The schedule shape this module operates on (Schedule v2 — `endAt` added). */
export type Schedule = { kind: 'now' } | { kind: 'window'; at: string; endAt?: string };

/** The shape a submit/rewindow BODY carries, pre-normalization. */
export type ScheduleInput = { kind: 'now' } | { kind: 'window'; at: string; endAt?: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** V3 — the minimum lead a fresh `window.at` (or a rewound one) must clear. */
export const MIN_LEAD_MS = 30 * MINUTE_MS;
/** V4 — the furthest out a `window.at` may be stamped. */
export const MAX_HORIZON_MS = 90 * DAY_MS;
/** V5 default — an omitted `endAt` is stamped `at + DEFAULT_WINDOW_MS`. */
export const DEFAULT_WINDOW_MS = 4 * HOUR_MS;
/** V5 cap — the longest a maintenance window may span. */
export const MAX_WINDOW_MS = 24 * HOUR_MS;
/** A rewindow refuses once the last approval is this stale (SCHEDULE_STALE_APPROVAL). */
export const REWINDOW_STALE_MS = 30 * DAY_MS;

export type ScheduleValidationError = 'SCHEDULE_INVALID' | 'SCHEDULE_TOO_SOON' | 'SCHEDULE_TOO_FAR';

export type ScheduleValidation =
  | { ok: true; schedule: Schedule }
  | { ok: false; code: ScheduleValidationError };

/**
 * `validateSchedule` — V1–V6, called at submit (after the zod shape
 * parse, before the item is built) and at rewindow (V2–V6 only; rewindow bodies are
 * always `kind:'window'`, so V1 never applies there). Returns the NORMALIZED
 * schedule (V6: both instants re-serialized through `new Date(x).toISOString()`,
 * and V5's default `endAt` computed+filled) so the store only ever holds one
 * canonical shape.
 */
export function validateSchedule(input: ScheduleInput, nowMsValue: number): ScheduleValidation {
  if (input.kind === 'now') return { ok: true, schedule: { kind: 'now' } }; // V1

  const atMs = Date.parse(input.at);
  if (!Number.isFinite(atMs)) return { ok: false, code: 'SCHEDULE_INVALID' }; // V2

  if (atMs < nowMsValue + MIN_LEAD_MS) return { ok: false, code: 'SCHEDULE_TOO_SOON' }; // V3
  if (atMs > nowMsValue + MAX_HORIZON_MS) return { ok: false, code: 'SCHEDULE_TOO_FAR' }; // V4

  let endMs: number;
  if (input.endAt !== undefined) {
    endMs = Date.parse(input.endAt);
    if (!Number.isFinite(endMs) || endMs <= atMs || endMs - atMs > MAX_WINDOW_MS) {
      return { ok: false, code: 'SCHEDULE_INVALID' }; // V5 (explicit endAt out of bounds)
    }
  } else {
    endMs = atMs + DEFAULT_WINDOW_MS; // V5 (default duration)
  }

  return {
    ok: true,
    schedule: { kind: 'window', at: new Date(atMs).toISOString(), endAt: new Date(endMs).toISOString() }, // V6
  };
}

/**
 * The effective window end for a STORED schedule. Explicit `endAt` wins; a legacy
 * row written before Schedule v2 (or one that otherwise omits it) is total via
 * `at + DEFAULT_WINDOW_MS` ("so the gate below is total"). `undefined`
 * for `kind:'now'` (no window exists) or an unparseable `at`.
 */
export function windowEndOf(schedule: Schedule): string | undefined {
  if (schedule.kind !== 'window') return undefined;
  if (schedule.endAt) return schedule.endAt;
  const atMs = Date.parse(schedule.at);
  if (!Number.isFinite(atMs)) return undefined;
  return new Date(atMs + DEFAULT_WINDOW_MS).toISOString();
}

/** windowcheck.go's `Verdict` enum, ported field-for-field. */
export type TimeVerdict = 'IN_WINDOW' | 'NO_WINDOW' | 'BEFORE_WINDOW' | 'WINDOW_EXPIRED' | 'SCHEDULE_INVALID';

interface TimeAnalysis {
  invalid: boolean;
  earliestMs?: number;
  startMs?: number;
  endMs?: number;
  /** `earliestApplyAt` set, valid, and not yet reached (never true once expired). */
  cooling: boolean;
  /** `kind:'window'`, not yet expired, and `now < start` (never true once expired). */
  beforeStart: boolean;
  /** `kind:'window'` and `now >= end`. Takes precedence over cooling/beforeStart
   * (windowcheck.go's own documented precedence). */
  expired: boolean;
}

/**
 * The single source of truth both {@link evaluateTime} (the windowcheck.go mirror)
 * and {@link applyGate} (the richer SPA-facing gate) are VIEWS over — so the two can
 * never independently drift on what "cooling"/"before start"/"expired" means.
 */
function analyzeTime(schedule: Schedule, earliestApplyAt: string | undefined, nowMsValue: number): TimeAnalysis {
  let earliestMs: number | undefined;
  if (earliestApplyAt !== undefined) {
    earliestMs = Date.parse(earliestApplyAt);
    if (!Number.isFinite(earliestMs)) {
      return { invalid: true, cooling: false, beforeStart: false, expired: false };
    }
  }

  if (schedule.kind === 'now') {
    const cooling = earliestMs !== undefined && nowMsValue < earliestMs;
    return { invalid: false, earliestMs, cooling, beforeStart: false, expired: false };
  }

  const startMs = Date.parse(schedule.at);
  const endIso = windowEndOf(schedule);
  const endMs = endIso !== undefined ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(startMs < endMs)) {
    return { invalid: true, cooling: false, beforeStart: false, expired: false };
  }

  const expired = nowMsValue >= endMs;
  const cooling = !expired && earliestMs !== undefined && nowMsValue < earliestMs;
  const beforeStart = !expired && nowMsValue < startMs;
  return { invalid: false, earliestMs, startMs, endMs, cooling, beforeStart, expired };
}

/**
 * `evaluateTime` — a direct, from-scratch port of windowcheck.go's `Evaluate`
 * (freeze excluded; the Go library doesn't know about it either — sources
 * freeze from the CI plane separately). Same five verdicts, same precedence
 * (malformed → expired → cooling → before-start → in/no-window), same `opensAt`
 * arithmetic (`max(earliest, start)` when both gates are shut). This is the exact
 * surface `test/scheduleWindowCheckParity.test.ts` cross-checks against the real
 * `catalogctl window-check` binary.
 */
export function evaluateTime(
  schedule: Schedule,
  earliestApplyAt: string | undefined,
  nowMsValue: number,
): { verdict: TimeVerdict; opensAt?: string } {
  const a = analyzeTime(schedule, earliestApplyAt, nowMsValue);
  if (a.invalid) return { verdict: 'SCHEDULE_INVALID' };

  // opensAt is always re-serialized via toISOString() — never the raw stored
  // string verbatim — so every branch's output is byte-consistent (V6-style
  // normalization) regardless of which instant(s) it was derived from.
  if (schedule.kind === 'now') {
    return a.cooling ? { verdict: 'BEFORE_WINDOW', opensAt: new Date(a.earliestMs!).toISOString() } : { verdict: 'NO_WINDOW' };
  }

  if (a.expired) return { verdict: 'WINDOW_EXPIRED' };
  if (a.cooling) {
    const opensAtMs = Math.max(a.earliestMs!, a.startMs!);
    return { verdict: 'BEFORE_WINDOW', opensAt: new Date(opensAtMs).toISOString() };
  }
  if (a.beforeStart) return { verdict: 'BEFORE_WINDOW', opensAt: new Date(a.startMs!).toISOString() };
  return { verdict: 'IN_WINDOW' };
}

/** Reasons {@link applyGate} may report — ordered. All
 * APPLICABLE reasons are reported together (never short-circuited): FROZEN can
 * co-occur with any time reason, and COOLING can co-occur with BEFORE_WINDOW
 * (the "cooling-off until 09:14 tomorrow · window opens 22:00" case). */
export type GateReason = 'FROZEN' | 'COOLING' | 'BEFORE_WINDOW' | 'WINDOW_EXPIRED' | 'SCHEDULE_INVALID';

export interface GateVerdict {
  /** True iff the conjunction holds: ¬frozen ∧ cooling satisfied ∧ in-window. */
  clear: boolean;
  reasons: GateReason[];
  /** The instant every still-shut gate clears (the LATER of earliest/start), when
   * at least one of COOLING/BEFORE_WINDOW is reported. Absent once WINDOW_EXPIRED
   * or SCHEDULE_INVALID fires (there is no "opens at" for a dead window) and absent
   * when `clear` (nothing to report). FROZEN alone never contributes an `opensAt` —
   * unfreezing is a human act on no fixed clock. */
  opensAt?: string;
}

/**
 * `applyGate` — the composition rule as code, the second `domain/
 * schedule.ts` export T-S1 promises. Composes FROZEN (an orthogonal, ALWAYS-
 * reported veto — never consulted by {@link evaluateTime}, which the CI plane
 * mirrors instead) with the time verdict from {@link analyzeTime},
 * expanded into the richer COOLING/BEFORE_WINDOW split {@link evaluateTime}
 * collapses for windowcheck.go's single-token verdict.
 */
export function applyGate(
  item: { schedule: Schedule; earliestApplyAt?: string },
  frozen: boolean,
  nowMsValue: number,
): GateVerdict {
  const a = analyzeTime(item.schedule, item.earliestApplyAt, nowMsValue);
  const reasons: GateReason[] = [];
  if (frozen) reasons.push('FROZEN');

  if (a.invalid) {
    reasons.push('SCHEDULE_INVALID');
    return { clear: false, reasons };
  }
  if (a.expired) {
    reasons.push('WINDOW_EXPIRED');
    return { clear: false, reasons };
  }
  if (a.cooling) reasons.push('COOLING');
  if (a.beforeStart) reasons.push('BEFORE_WINDOW');

  const opensAt =
    a.cooling || a.beforeStart
      ? new Date(Math.max(a.earliestMs ?? -Infinity, a.startMs ?? -Infinity)).toISOString()
      : undefined;
  return { clear: reasons.length === 0, reasons, ...(opensAt !== undefined ? { opensAt } : {}) };
}

/**
 * Eager infeasibility: can this schedule EVER be satisfied
 * given the `earliestApplyAt` just stamped? Distinct from the LAZY {@link applyGate}
 * — which only discovers this once `now` itself reaches `windowEnd` — because a
 * cooling-off that outlasts its own window is a doomed wait from the instant it is
 * created, and that should be surfaced immediately at quorum-met, not after a
 * silent stall. Pure function of the schedule fields; `nowMsValue` only matters for
 * the "window already wholly past" trigger (a slow non-interim quorum can also
 * complete after the window closed, with no cooling involved at all).
 */
export function isWindowInfeasible(schedule: Schedule, earliestApplyAt: string | undefined, nowMsValue: number): boolean {
  if (schedule.kind !== 'window') return false;
  const endIso = windowEndOf(schedule);
  const endMs = endIso !== undefined ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(endMs)) return false; // malformed — SCHEDULE_INVALID is applyGate's concern
  if (nowMsValue >= endMs) return true;
  const earliestMs = earliestApplyAt !== undefined ? Date.parse(earliestApplyAt) : undefined;
  return earliestMs !== undefined && Number.isFinite(earliestMs) && earliestMs >= endMs;
}

/**
 * `settleWindow` (T-S4) — lazily settle an `AWAITING_DEPLOY_
 * APPROVAL` request whose window has expired: stamps `WINDOW_EXPIRED` + a
 * `window_expired` event + an audit entry on the NEXT read/mutation that touches
 * it, write-on-read exactly like `domain/cooling.ts#settleCooling` (which this
 * composes with at every call site — settle cooling FIRST so a request that just
 * left `APPROVED_COOLING` can be re-evaluated for window expiry in the SAME touch;
 * see routes/requests.ts). No background timer anywhere (justification
 * applies identically here).
 *
 * A no-op for anything not currently `AWAITING_DEPLOY_APPROVAL` (nothing else can
 * expire — `APPROVED_COOLING` is `settleCooling`'s job, and every OTHER status is
 * either open, terminal, or already `WINDOW_EXPIRED`) or whose schedule isn't
 * `kind:'window'` (a freeze-held `kind:'now'` row sitting in `AWAITING_DEPLOY_
 * APPROVAL` has no window to expire — "kind:'now' is a degenerate
 * always-open window"). Idempotent-safe: a losing race (a concurrent cancel/
 * rewindow, or a concurrent settle) re-reads and returns the row's TRUE current
 * state instead of erroring.
 */
export async function settleWindow(store: ConfigStore, projectId: string, req: RequestItem): Promise<RequestItem> {
  if (req.status !== 'AWAITING_DEPLOY_APPROVAL' || req.schedule.kind !== 'window') return req;
  const verdict = applyGate(req, false, nowMs()); // frozen is irrelevant to EXPIRY specifically (freeze never masks it, but never causes it either)
  if (!verdict.reasons.includes('WINDOW_EXPIRED')) return req;

  const now = nowIso();
  const closedAt = windowEndOf(req.schedule) ?? req.schedule.at;
  const events = [
    ...req.events,
    { at: now, type: 'window_expired', label: `Maintenance window closed at ${closedAt} — re-window or cancel` },
  ];
  const entry: AuditEntryInput = {
    action: 'request-window-expired',
    actor: 'system:window-elapsed',
    targetType: 'request',
    targetId: req.id,
    requestId: req.id,
    before: { status: req.status },
    after: { status: 'WINDOW_EXPIRED' },
  };

  const k = requestKey(projectId, req.id);
  const hKey = chainHead(projectId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes } = recordIn(projectId, head, entry);
    const domain: TransactWrite[] = [
      { kind: 'update', pk: k.PK, sk: k.SK, set: { status: 'WINDOW_EXPIRED', updatedAt: now, events }, ifEquals: { attr: 'status', value: 'AWAITING_DEPLOY_APPROVAL' } },
    ];
    try {
      await store.transact([...domain, ...writes]);
      return { ...req, status: 'WINDOW_EXPIRED', updatedAt: now, events };
    } catch (e) {
      if (e instanceof ConditionError) {
        const fresh = (await store.get(k.PK, k.SK)) as RequestItem | null;
        if (fresh && fresh.status !== 'AWAITING_DEPLOY_APPROVAL') return fresh; // already settled/cancelled/rewound by someone else
        if (attempt === 0) continue; // chain contention (a DIFFERENT request's write) → retry once
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  return req;
}
