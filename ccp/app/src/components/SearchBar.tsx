import type { JSX } from 'react';
import './searchbar.css';

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** Optional right-aligned count, e.g. "12 of 58". */
  count?: string;
}

/**
 * Shared search input. Presentational and controlled: the parent owns the raw
 * value (so typing is instant) and runs it through useDebouncedValue for the
 * actual filtering.
 */
export function SearchBar({ value, onChange, placeholder, ariaLabel, count }: SearchBarProps): JSX.Element {
  return (
    <div className="searchbar">
      <span className="searchbar__icon" aria-hidden="true">
        ⌕
      </span>
      <input
        type="search"
        className="searchbar__input"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? 'Search'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {count && (
        <span className="searchbar__count" aria-live="polite">
          {count}
        </span>
      )}
    </div>
  );
}

export default SearchBar;
