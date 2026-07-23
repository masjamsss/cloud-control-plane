import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import {
  applyMutatedRequestToList,
  isRejectReasonValid,
  parseFilters,
  queueAgeLabel,
} from '@/features/approvals/ApprovalsQueue';

/**
 * Task 3: same URL-backed filter shape on the Approvals queue as on My
 * requests — a reviewer's narrowed view (e.g. a text search across the
 * pending queue) is a link a lead can share, not just a local UI state.
 */
describe('ApprovalsQueue parseFilters — URL → filter state (valid, invalid, absent)', () => {
  it('valid: reads a known status and a text query', () => {
    const sp = new URLSearchParams('status=AWAITING_CODE_REVIEW&q=rizky');
    expect(parseFilters(sp)).toEqual({ status: 'AWAITING_CODE_REVIEW', q: 'rizky' });
  });

  it('invalid: an unknown status coerces to "all"', () => {
    const sp = new URLSearchParams('status=bogus');
    expect(parseFilters(sp)).toEqual({ status: 'all', q: '' });
  });

  it('absent: no params default to "all" and empty text', () => {
    const sp = new URLSearchParams();
    expect(parseFilters(sp)).toEqual({ status: 'all', q: '' });
  });

  it('the literal "all" status is accepted as-is', () => {
    const sp = new URLSearchParams('status=all');
    expect(parseFilters(sp)).toEqual({ status: 'all', q: '' });
  });
});

/**
 * 0025 RX-3 — "approve/reject: pessimistic-but-responsive". Lane C's
 * describeApproveError/TOTP handling (approveError.ts, exercised by
 * approveError.test.ts) is untouched by this task; these tests cover the
 * NEW seam it composes with — patching queue state from a mutation's
 * returned `result.request` instead of `load()`'s pre-RX-3 triple refetch,
 * and the inline reject-reason form that replaced `window.prompt`. No
 * jsdom/RTL in this repo (src/test/setup.ts) — the state-shaping and
 * validation logic is pure and tested directly; the "no more triple
 * refetch" / "no more window.prompt" claims are proven by scanning the
 * component source itself, the same technique standalone.test.ts uses for
 * its own structural invariants.
 */

function fixtureRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'req-1',
    requester: 'dewi',
    service: 'ebs',
    operationId: 'ebs-grow',
    macd: 'Change',
    targetAddress: 'aws_ebs_volume.x',
    params: {},
    justification: 'Because the volume is nearly full.',
    exposure: 'l1_self_service',
    risk: 'LOW',
    status: 'AWAITING_CODE_REVIEW',
    approvalsRequired: 2,
    approvals: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

describe('applyMutatedRequestToList — patches or drops a request from a mutation result (0025 RX-3)', () => {
  it('patches the request in place when it is still AWAITING_CODE_REVIEW (a partial/1-of-2 approval)', () => {
    const other = fixtureRequest({ id: 'req-other' });
    const before = fixtureRequest({ id: 'req-1', approvals: [] });
    const updated = fixtureRequest({
      id: 'req-1',
      approvals: [{ user: 'rizky', at: '2026-01-01T01:00:00.000Z' }],
    });
    const next = applyMutatedRequestToList([other, before], updated);
    expect(next).toHaveLength(2);
    expect(next.find((r) => r.id === 'req-1')).toEqual(updated);
    expect(next.find((r) => r.id === 'req-other')).toEqual(other);
  });

  it('removes the request once it is fully approved and APPLIED (quorum met, "now" schedule)', () => {
    const before = fixtureRequest({ id: 'req-1' });
    const updated = fixtureRequest({ id: 'req-1', status: 'APPLIED' });
    expect(applyMutatedRequestToList([before], updated)).toEqual([]);
  });

  it('removes the request once fully approved but scheduled (AWAITING_DEPLOY_APPROVAL, "window" schedule)', () => {
    const before = fixtureRequest({ id: 'req-1' });
    const updated = fixtureRequest({ id: 'req-1', status: 'AWAITING_DEPLOY_APPROVAL' });
    expect(applyMutatedRequestToList([before], updated)).toEqual([]);
  });

  it('removes the request on reject (always REJECTED, never AWAITING_CODE_REVIEW)', () => {
    const before = fixtureRequest({ id: 'req-1' });
    const updated = fixtureRequest({ id: 'req-1', status: 'REJECTED' });
    expect(applyMutatedRequestToList([before], updated)).toEqual([]);
  });

  it('leaves every OTHER request untouched, in order', () => {
    const a = fixtureRequest({ id: 'a' });
    const b = fixtureRequest({ id: 'b' });
    const c = fixtureRequest({ id: 'c' });
    const updatedB = fixtureRequest({ id: 'b', status: 'REJECTED' });
    expect(applyMutatedRequestToList([a, b, c], updatedB)).toEqual([a, c]);
  });

  it('is a no-op when the updated request is not in the list (defensive; nothing to patch or drop)', () => {
    const a = fixtureRequest({ id: 'a' });
    const stray = fixtureRequest({ id: 'not-in-list', status: 'REJECTED' });
    expect(applyMutatedRequestToList([a], stray)).toEqual([a]);
  });
});

