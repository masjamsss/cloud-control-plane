import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeOwnPassword, enroll, ensureSeeded, resetPassword, resetStoreForTests } from '@/lib/accounts';
import {
  currentUser,
  IDLE_TIMEOUT_MS,
  isAuthenticated,
  login,
  MAX_SESSION_MS,
  signOut,
} from '@/lib/auth';
import { SEED_LEAD } from '@/config';

beforeEach(async () => {
  resetStoreForTests();
  signOut();
  await ensureSeeded();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('forced password change', () => {
  it('the seeded roster signs in with its name-password and is NOT forced to change (MOCK demo)', async () => {
    const res = await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mustChangePassword).toBe(false);
  });

  it('an admin reset forces a change, and changing your own password clears it', async () => {
    await enroll(
      { username: 'budi', displayName: 'Budi', role: 'requester', teamId: 'erp-basis', password: 'sunflower7' },
      SEED_LEAD.username,
    );
    await resetPassword('budi', 'temp-from-admin');
    const forced = await login('budi', 'temp-from-admin');
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.mustChangePassword).toBe(true);
    if (forced.ok) await changeOwnPassword(forced.user.id, 'temp-from-admin', 'a-strong-new-pass');
    signOut();
    const second = await login('budi', 'a-strong-new-pass');
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.mustChangePassword).toBe(false);
  });

  it('an admin password reset re-forces a change', async () => {
    await enroll(
      { username: 'dewi', displayName: 'Dewi', role: 'requester', teamId: 'erp-basis', password: 'sunflower7' },
      SEED_LEAD.username,
    );
    // Dewi sets her own password (clears the flag), then an admin resets it.
    await changeOwnPassword('dewi', 'sunflower7', 'chosen-by-dewi');
    await resetPassword('dewi', 'temp-from-admin');
    const res = await login('dewi', 'temp-from-admin');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mustChangePassword).toBe(true);
  });
});

describe('session expiry', () => {
  it('expires after the absolute lifetime', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T08:00:00Z'));
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    expect(isAuthenticated()).toBe(true);
    // Just past the 12h absolute cap.
    vi.setSystemTime(new Date(Date.now() + MAX_SESSION_MS + 60_000));
    expect(currentUser()).toBeNull();
    expect(isAuthenticated()).toBe(false);
  });

  it('expires after the idle timeout, but activity slides the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T08:00:00Z'));
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);

    // Activity just inside the idle window keeps the session and refreshes lastSeen.
    vi.setSystemTime(new Date(Date.now() + IDLE_TIMEOUT_MS - 60_000));
    expect(isAuthenticated()).toBe(true);

    // From that refreshed point, another almost-idle gap still holds.
    vi.setSystemTime(new Date(Date.now() + IDLE_TIMEOUT_MS - 60_000));
    expect(isAuthenticated()).toBe(true);

    // A gap longer than the idle timeout expires it.
    vi.setSystemTime(new Date(Date.now() + IDLE_TIMEOUT_MS + 60_000));
    expect(currentUser()).toBeNull();
  });
});
