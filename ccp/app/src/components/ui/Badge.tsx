import type { ReactNode } from 'react';
import type { JSX } from 'react';
import './ui.css';

export type BadgeColor =
  | 'ok'
  | 'warn'
  | 'crit'
  | 'human'
  | 'brass'
  | 'muted';

export interface BadgeProps {
  color?: BadgeColor;
  children: ReactNode;
  title?: string;
}

/**
 * Generic pill. Semantic color driven by the `color` prop, mapped to the
 * design tokens in ui.css. Defaults to a neutral/muted pill.
 */
export function Badge({ color = 'muted', children, title }: BadgeProps): JSX.Element {
  return (
    <span className={`ui-badge ui-badge--${color}`} title={title}>
      {children}
    </span>
  );
}
