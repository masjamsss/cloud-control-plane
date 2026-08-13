import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../appEnv';
import { redactSecrets } from '../redact';

/**
 * OPS-7 — the api emitted NO access log at all: no method/path/status/latency lines, no
 * per-request correlation id, no client identifier. The only runtime log lines were boot
 * messages, scheduler/drift `console.error`s, and OPS-2's server-error log. The audit
 * chain covers business MUTATIONS; 4xx refusals (auth failures, rate limits, validation)
 * and ordinary read traffic left no trace anywhere. An operator could not answer "what was
 * the api doing at 14:32", and a user's "it failed" report could not be correlated with
 * anything server-side.
 *
 * ── WHAT IS LOGGED, AND WHAT IS NOT (the decision this finding asks for, stated once) ──
 *
 * Logged: method, path (no query string), status, latency, and a per-request id.
 *
 * NEVER logged: the request or response BODY, the query string, headers, or cookies.
 * IN A GOVERNANCE PRODUCT this is not a generic "don't log secrets" hygiene note — the
 * request bodies this api accepts ARE the governed content: change-request `params`,
 * `justification` text, plan/drift payloads, TOTP codes, session cookies, the scanner's
 * bearer key. A body-logging access logger in this system would put exactly the material
 * the audit chain exists to control INTO a plain-text operator log stream instead, on
 * every request rather than the ones an operator chose to record. That is why this is a
 * hand-written ~15-line middleware and not `hono/logger` (which logs method+path+status
 * only by default, so the *shape* is fine — but the decision needs to be visible and
 * enforced HERE, not inherited silently from a dependency's default, per this repo's
 * "state the policy explicitly" practice — see `domain/retention.ts` for the same move
 * applied to a different finding). `path` is passed through {@link redactSecrets} anyway,
 * on the same reasoning `formatServerError` in `../log.ts` already applies to error text:
 * a route segment could in principle carry something URL- or token-shaped, and query
 * strings are dropped entirely rather than redacted, because redaction can only scrub
 * SHAPES it recognises and a query string is exactly where arbitrary user input goes.
 *
 * The id is minted here, not trusted from an inbound header: an unauthenticated client
 * choosing its own correlation id could poison an operator's log search or spoof
 * correlation with an unrelated request. `X-Request-Id` on the RESPONSE is this system's
 * only channel for it — nothing is echoed into a JSON error body, so this needed no
 * OpenAPI/wire-contract change (see B-S4).
 */
export const withRequestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  const startedAt = Date.now();
  await next();
  const ms = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(redactSecrets(`ccp-api ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms id=${id}`));
};
