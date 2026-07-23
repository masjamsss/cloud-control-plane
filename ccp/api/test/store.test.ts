import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError, type Item } from '../src/store/configStore';
import * as S from '../src/store/schema';

const ULID = '01J0000000000000000000000A';

/* One valid fixture per §2.1 entity, keyed via the helpers, and the field to drop
 * to prove a required field is enforced. */
const schemaCases: Array<{ name: string; schema: z.ZodTypeAny; valid: Item; drop: string }> = [
  {
    name: 'AccountItem',
    schema: S.AccountItem,
    valid: {
      ...S.accountKey('sari'),
      id: 'sari',
      username: 'sari',
      displayName: 'Sari',
      role: 'requester',
      teamId: 'app-platform',
      status: 'active',
      createdAt: '2026-07-11T00:00:00.000Z',
      createdBy: 'system',
      mustChangePassword: false,
      isAdmin: false,
      credential: { algo: 'argon2id', hash: 'x' },
      failedAttempts: 0,
      sessionVersion: 1,
    },
    drop: 'username',
  },
  {
    name: 'SessionItem',
    schema: S.SessionItem,
    valid: {
      ...S.sessionKey('deadbeef'),
      userId: 'sari',
      issuedAt: '2026-07-11T00:00:00.000Z',
      lastSeenAt: '2026-07-11T00:00:00.000Z',
      absoluteExpiresAt: '2026-07-11T12:00:00.000Z',
      sessionVersion: 1,
      ttl: 1_800_000_000,
      GSI1PK: S.sessionUserGsi('sari'),
    },
    drop: 'userId',
  },
  {
    name: 'TeamItem',
    schema: S.TeamItem,
    valid: { ...S.teamKey('sample', 'app-platform'), id: 'app-platform', name: 'App Platform', serviceSlugs: ['ec2', 'ebs'] },
    drop: 'name',
  },
  {
    name: 'PolicyItem',
    schema: S.PolicyItem,
    valid: { ...S.policyKey('sample'), low: 1, medium: 1, high: 2, deleteMin: 2, version: 1 },
    drop: 'high',
  },
  {
    name: 'RiskOverrideItem',
    schema: S.RiskOverrideItem,
    valid: { ...S.riskOverrideKey('sample', 'ebs-grow'), risk: 'HIGH', version: 1, setBy: 'putra', setAt: '2026-07-11T00:00:00.000Z' },
    drop: 'risk',
  },
  {
    name: 'SettingItem',
    schema: S.SettingItem,
    valid: { ...S.settingKey('sample', 'freeze.global'), key: 'freeze.global', value: false, version: 1, updatedBy: 'putra', updatedAt: '2026-07-11T00:00:00.000Z' },
    drop: 'updatedBy',
  },
  {
    name: 'RequestItem',
    schema: S.RequestItem,
    valid: {
      ...S.requestKey('sample', ULID),
      id: ULID,
      requestUlid: ULID,
      requester: 'sari',
      teamId: 'app-platform',
      service: 'ebs',
      operationId: 'ebs-grow',
      macd: 'Change',
      targetAddress: 'aws_ebs_volume.x',
      params: { new_size_gib: 250 },
      justification: 'grow the volume to 250 gib for month-end load',
      exposure: 'l1_with_guardrails',
      risk: 'MEDIUM',
      status: 'AWAITING_CODE_REVIEW',
      approvalsRequired: 1,
      approvals: [],
      schedule: { kind: 'now' },
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      events: [{ at: '2026-07-11T00:00:00.000Z', type: 'created', label: 'Requested by Sari', actor: 'sari' }],
      policyVersion: 1,
      GSI1PK: S.requestCollectionGsi('sample'),
      GSI1SK: ULID,
    },
    drop: 'requester',
  },
  {
    name: 'ApprovalItem',
    schema: S.ApprovalItem,
    valid: { ...S.approvalKey('sample', ULID, 'budi'), user: 'budi', at: '2026-07-11T00:00:00.000Z' },
    drop: 'user',
  },
  {
    name: 'RequestEventItem',
    schema: S.RequestEventItem,
    valid: { ...S.eventKey('sample', ULID, 2), at: '2026-07-11T00:00:00.000Z', type: 'approved', label: 'Approved by Budi (1/1)' },
    drop: 'label',
  },
  {
    name: 'PendingConfigChangeItem',
    schema: S.PendingConfigChangeItem,
    valid: {
      ...S.configChangeKey('sample', ULID),
      id: ULID,
      kind: 'policy-downgrade',
      before: { high: 2 },
      after: { high: 1 },
      targetKey: 'POLICY',
      proposedBy: 'putra',
      proposedAt: '2026-07-11T00:00:00.000Z',
      status: 'PENDING',
      expiresAt: '2026-07-14T00:00:00.000Z',
      GSI1PK: S.pendingConfigGsi('sample'),
    },
    drop: 'proposedBy',
  },
  {
    name: 'AuditItem',
    schema: S.AuditItem,
    valid: {
      ...S.auditKey('sample', '202607', ULID),
      id: ULID,
      projectId: 'sample',
      at: '2026-07-11T00:00:00.000Z',
      actor: 'sari',
      action: 'login',
      targetType: 'session',
      targetId: 'sari',
      prevHash: '',
      hash: 'abc',
    },
    drop: 'projectId',
  },
  {
    name: 'ChainHeadItem',
    schema: S.ChainHeadItem,
    valid: { ...S.chainHead('sample'), hash: 'abc', lastUlid: ULID, count: 1 },
    drop: 'hash',
  },
];

