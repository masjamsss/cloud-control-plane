import { afterEach, describe, expect, it } from 'vitest';
import type { Inventory, ManifestOperation, ServiceManifest } from '@/types';
import { manifests } from '@/data/manifests';
import { deriveServiceCatalog, deriveFormPlan } from '@/lib/catalog';
import { getOperation, validateParams } from '@/lib/interpreter';
import { resolveActiveProject } from '@/lib/ProjectContext';
import { setProjectScopeForTests } from '@/lib/projectScope';
import { providerOfType, type CloudProvider } from '@/lib/providerDisplay';
import { AWS_SERVICES } from '@/lib/awsServiceMap';
import { AZURE_SERVICES } from '@/lib/azureServiceMap';

/**
 * 0039 S1 lane P: the end-to-end mock-mode proof that the azure catalog
 * surfaces and behaves correctly in the app — not a synthetic 2-manifest
 * fixture (that's lane L's catalogProvider.test.ts) and not a hardcoded
 * provider literal (that's lane C's beyondCatalog.test.ts), but the REAL
 * bundled catalog (`@/data/manifests`, all 46 manifests) filtered through a
 * REAL vendored project fixture (`azure-fixture`, resolved the same way the
 * router resolves any project — see useActiveProjectId.test.ts's docblock).
 *
 * This repo has no jsdom/RTL, so "end to end" here means the same thing it
 * means in interpreter.test.ts and catalogProvider.test.ts: the actual
 * deterministic interpreter/catalog functions, called directly, over real
 * loaded data — no DOM, no render, no model.
 */

afterEach(() => {
  setProjectScopeForTests('sample');
});

const azureManifests: ServiceManifest[] = manifests.filter((m) => m.service.startsWith('azure-'));
const azureOps: ManifestOperation[] = azureManifests.flatMap((m) => m.operations);

/** The service catalog visible to `provider`, over the REAL bundled manifests. */
function catalogServicesFor(provider: CloudProvider): string[] {
  return deriveServiceCatalog(manifests, undefined, provider)
    .flatMap((g) => g.services.map((s) => s.service))
    .sort();
}

