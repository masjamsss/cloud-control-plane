import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChangeRequest, InventoryResource, ServiceManifest, User } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId, useProject } from '@/lib/ProjectContext';
import { useSettings } from '@/lib/settings';
import { OpChips } from '@/components/ui/OpChips';
import {
  buildPaletteSections,
  filterPaletteSections,
  firstSelectableRowIndex,
  flattenPaletteSections,
  isSelectableRow,
  lastSelectableRowIndex,
  nextSelectableRowIndex,
  PALETTE_HEADER_PX,
  PALETTE_OVERSCAN,
  PALETTE_ROW_PX,
  shouldShowResources,
  type PaletteEntry,
  type PaletteRow,
} from '@/lib/palette';
import './command-palette.css';

// Kept re-exported from here (unchanged shape/behavior) so existing imports
// of `@/components/CommandPalette` — including palette.test.ts — keep working.
export { minQueryToShowResources, resourceToPaletteItem } from '@/lib/palette';
export type { ResourcePaletteItem } from '@/lib/palette';

/** One row's visible content — a header label, or an entry's mono/title/chips/hint. */
function RowBody({ row }: { row: PaletteEntry }): JSX.Element {
  return (
    <>
      {row.mono && (
        <span className="cmdp__mono" aria-hidden="true">
          {row.mono}
        </span>
      )}
      <span className="cmdp__item-title">{row.title}</span>
      {row.kind === 'op' && row.op && <OpChips op={row.op} />}
      {row.hint && <span className="cmdp__hint">{row.hint}</span>}
    </>
  );
}

/**
 * Cmd/Ctrl+K command palette. Deterministic search over the
 * bundled catalog — services, operations, navigation, the signed-in user's
 * requests, estate resources, and the beyond-catalog escape hatch. No
 * network beyond the existing mock ApiClient, no AI.
 *
 * "palette scale fixes": at 680+ ops and (soon) 1,300+
 * resources, cmdk's default `shouldFilter` behavior mounts every candidate
 * Command.Item up front and hides non-matches with CSS, which does not
 * scale (cmdk's own README documents `shouldFilter={false}` + externally
 * filtered items as the supported alternative for exactly this case). This
 * component owns filtering itself (lib/palette.ts, DOM-free and unit
 * tested) and windows the resulting flat row list with ONE
 * @tanstack/react-virtual instance, so mounted DOM nodes stay bounded
 * regardless of catalog size. Because only a slice of rows is ever mounted,
 * cmdk's native DOM-based roving focus (which needs every candidate
 * mounted) can't drive arrow-key navigation here — ArrowUp/ArrowDown/Home/
 * End are handled in onKeyDown below instead, calling
 * e.preventDefault() so cmdk's own switch (which cmdk runs AFTER the
 * consumer's onKeyDown, skipping its own handling once defaultPrevented) is
 * skipped for exactly those keys. Escape/Tab and typing into the input are
 * untouched — cmdk (Escape is actually Radix Dialog's own handling) and the
 * browser continue to own those.
 *
 * "palette keystroke pipeline": the query is deferred
 * (`useDeferredValue`), and section *construction* is memoized separately
 * from *filtering*. Before this, `buildPaletteSections` took the raw query
 * merely to gate the Resources section, but that made it a dependency of
 * the whole (~11 ms-at-full-catalog) build memo — so all 680 ops were
 * re-mapped, and every op's admin-disabled flag re-read from settings, on
 * every keystroke (measured in `scripts/palette-bench.ts`). Now the build
 * memo depends only on `[user, manifests, resources, myRequests,
 * showResources]` — a boolean that flips at most twice per search, not a
 * string that changes every keystroke — and `buildPaletteSections` reads
 * settings exactly once per call instead of once per operation. Only
 * `filterPaletteSections` + `flattenPaletteSections` still run per
 * keystroke, over the already-built sections, at deferred priority; the
 * `isStale` flag dims the list while that catches up, same affordance as
 * `ServiceConsole.tsx`'s deferred resource filter.
 */
