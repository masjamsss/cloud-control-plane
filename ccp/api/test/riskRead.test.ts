import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', 'x-ccp-project': 'sample' };

function get(app: Hono<AppEnv>, cookie: string, path: string) {
  return app.request(path, { headers: { cookie, 'x-ccp-project': 'sample' } });
}
function put(app: Hono<AppEnv>, cookie: string, path: string, body: unknown) {
  return app.request(path, { method: 'PUT', headers: { ...CH, cookie }, body: JSON.stringify(body) });
}
function del(app: Hono<AppEnv>, cookie: string, path: string) {
  return app.request(path, { method: 'DELETE', headers: { ...CH, cookie } });
}
function post(app: Hono<AppEnv>, cookie: string, path: string) {
  return app.request(path, { method: 'POST', headers: { ...CH, cookie } });
}

async function setup(): Promise<{ app: Hono<AppEnv>; store: ConfigStore; admin: string; sari: string }> {
  const store = new MemoryStore();
  await seed(store); // putra=admin lead, sari=requester, budi=approver, lina=lead
  const app = createApp(store);
  return { app, store, admin: await sessionCookieFor(store, 'putra'), sari: await sessionCookieFor(store, 'sari') };
}

/**
 * GET /admin/risk — OpenAPI declared it ("All overrides, riskOverrides.ts map
 * shape") but admin.ts never routed it (404), the same class of gap as the
 * teams CRUD fixed earlier. It is the risk flow's only read path: without it
 * the SPA can PUT/DELETE an override but never render the server's persisted
 * truth after a reload.
 */
describe('GET /admin/risk — the overrides map (was OpenAPI-declared but unrouted → 404)', () => {
  it('starts empty: no overrides → {}', async () => {
    const { app, admin } = await setup();
    const res = await get(app, admin, '/admin/risk');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('an applied (tightening) override appears in the map, keyed by opId', async () => {
    const { app, admin } = await setup();
    // cloudwatch-alarm-threshold has manifest floor LOW → raising to HIGH tightens → applies now.
    const putRes = await put(app, admin, '/admin/risk/cloudwatch-alarm-threshold', { risk: 'HIGH' });
    expect(putRes.status).toBe(200);

    const map = await (await get(app, admin, '/admin/risk')).json();
    expect(map).toEqual({ 'cloudwatch-alarm-threshold': 'HIGH' });
  });

  it('a pending (dual-controlled) reduction does NOT appear until a second admin acks', async () => {
    const { app, store, admin } = await setup();
    await seedAccount(store, { id: 'gita', role: 'lead', teamId: 'platform', isAdmin: true });
    await put(app, admin, '/admin/risk/cloudwatch-alarm-threshold', { risk: 'HIGH' }); // applied
    // HIGH → LOW is a reduction → 202 PendingConfigChange, not an applied override.
    const reduce = await put(app, admin, '/admin/risk/cloudwatch-alarm-threshold', { risk: 'LOW' });
    expect(reduce.status).toBe(202);
    const pending = (await reduce.json()) as { id: string };

    // Still HIGH while the reduction awaits its second admin.
    expect(await (await get(app, admin, '/admin/risk')).json()).toEqual({
      'cloudwatch-alarm-threshold': 'HIGH',
    });

    // A second, DISTINCT admin acks → the reduction lands and the map reflects it.
    const gita = await sessionCookieFor(store, 'gita');
    expect((await post(app, gita, `/admin/config-changes/${pending.id}/ack`)).status).toBe(200);
    expect(await (await get(app, admin, '/admin/risk')).json()).toEqual({
      'cloudwatch-alarm-threshold': 'LOW',
    });
  });

  it('clearing an override (tightening direction) removes it from the map', async () => {
    const { app, admin } = await setup();
    // ebs-grow floor is MEDIUM; override to HIGH (tightening → applied)…
    await put(app, admin, '/admin/risk/ebs-grow', { risk: 'HIGH' });
    expect(await (await get(app, admin, '/admin/risk')).json()).toEqual({ 'ebs-grow': 'HIGH' });
    // …then DELETE clears back to the MEDIUM floor. HIGH→MEDIUM is a reduction → 202,
    // so the override must STILL be visible (clear is pending, not applied).
    const clr = await del(app, admin, '/admin/risk/ebs-grow');
    expect(clr.status).toBe(202);
    expect(await (await get(app, admin, '/admin/risk')).json()).toEqual({ 'ebs-grow': 'HIGH' });
  });

  it('requires the admin capability (requester → 403 NOT_ADMIN) and a session (401 without one)', async () => {
    const { app, sari } = await setup();
    const asRequester = await get(app, sari, '/admin/risk');
    expect(asRequester.status).toBe(403);
    expect((await asRequester.json()).code).toBe('NOT_ADMIN');

    const anonymous = await app.request('/admin/risk');
    expect(anonymous.status).toBe(401);
  });
});
