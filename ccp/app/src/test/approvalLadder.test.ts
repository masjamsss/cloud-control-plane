import { describe, expect, it } from 'vitest';
import {
  approveAnnouncement,
  buildLadderSegments,
  canSignApprovalStep,
  ladderAriaLabel,
  ladderRowTooltip,
  ladderStatusText,
  nextSignerLabel,
  type LadderApproval,
} from '@/lib/approvalLadder';

/**
 * 0037 Feature B — the CLIENT half of the two-level approval ladder. The api re-enforces
 * every rule; these pure helpers only decide what the SPA shows (the friendly progress
 * phrase) and whether to OFFER the Approve button. Tested directly — this repo has no
 * jsdom (src/test/setup.ts), so the queue/detail gating logic is proven here.
 */

describe('canSignApprovalStep — the client mirror of the server WHO gate', () => {
  it('L2 (first approver) admits an approver OR a lead', () => {
    expect(canSignApprovalStep('L2', 'approver')).toBe(true);
    expect(canSignApprovalStep('L2', 'lead')).toBe(true);
  });

  it('L3 (final approver) is lead-only — an approver cannot sign it', () => {
    expect(canSignApprovalStep('L3', 'approver')).toBe(false);
    expect(canSignApprovalStep('L3', 'lead')).toBe(true);
  });

  it('a requester signs neither step', () => {
    expect(canSignApprovalStep('L2', 'requester')).toBe(false);
    expect(canSignApprovalStep('L3', 'requester')).toBe(false);
  });
});

describe('ladderStatusText — plain-language progress, no codenames', () => {
  it('maps L2 → "first approver" and L3 → "final approver"', () => {
    expect(ladderStatusText('L2')).toBe('Waiting for the first approver (L2)');
    expect(ladderStatusText('L3')).toBe('Waiting for the final approver (L3)');
  });

  it('null (fully signed) or undefined (mock-mode, field absent) → no line (the N-of-M count stands alone)', () => {
    expect(ladderStatusText(null)).toBeNull();
    expect(ladderStatusText(undefined)).toBeNull();
  });
});

/**
 * `<ApprovalLadder>` redesign (UX audit 2026-07-21, F-03/F-04/S-08) — the
 * pure segment-shaping/copy helpers the shared stepper renders. No jsdom in
 * this repo (src/test/setup.ts) — these stay framework-agnostic on purpose,
 * so they're proven directly rather than via a mounted component.
 */
describe('nextSignerLabel — the short WHAT-KIND-OF-SIGNER label for the active segment', () => {
  it('maps L2 → "First approver" and L3 → "Final approver"', () => {
    expect(nextSignerLabel('L2')).toBe('First approver');
    expect(nextSignerLabel('L3')).toBe('Final approver');
  });

  it('null or undefined (fully signed, or mock-mode where the field is absent) fall back to "Approval"', () => {
    expect(nextSignerLabel(null)).toBe('Approval');
    expect(nextSignerLabel(undefined)).toBe('Approval');
  });
});

describe("ladderAriaLabel — the stepper's accessible name", () => {
  it('renders "Approvals: N of M recorded"', () => {
    expect(ladderAriaLabel(1, 2)).toBe('Approvals: 1 of 2 recorded');
    expect(ladderAriaLabel(0, 1)).toBe('Approvals: 0 of 1 recorded');
  });

  it('clamps a negative/bad required to 0 rather than rendering "of -1"', () => {
    expect(ladderAriaLabel(0, -3)).toBe('Approvals: 0 of 0 recorded');
  });
});

describe('ladderRowTooltip — the size="row" pill tooltip (MyRequests)', () => {
  it('singular/plural "approval(s)" on the base count', () => {
    expect(ladderRowTooltip(0, 1, undefined)).toBe('0 of 1 approval');
    expect(ladderRowTooltip(1, 2, undefined)).toBe('1 of 2 approvals');
  });

  it("appends the who's-next phrase when nextStep is present", () => {
    expect(ladderRowTooltip(1, 2, 'L3')).toBe(
      '1 of 2 approvals — Waiting for the final approver (L3)',
    );
  });

  it('omits the phrase entirely once fully signed (nextStep null) or in mock-mode (undefined)', () => {
    expect(ladderRowTooltip(2, 2, null)).toBe('2 of 2 approvals');
    expect(ladderRowTooltip(1, 2, undefined)).toBe('1 of 2 approvals');
  });
});

function approval(user: string, at: string): LadderApproval {
  return { user, at };
}

const upperName = (id: string): string => id.toUpperCase();
const echoTime = (iso: string): string => `formatted(${iso})`;

