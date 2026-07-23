import { describe, expect, it } from 'vitest';
import type { ChangeRequest, ManifestOperation } from '@/types';
import { manifests } from '@/data/manifests';
import { getOperation } from '@/lib/interpreter';
import {
  TERMINAL_REQUEST_STATUSES,
  canRequestAgain,
  requestAgainPath,
  reusableParams,
} from '@/lib/requestAgain';
import { validateParams } from '@/lib/interpreter';
import inventoryData from '@/data/inventory.json';
import type { Inventory } from '@/types';

/**
 * 0034 D15 (closes F25) — "Request again": a terminal request re-drives the
 * SAME form pre-seeded from its params via `?from=`, with a fresh id and a
 * fresh justification, and the seeded values flow through the CURRENT
 * manifest's validation — stale params re-validate, never bypass.
 */

const inventory = inventoryData as unknown as Inventory;

function requestFixture(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'req-01',
    requester: 'dewi',
    service: 'ebs',
    operationId: 'ebs-grow',
    macd: 'Change',
    targetAddress: 'aws_ebs_volume.app01_sdd',
    params: { volume: 'aws_ebs_volume.app01_sdd', new_size_gib: 250 },
    justification: 'Filesystem at 90%.',
    exposure: 'l1_with_guardrails',
    risk: 'MEDIUM',
    status: 'REJECTED',
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-11T00:00:00Z',
    events: [],
    ...overrides,
  };
}

describe('canRequestAgain — terminal statuses only', () => {
  it('every terminal status is re-drivable', () => {
    for (const status of TERMINAL_REQUEST_STATUSES) {
      expect(canRequestAgain({ status }), status).toBe(true);
    }
  });

  it('open/parked statuses are NOT — they have their own verbs (cancel/rewindow)', () => {
    for (const status of [
      'AWAITING_CODE_REVIEW',
      'NEEDS_ENGINEER',
      'APPROVED_COOLING',
      'AWAITING_DEPLOY_APPROVAL',
      'WINDOW_EXPIRED',
      'DRAFT',
    ] as const) {
      expect(canRequestAgain({ status }), status).toBe(false);
    }
  });
});

describe('requestAgainPath — the form the link reopens', () => {
  it('a catalog op reopens its own form with ?from=<id>', () => {
    expect(requestAgainPath(requestFixture())).toBe('/services/ebs/ebs-grow?from=req-01');
  });

  it('a beyond-catalog request reopens the structured tail with ?from=<id>', () => {
    const r = requestFixture({ operationId: 'beyond-catalog-request', service: 'redshift' });
    expect(requestAgainPath(r)).toBe('/services/request-new?from=req-01');
  });
});

describe('reusableParams — seed only what the CURRENT manifest still declares', () => {
  const op = getOperation('ebs-grow', manifests)!;

  it('copies matching params for the same operation', () => {
    expect(reusableParams(op, requestFixture())).toEqual({
      volume: 'aws_ebs_volume.app01_sdd',
      new_size_gib: 250,
    });
  });

  it('a request for a DIFFERENT operation seeds nothing (hand-edited ?from=)', () => {
    const other = requestFixture({ operationId: 'ebs-set-iops' });
    expect(reusableParams(op, other)).toEqual({});
  });

  it('params the current manifest no longer declares are dropped', () => {
    const withGhost = requestFixture({
      params: { volume: 'aws_ebs_volume.app01_sdd', new_size_gib: 250, removed_param: 'x' },
    });
    const reuse = reusableParams(op, withGhost);
    expect('removed_param' in reuse).toBe(false);
    expect(reuse.new_size_gib).toBe(250);
  });

  it('role:"const" params never seed from a request (the manifest writes them, not the requester)', () => {
    const constOp: ManifestOperation = {
      ...op,
      params: [...op.params, { ...op.params[1]!, name: 'locked', role: 'const' as const }],
    };
    const source = requestFixture({ params: { ...requestFixture().params, locked: 'stale' } });
    expect('locked' in reusableParams(constOp, source)).toBe(false);
  });

  it('stale params RE-VALIDATE: a value the current manifest refuses is flagged by validateParams, not silently accepted', () => {
    // ebs-grow is growOnly with bounded size: a 9999999 seeded from an old
    // request must come back as a validation error in the live form.
    const stale = requestFixture({
      params: { volume: 'aws_ebs_volume.app01_sdd', new_size_gib: 9_999_999 },
    });
    const reuse = reusableParams(op, stale);
    const result = validateParams(op, reuse, inventory);
    expect(result.ok).toBe(false);
    expect(result.errors.new_size_gib).toBeTruthy();
  });
});
