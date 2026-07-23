import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpApiClient, ProjectDataVersions } from '@/lib/httpApi';
import { ApiRefusalError } from '@/lib/httpApi';
import {
  activateLocalProjectData,
  archiveLocalProject,
  listLocalProjectDataVersions,
  listLocalProjects,
  mintLocalUploadToken,
  proposeLocalProjectTrust,
  registerLocalProject,
  resetLocalProjectsForTests,
  revokeLocalUploadToken,
  unarchiveLocalProject,
  uploadLocalTrustRequest,
} from '@/lib/projectOnboarding';
import {
  activatedAgeLabel,
  activateProjectDataVia,
  archiveProjectVia,
  dataAgeLabel,
  dataCountsLabel,
  groupDataVersions,
  listProjectDataVersionsVia,
  mintUploadTokenVia,
  readArtifactFile,
  refusalCopy,
  REFUSAL_COPY,
  repoHostLabel,
  repoLabel,
  repoRefFromForm,
  staleDataNotice,
  STALE_DATA_DAYS,
} from '@/features/admin/projectsFlow';
import {
  GITHUB_CI_PATH,
  GITLAB_CI_PATH,
  githubDataWorkflow,
  gitlabDataPipeline,
  PROJECT_ID_VAR,
  SERVER_URL_VAR,
  UPLOAD_KEY_SECRET,
} from '@/features/admin/ciTemplates';

/**
 * The reworked onboarding wizard's new surface: the host-aware repo field
 * (step 1), the exact-bytes file read (step 2), the CI data lane — mint an
 * upload key, staged versions, one-button activate (steps 4–5) — and the
 * lifecycle around a ready project (freshness, archive, version history).
 * The wire shapes are the onboarding backend's own (httpApi.ts mirrors
 * routes/projectData.ts). The demo registry's pinned divergences from the
 * server: trust/activate apply immediately (no second-admin envelope
 * locally) and minting a key stages one sample version (no repo CI talks to
 * this browser). The first activation flipping the project ready is NOT a
 * divergence — the server's activation ack is the go-live too.
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

const COMMIT = 'abc123def4567890abc123def4567890abc123de';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Walk acme to `trusted` — the state steps 4/5 operate on. */
async function trustAcme(): Promise<void> {
  registerLocalProject(REGISTER);
  const prescanSha256 = await sha256Hex(CLEAN_REPORT_TEXT);
  await uploadLocalTrustRequest(
    'acme',
    { repo: 'terraform-acme', commitSha: COMMIT, prescanSha256 },
    CLEAN_REPORT_TEXT,
    {
      repo: 'terraform-acme',
      verdict: 'clean',
      findings: [],
      resourceBlocks: 12,
      moduleBlocks: 1,
      tfJsonFiles: 0,
      fmtDirtyFiles: 2,
      providerPins: { aws: '~> 6.0' },
    },
  );
  await proposeLocalProjectTrust('acme', { commitSha: COMMIT, prescanSha256 });
}

const NEVER: HttpApiClient = new Proxy({} as HttpApiClient, {
  get: () => () => {
    throw new Error('server must not be called when not authoritative');
  },
});

beforeEach(() => {
  resetLocalProjectsForTests();
});

describe('repoRefFromForm — the host toggle to the wire shape', () => {
  it('builds github and gitlab.com refs without a server address', () => {
    expect(repoRefFromForm({ host: 'github', baseUrl: '', owner: 'acme-co', name: 'tf' })).toEqual(
      { ok: true, repo: { host: 'github', owner: 'acme-co', name: 'tf' } },
    );
    expect(
      repoRefFromForm({ host: 'gitlab', baseUrl: 'ignored', owner: 'grp/sub', name: 'tf' }),
    ).toEqual({ ok: true, repo: { host: 'gitlab', owner: 'grp/sub', name: 'tf' } });
  });

  it('self-hosted needs a full https address (trailing slash trimmed)', () => {
    expect(
      repoRefFromForm({
        host: 'gitlab-self-hosted',
        baseUrl: 'https://gitlab.example.com/',
        owner: 'grp',
        name: 'tf',
      }),
    ).toEqual({
      ok: true,
      repo: { host: 'gitlab', baseUrl: 'https://gitlab.example.com', owner: 'grp', name: 'tf' },
    });
    for (const baseUrl of ['', 'gitlab.example.com', 'http://gitlab.example.com']) {
      const out = repoRefFromForm({ host: 'gitlab-self-hosted', baseUrl, owner: 'g', name: 't' });
      expect(out.ok, baseUrl).toBe(false);
      if (!out.ok) expect(out.reason).toContain('https');
    }
  });

  it('refuses a missing owner or repository with a plain reason', () => {
    const noOwner = repoRefFromForm({ host: 'github', baseUrl: '', owner: ' ', name: 'tf' });
    expect(noOwner).toEqual({ ok: false, reason: 'Name the repository owner or group.' });
    const noName = repoRefFromForm({ host: 'github', baseUrl: '', owner: 'a', name: '' });
    expect(noName).toEqual({ ok: false, reason: 'Name the repository.' });
  });
});