describe('1. catalog surfaces azure for an azure project, hides it for aws (0039 S1 lane P)', () => {
  it('the bundled catalog ships exactly the 16 azure-* manifests today', () => {
    expect(azureManifests.map((m) => m.service).sort()).toEqual([
      'azure-ai',
      'azure-analytics',
      'azure-compute',
      'azure-connectivity',
      'azure-containers',
      'azure-core',
      'azure-database',
      'azure-governance',
      'azure-integration',
      'azure-iot',
      'azure-keyvault',
      'azure-monitoring',
      'azure-network',
      'azure-other',
      'azure-storage',
      'azure-web',
    ]);
    expect(manifests.length).toBe(114); // 79 aws + 16 azure — pins the split this lane relies on
  });

  it('the azure-fixture project (a REAL vendored project.json, provider "azure") sees all 155 NAMED azure services and none of the aws services', () => {
    // resolveActiveProject is the exact seam ProjectProvider/router use to
    // resolve a route's :projectId AND set the ambient scope — the same
    // pure, no-DOM test seam useActiveProjectId.test.ts and
    // azureProjectFixture.test.tsx use to "set/inject the active project".
    const project = resolveActiveProject('azure-fixture');
    expect(project.provider).toBe('azure');

    // Full coverage: the 16 shared azure manifests fan out into their with-ops
    // named services, and every op-less azure service in the tile map browses
    // too — 155 in total (deriveServiceCatalog augments the with-ops summaries
    // with the rest of the provider's tile map).
    const services = catalogServicesFor(project.provider ?? 'aws');
    expect(services).toHaveLength(155);
    expect(services).toContain('vm');
    expect(services).toContain('sql');
    expect(services).toContain('storage-account');

    // The raw azure-* manifest slugs are no longer browsable keys…
    for (const manifestSlug of azureManifests.map((m) => m.service)) {
      expect(services, manifestSlug).not.toContain(manifestSlug);
    }
    // …and none of the 30 aws services leak through under the azure project.
    for (const awsService of ['ec2', 's3', 'security-groups', 'iam', 'rds']) {
      expect(services).not.toContain(awsService);
    }
  });

  it('the sample project (the bundled default, no provider field ⇒ aws) sees the aws catalog and none of the azure services', () => {
    const project = resolveActiveProject('sample');
    expect(project.provider).toBeUndefined(); // absence means aws — the documented wire convention

    // Full coverage: the 57 shared aws manifests fan out into their with-ops
    // named services, plus every op-less aws service in the tile map — 154 in
    // total, exactly as the 16 azure manifests fan into 155.
    const services = catalogServicesFor(project.provider ?? 'aws');
    expect(services).toHaveLength(156);
    expect(services).toContain('ec2');
    expect(services).toContain('s3');
    expect(services).toContain('athena'); // a long-tail service, keyed off its manifest's op

    for (const azureService of azureManifests.map((m) => m.service)) {
      expect(services).not.toContain(azureService);
    }
  });

  it('the same shared manifest array splits cleanly per active project — no leakage either direction', () => {
    const azureProject = resolveActiveProject('azure-fixture');
    const azureServices = catalogServicesFor(azureProject.provider ?? 'aws');
    const sampleProject = resolveActiveProject('sample');
    const awsServices = catalogServicesFor(sampleProject.provider ?? 'aws');

    // Provider integrity — the REAL "no leakage" invariant: every service the
    // aws view derives is an aws named service, every one the azure view derives
    // is an azure named service. No aws-manifest op ever surfaces under azure or
    // vice versa (deriveServiceCatalog filters by provider).
    for (const s of awsServices) expect(s in AWS_SERVICES, `${s} not an aws service`).toBe(true);
    for (const s of azureServices)
      expect(s in AZURE_SERVICES, `${s} not an azure service`).toBe(true);
    // The two sets share exactly four SLUG STRINGS — services both clouds name
    // (aws Batch/DMS/Cloud WAN/Resource Groups vs their azure namesakes: Batch,
    // Database Migration, Virtual Network Manager, Resource Groups). That is a
    // display-name coincidence, not a manifest leak: each is derived solely from
    // its own provider's manifests, and getServiceMeta(slug, provider) resolves
    // each to its own cloud's identity. Anything else here would be a real leak.
    const overlap = azureServices.filter((s) => awsServices.includes(s)).sort();
    expect(overlap).toEqual(['batch', 'dms', 'network-manager', 'resource-groups']);
    // Both providers browse at full provisionable coverage — aws fans its 57
    // manifests into 154 console services, azure its 16 into 155 portal services
    // — so the two provider views sum to 154 + 155, well past the 73 manifest
    // count.
    expect(awsServices).toHaveLength(156);
    expect(azureServices).toHaveLength(155);
    expect(azureServices.length + awsServices.length).toBe(311);
  });
});

describe('2. a representative op resolves + validates: azure-compute VM resize (0039 S1 lane P)', () => {
  const op = getOperation('azure-compute-linux-vm-resize', manifests)!;

  const inventory: Inventory = {
    generatedAt: null,
    resources: [
      {
        address: 'azurerm_linux_virtual_machine.web01',
        resourceType: 'azurerm_linux_virtual_machine',
        name: 'web01',
        service: 'azure-compute',
        attributes: { size: 'Standard_B2s' },
      },
    ],
  };

  it('resolves from the real bundled manifests and targets the right resource type', () => {
    expect(op).toBeDefined();
    expect(op.target.resourceType).toBe('azurerm_linux_virtual_machine');
    expect(op.exposure).toBe('l1_with_guardrails');
  });

  it('deriveFormPlan lays it out into a target section (the VM picker) and a change section (the new size)', () => {
    const plan = deriveFormPlan(op);
    expect(plan.sections.map((s) => s.id)).toEqual(['target', 'change']);
    expect(plan.sections[0]!.fields.map((f) => f.name)).toEqual(['virtual_machine']);
    expect(plan.sections[1]!.fields.map((f) => f.name)).toEqual(['size']);
    expect(plan.submitLabel).toBe('Request change');
    expect(plan.needsAck).toBe(true); // HIGH riskFloor / guardrailed op
    expect(plan.warnings).toEqual(['Causes deallocate and restart downtime.']);
  });

  it('validateParams accepts an allowlisted size', () => {
    const res = validateParams(
      op,
      { virtual_machine: 'azurerm_linux_virtual_machine.web01', size: 'Standard_D2s_v5' },
      inventory,
    );
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual({});
  });

  it('validateParams REJECTS a size outside the allowlist', () => {
    const res = validateParams(
      op,
      { virtual_machine: 'azurerm_linux_virtual_machine.web01', size: 'Standard_ZZZ_not_real' },
      inventory,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.size).toBeTruthy();
    expect(res.errors.virtual_machine).toBeUndefined();
  });
});

