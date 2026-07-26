import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpApiClient, ServerProject } from '@/lib/httpApi';
import type { ManifestOperation, ServiceManifest } from '@/types';
import {
  listLocalProjects,
  registerLocalProject,
  resetLocalProjectsForTests,
} from '@/lib/projectOnboarding';
import {
  activateProjectDataVia,
  deregisterProjectVia,
  loadServerProjectsVia,
  mintUploadTokenVia,
  projectCloudLabel,
  projectIdentityRows,
  proposeTrustVia,
  registerProjectVia,
  uploadTrustRequestVia,
} from '@/features/admin/projectsFlow';
import {
  isCloudResourceId,
  providerOfType,
  RESOURCE_TYPE_PATTERNS,
  stripProviderPrefix,
} from '@/lib/providerDisplay';
import { deriveServiceCatalog } from '@/lib/catalog';
import { scanMixedProviderManifest } from '../../scripts/verify-manifest-safety';

/**
 * 0034 G1 — GCP project onboarding through the SAME provider-discriminated
 * registry the azure seam built (0039 S1): a gcp project carries
 * `provider:'gcp'` + gcpProjectId/gcpRegion IN PLACE OF accountId/region, and
 * walks the SAME fail-closed ladder (draft → pending-trust → trusted → ready).
 * This suite mirrors azureOnboarding.test.ts — the aws and azure paths are
 * proven unchanged in their own suites and stay green. It also pins the seam's
 * FAIL-CLOSED reading everywhere a gcp project touches catalog surfaces: with
 * zero gcp manifests and no gcp tile map, a gcp project derives an EMPTY
 * catalog — never another cloud's.
 */

const GCP_REGISTER = {
  id: 'exampleco',
  name: 'Example GCP estate',
  provider: 'gcp' as const,
  github: { owner: 'exampleco', repo: 'terraform-exampleco' },
  gcpProjectId: 'example-prod-app',
  gcpRegion: 'us-central1',
};

const GCP_CLEAN_REPORT_TEXT = JSON.stringify({
  repo: 'terraform-exampleco',
  verdict: 'clean',
  findings: [],
  resourceBlocks: 8,
  moduleBlocks: 0,
  tfJsonFiles: 0,
  fmtDirtyFiles: 0,
  providerPins: { google: '~> 6.0' },
});

const COMMIT = 'abc123def4567890abc123def4567890abc123de';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `NEVER` client proves the demo branch never touches the server when not
 * authoritative — the same guard the aws and azure suites use. */
const NEVER: HttpApiClient = new Proxy({} as HttpApiClient, {
  get: () => () => {
    throw new Error('server must not be called when not authoritative');
  },
});

beforeEach(() => {
  resetLocalProjectsForTests();
});

describe('the ladder, end to end — a GCP project reaches ready', () => {
  it('walks register → upload → trust → activate to ready, and provider:gcp persists the whole way', async () => {
    const draft = await registerProjectVia(false, NEVER, GCP_REGISTER);
    expect(draft.status).toBe('draft');
    expect(draft.provider).toBe('gcp');
    // The gcp identity pair is stored; the aws and azure identities are
    // structurally absent — never keys set to undefined.
    expect(draft).toMatchObject({
      gcpProjectId: 'example-prod-app',
      gcpRegion: 'us-central1',
    });
    expect('accountId' in draft).toBe(false);
    expect('region' in draft).toBe(false);
    expect('subscriptionId' in draft).toBe(false);
    expect('location' in draft).toBe(false);
    expect((await loadServerProjectsVia(false, NEVER)).map((p) => p.id)).toEqual(['exampleco']);

    const prescanSha256 = await sha256Hex(GCP_CLEAN_REPORT_TEXT);
    const uploaded = await uploadTrustRequestVia(false, NEVER, 'exampleco', {
      trustRequest: { repo: 'terraform-exampleco', commitSha: COMMIT, prescanSha256 },
      prescanReport: GCP_CLEAN_REPORT_TEXT,
    });
    expect(uploaded.status).toBe('pending-trust');
    expect(uploaded.provider).toBe('gcp');
    expect(uploaded.trustRequest?.report.verdict).toBe('clean');

    const trustOutcome = await proposeTrustVia(false, NEVER, 'exampleco', {
      commitSha: COMMIT,
      prescanSha256,
    });
    expect(trustOutcome).toEqual({ applied: true });
    expect(listLocalProjects()[0]?.status).toBe('trusted');

    await mintUploadTokenVia(false, NEVER, 'exampleco');
    expect(await activateProjectDataVia(false, NEVER, 'exampleco', 1)).toEqual({ applied: true });

    const ready = listLocalProjects()[0]!;
    expect(ready.status).toBe('ready');
    expect(ready.provider).toBe('gcp');
    if (ready.provider !== 'gcp') throw new Error('narrow');
    expect(ready.gcpProjectId).toBe('example-prod-app');
    expect(ready.gcpRegion).toBe('us-central1');
    expect(ready.artifacts?.inventorySha256).toMatch(/^[a-f0-9]{64}$/);

    expect(await deregisterProjectVia(false, NEVER, 'exampleco')).toEqual({ applied: true });
    expect(listLocalProjects()).toEqual([]);
  });
});

