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

/**
 * The demo registry behind Admin → Projects (nothing greyed in demo):
 * lib/projectOnboarding walks ccp-api's whole onboarding ladder against
 * this browser's own store, with the same fail-closed rules — forward-only
 * statuses, the sha-256 binding between report bytes and trust request, and
 * the never-trust-a-reject verdict. The *Via wrappers route to it whenever
 * the server does not serve the projects flow, so the wizard works end to end
 * without a backend. The one deliberate demo divergence — trust/activate/
 * deregister apply immediately instead of waiting for a second admin — is
 * pinned here too.
 */

const REGISTER = {
  id: 'acme',
  name: 'Acme estate',
  github: { owner: 'acme-co', repo: 'terraform-acme' },
  accountId: '123456789012',
  region: 'ap-southeast-1',
};

const CLEAN_REPORT_TEXT = JSON.stringify({
  repo: 'terraform-acme',
  verdict: 'clean',
  findings: [],
  resourceBlocks: 12,
  moduleBlocks: 1,
  tfJsonFiles: 0,
  fmtDirtyFiles: 2,
  providerPins: { aws: '~> 6.0' },
});

const REJECT_REPORT_TEXT = JSON.stringify({
  repo: 'terraform-acme',
  verdict: 'reject',
  findings: [{ code: 'PROVISIONER', file: 'main.tf', line: 12 }],
  resourceBlocks: 12,
  moduleBlocks: 1,
  tfJsonFiles: 0,
  fmtDirtyFiles: 2,
  providerPins: { aws: '~> 6.0' },
});

const COMMIT = 'abc123def4567890abc123def4567890abc123de';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function uploadClean(id = 'acme'): Promise<ServerProject> {
  const prescanSha256 = await sha256Hex(CLEAN_REPORT_TEXT);
  return uploadTrustRequestVia(false, null, id, {
    trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256 },
    prescanReport: CLEAN_REPORT_TEXT,
  });
}

const NEVER: HttpApiClient = new Proxy({} as HttpApiClient, {
  get: () => () => {
    throw new Error('server must not be called when not authoritative');
  },
});

beforeEach(() => {
  resetLocalProjectsForTests();
});

describe('the ladder, end to end (draft → pending-trust → trusted → ready)', () => {
  it('walks every step against the local registry, with the demo immediate-apply for trust/deregister', async () => {
    const draft = await registerProjectVia(false, NEVER, REGISTER);
    expect(draft.status).toBe('draft');
    expect((await loadServerProjectsVia(false, NEVER)).map((p) => p.id)).toEqual(['acme']);

    const uploaded = await uploadClean();
    expect(uploaded.status).toBe('pending-trust');
    expect(uploaded.trustRequest?.report.verdict).toBe('clean');
    expect(uploaded.trustRequest?.commitSha).toBe(COMMIT);

    const prescanSha256 = await sha256Hex(CLEAN_REPORT_TEXT);
    const trustOutcome = await proposeTrustVia(false, NEVER, 'acme', {
      commitSha: COMMIT,
      prescanSha256,
    });
    // Demo divergence, pinned: the two-admin envelope is server-only.
    expect(trustOutcome).toEqual({ applied: true });
    expect(listLocalProjects()[0]?.status).toBe('trusted');
    expect(listLocalProjects()[0]?.trust?.commitSha).toBe(COMMIT);

    // Go-live rides the data lane: minting a key stages the demo's sample v1,
    // and the FIRST activation flips the trusted project ready, recording the
    // version's digests as the artifacts — there is no other path to ready.
    await mintUploadTokenVia(false, NEVER, 'acme');
    expect(await activateProjectDataVia(false, NEVER, 'acme', 1)).toEqual({ applied: true });
    const ready = listLocalProjects()[0]!;
    expect(ready.status).toBe('ready');
    expect(ready.artifacts?.inventorySha256).toMatch(/^[a-f0-9]{64}$/);

    expect(await deregisterProjectVia(false, NEVER, 'acme')).toEqual({ applied: true });
    expect(listLocalProjects()).toEqual([]);
  });

  it('authoritative routes every call to the client instead (the local store is never touched)', async () => {
    const calls: string[] = [];
    const remote: ServerProject = { ...REGISTER, status: 'draft' };
    const client = {
      listServerProjects: async () => {
        calls.push('list');
        return [remote];
      },
      registerProject: async () => {
        calls.push('register');
        return remote;
      },
    } as unknown as HttpApiClient;
    await registerProjectVia(true, client, REGISTER);
    expect(await loadServerProjectsVia(true, client)).toEqual([remote]);
    expect(calls).toEqual(['register', 'list']);
    expect(listLocalProjects()).toEqual([]);
  });
});

