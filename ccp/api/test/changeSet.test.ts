import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { seed, seedAccount, sessionCookieFor, setSetting } from './helpers/seed';

/**
 * The multi-operation CHANGE SET (Phase B). A request may hold an ordered `items` list —
 * one reviewed change that enacts several operations (multi-edit on one resource, or one
 * action fanned across many targets) — sharing ONE justification + schedule + approval.
 *
 * The load-bearing safety invariants the adversarial reviewer will attack, each locked below:
 *   - ATOMIC validation: the whole set is rejected (and NOTHING stored) if ANY item fails a
 *     per-op gate (unknown op, disabled, team scope, bounds, forces-replace confirmation);
 *   - STRICTEST-combined requirement: the set's review tier + ladder is the strictest across
 *     all items (tighten-only), never weaker than its strictest single item; forces-replace
 *     on ANY item floors the whole set to the [L2, L3] replace ladder;
 *   - forces-replace-in-set keeps its TYPED confirmation (bound to that item's exact target)
 *     AND the ladder;
 *   - NO mass-assignment: per item, status/approvals/requirement AND service/macd/exposure
 *     are server-computed — the client supplies only operationId/targetAddress/params;
 *   - NOTHING auto-applies (a completed set lands exactly where a single-op change does);
 *   - single-op is a strict special case (`items.length === 1`) — byte-identical to before.
 *
 * Real catalog ops used (exposures pinned by manifest_lint / opTaxonomy):
 *   cloudwatch-alarm-threshold  self-service  [L2]     (cloudwatch, erp-basis)
 *   ebs-gp2-to-gp3              self-service  [L2]     (ebs,        erp-basis)
 *   ebs-grow                    guardrails    [L2, L3] (ebs,        erp-basis)
 *   ec2-remove-instance-tag     guardrails    [L2, L3] (ec2,        erp-basis)
 *   ebs-set-encrypted           engineer +    [L2, L3] (ebs,        erp-basis) forcesReplace
 *   s3-update-tags              self-service  [L2]     (s3,         PLATFORM — out of erp-basis scope)
 */

const JUST = 'a change-set justification comfortably past the ten-character minimum';

const VOL_A = 'aws_ebs_volume.dwh01_sda';
const VOL_B = 'aws_ebs_volume.dwh01_sdb';
const VOL_C = 'aws_ebs_volume.dwh01_sdc';
const ALARM_A = 'aws_cloudwatch_metric_alarm.cpu_a';
const ALARM_B = 'aws_cloudwatch_metric_alarm.cpu_b';

