/**
 * ERR-8 / OPS-8 — graceful shutdown for the api process.
 *
 * WHAT WAS WRONG, measured rather than reasoned about. The shipped container ran
 * `CMD ["npm", "run", "start"]`, which is four processes deep — `npm → sh → tsx → node`.
 * Docker signals PID 1 and PID 1 only, so a `docker stop` killed **npm**:
 *
 *     $ kill -TERM <npm>          # exactly what `docker stop` sends PID 1
 *     npm: exited rc=143
 *     writer lock released?  NO — ccp.json.lock survived
 *     listener drained?      NO — an orphan is still serving the port
 *
 * The node running `server.ts` never saw the signal at all. That makes CONC-7's
 * SIGTERM/SIGINT writer-lock handback — real code, with a real test — **completely inert
 * in the shipped image**: it could only ever fire in a dev shell where node is the process
 * being signalled. The container's every stop was a hard kill.
 *
 * Fixing PID 1 (see the Dockerfile) is what makes a handler reachable. This file is what
 * the handler should then DO, and the order is the whole content:
 *
 *  1. **Stop the scheduler first.** A tick that starts during the drain would claim work
 *     this process is about to stop being able to finish. Nothing else can un-start it.
 *  2. **Stop accepting new connections** (`server.close`), then **hang up IDLE keep-alive
 *     sockets** (`closeIdleConnections`). Without step 2b a single idle browser or proxy
 *     connection holds `close()`'s callback until its own keep-alive timeout, so every
 *     shutdown would burn the entire deadline and look like a drain failure.
 *  3. **Let in-flight requests finish**, bounded by a deadline. A request that was told to
 *     expect durability on response deserves its response; a request that will not end
 *     deserves to lose, because the alternative is Docker's SIGKILL taking the decision.
 *  4. **Release the writer lock LAST** — after the drain, because in-flight requests are
 *     still writing through it, and on EVERY path including the deadline, because a lock
 *     left behind makes the next boot clear a lock it cannot prove is dead.
 *
 * EXIT CODE IS 0 EVEN WHEN THE DRAIN TIMES OUT. A timed-out drain is still a shutdown we
 * were *asked* to perform; reporting failure would make `restart: on-failure` supervisors
 * bring the process back up after a deliberate stop. The timeout is surfaced as a loud log
 * line instead, which is the thing an operator can act on. Boot failures are the opposite
 * case and do exit non-zero — see server.ts.
 */

/** The subset of `http.Server` this needs — structural so a test can drive it with a fake. */
export interface DrainableServer {
  close(cb?: (err?: Error) => void): unknown;
  /** Node >=18.2 on http.Server; absent on http2, hence optional. */
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface ShutdownDeps {
  server: DrainableServer;
  /** The auto-apply loop handle, when armed (`maybeStartSchedulerLoop` returns null when not). */
  scheduler?: { stop: () => void } | null;
  /** CONC-7's writer-lock handback — `FileStore.close`. Absent for MemoryStore. */
  releaseStore?: (() => void) | undefined;
  /** How long in-flight requests get before they are cut. Must stay BELOW the compose
   * `stop_grace_period`, so we always exit on our own terms rather than being SIGKILLed
   * halfway through this sequence. */
  deadlineMs?: number;
  exit: (code: number) => void;
  log: (line: string) => void;
}

/** Default drain budget. compose sets `stop_grace_period: 30s` above it, deliberately. */
export const DEFAULT_DRAIN_MS = 15_000;

/**
 * Build the signal handler. Returns a function to register on SIGTERM/SIGINT.
 *
 * Idempotent by construction, and the second signal is an ESCAPE HATCH rather than a
 * no-op: an operator who sends SIGTERM twice is saying "I am not waiting for the drain",
 * and a handler that ignored them would leave `docker stop`'s SIGKILL as the only way out.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DRAIN_MS;
  let phase: 'running' | 'draining' | 'done' = 'running';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (reason: string): void => {
    if (phase === 'done') return;
    phase = 'done';
    if (timer !== undefined) clearTimeout(timer);
    // LAST, and on every path — see the header. A throwing release must not stop the exit,
    // or a store fault would turn a shutdown into a hang.
    try {
      deps.releaseStore?.();
    } catch (e) {
      deps.log(`ccp-api: releasing the store writer lock FAILED during shutdown — ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.log(`ccp-api: shutdown complete (${reason})`);
    deps.exit(0);
  };

  return (signal: string): void => {
    if (phase !== 'running') {
      deps.log(`ccp-api: ${signal} received while already shutting down — exiting now, in-flight requests are being cut`);
      finish(`${signal} twice`);
      return;
    }
    phase = 'draining';
    deps.log(`ccp-api: ${signal} received — draining (up to ${deadlineMs}ms), then exiting`);

    // 1. No new scheduled work. Guarded: a throwing stop() must not skip the drain.
    try {
      deps.scheduler?.stop();
    } catch (e) {
      deps.log(`ccp-api: stopping the scheduler loop FAILED during shutdown — ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3 (armed before 2, so a close() that never calls back cannot hang the process).
    timer = setTimeout(() => {
      deps.log(`ccp-api: drain deadline of ${deadlineMs}ms reached — cutting remaining connections`);
      try {
        deps.server.closeAllConnections?.();
      } catch {
        /* best effort: we are exiting regardless */
      }
      finish('drain timed out');
    }, deadlineMs);

    // 2. Stop accepting, then hang up idle keep-alives so the drain measures real work.
    deps.server.close(() => finish('drained'));
    try {
      deps.server.closeIdleConnections?.();
    } catch {
      /* http2 and old node have no such method; the deadline still bounds us */
    }
  };
}