describe('isRejectReasonValid — the >=10-char rule (0025 RX-3; was window.prompt\'s inline check)', () => {
  it('false under 10 trimmed characters', () => {
    expect(isRejectReasonValid('too short')).toBe(false); // 9 chars
    expect(isRejectReasonValid('')).toBe(false);
  });

  it('true at exactly 10 trimmed characters, and above', () => {
    expect(isRejectReasonValid('1234567890')).toBe(true); // exactly 10
    expect(isRejectReasonValid('a perfectly good reason')).toBe(true);
  });

  it('trims surrounding whitespace before measuring, same as the pre-RX-3 check', () => {
    expect(isRejectReasonValid('   too short   ')).toBe(false);
    expect(isRejectReasonValid('  1234567890  ')).toBe(true);
  });
});

describe('ApprovalsQueue source invariants (0025 RX-3 accept criteria, proven by scanning the component)', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'features', 'approvals', 'ApprovalsQueue.tsx');
  const rawSource = readFileSync(SRC, 'utf8');
  // Strip comments before matching — this file's own doc comments legitimately
  // *talk about* load()/window.prompt (documenting what RX-3 replaced), which
  // would otherwise false-positive against the code-only checks below. No
  // string literal in this file contains "//" or "/*" (verified), so a plain
  // strip is safe here — same spirit as standalone.test.ts's own
  // code-vs-comment split, just handling block comments too.
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('load() is called exactly once (the initial mount) — approve/reject patch state instead of refetching (accept: one mutation => <=1 fetch)', () => {
    const calls = source.match(/\bload\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('no longer uses window.prompt for the rejection reason — replaced by an inline form', () => {
    expect(source.includes('window.prompt')).toBe(false);
  });

  it('does not use useOptimistic (0025 §3.4 no-go: the server may raise approvalsRequired at approve time)', () => {
    expect(source.includes('useOptimistic')).toBe(false);
  });
});

describe('queueAgeLabel — the approvals-queue age chip (0034 §4.3 / papercut #4)', () => {
  it('renders "today" for a same-day request', () => {
    expect(queueAgeLabel('2026-07-15T08:00:00Z', new Date('2026-07-15T12:00:00Z'))).toBe('today');
  });
  it('renders a singular day at exactly one calendar day', () => {
    expect(queueAgeLabel('2026-07-14T12:00:00Z', new Date('2026-07-15T12:00:00Z'))).toBe('1 day old');
  });
  it('renders plural days for an older request', () => {
    expect(queueAgeLabel('2026-07-10T12:00:00Z', new Date('2026-07-15T12:00:00Z'))).toBe('5 days old');
  });
  it('returns null (no chip) for a missing/invalid timestamp', () => {
    expect(queueAgeLabel(undefined)).toBeNull();
    expect(queueAgeLabel('not-a-date')).toBeNull();
  });
});
