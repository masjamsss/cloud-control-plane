import type { JSX } from 'react';
import type { RiskCounts } from '@/lib/catalog';
import { riskLabel } from '@/lib/catalog';

/**
 * A small stacked bar sized by LOW/MED/HIGH operation counts, using the risk
 * tokens (the one colored axis). Color is never the sole channel: the bar
 * carries an accessible label and a visible count legend.
 */
export function RiskMix({ counts }: { counts: RiskCounts }): JSX.Element {
  const total = counts.LOW + counts.MEDIUM + counts.HIGH;
  const label =
    total === 0
      ? 'No operations'
      : 'Risk mix: ' +
        (
          [
            [counts.LOW, riskLabel.LOW],
            [counts.MEDIUM, riskLabel.MEDIUM],
            [counts.HIGH, riskLabel.HIGH],
          ] as const
        )
          .filter(([n]) => n > 0)
          .map(([n, l]) => `${n} ${l.toLowerCase()}`)
          .join(', ');

  return (
    <div className="risk-mix" role="img" aria-label={label}>
      <div className="risk-mix__bar" aria-hidden="true">
        {counts.LOW > 0 && (
          <span
            className="risk-mix__seg risk-mix__seg--low"
            style={{ flexGrow: counts.LOW }}
          />
        )}
        {counts.MEDIUM > 0 && (
          <span
            className="risk-mix__seg risk-mix__seg--med"
            style={{ flexGrow: counts.MEDIUM }}
          />
        )}
        {counts.HIGH > 0 && (
          <span
            className="risk-mix__seg risk-mix__seg--high"
            style={{ flexGrow: counts.HIGH }}
          />
        )}
        {total === 0 && <span className="risk-mix__seg risk-mix__seg--empty" />}
      </div>
      <div className="risk-mix__legend" aria-hidden="true">
        {counts.LOW > 0 && (
          <span className="risk-mix__tick risk-mix__tick--low">{counts.LOW}</span>
        )}
        {counts.MEDIUM > 0 && (
          <span className="risk-mix__tick risk-mix__tick--med">{counts.MEDIUM}</span>
        )}
        {counts.HIGH > 0 && (
          <span className="risk-mix__tick risk-mix__tick--high">{counts.HIGH}</span>
        )}
      </div>
    </div>
  );
}