export function CommandPalette({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User;
}): JSX.Element {
  const navigate = useNavigate();
  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [resources, setResources] = useState<InventoryResource[]>([]);
  const [myRequests, setMyRequests] = useState<ChangeRequest[]>([]);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // The palette lives in AppShell and never unmounts on a project switch —
  // without this key its mount-time data would keep serving the old project.
  const projectId = useActiveProjectId();

  useEffect(() => {
    let alive = true;
    void api.listManifests().then((m) => {
      if (alive) setManifests(m);
    });
    void api.getInventory().then((inv) => {
      if (alive) setResources(inv.resources);
    });
    // Approvers/leads additionally see requests pending THEIR approval — which
    // may belong to other people — merged into the same "My requests" group.
    const canApproveRole = user.role === 'approver' || user.role === 'lead';
    void Promise.all([
      api.listRequests(user.id),
      canApproveRole ? api.listPendingApprovals(user) : Promise.resolve([]),
    ]).then(([mine, pending]) => {
      if (!alive) return;
      const byId = new Map<string, ChangeRequest>();
      for (const r of [...mine, ...pending]) byId.set(r.id, r);
      setMyRequests([...byId.values()]);
    });
    return () => {
      alive = false;
    };
  }, [user, projectId]);

  // Deferred so the expensive build/filter pipeline never blocks a
  // keystroke's paint — the input below stays controlled by the
  // raw `query`, so typing itself is always instant; only the rows lag.
  const deferredQuery = useDeferredValue(query);
  const isStale = query.trim() !== deferredQuery.trim();
  const showResources = shouldShowResources(deferredQuery);
  // Live settings snapshot, named as a build-stage dependency below.
  // buildPaletteSections() still reads getSettings() itself (same cache, so
  // this costs nothing extra) — `settings` is here purely so an admin
  // disabling/enabling an op (this tab or another) actually invalidates the
  // build memo. Before this, disabledOps wasn't a tracked dependency at all:
  // the palette mounts once per AppShell lifetime, so a toggle elsewhere
  // never appeared in an already-open session.
  const settings = useSettings();

  // Stage 1 — build: depends on data + the showResources gate + settings, so
  // retyping within the same gate state never re-triggers the ~680-op
  // rebuild (see the module doc comment) — only an actual data or settings
  // change does.
  const paletteProvider = useProject().provider ?? 'aws';
  const sections = useMemo(
    () =>
      buildPaletteSections({
        user,
        manifests,
        resources,
        myRequests,
        showResources,
        provider: paletteProvider,
      }),
    [user, manifests, resources, myRequests, showResources, settings, paletteProvider],
  );
  // Stage 2 — filter + flatten: the cheap per-keystroke stage (well
  // under a millisecond even at estate scale), run at deferred priority.
  const filtered = useMemo(
    () => filterPaletteSections(sections, deferredQuery),
    [sections, deferredQuery],
  );
  const rows = useMemo(() => flattenPaletteSections(filtered), [filtered]);
  const rowIndexById = useMemo(() => new Map(rows.map((r, i) => [r.id, i] as const)), [rows]);
  // Rows are no longer nested inside a real Command.Group (see the module
  // doc comment), so screen readers lose the automatic group->item
  // aria-labelledby association cmdk provides natively. This restores an
  // equivalent per-item announcement ("Resize an instance — Operations")
  // without needing every row to actually be a DOM descendant of its heading.
  const sectionHeadingById = useMemo(
    () => new Map(filtered.map((s) => [s.id, s.heading] as const)),
    [filtered],
  );

  // The query (or the underlying data) changed the row list — re-derive the
  // highlight rather than keep a stale/out-of-bounds index. Mirrors cmdk's
  // own native behavior: it re-selects the first match on every search
  // change too (see cmdk's internal J(), scheduled off every "search" update).
  useEffect(() => {
    setHighlightedIndex(Math.max(0, firstSelectableRowIndex(rows)));
  }, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? PALETTE_HEADER_PX : PALETTE_ROW_PX),
    overscan: PALETTE_OVERSCAN,
  });

  const highlightedRow = rows[highlightedIndex];
  const highlightedValue =
    highlightedRow && isSelectableRow(highlightedRow) ? highlightedRow.id : undefined;

  const go = (to: string): void => {
    onOpenChange(false);
    navigate(to);
  };

  const moveHighlight = (delta: 1 | -1): void => {
    const next = nextSelectableRowIndex(rows, highlightedIndex, delta);
    setHighlightedIndex(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const jumpHighlight = (to: 'first' | 'last'): void => {
    const next = to === 'first' ? firstSelectableRowIndex(rows) : lastSelectableRowIndex(rows);
    if (next < 0) return;
    setHighlightedIndex(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const selectHighlighted = (): void => {
    const row = rows[highlightedIndex];
    if (row && isSelectableRow(row)) go(row.to);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveHighlight(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveHighlight(-1);
        break;
      case 'Home':
        e.preventDefault();
        jumpHighlight('first');
        break;
      case 'End':
        e.preventDefault();
        jumpHighlight('last');
        break;
      case 'Enter':
        e.preventDefault();
        selectHighlighted();
        break;
      default:
        break;
    }
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command menu"
      className="cmdp"
      shouldFilter={false}
      value={highlightedValue}
      onValueChange={(id) => {
        const idx = rowIndexById.get(id);
        if (idx !== undefined) setHighlightedIndex(idx);
      }}
      onKeyDown={onKeyDown}
    >
      <Command.Input
        className="cmdp__input"
        placeholder="Search services, operations, requests, resources…"
        value={query}
        onValueChange={setQuery}
      />
      <Command.List
        className={isStale ? 'cmdp__list cmdp__list--stale' : 'cmdp__list'}
        aria-busy={isStale}
        ref={listRef}
      >
        {rows.length === 0 ? (
          <div className="cmdp__empty">No matches.</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row: PaletteRow = rows[vi.index]!;
              return (
                <div
                  key={row.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {row.kind === 'header' ? (
                    <div className="cmdp__row-header">{row.label}</div>
                  ) : (
                    <Command.Item
                      value={row.id}
                      onSelect={() => go(row.to)}
                      className="cmdp__item"
                      aria-label={`${row.title} — ${sectionHeadingById.get(row.sectionId) ?? row.kind}`}
                    >
                      <RowBody row={row} />
                    </Command.Item>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