/** A self-service item ([L2], required 1). */
function selfServiceItem(alarm = ALARM_A, threshold = 80) {
  return { operationId: 'cloudwatch-alarm-threshold', targetAddress: alarm, params: { alarm, new_threshold: threshold } };
}
/** A guardrails item ([L2, L3], required 2). */
function guardrailsItem(vol = VOL_A, size = 250) {
  return { operationId: 'ebs-grow', targetAddress: vol, params: { volume: vol, new_size_gib: size } };
}
/** A forces-replace item (engineer, [L2, L3]) with a matching typed confirmation. */
function replaceItem(vol = VOL_B) {
  return { operationId: 'ebs-set-encrypted', targetAddress: vol, replaceConfirmation: vol, params: { volume: vol, encrypted: 'true' } };
}

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE). This suite predates that concept
// and always meant "act on the sample estate".
function submit(app: ReturnType<typeof createApp>, cookie: string, body: unknown) {
  return app.request('/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}
function approve(app: ReturnType<typeof createApp>, cookie: string, id: string) {
  return app.request(`/requests/${id}/approve`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });
}
async function listMine(app: ReturnType<typeof createApp>, cookie: string): Promise<RequestItem[]> {
  const res = await app.request('/requests?scope=mine', { headers: { cookie, 'x-ccp-project': 'sample' } });
  return ((await res.json()) as { items: RequestItem[] }).items;
}
async function stored(store: MemoryStore, id: string): Promise<RequestItem> {
  const k = requestKey('sample', id);
  return (await store.get(k.PK, k.SK)) as RequestItem;
}
async function newApp() {
  const store = new MemoryStore();
  await seed(store);
  const app = createApp(store);
  return { store, app };
}

/* ── STRICTEST-combined requirement ──────────────────────────────────────────────────── */

describe('change set — the combined requirement is the STRICTEST across all items', () => {
  it('two self-service items → [L2], required 1, normal review queue', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const created = await (
      await submit(app, cookie, { items: [selfServiceItem(ALARM_A), selfServiceItem(ALARM_B, 70)], justification: JUST, schedule: { kind: 'now' } })
    ).json();
    expect(created.approvalsRequired).toBe(1);
    expect(created.approvalLadder).toEqual(['L2']);
    expect(created.reviewTier).toBe('self_service');
    expect(created.status).toBe('AWAITING_CODE_REVIEW');
    expect((await stored(store, created.id)).items).toHaveLength(2);
  });

  it('self-service + guardrails → the guardrails ladder wins: [L2, L3], required 2', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [selfServiceItem(), guardrailsItem()],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    expect(created.approvalsRequired).toBe(2);
    expect(created.approvalLadder).toEqual(['L2', 'L3']);
    expect(created.reviewTier).toBe('guardrails');
  });

  it('is order-independent — guardrails first still yields required 2', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [guardrailsItem(), selfServiceItem()],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    expect(created.approvalsRequired).toBe(2);
    expect(created.reviewTier).toBe('guardrails');
  });

  it('any forces-replace item floors the WHOLE set to engineer + [L2, L3] (NEEDS_ENGINEER)', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [selfServiceItem(), replaceItem()],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    expect(created.reviewTier).toBe('engineer');
    expect(created.approvalLadder).toEqual(['L2', 'L3']);
    expect(created.approvalsRequired).toBe(2);
    expect(created.status).toBe('NEEDS_ENGINEER');
  });

  it('is NEVER weaker than the strictest single item (the set === that item submitted alone)', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const alone = await (await submit(app, cookie, { items: [guardrailsItem()], justification: JUST, schedule: { kind: 'now' } })).json();
    const set = await (
      await submit(app, cookie, { items: [selfServiceItem(), guardrailsItem(VOL_C)], justification: JUST, schedule: { kind: 'now' } })
    ).json();
    expect(set.approvalsRequired).toBeGreaterThanOrEqual(alone.approvalsRequired);
    expect(set.approvalsRequired).toBe(2);
  });
});

/* ── ATOMIC validation — one bad item rejects the whole set, stores nothing ───────────── */

