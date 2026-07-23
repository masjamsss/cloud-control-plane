import { beforeEach, describe, expect, it } from 'vitest';
import type {
  HttpApiClient,
  OwnSessionRow,
  RecoveryCodesRegenerateResult,
  RecoveryCodesStatus,
  ReauthResult,
  TotpDeviceConfirmResult,
  TotpDeviceWire,
  TotpEnrollmentOffer,
} from '@/lib/httpApi';
import { ApiRefusalError } from '@/lib/httpApi';
import {
  beginAddDeviceVia,
  changeOwnPasswordVia,
  confirmAddDeviceVia,
  isReauthError,
  loadDevicesVia,
  loadRecoveryStatusVia,
  loadSessionsVia,
  reauthVia,
  regenerateRecoveryCodesVia,
  removeDeviceVia,
  revokeOtherSessionsVia,
  revokeSessionVia,
} from '@/features/account/accountFlow';
import {
  enroll,
  getAccount,
  reauthWithPassword,
  resetReauthForTests,
  resetStoreForTests,
  setSecurityStateForTests,
  ReauthRequiredError,
} from '@/lib/accounts';

/**
 * The standing Account & security page's advisory→authoritative branch
 * (accountFlow.ts). Mirrors authFlow.test.ts's / usersFlow.test.ts's
 * fake-client approach (no jsdom in this repo — test/standalone.test.ts pins
 * the dep allowlist): the authoritative branch is proven against a fake
 * {@link HttpApiClient} that calls out loudly if an unstubbed method fires;
 * the non-authoritative branch is proven against the real lib/accounts demo
 * store, seeded fresh per test.
 */

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
    reauth: notUsed,
    listTotpDevices: notUsed,
    beginAddTotpDevice: notUsed,
    confirmAddTotpDevice: notUsed,
    removeTotpDevice: notUsed,
    getRecoveryCodesStatus: notUsed,
    regenerateRecoveryCodes: notUsed,
    listOwnSessions: notUsed,
    revokeOwnSession: notUsed,
    revokeOwnOtherSessions: notUsed,
    ...over,
  } as unknown as HttpApiClient;
}

/** A hand-rolled spy (this repo's convention — see authFlow.test.ts). */
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

const PW = 'satu-dua-tiga-empat';

beforeEach(() => {
  resetStoreForTests();
  resetReauthForTests();
});

async function seedOne(
  username: string,
  role: 'requester' | 'approver' | 'lead' = 'requester',
): Promise<void> {
  await enroll(
    { username, displayName: username.toUpperCase(), role, teamId: 'platform', password: PW },
    'system',
  );
}

