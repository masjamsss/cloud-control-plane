import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DriftReport, DriftStatus, DriftVerdict } from '@/types/drift';
import {
  DriftStatusCard,
  driftAgeLabel,
  driftCardModel,
  isDriftStale,
} from '@/features/drift/DriftPanel';
import { DriftReportBody, DriftVerdictTable } from '@/features/drift/DriftPage';
import { formatProjectTime } from '@/lib/datetime';

/**
 * The drift panel + page — rendered as SSR strings (no jsdom in this repo;
 * react-dom/server, the CoolingPanel/PlanSummaryPanel precedent). Pins the
 * spec's five card states, the exactly-2x-cadence staleness boundary, age
 * clamping, the role-projection render contract (presence always renders,
 * values only when the data itself carries them), and the invisibleToPlan
 * footer's standing presence.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

const NOW = Date.parse('2026-07-20T09:17:00.000Z');

function baseReport(overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    version: 1,
    capturedAt: '2026-07-20T08:00:00.000Z',
    runId: '1',
    commit: 'abc',
    cadenceHours: 6,
    planExitCode: 0,
    counts: { drifted: 0, security: 0, byClass: {} },
    verdicts: [],
    absorbed: [],
    invisibleToPlan: 'Out-of-band creations are invisible to plan-based detection.',
    ...overrides,
  };
}

/** A minimal swept sweep section (out-of-band provisioning spec) — `n`
 * findings, deliberately empty rows (this describe block never renders the
 * unmanaged-resources section itself, only DriftStatusCard's own count
 * line, which reads only `report.sweep`'s presence + `counts.unmanaged`). */
function sweptSection(n: number): DriftReport['sweep'] {
  return {
    method: 'importer-kit discover',
    capturedAt: '2026-07-20T08:00:00.000Z',
    region: 'ap-southeast-1',
    findings: [],
    totalFindings: n,
    ignoredCount: 0,
  };
}

describe('driftAgeLabel — relative age, clamped at zero', () => {
  it('a timestamp in the past renders hours/minutes ago', () => {
    expect(driftAgeLabel('2026-07-20T06:17:00.000Z', NOW)).toBe('3h 0m ago');
  });

  it('under an hour renders minutes only', () => {
    expect(driftAgeLabel('2026-07-20T09:00:00.000Z', NOW)).toBe('17m ago');
  });

  it('a future timestamp (client clock skew) clamps to zero — never "in N minutes"', () => {
    expect(driftAgeLabel('2026-07-20T10:00:00.000Z', NOW)).toBe('just now');
  });

  it('an unparseable timestamp reads as unknown, never as freshly-just-happened', () => {
    expect(driftAgeLabel('not-a-date', NOW)).toBe('unknown age');
  });
});

describe('isDriftStale — flips exactly past 2x cadence, never at it', () => {
  const capturedAt = '2026-07-20T00:00:00.000Z';
  const cadenceHours = 6; // stale threshold: 12h

  it('at exactly 2x cadence: not yet stale', () => {
    const now = Date.parse(capturedAt) + 12 * 60 * 60 * 1000;
    expect(isDriftStale(capturedAt, cadenceHours, now)).toBe(false);
  });

  it('one millisecond past 2x cadence: stale', () => {
    const now = Date.parse(capturedAt) + 12 * 60 * 60 * 1000 + 1;
    expect(isDriftStale(capturedAt, cadenceHours, now)).toBe(true);
  });

  it('well within cadence: not stale', () => {
    const now = Date.parse(capturedAt) + 60 * 60 * 1000; // 1h
    expect(isDriftStale(capturedAt, cadenceHours, now)).toBe(false);
  });
});

