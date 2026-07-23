import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import {
  buildBeyondCatalogDraft,
  catalogedRedirect,
  deriveTechnologyChooser,
  type BeyondCatalogInput,
} from '@/lib/beyondCatalog';
import {
  CatalogedRedirectBanner,
  TechnologyChooserStep,
  tailPrefillFrom,
} from '@/features/request/BeyondCatalogForm';
import { APP_NAME } from '@/brand';

/**
 * 0034 A11 render shapes: STEP 1 (the technology chooser) routes cataloged
 * technology into the REAL form; the redirect banner is non-blocking routing
 * intelligence; the "Request again" prefill copies structured params but
 * never the justification. renderToStaticMarkup under MemoryRouter (Links).
 */

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, el));
}

describe('TechnologyChooserStep — the baselines come FIRST', () => {
  const groups = deriveTechnologyChooser(manifests);
  const html = render(
    React.createElement(TechnologyChooserStep, { groups, onPickTail: () => {} }),
  );

  it('renders one card per provision baseline, each linking into the real form', () => {
    expect(html).toContain('href="/services/ec2/ec2-provision-instance"');
    expect(html).toContain('href="/services/ebs/ebs-create-volume"');
    expect(html).toContain('href="/services/s3/s3-create-bucket"');
  });

  it('groups carry the catalog’s category headings', () => {
    expect(html).toContain('Compute');
    expect(html).toContain('Storage');
    expect(html).toContain('Networking');
  });

  it('the free-text tail is the LAST resort card, clearly labeled', () => {
    expect(html).toContain(`Something ${APP_NAME} doesn’t offer yet`);
    // The tail is a button (a mode switch), not a navigation.
    expect(html).toContain('bc-chooser__tail');
  });
});

describe('CatalogedRedirectBanner — typing service: ec2 shows the baseline redirect', () => {
  it('renders the display name, the baseline title, and the link into the real form', () => {
    const redirect = catalogedRedirect('ec2', manifests);
    const html = render(React.createElement(CatalogedRedirectBanner, { redirect }));
    expect(html).toContain('EC2');
    expect(html).toContain('already cataloged');
    expect(html).toContain('href="/services/ec2/ec2-provision-instance"');
    // Non-blocking: the banner says submission stays possible.
    expect(html).toContain('You can still submit here');
  });

  it('renders nothing for an uncataloged service', () => {
    expect(render(React.createElement(CatalogedRedirectBanner, { redirect: null }))).toBe('');
  });
});

describe('tailPrefillFrom — "Request again" seeds the structured tail, never the justification', () => {
  const input: BeyondCatalogInput = {
    kind: 'new_resource_uncatalogued',
    service: 'redshift',
    resourceType: 'aws_redshift_cluster',
    workload: 'Month-end finance analytics for the reporting team.',
    sizingCapacity: 500,
    sizingUnit: 'GiB',
    instanceCount: 3,
    connectivity: 'vpc-internal',
    dataClassification: 'confidential',
    neededBy: '2027-01-15',
    summary: 'A Redshift cluster for the new finance analytics workload.',
    justification: 'Finance needs a dedicated warehouse for month-end reporting and cannot wait.',
  };

  it('copies every structured field back into form state', () => {
    const draft = buildBeyondCatalogDraft(input, 'dewi');
    const prefill = tailPrefillFrom(draft);
    expect(prefill).toMatchObject({
      kind: 'new_resource_uncatalogued',
      service: 'redshift',
      resourceType: 'aws_redshift_cluster',
      workload: input.workload,
      sizingCapacity: '500',
      sizingUnit: 'GiB',
      instanceCount: '3',
      connectivity: 'vpc-internal',
      dataClassification: 'confidential',
      neededBy: '2027-01-15',
      summary: input.summary,
    });
    // The justification is deliberately NOT part of the prefill shape.
    expect(prefill && 'justification' in prefill).toBe(false);
  });

  it('a v1 request (no structured fields) prefills what it has and safe defaults for the rest', () => {
    const draft = buildBeyondCatalogDraft(input, 'dewi');
    draft.params = { kind: 'enable_new_service', summary: 'Enable Redshift.' };
    const prefill = tailPrefillFrom(draft);
    expect(prefill).toMatchObject({
      kind: 'enable_new_service',
      summary: 'Enable Redshift.',
      workload: '',
      connectivity: 'unknown',
      dataClassification: '',
    });
  });

  it('returns null for a non-beyond-catalog request', () => {
    const draft = buildBeyondCatalogDraft(input, 'dewi');
    draft.operationId = 'ebs-grow';
    expect(tailPrefillFrom(draft)).toBeNull();
  });
});