describe("buildLadderSegments — the stepper's segment model", () => {
  it('a fresh, unsigned request: Submitted + one active segment naming the next signer kind', () => {
    const segments = buildLadderSegments({
      required: 2,
      approvals: [],
      nextStep: 'L2',
      viewerCanSign: true,
      resolveName: upperName,
      formatTime: echoTime,
    });
    expect(segments).toEqual([
      { key: 'submitted', state: 'done', label: 'Submitted' },
      { key: 'pending-0', state: 'active', label: 'First approver', sub: 'you can sign this' },
      { key: 'pending-1', state: 'todo', label: 'Approval', sub: undefined },
    ]);
  });

  it('a partial signature: the signer is a first-class done segment (name + when), not a parenthetical', () => {
    const segments = buildLadderSegments({
      required: 2,
      approvals: [approval('bob', '2026-07-06T17:05:00.000Z')],
      nextStep: 'L3',
      viewerCanSign: false,
      viewerIsOwnRequest: true,
      resolveName: upperName,
      formatTime: echoTime,
    });
    expect(segments).toEqual([
      { key: 'submitted', state: 'done', label: 'Submitted' },
      {
        key: 'signed-0-bob',
        state: 'done',
        label: 'BOB',
        sub: 'formatted(2026-07-06T17:05:00.000Z)',
      },
      {
        key: 'pending-0',
        state: 'active',
        label: 'Final approver',
        sub: 'your own request — a second reviewer signs',
      },
    ]);
  });

  it('fully signed: only Submitted + the signed segments — no pending/active segment left', () => {
    const segments = buildLadderSegments({
      required: 1,
      approvals: [approval('alice', '2026-07-06T09:00:00.000Z')],
      nextStep: null,
      viewerCanSign: false,
      resolveName: upperName,
      formatTime: echoTime,
    });
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.state === 'done')).toBe(true);
  });

  it('viewer can neither sign nor is the owner (wrong role/seniority): active segment gets no sub-label — never a guessed reason', () => {
    const segments = buildLadderSegments({
      required: 1,
      approvals: [],
      nextStep: 'L3',
      viewerCanSign: false,
      viewerIsOwnRequest: false,
      resolveName: upperName,
      formatTime: echoTime,
    });
    expect(segments[1]).toEqual({
      key: 'pending-0',
      state: 'active',
      label: 'Final approver',
      sub: undefined,
    });
  });

  it('graceful 0-of-0/awaiting state: required 0 (not yet set) + nothing signed never reads as silently complete', () => {
    const segments = buildLadderSegments({
      required: 0,
      approvals: [],
      viewerCanSign: false,
      resolveName: upperName,
      formatTime: echoTime,
    });
    expect(segments).toEqual([
      { key: 'submitted', state: 'done', label: 'Submitted' },
      {
        key: 'awaiting-requirement',
        state: 'todo',
        label: 'Awaiting requirement',
        sub: 'the approvals needed have not been set yet',
      },
    ]);
  });

  it('a negative/bad required clamps to 0 — same graceful awaiting state, never a crash or a negative pending count', () => {
    const segments = buildLadderSegments({
      required: -5,
      approvals: [],
      viewerCanSign: false,
      resolveName: upperName,
      formatTime: echoTime,
    });
    expect(segments.map((s) => s.key)).toEqual(['submitted', 'awaiting-requirement']);
  });

  it('required 0 but already (over-)signed: no awaiting placeholder — the signed segment alone reads as done', () => {
    const segments = buildLadderSegments({
      required: 0,
      approvals: [approval('alice', '2026-07-06T09:00:00.000Z')],
      viewerCanSign: false,
      resolveName: upperName,
      formatTime: echoTime,
    });
    expect(segments.map((s) => s.key)).toEqual(['submitted', 'signed-0-alice']);
  });

  it('undefined nextStep (mock-mode) still labels the active segment with the graceful "Approval" fallback', () => {
    const segments = buildLadderSegments({
      required: 1,
      approvals: [],
      nextStep: undefined,
      viewerCanSign: true,
      resolveName: upperName,
      formatTime: echoTime,
    });
    expect(segments[1]?.label).toBe('Approval');
    expect(segments[1]?.sub).toBe('you can sign this');
  });
});

describe('approveAnnouncement — the aria-live confirmation after a successful approve (S-09)', () => {
  it('partial: names how many approvals remain, pluralized', () => {
    expect(approveAnnouncement(1, 2)).toBe('Request approved — 1 approval remaining.');
    expect(approveAnnouncement(0, 3)).toBe('Request approved — 3 approvals remaining.');
  });

  it('fully signed by this approve: no remaining count, just confirmation', () => {
    expect(approveAnnouncement(2, 2)).toBe('Request approved — fully signed.');
  });

  it('never a negative remaining count even with stale/inconsistent have > required', () => {
    expect(approveAnnouncement(3, 2)).toBe('Request approved — fully signed.');
  });
});
