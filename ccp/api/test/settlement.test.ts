import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import { accountKey, accountsGsi, projectKey, settlementKey, teamKey, teamCollectionGsi, type AccountItem, type ProjectItem } from '../src/store/schema';
import { runSettlement, SettlementConfigError } from '../src/domain/settlement';
import { legacyProjectId } from '../src/deploy';
import { CONTROL_SCOPE, rolesOf } from '../src/projects';
import { exportAuditChain } from '../src/domain/auditQuery';
import { needsTotp } from '../src/auth/totp';
import { seed, sessionCookieFor } from './helpers/seed';

/**
 * data-birth spec §9 — the one-time legacy settlement. Proves:
 *
 *  - idempotent (a second run is a no-op — no duplicate writes, no duplicate audit);
 *  - retro-registers `sample` iff a real legacy footprint exists, WITHOUT a trust block
 *    (it never passed prescan — that honesty is recorded, not papered over);
 *  - a genuinely blank store (no legacy footprint) is left alone — no phantom
 *    `sample` project is manufactured;
 *  - bare-row materialization is BYTE-IDENTICAL to what the retired `rolesOf` shim
 *    (arm 2: a `projects` list; arm 3: bare → `sample`-only) used to compute on the
 *    fly — the shim and the settlement are proven equivalent before the shim dies;
 *  - both writes audit onto the `@control` chain (control-plane bookkeeping, not
 *    the estate's own history);
 *  - survives a restart (the on-disk `SETTLEMENT` marker, not memory, is the
 *    source of truth — `runSettlement` called twice, independent of any
 *    in-process cache, is still a no-op the second time).
 */

async function bareAccount(id: string, over: Partial<AccountItem> = {}): Promise<AccountItem> {
  return {
    ...accountKey(id),
    id,
    username: id,
    displayName: id,
    role: 'approver',
    teamId: 'app-platform',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    GSI1PK: accountsGsi(),
    GSI1SK: id,
    ...over,
  };
}

