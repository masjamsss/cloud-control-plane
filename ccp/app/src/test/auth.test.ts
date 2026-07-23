import { beforeEach, describe, expect, it } from 'vitest';
import { enroll, ensureSeeded, resetStoreForTests, setStatus } from '@/lib/accounts';
import { currentUser, isAuthenticated, login, signOut, subscribeSessionChanged } from '@/lib/auth';
import { SEED_LEAD } from '@/config';

beforeEach(async () => {
  resetStoreForTests();
  signOut();
  await ensureSeeded();
});

describe('login', () => {
  it('signs in the bootstrap Lead with the right password', async () => {
    const res = await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    expect(res.ok).toBe(true);
    expect(isAuthenticated()).toBe(true);
    expect(currentUser()?.role).toBe('lead');
  });

  it('fails closed on a wrong password, with a generic reason', async () => {
    const res = await login(SEED_LEAD.username, 'nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/wrong username or password/i);
    expect(isAuthenticated()).toBe(false);
  });

  it('fails on an unknown user (same generic reason)', async () => {
    const res = await login('ghost', 'whatever1');
    expect(res.ok).toBe(false);
    expect(isAuthenticated()).toBe(false);
  });

  it('refuses a disabled account', async () => {
    await enroll(
      { username: 'dewi', displayName: 'Dewi', role: 'requester', teamId: 'erp-basis', password: 'sunflower7' },
      SEED_LEAD.username,
    );
    setStatus('dewi', 'disabled');
    const res = await login('dewi', 'sunflower7');
    expect(res.ok).toBe(false);
    expect(isAuthenticated()).toBe(false);
  });
});

describe('session', () => {
  it('signOut clears the session', async () => {
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    expect(isAuthenticated()).toBe(true);
    signOut();
    expect(isAuthenticated()).toBe(false);
    expect(currentUser()).toBeNull();
  });

  it('currentUser is null once the account is disabled underneath a live session', async () => {
    // The seed already provides a second Lead (bob); log in as the bootstrap
    // Lead and disable it — the guard allows this since bob remains active.
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    setStatus(SEED_LEAD.username, 'disabled');
    expect(currentUser()).toBeNull();
    expect(isAuthenticated()).toBe(false);
  });
});

describe('subscribeSessionChanged — the useCurrentUser() external-store source (0025 RX-4)', () => {
  it('fires on a successful login (identity change: signed out → signed in)', async () => {
    let calls = 0;
    const unsubscribe = subscribeSessionChanged(() => (calls += 1));
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('fires on signOut (identity change: signed in → signed out)', async () => {
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    let calls = 0;
    const unsubscribe = subscribeSessionChanged(() => (calls += 1));
    signOut();
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('a failed login does not fire (no identity change)', async () => {
    let calls = 0;
    const unsubscribe = subscribeSessionChanged(() => (calls += 1));
    await login(SEED_LEAD.username, 'nope');
    expect(calls).toBe(0);
    unsubscribe();
  });

  it('unsubscribing stops further notifications', async () => {
    let calls = 0;
    const unsubscribe = subscribeSessionChanged(() => (calls += 1));
    unsubscribe();
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    expect(calls).toBe(0);
  });
});
