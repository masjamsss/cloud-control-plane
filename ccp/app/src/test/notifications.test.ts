import { describe, expect, it } from 'vitest';
import type { ChangeRequest, RequestStatus } from '@/types';
import { REQUEST_STATUSES } from '@/types';
import { ownNote } from '@/components/Notifications';

/**
 * UI-10 — the bell's own-request note text, specifically the default branch. `ownNote`'s
 * switch names most statuses explicitly (each with its own title/detail copy); anything it
 * does NOT name falls to a default branch that used to interpolate `req.status` raw —
 * `· CHECKS_RUNNING`, `· APPLYING`, a SCREAMING_SNAKE token sitting next to plain-English
 * copy everywhere else in the bell.
 */
function fixtureRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'req-1',
    requester: 'dewi',
    service: 'ebs',
    operationId: 'ebs-grow',
    macd: 'Change',
    targetAddress: 'aws_ebs_volume.x',
    params: {},
    justification: 'Because the volume is nearly full.',
    exposure: 'l1_self_service',
    risk: 'LOW',
    status: 'AWAITING_CODE_REVIEW',
    approvalsRequired: 2,
    approvals: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

// The switch's own explicitly-named cases — anything NOT in this set exercises the
// default branch this fix is about.
const NAMED_STATUSES = new Set<RequestStatus>([
  'APPLIED',
  'NOOP',
  'REJECTED',
  'APPLY_FAILED',
  'DIGEST_MISMATCH',
  'AWAITING_DEPLOY_APPROVAL',
  'WINDOW_EXPIRED',
  'NEEDS_ENGINEER',
  'AWAITING_CODE_REVIEW',
]);

describe('ownNote — the bell note for a request the current user owns', () => {
  it('UI-10: the default branch never contains a raw SCREAMING_SNAKE status token', () => {
    for (const status of REQUEST_STATUSES) {
      if (NAMED_STATUSES.has(status)) continue; // exercised elsewhere in the switch
      const note = ownNote(fixtureRequest({ status }));
      expect(note.detail, status).not.toContain(status);
      expect(note.detail, status).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
    }
  });

  it('the default branch renders the curated label, not a transform of the enum', () => {
    // CHECKS_RUNNING is unnamed in the switch, so this exercises the default branch
    // specifically — and pins the exact word StatusBadge uses for the same status,
    // which is the whole point of routing both through one source.
    const note = ownNote(fixtureRequest({ status: 'CHECKS_RUNNING' }));
    expect(note.detail).toContain('Checks running');
  });
});