describe('3. provider-typed correctness — every azure op targets an azurerm_* resource type (0039 S1 lane P)', () => {
  it('all 388 ops across the 16 azure manifests target azurerm_* (no cross-provider leakage)', () => {
    expect(azureOps.length).toBe(388);
    const offenders = azureOps.filter((op) => !op.target.resourceType.startsWith('azurerm_'));
    expect(offenders.map((op) => `${op.id} -> ${op.target.resourceType}`)).toEqual([]);
  });

  it('agrees with the shared provider-display seam (providerOfType) for every azure op', () => {
    const offenders = azureOps.filter((op) => providerOfType(op.target.resourceType) !== 'azure');
    expect(offenders).toEqual([]);
  });

  it('every azure manifest declares only azurerm_* resourceTypes (the manifest-level half of the same guarantee)', () => {
    for (const m of azureManifests) {
      expect(m.resourceTypes.length).toBeGreaterThan(0);
      for (const rt of m.resourceTypes) {
        expect(rt.startsWith('azurerm_')).toBe(true);
      }
    }
  });
});

describe('4. NSG absent / CAF governance engineer-gated (0039 S1 lane P; lane-lz-caf wires the platform landing zone)', () => {
  // Network micro-segmentation (NSG rule/group) stays ABSENT on both providers —
  // it is guarded by the R7-azure plan-check belt, not a catalog form.
  const ABSENT_RESOURCE_TYPES = ['azurerm_network_security_rule', 'azurerm_network_security_group'];

  it('no catalogued azure op targets a network-security-rule or NSG resource (still absent)', () => {
    for (const absent of ABSENT_RESOURCE_TYPES) {
      const hit = azureOps.find((op) => op.target.resourceType === absent);
      expect(hit, `unexpectedly catalogued: ${absent}`).toBeUndefined();
    }
  });

  it('no azure manifest declares an NSG rule/group resource type', () => {
    const allDeclaredTypes = new Set(azureManifests.flatMap((m) => m.resourceTypes));
    for (const absent of ABSENT_RESOURCE_TYPES) {
      expect(allDeclaredTypes.has(absent)).toBe(false);
    }
  });

  // Governance/RBAC/policy constructs ARE now catalogued (azure-governance,
  // lane-lz-caf) so an imported subscription's platform landing zone is
  // recognized and routed — never blind self-service. The wired boundary is
  // STRONGER than the old "surface absent": every op that touches a role
  // assignment/definition or ANY policy resource is exposure engineer_only.
  it('every op targeting a role assignment/definition is engineer_only', () => {
    const roleTypes = new Set(['azurerm_role_assignment', 'azurerm_role_definition']);
    const offenders = azureOps
      .filter((op) => roleTypes.has(op.target.resourceType) && op.exposure !== 'engineer_only')
      .map((op) => `${op.id} -> ${op.target.resourceType} (${op.exposure})`);
    expect(offenders).toEqual([]);
  });

  it('every op targeting a policy resource type is engineer_only', () => {
    const offenders = azureOps
      .filter((op) => /policy/i.test(op.target.resourceType) && op.exposure !== 'engineer_only')
      .map((op) => `${op.id} -> ${op.target.resourceType} (${op.exposure})`);
    expect(offenders).toEqual([]);
  });

  it('the whole azure-governance service is engineer_only (no self-service governance op)', () => {
    const gov = azureManifests.find((m) => m.service === 'azure-governance')!;
    expect(gov.operations.length).toBeGreaterThan(0);
    for (const op of gov.operations) {
      expect(op.exposure, op.id).toBe('engineer_only');
    }
  });
});
