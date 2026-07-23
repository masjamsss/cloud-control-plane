import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ConfigStore } from './store/configStore';
import type { AppEnv } from './appEnv';
import { registerErrorHandler } from './errors';
import { CLIENT_HEADER, withClientHeader, withPasswordGate, withProject, withSession, withSettlement } from './middleware/session';
import { authRoutes } from './routes/auth';
import { accountRoutes } from './routes/account';
import { requestRoutes } from './routes/requests';
import { adminRoutes } from './routes/admin';
import { migrateRoutes } from './routes/migrate';
import { projectRoutes } from './routes/projects';
import { instanceAdminRoutes, instancePublicRoutes } from './routes/instance';
import { corsOrigins } from './deploy';
import { readiness } from './domain/readiness';

// Allowed credentialed-CORS origins live in the deploy-config surface (deploy.ts),
// read at request time so a deploy sets CCP_CORS_ORIGIN without a rebuild and
// tests can flip it. Re-exported here for existing importers.
export { corsOrigins };

export type CreateAppOptions = {
  /** Root dir for per-project served data files (`<root>/<projectId>/v<N>/…`).
   * Defaults to `<CCP_DATA_DIR>/projects`; tests inject a temp dir. */
  projectDataRoot?: string;
};

/**
 * Assemble the app. Global middleware order: store context → withSettlement
 * (one-time legacy settlement, data-birth spec §9 — must precede session
 * resolution, see its own doc comment) → withSession (resolve cookie) →
 * withClientHeader (CSRF on non-GET business routes) → withProject (resolve
 * x-ccp-project, default the reserved `@control` scope) → withPasswordGate.
 * Route guards attach per sub-app. The same app object deploys to Lambda later.
 */
export function createApp(store: ConfigStore, opts: CreateAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  registerErrorHandler(app);

  // CORS FIRST so a preflight (OPTIONS) short-circuits before the CSRF/session gates,
  // and every response to a browser at the SPA origin carries credentialed CORS headers.
  app.use('*', cors({
    origin: (origin) => (origin && corsOrigins().includes(origin) ? origin : null),
    credentials: true, // the session cookie is credentialed — the browser needs ACAC:true
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', CLIENT_HEADER, 'X-Ccp-Project'],
    exposeHeaders: ['Retry-After'],
    maxAge: 600,
  }));

  app.use('*', async (c, next) => {
    c.set('store', store);
    await next();
  });
  // The one-time legacy settlement (domain/settlement.ts) MUST run before
  // withSession resolves+caches the acting account — settlement can mutate that
  // very row (bare legacy row → explicit `roles` map), and a cached pre-settlement
  // snapshot would fail authorization on the exact request that triggered it.
  app.use('*', withSettlement);
  app.use('*', withSession);
  app.use('*', withClientHeader);
  app.use('*', withProject);
  app.use('*', withPasswordGate);

  // Liveness: the process is up and serving. Deliberately shallow — it stays green
  // even with an empty store, which is exactly why /readyz exists.
  app.get('/healthz', (c) => c.json({ ok: true }));

  // Readiness that does not lie: reports store-loaded + account-count + audit-chain
  // verification, so an emptied/corrupt store is visibly NOT ready (503). Unauthenticated
  // infra probe — no session required (the middleware above is non-rejecting for GET).
  app.get('/readyz', async (c) => {
    const r = await readiness(c.get('store'));
    return c.json(r, r.ready ? 200 : 503);
  });

  // ADR-0023 — instance display identity. GET is unauthenticated (the login
  // page renders the name pre-auth), same tier as /healthz + /readyz above.
  app.route('/instance', instancePublicRoutes());

  app.route('/auth', authRoutes());
  // Account & security center self-service (devices/codes/sessions) — a
  // second small Hono group at the SAME /auth prefix (the login-step-machine
  // routes vs the standing self-service routes), same split instance.ts uses
  // for public-vs-admin.
  app.route('/auth', accountRoutes());
  app.route('/requests', requestRoutes());
  app.route('/admin/migrate', migrateRoutes()); // more specific — before /admin
  // Instance rename: admin-only but GLOBAL (not project-scoped) — mounted
  // before /admin so it never inherits adminRoutes' requireProjectMembership.
  app.route('/admin/instance', instanceAdminRoutes());
  // adminRoutes needs the data root too: the deregister-ack lifecycle hook
  // removes the deregistered project's on-disk served data.
  app.route('/admin', adminRoutes({ projectDataRoot: opts.projectDataRoot }));
  // Registry + onboarding trust surface + the per-account data plane
  app.route('/projects', projectRoutes({ dataRoot: opts.projectDataRoot }));

  return app;
}
