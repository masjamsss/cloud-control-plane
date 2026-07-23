import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthAccount, AuthResult, HttpApiClient, LoginResult } from '@/lib/httpApi';
import {
  apiLogin,
  completeChangePassword,
  completeEnrollTotp,
  completeRecoveryLogin,
  completeVerifyTotp,
  hydrateApiSession,
  isValidTotpCode,
  nextAuthStep,
  parseOtpauthSecret,
} from '@/features/auth/authFlow';
import { clearApiSession, consumeRecoveryLoginFlag, getApiSessionAccount } from '@/lib/apiSession';

/**
 * Unit coverage for the authoritative auth bridge (0015 §B3 Task 1/2). The
 * LoginPage screens are thin views over these helpers — this repo has no jsdom
 * (test/standalone.test.ts pins the dep allowlist), so the branching + session
 * wiring is proven HERE against a fake {@link HttpApiClient}, and TOTP codes are
 * driven by a hand-rolled RFC 6238 generator (mirrors httpApi.integration.test.ts)
 * that is itself checked against the RFC's published test vector.
 */

// ---- hand-rolled RFC 6238 TOTP (SHA1 / 6 digits / 30s — otplib authenticator) ----
function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '')) {
    const idx = A.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totpAt(secret: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

// RFC 6238 Appendix B: seed = ASCII "12345678901234567890" (its base32), and at
// T=59s the SHA1 TOTP is 94287082 → the 6-digit truncation is 287082.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const account: AuthAccount = {
  id: 'putra',
  username: 'putra',
  displayName: 'Putra',
  role: 'lead',
  teamId: 'platform',
  status: 'active',
  isAdmin: true,
  mustChangePassword: false,
  totpEnrolled: true,
};

function authResult(over: Partial<AuthAccount> = {}): AuthResult {
  return { user: { ...account, ...over }, mustChangePassword: false };
}

/** A full-session AuthResult STILL pinned to a temporary password — both the
 * top-level flag and the account's own flag set, exactly as ccp-api's
 * /auth/me and the TOTP responses return it while mustChangePassword holds. */
function mustChangeAuth(): AuthResult {
  return { user: { ...account, mustChangePassword: true }, mustChangePassword: true };
}

/** A fake HttpApiClient — only the identity methods under test are real; the rest
 * throw so an accidental call is loud, not silent. */
function fakeClient(over: Partial<HttpApiClient> = {}): HttpApiClient {
  const notUsed = (): never => {
    throw new Error('fakeClient: method not stubbed for this test');
  };
  return {
    serverInfo: notUsed,
    listManifests: notUsed,
    getInventory: notUsed,
    listRequests: notUsed,
    getRequest: notUsed,
    submitRequest: notUsed,
    approveRequest: notUsed,
    rejectRequest: notUsed,
    listPendingApprovals: notUsed,
    listAllRequests: notUsed,
    login: notUsed,
    completeTotp: notUsed,
    enrollTotp: notUsed,
    completeTotpRecovery: notUsed,
    changePassword: notUsed,
    me: notUsed,
    logout: notUsed,
    ...over,
  } as unknown as HttpApiClient;
}

/** A hand-rolled spy (this repo doesn't use vitest's vi.fn — see the integration
 * test's hand-rolled cookie jar). Records the last argument it was called with. */
function spy<T extends unknown[], R>(
  impl: (...args: T) => R,
): ((...args: T) => R) & { calls: T[] } {
  const fn = (...args: T): R => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [] as T[];
  return fn;
}

beforeEach(() => {
  clearApiSession();
});

describe('RFC 6238 generator — matches the published test vector', () => {
  it('produces 287082 for the RFC seed at T=59s (SHA1/6-digit)', () => {
    expect(totpAt(RFC_SECRET, 59)).toBe('287082');
  });
});

describe('nextAuthStep — the mandatory interstitial precedence', () => {
  const base: LoginResult = { user: account, mustChangePassword: false };
  it('enrolment beats everything when a secret is offered', () => {
    expect(
      nextAuthStep({
        ...base,
        totpEnrollment: { secret: 'S', otpauthUri: 'otpauth://x' },
        totpRequired: true,
      }),
    ).toBe('enroll-totp');
  });
  it('an enrolled privileged account is challenged', () => {
    expect(nextAuthStep({ ...base, totpRequired: true })).toBe('verify-totp');
  });
  it('a temporary password is the next gate', () => {
    expect(nextAuthStep({ ...base, mustChangePassword: true })).toBe('change-password');
  });
  it('an ordinary account goes straight in', () => {
    expect(nextAuthStep(base)).toBe('done');
  });
});

describe('isValidTotpCode', () => {
  it('accepts exactly six digits (trimmed)', () => {
    expect(isValidTotpCode('287082')).toBe(true);
    expect(isValidTotpCode('  000000 ')).toBe(true);
  });
  it('rejects wrong length or non-digits', () => {
    expect(isValidTotpCode('12345')).toBe(false);
    expect(isValidTotpCode('1234567')).toBe(false);
    expect(isValidTotpCode('12a456')).toBe(false);
    expect(isValidTotpCode('')).toBe(false);
  });
});

describe('parseOtpauthSecret', () => {
  it('extracts the base32 secret from an otpauth URI', () => {
    const uri = `otpauth://totp/Cloud%20Control%20Plane:putra?secret=${RFC_SECRET}&issuer=Cloud%20Control%20Plane&digits=6`;
    expect(parseOtpauthSecret(uri)).toBe(RFC_SECRET);
  });
  it('returns null when there is no secret param', () => {
    expect(parseOtpauthSecret('otpauth://totp/Cloud%20Control%20Plane:putra?issuer=Cloud%20Control%20Plane')).toBeNull();
  });
});

describe('apiLogin — routes to the right step and only opens a session when done', () => {
  it('routes a first-login privileged account to enrolment without a session yet', async () => {
    const client = fakeClient({
      login: async () => ({
        user: account,
        mustChangePassword: false,
        totpRequired: true,
        totpEnrollment: { secret: RFC_SECRET, otpauthUri: 'otpauth://x' },
      }),
    });
    const out = await apiLogin(client, 'putra', 'pw');
    expect(out).toMatchObject({ ok: true, step: 'enroll-totp' });
    expect(getApiSessionAccount()).toBeNull();
  });

  it('routes an enrolled privileged account to the challenge without a session yet', async () => {
    const client = fakeClient({
      login: async () => ({ user: account, mustChangePassword: false, totpRequired: true }),
    });
    const out = await apiLogin(client, 'putra', 'pw');
    expect(out).toMatchObject({ ok: true, step: 'verify-totp' });
    expect(getApiSessionAccount()).toBeNull();
  });

  it('an ordinary account opens the session immediately', async () => {
    const client = fakeClient({
      login: async () => ({
        user: { ...account, role: 'requester', isAdmin: false },
        mustChangePassword: false,
      }),
    });
    const out = await apiLogin(client, 'dewi', 'pw');
    expect(out).toMatchObject({ ok: true, step: 'done' });
    expect(getApiSessionAccount()?.id).toBe('putra');
    expect(getApiSessionAccount()?.role).toBe('requester');
    expect(getApiSessionAccount()?.isAdmin).toBe(false);
  });

  it('surfaces the server reason on a rejected login, with no session', async () => {
    const client = fakeClient({
      login: async () => {
        throw new Error('Wrong username or password.');
      },
    });
    const out = await apiLogin(client, 'putra', 'bad');
    expect(out).toEqual({ ok: false, reason: 'Wrong username or password.' });
    expect(getApiSessionAccount()).toBeNull();
  });
});

describe('completeEnrollTotp / completeVerifyTotp — bind the session on a valid code', () => {
  const code = totpAt(RFC_SECRET, Math.floor(Date.now() / 1000));

  it('enroll: a valid code calls the server and mirrors the session', async () => {
    const enrollTotp = spy(async () => authResult({ totpEnrolled: true }));
    const out = await completeEnrollTotp(fakeClient({ enrollTotp }), code);
    expect(out.ok).toBe(true);
    expect(enrollTotp.calls).toEqual([[code]]);
    expect(getApiSessionAccount()?.id).toBe('putra');
  });

  it('enroll: an invalid code is rejected locally — the server is never called', async () => {
    const enrollTotp = spy(async () => authResult());
    const out = await completeEnrollTotp(fakeClient({ enrollTotp }), '12ab');
    expect(out.ok).toBe(false);
    expect(enrollTotp.calls).toEqual([]);
    expect(getApiSessionAccount()).toBeNull();
  });

  it('verify: a valid code upgrades to a full session', async () => {
    const completeTotp = spy(async () => authResult());
    const out = await completeVerifyTotp(fakeClient({ completeTotp }), code);
    expect(out.ok).toBe(true);
    expect(completeTotp.calls).toEqual([[code]]);
    expect(getApiSessionAccount()?.role).toBe('lead');
  });

  it('verify: a server refusal surfaces a reason and leaves no session', async () => {
    const out = await completeVerifyTotp(
      fakeClient({
        completeTotp: async () => {
          throw new Error('Invalid code');
        },
      }),
      code,
    );
    expect(out).toEqual({ ok: false, reason: 'Invalid code' });
    expect(getApiSessionAccount()).toBeNull();
  });
});

describe('hydrateApiSession — re-establishes identity from an existing cookie', () => {
  it('adopts a live server session and reports step:done for an ordinary account', async () => {
    const out = await hydrateApiSession(fakeClient({ me: async () => authResult() }));
    expect(out).toMatchObject({ live: true, step: 'done' });
    expect(getApiSessionAccount()?.id).toBe('putra');
  });

  it('reports no session when the cookie is absent', async () => {
    const out = await hydrateApiSession(fakeClient({ me: async () => null }));
    expect(out).toEqual({ live: false });
    expect(getApiSessionAccount()).toBeNull();
  });

  it('reports no session (never throws) when me() errors', async () => {
    const out = await hydrateApiSession(
      fakeClient({
        me: async () => {
          throw new Error('network');
        },
      }),
    );
    expect(out).toEqual({ live: false });
    expect(getApiSessionAccount()).toBeNull();
  });

  // The go-live blocker (BUILD lane): a hydrated/reloaded session whose account
  // is still on its temporary password must route to the CHANGE-PASSWORD step,
  // never step:done. step:done → LoginPage navigate('/') → RequireAuth bounces
  // back to /login (mustChangePassword) → hydrate again → the "Preparing…" loop
  // the first admin could never escape.
  it('a live session still on a temporary password routes to change-password, not done', async () => {
    const out = await hydrateApiSession(fakeClient({ me: async () => mustChangeAuth() }));
    expect(out).toMatchObject({ live: true, step: 'change-password' });
    // The account is mirrored so currentUser() answers — but it still carries the
    // flag, so RequireAuth would (correctly) keep it off every app route.
    expect(getApiSessionAccount()?.mustChangePassword).toBe(true);
  });
});

describe('completeChangePassword — swaps a temporary password for a full session', () => {
  it('a valid change calls the server with (current,new) and mirrors the now-unblocked account', async () => {
    // Start from a hydrated must-change session (as the reload path leaves it)…
    await hydrateApiSession(fakeClient({ me: async () => mustChangeAuth() }));
    expect(getApiSessionAccount()?.mustChangePassword).toBe(true);

    const changePassword = spy(async () => authResult()); // server clears the flag
    const out = await completeChangePassword(
      fakeClient({ changePassword }),
      'temp-pw',
      'brand-new-pw',
    );
    expect(out.ok).toBe(true);
    expect(changePassword.calls).toEqual([['temp-pw', 'brand-new-pw']]);
    // …and now the bridge holds a full session (flag cleared) → home is reachable.
    expect(getApiSessionAccount()?.id).toBe('putra');
    expect(getApiSessionAccount()?.mustChangePassword).toBe(false);
  });

  it('a server refusal surfaces the reason and LEAVES the must-change session intact to retry', async () => {
    await hydrateApiSession(fakeClient({ me: async () => mustChangeAuth() }));
    const out = await completeChangePassword(
      fakeClient({
        changePassword: async () => {
          throw new Error('That code was not accepted.');
        },
      }),
      'wrong-current',
      'brand-new-pw',
    );
    expect(out).toEqual({ ok: false, reason: 'That code was not accepted.' });
    // The prior must-change session is untouched — the user stays on the screen.
    expect(getApiSessionAccount()?.mustChangePassword).toBe(true);
  });
});

/**
 * The first-login ORDER for a fresh bootstrap admin (privileged + not enrolled +
 * temporary password), proven end-to-end over the helpers: TOTP enrolment beats
 * the password gate, the forced change is the LAST gate, and only then does a
 * full session open. This is the exact sequence LoginPage drives; covering it
 * here (no DOM in this repo) pins the routing the component only glues together.
 */
describe('first-login order — TOTP enrol precedes the forced password change', () => {
  it('login → enroll-totp (no session), TOTP done but still change-password, then done', async () => {
    const client = fakeClient({
      login: async () => ({
        user: { ...account, mustChangePassword: true, totpEnrolled: false },
        mustChangePassword: true,
        totpRequired: true,
        totpEnrollment: { secret: RFC_SECRET, otpauthUri: 'otpauth://x' },
      }),
      // Enrolling binds TOTP but does NOT clear the temporary-password flag.
      enrollTotp: async () => mustChangeAuth(),
      changePassword: async () => authResult(),
    });

    // 1) login: enrolment is the first interstitial; no session opens yet.
    const login = await apiLogin(client, 'putra', 'one-time-pw');
    expect(login).toMatchObject({ ok: true, step: 'enroll-totp' });
    expect(getApiSessionAccount()).toBeNull();

    // 2) enroll TOTP: succeeds, but the NEXT gate is change-password, not home.
    const code = totpAt(RFC_SECRET, Math.floor(Date.now() / 1000));
    const enrolled = await completeEnrollTotp(client, code);
    expect(enrolled.ok).toBe(true);
    if (enrolled.ok) expect(nextAuthStep(enrolled.result)).toBe('change-password');
    expect(getApiSessionAccount()?.mustChangePassword).toBe(true);

    // 3) change password: the flag clears and the full session is now open.
    const changed = await completeChangePassword(client, 'one-time-pw', 'brand-new-pw');
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(nextAuthStep(changed.result)).toBe('done');
    expect(getApiSessionAccount()?.mustChangePassword).toBe(false);
  });
});

describe('completeChangePassword — keepOtherSessions forwarding (the standing card’s checkbox)', () => {
  it('omitted: calls the server with exactly two arguments — the forced first-use screen never offers the choice', async () => {
    const changePassword = spy(async () => authResult());
    await completeChangePassword(fakeClient({ changePassword }), 'temp-pw', 'brand-new-pw');
    expect(changePassword.calls).toEqual([['temp-pw', 'brand-new-pw']]);
  });

  it('explicit false: forwarded as a third argument', async () => {
    const changePassword = spy(async () => authResult());
    await completeChangePassword(fakeClient({ changePassword }), 'temp-pw', 'brand-new-pw', false);
    expect(changePassword.calls).toEqual([['temp-pw', 'brand-new-pw', false]]);
  });

  it('explicit true: forwarded as a third argument', async () => {
    const changePassword = spy(async () => authResult());
    await completeChangePassword(fakeClient({ changePassword }), 'temp-pw', 'brand-new-pw', true);
    expect(changePassword.calls).toEqual([['temp-pw', 'brand-new-pw', true]]);
  });
});

describe('completeRecoveryLogin — the third way to clear the TOTP gate', () => {
  it('a blank code is rejected locally — the server is never called', async () => {
    const completeTotpRecovery = spy(async () => authResult());
    const out = await completeRecoveryLogin(fakeClient({ completeTotpRecovery }), '   ');
    expect(out).toEqual({ ok: false, reason: 'Enter one of your recovery codes.' });
    expect(completeTotpRecovery.calls).toEqual([]);
    expect(getApiSessionAccount()).toBeNull();
  });

  it('a valid code trims, calls the server, and mirrors the session', async () => {
    const completeTotpRecovery = spy(async () => ({ ...authResult(), recoveryLogin: true }));
    const out = await completeRecoveryLogin(
      fakeClient({ completeTotpRecovery }),
      '  AAAA-BBBB-CCCC-DDDD  ',
    );
    expect(out.ok).toBe(true);
    expect(completeTotpRecovery.calls).toEqual([['AAAA-BBBB-CCCC-DDDD']]);
    expect(getApiSessionAccount()?.id).toBe('putra');
  });

  it('sets the one-shot recovery-login flag only when the server says recoveryLogin: true', async () => {
    consumeRecoveryLoginFlag(); // drain any flag a prior test left set
    await completeRecoveryLogin(
      fakeClient({ completeTotpRecovery: async () => ({ ...authResult(), recoveryLogin: true }) }),
      'CODE',
    );
    expect(consumeRecoveryLoginFlag()).toBe(true);
    // Reading it once already cleared it — a second read is false.
    expect(consumeRecoveryLoginFlag()).toBe(false);
  });

  it('does NOT set the flag on an ordinary (non-recovery) success', async () => {
    consumeRecoveryLoginFlag();
    await completeRecoveryLogin(
      fakeClient({ completeTotpRecovery: async () => authResult() }),
      'CODE',
    );
    expect(consumeRecoveryLoginFlag()).toBe(false);
  });

  it('a server refusal surfaces the reason and leaves no session', async () => {
    const out = await completeRecoveryLogin(
      fakeClient({
        completeTotpRecovery: async () => {
          throw new Error('That code was not accepted or has already been used.');
        },
      }),
      'CODE',
    );
    expect(out).toEqual({
      ok: false,
      reason: 'That code was not accepted or has already been used.',
    });
    expect(getApiSessionAccount()).toBeNull();
  });
});

describe('the recovery-login one-shot flag (lib/apiSession.ts) — read-once, and sign-out drops it', () => {
  it('starts unset', () => {
    expect(consumeRecoveryLoginFlag()).toBe(false);
  });

  it('a sign-out (clearApiSession) drops a pending flag too', async () => {
    await completeRecoveryLogin(
      fakeClient({ completeTotpRecovery: async () => ({ ...authResult(), recoveryLogin: true }) }),
      'CODE',
    );
    clearApiSession(); // the sign-out path
    expect(consumeRecoveryLoginFlag()).toBe(false);
  });
});
