import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { AppEnv } from '../src/appEnv';
import { __setNow } from '../src/clock';
import { MIN_LEAD_MS, MAX_HORIZON_MS, MAX_WINDOW_MS, DEFAULT_WINDOW_MS } from '../src/domain/schedule';
import { seed, sessionCookieFor } from './helpers/seed';

/**
 * T-S2 (0024 §2.1) — the SUBMIT route wiring: `validateSchedule` runs after the
 * shape parse and before the item is built, its rejections surface as the new §8
 * codes, and a successful submit stores the NORMALIZED schedule (V6 + V5's default
 * endAt) rather than the client's raw input. `schedule.test.ts` already proves
 * `validateSchedule` itself exhaustively; this file proves the ROUTE actually calls
 * it and does the right thing with the result.
 */

const DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
};

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function submit(app: Hono<AppEnv>, cookie: string, schedule: unknown) {
  return app.request('/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify({ ...DRAFT, schedule }),
  });
}

describe('POST /requests — schedule validation wiring (0024 §2.1/T-S2)', () => {
  afterEach(() => __setNow(null));

  it('kind "now" is unaffected — still submits with no schedule fields to validate', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'now' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schedule).toEqual({ kind: 'now' });
  });

  it('V2: a garbled `at` is refused SCHEDULE_INVALID (422) — not silently accepted (the old bug)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at: 'banana' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_INVALID');
  });

  it('V2: an empty `at` (ReviewStep.tsx\'s old ONLY check) is refused SCHEDULE_INVALID, never persisted', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at: '' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_INVALID');
  });

  it('V3: `at` = now (the picker\'s own past-instant footgun default) is refused SCHEDULE_TOO_SOON', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const now = Date.parse('2026-07-12T12:00:00.000Z');
    __setNow(() => now);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at: new Date(now).toISOString() });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_TOO_SOON');
  });

  it('V3: `at` a few seconds under MIN_LEAD is refused; at exactly MIN_LEAD it is accepted', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const now = Date.parse('2026-07-12T12:00:00.000Z');
    __setNow(() => now);

    const tooSoon = new Date(now + MIN_LEAD_MS - 5000).toISOString();
    const r1 = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at: tooSoon });
    expect(r1.status).toBe(422);
    expect((await r1.json()).code).toBe('SCHEDULE_TOO_SOON');

    const exactly = new Date(now + MIN_LEAD_MS).toISOString();
    const r2 = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at: exactly });
    expect(r2.status).toBe(201);
  });

  it('V4: `at` beyond MAX_HORIZON is refused SCHEDULE_TOO_FAR', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const now = Date.parse('2026-07-12T12:00:00.000Z');
    __setNow(() => now);

    const tooFar = new Date(now + MAX_HORIZON_MS + 60_000).toISOString();
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at: tooFar });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_TOO_FAR');
  });

  it('V5: an omitted endAt is stamped `at + DEFAULT_WINDOW_MS` and PERSISTED — the store never holds an endAt-less window from a fresh submit', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const now = Date.parse('2026-07-12T12:00:00.000Z');
    __setNow(() => now);

    const at = new Date(now + MIN_LEAD_MS).toISOString();
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schedule).toEqual({ kind: 'window', at, endAt: new Date(Date.parse(at) + DEFAULT_WINDOW_MS).toISOString() });
  });

  it('V5: an explicit endAt spanning more than 24h is refused SCHEDULE_INVALID', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const now = Date.parse('2026-07-12T12:00:00.000Z');
    __setNow(() => now);

    const at = new Date(now + MIN_LEAD_MS).toISOString();
    const endAt = new Date(Date.parse(at) + MAX_WINDOW_MS + 60_000).toISOString();
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at, endAt });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SCHEDULE_INVALID');
  });

  it('V6: a non-canonical-but-valid offset `at` is normalized to canonical UTC in storage', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const now = Date.parse('2026-07-12T12:00:00.000Z');
    __setNow(() => now);

    const atMs = now + 2 * 60 * 60 * 1000;
    const nonCanonical = new Date(atMs).toISOString().replace('Z', '+00:00');
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at: nonCanonical });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schedule.at).toBe(new Date(atMs).toISOString());
  });

  it('a valid window submit still succeeds end-to-end (wiring order sanity)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const now = Date.parse('2026-07-12T12:00:00.000Z');
    __setNow(() => now);

    const at = new Date(now + 3600_000).toISOString();
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { kind: 'window', at });
    expect(res.status).toBe(201);
  });
});
