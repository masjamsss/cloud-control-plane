import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpApiClient } from '@/lib/httpApi';
import { clearApiSession, getApiSessionAccount, setApiSessionAccount } from '@/lib/apiSession';
import type { AuthAccount } from '@/lib/httpApi';

/**
 * FE-5 — api-mode session expiry was never detected, so the UI stayed "signed in" while
 * every call failed.
 *
 * Identity in api mode is the in-memory `apiSession` cache, set at login/TOTP/`me()` and
 * cleared only by an explicit logout. There was NO 401 handling anywhere outside `me()`:
 * a `request()` that came back 401 just surfaced the server's reason. Sessions expire at
 * 12h absolute / 30m idle, so the ordinary path was — idle past the window, click
 * anything, every fetch 401s, and `RequireAuth` (reading the still-populated cache) keeps
 * the user on a page where lists hang on "Loading…" for ever and mutations fail with a
 * bare reason and no route back to sign-in. Recovery required a manual full reload.
 *
 * The fix has two halves and NEITHER works alone: the HTTP layer clears the cache on a
 * session-class 401, and the guards read a SUBSCRIBED account so the clear becomes a
 * redirect. This file pins the first half and the discrimination it depends on — the
 * second half is `guards.tsx` reading `useAuthedAccount()`, which needs a mounted router
 * and so cannot be driven here (no jsdom in this repo — see test/standalone.test.ts's
 * dependency allowlist).
 */

const ACCOUNT: AuthAccount = {
  id: 'u1',
  username: 'lina',
  displayName: 'Lina',
  status: 'active',
  isAdmin: false,
  role: 'lead',
  teamId: 'erp-basis',
  mustChangePassword: false,
  totpEnrolled: true,
  roles: { 'acme-prod': { role: 'lead' } },
};

/** A fetch that always answers with the given status + taxonomy body. */
function fetchReturning(status: number, code: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ code, reason: 'x' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  setApiSessionAccount(ACCOUNT);
});
afterEach(() => {
  clearApiSession();
});

describe('a session-class 401 ends the client’s belief in the session', () => {
  it('THE DEFECT: an expired session used to leave the cache populated', async () => {
    expect(getApiSessionAccount(), 'signed in to begin with').not.toBeNull();

    const client = createHttpApiClient('http://api.test', { fetch: fetchReturning(401, 'SESSION_EXPIRED') });
    await client.listRequests('u1').catch(() => undefined); // the call fails, as it should

    expect(getApiSessionAccount(), 'the cache must be cleared, or the UI stays "signed in"').toBeNull();
  });

  it('clears on every session-class code, not just the one the tester thought of', async () => {
    for (const code of ['NO_SESSION', 'SESSION_EXPIRED', 'SESSION_INVALIDATED']) {
      setApiSessionAccount(ACCOUNT);
      const client = createHttpApiClient('http://api.test', { fetch: fetchReturning(401, code) });
      await client.listRequests('u1').catch(() => undefined);
      expect(getApiSessionAccount(), `${code} must clear the session`).toBeNull();
    }
  });

  it('does NOT clear on a login-attempt 401 — those are about an attempt, not a session', async () => {
    // BAD_CREDENTIALS and TOTP_REQUIRED are also 401. Clearing on them would be wrong in
    // principle and would fight the multi-step login flow, where a TOTP challenge is the
    // EXPECTED answer rather than a failure. "Any 401" is the tempting, wrong rule.
    for (const code of ['BAD_CREDENTIALS', 'TOTP_REQUIRED']) {
      setApiSessionAccount(ACCOUNT);
      const client = createHttpApiClient('http://api.test', { fetch: fetchReturning(401, code) });
      await client.listRequests('u1').catch(() => undefined);
      expect(getApiSessionAccount(), `${code} must NOT clear the session`).not.toBeNull();
    }
  });

  it('does not clear on a 403 — an authorization refusal leaves you signed in', async () => {
    const client = createHttpApiClient('http://api.test', { fetch: fetchReturning(403, 'PROJECT_SCOPE') });
    await client.listRequests('u1').catch(() => undefined);
    expect(getApiSessionAccount()).not.toBeNull();
  });

  it('does not clear on a 401 with no recognisable body', async () => {
    // A proxy's own HTML 401, say. Nothing says the SESSION ended, so nothing is assumed.
    const noBody = (async () => new Response('<html>nope</html>', { status: 401 })) as unknown as typeof fetch;
    const client = createHttpApiClient('http://api.test', { fetch: noBody });
    await client.listRequests('u1').catch(() => undefined);
    expect(getApiSessionAccount()).not.toBeNull();
  });

  it('leaves the response body readable by the caller — the check must not consume it', async () => {
    // The 401 peek clones the response. Reading the original here would have thrown
    // "Body is unusable", and every error path in httpApi.ts reads it for its message.
    const client = createHttpApiClient('http://api.test', { fetch: fetchReturning(401, 'SESSION_EXPIRED') });
    await expect(client.listRequests('u1')).rejects.toThrow('x');
  });
});
