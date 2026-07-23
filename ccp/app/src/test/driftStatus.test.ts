import { beforeEach, describe, expect, it } from 'vitest';
import { createMockApiClient } from '@/lib/api';
import { createHttpApiClient } from '@/lib/httpApi';
import { ensureSeeded, resetStoreForTests } from '@/lib/accounts';
import { login, signOut } from '@/lib/auth';
import { SEED_LEAD } from '@/config';
import { setProjectScopeForTests } from '@/lib/projectScope';
import type { DriftReport } from '@/types/drift';

/**
 * The drift-portal spec's SPA seam (slice 1, "See it"): `getDriftStatus()`
 * through both clients.
 *
 * Mock half: the seeded report is deterministic (fixed timestamps, same
 * doctrine as seedRequests()) and role-projected exactly like the field-
 * tier table the api will enforce server-side — a Requester keeps
 * presence, never values or security evidence; Approver/Lead see the
 * report unmodified. This is what "mock parity" (the mock simulates the
 * whole pipeline) means for this WI.
 *
 * httpApi half: an injected fetch proves 200 connected:true maps to the
 * report, 200 connected:false / 404 / a network failure all map to null —
 * the ApiClient seam has no error variant for this flow, so every failure
 * mode collapses to the same honest "not connected" answer.
 */

function seedPeople(): void {
  resetStoreForTests();
  signOut();
}

beforeEach(seedPeople);

describe('mock — getDriftStatus() serves the seeded report, role-projected', () => {
  // alice (lead/admin) + the roster from project.json's seedAccounts: bob
  // (lead), carol (approver), dave/erin (requesters). Every
  // seeded roster row below the bootstrap Lead carries its OWN `password`
  // field equal to its username (project.json) — SEED_ACCOUNT_DEFAULT_PASSWORD
  // is a fallback for a project that omits one, not this one's credential.
  beforeEach(async () => {
    await ensureSeeded();
  });

  it('an approver sees full detail: values, machine values, security evidence, recommendation prose', async () => {
    await login('carol', 'carol');
    const api = createMockApiClient();
    const status = await api.getDriftStatus();
    expect(status).not.toBeNull();
    const report = status!.report;

    expect(report.planExitCode).toBe(2);
    expect(report.cadenceHours).toBe(6);
    expect(report.counts).toEqual({
      drifted: 3,
      security: 1,
      byClass: { benign_inplace: 1, security_posture: 1, oob_deletion: 1 },
      unmanaged: 3,
    });
    expect(report.verdicts).toHaveLength(3);

    const benign = report.verdicts.find((v) => v.class === 'benign_inplace');
    expect(benign).toBeDefined();
    expect(benign!.changedAttrs).toEqual([
      {
        path: 'tags.Owner',
        live: '"bi-team"',
        code: '"platform"',
        sensitive: false,
        liveJson: 'bi-team',
        codeJson: 'platform',
      },
    ]);

    const security = report.verdicts.find((v) => v.class === 'security_posture');
    expect(security).toBeDefined();
    expect(security!.riskTier).toBe('high');
    expect(security!.securityHits?.length).toBeGreaterThan(0);
    expect(security!.recommendation).toBeTruthy();
    expect(security!.neverDo).toBeTruthy();

    // Drift restore tranche (L29): the seeded out-of-band-deletion verdict —
    // a pure create with drift evidence, restore-eligible.
    const restoreEligible = report.verdicts.find((v) => v.class === 'oob_deletion');
    expect(restoreEligible).toBeDefined();
    expect(restoreEligible!.address).toBe('aws_flow_log.prod_vpc');
    expect(restoreEligible!.actions).toEqual(['create']);
    expect(restoreEligible!.driftEvidence).toBe(true);
    expect(restoreEligible!.changedAttrs).toEqual([]);
    expect(restoreEligible!.securityHits ?? []).toEqual([]);
    expect(restoreEligible!.recommendation).toBeTruthy();

    expect(report.absorbed).toEqual([
      { address: 'aws_s3_bucket.app_backup', class: 'churn_absorbed', riskTier: 'info' },
    ]);
    expect(report.invisibleToPlan).toBeTruthy();

    // Out-of-band provisioning spec: the sweep section, unprojected for
    // approver+ — identifiers and evidence bodies present.
    expect(report.sweep).toBeDefined();
    expect(report.sweep!.findings).toHaveLength(3);
    expect(report.sweep!.totalFindings).toBe(3);
    const importEligible = report.sweep!.findings.find((f) => f.tfType === 'aws_instance')!;
    expect(importEligible.arn).toBeTruthy();
    expect(importEligible.liveId).toBeTruthy();
    expect(importEligible.importPayload).toBeTruthy();
    expect(importEligible.importPayload!.importBlock).toContain('import {');
    const securityFamily = report.sweep!.findings.find((f) => f.securityFamily)!;
    expect(securityFamily.actor).toBeTruthy();
    const withheld = report.sweep!.findings.find((f) => f.tfType === 'aws_db_instance')!;
    expect(withheld.payloadWithheldReason).toBeTruthy();
    expect(withheld.actor).toBeNull(); // no CloudTrail match — never omitted, never a guessed value
  });

  it('a lead sees the same full detail as an approver', async () => {
    await login(SEED_LEAD.username, SEED_LEAD.defaultPassword);
    const api = createMockApiClient();
    const status = await api.getDriftStatus();
    const security = status!.report.verdicts.find((v) => v.class === 'security_posture')!;
    expect(security.securityHits?.length).toBeGreaterThan(0);
    expect(security.recommendation).toBeTruthy();
  });

  it('a requester sees presence — address, type, class, risk, attr paths — but never values or security evidence', async () => {
    await login('dave', 'dave');
    const api = createMockApiClient();
    const status = await api.getDriftStatus();
    expect(status).not.toBeNull();
    const report = status!.report;

    // Presence — every tier, unchanged from the approver's view.
    expect(report.counts.drifted).toBe(3);
    expect(report.verdicts.map((v) => v.address).sort()).toEqual([
      'aws_flow_log.prod_vpc',
      'aws_instance.app01',
      'aws_security_group.apm_agents',
    ]);

    for (const v of report.verdicts) {
      expect(v.class).toBeTruthy();
      expect(v.riskTier).toBeTruthy();
      for (const attr of v.changedAttrs ?? []) {
        expect(attr.path).toBeTruthy();
        // Values follow duty — absent for a Requester.
        expect(attr.live).toBeUndefined();
        expect(attr.code).toBeUndefined();
        expect(attr.liveJson).toBeUndefined();
        expect(attr.codeJson).toBeUndefined();
        expect(attr.sensitive).toBeUndefined();
      }
      expect(v.securityHits ?? []).toEqual([]);
      expect(v.recommendation).toBeUndefined();
      expect(v.neverDo).toBeUndefined();
      expect(v.executor).toBeUndefined();
    }

    // The completeness footer is not duty-gated — every tier sees it.
    expect(report.invisibleToPlan).toBeTruthy();
    expect(report.absorbed).toHaveLength(1);

    // Out-of-band provisioning spec: sweep presence — every finding's
    // {class, tfType, name, service, securityFamily, importPayloadPresent}
    // survives, but never an identifier or evidence body, and never
    // `stateful` (the api's requesterFindingView omits it too, despite it
    // living on the same base row as `service`).
    expect(report.sweep).toBeDefined();
    expect(report.sweep!.totalFindings).toBe(3); // report-level counts follow every tier
    expect(report.sweep!.findings).toHaveLength(3);
    for (const f of report.sweep!.findings) {
      expect(f.class).toBeTruthy();
      expect(f.service).toBeTruthy();
      expect(typeof f.importPayloadPresent).toBe('boolean');
      expect(f.arn).toBeUndefined();
      expect(f.liveId).toBeUndefined();
      expect(f.region).toBeUndefined();
      expect(f.stateful).toBeUndefined();
      expect(f.actor).toBeUndefined();
      expect(f.importPayload).toBeUndefined();
      expect(f.payloadWithheldReason).toBeUndefined();
    }
    const importEligible = report.sweep!.findings.find((f) => f.tfType === 'aws_instance')!;
    expect(importEligible.importPayloadPresent).toBe(true);
    const securityFamily = report.sweep!.findings.find((f) => f.securityFamily)!;
    expect(securityFamily.importPayloadPresent).toBe(false);
  });

  it('the mock never answers not-connected — per-flow parity, the seedRequests() doctrine (0027 §4 invariant 7 is superseded)', async () => {
    signOut(); // resolves to the anonymous fallback (role 'requester') — still connected
    const api = createMockApiClient();
    expect(await api.getDriftStatus()).not.toBeNull();
  });
});

