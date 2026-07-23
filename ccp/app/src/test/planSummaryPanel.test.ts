import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlanSummary } from '@/lib/planSummary';
import {
  hasPlanContent,
  planPendingText,
  PlanSummaryBlock,
  PlanSummaryPanel,
} from '@/features/requests/PlanSummaryPanel';

/**
 * 0035 Docket B — the plan-summary panel, rendered as an SSR string (no jsdom,
 * react-dom/server; PlanSummaryBlock's dependents useEffect never fires under
 * renderToStaticMarkup, exactly the CoolingPanel/LinkPrPanel precedent). Three
 * things the docket calls for: the headline, a REPLACE showing its curated
 * consequence panel, and the honest "no plan yet" empty state — never a fake.
 */

const REPLACE_SUMMARY: PlanSummary = {
  resourceChanges: [
    {
      address: 'aws_ebs_volume.app01_sdb',
      type: 'aws_ebs_volume',
      action: 'replace',
      forcedBy: ['encrypted'],
      changed: [{ attr: 'encrypted', before: 'false', after: 'true' }],
    },
  ],
  counts: { create: 0, update: 0, replace: 1, delete: 0, noop: 0 },
  recordedAt: '2026-07-14T12:30:00.000Z',
  runUrl: 'https://github.com/example-org/example-estate/actions/runs/42',
};

describe('PlanSummaryPanel — a REPLACE, headline + consequence panel + dependents', () => {
  const html = renderToStaticMarkup(
    React.createElement(PlanSummaryPanel, {
      summary: REPLACE_SUMMARY,
      dependentsByAddress: {
        'aws_ebs_volume.app01_sdb': ['aws_volume_attachment.app01_sdb'],
      },
    }),
  );

  it('leads with the plain-language headline naming the resource', () => {
    expect(html).toContain('This plan will replace one volume.');
  });

  it('marks the row as a Replace and explains what forced it', () => {
    expect(html).toContain('Replace');
    expect(html).toContain('Replacement forced by');
    expect(html).toContain('<code>encrypted</code>');
  });

  it('renders the curated consequence panel with the data-destruction badge', () => {
    // Curated copy from src/data/replaceConsequences.json for aws_ebs_volume.
    expect(html).toContain('Replacing a volume destroys the disk and creates an empty new one.');
    expect(html).toContain('Data inside is destroyed.');
    expect(html).toContain('All data on the volume is lost');
  });

  it('lists the committed-Terraform dependents of the doomed address', () => {
    expect(html).toContain('Also wired to this resource in the committed Terraform');
    expect(html).toContain('aws_volume_attachment.app01_sdb');
  });

  it('carries the vintage line with a link to the CI run — and never over-promises', () => {
    expect(html).toContain('From the CI plan recorded');
    expect(html).toContain('href="https://github.com/example-org/example-estate/actions/runs/42"');
    expect(html).toContain('view the run');
    expect(html).toContain('Nothing applies until every approval is in.');
  });
});

describe('PlanSummaryPanel — a no-op plan is honest about doing nothing', () => {
  it('renders the no-op headline and marks it as such', () => {
    const noop: PlanSummary = {
      resourceChanges: [],
      counts: { create: 0, update: 0, replace: 0, delete: 0, noop: 4 },
    };
    const html = renderToStaticMarkup(React.createElement(PlanSummaryPanel, { summary: noop }));
    expect(html).toContain('No changes — this plan leaves the live environment exactly as it is.');
    expect(html).toContain('plan-summary__headline--noop');
  });
});

describe('PlanSummaryBlock — the honest empty state, never a fabricated plan', () => {
  it('pre-PR: says the plan runs when the request becomes a PR', () => {
    const html = renderToStaticMarkup(
      React.createElement(PlanSummaryBlock, { status: 'SUBMITTED', planSummary: undefined }),
    );
    expect(html).toContain('Terraform runs the plan when this request becomes a PR');
    expect(html).toContain('plan-summary__pending');
  });

  it('a legacy string summary is not trusted — the guarded pending note shows instead', () => {
    const html = renderToStaticMarkup(
      React.createElement(PlanSummaryBlock, {
        status: 'PLAN_READY',
        planSummary: '1 to change, 0 to add, 0 to destroy.',
      }),
    );
    expect(html).toContain('No plan summary recorded yet');
    // The legacy string is never echoed as if it were the summary.
    expect(html).not.toContain('1 to change');
  });

  it('a terminal request with no plan renders nothing (no empty heading)', () => {
    const html = renderToStaticMarkup(
      React.createElement(PlanSummaryBlock, { status: 'APPLIED', planSummary: undefined }),
    );
    expect(html).toBe('');
  });
});

describe('hasPlanContent + planPendingText — the section-visibility guards', () => {
  it('hasPlanContent is true when there is a summary OR an honest pending note', () => {
    expect(hasPlanContent('SUBMITTED', undefined)).toBe(true);
    expect(hasPlanContent('PLAN_READY', undefined)).toBe(true);
    expect(hasPlanContent('APPLIED', REPLACE_SUMMARY)).toBe(true);
  });

  it('hasPlanContent is false for a terminal request with no plan (skip the heading)', () => {
    expect(hasPlanContent('APPLIED', undefined)).toBe(false);
    expect(hasPlanContent('REJECTED', undefined)).toBe(false);
  });

  it('planPendingText is pre-PR-honest, awaiting-honest, or null (terminal)', () => {
    expect(planPendingText('DRAFT')).toMatch(/becomes a PR/);
    expect(planPendingText('AWAITING_CODE_REVIEW')).toMatch(/once the PR’s plan job runs/);
    expect(planPendingText('APPLIED')).toBeNull();
  });
});
