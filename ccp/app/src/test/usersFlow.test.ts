import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountDeleteResult,
  AdminAccount,
  AdminWriteOutcome,
  HttpApiClient,
  ServerProject,
  SessionRevokeResult,
  TotpResetResult,
} from '@/lib/httpApi';
import type { Role } from '@/types';
import {
  ALL_ACCOUNTS_LABEL,
  ALL_ACCOUNTS_NOTE,
  ALL_ACCOUNTS_SCOPE,
  addAssignmentVia,
  assignmentsOf,
  blockedRemoveReason,
  deleteAccountVia,
  describeAccountDelete,
  describeAccountWrite,
  describeSessionsRevoked,
  describeTotpReset,
  enrollVia,
  isSeniorRole,
  loadAccountsVia,
  loadAssignableScopesVia,
  loadTeamsForScopeVia,
  removeAssignmentVia,
  renameAccountVia,
  resetAccountPasswordVia,
  resetAccountTotpVia,
  revokeAccountSessionsVia,
  scopeLabelFor,
  setAccountRoleVia,
  setAccountStatusVia,
  setAccountTeamVia,
  setAssignmentTeamVia,
} from '@/features/admin/usersFlow';
import {
  enroll,
  getAccount,
  listAccounts,
  resetStoreForTests as resetAccounts,
  setSecurityStateForTests,
  type Account,
} from '@/lib/accounts';

/**
 * Proves the B1 fix: UsersAdmin.tsx used to gate its
 * ENTIRE surface on the one `can('users')` flag (`authoritative`), but only
 * ever wired reset-TOTP/revoke-sessions to it — enrol/role/team/status/
 * password-reset stayed hardcoded `disabled` and wrote straight to
 * lib/accounts's localStorage regardless of mode. B1 wires those five through
 * too. This file proves every wired action calls the httpApi methods verbatim
 * when authoritative (mirrors authFlow.test.ts's / teamsFlow.test.ts's
 * fake-client approach — no jsdom in this repo, so the extracted function is
 * what's under test) and is byte-for-byte the pre-existing lib/accounts
 * behavior when it isn't; the componentCoverage half of the proof (every
 * control's `disabled` attribute actually tracks `authoritative`) lives in
 * advisoryGate.test.ts against the real AccountRow component. The isAdmin
 * grant/revoke toggle is NOT part of B1 and has no `xxxVia` counterpart here —
 * UsersAdmin.tsx calls lib/accounts's `setAdmin` directly, unconditionally.
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
    me: notUsed,
    logout: notUsed,
    listAuditEntries: notUsed,
    exportAudit: notUsed,
    listAdminTeams: notUsed,
    createAdminTeam: notUsed,
    renameAdminTeam: notUsed,
    setAdminTeamServices: notUsed,
    deleteAdminTeam: notUsed,
    listAdminAccounts: notUsed,
    createAdminAccount: notUsed,
    setAccountRole: notUsed,
    setAccountTeam: notUsed,
    setAccountRoleOn: notUsed,
    setAccountTeamOn: notUsed,
    revokeAccountRoleOn: notUsed,
    setAccountStatus: notUsed,
    resetAccountPassword: notUsed,
    resetAccountTotp: notUsed,
    revokeAccountSessions: notUsed,
    listServerProjects: notUsed,
    ...over,
  } as unknown as HttpApiClient;
}

/** A hand-rolled spy (this repo doesn't use vitest's vi.fn — see
 * authFlow.test.ts's identical helper). Records every call's arguments. */
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

const NEVER_CALLED = (): never => {
  throw new Error('server must not be called when not authoritative');
};

beforeEach(() => {
  resetAccounts();
});

