import { beforeEach, describe, expect, it } from 'vitest';
import { createMockApiClient } from '@/lib/api';
import { createHttpApiClient } from '@/lib/httpApi';
import { ensureSeeded, resetStoreForTests } from '@/lib/accounts';
import { login, signOut } from '@/lib/auth';
import { SEED_LEAD } from '@/config';
import { setProjectScopeForTests } from '@/lib/projectScope';
import { resetSettingsForTests, setChangeFreeze } from '@/lib/settings';

/**
 * The drift-page action seams (spec addendum A6/A7, plan B1/B2/C2):
 * `startDriftCheck`, `generateDriftProposals`, `legitimizeDriftSecurity`,
 * plus (drift restore tranche, L29) `submitDriftProposal`'s restore-flavor
 * role gate and request shape. Mirrors driftStatus.test.ts's split — mock
 * half exercises the REAL `createMockApiClient()` (role/freeze gates,
 * digest validation, the simulated-pipeline effects on a re-fetched
 * status), httpApi half proves the request/response mapping with an
 * injected fetch.
 */

function seedPeople(): void {
  resetStoreForTests();
  signOut();
  resetSettingsForTests();
}

beforeEach(seedPeople);

// Fixed digests the mock seeds (lib/api.ts MOCK_DRIFT_PROPOSAL_DIGEST): the
// benign adopt row, the watchlisted security (revert) row, and (drift
// restore tranche, L29) the deleted flow log (restore) row.
const ADOPT_DIGEST = 'a1'.repeat(32);
const SECURITY_DIGEST = 'b2'.repeat(32);
const RESTORE_DIGEST = 'c9'.repeat(32);

describe('mock — startDriftCheck (B1)', () => {
  beforeEach(async () => {
    await ensureSeeded();
  });

  it('a lead can start a check; the report is bumped as though the workflow just published', async () => {
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    const api = createMockApiClient();
    const before = await api.getDriftStatus();
    const result = await api.startDriftCheck('sample');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.at).toBeTruthy();

    const after = await api.getDriftStatus();
    expect(after!.report.capturedAt).toBe(result.at);
    expect(after!.report.version).toBe(before!.report.version + 1);
    // Simulating a completed check republishes the SAME drift, not a
    // different one — the verdict addresses are unchanged.
    expect(after!.report.verdicts.map((v) => v.address)).toEqual(
      before!.report.verdicts.map((v) => v.address),
    );
  });

  it('an approver (not lead/admin) is refused', async () => {
    await login('carol', 'carol');
    const api = createMockApiClient();
    const result = await api.startDriftCheck('sample');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FORBIDDEN');
  });

  it('a requester is refused', async () => {
    await login('dave', 'dave');
    const api = createMockApiClient();
    const result = await api.startDriftCheck('sample');
    expect(result.ok).toBe(false);
  });

  it('a frozen estate refuses a check (unlike generation — see below)', async () => {
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    setChangeFreeze(true);
    const api = createMockApiClient();
    const result = await api.startDriftCheck('sample');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FROZEN');
  });
});

describe('mock — generateDriftProposals (B2)', () => {
  beforeEach(async () => {
    await ensureSeeded();
  });

  it('a lead can refresh generation; re-running over unchanged drift is idempotent (no new rows)', async () => {
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    const api = createMockApiClient();
    const before = await api.getDriftStatus();
    const beforeCount = before!.proposals!.length;

    const result = await api.generateDriftProposals('sample');
    expect(result.ok).toBe(true);

    const after = await api.getDriftStatus();
    expect(after!.proposals!.length).toBe(beforeCount);
  });

  it('an approver is refused', async () => {
    await login('carol', 'carol');
    const api = createMockApiClient();
    const result = await api.generateDriftProposals('sample');
    expect(result.ok).toBe(false);
  });

  it('generation is NOT gated by the change freeze — it only refreshes proposals, never submits', async () => {
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    setChangeFreeze(true);
    const api = createMockApiClient();
    const result = await api.generateDriftProposals('sample');
    expect(result.ok).toBe(true);
  });
});