describe('driftCardModel + DriftStatusCard — the states, extended (out-of-band provisioning spec) with the unmanaged-resource sweep axis', () => {
  it('not connected: the grey note, never reading as green/clean', () => {
    const model = driftCardModel(null, NOW);
    expect(model.tone).toBe('unknown');
    expect(model.stale).toBe(false);
    expect(model.headline).toBe("Drift monitoring isn't connected in this deployment");

    const html = render(React.createElement(DriftStatusCard, { status: null, now: NOW }));
    // React HTML-escapes the apostrophe in rendered markup — match text either
    // side of it rather than the literal contraction.
    expect(html).toContain('Drift monitoring isn');
    expect(html).toContain('connected in this deployment');
    expect(html).toContain('drift-card--unknown');
    expect(html).not.toContain('drift-card--clean');
    expect(html).not.toContain('drift-card--drifted');
  });

  it('clean AND swept (zero unmanaged): the ONLY case that may claim "no unmanaged resources" — a dated positive claim, never an unqualified "in sync"', () => {
    const capturedAt = '2026-07-20T08:00:00.000Z'; // well under the 12h stale threshold
    const status: DriftStatus = {
      report: baseReport({
        capturedAt,
        planExitCode: 0,
        counts: { drifted: 0, security: 0, byClass: {}, unmanaged: 0 },
        sweep: sweptSection(0),
      }),
    };
    const html = render(React.createElement(DriftStatusCard, { status, now: NOW }));
    expect(html).toContain('No drift detected · no unmanaged resources as of');
    expect(html).toContain(formatProjectTime(capturedAt));
    expect(html).toContain('drift-card--clean');
    expect(html).not.toContain('drift-card--stale');
  });

  it('NAMED INVARIANT: a report with no sweep section NEVER renders "clean" tone or claims "no unmanaged resources", even when drift itself is clean', () => {
    const capturedAt = '2026-07-20T08:00:00.000Z';
    const status: DriftStatus = { report: baseReport({ capturedAt, planExitCode: 0 }) }; // no `sweep` key at all
    const model = driftCardModel(status, NOW);
    expect(model.tone).not.toBe('clean');
    expect(model.headline).toContain('unmanaged: not swept');
    expect(model.headline).not.toContain('no unmanaged resources');

    const html = render(React.createElement(DriftStatusCard, { status, now: NOW }));
    expect(html).toContain('unmanaged: not swept');
    expect(html).not.toContain('drift-card--clean');
    expect(html).not.toContain('no unmanaged resources');
  });

  it('drifted: names the drifted count and the security count, dated, unmanaged: not swept when the report carries no sweep', () => {
    const capturedAt = '2026-07-20T08:00:00.000Z';
    const status: DriftStatus = {
      report: baseReport({
        capturedAt,
        planExitCode: 2,
        counts: { drifted: 7, security: 1, byClass: { benign_inplace: 6, security_posture: 1 } },
      }),
    };
    const html = render(React.createElement(DriftStatusCard, { status, now: NOW }));
    expect(html).toContain('7 resources drifted, 1 security');
    expect(html).toContain(formatProjectTime(capturedAt));
    expect(html).toContain('unmanaged: not swept');
    expect(html).toContain('drift-card--drifted');
  });

  it('drifted AND swept: both counts named on one line, amber tone', () => {
    const capturedAt = '2026-07-20T08:00:00.000Z';
    const status: DriftStatus = {
      report: baseReport({
        capturedAt,
        planExitCode: 2,
        counts: { drifted: 7, security: 1, byClass: { benign_inplace: 6, security_posture: 1 }, unmanaged: 2 },
        sweep: sweptSection(2),
      }),
    };
    const html = render(React.createElement(DriftStatusCard, { status, now: NOW }));
    expect(html).toContain('7 resources drifted, 1 security · 2 resources unmanaged as of');
    expect(html).toContain('drift-card--drifted');
  });

  it('drift itself clean, but unmanaged findings exist: amber, never clean — a clean plan is not a clean card', () => {
    const status: DriftStatus = {
      report: baseReport({
        planExitCode: 0,
        counts: { drifted: 0, security: 0, byClass: {}, unmanaged: 3 },
        sweep: sweptSection(3),
      }),
    };
    const model = driftCardModel(status, NOW);
    expect(model.tone).toBe('drifted');
    expect(model.headline).toContain('No drift detected');
    expect(model.headline).toContain('3 resources unmanaged');

    const html = render(React.createElement(DriftStatusCard, { status, now: NOW }));
    expect(html).toContain('drift-card--drifted');
    expect(html).not.toContain('drift-card--clean');
  });

  it('a single drifted resource is singular ("1 resource", not "1 resources") — same rule for a single unmanaged resource', () => {
    const status: DriftStatus = {
      report: baseReport({
        planExitCode: 2,
        counts: { drifted: 1, security: 0, byClass: { benign_inplace: 1 }, unmanaged: 1 },
        sweep: sweptSection(1),
      }),
    };
    const html = render(React.createElement(DriftStatusCard, { status, now: NOW }));
    expect(html).toContain('1 resource drifted');
    expect(html).not.toContain('1 resources drifted');
    expect(html).toContain('1 resource unmanaged');
    expect(html).not.toContain('1 resources unmanaged');
  });

  it('stale: leads with "Last checked X ago" and carries the stale styling — data stays, confidence degrades', () => {
    const capturedAt = '2026-07-19T00:00:00.000Z'; // 33h before NOW, past the 12h threshold
    const status: DriftStatus = {
      report: baseReport({
        capturedAt,
        planExitCode: 0,
        counts: { drifted: 0, security: 0, byClass: {}, unmanaged: 0 },
        sweep: sweptSection(0),
      }),
    };
    const html = render(React.createElement(DriftStatusCard, { status, now: NOW }));
    expect(html).toContain('Last checked');
    expect(html).toContain('ago');
    expect(html).toContain('drift-card--stale');
    // The dated claim itself is still present — stale data is shown, not hidden.
    expect(html).toContain('No drift detected · no unmanaged resources as of');
  });
});

