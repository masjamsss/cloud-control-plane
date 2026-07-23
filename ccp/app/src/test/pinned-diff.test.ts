import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import { createMockApiClient, type ApiClient } from '@/lib/api';
import { manifests } from '@/data/manifests';
import { getOperation } from '@/lib/interpreter';
import { generateDiff } from '@/lib/diff';

/**
 * LEARN-4: the diff the approver sees must be the one pinned at submit, not a diff
 * regenerated later from mutable inventory. These assert the pin is captured and
 * persisted on the request record.
 */

function draft(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'pin-01',
    requester: 'dewi',
    teamId: 'erp-basis',
    service: 'ebs',
    operationId: 'ebs-grow',
    macd: 'Change',
    targetAddress: 'aws_ebs_volume.erp_app03_data',
    params: { volume: 'aws_ebs_volume.erp_app03_data', new_size_gib: 200 },
    justification: 'grow for month-end',
    exposure: 'l1_with_guardrails',
    risk: 'MEDIUM',
    status: 'DRAFT',
    createdAt: '', updatedAt: '', events: [],
    ...overrides,
  };
}

/** Submit and unwrap the SubmitResult to its ChangeRequest (throws on rejection). */
async function submit(client: ApiClient, d: ChangeRequest): Promise<ChangeRequest> {
  const res = await client.submitRequest(d);
  if (!res.ok) throw new Error(res.reason);
  return res.request;
}

describe('pinned diff', () => {
  it('captures the generated diff on the request at submit', async () => {
    const api = createMockApiClient();
    const submitted = await submit(api, draft());
    const op = getOperation('ebs-grow', manifests)!;
    const inv = await api.getInventory();
    expect(submitted.pinnedDiff).toBeTruthy();
    // The pin equals the diff generated from the op + params at submit time.
    expect(submitted.pinnedDiff).toBe(generateDiff(op, submitted.params, inv));
    expect(submitted.pinnedDiff).toContain('size_gib');
  });

  it('persists the pin so a later fetch returns the identical bytes', async () => {
    const api = createMockApiClient();
    const submitted = await submit(api, draft({ id: 'pin-02' }));
    const fetched = await api.getRequest(submitted.id);
    expect(fetched?.pinnedDiff).toBe(submitted.pinnedDiff);
  });

  it('pins engineer-only requests too', async () => {
    const api = createMockApiClient();
    const submitted = await submit(api, draft({ id: 'pin-03', exposure: 'engineer_only' }));
    expect(submitted.status).toBe('NEEDS_ENGINEER');
    expect(submitted.pinnedDiff).toBeTruthy();
  });
});