describe('change set — ATOMIC: any failing item rejects the whole set (nothing stored)', () => {
  it('an out-of-bounds param on ONE item → 422 PARAM_OUT_OF_BOUNDS, nothing persisted', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const res = await submit(app, cookie, {
      items: [selfServiceItem(), { operationId: 'cloudwatch-alarm-threshold', targetAddress: ALARM_B, params: { alarm: ALARM_B, new_threshold: 999 } }],
      justification: JUST,
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('PARAM_OUT_OF_BOUNDS');
    expect(await listMine(app, cookie)).toHaveLength(0);
  });

  it('an unknown operationId on ONE item → 422 VALIDATION_FAILED, nothing persisted', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const res = await submit(app, cookie, {
      items: [selfServiceItem(), { operationId: 'does-not-exist', targetAddress: VOL_A, params: {} }],
      justification: JUST,
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
    expect(await listMine(app, cookie)).toHaveLength(0);
  });

  it('an out-of-team item on ONE item → 422 TEAM_SCOPE, nothing persisted', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari'); // requester in erp-basis (no s3)
    const bucket = 'aws_s3_bucket.app_backup';
    const res = await submit(app, cookie, {
      items: [selfServiceItem(), { operationId: 's3-update-tags', targetAddress: bucket, params: { bucket, tags: { Team: 'Backup' } } }],
      justification: JUST,
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('TEAM_SCOPE');
    expect(await listMine(app, cookie)).toHaveLength(0);
  });

  it('a disabled op on ONE item → 422 OP_DISABLED, nothing persisted', async () => {
    const { app, store } = await newApp();
    await setSetting(store, 'sample', 'catalog.disabled-ops', ['ebs-grow']);
    const cookie = await sessionCookieFor(store, 'sari');
    const res = await submit(app, cookie, {
      items: [selfServiceItem(), guardrailsItem()],
      justification: JUST,
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('OP_DISABLED');
    expect(await listMine(app, cookie)).toHaveLength(0);
  });

  it('a global freeze rejects the whole set (GLOBAL_FREEZE), nothing persisted', async () => {
    const { app, store } = await newApp();
    await setSetting(store, 'sample', 'freeze.global', true);
    const cookie = await sessionCookieFor(store, 'sari');
    const res = await submit(app, cookie, {
      items: [selfServiceItem(), guardrailsItem()],
      justification: JUST,
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe('GLOBAL_FREEZE');
    expect(await listMine(app, cookie)).toHaveLength(0);
  });
});

/* ── forces-replace inside a set — typed confirmation + ladder both preserved ─────────── */

describe('change set — a forces-replace item keeps its typed confirmation AND the ladder', () => {
  it('accepts a matching per-item confirmation, stores it on the item, none at top level', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [selfServiceItem(), replaceItem(VOL_B)],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    expect(created.status).toBe('NEEDS_ENGINEER');
    const row = await stored(store, created.id);
    const replaceStored = row.items!.find((i) => i.operationId === 'ebs-set-encrypted')!;
    expect(replaceStored.replaceConfirmation).toBe(VOL_B);
    // A set never carries a top-level confirmation — the acknowledgement lives per item.
    expect(row.replaceConfirmation).toBeUndefined();
  });

  it('rejects the set when the forces-replace item has NO confirmation (nothing stored)', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const res = await submit(app, cookie, {
      items: [selfServiceItem(), { operationId: 'ebs-set-encrypted', targetAddress: VOL_B, params: { volume: VOL_B, encrypted: 'true' } }],
      justification: JUST,
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('REPLACE_CONFIRMATION_REQUIRED');
    expect(await listMine(app, cookie)).toHaveLength(0);
  });

  it('rejects a confirmation that names a DIFFERENT resource (no replay onto another item)', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const res = await submit(app, cookie, {
      items: [{ operationId: 'ebs-set-encrypted', targetAddress: VOL_B, replaceConfirmation: VOL_A, params: { volume: VOL_B, encrypted: 'true' } }],
      justification: JUST,
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('REPLACE_CONFIRMATION_REQUIRED');
    expect(await listMine(app, cookie)).toHaveLength(0);
  });

  it('the [L2, L3] ladder completes on two distinct signers; an approver is refused at L3', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [selfServiceItem(), replaceItem(VOL_B)],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();

    const one = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json(); // approver signs L2
    expect(one.approvals).toHaveLength(1);
    expect(one.status).toBe('NEEDS_ENGINEER');
    expect(one.nextApprovalStep).toBe('L3');

    // Explicit `roles` (not the bare legacy shape): this account is added AFTER the
    // app has already served requests, so this store's one-time settlement
    // (domain/settlement.ts) has already run — exactly like a REAL new account
    // added via POST /admin/accounts, which always writes the canonical shape, a
    // bare row added at this point would never be materialized.
    await seedAccount(store, { id: 'dewi', role: 'approver', teamId: 'app-platform', isAdmin: false, roles: { sample: { role: 'approver', teamId: 'app-platform' } } });
    const refused = await approve(app, await sessionCookieFor(store, 'dewi'), created.id); // approver at L3 → refused
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('WRONG_APPROVAL_LEVEL');

    const done = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json(); // lead signs L3
    expect(done.status).toBe('APPLIED');
    expect(done.approvals).toHaveLength(2);
  });
});

/* ── BULK: one op × N targets ─────────────────────────────────────────────────────────── */

describe('change set — BULK (one action fanned across many targets)', () => {
  it('stores one item per target, same op, the strictest requirement across them', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [selfServiceItem(ALARM_A, 60), selfServiceItem(ALARM_B, 65), selfServiceItem('aws_cloudwatch_metric_alarm.cpu_c', 70)],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    expect(created.approvalsRequired).toBe(1);
    const row = await stored(store, created.id);
    expect(row.items).toHaveLength(3);
    expect(row.items!.every((i) => i.operationId === 'cloudwatch-alarm-threshold')).toBe(true);
    expect(row.items!.map((i) => i.targetAddress)).toEqual([ALARM_A, ALARM_B, 'aws_cloudwatch_metric_alarm.cpu_c']);
  });

  it('a bulk DELETE across targets carries the guardrails ladder (required 2)', async () => {
    const { app, store } = await newApp();
    const del = (inst: string, key: string) => ({ operationId: 'ec2-remove-instance-tag', targetAddress: inst, params: { instance: inst, tag_key: key } });
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [del('aws_instance.a', 'Temporary'), del('aws_instance.b', 'Temporary')],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    expect(created.approvalsRequired).toBe(2);
    expect((await stored(store, created.id)).items).toHaveLength(2);
  });
});

/* ── MULTI-EDIT: N ops × one target ───────────────────────────────────────────────────── */

describe('change set — MULTI-EDIT (several settings on one resource)', () => {
  it('stores one item per op, all on the same target, strictest requirement', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [
          { operationId: 'ebs-grow', targetAddress: VOL_A, params: { volume: VOL_A, new_size_gib: 300 } },
          { operationId: 'ebs-gp2-to-gp3', targetAddress: VOL_A, params: { volume: VOL_A, target_type: 'gp3' } },
        ],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    expect(created.approvalsRequired).toBe(2); // ebs-grow (guardrails) is the strictest
    const row = await stored(store, created.id);
    expect(row.items).toHaveLength(2);
    expect(row.items!.every((i) => i.targetAddress === VOL_A)).toBe(true);
  });

  it('a completed multi-edit lands APPLIED on two distinct signers (nothing auto-applies early)', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [selfServiceItem(), guardrailsItem()],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    const one = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(one.status).toBe('AWAITING_CODE_REVIEW'); // 1/2 — still open, NOT applied
    const two = await (await approve(app, await sessionCookieFor(store, 'lina'), created.id)).json();
    expect(two.status).toBe('APPLIED');
  });
});

/* ── single-op is a strict special case (items.length === 1) ─────────────────────────── */

describe('change set — single-op back-compat (items.length === 1)', () => {
  it('a legacy single-op body stores NO items list and keeps its top-level fields', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        operationId: 'cloudwatch-alarm-threshold',
        targetAddress: ALARM_A,
        params: { alarm: ALARM_A, new_threshold: 80 },
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    const row = await stored(store, created.id);
    expect(row.items).toBeUndefined();
    expect(row.operationId).toBe('cloudwatch-alarm-threshold');
    expect(row.targetAddress).toBe(ALARM_A);
    expect(created.approvalsRequired).toBe(1);
  });

  it('a one-element items list is normalized to single-op storage (no items field)', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), { items: [guardrailsItem()], justification: JUST, schedule: { kind: 'now' } })
    ).json();
    const row = await stored(store, created.id);
    expect(row.items).toBeUndefined();
    expect(row.operationId).toBe('ebs-grow');
    expect(row.targetAddress).toBe(VOL_A);
    expect(created.approvalsRequired).toBe(2);
  });

  it('a single forces-replace item still records its confirmation at TOP level (byte-identical)', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), { items: [replaceItem(VOL_B)], justification: JUST, schedule: { kind: 'now' } })
    ).json();
    const row = await stored(store, created.id);
    expect(row.items).toBeUndefined();
    expect(row.replaceConfirmation).toBe(VOL_B);
    expect(created.replaceConfirmation).toBe(VOL_B);
  });
});

