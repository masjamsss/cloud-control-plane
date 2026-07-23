import type { JSX } from 'react';
import type { ManifestParam } from '@/types';

export interface BoundsHintProps {
  param: ManifestParam;
  /** Wire this into the control's aria-describedby when a hint is present. */
  id?: string;
}

/**
 * Derive the static, pre-typing format hint for a parameter from its bounds.
 * Pure — returns null when the parameter has no meaningful format to surface,
 * so callers can decide whether to include it in aria-describedby.
 */
export function boundsHintText(param: ManifestParam): string | null {
  const b = param.bounds;

  if (b?.semantic && /cidr/i.test(b.semantic)) {
    return 'Internal CIDR, e.g. 10.0.0.0/16';
  }

  if (param.type === 'number') {
    const { min, max, growOnly } = b ?? {};
    let range: string | null = null;
    if (min !== undefined && max !== undefined) range = `Between ${min} and ${max}`;
    else if (min !== undefined) range = `At least ${min}`;
    else if (max !== undefined) range = `Up to ${max}`;
    const grow = growOnly ? 'Can only grow — must exceed the current value.' : null;
    const parts = [range, grow].filter((p): p is string => Boolean(p));
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  // List params on the bounded multi-select surface their item-count bounds
  // the same way number params surface min/max; a typed list (user_input)
  // keeps its format hint below instead — "choose" only fits a picker.
  if (param.type === 'list' && param.source === 'inventory') {
    const { minItems, maxItems } = b ?? {};
    if (minItems !== undefined && maxItems !== undefined)
      return `Choose ${minItems === maxItems ? minItems : `${minItems} to ${maxItems}`}`;
    if (minItems !== undefined) return `Choose at least ${minItems}`;
    if (maxItems !== undefined) return `Choose up to ${maxItems}`;
  }

  if (b?.pattern) {
    return `Format: ${b.pattern}`;
  }

  return null;
}

/** The persistent, derived format hint rendered beneath a control. */
export function BoundsHint({ param, id }: BoundsHintProps): JSX.Element | null {
  const text = boundsHintText(param);
  if (!text) return null;
  return (
    <p id={id} className="sf-hint">
      {text}
    </p>
  );
}
