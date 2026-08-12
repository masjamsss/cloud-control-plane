import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import { seed } from './helpers/seed';
import { record } from '../src/domain/audit';
import { auditKey, driftPointerKey, projectKey, type AuditItem, type DriftPointerItem, type ProjectItem } from '../src/store/schema';
import { nowIso } from '../src/clock';

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
    const monthPk = auditKey('sample', nowIso().slice(0, 7).replace('-', ''), '').PK;
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

/* ── DATA-10: the on-disk served-file cross-check ─────────────────────────── */

describe('/readyz cross-checks dataActive / drift pointer rows against the disk (DATA-10)', () => {
  let dataRoot: string;
  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'ccp-readyz-data-'));
  });
  afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

  /** Seed + trigger the lazy legacy settlement (a throwaway request through the
   * SAME middleware chain the real assertion call uses below) so 'sample' has a
   * real ProjectItem row to mutate, exactly the existing suite's own pattern
   * (see the "seeded store" test above). */
  async function seededApp(store: ConfigStore): Promise<ReturnType<typeof createApp>> {
    await seed(store);
    const app = createApp(store, { projectDataRoot: dataRoot });
    await app.request('/healthz'); // settles 'sample' before the test reads its row
    return app;
  }

  it('a project whose ACTIVE served-data version has no files on disk is NOT ready', async () => {
    const store = new MemoryStore();
    const app = await seededApp(store);

    const pk = projectKey('sample');
    const project = (await store.get(pk.PK, pk.SK)) as ProjectItem;
    await store.put({
      ...project,
      dataActive: { version: 1, activatedBy: 'putra', activatedAt: nowIso() },
    } as never); // v1 activated, but nothing was ever written to dataRoot

    const ready = await app.request('/readyz');
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body.reasons.join(' ')).toMatch(/ACTIVE served-data version \(v1\).*missing on disk/);
  });

  it('the SAME project is ready once its active version files are actually on disk', async () => {
    const store = new MemoryStore();
    const app = await seededApp(store);

    const pk = projectKey('sample');
    const project = (await store.get(pk.PK, pk.SK)) as ProjectItem;
    await store.put({
      ...project,
      dataActive: { version: 1, activatedBy: 'putra', activatedAt: nowIso() },
    } as never);
    // The one file every version unconditionally writes (writeProjectDataVersion,
    // domain/projectData.ts) — the exact convention projectDataVersionExists checks.
    mkdirSync(join(dataRoot, 'sample', 'v1'), { recursive: true });
    writeFileSync(join(dataRoot, 'sample', 'v1', 'inventory.json'), '{}');

    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body.reasons).toEqual([]);
  });

  it('a project with no dataActive at all is unaffected (nothing to cross-check)', async () => {
    const store = new MemoryStore();
    const app = await seededApp(store);
    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
  });

  it('a served drift report whose file has vanished from disk is NOT ready', async () => {
    const store = new MemoryStore();
    const app = await seededApp(store);

    const dk = driftPointerKey('sample');
    const pointer: DriftPointerItem = {
      ...dk,
      version: 1,
      capturedAt: nowIso(),
      planExitCode: 0,
      driftedCount: 0,
      securityCount: 0,
    };
    await store.put(pointer as never); // pointer advanced, but the report file was never written

    const ready = await app.request('/readyz');
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body.reasons.join(' ')).toMatch(/served drift report \(v1\).*missing on disk/);
  });

  it('the SAME project is ready once its pointed-to drift report file is actually on disk', async () => {
    const store = new MemoryStore();
    const app = await seededApp(store);

    const dk = driftPointerKey('sample');
    const pointer: DriftPointerItem = {
      ...dk,
      version: 1,
      capturedAt: nowIso(),
      planExitCode: 0,
      driftedCount: 0,
      securityCount: 0,
    };
    await store.put(pointer as never);
    // The exact on-disk convention driftReportExists checks (domain/drift.ts's
    // driftReportPath: `<root>/<projectId>/drift/v<n>.json`).
    mkdirSync(join(dataRoot, 'sample', 'drift'), { recursive: true });
    writeFileSync(join(dataRoot, 'sample', 'drift', 'v1.json'), '{}');

    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body.reasons).toEqual([]);
  });
});
