import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OrientationNote } from '@/features/services/OrientationNote';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 0034 Addendum D16 — service-page orientation. The owner walked the Lambda
 * service page as a reviewer and rejected that it never says what to DO: the
 * fix is one line above "Your resources" on every service page, stating the
 * next step (pick a resource → its Actions menu → review is the gate). No
 * jsdom in this repo (standalone.test.ts) — renderToStaticMarkup needs no DOM.
 */
describe('OrientationNote — the one-line task header (D16)', () => {
  const html = renderToStaticMarkup(React.createElement(OrientationNote));

  it('states the owner-approved next-step line, verbatim', () => {
    expect(html).toContain(
      'Pick a resource below, then choose an action from its Actions menu. Changes go to review before anything is applied.',
    );
  });

  it('is one plain paragraph — orientation, not a banner competing with the page', () => {
    expect(html).toMatch(/^<p class="console__orientation">/);
  });

  it('never leaks internal notation into the operator line', () => {
    expect(html).not.toMatch(/§/);
    expect(html).not.toMatch(/[A-Za-z0-9]_[A-Za-z0-9]/);
  });
});

describe('ServiceConsole renders the orientation above "Your resources" on every service page', () => {
  // ServiceConsole needs a router + api to mount, so placement is pinned at
  // the source level (same mechanical file-scan style as copyLint): the ONE
  // console component serves every service, and OrientationNote must appear
  // in its JSX before the your-resources section is opened.
  const source = readFileSync(join(SRC, 'features', 'services', 'ServiceConsole.tsx'), 'utf8');

  it('ServiceConsole mounts OrientationNote', () => {
    expect(source).toContain('<OrientationNote />');
  });

  it('…above the "Your resources" section', () => {
    const note = source.indexOf('<OrientationNote />');
    const resources = source.indexOf('aria-labelledby="your-resources"');
    expect(note).toBeGreaterThan(-1);
    expect(resources).toBeGreaterThan(-1);
    expect(note).toBeLessThan(resources);
  });
});
