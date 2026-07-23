import { beforeEach, describe, expect, it } from 'vitest';
import {
  EnrollError,
  enroll,
  ensureSeeded,
  getAccount,
  listAccounts,
  resetPassword,
  resetStoreForTests,
  resolveName,
  setAdmin,
  setRole,
  setStatus,
  setTeam,
  subscribeAccountsChanged,
  verifyPassword,
} from '@/lib/accounts';
import { SEED_ACCOUNTS, SEED_LEAD } from '@/config';
import { eligibleApproverCount, maxSatisfiableApprovals, quorumWarning } from '@/lib/quorum';

beforeEach(() => resetStoreForTests());

const dewi = {
  username: 'dewi',
  displayName: 'Dewi',
  role: 'requester' as const,
  teamId: 'erp-basis',
  password: 'sunflower7',
};

/** The seed's other Lead (Bob) — used to reduce the roster to a single
 * active Lead before exercising the last-active-Lead guard below. */
const otherLead = SEED_ACCOUNTS.find((a) => a.role === 'lead')!;

describe('seeding', () => {
  it('seeds the full engineer roster (1 admin Lead + 1 Lead + 1 Approver + 2 Requesters), idempotently', async () => {
    await ensureSeeded();
    await ensureSeeded(); // second call must not duplicate anything
    const all = listAccounts();
    expect(all).toHaveLength(1 + SEED_ACCOUNTS.length);

    const byUsername = Object.fromEntries(all.map((a) => [a.username, a]));
    expect(byUsername[SEED_LEAD.username]?.role).toBe('lead');
    expect(byUsername[SEED_LEAD.username]?.isAdmin).toBe(true);
    for (const seed of SEED_ACCOUNTS) {
      expect(byUsername[seed.username]?.role, seed.username).toBe(seed.role);
      expect(byUsername[seed.username]?.teamId, seed.username).toBe(seed.teamId);
      expect(byUsername[seed.username]?.status, seed.username).toBe('active');
    }
    // Exactly one admin in the whole roster: the bootstrap Lead.
    expect(all.filter((a) => a.isAdmin === true).map((a) => a.username)).toEqual([
      SEED_LEAD.username,
    ]);
  });

  it('the seeded roster signs in with its name-password (MOCK demo — none forced to change)', async () => {
    await ensureSeeded();
    expect(listAccounts().some((a) => a.mustChangePassword === true)).toBe(false);
  });

  it('a satisfiable 2-approval quorum exists without the requester (separation of duties)', async () => {
    await ensureSeeded();
    const accounts = listAccounts();
    // 2 Leads (alice, bob) + 1 Approver (carol) = 3 eligible approvers —
    // the 2 Requesters (dave, erin) don't count.
    expect(eligibleApproverCount(accounts)).toBe(3);
    const max = maxSatisfiableApprovals(eligibleApproverCount(accounts));
    expect(max).toBe(2);
    // A HIGH/Delete-class change (2 approvals required) is fully satisfiable —
    // no quorum warning — without ever needing the requester's own approval.
    expect(quorumWarning(2, max)).toBeNull();
  });
});

describe('enrol', () => {
  it('creates an account keyed by username and hashes the password', async () => {
    const acct = await enroll(dewi, SEED_LEAD.username);
    expect(acct.id).toBe('dewi');
    expect(getAccount('dewi')?.displayName).toBe('Dewi');
    expect(acct).not.toHaveProperty('password');
    expect(acct.passwordHash).not.toContain('sunflower7');
    expect(await verifyPassword(acct, 'sunflower7')).toBe(true);
    expect(await verifyPassword(acct, 'wrong')).toBe(false);
  });

  it('OP-2: forces a password change on first sign-in, matching the server (admin.ts mustChangePassword:true)', async () => {
    const acct = await enroll(dewi, SEED_LEAD.username);
    expect(acct.mustChangePassword).toBe(true);
    expect(getAccount('dewi')?.mustChangePassword).toBe(true);
  });

  it('rejects a duplicate username', async () => {
    await enroll(dewi, SEED_LEAD.username);
    await expect(
      enroll({ ...dewi, displayName: 'Dewi 2' }, SEED_LEAD.username),
    ).rejects.toBeInstanceOf(EnrollError);
  });

  it('rejects a short password', async () => {
    await expect(
      enroll({ ...dewi, password: 'short' }, SEED_LEAD.username),
    ).rejects.toBeInstanceOf(EnrollError);
  });

  it('rejects an invalid username', async () => {
    await expect(
      enroll({ ...dewi, username: 'Bad Name!' }, SEED_LEAD.username),
    ).rejects.toBeInstanceOf(EnrollError);
  });
});

describe('resetPassword', () => {
  it('changes the verifier', async () => {
    const acct = await enroll(dewi, SEED_LEAD.username);
    await resetPassword('dewi', 'newpassword9');
    const after = getAccount('dewi')!;
    expect(await verifyPassword(after, 'sunflower7')).toBe(false);
    expect(await verifyPassword(after, 'newpassword9')).toBe(true);
    expect(acct.passwordHash).not.toBe(after.passwordHash);
  });
});

describe('setStatus + last-active-Lead guard', () => {
  it('disables and re-enables an account', async () => {
    await enroll(dewi, SEED_LEAD.username);
    setStatus('dewi', 'disabled');
    expect(getAccount('dewi')?.status).toBe('disabled');
    setStatus('dewi', 'active');
    expect(getAccount('dewi')?.status).toBe('active');
  });

  it('refuses to disable the last active Lead', async () => {
    await ensureSeeded(); // seeds 2 Leads (alice + bob) — reduce to one before testing the guard
    setStatus(otherLead.username, 'disabled');
    expect(() => setStatus(SEED_LEAD.username, 'disabled')).toThrow(EnrollError);
  });

  it('allows disabling a Lead when another active Lead remains', async () => {
    await ensureSeeded(); // alice + bob are both already active Leads
    await enroll(
      { ...dewi, username: 'sari', displayName: 'Sari', role: 'lead' },
      SEED_LEAD.username,
    );
    expect(() => setStatus(SEED_LEAD.username, 'disabled')).not.toThrow();
    expect(getAccount(SEED_LEAD.username)?.status).toBe('disabled');
  });
});

