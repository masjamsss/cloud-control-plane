import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { deriveServiceCatalog, type ServiceSummary } from '@/lib/catalog';
import { provisionPathFor, type CatalogIndex } from '@/lib/providerCatalog';
import awsCatalogIndex from '@/data/provider-catalog/index.json';
import azureCatalogIndex from '@/data/provider-catalog-azure/index.json';
import { AWS_SERVICES } from '@/lib/awsServiceMap';
import { AZURE_SERVICES } from '@/lib/azureServiceMap';
import type { CloudProvider } from '@/lib/providerDisplay';
import { ServiceCard } from '@/features/catalog/ServiceCard';

/**
 * Full provisionable coverage. The catalog browses EVERY top-level provisionable
 * service, not just the ones a curated op happens to cover. deriveServiceCatalog
 * augments the with-ops summaries with an op-less summary for every remaining
 * service in the provider's tile map, so the derived set is the whole provider
 * map — and each op-less tile is a working "Provision <service>" deep-link into
 * the provider-wide provision page (/provision/<service>?type=…), never a
 * dead/empty tile.
 *
 * The real per-cloud coverage numbers (the headline the owner asked for):
 *   · AWS   — 154 services (134 with a catalog op + 20 op-less Provision-only)
 *   · Azure — 155 services (135 with a catalog op + 20 op-less Provision-only)
 */

const AWS_FULL = 156;
const AZURE_FULL = 155;
const AWS_WITH_OPS = 143;
const AZURE_WITH_OPS = 135;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every resource type the provider-catalog can stand up, per cloud — the
 * unified provision system's "is this type provisionable?" source of truth
 * (replacing the retired provision-catalog.json's findProvisionEntry). An
 * op-less tile's primaryType must be a member, or its deep-link is dead. */
const PROVISIONABLE: Record<CloudProvider, Set<string>> = {
  aws: new Set(
    (awsCatalogIndex as unknown as CatalogIndex).services.flatMap((s) => s.types.map((t) => t.t)),
  ),
  azure: new Set(
    (azureCatalogIndex as unknown as CatalogIndex).services.flatMap((s) => s.types.map((t) => t.t)),
  ),
  // No gcp provider-catalog tree exists yet (0034 lane G3/G4): the empty
  // set keeps the Record exhaustive and means zero gcp types are provisionable
  // — the fail-closed reading, same as loadProviderIndex's empty gcp index.
  gcp: new Set<string>(),
};

function summariesFor(provider: CloudProvider): ServiceSummary[] {
  return deriveServiceCatalog(manifests, undefined, provider).flatMap((g) => g.services);
}

describe('deriveServiceCatalog yields the full provisionable-service set per cloud', () => {
  it('an aws project browses all 156 aws services (143 with ops + 13 op-less)', () => {
    const summaries = summariesFor('aws');
    expect(summaries).toHaveLength(AWS_FULL);
    // Every derived service is an aws service (no azure leakage) and the tile map
    // is browsed in full (every AWS_SERVICES key surfaces exactly once).
    const slugs = new Set(summaries.map((s) => s.service));
    expect(slugs.size).toBe(AWS_FULL);
    for (const slug of Object.keys(AWS_SERVICES)) expect(slugs.has(slug), slug).toBe(true);
    // With-ops services are unchanged in count (the browse we already shipped).
    expect(summaries.filter((s) => s.operations.length > 0)).toHaveLength(AWS_WITH_OPS);
    expect(summaries.filter((s) => s.operations.length === 0)).toHaveLength(
      AWS_FULL - AWS_WITH_OPS,
    );
  });

  it('an azure project browses all 155 azure services (135 with ops + 20 op-less)', () => {
    const summaries = summariesFor('azure');
    expect(summaries).toHaveLength(AZURE_FULL);
    const slugs = new Set(summaries.map((s) => s.service));
    expect(slugs.size).toBe(AZURE_FULL);
    for (const slug of Object.keys(AZURE_SERVICES)) expect(slugs.has(slug), slug).toBe(true);
    expect(summaries.filter((s) => s.operations.length > 0)).toHaveLength(AZURE_WITH_OPS);
    expect(summaries.filter((s) => s.operations.length === 0)).toHaveLength(
      AZURE_FULL - AZURE_WITH_OPS,
    );
  });
});

describe('every op-less service is a working Provision deep-link (never a dead tile)', () => {
  for (const provider of ['aws', 'azure'] as const) {
    it(`every op-less ${provider} tile carries a primaryType that resolves a real provisionable entry`, () => {
      const opless = summariesFor(provider).filter((s) => s.operations.length === 0);
      expect(opless.length).toBeGreaterThan(0);
      for (const s of opless) {
        // op-less ⟹ has a provisionable type to provision (no primaryType would
        // mean a dead tile — exactly what full coverage exists to prevent).
        expect(s.primaryType, `${s.service} op-less but has no primaryType`).toBeTruthy();
        // …and that type is a real entry the /provision form can stand up.
        expect(
          PROVISIONABLE[provider].has(s.primaryType!),
          `${s.service} → ${s.primaryType} not provisionable`,
        ).toBe(true);
      }
    });
  }

  it('a concrete op-less aws service deep-links to /provision for its primary type', () => {
    // Cognito was the fixed example; it now carries curated create ops (0039 aws-provision-
    // structure), so pick ANY still-op-less aws service dynamically — the invariant (an
    // op-less tile is a working /provision deep-link for its primaryType) holds whichever
    // service it is, and this no longer breaks each time a service earns its first op.
    const opLess = summariesFor('aws').find((s) => s.operations.length === 0 && s.primaryType);
    expect(opLess, 'expected at least one op-less aws service').toBeDefined();
    expect(opLess!.manifest).toBeUndefined(); // op-less: no manifest behind it
    // The op-less tile's "action" is a WORKING /provision deep-link with its primaryType
    // preselected — a real page, never a dead tile. The exact service segment is
    // provisionPathFor's own routing, which may group a type under a different slug than
    // the browse tile (e.g. aws_ec2_client_vpn_endpoint tiles under `client-vpn` but
    // provisions under `vpn`); the invariant is the working link + preselected type.
    const path = provisionPathFor(opLess!.primaryType!);
    expect(path, `${opLess!.service} → ${path}`).toMatch(/^\/provision\/[a-z0-9-]+\?type=/);
    expect(path).toContain(`type=${opLess!.primaryType}`);
    expect(PROVISIONABLE.aws.has(opLess!.primaryType!)).toBe(true);
  });

  it('a concrete op-less azure service (app-security-group) deep-links to /provision', () => {
    const asg = summariesFor('azure').find((s) => s.service === 'app-security-group');
    expect(asg).toBeDefined();
    expect(asg!.operations).toHaveLength(0);
    expect(asg!.primaryType).toBe('azurerm_application_security_group');
    expect(provisionPathFor(asg!.primaryType!)).toBe(
      '/provision/app-security-group?type=azurerm_application_security_group',
    );
    expect(PROVISIONABLE.azure.has(asg!.primaryType!)).toBe(true);
  });
});

/**
 * TEST-7: ServiceCard is a plain, prop-driven leaf component (no useEffect, no
 * data fetch of its own — `summariesFor` above already hands it a fully-derived
 * `ServiceSummary`), so its op-less wiring renders for REAL here via SSR
 * (`react-dom/server`, this repo's only rendering surface — see
 * standalone.test.ts's dependency-allowlist test and TEST-7's own note there
 * for why jsdom/RTL is not simply added). This replaced a source-text
 * assertion (`expect(src).toContain('provisionPathFor(primaryType)')`) that
 * would have kept passing if the branch were renamed to something that quietly
 * stopped linking anywhere — the rendered `href` is the actual behavior; the
 * source string was only ever a proxy for it.
 */
describe('ServiceCard — op-less tile wiring (rendered, not source-pinned)', () => {
  const asg = summariesFor('azure').find((s) => s.service === 'app-security-group')!;

  function render(summary: ServiceSummary): string {
    return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(ServiceCard, { summary })));
  }

  it('an op-less tile links to its /provision deep-link, not a resource console', () => {
    expect(asg.operations).toHaveLength(0); // the precondition this test is actually about
    const html = render(asg);
    expect(html).toContain('href="/provision/app-security-group?type=azurerm_application_security_group"');
    expect(html).not.toContain('href="/services/app-security-group"');
  });

  it('an op-less tile renders the "Provision +" call-to-action, not the risk-mix/resource-count console preview', () => {
    const html = render(asg);
    expect(html).toContain('Provision +');
    expect(html).not.toContain('service-card__count'); // the with-ops branch's resource-count figure
  });

  it('a WITH-ops tile links to its resource console instead, as the control', () => {
    const withOps = summariesFor('aws').find((s) => s.operations.length > 0)!;
    const html = render(withOps);
    expect(html).toContain(`href="/services/${withOps.service}"`);
    expect(html).not.toContain('Provision +');
  });
});