describe('register — the server\'s own shape rules, locally enforced', () => {
  it('refuses a duplicate id, and each malformed field, with a plain reason', () => {
    registerLocalProject(REGISTER);
    expect(() => registerLocalProject(REGISTER)).toThrow('already exists');
    expect(() => registerLocalProject({ ...REGISTER, id: 'Bad_Slug' })).toThrow('lowercase slug');
    expect(() => registerLocalProject({ ...REGISTER, id: 'x2', name: 'a' })).toThrow('2–100');
    expect(() => registerLocalProject({ ...REGISTER, id: 'x3', accountId: '123' })).toThrow('twelve digits');
    expect(() => registerLocalProject({ ...REGISTER, id: 'x4', region: 'nowhere' })).toThrow('region code');
    expect(() =>
      registerLocalProject({ ...REGISTER, id: 'x5', github: { owner: '-bad-', repo: 'r' } }),
    ).toThrow('GitHub owner');
  });
});

describe('upload — the sha binding and the artifact contract', () => {
  beforeEach(() => {
    registerLocalProject(REGISTER);
  });

  it('refuses a report whose bytes do not hash to the trust request fingerprint', async () => {
    await expect(
      uploadTrustRequestVia(false, null, 'acme', {
        trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: 'd'.repeat(64) },
        prescanReport: CLEAN_REPORT_TEXT,
      }),
    ).rejects.toThrow('does not match the fingerprint');
  });

  it('refuses text that is not a prescan-report.json', async () => {
    await expect(
      uploadTrustRequestVia(false, null, 'acme', {
        trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256: 'd'.repeat(64) },
        prescanReport: '{"nope": true}',
      }),
    ).rejects.toThrow('Not a prescan-report.json');
  });

  it('refuses a trust request and report that name different repositories', async () => {
    const prescanSha256 = await sha256Hex(CLEAN_REPORT_TEXT);
    await expect(
      uploadTrustRequestVia(false, null, 'acme', {
        trustRequest: { repo: 'some-other-repo', commitSha: COMMIT, prescanSha256 },
        prescanReport: CLEAN_REPORT_TEXT,
      }),
    ).rejects.toThrow('different repositories');
  });

  it('refuses re-aiming a trusted project (forward-only ladder)', async () => {
    await uploadClean();
    const prescanSha256 = await sha256Hex(CLEAN_REPORT_TEXT);
    await proposeTrustVia(false, null, 'acme', { commitSha: COMMIT, prescanSha256 });
    await expect(uploadClean()).rejects.toThrow('already trusted');
  });
});

describe('trust — fail-closed in every direction', () => {
  beforeEach(() => {
    registerLocalProject(REGISTER);
  });

  it('a reject verdict never gets trusted, full stop', async () => {
    const prescanSha256 = await sha256Hex(REJECT_REPORT_TEXT);
    await uploadTrustRequestVia(false, null, 'acme', {
      trustRequest: { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256 },
      prescanReport: REJECT_REPORT_TEXT,
    });
    await expect(
      proposeTrustVia(false, null, 'acme', { commitSha: COMMIT, prescanSha256 }),
    ).rejects.toThrow('nothing to trust');
    expect(listLocalProjects()[0]?.status).toBe('pending-trust');
  });

  it('refuses a decision that does not match the uploaded binding, and a draft with no upload', async () => {
    await expect(
      proposeTrustVia(false, null, 'acme', { commitSha: COMMIT, prescanSha256: 'd'.repeat(64) }),
    ).rejects.toThrow('Upload the scan artifacts first.');
    await uploadClean();
    await expect(
      proposeTrustVia(false, null, 'acme', { commitSha: 'beefbeef', prescanSha256: 'd'.repeat(64) }),
    ).rejects.toThrow('does not match the uploaded scan');
  });
});

