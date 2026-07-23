import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import { accountKey, accountsGsi, type AccountItem } from '../src/store/schema';
import { canonicalJson } from '../src/domain/audit';
import { CONTROL_SCOPE, __resetKnownProjectsForTests, isKnownProject } from '../src/projects';
import { bootstrap } from '../scripts/bootstrap';
import { sessionCookieFor } from './helpers/seed';

/**
 * data-birth spec §12 lane A acceptance — "a fresh store with a founding
 * declaration reaches 'first estate ready' with no hardcoded id anywhere in
 * api/src". This suite boots a store the way a REAL fresh install does
 * (scripts/bootstrap.ts — never test/helpers/seed.ts's estate fixture) and
 * proves: the instance is ready with ZERO estates, the registry is usable from
 * the reserved `@control` scope by a founding ('*'-bound) admin, and the first
 * account reaches `ready` purely through the existing onboarding ladder — no
 * rebuild, no redeploy (the same `app`/`store` instance throughout).
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const digest = (v: unknown): string => sha256(canonicalJson(v));
const COMMIT = 'abc123def4567890abc123def4567890abc123de';

const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' };

/** A second founding admin, bound via `'*'` exactly like scripts/bootstrap.ts's
 * founder — mirrors what the sibling governance-birth spec's founding ladder
 * seats (declared quorum, all bound on `'*'`); this lane does not build that
 * ladder, so the second admin is seeded directly in that same canonical shape. */
async function seedSecondFounder(store: ConfigStore, id: string): Promise<void> {
  const item: AccountItem = {
    ...accountKey(id),
    id,
    username: id,
    displayName: id,
    roles: { '*': { role: 'lead' } },
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: true,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    totp: { secretEnc: 'enc', enrolledAt: '2026-07-11T00:00:00.000Z' },
    GSI1PK: accountsGsi(),
    GSI1SK: id,
  };
  await store.put(item);
}

function reportText(): string {
  return `${JSON.stringify(
    { repo: 'terraform-first', verdict: 'clean', findings: [], resourceBlocks: 5, moduleBlocks: 0, tfJsonFiles: 0, fmtDirtyFiles: 0, providerPins: { aws: '~> 6.0' } },
    null,
    2,
  )}\n`;
}

function bundle(): Record<string, unknown> {
  const inventory = {
    generatedAt: '2026-07-21T00:00:00.000Z',
    sourceCommit: COMMIT,
    source: 'scan of terraform-first environments/prod',
    resources: [{ address: 'aws_instance.web', resourceType: 'aws_instance', name: 'web', service: 'ec2', attributes: { instance_type: 't3.micro' } }],
  };
  const blocks = {
    index: { 'aws_instance.web': 'main' },
    chunks: { main: { 'aws_instance.web': { file: 'main.tf', line: 1, source: 'resource "aws_instance" "web" {}' } } },
  };
  const manifests = [{ service: 'ec2', scope: 'estate', resourceTypes: ['aws_instance'], summary: 'EC2 ops.', operations: [{ id: 'ec2-resize', service: 'ec2', macd: 'Change' }] }];
  return {
    digests: { inventorySha256: digest(inventory), blocksSha256: digest(blocks), manifestsSha256: digest(manifests) },
    inventory,
    blocks,
    manifests,
    summary: { providerPins: { aws: '~> 6.0' } },
  };
}

/** A genuinely blank install: `scripts/bootstrap.ts` (the real first-boot path,
 * never test/helpers/seed.ts's estate fixture) plus a second founding admin so
 * the ladder's 2-admin envelopes are feasible. Clears the founder's one-time
 * `mustChangePassword` flag directly — the runbook's own Phase 2 ("have them log
 * in and change it first"), a separate, already-covered concern (bootstrap.test.ts)
 * this suite does not need to re-walk to test the registry/ladder. */
async function blankInstall(): Promise<{ store: ConfigStore; app: ReturnType<typeof createApp>; founder: string; second: string }> {
  __resetKnownProjectsForTests();
  const store = new MemoryStore();
  const res = await bootstrap(store, { print: () => {} });
  expect(res.ok).toBe(true);
  const founderKey = accountKey('putra');
  const founderAcc = (await store.get(founderKey.PK, founderKey.SK)) as AccountItem;
  await store.put({ ...founderAcc, mustChangePassword: false });
  await seedSecondFounder(store, 'second');
  const app = createApp(store);
  return { store, app, founder: await sessionCookieFor(store, 'putra'), second: await sessionCookieFor(store, 'second') };
}

