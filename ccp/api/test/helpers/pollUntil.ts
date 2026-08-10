/**
 * TEST-9 — for tests that assert a fire-and-forget background task did NOT run: there is
 * no completion hook to await for something that (correctly) never started, so a fixed
 * sleep is the only lever — and it is the wrong one both directions. Too short, and an
 * erroneous background task that is merely SLOWER than the sleep produces a false pass
 * (the assertion runs before the bug has had time to manifest). Too generous, and every
 * run of the honest (no-bug) case pays the full wait for nothing.
 *
 * `pollUntil` widens the observation window relative to a fixed sleep AND returns the
 * moment the forbidden condition becomes observable, rather than either wasting the whole
 * window or using too short a one. `driftGenIdle` (domain/driftProposals.ts) is the
 * companion fix for the POSITIVE half of TEST-9 — cases that assert a fire-and-forget task
 * DID run, where a real completion promise exists and should be awaited directly instead.
 *
 * @param check     Polled every `intervalMs`; a `true` return means "the condition this
 *                   test is watching for has happened" — for a "prove nothing happened"
 *                   test, that is the FAILURE condition, so the caller asserts the
 *                   returned value is `false`.
 * @param timeoutMs Total budget before giving up and returning `false`. Default 200ms —
 *                   the same headroom the fixed sleeps this replaces already used at their
 *                   most generous (driftButtons.test.ts's positive wait).
 * @param intervalMs Poll interval. Default 10ms.
 */
export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 200,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
