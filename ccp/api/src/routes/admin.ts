import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../appEnv';
import type { AccountItem, ApplySpec, PendingConfigChangeItem, RiskOverrideItem, RoleBinding, RoleName, SettingItem, TeamItem } from '../store/schema';
import { accountKey, accountsGsi, nextAccountVersion, pendingConfigGsi, policyKey, riskOverrideKey, settingKey, teamCollectionGsi, teamKey } from '../store/schema';
import type { TransactWrite } from '../store/configStore';
import { apiError, ApiError } from '../errors';
import { requireSession } from '../middleware/session';
import { requireAdmin, requireProjectMembership } from '../middleware/authz';
import { ALL_PROJECTS, CONTROL_SCOPE, isSeniorAnywhere, isValidProjectBinding, projectsOf, roleFor, rolesOf, teamFor } from '../projects';
import { hashPassword, MIN_PASSWORD } from '../auth/credentials';
import { killAllSessions } from '../auth/sessions';
import { publicAccount } from '../auth/account';
import { totpDevicesOf } from '../auth/totp';
import { getManifests, getOperation } from '../manifests';
import { disabledOps, loadAccounts, loadPolicy, loadSetting } from '../domain/config';
import { classify, commitOrPropose, ackPending, rejectPending, publicPendingChange, type Classification } from '../domain/dualControl';
import { afterProjectConfigApply } from '../domain/projectsLifecycle';
import { transactWithAudit } from '../domain/audit';
import { exportAuditChain, readAuditChronological, toAuditEntry } from '../domain/auditQuery';
import { nowIso } from '../clock';

const TeamCreateBody = z.object({ name: z.string(), serviceSlugs: z.array(z.string()).optional() });
const TeamRenameBody = z.object({ name: z.string() });
const TeamServicesBody = z.object({ serviceSlugs: z.array(z.string()) });

/** app teams.ts parity: lowercase, non-alnum → '-', trimmed. */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const PolicyBody = z.object({
  low: z.number().int(),
  medium: z.number().int(),
  high: z.number().int(),
  deleteMin: z.number().int(),
});
const RiskBody = z.object({ risk: z.enum(['LOW', 'MEDIUM', 'HIGH']) });
const CatalogBody = z.object({ enabled: z.boolean() });
const RoleEnum = z.enum(['requester', 'approver', 'lead']);

const EnrollBody = z.object({
  username: z.string().regex(/^[a-z0-9._-]{2,32}$/),
  displayName: z.string().min(1),
  /** The FIRST project binding: role (+ optional team) on `projectId`. */
  role: RoleEnum,
  teamId: z.string().min(1),
  password: z.string().min(MIN_PASSWORD),
  /** The project to bind into; omitted → the enrolling (acting) project. `'*'` is
   * refused (the all-projects wildcard is bootstrap/migration-only). */
  projectId: z.string().min(1).optional(),
});

/* ── PATCH is PER-PROJECT VERBS, never a whole-map replacement (mass-assignment). ──
 * A `{roles:{…}}` or legacy `{role,projects,teamId}` body is stripped to nothing by these
 * schemas and rejected by the `.refine` (at least one field). Each verb targets ONE
 * registered project id (`'*'` refused in the handler). `status`/`isAdmin`/`totpRequired`
 * are GLOBAL account fields and stay. Verb sub-objects are `.strict()` so a smuggled key
 * inside a verb is a 422, not a silent write. */
