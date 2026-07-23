import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../appEnv';
import type { AccountItem, PolicyItem, RiskOverrideItem, TeamItem } from '../store/schema';
import { accountKey, accountsGsi, policyKey, riskOverrideKey, teamCollectionGsi, teamKey } from '../store/schema';
import { apiError } from '../errors';
import { requireSession } from '../middleware/session';
import { requireAdmin, requireProjectMembership } from '../middleware/authz';
import { record } from '../domain/audit';
import { nowIso } from '../clock';

/**
 * v1 (SPA localStorage) → v2 backend migration. Accepts ONE document with
 * the five v1 stores exactly as the SPA persists them. Allowed only while the backend
 * holds JUST the bootstrap account. Imported accounts keep their PBKDF2 credential and
 * are transparently re-hashed to argon2id on first successful login (Task 4). Sessions
 * are never imported. v1 audit rows are appended as chained `v1-import` wrappers.
 */

const V1Account = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(['requester', 'approver', 'lead']),
  teamId: z.string(),
  passwordHash: z.string(),
  salt: z.string(),
  iterations: z.number(),
  status: z.enum(['active', 'disabled']),
  createdAt: z.string(),
  createdBy: z.string(),
  mustChangePassword: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
});
const V1Team = z.object({ id: z.string(), name: z.string(), serviceSlugs: z.array(z.string()) });
const V1Policy = z.object({ low: z.number(), medium: z.number(), high: z.number(), deleteMin: z.number() });
const V1Audit = z.object({ id: z.string(), at: z.string(), actor: z.string(), action: z.string(), summary: z.string() });

const V1Body = z
  .object({
    'ccp.accounts.v1': z.array(V1Account),
    'ccp.teams.v1': z.array(V1Team),
    'ccp.policy.v1': V1Policy,
    'ccp.risk-overrides.v1': z.record(z.enum(['LOW', 'MEDIUM', 'HIGH'])),
    'ccp.audit.v1': z.array(V1Audit),
  })
  .passthrough();

export function migrateRoutes(): Hono<AppEnv> {
  const m = new Hono<AppEnv>();
  m.use('*', requireSession, requireAdmin, requireProjectMembership);

  m.post('/v1', async (c) => {
    const store = c.get('store');
    const projectId = c.get('projectId');
    const actor = c.get('account')!.id;

    // Allowed only while the backend holds JUST the bootstrap account.
    const accounts = await store.queryGSI1(accountsGsi());
    if (accounts.length !== 1) return apiError(c, 'BACKEND_NOT_EMPTY');

    const parsed = V1Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');
    const v1 = parsed.data;

    const counts = { accounts: 0, teams: 0, policy: 0, riskOverrides: 0, audit: 0 };

    for (const a of v1['ccp.accounts.v1']) {
      const item: AccountItem = {
        ...accountKey(a.username),
        id: a.id,
        username: a.username,
        displayName: a.displayName,
        // v1 was single-project (one baked estate): the imported global role/team becomes this
        // account's binding ON the enrolling project, in the new canonical `roles` shape.
        roles: { [projectId]: { role: a.role, teamId: a.teamId } },
        status: a.status,
        createdAt: a.createdAt,
        createdBy: a.createdBy,
        mustChangePassword: a.mustChangePassword ?? false,
        isAdmin: a.isAdmin ?? false,
        credential: { algo: 'pbkdf2', hash: a.passwordHash, salt: a.salt, iterations: a.iterations },
        failedAttempts: 0,
        sessionVersion: 1,
        accountVersion: 1, // the dual-control drift counter starts life on every fresh row
        GSI1PK: accountsGsi(),
        GSI1SK: a.username,
      };
      try {
        await store.put(item, { ifNotExists: true }); // never clobber the bootstrap account
        counts.accounts++;
      } catch {
        /* username collides with an existing account — skip */
      }
    }

    for (const t of v1['ccp.teams.v1']) {
      const item: TeamItem = { ...teamKey(projectId, t.id), id: t.id, name: t.name, serviceSlugs: t.serviceSlugs, version: 1, GSI1PK: teamCollectionGsi(projectId), GSI1SK: t.id } as TeamItem;
      await store.put(item);
      counts.teams++;
    }

    const policy: PolicyItem = { ...policyKey(projectId), ...v1['ccp.policy.v1'], version: 1 };
    await store.put(policy);
    counts.policy = 1;

    for (const [opId, risk] of Object.entries(v1['ccp.risk-overrides.v1'])) {
      const item: RiskOverrideItem = { ...riskOverrideKey(projectId, opId), risk, version: 1, setBy: actor, setAt: nowIso() };
      await store.put(item);
      counts.riskOverrides++;
    }

    // v1 audit rows → chained `v1-import` wrappers carrying the original in `before`.
    for (const e of v1['ccp.audit.v1']) {
      await record(store, projectId, { action: 'v1-import', actor: e.actor, targetType: 'audit', targetId: e.id, before: e });
      counts.audit++;
    }
    await record(store, projectId, { action: 'v1-migrate', actor, targetType: 'session', targetId: actor, after: counts });

    return c.json(counts);
  });

  return m;
}
