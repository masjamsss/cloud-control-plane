import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry as LocalAuditEntry } from '@/lib/audit';
import type { AuditEntry as ServerAuditEntry, AuditExport, HttpApiClient } from '@/lib/httpApi';
import {
  describeServerEntry,
  exportAuditVia,
  humanizeAction,
  loadAuditRows,
  localAuditExport,
  localEntryToRow,
  serverEntryToRow,
} from '@/features/admin/auditFlow';

/**
 * Proves the 0015 §B3 / 0014 P1 #4 fix: AuditHistory.tsx used to render
 * lib/audit's local entries UNCONDITIONALLY, only toggling the "recorded
 * locally and advisory" note on `can('audit')`. Once Lane B flipped that flag
 * true in api mode, the note would have disappeared while the timeline still
 * showed this browser's own (client-forgeable) history, not ccp-api's
 * hash-chained log — a trust label that lies. This file is the honesty proof
 * for the fix, mirroring authFlow.test.ts's fake-client approach (no jsdom in
 * this repo — see test/standalone.test.ts — so the branching function itself
 * is what's under test, not a rendered/clicked component).
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
    resetAccountTotp: notUsed,
    revokeAccountSessions: notUsed,
    ...over,
  } as unknown as HttpApiClient;
}

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

function serverEntry(over: Partial<ServerAuditEntry> = {}): ServerAuditEntry {
  return {
    id: '01J000',
    at: '2026-07-10T08:00:00Z',
    actor: 'putra',
    action: 'team-create',
    targetType: 'team',
    targetId: 'platform',
    prevHash: '',
    hash: 'h1',
    ...over,
  };
}

let localEntries: LocalAuditEntry[] = [];
beforeEach(() => {
  localEntries = [
    {
      id: 'local-1',
      at: '2026-07-09T00:00:00Z',
      actor: 'dewi',
      action: 'Enrolled user',
      summary: 'Dewi (@dewi) — Requester, ERP Basis',
      projectId: 'sample',
    },
  ];
});

describe('humanizeAction — the generic fallback for actions this view has no bespoke format for', () => {
  it('kebab-case → capitalized first word, rest lowercase, spaces for dashes', () => {
    expect(humanizeAction('policy-change')).toBe('Policy change');
    expect(humanizeAction('account-update')).toBe('Account update');
  });
  it('a single word is just capitalized', () => {
    expect(humanizeAction('freeze')).toBe('Freeze');
  });
});

describe('describeServerEntry — exact wording for the flows this build actually wires', () => {
  it('team-create: the created name', () => {
    const e = serverEntry({
      action: 'team-create',
      targetId: 'platform',
      after: { name: 'Platform', serviceSlugs: [] },
    });
    expect(describeServerEntry(e)).toEqual({ action: 'Created team', summary: 'Platform' });
  });

  it('team-rename: before name → after name', () => {
    const e = serverEntry({
      action: 'team-rename',
      targetId: 'platform',
      before: { name: 'Platform' },
      after: { name: 'Core Platform' },
    });
    expect(describeServerEntry(e)).toEqual({
      action: 'Renamed team',
      summary: 'Platform → Core Platform',
    });
  });

  it('team-set-services: the target id (bulk op — no per-slug diff rendered)', () => {
    const e = serverEntry({ action: 'team-set-services', targetId: 'platform' });
    expect(describeServerEntry(e)).toEqual({
      action: 'Updated team services',
      summary: 'platform',
    });
  });

  it('team-delete: the deleted name from `before`', () => {
    const e = serverEntry({
      action: 'team-delete',
      targetId: 'platform',
      before: { name: 'Platform' },
    });
    expect(describeServerEntry(e)).toEqual({ action: 'Deleted team', summary: 'Platform' });
  });

  it('totp-reset: the account, @-prefixed', () => {
    const e = serverEntry({ action: 'totp-reset', targetType: 'account', targetId: 'dewi' });
    expect(describeServerEntry(e)).toEqual({ action: 'Reset TOTP', summary: '@dewi' });
  });

  it('sessions-revoke: the account, @-prefixed', () => {
    const e = serverEntry({ action: 'sessions-revoke', targetType: 'account', targetId: 'dewi' });
    expect(describeServerEntry(e)).toEqual({ action: 'Revoked sessions', summary: '@dewi' });
  });

  it('an unknown action (project-wide chain may hold any admin action) degrades honestly, never throws', () => {
    const e = serverEntry({ action: 'policy-change', targetType: 'policy', targetId: 'POLICY' });
    expect(describeServerEntry(e)).toEqual({ action: 'Policy change', summary: 'policy POLICY' });
  });

  it('team-rename with a malformed before/after still falls back to the target id, not a crash', () => {
    const e = serverEntry({
      action: 'team-rename',
      targetId: 'platform',
      before: undefined,
      after: undefined,
    });
    expect(describeServerEntry(e)).toEqual({ action: 'Renamed team', summary: 'platform' });
  });
});

describe('serverEntryToRow / localEntryToRow — both project into the same AuditRow shape', () => {
  it('server entry', () => {
    const e = serverEntry({
      action: 'totp-reset',
      targetType: 'account',
      targetId: 'dewi',
      at: '2026-07-10T09:00:00Z',
      actor: 'putra',
      id: 'srv-1',
    });
    expect(serverEntryToRow(e)).toEqual({
      id: 'srv-1',
      at: '2026-07-10T09:00:00Z',
      actor: 'putra',
      action: 'Reset TOTP',
      summary: '@dewi',
    });
  });

  it('local entry passes through unchanged', () => {
    expect(localEntryToRow(localEntries[0]!)).toEqual({
      id: 'local-1',
      at: '2026-07-09T00:00:00Z',
      actor: 'dewi',
      action: 'Enrolled user',
      summary: 'Dewi (@dewi) — Requester, ERP Basis',
    });
  });
});

describe('loadAuditRows — which store answers the timeline', () => {
  it('authoritative + client: reads ccp-api (GET /admin/audit), not the local list', async () => {
    const items = [serverEntry({ id: 'srv-1' })];
    const listAuditEntries = spy(async () => ({ items }));
    const rows = await loadAuditRows(true, fakeClient({ listAuditEntries }), localEntries);
    expect(listAuditEntries.calls).toEqual([[]]);
    expect(rows).toEqual([serverEntryToRow(items[0]!)]);
  });

  it('not authoritative: the exact pre-existing local list — the server is never called', async () => {
    const listAuditEntries = spy(NEVER_CALLED);
    const rows = await loadAuditRows(false, fakeClient({ listAuditEntries }), localEntries);
    expect(listAuditEntries.calls).toEqual([]);
    expect(rows).toEqual(localEntries.map(localEntryToRow));
  });

  it('authoritative but no client (defensive): still falls back to the local list', async () => {
    const rows = await loadAuditRows(true, null, localEntries);
    expect(rows).toEqual(localEntries.map(localEntryToRow));
  });
});

describe('exportAuditVia', () => {
  it('calls client.exportAudit() and returns its document verbatim', async () => {
    const doc: AuditExport = {
      projectId: 'sample',
      head: 'h9',
      count: 1,
      verified: true,
      verification: { code: 0, message: 'ok: 1 entry intact' },
      entries: [serverEntry()],
    };
    const exportAudit = spy(async () => doc);
    const result = await exportAuditVia(fakeClient({ exportAudit }));
    expect(exportAudit.calls).toEqual([[]]);
    expect(result).toEqual(doc);
  });
});

describe('localAuditExport — the demo export document (no fake chain)', () => {
  it('wraps the local entries with the project id, a count, and an explicit local source', () => {
    const entries: LocalAuditEntry[] = [
      { id: '1', at: '2026-07-16T01:00:00Z', actor: 'putra', action: 'Created team', summary: 'Network', projectId: 'sample' },
      { id: '2', at: '2026-07-16T02:00:00Z', actor: 'putra', action: 'Reset TOTP', summary: '@dewi', projectId: 'sample' },
    ];
    const doc = localAuditExport('sample', entries);
    expect(doc).toEqual({ projectId: 'sample', source: 'browser-local', count: 2, entries });
    // Honesty: the local document never pretends to be the verified chain.
    expect(doc).not.toHaveProperty('verified');
    expect(doc).not.toHaveProperty('head');
  });

  it('an empty log still exports a well-formed document', () => {
    expect(localAuditExport('sample', [])).toEqual({
      projectId: 'sample',
      source: 'browser-local',
      count: 0,
      entries: [],
    });
  });
});
