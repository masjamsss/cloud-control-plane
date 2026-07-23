import type { JSX } from 'react';
import type { Exposure, ManifestOperation, RiskFloor } from '@/types';
import { resolveRisk } from '@/lib/riskOverrides';
import { RiskBadge } from './RiskBadge';
import { AccessBadge } from './AccessBadge';
import './ui.css';

export interface OpChipData {
  risk: RiskFloor;
  exposure: Exposure;
}

/**
 * Pure derivation of the two badge axes for one operation: risk
 * (the colored axis, a Lead's override if set — see resolveRisk) and exposure
 * (the steel review-requirement axis, always the manifest value — there is no
 * override concept for exposure). Exported so the "both axes are independent"
 * contract is directly testable without mounting <OpChips>: 8 ops in the real
 * catalog have risk/exposure combinations off the LOW/self·MEDIUM/guard·
 * HIGH/engineer "diagonal", which is exactly why one chip can never encode
 * both — see OpChips.test.ts.
 */
export function opChipData(
  op: Pick<ManifestOperation, 'id' | 'riskFloor' | 'exposure'>,
): OpChipData {
  return { risk: resolveRisk(op), exposure: op.exposure };
}

export interface OpChipsProps {
  op: ManifestOperation;
}

/**
 * Shared, compact chip row for a list row: the risk badge (colored axis) and
 * the exposure badge (steel axis) rendered independently, side by side. Used
 * on every op row across the palette, the scoped action picker, and (via the
 * same two components individually) the request form — one place that decides
 * "how does an op's risk+exposure read in a dense list", reused everywhere
 * rather than re-derived per surface.
 */
export function OpChips({ op }: OpChipsProps): JSX.Element {
  const { risk, exposure } = opChipData(op);
  return (
    <span className="op-chips">
      <RiskBadge risk={risk} />
      <AccessBadge exposure={exposure} />
    </span>
  );
}