describe('settlement — the one-time legacy settlement (data-birth spec §9)', () => {
  describe('retro-registration: only a REAL legacy sample footprint gets adopted', () => {
    it('a store with a real sample footprint (teams) but no ProjectItem gets sample retro-registered — ready, no trust block', async () => {
      const store = new MemoryStore();
      await seed(store); // writes 'sample'-scoped team + policy rows; no ProjectItem
      const pKey = projectKey('sample');
      expect(await store.get(pKey.PK, pKey.SK)).toBeNull();

      const result = await runSettlement(store);
      expect(result.retroRegistered).toBe(true);

      const project = (await store.get(pKey.PK, pKey.SK)) as ProjectItem;
      expect(project).toBeTruthy();
      expect(project.status).toBe('ready');
      expect(project.createdBy).toBe('migration');
      expect(project.trust).toBeUndefined(); // never passed prescan — recorded honestly, not backfilled
    });

    it('a genuinely blank store (accounts only, no sample footprint) is left alone — no phantom sample project', async () => {
      const store = new MemoryStore();
      await store.put(await bareAccount('putra', { role: 'lead', isAdmin: true }));

      const result = await runSettlement(store);
      expect(result.retroRegistered).toBe(false);

      const pKey = projectKey('sample');
      expect(await store.get(pKey.PK, pKey.SK)).toBeNull();
    });

    it('a store that already has an sample ProjectItem is never re-registered (idempotent by construction, not just by marker)', async () => {
      const store = new MemoryStore();
      await seed(store);
      const existing: ProjectItem = {
        ...projectKey('sample'),
        id: 'sample',
        name: 'sample (already onboarded the real way)',
        accountId: '123456789012',
        region: 'ap-southeast-5',
        status: 'ready',
        createdBy: 'putra',
        createdAt: '2020-01-01T00:00:00.000Z',
        version: 1,
        trust: { trustedBy: 'putra', trustedAt: '2020-01-01T00:00:00.000Z', preScanReportSha256: 'x'.repeat(64), commitSha: 'a'.repeat(40) },
        GSI1PK: 'PROJECTS',
        GSI1SK: 'sample',
      };
      await store.put(existing as never);

      const result = await runSettlement(store);
      expect(result.retroRegistered).toBe(false);
      const after = (await store.get(projectKey('sample').PK, projectKey('sample').SK)) as ProjectItem;
      expect(after).toEqual(existing); // untouched — a real trust record is never overwritten
    });
  });

  describe('bare-row materialization ≡ the retired rolesOf shim (arm 2/3), stamped explicit', () => {
    it('arm 3 (bare: role/teamId, no projects) materializes to exactly {sample: {role, teamId}} — what arm 3 used to compute live', async () => {
      const store = new MemoryStore();
      await store.put(await bareAccount('approver1', { role: 'approver', teamId: 'app-platform' }));

      const result = await runSettlement(store);
      expect(result.accountsMaterialized).toBe(1);

      const after = (await store.get(accountKey('approver1').PK, 'META')) as AccountItem;
      expect(after.roles).toEqual({ sample: { role: 'approver', teamId: 'app-platform' } });
      // and the canonical shim (rolesOf arm 1) now reads it back verbatim.
      expect(rolesOf(after)).toEqual({ sample: { role: 'approver', teamId: 'app-platform' } });
    });

    it('arm 3, no teamId at all: materializes to {sample: {role}} — teamId is omitted, never stamped as undefined', async () => {
      const store = new MemoryStore();
      const bare = await bareAccount('noteam', { role: 'lead' });
      delete (bare as { teamId?: string }).teamId;
      await store.put(bare);

      await runSettlement(store);
      const after = (await store.get(accountKey('noteam').PK, 'META')) as AccountItem;
      expect(after.roles).toEqual({ sample: { role: 'lead' } });
      expect(Object.keys(after.roles!.sample!)).not.toContain('teamId');
    });

    it('arm 2 (a `projects` membership list) materializes to one binding PER listed project — including the \'*\' wildcard', async () => {
      const store = new MemoryStore();
      await store.put(await bareAccount('multi', { role: 'approver', teamId: 'app-platform', projects: ['sample', 'acme'] }));
      await store.put(await bareAccount('wild', { role: 'lead', teamId: 'platform', projects: ['*'] }));

      await runSettlement(store);

      const multi = (await store.get(accountKey('multi').PK, 'META')) as AccountItem;
      expect(multi.roles).toEqual({
        sample: { role: 'approver', teamId: 'app-platform' },
        acme: { role: 'approver', teamId: 'app-platform' },
      });

      const wild = (await store.get(accountKey('wild').PK, 'META')) as AccountItem;
      expect(wild.roles).toEqual({ '*': { role: 'lead', teamId: 'platform' } });
    });

    it('a row that already carries `roles` (canonical shape) is never touched — arm 1 rows are not re-materialized', async () => {
      const store = new MemoryStore();
      const canonical = await bareAccount('modern', { role: undefined, teamId: undefined, roles: { sample: { role: 'lead' } } });
      await store.put(canonical);

      const result = await runSettlement(store);
      expect(result.accountsMaterialized).toBe(0);
      const after = (await store.get(accountKey('modern').PK, 'META')) as AccountItem;
      expect(after.roles).toEqual({ sample: { role: 'lead' } }); // byte-identical, no rewrite
    });

    it('the standard 4-account estate (seed()) all materialize correctly in one pass', async () => {
      const store = new MemoryStore();
      await seed(store);
      const result = await runSettlement(store);
      expect(result.accountsMaterialized).toBe(4);

      const putra = (await store.get(accountKey('putra').PK, 'META')) as AccountItem;
      const sari = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
      expect(rolesOf(putra)).toEqual({ sample: { role: 'lead', teamId: 'platform' } });
      expect(rolesOf(sari)).toEqual({ sample: { role: 'requester', teamId: 'erp-basis' } });
    });
  });

  describe('audit: both writes land on the @control chain — control-plane bookkeeping, not the estate\'s own history', () => {
    it('retro-register + materialize are each one audited entry, on @control, never on the sample chain', async () => {
      const store = new MemoryStore();
      await seed(store);

      await runSettlement(store);

      const control = await exportAuditChain(store, CONTROL_SCOPE);
      expect(control.verified).toBe(true);
      expect(control.entries.some((e) => e.action === 'project-retro-register' && e.targetId === 'sample')).toBe(true);
      const materializeEntries = control.entries.filter((e) => e.action === 'account-settlement');
      expect(materializeEntries).toHaveLength(4);
      expect(materializeEntries.map((e) => e.targetId).sort()).toEqual(['budi', 'lina', 'putra', 'sari']);

      // the estate's OWN chain is untouched by settlement — it stays exactly what
      // seed() left it as (nothing — seed() writes teams/policy directly, never
      // through the audited path), proving settlement never rewrites sample's history.
      const sample = await exportAuditChain(store, 'sample');
      expect(sample.count).toBe(0);
    });
  });

  describe('idempotent: a second run is a genuine no-op', () => {
    it('running settlement twice never duplicates the ProjectItem, the materialized roles, or any audit entry', async () => {
      const store = new MemoryStore();
      await seed(store);

      const first = await runSettlement(store);
      expect(first.retroRegistered).toBe(true);
      expect(first.accountsMaterialized).toBe(4);

      const second = await runSettlement(store);
      expect(second.retroRegistered).toBe(false);
      expect(second.accountsMaterialized).toBe(0);

      const control = await exportAuditChain(store, CONTROL_SCOPE);
      expect(control.entries.filter((e) => e.action === 'project-retro-register')).toHaveLength(1);
      expect(control.entries.filter((e) => e.action === 'account-settlement')).toHaveLength(4);
    });
  });

  describe('restart-survival: the on-disk SETTLEMENT marker, not memory, is authoritative', () => {
    it('a marker written by one call is honored by a wholly independent later call on the same store (simulates a fresh process re-opening the same file)', async () => {
      const store = new MemoryStore();
      await seed(store);
      await runSettlement(store);
      const marker = settlementKey();
      const written = await store.get(marker.PK, marker.SK);
      expect(written).toBeTruthy();

      // A fresh process boot re-running settlement (e.g. server.ts's boot hook)
      // calls runSettlement directly — it does not share ANY in-memory state with
      // the process that settled it (a fresh `domain/settlement.ts` module
      // instance has an empty WeakMap); only the marker ROW makes this a no-op.
      const result = await runSettlement(store);
      expect(result.retroRegistered).toBe(false);
      expect(result.accountsMaterialized).toBe(0);

      const control = await exportAuditChain(store, CONTROL_SCOPE);
      expect(control.entries.filter((e) => e.action === 'project-retro-register')).toHaveLength(1);
    });

    it('a store with the marker but a NEWLY-added bare account (added after settlement, e.g. a hand-edited restore) is not retroactively touched — settlement is one-time, not a standing watcher', async () => {
      const store = new MemoryStore();
      await seed(store);
      await runSettlement(store);

      await store.put(await bareAccount('latecomer', { role: 'approver', teamId: 'app-platform' }));
      const result = await runSettlement(store);
      expect(result.accountsMaterialized).toBe(0); // the marker short-circuits the whole pass

      const after = (await store.get(accountKey('latecomer').PK, 'META')) as AccountItem;
      expect(after.roles).toBeUndefined(); // NOT materialized — by design (see the doc comment: a real
      // deploy never creates a bare row after settlement; every live path — enroll,
      // bootstrap — writes the canonical `roles` shape from day one).
    });
  });

  describe('security-floor integration: the 2FA requirement is correct on the very FIRST live request, not just after a warm-up', () => {
    it('a bare-shape senior account logging in through the real HTTP app requires TOTP on its first-ever request against this store', async () => {
      const store = new MemoryStore();
      await seed(store); // putra: bare legacy shape, role:'lead' — needs materialization to be seen as senior
      const app = createApp(store);

      // This IS the first request against this store — withSettlement (mounted
      // before withSession in index.ts) must materialize putra's role BEFORE the
      // login handler reads the account back, or the freshly-settled admin would
      // silently skip 2FA on the exact login that triggered its own settlement.
      const login = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'putra', password: 'wrong-but-status-check-only' }),
      });
      // (wrong password → 401, but that is fine: we only need the account THE
      // LOGIN HANDLER read to already be materialized — verify it directly.)
      expect(login.status).toBe(401);
      const stored = (await store.get(accountKey('putra').PK, 'META')) as AccountItem;
      expect(stored.roles).toEqual({ sample: { role: 'lead', teamId: 'platform' } });
      expect(needsTotp(stored)).toBe(true);
    });
  });

  describe('a store settled once by seed()+HTTP and once by a direct runSettlement call agree byte-for-byte', () => {
    it('two independently-settled stores (one via a live request, one via a direct call) reach the identical materialized shape', async () => {
      const viaHttp = new MemoryStore();
      await seed(viaHttp);
      const app = createApp(viaHttp);
      await app.request('/healthz'); // any request settles it lazily

      const viaDirect = new MemoryStore();
      await seed(viaDirect);
      await runSettlement(viaDirect);

      const a = (await viaHttp.get(accountKey('putra').PK, 'META')) as AccountItem;
      const b = (await viaDirect.get(accountKey('putra').PK, 'META')) as AccountItem;
      expect(a.roles).toEqual(b.roles);

      const pa = (await viaHttp.get(projectKey('sample').PK, 'META')) as ProjectItem;
      const pb = (await viaDirect.get(projectKey('sample').PK, 'META')) as ProjectItem;
      expect(pa.status).toBe(pb.status);
      expect(pa.id).toBe(pb.id);
    });
  });
});

