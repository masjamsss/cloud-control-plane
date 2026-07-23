import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpApiClient, ServerProject } from '@/lib/httpApi';
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
  proposeTrustVia,
  registerProjectVia,
  uploadTrustRequestVia,
} from '@/features/admin/projectsFlow';
import { projectCloudLabel, projectIdentityRows } from '@/features/admin/projectsFlow';

/**
 * 0039 S1 — restoring AZURE subscription onboarding onto main's per-account
 * data-plane. The registry is now PROVIDER-DISCRIMINATED: an azure project
 * carries `provider:'azure'` + subscription/tenant/location IN PLACE OF the aws
 * accountId/region, and walks the SAME fail-closed ladder (draft →
 * pending-trust → trusted → ready) through the SAME store/activation flow. This
 * suite mirrors the aws end-to-end in projectOnboarding.test.ts — the aws path
 * itself is proven unchanged there and stays green.
 */

const AZURE_REGISTER = {
  id: 'contoso',
  name: 'Contoso Azure estate',
  provider: 'azure' as const,
  github: { owner: 'contoso', repo: 'terraform-contoso' },
  subscriptionId: '11111111-2222-3333-4444-555555555555',
  tenantId: '66666666-7777-8888-9999-000000000000',
  location: 'southeastasia',
};

const AZURE_CLEAN_REPORT_TEXT = JSON.stringify({
  repo: 'terraform-contoso',
  verdict: 'clean',
  findings: [],
  resourceBlocks: 8,
  moduleBlocks: 0,
  tfJsonFiles: 0,
  fmtDirtyFiles: 0,
  providerPins: { azurerm: '~> 4.0' },
});

const COMMIT = 'abc123def4567890abc123def4567890abc123de';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `NEVER` client proves the demo branch never touches the server when not
 * authoritative — the same guard the aws suite uses. */
const NEVER: HttpApiClient = new Proxy({} as HttpApiClient, {
  get: () => () => {
    throw new Error('server must not be called when not authoritative');
  },
});

beforeEach(() => {
  resetLocalProjectsForTests();
});

describe('the ladder, end to end — an AZURE subscription reaches ready', () => {
  it('walks register → upload → trust → activate to ready, and provider:azure persists the whole way', async () => {
    const draft = await registerProjectVia(false, NEVER, AZURE_REGISTER);
    expect(draft.status).toBe('draft');
    expect(draft.provider).toBe('azure');
    // The azure identity triple is stored; the aws identity is structurally absent.
    expect(draft).toMatchObject({
      subscriptionId: AZURE_REGISTER.subscriptionId,
      tenantId: AZURE_REGISTER.tenantId,
      location: 'southeastasia',
    });
    expect('accountId' in draft).toBe(false);
    expect('region' in draft).toBe(false);
    expect((await loadServerProjectsVia(false, NEVER)).map((p) => p.id)).toEqual(['contoso']);

    const prescanSha256 = await sha256Hex(AZURE_CLEAN_REPORT_TEXT);
    const uploaded = await uploadTrustRequestVia(false, NEVER, 'contoso', {
      trustRequest: { repo: 'terraform-contoso', commitSha: COMMIT, prescanSha256 },
      prescanReport: AZURE_CLEAN_REPORT_TEXT,
    });
    expect(uploaded.status).toBe('pending-trust');
    expect(uploaded.provider).toBe('azure');
    expect(uploaded.trustRequest?.report.verdict).toBe('clean');

    const trustOutcome = await proposeTrustVia(false, NEVER, 'contoso', { commitSha: COMMIT, prescanSha256 });
    expect(trustOutcome).toEqual({ applied: true });
    expect(listLocalProjects()[0]?.status).toBe('trusted');

    // Go-live rides the SAME data lane as aws: mint stages the demo's sample v1,
    // and the FIRST activation flips the trusted project ready with artifacts.
    await mintUploadTokenVia(false, NEVER, 'contoso');
    expect(await activateProjectDataVia(false, NEVER, 'contoso', 1)).toEqual({ applied: true });

    const ready = listLocalProjects()[0]!;
    expect(ready.status).toBe('ready');
    expect(ready.provider).toBe('azure');
    if (ready.provider !== 'azure') throw new Error('narrow');
    expect(ready.subscriptionId).toBe(AZURE_REGISTER.subscriptionId);
    expect(ready.tenantId).toBe(AZURE_REGISTER.tenantId);
    expect(ready.location).toBe('southeastasia');
    expect(ready.artifacts?.inventorySha256).toMatch(/^[a-f0-9]{64}$/);

    expect(await deregisterProjectVia(false, NEVER, 'contoso')).toEqual({ applied: true });
    expect(listLocalProjects()).toEqual([]);
  });
});