describe('register — the gcp identity shape rules, locally enforced', () => {
  it('refuses a malformed project id and a malformed region', () => {
    expect(() =>
      registerLocalProject({ ...GCP_REGISTER, id: 'g1', gcpProjectId: 'Bad-Case' }),
    ).toThrow('GCP project id');
    expect(() => registerLocalProject({ ...GCP_REGISTER, id: 'g2', gcpProjectId: 'ab' })).toThrow(
      'GCP project id',
    );
    expect(() =>
      registerLocalProject({ ...GCP_REGISTER, id: 'g3', gcpRegion: 'us-central1-a' }),
    ).toThrow('GCP region');
  });

  it('persists provider:gcp and the identity pair, and never writes aws or azure fields', () => {
    const created = registerLocalProject(GCP_REGISTER);
    expect(created.provider).toBe('gcp');
    expect(created).toMatchObject({ gcpProjectId: 'example-prod-app', gcpRegion: 'us-central1' });
    for (const key of ['accountId', 'region', 'subscriptionId', 'tenantId', 'location']) {
      expect(key in created, key).toBe(false);
    }
  });
});

describe('display — a gcp project renders its own cloud, never another', () => {
  const gcpProject = registerShape();
  function registerShape(): ServerProject {
    return {
      id: 'exampleco',
      name: 'Example GCP estate',
      repo: { host: 'github', owner: 'exampleco', name: 'terraform-exampleco' },
      provider: 'gcp',
      gcpProjectId: 'example-prod-app',
      gcpRegion: 'us-central1',
      status: 'draft',
    } as ServerProject;
  }

  it('projectCloudLabel says GCP', () => {
    expect(projectCloudLabel(gcpProject)).toBe('GCP');
    expect(projectCloudLabel({ provider: 'azure' })).toBe('Azure');
    expect(projectCloudLabel({})).toBe('AWS');
  });

  it('projectIdentityRows renders Project + Region', () => {
    expect(projectIdentityRows(gcpProject)).toEqual([
      { label: 'Project', value: 'example-prod-app', mono: true },
      { label: 'Region', value: 'us-central1' },
    ]);
  });
});

describe('provider display seam — google_* resolves to gcp, fail-closed elsewhere', () => {
  it('providerOfType classifies google_* as gcp (never aws)', () => {
    expect(providerOfType('google_storage_bucket')).toBe('gcp');
    expect(providerOfType('google_compute_firewall')).toBe('gcp');
    // the incumbent classifications are byte-identical
    expect(providerOfType('aws_instance')).toBe('aws');
    expect(providerOfType('azurerm_storage_account')).toBe('azure');
  });

  it('stripProviderPrefix and RESOURCE_TYPE_PATTERNS know google_*', () => {
    expect(stripProviderPrefix('google_storage_bucket')).toBe('storage_bucket');
    expect(RESOURCE_TYPE_PATTERNS.gcp.test('google_storage_bucket')).toBe(true);
    expect(RESOURCE_TYPE_PATTERNS.gcp.test('aws_instance')).toBe(false);
  });

  it('isCloudResourceId recognizes GCP resource names', () => {
    expect(isCloudResourceId('projects/example-prod-app/zones/us-central1-a/disks/d1')).toBe(true);
    expect(isCloudResourceId('//compute.googleapis.com/projects/p/zones/z/instances/i')).toBe(true);
    expect(isCloudResourceId('arn:aws:s3:::bucket')).toBe(true);
    expect(isCloudResourceId('plain-name')).toBe(false);
  });
});

describe('fail-closed catalog — a gcp project offers ZERO operations today', () => {
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
      exposure: 'l1_self_service',
      forcesReplace: false,
      terraformCapability: '~ update',
    } as unknown as ManifestOperation;
  }
  const awsManifest = {
    service: 'ec2',
    scope: 'estate',
    resourceTypes: ['aws_instance'],
    summary: 'fixture',
    operations: [op('ec2', 'aws_instance')],
  } as unknown as ServiceManifest;

  it('deriveServiceCatalog with provider gcp over aws manifests derives NOTHING — never the aws catalog', () => {
    expect(deriveServiceCatalog([awsManifest], undefined, 'gcp')).toEqual([]);
  });

  it('the single-provider manifest gate names gcp in a mixed manifest', () => {
    const mixed = scanMixedProviderManifest('bad.json', ['aws_instance', 'google_storage_bucket']);
    expect(mixed?.providers.sort()).toEqual(['aws', 'gcp']);
    expect(scanMixedProviderManifest('ok.json', ['google_storage_bucket'])).toBeNull();
  });
});