describe('DriftVerdictTable — role-projected columns: presence always, values only when the data carries them', () => {
  const requesterVerdict: DriftVerdict = {
    address: 'aws_security_group.apm_agents',
    type: 'aws_security_group',
    actions: ['update'],
    class: 'security_posture',
    riskTier: 'high',
    driftEvidence: true,
    changedAttrs: [{ path: 'ingress[0].cidr_blocks' }],
    // securityHits / recommendation / neverDo: absent — the Requester tier.
  };

  const approverVerdict: DriftVerdict = {
    ...requesterVerdict,
    changedAttrs: [
      { path: 'ingress[0].cidr_blocks', live: '["0.0.0.0/0"]', code: '["10.0.0.0/16"]' },
    ],
    securityHits: [
      { path: 'ingress[0].cidr_blocks', why: 'network reachability changed out-of-band' },
    ],
    recommendation: 'Capture evidence, then default to reverting in the console.',
  };

  it('a requester-projected verdict shows the address, class, risk and path, but never a value or security evidence', () => {
    const html = render(React.createElement(DriftVerdictTable, { verdicts: [requesterVerdict] }));
    expect(html).toContain('aws_security_group.apm_agents');
    expect(html).toContain('ingress[0].cidr_blocks');
    expect(html).toContain('security posture');
    expect(html).toContain('high');
    expect(html).not.toContain('0.0.0.0/0');
    expect(html).not.toContain('10.0.0.0/16');
    expect(html).not.toContain('network reachability');
    expect(html).not.toContain('Capture evidence');
    expect(html).not.toContain('security evidence');
  });

  it('an approver-projected verdict shows the values and the security evidence badge', () => {
    const html = render(React.createElement(DriftVerdictTable, { verdicts: [approverVerdict] }));
    expect(html).toContain('0.0.0.0/0');
    expect(html).toContain('10.0.0.0/16');
    expect(html).toContain('network reachability changed out-of-band');
    expect(html).toContain('Capture evidence');
    expect(html).toContain('security evidence');
  });

  it('no verdicts: the honest empty state, not a blank table', () => {
    const html = render(React.createElement(DriftVerdictTable, { verdicts: [] }));
    expect(html).toContain('No drifted resources');
    expect(html).not.toContain('<table');
  });
});

describe('DriftReportBody — the invisibleToPlan footer always renders, whatever the verdict count', () => {
  it('renders the footer verbatim even when nothing drifted (the clean state)', () => {
    const html = render(
      React.createElement(DriftReportBody, {
        report: baseReport({ planExitCode: 0, verdicts: [] }),
      }),
    );
    expect(html).toContain('Out-of-band creations are invisible to plan-based detection.');
  });

  it('renders the footer verbatim alongside a populated verdict table', () => {
    const verdict: DriftVerdict = {
      address: 'aws_instance.app01',
      type: 'aws_instance',
      actions: ['update'],
      class: 'benign_inplace',
      riskTier: 'low',
      driftEvidence: true,
      changedAttrs: [{ path: 'tags.Owner' }],
    };
    const html = render(
      React.createElement(DriftReportBody, {
        report: baseReport({
          planExitCode: 2,
          counts: { drifted: 1, security: 0, byClass: { benign_inplace: 1 } },
          verdicts: [verdict],
        }),
      }),
    );
    expect(html).toContain('Out-of-band creations are invisible to plan-based detection.');
    expect(html).toContain('tags.Owner');
  });

  it('renders the absorbed-entries note only when there are any', () => {
    const withAbsorbed = render(
      React.createElement(DriftReportBody, {
        report: baseReport({
          absorbed: [{ address: 'aws_s3_bucket.app_backup', class: 'churn_absorbed', riskTier: 'info' }],
        }),
      }),
    );
    expect(withAbsorbed).toContain('absorbed by an existing ignore rule');
    expect(withAbsorbed).toContain('aws_s3_bucket.app_backup');

    const withoutAbsorbed = render(
      React.createElement(DriftReportBody, { report: baseReport({ absorbed: [] }) }),
    );
    expect(withoutAbsorbed).not.toContain('absorbed by an existing ignore rule');
  });
});

describe('router — /drift is a registered project-scoped route, open to every role', () => {
  // router.tsx's createBrowserRouter needs a DOM at import time, so
  // registration is pinned at the source level — the notInControlPlane.test.ts
  // technique.
  const source = readFileSync(join(SRC, 'router.tsx'), 'utf8');

  it('registers the drift path with the DriftPage element', () => {
    expect(source).toContain("path: 'drift'");
    expect(source).toContain('<DriftPage />');
  });

  it('is NOT wrapped in a RoleGate, unlike Approvals/Dashboard', () => {
    const driftBlock = source.slice(source.indexOf("path: 'drift'"), source.indexOf("path: 'approvals'"));
    expect(driftBlock).not.toContain('RoleGate');
  });
});