/** Sanity: the footprint-detection helper's team signal really is what seed()
 * leaves behind (guards the detector against silently drifting from the
 * fixture it is meant to recognize). */
describe('settlement footprint detection stays aligned with the seed() fixture', () => {
  it('seed() writes team rows under the exact GSI the detector reads', async () => {
    const store = new MemoryStore();
    await seed(store);
    const teams = await store.queryGSI1(teamCollectionGsi('sample'));
    expect(teams.length).toBeGreaterThan(0);
    const oneKey = teamKey('sample', (teams[0] as unknown as { id: string }).id);
    expect(await store.get(oneKey.PK, oneKey.SK)).toBeTruthy();
  });
});

/**
 * O2 — the legacy estate id is operator config (`CCP_LEGACY_PROJECT_ID`), resolved
 * through src/deploy.ts's `legacyProjectId()` seam (spec §7.3). These cases pin the
 * config semantics: unset = there is no legacy estate (fresh installs settle clean),
 * a truly-bare row with nothing configured is a LOUD refusal (never a silent strand),
 * the value genuinely flows FROM config, malformed values fail closed naming the fix,
 * and an already-settled store is inert to the variable. They pass EXPLICIT env objects
 * to runSettlement/legacyProjectId (the deployConfig.test.ts style), so they are
 * independent of the global default that setup.ts assigns.
 */
