import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { getTeams } from '@/lib/teams';
import { CATEGORY_ORDER, getServiceMeta, hasServiceMeta } from '@/lib/serviceMeta';
import { AZURE_SERVICES } from '@/lib/azureServiceMap';
import { AWS_SERVICES } from '@/lib/awsServiceMap';
import { providerOfType } from '@/lib/providerDisplay';

/**
 * Service-coverage guardrails. These are what make "manage all of them" safe as
 * the catalog grows: onboard a service by adding a manifest + a team + (ideally)
 * metadata, and this suite fails loudly if any of the three drift apart.
 */

const services = manifests.map((m) => m.service);
const assigned = new Set(getTeams().flatMap((t) => t.serviceSlugs));

/**
 * The BROWSABLE service keys — what a requester actually sees as tiles and must
 * be able to own/request. BOTH providers browse at FULL provisionable coverage,
 * so the keys are the NAMED services — the 156 aws (awsServiceMap.ts) and 155
 * azure (azureServiceMap.ts), each covering every with-ops service AND every
 * op-less Provision-only one — NOT the shared manifest slugs (the 79 aws + 16
 * azure manifests fan their ops out into those named services via
 * catalogServiceKey). Team ownership and metadata are checked against these keys,
 * not the manifests.
 */
const awsNamedServices = Object.keys(AWS_SERVICES);
const azureNamedServices = Object.keys(AZURE_SERVICES);
const browsableServices = [...awsNamedServices, ...azureNamedServices];
const browsableSet = new Set(browsableServices);

describe('every manifest is well-formed', () => {
  it('has a unique, non-empty service slug', () => {
    expect(new Set(services).size).toBe(services.length);
    for (const s of services) expect(s).toMatch(/^[a-z0-9-]+$/);
  });
  it('exposes at least one operation and declares its resource types', () => {
    for (const m of manifests) {
      expect(m.operations.length, `${m.service} has no operations`).toBeGreaterThan(0);
      expect(m.resourceTypes.length, `${m.service} declares no resourceTypes`).toBeGreaterThan(0);
    }
  });
});

describe('every operation is well-formed and safely bounded', () => {
  const allOps = manifests.flatMap((m) => m.operations);

  it('has globally-unique operation ids', () => {
    const ids = allOps.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each op matches its manifest service and targets a declared resource type', () => {
    for (const m of manifests) {
      for (const op of m.operations) {
        expect(op.service, op.id).toBe(m.service);
        expect(m.resourceTypes, `${op.id} targets ${op.target.resourceType}`).toContain(
          op.target.resourceType,
        );
      }
    }
  });

  it('every op carries the fields the interpreter and UI rely on', () => {
    const RISK = ['LOW', 'MEDIUM', 'HIGH'];
    const EXPOSURE = ['l1_self_service', 'l1_with_guardrails', 'engineer_only'];
    for (const op of allOps) {
      expect(RISK, op.id).toContain(op.riskFloor);
      expect(EXPOSURE, op.id).toContain(op.exposure);
      expect(op.params.length, `${op.id} has no params`).toBeGreaterThan(0);
      for (const p of op.params) {
        expect(p.name, op.id).toBeTruthy();
        expect(p.label, op.id).toBeTruthy();
      }
    }
  });
});

describe('no drift between browsable services, teams, and metadata', () => {
  it('every browsable service (156 named aws + 155 named azure) is owned by a team (else requesters are locked out)', () => {
    const orphans = browsableServices.filter((s) => !assigned.has(s));
    expect(orphans, `services with no team: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every team service slug is a browsable service (else its tile is empty)', () => {
    const dangling = [...assigned].filter((s) => !browsableSet.has(s));
    expect(dangling, `team slugs with no browsable service: ${dangling.join(', ')}`).toEqual([]);
  });

  it('every browsable service has polished metadata', () => {
    const missing = browsableServices.filter((s) => !hasServiceMeta(s));
    expect(missing, `services falling back to title-case meta: ${missing.join(', ')}`).toEqual([]);
  });

  it('every browsable service resolves a valid category', () => {
    for (const s of browsableServices) {
      expect(CATEGORY_ORDER, s).toContain(getServiceMeta(s).category);
    }
  });
});

describe('azure browses at full provisionable coverage (155 named services)', () => {
  it('names exactly 155 azure services, each with serviceMeta and a team', () => {
    expect(azureNamedServices).toHaveLength(155);
    const assignedSet = assigned;
    for (const s of azureNamedServices) {
      expect(hasServiceMeta(s), `${s} has no serviceMeta`).toBe(true);
      expect(assignedSet.has(s), `${s} is owned by no team`).toBe(true);
      expect(CATEGORY_ORDER, `${s} category`).toContain(getServiceMeta(s).category);
    }
  });

  it('the 16 azure-* manifest slugs are NOT browsable service keys anymore (ops fan out into named services)', () => {
    const azureManifestSlugs = manifests
      .filter((m) => m.resourceTypes.length > 0 && providerOfType(m.resourceTypes[0]!) === 'azure')
      .map((m) => m.service);
    expect(azureManifestSlugs.length).toBeGreaterThan(0);
    for (const slug of azureManifestSlugs) {
      expect(browsableSet.has(slug), `${slug} should not be a browsable key`).toBe(false);
    }
  });
});

describe('aws browses at full provisionable coverage (156 named services)', () => {
  it('names exactly 156 aws services, each with serviceMeta and a team', () => {
    expect(awsNamedServices).toHaveLength(156);
    for (const s of awsNamedServices) {
      expect(hasServiceMeta(s), `${s} has no serviceMeta`).toBe(true);
      expect(assigned.has(s), `${s} is owned by no team`).toBe(true);
      expect(CATEGORY_ORDER, `${s} category`).toContain(getServiceMeta(s).category);
    }
  });

  it('the 17 aws-* family manifest slugs are NOT browsable service keys (their ops fan out into named services)', () => {
    const awsFamilySlugs = manifests
      .filter(
        (m) =>
          m.service.startsWith('aws-') &&
          m.resourceTypes.length > 0 &&
          providerOfType(m.resourceTypes[0]!) === 'aws',
      )
      .map((m) => m.service);
    expect(awsFamilySlugs).toHaveLength(17);
    for (const slug of awsFamilySlugs) {
      expect(browsableSet.has(slug), `${slug} should not be a browsable key`).toBe(false);
    }
  });

  it('the 81 curated aws manifest slugs ARE named services (they double as their own tile)', () => {
    const curatedAwsSlugs = manifests
      .filter(
        (m) =>
          !m.service.startsWith('aws-') &&
          m.resourceTypes.length > 0 &&
          providerOfType(m.resourceTypes[0]!) === 'aws',
      )
      .map((m) => m.service);
    expect(curatedAwsSlugs).toHaveLength(81);
    for (const slug of curatedAwsSlugs) {
      expect(browsableSet.has(slug), `${slug} should be a browsable key`).toBe(true);
    }
  });
});
