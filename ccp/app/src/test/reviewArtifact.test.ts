import { describe, expect, it } from 'vitest';
import type { ChangeRequest, ManifestOperation } from '@/types';
import { createMockApiClient, type ApiClient } from '@/lib/api';
import { hclHasPreventDestroy } from '@/features/request/ReviewStep';
import { manifests } from '@/data/manifests';
import { getOperation } from '@/lib/interpreter';
import { isSubBlockOp, isWholeResourceRemoveBlockOp } from '@/lib/diff';

/**
 * The journey-simulation "review artifact truthfulness" register — the
 * end-to-end (submit-flow) half of the fixes whose pure-function core is
 * pinned in diff.test.ts (generateDiff / isAttributeLevelOp) and
 * accounts.test.ts (enroll). Driven through {@link createMockApiClient} the
 * same way pinned-diff.test.ts and changeSetApi.test.ts already do, so these
 * prove the WIRING — that the fix actually reaches what a reviewer sees —
 * not just the helper function in isolation.
 */

function draft(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'ra-01',
    requester: 'dewi',
    teamId: 'erp-basis',
    service: 'ec2',
    operationId: 'ec2-add-instance-tag',
    macd: 'Add',
    targetAddress: 'aws_instance.app01',
    params: { instance: 'aws_instance.app01', tag_key: 'Owner', tag_value: 'erp-basis' },
    justification: 'tag the instance for cost allocation',
    exposure: 'l1_self_service',
    risk: 'LOW',
    status: 'DRAFT',
    createdAt: '',
    updatedAt: '',
    events: [],
    ...overrides,
  };
}

/** Submit and unwrap the SubmitResult to its ChangeRequest (throws on rejection). */
async function submit(client: ApiClient, d: ChangeRequest): Promise<ChangeRequest> {
  const res = await client.submitRequest(d);
  if (!res.ok) throw new Error(res.reason);
  return res.request;
}

/** Looks up a bundled-catalog op by id (throws if the id doesn't exist —
 * a typo here should fail loudly, not silently skip). */
function catalogOp(id: string): ManifestOperation {
  const found = getOperation(id, manifests);
  if (!found) throw new Error('missing op ' + id);
  return found;
}

/** Minimal, schema-shaped values for a catalog op: an inventory-sourced param
 * gets a synthetic `<resourceType>.placeholder` address, a number param gets
 * `1`, everything else gets `'x'` — the same placeholder convention
 * diff.test.ts's own catalog-wide sweeps use for generateDiff. Neither
 * submitRequest nor submitChangeSet validates params against the manifest
 * schema (that lives client-side, in the request wizard/inventoryPicker), so
 * this is enough to exercise the plan-action wiring for any op. */
function placeholderValues(o: ManifestOperation): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const p of o.params) {
    if (p.source === 'inventory') values[p.name] = `${o.target.resourceType}.placeholder`;
    else if (p.type === 'number') values[p.name] = 1;
    else values[p.name] = 'x';
  }
  return values;
}

/**
 * Submits ONE op through the change-set path with placeholder values.
 * Unlike `submitRequest`, the mock's `submitChangeSet` computes `planSummary`
 * unconditionally — an engineer-track item still gets one (see
 * `submitChangeSet` in lib/api.ts: `resourceChanges`/`counts` are built
 * before the engineer-vs-guardrails branch, and `planSummary` is set on the
 * returned request either way) — so this is the one vehicle that can sweep
 * EVERY op in the catalog uniformly, including the two `engineer_only`
 * sub-block ops (backup-remove-selection-tag/-condition) that a plain
 * `submitRequest` would route straight to NEEDS_ENGINEER with no plan
 * summary at all (see the "genuine whole-resource create/destroy" test
 * above, which has to pick the rare non-engineer example of each op class
 * for exactly this reason).
 */
async function submitOneViaChangeSet(api: ApiClient, operationId: string): Promise<ChangeRequest> {
  const o = catalogOp(operationId);
  const res = await api.submitChangeSet({
    items: [
      {
        operationId,
        targetAddress: `${o.target.resourceType}.placeholder`,
        params: placeholderValues(o),
      },
    ],
    justification: 'round 3 badge sweep — plan action for a catalog op',
    schedule: { kind: 'now' },
  });
  if (!res.ok) throw new Error(`${operationId}: ${res.reason}`);
  return res.request;
}

