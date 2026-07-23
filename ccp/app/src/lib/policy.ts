import type { Macd, RiskFloor } from '@/types';
import { currentProjectId, scopedKey, SAMPLE_ESTATE_ID } from '@/lib/projectScope';

/**
 * The approval policy — how many senior approvals a change needs, keyed by its
 * risk level, plus a floor for deletes. Editable by a Lead; `approvalsFor` (and
 * permissions.approvalsRequiredFor) read it. Persisted locally; a real
 * `ccp-api` keeps the same shape.
 *
 * Invariant from the concept: nothing auto-applies — every tier is ≥ 1 approval.
 *
 * Project-scoped: the storage key is computed at call time from the
 * active project, so switching projects never needs a reload.
 */

export interface ApprovalPolicy {
  low: number;
  medium: number;
  high: number;
  /** A delete needs at least this many, regardless of its risk tier. */
  deleteMin: number;
}

export const DEFAULT_POLICY: ApprovalPolicy = { low: 1, medium: 1, high: 2, deleteMin: 2 };
export const MIN_APPROVALS = 1;
export const MAX_APPROVALS = 5;

// legacy key from the Gerbang era — reads old data, never written
const LEGACY_KEY = 'gerbang.policy.v1';
const storeKey = (): string => scopedKey('policy');
const memory = new Map<string, string>();

function readRaw(): string | null {
  // One-time legacy migration: an un-namespaced v1 key surfaces under the
  // sample estate exactly once.
  try {
    if (
      currentProjectId() === SAMPLE_ESTATE_ID &&
      localStorage.getItem(LEGACY_KEY) !== null &&
      localStorage.getItem(storeKey()) === null
    ) {
      localStorage.setItem(storeKey(), localStorage.getItem(LEGACY_KEY)!);
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    /* storage unavailable — memory fallback path needs no migration */
  }
  try {
    return localStorage.getItem(storeKey());
  } catch {
    return memory.get(storeKey()) ?? null;
  }
}
function writeRaw(value: string): void {
  try {
    localStorage.setItem(storeKey(), value);
  } catch {
    memory.set(storeKey(), value);
  }
}

function clamp(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_APPROVALS, Math.min(MAX_APPROVALS, Math.round(n)));
}

export function getPolicy(): ApprovalPolicy {
  const raw = readRaw();
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    const p = JSON.parse(raw) as Partial<ApprovalPolicy>;
    return {
      low: clamp(p.low ?? DEFAULT_POLICY.low, DEFAULT_POLICY.low),
      medium: clamp(p.medium ?? DEFAULT_POLICY.medium, DEFAULT_POLICY.medium),
      high: clamp(p.high ?? DEFAULT_POLICY.high, DEFAULT_POLICY.high),
      deleteMin: clamp(p.deleteMin ?? DEFAULT_POLICY.deleteMin, DEFAULT_POLICY.deleteMin),
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function setPolicy(next: Partial<ApprovalPolicy>): ApprovalPolicy {
  const merged = { ...getPolicy(), ...next };
  const clamped: ApprovalPolicy = {
    low: clamp(merged.low, DEFAULT_POLICY.low),
    medium: clamp(merged.medium, DEFAULT_POLICY.medium),
    high: clamp(merged.high, DEFAULT_POLICY.high),
    deleteMin: clamp(merged.deleteMin, DEFAULT_POLICY.deleteMin),
  };
  writeRaw(JSON.stringify(clamped));
  return clamped;
}

const RISK_KEY: Record<RiskFloor, keyof ApprovalPolicy> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

/** Approvals a change needs given its risk tier and MACD, under a policy. */
export function approvalsFor(risk: RiskFloor, macd: Macd, policy: ApprovalPolicy = getPolicy()): number {
  const base = policy[RISK_KEY[risk]];
  return macd === 'Delete' ? Math.max(base, policy.deleteMin) : base;
}

/** Test-only: reset to defaults. */
export function resetPolicyForTests(): void {
  writeRaw(JSON.stringify(DEFAULT_POLICY));
}
