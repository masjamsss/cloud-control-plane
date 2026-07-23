/**
 * Deploy/runtime configuration surface ("real-host deploy story").
 *
 * ADDITIVE + CONFIG ONLY: nothing here touches authz, quorum, or the audit-chain
 * semantics. It centralises the env that a REAL host needs — secure-cookie posture,
 * credentialed-CORS origins, durable-store selection — and a production PREFLIGHT
 * that fails closed on an insecure/incomplete config so the backend refuses to boot
 * rather than serve sessions over plaintext or with no browser origin.
 *
 * TLS is assumed to be terminated by an EXTERNAL reverse proxy (nginx/ALB/etc.);
 * this process speaks HTTP behind it and drives `Secure` cookies off env, not off
 * an in-process certificate. See ccp/api/README.md "Deploy".
 */

import { join } from 'node:path';
import { PROJECT_ID_RE } from './projects';

export type Env = NodeJS.ProcessEnv;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/** Parse a boolean-ish flag; unset or unrecognised → undefined (caller decides the default). */
export function boolFlag(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return undefined;
}

export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/** `CCP_STORE=memory` selects the process-bound store (tests / throwaway dev). */
export function isMemoryStore(env: Env = process.env): boolean {
  return env.CCP_STORE === 'memory';
}

/**
 * The resolved durable data-file path, or `null` for the in-memory store. Shared by
 * the server entrypoint and the backup/restore scripts so they agree on which file
 * is authoritative. `CCP_DATA_FILE` wins; else `<CCP_DATA_DIR>/ccp.json`.
 */
export function resolveDataFile(env: Env = process.env): string | null {
  if (isMemoryStore(env)) return null;
  const dir = env.CCP_DATA_DIR || '.ccp-data';
  return env.CCP_DATA_FILE || join(dir, 'ccp.json');
}

/** The pre-data-birth legacy estate id, or null when this install has none
 *  (every fresh install). Consulted ONLY by the one-time boot settlement
 *  (domain/settlement.ts) on a store without a SETTLEMENT marker; inert
 *  afterwards. A set-but-malformed value throws — fail closed, name the fix. */
export function legacyProjectId(env: Env = process.env): string | null {
  const raw = (env.CCP_LEGACY_PROJECT_ID ?? '').trim();
  if (raw === '') return null;
  if (!PROJECT_ID_RE.test(raw)) {
    throw new Error(
      `CCP_LEGACY_PROJECT_ID='${raw}' is not a valid project id (must match ${PROJECT_ID_RE}) — unset it on a fresh install, or set the exact id your pre-multi-project store used.`,
    );
  }
  return raw;
}

/**
 * Are session cookies marked `Secure`? Explicit `CCP_SECURE_COOKIES` wins;
 * otherwise the default is ON in production and OFF elsewhere so local dev/tests
 * keep working over http.
 */
export function resolveSecureCookies(env: Env = process.env): boolean {
  return boolFlag(env.CCP_SECURE_COOKIES) ?? isProduction(env);
}

export type SameSite = 'Lax' | 'Strict' | 'None';

/**
 * `SameSite` for the session cookie. Default `Lax` (unchanged from B2). A CROSS-ORIGIN
 * SPA that calls the API with credentials needs `None` (+ `Secure`) for the browser to
 * attach the cookie on cross-site fetches; a same-origin deploy keeps `Lax`/`Strict`.
 * CSRF is enforced by the `x-ccp-client` header (middleware/session.ts), NOT by
 * SameSite, so this knob does not change the CSRF posture.
 */
export function resolveSameSite(env: Env = process.env): SameSite {
  const raw = (env.CCP_COOKIE_SAMESITE ?? '').trim().toLowerCase();
  if (raw === 'strict') return 'Strict';
  if (raw === 'none') return 'None';
  return 'Lax';
}

export type SessionCookieOptions = { httpOnly: true; sameSite: SameSite; secure: boolean; path: '/' };

/** The `hono/cookie` options for the session cookie — env-aware, resolved at set-time. */
export function sessionCookieOptions(env: Env = process.env): SessionCookieOptions {
  return { httpOnly: true, sameSite: resolveSameSite(env), secure: resolveSecureCookies(env), path: '/' };
}

/**
 * Allowed browser origins for credentialed CORS (comma-separated `CCP_CORS_ORIGIN`).
 * Empty = no cross-origin browser access. With credentials the spec forbids `*`, so the
 * edge echoes ONLY an exact allow-listed origin.
 */
export function corsOrigins(env: Env = process.env): string[] {
  return (env.CCP_CORS_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Thrown by `assertDeployable` — carries the list of fatal config problems. */
export class DeployConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`insecure/incomplete production config:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'DeployConfigError';
  }
}

/**
 * PRODUCTION PREFLIGHT. Returns the list of fatal problems (empty = deployable).
 * Only enforced when `NODE_ENV=production` — dev and the test suite are unconstrained,
 * so nothing here can regress local flows or B2's restart-survival proof (which boots
 * with `NODE_ENV=development`). Fail closed: a real host must not serve with any of these.
 */
export function deployProblems(env: Env = process.env): string[] {
  if (!isProduction(env)) return [];
  const problems: string[] = [];

  if (isMemoryStore(env)) {
    problems.push(
      'CCP_STORE=memory is not durable — a restart would drop every account, session, and the audit chain. Use the default durable FileStore in production (unset CCP_STORE; set CCP_DATA_DIR).',
    );
  }
  if (!resolveSecureCookies(env)) {
    problems.push(
      'CCP_SECURE_COOKIES is disabled in production — session cookies would be accepted over plaintext HTTP. Enable Secure cookies (they are on by default in production; do not set CCP_SECURE_COOKIES=false behind TLS).',
    );
  }
  if (resolveSameSite(env) === 'None' && !resolveSecureCookies(env)) {
    problems.push('CCP_COOKIE_SAMESITE=None requires Secure cookies — browsers reject a SameSite=None cookie without Secure.');
  }
  if (corsOrigins(env).length === 0 && boolFlag(env.CCP_SAME_ORIGIN) !== true) {
    problems.push(
      'CCP_CORS_ORIGIN is empty — no browser origin can authenticate cross-site. Set the SPA origin(s) (comma-separated), or set CCP_SAME_ORIGIN=1 if the SPA is served same-origin behind the reverse proxy.',
    );
  }
  if (!(env.CCP_TOTP_KEY && env.CCP_TOTP_KEY.length > 0)) {
    problems.push(
      'CCP_TOTP_KEY is unset — the TOTP secret cipher has no key, so privileged (approver/lead/admin) enrollment and verification would fail at runtime. Set a stable high-entropy value.',
    );
  }
  return problems;
}

/** Throw `DeployConfigError` if the production config is not deployable. No-op outside production. */
export function assertDeployable(env: Env = process.env): void {
  const problems = deployProblems(env);
  if (problems.length > 0) throw new DeployConfigError(problems);
}
