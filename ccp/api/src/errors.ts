import type { Context, Env, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Error taxonomy — the ONLY error surface. Every 4xx body is `{code, reason, details?}`.
 * Statuses and codes are transcribed verbatim from `ccp/docs/specs/ccp-api.md`.
 * `reason` is the human string the SPA surfaces as `MutationResult.ok:false`.
 * Only `BAD_CREDENTIALS.reason` is pinned by the spec (auth.ts:91 parity, no enumeration).
 */
export const ERRORS = {
  // 401 — missing/expired/version-bumped session; login failure (generic); TOTP step pending
  NO_SESSION: { status: 401, reason: "You are not signed in." },
  SESSION_EXPIRED: {
    status: 401,
    reason: "Your session has expired. Please sign in again.",
  },
  SESSION_INVALIDATED: {
    status: 401,
    reason: "Your session is no longer valid. Please sign in again.",
  },
  BAD_CREDENTIALS: { status: 401, reason: "Wrong username or password." },
  TOTP_REQUIRED: { status: 401, reason: "A verification code is required." },
  // Upload-token lane (CI data upload — Bearer token, never a session). One
  // generic code for missing/malformed/unknown/expired/revoked/wrong-project so
  // a probe can't tell which part was wrong (no enumeration).
  UPLOAD_TOKEN_INVALID: {
    status: 401,
    reason: "The upload token is missing, wrong, expired, or revoked.",
  },
  // Onboard-token lane (pre-trust CI artifact upload — Bearer token, never a
  // session; a SEPARATE credential from the upload token, I10). Same
  // no-enumeration posture: one generic code for missing/malformed/unknown/
  // expired/revoked/wrong-project so a probe can't tell which part was wrong.
  ONBOARD_TOKEN_INVALID: {
    status: 401,
    reason: "The onboarding token is missing, wrong, expired, or revoked.",
  },

  // 403 — authenticated but not permitted (api.ts:249-262 reasons)
  FORBIDDEN_ROLE: {
    status: 403,
    reason: "Only approvers and leads can do that.",
  },
  NOT_ADMIN: { status: 403, reason: "Admin capability is required for that." },
  SELF_APPROVAL: {
    status: 403,
    reason: "You cannot approve your own request.",
  },
  SELF_ACK: {
    status: 403,
    reason: "You cannot acknowledge your own proposal.",
  },
  SELF_DELETE: {
    status: 403,
    reason: "You cannot delete your own account. Ask another admin to do it.",
  },
  TEAM_SCOPE: {
    status: 403,
    reason: "You can only request changes for your team's services.",
  },
  PROJECT_SCOPE: {
    status: 403,
    reason: "Your account is not authorized for this project.",
  },
  // data-birth spec §5 — the reserved control-plane scope (`@control`) is not an
  // estate: request submission/approval and catalog reads refuse this, distinct
  // from PROJECT_SCOPE (unbound account) — the caller IS bound (via '*'), the
  // scope itself just has no data plane to act on.
  CONTROL_SCOPE: {
    status: 403,
    reason: "This action needs an onboarded account's scope.",
  },
  ENGINEER_REVIEW_REQUIRED: {
    status: 403,
    reason:
      "This change needs an engineer-tier review; only a Lead can approve it.",
  },
  WRONG_APPROVAL_LEVEL: {
    status: 403,
    reason:
      "The next approval on this change needs a different approver level — the final sign-off must come from a lead.",
  },
  PASSWORD_CHANGE_REQUIRED: {
    status: 403,
    reason: "You must change your password before continuing.",
  },
  MISSING_CLIENT_HEADER: {
    status: 403,
    reason: "Missing or invalid client header.",
  },
  // ADR-0026 — the sensitive self-service re-auth gate: this session has no
  // fresh (<=10m) elevation. The SPA treats this as a flow (confirm-it's-you
  // dialog, then transparent retry), never a bare error.
  REAUTH_REQUIRED: {
    status: 403,
    reason: "Please confirm it is you before continuing.",
  },

  // 409 — correct request, conflicting state; retry only after re-read
  ALREADY_APPROVED: {
    status: 409,
    reason: "You have already approved this request.",
  },
  STATE_CONFLICT: {
    status: 409,
    reason: "This request is not in a state that allows that.",
  },
  STALE_PROPOSAL: {
    status: 409,
    reason: "The target changed since this proposal was made.",
  },
  CHAIN_CONTENTION: {
    status: 409,
    reason: "The audit chain is busy; please retry.",
  },
  DUPLICATE_USERNAME: {
    status: 409,
    reason: "That username is already taken.",
  },
  DUPLICATE_TEAM: { status: 409, reason: "That team name is already taken." },
  TEAM_NOT_EMPTY: {
    status: 409,
    reason: "Move this team's members and services before deleting it.",
  },
  BACKEND_NOT_EMPTY: { status: 409, reason: "The backend already holds data." },
  DUPLICATE_PROJECT: {
    status: 409,
    reason: "That project id is already registered.",
  },
  // drift-portal spec §4.3 — a proposal not from the latest report, already
  // submitted, or otherwise no longer 'open' is never submittable.
  DRIFT_PROPOSAL_STALE: {
    status: 409,
    reason:
      "This drift proposal is stale — superseded by a newer report, already submitted, or not from the latest snapshot.",
  },
  // ADR-0023 — the instance-identity row changed between your read and this
  // write (another admin renamed it concurrently); re-read and retry.
  INSTANCE_STALE: {
    status: 409,
    reason:
      "The instance identity changed since you loaded it — reload and try again.",
  },

  // 422 — body understood, rejected by rules
  VALIDATION_FAILED: {
    status: 422,
    reason: "The request could not be validated.",
  },
  // drift-portal spec §4.3/§8 — eligibility RE-DERIVED from the stored report
  // (never the proposal's own claim) refused; every security-posture-drift
  // refusal rides this code (enforcement point 2 of the binding invariant).
  DRIFT_NOT_ADOPTABLE: {
    status: 422,
    reason:
      "This drift can no longer be adopted or reverted from the portal — eligibility re-derived from the current report refused it.",
  },
  // drift-portal spec §4.3/§8 — the direct POST /requests lane is closed for
  // system-drift-*; a drift request can ONLY be created via
  // POST /projects/:id/drift/proposals/:digest/submit (enforcement point 2b).
  DRIFT_PROPOSAL_REQUIRED: {
    status: 422,
    reason:
      "Drift system operations can only be submitted via POST /projects/:id/drift/proposals/:digest/submit.",
  },
  // Forces-replace confirmed-override lane: a destroy+recreate op must carry the
  // requester's typed confirmation naming the exact resource being replaced.
  REPLACE_CONFIRMATION_REQUIRED: {
    status: 422,
    reason:
      "This change destroys and recreates the resource. Type the resource name to confirm before submitting.",
  },
  OP_DISABLED: { status: 422, reason: "That operation is currently disabled." },
  PARAM_OUT_OF_BOUNDS: {
    status: 422,
    reason: "A parameter is outside its allowed bounds.",
  },
  LAST_LEAD_GUARD: {
    status: 422,
    reason: "That would remove the last active Lead/admin.",
  },
  // ADR-0024 clause 5 — removing an account's LAST enrolled TOTP device while
  // `needsTotp` is true would leave a required-2FA account with none.
  LAST_FACTOR: {
    status: 422,
    reason:
      "That is your last authenticator device and 2FA is required for your account — add another before removing it.",
  },
  // ADR-0024 clause 1 — self-service device add refuses at the 5-device cap.
  DEVICE_LIMIT: {
    status: 422,
    reason:
      "You already have 5 authenticator devices — remove one before adding another.",
  },
  POLICY_OUT_OF_RANGE: {
    status: 422,
    reason: "Policy values must be between 1 and 5.",
  },
  // Schedule validation (submit + rewindow)
  SCHEDULE_INVALID: {
    status: 422,
    reason: "The schedule is not a valid maintenance window.",
  },
  SCHEDULE_TOO_SOON: {
    status: 422,
    reason: "The maintenance window must start at least 30 minutes from now.",
  },
  SCHEDULE_TOO_FAR: {
    status: 422,
    reason: "The maintenance window may not be more than 90 days out.",
  },
  // Rewindow refuses a stale approval rather than silently re-aiming it
  SCHEDULE_STALE_APPROVAL: {
    status: 422,
    reason:
      "This approval is too old to re-window; reject and resubmit, or get a fresh approval first.",
  },
  // Onboarding trust surface (fail-closed sha binding + verdict rule)
  PRESCAN_SHA_MISMATCH: {
    status: 422,
    reason:
      "The uploaded prescan report does not hash to the trust request’s prescanSha256.",
  },
  TRUST_VERDICT_NOT_CLEAN: {
    status: 422,
    reason:
      "The prescan verdict is not clean — a rejected repo can never be trusted.",
  },
  // Project data upload (fail-closed digest binding)
  DATA_DIGEST_MISMATCH: {
    status: 422,
    reason:
      "The uploaded data does not hash to the digests it claims. Nothing was stored.",
  },

  // 413 — the upload body is over the explicit size cap
  UPLOAD_TOO_LARGE: {
    status: 413,
    reason: "The uploaded data bundle is too large.",
  },

  // 423 — locked until a time / global freeze
  ACCOUNT_LOCKED: {
    status: 423,
    reason: "This account is locked. Try again later.",
  },
  GLOBAL_FREEZE: { status: 423, reason: "Changes are frozen right now." },

  // 429 — token bucket / lockout backoff; Retry-After always set
  RATE_LIMITED: { status: 429, reason: "Too many requests. Please slow down." },
  LOGIN_BACKOFF: { status: 429, reason: "Too many attempts. Try again later." },
} as const satisfies Record<
  string,
  { status: ContentfulStatusCode; reason: string }
>;

export type ErrorCode = keyof typeof ERRORS;

export type ErrorDetails = Record<string, unknown> & {
  until?: string;
  retryAfter?: number;
};

/** A thrown error carrying a taxonomy code — mapped to a response by the Hono error handler. */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly details?: ErrorDetails,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

function retryAfterSeconds(details?: ErrorDetails): number {
  if (typeof details?.retryAfter === "number")
    return Math.max(0, Math.ceil(details.retryAfter));
  if (typeof details?.until === "string") {
    const ms = Date.parse(details.until) - Date.now();
    return Math.max(0, Math.ceil(ms / 1000));
  }
  return 60;
}

/**
 * Emit a taxonomy error response `{code, reason, details?}` at its spec status.
 * For 429 always sets `Retry-After` (derived from `details.retryAfter` seconds,
 * else `details.until` ISO, else 60s). For 423 the caller passes `{until}`.
 */
export function apiError(c: Context, code: ErrorCode, details?: ErrorDetails) {
  const { status, reason } = ERRORS[code];
  if (status === 429) {
    c.header("Retry-After", String(retryAfterSeconds(details)));
  }
  const body: { code: ErrorCode; reason: string; details?: ErrorDetails } = {
    code,
    reason,
  };
  if (details && Object.keys(details).length > 0) body.details = details;
  return c.json(body, status);
}

/**
 * Register the app-wide error handler: thrown `ApiError`s become taxonomy responses;
 * anything else is an unexpected 500 (outside the taxonomy by design — reserved for bugs).
 */
export function registerErrorHandler<E extends Env>(app: Hono<E>): void {
  app.onError((err, c) => {
    if (err instanceof ApiError) return apiError(c, err.code, err.details);
    return c.json({ code: "INTERNAL", reason: "Internal error." }, 500);
  });
}
