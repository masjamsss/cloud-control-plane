import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpApiClient, ServerPendingChange } from '@/lib/httpApi';
import {
  ackPendingVia,
  loadPendingCountVia,
  loadPendingRowsVia,
  localPendingRows,
  rejectPendingVia,
} from '@/features/admin/pendingChangesFlow';
import {
  getPendingChange,
  proposePendingChange,
  resetPendingChangesForTests,
} from '@/lib/pendingChanges';

/**
 * The dual-control queue's honesty proof (the teamsFlow.test.ts pattern):
 * `authoritative=true` routes reads/decisions through ccp-api's
 * config-changes surface — the REAL §6 state machine, whose refusals
 * (SELF_ACK, STALE_PROPOSAL) propagate verbatim; `authoritative=false` is
 * exactly the pre-existing lib/pendingChanges local behavior.
 */

function fakeClient(over: Partial<HttpApiClient> = {}): HttpApiClient {
  const notUsed = (): never => {
    throw new Error('fakeClient: method not stubbed for this test');
  };
  return {
    listAdminConfigChanges: notUsed,
    ackAdminConfigChange: notUsed,
    rejectAdminConfigChange: notUsed,
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

function serverItem(over: Partial<ServerPendingChange> = {}): ServerPendingChange {
  return {
    id: '01A',
    kind: 'policy-downgrade',
    before: 2,
    after: 1,
    targetKey: 'POLICY',
    proposedBy: 'putra',
    proposedAt: '2026-07-11T00:00:00Z',
    status: 'PENDING',
    expiresAt: '2026-07-14T00:00:00Z',
    ...over,
  };
}

beforeEach(resetPendingChangesForTests);

describe('loadPendingRowsVia', () => {
  it('authoritative + client: maps the server list, NEWEST first (the GSI is ulid-ascending)', async () => {
    const listAdminConfigChanges = spy(async () => [
      serverItem({ id: '01A', proposedAt: '2026-07-11T00:00:00Z' }),
      serverItem({ id: '01B', proposedAt: '2026-07-12T00:00:00Z' }),
    ]);
    const rows = await loadPendingRowsVia(true, fakeClient({ listAdminConfigChanges }));
    expect(rows.map((r) => r.id)).toEqual(['01B', '01A']);
    expect(rows[0]).toMatchObject({
      kind: 'policy-downgrade',
      proposedBy: 'putra',
      status: 'PENDING',
      summary: 'POLICY: 2 → 1',
    });
  });

  it('not authoritative: the local store’s rows — the server is never called', async () => {
    proposePendingChange({
      proposedBy: 'putra',
      kind: 'limits',
      before: 50,
      after: 80,
      targetKey: 'limits.submissionsPerHour',
    });
    const listAdminConfigChanges = spy(NEVER_CALLED);
    const rows = await loadPendingRowsVia(false, fakeClient({ listAdminConfigChanges }));
    expect(listAdminConfigChanges.calls).toEqual([]);
    expect(rows).toEqual(localPendingRows());
    expect(rows[0]).toMatchObject({
      kind: 'limits',
      summary: 'limits.submissionsPerHour: 50 → 80',
    });
  });
});

describe('loadPendingCountVia', () => {
  it('authoritative: counts only PENDING items from the server list', async () => {
    const listAdminConfigChanges = spy(async () => [
      serverItem({ id: '01A' }),
      serverItem({ id: '01B', status: 'APPLIED' }),
    ]);
    expect(await loadPendingCountVia(true, fakeClient({ listAdminConfigChanges }))).toBe(1);
  });

  it('not authoritative: the local store’s pending count', async () => {
    proposePendingChange({ proposedBy: 'p', kind: 'k', before: 1, after: 2, targetKey: 't' });
    expect(await loadPendingCountVia(false, fakeClient())).toBe(1);
  });
});

describe('ackPendingVia / rejectPendingVia', () => {
  it('authoritative ack: POSTs and returns the decided row (APPLIED)', async () => {
    const ackAdminConfigChange = spy(async () =>
      serverItem({ status: 'APPLIED', ackBy: 'gita', ackAt: '2026-07-11T01:00:00Z' }),
    );
    const row = await ackPendingVia(true, fakeClient({ ackAdminConfigChange }), '01A');
    expect(ackAdminConfigChange.calls).toEqual([['01A']]);
    expect(row).toMatchObject({ id: '01A', status: 'APPLIED' });
  });

  it('authoritative ack: the server’s SELF_ACK refusal propagates verbatim (no local fallback)', async () => {
    const ackAdminConfigChange = spy(async (): Promise<ServerPendingChange> => {
      throw new Error('You cannot acknowledge your own proposal.');
    });
    await expect(ackPendingVia(true, fakeClient({ ackAdminConfigChange }), '01A')).rejects.toThrow(
      'You cannot acknowledge your own proposal.',
    );
  });

  it('authoritative reject: POSTs and returns the decided row (REJECTED)', async () => {
    const rejectAdminConfigChange = spy(async () =>
      serverItem({ status: 'REJECTED', ackBy: 'putra' }),
    );
    const row = await rejectPendingVia(true, fakeClient({ rejectAdminConfigChange }), '01A');
    expect(rejectAdminConfigChange.calls).toEqual([['01A']]);
    expect(row).toMatchObject({ id: '01A', status: 'REJECTED' });
  });

  it('not authoritative: the local transitions flip status in the local store — the server is never called', async () => {
    const a = proposePendingChange({
      proposedBy: 'p',
      kind: 'k',
      before: 1,
      after: 2,
      targetKey: 't',
    });
    const b = proposePendingChange({
      proposedBy: 'p',
      kind: 'k',
      before: 3,
      after: 4,
      targetKey: 'u',
    });
    const ackAdminConfigChange = spy(NEVER_CALLED);
    const rejectAdminConfigChange = spy(NEVER_CALLED);
    const client = fakeClient({ ackAdminConfigChange, rejectAdminConfigChange });

    const acked = await ackPendingVia(false, client, a.id);
    expect(acked).toMatchObject({ id: a.id, status: 'ACKED' });
    expect(getPendingChange(a.id)?.status).toBe('ACKED');

    const rejected = await rejectPendingVia(false, client, b.id);
    expect(rejected).toMatchObject({ id: b.id, status: 'REJECTED' });
    expect(getPendingChange(b.id)?.status).toBe('REJECTED');

    expect(ackAdminConfigChange.calls).toEqual([]);
    expect(rejectAdminConfigChange.calls).toEqual([]);
  });

  it('not authoritative + an unknown id: resolves undefined (a no-op, matching the local store)', async () => {
    expect(await ackPendingVia(false, fakeClient(), 'no-such-id')).toBeUndefined();
  });
});
