import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { seed, seedRequests, sessionCookieFor, setSetting } from './helpers/seed';

/**
 * maxOpen quota vs the request-status lifecycle (coordinator scope addition to
 * the 0021 lane wave). `middleware/rateLimit.ts` keeps its OWN open-status list,
 * separate from requests.ts's approve/reject OPEN_STATUSES — when Lane A's
 * G1 work added `APPROVED_COOLING` (interim quorum met, awaiting
 * `earliestApplyAt`) and `CANCELLED`, this list silently stopped counting a
 * cooling request against its requester's maxOpen quota, letting a requester
 * queue unbounded cooling requests. These tests pin the quota semantics per
 * status:
 *
 *   counts   — AWAITING_CODE_REVIEW (in-flight), APPROVED_COOLING (approved
 *              but NOT yet applied: still occupying reviewer/deploy attention
 *              until the window elapses or it is cancelled)
 *   released — CANCELLED (terminal), APPLIED (terminal)
 */

const DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function submit(app: Hono<AppEnv>, cookie: string, body: unknown) {
  return app.request('/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
    body: JSON.stringify(body),
  });
}

/** Estate with maxOpen=1 and exactly ONE pre-existing request for sari in `status`. */
async function setupWithOne(status: string): Promise<{ app: Hono<AppEnv>; store: ConfigStore; sari: string }> {
  const store = new MemoryStore();
  await seed(store);
  await setSetting(store, 'sample', 'rate.limits', { maxOpen: 1 }); // submissionsPerHour keeps its default (50)
  await seedRequests(store, 'sample', 'sari', 1, { status });
  const app = createApp(store);
  return { app, store, sari: await sessionCookieFor(store, 'sari') };
}

describe('maxOpen quota: which request statuses occupy a slot', () => {
  it('an APPROVED_COOLING request still counts toward maxOpen — cooling is not a quota escape', async () => {
    const { app, sari } = await setupWithOne('APPROVED_COOLING');
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('control: a classic open status (AWAITING_CODE_REVIEW) fills the quota the same way', async () => {
    const { app, sari } = await setupWithOne('AWAITING_CODE_REVIEW');
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
  });

  it('a CANCELLED request does NOT count — terminal statuses release the slot', async () => {
    const { app, sari } = await setupWithOne('CANCELLED');
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(201); // quota free again: the cancel released it
  });

  it('an APPLIED request does NOT count either (existing terminal-status behaviour, pinned)', async () => {
    const { app, sari } = await setupWithOne('APPLIED');
    const res = await submit(app, sari, DRAFT);
    expect(res.status).toBe(201);
  });

  it("the quota is per-requester: sari's APPROVED_COOLING request does not consume budi's slot", async () => {
    const { app, store } = await setupWithOne('APPROVED_COOLING');
    const budi = await sessionCookieFor(store, 'budi');
    const res = await submit(app, budi, DRAFT);
    expect(res.status).toBe(201);
  });
});
