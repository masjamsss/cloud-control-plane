import type { JSX } from 'react';
import type { RiskFloor } from '@/types';
import { Badge, type BadgeColor } from './Badge';

export interface RiskBadgeProps {
  risk: RiskFloor;
}

const RISK_COLOR: Record<RiskFloor, BadgeColor> = {
  LOW: 'ok',
  MEDIUM: 'warn',
  HIGH: 'crit',
};

/**
 * Maps a RiskFloor to its semantic token color and renders a labelled pill.
 */
export function RiskBadge({ risk }: RiskBadgeProps): JSX.Element {
  return (
    <Badge color={RISK_COLOR[risk]} title={`Risk floor: ${risk}`}>
      {risk}
    </Badge>
  );
}
