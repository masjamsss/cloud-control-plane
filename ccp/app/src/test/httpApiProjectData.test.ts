import { afterEach, describe, expect, it } from 'vitest';
import { createHttpApiClient, projectRepoLabel } from '@/lib/httpApi';
import type { Inventory, ServiceManifest } from '@/types';
import { manifests as bundledManifests } from '@/data/manifests';
import { setProjectScopeForTests } from '@/lib/projectScope';

/**
 * The onboarding data-plane client methods (upload tokens, versions, activate,
 * archive/unarchive, the serve-reads) and THE SERVE-READ RULE on
 * listManifests/getInventory: the bundled default ('sample') never touches the
 * network; a non-default account reads ccp-api's data plane and falls back
 * to the injected (vendored-or-empty) resolver on a 404 or an error. Proven
 * with an injected fake `fetch` — the same seam httpApiAdmin.test.ts uses.
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}

function fakeFetch(handler: (call: Call) => { status: number; body?: unknown }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init.credentials,
    };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

afterEach(() => setProjectScopeForTests('sample'));

describe('upload tokens — mint / revoke', () => {
  it('mintUploadToken POSTs the ttl body with the CSRF header and returns the one-time token', async () => {
    const minted = { tokenId: '01J', token: '01J.secret', expiresAt: '2026-07-18T00:00:00Z' };
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: minted }));
    const client = createHttpApiClient('', { fetch });
    expect(await client.mintUploadToken('acme', { ttlMinutes: 60 })).toEqual(minted);
    expect(calls[0]).toMatchObject({
      url: '/projects/acme/upload-tokens',
      method: 'POST',
      body: { ttlMinutes: 60 },
      credentials: 'include',
    });
    expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
  });

  it('mintUploadToken with no opts sends an empty object; a server refusal surfaces its reason', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 409,
      body: { code: 'STATE_CONFLICT', reason: 'This request is not in a state that allows that.' },
    }));
    const client = createHttpApiClient('', { fetch });
    await expect(client.mintUploadToken('acme')).rejects.toThrow('not in a state');
    expect(calls[0]!.body).toEqual({});
  });

  it('revokeUploadToken DELETEs the token path', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, revoked: true } }));
    const client = createHttpApiClient('', { fetch });
    await client.revokeUploadToken('acme', '01J');
    expect(calls[0]).toMatchObject({ url: '/projects/acme/upload-tokens/01J', method: 'DELETE' });
  });
});

describe('versions — list / activate; archive / unarchive', () => {
  it('listProjectDataVersions GETs /projects/:id/data', async () => {
    const body = {
      activeVersion: 1,
      versions: [
        {
          version: 1,
          status: 'active',
          uploadedAt: '2026-07-17T00:00:00Z',
          uploadedVia: 'upload-token:01J',
          digests: { inventorySha256: 'a'.repeat(64), blocksSha256: 'b'.repeat(64) },
          uploadDigests: { inventorySha256: 'a'.repeat(64), blocksSha256: 'b'.repeat(64) },
          counts: { resources: 3, blockAddresses: 3, blockChunks: 1, manifests: 0 },
          chunks: ['main'],
          warnings: [],
        },
      ],
    };
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body }));
    const client = createHttpApiClient('', { fetch });
    expect(await client.listProjectDataVersions('acme')).toEqual(body);
    expect(calls[0]).toMatchObject({ url: '/projects/acme/data', method: 'GET' });
  });

  it('activateProjectData maps 202 onto {applied:false, pendingId} — a proposal is never claimed applied', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 202,
      body: { id: 'pc-1', kind: 'project-data-activate' },
    }));
    const client = createHttpApiClient('', { fetch });
    expect(await client.activateProjectData('acme', 2)).toEqual({
      applied: false,
      pendingId: 'pc-1',
    });
    expect(calls[0]).toMatchObject({ url: '/projects/acme/data/2/activate', method: 'POST' });
  });

  it('archiveProject POSTs and resolves on 200; unarchiveProject maps its 202 envelope', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith('/archive')
        ? { status: 200, body: { ok: true } }
        : { status: 202, body: { id: 'pc-2', kind: 'project-unarchive' } },
    );
    const client = createHttpApiClient('', { fetch });
    await client.archiveProject('acme');
    expect(await client.unarchiveProject('acme')).toEqual({ applied: false, pendingId: 'pc-2' });
    expect(calls.map((c) => c.url)).toEqual(['/projects/acme/archive', '/projects/acme/unarchive']);
  });
});

describe('the serve-reads — null on 404 (no active data), values on 200', () => {
  it('getProjectManifests / getProjectInventory / getProjectBlocksChunk hit the data-plane paths', async () => {
    const inventory = { generatedAt: null, resources: [] };
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/manifests')) return { status: 200, body: [] };
      if (call.url.endsWith('/inventory')) return { status: 200, body: inventory };
      return {
        status: 200,
        body: { 'aws_instance.web': { file: 'main.tf', line: 1, source: 'resource {}' } },
      };
    });
    const client = createHttpApiClient('', { fetch });
    expect(await client.getProjectManifests('acme')).toEqual([]);
    expect(await client.getProjectInventory('acme')).toEqual(inventory);
    const chunk = await client.getProjectBlocksChunk('acme', 'main');
    expect(chunk).toHaveProperty('aws_instance.web');
    expect(calls.map((c) => c.url)).toEqual([
      '/projects/acme/manifests',
      '/projects/acme/inventory',
      '/projects/acme/blocks/main',
    ]);
  });

  it('404 → null on all three (the caller falls back to vendored-or-empty)', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 404,
      body: { code: 'NOT_FOUND', reason: 'No active data.' },
    }));
    const client = createHttpApiClient('', { fetch });
    expect(await client.getProjectManifests('acme')).toBeNull();
    expect(await client.getProjectInventory('acme')).toBeNull();
    expect(await client.getProjectBlocksChunk('acme', 'main')).toBeNull();
  });

  it('fail closed on junk: a non-array manifests body and an inventory without resources both read as null', async () => {
    const { fetch } = fakeFetch((call) =>
      call.url.endsWith('/manifests')
        ? { status: 200, body: { not: 'an array' } }
        : { status: 200, body: { rows: [] } },
    );
    const client = createHttpApiClient('', { fetch });
    expect(await client.getProjectManifests('acme')).toBeNull();
    expect(await client.getProjectInventory('acme')).toBeNull();
  });
});

describe('THE SERVE-READ RULE on listManifests/getInventory (the app-rebuild killer)', () => {
  const EMPTY_SENTINEL: Inventory = { generatedAt: null, resources: [] };

  it("the bundled default ('sample') NEVER touches the network — build-time data stays authoritative", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 500 }));
    const client = createHttpApiClient('', {
      fetch,
      getManifests: () => bundledManifests,
      getInventory: () => EMPTY_SENTINEL,
    });
    setProjectScopeForTests('sample');
    expect(await client.listManifests()).toBe(bundledManifests);
    expect(await client.getInventory()).toBe(EMPTY_SENTINEL);
    expect(calls).toEqual([]);
  });

  it('a NON-default account reads the server data plane (with the acting-scope header) and parses it', async () => {
    // A real bundled manifest round-trips the app's own schema — the served
    // copy must parse exactly like a build-time one.
    const served = JSON.parse(JSON.stringify(bundledManifests[0])) as unknown;
    const inventory = {
      generatedAt: '2026-07-17T00:00:00.000Z',
      resources: [{ address: 'aws_instance.web', resourceType: 'aws_instance', attributes: {} }],
    };
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith('/manifests')
        ? { status: 200, body: [served] }
        : { status: 200, body: inventory },
    );
    const client = createHttpApiClient('', {
      fetch,
      getManifests: () => [],
      getInventory: () => EMPTY_SENTINEL,
    });
    setProjectScopeForTests('acme');

    const manifests = (await client.listManifests()) as ServiceManifest[];
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.service).toBe(bundledManifests[0]!.service);
    expect((await client.getInventory()).resources).toHaveLength(1);

    expect(calls.map((c) => c.url)).toEqual([
      '/projects/acme/manifests',
      '/projects/acme/inventory',
    ]);
    expect(calls[0]!.headers['x-ccp-project']).toBe('acme');
  });

  it('404 (nothing active) falls back to the injected resolver — vendored-or-empty, never another estate', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 404,
      body: { code: 'NOT_FOUND', reason: 'No active data.' },
    }));
    const vendored: ServiceManifest[] = [];
    const client = createHttpApiClient('', {
      fetch,
      getManifests: () => vendored,
      getInventory: () => EMPTY_SENTINEL,
    });
    setProjectScopeForTests('acme');
    expect(await client.listManifests()).toBe(vendored);
    expect(await client.getInventory()).toBe(EMPTY_SENTINEL);
  });

  it('a network error or malformed served data also falls back (fail closed, still usable)', async () => {
    let mode: 'throw' | 'junk' = 'throw';
    const throwingFetch = (async () => {
      if (mode === 'throw') throw new Error('connection refused');
      return new Response(JSON.stringify([{ service: 'x' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createHttpApiClient('', {
      fetch: throwingFetch,
      getManifests: () => bundledManifests,
      getInventory: () => EMPTY_SENTINEL,
    });
    setProjectScopeForTests('acme');
    expect(await client.listManifests()).toBe(bundledManifests); // network error → fallback
    mode = 'junk';
    expect(await client.listManifests()).toBe(bundledManifests); // junk manifest (fails the schema) → fallback
  });
});

describe('projectRepoLabel — one label whichever repo shape a row carries', () => {
  it('prefers the canonical repo; falls back to the legacy github mirror; empty when neither', () => {
    expect(projectRepoLabel({ repo: { host: 'gitlab', owner: 'grp/sub', name: 'estate' } })).toBe(
      'grp/sub/estate',
    );
    expect(projectRepoLabel({ github: { owner: 'acme-co', repo: 'terraform-acme' } })).toBe(
      'acme-co/terraform-acme',
    );
    expect(
      projectRepoLabel({
        repo: { host: 'github', owner: 'acme-co', name: 'terraform-acme' },
        github: { owner: 'acme-co', repo: 'terraform-acme' },
      }),
    ).toBe('acme-co/terraform-acme');
    expect(projectRepoLabel({})).toBe('');
  });
});
