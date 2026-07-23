import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  CoolingPanel,
  FeasibilityBanner,
  LinkPrPanel,
  RequestAgainLink,
  WindowPanel,
} from '@/features/requests/RequestDetail';
import { formatProjectTime } from '@/lib/datetime';

/**
 * Render-shape proof for the two 0021 G1/G5 additions on RequestDetail:
 * the Cancel button's visibility rule (coolingFlow.test.ts already proves
 * canCancelRequest's pure logic in isolation; this proves CoolingPanel
 * actually WIRES it into the button, the same dual-layer proof AccountRow
 * gets in advisoryGate.test.ts — pure predicate + a render-shape check) and
 * the feasibility notice banners. No jsdom in this repo — renderToStaticMarkup
 * needs no DOM (see test/standalone.test.ts's exact dependency allowlist).
 */

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

describe('CoolingPanel — the Cancel button visibility rule, at the render level', () => {
  const owner = { id: 'sari', role: 'requester' };
  const notOwnerApprover = { id: 'budi', role: 'approver' };
  const lead = { id: 'budi', role: 'lead' };

  it('renders nothing at all for a status other than APPROVED_COOLING', () => {
    const html = render(
      React.createElement(CoolingPanel, {
        request: { status: 'APPLIED', requester: 'sari', earliestApplyAt: '2026-07-11T00:00:00.000Z' },
        currentUser: owner,
        onCancel: () => {},
        busy: false,
      }),
    );
    expect(html).toBe('');
  });

  it('CANCELLED also renders nothing — shown via the StatusBadge chip instead, not a standing banner', () => {
    const html = render(
      React.createElement(CoolingPanel, {
        request: { status: 'CANCELLED', requester: 'sari', earliestApplyAt: '2026-07-11T00:00:00.000Z' },
        currentUser: owner,
        onCancel: () => {},
        busy: false,
      }),
    );
    expect(html).toBe('');
  });

  it('APPROVED_COOLING + the owner viewing: the banner AND the Cancel button both render', () => {
    const html = render(
      React.createElement(CoolingPanel, {
        request: { status: 'APPROVED_COOLING', requester: 'sari', earliestApplyAt: '2026-07-11T00:00:00.000Z' },
        currentUser: owner,
        onCancel: () => {},
        busy: false,
      }),
    );
    expect(html).toContain('cooling off until');
    expect(html).toContain(formatProjectTime('2026-07-11T00:00:00.000Z'));
    expect(html).toMatch(/remaining|elapsing shortly/);
    expect(html).toContain('Cancel this change');
    expect(html).toContain('<button');
  });

  it('APPROVED_COOLING + a Lead who is NOT the requester: still shows the Cancel button (senior override)', () => {
    const html = render(
      React.createElement(CoolingPanel, {
        request: { status: 'APPROVED_COOLING', requester: 'sari', earliestApplyAt: '2026-07-11T00:00:00.000Z' },
        currentUser: lead,
        onCancel: () => {},
        busy: false,
      }),
    );
    expect(html).toContain('Cancel this change');
  });

  it('APPROVED_COOLING + a plain approver who is neither requester nor Lead/admin: NO Cancel button, banner still shows', () => {
    const html = render(
      React.createElement(CoolingPanel, {
        request: { status: 'APPROVED_COOLING', requester: 'sari', earliestApplyAt: '2026-07-11T00:00:00.000Z' },
        currentUser: notOwnerApprover,
        onCancel: () => {},
        busy: false,
      }),
    );
    expect(html).toContain('cooling off until');
    expect(html).not.toContain('Cancel this change');
    expect(html).not.toContain('<button');
  });

  it('busy:true disables the button and swaps its label', () => {
    const html = render(
      React.createElement(CoolingPanel, {
        request: { status: 'APPROVED_COOLING', requester: 'sari', earliestApplyAt: '2026-07-11T00:00:00.000Z' },
        currentUser: owner,
        onCancel: () => {},
        busy: true,
      }),
    );
    expect(html).toContain('Cancelling…');
    const btnStart = html.indexOf('<button');
    const btnEnd = html.indexOf('>', btnStart);
    expect(html.slice(btnStart, btnEnd + 1)).toContain('disabled');
  });

  it('an error renders as role="alert" text', () => {
    const html = render(
      React.createElement(CoolingPanel, {
        request: { status: 'APPROVED_COOLING', requester: 'sari', earliestApplyAt: '2026-07-11T00:00:00.000Z' },
        currentUser: owner,
        onCancel: () => {},
        busy: false,
        error: 'This request is not in a state that allows that.',
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('This request is not in a state that allows that.');
  });
});

describe('FeasibilityBanner — 0021 G5 notices rendered from server fields, not local math', () => {
  it('undefined feasibility (mock-mode, or api-mode before the live fetch resolves) renders nothing', () => {
    expect(render(React.createElement(FeasibilityBanner, { feasibility: undefined }))).toBe('');
  });

  it('comfortable quorum (feasible, no interim) renders nothing — nothing to say', () => {
    const html = render(
      React.createElement(FeasibilityBanner, {
        feasibility: { eligibleApprovers: 3, feasible: true, interimProfileWillApply: false },
      }),
    );
    expect(html).toBe('');
  });

  it('a feasible request renders nothing even if interimProfileWillApply is (stalely) set — no interim notice anymore (0037)', () => {
    const html = render(
      React.createElement(FeasibilityBanner, {
        feasibility: { eligibleApprovers: 1, feasible: true, interimProfileWillApply: true },
      }),
    );
    expect(html).toBe('');
  });

  it('infeasible renders the error-toned notice, naming the missing lead for the final approval', () => {
    const html = render(
      React.createElement(FeasibilityBanner, {
        feasibility: { eligibleApprovers: 1, feasible: false, interimProfileWillApply: false },
      }),
    );
    expect(html).toContain('rd-feasibility--infeasible');
    expect(html).toMatch(/lead for the final approval/i);
  });
});

/**
 * WindowPanel (0024 §2.2-§2.4) — the SAME dual-layer proof CoolingPanel gets
 * above (windowFlow.test.ts already proves canCancelWindowedRequest/
 * canRewindowRequest/windowGateSummary in isolation; this proves the panel
 * actually wires them into what renders). `now` is always passed explicitly
 * for deterministic countdowns (no client timer, 0024 §2.3).
 */
describe('WindowPanel — the gate-truth panel + Cancel/Re-window visibility rules', () => {
  const NOW = Date.parse('2026-07-12T12:00:00.000Z');
  const owner = { id: 'sari', role: 'requester' };
  const notOwnerApprover = { id: 'budi', role: 'approver' };
  const lead = { id: 'budi', role: 'lead' };

  const beforeWindow = { kind: 'window' as const, at: '2026-07-12T18:00:00.000Z', endAt: '2026-07-12T22:00:00.000Z' };
  const openWindow = { kind: 'window' as const, at: '2026-07-12T10:00:00.000Z', endAt: '2026-07-12T22:00:00.000Z' };
  const coolingWindow = { kind: 'window' as const, at: '2026-07-12T10:00:00.000Z', endAt: '2026-07-12T22:00:00.000Z' };

  const noop = (): void => {};

  it('renders nothing for a status other than WINDOW_EXPIRED/AWAITING_DEPLOY_APPROVAL', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'APPLIED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toBe('');
  });

  it('renders nothing for AWAITING_DEPLOY_APPROVAL + schedule.kind:"now" (a freeze-held row — no window to show)', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'AWAITING_DEPLOY_APPROVAL', requester: 'sari', schedule: { kind: 'now' }, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toBe('');
  });

  it('WINDOW_EXPIRED: shows the closed message, a Cancel button, AND a re-window form for the owner', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toContain('closed');
    expect(html).toContain('Cancel this change');
    expect(html).toContain('Re-window');
    expect(html).toContain('<form');
    expect(html).toContain('<input');
  });

  it('AWAITING_DEPLOY_APPROVAL, before the window opens: shows "opens" copy, Cancel AND Re-window both offered', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'AWAITING_DEPLOY_APPROVAL', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toContain('opens');
    expect(html).toContain('Cancel this change');
    expect(html).toContain('Re-window');
  });

  it('AWAITING_DEPLOY_APPROVAL, window CURRENTLY open: Cancel offered, Re-window is NOT (mid-window, §2.4)', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'AWAITING_DEPLOY_APPROVAL', requester: 'sari', schedule: openWindow, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toContain('open now');
    expect(html).toContain('Cancel this change');
    expect(html).not.toContain('Re-window');
    expect(html).not.toContain('<form');
  });

  it('AWAITING_DEPLOY_APPROVAL, still cooling under the interim profile: mentions cooling AND the window opens time', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: {
          status: 'AWAITING_DEPLOY_APPROVAL',
          requester: 'sari',
          schedule: coolingWindow,
          earliestApplyAt: '2026-07-12T14:00:00.000Z',
        },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toContain('Cooling off');
    expect(html).toContain(formatProjectTime('2026-07-12T14:00:00.000Z'));
  });

  it('a plain approver who is neither requester nor Lead/admin: text renders, NEITHER button does', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: notOwnerApprover,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toContain('closed');
    expect(html).not.toContain('Cancel this change');
    expect(html).not.toContain('Re-window');
    expect(html).not.toContain('<button');
  });

  it('a Lead who is NOT the requester still gets both actions (senior override)', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: lead,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toContain('Cancel this change');
    expect(html).toContain('Re-window');
  });

  it('cancelBusy disables the Cancel button and swaps its label', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: true,
        rewindowBusy: false,
        now: NOW,
      }),
    );
    expect(html).toContain('Cancelling…');
  });

  it('rewindowBusy disables the Re-window button and swaps its label', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: true,
        now: NOW,
      }),
    );
    expect(html).toContain('Re-windowing…');
  });

  it('a cancelError renders as role="alert" text', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        cancelError: 'This request is not in a state that allows that.',
        now: NOW,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('This request is not in a state that allows that.');
  });

  it('a rewindowError renders as role="alert" text', () => {
    const html = render(
      React.createElement(WindowPanel, {
        request: { status: 'WINDOW_EXPIRED', requester: 'sari', schedule: beforeWindow, earliestApplyAt: undefined },
        currentUser: owner,
        onCancel: noop,
        onRewindow: noop,
        cancelBusy: false,
        rewindowBusy: false,
        rewindowError: 'This approval is too old to re-window.',
        now: NOW,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('This approval is too old to re-window.');
  });
});

/**
 * 0034 D15 — "Request again" on terminal requests: same dual-layer proof
 * (requestAgain.test.ts proves the pure predicate/path; this proves the link
 * actually renders wired to them). MemoryRouter because the affordance is a
 * react-router Link.
 */
describe('RequestAgainLink — one click from a terminal request back into the form', () => {
  const base = { id: 'req-9', service: 'ebs', operationId: 'ebs-grow' };

  function renderLink(status: string): string {
    return renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(RequestAgainLink, { request: { ...base, status: status as never } }),
      ),
    );
  }

  it('renders for REJECTED with the pre-seeding ?from= target', () => {
    const html = renderLink('REJECTED');
    expect(html).toContain('Request again');
    expect(html).toContain('/services/ebs/ebs-grow?from=req-9');
  });

  it('renders for APPLIED and CANCELLED too (a completed change is a template for the next one)', () => {
    expect(renderLink('APPLIED')).toContain('Request again');
    expect(renderLink('CANCELLED')).toContain('Request again');
  });

  it('renders NOTHING for open/parked statuses — cancel/rewindow own those', () => {
    for (const status of ['AWAITING_CODE_REVIEW', 'NEEDS_ENGINEER', 'WINDOW_EXPIRED', 'APPROVED_COOLING']) {
      expect(renderLink(status), status).toBe('');
    }
  });

  it('a beyond-catalog request links to the structured tail instead', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(RequestAgainLink, {
          request: { id: 'req-9', service: 'redshift', operationId: 'beyond-catalog-request', status: 'REJECTED' },
        }),
      ),
    );
    expect(html).toContain('/services/request-new?from=req-9');
  });
});

