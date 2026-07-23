import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginAddTotpDevice,
  changeOwnPassword,
  clearReauth,
  confirmAddTotpDevice,
  ensureSeeded,
  getAccount,
  getRecoveryStatus,
  isReauthFresh,
  listAccounts,
  listTotpDevices,
  MAX_TOTP_DEVICES,
  noteSignIn,
  noteSignOut,
  reauthWithPassword,
  regenerateRecoveryCodes,
  removeTotpDevice,
  resetAccountTotp,
  resetReauthForTests,
  resetStoreForTests,
  revokeAccountSessions,
  revokeOwnOtherSessions,
  ReauthRequiredError,
  setSecurityStateForTests,
  setTotpRequired,
  enroll,
} from '@/lib/accounts';
import { login, signOut } from '@/lib/auth';
import { SEED_LEAD } from '@/config';

/**
 * The demo account-security state (nothing greyed in demo): lib/accounts
 * carries a local stand-in for ccp-api's login-2FA enrolment
 * (`totpEnrolled`) and per-account sessions (`activeSessions`), so the Users
 * admin's 2FA toggle, Reset TOTP, and Revoke sessions act on REAL local state
 * in a mock build. This file pins the three mock behaviors end to end: the
 * toggle's pin persists, a TOTP reset clears enrolment + sessions, a revoke
 * clears sessions — plus the seed that guarantees the actions never start
 * from an empty store, and the sign-in/out bookkeeping that keeps the count
 * honest.
 */

beforeEach(() => {
  resetStoreForTests();
});

async function seedOne(username: string, role: 'requester' | 'approver' | 'lead'): Promise<void> {
  await enroll(
    { username, displayName: username.toUpperCase(), role, teamId: 'platform', password: 'satu-dua-tiga-empat' },
    'system',
  );
}