/* ── NO mass-assignment (per item) ────────────────────────────────────────────────────── */

describe('change set — mass-assignment safety (per item AND request-level)', () => {
  it('ignores hostile request-level status/approvals/reviewTier/requester; the server computes them', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [selfServiceItem(), guardrailsItem()],
        justification: JUST,
        schedule: { kind: 'now' },
        status: 'APPLIED',
        approvalsRequired: 1,
        approvals: [{ user: 'sari', at: '2020-01-01T00:00:00.000Z' }],
        reviewTier: 'self_service',
        requester: 'putra',
      })
    ).json();
    expect(created.status).toBe('AWAITING_CODE_REVIEW');
    expect(created.approvalsRequired).toBe(2);
    expect(created.approvals).toHaveLength(0);
    expect(created.reviewTier).toBe('guardrails');
    expect(created.requester).toBe('sari');
  });

  it('per item, service/macd/exposure come from the MANIFEST, never the body', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [
          selfServiceItem(),
          // Hostile per-item extras — none may ride into the stored item.
          { operationId: 'ebs-grow', targetAddress: VOL_A, params: { volume: VOL_A, new_size_gib: 300 }, service: 'evil', macd: 'Delete', exposure: 'l1_self_service', reviewTier: 'self_service' },
        ],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();
    const row = await stored(store, created.id);
    const grow = row.items!.find((i) => i.operationId === 'ebs-grow')!;
    expect(grow.service).toBe('ebs');
    expect(grow.macd).toBe('Change');
    expect(grow.exposure).toBe('l1_with_guardrails');
    expect(grow.reviewTier).toBe('guardrails');
    // The set stays guardrails despite the injected self_service tier.
    expect(created.reviewTier).toBe('guardrails');
  });
});

