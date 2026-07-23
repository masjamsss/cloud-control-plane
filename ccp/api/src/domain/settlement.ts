import type { ConfigStore } from '../store/configStore';
import type { AccountItem, ProjectItem, RoleBinding } from '../store/schema';
import { accountsGsi, chainHead, projectCollectionGsi, projectKey, requestCollectionGsi, settlementKey, teamCollectionGsi } from '../store/schema';
import { ConditionError } from '../store/configStore';
import { transactWithAudit } from './audit';
import { CONTROL_SCOPE } from '../projects';
import { legacyProjectId, type Env } from '../deploy';
import { nowIso } from '../clock';

/**
 * The one-time boot SETTLEMENT (data-birth spec §9). The legacy estate id it operates
 * on is OPERATOR CONFIGURATION — `CCP_LEGACY_PROJECT_ID`, resolved via deploy.ts's
 * `legacyProjectId()` (spec O2; an extension of ADR-0021/0030, not a new ADR — D7).
 *
 * A store born before multi-project support was born under a single baked estate id:
 * that estate's data lives under its `P#<id>#` partitions (teams/requests/audit) but
 * may never have a real `ProjectItem` registry row, and account rows may still be on
 * the legacy scalar shape (`role`/`teamId`, no `roles` map) that `rolesOf`'s now-retired
 * arm 3 used to fail closed onto the baked id. Settlement makes both facts explicit and
 * durable so the store keeps working once arm 3 stops manufacturing that binding live:
 *
 *  1. RETRO-REGISTER (only with a legacy id configured): if no
 *     `ProjectItem{id:<legacyId>}` exists but a legacy footprint does (team/request
 *     rows, or an audit chain — `P(<legacyId>)…`), write one with `status:'ready'` and
 *     NO `trust` block — it never passed prescan, and that honesty is recorded, not
 *     papered over (spec §9.1).
 *  2. MATERIALIZE BARE ROWS: every account row without a `roles` map gets one stamped
 *     explicitly — exactly what the old `rolesOf` arm 2 (a `projects` list) or arm 3
 *     (bare → the legacy id) computed for it, so a settled store behaves byte-identically
 *     to the pre-settlement shim for every bound account (spec §9.2).
 *  3. CHAINS STAY PUT: both writes above audit onto the `@control` chain (this IS a
 *     control-plane action — a legacy estate's own chain is immutable history, never
 *     rewritten; `/readyz` verifies both, domain/readiness.ts).
 *
 * Legacy-id semantics (spec O2):
 *  - UNSET = this install has no legacy estate. Every fresh public install: step 1 is
 *    skipped and step 2 touches zero rows (a fresh-boot account is always written with
 *    an explicit `roles` map already — scripts/bootstrap.ts, routes/admin.ts enroll),
 *    so settlement is a clean no-op with no config.
 *  - UNSET but the store DOES hold a truly-bare account row (no `roles`, no `projects`)
 *    = a LOUD refusal ({@link SettlementConfigError}: no writes, no marker) — never a
 *    silent strand. Recoverable: set the variable to the id that store's data lives
 *    under and reboot.
 *  - INERT AFTER SETTLEMENT: an already-settled store (marker present) never consults
 *    the variable, so a later env typo can't disturb a healthy deployment (D4).
 *
 * Idempotent (a `SETTLEMENT` marker row, written last, guards re-entry) and safe to call
 * on every store, including one that never had a legacy estate.
 */

/** Thrown by {@link runSettlement} when the store holds truly-bare pre-multi-project
 *  account rows (no `roles`, no `projects`) but no legacy estate id is configured
 *  (`CCP_LEGACY_PROJECT_ID` unset) — there is nothing to bind them onto. Fail
 *  closed: settlement writes NOTHING and never stamps the marker, so the next boot
 *  re-attempts and settles correctly once the operator sets the variable. */
export class SettlementConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementConfigError';
  }
}

