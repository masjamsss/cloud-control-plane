import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { ProjectItem } from '../src/store/schema';
import { ProjectItem as ProjectItemSchema, projectCollectionGsi, projectKey, repoRefOf, githubMirrorOf } from '../src/store/schema';
import { __resetKnownProjectsForTests } from '../src/projects';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * The HOST-AGNOSTIC repo config (github → repo:{host,baseUrl?,owner,name}) and
 * its READ-TIME back-compat shim: old `github`-only rows keep working untouched,
 * the register route accepts either shape (never both), and every projection
 * serves both shapes during migration — with the `github` mirror present ONLY
 * when the host really is github. This is also the seam that unblocks GitLab.
 */

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function hdrs(cookie: string, opts: { json?: boolean } = {}): Record<string, string> {
  const h: Record<string, string> = { cookie, 'x-ccp-client': 'ccp-spa', 'x-ccp-project': 'sample' };
  if (opts.json) h['content-type'] = 'application/json';
  return h;
}

const BASE = { id: 'acme', name: 'Acme estate', accountId: '123456789012', region: 'ap-southeast-5' };

type App = ReturnType<typeof createApp>;

async function setup(): Promise<{ store: ConfigStore; app: App; putra: string; sari: string }> {
  const store = new MemoryStore();
  await seed(store);
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  const app = createApp(store);
  return { store, app, putra: await sessionCookieFor(store, 'putra'), sari: await sessionCookieFor(store, 'sari') };
}

async function register(app: App, cookie: string, body: Record<string, unknown>): Promise<Response> {
  return app.request('/projects', { method: 'POST', headers: hdrs(cookie, { json: true }), body: JSON.stringify(body) });
}

beforeEach(() => __resetKnownProjectsForTests());

describe('the pure shim (repoRefOf / githubMirrorOf)', () => {
  it('resolves a legacy github-only row to host github; a repo field wins; neither → undefined', () => {
    expect(repoRefOf({ github: { owner: 'acme-co', repo: 'terraform-acme' } })).toEqual({
      host: 'github',
      owner: 'acme-co',
      name: 'terraform-acme',
    });
    expect(
      repoRefOf({
        repo: { host: 'gitlab', owner: 'grp/sub', name: 'estate' },
        github: { owner: 'stale', repo: 'stale' },
      }),
    ).toEqual({ host: 'gitlab', owner: 'grp/sub', name: 'estate' });
    expect(repoRefOf({})).toBeUndefined();
  });

  it('mirrors ONLY a github-hosted repo back into the legacy shape (a gitlab mirror would be a lie)', () => {
    expect(githubMirrorOf({ host: 'github', owner: 'acme-co', name: 'terraform-acme' })).toEqual({
      owner: 'acme-co',
      repo: 'terraform-acme',
    });
    expect(githubMirrorOf({ host: 'gitlab', owner: 'grp', name: 'estate' })).toBeUndefined();
    expect(githubMirrorOf(undefined)).toBeUndefined();
  });
});

describe('POST /projects — accepts either shape, stores canonically, serves both', () => {
  it('legacy github body: stored row carries BOTH repo (canonical) and the github mirror; response serves both', async () => {
    const { store, app, putra } = await setup();
    const res = await register(app, putra, { ...BASE, github: { owner: 'acme-co', repo: 'terraform-acme' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.github).toEqual({ owner: 'acme-co', repo: 'terraform-acme' });
    expect(body.repo).toEqual({ host: 'github', owner: 'acme-co', name: 'terraform-acme' });

    const k = projectKey('acme');
    const row = (await store.get(k.PK, k.SK)) as ProjectItem;
    expect(row.repo).toEqual({ host: 'github', owner: 'acme-co', name: 'terraform-acme' });
    expect(row.github).toEqual({ owner: 'acme-co', repo: 'terraform-acme' });
    // the stored row parses against the widened schema
    expect(ProjectItemSchema.safeParse(row).success).toBe(true);
  });

  it('host-agnostic github body: same canonical storage, mirror present', async () => {
    const { app, putra } = await setup();
    const res = await register(app, putra, { ...BASE, repo: { host: 'github', owner: 'acme-co', name: 'terraform-acme' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.github).toEqual({ owner: 'acme-co', repo: 'terraform-acme' });
    expect(body.repo).toEqual({ host: 'github', owner: 'acme-co', name: 'terraform-acme' });
  });

  it('gitlab body (with subgroups + self-hosted baseUrl): repo served, NO github field fabricated', async () => {
    const { app, putra } = await setup();
    const repo = { host: 'gitlab', baseUrl: 'https://gitlab.example.com', owner: 'infra/estates', name: 'terraform-acme' };
    const res = await register(app, putra, { ...BASE, repo });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.repo).toEqual(repo);
    expect(body.github).toBeUndefined();
  });

  it('refuses BOTH shapes, NEITHER shape, a non-https baseUrl, and junk hosts (422)', async () => {
    const { app, putra } = await setup();
    for (const body of [
      { ...BASE, github: { owner: 'a', repo: 'b' }, repo: { host: 'github', owner: 'a', name: 'b' } },
      { ...BASE },
      { ...BASE, repo: { host: 'gitlab', baseUrl: 'http://plaintext.example.com', owner: 'g', name: 'r' } },
      { ...BASE, repo: { host: 'bitbucket', owner: 'g', name: 'r' } },
      { ...BASE, repo: { host: 'github', owner: '../etc', name: 'r' } },
    ]) {
      const res = await register(app, putra, body as Record<string, unknown>);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('READ-TIME back-compat — legacy stored rows keep working with no migration', () => {
  it('a pre-existing github-only row (planted verbatim) serves BOTH shapes on both tiers', async () => {
    const { store, app, putra, sari } = await setup();
    // Plant a legacy row exactly as the old register wrote it: github only, no repo.
    const k = projectKey('legacy');
    await store.put({
      ...k,
      id: 'legacy',
      name: 'Legacy estate',
      github: { owner: 'old-co', repo: 'old-estate' },
      accountId: '210987654321',
      region: 'ap-southeast-1',
      status: 'draft',
      createdBy: 'putra',
      createdAt: '2026-07-01T00:00:00.000Z',
      version: 1,
      GSI1PK: projectCollectionGsi(),
      GSI1SK: 'legacy',
    });

    // rich tier (lead+admin)
    const rich = (await (await app.request('/projects', { headers: hdrs(putra) })).json()) as Array<Record<string, unknown>>;
    const richRow = rich.find((p) => p.id === 'legacy')!;
    expect(richRow.github).toEqual({ owner: 'old-co', repo: 'old-estate' });
    expect(richRow.repo).toEqual({ host: 'github', owner: 'old-co', name: 'old-estate' });

    // thin tier (any bound session)
    const thin = (await (await app.request('/projects', { headers: hdrs(sari) })).json()) as Array<Record<string, unknown>>;
    const thinRow = thin.find((p) => p.id === 'legacy')!;
    expect(thinRow.github).toEqual({ owner: 'old-co', repo: 'old-estate' });
    expect(thinRow.repo).toEqual({ host: 'github', owner: 'old-co', name: 'old-estate' });

    // and the widened zod still parses the legacy row untouched
    const raw = await store.get(k.PK, k.SK);
    expect(ProjectItemSchema.safeParse(raw).success).toBe(true);
  });
});
