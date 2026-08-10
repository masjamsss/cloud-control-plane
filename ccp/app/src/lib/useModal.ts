import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type TabTrapTarget = 'first' | 'last' | null;

/**
 * The Tab-cycle trap's decision logic, pulled out of the keydown handler as
 * a pure function so it is unit-testable without a DOM — this repo has no
 * jsdom/happy-dom or @testing-library/react (see TEST-7), so `useModal`'s
 * actual focus/DOM-touching effects can only be exercised indirectly, via
 * the SSR/markup tests on each dialog's rendered output. This piece — which
 * end of the focusable-items list Tab or Shift+Tab should redirect to — has
 * no DOM dependency at all and can be verified directly.
 *
 * `activeIndex` mirrors `items.indexOf(document.activeElement)`, but
 * distinguishes two different "not one of the items" cases the caller must
 * compute up front: `null` means the currently focused element is OUTSIDE
 * the dialog container entirely (focus escaped, or nothing is focused) —
 * Tab must be pulled back in. `-1` means the focused element IS inside the
 * container but isn't one of the enumerated focusable items (e.g. the
 * container itself, focused via its `tabIndex={-1}` fallback) — that's
 * genuinely "the middle of nowhere" and, like any non-edge index, is left
 * alone so the browser's default Tab behavior proceeds unmodified.
 *
 * Returns which end to focus (`'first'` | `'last'`), or `null` if the
 * caller should do nothing and let Tab behave normally (focus is already on
 * a middle item, mid-cycle). Callers with zero focusable items never reach
 * this function — that case is handled by unconditionally suppressing Tab
 * one level up, since there is nothing to redirect to.
 */
export function tabTrapTarget(
  itemCount: number,
  activeIndex: number | null,
  shiftKey: boolean,
): TabTrapTarget {
  if (itemCount === 0) return null;
  const atFirst = activeIndex === 0;
  const atLast = activeIndex === itemCount - 1;
  const outside = activeIndex === null;
  if (shiftKey) return atFirst || outside ? 'last' : null;
  return atLast || outside ? 'first' : null;
}

/**
 * UI-6 — the shared modal behavior every hand-rolled `role="dialog"` overlay
 * in this app needs and none of them fully had: initial focus MOVES into the
 * dialog on open, Escape closes it, Tab/Shift+Tab CYCLE within it instead of
 * escaping to the page behind (which stays visually obscured but was fully
 * tab-reachable and screen-reader-browsable before this fix — the page was
 * never actually inert while a drawer sat over it), and focus RETURNS to
 * whatever triggered the dialog once it closes. This is the primitive Radix
 * (`@radix-ui/react-dialog`) would otherwise provide — kept as a small local
 * hook instead of a new dependency since the app already has two other Radix
 * packages wired for different overlay classes (dropdown-menu, popover) and
 * this app's drawers are simple enough not to need Radix's fuller feature
 * set (portals, nested-dialog stacking, etc.).
 *
 * `containerRef` must point at the dialog's own root element — the one
 * carrying `role="dialog"` — and that element must itself carry
 * `tabIndex={-1}` (the same convention `ErrorSummary`/`RouteSkeleton` already
 * use) so it can receive focus when the dialog has no other focusable
 * control. This hook does not render anything and does not set
 * `aria-modal` — every caller still owns its own JSX for those.
 */
export function useModal(containerRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  const triggerRef = useRef<Element | null>(null);

  // Mount-only: capture the trigger and move focus in once, restore it on close.
  // Deliberately NOT re-run on every render (which a naive [containerRef, onClose]
  // dependency list would do) — a drawer with a controlled input re-renders on every
  // keystroke, and re-running "focus the first control" on each of those would yank
  // focus back to the top of the dialog while someone is mid-sentence in a textarea.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    const container = containerRef.current;
    const first =
      (container?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? undefined) || container;
    first?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.contains(trigger)) trigger.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The keydown handler itself is cheap to re-attach — safe to depend on onClose.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const container = containerRef.current;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !container) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (items.length === 0) {
        e.preventDefault(); // nothing to cycle to — refuse to let Tab leave the dialog
        return;
      }
      const active = document.activeElement;
      const activeIndex = container.contains(active) ? items.indexOf(active as HTMLElement) : null;
      const target = tabTrapTarget(items.length, activeIndex, e.shiftKey);
      if (target === 'first') {
        e.preventDefault();
        items[0]!.focus();
      } else if (target === 'last') {
        e.preventDefault();
        items[items.length - 1]!.focus();
      }
    }
    // Capture phase: Escape must close the dialog regardless of which descendant
    // (an input, a Radix subcomponent) would otherwise consume the keydown first.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [containerRef, onClose]);
}
