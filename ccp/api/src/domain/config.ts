import { DEFAULT_POLICY, type ApprovalPolicy } from '@app-lib/policy';
import type { Team } from '@/types';
import type { ConfigStore } from '../store/configStore';
import type { AccountItem, PolicyItem, RiskOverrideItem, SettingItem, TeamItem } from '../store/schema';
import { accountsGsi, policyKey, riskOverrideKey, settingKey, teamCollectionGsi } from '../store/schema';

/**
 * Server-side readers of authoritative config. These never touch the app's
 * localStorage-backed stores — the server owns the truth. `approvalsFor`/`canRequest`/
 * `canApprove` are imported read-only from the app and ALWAYS called with the server
 * policy/teams explicitly, so their localStorage default parameters never evaluate.
 */

export async function loadPolicy(store: ConfigStore, projectId: string): Promise<{ policy: ApprovalPolicy; version: number }> {
  const k = policyKey(projectId);
  const item = (await store.get(k.PK, k.SK)) as PolicyItem | null;
  if (!item) return { policy: { ...DEFAULT_POLICY }, version: 0 };
  return {
    policy: { low: item.low, medium: item.medium, high: item.high, deleteMin: item.deleteMin },
    version: item.version,
  };
}

export async function loadTeams(store: ConfigStore, projectId: string): Promise<Team[]> {
  const items = (await store.queryGSI1(teamCollectionGsi(projectId))) as TeamItem[];
  return items.map((t) => ({ id: t.id, name: t.name, serviceSlugs: t.serviceSlugs }));
}

/** Effective risk = a Lead's override if set, else the manifest floor (server RISKOVR# items). */
export async function resolveRisk(
  store: ConfigStore,
  projectId: string,
  op: { id: string; riskFloor: 'LOW' | 'MEDIUM' | 'HIGH' },
): Promise<{ risk: 'LOW' | 'MEDIUM' | 'HIGH'; version: number }> {
  const k = riskOverrideKey(projectId, op.id);
  const ovr = (await store.get(k.PK, k.SK)) as RiskOverrideItem | null;
  return ovr ? { risk: ovr.risk, version: ovr.version } : { risk: op.riskFloor, version: 0 };
}

export async function loadSetting<T = unknown>(store: ConfigStore, projectId: string, key: string): Promise<T | undefined> {
  const k = settingKey(projectId, key);
  const item = (await store.get(k.PK, k.SK)) as SettingItem | null;
  return item ? (item.value as T) : undefined;
}

export async function isFrozen(store: ConfigStore, projectId: string): Promise<boolean> {
  return (await loadSetting<boolean>(store, projectId, 'freeze.global')) === true;
}

export async function disabledOps(store: ConfigStore, projectId: string): Promise<string[]> {
  return (await loadSetting<string[]>(store, projectId, 'catalog.disabled-ops')) ?? [];
}

export type RateLimits = { submissionsPerHour: number; maxOpen: number };
export const DEFAULT_RATE_LIMITS: RateLimits = { submissionsPerHour: 50, maxOpen: 20 };

export async function rateLimits(store: ConfigStore, projectId: string): Promise<RateLimits> {
  const v = await loadSetting<Partial<RateLimits>>(store, projectId, 'rate.limits');
  return { ...DEFAULT_RATE_LIMITS, ...(v ?? {}) };
}

/** All accounts (GLOBAL directory) — used for eligible-approver counts and admin listing. */
export async function loadAccounts(store: ConfigStore): Promise<AccountItem[]> {
  return (await store.queryGSI1(accountsGsi())) as AccountItem[];
}
