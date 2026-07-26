import { afterEach, describe, expect, it } from 'vitest';
import { ApiRefusalError, createHttpApiClient } from '@/lib/httpApi';
import { createScanJobVia, latestScanJobVia } from '@/features/admin/projectsFlow';
import { setProjectScopeForTests } from '@/lib/projectScope';

/**
 * The ZERO-TOUCH first scan's client half (ADR-0033): the wizard asks the
 * control plane to scan a repo itself, then reads the job's progress.
 *
 * What matters here is what the client must NOT do. It never sends a repo URL
 * or a token (the server picks the target and mints the credential), it treats
 * "this project has never been scanned" as an ordinary empty state rather than
 * an error, and it surfaces the server's SCANNER_DISABLED refusal verbatim —
 * that sentence IS how the wizard explains an unarmed deployment, so it must
 * reach the screen unedited.
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
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

describe('createScanJob — asking the control plane to scan the repo itself', () => {
  it('POSTs an empty request with the CSRF header and returns the queued job', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 201,
      body: { jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', status: 'queued' },
    }));
    const client = createHttpApiClient('', { fetch });

    expect(await client.createScanJob('acme')).toEqual({
      jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'queued',
    });
    expect(calls[0]).toMatchObject({ url: '/projects/acme/scan-jobs', method: 'POST' });
    expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    // THE POINT: the client names no target and carries no credential. The
    // server rebuilds the clone URL from the stored repo ref and mints the
    // worker's token itself — if a body ever appears here, that moved.
    expect(calls[0]!.body).toBeUndefined();
  });

  it('escapes the project id into the path', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 201,
      body: { jobId: 'J', status: 'queued' },
    }));
    await createHttpApiClient('', { fetch }).createScanJob('a/../b');
    expect(calls[0]!.url).toBe('/projects/a%2F..%2Fb/scan-jobs');
  });

  it("surfaces an unarmed deployment's refusal verbatim — that sentence IS the explanation", async () => {
    const reason =
      'The built-in repository scanner is not enabled on this deployment. Run the scan from the repository’s CI or locally instead.';
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { code: 'SCANNER_DISABLED', reason },
    }));
    const client = createHttpApiClient('', { fetch });
    await expect(client.createScanJob('acme')).rejects.toBeInstanceOf(ApiRefusalError);
    await client.createScanJob('acme').catch((e: unknown) => {
      expect((e as ApiRefusalError).code).toBe('SCANNER_DISABLED');
      expect((e as ApiRefusalError).message).toBe(reason);
    });
  });

  it('surfaces a refused clone target without inventing copy of its own', async () => {
    const reason =
      "This project's repository host is not one this deployment is allowed to clone from.";
    const { fetch } = fakeFetch(() => ({
      status: 422,
      body: { code: 'SCAN_TARGET_REFUSED', reason },
    }));
    await createHttpApiClient('', { fetch })
      .createScanJob('acme')
      .catch((e: unknown) => {
        expect((e as ApiRefusalError).code).toBe('SCAN_TARGET_REFUSED');
        expect((e as ApiRefusalError).message).toBe(reason);
      });
  });
});

describe('latestScanJob — the wizard’s progress read', () => {
  it('GETs the latest job and returns its state', async () => {
    const state = {
      jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'scanning',
      createdAt: '2026-07-26T01:00:00.000Z',
      startedAt: '2026-07-26T01:00:03.000Z',
    };
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: state }));
    expect(await createHttpApiClient('', { fetch }).latestScanJob('acme')).toEqual(state);
    expect(calls[0]).toMatchObject({ url: '/projects/acme/scan-jobs/latest', method: 'GET' });
  });

  it('treats "never scanned" (404) as an empty state, not an error', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 404,
      body: { code: 'NOT_FOUND', reason: 'No scan job.' },
    }));
    expect(await createHttpApiClient('', { fetch }).latestScanJob('acme')).toBeNull();
  });

  it('still throws on a real refusal — 404 is the ONLY tolerated status', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: { code: 'NOT_ADMIN', reason: 'nope' },
    }));
    await expect(createHttpApiClient('', { fetch }).latestScanJob('acme')).rejects.toBeInstanceOf(
      ApiRefusalError,
    );
  });

  it('carries a failed job’s server-sanitized reason through unchanged', async () => {
    // The server already stripped URLs, tokens and control characters; the
    // client must not re-edit it, or the admin sees a different failure than
    // the one recorded in the audit trail.
    const state = {
      jobId: 'J',
      status: 'failed',
      createdAt: '2026-07-26T01:00:00.000Z',
      finishedAt: '2026-07-26T01:00:09.000Z',
      error: 'clone failed: [url] not found',
    };
    const { fetch } = fakeFetch(() => ({ status: 200, body: state }));
    const got = await createHttpApiClient('', { fetch }).latestScanJob('acme');
    expect(got?.error).toBe('clone failed: [url] not found');
  });
});

describe('the wizard’s flow helpers', () => {
  it('use the authoritative client when there is one', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.method === 'POST'
        ? { status: 201, body: { jobId: 'J', status: 'queued' } }
        : { status: 200, body: { jobId: 'J', status: 'queued', createdAt: 'now' } },
    );
    const client = createHttpApiClient('', { fetch });
    expect(await createScanJobVia(true, client, 'acme')).toEqual({ jobId: 'J', status: 'queued' });
    expect(await latestScanJobVia(true, client, 'acme')).toMatchObject({ jobId: 'J' });
    expect(calls).toHaveLength(2);
  });

  it('refuse in the preview build instead of faking a scan', async () => {
    // There is deliberately NO demo stand-in: the whole feature is a real
    // deployment cloning a real repository, so a mock would be theatre. The
    // preview says so and points at the other two ways.
    await expect(createScanJobVia(false, null, 'acme')).rejects.toThrow(/real deployment/i);
    expect(await latestScanJobVia(false, null, 'acme')).toBeNull();
  });
});