describe('§2.1 schemas round-trip', () => {
  for (const { name, schema, valid, drop } of schemaCases) {
    it(`${name}: parses a valid fixture and rejects one missing ${drop}`, () => {
      expect(schema.parse(valid)).toEqual(valid);
      const broken: Record<string, unknown> = { ...valid };
      delete broken[drop];
      expect(() => schema.parse(broken)).toThrow();
    });
  }
});

describe('MemoryStore basics', () => {
  it('put/get round-trips and returns a copy (no aliasing)', async () => {
    const store = new MemoryStore();
    const item: Item = { ...S.teamKey('sample', 'app-platform'), id: 'app-platform', name: 'App Platform', serviceSlugs: ['ec2'] };
    await store.put(item);
    const got = await store.get(item.PK, item.SK);
    expect(got).toEqual(item);
    (got!.serviceSlugs as string[]).push('mutated');
    const again = await store.get(item.PK, item.SK);
    expect(again!.serviceSlugs as string[]).toEqual(['ec2']);
  });

  it('query returns SK-ascending; queryGSI1 returns GSI1SK-ascending', async () => {
    const store = new MemoryStore();
    const pk = S.requestKey('sample', ULID).PK;
    await store.put({ PK: pk, SK: 'EVT#000002', n: 2 });
    await store.put({ PK: pk, SK: 'EVT#000001', n: 1 });
    await store.put({ PK: pk, SK: 'META', n: 0 });
    const evts = await store.query(pk, 'EVT#');
    expect(evts.map((e) => e.SK)).toEqual(['EVT#000001', 'EVT#000002']);

    const gsi = S.requestCollectionGsi('sample');
    await store.put({ PK: S.requestKey('sample', 'b').PK, SK: 'META', GSI1PK: gsi, GSI1SK: 'b' });
    await store.put({ PK: S.requestKey('sample', 'a').PK, SK: 'META', GSI1PK: gsi, GSI1SK: 'a' });
    const all = await store.queryGSI1(gsi);
    expect(all.map((i) => i.GSI1SK)).toEqual(['a', 'b']);
  });

  it('put ifNotExists on an existing key throws ConditionError', async () => {
    const store = new MemoryStore();
    const k = S.accountKey('sari');
    await store.put({ ...k, id: 'sari' });
    await expect(store.put({ ...k, id: 'sari2' }, { ifNotExists: true })).rejects.toBeInstanceOf(ConditionError);
  });
});

