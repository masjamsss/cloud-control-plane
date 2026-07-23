import { readFileSync } from 'node:fs';
import type { ConfigStore } from '../../src/store/configStore';
import type { AccountItem, RequestItem, RoleBinding, SettingItem, TeamItem } from '../../src/store/schema';
import {
  accountKey,
  accountsGsi,
  policyKey,
  requestCollectionGsi,
  requestKey,
  settingKey,
  teamCollectionGsi,
  teamKey,
} from '../../src/store/schema';
import { mintSession } from '../../src/auth/sessions';

/**
 * The sample-estate project id used across the api test suite. Matches the repo-wide
 * frozen sample-estate id (`SAMPLE_ESTATE_ID` — ccp/app/src/lib/projectScope.ts,
 * AGENTS.md rule 5). test/setup.ts configures `CCP_LEGACY_PROJECT_ID` to THIS value,
 * so the one-time settlement binds the bare seed accounts onto the same id seed() labels
 * teams and policy with — one source of truth, no seed↔settlement desync.
 */
export const SAMPLE_PROJECT_ID = 'sample';

const project = JSON.parse(
  readFileSync(new URL('../../../app/src/data/project.json', import.meta.url), 'utf8'),
) as { teams: Array<{ id: string; name: string; serviceSlugs: string[] }> };

type SeedAccount = {
  id: string;
  role: AccountItem['role'];
  teamId: string;
  isAdmin: boolean;
  projects?: string[];
  /**
   * Explicit PER-PROJECT roles map (new canonical shape). When present it is emitted
   * verbatim and the legacy `role`/`teamId`/`projects` fields are OMITTED — the only way
   * to build a genuinely cross-project fixture (e.g. approver on A, requester on B).
   */
  roles?: Record<string, RoleBinding>;
  /**
   * TOTP enrollment override. Default: enrolled for a SENIOR account (approver/lead on
   * any project), unenrolled for a pure requester — matching the real activation invariant
   * ("mandatory TOTP for approver/lead/admin at every login", ADR-0009 §0.1) that
   * `sessionCookieFor` otherwise bypasses (it mints a session directly, skipping
   * login/enroll). Pass `false` to build a deliberately-unactivated senior fixture.
   */
  totp?: boolean;
};

// NOTE: the standard accounts deliberately carry NO `projects` field — they are
// legacy-shaped (bare) rows that only work once the one-time settlement
// (domain/settlement.ts) materializes them onto the configured legacy estate id
// (the suite sets CCP_LEGACY_PROJECT_ID = SAMPLE_PROJECT_ID — test/setup.ts).
const ACCOUNTS: SeedAccount[] = [
  { id: 'sari', role: 'requester', teamId: 'erp-basis', isAdmin: false },
  { id: 'budi', role: 'approver', teamId: 'erp-basis', isAdmin: false },
  { id: 'putra', role: 'lead', teamId: 'platform', isAdmin: true },
  { id: 'lina', role: 'lead', teamId: 'platform', isAdmin: false },
];

function accountItem(a: SeedAccount): AccountItem {
  // A senior account (approver/lead anywhere) defaults to TOTP-enrolled.
  const seniorAnywhere = a.roles
    ? Object.values(a.roles).some((b) => b.role !== 'requester')
    : a.role === 'approver' || a.role === 'lead';
  const totpEnrolled = a.totp ?? seniorAnywhere;
  // New-shape fixture (explicit roles map) emits ONLY `roles`; legacy fixture emits the
  // legacy trio. Never both — a fixture models exactly one stored shape.
  const roleShape: Partial<AccountItem> = a.roles
    ? { roles: a.roles }
    : { role: a.role, teamId: a.teamId, ...(a.projects ? { projects: a.projects } : {}) };
  return {
    ...accountKey(a.id),
    id: a.id,
    username: a.id,
    displayName: a.id[0]!.toUpperCase() + a.id.slice(1),
    ...roleShape,
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: a.isAdmin,
    credential: { algo: 'argon2id', hash: 'placeholder-never-verified' },
    failedAttempts: 0,
    sessionVersion: 1,
    ...(totpEnrolled ? { totp: { secretEnc: 'seed-enc-secret', enrolledAt: '2026-07-11T00:00:00.000Z' } } : {}),
    GSI1PK: accountsGsi(),
    GSI1SK: a.id,
  };
}

/** Seed one extra account with an explicit allowed-projects binding. */
export async function seedAccount(store: ConfigStore, a: SeedAccount): Promise<void> {
  await store.put(accountItem(a));
}

/** Seed the standard estate: 4 accounts, project teams, policy {1,1,2,2}. */
export async function seed(store: ConfigStore, projectId = SAMPLE_PROJECT_ID): Promise<void> {
  for (const a of ACCOUNTS) await store.put(accountItem(a));
  for (const t of project.teams) {
    const item: TeamItem = { ...teamKey(projectId, t.id), id: t.id, name: t.name, serviceSlugs: t.serviceSlugs, version: 1, GSI1PK: teamCollectionGsi(projectId), GSI1SK: t.id } as TeamItem;
    await store.put(item);
  }
  await setPolicy(store, projectId, { low: 1, medium: 1, high: 2, deleteMin: 2 });
}

export async function setPolicy(
  store: ConfigStore,
  projectId: string,
  p: { low: number; medium: number; high: number; deleteMin: number },
  version = 1,
): Promise<void> {
  await store.put({ ...policyKey(projectId), ...p, version });
}

export async function setSetting(store: ConfigStore, projectId: string, key: string, value: unknown): Promise<void> {
  const item: SettingItem = { ...settingKey(projectId, key), key, value, version: 1, updatedBy: 'putra', updatedAt: '2026-07-11T00:00:00.000Z' };
  await store.put(item);
}

/** Session cookie for a seeded account (bypasses login/TOTP — we test authz, not login). */
export async function sessionCookieFor(store: ConfigStore, userId: string): Promise<string> {
  const k = accountKey(userId);
  const acc = (await store.get(k.PK, k.SK)) as AccountItem;
  const token = await mintSession(store, userId, acc.sessionVersion);
  return `ccp_session=${token}`;
}

/** Seed N already-created requests for a requester (rate-limit setup). */
export async function seedRequests(
  store: ConfigStore,
  projectId: string,
  requester: string,
  count: number,
  over: Partial<RequestItem> = {},
): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const id = `seed-${requester}-${i}`;
    const item = {
      ...requestKey(projectId, id),
      id,
      requestUlid: id,
      requester,
      teamId: 'erp-basis',
      service: 'cloudwatch',
      operationId: 'cloudwatch-alarm-threshold',
      macd: 'Change',
      targetAddress: 'x',
      params: {},
      justification: 'seeded request for rate-limit setup',
      exposure: 'l1_self_service',
      risk: 'LOW',
      status: 'APPLIED',
      approvalsRequired: 1,
      approvals: [],
      schedule: { kind: 'now' },
      createdAt: now,
      updatedAt: now,
      events: [],
      policyVersion: 1,
      GSI1PK: requestCollectionGsi(projectId),
      GSI1SK: id,
      ...over,
    } as RequestItem;
    await store.put(item);
  }
}