describe('the seed — the security actions have something real to act on', () => {
  it('seeds privileged accounts with an authenticator set up and live sessions', async () => {
    await ensureSeeded();
    const accounts = listAccounts();
    expect(accounts.length).toBeGreaterThan(1);
    const privileged = accounts.filter((a) => a.role !== 'requester' || a.isAdmin === true);
    const requesters = accounts.filter((a) => a.role === 'requester' && a.isAdmin !== true);
    expect(privileged.length).toBeGreaterThan(0);
    for (const a of privileged) {
      expect(a.totpEnrolled, `${a.username} should have an authenticator`).toBe(true);
      expect(a.activeSessions ?? 0, `${a.username} should have sessions`).toBeGreaterThan(0);
    }
    // Requesters have a session but no authenticator yet — resetting one is a no-op that says so.
    for (const a of requesters) {
      expect(a.totpEnrolled).toBe(false);
      expect(a.activeSessions ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('setTotpRequired — the 2FA toggle persists to the store', () => {
  it('pins the requirement in both directions and survives a reload (fresh read)', async () => {
    await seedOne('lina', 'lead');
    expect(getAccount('lina')?.totpRequired).toBeUndefined(); // role default applies
    setTotpRequired('lina', false);
    expect(getAccount('lina')?.totpRequired).toBe(false);
    setTotpRequired('lina', true);
    expect(getAccount('lina')?.totpRequired).toBe(true);
  });

  it('throws a plain reason for an unknown account', () => {
    expect(() => setTotpRequired('ghost', true)).toThrow('No such account.');
  });
});

describe('resetAccountTotp — clears enrolment AND revokes sessions (server parity)', () => {
  it('clears the authenticator, zeroes sessions, and reports how many were revoked', async () => {
    await seedOne('dewi', 'approver');
    setSecurityStateForTests('dewi', { totpEnrolled: true, activeSessions: 3 });
    const result = resetAccountTotp('dewi');
    expect(result).toEqual({ sessionsRevoked: 3 });
    expect(getAccount('dewi')?.totpEnrolled).toBe(false);
    expect(getAccount('dewi')?.activeSessions).toBe(0);
    // A second reset acts on the now-empty state — visibly different outcome.
    expect(resetAccountTotp('dewi')).toEqual({ sessionsRevoked: 0 });
  });
});

describe('revokeAccountSessions — clears sessions, leaves the authenticator alone', () => {
  it('zeroes the count, reports what was cleared, and does not touch enrolment', async () => {
    await seedOne('putra', 'lead');
    setSecurityStateForTests('putra', { totpEnrolled: true, activeSessions: 2 });
    expect(revokeAccountSessions('putra')).toEqual({ sessionsRevoked: 2 });
    expect(getAccount('putra')?.activeSessions).toBe(0);
    expect(getAccount('putra')?.totpEnrolled).toBe(true);
    expect(revokeAccountSessions('putra')).toEqual({ sessionsRevoked: 0 });
  });
});

describe('session bookkeeping — the count moves with real sign-ins', () => {
  it('noteSignIn/noteSignOut bump and floor the count, never throwing for unknown ids', async () => {
    await seedOne('sari', 'requester');
    noteSignIn('sari');
    noteSignIn('sari');
    expect(getAccount('sari')?.activeSessions).toBe(2);
    noteSignOut('sari');
    expect(getAccount('sari')?.activeSessions).toBe(1);
    noteSignOut('sari');
    noteSignOut('sari'); // floors at 0
    expect(getAccount('sari')?.activeSessions).toBe(0);
    expect(() => noteSignIn('ghost')).not.toThrow();
    expect(() => noteSignOut('ghost')).not.toThrow();
  });

  it('a real local sign-in counts a session; signing out ends it', async () => {
    await ensureSeeded();
    const before = getAccount(SEED_LEAD.username)?.activeSessions ?? 0;
    const result = await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    expect(result.ok).toBe(true);
    expect(getAccount(SEED_LEAD.username)?.activeSessions).toBe(before + 1);
    signOut();
    expect(getAccount(SEED_LEAD.username)?.activeSessions).toBe(before);
  });
});

/* ── ADR-0026 mock mirror: re-authentication ──────────────────────────────── */

describe('re-auth (mock mirror) — in-memory, per-tab, password-only', () => {
  beforeEach(() => resetReauthForTests());

  it('starts unelevated; a correct password elevates; a wrong one does not', async () => {
    await seedOne('sari', 'requester');
    expect(isReauthFresh()).toBe(false);
    expect(await reauthWithPassword('sari', 'wrong')).toBe(false);
    expect(isReauthFresh()).toBe(false);
    expect(await reauthWithPassword('sari', 'satu-dua-tiga-empat')).toBe(true);
    expect(isReauthFresh()).toBe(true);
  });

  it('an unknown account fails closed (never throws, just returns false)', async () => {
    await expect(reauthWithPassword('ghost', 'whatever')).resolves.toBe(false);
  });

  it('the window is exactly REAUTH_MS (10 minutes) — fresh just inside, stale just past', async () => {
    await seedOne('sari', 'requester');
    const T0 = Date.UTC(2026, 6, 22, 9, 0, 0);
    const real = Date.now;
    try {
      Date.now = () => T0;
      await reauthWithPassword('sari', 'satu-dua-tiga-empat');
      Date.now = () => T0 + 10 * 60_000;
      expect(isReauthFresh()).toBe(true); // inclusive boundary
      Date.now = () => T0 + 10 * 60_000 + 1;
      expect(isReauthFresh()).toBe(false);
    } finally {
      Date.now = real;
    }
  });

  it('signOut() clears the elevation (ADR-0026: never survives sign-out)', async () => {
    await ensureSeeded();
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    await reauthWithPassword(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    expect(isReauthFresh()).toBe(true);
    signOut();
    expect(isReauthFresh()).toBe(false);
  });

  it('clearReauth is a direct, idempotent reset', () => {
    clearReauth();
    expect(isReauthFresh()).toBe(false);
    clearReauth();
    expect(isReauthFresh()).toBe(false);
  });
});

/* ── ADR-0024 mock mirror: multi-device 2FA ───────────────────────────────── */

const NEVER_NEEDS_TOTP = (): boolean => false;
const ALWAYS_NEEDS_TOTP = (): boolean => true;

describe('multi-device TOTP (mock mirror)', () => {
  beforeEach(() => resetReauthForTests());

  it('every ⚿ action throws ReauthRequiredError without a fresh elevation', async () => {
    await seedOne('sari', 'requester');
    expect(() => beginAddTotpDevice('sari')).toThrow(ReauthRequiredError);
    expect(() => confirmAddTotpDevice('sari', '123456', 'Phone')).toThrow(ReauthRequiredError);
    expect(() => removeTotpDevice('sari', 'whatever', NEVER_NEEDS_TOTP)).toThrow(ReauthRequiredError);
  });

  it('begin returns a plausible otpauth URI + base32-shaped secret; confirm accepts any 6-digit code, appends a named device, and the FIRST device auto-issues 10 recovery codes', async () => {
    await seedOne('sari', 'requester');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');

    const offer = beginAddTotpDevice('sari');
    expect(offer.otpauthUri).toContain('otpauth://totp/');
    expect(offer.secret).toMatch(/^[A-Z2-7]+$/);

    const result = confirmAddTotpDevice('sari', '123456', 'My phone');
    expect(result.name).toBe('My phone');
    expect(result.recoveryCodes).toHaveLength(10);

    const account = getAccount('sari')!;
    expect(account.totpEnrolled).toBe(true);
    expect(account.totpDevices).toHaveLength(1);
    expect(account.totpDevices![0]!.name).toBe('My phone');
    expect(account.recovery!.remaining).toBe(10);
    expect(listTotpDevices('sari')).toEqual(account.totpDevices);
  });

  it('a second device does NOT re-issue recovery codes', async () => {
    await seedOne('sari', 'requester');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    confirmAddTotpDevice('sari', '123456', 'First');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat'); // re-elevate for the second ⚿ action
    const result = confirmAddTotpDevice('sari', '654321', 'Second');
    expect(result.recoveryCodes).toBeUndefined();
    expect(getAccount('sari')!.totpDevices).toHaveLength(2);
  });

  it('confirm validates: empty name, oversize name (>40), non-6-digit code', async () => {
    await seedOne('sari', 'requester');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    expect(() => confirmAddTotpDevice('sari', '123456', '')).toThrow('Enter a name');
    expect(() => confirmAddTotpDevice('sari', '123456', 'x'.repeat(41))).toThrow('40 characters or fewer');
    expect(() => confirmAddTotpDevice('sari', 'abc', 'Phone')).toThrow('6-digit code');
  });

  it(`refuses at the ${MAX_TOTP_DEVICES}-device cap (both begin and confirm)`, async () => {
    await seedOne('sari', 'requester');
    for (let i = 0; i < MAX_TOTP_DEVICES; i++) {
      await reauthWithPassword('sari', 'satu-dua-tiga-empat');
      confirmAddTotpDevice('sari', '123456', `Device ${i}`);
    }
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    expect(() => beginAddTotpDevice('sari')).toThrow('5 authenticator devices');
  });

  it('LAST_FACTOR: refuses removing the only device while isNeedsTotp(account) is true', async () => {
    await seedOne('lina', 'lead');
    await reauthWithPassword('lina', 'satu-dua-tiga-empat');
    confirmAddTotpDevice('lina', '123456', 'Only one');
    const deviceId = getAccount('lina')!.totpDevices![0]!.id;

    await reauthWithPassword('lina', 'satu-dua-tiga-empat');
    expect(() => removeTotpDevice('lina', deviceId, ALWAYS_NEEDS_TOTP)).toThrow('last authenticator device');
    expect(getAccount('lina')!.totpDevices).toHaveLength(1);
  });

  it('removing the last device IS allowed when isNeedsTotp returns false, and clears recovery codes with it', async () => {
    await seedOne('sari', 'requester');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    confirmAddTotpDevice('sari', '123456', 'Only one');
    expect(getAccount('sari')!.recovery).toBeDefined();
    const deviceId = getAccount('sari')!.totpDevices![0]!.id;

    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    removeTotpDevice('sari', deviceId, NEVER_NEEDS_TOTP);
    const account = getAccount('sari')!;
    expect(account.totpDevices).toEqual([]);
    expect(account.totpEnrolled).toBe(false);
    expect(account.recovery).toBeUndefined();
  });

  it('removing one of SEVERAL devices is always allowed regardless of isNeedsTotp', async () => {
    await seedOne('lina', 'lead');
    await reauthWithPassword('lina', 'satu-dua-tiga-empat');
    confirmAddTotpDevice('lina', '123456', 'First');
    await reauthWithPassword('lina', 'satu-dua-tiga-empat');
    confirmAddTotpDevice('lina', '654321', 'Second');
    const [first] = getAccount('lina')!.totpDevices!;

    await reauthWithPassword('lina', 'satu-dua-tiga-empat');
    removeTotpDevice('lina', first!.id, ALWAYS_NEEDS_TOTP);
    expect(getAccount('lina')!.totpDevices).toHaveLength(1);
  });

  it('removing an unknown device id throws a plain reason', async () => {
    await seedOne('sari', 'requester');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    expect(() => removeTotpDevice('sari', 'does-not-exist', NEVER_NEEDS_TOTP)).toThrow('No such device.');
  });

  it('resetAccountTotp (admin) clears totpDevices + recovery too, not just the boolean', async () => {
    await seedOne('sari', 'requester');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    confirmAddTotpDevice('sari', '123456', 'Phone');
    expect(getAccount('sari')!.totpDevices).toHaveLength(1);
    expect(getAccount('sari')!.recovery).toBeDefined();

    resetAccountTotp('sari');
    const account = getAccount('sari')!;
    expect(account.totpEnrolled).toBe(false);
    expect(account.totpDevices).toBeUndefined();
    expect(account.recovery).toBeUndefined();
  });
});

/* ── ADR-0025 mock mirror: recovery codes ─────────────────────────────────── */

describe('recovery codes (mock mirror)', () => {
  beforeEach(() => resetReauthForTests());

  it('never generated → {remaining: 0}, no generatedAt', async () => {
    await seedOne('sari', 'requester');
    expect(getRecoveryStatus('sari')).toEqual({ remaining: 0 });
  });

  it('regenerate throws ReauthRequiredError without a fresh elevation', async () => {
    await seedOne('sari', 'requester');
    expect(() => regenerateRecoveryCodes('sari')).toThrow(ReauthRequiredError);
  });

  it('regenerate refuses when no device is enrolled — codes exist only while 2FA is active', async () => {
    await seedOne('sari', 'requester');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    expect(() => regenerateRecoveryCodes('sari')).toThrow('authenticator device');
  });

  it('regenerate replaces the whole set: 10 fresh, distinct, differently-formatted codes each time', async () => {
    await seedOne('sari', 'requester');
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    confirmAddTotpDevice('sari', '123456', 'Phone');
    const first = getRecoveryStatus('sari');
    expect(first.remaining).toBe(10);

    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    const { codes, generatedAt } = regenerateRecoveryCodes('sari');
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[23-9A-HJ-NP-Z]{4}-[23-9A-HJ-NP-Z]{4}-[23-9A-HJ-NP-Z]{4}-[23-9A-HJ-NP-Z]{4}$/);
    expect(getRecoveryStatus('sari')).toEqual({ remaining: 10, generatedAt });
  });
});

/* ── §4 standing password change: verify-first (mock mirror) ─────────────── */

describe('changeOwnPassword — verify-first (the standing Account page card)', () => {
  it('the wrong current password is refused with a generic reason; nothing changes', async () => {
    await seedOne('sari', 'requester');
    await expect(changeOwnPassword('sari', 'not-the-password', 'a-brand-new-pw-1')).rejects.toThrow('Wrong username or password.');
  });

  it('the correct current password swaps the credential and clears mustChangePassword', async () => {
    await seedOne('sari', 'requester');
    await changeOwnPassword('sari', 'satu-dua-tiga-empat', 'a-brand-new-pw-1');
    const relogin = await login('sari', 'a-brand-new-pw-1');
    expect(relogin.ok).toBe(true);
    if (relogin.ok) expect(relogin.mustChangePassword).toBe(false);
    // the OLD password no longer works.
    signOut();
    const stale = await login('sari', 'satu-dua-tiga-empat');
    expect(stale.ok).toBe(false);
  });
});

/* ── §8 sessions: revoke-others is the existing admin action, reused for self ── */

describe('revokeOwnOtherSessions — reuses revokeAccountSessions, gated on reauth', () => {
  it('throws ReauthRequiredError without a fresh elevation', async () => {
    await seedOne('sari', 'requester');
    setSecurityStateForTests('sari', { activeSessions: 3 });
    expect(() => revokeOwnOtherSessions('sari')).toThrow(ReauthRequiredError);
    expect(getAccount('sari')?.activeSessions).toBe(3); // untouched
  });

  it('zeroes the session count once elevated', async () => {
    await seedOne('sari', 'requester');
    setSecurityStateForTests('sari', { activeSessions: 3 });
    await reauthWithPassword('sari', 'satu-dua-tiga-empat');
    expect(revokeOwnOtherSessions('sari')).toEqual({ sessionsRevoked: 3 });
    expect(getAccount('sari')?.activeSessions).toBe(0);
  });
});
