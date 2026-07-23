import type { RiskFloor } from '@/types';
import { currentProjectId, scopedKey, SAMPLE_ESTATE_ID } from '@/lib/projectScope';

/**
 * Per-operation risk overrides. Each catalogued operation ships with a
 * manifest `riskFloor`, but a Lead can reclassify any activity as LOW / MEDIUM /
 * HIGH here — and that effective risk is what drives the approval policy and the
 * badges everywhere. Persisted locally; a real `ccp-api` keeps the same map.
 *
 * Project-scoped: the storage key is computed at call time from the
 * active project, so switching projects never needs a reload.
 */

// legacy key from the Gerbang era — reads old data, never written
const LEGACY_KEY = 'gerbang.risk-overrides.v1';
const storeKey = (): string => scopedKey('risk-overrides');
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
function load(): Record<string, RiskFloor> {
  const raw = readRaw();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, RiskFloor>) : {};
  } catch {
    return {};
  }
}

export function listRiskOverrides(): Record<string, RiskFloor> {
  return load();
}
export function getRiskOverride(operationId: string): RiskFloor | undefined {
  return load()[operationId];
}

/** Effective risk = a Lead's override if set, else the manifest floor. */
export function resolveRisk(op: { id: string; riskFloor: RiskFloor }): RiskFloor {
  return load()[op.id] ?? op.riskFloor;
}

export function setRiskOverride(operationId: string, risk: RiskFloor): void {
  const map = load();
  map[operationId] = risk;
  writeRaw(JSON.stringify(map));
}
export function clearRiskOverride(operationId: string): void {
  const map = load();
  delete map[operationId];
  writeRaw(JSON.stringify(map));
}

export function resetRiskOverridesForTests(): void {
  writeRaw('{}');
}
