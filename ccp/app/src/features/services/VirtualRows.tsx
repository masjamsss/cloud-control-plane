import { useRef } from 'react';
import type { JSX } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ManifestOperation } from '@/types';
import type { InventoryResource } from '@/types';
import { summarizeChildren, type FamilyRow } from '@/lib/resourceFamily';
import { ResourceRow } from './ResourceRow';

/**
 * Windowed rendering for a large, expanded resource group. Only the
 * visible rows are in the DOM, so a service like EBS (350+ volumes) stays smooth.
 * Row heights vary (chips), so heights are measured. The scroll container uses
 * overflow-y:auto — safe now that ResourceRow's actions menu is a portalled Radix
 * dropdown that escapes the container instead of being clipped by it.
 */
export function VirtualRows({
  rows,
  serviceSlug,
  actionsFor,
  onOpenPicker,
  selection,
}: {
  /** Console-style rows: one per logical resource, config rolled up. */
  rows: FamilyRow[];
  serviceSlug: string;
  actionsFor: (resourceType: string) => ManifestOperation[];
  onOpenPicker: (resource: InventoryResource, actions: ManifestOperation[]) => void;
  /** Bulk multi-select (Phase B), OPTIONAL — threaded to each windowed row. */
  selection?: { isSelected: (address: string) => boolean; onToggle: (address: string) => void };
}): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    overscan: 8,
  });

  return (
    <div ref={parentRef} className="console__vscroll">
      <div
        style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index]!;
          const resource = row.resource;
          return (
            <div
              key={resource.address}
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
              <ResourceRow
                serviceSlug={serviceSlug}
                resource={resource}
                actions={actionsFor(resource.resourceType)}
                childSummary={summarizeChildren(row.children, resource.resourceType)}
                onOpenPicker={onOpenPicker}
                selection={
                  selection
                    ? {
                        selected: selection.isSelected(resource.address),
                        onToggle: selection.onToggle,
                      }
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