/**
 * 0033 A12 — LinkPrPanel: the Lead-side write control for the PR back-link.
 * The server is the authority (lead-only, https-only, refused on terminal
 * statuses); this proves the panel's own visibility and validity rules.
 */
describe('LinkPrPanel — who sees the PR-link control, and when it can submit', () => {
  const lead = { id: 'putra', role: 'lead' };
  const admin = { id: 'ops', role: 'requester', isAdmin: true };
  const approver = { id: 'budi', role: 'approver' };
  const noop = (): void => {};

  function renderPanel(over: {
    status?: string;
    prUrl?: string;
    user?: { id: string; role: string; isAdmin?: boolean };
    serverCanLink?: boolean;
    busy?: boolean;
    error?: string | null;
  }): string {
    return renderToStaticMarkup(
      React.createElement(LinkPrPanel, {
        request: { status: (over.status ?? 'NEEDS_ENGINEER') as never, prUrl: over.prUrl },
        currentUser: over.user ?? lead,
        serverCanLink: over.serverCanLink ?? true,
        onLink: noop,
        busy: over.busy ?? false,
        error: over.error,
      }),
    );
  }

  it('a Lead on an open NEEDS_ENGINEER request sees the input and the Link button', () => {
    const html = renderPanel({});
    expect(html).toContain('Paste the engineering PR');
    expect(html).toContain('Link the PR');
    expect(html).toContain('<input');
  });

  it('an admin (senior override) sees it too; a plain approver never does', () => {
    expect(renderPanel({ user: admin })).toContain('Link the PR');
    expect(renderPanel({ user: approver })).toBe('');
  });

  it('mock mode (no server verb) renders nothing — the control never fakes a write', () => {
    expect(renderPanel({ serverCanLink: false })).toBe('');
  });

  it('renders only on OPEN statuses — a terminal request has no linking to offer here', () => {
    expect(renderPanel({ status: 'AWAITING_CODE_REVIEW' })).toContain('Link the PR');
    for (const status of ['REJECTED', 'CANCELLED', 'APPLIED']) {
      expect(renderPanel({ status }), status).toBe('');
    }
  });

  it('an already-linked request offers the correcting copy instead', () => {
    const html = renderPanel({ prUrl: 'https://github.com/x/y/pull/1' });
    expect(html).toContain('paste a new address to correct it');
    expect(html).toContain('Update the PR link');
  });

  it('the submit control starts disabled until a plausible https URL is present (server re-validates anyway)', () => {
    const html = renderPanel({});
    const btnStart = html.indexOf('<button');
    const btnEnd = html.indexOf('>', btnStart);
    expect(html.slice(btnStart, btnEnd + 1)).toContain('disabled');
  });

  it('an error renders as role="alert" text', () => {
    const html = renderPanel({ error: 'Only approvers and leads can do that.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Only approvers and leads can do that.');
  });

  it('busy swaps the label', () => {
    expect(renderPanel({ busy: true })).toContain('Linking…');
  });
});
