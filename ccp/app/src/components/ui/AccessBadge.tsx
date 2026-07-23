import type { JSX } from 'react';
import type { Exposure } from '@/types';
import { exposureLabel } from '@/lib/interpreter';
import './ui.css';

export interface AccessBadgeProps {
  exposure: Exposure;
}

interface AccessSpec {
  /** Fill-weight modifier class → outline / 12% / 20% on the steel hue. */
  weight: 'self' | 'guard' | 'engineer';
  /** Short label describing the REVIEW required — never a block on submitting. */
  label: string;
}

/**
 * This is a REVIEW requirement, not a submission gate. Any L1 can request any
 * change at any severity; the badge tells the reviewer how much approval it
 * needs before it applies.
 */
// The REVIEW TYPE (how the change is handled), not an approval count —
// the number of approvals is risk-based and shown separately (approvalsRequiredFor).
const ACCESS_SPEC: Record<Exposure, AccessSpec> = {
  l1_self_service: { weight: 'self', label: 'Self-service' },
  l1_with_guardrails: { weight: 'guard', label: 'Guardrailed' },
  engineer_only: { weight: 'engineer', label: 'Engineer-authored' },
};

/**
 * Review-requirement chip on the single steel --access hue. Three fill weights
 * distinguish the tiers — never green/amber/red, so it can't be confused with
 * the (colored) Risk axis, and never implies a change cannot be requested.
 */
export function AccessBadge({ exposure }: AccessBadgeProps): JSX.Element {
  const spec = ACCESS_SPEC[exposure];
  return (
    <span className={`access-badge access-badge--${spec.weight}`} title={exposureLabel(exposure)}>
      {spec.label}
    </span>
  );
}
