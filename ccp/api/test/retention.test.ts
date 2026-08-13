import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { MemoryStore } from '../src/store/memoryStore';
import { record } from '../src/domain/audit';
import { exportAuditChain } from '../src/domain/auditQuery';
import { mintSession, resolveSession, ABSOLUTE_MS, IDLE_MS } from '../src/auth/sessions';
import {
  AUDIT_CHAIN_RETENTION,
  IDEMPOTENCY_RETENTION_MS,
  idempotencyMarkerExpired,
  readLiveIdempotencyMarker,
  sessionUnresolvable,
  sweepUserSessions,
} from '../src/domain/retention';
import { accountKey, requestIdempotencyKey, sessionUserGsi } from '../src/store/schema';
import type { AccountItem, SessionItem } from '../src/store/schema';
import { __setNow } from '../src/clock';

/**
 * PERF-7 — the retention policy, as executable statements.
 *
 * Nothing in this store was ever purged. The fix is not "a cleanup job": it is
 * three separate policy decisions, one per class of data, and the third of them is
 * a product decision about the evidence store itself. These tests pin all three,
 * including the one whose correct implementation is to delete NOTHING — because a
 * policy that is only written in prose is a policy the next sweep will break.
 */

const T0 = Date.parse('2026-07-10T00:00:00.000Z');
const PID = 'p';

async function seedAccount(store: MemoryStore, id: string): Promise<AccountItem> {
  const acc = {
    ...accountKey(id),
    id,
    username: id,
    displayName: id,
    role: 'requester',
    status: 'active',
    sessionVersion: 3, // NOT zero — read it from the row, never assume the seed value
    passwordHash: 'x',
  } as unknown as AccountItem;
  await store.put(acc);
  return acc;
}

describe('PERF-7 — sessions are deleted once they can no longer be resolved', () => {
  afterEach(() => __setNow(null));

  it('sweeps rows the resolver would refuse, and keeps every row it would accept', async () => {
    const store = new MemoryStore();
    const acc = await seedAccount(store, 'alice');

    __setNow(() => T0);
    const stale = await mintSession(store, acc.id, acc.sessionVersion);
    // The second mint is placed while the FIRST is still resolvable, deliberately:
    // minting sweeps, so seeding the "live" session after the stale one had already
    // expired would have the fixture clean itself up and leave nothing to test.
    __setNow(() => T0 + IDLE_MS - 60_000);
    const live = await mintSession(store, acc.id, acc.sessionVersion);

    // L-1 — assert the fixture is actually in the state the test claims. A sweep
    // test whose "expired" row was never expired passes against no sweep at all.
    const now = T0 + IDLE_MS + 60_000;
    const rows = (await store.queryGSI1(sessionUserGsi(acc.id))) as SessionItem[];
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => sessionUnresolvable(r, now))).toHaveLength(1);
    expect((await resolveSession(store, stale, now)).ok).toBe(false);
    expect((await resolveSession(store, live, now)).ok).toBe(true);

    const swept = await sweepUserSessions(store, acc.id, now);
    expect(swept).toBe(1);

    const left = (await store.queryGSI1(sessionUserGsi(acc.id))) as SessionItem[];
    expect(left).toHaveLength(1);
    // The surviving row is still usable — the sweep is not allowed to log anyone out.
    expect((await resolveSession(store, live, now)).ok).toBe(true);
  });

  it('sweeps on mint, so an ordinary login clears what the previous ones left behind', async () => {
    const store = new MemoryStore();
    const acc = await seedAccount(store, 'bob');

    __setNow(() => T0);
    for (let i = 0; i < 5; i++) await mintSession(store, acc.id, acc.sessionVersion);
    expect(await store.queryGSI1(sessionUserGsi(acc.id))).toHaveLength(5);

    // A day later — every one of those is past absolute expiry. Logging in again is
    // the only event this needs; nothing is scheduled and no timer has to be armed.
    __setNow(() => T0 + ABSOLUTE_MS + 60_000);
    const fresh = await mintSession(store, acc.id, acc.sessionVersion);

    const left = (await store.queryGSI1(sessionUserGsi(acc.id))) as SessionItem[];
    expect(left).toHaveLength(1);
    expect((await resolveSession(store, fresh, T0 + ABSOLUTE_MS + 60_000)).ok).toBe(true);
  });

  it('never sweeps a session on account state alone — retention must not depend on a second row', async () => {
    const store = new MemoryStore();
    const acc = await seedAccount(store, 'carol');
    __setNow(() => T0);
    await mintSession(store, acc.id, acc.sessionVersion);

    // Bump the account's sessionVersion: the session is now unresolvable, but only
    // because of the OTHER row. A rollback of that row would make it live again, so
    // deleting it here would destroy something recoverable.
    await store.put({ ...acc, sessionVersion: acc.sessionVersion + 1 } as unknown as AccountItem);
    expect(await sweepUserSessions(store, acc.id, T0 + 1000)).toBe(0);
    expect(await store.queryGSI1(sessionUserGsi(acc.id))).toHaveLength(1);
  });
});