describe('register — host-agnostic, one repo shape per call (the server rule)', () => {
  it('stores a gitlab subgroup project WITHOUT a github mirror (never a lie)', () => {
    const created = registerLocalProject({
      ...REGISTER,
      github: undefined,
      id: 'plat',
      repo: { host: 'gitlab', baseUrl: 'https://gitlab.example.com', owner: 'platform/infra', name: 'tf-estate' },
    });
    expect(created.repo).toEqual({
      host: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      owner: 'platform/infra',
      name: 'tf-estate',
    });
    // The github mirror exists only when the host really is github.
    expect(created.github).toBeUndefined();
    expect(repoLabel(created)).toBe('platform/infra/tf-estate');
    expect(repoHostLabel(created)).toBe('GitLab at gitlab.example.com');
  });

  it('legacy github-shaped input still registers (and labels as GitHub)', () => {
    const created = registerLocalProject(REGISTER);
    expect(created.repo).toEqual({ host: 'github', owner: 'acme-co', name: 'terraform-acme' });
    expect(created.github).toEqual({ owner: 'acme-co', repo: 'terraform-acme' });
    expect(repoLabel(created)).toBe('acme-co/terraform-acme');
    expect(repoHostLabel(created)).toBe('GitHub');
    expect(repoHostLabel({ repo: undefined })).toBe('GitHub');
    expect(repoHostLabel({ repo: { host: 'gitlab', owner: 'g', name: 't' } })).toBe('GitLab');
  });

  it('refuses both-or-neither repo shapes, like the register endpoint', () => {
    expect(() =>
      registerLocalProject({
        ...REGISTER,
        id: 'x0',
        repo: { host: 'github', owner: 'acme-co', name: 'tf' },
      }),
    ).toThrow('exactly one way');
    expect(() => registerLocalProject({ ...REGISTER, github: undefined, id: 'x0' })).toThrow(
      'exactly one way',
    );
  });

  it('refuses a slashed owner on github and a bad self-hosted address', () => {
    expect(() =>
      registerLocalProject({
        ...REGISTER,
        github: undefined,
        id: 'x1',
        repo: { host: 'github', owner: 'a/b', name: 'tf' },
      }),
    ).toThrow('GitHub owner');
    expect(() =>
      registerLocalProject({
        ...REGISTER,
        github: undefined,
        id: 'x2',
        repo: { host: 'gitlab', baseUrl: 'http://plain.example.com', owner: 'g', name: 'tf' },
      }),
    ).toThrow('https');
  });
});

describe('readArtifactFile — the exact-bytes rule the picker exists for', () => {
  const asFile = (bytes: Uint8Array, name = 'trust-request.json') => ({
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  });

  it('returns text whose bytes hash to the same fingerprint as the file', async () => {
    const text = `${CLEAN_REPORT_TEXT}\n`;
    const read = await readArtifactFile(asFile(new TextEncoder().encode(text)));
    expect(read).toEqual({ ok: true, text });
    if (read.ok) expect(await sha256Hex(read.text)).toBe(await sha256Hex(text));
  });

  it('keeps a leading BOM byte-faithful instead of silently dropping it', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]); // BOM + "{}"
    const read = await readArtifactFile(asFile(bom));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(new TextEncoder().encode(read.text)).toEqual(bom);
    }
  });

  it('refuses a non-text file and an oversized file, naming the file', async () => {
    const binary = await readArtifactFile(asFile(new Uint8Array([0xff, 0xfe, 0x00]), 'plan.zip'));
    expect(binary).toEqual({ ok: false, reason: 'plan.zip is not a text file — pick the JSON file the scan wrote.' });
    const huge = await readArtifactFile({
      name: 'big.json',
      size: 2_000_000,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.reason).toContain('big.json');
  });
});

