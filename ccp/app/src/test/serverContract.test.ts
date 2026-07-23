import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import { createMockApiClient, noCapabilities, SERVER_FLOWS } from '@/lib/api';
import { createHttpApiClient } from '@/lib/httpApi';
import { resetSettingsForTests, setChangeFreeze, setOpDisabled } from '@/lib/settings';

/**
 * The shared §1.1 contract both clients implement: `serverInfo()` (advisory vs
 * authoritative) and the `SubmitResult`-shaped submit that surfaces a server-side
 * rejection. These exercise it against the MOCK (no network) — the HTTP client's
 * real login→session flow is proven in httpApi.integration.test.ts.
 */

function draft(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'sc-01',
    requester: 'dewi',
    teamId: 'erp-basis',
    service: 'ebs',
    operationId: 'ebs-grow',
    macd: 'Change',
    targetAddress: 'aws_ebs_volume.erp_app03_data',
    params: { volume: 'aws_ebs_volume.erp_app03_data', new_size_gib: 200 },
    justification: 'grow the volume for month-end load',
    exposure: 'l1_with_guardrails',
    risk: 'MEDIUM',
    status: 'DRAFT',
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
    events: [{ at: '2026-07-10T00:00:00Z', type: 'created', label: 'drafted', actor: 'dewi' }],
    ...overrides,
  };
}

afterEach(resetSettingsForTests);

/** The flows ccp-api's admin surface now serves AND lib/httpApi carries a
 * real call for: audit read/export, teams CRUD, the users accounts surface
 * (0014 P1 #4 + B1), the five estate-governance flows (policy, risk +
 * catalog toggle, settings incl. freeze/allowlist/rate-limits, the §6
 * dual-control queue), and — since W5/N2 grew ccp-api's /projects
 * registry + trust surface — projects too. Every gate-able flow is served. */
const SERVED_BY_HTTP_CLIENT = new Set<(typeof SERVER_FLOWS)[number]>([
  'audit',
  'teams',
  'users',
  'policy',
  'risk',
  'settings',
  'pendingChanges',
  'projects',
]);

describe('serverInfo — per-flow capabilities (§1.1 / 0015 §B3 / 0014 P1 #4)', () => {
  it('the mock reports mode:mock and serves no admin flow (client-forgeable stores)', async () => {
    expect(await createMockApiClient().serverInfo()).toEqual({
      mode: 'mock',
      capabilities: noCapabilities(),
    });
  });

  it('the http client reports mode:api and serves every gated admin flow, projects included (W5/N2)', async () => {
    // ccp-api's admin surface serves audit reads, full teams CRUD, the
    // accounts CRUD + TOTP/session slice, the approval policy, risk overrides +
    // catalog enable/disable, the settings it reads back (freeze / disabled-ops /
    // rate limits / allowlist restrictions), the dual-control queue, and now the
    // /projects registry + onboarding trust surface — and this client carries
    // each call.
    expect(await createHttpApiClient('').serverInfo()).toEqual({
      mode: 'api',
      capabilities: {
        ...noCapabilities(),
        audit: true,
        teams: true,
        users: true,
        policy: true,
        risk: true,
        settings: true,
        pendingChanges: true,
        projects: true,
      },
    });
  });

  it('the honesty invariant: a flag is true ONLY for a flow whose write/read now reaches the server', async () => {
    // Mock: unchanged — its stores are client-forgeable, so nothing is ever
    // authoritative there. Http client: exactly the served set is true. An
    // exact per-flow match — not just "not all false" — so a regression in
    // EITHER direction (a served flow silently left false, or an unserved one
    // wrongly flipped true) fails this test.
    const expectations = [
      { client: createMockApiClient(), served: new Set<(typeof SERVER_FLOWS)[number]>() },
      { client: createHttpApiClient(''), served: SERVED_BY_HTTP_CLIENT },
    ];
    for (const { client, served } of expectations) {
      const { capabilities } = await client.serverInfo();
      for (const flow of SERVER_FLOWS) {
        expect(
          capabilities[flow],
          `${flow}: a control may go live only when its write reaches the server`,
        ).toBe(served.has(flow));
      }
    }
  });
});

describe('submitRequest returns a SubmitResult (§1.1) — the mock enforces the server gates', () => {
  it('a normal submit succeeds: ok:true with the created request', async () => {
    const res = await createMockApiClient().submitRequest(draft());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.request.status).toBe('AWAITING_CODE_REVIEW');
  });

  it('a frozen estate rejects: ok:false, code FROZEN', async () => {
    setChangeFreeze(true);
    const res = await createMockApiClient().submitRequest(draft());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('FROZEN');
      expect(res.reason).toMatch(/frozen/i);
    }
  });

  it('a disabled operation rejects: ok:false, code OP_DISABLED', async () => {
    setOpDisabled('ebs-grow', true);
    const res = await createMockApiClient().submitRequest(draft());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('OP_DISABLED');
  });
});
