import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../appEnv';
import type { InstanceItem } from '../store/schema';
import { instanceKey } from '../store/schema';
import type { TransactWrite } from '../store/configStore';
import { apiError, ApiError } from '../errors';
import { requireSession } from '../middleware/session';
import { requireAdmin } from '../middleware/authz';
import { CONTROL_SCOPE } from '../projects';
import { transactWithAudit } from '../domain/audit';
import { nowIso } from '../clock';

/**
 * Instance display identity (ADR-0023). Two route groups, mounted separately
 * in index.ts (like /admin/migrate before /admin): the read is fully public
 * (the login page renders the name pre-auth), the write is admin-only and
 * DELIBERATELY not under requireProjectMembership — instance naming is a
 * GLOBAL control-plane fact, not tied to any one project, so any admin may
 * rename it regardless of which project(s) their account is bound to (same
 * "admin capability, not a project verb" posture the projects registry read
 * uses for GET /projects).
 */

// name: trimmed, single-line, 1-64 chars, no control characters. tagline: same
// rules, 0-140. The single regex bans every C0 control char + DEL (0x00-0x1F,
// 0x7F) — which also excludes \n/\r, so "no control characters" and
// "single-line" are one check.
const NO_CONTROL_CHARS = /^[^\x00-\x1F\x7F]*$/;
/** Exported so the first-boot seed (scripts/bootstrap.ts) validates
 * CCP_INSTANCE_NAME/CCP_INSTANCE_TAGLINE with the exact same rules a
 * later admin PUT enforces — one law, not two. */
export const InstanceBody = z.object({
  name: z.string().trim().min(1).max(64).regex(NO_CONTROL_CHARS),
  tagline: z.string().trim().max(140).regex(NO_CONTROL_CHARS).optional().default(''),
});

function publicInstance(item: InstanceItem | null): {
  name: string | null;
  tagline: string | null;
} {
  return { name: item?.name ?? null, tagline: item?.tagline ?? null };
}

/** `GET /instance` — unauthenticated (mounted directly on the app root, like
 * /healthz + /readyz). Absent item ⇒ {name:null, tagline:null}; the SPA stays
 * on its baked-generic default in that case (never a placeholder string). */
export function instancePublicRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', async (c) => {
    const store = c.get('store');
    const k = instanceKey();
    const item = (await store.get(k.PK, k.SK)) as InstanceItem | null;
    return c.json(publicInstance(item));
  });
  return r;
}

/**
 * `PUT /admin/instance` — admin, validated, version-guarded (read-then-guarded-
 * write, same pattern as admin.ts's policy/setting PUT — no client-supplied
 * expected version; the guard is an internal concurrency safety net, not an
 * optimistic-lock contract the caller must track), audited as
 * `instance-identity-change` on the control-plane's own chain ({@link
 * CONTROL_SCOPE} — the same chain the projects registry and account
 * settlement use for global, non-estate writes). Classification: immediate +
 * audited (a display string, not a privilege edge — ADR-0023 §4.2) — never
 * dual-control.
 */
export function instanceAdminRoutes(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', requireSession, requireAdmin);

  a.put('/', async (c) => {
    const store = c.get('store');
    const actor = c.get('account')!.id;
    const parsed = InstanceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED');

    const k = instanceKey();
    const existing = (await store.get(k.PK, k.SK)) as InstanceItem | null;
    const version = existing?.version ?? 0;
    const now = nowIso();
    const after = {
      name: parsed.data.name,
      tagline: parsed.data.tagline ?? '',
    };
    const write: TransactWrite =
      version === 0
        ? {
            kind: 'put',
            item: {
              ...k,
              ...after,
              version: 1,
              updatedBy: actor,
              updatedAt: now,
            },
            ifNotExists: true,
          }
        : {
            kind: 'update',
            pk: k.PK,
            sk: k.SK,
            set: {
              ...after,
              version: version + 1,
              updatedBy: actor,
              updatedAt: now,
            },
            ifEquals: { attr: 'version', value: version },
          };

    try {
      await transactWithAudit(store, CONTROL_SCOPE, [write], {
        action: 'instance-identity-change',
        actor,
        targetType: 'instance',
        targetId: 'INSTANCE',
        before: existing ? { name: existing.name, tagline: existing.tagline } : null,
        after,
      });
    } catch (e) {
      // transactWithAudit retries a lost condition ONCE (assuming chain-head
      // contention) then throws CHAIN_CONTENTION — since it never rebuilds
      // OUR domain write, a genuinely lost version guard (another admin
      // renamed between our read and this write) surfaces the same way.
      // Report the domain-accurate conflict instead of the generic chain
      // code; anything else (a real bug) still surfaces as an unhandled 500.
      if (e instanceof ApiError && e.code === 'CHAIN_CONTENTION')
        return apiError(c, 'INSTANCE_STALE');
      throw e;
    }

    return c.json({
      name: after.name,
      tagline: after.tagline,
      version: version + 1,
    });
  });

  return a;
}