describe('the CI data lane, locally (mint → staged → activate → history)', () => {
  it('mint needs trust first, returns the key ONCE, and stages the demo version', async () => {
    registerLocalProject(REGISTER);
    await expect(mintLocalUploadToken('acme')).rejects.toThrow('Trust the scanned commit');

    resetLocalProjectsForTests();
    await trustAcme();
    const mint = await mintLocalUploadToken('acme');
    // The server's token format: `<tokenId>.<secret>` — the id half is the
    // non-secret handle revoke names.
    expect(mint.token).toBe(`${mint.tokenId}.${mint.token.split('.')[1]}`);
    expect(mint.tokenId).toMatch(/^[0-9a-f]{16}$/);
    expect(mint.token.split('.')[1]).toMatch(/^[0-9a-f]{48}$/);

    // The secret never round-trips — no projection carries it.
    const project = listLocalProjects()[0]!;
    expect(JSON.stringify(project)).not.toContain(mint.token);

    // Demo divergence, pinned: minting stages one sample version (no repo CI
    // talks to this browser), in the server's own row shape — provenance,
    // server-computed digests, counts derived from the scan census.
    const versions = listLocalProjectDataVersions('acme');
    expect(versions.activeVersion).toBeUndefined();
    expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0]).toMatchObject({
      version: 1,
      status: 'staged',
      uploadedVia: `upload-token:${mint.tokenId}`,
      sourceCommit: COMMIT,
      counts: { resources: 12, blockAddresses: 11 },
    });
    const staged = versions.versions[0]!;
    expect(staged.digests.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(staged.digests).toEqual(staged.uploadDigests);
    expect(staged.warnings.join(' ')).toContain('not terraform-formatted');
  });

  it('minting adds a key (rotation = mint new + revoke old); revoke needs the id', async () => {
    await trustAcme();
    const first = await mintLocalUploadToken('acme');
    const second = await mintLocalUploadToken('acme');
    expect(second.tokenId).not.toBe(first.tokenId);
    // Minting more keys does not pile up staged versions.
    expect(listLocalProjectDataVersions('acme').versions).toHaveLength(1);

    // Both keys exist until revoked — like the server's token rows.
    revokeLocalUploadToken('acme', first.tokenId);
    expect(() => revokeLocalUploadToken('acme', first.tokenId)).toThrow('No such upload key');
    revokeLocalUploadToken('acme', second.tokenId);
  });

  it('activate moves the active pointer and records the SERVER-computed digests — no typing', async () => {
    await trustAcme();
    await mintLocalUploadToken('acme');
    const staged = listLocalProjectDataVersions('acme').versions[0]!;
    const ready = activateLocalProjectData('acme', staged.version);
    // Go-live, pinned: the FIRST activation flips ready and records the
    // version's digests — the same seam the server's 2-admin ack applies
    // (only the envelope collapses locally).
    expect(ready.status).toBe('ready');
    expect(ready.dataActive?.version).toBe(1);
    expect(ready.artifacts?.inventorySha256).toBe(staged.digests.inventorySha256);

    const after = listLocalProjectDataVersions('acme');
    expect(after.activeVersion).toBe(1);
    expect(after.versions.map((v) => v.status)).toEqual(['active']);

    expect(() => activateLocalProjectData('acme', 9)).toThrow('No such data version');
    expect(() => activateLocalProjectData('acme', 1)).toThrow('already the active one');
  });

  it('a later upload can be activated, and the earlier one re-activated from history', async () => {
    await trustAcme();
    await mintLocalUploadToken('acme');
    const first = activateLocalProjectData('acme', 1);
    await mintLocalUploadToken('acme'); // stages #2 (nothing staged after #1 went active)
    const second = activateLocalProjectData('acme', 2);
    // Re-activation is a pointer swap only: still ready, and the go-live
    // artifacts record (v1's digests) is untouched — same rule as the server.
    expect(second.status).toBe('ready');
    expect(second.artifacts?.blocksSha256).toBe(first.artifacts?.blocksSha256);

    let grouped = groupDataVersions(listLocalProjectDataVersions('acme'));
    expect(grouped.active?.version).toBe(2);
    expect(grouped.earlier.map((v) => v.version)).toEqual([1]);
    expect(grouped.staged).toEqual([]);

    activateLocalProjectData('acme', 1);
    grouped = groupDataVersions(listLocalProjectDataVersions('acme'));
    expect(grouped.active?.version).toBe(1);
    // Upload #2 is newer than the now-active #1 — back in the activate list.
    expect(grouped.staged.map((v) => v.version)).toEqual([2]);
    expect(grouped.earlier).toEqual([]);
  });

  it('the Via wrappers route to the client when authoritative, local otherwise', async () => {
    const calls: string[] = [];
    const client = {
      mintUploadToken: async (id: string) => {
        calls.push(`mint:${id}`);
        return { tokenId: 'k', token: 'k.s', expiresAt: 'e' };
      },
      listProjectDataVersions: async (id: string) => {
        calls.push(`list:${id}`);
        return { versions: [] };
      },
      activateProjectData: async (id: string, version: number) => {
        calls.push(`activate:${id}:${version}`);
        return { applied: false as const, pendingId: 'p1' };
      },
      archiveProject: async (id: string) => {
        calls.push(`archive:${id}`);
        // The real client returns void — archive is the tightening write.
      },
    } as unknown as HttpApiClient;

    await mintUploadTokenVia(true, client, 'acme');
    await listProjectDataVersionsVia(true, client, 'acme');
    expect(await activateProjectDataVia(true, client, 'acme', 1)).toEqual({
      applied: false,
      pendingId: 'p1',
    });
    expect(await archiveProjectVia(true, client, 'acme')).toEqual({ applied: true });
    expect(calls).toEqual(['mint:acme', 'list:acme', 'activate:acme:1', 'archive:acme']);
    expect(listLocalProjects()).toEqual([]);

    // Not authoritative → the local registry (and never the server).
    await trustAcme();
    await mintUploadTokenVia(false, NEVER, 'acme');
    expect(await activateProjectDataVia(false, NEVER, 'acme', 1)).toEqual({ applied: true });
  });
});

