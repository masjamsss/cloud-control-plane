import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusBadge, statusLabel } from '@/components/ui/StatusBadge';
import { REQUEST_STATUSES } from '@/types';

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

/**
 * UI-10 — `statusLabel` is the one canonical source of status copy, exported
 * specifically so `MyRequests.tsx`, `ApprovalsQueue.tsx` and `lib/palette.ts`
 * stop each deriving their own words for the same status ("Awaiting code
 * review" vs this map's "Awaiting review" for AWAITING_CODE_REVIEW). Every
 * value in the closed vocabulary must resolve through it — the whole point is
 * that no status can fall back to a raw-enum or ad hoc humanization anywhere
 * that imports this function.
 */
describe('statusLabel — UI-10, the one canonical status-copy source', () => {
  it('every status in the closed vocabulary has a defined, non-empty label', () => {
    for (const status of REQUEST_STATUSES) {
      const label = statusLabel(status);
      expect(label, status).toBeTypeOf('string');
      expect(label.length, status).toBeGreaterThan(0);
    }
  });

  it('never returns the raw SCREAMING_SNAKE_CASE token — every label is human copy', () => {
    for (const status of REQUEST_STATUSES) {
      expect(statusLabel(status), status).not.toBe(status);
      expect(statusLabel(status), status).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it('is exactly what StatusBadge renders — the same function, not a parallel copy', () => {
    for (const status of REQUEST_STATUSES) {
      const html = renderToStaticMarkup(React.createElement(StatusBadge, { status }));
      expect(html, status).toContain(statusLabel(status));
    }
  });

  it('deliberately differs from a mechanical humanization for several statuses — these are curated, not derived', () => {
    // Pins the exact cases the old per-file humanizeStatus functions got
    // wrong by construction: a plain underscore-to-space transform would
    // produce "Noop" and "Approved cooling", not these.
    expect(statusLabel('NOOP')).toBe('No change');
    expect(statusLabel('APPROVED_COOLING')).toBe('Cooling off');
  });
});
