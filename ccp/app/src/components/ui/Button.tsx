import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { JSX } from 'react';
import './ui.css';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

/**
 * Console button. Three variants:
 *  - primary: brass accent, the affirmative action
 *  - ghost:   quiet, outlined secondary action
 *  - danger:  critical/destructive action
 */
export function Button({
  variant = 'primary',
  children,
  className,
  type,
  ...rest
}: ButtonProps): JSX.Element {
  const classes = ['ui-btn', `ui-btn--${variant}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type ?? 'button'} className={classes} {...rest}>
      {children}
    </button>
  );
}