/**
 * TEST-7's OTHER half: ServiceConsole is a top-level ROUTE component whose
 * op-less branch is gated behind its OWN `useEffect`-driven manifest/inventory
 * fetch (`api.listManifests()`/`api.getInventory()`) — under
 * `renderToStaticMarkup`, that effect never fires (SSR does not run effects at
 * all), so `manifests` stays `null` forever and this branch is structurally
 * unreachable no matter what is rendered. There is no pure, prop-driven view
 * to render instead (unlike RequestForm/BulkRequestForm, ServiceConsole has
 * never been split into a `*View` component — see submitFlow.ts's peers for
 * that pattern where it DOES exist). Reaching this branch for real needs
 * either that extraction (a real refactor, not a test change) or jsdom + a
 * mocked fetch + waiting out the effect (the RTL lane TEST-7 recommends
 * introducing, not yet taken — see standalone.test.ts). Source-pinned as a
 * deliberate, named stopgap, not an oversight.
 */
describe('ServiceConsole — op-less service CTA (source-pinned; see the doc comment above)', () => {
  it('renders a known op-less service as a Provision CTA, never a "no service" dead-end', () => {
    const src = readFileSync(join(SRC, 'features/services/ServiceConsole.tsx'), 'utf8');
    // A known named service with no manifest gets the provision CTA branch…
    expect(src).toContain('hasServiceMeta(slug)');
    expect(src).toContain('provisionPathFor(provisionType)');
    // …and only a genuinely unknown slug still falls through to "No service named".
    expect(src).toContain('No service named');
  });
});