describe('settlement config — the legacy estate id is CCP_LEGACY_PROJECT_ID (O2, spec §7.3)', () => {
  it('unset + a blank store: both steps no-op AND the SETTLEMENT marker is still written — a fresh public install settles clean with no config', async () => {
    const store = new MemoryStore();
    const result = await runSettlement(store, {}); // env WITHOUT CCP_LEGACY_PROJECT_ID → no legacy estate
    expect(result).toEqual({ retroRegistered: false, accountsMaterialized: 0 });
    const marker = settlementKey();
    expect(await store.get(marker.PK, marker.SK)).toBeTruthy(); // settled — the next boot is a no-op
  });

  it('unset + arm-2-only accounts (a `projects` membership list, incl. the \'*\' wildcard): materialized from the lists, never refused — the id-free arm never consults the variable', async () => {
    const store = new MemoryStore();
    await store.put(await bareAccount('multi', { role: 'approver', teamId: 'app-platform', projects: ['alpha', 'beta'] }));
    await store.put(await bareAccount('wild', { role: 'lead', teamId: 'platform', projects: ['*'] }));

    const result = await runSettlement(store, {}); // unset — must NOT refuse: no truly-bare rows here
    expect(result.accountsMaterialized).toBe(2);

    const multi = (await store.get(accountKey('multi').PK, 'META')) as AccountItem;
    expect(multi.roles).toEqual({ alpha: { role: 'approver', teamId: 'app-platform' }, beta: { role: 'approver', teamId: 'app-platform' } });
    const wild = (await store.get(accountKey('wild').PK, 'META')) as AccountItem;
    expect(wild.roles).toEqual({ '*': { role: 'lead', teamId: 'platform' } });
  });

  it('unset + a truly-bare row: SettlementConfigError naming the variable, with NO writes and NO marker — then re-run with the id configured settles exactly as configured (D3 + recoverability)', async () => {
    const store = new MemoryStore();
    await store.put(await bareAccount('stranded', { role: 'approver', teamId: 'app-platform' })); // no roles, no projects

    const err = await runSettlement(store, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementConfigError);
    expect((err as Error).message).toMatch(/CCP_LEGACY_PROJECT_ID/);
    expect((err as Error).message).toMatch(/1 account/); // names the count of stranded rows

    // fail closed: nothing was written — no roles stamped, no marker
    const stranded = (await store.get(accountKey('stranded').PK, 'META')) as AccountItem;
    expect(stranded.roles).toBeUndefined();
    const marker = settlementKey();
    expect(await store.get(marker.PK, marker.SK)).toBeNull();

    // recover: set the variable, reboot → settles exactly as configured
    const result = await runSettlement(store, { CCP_LEGACY_PROJECT_ID: 'legacy-a' });
    expect(result).toEqual({ retroRegistered: false, accountsMaterialized: 1 });
    const after = (await store.get(accountKey('stranded').PK, 'META')) as AccountItem;
    expect(after.roles).toEqual({ 'legacy-a': { role: 'approver', teamId: 'app-platform' } });
    expect(await store.get(marker.PK, marker.SK)).toBeTruthy();
  });

  it('configured to a DISTINCT id (legacy-a, deliberately ≠ the test default) with a matching footprint + bare rows: retro-registers THAT id and binds the bare rows to THAT id — the value flows from config, not a coincidental constant', async () => {
    const store = new MemoryStore();
    await seed(store, 'legacy-a'); // footprint (teams/policy) + 4 bare accounts under legacy-a

    const result = await runSettlement(store, { CCP_LEGACY_PROJECT_ID: 'legacy-a' });
    expect(result.retroRegistered).toBe(true);
    expect(result.accountsMaterialized).toBe(4);

    const project = (await store.get(projectKey('legacy-a').PK, projectKey('legacy-a').SK)) as ProjectItem;
    expect(project.status).toBe('ready');
    expect(project.id).toBe('legacy-a');

    const putra = (await store.get(accountKey('putra').PK, 'META')) as AccountItem;
    const sari = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(rolesOf(putra)).toEqual({ 'legacy-a': { role: 'lead', teamId: 'platform' } });
    expect(rolesOf(sari)).toEqual({ 'legacy-a': { role: 'requester', teamId: 'erp-basis' } });
  });

  it('malformed values (Bad_Id!, @control, a 33-char id) fail closed at resolution, naming the variable — @control can never be a legacy id (the grammar excludes it)', async () => {
    for (const bad of ['Bad_Id!', '@control', 'a'.repeat(33)]) {
      expect(() => legacyProjectId({ CCP_LEGACY_PROJECT_ID: bad })).toThrowError(/CCP_LEGACY_PROJECT_ID/);
    }
    // …and it surfaces through runSettlement on an unsettled store (resolution follows the marker check)
    const store = new MemoryStore();
    const err = await runSettlement(store, { CCP_LEGACY_PROJECT_ID: '@control' }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/CCP_LEGACY_PROJECT_ID/);
  });

  it('an already-settled store (marker present) is inert to the variable — a later unset OR malformed value is never even resolved, so boot stays a clean no-op (D4)', async () => {
    const store = new MemoryStore();
    await seed(store, 'legacy-a');
    const first = await runSettlement(store, { CCP_LEGACY_PROJECT_ID: 'legacy-a' });
    expect(first.retroRegistered).toBe(true); // settled now — marker written

    // marker present → these must NOT throw and must be no-ops, despite bad/absent env
    expect(await runSettlement(store, {})).toEqual({ retroRegistered: false, accountsMaterialized: 0 });
    expect(await runSettlement(store, { CCP_LEGACY_PROJECT_ID: 'Bad_Id!' })).toEqual({ retroRegistered: false, accountsMaterialized: 0 });
  });
});