describe('register — the azure identity shape rules, locally enforced', () => {
  it('refuses a bad subscription GUID, a bad tenant GUID, and a malformed location', () => {
    expect(() =>
      registerLocalProject({ ...AZURE_REGISTER, id: 'a1', subscriptionId: 'not-a-guid' }),
    ).toThrow('subscription id must be a GUID');
    expect(() => registerLocalProject({ ...AZURE_REGISTER, id: 'a2', tenantId: 'nope' })).toThrow(
      'tenant id must be a GUID',
    );
    expect(() =>
      registerLocalProject({ ...AZURE_REGISTER, id: 'a3', location: 'Mars Base 1' }),
    ).toThrow('Azure location');
  });

  it('persists provider:azure and the identity triple, and never writes aws fields', () => {
    const created = registerLocalProject(AZURE_REGISTER);
    expect(created.provider).toBe('azure');
    if (created.provider !== 'azure') throw new Error('narrow');
    expect(created.subscriptionId).toBe(AZURE_REGISTER.subscriptionId);
    expect(created.tenantId).toBe(AZURE_REGISTER.tenantId);
    expect(created.location).toBe('southeastasia');
    // No aws identity leaks onto an azure row.
    expect('accountId' in created).toBe(false);
    expect('region' in created).toBe(false);
  });

  it('an authoritative build routes the azure register verbatim to the client', async () => {
    const calls: string[] = [];
    const remote = { ...AZURE_REGISTER, status: 'draft' } as unknown as ServerProject;
    const client = {
      registerProject: async (input: unknown) => {
        calls.push('register');
        expect(input).toMatchObject({ provider: 'azure', subscriptionId: AZURE_REGISTER.subscriptionId });
        return remote;
      },
    } as unknown as HttpApiClient;
    const created = await registerProjectVia(true, client, AZURE_REGISTER);
    expect(created.provider).toBe('azure');
    expect(calls).toEqual(['register']);
    // The local store is never touched on the authoritative path.
    expect(listLocalProjects()).toEqual([]);
  });
});

describe('the registry card helpers render the right cloud identity', () => {
  it('an azure project shows Subscription/Tenant/Location; an aws project shows Account/Region', () => {
    const azure = registerLocalProject(AZURE_REGISTER);
    expect(projectCloudLabel(azure)).toBe('Azure');
    expect(projectIdentityRows(azure)).toEqual([
      { label: 'Subscription', value: AZURE_REGISTER.subscriptionId, mono: true },
      { label: 'Tenant', value: AZURE_REGISTER.tenantId, mono: true },
      { label: 'Location', value: 'southeastasia' },
    ]);

    const aws = registerLocalProject({
      id: 'acme',
      name: 'Acme estate',
      github: { owner: 'acme-co', repo: 'terraform-acme' },
      accountId: '123456789012',
      region: 'ap-southeast-1',
    });
    expect(projectCloudLabel(aws)).toBe('AWS');
    expect(projectIdentityRows(aws)).toEqual([
      { label: 'Account', value: '123456789012', mono: true },
      { label: 'Region', value: 'ap-southeast-1' },
    ]);
  });
});
