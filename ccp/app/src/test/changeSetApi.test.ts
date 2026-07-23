import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeSetDraft } from '@/types';
import { createHttpApiClient } from '@/lib/httpApi';
import { createMockApiClient } from '@/lib/api';
import { resetSettingsForTests, setOpDisabled } from '@/lib/settings';

/**
 * The `submitChangeSet` seam (Phase B) on BOTH clients:
 *   - the HTTP client posts the identity-free `{items, justification, schedule}` to the SAME
 *     POST /requests, carries credentials + the CSRF header, and surfaces the atomic
 *     rejection codes the server returns;
 *   - the MOCK stand-in mirrors the server's fail-closed gates (atomic) and the
 *     STRICTEST-combined requirement, so the standalone app behaves like the authority.
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}

function fakeFetch(handler: (call: Call) => { status: number; body?: unknown }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
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
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const DRAFT: ChangeSetDraft = {
  items: [
    { operationId: 'ebs-grow', targetAddress: 'aws_ebs_volume.a', params: { volume: 'aws_ebs_volume.a', new_size_gib: 250 } },
    { operationId: 'ebs-grow', targetAddress: 'aws_ebs_volume.b', params: { volume: 'aws_ebs_volume.b', new_size_gib: 250 } },
  ],
  justification: 'grow both ERP data volumes for the month-end batch window',
  schedule: { kind: 'now' },
};

describe('httpApi — submitChangeSet posts the change set to POST /requests', () => {
  it('sends {items, justification, schedule}, credentials + the CSRF header; 201 → ok:true', async () => {
    const created = { id: '01J-set', requester: 'sari', items: DRAFT.items, status: 'AWAITING_CODE_REVIEW' };
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: created }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.submitChangeSet(DRAFT);
    expect(result).toEqual({ ok: true, request: created });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/requests', method: 'POST', credentials: 'include' });
    expect(calls[0]!.headers['x-ccp-client']).toBe('ccp-spa');
    expect(calls[0]!.body).toMatchObject({
      items: [
        { operationId: 'ebs-grow', targetAddress: 'aws_ebs_volume.a', params: { volume: 'aws_ebs_volume.a', new_size_gib: 250 } },
        { operationId: 'ebs-grow', targetAddress: 'aws_ebs_volume.b', params: { volume: 'aws_ebs_volume.b', new_size_gib: 250 } },
      ],
      justification: DRAFT.justification,
      schedule: { kind: 'now' },
    });
    // Never sends an identity or a status — the server computes them.
    expect(calls[0]!.body).not.toHaveProperty('requester');
    expect(calls[0]!.body).not.toHaveProperty('status');
  });

  it('forwards a forces-replace item’s confirmation, and only when present', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: { id: 'x' } }));
    const client = createHttpApiClient('', { fetch });
    await client.submitChangeSet({
      items: [
        { operationId: 'ebs-grow', targetAddress: 'aws_ebs_volume.a', params: {} },
        { operationId: 'ebs-set-encrypted', targetAddress: 'aws_ebs_volume.b', params: {}, replaceConfirmation: 'aws_ebs_volume.b' },
      ],
      justification: 'encrypt one volume alongside a grow',
      schedule: { kind: 'now' },
    });
    const items = (calls[0]!.body as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]).not.toHaveProperty('replaceConfirmation');
    expect(items[1]!.replaceConfirmation).toBe('aws_ebs_volume.b');
  });

  it('a 422 PARAM_OUT_OF_BOUNDS (one bad item, atomic) → ok:false code OUT_OF_BOUNDS', async () => {
    const { fetch } = fakeFetch(() => ({ status: 422, body: { code: 'PARAM_OUT_OF_BOUNDS', reason: 'A value is out of bounds.' } }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.submitChangeSet(DRAFT);
    expect(result).toEqual({ ok: false, code: 'OUT_OF_BOUNDS', reason: 'A value is out of bounds.' });
  });

  it('a 423 GLOBAL_FREEZE → ok:false code FROZEN', async () => {
    const { fetch } = fakeFetch(() => ({ status: 423, body: { code: 'GLOBAL_FREEZE', reason: 'Changes are frozen.' } }));
    const client = createHttpApiClient('', { fetch });
    const result = await client.submitChangeSet(DRAFT);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'FROZEN' });
  });
});

describe('mock submitChangeSet — atomic gates + strictest combined requirement', () => {
  afterEach(resetSettingsForTests);

  it('two guardrails items → one combined request, required 2, items populated', async () => {
    const client = createMockApiClient();
    const res = await client.submitChangeSet(DRAFT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.request.approvalsRequired).toBe(2);
    expect(res.request.items).toHaveLength(2);
    expect(res.request.status).toBe('AWAITING_CODE_REVIEW');
  });

  it('the strictest item wins: self-service + guardrails → required 2', async () => {
    const client = createMockApiClient();
    const res = await client.submitChangeSet({
      items: [
        { operationId: 'cloudwatch-alarm-threshold', targetAddress: 'aws_cloudwatch_metric_alarm.x', params: { alarm: 'aws_cloudwatch_metric_alarm.x', new_threshold: 80 } },
        { operationId: 'ebs-grow', targetAddress: 'aws_ebs_volume.a', params: { volume: 'aws_ebs_volume.a', new_size_gib: 250 } },
      ],
      justification: 'raise an alarm threshold and grow a volume together',
      schedule: { kind: 'now' },
    });
    expect(res.ok && res.request.approvalsRequired).toBe(2);
  });

  it('a forces-replace item floors the set to the engineer track (NEEDS_ENGINEER)', async () => {
    const client = createMockApiClient();
    const res = await client.submitChangeSet({
      items: [
        { operationId: 'ebs-grow', targetAddress: 'aws_ebs_volume.a', params: {} },
        { operationId: 'ebs-set-encrypted', targetAddress: 'aws_ebs_volume.b', params: {}, replaceConfirmation: 'aws_ebs_volume.b' },
      ],
      justification: 'encrypt one volume alongside a grow — needs an engineer',
      schedule: { kind: 'now' },
    });
    expect(res.ok && res.request.status).toBe('NEEDS_ENGINEER');
  });

  it('ATOMIC: a disabled op in the set rejects the WHOLE set (nothing submitted)', async () => {
    setOpDisabled('ebs-grow', true);
    const client = createMockApiClient();
    const res = await client.submitChangeSet(DRAFT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('OP_DISABLED');
  });

  it('a single-item set normalizes to a single-op request (no items list)', async () => {
    const client = createMockApiClient();
    const res = await client.submitChangeSet({
      items: [{ operationId: 'ebs-grow', targetAddress: 'aws_ebs_volume.a', params: {} }],
      justification: 'grow a single volume via the change-set path',
      schedule: { kind: 'now' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.request.items).toBeUndefined();
    expect(res.request.operationId).toBe('ebs-grow');
  });
});
