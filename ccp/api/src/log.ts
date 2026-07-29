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
export function formatServerError(err: unknown, req?: { method?: string; path?: string }): string {
  const where = req?.method !== undefined || req?.path !== undefined
    ? ` ${req.method ?? '?'} ${req.path ?? '?'}`
    : '';
  if (err instanceof Error) {
    // The stack already begins with "Name: message", so printing both would duplicate it.
    const body = err.stack !== undefined && err.stack.length > 0 ? err.stack : `${err.name}: ${err.message}`;
    return redactSecrets(`ccp-api ERROR${where} — ${body}`);
  }
  // A non-Error throw (`throw 'nope'`, a rejected promise carrying an object) still has to
  // land somewhere legible — this is the case that most often produced silence.
  return redactSecrets(`ccp-api ERROR${where} — non-Error thrown: ${safeInspect(err)}`);
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
export function logServerError(err: unknown, req?: { method?: string; path?: string }): void {
  // eslint-disable-next-line no-console
  console.error(formatServerError(err, req));
}

let processHandlersInstalled = false;

/**
 * Install process-level last-resort logging (`unhandledRejection`, `uncaughtException`).
 *
 * Called from the SERVER ENTRYPOINT, never from `createApp` — installing process handlers
 * inside the app factory would attach a new pair on every test that builds an app, and
 * Node warns and then leaks listeners.
 *
 * Neither handler exits. `uncaughtException` is genuinely undefined behaviour and the
 * textbook advice is to crash — but this process is supervised by compose with
 * `restart: unless-stopped`, and an api that exits on any stray throw is a restart loop
 * that serves nothing. The store's own integrity does not depend on process liveness
 * (every mutation is a completed transact against a snapshot, and DATA-3's fault latch
 * catches a store that has stopped being authoritative), so staying up and LOUD is the
 * better failure mode here than exiting silently. Logging both is the change that matters;
 * the exit policy is a separate decision an operator can make from the evidence.
 */
export function installProcessErrorLogging(): void {
  if (processHandlersInstalled) return; // idempotent: safe if an entrypoint is re-entered
  processHandlersInstalled = true;
  process.on('unhandledRejection', (reason) => {
    logServerError(reason, { method: 'unhandledRejection' });
  });
  process.on('uncaughtException', (err) => {
    logServerError(err, { method: 'uncaughtException' });
  });
}