describe('loadDevicesVia', () => {
  it('authoritative: returns the client rows verbatim', async () => {
    const rows: TotpDeviceWire[] = [
      { id: 'd1', name: 'Phone', enrolledAt: '2026-01-01T00:00:00Z' },
    ];
    const client = fakeClient({ listTotpDevices: async () => rows });
    expect(await loadDevicesVia(true, client, 'x')).toEqual(rows);
  });

  it('mock: reads the demo device list for the given id', async () => {
    await seedOne('sari', 'lead');
    setSecurityStateForTests('sari', {
      totpDevices: [{ id: 'device-1', name: 'Authenticator', enrolledAt: '2026-01-01T00:00:00Z' }],
    });
    const rows = await loadDevicesVia(false, null, 'sari');
    expect(rows).toEqual([
      { id: 'device-1', name: 'Authenticator', enrolledAt: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('mock: an unenrolled account has no devices', async () => {
    await seedOne('dewi');
    expect(await loadDevicesVia(false, null, 'dewi')).toEqual([]);
  });
});

describe('beginAddDeviceVia / confirmAddDeviceVia — re-auth gated on the mock branch', () => {
  it('authoritative: forwards to the client verbatim', async () => {
    const offer: TotpEnrollmentOffer = { secret: 'SECRET', otpauthUri: 'otpauth://x' };
    const beginAddTotpDevice = spy(async () => offer);
    expect(await beginAddDeviceVia(true, fakeClient({ beginAddTotpDevice }), 'x')).toBe(offer);
    expect(beginAddTotpDevice.calls).toEqual([[]]);

    const confirmed: TotpDeviceConfirmResult = {
      id: 'd1',
      name: 'Phone',
      enrolledAt: '2026-01-01T00:00:00Z',
    };
    const confirmAddTotpDevice = spy(async () => confirmed);
    const result = await confirmAddDeviceVia(
      true,
      fakeClient({ confirmAddTotpDevice }),
      'x',
      '123456',
      'Phone',
    );
    expect(result).toBe(confirmed);
    expect(confirmAddTotpDevice.calls).toEqual([['123456', 'Phone']]);
  });

  it('mock: throws ReauthRequiredError without a fresh elevation', async () => {
    await seedOne('sari');
    await expect(beginAddDeviceVia(false, null, 'sari')).rejects.toThrow(ReauthRequiredError);
  });

  it('mock: succeeds once elevated, and the first device confirm returns fresh recovery codes', async () => {
    await seedOne('sari');
    await reauthWithPassword('sari', PW);
    const offer = await beginAddDeviceVia(false, null, 'sari');
    expect(offer.otpauthUri).toContain('otpauth://');
    const result = await confirmAddDeviceVia(false, null, 'sari', '123456', 'My phone');
    expect(result.name).toBe('My phone');
    expect(result.recoveryCodes).toHaveLength(10);
  });
});

describe('removeDeviceVia — the last-factor guard on the mock branch', () => {
  it('authoritative: forwards the id to the client', async () => {
    const removeTotpDevice = spy(async () => undefined);
    await removeDeviceVia(true, fakeClient({ removeTotpDevice }), 'x', 'd1');
    expect(removeTotpDevice.calls).toEqual([['d1']]);
  });

  it('mock: refuses to strip the last device off a lead (2FA required for the role)', async () => {
    await seedOne('putra', 'lead');
    setSecurityStateForTests('putra', {
      totpDevices: [{ id: 'device-1', name: 'Authenticator', enrolledAt: '2026-01-01T00:00:00Z' }],
    });
    await reauthWithPassword('putra', PW);
    await expect(removeDeviceVia(false, null, 'putra', 'device-1')).rejects.toThrow(
      /last authenticator device/,
    );
    expect(getAccount('putra')?.totpDevices).toHaveLength(1); // untouched
  });

  it('mock: allows removing the last device off a plain requester (2FA not required)', async () => {
    await seedOne('dewi', 'requester');
    setSecurityStateForTests('dewi', {
      totpDevices: [{ id: 'device-1', name: 'Authenticator', enrolledAt: '2026-01-01T00:00:00Z' }],
    });
    await reauthWithPassword('dewi', PW);
    await removeDeviceVia(false, null, 'dewi', 'device-1');
    expect(getAccount('dewi')?.totpDevices).toEqual([]);
  });
});

describe('loadRecoveryStatusVia / regenerateRecoveryCodesVia', () => {
  it('authoritative: forwards to the client verbatim', async () => {
    const status: RecoveryCodesStatus = { remaining: 7, generatedAt: '2026-01-01T00:00:00Z' };
    expect(
      await loadRecoveryStatusVia(
        true,
        fakeClient({ getRecoveryCodesStatus: async () => status }),
        'x',
      ),
    ).toBe(status);

    const regen: RecoveryCodesRegenerateResult = {
      codes: ['AAAA-BBBB-CCCC-DDDD'],
      generatedAt: '2026-01-01T00:00:00Z',
    };
    expect(
      await regenerateRecoveryCodesVia(
        true,
        fakeClient({ regenerateRecoveryCodes: async () => regen }),
        'x',
      ),
    ).toBe(regen);
  });

  it('mock: no device enrolled → regenerate refuses even when elevated', async () => {
    await seedOne('dewi');
    await reauthWithPassword('dewi', PW);
    await expect(regenerateRecoveryCodesVia(false, null, 'dewi')).rejects.toThrow(
      /authenticator device/,
    );
  });

  it('mock: regenerating replaces the set and the status reflects it', async () => {
    await seedOne('sari', 'lead');
    setSecurityStateForTests('sari', {
      totpDevices: [{ id: 'device-1', name: 'Authenticator', enrolledAt: '2026-01-01T00:00:00Z' }],
    });
    await reauthWithPassword('sari', PW);
    const regen = await regenerateRecoveryCodesVia(false, null, 'sari');
    expect(regen.codes).toHaveLength(10);
    const status = await loadRecoveryStatusVia(false, null, 'sari');
    expect(status.remaining).toBe(10);
  });
});

describe('loadSessionsVia — the two backends model "my sessions" differently', () => {
  it('authoritative: a row-by-row list', async () => {
    const rows: OwnSessionRow[] = [
      {
        id: 's1',
        issuedAt: '2026-01-01T00:00:00Z',
        lastSeenAt: '2026-01-01T00:00:00Z',
        current: true,
      },
    ];
    const view = await loadSessionsVia(
      true,
      fakeClient({ listOwnSessions: async () => rows }),
      'x',
    );
    expect(view).toEqual({ kind: 'rows', rows });
  });

  it('mock: a count, minus one for "this device"', async () => {
    await seedOne('sari');
    setSecurityStateForTests('sari', { activeSessions: 3 });
    expect(await loadSessionsVia(false, null, 'sari')).toEqual({ kind: 'count', otherSessions: 2 });
  });

  it('mock: never goes negative when the counter is already at zero', async () => {
    await seedOne('sari');
    setSecurityStateForTests('sari', { activeSessions: 0 });
    expect(await loadSessionsVia(false, null, 'sari')).toEqual({ kind: 'count', otherSessions: 0 });
  });
});

describe('revokeSessionVia / revokeOtherSessionsVia', () => {
  it('revokeSessionVia forwards the session id to the client', async () => {
    const revokeOwnSession = spy(async () => undefined);
    await revokeSessionVia(fakeClient({ revokeOwnSession }), 's1');
    expect(revokeOwnSession.calls).toEqual([['s1']]);
  });

  it('revokeOtherSessionsVia authoritative: returns the client result verbatim', async () => {
    const client = fakeClient({ revokeOwnOtherSessions: async () => ({ revoked: 4 }) });
    expect(await revokeOtherSessionsVia(true, client, 'x')).toEqual({ revoked: 4 });
  });

  it('revokeOtherSessionsVia mock: maps sessionsRevoked → revoked, gated on reauth', async () => {
    await seedOne('sari');
    setSecurityStateForTests('sari', { activeSessions: 3 });
    await expect(revokeOtherSessionsVia(false, null, 'sari')).rejects.toThrow(ReauthRequiredError);
    await reauthWithPassword('sari', PW);
    expect(await revokeOtherSessionsVia(false, null, 'sari')).toEqual({ revoked: 3 });
  });
});

describe('changeOwnPasswordVia', () => {
  it('authoritative: signOutOtherDevices=true (the default) inverts to keepOtherSessions=false', async () => {
    const changePassword = spy(async () => ({
      user: {
        id: 'x',
        username: 'x',
        displayName: 'X',
        role: 'requester',
        teamId: 't',
        status: 'active' as const,
        isAdmin: false,
        mustChangePassword: false,
        totpEnrolled: false,
      },
      mustChangePassword: false,
    }));
    const outcome = await changeOwnPasswordVia(
      true,
      fakeClient({ changePassword }),
      'x',
      'old',
      'new',
      true,
    );
    expect(outcome).toEqual({ ok: true });
    expect(changePassword.calls).toEqual([['old', 'new', false]]);
  });

  it('authoritative: signOutOtherDevices=false inverts to keepOtherSessions=true', async () => {
    const changePassword = spy(async () => ({
      user: {
        id: 'x',
        username: 'x',
        displayName: 'X',
        role: 'requester',
        teamId: 't',
        status: 'active' as const,
        isAdmin: false,
        mustChangePassword: false,
        totpEnrolled: false,
      },
      mustChangePassword: false,
    }));
    await changeOwnPasswordVia(true, fakeClient({ changePassword }), 'x', 'old', 'new', false);
    expect(changePassword.calls).toEqual([['old', 'new', true]]);
  });

  it('authoritative: a server refusal is mapped to {ok:false, reason}', async () => {
    const client = fakeClient({
      changePassword: async () => {
        throw new Error('Wrong current password.');
      },
    });
    const outcome = await changeOwnPasswordVia(true, client, 'x', 'old', 'new', true);
    expect(outcome).toEqual({ ok: false, reason: 'Wrong current password.' });
  });

  it('mock: verify-first, wraps a thrown EnrollError into {ok:false, reason}', async () => {
    await seedOne('sari');
    const outcome = await changeOwnPasswordVia(
      false,
      null,
      'sari',
      'wrong-password',
      'brand-new-pw-1',
      true,
    );
    expect(outcome).toEqual({ ok: false, reason: 'Wrong username or password.' });
  });

  it('mock: the correct current password succeeds — no re-auth gate on top of it', async () => {
    await seedOne('sari');
    expect(await changeOwnPasswordVia(false, null, 'sari', PW, 'brand-new-pw-1', true)).toEqual({
      ok: true,
    });
  });
});

describe('isReauthError', () => {
  it('true for an ApiRefusalError carrying REAUTH_REQUIRED', () => {
    expect(isReauthError(new ApiRefusalError('REAUTH_REQUIRED', 'Please confirm it is you.'))).toBe(
      true,
    );
  });
  it('false for any other ApiRefusalError code', () => {
    expect(isReauthError(new ApiRefusalError('DEVICE_LIMIT', 'Too many devices.'))).toBe(false);
  });
  it('true for the mock ReauthRequiredError', () => {
    expect(isReauthError(new ReauthRequiredError('elevate'))).toBe(true);
  });
  it('false for a plain Error and for non-error values', () => {
    expect(isReauthError(new Error('boom'))).toBe(false);
    expect(isReauthError('boom')).toBe(false);
    expect(isReauthError(undefined)).toBe(false);
  });
});

describe('reauthVia', () => {
  it('authoritative: a successful password elevation returns true', async () => {
    const reauth = spy(async (): Promise<ReauthResult> => ({
      ok: true,
      reauthAt: '2026-01-01T00:00:00Z',
    }));
    const ok = await reauthVia(true, fakeClient({ reauth }), 'x', { password: 'pw' });
    expect(ok).toBe(true);
    expect(reauth.calls).toEqual([[{ password: 'pw' }]]);
  });

  it('authoritative: a code elevation forwards {code} and a rejection returns false, not a throw', async () => {
    const reauth = spy(async (input: { password: string } | { code: string }) => {
      expect(input).toEqual({ code: '000000' });
      throw new Error('Wrong code');
    });
    const ok = await reauthVia(true, fakeClient({ reauth }), 'x', { code: '000000' });
    expect(ok).toBe(false);
  });

  it('mock: password elevation delegates to the real PBKDF2 verify', async () => {
    await seedOne('sari');
    expect(await reauthVia(false, null, 'sari', { password: 'wrong' })).toBe(false);
    expect(await reauthVia(false, null, 'sari', { password: PW })).toBe(true);
  });

  it('mock: a code elevation is always false — no real secret to check it against', async () => {
    await seedOne('sari');
    expect(await reauthVia(false, null, 'sari', { code: '123456' })).toBe(false);
  });
});