describe('PERF-7 — idempotency markers age out at the client retry horizon', () => {
  afterEach(() => __setNow(null));

  const key = requestIdempotencyKey(PID, 'alice', 'client-key-1');

  it('reads a fresh marker and deletes an aged one, treating it as absent', async () => {
    const store = new MemoryStore();
    // The marker stores no timestamp — its age comes from the ULID it points at, so
    // the fixture seeds that ULID from an explicit instant rather than from whatever
    // the process-wide monotonic factory happens to have reached.
    const now = T0;
    const recent = ulid(now - 60_000);
    await store.put({ ...key, requestId: recent });

    expect(idempotencyMarkerExpired({ requestId: recent }, now)).toBe(false);
    expect(await readLiveIdempotencyMarker(store, key, now)).not.toBeNull();
    expect(await store.get(key.PK, key.SK)).not.toBeNull(); // a live marker is left alone

    // L-1 — the "old" marker must really be past the horizon, or this proves nothing.
    const wayLater = now + IDEMPOTENCY_RETENTION_MS + 60_000;
    expect(idempotencyMarkerExpired({ requestId: recent }, wayLater)).toBe(true);

    expect(await readLiveIdempotencyMarker(store, key, wayLater)).toBeNull();
    expect(await store.get(key.PK, key.SK)).toBeNull(); // and it is gone, not just hidden
  });

  it('fails CLOSED on a marker it cannot age — an unreadable marker keeps deduplicating', async () => {
    // The unsafe direction here creates a duplicate change request, so anything this
    // cannot date must count as live. That is a rule about the shape of the value,
    // not a list of the two malformed values seen so far.
    for (const bad of [{}, { requestId: 42 }, { requestId: '' }, { requestId: 'not-a-ulid' }, { requestId: null }]) {
      expect(idempotencyMarkerExpired(bad as Record<string, unknown>, Date.now() + 10 * IDEMPOTENCY_RETENTION_MS)).toBe(false);
    }
  });
});

describe('PERF-7 — the audit chain is PERMANENT, and no sweep may touch it', () => {
  afterEach(() => __setNow(null));

  it('states the policy as a value, not only as prose', () => {
    // The product decision, asserted. Changing the chain to a pruned store has to go
    // through this line, which is the point of it existing.
    expect(AUDIT_CHAIN_RETENTION).toBe('permanent');
  });

  it('leaves the chain byte-identical after every retention sweep in the system', async () => {
    const store = new MemoryStore();
    const acc = await seedAccount(store, 'dave');

    __setNow(() => T0);
    for (let i = 0; i < 8; i++) {
      await record(store, PID, { action: 'change-approve', actor: 'dave', targetType: 'request', targetId: `r${i}` });
    }
    await mintSession(store, acc.id, acc.sessionVersion);
    const marker = requestIdempotencyKey(PID, 'dave', 'k');
    await store.put({ ...marker, requestId: ulid(T0 - 2 * IDEMPOTENCY_RETENTION_MS) });

    const before = await exportAuditChain(store, PID);
    expect(before.verified).toBe(true);
    expect(before.count).toBe(8);

    // Run every sweep this codebase has, at a time far past every horizon, and assert
    // the setup fired: each one must actually have had something to delete, or the
    // chain surviving them proves nothing.
    const farFuture = T0 + ABSOLUTE_MS + IDEMPOTENCY_RETENTION_MS + 86_400_000;
    expect(await sweepUserSessions(store, acc.id, farFuture)).toBeGreaterThan(0);
    expect(await readLiveIdempotencyMarker(store, marker, farFuture)).toBeNull();
    expect(await store.get(marker.PK, marker.SK)).toBeNull();

    const after = await exportAuditChain(store, PID);
    expect(after.count).toBe(before.count);
    expect(after.head).toBe(before.head);
    expect(after.verified).toBe(true);
    expect(after.entries).toEqual(before.entries);
  });
});
