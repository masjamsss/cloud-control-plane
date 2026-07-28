/**
 * The bundle claim's lease, in its own module ON PURPOSE.
 *
 * `domain/apply/scheduler.ts` needs this predicate (ARCH-4) and must not import
 * `domain/bundle.ts` to get it: that module spawns processes, and the apply subsystem's
 * INVARIANT #1 is that it never does. The invariant's source-level check scans each
 * file's own TEXT, so a static import of a spawner would have passed it while quietly
 * making the guarantee untrue — the check is now transitive (`test/schedulerGating.test.ts`)
 * and this file is why it can be.
 *
 * Nothing here imports anything. That is the point.
 */

/**
 * How long a `bundle.state:'running'` claim may go without an outcome before another
 * lane may treat it as dead (ERR-2, and ARCH-4's mutual exclusion).
 *
 * Before this, `running` was permanent. The claim is written, the multi-minute bundle
 * runs, and the outcome is recorded — but nothing else in the codebase ever writes
 * `bundle`, and there is no reaper, no timeout and no admin route that resets it. A
 * process crash mid-bundle left the request answering 409 BUNDLE_RUNNING on every future
 * apply, forever.
 *
 * An hour is well past the bundle's own worst case — its longest step timeout is 15
 * minutes and the steps are sequential — so a LIVE run is never robbed of its claim.
 */
export const BUNDLE_LEASE_MS = 60 * 60_000;

/**
 * Is a bundle claim LIVE as of `now` — running, and not past its lease?
 *
 * This lives here rather than inside the route because ARCH-4 needs a SECOND reader.
 * The bundle claim writes `bundle.state:'running'` and deliberately does not move
 * `status`, while the timer-driven scheduler's due filter reads only status + window and
 * never consulted `bundle` at all. With both lanes armed, a Lead's bundle click inside an
 * open window raced the next scheduler tick: the scheduler could claim
 * `AWAITING_DEPLOY_APPROVAL → APPLYING` and run its executor while the bundle was
 * mid-clone, after which the bundle's own result write lost its `ifEquals` guard and
 * surfaced as a 500 — with real side effects already landed (a pushed commit, a satisfied
 * deploy gate) and the request record stuck at `bundle.state:'running'`.
 *
 * Checking the LEASE rather than the bare `'running'` flag is the load-bearing part: a
 * crashed bundle must not wedge the scheduler forever, which would be ERR-2's defect
 * reappearing one lane over. A claim whose `at` cannot be parsed counts as expired — a
 * claim that cannot be aged is one nothing can ever release.
 */
export function bundleClaimLive(
  bundle: { state?: string; at?: string } | undefined,
  now: number,
): boolean {
  if (bundle?.state !== 'running') return false;
  const at = Date.parse(bundle.at ?? '');
  if (!Number.isFinite(at)) return false; // unageable ⇒ expired ⇒ not live
  return now - at < BUNDLE_LEASE_MS;
}