describe('blankInstall — a fresh store reaches "first estate ready" via the real ladder (data-birth spec §12 lane A)', () => {
  describe('zero-project boot: /readyz is green with zero estates', () => {
    it('a founded, empty instance is ready — estates:0, chains carries only @control', async () => {
      const { app } = await blankInstall();
      const res = await app.request('/readyz');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ready).toBe(true);
      expect(body.accounts).toBe(2); // the two founders
      expect(body.estates).toBe(0);
      expect(body.chains).toEqual([expect.objectContaining({ projectId: CONTROL_SCOPE, verified: true })]);
      expect(body.reasons).toEqual([]);
    });

    it('grep-shaped acceptance: no hardcoded estate id anywhere the registry read path touches — KNOWN is exactly {@control}', () => {
      __resetKnownProjectsForTests();
      expect(isKnownProject(CONTROL_SCOPE)).toBe(true);
      expect(isKnownProject('sample')).toBe(false);
      expect(isKnownProject('acme')).toBe(false);
    });
  });

  describe('the registry is usable from @control by a \'*\' founding admin', () => {
    it('GET /projects (header-less → @control) returns the empty registry, not an error', async () => {
      const { app, founder } = await blankInstall();
      const res = await app.request('/projects', { headers: { cookie: founder } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('POST /projects (header-less → @control) registers the first draft — the registry itself is not estate-only', async () => {
      const { app, founder } = await blankInstall();
      const res = await app.request('/projects', {
        method: 'POST',
        headers: { ...CH, cookie: founder },
        body: JSON.stringify({ id: 'first', name: 'The first estate', accountId: '123456789012', region: 'ap-southeast-5', github: { owner: 'acme-co', repo: 'terraform-first' } }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.status).toBe('draft');
      // a draft grants nothing — not yet routable/known.
      expect(isKnownProject('first')).toBe(false);
    });
  });

  describe('the first account reaches "ready" purely through the existing onboarding ladder', () => {
    it('register → trust-request → trust (2-admin ack) → upload → activate (2-admin ack) → ready, routable, usable — no rebuild, no redeploy', async () => {
      const { app, founder, second } = await blankInstall();

      // 1. register (draft) — acting from @control, no estate existed before this.
      const reg = await app.request('/projects', {
        method: 'POST',
        headers: { ...CH, cookie: founder },
        body: JSON.stringify({ id: 'first', name: 'The first estate', accountId: '123456789012', region: 'ap-southeast-5', github: { owner: 'acme-co', repo: 'terraform-first' } }),
      });
      expect(reg.status).toBe(201);

      // 2. catalogctl onboard's local, credential-free artifact upload.
      const prescanReport = reportText();
      const trustReq = await app.request('/projects/first/trust-request', {
        method: 'PUT',
        headers: { ...CH, cookie: founder },
        body: JSON.stringify({ trustRequest: { repo: 'terraform-first', commitSha: COMMIT, prescanSha256: sha256(prescanReport) }, prescanReport }),
      });
      expect(trustReq.status).toBe(200);
      expect((await trustReq.json()).status).toBe('pending-trust');

      // 3. the dual-controlled trust decision: propose (founder) → ack (second founder).
      const propose = await app.request('/projects/first/trust', {
        method: 'POST',
        headers: { ...CH, cookie: founder },
        body: JSON.stringify({ commitSha: COMMIT, prescanSha256: sha256(prescanReport) }),
      });
      expect(propose.status).toBe(202);
      const pendingTrust = (await propose.json()) as { id: string };
      const ackTrust = await app.request(`/admin/config-changes/${pendingTrust.id}/ack`, { method: 'POST', headers: { ...CH, cookie: second } });
      expect(ackTrust.status).toBe(200);

      // Trusted, but STILL not routable — trust alone grants nothing (only data
      // activation does; §6's ladder).
      expect(isKnownProject('first')).toBe(false);

      // 4. mint an upload token, then the estate repo's CI uploads the data bundle
      // (token-authed — no cookie, no CSRF header; the sandbox contract stays local).
      const mintRes = await app.request('/projects/first/upload-tokens', {
        method: 'POST',
        headers: { ...CH, cookie: founder },
      });
      expect(mintRes.status).toBe(201);
      const { token } = (await mintRes.json()) as { token: string };
      const uploadRes = await app.request('/projects/first/data', {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(bundle()),
      });
      expect(uploadRes.status).toBe(201);

      // Staged, but serving nothing yet — activation is the ONLY transition to ready.
      expect(isKnownProject('first')).toBe(false);
      expect((await app.request('/projects/first/inventory', { headers: { cookie: founder } })).status).toBe(404);

      // 5. the FIRST data activation: propose (founder) → ack (second founder) = go-live.
      const activatePropose = await app.request('/projects/first/data/1/activate', {
        method: 'POST',
        headers: { ...CH, cookie: founder },
      });
      expect(activatePropose.status).toBe(202);
      const pendingActivate = (await activatePropose.json()) as { id: string };
      const ackActivate = await app.request(`/admin/config-changes/${pendingActivate.id}/ack`, { method: 'POST', headers: { ...CH, cookie: second } });
      expect(ackActivate.status).toBe(200);

      // Now ready: routable, listed, served — with NO rebuild/redeploy (same app).
      expect(isKnownProject('first')).toBe(true);
      const list = (await (await app.request('/projects', { headers: { cookie: founder } })).json()) as Array<{ id: string; status: string }>;
      expect(list.find((p) => p.id === 'first')?.status).toBe('ready');
      expect((await app.request('/projects/first/inventory', { headers: { cookie: founder } })).status).toBe(200);

      // /readyz now counts exactly one estate, alongside the control-plane chain.
      const ready = await (await app.request('/readyz')).json();
      expect(ready.ready).toBe(true);
      expect(ready.estates).toBe(1);
      expect(ready.chains.map((c: { projectId: string }) => c.projectId).sort()).toEqual([CONTROL_SCOPE, 'first'].sort());

      // and it is USABLE: a change can be submitted against it, acting with an
      // explicit x-ccp-project header (the estate scope, never @control).
      const submit = await app.request('/requests', {
        method: 'POST',
        headers: { ...CH, cookie: founder, 'x-ccp-project': 'first' },
        body: JSON.stringify({
          operationId: 'ec2-resize',
          targetAddress: 'aws_instance.web',
          params: { instance: 'aws_instance.web', new_instance_type: 'm5.large' },
          justification: 'prove the first estate is genuinely usable end to end',
          schedule: { kind: 'now' },
        }),
      });
      expect(submit.status).toBe(201);
    });
  });
});
