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
let corsMemo: { raw: string; origins: string[] } | null = null;

export function corsOrigins(env: Env = process.env): string[] {
  const raw = env.CCP_CORS_ORIGIN ?? '';
  // Memoized on the RAW string, so a deploy still sets CCP_CORS_ORIGIN without a
  // rebuild and a test can still flip it mid-process — the memo re-derives the
  // moment the value differs. Without it this splits, trims and filters on every
  // single request (the CORS origin callback runs per request, before anything
  // else), which is pure repeated work for a value that essentially never changes.
  if (corsMemo !== null && corsMemo.raw === raw) return corsMemo.origins;
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Frozen: callers used to get a fresh array each time and could mutate it
  // harmlessly. They now share one, and this is the allow-list for credentialed
  // CORS — a stray push into it would widen who may authenticate, process-wide.
  Object.freeze(origins);
  corsMemo = { raw, origins };
  return origins;
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

/**
 * ARCH-11 — ARMING-FLAG COMBINATION WARNINGS.
 *
 * Every one of the ~35 `CCP_*` arming flags across this codebase is individually
 * fail-closed (a genuine strength: an unset flag never half-enables its lane), but
 * nothing anywhere reasons about a flag set in a COMBINATION that can never do
 * anything — a sub-flag armed for a lane whose gate is off, so the code path that
 * would ever consult it is unreachable. That silence is exactly how an operator
 * ends up debugging "why doesn't drift-proposal generation ever run" with every
 * individual flag correctly spelled.
 *
 * This is deliberately advisory, not a `deployProblems` entry: unlike the
 * production security preflight above (an insecure config is refused outright),
 * a dead sub-flag is inert, not unsafe — nothing here can accidentally admit an
 * unauthenticated caller or serve a session over plaintext, so failing the whole
 * boot over it would be a disproportionate response to a `low`-severity paper cut.
 * Printed at boot (any NODE_ENV — a local dev misconfiguring the same flags
 * deserves the same nudge) alongside the scheduler/settlement banners
 * server.ts already logs, never thrown.
 *
 * Each case below was verified by reading the ONE call site that ever consults
 * the sub-flag's value, and confirming that call site is unreachable while the
 * flag it depends on is unset — this is not a speculative "these seem related"
 * list. A flag combination that legitimately has two independent, valid uses
 * (e.g. `CCP_FORGE_SEAL_KEY` set ahead of arming the scanner later — the
 * credential's own PUT route is not gated on `CCP_SCANNER` at all) is
 * deliberately NOT included here; warning about a legitimate "prepare now, arm
 * later" workflow would just teach operators to ignore this list.
 */
export function deployWarnings(env: Env = process.env): string[] {
  const warnings: string[] = [];

  const driftArmed = env.CCP_DRIFT === '1';
  if (!driftArmed) {
    // Every consumer of these three sub-flags is reached only from
    // routes/drift.ts's PUT /:id/drift handler, which refuses DRIFT_DISARMED
    // before any of them are checked, generation.ts's own doc comment.
    if (env.CCP_DRIFT_PROPOSALS === '1') {
      warnings.push(
        'CCP_DRIFT_PROPOSALS=1 is set, but CCP_DRIFT is not — drift-proposal generation is triggered only from the report-upload route, which refuses every upload (DRIFT_DISARMED) while CCP_DRIFT is unset. Set CCP_DRIFT=1 as well, or unset CCP_DRIFT_PROPOSALS.',
      );
    }
    if (env.CCP_DRIFT_IMPORT === '1') {
      warnings.push(
        'CCP_DRIFT_IMPORT=1 is set, but CCP_DRIFT is not — the import-flavor submit gate is checked only after the top-level CCP_DRIFT arming, which refuses the request first. Set CCP_DRIFT=1 as well, or unset CCP_DRIFT_IMPORT.',
      );
    }
    if (env.CCP_DRIFT_RESTORE === '1') {
      warnings.push(
        'CCP_DRIFT_RESTORE=1 is set, but CCP_DRIFT is not — the restore-flavor submit gate is checked only after the top-level CCP_DRIFT arming, which refuses the request first. Set CCP_DRIFT=1 as well, or unset CCP_DRIFT_RESTORE.',
      );
    }
  }

  // CCP_EXECUTOR is read in exactly one place, apply/loop.ts's selectExecutor,
  // itself constructed only when the timer-driven scheduler starts
  // (CCP_SCHEDULER=1). It has no effect on the bundle lane (CCP_BUNDLE), which
  // runs its own separate CCP_BUNDLE_TRIGGER_CMD shell command instead.
  if (env.CCP_EXECUTOR === 'terraform' && env.CCP_SCHEDULER !== '1') {
    warnings.push(
      'CCP_EXECUTOR=terraform is set, but CCP_SCHEDULER is not — CCP_EXECUTOR only selects the auto-apply SCHEDULER lane\'s executor, which never starts without CCP_SCHEDULER=1. If you meant the approval-bundle lane to run terraform, that is governed separately by CCP_BUNDLE_TRIGGER_CMD.',
    );
  }

  // The bundle lane requires ALL THREE of CCP_BUNDLE + CCP_BUNDLE_GATE_CMD +
  // CCP_BUNDLE_TRIGGER_CMD (domain/bundle.ts's bundleArmed) — missing any one
  // leaves it silently, fully disarmed rather than partially live, which is
  // the right runtime behavior but an easy typo to never notice.
  if (env.CCP_BUNDLE === '1' && !(env.CCP_BUNDLE_GATE_CMD && env.CCP_BUNDLE_TRIGGER_CMD)) {
    const missing = [
      !env.CCP_BUNDLE_GATE_CMD && 'CCP_BUNDLE_GATE_CMD',
      !env.CCP_BUNDLE_TRIGGER_CMD && 'CCP_BUNDLE_TRIGGER_CMD',
    ].filter((v): v is string => v !== false);
    warnings.push(
      `CCP_BUNDLE=1 is set, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not — the bundle lane requires all three (CCP_BUNDLE + CCP_BUNDLE_GATE_CMD + CCP_BUNDLE_TRIGGER_CMD) and stays fully disarmed until every one is set.`,
    );
  }

  // githubAppConfig() (domain/forgeCredentials.ts) has exactly one call site,
  // resolveCloneAuth in routes/scanJobs.ts, reached only from the scanner
  // worker's /claim route behind its own CCP_SCANNER + CCP_SCANNER_KEY gate.
  const scannerArmed = env.CCP_SCANNER === '1' && !!env.CCP_SCANNER_KEY && env.CCP_SCANNER_KEY.length >= 32;
  if (!scannerArmed && (env.CCP_GITHUB_APP_ID || env.CCP_GITHUB_APP_KEY || env.CCP_GITHUB_APP_KEY_FILE)) {
    warnings.push(
      'A GitHub App is configured (CCP_GITHUB_APP_ID/KEY), but the scanner is not armed (CCP_SCANNER=1 + a >=32-char CCP_SCANNER_KEY) — the App credential is only ever consulted from the scanner worker\'s claim route, which stays closed without both.',
    );
  }

  return warnings;
}
