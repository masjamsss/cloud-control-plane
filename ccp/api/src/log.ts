import { redactSecrets } from './redact';

/**
 * OPS-2 — the api's own faults left no evidence.
 *
 * `registerErrorHandler` mapped every non-`ApiError` exception to `{code:"INTERNAL"}` 500
 * and logged NOTHING: no message, no stack, no route. And there was no
 * `unhandledRejection`/`uncaughtException` handler anywhere in the api. So any bug-class
 * failure — a store I/O error, a `TypeError` in a route, a throw inside
 * `transactWithAudit` — showed the user "Internal error.", showed
 * `docker compose logs api` an empty screen, and left an operator with no way to diagnose
 * a recurring 500 or even to notice one.
 *
 * For a system whose entire selling point is evidence, that is the sharpest possible
 * omission: it kept a hash-linked audit chain of everything users did and no record at all
 * of its own failures.
 *
 * WHAT IS LOGGED, AND WHAT IS NOT. The message, the stack, and the method+path — enough to
 * find the code and the request shape. Never the body, the query string, headers or
 * cookies: those carry credentials by construction, and a log is the one place a secret
 * outlives the request that carried it. What does get through is passed through
 * {@link redactSecrets} anyway, because an error message can quote a URL or a token that
 * some intermediate layer interpolated.
 */

/** One line of structured, greppable text. Pure, so a test can assert on it exactly. */
export function formatServerError(err: unknown, req?: { method?: string; path?: string; requestId?: string }): string {
  const where = req?.method !== undefined || req?.path !== undefined
    ? ` ${req.method ?? '?'} ${req.path ?? '?'}`
    : '';
  // OPS-7 — threads withRequestLog's per-request id through, so a fault in the access
  // log and a fault in this log are the SAME line an operator can grep for. Absent for
  // the process-level handlers below (unhandledRejection/uncaughtException fire outside
  // any one request's context and never had an id to thread).
  const withId = req?.requestId !== undefined ? ` id=${req.requestId}` : '';
  if (err instanceof Error) {
    // The stack already begins with "Name: message", so printing both would duplicate it.
    const body = err.stack !== undefined && err.stack.length > 0 ? err.stack : `${err.name}: ${err.message}`;
    return redactSecrets(`ccp-api ERROR${where}${withId} — ${body}`);
  }
  // A non-Error throw (`throw 'nope'`, a rejected promise carrying an object) still has to
  // land somewhere legible — this is the case that most often produced silence.
  return redactSecrets(`ccp-api ERROR${where}${withId} — non-Error thrown: ${safeInspect(err)}`);
}

function safeInspect(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v); // circular, or a throwing toJSON
  }
}

/** Write a server-side error to stderr. The single choke point, so redaction cannot be skipped. */
export function logServerError(err: unknown, req?: { method?: string; path?: string; requestId?: string }): void {
  // eslint-disable-next-line no-console
  console.error(formatServerError(err, req));
}

let processHandlersInstalled = false;

/**
 * Which half of its life the process is in. `boot` until the listener is actually up.
 *
 * This is the distinction R-16 was missing — see {@link installProcessErrorLogging}.
 */
let phase: 'boot' | 'serving' = 'boot';

/**
 * Called by the entrypoint once `serve()` has bound the port. Everything before this
 * point is boot; everything after is steady state, and the two want opposite policies.
 */
export function markProcessServing(): void {
  phase = 'serving';
}

/** Test seam: put the phase back so a suite can exercise both policies. */
export function __resetProcessPhaseForTests(): void {
  phase = 'boot';
}

/**
 * Install process-level last-resort logging (`unhandledRejection`, `uncaughtException`).
 *
 * Called from the SERVER ENTRYPOINT, never from `createApp` — installing process handlers
 * inside the app factory would attach a new pair on every test that builds an app, and
 * Node warns and then leaks listeners.
 *
 * ── THE EXIT POLICY IS PHASE-DEPENDENT (ERR-8 / OPS-8, resolving R-16) ──────────────
 *
 * R-16 recorded that neither handler exits, and gave the right reason for a *serving*
 * process: it is supervised with `restart: unless-stopped`, so an api that exits on any
 * stray throw is a restart loop that serves nothing, and staying up and LOUD is the better
 * failure mode. That reasoning is kept, unchanged, for the serving phase.
 *
 * It does not survive being applied to BOOT, and measuring it is what showed why. With a
 * corrupt store file — the exact case ERR-8 names — the shipped process did this:
 *
 *     ccp-api ERROR unhandledRejection ? — SyntaxError: ... is not valid JSON
 *         at FileStore.load (src/store/fileStore.ts:144:27)
 *         at async start (src/server.ts:91:17)
 *     RESULT: exited rc=0
 *
 * **A fatal boot failure reported SUCCESS.** `void start()` had no catch, the rejection
 * reached this non-exiting handler, the handler returned, and with no listener bound there
 * was nothing left to keep the event loop alive — so Node ran out of work and exited
 * cleanly. Every consumer of that exit code was told the api started: `docker run` without
 * a restart policy, a Kubernetes `restartPolicy: OnFailure`, systemd `Restart=on-failure`,
 * and `install.sh`'s `compose up ... || die`. This is L-1's shape at the process level — a
 * boot that could not happen looked exactly like a boot that succeeded — and it is a
 * failure mode OPS-2 introduced, since before it the same rejection crashed non-zero.
 *
 * So: **before the listener is up, a process-level fault is fatal and exits 1; after it,
 * it is logged and survived.** The invariant that makes both correct is the same one:
 * report the truth to the supervisor. A process that has not bound a port will never serve
 * this request or any other, and non-zero is the only signal that says so.
 */
export function installProcessErrorLogging(): void {
  if (processHandlersInstalled) return; // idempotent: safe if an entrypoint is re-entered
  processHandlersInstalled = true;
  process.on('unhandledRejection', (reason) => {
    logServerError(reason, { method: 'unhandledRejection' });
    exitIfBoot();
  });
  process.on('uncaughtException', (err) => {
    logServerError(err, { method: 'uncaughtException' });
    exitIfBoot();
  });
}

function exitIfBoot(): void {
  if (phase !== 'boot') return;
  // eslint-disable-next-line no-console
  console.error('ccp-api: the failure above happened during BOOT, before the port was bound — exiting non-zero so the supervisor sees a failed start rather than a healthy container that serves nothing.');
  process.exit(1);
}