/**
 * In-memory "already confirmed settled" cache — keyed by STORE INSTANCE (a
 * `WeakMap`, not a single module-global flag). A real deploy has exactly one store
 * per process, so this is equivalent to `projects.ts`'s `hydrated` boolean in
 * production; the per-instance keying matters for tests, which construct many
 * independent `MemoryStore`s within one process (often one per `it()`), each
 * needing its OWN settlement pass — a single global flag would silently skip every
 * store after the first. A `WeakMap` also needs no test-reset hook: a fresh store
 * object was never a key, so it is always correctly "unsettled" from this cache's
 * point of view (the store's own on-disk `SETTLEMENT` marker, checked inside
 * {@link runSettlement}, remains the durable, restart-surviving source of truth).
 */
const confirmedSettled = new WeakMap<ConfigStore, true>();

/** The legacy per-account effective roles for a row without `roles` — exactly what
 * `rolesOf`'s retired arm 2/3 computed BEFORE this lane (arm 2: expand the `projects`
 * membership list; arm 3: bind onto the configured legacy estate id). Used only here,
 * to materialize the explicit map settlement stamps onto the row — the "shim and
 * settlement are proven equivalent" contract (settlement.test.ts). `legacyId` is read
 * ONLY by the arm-3 (truly-bare) branch; arm-2 rows never consult it. A truly-bare row
 * with `legacyId === null` is unreachable — {@link materializeBareAccountRows} pre-scans
 * and refuses before any row is materialized — but is guarded here too, fail closed. */
function legacyRoles(
  account: Pick<AccountItem, 'role' | 'teamId' | 'projects'>,
  legacyId: string | null,
): Record<string, RoleBinding> {
  const role = account.role ?? 'requester';
  const binding: RoleBinding = { role, ...(account.teamId !== undefined ? { teamId: account.teamId } : {}) };
  if (account.projects && account.projects.length > 0) {
    const out: Record<string, RoleBinding> = {};
    for (const p of account.projects) out[p] = binding;
    return out;
  }
  if (legacyId === null) {
    throw new SettlementConfigError(
      'internal: a truly-bare account row reached materialization with no legacy id configured (should have been refused by the pre-scan)',
    );
  }
  return { [legacyId]: binding };
}

/** Does this store carry a legacy footprint (team, request, or audit-chain activity
 * under the configured legacy estate id's partitions) that a real deployment would
 * have left, distinct from a freshly-founded store that simply has no such data? */
async function hasLegacyFootprint(store: ConfigStore, legacyId: string): Promise<boolean> {
  const teams = await store.queryGSI1(teamCollectionGsi(legacyId));
  if (teams.length > 0) return true;
  const requests = await store.queryGSI1(requestCollectionGsi(legacyId));
  if (requests.length > 0) return true;
  const hKey = chainHead(legacyId);
  return (await store.get(hKey.PK, hKey.SK)) !== null;
}

/** Retro-register the configured legacy estate id (step 1) iff it looks like a real
 * legacy deployment and no registry row exists yet for it. Returns true if a row was
 * written. Called only when a legacy id is configured (`legacyId !== null`). */
async function retroRegisterLegacyProject(store: ConfigStore, legacyId: string): Promise<boolean> {
  const pKey = projectKey(legacyId);
  if (await store.get(pKey.PK, pKey.SK)) return false; // already registered — nothing to do
  if (!(await hasLegacyFootprint(store, legacyId))) return false; // a genuinely blank store — no legacy estate to adopt

  const item: ProjectItem = {
    ...pKey,
    id: legacyId,
    name: legacyId,
    status: 'ready',
    createdBy: 'migration',
    createdAt: nowIso(),
    version: 1,
    GSI1PK: projectCollectionGsi(),
    GSI1SK: legacyId,
    // Deliberately NO `trust` block — this estate never passed prescan trust; that
    // honesty is recorded (spec §9.1), not backfilled with a trust it never earned.
  };
  await transactWithAudit(store, CONTROL_SCOPE, [{ kind: 'put', item: item as never, ifNotExists: true }], {
    action: 'project-retro-register',
    actor: 'migration',
    targetType: 'project',
    targetId: legacyId,
    after: { id: legacyId, status: 'ready' },
  });
  return true;
}

/** Materialize every bare account row (step 2): stamp the explicit `roles` map the
 * retired shim arms used to compute on the fly. Returns the count of rows touched.
 * When no legacy id is configured (`legacyId === null`) a PRE-SCAN runs first: a
 * truly-bare row (no `roles`, no `projects`) has nothing to bind to, so settlement
 * REFUSES up front with a {@link SettlementConfigError} — before writing a single
 * row, so a refused settlement leaves zero partial state (the marker is written last
 * by the caller, only on success). Arm-2 rows (a non-empty `projects` list) never
 * need the legacy id and settle normally whether or not it is configured. */
