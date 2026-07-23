import type { JSX } from 'react';
import type { Macd } from '@/types';
import './ui.css';

export interface MacdTagProps {
  macd: Macd;
}

interface MacdSpec {
  /** Neutral Terraform-plan glyph. */
  glyph: string;
  /** Verb label, always paired with the glyph. */
  label: string;
  /** Delete borrows the risk-high glyph hue; others stay neutral. */
  danger?: boolean;
}

const MACD_SPEC: Record<Macd, MacdSpec> = {
  Add: { glyph: '+', label: 'Add' },
  Move: { glyph: '→', label: 'Move' },
  Change: { glyph: '~', label: 'Change' },
  Delete: { glyph: '−', label: 'Delete', danger: true },
};

/**
 * MACD glyph-tag: a neutral mono chip (+ → ~ −) on --surface-2. Not a colored
 * axis — MACD reads as a plan symbol, keeping Risk the only saturated hue.
 * Delete's glyph alone may take --risk-high.
 */
export function MacdTag({ macd }: MacdTagProps): JSX.Element {
  const spec = MACD_SPEC[macd];
  return (
    <span className="macd-tag" title={`${spec.label} operation`}>
      <span
        className={`macd-tag__glyph${spec.danger ? ' macd-tag__glyph--danger' : ''}`}
        aria-hidden="true"
      >
        {spec.glyph}
      </span>
      {spec.label}
    </span>
  );
}
