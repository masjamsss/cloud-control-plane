import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../appEnv';
import { AccountItem, PolicyItem, RiskOverrideItem, TeamItem } from '../store/schema';
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

/**
 * DATA-11 — the username grammar the rest of the product enforces
 * (`routes/admin.ts` EnrollBody). The v1 shape accepted `z.string()`, so
 * arbitrary bytes reached `accountKey()` and became a store PARTITION KEY. A
 * migration is not a lower-trust boundary than enrolment; it is the SAME
 * boundary, run once, by an admin, against a document nobody validated.
 */
const V1_USERNAME = /^[a-z0-9._-]{2,32}$/;

const V1Account = z
  .object({
    id: z.string(),
    username: z.string().regex(V1_USERNAME),
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
  })
  /**
   * DATA-11 — `id === username` is a RUNTIME INVARIANT, not a convention.
   * The account row is keyed by username (`accountKey`), while a session stores
   * `userId = account.id` and resolves it back through `accountKey(userId)`
   * (`auth/sessions.ts`). An imported row where the two disagree can pass login
   * — which looks the account up BY USERNAME — and then every session it mints
   * resolves to a nonexistent `ACCOUNT#<id>` row and comes back `invalid`. The
   * account can authenticate and can never hold a session, forever.
   *
   * REFUSED rather than normalized, deliberately. Every v1 export this product
   * ever produced has `id === username` (the SPA's own account store documents
   * `id` as "stable — equals the username"), so a document where they differ is
   * corrupt or hostile, and silently rewriting an identity during a one-shot
   * migration is a worse failure than refusing the document: the admin can fix
   * the export and re-run, but cannot un-rewrite an identity that historical
   * request authorship and audit actors already reference.
   */
  .refine((a) => a.id === a.username, {
    message: 'account id must equal username (the store keys accounts by username)',
    path: ['id'],
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

    /**
     * DATA-11 — THE RULE: no row leaves this route without passing the store
     * schema that governs it.
     *
     * The import used to build every row by CAST (`as TeamItem`, a bare
     * `PolicyItem` literal), which type-checks and validates nothing at runtime.
     * The v1 schemas above only describe the v1 document; they say nothing about
     * what the store requires. `V1Policy` is unbounded `z.number()` while
     * `PolicyItem` requires integers 1..5, so a v1 doc with `high: 0` or `7.5`
     * landed verbatim and drove the `approvalsRequired` math out of contract.
     *
     * Parsing the CONSTRUCTED row — rather than adding min/max to `V1Policy` —
     * is the rule form: it holds for every row kind, including the two nobody
     * reported, and a future field added to a store schema is enforced here on
     * the day it is added rather than the day a migration writes past it.
     */
    const rejected: Array<{ field: string; problem: string }> = [];
    function checked<T>(schema: z.ZodType<T>, row: unknown, field: string): T {
      const r = schema.safeParse(row);
      if (r.success) return r.data;
      rejected.push({ field, problem: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return row as T; // never written — `rejected` aborts the import below
    }

    /* BUILD AND VALIDATE EVERYTHING FIRST, WRITE NOTHING YET (DATA-11).
     *
     * The import is not transactional and cannot be — it spans the audit chain.
     * So the only way a schema-violating row does not reach the store is for the
     * whole document to be checked before the first `put`. Refusing the document
     * whole is also the right posture for a migration that runs once, at
     * adoption: a half-imported estate is not a state anyone can reason about,
     * and the operator's remedy (fix the export, re-run) is only available while
     * the backend still holds just the bootstrap account.
     */
    const accountRows = v1['ccp.accounts.v1'].map((a) =>
      checked<AccountItem>(
        AccountItem,
        {
          ...accountKey(a.username),
          // The invariant the `.refine` above pins: keyed by username, identified
          // by username. (`a.id === a.username` here, by construction.)
          id: a.username,
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
        },
        `ccp.accounts.v1[${a.username}]`,
      ),
    );

    const teamRows = v1['ccp.teams.v1'].map((t) =>
      checked<TeamItem>(
        TeamItem,
        { ...teamKey(projectId, t.id), id: t.id, name: t.name, serviceSlugs: t.serviceSlugs, version: 1, GSI1PK: teamCollectionGsi(projectId), GSI1SK: t.id },
        `ccp.teams.v1[${t.id}]`,
      ),
    );

    const policy = checked<PolicyItem>(
      PolicyItem,
      { ...policyKey(projectId), ...v1['ccp.policy.v1'], version: 1 },
      'ccp.policy.v1',
    );

    const riskRows = Object.entries(v1['ccp.risk-overrides.v1']).map(([opId, risk]) =>
      checked<RiskOverrideItem>(
        RiskOverrideItem,
        { ...riskOverrideKey(projectId, opId), risk, version: 1, setBy: actor, setAt: nowIso() },
        `ccp.risk-overrides.v1[${opId}]`,
      ),
    );

    if (rejected.length > 0) {
      return apiError(c, 'VALIDATION_FAILED', {
        field: rejected[0]!.field,
        problem: rejected[0]!.problem,
        rejectedRows: rejected.length,
      });
    }

    /* ── every row above satisfies its store schema; NOW write ──────────── */

    for (const item of accountRows) {
      try {
        await store.put(item, { ifNotExists: true }); // never clobber the bootstrap account
        counts.accounts++;
      } catch {
        /* username collides with an existing account — skip */
      }
    }

    for (const item of teamRows) {
      await store.put(item);
      counts.teams++;
    }

    await store.put(policy);
    counts.policy = 1;

    for (const item of riskRows) {
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