describe('setRole + setTeam (reassignment)', () => {
  it('changes a role and team', async () => {
    await enroll(dewi, SEED_LEAD.username);
    setRole('dewi', 'approver');
    setTeam('dewi', 'platform');
    const a = getAccount('dewi')!;
    expect(a.role).toBe('approver');
    expect(a.teamId).toBe('platform');
  });
  it('refuses to demote the last active Lead', async () => {
    await ensureSeeded(); // seeds 2 Leads (alice + bob) — reduce to one before testing the guard
    setStatus(otherLead.username, 'disabled');
    expect(() => setRole(SEED_LEAD.username, 'requester')).toThrow(EnrollError);
  });
  it('allows demoting a Lead when another active Lead remains', async () => {
    await ensureSeeded(); // alice + bob are both already active Leads
    await enroll(
      { ...dewi, username: 'sari', displayName: 'Sari', role: 'lead' },
      SEED_LEAD.username,
    );
    expect(() => setRole(SEED_LEAD.username, 'requester')).not.toThrow();
    expect(getAccount(SEED_LEAD.username)?.role).toBe('requester');
  });
});

describe('resolveName', () => {
  it('uses the account display name when enrolled', async () => {
    await enroll(dewi, SEED_LEAD.username);
    expect(resolveName('dewi')).toBe('Dewi');
  });
  it('humanizes an unknown id (historical authors)', () => {
    expect(resolveName('rizky')).toBe('Rizky');
    expect(resolveName('foo.bar_baz')).toBe('Foo Bar Baz');
  });
});

describe('admin capability (ADR-0011)', () => {
  it('seeds the bootstrap Lead as admin', async () => {
    await ensureSeeded();
    expect(getAccount(SEED_LEAD.username)?.isAdmin).toBe(true);
  });

  it('can grant and revoke admin on another account', async () => {
    await ensureSeeded();
    await enroll(dewi, SEED_LEAD.username);
    expect(getAccount('dewi')?.isAdmin ?? false).toBe(false);
    setAdmin('dewi', true);
    expect(getAccount('dewi')?.isAdmin).toBe(true);
    setAdmin('dewi', false);
    expect(getAccount('dewi')?.isAdmin).toBe(false);
  });

  it('refuses to remove the last active admin', async () => {
    await ensureSeeded(); // SEED_LEAD (alice) is the only admin — none of SEED_ACCOUNTS carry isAdmin
    expect(() => setAdmin(SEED_LEAD.username, false)).toThrow(EnrollError);
    // With a second admin, revoking the first is allowed.
    await enroll(dewi, SEED_LEAD.username);
    setAdmin('dewi', true);
    expect(() => setAdmin(SEED_LEAD.username, false)).not.toThrow();
  });
});

describe('seed-version refresh (the stuck-login papercut)', () => {
  it('refreshes a stale pre-version store to the current roster', async () => {
    // Simulate a browser opened before the roster change: a non-empty store
    // holding the OLD single "putra" lead, seeded at no/older version (reset
    // leaves the version at 0; enroll does not bump it).
    await enroll(
      { username: 'putra', displayName: 'Putra', role: 'lead', teamId: 'platform', password: 'ccp-lead' },
      'system',
    );
    expect(getAccount('putra')).toBeTruthy();

    await ensureSeeded();

    // The stale store is refreshed to the current roster — the old account is
    // gone and the current name-password logins work.
    expect(getAccount('putra'), 'stale account cleared').toBeUndefined();
    const alice = getAccount('alice');
    expect(alice, 'current roster seeded').toBeTruthy();
    expect(alice ? await verifyPassword(alice, 'alice') : false).toBe(true);
  });

  it('does NOT wipe a current-version store — enrolled accounts survive a re-run', async () => {
    await ensureSeeded(); // seeds at the current version
    await enroll(
      { username: 'newbie', displayName: 'Newbie', role: 'requester', teamId: 'erp-basis', password: 'password1' },
      SEED_LEAD.username,
    );
    await ensureSeeded(); // re-run at the same version → must be a no-op, no wipe
    expect(getAccount('newbie'), 'enrolled account preserved').toBeTruthy();
    expect(getAccount('alice'), 'roster intact').toBeTruthy();
  });
});

describe('subscribeAccountsChanged — the roster external-store source (0025 RX-4)', () => {
  it('fires on every write: enroll, role/team/status changes, admin grant', async () => {
    let calls = 0;
    const unsubscribe = subscribeAccountsChanged(() => (calls += 1));
    await ensureSeeded();
    expect(calls).toBe(1);
    await enroll(dewi, SEED_LEAD.username);
    expect(calls).toBe(2);
    setRole('dewi', 'approver');
    expect(calls).toBe(3);
    setTeam('dewi', 'platform');
    expect(calls).toBe(4);
    setStatus('dewi', 'disabled');
    expect(calls).toBe(5);
    setAdmin('dewi', true);
    expect(calls).toBe(6);
    unsubscribe();
  });

  it('unsubscribing stops further notifications', async () => {
    let calls = 0;
    const unsubscribe = subscribeAccountsChanged(() => (calls += 1));
    unsubscribe();
    await ensureSeeded();
    expect(calls).toBe(0);
  });
});
