import type { JSX } from 'react';
import type { Inventory, ManifestOperation } from '@/types';
import { resolveTargetCurrent } from '@/lib/catalog';
import { approvalsRequiredFor } from '@/lib/permissions';
import { resolveRisk } from '@/lib/riskOverrides';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import './request.css';

export interface ImpactPanelProps {
  op: ManifestOperation;
  values: Record<string, unknown>;
  inventory: Inventory;
}

function display(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/**
 * The sticky facts / impact side panel. Restates the operation's honest metadata
 * (MACD / risk / reversibility / downtime / Terraform capability), the number of
 * senior approvals this change needs (risk-based), and — once a target is chosen
 * — the live `current → new` line for the attribute it touches. Closes with the
 * honest note that submit only opens a reviewed request; nothing applies without
 * a human approval.
 */
export function ImpactPanel({ op, values, inventory }: ImpactPanelProps): JSX.Element {
  const change = resolveTargetCurrent(op, values, inventory);
  const changeParam = op.params.find(
    (p) => p.source !== 'inventory' && (p.name.startsWith('new_') || p.name === 'target_type'),
  );
  const newValue = changeParam ? values[changeParam.name] : undefined;
  const approvals = approvalsRequiredFor(op);

  return (
    <aside className="rq-impact">
      <p className="rq-impact__eyebrow">REQUEST FACTS</p>
      <dl className="rq-impact__facts">
        <dt>MACD</dt>
        <dd>
          <MacdTag macd={op.macd} />
        </dd>
        <dt>Risk</dt>
        <dd>
          <RiskBadge risk={resolveRisk(op)} />
        </dd>
        <dt>Reversible</dt>
        <dd className={op.reversible ? '' : 'rq-impact__warnval'}>
          {op.reversible ? 'Yes' : 'No — irreversible ⚠'}
        </dd>
        <dt>Downtime</dt>
        <dd className={op.downtime !== 'none' ? 'rq-impact__warnval' : ''}>
          {op.downtime === 'none' ? 'None' : op.downtime}
        </dd>
        <dt>Approval</dt>
        <dd>
          {approvals} senior approval{approvals > 1 ? 's' : ''}
        </dd>
        <dt>Terraform</dt>
        <dd className="rq-impact__mono">{op.terraformCapability}</dd>
      </dl>

      {change && (
        <div className="rq-impact__change">
          <p className="rq-impact__eyebrow">WHAT CHANGES</p>
          <p className="rq-impact__diff">
            <span className="rq-impact__attr">{change.attr}</span>
            {': '}
            <span className="rq-impact__mono">{display(change.current)}</span>
            {' → '}
            <span className="rq-impact__mono rq-impact__new">{display(newValue)}</span>
          </p>
        </div>
      )}

      <p className="rq-impact__note">
        You can request this at any severity. On submit it becomes a Terraform PR that a senior
        reviews as a diff. <strong>Nothing applies automatically</strong> — every change is approved
        by a human before it runs.
      </p>
    </aside>
  );
}
