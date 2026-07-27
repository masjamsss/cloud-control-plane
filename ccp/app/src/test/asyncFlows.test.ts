import { describe, expect, it } from 'vitest';
import type { ChangeRequest, ChangeSetDraft } from '@/types';
import { NETWORK_FAILURE_MESSAGE } from '@/lib/asyncGuard';
import { approveRequestVia, rejectRequestVia } from '@/features/approvals/approvalsFlow';
import { submitChangeSetVia, submitRequestVia } from '@/features/request/submitFlow';
import { loadMyRequestsVia } from '@/features/requests/myRequestsFlow';

/**
 * FE-1 / FE-2 — the four flows that were stranding their own busy/loading state.
 *
 * Each screen used to write only a success branch: `setBusy(true)`, await, clear inside
 * the success path. A rejected `fetch` skipped the clear entirely, so the control stayed
 * disabled (or the page stayed on "Loading…") until a full reload — and on RequestForm
 * that reload DISCARDS the drafted request. These are the extracted, React-free halves,
 * and what is asserted is the same property for each: a rejection comes back as a
 * RENDERABLE RESULT, never as a rejection.
 *
 * The unreachable case is deliberately distinguishable from a server refusal
 * (`code: 'UNREACHABLE'`), because the two mean opposite things to a requester: a refusal
 * is final and needs a different draft, an unreachable server needs the same draft sent
 * again. A test pins that, since collapsing them would be an easy and invisible
 * simplification.
 *
 * No jsdom (see test/standalone.test.ts's dependency allowlist) and no `vi.fn` (see
 * authFlow.test.ts) — hand-rolled fakes and spies.
 */

const DROPPED = new TypeError('Failed to fetch'); // exactly what a failed fetch rejects with
const request = { id: 'req-1' } as ChangeRequest;

describe('approvalsFlow — a stuck Approve button is a change nobody can move', () => {
  it('approve: a rejected call becomes {ok:false, code:UNREACHABLE}, not a rejection', async () => {
    const result = await approveRequestVia({ approveRequest: () => Promise.reject(DROPPED) }, 'req-1');
    expect(result).toEqual({ ok: false, reason: NETWORK_FAILURE_MESSAGE, code: 'UNREACHABLE' });
  });

  it('approve: passes a server refusal through untouched — its reason and code are better than ours', async () => {
    const refusal = { ok: false as const, reason: 'You already approved this change.', code: 'DUPLICATE_APPROVAL' };
    const result = await approveRequestVia({ approveRequest: () => Promise.resolve(refusal) }, 'req-1');
    expect(result).toEqual(refusal);
  });

  it('approve: passes success through', async () => {
    const result = await approveRequestVia({ approveRequest: () => Promise.resolve({ ok: true, request }) }, 'req-1');
    expect(result).toEqual({ ok: true, request });
  });

  it('reject: same guarantee, and the optional reason still reaches the client', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const result = await rejectRequestVia(
      {
        rejectRequest: (id: string, reason?: string) => {
          seen.push([id, reason]);
          return Promise.reject(DROPPED);
        },
      },
      'req-1',
      'not this quarter',
    );
    expect(seen).toEqual([['req-1', 'not this quarter']]);
    expect(result).toEqual({ ok: false, reason: NETWORK_FAILURE_MESSAGE, code: 'UNREACHABLE' });
  });
});

describe('submitFlow — a stuck "Submitting…" loses the whole drafted request', () => {
  const draft = { id: 'draft-1' } as ChangeRequest;

  it('a rejected submit becomes UNREACHABLE, so the requester can press Submit again', async () => {
    const result = await submitRequestVia({ submitRequest: () => Promise.reject(DROPPED) }, () => {}, draft);
    expect(result).toEqual({ ok: false, reason: NETWORK_FAILURE_MESSAGE, code: 'UNREACHABLE' });
  });

  it('does NOT navigate when the call fails — the draft must stay on screen', async () => {
    // Navigating away on a failed submit would destroy the draft as surely as the
    // reload did. This is the assertion that keeps the failure path on the form.
    const went: string[] = [];
    await submitRequestVia({ submitRequest: () => Promise.reject(DROPPED) }, (p) => went.push(p), draft);
    expect(went).toEqual([]);
  });

  it('does NOT navigate on a server REFUSAL either — nothing was created to navigate to', async () => {
    const went: string[] = [];
    const refusal = { ok: false as const, reason: 'Changes are frozen.', code: 'FROZEN' as const };
    const result = await submitRequestVia({ submitRequest: () => Promise.resolve(refusal) }, (p) => went.push(p), draft);
    expect(went).toEqual([]);
    expect(result).toEqual(refusal);
  });

  it('navigates to the created request on success', async () => {
    const went: string[] = [];
    await submitRequestVia({ submitRequest: () => Promise.resolve({ ok: true, request }) }, (p) => went.push(p), draft);
    expect(went).toEqual(['/requests/req-1']);
  });

  it('change-set submit carries the same guarantees', async () => {
    const went: string[] = [];
    const bulk = { items: [] } as unknown as ChangeSetDraft;
    const failed = await submitChangeSetVia({ submitChangeSet: () => Promise.reject(DROPPED) }, (p) => went.push(p), bulk);
    expect(failed).toEqual({ ok: false, reason: NETWORK_FAILURE_MESSAGE, code: 'UNREACHABLE' });
    expect(went).toEqual([]);

    await submitChangeSetVia({ submitChangeSet: () => Promise.resolve({ ok: true, request }) }, (p) => went.push(p), bulk);
    expect(went).toEqual(['/requests/req-1']);
  });
});

describe('myRequestsFlow — the requester’s primary screen must not sit on "Loading…"', () => {
  const ok = {
    listRequests: () => Promise.resolve([request]),
    listManifests: () => Promise.resolve([]),
    getInventory: () => Promise.resolve({ resources: [] } as never),
  };

  it('loads all three in one attempt', async () => {
    const outcome = await loadMyRequestsVia(ok, 'user-1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.requests).toEqual([request]);
  });

  it('ANY of the three failing fails the whole load, rather than rendering a half-page', async () => {
    // Promise.all rejects on the first failure; the point of the assertion is that the
    // failure reaches the caller as a value for EACH of the three, so no single call can
    // reject past the guard and strand `loading`.
    for (const broken of ['listRequests', 'listManifests', 'getInventory'] as const) {
      const outcome = await loadMyRequestsVia({ ...ok, [broken]: () => Promise.reject(DROPPED) }, 'user-1');
      expect(outcome.ok, `${broken} rejecting must be caught`).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe(NETWORK_FAILURE_MESSAGE);
    }
  });

  it('surfaces the server’s own message for a 401 after an idle-expired session', async () => {
    // The exact production case the finding names: one 401 left the page loading for
    // ever with an unhandled rejection. httpApi throws an Error carrying the reason.
    const expired = new Error('Your session expired — sign in again.');
    const outcome = await loadMyRequestsVia({ ...ok, listRequests: () => Promise.reject(expired) }, 'user-1');
    expect(outcome).toEqual({ ok: false, reason: 'Your session expired — sign in again.' });
  });

  it('passes the userId through to listRequests', async () => {
    const seen: string[] = [];
    await loadMyRequestsVia({ ...ok, listRequests: (id: string) => { seen.push(id); return Promise.resolve([]); } }, 'user-7');
    expect(seen).toEqual(['user-7']);
  });
});
