/**
 * TEST-4 — a skipped integration suite must not be indistinguishable from a passing one.
 *
 * The suites that prove the request-to-PR/apply pipeline end-to-end are each guarded by
 * `describe.skipIf(<toolchain present>)`: the LIVE terraform plan→pin→apply→halt-on-drift
 * proof, both TS↔Go parity harnesses, and the seam-fixture parity blocks. Every one of
 * them degrades to a silent skip when its dependency is missing, and vitest reports the
 * run as green.
 *
 * That was not hypothetical. These blocks ran in CI only because GitHub's `ubuntu-latest`
 * image happens to preinstall Go and Terraform — an undeclared, unpinned dependency on a
 * runner image. A runner change, a self-hosted runner, or the GitLab mirror (which has no
 * api lane at all) would have turned the highest-value proofs in the repo off, with no
 * signal anywhere. The audit's own run shows the tell: "1137 passed | 1 skipped".
 *
 * This is L-1's lesson in the test suite rather than in a gate: distinguish *"ran and
 * found nothing wrong"* from *"could not run"*. `ccp-api.yml` now installs Go and
 * Terraform explicitly AND sets `CCP_REQUIRE_INTEGRATION=1`, so in CI a missing toolchain
 * is a hard failure naming what is absent, while a developer without terraform installed
 * still gets a clean local skip.
 */

/** True when the run is contractually required to execute every integration suite. */
export function integrationRequired(): boolean {
  return process.env.CCP_REQUIRE_INTEGRATION === '1';
}

/**
 * Decide whether a toolchain-gated suite may skip.
 *
 * Returns the value for `describe.skipIf(...)` — `true` to skip — and THROWS instead when
 * the toolchain is missing in a run that requires it. Throwing at module scope fails the
 * file outright, which is the point: a required proof that cannot run must break the
 * build, not quietly shrink the suite.
 *
 * @param name  what is missing, in the words an operator needs ("the terraform binary")
 * @param present  whether it was found
 * @param hint  how to make it present (a CI step, an install command)
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
