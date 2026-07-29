/**
 * The one place a rejected async call becomes something the UI can render.
 *
 * Pure and React-free (the `*Flow.ts` doctrine — see
 * features/drift/proposalFlow.ts's header: this repo has no jsdom, so every
 * async rule has to be unit-testable without mounting a component).
 *
 * Why this exists: the api clients map non-2xx *responses* onto structured
 * `{ok:false, reason}` results, but a rejected `fetch` — a dropped Wi-Fi
 * link, DNS failure, a proxy 502, an api restart mid-deploy — is a promise
 * REJECTION, not a result. Every call site that only wrote a success branch
 * therefore had no path at all for the most ordinary production failure
 * there is: the busy flag never cleared, the `loading` flag never cleared,
 * and the only recovery was a full page reload (FE-1 / FE-2 / UI-1 / UI-4).
 *
 * The contract here is deliberately narrow: `attempt` NEVER rejects. A
 * caller that awaits it is structurally incapable of stranding its own
 * busy/loading state, which is stronger than asking every future call site
 * to remember a `.catch`.
 */

/**
 * What a rejected call says when the error carries nothing better. Kept as
 * one exported constant rather than retyped per screen — the same fact
 * deserves the same phrasing ("one fact, one phrasing"), and a test can pin
 * it.
 */
export const NETWORK_FAILURE_MESSAGE =
  'Could not reach the server — check your connection and try again.';

/**
 * Turn anything a rejected promise can carry into a sentence a user can
 * read. An `Error` thrown by the api seam (plain `Error`, or
 * `httpApi.ts`'s `ApiRefusalError`) already carries a server-authored
 * reason — `readError` guarantees a non-empty one — so its message is
 * surfaced as-is; anything else falls back.
 *
 * `TypeError` is special-cased FIRST because that is exactly what a failed
 * `fetch` rejects with, and "Failed to fetch" / "NetworkError when
 * attempting to fetch resource" is browser-internal text that varies per
 * engine and means nothing to a requester.
 */
export function failureReason(err: unknown, fallback: string = NETWORK_FAILURE_MESSAGE): string {
  if (err instanceof TypeError) return fallback; // a rejected fetch — never show the engine's own wording
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

/** The result of an {@link attempt}: the value, or a renderable reason. */
export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Run `run` and fold BOTH outcomes into a value. Never rejects, never
 * throws — including when `run` throws synchronously before returning a
 * promise (a seam that is `undefined`, a bad argument), which a bare
 * `promise.catch(…)` at the call site would miss entirely.
 */
export async function attempt<T>(
  run: () => Promise<T> | T,
  fallback: string = NETWORK_FAILURE_MESSAGE,
): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, reason: failureReason(err, fallback) };
  }
}
