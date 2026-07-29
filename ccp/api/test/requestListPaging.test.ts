import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { seed, seedRequests, sessionCookieFor, SAMPLE_PROJECT_ID } from './helpers/seed';
import { __setKnownProjects } from '../src/projects';

/**
 * `GET /requests` declared a `cursor` parameter and a `cursor` response field in
 * openapi/ccp-api.yaml from the day the contract was written, and honoured
 * neither: it returned every request the estate had ever seen, in one response,
 * forever. These pin the pagination that closes that gap, and — just as
 * importantly — pin that an unpaged call still behaves exactly as it always did.
 */
describe('GET /requests pagination', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    await seed(store);
    __setKnownProjects([SAMPLE_PROJECT_ID]);
  });

  const list = async (query: string, who = 'sari'): Promise<{ status: number; body: { items: Array<{ id: string }>; cursor?: string } }> => {
    const app = createApp(store);
    const res = await app.request(`/requests?${query}`, {
      headers: { cookie: await sessionCookieFor(store, who), 'x-ccp-project': SAMPLE_PROJECT_ID },
    });
    return { status: res.status, body: (await res.json()) as { items: Array<{ id: string }>; cursor?: string } };
  };

  it('returns the whole collection and no cursor when limit is omitted', async () => {
    await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 25);
    const { status, body } = await list('scope=mine');
    expect(status).toBe(200);
    expect(body.items).toHaveLength(25);
    expect(body.cursor).toBeUndefined();
  });

  it('pages the collection exactly once each, in stable order', async () => {
    await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 25);
    const unpaged = (await list('scope=mine')).body.items.map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const { body } = await list(`scope=mine&limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      expect(body.items.length).toBeLessThanOrEqual(7);
      seen.push(...body.items.map((r) => r.id));
      if (!body.cursor) break;
      cursor = body.cursor;
    }
    expect(seen).toEqual(unpaged);
    expect(new Set(seen).size).toBe(25); // no duplicates across pages
  });

  it('omits the cursor on the last page', async () => {
    await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 5);
    expect((await list('scope=mine&limit=5')).body.cursor).toBeUndefined();
    expect((await list('scope=mine&limit=4')).body.cursor).toBeDefined();
    expect((await list('scope=mine&limit=99')).body.items).toHaveLength(5);
  });

  it('pages a FILTERED scope correctly when most rows are rejected', async () => {
    // 30 rows belong to someone else, 4 to sari — a page of 2 must still fill,
    // which means the walk has to keep reading past the rejected rows.
    await seedRequests(store, SAMPLE_PROJECT_ID, 'budi', 30);
    await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 4);

    const first = await list('scope=mine&limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.cursor).toBeDefined();

    const second = await list(`scope=mine&limit=2&cursor=${first.body.cursor}`);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.cursor).toBeUndefined();

    const ids = [...first.body.items, ...second.body.items].map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => id.startsWith('seed-sari-'))).toBe(true);
  });

  it('refuses a cursor without a limit rather than silently ignoring it', async () => {
    await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 3);
    expect((await list('scope=mine&cursor=seed-sari-0')).status).toBe(422);
  });

  it('caps limit at 1000 instead of trusting the client', async () => {
    await seedRequests(store, SAMPLE_PROJECT_ID, 'sari', 3);
    const { status, body } = await list('scope=mine&limit=999999');
    expect(status).toBe(200);
    expect(body.items).toHaveLength(3);
  });

  it('keeps the role gate ahead of pagination', async () => {
    const app = createApp(store);
    const res = await app.request('/requests?scope=all&limit=5', {
      headers: { cookie: await sessionCookieFor(store, 'sari'), 'x-ccp-project': SAMPLE_PROJECT_ID },
    });
    expect(res.status).toBe(403); // sari is a requester
  });
});
