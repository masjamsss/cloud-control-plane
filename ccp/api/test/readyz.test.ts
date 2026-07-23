import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { seed } from './helpers/seed';
import { record } from '../src/domain/audit';
import { auditKey, type AuditItem } from '../src/store/schema';

/**
 * Task 4 — readiness that does not lie. The audit found /healthz stays green even on
 * an emptied store; /readyz must report store-loaded + account-count + audit-chain
 * verification, so an emptied/corrupt store is visibly NOT ready (503).
 */

describe('/readyz reflects real store health (unlike /healthz)', () => {
  it('empty store: /healthz is still 200, but /readyz is 503 and says why', async () => {
    const store = new MemoryStore();
    const app = createApp(store);

    const health = await app.request('/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true }); // liveness lies-by-design: green on empty

    const ready = await app.request('/readyz');
    expect(ready.status).toBe(503); // readiness does NOT lie
    const body = await ready.json();
    expect(body.ready).toBe(false);
    expect(body.accounts).toBe(0);
    expect(body.reasons.join(' ')).toMatch(/0 accounts/);
  });

  it('seeded store with a verifying chain: /readyz is 200 with the counts', async () => {
    const store = new MemoryStore();
    await seed(store); // 4 accounts, sample-partitioned teams/policy — a legacy footprint
    for (let i = 0; i < 3; i++) {
      await record(store, 'sample', { action: `a${i}`, actor: 'putra', targetType: 'session', targetId: 'putra' });
    }
    const app = createApp(store);

    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body.ready).toBe(true);
    expect(body.storeLoaded).toBe(true);
    expect(body.accounts).toBe(4);
    expect(body.estates).toBe(1); // just 'sample' — @control is the control-plane chain, not an estate
    expect(body.reasons).toEqual([]);
    // data-birth: the FIRST request lazily settles this legacy store (domain/settlement.ts)
    // before /readyz ever computes — retro-registering 'sample' (its own chain keeps exactly
    // the 3 entries this test wrote) and materializing the 4 seeded accounts' bare rows,
    // both audited onto the control plane's OWN chain (1 retro-register + 4 materialize = 5).
    expect(body.chains).toEqual([
      expect.objectContaining({ projectId: '@control', count: 5, verified: true }),
      expect.objectContaining({ projectId: 'sample', count: 3, verified: true }),
    ]);
  });

  it('a store with accounts but a TAMPERED audit chain is NOT ready', async () => {
    const store = new MemoryStore();
    await seed(store);
    for (let i = 0; i < 3; i++) {
      await record(store, 'sample', { action: `a${i}`, actor: 'putra', targetType: 'session', targetId: 'putra' });
    }
    // Corrupt one persisted audit entry's hash so the §7 chain no longer verifies.
    const monthPk = auditKey('sample', new Date().toISOString().slice(0, 7).replace('-', ''), '').PK;
    const entries = (await store.query(monthPk)) as AuditItem[];
    expect(entries.length).toBeGreaterThan(0);
    await store.put({ ...entries[0]!, hash: 'tampered-hash' });

    const app = createApp(store);
    const ready = await app.request('/readyz');
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body.ready).toBe(false);
    expect(body.accounts).toBe(4); // accounts are fine …
    expect(body.reasons.join(' ')).toMatch(/does not verify/); // … but the evidence chain is broken
  });
});