describe('resetAccountTotpVia', () => {
  it('authoritative: calls client.resetAccountTotp(accountId) verbatim and returns its result', async () => {
    const result: TotpResetResult = { ok: true, totpReset: true, sessionsRevoked: 2 };
    const resetAccountTotp = spy(async () => result);
    const out = await resetAccountTotpVia(true, fakeClient({ resetAccountTotp }), 'dewi');
    expect(resetAccountTotp.calls).toEqual([['dewi']]);
    expect(out).toEqual(result);
  });

  it('a server rejection (e.g. unknown account) propagates — the caller surfaces its reason', async () => {
    const resetAccountTotp = spy(async (): Promise<TotpResetResult> => {
      throw new Error('No such account.');
    });
    await expect(resetAccountTotpVia(true, fakeClient({ resetAccountTotp }), 'ghost')).rejects.toThrow(
      'No such account.',
    );
  });

  it('not authoritative: clears the demo enrolment + sessions and reports the real count — the server is never called', async () => {
    const resetAccountTotp = spy(NEVER_CALLED);
    await enroll({ username: 'dewi', displayName: 'Dewi', role: 'approver', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    setSecurityStateForTests('dewi', { totpEnrolled: true, activeSessions: 3 });
    const out = await resetAccountTotpVia(false, fakeClient({ resetAccountTotp }), 'dewi');
    expect(resetAccountTotp.calls).toEqual([]);
    expect(out).toEqual({ ok: true, totpReset: true, sessionsRevoked: 3 });
    expect(getAccount('dewi')?.totpEnrolled).toBe(false);
    expect(getAccount('dewi')?.activeSessions).toBe(0);
  });

  it('not authoritative + unknown account: throws a plain reason (same contract as the server refusal)', async () => {
    await expect(resetAccountTotpVia(false, null, 'ghost')).rejects.toThrow('No such account.');
  });
});

describe('revokeAccountSessionsVia', () => {
  it('authoritative: calls client.revokeAccountSessions(accountId) verbatim and returns its result', async () => {
    const result: SessionRevokeResult = { ok: true, sessionsRevoked: 1 };
    const revokeAccountSessions = spy(async () => result);
    const out = await revokeAccountSessionsVia(true, fakeClient({ revokeAccountSessions }), 'putra');
    expect(revokeAccountSessions.calls).toEqual([['putra']]);
    expect(out).toEqual(result);
  });

  it('not authoritative: zeroes the demo session count and reports what was cleared — the server is never called', async () => {
    const revokeAccountSessions = spy(NEVER_CALLED);
    await enroll({ username: 'putra', displayName: 'Putra', role: 'lead', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    setSecurityStateForTests('putra', { totpEnrolled: true, activeSessions: 2 });
    const out = await revokeAccountSessionsVia(false, fakeClient({ revokeAccountSessions }), 'putra');
    expect(revokeAccountSessions.calls).toEqual([]);
    expect(out).toEqual({ ok: true, sessionsRevoked: 2 });
    expect(getAccount('putra')?.activeSessions).toBe(0);
    // Sessions cleared; the authenticator itself is untouched by a plain revoke.
    expect(getAccount('putra')?.totpEnrolled).toBe(true);
  });
});

describe('describeTotpReset', () => {
  it('pluralizes the revoked-session count', () => {
    expect(describeTotpReset({ ok: true, totpReset: true, sessionsRevoked: 0 })).toBe(
      '2FA reset — 0 sessions revoked.',
    );
    expect(describeTotpReset({ ok: true, totpReset: true, sessionsRevoked: 1 })).toBe(
      '2FA reset — 1 session revoked.',
    );
    expect(describeTotpReset({ ok: true, totpReset: true, sessionsRevoked: 3 })).toBe(
      '2FA reset — 3 sessions revoked.',
    );
  });
});

describe('describeSessionsRevoked', () => {
  it('pluralizes the revoked-session count', () => {
    expect(describeSessionsRevoked({ ok: true, sessionsRevoked: 1 })).toBe('1 session revoked.');
    expect(describeSessionsRevoked({ ok: true, sessionsRevoked: 2 })).toBe('2 sessions revoked.');
  });
});

describe('loadAccountsVia', () => {
  const remote: AdminAccount[] = [
    {
      id: 'b', username: 'b', displayName: 'Bravo', role: 'requester', teamId: 'platform',
      status: 'active', isAdmin: false, mustChangePassword: false, totpEnrolled: false,
      createdAt: '2026-07-01T00:00:00Z', createdBy: 'system',
    },
    {
      id: 'a', username: 'a', displayName: 'Alpha', role: 'lead', teamId: 'platform',
      status: 'active', isAdmin: true, mustChangePassword: false, totpEnrolled: true,
      createdAt: '2026-07-01T00:00:00Z', createdBy: 'system',
    },
  ];

  it('authoritative + client: lists from ccp-api, sorted by displayName — not lib/accounts', async () => {
    const listAdminAccounts = spy(async () => remote);
    const result = await loadAccountsVia(true, fakeClient({ listAdminAccounts }));
    expect(listAdminAccounts.calls).toEqual([[]]);
    expect(result.map((a) => a.displayName)).toEqual(['Alpha', 'Bravo']);
    expect(result.map((a) => a.isAdmin)).toEqual([true, false]);
  });

  it('a server-sourced row never carries real local credential material (placeholders only)', async () => {
    const listAdminAccounts = spy(async () => remote);
    const [alpha] = await loadAccountsVia(true, fakeClient({ listAdminAccounts }));
    expect(alpha).toMatchObject({ passwordHash: '', salt: '', iterations: 0 });
  });

  it('not authoritative: falls back to lib/accounts — the server is never called', async () => {
    const listAdminAccounts = spy(NEVER_CALLED);
    const result = await loadAccountsVia(false, fakeClient({ listAdminAccounts }));
    expect(listAdminAccounts.calls).toEqual([]);
    expect(result).toEqual(listAccounts());
  });

  it('authoritative but no client (defensive): still falls back to lib/accounts', async () => {
    expect(await loadAccountsVia(true, null)).toEqual(listAccounts());
  });
});

describe('enrollVia', () => {
  const input = {
    username: 'nia', displayName: 'Nia', role: 'requester' as const, teamId: 'erp-basis',
    password: 'satu-dua-tiga-empat',
  };

  it('authoritative: calls client.createAdminAccount with the input verbatim and returns its outcome', async () => {
    const account: AdminAccount = {
      id: 'nia', username: 'nia', displayName: 'Nia', role: 'requester', teamId: 'erp-basis',
      status: 'active', isAdmin: false, mustChangePassword: true, totpEnrolled: false,
      createdAt: '2026-07-11T00:00:00Z', createdBy: 'putra',
    };
    const createAdminAccount = spy(async () => ({ applied: true as const, account }));
    const out = await enrollVia(true, fakeClient({ createAdminAccount }), input, 'putra');
    expect(createAdminAccount.calls).toEqual([[input]]);
    expect(out).toEqual({ applied: true, account });
  });

  it('authoritative: a dual-controlled (senior) enrol propagates the PENDING outcome — never a fabricated success', async () => {
    const createAdminAccount = spy(async () => ({ applied: false as const, pendingId: '01J' }));
    const out = await enrollVia(
      true,
      fakeClient({ createAdminAccount }),
      { ...input, username: 'zed', displayName: 'Zed', role: 'lead' },
      'putra',
    );
    expect(out).toEqual({ applied: false, pendingId: '01J' });
  });

  it('not authoritative: enrols via lib/accounts — the server is never called', async () => {
    const createAdminAccount = spy(NEVER_CALLED);
    const out = await enrollVia(false, fakeClient({ createAdminAccount }), input, 'putra');
    expect(createAdminAccount.calls).toEqual([]);
    expect(out.applied).toBe(true);
    if (out.applied) expect(out.account.username).toBe('nia');
    expect(getAccount('nia')).toBeTruthy();
  });
});

describe('setAccountRoleVia', () => {
  it('authoritative: calls client.setAccountRole(id, role) verbatim', async () => {
    const setAccountRole = spy(async () => ({ applied: true as const }));
    const out = await setAccountRoleVia(true, fakeClient({ setAccountRole }), 'sari', 'lead');
    expect(setAccountRole.calls).toEqual([['sari', 'lead']]);
    expect(out).toEqual({ applied: true });
  });

  it('authoritative: a dual-controlled promotion propagates the PENDING outcome', async () => {
    const setAccountRole = spy(async () => ({ applied: false as const, pendingId: '01K' }));
    const out = await setAccountRoleVia(true, fakeClient({ setAccountRole }), 'sari', 'lead');
    expect(out).toEqual({ applied: false, pendingId: '01K' });
  });

  it('not authoritative: sets via lib/accounts — the server is never called', async () => {
    const setAccountRole = spy(NEVER_CALLED);
    await enroll({ username: 'sari', displayName: 'Sari', role: 'requester', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    const out = await setAccountRoleVia(false, fakeClient({ setAccountRole }), 'sari', 'lead');
    expect(setAccountRole.calls).toEqual([]);
    expect(out).toEqual({ applied: true });
    expect(getAccount('sari')?.role).toBe('lead');
  });
});

describe('setAccountTeamVia', () => {
  it('authoritative: calls client.setAccountTeam(id, teamId) verbatim', async () => {
    const setAccountTeam = spy(async () => ({ applied: true as const }));
    const out = await setAccountTeamVia(true, fakeClient({ setAccountTeam }), 'sari', 'platform');
    expect(setAccountTeam.calls).toEqual([['sari', 'platform']]);
    expect(out).toEqual({ applied: true });
  });

  it('not authoritative: sets via lib/accounts — the server is never called', async () => {
    const setAccountTeam = spy(NEVER_CALLED);
    await enroll({ username: 'sari', displayName: 'Sari', role: 'requester', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    const out = await setAccountTeamVia(false, fakeClient({ setAccountTeam }), 'sari', 'platform');
    expect(setAccountTeam.calls).toEqual([]);
    expect(out).toEqual({ applied: true });
    expect(getAccount('sari')?.teamId).toBe('platform');
  });
});

describe('setAccountStatusVia', () => {
  it('authoritative: calls client.setAccountStatus(id, status) verbatim', async () => {
    const setAccountStatus = spy(async () => ({ applied: false as const, pendingId: '01L' }));
    const out = await setAccountStatusVia(true, fakeClient({ setAccountStatus }), 'sari', 'active');
    expect(setAccountStatus.calls).toEqual([['sari', 'active']]);
    expect(out).toEqual({ applied: false, pendingId: '01L' });
  });

  it('not authoritative: sets via lib/accounts — the server is never called', async () => {
    const setAccountStatus = spy(NEVER_CALLED);
    await enroll({ username: 'budi', displayName: 'Budi', role: 'requester', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    const out = await setAccountStatusVia(false, fakeClient({ setAccountStatus }), 'budi', 'disabled');
    expect(setAccountStatus.calls).toEqual([]);
    expect(out).toEqual({ applied: true });
    expect(getAccount('budi')?.status).toBe('disabled');
  });
});

describe('resetAccountPasswordVia', () => {
  it('authoritative: calls client.resetAccountPassword(id, newPassword) verbatim', async () => {
    const resetAccountPassword = spy(async () => ({ applied: true as const }));
    const out = await resetAccountPasswordVia(true, fakeClient({ resetAccountPassword }), 'sari', 'baru-sekali-delapan');
    expect(resetAccountPassword.calls).toEqual([['sari', 'baru-sekali-delapan']]);
    expect(out).toEqual({ applied: true });
  });

  it('not authoritative: resets via lib/accounts — the server is never called', async () => {
    const resetAccountPassword = spy(NEVER_CALLED);
    await enroll({ username: 'sari', displayName: 'Sari', role: 'requester', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    const out = await resetAccountPasswordVia(false, fakeClient({ resetAccountPassword }), 'sari', 'baru-sekali-delapan');
    expect(resetAccountPassword.calls).toEqual([]);
    expect(out).toEqual({ applied: true });
    expect(getAccount('sari')?.mustChangePassword).toBe(true);
  });
});

describe('renameAccountVia — display name only, never an authorization change', () => {
  it('authoritative: calls client.renameAccount(id, trimmedName) verbatim', async () => {
    const renameAccount = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    const out = await renameAccountVia(true, fakeClient({ renameAccount }), 'sari', '  Sari Wijaya  ');
    expect(renameAccount.calls).toEqual([['sari', 'Sari Wijaya']]);
    expect(out).toEqual({ applied: true });
  });

  it('a server rejection (e.g. bundled-with-a-verb 422) propagates its reason', async () => {
    const renameAccount = spy(async (): Promise<AdminWriteOutcome> => {
      throw new Error('The request could not be validated.');
    });
    await expect(renameAccountVia(true, fakeClient({ renameAccount }), 'sari', 'X')).rejects.toThrow(
      'could not be validated',
    );
  });

  it('not authoritative: renames via lib/accounts — the server is never called', async () => {
    const renameAccount = spy(NEVER_CALLED);
    await enroll({ username: 'sari', displayName: 'Sari', role: 'requester', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    const out = await renameAccountVia(false, fakeClient({ renameAccount }), 'sari', 'Sari Wijaya');
    expect(renameAccount.calls).toEqual([]);
    expect(out).toEqual({ applied: true });
    expect(getAccount('sari')?.displayName).toBe('Sari Wijaya');
  });
});

describe('deleteAccountVia — permanent, guard errors surface as-is', () => {
  it('authoritative: calls client.deleteAccount(id) verbatim and returns its result', async () => {
    const result: AccountDeleteResult = { ok: true, deleted: true, sessionsRevoked: 2 };
    const deleteAccount = spy(async () => result);
    const out = await deleteAccountVia(true, fakeClient({ deleteAccount }), 'dewi', 'putra');
    expect(deleteAccount.calls).toEqual([['dewi']]);
    expect(out).toEqual(result);
  });

  it("authoritative: the server's fail-closed refusal (last lead / self) propagates for the row to show", async () => {
    const deleteAccount = spy(async (): Promise<AccountDeleteResult> => {
      throw new Error('That would remove the last active Lead/admin.');
    });
    await expect(deleteAccountVia(true, fakeClient({ deleteAccount }), 'putra', 'gita')).rejects.toThrow(
      'last active Lead',
    );
  });

  it('not authoritative: removes via lib/accounts — the server is never called and the row is gone', async () => {
    const deleteAccount = spy(NEVER_CALLED);
    await enroll({ username: 'sari', displayName: 'Sari', role: 'requester', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    const out = await deleteAccountVia(false, fakeClient({ deleteAccount }), 'sari', 'someone-else');
    expect(deleteAccount.calls).toEqual([]);
    expect(out).toEqual({ ok: true, deleted: true, sessionsRevoked: 0 });
    expect(getAccount('sari')).toBeUndefined();
  });

  it('not authoritative: deleting YOURSELF is refused locally too (mirror of the server guard)', async () => {
    await enroll({ username: 'sari', displayName: 'Sari', role: 'requester', teamId: 'erp-basis', password: 'satu-dua-tiga-empat' }, 'system');
    await expect(deleteAccountVia(false, fakeClient(), 'sari', 'sari')).rejects.toThrow(
      'cannot delete your own account',
    );
    expect(getAccount('sari')).toBeTruthy();
  });
});

describe('describeAccountDelete', () => {
  it('names the account and pluralizes the signed-out sessions', () => {
    expect(describeAccountDelete('dewi', { ok: true, deleted: true, sessionsRevoked: 1 })).toBe(
      '@dewi deleted — 1 session signed out.',
    );
    expect(describeAccountDelete('dewi', { ok: true, deleted: true, sessionsRevoked: 0 })).toBe(
      '@dewi deleted — 0 sessions signed out.',
    );
  });
});

describe('blockedRemoveReason — a blocked Remove always says WHY', () => {
  const scopes = [{ id: 'sample', name: 'Sample' }, { id: 'acme', name: 'Acme Corp' }];
  const user = (id: string, roles: Record<string, { role: Role; teamId?: string }>, status: 'active' | 'disabled' = 'active'): Account =>
    ({ id, username: id, displayName: id, role: 'requester', teamId: '', status, roles } as unknown as Account);

  it("the '*' all-accounts entry is install-time — its reason is the standing note", () => {
    const dewi = user('dewi', { '*': { role: 'approver' } });
    expect(blockedRemoveReason(dewi, { scope: '*', role: 'approver' }, [dewi], scopes)).toBe(ALL_ACCOUNTS_NOTE);
  });

  it('the LAST active lead on an account cannot be removed — names the account in plain words', () => {
    const dewi = user('dewi', { sample: { role: 'lead' } });
    const other = user('budi', { sample: { role: 'approver' } });
    expect(blockedRemoveReason(dewi, { scope: 'sample', role: 'lead' }, [dewi, other], scopes)).toBe(
      "Can't remove the last lead on Sample — assign another lead first.",
    );
  });

  it('NOT blocked while another active lead covers the account — including an all-accounts lead', () => {
    const dewi = user('dewi', { sample: { role: 'lead' } });
    const otherLead = user('putra', { sample: { role: 'lead' } });
    expect(blockedRemoveReason(dewi, { scope: 'sample', role: 'lead' }, [dewi, otherLead], scopes)).toBeNull();
    const wildcardLead = user('putra', { '*': { role: 'lead' } });
    expect(blockedRemoveReason(dewi, { scope: 'sample', role: 'lead' }, [dewi, wildcardLead], scopes)).toBeNull();
  });

  it('a DISABLED other lead does not count as coverage (matches the server guard)', () => {
    const dewi = user('dewi', { sample: { role: 'lead' } });
    const disabledLead = user('putra', { sample: { role: 'lead' } }, 'disabled');
    expect(blockedRemoveReason(dewi, { scope: 'sample', role: 'lead' }, [dewi, disabledLead], scopes)).toBe(
      "Can't remove the last lead on Sample — assign another lead first.",
    );
  });

  it('non-lead assignments are never blocked; an empty directory gives no up-front verdict', () => {
    const dewi = user('dewi', { sample: { role: 'requester' }, acme: { role: 'lead' } });
    expect(blockedRemoveReason(dewi, { scope: 'sample', role: 'requester' }, [dewi], scopes)).toBeNull();
    expect(blockedRemoveReason(dewi, { scope: 'acme', role: 'lead' }, [], scopes)).toBeNull();
  });
});

describe('describeAccountWrite', () => {
  it('applied:true → "<label>." — a plain confirmation', () => {
    expect(describeAccountWrite({ applied: true }, 'Role updated')).toBe('Role updated.');
  });

  it("applied:false → pending-approval copy, never claims a success that hasn't happened yet", () => {
    expect(describeAccountWrite({ applied: false, pendingId: '01J' }, 'Role updated')).toBe(
      "Role updated — proposed, pending a second admin's approval.",
    );
  });
});

/* ── multi-account role + scope assignment ─────────────────────────────────────
 * The client verbs themselves (exact PATCH bodies) are proven in
 * httpApiAdmin.test.ts; these prove the FLOW layer routes each panel action to
 * the right per-account verb, reads the per-account role map, and scopes the
 * team list to the chosen account. */

function adminAccount(over: Partial<AdminAccount> = {}): AdminAccount {
  return {
    id: 'dewi', username: 'dewi', displayName: 'Dewi', role: 'requester', teamId: 'platform',
    status: 'active', isAdmin: false, mustChangePassword: false, totpEnrolled: false,
    createdAt: '2026-07-01T00:00:00Z', createdBy: 'system', ...over,
  };
}

// This fixture is aws-only by construction (accountId/region are always set,
// unconditionally) — `over` is narrowed to just ServerProject's aws arm so a
// caller can't (even in principle) mix in azure-only fields, and so `Partial`
// doesn't distribute across ServerProject's full provider-discriminated
// union here (0039 fix-wave S1: ServerProject widened to that union).
function serverProject(over: Partial<Extract<ServerProject, { accountId: string }>> = {}): ServerProject {
  return {
    id: 'acme', name: 'Acme Corp', github: { owner: 'acme', repo: 'infra' },
    accountId: '123456789012', region: 'ap-southeast-1', status: 'ready', ...over,
  };
}

describe('assignmentsOf — the user’s (scope, role) list', () => {
  it('reads the per-account roles map, wildcard first then alphabetical', () => {
    const account = { roles: { sample: { role: 'requester' }, acme: { role: 'lead', teamId: 'platform' }, '*': { role: 'approver' } } } as unknown as Account;
    expect(assignmentsOf(account, 'sample')).toEqual([
      { scope: '*', role: 'approver' },
      { scope: 'acme', role: 'lead', teamId: 'platform' },
      { scope: 'sample', role: 'requester' },
    ]);
  });

  it('degrades to a single scalar row on a mock/legacy account with no roles map', () => {
    const account = { role: 'approver', teamId: 'erp-basis' } as unknown as Account;
    expect(assignmentsOf(account, 'sample')).toEqual([{ scope: 'sample', role: 'approver', teamId: 'erp-basis' }]);
  });
});

describe('scopeLabelFor / isSeniorRole — plain-language helpers', () => {
  it('names the wildcard "All accounts" and a known account by its name; falls back to the id', () => {
    const scopes = [{ id: 'acme', name: 'Acme Corp' }];
    expect(scopeLabelFor(ALL_ACCOUNTS_SCOPE, scopes)).toBe(ALL_ACCOUNTS_LABEL);
    expect(scopeLabelFor('acme', scopes)).toBe('Acme Corp');
    expect(scopeLabelFor('unknown', scopes)).toBe('unknown');
  });

  it('a senior role is anything above requester (drives the dual-control hint)', () => {
    expect(isSeniorRole('requester')).toBe(false);
    expect(isSeniorRole('approver')).toBe(true);
    expect(isSeniorRole('lead')).toBe(true);
  });
});

describe('loadAssignableScopesVia — the scope dropdown’s options', () => {
  const active = { id: 'sample', name: 'Sample' };

  it('authoritative: the acting account plus every READY registered account (drafts excluded, deduped)', async () => {
    const listServerProjects = spy(async (): Promise<ServerProject[]> => [
      serverProject({ id: 'acme', name: 'Acme Corp', status: 'ready' }),
      serverProject({ id: 'beta', name: 'Beta', status: 'draft' }),
      serverProject({ id: 'sample', name: 'Sample', status: 'ready' }),
    ]);
    const out = await loadAssignableScopesVia(true, fakeClient({ listServerProjects }), active);
    expect(out).toEqual([
      { id: 'sample', name: 'Sample' },
      { id: 'acme', name: 'Acme Corp' },
    ]);
  });

  it('non-authoritative: just the acting account (the local store is single-account)', async () => {
    const out = await loadAssignableScopesVia(false, fakeClient(), active);
    expect(out).toEqual([active]);
  });
});

describe('loadTeamsForScopeVia — teams are per account', () => {
  it('authoritative: reads the CHOSEN account’s team list via the projectId override', async () => {
    const listAdminTeams = spy(async () => [{ id: 'erp-basis', name: 'ERP Basis', serviceSlugs: ['ec2'] }]);
    const out = await loadTeamsForScopeVia(true, fakeClient({ listAdminTeams }), 'acme');
    expect(listAdminTeams.calls).toEqual([[{ projectId: 'acme' }]]);
    expect(out).toEqual([{ id: 'erp-basis', name: 'ERP Basis', serviceSlugs: ['ec2'] }]);
  });

  it('the wildcard scope has no team dimension → empty, no server call', async () => {
    const listAdminTeams = spy(NEVER_CALLED);
    const out = await loadTeamsForScopeVia(true, fakeClient({ listAdminTeams }), ALL_ACCOUNTS_SCOPE);
    expect(listAdminTeams.calls).toEqual([]);
    expect(out).toEqual([]);
  });
});

describe('addAssignmentVia — grant/raise a role on one account', () => {
  it('authoritative: calls setAccountRoleOn(id, scope, role, team) verbatim', async () => {
    const setAccountRoleOn = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    const out = await addAssignmentVia(true, fakeClient({ setAccountRoleOn }), 'dewi', 'acme', 'requester', 'erp-basis');
    expect(setAccountRoleOn.calls).toEqual([['dewi', 'acme', 'requester', 'erp-basis']]);
    expect(out).toEqual({ applied: true });
  });

  it('a senior grant surfaces the dual-control proposal (applied:false) → "pending a second admin\'s approval"', async () => {
    const setAccountRoleOn = spy(async (): Promise<AdminWriteOutcome> => ({ applied: false, pendingId: '01Z' }));
    const out = await addAssignmentVia(true, fakeClient({ setAccountRoleOn }), 'dewi', 'acme', 'lead', 'platform');
    expect(out).toEqual({ applied: false, pendingId: '01Z' });
    expect(describeAccountWrite(out, 'Lead on Acme Corp')).toBe(
      "Lead on Acme Corp — proposed, pending a second admin's approval.",
    );
  });
});

describe('setAssignmentTeamVia / removeAssignmentVia — the other two panel verbs', () => {
  it('setAssignmentTeamVia calls setAccountTeamOn(id, scope, team)', async () => {
    const setAccountTeamOn = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    await setAssignmentTeamVia(true, fakeClient({ setAccountTeamOn }), 'dewi', 'acme', 'platform');
    expect(setAccountTeamOn.calls).toEqual([['dewi', 'acme', 'platform']]);
  });

  it('removeAssignmentVia calls revokeAccountRoleOn(id, scope)', async () => {
    const revokeAccountRoleOn = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    const out = await removeAssignmentVia(true, fakeClient({ revokeAccountRoleOn }), 'dewi', 'acme');
    expect(revokeAccountRoleOn.calls).toEqual([['dewi', 'acme']]);
    expect(out).toEqual({ applied: true });
  });
});

describe('accountFromAdmin carries the per-account roles map into the panel', () => {
  it('loadAccountsVia preserves account.roles so the summary/panel can read every scope', async () => {
    const remote = [adminAccount({ roles: { sample: { role: 'requester' }, acme: { role: 'lead', teamId: 'platform' } } })];
    const listAdminAccounts = spy(async () => remote);
    const [account] = await loadAccountsVia(true, fakeClient({ listAdminAccounts }));
    expect(account!.roles).toEqual({ sample: { role: 'requester' }, acme: { role: 'lead', teamId: 'platform' } });
  });
});