describe('OP-3 / LD-1 — plan action keyed off whole-resource-vs-attribute, not MACD', () => {
  it('a tag ADD (MACD "Add") submits with plan action "update", never "create"', async () => {
    const api = createMockApiClient();
    const submitted = await submit(api, draft());
    const summary = submitted.planSummary!;
    expect(summary.resourceChanges).toHaveLength(1);
    expect(summary.resourceChanges[0]!.action).toBe('update');
    expect(summary.counts).toEqual({ create: 0, update: 1, replace: 0, delete: 0, noop: 0 });
  });

  it('a tag REMOVE (MACD "Delete") submits with plan action "update", never "delete" — no ⚠ Destroy, no dependents scan trigger', async () => {
    const api = createMockApiClient();
    const submitted = await submit(
      api,
      draft({
        id: 'ra-02',
        operationId: 'ec2-remove-instance-tag',
        macd: 'Delete',
        risk: 'MEDIUM',
        exposure: 'l1_with_guardrails',
        params: { instance: 'aws_instance.app01', tag_key: 'Temporary' },
      }),
    );
    const summary = submitted.planSummary!;
    expect(summary.resourceChanges).toHaveLength(1);
    expect(summary.resourceChanges[0]!.action).toBe('update');
    expect(summary.counts).toEqual({ create: 0, update: 1, replace: 0, delete: 0, noop: 0 });
  });

  it('submitChangeSet applies the same keying (mockPlanSummaryFor is called from both submit paths)', async () => {
    const api = createMockApiClient();
    const res = await api.submitChangeSet({
      items: [
        {
          operationId: 'ec2-add-instance-tag',
          targetAddress: 'aws_instance.app01',
          params: { instance: 'aws_instance.app01', tag_key: 'Owner', tag_value: 'erp-basis' },
        },
      ],
      justification: 'tag via the change-set path',
      schedule: { kind: 'now' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.request.planSummary?.resourceChanges[0]?.action).toBe('update');
  });

  it('a genuine whole-resource create/destroy is unaffected — still "create"/"delete"', async () => {
    // Most create_resource/remove_block ops in this catalog are engineer_only
    // (an engineer authors/reviews real provisioning and teardown), and the
    // engineer-tier handoff never computes a planSummary at all — so this
    // needs the rare non-engineer examples of each to exercise the normal
    // submit path's plan summary.
    const api = createMockApiClient();
    const created = await submit(
      api,
      draft({
        id: 'ra-03',
        service: 'acm',
        operationId: 'acm-request-certificate', // instantiate_module, l1_with_guardrails
        macd: 'Add',
        risk: 'MEDIUM',
        exposure: 'l1_with_guardrails',
        targetAddress: '',
        params: { primary_domain_name: 'app.example.com', validation_method: 'DNS' },
      }),
    );
    // Any resolvable Add op backed by create_resource/instantiate_module must
    // still say "create" — this fix narrows the bug, it doesn't erase the verb.
    expect(created.planSummary?.resourceChanges[0]?.action).toBe('create');

    const deleted = await submit(
      api,
      draft({
        id: 'ra-04',
        service: 'cloudwatch',
        operationId: 'cloudwatch-delete-alarm', // remove_block, bare resourceType target, l1_self_service
        macd: 'Delete',
        risk: 'LOW',
        exposure: 'l1_self_service',
        targetAddress: 'aws_cloudwatch_metric_alarm.legacy_host',
        params: { alarm: 'aws_cloudwatch_metric_alarm.legacy_host' },
      }),
    );
    expect(deleted.planSummary?.resourceChanges[0]?.action).toBe('delete');
  });
});

/**
 * Review-truthfulness round 3 — the plan-action BADGE gets the same
 * whole-resource-vs-attribute fix round 2 (#120) already gave the rendered
 * diff TEXT (diff.test.ts's "honest sub-block delta" suite). Round 2
 * deliberately left `mockPlanSummaryFor` MACD-keyed for the 9 sub-block-
 * scoped remove_block/append_block ops — isAttributeLevelOp's own docstring
 * calls this out as a follow-up, since append_block/remove_block can ALSO be
 * a genuine whole-resource create/destroy (ebs-delete-volume). Concretely:
 * autoscaling-remove-tag (a tag removal) rendered plan action "delete" —
 * the ⚠ Destroy badge and the dependents scan next to a diff that correctly
 * showed only a tag block going away. `isSubBlockOp` (lib/diff.ts, already
 * proved out for the diff text in round 2) is now folded into
 * `mockPlanSummaryFor`'s action check too, reused — not re-derived.
 */
describe('review-truthfulness round 3 — sub-block ops render plan action "update" (the badge, not just the diff text)', () => {
  const SUB_BLOCK_OP_IDS = [
    'autoscaling-remove-tag',
    'sg-remove-ingress-rule',
    'waf-delete-rule',
    'iam-detach-managed-policy',
    'eventbridge-remove-target-dead-letter-queue',
    'backup-remove-selection-tag', // engineer_only + forcesReplace — see submitOneViaChangeSet
    'backup-remove-selection-condition', // engineer_only + forcesReplace
    'autoscaling-start-instance-refresh', // append_block, macd "Change"
    'eventbridge-set-target-dead-letter-queue', // append_block, macd "Change", no target.block/path hint
  ];

  it('all 9 named sub-block ops submit with plan action "update" — never "create"/"delete"', async () => {
    const api = createMockApiClient();
    for (const id of SUB_BLOCK_OP_IDS) {
      const req = await submitOneViaChangeSet(api, id);
      expect(req.planSummary?.resourceChanges, id).toHaveLength(1);
      expect(req.planSummary?.resourceChanges[0]?.action, id).toBe('update');
      expect(req.planSummary?.counts, id).toEqual({
        create: 0,
        update: 1,
        replace: 0,
        delete: 0,
        noop: 0,
      });
    }
  });

  it('the exact bug-report regression, through the real single-request submit lane: autoscaling-remove-tag (MACD "Delete") is "update", never "delete"', async () => {
    const api = createMockApiClient();
    const submitted = await submit(
      api,
      draft({
        id: 'ra-30',
        service: 'autoscaling',
        operationId: 'autoscaling-remove-tag',
        macd: 'Delete',
        risk: 'LOW',
        exposure: 'l1_self_service',
        targetAddress: 'aws_autoscaling_group.app_web',
        params: { asg: 'aws_autoscaling_group.app_web', key: 'Temporary' },
      }),
    );
    expect(submitted.planSummary?.resourceChanges[0]?.action).toBe('update');
    expect(submitted.planSummary?.counts).toEqual({
      create: 0,
      update: 1,
      replace: 0,
      delete: 0,
      noop: 0,
    });
  });

  it('a "Change"-macd append_block sub-block op also submits as "update" through the real single-request lane: eventbridge-remove-target-dead-letter-queue', async () => {
    const api = createMockApiClient();
    const submitted = await submit(
      api,
      draft({
        id: 'ra-31',
        service: 'eventbridge',
        operationId: 'eventbridge-remove-target-dead-letter-queue',
        macd: 'Change',
        risk: 'MEDIUM',
        exposure: 'l1_with_guardrails',
        targetAddress: 'aws_cloudwatch_event_target.orders_to_lambda',
        params: { target: 'aws_cloudwatch_event_target.orders_to_lambda' },
      }),
    );
    expect(submitted.planSummary?.resourceChanges[0]?.action).toBe('update');
  });

  it('every sub-block op in the whole catalog (isSubBlockOp) submits as "update" — catalog-wide sweep guarding against a silent regression', async () => {
    const subBlockOps = manifests.flatMap((m) => m.operations).filter((o) => isSubBlockOp(o));
    // 9 measured today (the named list above) — never fewer.
    expect(subBlockOps.length).toBeGreaterThanOrEqual(9);
    const api = createMockApiClient();
    const offenders: string[] = [];
    for (const o of subBlockOps) {
      const req = await submitOneViaChangeSet(api, o.id);
      const action = req.planSummary?.resourceChanges[0]?.action;
      if (action !== 'update') offenders.push(`${o.id}: plan action "${action}", expected "update"`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every genuine whole-resource remove_block op in the whole catalog still submits as "delete" — unaffected outside the 9', async () => {
    const wholeOps = manifests
      .flatMap((m) => m.operations)
      .filter((o) => isWholeResourceRemoveBlockOp(o));
    // 33 measured today across the catalog (diff.test.ts pins the same count
    // for the diff-text side of this same classifier).
    expect(wholeOps.length).toBeGreaterThanOrEqual(30);
    const api = createMockApiClient();
    const offenders: string[] = [];
    for (const o of wholeOps) {
      const req = await submitOneViaChangeSet(api, o.id);
      const action = req.planSummary?.resourceChanges[0]?.action;
      if (action !== 'delete') offenders.push(`${o.id}: plan action "${action}", expected "delete"`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every create_resource/instantiate_module op in the whole catalog still submits as "create" — unaffected by this fix', async () => {
    const creates = manifests
      .flatMap((m) => m.operations)
      .filter((o) => o.codemodOp === 'create_resource' || o.codemodOp === 'instantiate_module');
    // 167 measured today (159 create_resource + 8 instantiate_module).
    expect(creates.length).toBeGreaterThanOrEqual(150);
    const api = createMockApiClient();
    const offenders: string[] = [];
    for (const o of creates) {
      const req = await submitOneViaChangeSet(api, o.id);
      const action = req.planSummary?.resourceChanges[0]?.action;
      if (action !== 'create') offenders.push(`${o.id}: plan action "${action}", expected "create"`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('LD-2 — mock PR numbers are monotonic, never a repeated literal', () => {
  it('two requests submitted in the same session get distinct, increasing numbers past the seeds', async () => {
    const api = createMockApiClient();
    const first = await submit(api, draft({ id: 'ra-10' }));
    const second = await submit(api, draft({ id: 'ra-11' }));
    expect(first.prNumber).toBeGreaterThan(224); // highest seeded PR (#224)
    expect(second.prNumber).toBeGreaterThan(first.prNumber!);
    expect(first.prUrl).not.toBe(second.prUrl);
    // The old bug: both literally 222 — a lead's bell showed two identical
    // "PR #222 awaiting your approval" lines for two unrelated changes.
    expect(first.prNumber).not.toBe(222);
    expect(second.prNumber).not.toBe(222);
  });

  it('submitChangeSet shares the same counter as submitRequest — no collision across the two paths', async () => {
    const api = createMockApiClient();
    const viaSingle = await submit(api, draft({ id: 'ra-12' }));
    const setRes = await api.submitChangeSet({
      items: [{ operationId: 'ec2-add-instance-tag', targetAddress: 'aws_instance.app01', params: { instance: 'aws_instance.app01', tag_key: 'Owner', tag_value: 'x' } }],
      justification: 'second submission via the change-set path',
      schedule: { kind: 'now' },
    });
    expect(setRes.ok).toBe(true);
    if (!setRes.ok) return;
    expect(setRes.request.prNumber).toBeGreaterThan(viaSingle.prNumber!);
  });
});

describe('OP-1 — engineer-tier handoff carries a real approvals target (data half)', () => {
  it('a catalog engineer_only op lands on the promised count, never "0 of 0"', async () => {
    const api = createMockApiClient();
    const submitted = await submit(
      api,
      draft({
        id: 'ra-20',
        service: 'ebs',
        operationId: 'ebs-set-encrypted',
        macd: 'Change',
        risk: 'HIGH',
        exposure: 'engineer_only',
        targetAddress: 'aws_ebs_volume.app01_sdb',
        params: { volume: 'aws_ebs_volume.app01_sdb', encrypted: 'true' },
      }),
    );
    expect(submitted.status).toBe('NEEDS_ENGINEER');
    expect(submitted.approvalsRequired).toBe(2); // HIGH risk under the default policy
    expect(submitted.approvals).toEqual([]);
  });

  it('a beyond-catalog (synthetic, op-not-in-manifest) engineer_only request also gets a real target', async () => {
    const api = createMockApiClient();
    const submitted = await submit(
      api,
      draft({
        id: 'ra-21',
        service: 's3',
        operationId: 'beyond-catalog-synthetic-op-not-in-any-manifest',
        macd: 'Add',
        risk: 'HIGH',
        exposure: 'engineer_only',
        targetAddress: '',
        params: {},
      }),
    );
    expect(submitted.status).toBe('NEEDS_ENGINEER');
    expect(submitted.approvalsRequired).toBe(2);
    expect(submitted.approvals).toEqual([]);
  });
});

describe('OP-4 — prevent_destroy detection (pure function backing the ReviewStep callout)', () => {
  it('detects the guard on a real committed volume block', () => {
    const source =
      'resource "aws_ebs_volume" "app01_sdb" {\n  size = 20\n\n  lifecycle {\n    prevent_destroy = true\n  }\n}';
    expect(hclHasPreventDestroy(source)).toBe(true);
  });

  it('says nothing is protected when the block carries no lifecycle guard', () => {
    const source = 'resource "aws_ebs_volume" "scratch" {\n  size = 20\n}';
    expect(hclHasPreventDestroy(source)).toBe(false);
  });

  it('is not fooled by a false/absent value or an unrelated lifecycle rule', () => {
    expect(
      hclHasPreventDestroy('resource "x" "y" {\n  lifecycle {\n    prevent_destroy = false\n  }\n}'),
    ).toBe(false);
    expect(
      hclHasPreventDestroy('resource "x" "y" {\n  lifecycle {\n    create_before_destroy = true\n  }\n}'),
    ).toBe(false);
  });
});