describe('MemoryStore.transact is all-or-nothing (DynamoDB semantics)', () => {
  it('a 2nd put that violates ifNotExists leaves the 1st NOT applied', async () => {
    const store = new MemoryStore();
    const existing = S.accountKey('budi');
    await store.put({ ...existing, id: 'budi' });
    const fresh = S.accountKey('sari');
    await expect(
      store.transact([
        { kind: 'put', item: { ...fresh, id: 'sari' } },
        { kind: 'put', item: { ...existing, id: 'dup' }, ifNotExists: true },
      ]),
    ).rejects.toBeInstanceOf(ConditionError);
    // the 1st put must NOT have landed
    expect(await store.get(fresh.PK, fresh.SK)).toBeNull();
    // the pre-existing item is untouched
    expect((await store.get(existing.PK, existing.SK))?.id).toBe('budi');
  });

  it('update ifEquals on a mismatched value throws and aborts the batch', async () => {
    const store = new MemoryStore();
    const head = S.chainHead('sample');
    await store.put({ ...head, hash: 'GENESIS', lastUlid: '', count: 0 });
    const other = S.requestKey('sample', ULID);
    await expect(
      store.transact([
        { kind: 'put', item: { ...other, id: ULID } },
        { kind: 'update', pk: head.PK, sk: head.SK, set: { hash: 'NEW', count: 1 }, ifEquals: { attr: 'hash', value: 'WRONG' } },
      ]),
    ).rejects.toBeInstanceOf(ConditionError);
    // batch aborted: neither the put nor the update applied
    expect(await store.get(other.PK, other.SK)).toBeNull();
    expect((await store.get(head.PK, head.SK))?.hash).toBe('GENESIS');
  });

  it('a fully-satisfied batch applies every write atomically', async () => {
    const store = new MemoryStore();
    const head = S.chainHead('sample');
    await store.put({ ...head, hash: 'GENESIS', lastUlid: '', count: 0 });
    const audit = S.auditKey('sample', '202607', ULID);
    await store.transact([
      { kind: 'put', item: { ...audit, id: ULID, hash: 'H1' }, ifNotExists: true },
      { kind: 'update', pk: head.PK, sk: head.SK, set: { hash: 'H1', lastUlid: ULID, count: 1 }, ifEquals: { attr: 'hash', value: 'GENESIS' } },
    ]);
    expect((await store.get(audit.PK, audit.SK))?.hash).toBe('H1');
    expect(await store.get(head.PK, head.SK)).toMatchObject({ hash: 'H1', count: 1 });
  });
});

describe('multi-project keying isolates everything except identity', () => {
  it('project-scoped items under "a" are invisible to the same query under "b"; accounts are shared', async () => {
    const store = new MemoryStore();
    // project-scoped: same logical team id, different projects
    await store.put({ ...S.teamKey('a', 'app-platform'), id: 'app-platform', name: 'A Basis', serviceSlugs: [] });
    await store.put({ ...S.teamKey('b', 'app-platform'), id: 'app-platform', name: 'B Basis', serviceSlugs: [] });
    expect((await store.get(S.teamKey('a', 'app-platform').PK, 'META'))?.name).toBe('A Basis');
    expect((await store.get(S.teamKey('b', 'app-platform').PK, 'META'))?.name).toBe('B Basis');

    // a request in project a is not returned by the project-b request collection
    await store.put({
      ...S.requestKey('a', ULID),
      id: ULID,
      GSI1PK: S.requestCollectionGsi('a'),
      GSI1SK: ULID,
    });
    expect(await store.queryGSI1(S.requestCollectionGsi('a'))).toHaveLength(1);
    expect(await store.queryGSI1(S.requestCollectionGsi('b'))).toHaveLength(0);

    // per-project audit chains are distinct partitions
    expect(S.chainHead('a').PK).not.toBe(S.chainHead('b').PK);

    // identity is GLOBAL: one account key regardless of project context
    await store.put({ ...S.accountKey('putra'), id: 'putra', isAdmin: true });
    expect(S.accountKey('putra').PK).toBe('ACCOUNT#putra');
    expect((await store.get('ACCOUNT#putra', 'META'))?.isAdmin).toBe(true);
  });
});
