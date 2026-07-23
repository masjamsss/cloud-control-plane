import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { JSX } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Inventory, ManifestParam } from '@/types';
import {
  asListValue,
  buildPickerOptions,
  PICKER_OVERSCAN,
  PICKER_ROW_PX,
  resourceTypeOf,
  toggleListValue,
  type PickerOption,
} from '@/lib/inventoryPicker';

export interface InventoryPickerProps {
  param: ManifestParam;
  value: unknown;
  inventory: Inventory;
  id: string;
  labelId?: string;
  invalid?: boolean;
  describedBy?: string;
  /** Bounded multi-select mode for list params: options toggle
   * membership, chosen entries render as removable chips, and the picker
   * refuses to stage more than bounds.maxItems. Default false: the classic
   * single-select combobox, unchanged. */
  multiple?: boolean;
  onChange: (name: string, value: unknown) => void;
  onBlur: (name: string) => void;
}

/**
 * A searchable combobox over the account inventory, filtered to the parameter's
 * target resource type. Every option shows the human name, the address, and a
 * current attribute value — never a raw address `<select>`. Selecting an option
 * commits its address via onChange.
 *
 * "InventoryPicker at estate scale": opening this with an empty
 * query used to mount every matching option as a real DOM node — up to ~350
 * for a broad type like `aws_ebs_volume` (352 in the bundled estate). The
 * options panel is now windowed with the same `@tanstack/react-virtual`
 * instance CommandPalette and VirtualRows already use (no new dependency),
 * so mounted nodes stay bounded (`estimateMountedOptionCount`,
 * `inventoryPicker.test.ts`) regardless of resource-type breadth. Because
 * only a slice of options is ever mounted, `aria-activedescendant` must
 * always reference one that IS mounted — `moveActive` below scrolls the
 * newly-active option into view on every arrow-key press, same fix
 * CommandPalette applied for the identical reason (its module doc comment).
 * The pure options build moved to `lib/inventoryPicker.ts` alongside the
 * O(n) fix (was `.find()` per address against the whole inventory — O(n·m)).
 *
 * Multi-select mode (`multiple`): the SAME windowed listbox, but
 * committing an option TOGGLES membership (aria-multiselectable; the panel
 * stays open for the next pick), the selection renders as removable chips
 * above the input, Backspace on an empty query removes the last chip, and
 * `bounds.maxItems` is enforced at interaction time (a full list refuses
 * further adds) as well as by validation. Pure list logic lives in
 * lib/inventoryPicker.ts (asListValue / toggleListValue) so it is testable
 * without a DOM.
 */
