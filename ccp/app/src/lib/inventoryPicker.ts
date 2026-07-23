import type { Inventory, InventoryResource, ManifestParam } from '@/types';
import { parseInventoryEnum, resolveEnum } from '@/lib/interpreter';

/**
 * Pure data layer for {@link InventoryPicker} (the same
 * DOM-free split `lib/palette.ts` already uses for CommandPalette, so this
 * is directly testable without jsdom/RTL, this app has neither, see
 * src/test/setup.ts).
 */

export interface PickerOption {
  address: string;
  name: string;
  current: string | null;
}

/** Attributes we prefer to surface as the "current value" chip, in priority order. */
const CURRENT_KEYS = [
  'instance_type',
  'instance_class',
  'size',
  'volume_size',
  'engine',
  'engine_version',
  'class',
  'type',
];

function pickCurrent(resource: InventoryResource): string | null {
  // Placement rows (subnets) answer "where is it and what range" in one chip —
  // the mount-target picker shows zone + CIDR, not just the zone.
  const az = resource.attributes['availability_zone'];
  const cidr = resource.attributes['cidr_block'];
  if (az !== undefined && az !== '' && cidr !== undefined && cidr !== '') {
    return `${String(az)} · ${String(cidr)}`;
  }
  for (const key of CURRENT_KEYS) {
    const v = resource.attributes[key];
    if (v !== undefined && v !== '') return String(v);
  }
  const first = Object.entries(resource.attributes)[0];
  return first ? String(first[1]) : null;
}

/** Parse the resource type from an `inventory://<type>/<field>` enumSource —
 * via the interpreter's parseInventoryEnum, the ONE place the URI convention
 * is decoded (this file used to re-parse it independently). */
export function resourceTypeOf(param: ManifestParam): string | null {
  return parseInventoryEnum(param.enumSource)?.type ?? null;
}

/* ── Multi-select mode (bounded list params) ─────────────────────── */

/**
 * True when a param is a LIST whose options come from the inventory — the
 * params the picker renders in multi-select mode (security-group lists,
 * subnet lists, notification-topic lists).
 *
 * Deliberately requires source:"inventory", not merely an enumSource:
 * `rds-change-subnet-group-subnets` declares source:"user_input" with an
 * `inventory://aws_subnet/id` enum, but this HCL-derived inventory carries no
 * computed `id` attribute at all — the enum resolves EMPTY, so routing it to
 * a picker would turn a typeable field into a dead end. It keeps its text
 * input untouched until its data path is re-authored (a manifest/data task,
 * not a form-engine one).
 */
export function isInventoryListParam(
  param: Pick<ManifestParam, 'type' | 'source' | 'enumSource'>,
): boolean {
  return (
    param.type === 'list' &&
    param.source === 'inventory' &&
    parseInventoryEnum(param.enumSource) !== null
  );
}

/** Normalize a form value to the picker's list shape: an array of the chosen
 * option values, tolerating the pre-multi-select single-string shape. */
export function asListValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v !== '');
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

/**
 * Toggle one option in a bounded multi-select list: chosen → removed;
 * absent → appended, unless the list already sits at `maxItems` (the add is
 * refused — the bound is enforced at interaction time AND by validation, so
 * the picker can never even stage an over-long list). Pure; order of the
 * remaining entries is preserved.
 */
export function toggleListValue(
  current: string[],
  option: string,
  maxItems?: number,
): string[] {
  if (current.includes(option)) return current.filter((v) => v !== option);
  if (maxItems !== undefined && current.length >= maxItems) return current;
  return [...current, option];
}

/**
 * Every selectable option for an inventory-sourced parameter, in resolveEnum
 * order — the picker's full option list, before the user's text filter.
 *
 * O(n) — was O(n·m): the previous version called
 * `inventory.resources.find(...)` once per resolved address, i.e. a full
 * linear scan of the ENTIRE inventory (up to 1,418 resources) for every one
 * of up to ~350 addresses of a broad resource type. This builds one
 * `Map<address, resource>` from the inventory ONCE, then does an O(1) lookup
 * per address.
 */
export function buildPickerOptions(param: ManifestParam, inventory: Inventory): PickerOption[] {
  const addresses = resolveEnum(param, inventory);
  const byAddress = new Map(inventory.resources.map((r) => [r.address, r] as const));
  return addresses.map((address) => {
    const r = byAddress.get(address);
    return {
      address,
      name: r?.name ?? address,
      current: r ? pickCurrent(r) : null,
    };
  });
}

/* ── Virtualization bounds (the "opens with <=~20 mounted options" claim) ──── */

/** Estimated option row height in px — used only as the virtualizer's
 * initial guess; @tanstack/react-virtual remeasures real rows once mounted
 * (see InventoryPicker.tsx's `measureElement`), same as CommandPalette /
 * VirtualRows. */
export const PICKER_ROW_PX = 52;
/** Matches `.sf-combo__panel`'s `max-height` in SchemaForm.css — the fixed
 * scrollable viewport the picker's options render into. */
export const PICKER_PANEL_PX = 320;
/** Rows kept mounted beyond the visible viewport on each side, for smooth
 * keyboard nav and scrolling. Configured on the SAME useVirtualizer call in
 * InventoryPicker.tsx that this constant documents. */
export const PICKER_OVERSCAN = 6;

/**
 * The number of options @tanstack/react-virtual will actually mount for a
 * list of `total` options, given the picker panel's fixed viewport height
 * and its row/overscan configuration — mirrors react-virtual's own
 * windowing formula (visible rows implied by the viewport, plus overscan on
 * both sides), clamped to `total` once the list fits on one screen. Same
 * restatement palette.ts's `estimateMountedRowCount` uses, kept local here
 * since the two pickers window independently configured lists.
 */
export function estimateMountedOptionCount(
  total: number,
  viewportPx: number,
  rowPx: number,
  overscan: number,
): number {
  const visible = Math.ceil(viewportPx / rowPx);
  return Math.min(total, visible + overscan * 2);
}
