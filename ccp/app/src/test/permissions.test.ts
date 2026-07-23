import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Team, User } from '@/types';
import { manifests } from '@/data/manifests';
import { getOperation } from '@/lib/interpreter';
import { approvalsRequiredFor, canApprove, canRequest, requestableServices } from '@/lib/permissions';

const teams: Team[] = [{ id: 't1', name: 'Team 1', serviceSlugs: ['ec2', 'ebs'] }];
const requester: User = { id: 'd', name: 'Dewi', role: 'requester', teamId: 't1' };
const approver: User = { id: 'a', name: 'Rizky', role: 'approver', teamId: 't1' };
const lead: User = { id: 'l', name: 'Putra', role: 'lead', teamId: 't1' };

function op(id: string) {
  const found = getOperation(id, manifests);
  if (!found) throw new Error('missing op ' + id);
  return found;
}

function req(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'r1', requester: 'd', service: 'ebs', operationId: 'ebs-grow', macd: 'Change',
    targetAddress: 'aws_ebs_volume.erp_app03_data', params: {}, justification: 'x',
    exposure: 'l1_with_guardrails', risk: 'MEDIUM', status: 'AWAITING_CODE_REVIEW',
    createdAt: '', updatedAt: '', events: [], approvals: [], approvalsRequired: 1,
    ...overrides,
  };
}

describe('approvalsRequiredFor — risk-based (1 low / 2 high-or-delete)', () => {
  it('LOW change needs 1', () => expect(approvalsRequiredFor(op('cloudwatch-alarm-threshold'))).toBe(1));
  it('MEDIUM change needs 1', () => expect(approvalsRequiredFor(op('ec2-resize'))).toBe(1));
  it('any Delete needs 2', () => expect(approvalsRequiredFor(op('ec2-remove-instance-tag'))).toBe(2));
  it('HIGH needs 2', () => expect(approvalsRequiredFor(op('ebs-delete-volume'))).toBe(2));
});

describe('canRequest — team-scoped for requesters, open for seniors', () => {
  it('requester can request their team services', () => expect(canRequest(requester, 'ec2', teams)).toBe(true));
  it('requester cannot request other services', () => expect(canRequest(requester, 's3', teams)).toBe(false));
  it('approver can request anything', () => expect(canRequest(approver, 's3', teams)).toBe(true));
  it('lead can request anything', () => expect(canRequest(lead, 's3', teams)).toBe(true));
});

describe('canApprove — separation of duties', () => {
  it('approver can approve someone else’s request', () => expect(canApprove(approver, req())).toBe(true));
  it('a requester cannot approve', () => expect(canApprove(requester, req())).toBe(false));
  it('you cannot approve your own request', () => expect(canApprove(approver, req({ requester: 'a' }))).toBe(false));
  it('you cannot approve twice', () =>
    expect(canApprove(approver, req({ approvals: [{ user: 'a', at: 'now' }] }))).toBe(false));
});

describe('requestableServices', () => {
  it('a requester only their team', () => {
    const set = requestableServices(requester, manifests, teams);
    expect(set.has('ec2')).toBe(true);
    expect(set.has('s3')).toBe(false);
  });
  it('a lead sees all', () => {
    const set = requestableServices(lead, manifests, teams);
    expect(set.size).toBe(new Set(manifests.map((m) => m.service)).size);
    expect(set.has('s3')).toBe(true);
  });
});
