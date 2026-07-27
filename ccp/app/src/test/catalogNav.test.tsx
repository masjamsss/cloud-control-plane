import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CategoryNav, type CategoryNavItem } from '@/features/catalog/CategoryNav';
import { sectionId } from '@/features/catalog/ServiceCatalog';
import { CATEGORY_ORDER } from '@/lib/serviceMeta';

/**
 * The catalog's jump rail — the navigation layer over a browse that is one
 * continuous ~20,000px scroll across 150+ services.
 *
 * Rendered as SSR strings (no jsdom in this repo — the DriftPanel/CoolingPanel
 * precedent), so what's pinned here is the render contract and the id scheme.
 * The scroll-position behaviour on top of it (scrollspy, jump clearance, the
 * rail's overflow fades) is browser-only and was verified against the running
 * app across viewport widths rather than asserted here.
 */

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

const items: CategoryNavItem[] = [
  { id: sectionId('Compute'), label: 'Compute', count: 12 },
  {
    id: sectionId('Networking & Content Delivery'),
    label: 'Networking & Content Delivery',
    count: 13,
  },
];

describe('sectionId', () => {
  it('slugs a category to a stable, url-safe anchor', () => {
    expect(sectionId('Compute')).toBe('cat-compute');
    expect(sectionId('Security & Identity')).toBe('cat-security-identity');
    expect(sectionId('Developer & Mgmt Tools')).toBe('cat-developer-mgmt-tools');
    expect(sectionId('Security, Identity & Compliance')).toBe('cat-security-identity-compliance');
  });

  it('never leaves a leading or trailing separator', () => {
    expect(sectionId('& Compute &')).toBe('cat-compute');
    expect(sectionId('IoT')).toBe('cat-iot');
  });

  /* The one failure mode with real consequences: two categories colliding would
     aim both their chips at the same section, silently making one unreachable.
     Runs over the WHOLE shipped category set, so adding a category that collides
     with an existing one fails here rather than in someone's browser. */
  it('is collision-free across every shipped category', () => {
    const ids = CATEGORY_ORDER.map(sectionId);
    expect(new Set(ids).size).toBe(CATEGORY_ORDER.length);
    for (const id of ids) expect(id).toMatch(/^cat-[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('CategoryNav', () => {
  it('renders one anchor per category, carrying its section id and count', () => {
    const html = render(<CategoryNav items={items} />);
    expect(html).toContain('href="#cat-compute"');
    expect(html).toContain('href="#cat-networking-content-delivery"');
    expect(html).toContain('Compute');
    expect(html).toContain('>12<');
    expect(html).toContain('>13<');
  });

  it('is a labelled landmark, so the rail is reachable as navigation', () => {
    const html = render(<CategoryNav items={items} />);
    expect(html).toContain('<nav');
    expect(html).toContain('aria-label="Jump to category"');
  });

  /* A single category is the whole page — a rail with one chip navigates
     nowhere and would just cost vertical space in the sticky bar. */
  it('renders nothing when there are fewer than two categories to move between', () => {
    expect(render(<CategoryNav items={[]} />)).toBe('');
    expect(render(<CategoryNav items={[items[0]!]} />)).toBe('');
  });

  /* Chips stay real links: middle-click/⌘-click and "open in new tab" keep
     working, and the href is what makes them keyboard-reachable at all. */
  it('keeps every chip a real anchor with an href', () => {
    const html = render(<CategoryNav items={items} />);
    const anchors = html.match(/<a /g) ?? [];
    expect(anchors).toHaveLength(items.length);
    expect(html).not.toContain('href=""');
  });
});
