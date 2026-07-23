import { useEffect, useState } from 'react';

/**
 * Debounce a fast-changing value (e.g. a search box). The input stays instantly
 * responsive because the caller holds the raw value; only the returned value —
 * used for filtering — lags by `delayMs`, so we don't re-filter on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