describe('httpApi — getDriftStatus() maps 200/404/network onto DriftStatus | null', () => {
  const REPORT: DriftReport = {
    version: 3,
    capturedAt: '2026-07-20T03:17:04.000Z',
    runId: '999',
    commit: 'deadbeef',
    cadenceHours: 6,
    planExitCode: 2,
    counts: { drifted: 1, security: 0, byClass: { benign_inplace: 1 } },
    verdicts: [],
    absorbed: [],
    invisibleToPlan: 'Out-of-band creations are invisible to plan-based detection.',
  };

  function fakeFetch(handler: () => { status: number; body?: unknown }): {
    fetch: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const { status, body } = handler();
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    return { fetch: fn, calls };
  }

  beforeEach(() => setProjectScopeForTests('sample'));

  it('200 connected:true maps to the report, hitting GET /projects/:id/drift', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { connected: true, report: REPORT },
    }));
    const client = createHttpApiClient('', { fetch });
    expect(await client.getDriftStatus()).toEqual({ report: REPORT });
    expect(calls).toEqual(['/projects/sample/drift']);
  });

  it('200 connected:false (disarmed, or nothing ever published) maps to null', async () => {
    const client = createHttpApiClient('', {
      fetch: fakeFetch(() => ({ status: 200, body: { connected: false } })).fetch,
    });
    expect(await client.getDriftStatus()).toBeNull();
  });

  it('404 (archived / unbound project) maps to null', async () => {
    const client = createHttpApiClient('', {
      fetch: fakeFetch(() => ({ status: 404, body: { code: 'STATE_CONFLICT', reason: 'no' } })).fetch,
    });
    expect(await client.getDriftStatus()).toBeNull();
  });

  it('403 (unbound account — PROJECT_SCOPE) also maps to null, the same honest "not connected"', async () => {
    const client = createHttpApiClient('', {
      fetch: fakeFetch(() => ({ status: 403, body: { code: 'PROJECT_SCOPE', reason: 'no' } })).fetch,
    });
    expect(await client.getDriftStatus()).toBeNull();
  });

  it('a network failure maps to null — this seam never throws (no error variant on the return type)', async () => {
    const throwingFetch = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const client = createHttpApiClient('', { fetch: throwingFetch });
    expect(await client.getDriftStatus()).toBeNull();
  });
});
