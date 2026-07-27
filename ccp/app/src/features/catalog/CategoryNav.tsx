import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent } from 'react';

export interface CategoryNavItem {
  /** The section's DOM id — what this chip scrolls to. */
  id: string;
  label: string;
  /** Services in the category, after the active search/filters. */
  count: number;
}

/**
 * The catalog's jump rail — one chip per rendered category, pinned under the
 * search row.
 *
 * The console browses the whole provisionable surface (156 services on the
 * bundled AWS estate), which is a ~20,000px single scroll: before this, the
 * only way to reach "Security & Identity" was to scroll past every compute and
 * storage row, and nothing on screen said which category you were currently in.
 * The chips are that missing map — click to jump, and the rail tracks the
 * section you're reading (scrollspy) so your position in the catalog is always
 * legible.
 *
 * Position is read straight off the sections' own rects on scroll (rAF-coalesced,
 * passive listener) rather than through an IntersectionObserver: the active
 * category is simply the LAST section whose top has passed under the sticky
 * chrome, which is exactly what a reader perceives as "the one I'm in" — including
 * for a category taller than the viewport, where an observer's intersection
 * window flickers between neighbours.
 */
export function CategoryNav({ items }: { items: CategoryNavItem[] }): JSX.Element | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  // The chip rail is a horizontal scroller; keep the tracked chip in view
  // without ever scrolling the PAGE (what scrollIntoView would do).
  const activeChipRef = useRef<HTMLAnchorElement | null>(null);

  // Identity of the rendered set, so the scroll listener re-binds when a search
  // or filter changes which categories exist (and not on every parent render).
  const idKey = items.map((i) => i.id).join('|');

  useEffect(() => {
    const ids = idKey.length > 0 ? idKey.split('|') : [];
    if (ids.length === 0) {
      setActiveId(null);
      return;
    }

    let frame = 0;
    const measure = (): void => {
      frame = 0;
      let current = ids[0] ?? null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        // The hand-over line is the section's OWN scroll-margin-top — the exact
        // offset a jump parks it at (catalog.css --catalog-stick, which the
        // narrow-viewport media query redefines). Deriving the line from the
        // scroll target instead of the rail's measured rect keeps "jumped to X"
        // and "reading X" the same answer; measuring the rail put the line a few
        // px above where a jump lands, so a jump highlighted the chip before it.
        // +2 absorbs sub-pixel rect rounding at that point.
        const line = parseFloat(window.getComputedStyle(el).scrollMarginTop) || 0;
        if (el.getBoundingClientRect().top <= line + 2) current = id;
        else break;
      }
      setActiveId(current);
    };

    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [idKey]);

  // Whether the rail has more chips off either edge, published as data-* so the
  // stylesheet can fade that edge. Without it the rail just clips mid-chip and
  // reads as a layout bug rather than "there is more this way" — and a fade
  // baked in unconditionally would dim the leading chip (usually the active,
  // accent-filled one) while the rail sits at rest.
  const syncOverflow = useCallback((): void => {
    const rail = railRef.current;
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    rail.dataset.overflowLeft = String(rail.scrollLeft > 1);
    rail.dataset.overflowRight = String(rail.scrollLeft < max - 1);
  }, []);

  useEffect(() => {
    syncOverflow();
    const rail = railRef.current;
    if (!rail) return;
    rail.addEventListener('scroll', syncOverflow, { passive: true });
    window.addEventListener('resize', syncOverflow, { passive: true });
    return () => {
      rail.removeEventListener('scroll', syncOverflow);
      window.removeEventListener('resize', syncOverflow);
    };
  }, [idKey, syncOverflow]);

  // Keep the tracked chip visible in the rail — nearest-edge only, so a rail
  // that already shows it never moves.
  useEffect(() => {
    const rail = railRef.current;
    const chip = activeChipRef.current;
    if (!rail || !chip) return;
    const pad = 24;
    const left = chip.offsetLeft - pad;
    const right = chip.offsetLeft + chip.offsetWidth + pad;
    if (left < rail.scrollLeft) rail.scrollLeft = left;
    else if (right > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = right - rail.clientWidth;
    syncOverflow();
  }, [activeId, syncOverflow]);

  const jump = useCallback((event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    // Leave modified clicks (new tab/window) and non-primary buttons to the
    // browser — the chips stay real links.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // scroll-margin-top on the section (catalog.css) clears the sticky chrome.
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    setActiveId(id);
  }, []);

  if (items.length < 2) return null;

  return (
    <nav className="catalog__jump" aria-label="Jump to category">
      <div className="catalog__jump-rail" ref={railRef}>
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <a
              key={item.id}
              ref={active ? activeChipRef : undefined}
              href={`#${item.id}`}
              className={`catalog__chip${active ? ' catalog__chip--active' : ''}`}
              aria-current={active ? 'true' : undefined}
              onClick={(e) => jump(e, item.id)}
            >
              {item.label}
              <span className="catalog__chip-count">{item.count}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