async function materializeBareAccountRows(store: ConfigStore, legacyId: string | null): Promise<number> {
  const accounts = (await store.queryGSI1(accountsGsi())) as AccountItem[];

  if (legacyId === null) {
    const stranded = accounts.filter((a) => !a.roles && !(a.projects && a.projects.length > 0));
    if (stranded.length > 0) {
      throw new SettlementConfigError(
        `settlement refused: ${stranded.length} account row(s) predate multi-project support (no roles, no projects) and CCP_LEGACY_PROJECT_ID is unset — there is no project to bind them to. Set CCP_LEGACY_PROJECT_ID to the id this store's pre-multi-project data lives under and reboot; a fresh install should leave it unset.`,
      );
    }
  }

  let touched = 0;
  for (const account of accounts) {
    if (account.roles) continue; // already canonical — nothing to materialize
    const roles = legacyRoles(account, legacyId);
    await transactWithAudit(
      store,
      CONTROL_SCOPE,
      [{ kind: 'update', pk: account.PK, sk: account.SK, set: { roles }, ifEquals: { attr: 'roles', value: account.roles } }],
      { action: 'account-settlement', actor: 'migration', targetType: 'account', targetId: account.id, after: { roles } },
    );
    touched++;
  }
  return touched;
}

/** Run the settlement now on THIS store (idempotent via its on-disk `SETTLEMENT`
 * marker, written last so a crash mid-settlement re-attempts on the next boot
 * rather than falsely marking completion) — always re-checks the marker, so this
 * is safe/correct to call directly and repeatedly (settlement.test.ts's oracle;
 * restart-survival proofs). Ordinary request-path callers should use
 * {@link ensureSettlement}, which adds the cheap per-instance cache. */
export async function runSettlement(store: ConfigStore, env: Env = process.env): Promise<{ retroRegistered: boolean; accountsMaterialized: number }> {
  const marker = settlementKey();
  if (await store.get(marker.PK, marker.SK)) {
    confirmedSettled.set(store, true);
    return { retroRegistered: false, accountsMaterialized: 0 };
  }

  // Resolved once per pass, AFTER the marker short-circuit above: an already-settled
  // store boots identically whatever the variable says (D4) — immune to a later env
  // typo. A malformed value throws here (fail closed, no marker); an unset value is
  // `null` (no legacy estate), which makes both steps no-ops on a fresh store.
  const legacyId = legacyProjectId(env);

  let retroRegistered = false;
  let accountsMaterialized = 0;
  try {
    if (legacyId !== null) retroRegistered = await retroRegisterLegacyProject(store, legacyId);
    accountsMaterialized = await materializeBareAccountRows(store, legacyId);
    await store.put({ ...marker, settledAt: nowIso(), settledBy: 'migration' }, { ifNotExists: true });
  } catch (e) {
    // A ConditionError here means a CONCURRENT caller raced this exact settlement
    // (two requests both saw "no marker" and both started) — not a real failure.
    // Fail open: trust the other caller finished (or will), and don't retry-storm
    // every subsequent request against this store. A genuinely half-settled store
    // (process crash mid-way) is caught on the NEXT process boot, which re-checks
    // the marker (absent) and re-attempts from scratch — retro-register/materialize
    // are both `ifNotExists`/no-op-if-canonical, so a re-attempt is harmless.
    if (!(e instanceof ConditionError)) throw e;
  }
  confirmedSettled.set(store, true);
  return { retroRegistered, accountsMaterialized };
}

/** Lazy trigger (mirrors `projects.ts`'s `needsProjectHydration`/`hydrateKnownProjects`
 * pair): cheap after the first call against THIS store, safe to call on every
 * request. Called from `middleware/session.ts#withProject`, before
 * `hydrateKnownProjects` — so a freshly-retro-registered legacy-project row is visible
 * to the SAME hydration pass. */
export async function ensureSettlement(store: ConfigStore): Promise<void> {
  if (confirmedSettled.has(store)) return;
  await runSettlement(store);
}