describe('mock — legitimizeDriftSecurity (C2)', () => {
  beforeEach(async () => {
    await ensureSeeded();
  });

  it('an approver can start a legitimize request from the security row\'s open revert proposal', async () => {
    await login('carol', 'carol');
    const api = createMockApiClient();
    const result = await api.legitimizeDriftSecurity(SECURITY_DIGEST, {
      justification: 'Emergency change: widened access to unblock an incident; CloudTrail evidence attached.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe('NEEDS_ENGINEER');
    expect(result.request.operationId).toBe('system-drift-legitimize');
    expect(result.request.exposure).toBe('engineer_only');

    // The revert proposal is NOT consumed — C1 stays available (addendum A6).
    const status = await api.getDriftStatus();
    const revertProposal = status!.proposals!.find((p) => p.digest === SECURITY_DIGEST)!;
    expect(revertProposal.status).toBe('open');
  });

  it('a requester is refused', async () => {
    await login('dave', 'dave');
    const api = createMockApiClient();
    const result = await api.legitimizeDriftSecurity(SECURITY_DIGEST, {
      justification: 'Emergency change: widened access to unblock an incident; CloudTrail evidence attached.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a digest that is not an open revert proposal (e.g. the adopt row)', async () => {
    await login('carol', 'carol');
    const api = createMockApiClient();
    const result = await api.legitimizeDriftSecurity(ADOPT_DIGEST, {
      justification: 'Emergency change: widened access to unblock an incident; CloudTrail evidence attached.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
  });

  it('a frozen estate refuses a legitimize start (it creates a request)', async () => {
    await login('carol', 'carol');
    setChangeFreeze(true);
    const api = createMockApiClient();
    const result = await api.legitimizeDriftSecurity(SECURITY_DIGEST, {
      justification: 'Emergency change: widened access to unblock an incident; CloudTrail evidence attached.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FROZEN');
  });
});

describe('mock — submitDriftProposal, restore flavor (drift restore tranche, L29)', () => {
  beforeEach(async () => {
    await ensureSeeded();
  });

  it('an approver can submit the restore proposal; it creates a normal [L2, L3] AWAITING_CODE_REVIEW request', async () => {
    await login('carol', 'carol');
    const api = createMockApiClient();
    const result = await api.submitDriftProposal(RESTORE_DIGEST, {
      justification: 'CloudTrail Delete event captured (who/when/from where); restoring the deleted flow log.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe('AWAITING_CODE_REVIEW');
    expect(result.request.operationId).toBe('system-drift-restore');
    expect(result.request.macd).toBe('Add');
    expect(result.request.exposure).toBe('l1_with_guardrails');
    expect(result.request.risk).toBe('HIGH');
    // l1_with_guardrails ⇒ the [L2, L3] ladder — two distinct approvals.
    expect(result.request.approvalsRequired).toBe(2);
    expect(result.request.targetAddress).toBe('aws_flow_log.prod_vpc');

    // The proposal flips to 'submitted' — a re-fetch reflects it, mirroring
    // adopt/revert/import's own post-submit status flip.
    const status = await api.getDriftStatus();
    const restoreProposal = status!.proposals!.find((p) => p.digest === RESTORE_DIGEST)!;
    expect(restoreProposal.status).toBe('submitted');
    expect(restoreProposal.requestId).toBe(result.request.id);
  });

  it('a requester is refused — restore rides the SAME approver/lead-only rule as revert/import', async () => {
    await login('dave', 'dave');
    const api = createMockApiClient();
    const result = await api.submitDriftProposal(RESTORE_DIGEST, {
      justification: 'CloudTrail Delete event captured; restoring the deleted flow log.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FORBIDDEN');
    expect(result.reason).toBe('Only an approver or a lead can submit a drift restore.');
  });

  it('a lead can also submit a restore', async () => {
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    const api = createMockApiClient();
    const result = await api.submitDriftProposal(RESTORE_DIGEST, {
      justification: 'CloudTrail Delete event captured; restoring the deleted flow log.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(true);
  });

  it('a frozen estate refuses a restore submit', async () => {
    await login('carol', 'carol');
    setChangeFreeze(true);
    const api = createMockApiClient();
    const result = await api.submitDriftProposal(RESTORE_DIGEST, {
      justification: 'CloudTrail Delete event captured; restoring the deleted flow log.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FROZEN');
  });

  it('restore batches ONLY with other restore proposals — an adopt digest in alsoDigests is refused', async () => {
    await login('carol', 'carol');
    const api = createMockApiClient();
    const result = await api.submitDriftProposal(RESTORE_DIGEST, {
      justification: 'CloudTrail Delete event captured; restoring the deleted flow log.',
      schedule: { kind: 'now' },
      alsoDigests: [ADOPT_DIGEST],
    });
    expect(result.ok).toBe(false);
  });
});

describe('httpApi — startDriftCheck / generateDriftProposals / legitimizeDriftSecurity', () => {
  function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }): {
    fetch: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const { status, body } = handler(url, init);
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    return { fetch: fn, calls };
  }

  beforeEach(() => setProjectScopeForTests('sample'));

  it('startDriftCheck: 202 maps to ok:true, hitting POST /projects/:id/drift/check', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 202,
      body: { requested: true, at: '2026-07-20T09:00:00Z' },
    }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.startDriftCheck('sample');
    expect(result).toEqual({ ok: true, at: '2026-07-20T09:00:00Z' });
    expect(calls).toEqual(['/projects/sample/drift/check']);
  });

  it('startDriftCheck: 409 DRIFT_DISARMED surfaces the raw code and reason', async () => {
    const client = createHttpApiClient('', {
      fetch: fakeFetch(() => ({
        status: 409,
        body: { code: 'DRIFT_DISARMED', reason: 'On-demand drift checks are not armed on this deployment.' },
      })).fetch,
    });
    const result = await client.startDriftCheck('sample');
    expect(result).toEqual({
      ok: false,
      code: 'DRIFT_DISARMED',
      reason: 'On-demand drift checks are not armed on this deployment.',
    });
  });

  it('generateDriftProposals: 202 maps to ok:true with the report version, hitting POST /projects/:id/drift/generate', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 202, body: { scheduled: true, reportVersion: 12 } }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.generateDriftProposals('sample');
    expect(result).toEqual({ ok: true, reportVersion: 12 });
    expect(calls).toEqual(['/projects/sample/drift/generate']);
  });

  it('legitimizeDriftSecurity: 201 maps to ok:true with the created request, hitting POST /projects/:id/drift/security/:digest/legitimize', async () => {
    const created = {
      id: 'req-legit-1',
      status: 'NEEDS_ENGINEER',
      operationId: 'system-drift-legitimize',
    };
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: created }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.legitimizeDriftSecurity(SECURITY_DIGEST, {
      justification: 'Emergency change: widened access to unblock an incident; CloudTrail evidence attached.',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request).toEqual(created);
    expect(calls).toEqual([`/projects/sample/drift/security/${SECURITY_DIGEST}/legitimize`]);
  });

  it('legitimizeDriftSecurity: a non-201/2xx response maps to ok:false via the shared submit-code bucketing', async () => {
    const client = createHttpApiClient('', {
      fetch: fakeFetch(() => ({
        status: 422,
        body: { code: 'DRIFT_NOT_ADOPTABLE', reason: 'Not every covered verdict is security-posture.' },
      })).fetch,
    });
    const result = await client.legitimizeDriftSecurity(SECURITY_DIGEST, {
      justification: 'x',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FORBIDDEN'); // submitCodeFor's default bucket
    expect(result.reason).toBe('Not every covered verdict is security-posture.');
  });
});
