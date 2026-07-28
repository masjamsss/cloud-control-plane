import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * ARCH-1 — the apply bundle acted on requests that had never been approved.
 *
 * `BUNDLE_ELIGIBLE` was `{AWAITING_CODE_REVIEW, AWAITING_DEPLOY_APPROVAL}` under a comment
 * claiming "fully approved … a pre-quorum request is refused". But `AWAITING_CODE_REVIEW`
 * **is** the pre-quorum status: `initialStatusFor` puts every fresh non-engineer submission
 * there, and the approve handler moves a quorum-met request *out* of it. The handler
 * checked role, freeze, status and bundle state, and never `approvals.length` against the
 * ladder.
 *
 * So on an armed deployment, a Lead or admin calling `POST /requests/:id/apply` on a
 * ZERO-APPROVAL request ran the whole bundle: gate, commit to `main`, deploy-gate trigger.
 * The only remaining defence was whatever the operator wired into `CCP_BUNDLE_GATE_CMD` —
 * and the shipped `UNAPPROVED` refusal lives in `pr-prepare`, not in the documented
 * drift-edit/plan-check gate recipe. That voids ADR-0016's premise that the portal ladder
 * IS the human review of the change.
 *
 * The finding notes the tell, and it is worth repeating: the existing suite's own
 * "pre-quorum is refused" case has to flip the seeded row to `NEEDS_ENGINEER` first,
 * *precisely because* `AWAITING_CODE_REVIEW` would not have been refused. The un-flipped
 * case — the one the finding asks for — is the first test below.
 */

const ENV_KEYS = ['CCP_BUNDLE', 'CCP_GIT_REMOTE', 'CCP_GIT_BRANCH', 'CCP_BUNDLE_GATE_CMD', 'CCP_BUNDLE_TRIGGER_CMD'] as const;
const saved: Record<string, string | undefined> = {};
const temps: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps.length = 0;
});

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A bare origin with one commit, plus a gate that RECORDS whether it ran. */
function arm(): { gateMarker: string } {
  const root = mkdtempSync(join(tmpdir(), 'bundle-quorum-'));
  temps.push(root);
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  const gateMarker = join(root, 'gate-ran');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' });
  writeFileSync(join(work, 'README.md'), 'seed\n');
  g(work, 'add', '-A');
  g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed');
  g(work, 'push', 'origin', 'HEAD:refs/heads/main');
  Object.assign(process.env, {
    CCP_BUNDLE: '1',
    CCP_GIT_REMOTE: bare,
    // The gate leaves a file behind, so a test can assert the bundle NEVER STARTED rather
    // than only that the response was a 409. A refusal that still ran the gate would be a
    // refusal in name only.
    CCP_BUNDLE_GATE_CMD: `touch ${gateMarker}`,
    CCP_BUNDLE_TRIGGER_CMD: 'true',
  });
  return { gateMarker };
}

async function seededApp(over: Partial<RequestItem>): Promise<{
  store: ConfigStore;
  app: ReturnType<typeof createApp>;
  id: string;
}> {
  const store = new MemoryStore();
  await seed(store);
  await seedRequests(store, 'sample', 'sari', 1, {
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    approvalsRequired: 2,
    ...over,
  });
  return { store, app: createApp(store), id: 'seed-sari-0' };
}

const post = async (app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<Response> =>
  app.request(`/requests/${id}/apply`, {
    method: 'POST',
    headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' },
  });

const FULL = [
  { user: 'budi', at: '2026-07-01T00:00:00.000Z' },
  { user: 'lina', at: '2026-07-02T00:00:00.000Z' },
];

describe('the bundle acts only on a fully approved request (ARCH-1)', () => {
  it('THE DEFECT: AWAITING_CODE_REVIEW with ZERO approvals is refused, and the gate never runs', async () => {
    // The un-flipped case the finding asks for. Against the unfixed handler this returned
    // 200/502 and had already committed to main.
    const { gateMarker } = arm();
    const { store, app, id } = await seededApp({ status: 'AWAITING_CODE_REVIEW', approvals: [] });

    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason: string };
    expect(body.reason, 'the refusal must say how short it is').toMatch(/0 of \d+ required approvals/);

    const { existsSync } = await import('node:fs');
    expect(existsSync(gateMarker), 'the bundle must not have started at all').toBe(false);
  });

  it('refuses a PARTIALLY approved request — one short is still short', async () => {
    const { gateMarker } = arm();
    const { store, app, id } = await seededApp({
      status: 'AWAITING_CODE_REVIEW',
      approvals: [{ user: 'budi', at: '2026-07-01T00:00:00.000Z' }],
    });

    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status).toBe(409);
    const { existsSync } = await import('node:fs');
    expect(existsSync(gateMarker)).toBe(false);
  });

  it('the refusal does not depend on the status — a pre-quorum AWAITING_DEPLOY_APPROVAL is refused too', async () => {
    // Status was never the quorum signal, which is the whole point. A row that reached the
    // deploy-approval status some other way must still be counted, not trusted.
    const { gateMarker } = arm();
    const { store, app, id } = await seededApp({ status: 'AWAITING_DEPLOY_APPROVAL', approvals: [] });

    expect((await post(app, await sessionCookieFor(store, 'lina'), id)).status).toBe(409);
    const { existsSync } = await import('node:fs');
    expect(existsSync(gateMarker)).toBe(false);
  });

  it('a FULLY approved request still runs — the gate must not become unusable', async () => {
    // The failure mode of an over-strict fix: nothing can ever be applied. The bundle is
    // allowed to fail here (no real gate recipe); what matters is that it STARTED.
    const { gateMarker } = arm();
    const { store, app, id } = await seededApp({ status: 'AWAITING_DEPLOY_APPROVAL', approvals: FULL });

    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    expect(res.status, 'a fully approved request must not be refused').not.toBe(409);
    const { existsSync } = await import('node:fs');
    expect(existsSync(gateMarker), 'the bundle ran').toBe(true);
  });

  it('counts against the LIVE ladder, not the count frozen on the row', async () => {
    // `currentRequirement` is the same tighten-only helper approve uses, so a tier raised
    // after submission applies here too. Trusting the row's own `approvalsRequired` would
    // let a request approved under a laxer ladder through on its old count.
    const { store, app, id } = await seededApp({
      status: 'AWAITING_DEPLOY_APPROVAL',
      approvals: [{ user: 'budi', at: '2026-07-01T00:00:00.000Z' }],
      approvalsRequired: 1, // the row claims it only ever needed one
    });
    arm();

    const res = await post(app, await sessionCookieFor(store, 'lina'), id);
    const k = requestKey('sample', id);
    const row = (await store.get(k.PK, k.SK)) as RequestItem;
    // ebs-grow is l1_with_guardrails, whose live ladder needs more than one signature.
    expect(row.approvals.length).toBeLessThan(2);
    expect(res.status, 'the row’s own claim must not override the live ladder').toBe(409);
  });
});