/* ── idempotent resubmit — same key returns the first request, never a duplicate ───────── */

describe('change set — idempotent resubmit (same idempotencyKey)', () => {
  it('a resubmit with the SAME key returns the first request (200), and only ONE is stored', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const body = { items: [selfServiceItem(), guardrailsItem()], justification: JUST, schedule: { kind: 'now' }, idempotencyKey: 'set-abc-123' };

    const firstRes = await submit(app, cookie, body);
    expect(firstRes.status).toBe(201);
    const first = await firstRes.json();

    const secondRes = await submit(app, cookie, body);
    expect(secondRes.status).toBe(200); // a resubmit resolves, it does not re-create
    const second = await secondRes.json();

    expect(second.id).toBe(first.id);
    expect(await listMine(app, cookie)).toHaveLength(1); // exactly one request exists
  });

  it('a different key (or no key) creates a DISTINCT request each time', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const base = { items: [selfServiceItem()], justification: JUST, schedule: { kind: 'now' } };
    const a = await (await submit(app, cookie, { ...base, idempotencyKey: 'k1' })).json();
    const b = await (await submit(app, cookie, { ...base, idempotencyKey: 'k2' })).json();
    const noKey = await (await submit(app, cookie, base)).json();
    expect(new Set([a.id, b.id, noKey.id]).size).toBe(3);
    expect(await listMine(app, cookie)).toHaveLength(3);
  });

  it('the key is scoped to the requester — the same key from another requester is independent', async () => {
    const { app, store } = await newApp();
    await seedAccount(store, { id: 'putra', role: 'requester', teamId: 'erp-basis', isAdmin: false });
    const body = { items: [selfServiceItem()], justification: JUST, schedule: { kind: 'now' }, idempotencyKey: 'shared-key' };
    const sari = await (await submit(app, await sessionCookieFor(store, 'sari'), body)).json();
    const putra = await (await submit(app, await sessionCookieFor(store, 'putra'), body)).json();
    expect(putra.id).toBeTruthy(); // putra's own submit genuinely succeeded (not masked by an unrelated 403)
    expect(putra.id).not.toBe(sari.id); // no cross-requester collision
  });
});

/* ── explicit body-size ceiling — an oversized submit is refused before parsing ─────────── */

describe('change set — explicit request body-size cap', () => {
  it('refuses a body over the ceiling with VALIDATION_FAILED, nothing stored', async () => {
    const { app, store } = await newApp();
    const cookie = await sessionCookieFor(store, 'sari');
    const huge = 'x'.repeat(300 * 1024); // > MAX_SUBMIT_BODY_BYTES (256 KB)
    const res = await submit(app, cookie, {
      items: [{ operationId: 'cloudwatch-alarm-threshold', targetAddress: ALARM_A, params: { alarm: ALARM_A, new_threshold: 80, blob: huge } }],
      justification: JUST,
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
    expect(await listMine(app, cookie)).toHaveLength(0);
  });
});

/* ── audited as ONE change under the hash-chained audit ───────────────────────────────── */

describe('change set — the whole set is audited as ONE change', () => {
  it('records exactly one request-submit entry carrying the item count + per-item summary', async () => {
    const { app, store } = await newApp();
    const created = await (
      await submit(app, await sessionCookieFor(store, 'sari'), {
        items: [selfServiceItem(), guardrailsItem(), replaceItem(VOL_B)],
        justification: JUST,
        schedule: { kind: 'now' },
      })
    ).json();

    const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
    const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
    const submits = entries.filter((e) => e.action === 'request-submit' && e.requestId === created.id);
    expect(submits).toHaveLength(1);
    const after = submits[0]!.after as { itemCount: number; items: Array<{ operationId: string; forcesReplace?: boolean }>; reviewTier: string };
    expect(after.itemCount).toBe(3);
    expect(after.items.map((i) => i.operationId)).toEqual(['cloudwatch-alarm-threshold', 'ebs-grow', 'ebs-set-encrypted']);
    expect(after.items.find((i) => i.operationId === 'ebs-set-encrypted')!.forcesReplace).toBe(true);
    expect(after.reviewTier).toBe('engineer');
  });
});
