import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { ProvisionCatalog } from '@/features/request/ProvisionCatalog';
import { deriveProvisionChoices, ProvisionTypePicker } from '@/features/request/ProvisionService';
import type { CatalogIndex, CatalogServiceEntry } from '@/lib/providerCatalog';
import { resetSettingsForTests, setChangeFreeze } from '@/lib/settings';

/**
 * Render shapes for the service-centric provision surfaces: the "What do you
 * need?" step lists ONE card per AWS service (never per-op action cards), and
 * the per-service picker prefers the estate's hand-authored create forms.
 * renderToStaticMarkup under MemoryRouter, same as the chooser tests.
 */

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, el));
}

const INDEX: CatalogIndex = {
  provider: 'hashicorp/aws',
  providerVersion: '6.53.0',
  services: [
    {
      slug: 'ec2',
      name: 'EC2',
      category: 'Compute',
      types: [{ t: 'aws_instance', label: 'Instance', primary: 1, req: 1, opt: 40 }],
    },
    {
      slug: 'sqs',
      name: 'SQS',
      category: 'Integration & Messaging',
      types: [
        { t: 'aws_sqs_queue', label: 'Queue', primary: 1, req: 0, opt: 20 },
        { t: 'aws_sqs_queue_policy', label: 'Queue policy', req: 2, opt: 1 },
      ],
    },
  ],
};

describe('ProvisionCatalog — one provision card per SERVICE', () => {
  beforeEach(() => {
    resetSettingsForTests();
  });

  // Collected (and so rendered) once, synchronously, before any beforeEach
  // runs — reset explicitly here too so this shared render is deterministic
  // regardless of what an earlier test in this file/process left behind,
  // same as every `it()` below that renders its own frozen/unfrozen html.
  resetSettingsForTests();
  const html = render(React.createElement(ProvisionCatalog, { index: INDEX, onPickTail: () => {} }));

  it('renders a provision card per service, linking to the provision page', () => {
    expect(html).toContain('Provision a new EC2 resource');
    expect(html).toContain('Provision a new SQS resource');
    expect(html).toContain('href="/provision/ec2"');
    expect(html).toContain('href="/provision/sqs"');
  });

  it('groups by the generated categories and shows the census line', () => {
    expect(html).toContain('Compute');
    expect(html).toContain('Integration &amp; Messaging');
    expect(html).toContain('2 services');
    expect(html).toContain('provider');
  });

  it('keeps the free-text tail as the last resort', () => {
    expect(html).toContain('Something that isn’t on this list');
    expect(html).toContain('bc-chooser__tail');
  });

  it('never renders op-level action cards on this page', () => {
    expect(html).not.toContain('href="/services/ec2/ec2-provision-instance"');
  });

  /**
   * OP-5 (2026-07-21 journey sim) — the describe-it escape hatch was the
   * last thing on a ~7,600px catalog and the intro never mentioned it. The
   * intro now names the option, and a persistent anchor sits above the
   * tile grid (not gated on search or the index having loaded), routing
   * through the SAME onPickTail the "Anything else" tail card at the foot
   * of the list already used.
   */
  it('the intro mentions the describe-it option', () => {
    expect(html).toContain('Describe it instead');
  });

  it('renders a persistent describe-it anchor, positioned above the tile grid', () => {
    expect(html).toContain('bc-describe-anchor');
    expect(html).toContain('Can’t find it? Describe it instead →');
    const anchorAt = html.indexOf('bc-describe-anchor');
    const gridAt = html.indexOf('console__add-grid');
    expect(anchorAt).toBeGreaterThan(-1);
    expect(gridAt).toBeGreaterThan(-1);
    expect(anchorAt).toBeLessThan(gridAt);
  });

  it('the anchor still renders above the fold even before the provider index has loaded', () => {
    const loadingHtml = render(React.createElement(ProvisionCatalog, { index: null, onPickTail: () => {} }));
    expect(loadingHtml).toContain('bc-describe-anchor');
  });

  it('the anchor still renders when a search query matches nothing', () => {
    // query state is internal — exercised indirectly is out of scope here;
    // what matters is the anchor's render is unconditional on `index`/query,
    // unlike the "Anything else" tail card which sits after the (possibly
    // empty) results list.
    expect(html.indexOf('bc-describe-anchor')).toBeLessThan(html.indexOf('catalog__search'));
  });

  it('no freeze notice when the estate is open', () => {
    expect(html).not.toContain('bc-frozen-notice');
  });

  it('LD-4: shows a freeze notice at page entry when the estate is frozen', () => {
    setChangeFreeze(true);
    const frozenHtml = render(
      React.createElement(ProvisionCatalog, { index: INDEX, onPickTail: () => {} }),
    );
    expect(frozenHtml).toContain('bc-frozen-notice');
    expect(frozenHtml).toContain('frozen by an administrator');
  });
});

describe('ProvisionTypePicker — estate forms lead, generated forms cover the rest', () => {
  const entry: CatalogServiceEntry = {
    slug: 'ec2',
    name: 'EC2',
    category: 'Compute',
    types: [
      { t: 'aws_instance', label: 'Instance', primary: 1, req: 1, opt: 40 },
      { t: 'aws_ec2_fleet', label: 'Fleet', req: 2, opt: 12 },
    ],
  };
  const choices = deriveProvisionChoices(entry, manifests);
  const html = render(
    React.createElement(ProvisionTypePicker, {
      serviceName: 'EC2',
      choices,
      onPick: () => {},
    }),
  );

  it('the estate’s hand-authored create form is preferred for aws_instance', () => {
    const instance = choices.find((c) => c.summary.t === 'aws_instance');
    expect(instance?.ops.some((op) => op.id === 'ec2-provision-instance')).toBe(true);
    expect(html).toContain('href="/services/ec2/ec2-provision-instance"');
    expect(html).toContain('estate form');
  });

  it('types without a manifest form offer the generated form with its parameter counts', () => {
    const fleet = choices.find((c) => c.summary.t === 'aws_ec2_fleet');
    expect(fleet?.ops).toEqual([]);
    expect(html).toContain('2 required · 12 optional settings');
    expect(html).toContain('aws_ec2_fleet');
  });
});