describe('archive — retire and restore without touching the ladder', () => {
  it('archives, blocks every mutation while archived, and restores in place', async () => {
    await trustAcme();
    await mintLocalUploadToken('acme');
    const archived = archiveLocalProject('acme');
    // The wire shape is the server's: who archived it, and when.
    expect(archived.archived?.archivedBy).toBeTruthy();
    expect(archived.archived?.archivedAt).toBeTruthy();
    expect(archived.status).toBe('trusted'); // the ladder is untouched

    await expect(mintLocalUploadToken('acme')).rejects.toThrow('archived');
    expect(() => activateLocalProjectData('acme', 1)).toThrow('archived');
    expect(() => archiveLocalProject('acme')).toThrow('already archived');

    const restored = unarchiveLocalProject('acme');
    expect(restored.archived).toBeUndefined();
    expect(restored.status).toBe('trusted');
    expect(activateLocalProjectData('acme', 1).status).toBe('ready');
  });
});

describe('freshness copy — the registry list’s honest data line', () => {
  const NOW = new Date('2026-07-17T12:00:00Z');

  it('renders today / 1 day old / N days old on the estate calendar', () => {
    expect(dataAgeLabel('2026-07-17T09:00:00Z', NOW)).toBe('today');
    expect(dataAgeLabel('2026-07-16T09:00:00Z', NOW)).toBe('1 day old');
    expect(dataAgeLabel('2026-07-14T09:00:00Z', NOW)).toBe('3 days old');
    expect(dataAgeLabel(undefined, NOW)).toBeNull();
    expect(dataAgeLabel(null, NOW)).toBeNull();
  });

  it('phrases the card’s "activated …" line as today / N days ago', () => {
    expect(activatedAgeLabel('2026-07-17T09:00:00Z', NOW)).toBe('today');
    expect(activatedAgeLabel('2026-07-16T09:00:00Z', NOW)).toBe('1 day ago');
    expect(activatedAgeLabel('2026-07-14T09:00:00Z', NOW)).toBe('3 days ago');
    expect(activatedAgeLabel(undefined, NOW)).toBeNull();
  });

  it('says so after 30 days without newly activated data, and stays quiet before', () => {
    expect(staleDataNotice('2026-07-10T09:00:00Z', NOW)).toBeNull();
    expect(staleDataNotice('2026-06-17T09:00:00Z', NOW)).toBe(
      'No new data activated in 30 days — check the repo’s CI job for a fresher upload.',
    );
    expect(STALE_DATA_DAYS).toBe(30);
  });

  it('counts resources and block sources in plain words', () => {
    const counts = (resources: number, blockAddresses: number) => ({
      counts: { resources, blockAddresses, blockChunks: 1, manifests: 0 },
    });
    expect(dataCountsLabel(counts(128, 96))).toBe('128 resources, 96 block sources');
    expect(dataCountsLabel(counts(1, 1))).toBe('1 resource, 1 block source');
  });

  it('groupDataVersions splits the server list into active / newer staged / earlier', () => {
    const v = (version: number, status: 'staged' | 'active') => ({
      version,
      status,
      uploadedAt: '2026-07-17T00:00:00Z',
      uploadedVia: 'upload-token:t',
      digests: { inventorySha256: 'a'.repeat(64), blocksSha256: 'b'.repeat(64) },
      uploadDigests: { inventorySha256: 'a'.repeat(64), blocksSha256: 'b'.repeat(64) },
      counts: { resources: 1, blockAddresses: 1, blockChunks: 1, manifests: 0 },
      chunks: ['main'],
      warnings: [],
    });
    const list: ProjectDataVersions = {
      activeVersion: 2,
      versions: [v(1, 'staged'), v(2, 'active'), v(3, 'staged'), v(4, 'staged')],
    };
    const grouped = groupDataVersions(list);
    expect(grouped.active?.version).toBe(2);
    expect(grouped.staged.map((x) => x.version)).toEqual([4, 3]); // newest first
    expect(grouped.earlier.map((x) => x.version)).toEqual([1]);

    // No active pointer yet — everything is stageable, nothing is "earlier".
    const fresh = groupDataVersions({ versions: [v(1, 'staged'), v(2, 'staged')] });
    expect(fresh.active).toBeUndefined();
    expect(fresh.staged.map((x) => x.version)).toEqual([2, 1]);
    expect(fresh.earlier).toEqual([]);
  });
});

