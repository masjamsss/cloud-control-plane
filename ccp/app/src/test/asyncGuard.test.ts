import { describe, expect, it } from 'vitest';
import { NETWORK_FAILURE_MESSAGE, attempt, failureReason } from '@/lib/asyncGuard';

/**
 * FE-1 / FE-2 — the seam that turns a rejected call into something renderable.
 *
 * The api clients map non-2xx *responses* onto `{ok:false, reason}` results, but a
 * rejected `fetch` — dropped link, DNS failure, proxy 502, an api restart mid-deploy —
 * is a promise REJECTION, not a result. Call sites that wrote only a success branch had
 * no path at all for the most ordinary production failure there is: the busy flag never
 * cleared, `loading` never cleared, and the only recovery was a full page reload.
 *
 * What is pinned here is the CONTRACT the fix rests on, because every call site's
 * correctness is inherited from it: `attempt` NEVER rejects, for any input, including
 * the ones a call-site `.catch` would miss. If that is ever weakened, the screens that
 * dropped their own `try/catch` in favour of it strand again — silently, since nothing
 * else would fail.
 *
 * No jsdom in this repo (see test/standalone.test.ts's dependency allowlist), and no
 * `vi.fn` (see authFlow.test.ts) — hand-rolled fakes throughout.
 */

describe('failureReason — a rejection becomes a sentence', () => {
  it('surfaces a server-authored Error message as-is', () => {
    // httpApi.ts's readError guarantees a non-empty reason, so this is the useful case:
    // the server already said something better than any fallback could.
    expect(failureReason(new Error('Your session expired — sign in again.'))).toBe(
      'Your session expired — sign in again.',
    );
  });

  it('replaces a TypeError with the fallback — a failed fetch rejects with one, and its wording is engine-internal', () => {
    // "Failed to fetch" (Chromium) / "NetworkError when attempting to fetch resource"
    // (Firefox) / "Load failed" (WebKit) are all this same case. A requester should
    // never be shown any of them.
    expect(failureReason(new TypeError('Failed to fetch'))).toBe(NETWORK_FAILURE_MESSAGE);
    expect(failureReason(new TypeError('Load failed'))).toBe(NETWORK_FAILURE_MESSAGE);
  });

  it('falls back for an Error with an empty message, rather than rendering an empty error line', () => {
    expect(failureReason(new Error(''))).toBe(NETWORK_FAILURE_MESSAGE);
  });

  it('falls back for anything that is not an Error at all', () => {
    // `throw 'nope'`, a rejected promise carrying undefined, a thrown object.
    expect(failureReason('nope')).toBe(NETWORK_FAILURE_MESSAGE);
    expect(failureReason(undefined)).toBe(NETWORK_FAILURE_MESSAGE);
    expect(failureReason({ code: 500 })).toBe(NETWORK_FAILURE_MESSAGE);
  });

  it('honours a caller-supplied fallback, so a screen can name what failed to load', () => {
    expect(failureReason(new TypeError('Failed to fetch'), 'Could not load the drift report.')).toBe(
      'Could not load the drift report.',
    );
  });
});

describe('attempt — never rejects, which is the whole guarantee', () => {
  it('folds a resolved value into ok:true', async () => {
    await expect(attempt(() => Promise.resolve(42))).resolves.toEqual({ ok: true, value: 42 });
  });

  it('folds a rejected promise into ok:false with a renderable reason', async () => {
    await expect(attempt(() => Promise.reject(new TypeError('Failed to fetch')))).resolves.toEqual({
      ok: false,
      reason: NETWORK_FAILURE_MESSAGE,
    });
  });

  it('folds a SYNCHRONOUS throw too — the case a call-site `.catch` misses entirely', async () => {
    // `client.thing().catch(…)` never runs the catch if `client.thing` itself throws
    // before returning a promise (an undefined seam, a bad argument). That is why the
    // guard wraps the CALL, not the promise.
    await expect(
      attempt(() => {
        throw new Error('seam is not wired');
      }),
    ).resolves.toEqual({ ok: false, reason: 'seam is not wired' });
  });

  it('accepts a non-async function, so a call site need not know which kind it has', async () => {
    await expect(attempt(() => 'sync value')).resolves.toEqual({ ok: true, value: 'sync value' });
  });

  it('preserves a falsy resolved value instead of mistaking it for failure', async () => {
    // The tempting shape — `const v = await run(); return v ? ok : fail` — breaks here.
    await expect(attempt(() => Promise.resolve(0))).resolves.toEqual({ ok: true, value: 0 });
    await expect(attempt(() => Promise.resolve(false))).resolves.toEqual({ ok: true, value: false });
    await expect(attempt(() => Promise.resolve(null))).resolves.toEqual({ ok: true, value: null });
  });

  it('never rejects for ANY of the shapes a rejection can carry', async () => {
    // The property, stated directly. A rejection escaping here is the stranded-spinner
    // bug returning, so it is asserted against the whole family rather than one example.
    const thrown: unknown[] = [new TypeError('x'), new Error('y'), 'z', undefined, null, 0, { a: 1 }];
    for (const t of thrown) {
      const outcome = await attempt(() => Promise.reject(t));
      expect(outcome.ok, `rejection carrying ${String(t)} must not escape`).toBe(false);
      if (!outcome.ok) expect(outcome.reason.length).toBeGreaterThan(0);
    }
  });
});
