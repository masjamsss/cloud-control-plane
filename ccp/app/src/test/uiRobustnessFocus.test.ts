import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewStep } from '@/features/request/ReviewStep';
import { RouteSkeleton } from '@/components/RouteSkeleton';
import { manifests } from '@/data/manifests';
import type { Inventory } from '@/types';

/**
 * UI-12 — two independent gaps on the same theme (a page swap with nothing
 * announced to assistive tech):
 *
 *   1. Configure ⇄ Review step transitions never moved focus — keyboard
 *      focus died on the unmounted button (falls back to `<body>`) and
 *      nothing told a screen reader the step changed. Fixed at both
 *      transition points in RequestForm.tsx (`onReview` / `onBackToEdit`),
 *      each moving focus to the newly-mounted step's own `<h1>` — the same
 *      rAF-after-setState technique the pre-existing invalid-path fix
 *      (ErrorSummary/`errorRef`) already used, just for the happy path too.
 *   2. RouteSkeleton (the lazy-route Suspense fallback) was wholesale
 *      `aria-hidden="true"`, so a route's loading state was pure silence for
 *      a screen reader, not "loading" — fixed with `role="status"` +
 *      `aria-busy="true"` + a visually-hidden "Loading…" text.
 *
 * RequestForm.tsx itself can't be driven through a real step transition here
 * (no jsdom in this repo — see TEST-7 — and its data load runs in a
 * useEffect, which renderToStaticMarkup never fires), so its half of (1) is
 * pinned at the source level, the same technique router.tsx's registration
 * tests already use. ReviewStep is a plain, prop-driven component and DOES
 * render for real below.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('ReviewStep — the review heading is a real focus target (UI-12)', () => {
  it('the h1 carries tabIndex={-1} so RequestForm can .focus() it on entering Review', () => {
    const inventory: Inventory = { generatedAt: '2026-01-01T00:00:00.000Z', resources: [] };
    const op = manifests[0]!.operations[0]!;
    const html = renderToStaticMarkup(
      React.createElement(ReviewStep, {
        op,
        values: {},
        inventory,
        justification: 'because',
        targetAddress: '',
        submitting: false,
        onEdit: () => undefined,
        onSubmit: () => undefined,
      }),
    );
    expect(html).toMatch(/<h1 class="rq-review__title" tabindex="-1">/);
  });
});

describe('RequestForm — step-transition focus wiring is pinned (UI-12)', () => {
  const source = readFileSync(join(SRC, 'features/request/RequestForm.tsx'), 'utf8');

  it('Configure→Review moves focus to the Review heading once it is mounted', () => {
    // The rAF wrapper is required — the Review markup isn't in the DOM until
    // after this render commits, same reasoning as the pre-existing errorRef
    // focus call just above it in the same function. Checked as an ORDERED
    // pair (not a tight-window regex) since a comment block sits between them.
    const setIdx = source.indexOf("setStep('review');");
    const focusIdx = source.indexOf('reviewHeadingRef.current?.focus()');
    expect(setIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeGreaterThan(setIdx);
    // Same onReview function body — no other setStep('review') call sits between.
    expect(source.indexOf("setStep('review');", setIdx + 1)).toBeLessThan(0);
  });

  it('Back-to-edit moves focus to the Configure heading', () => {
    const setIdx = source.indexOf("setStep('configure');", source.indexOf('onBackToEdit'));
    const focusIdx = source.indexOf('configureHeadingRef.current?.focus()');
    expect(setIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeGreaterThan(setIdx);
    // Wired as the ReviewStep's onEdit — not the old bare `() => setStep('configure')`,
    // which had no focus effect at all.
    expect(source).toContain('onEdit={onBackToEdit}');
  });

  it('the Configure step heading is itself a real focus target', () => {
    expect(source).toMatch(/ref=\{configureHeadingRef\}\s*tabIndex=\{-1\}/);
  });
});

describe('RouteSkeleton — the loading state is announced, not silent (UI-12)', () => {
  it('is a role="status" aria-busy live region with a (visually-hidden) "Loading…" text', () => {
    const html = renderToStaticMarkup(React.createElement(RouteSkeleton));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading');
    // No longer swallows the whole thing under aria-hidden.
    expect(html).not.toMatch(/class="rskel" role="status" aria-busy="true"[^>]*aria-hidden/);
  });

  it('the decorative shimmer bars stay aria-hidden (nothing for a screen reader to read off an empty gradient)', () => {
    const html = renderToStaticMarkup(React.createElement(RouteSkeleton));
    expect(html).toMatch(/class="rskel__title" aria-hidden="true"/);
    expect(html).toMatch(/class="rskel__section" aria-hidden="true"/);
  });
});
