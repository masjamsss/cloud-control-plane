/**
 * TEST-4 — a skipped integration suite must not be indistinguishable from a passing one.
 *
 * The SPA half. A DELIBERATE COPY of `ccp/api/test/helpers/requireToolchain.ts`, which
 * carries the full rationale: `ccp/app` and `ccp/api` are separate packages with separate
 * `node_modules` and separate `tsconfig` path maps, so importing across the boundary would
 * break both the build and the app's dependency allowlist.
 *
 * Copies diverge (L-8), so keep this one honest: it is nine lines, both sides read the
 * SAME environment variable `CCP_REQUIRE_INTEGRATION`, and both workflows set it. If the
 * contract ever changes, it changes in two files — and the variable name is the thing to
 * grep for.
 *
 * What this guards here is one suite: `src/test/httpApi.integration.test.ts`, which boots
 * the real ccp-api over HTTP and drives login → TOTP enroll → me through the actual
 * cookie/session flow. It needs `ccp/api`'s `tsx`, and the ccp-app CI job installed only
 * `ccp/app`'s deps — so the only proof that the client and the server agree skipped on
 * every CI run since it was written, and said so in its own comment.
 */

/** True when the run is contractually required to execute every integration suite. */
export function integrationRequired(): boolean {
  return process.env.CCP_REQUIRE_INTEGRATION === '1';
}

/**
 * Returns the value for `describe.skipIf(...)` — `true` to skip — and THROWS instead when
 * the dependency is missing in a run that requires it, so a required proof that cannot run
 * breaks the build rather than quietly shrinking the suite.
 */
export function skipUnless(name: string, present: boolean, hint: string): boolean {
  if (present) return false;
  if (integrationRequired()) {
    throw new Error(
      `CCP_REQUIRE_INTEGRATION=1 but ${name} is not available, so this suite would have SKIPPED. ` +
        `A green run that silently dropped an integration proof is the failure this check exists to prevent (TEST-4). ` +
        `Fix: ${hint}`,
    );
  }
  return true;
}
