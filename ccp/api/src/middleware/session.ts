import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv, SessionFail } from "../appEnv";
import { apiError } from "../errors";
import { resolveSession } from "../auth/sessions";
import { nowMs } from "../clock";
import {
  CONTROL_SCOPE,
  hydrateKnownProjects,
  isKnownProject,
  needsProjectHydration,
} from "../projects";
import { ensureSettlement } from "../domain/settlement";

export const SESSION_COOKIE = "ccp_session";

/** CSRF client header value (X-Ccp-Client const 'ccp-spa'). */
export const CLIENT_HEADER = "x-ccp-client";
export const CLIENT_VALUE = "ccp-spa";

/** Maps a resolve failure to its 401 code. */
export function failCode(
  reason: SessionFail,
): "SESSION_EXPIRED" | "SESSION_INVALIDATED" | "NO_SESSION" | "TOTP_REQUIRED" {
  switch (reason) {
    case "expired":
    case "idle":
      return "SESSION_EXPIRED";
    case "version":
      return "SESSION_INVALIDATED";
    case "totp":
      return "TOTP_REQUIRED";
    case "invalid":
    default:
      return "NO_SESSION";
  }
}

/**
 * Ensure the one-time legacy settlement (domain/settlement.ts) has run against
 * THIS store before anything else reads it. MUST run before `withSession`: session
 * resolution reads and caches the ACCOUNT row onto the request context, and
 * settlement's account-materialization step (bare legacy row → explicit `roles`
 * map) mutates that very row — resolving the session first would cache a
 * pre-materialization snapshot for the rest of the request, so a freshly-settled
 * account would still fail `requireProjectMembership` (rolesOf's retired arm 3 is
 * `{}`) on the exact request that triggered its own settlement.
 */
export const withSettlement: MiddlewareHandler<AppEnv> = async (c, next) => {
  await ensureSettlement(c.get("store"));
  await next();
};

/**
 * Resolve the session cookie (if present) onto the context. Non-rejecting: it sets
 * `account`/`session` on success, or `sessionFail` on failure. Route guards decide.
 */
export const withSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const store = c.get("store");
    const res = await resolveSession(store, token, nowMs());
    if (res.ok) {
      c.set("account", res.account);
      c.set("session", res.session);
    } else {
      c.set("sessionFail", res.reason);
    }
  }
  await next();
};

/**
 * The CI upload-token lane: `PUT /projects/:id/data` (project data) OR
 * `PUT /projects/:id/drift` (drift telemetry, WI-2) carrying a Bearer upload
 * token. Neither is a browser flow — no cookie, no session — so the CSRF
 * client header (which defends AMBIENT cookie credentials) does not apply: a
 * cross-site attacker cannot attach an Authorization header without a CORS
 * preflight this server refuses. Each upload handler enforces its own
 * fail-closed token gate; a PUT to either path WITHOUT a Bearer header stays
 * under the normal CSRF + session rules (and then fails the token gate anyway).
 */
export function isUploadTokenLane(
  method: string,
  path: string,
  authorization: string | undefined,
): boolean {
  return (
    method === "PUT" &&
    /^\/projects\/[^/]+\/(data|drift)$/.test(path) &&
    (authorization?.startsWith("Bearer ") ?? false)
  );
}

/**
 * The PRE-TRUST onboarding-token lane (easy-first-import spec §3 A-iii):
 * `PUT /projects/:id/trust-request` carrying a Bearer onboard token. A
 * SEPARATE predicate from {@link isUploadTokenLane} — deliberately not
 * folded into it, since the two credentials are a separate type/key
 * namespace (I10) and this lane authorizes exactly this ONE existing verb,
 * never `/data` or `/drift`. Like the upload lane this is not a browser flow
 * (no cookie, no session), so the CSRF client header does not apply for the
 * same reason; the handler enforces its own fail-closed token gate before
 * falling through to the pre-existing, unchanged validation pipeline.
 */
export function isOnboardTokenLane(
  method: string,
  path: string,
  authorization: string | undefined,
): boolean {
  return (
    method === "PUT" &&
    /^\/projects\/[^/]+\/trust-request$/.test(path) &&
    (authorization?.startsWith("Bearer ") ?? false)
  );
}

/**
 * CSRF: non-GET requests must carry `x-ccp-client: ccp-spa`.
 * /auth/* is exempt — the OpenAPI marks the `client` parameter only on the
 * business/admin mutations (/requests, /admin/*), not the auth entry routes.
 * The token-authed CI upload lane is exempt too (see {@link isUploadTokenLane}),
 * and so is the pre-trust onboarding-token lane (see {@link isOnboardTokenLane}).
 */
export const withClientHeader: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  const auth = c.req.header("authorization");
  const exempt =
    method === "GET" ||
    method === "HEAD" ||
    path === "/auth" ||
    path.startsWith("/auth/") ||
    isUploadTokenLane(method, path, auth) ||
    isOnboardTokenLane(method, path, auth);
  if (!exempt && c.req.header(CLIENT_HEADER) !== CLIENT_VALUE) {
    return apiError(c, "MISSING_CLIENT_HEADER");
  }
  await next();
};

/**
 * Resolve the project from `x-ccp-project` (default the reserved control-plane
 * scope `@control` — data-birth spec §5; a header-less client is now an inert
 * CONTROL-PLANE client (auth + admin-global + registry only), not an implicit
 * estate); unknown id → 422. Identity is global; everything else is scoped by this
 * projectId (frozen keying). The known set is a store-backed cache (registry)
 * hydrated lazily on the first request after boot, so a restart never forgets a
 * ready project — mounted AFTER `withSettlement`, so a pre-existing legacy
 * deployment's retro-registered row is already visible to THIS hydration pass.
 */
export const withProject: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (needsProjectHydration()) await hydrateKnownProjects(c.get("store"));
  const raw = c.req.header("x-ccp-project");
  const projectId = raw ?? CONTROL_SCOPE;
  if (!isKnownProject(projectId))
    return apiError(c, "VALIDATION_FAILED", { field: "x-ccp-project" });
  c.set("projectId", projectId);
  await next();
};

/** Hard-require a resolved session; else the mapped 401. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const account = c.get("account");
  if (!account) {
    const fail = c.get("sessionFail");
    return apiError(c, fail ? failCode(fail) : "NO_SESSION");
  }
  await next();
};

// ADR-0023: /instance is unauthenticated by design (the login page reads the
// instance name pre-auth) and carries zero privileged information — never
// worth blocking behind a pending forced password change.
const PASSWORD_GATE_EXEMPT_PREFIXES = [
  "/auth",
  "/healthz",
  "/readyz",
  "/instance",
];

/**
 * While `mustChangePassword` is true, every route EXCEPT /auth/me,
 * /auth/change-password, /auth/logout returns 403 PASSWORD_CHANGE_REQUIRED.
 * (/auth/login and /auth/totp are pre-session and naturally excluded.)
 */
export const withPasswordGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const account = c.get("account");
  const path = c.req.path;
  const exempt = PASSWORD_GATE_EXEMPT_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
  if (account?.mustChangePassword && !exempt) {
    return apiError(c, "PASSWORD_CHANGE_REQUIRED");
  }
  await next();
};
