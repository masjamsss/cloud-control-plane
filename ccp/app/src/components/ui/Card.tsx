import type { HTMLAttributes, ReactNode } from 'react';
import type { JSX } from 'react';
import './ui.css';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Optional header title rendered above the card body. */
  title?: ReactNode;
  /** Optional element rendered on the right side of the header (e.g. a badge). */
  actions?: ReactNode;
  /** Adds a subtle interactive hover treatment (for clickable cards). */
  interactive?: boolean;
  children: ReactNode;
}

/**
 * Panel container using the --panel token surface. Optionally renders a
 * header row with a title and trailing actions slot.
 */
export function Card({
  title,
  actions,
  interactive = false,
  children,
  className,
  ...rest
}: CardProps): JSX.Element {
  const classes = ['ui-card', interactive ? 'ui-card--interactive' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} {...rest}>
      {(title !== undefined || actions !== undefined) && (
        <div className="ui-card__head">
          {title !== undefined && <div className="ui-card__title">{title}</div>}
          {actions !== undefined && <div className="ui-card__actions">{actions}</div>}
        </div>
      )}
      <div className="ui-card__body">{children}</div>
    </div>
  );
}