const SetRoleVerb = z.object({ projectId: z.string().min(1), role: RoleEnum, teamId: z.string().min(1).optional() }).strict();
const SetTeamVerb = z.object({ projectId: z.string().min(1), teamId: z.string().min(1) }).strict();
const RevokeVerb = z.object({ projectId: z.string().min(1) }).strict();
const PatchBody = z
  .object({
    /** Grant/raise/lower a role on ONE project. Raising to approver/lead = loosening (dual-control). */
    setRole: SetRoleVerb.optional(),
    /** Change the team on ONE project (immediate — team is not a privilege dimension). */
    setTeam: SetTeamVerb.optional(),
    /** Revoke membership on ONE project (immediate; blocked by the per-project last-lead guard). */
    revoke: RevokeVerb.optional(),
    status: z.enum(['active', 'disabled']).optional(),
    isAdmin: z.boolean().optional(),
    /** Admin-controlled 2FA requirement. Full control, no server
     * role floor: an admin may pin it true OR false for ANY account. Applied
     * immediately + audited; the privileged-downgrade warning is a UI safety net. */
    totpRequired: z.boolean().optional(),
    /** Rename (a NON-authorization field): immediate + audited. Must arrive
     * ALONE — never bundled with a verb or a global authorization field — so
     * the one-change-per-request discipline (and its single-purpose audit
     * entry) holds; the handler refuses any mix with 422. */
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field' });

/** Capacity rank for the per-project classification: raising rank (e.g. requester→approver,
 * approver→lead, or a NEW senior member) is loosening; lateral/downgrade is tightening. */
const roleRank = (r: RoleName | undefined): number => (r === 'lead' ? 2 : r === 'approver' ? 1 : 0);
const ResetBody = z.object({ newPassword: z.string().min(MIN_PASSWORD) });

function inRange(p: z.infer<typeof PolicyBody>): boolean {
  return [p.low, p.medium, p.high, p.deleteMin].every((n) => n >= 1 && n <= 5);
}

function settingApply(projectId: string, key: string, value: unknown, version: number, actor: string, now: string): ApplySpec {
  const k = settingKey(projectId, key);
  if (version === 0) {
    const item: SettingItem = { ...k, key, value, version: 1, updatedBy: actor, updatedAt: now };
    return { op: 'put', pk: k.PK, sk: k.SK, item: item as unknown as Record<string, unknown>, ifNotExists: true };
  }
  return { op: 'update', pk: k.PK, sk: k.SK, set: { value, version: version + 1, updatedBy: actor, updatedAt: now }, guardAttr: 'version', guardValue: version };
}

async function settingVersion(store: AppEnv['Variables']['store'], projectId: string, key: string): Promise<number> {
  const k = settingKey(projectId, key);
  const item = (await store.get(k.PK, k.SK)) as SettingItem | null;
  return item?.version ?? 0;
}

export function adminRoutes(opts: { projectDataRoot?: string } = {}): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  // Admin capability alone is NOT cross-project: an admin acts within the projects
  // their account is bound to (`['*']` for an all-projects admin).
  a.use('*', requireSession, requireAdmin, requireProjectMembership);

  /* ── policy ─────────────────────────────────────────────────────────────── */
  a.get('/policy', async (c) => {
    const { policy, version } = await loadPolicy(c.get('store'), c.get('projectId'));
    return c.json({ ...policy, version });
  });

  a.put('/policy', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const parsed = PolicyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    if (!inRange(parsed.data)) return apiError(c, 'POLICY_OUT_OF_RANGE');

    const { policy: before, version } = await loadPolicy(store, projectId);
    const after = parsed.data;
    const classification = classify({ target: 'policy', before, after });
    const now = nowIso();
    const pk = policyKey(projectId);
    const apply: ApplySpec =
      version === 0
        ? { op: 'put', pk: pk.PK, sk: pk.SK, item: { ...pk, ...after, version: 1, changedBy: actor, changedAt: now }, ifNotExists: true }
        : { op: 'update', pk: pk.PK, sk: pk.SK, set: { ...after, version: version + 1, changedBy: actor, changedAt: now }, guardAttr: 'version', guardValue: version };

    const res = await commitOrPropose(store, projectId, actor, {
      classification,
      kind: 'policy-downgrade',
      targetKey: 'POLICY',
      before,
      after,
      apply,
      audit: { action: 'policy-change', actor, targetType: 'policy', targetId: 'POLICY', before, after },
    });
    if (res.status === 200) return c.json({ ...after, version: version + 1 });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── settings (freeze, disabled-ops, allowlist, rate) ───────────────────── */
  a.get('/settings', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const keys = ['freeze.global', 'catalog.disabled-ops', 'rate.limits', 'allowlist.restrictions'];
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = await loadSetting(store, projectId, key);
    return c.json(out);
  });

  a.put('/settings/:key', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const key = c.req.param('key');
    const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
    if (!body || body.value === undefined) return apiError(c, 'VALIDATION_FAILED');
    const value = body.value;

    const before = await loadSetting(store, projectId, key);
    let classification: 'tightening' | 'loosening';
    if (key === 'freeze.global') classification = classify({ target: 'freeze', before: before === true, after: value === true });
    else if (key === 'catalog.disabled-ops') {
      const b = (before as string[] | undefined) ?? [];
      const after = value as string[];
      const removed = b.some((x) => !after.includes(x)); // re-enabling an op
      classification = removed ? 'loosening' : 'tightening';
    } else if (key.startsWith('allowlist')) {
      classification = classify({ target: 'allowlist', before: (before as string[] | undefined) ?? [], after: value as string[] });
    } else classification = 'tightening'; // rate.limits etc.

    const version = await settingVersion(store, projectId, key);
    const apply = settingApply(projectId, key, value, version, actor, nowIso());
    const res = await commitOrPropose(store, projectId, actor, {
      classification,
      kind: `setting:${key}`,
      targetKey: `SETTING#${key}`,
      before,
      after: value,
      apply,
      audit: { action: 'setting-change', actor, targetType: 'setting', targetId: key, before, after: value },
    });
    if (res.status === 200) return c.json({ ok: true, key, value });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── risk overrides ─────────────────────────────────────────────────────── */
  // GET /admin/risk — OpenAPI declared it ("All overrides, riskOverrides.ts map
  // shape"); it was unrouted → 404, the same class of gap as the teams CRUD
  // below. Without it the SPA's risk admin is write-only: it can PUT/DELETE an
  // override but can never render the server's persisted truth after a reload.
  // Applied overrides only — a pending (dual-controlled) reduction is not an
  // override yet, exactly like GET /admin/policy above.
  a.get('/risk', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    // Estate-only surface (data-birth spec §5): a catalog/risk read is meaningless
    // on the reserved `@control` scope — it has no per-project risk overrides
    // (indeed no data plane at all). Refuse explicitly rather than silently
    // returning an empty map for a "project" that isn't one.
    if (projectId === CONTROL_SCOPE) return apiError(c, 'CONTROL_SCOPE');
    const out: Record<string, RiskOverrideItem['risk']> = {};
    for (const m of getManifests()) {
      for (const op of m.operations) {
        const k = riskOverrideKey(projectId, op.id);
        const item = (await store.get(k.PK, k.SK)) as RiskOverrideItem | null;
        if (item) out[op.id] = item.risk;
      }
    }
    return c.json(out);
  });

  a.put('/risk/:opId', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const opId = c.req.param('opId');
    const parsed = RiskBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const op = getOperation(opId, getManifests());
    if (!op) return apiError(c, 'VALIDATION_FAILED');

    const k = riskOverrideKey(projectId, opId);
    const existing = (await store.get(k.PK, k.SK)) as RiskOverrideItem | null;
    const beforeRisk = existing?.risk ?? op.riskFloor;
    const afterRisk = parsed.data.risk;
    const classification = classify({ target: 'risk', before: beforeRisk, after: afterRisk });
    const version = existing?.version ?? 0;
    const item: RiskOverrideItem = { ...k, risk: afterRisk, version: version + 1, setBy: actor, setAt: nowIso() };
    const apply: ApplySpec =
      version === 0
        ? { op: 'put', pk: k.PK, sk: k.SK, item: item as unknown as Record<string, unknown>, ifNotExists: true }
        : { op: 'update', pk: k.PK, sk: k.SK, set: { risk: afterRisk, version: version + 1, setBy: actor, setAt: nowIso() }, guardAttr: 'version', guardValue: version };

    const res = await commitOrPropose(store, projectId, actor, {
      classification,
      kind: 'risk-reduction',
      targetKey: `RISKOVR#${opId}`,
      before: beforeRisk,
      after: afterRisk,
      apply,
      audit: { action: 'risk-override', actor, targetType: 'risk-override', targetId: opId, before: beforeRisk, after: afterRisk },
    });
    if (res.status === 200) return c.json({ ok: true, opId, risk: afterRisk });
    return c.json(publicPendingChange(res.pending), 202);
  });

  a.delete('/risk/:opId', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const opId = c.req.param('opId');
    const op = getOperation(opId, getManifests());
    if (!op) return apiError(c, 'VALIDATION_FAILED');
    const k = riskOverrideKey(projectId, opId);
    const existing = (await store.get(k.PK, k.SK)) as RiskOverrideItem | null;
    if (!existing) return c.json({ ok: true, opId, risk: op.riskFloor });
    // Clearing to the manifest floor: loosening if the floor is lower than the override.
    const classification = classify({ target: 'risk', before: existing.risk, after: op.riskFloor });
    const apply: ApplySpec = { op: 'delete', pk: k.PK, sk: k.SK, guardAttr: 'version', guardValue: existing.version };
    const res = await commitOrPropose(store, projectId, actor, {
      classification,
      kind: 'risk-reduction',
      targetKey: `RISKOVR#${opId}`,
      before: existing.risk,
      after: op.riskFloor,
      apply,
      audit: { action: 'risk-override-clear', actor, targetType: 'risk-override', targetId: opId, before: existing.risk, after: op.riskFloor },
    });
    if (res.status === 200) return c.json({ ok: true, opId, risk: op.riskFloor });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── catalog enable/disable (via the disabled-ops setting) ──────────────── */
  a.put('/catalog/:opId', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const opId = c.req.param('opId');
    const parsed = CatalogBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    if (!getOperation(opId, getManifests())) return apiError(c, 'VALIDATION_FAILED');

    const before = await disabledOps(store, projectId);
    const wasDisabled = before.includes(opId);
    const after = parsed.data.enabled ? before.filter((x) => x !== opId) : [...new Set([...before, opId])];
    const classification = classify({ target: 'catalog', enabledBefore: !wasDisabled, enabledAfter: parsed.data.enabled });
    const version = await settingVersion(store, projectId, 'catalog.disabled-ops');
    const apply = settingApply(projectId, 'catalog.disabled-ops', after, version, actor, nowIso());
    const res = await commitOrPropose(store, projectId, actor, {
      classification,
      kind: 'catalog-enable',
      targetKey: 'SETTING#catalog.disabled-ops',
      before,
      after,
      apply,
      audit: { action: 'catalog-toggle', actor, targetType: 'catalog', targetId: opId, before: { enabled: !wasDisabled }, after: { enabled: parsed.data.enabled } },
    });
    if (res.status === 200) return c.json({ ok: true, opId, enabled: parsed.data.enabled });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── accounts ───────────────────────────────────────────────────────────── */
  a.get('/accounts', async (c) => {
    const projectId = c.get('projectId');
    const accounts = await loadAccounts(c.get('store'));
    return c.json(accounts.map((acc) => publicAccount(acc, projectId)));
  });

  a.post('/accounts', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const parsed = EnrollBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const username = parsed.data.username.toLowerCase();
    const k = accountKey(username);
    if (await store.get(k.PK, k.SK)) return apiError(c, 'DUPLICATE_USERNAME');

    // First-project binding: default = the project this admin is enrolling from. `'*'` is
    // refused (bootstrap/migration-only); any other id must be a registered project.
    const bindProject = parsed.data.projectId ?? projectId;
    if (bindProject === ALL_PROJECTS) return apiError(c, 'VALIDATION_FAILED', { field: 'projectId' });
    if (!isValidProjectBinding(bindProject)) return apiError(c, 'VALIDATION_FAILED', { field: 'projectId' });

    const roles: Record<string, RoleBinding> = { [bindProject]: { role: parsed.data.role, teamId: parsed.data.teamId } };
    const item: AccountItem = {
      ...k,
      id: username,
      username,
      displayName: parsed.data.displayName,
      roles, // the new canonical shape — no legacy role/teamId/projects on fresh rows
      status: 'active',
      createdAt: nowIso(),
      createdBy: actor,
      mustChangePassword: true,
      isAdmin: false,
      credential: { algo: 'argon2id', hash: await hashPassword(parsed.data.password) },
      failedAttempts: 0,
      sessionVersion: 1,
      accountVersion: 1, // the dual-control drift counter starts life on every fresh row
      GSI1PK: accountsGsi(),
      GSI1SK: username,
    };
    // Enrolling straight into a project OTHER than the enrolling one is a cross-tenant
    // grant → dual-control; otherwise classify by the granted role (senior → dual-control).
    const classification: Classification =
      bindProject !== projectId ? 'loosening' : classify({ target: 'enroll', role: parsed.data.role, isAdmin: false });
    const apply: ApplySpec = { op: 'put', pk: k.PK, sk: k.SK, item: item as unknown as Record<string, unknown>, ifNotExists: true };
    const res = await commitOrPropose(store, projectId, actor, {
      classification,
      kind: 'role-grant-senior',
      targetKey: `ACCOUNT#${username}`,
      before: null,
      // `after` carries a top-level `role` (the granted role) so dualControl's
      // grantsApprovalCapacity can read the senior-grant transition unchanged.
      after: { ...publicAccount(item, bindProject), projectId: bindProject },
      apply,
      audit: { action: 'account-enroll', actor, targetType: 'account', targetId: username, after: { ...publicAccount(item, bindProject), projectId: bindProject } },
    });
    if (res.status === 200) return c.json(publicAccount(item, projectId), 201);
    return c.json(publicPendingChange(res.pending), 202);
  });

  a.patch('/accounts/:id', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const parsed = PatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const body = parsed.data;
    const k = accountKey(id);
    const acc = (await store.get(k.PK, k.SK)) as AccountItem | null;
    if (!acc) return c.json({ code: 'NOT_FOUND', reason: 'No such account.' }, 404);

    // Rename is its own, WHOLE request (one-change-per-request): a displayName
    // may never ride with an authorization verb or a global authorization field.
    // It is not an authorization change, so it applies immediately — one audited
    // transaction — and never routes through the dual-control envelope.
    if (body.displayName !== undefined) {
      if (Object.keys(body).length > 1) return apiError(c, 'VALIDATION_FAILED', { field: 'displayName' });
      const before = acc.displayName;
      await transactWithAudit(store, projectId, [
        { kind: 'update', pk: k.PK, sk: k.SK, set: { displayName: body.displayName, accountVersion: nextAccountVersion(acc) } },
      ], {
        action: 'account-rename', actor, targetType: 'account', targetId: id,
        before: { displayName: before }, after: { displayName: body.displayName },
      });
      return c.json({ ok: true });
    }

    // At most ONE authorization verb per request — setRole/setTeam/revoke on one account
    // in one call is ambiguous (which wins?). Global fields (status/isAdmin/totpRequired)
    // may accompany a single verb.
    const verbCount = [body.setRole, body.setTeam, body.revoke].filter((v) => v !== undefined).length;
    if (verbCount > 1) return apiError(c, 'VALIDATION_FAILED', { field: 'setRole/setTeam/revoke' });

    // Every verb targets ONE registered project id; `'*'` is refused (bootstrap/migration-only).
    const verbProject = body.setRole?.projectId ?? body.setTeam?.projectId ?? body.revoke?.projectId;
    if (verbProject !== undefined) {
      if (verbProject === ALL_PROJECTS) return apiError(c, 'VALIDATION_FAILED', { field: 'projectId' });
      if (!isValidProjectBinding(verbProject)) return apiError(c, 'VALIDATION_FAILED', { field: 'projectId' });
    }

    const accounts = await loadAccounts(store);
    const current = rolesOf(acc); // the canonical current per-project map

    // ── build the NEXT roles map from the (single) verb ──────────────────────────────
    const nextRoles: Record<string, RoleBinding> = { ...current };
    let roleBefore: RoleName | undefined;
    let roleAfter: RoleName | undefined;
    let verbClassification: Classification | undefined;
    if (body.setRole) {
      const p = body.setRole.projectId;
      roleBefore = current[p]?.role; // undefined ⇒ granting a NEW membership
      roleAfter = body.setRole.role;
      const teamId = body.setRole.teamId ?? current[p]?.teamId;
      nextRoles[p] = { role: roleAfter, ...(teamId !== undefined ? { teamId } : {}) };
      // Raising capacity on a project (incl. a new senior member) = loosening; a
      // lateral change or downgrade = tightening (applies immediately).
      verbClassification = roleRank(roleAfter) > roleRank(roleBefore) ? 'loosening' : 'tightening';
    } else if (body.setTeam) {
      const p = body.setTeam.projectId;
      if (!current[p]) return apiError(c, 'VALIDATION_FAILED', { field: 'projectId' }); // no role to re-team
      nextRoles[p] = { role: current[p].role, teamId: body.setTeam.teamId };
      // team-only change is NOT a capacity change (no sessionVersion bump) and is tightening.
    } else if (body.revoke) {
      const p = body.revoke.projectId;
      if (!current[p]) return apiError(c, 'VALIDATION_FAILED', { field: 'projectId' }); // not a member
      delete nextRoles[p];
    }

    // ── guards ───────────────────────────────────────────────────────────────────────
    // Last-active-admin (GLOBAL — isAdmin is a deployment capability, not per project).
    const activeAdmins = accounts.filter((x) => x.isAdmin && x.status === 'active' && x.id !== id).length;
    const losesAdmin = acc.isAdmin && (body.isAdmin === false || body.status === 'disabled');
    if (losesAdmin && acc.status === 'active' && activeAdmins === 0) return apiError(c, 'LAST_LEAD_GUARD');

    // Last-active-lead, PER PROJECT: revoking/downgrading (or globally disabling) the last
    // active lead OF A PROJECT is refused even if OTHER projects still have leads. A '*'
    // (all-projects) lead counts as a lead on every project, so it keeps coverage.
    const otherActiveLeadsOn = (p: string): number =>
      accounts.filter((x) => x.id !== id && x.status === 'active' && roleFor(x, p) === 'lead').length;
    const projectsLosingLead = new Set<string>();
    if (acc.status === 'active' && body.status === 'disabled') {
      for (const [p, b] of Object.entries(current)) if (b.role === 'lead') projectsLosingLead.add(p);
    }
    if (body.setRole && current[body.setRole.projectId]?.role === 'lead' && body.setRole.role !== 'lead') {
      projectsLosingLead.add(body.setRole.projectId);
    }
    if (body.revoke && current[body.revoke.projectId]?.role === 'lead') projectsLosingLead.add(body.revoke.projectId);
    for (const p of projectsLosingLead) {
      if (otherActiveLeadsOn(p) === 0) return apiError(c, 'LAST_LEAD_GUARD');
    }

    // ── classification (loosening if ANY sub-change loosens) ──────────────────────────
    const classifications: Classification[] = [];
    if (verbClassification) classifications.push(verbClassification);
    if (body.isAdmin !== undefined && body.isAdmin !== acc.isAdmin) classifications.push(classify({ target: 'admin', before: acc.isAdmin, after: body.isAdmin }));
    if (body.status && body.status !== acc.status) classifications.push(classify({ target: 'account-status', before: acc.status, after: body.status }));
    // setTeam / revoke / totpRequired-only default to tightening (immediate).
    const classification: Classification = classifications.some((x) => x === 'loosening') ? 'loosening' : 'tightening';

    // sessionVersion bump (F3/G3): a live session re-reads the account on EVERY request, so
    // a per-project grant/revoke to an already-privileged account takes effect immediately
    // WITHOUT a bump. The bump exists for ONE reason — to force a session that never proved a
    // second factor to re-authenticate through the TOTP gate. So bump ONLY when the account
    // NEWLY gains senior capacity (was senior nowhere → is now, the exact F3 exploit shape)
    // or on an isAdmin change. A grant to an already-senior account, a demotion, a revoke, a
    // team move, and a status/totp change never create that TOTP gap.
    const verbPresent = body.setRole !== undefined || body.setTeam !== undefined || body.revoke !== undefined;
    const isAdminChanged = body.isAdmin !== undefined && body.isAdmin !== acc.isAdmin;
    const gainsSeniorCapacity = !isSeniorAnywhere(acc) && isSeniorAnywhere({ roles: nextRoles });
    const sessionBump = gainsSeniorCapacity || isAdminChanged;

    const set: Record<string, unknown> = {};
    if (verbPresent) {
      // Write the canonical `roles` map and materialize away the legacy trio (this IS the
      // one-time per-row migration: the first admin write rewrites the account to the new shape).
      set.roles = nextRoles;
      set.role = undefined;
      set.teamId = undefined;
      set.projects = undefined;
    }
    if (body.status) set.status = body.status;
    if (body.isAdmin !== undefined) set.isAdmin = body.isAdmin;
    // The 2FA requirement is NOT a classify input — a totpRequired-only change stays
    // 'tightening' → one immediate audited mutation (no second-admin gate, in either
    // direction). It rides along untouched when a verb/isAdmin change routes to dual-control.
    if (body.totpRequired !== undefined) set.totpRequired = body.totpRequired;
    if (sessionBump) set.sessionVersion = acc.sessionVersion + 1;
    // Drift guard: EVERY apply from this handler replays propose-time state at ack
    // (`set.roles` is the WHOLE next map), so EVERY apply bumps `accountVersion` and
    // guards on its pre-change value. If ANY other account mutation (a revoke, a reset,
    // a rename, a self password-change) lands between propose and ack, the stale ack is
    // rejected 409 STALE_PROPOSAL instead of replaying the old snapshot over it — the
    // exact hole that let an acked grant to an ALREADY-senior account (no sessionBump →
    // previously unguarded) silently resurrect a concurrently-revoked binding. The old
    // sessionVersion guard covered only sessionBump applies and only sessionVersion
    // drift; every sessionVersion writer also bumps accountVersion (see auth.ts
    // change-password), so this guard strictly subsumes it. sessionVersion itself keeps
    // its narrow TOTP-gate bump semantics above — benign changes still never bump it.
    set.accountVersion = nextAccountVersion(acc);
    const apply: ApplySpec = { op: 'update', pk: k.PK, sk: k.SK, set, guardAttr: 'accountVersion', guardValue: acc.accountVersion };

    // Audit + propose `before`/`after` carry the per-project {projectId, role} delta so a
    // reviewer sees exactly which project's authorization changed; the top-level `role`
    // (present only for setRole) lets dualControl's grantsApprovalCapacity read the
    // senior-grant transition unchanged.
    const beforeAudit: Record<string, unknown> = { status: acc.status, isAdmin: acc.isAdmin, totpRequired: acc.totpRequired };
    const afterAudit: Record<string, unknown> = {};
    if (body.setRole) {
      beforeAudit.projectId = body.setRole.projectId;
      beforeAudit.role = roleBefore ?? null;
      afterAudit.projectId = body.setRole.projectId;
      afterAudit.role = roleAfter;
      afterAudit.roles = nextRoles;
    } else if (body.setTeam) {
      afterAudit.projectId = body.setTeam.projectId;
      afterAudit.teamId = body.setTeam.teamId;
      afterAudit.roles = nextRoles;
    } else if (body.revoke) {
      beforeAudit.projectId = body.revoke.projectId;
      beforeAudit.role = current[body.revoke.projectId]?.role ?? null;
      afterAudit.projectId = body.revoke.projectId;
      afterAudit.revoked = true;
      afterAudit.roles = nextRoles;
    }
    if (body.status) afterAudit.status = body.status;
    if (body.isAdmin !== undefined) afterAudit.isAdmin = body.isAdmin;
    if (body.totpRequired !== undefined) afterAudit.totpRequired = body.totpRequired;

    const res = await commitOrPropose(store, projectId, actor, {
      classification,
      kind: 'admin-grant',
      targetKey: `ACCOUNT#${id}`,
      before: { ...beforeAudit, projects: projectsOf(acc) },
      after: afterAudit,
      apply,
      audit: { action: 'account-update', actor, targetType: 'account', targetId: id, before: beforeAudit, after: afterAudit },
    });
    if (res.status === 200) return c.json({ ok: true });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── account delete (PERMANENT — Disable stays the reversible option) ─────── */
  // Removing access is a tightening change, so it applies immediately (one
  // audited transaction) — but FAIL-CLOSED guards refuse anything that could
  // strand the estate: deleting yourself, the last active admin, or the last
  // active lead of ANY project (the same per-project coverage rule the PATCH
  // revoke/disable verbs enforce above). Live sessions are killed on delete.
  a.delete('/accounts/:id', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const k = accountKey(id);
    const acc = (await store.get(k.PK, k.SK)) as AccountItem | null;
    if (!acc) return c.json({ code: 'NOT_FOUND', reason: 'No such account.' }, 404);

    // Guard 1: never yourself — the acting admin cannot remove their own account.
    if (id === actor) return apiError(c, 'SELF_DELETE');

    const accounts = await loadAccounts(store);
    // Guard 2: never the last active admin. (Belt-and-braces: the actor is a
    // DISTINCT active admin — guard 1 — so today this cannot fire; it stays so
    // the invariant survives any future change to the self-delete rule.)
    const otherActiveAdmins = accounts.filter((x) => x.isAdmin && x.status === 'active' && x.id !== id).length;
    if (acc.isAdmin && otherActiveAdmins === 0) return apiError(c, 'LAST_LEAD_GUARD');

    // Guard 3: never the last active lead OF ANY project the account leads —
    // the exact coverage rule the PATCH revoke verb enforces, checked for every
    // project in the account's roles map (unconditional on the target's status,
    // matching revoke).
    const otherActiveLeadsOn = (p: string): number =>
      accounts.filter((x) => x.id !== id && x.status === 'active' && roleFor(x, p) === 'lead').length;
    for (const [p, b] of Object.entries(rolesOf(acc))) {
      if (b.role === 'lead' && otherActiveLeadsOn(p) === 0) return apiError(c, 'LAST_LEAD_GUARD');
    }

    // The audited `before` snapshot carries the authorization shape (never
    // credential material) so the evidence of record shows exactly what was removed.
    await transactWithAudit(store, projectId, [{ kind: 'delete', pk: k.PK, sk: k.SK }], {
      action: 'account-delete', actor, targetType: 'account', targetId: id,
      before: { displayName: acc.displayName, status: acc.status, isAdmin: acc.isAdmin, roles: rolesOf(acc) },
    });
    const sessionsRevoked = await killAllSessions(store, id);
    return c.json({ ok: true, deleted: true, sessionsRevoked });
  });

  a.post('/accounts/:id/reset-password', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const parsed = ResetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const k = accountKey(id);
    const acc = (await store.get(k.PK, k.SK)) as AccountItem | null;
    if (!acc) return c.json({ code: 'NOT_FOUND', reason: 'No such account.' }, 404);

    // A password reset affects login globally, so classify on senior-ANYWHERE (not just the
    // acting project): resetting anyone who is approver/lead on ANY project is loosening
    // (second-admin envelope); a pure-requester reset is tightening (immediate). Reads the
    // roles shim, so it is correct for both legacy and new-shape rows.
    const classification: Classification = isSeniorAnywhere(acc) ? 'loosening' : 'tightening';
    const set = {
      credential: { algo: 'argon2id', hash: await hashPassword(parsed.data.newPassword) },
      mustChangePassword: true,
      sessionVersion: acc.sessionVersion + 1, // reset kills live sessions
      failedAttempts: 0,
      accountVersion: nextAccountVersion(acc), // every account mutation bumps the drift counter
    };
    // Guarded like the PATCH applies: a senior reset routes through dual-control, and its
    // propose-time credential/sessionVersion snapshot must never replay over an account
    // that changed in between (e.g. a self password-change) — stale ack → 409 STALE_PROPOSAL.
    const apply: ApplySpec = { op: 'update', pk: k.PK, sk: k.SK, set, guardAttr: 'accountVersion', guardValue: acc.accountVersion };
    const res = await commitOrPropose(store, projectId, actor, {
      classification,
      kind: 'password-reset-senior',
      targetKey: `ACCOUNT#${id}`,
      before: null,
      after: { mustChangePassword: true },
      apply,
      audit: { action: 'password-reset', actor, targetType: 'account', targetId: id },
    });
    if (res.status === 200) return c.json({ ok: true });
    return c.json(publicPendingChange(res.pending), 202);
  });

  /* ── dual-control config changes ────────────────────────────────────────── */
  a.get('/config-changes', async (c) => {
    const pending = (await c.get('store').queryGSI1(pendingConfigGsi(c.get('projectId')))) as PendingConfigChangeItem[];
    return c.json(pending.map(publicPendingChange));
  });

  a.post('/config-changes/:id/ack', async (c) => {
    try {
      const applied = await ackPending(c.get('store'), c.get('projectId'), c.get('account')!.id, c.req.param('id'));
      // Project-kind applies carry follow-ups the generic machinery can't know:
      // the named 'Trusted repo for onboarding' event and the known-projects
      // cache resync on deregister (domain/projectsLifecycle.ts).
      await afterProjectConfigApply(c.get('store'), c.get('projectId'), applied, c.get('account')!.id, { dataRoot: opts.projectDataRoot });
      return c.json(publicPendingChange(applied));
    } catch (e) {
      if (e instanceof ApiError) return apiError(c, e.code, e.details);
      throw e;
    }
  });

  a.post('/config-changes/:id/reject', async (c) => {
    try {
      const rejected = await rejectPending(c.get('store'), c.get('projectId'), c.get('account')!.id, c.req.param('id'));
      return c.json(publicPendingChange(rejected));
    } catch (e) {
      if (e instanceof ApiError) return apiError(c, e.code, e.details);
      throw e;
    }
  });

  /* ── audit (evidence of record: readable, exportable, chain-verifiable) ──── */
  // GET /admin/audit — newest-first, cursor-paged. Read-only; admin gate is the enforcement.
  a.get('/audit', async (c) => {
    const { entries } = await readAuditChronological(c.get('store'), c.get('projectId'));
    const newestFirst = entries.slice().reverse().map(toAuditEntry);
    const limRaw = Number(c.req.query('limit'));
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), 1000) : 100;
    const cursor = c.req.query('cursor');
    let start = 0;
    if (cursor) {
      const idx = newestFirst.findIndex((e) => e.id === cursor);
      start = idx >= 0 ? idx + 1 : newestFirst.length; // unknown cursor → empty tail (never a silent full replay)
    }
    const page = newestFirst.slice(start, start + limit);
    const next = start + limit < newestFirst.length ? page[page.length - 1]?.id : undefined;
    return c.json({ items: page, ...(next ? { cursor: next } : {}) });
  });

  // GET /admin/audit/export — the WHOLE chain as a self-verifying evidence document.
  a.get('/audit/export', async (c) => {
    const doc = await exportAuditChain(c.get('store'), c.get('projectId'));
    c.header('content-disposition', `attachment; filename="ccp-audit-${doc.projectId}.json"`);
    return c.json(doc);
  });

  /* ── teams CRUD (OpenAPI declared them; they were unrouted → 404) ────────── */
  a.get('/teams', async (c) => {
    const teams = (await c.get('store').queryGSI1(teamCollectionGsi(c.get('projectId')))) as TeamItem[];
    return c.json(
      teams.map((t) => ({ id: t.id, name: t.name, serviceSlugs: t.serviceSlugs })).sort((x, y) => x.name.localeCompare(y.name)),
    );
  });

  a.post('/teams', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const parsed = TeamCreateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const name = parsed.data.name.trim();
    if (name.length < 2) return apiError(c, 'VALIDATION_FAILED');

    const existing = (await store.queryGSI1(teamCollectionGsi(projectId))) as TeamItem[];
    if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) return apiError(c, 'DUPLICATE_TEAM');

    const base = slugify(name) || 'team';
    const ids = new Set(existing.map((t) => t.id));
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;

    const wanted = new Set(parsed.data.serviceSlugs ?? []);
    const { writes, steals } = stripFromOthers(existing, wanted, null);
    const team: TeamItem = { ...teamKey(projectId, id), id, name, serviceSlugs: [...wanted], version: 1, GSI1PK: teamCollectionGsi(projectId), GSI1SK: id };
    writes.push({ kind: 'put', item: team, ifNotExists: true });

    await transactWithAudit(store, projectId, writes, {
      action: 'team-create', actor, targetType: 'team', targetId: id,
      after: { name, serviceSlugs: [...wanted] }, ...(steals.length ? { before: { stolenFrom: steals } } : {}),
    });
    return c.json({ id, name, serviceSlugs: [...wanted] }, 201);
  });

  a.patch('/teams/:id', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const parsed = TeamRenameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const name = parsed.data.name.trim();
    if (name.length < 2) return apiError(c, 'VALIDATION_FAILED');

    const existing = (await store.queryGSI1(teamCollectionGsi(projectId))) as TeamItem[];
    const team = existing.find((t) => t.id === id);
    if (!team) return c.json({ code: 'NOT_FOUND', reason: 'No such team.' }, 404);
    if (existing.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) return apiError(c, 'DUPLICATE_TEAM');

    const updated: TeamItem = { ...team, name, version: (team.version ?? 0) + 1 };
    await transactWithAudit(store, projectId, [{ kind: 'put', item: updated }], {
      action: 'team-rename', actor, targetType: 'team', targetId: id, before: { name: team.name }, after: { name },
    });
    return c.json({ id, name, serviceSlugs: team.serviceSlugs });
  });

  a.put('/teams/:id/services', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const parsed = TeamServicesBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const existing = (await store.queryGSI1(teamCollectionGsi(projectId))) as TeamItem[];
    const team = existing.find((t) => t.id === id);
    if (!team) return c.json({ code: 'NOT_FOUND', reason: 'No such team.' }, 404);

    const wanted = new Set(parsed.data.serviceSlugs);
    const { writes, steals } = stripFromOthers(existing, wanted, id);
    const updated: TeamItem = { ...team, serviceSlugs: [...wanted], version: (team.version ?? 0) + 1 };
    writes.push({ kind: 'put', item: updated });

    // Single-ownership steal is EXPLICIT in the audit before/after.
    await transactWithAudit(store, projectId, writes, {
      action: 'team-set-services', actor, targetType: 'team', targetId: id,
      before: { serviceSlugs: team.serviceSlugs, ...(steals.length ? { stolenFrom: steals } : {}) }, after: { serviceSlugs: [...wanted] },
    });
    return c.json({ id, name: team.name, serviceSlugs: [...wanted] });
  });

  a.delete('/teams/:id', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const k = teamKey(projectId, id);
    const team = (await store.get(k.PK, k.SK)) as TeamItem | null;
    if (!team) return c.json({ code: 'NOT_FOUND', reason: 'No such team.' }, 404);

    // Team membership is PER PROJECT now: a member is anyone whose team ON THIS project
    // is `id` (reads the roles shim, so it catches both legacy and new-shape accounts —
    // the legacy global `acc.teamId` would miss every new-shape member).
    const members = (await loadAccounts(store)).filter((acc) => teamFor(acc, projectId) === id).length;
    if (members > 0 || team.serviceSlugs.length > 0) return apiError(c, 'TEAM_NOT_EMPTY');

    await transactWithAudit(store, projectId, [{ kind: 'delete', pk: k.PK, sk: k.SK }], {
      action: 'team-delete', actor, targetType: 'team', targetId: id, before: { name: team.name },
    });
    return c.body(null, 204);
  });

  /* ── TOTP reset (lost phone = permanent privileged lockout without this) ─── */
  a.post('/accounts/:id/reset-totp', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const k = accountKey(id);
    const acc = (await store.get(k.PK, k.SK)) as AccountItem | null;
    if (!acc) return c.json({ code: 'NOT_FOUND', reason: 'No such account.' }, 404);

    // Clear ALL enrolled factors + recovery codes (ADR-0024 clause 6: the
    // admin path is unchanged in MEANING, widened in EFFECT — "clears all
    // devices and recovery codes", not just the legacy single secret) + bump
    // sessionVersion (kills live sessions). Next login re-enrolls a fresh
    // authenticator; the account still needs its password, so this is an
    // availability recovery, not a privilege grant → applied immediately +
    // audited. (accountVersion bumps too — every account mutation moves the
    // dual-control drift counter.)
    const wasEnrolled = totpDevicesOf(acc).length > 0;
    const updated: AccountItem = { ...acc, sessionVersion: acc.sessionVersion + 1, accountVersion: nextAccountVersion(acc) };
    delete updated.totp;
    delete updated.totpDevices;
    delete updated.recoveryCodes;
    await transactWithAudit(store, projectId, [{ kind: 'put', item: updated }], {
      action: 'totp-reset', actor, targetType: 'account', targetId: id,
      before: { totpEnrolled: wasEnrolled }, after: { totpEnrolled: false },
    });
    const sessionsRevoked = await killAllSessions(store, id);
    return c.json({ ok: true, totpReset: true, sessionsRevoked });
  });

  /* ── session revocation (wires killAllSessions — was dead code) ──────────── */
  a.post('/accounts/:id/revoke-sessions', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;
    const id = c.req.param('id');
    const k = accountKey(id);
    const acc = (await store.get(k.PK, k.SK)) as AccountItem | null;
    if (!acc) return c.json({ code: 'NOT_FOUND', reason: 'No such account.' }, 404);

    // Bump sessionVersion so any not-yet-deleted session also fails resolve, THEN delete.
    // (accountVersion bumps too — every account mutation moves the dual-control drift counter.)
    const updated: AccountItem = { ...acc, sessionVersion: acc.sessionVersion + 1, accountVersion: nextAccountVersion(acc) };
    await transactWithAudit(store, projectId, [{ kind: 'put', item: updated }], {
      action: 'sessions-revoke', actor, targetType: 'account', targetId: id,
    });
    const sessionsRevoked = await killAllSessions(store, id);
    return c.json({ ok: true, sessionsRevoked });
  });

  return a;
}

/**
 * Single-ownership helper: strip `wanted` service slugs from every team EXCEPT
 * `keepId`, returning the version-bumped puts + a record of what was stolen (for
 * the audit before/after). No caller hand-concatenates keys — each team item
 * already carries its PK/SK.
 */
function stripFromOthers(
  teams: TeamItem[],
  wanted: Set<string>,
  keepId: string | null,
): { writes: TransactWrite[]; steals: Array<{ id: string; removed: string[] }> } {
  const writes: TransactWrite[] = [];
  const steals: Array<{ id: string; removed: string[] }> = [];
  for (const t of teams) {
    if (t.id === keepId) continue;
    const removed = t.serviceSlugs.filter((s) => wanted.has(s));
    if (removed.length === 0) continue;
    const kept = t.serviceSlugs.filter((s) => !wanted.has(s));
    writes.push({ kind: 'put', item: { ...t, serviceSlugs: kept, version: (t.version ?? 0) + 1 } });
    steals.push({ id: t.id, removed });
  }
  return { writes, steals };
}