export function InventoryPicker({
  param,
  value,
  inventory,
  id,
  labelId,
  invalid = false,
  describedBy,
  multiple = false,
  onChange,
  onBlur,
}: InventoryPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const resourceType = resourceTypeOf(param);
  const listId = `${id}-listbox`;
  const maxItems = param.bounds?.maxItems;

  const options = useMemo<PickerOption[]>(() => buildPickerOptions(param, inventory), [param, inventory]);

  const chosen = useMemo<string[]>(() => (multiple ? asListValue(value) : []), [multiple, value]);
  const selected = multiple ? undefined : options.find((o) => o.address === String(value ?? ''));
  const atMax = multiple && maxItems !== undefined && chosen.length >= maxItems;

  const filtered = useMemo<PickerOption[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || o.address.toLowerCase().includes(q),
    );
  }, [options, query]);

  // The index actually shown/selectable — `active` itself can point past the
  // end right after a keystroke shrinks `filtered` (unchanged pre-existing
  // behavior: `active` is only clamped at render/selection time, not reset
  // on every filtered-length change).
  const activeIndex = filtered.length > 0 ? Math.min(active, filtered.length - 1) : 0;

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => PICKER_ROW_PX,
    overscan: PICKER_OVERSCAN,
  });

  const commit = (opt: PickerOption): void => {
    if (multiple) {
      // Toggle membership; the panel stays open so the next pick is one click
      // away. maxItems is enforced inside toggleListValue (a full list
      // refuses adds; removals always work).
      onChange(param.name, toggleListValue(chosen, opt.address, maxItems));
      setQuery('');
      return;
    }
    onChange(param.name, opt.address);
    setQuery('');
    setOpen(false);
    onBlur(param.name);
  };

  const removeChip = (address: string): void => {
    onChange(
      param.name,
      chosen.filter((v) => v !== address),
    );
  };

  const openMenu = (): void => {
    setQuery('');
    setActive(0);
    setOpen(true);
  };

  // Move the highlighted option and keep it mounted+in view — once the panel
  // is windowed, aria-activedescendant must always reference an option that
  // IS in the DOM (same requirement/fix as CommandPalette's moveHighlight).
  const moveActive = (next: number): void => {
    setActive(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openMenu();
      else moveActive(Math.min(activeIndex + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && filtered.length > 0) {
        e.preventDefault();
        const opt = filtered[activeIndex];
        if (opt) commit(opt);
      }
    } else if (e.key === 'Backspace') {
      // Multi-select affordance: an empty query + Backspace removes the most
      // recently added chip, so a keyboard user never has to leave the input.
      if (multiple && query === '' && chosen.length > 0) {
        e.preventDefault();
        const last = chosen[chosen.length - 1];
        if (last !== undefined) removeChip(last);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery('');
      }
    }
  };

  const activeId = open && filtered.length > 0 ? `${id}-opt-${activeIndex}` : undefined;

  const displayValue = multiple
    ? query
    : open
      ? query
      : selected
        ? `${selected.name} · ${selected.address}`
        : '';

  const optionsByAddress = useMemo(
    () => new Map(options.map((o) => [o.address, o] as const)),
    [options],
  );

  return (
    <div className="sf-combo">
      {multiple && chosen.length > 0 && (
        <ul className="sf-combo__chips" aria-labelledby={labelId}>
          {chosen.map((address) => {
            const opt = optionsByAddress.get(address);
            const name = opt?.name ?? address;
            return (
              <li key={address} className="sf-chip">
                <span className="sf-chip__name">{name}</span>
                <button
                  type="button"
                  className="sf-chip__remove"
                  aria-label={`Remove ${name}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeChip(address)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        className="sf-input sf-combo__input"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-activedescendant={activeId}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-labelledby={labelId}
        placeholder={multiple ? (atMax ? 'Selection is full' : 'Search resources…') : selected ? undefined : 'Search resources…'}
        value={displayValue}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          if (!open) setOpen(true);
        }}
        onFocus={openMenu}
        onClick={openMenu}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setOpen(false);
          setQuery('');
          onBlur(param.name);
        }}
      />
      {open && (
        // A plain div, not a literal <ul>/<li> (role="listbox"/"option" carry
        // the semantics assistive tech uses) — windowing means only a slice
        // of options is ever a DOM descendant, same tradeoff cmdk's own
        // Command.List/Command.Item already accept in CommandPalette.tsx, and
        // it keeps the virtualizer's absolutely-positioned sizer child valid
        // markup (a bare <div> is not permitted content inside a real <ul>).
        <div
          className="sf-combo__panel"
          id={listId}
          role="listbox"
          aria-multiselectable={multiple || undefined}
          ref={listRef}
        >
          {filtered.length === 0 ? (
            <div className="sf-combo__empty" role="option" aria-selected={false} aria-disabled>
              No eligible {resourceType ?? 'resources'} in this account
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const opt = filtered[vi.index]!;
                const i = vi.index;
                const isChosen = multiple
                  ? chosen.includes(opt.address)
                  : opt.address === selected?.address;
                const addRefused = multiple && atMax && !isChosen;
                return (
                  <div
                    key={opt.address}
                    data-index={i}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <div
                      id={`${id}-opt-${i}`}
                      role="option"
                      aria-selected={isChosen}
                      aria-disabled={addRefused || undefined}
                      className={
                        'sf-combo__option' +
                        (i === activeIndex ? ' is-active' : '') +
                        (isChosen ? ' is-chosen' : '') +
                        (addRefused ? ' is-refused' : '')
                      }
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commit(opt);
                      }}
                      onMouseEnter={() => setActive(i)}
                    >
                      {multiple && (
                        <span className="sf-combo__check" aria-hidden="true">
                          {isChosen ? '✓' : ''}
                        </span>
                      )}
                      <span className="sf-combo__name">{opt.name}</span>
                      <span className="sf-combo__addr">{opt.address}</span>
                      {opt.current !== null && <span className="sf-combo__current">{opt.current}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