describe('refusal copy — one plain sentence naming the fix and who does it', () => {
  it('maps each known code, and every sentence names an actor or an action', () => {
    for (const [code, sentence] of Object.entries(REFUSAL_COPY)) {
      expect(refusalCopy(new ApiRefusalError(code, 'raw server words')), code).toBe(sentence);
      expect(sentence).not.toContain(code); // never a raw code on screen
    }
    expect(refusalCopy(new ApiRefusalError('PRESCAN_SHA_MISMATCH', 'x'))).toContain(
      'a person on a terminal',
    );
    expect(refusalCopy(new ApiRefusalError('DATA_DIGEST_MISMATCH', 'x'))).toContain('CI');
  });

  it('falls back to the message for unmapped codes and plain errors', () => {
    expect(refusalCopy(new ApiRefusalError('SOMETHING_NEW', 'The server said why.'))).toBe(
      'The server said why.',
    );
    expect(refusalCopy(new Error('Plain reason.'))).toBe('Plain reason.');
    expect(refusalCopy('not-an-error')).toBe('Something went wrong.');
  });
});

describe('CI templates — the ready-to-commit files behind the step-4 tabs', () => {
  // The wizard shows the REAL data-lane files, verbatim — these are the
  // source of truth in the control-plane repo (docs/runbooks/account-data-ci.md).
  const repoRoot = join(__dirname, '..', '..', '..', '..');

  it('the GitHub tab is byte-identical to the repo’s real workflow file', () => {
    expect(GITHUB_CI_PATH).toBe('.github/workflows/ccp-data.yml');
    expect(githubDataWorkflow()).toBe(readFileSync(join(repoRoot, GITHUB_CI_PATH), 'utf8'));
  });

  it('the GitLab tab is byte-identical to the repo’s real job file', () => {
    expect(GITLAB_CI_PATH).toBe('.gitlab/ci/ccp-data.gitlab-ci.yml');
    expect(gitlabDataPipeline()).toBe(readFileSync(join(repoRoot, GITLAB_CI_PATH), 'utf8'));
  });

  it('both files wire the pinned setting names, key via environment only', () => {
    expect(UPLOAD_KEY_SECRET).toBe('CCP_UPLOAD_TOKEN');
    expect(SERVER_URL_VAR).toBe('CCP_CONTROL_PLANE_URL');
    expect(PROJECT_ID_VAR).toBe('CCP_PROJECT_ID');
    for (const body of [githubDataWorkflow(), gitlabDataPipeline()]) {
      expect(body).toContain(UPLOAD_KEY_SECRET);
      expect(body).toContain(SERVER_URL_VAR);
      expect(body).toContain(PROJECT_ID_VAR);
      // The key rides the environment; it is never interpolated onto a
      // command line a CI log would print.
      expect(body).not.toMatch(/--key\s/);
      expect(body).not.toMatch(/(curl|bash).*\$\{?CCP_UPLOAD_TOKEN/);
    }
    expect(githubDataWorkflow()).toContain(`secrets.${UPLOAD_KEY_SECRET}`);
    expect(githubDataWorkflow()).toContain('permissions:');
    expect(gitlabDataPipeline()).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  });
});
