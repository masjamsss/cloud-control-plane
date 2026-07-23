import type { JSX, Ref } from 'react';
import './request.css';

export interface ErrorSummaryItem {
  /** Param name — the anchor target is `#field-<name>`. */
  name: string;
  label: string;
  message: string;
}

export interface ErrorSummaryProps {
  items: ErrorSummaryItem[];
  /** React 19: `ref` is a regular prop on function components now —
   * `forwardRef` is no longer needed to accept one (still supported, but
   * deprecated as of 19; see the module history for the pre-19 form). */
  ref?: Ref<HTMLDivElement>;
}

/**
 * GOV.UK-style error summary. Rendered at the top of the form on an invalid
 * Review attempt; RequestFlow moves focus here (the container is focusable via
 * `tabIndex={-1}`) and each entry links to its field. Deterministic copy — the
 * same string appears inline and in the summary.
 */
export function ErrorSummary({ items, ref }: ErrorSummaryProps): JSX.Element {
  return (
    <div
      className="rq-errsum"
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-labelledby="rq-errsum-heading"
    >
      <h2 id="rq-errsum-heading" className="rq-errsum__heading">
        There is a problem
      </h2>
      <ul className="rq-errsum__list">
        {items.map((item) => (
          <li key={item.name}>
            <a className="rq-errsum__link" href={`#field-${item.name}`}>
              {item.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
