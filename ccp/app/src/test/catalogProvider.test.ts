import { describe, expect, it } from 'vitest';
import type { ManifestOperation, ServiceManifest } from '@/types';
import { deriveServiceCatalog } from '@/lib/catalog';
import { AWS_SERVICES } from '@/lib/awsServiceMap';
import { AZURE_SERVICES } from '@/lib/azureServiceMap';

/**
 * 0039 S1 lane L: manifests are shared across projects of DIFFERING cloud
 * providers, so the catalog must show only the ACTIVE project's provider's
 * services — an aws project must never list azure services and vice versa.
 * deriveServiceCatalog filters by providerOfType(resourceType) vs the caller's
 * `provider` argument (defaults to 'aws', matching every other provider-aware
 * seam added under 0039 — see lib/beyondCatalog.ts's validateBeyondCatalogInput).
 *
 * Catalog derivation now groups OPS by their named service key (portal parity),
 * so an azure op on `azurerm_linux_virtual_machine` surfaces as the 'vm' tile,
 * not its source manifest slug 'azure-compute'. Each fixture manifest therefore
 * carries a representative op per declared type so a service is actually derived.
 *
 * Full-coverage note: once a provider HAS at least one manifest, deriveService-
 * Catalog augments the with-ops summaries with every remaining service in that
 * provider's tile map (op-less Provision-only tiles), so the derived set is the
 * whole provider map — not just the fixture's one op. The invariant these tests
 * pin is therefore "the derived set is EXACTLY this provider's services (the
 * fixture's op-service present, the other provider's never), and never the other
 * cloud's". A provider with zero matching manifests still derives nothing (the
 * "no data loaded" state), which the empty-case tests below keep pinning.
 */

function op(service: string, resourceType: string): ManifestOperation {
  return {
    id: `${service}-op-${resourceType}`,
    service,
    macd: 'Change',
    codemodOp: 'set_attribute',
    title: `Change ${resourceType}`,
    description: `A fixture op targeting ${resourceType}.`,
    target: { resourceType },
    params: [],
    riskFloor: 'LOW',
    reversible: true,
    downtime: 'none',
    exposure: 'l1_self_service',
    forcesReplace: false,
    autoEligible: false,
    terraformCapability: 'fixture',
    group: 'connectivity-access',
  };
}

function manifest(service: string, resourceTypes: string[]): ServiceManifest {
  return {
    service,
    scope: 'estate',
    resourceTypes,
    summary: `${service} summary`,
    operations: resourceTypes.map((rt) => op(service, rt)),
  };
}

const awsManifest = manifest('ec2', ['aws_instance']);
// azurerm_linux_virtual_machine → named service 'vm' (azureServiceMap), the tile
// an azure project actually browses (not the shared manifest slug 'azure-compute').
const azureManifest = manifest('azure-compute', ['azurerm_linux_virtual_machine']);

describe('deriveServiceCatalog — provider filter (0039 S1 lane L)', () => {
  it('defaults to aws: the aws catalog surfaces, an azure-only manifest never does', () => {
    const groups = deriveServiceCatalog([awsManifest, azureManifest]);
    const services = groups.flatMap((g) => g.services.map((s) => s.service));
    // Full coverage: the fixture's ec2 op plus every op-less aws service — but
    // ONLY aws services, and never the azure fixture's 'vm'.
    expect(services).toContain('ec2');
    expect(services).not.toContain('vm');
    expect(services.every((s) => s in AWS_SERVICES)).toBe(true);
  });

  it('an aws project (provider explicitly "aws") hides azure services', () => {
    const groups = deriveServiceCatalog([awsManifest, azureManifest], undefined, 'aws');
    const services = groups.flatMap((g) => g.services.map((s) => s.service));
    expect(services).toContain('ec2');
    expect(services).not.toContain('vm');
    expect(services.every((s) => s in AWS_SERVICES)).toBe(true);
  });

  it('an azure project (provider "azure") shows only azure services, keyed by named service', () => {
    const groups = deriveServiceCatalog([awsManifest, azureManifest], undefined, 'azure');
    const services = groups.flatMap((g) => g.services.map((s) => s.service));
    expect(services).toContain('vm'); // the fixture op's named service
    expect(services).not.toContain('ec2');
    expect(services).not.toContain('azure-compute'); // the manifest slug is not a browsable key
    expect(services.every((s) => s in AZURE_SERVICES)).toBe(true);
  });

  it('an azure project with zero azure manifests renders zero groups (the "no data loaded" state, not the aws catalog)', () => {
    // Full coverage is a property of a LOADED project; with no matching manifests
    // deriveServiceCatalog stays fail-closed (never fabricates the tile map off an
    // empty catalog), so the "data hasn't loaded" branch still holds.
    const groups = deriveServiceCatalog([awsManifest], undefined, 'azure');
    expect(groups).toEqual([]);
  });

  it('a manifest with no resourceTypes matches no provider (fail-closed, never a guess)', () => {
    const empty = manifest('mystery', []);
    expect(deriveServiceCatalog([empty], undefined, 'aws')).toEqual([]);
    expect(deriveServiceCatalog([empty], undefined, 'azure')).toEqual([]);
  });

  it('a well-formed catalog of both providers splits cleanly with no leakage either direction', () => {
    const manifests = [awsManifest, azureManifest];
    const awsServices = deriveServiceCatalog(manifests, undefined, 'aws').flatMap((g) =>
      g.services.map((s) => s.service),
    );
    const azureServices = deriveServiceCatalog(manifests, undefined, 'azure').flatMap((g) =>
      g.services.map((s) => s.service),
    );
    // Each provider derives ONLY its own cloud's services — the fixture op's
    // service present, nothing from the other cloud.
    expect(awsServices).toContain('ec2');
    expect(awsServices.every((s) => s in AWS_SERVICES)).toBe(true);
    expect(awsServices).not.toContain('vm');
    expect(azureServices).toContain('vm');
    expect(azureServices.every((s) => s in AZURE_SERVICES)).toBe(true);
    expect(azureServices).not.toContain('ec2');
  });
});
