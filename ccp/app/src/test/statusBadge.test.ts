import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '@/components/ui/StatusBadge';

/**
 * 0021 G1 — the two new RequestItem statuses (APPROVED_COOLING, CANCELLED)
 * render "proper chips" (item 3 of the Lane C brief): a real label, not the
 * raw enum string, and a tone distinct from a failure. No jsdom in this
 * repo (test/standalone.test.ts) — renderToStaticMarkup needs no DOM.
 */
describe('StatusBadge — the two new 0021 G1 cooling-off statuses', () => {
  it('APPROVED_COOLING renders a "Cooling off" chip, not the raw enum string', () => {
    const html = renderToStaticMarkup(React.createElement(StatusBadge, { status: 'APPROVED_COOLING' }));
    expect(html).toContain('Cooling off');
    expect(html).not.toContain('APPROVED_COOLING<');
    // tone--wait, same bucket as AWAITING_DEPLOY_APPROVAL — "waiting on
    // something," not a failure.
    expect(html).toContain('status-badge--wait');
  });

  it('CANCELLED renders a "Cancelled" chip, toned like WITHDRAWN (self-stopped), not REJECTED (fail)', () => {
    const html = renderToStaticMarkup(React.createElement(StatusBadge, { status: 'CANCELLED' }));
    expect(html).toContain('Cancelled');
    expect(html).toContain('status-badge--idle');
    expect(html).not.toContain('status-badge--fail');
  });

  it('the title attribute still carries the raw status for both (existing convention, e.g. debugging/tooltips)', () => {
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { status: 'APPROVED_COOLING' }))).toContain(
      'title="APPROVED_COOLING"',
    );
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { status: 'CANCELLED' }))).toContain(
      'title="CANCELLED"',
    );
  });
});

/** 0024 §2.2/§2.3 — the third new status this design adds. */
describe('StatusBadge — WINDOW_EXPIRED (0024)', () => {
  it('renders a "Window expired" chip, not the raw enum string', () => {
    const html = renderToStaticMarkup(React.createElement(StatusBadge, { status: 'WINDOW_EXPIRED' }));
    expect(html).toContain('Window expired');
    expect(html).not.toContain('WINDOW_EXPIRED<');
  });

  it('uses the fail tone — needs a human to re-window or cancel, unlike the wait-toned AWAITING_DEPLOY_APPROVAL', () => {
    const html = renderToStaticMarkup(React.createElement(StatusBadge, { status: 'WINDOW_EXPIRED' }));
    expect(html).toContain('status-badge--fail');
    expect(html).not.toContain('status-badge--wait');
  });

  it('the title attribute carries the raw status', () => {
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { status: 'WINDOW_EXPIRED' }))).toContain(
      'title="WINDOW_EXPIRED"',
    );
  });
});
