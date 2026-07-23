import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ManifestOperation, RiskFloor } from '@/types';
import { manifests } from '@/data/manifests';
import { getServiceMeta } from '@/lib/serviceMeta';
import { getCurrentUser } from '@/lib/session';
import { recordAudit } from '@/lib/audit';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { authClient } from '@/lib/api';
import type { AdminWriteOutcome } from '@/lib/httpApi';
import { describeConfigWrite } from './policyFlow';
import {
  loadRiskStateVia,
  localRiskState,
  setOpEnabledVia,
  setRiskVia,
  type RiskAdminState,
} from './riskFlow';
import { ServiceIcon } from '@/components/ServiceIcon';
import { SearchBar } from '@/components/SearchBar';
import { MacdTag } from '@/components/ui/MacdTag';
import { GateFieldset, SERVER_MODE, useServerInfo } from '@/components/AdvisoryGate';
import './risk-admin.css';

const RISKS: RiskFloor[] = ['LOW', 'MEDIUM', 'HIGH'];
const RISK_LABEL: Record<RiskFloor, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' };

/**
 * Reclassify each activity's risk (LOW / MEDIUM / HIGH) and enable/disable it.
 * The effective risk here is what drives the approval policy and every risk
 * badge. Server-backed since ccp-api serves the risk + catalog routes
 * (riskFlow.ts): raising risk / disabling applies immediately; lowering risk /
 * re-enabling is dual-controlled and lands under Pending changes.
 */
export function RiskAdmin(): JSX.Element {
  const { can } = useServerInfo();
  const authoritative = can('risk');
  // Mode honesty: the local risk-override + disabled-ops stores genuinely
  // work in a mock build — the mock submit gate reads them (lib/api rejects a
  // disabled op) and every risk badge renders from them — so these controls
  // stay LIVE against this browser's demo state. An api build keeps the
  // arming rule unchanged (dark until ccp-api serves the flow).
  const demo = SERVER_MODE === 'mock';
  const [query, setQuery] = useState('');
  const q = useDebouncedValue(query.trim().toLowerCase(), 200);
  // Synchronous local snapshot first (mock/server-render truth on first
  // paint); the effect swaps in the server's overrides once authoritative.
  const [state, setState] = useState<RiskAdminState>(localRiskState);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    void loadRiskStateVia(authoritative, authClient)
      .then((s) => setState(s))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load activity risk.');
      });
  };
  useEffect(refresh, [authoritative]);

  const total = manifests.reduce((n, m) => n + m.operations.length, 0);
  const customised = Object.keys(state.overrides).length;

  /** One write path for every control on this page — routes to ccp-api
   * when authoritative (202 → the honest "proposed…" sentence), else to the
   * local stores exactly as before, with the local audit entry the server
   * would otherwise record itself. */
  async function act(
    fn: () => Promise<AdminWriteOutcome>,
    appliedLabel: string,
    audit: { action: string; summary: string },
  ): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const outcome = await fn();
      if (!authoritative) recordAudit(getCurrentUser().id, audit.action, audit.summary);
      setNotice(describeConfigWrite(outcome, appliedLabel));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the change.');
      refresh();
    } finally {
      setBusy(false);
    }
  }

  function change(op: ManifestOperation, risk: RiskFloor): void {
    void act(
      () => setRiskVia(authoritative, authClient, op, risk),
      `${op.title} set to ${RISK_LABEL[risk]}`,
      { action: 'Set activity risk', summary: `${op.title} (${op.service}) → ${RISK_LABEL[risk]}` },
    );
  }
  function reset(op: ManifestOperation): void {
    void act(
      () => setRiskVia(authoritative, authClient, op, op.riskFloor),
      `${op.title} reset to its default (${RISK_LABEL[op.riskFloor]})`,
      {
        action: 'Reset activity risk',
        summary: `${op.title} (${op.service}) → default ${RISK_LABEL[op.riskFloor]}`,
      },
    );
  }
  function toggleDisabled(op: ManifestOperation, currentlyDisabled: boolean): void {
    const enabled = currentlyDisabled; // disabled → enable it; enabled → disable it
    void act(
      () => setOpEnabledVia(authoritative, authClient, op.id, enabled),
      enabled ? `${op.title} enabled` : `${op.title} disabled`,
      { action: enabled ? 'Enabled activity' : 'Disabled activity', summary: `${op.title} (${op.service})` },
    );
  }

  return (
    <div className="risk">
      <GateFieldset disabled={!authoritative && !demo}>
        <div className="risk__head">
          <div className="risk__head-id">
            <h2 className="risk__title">Activity risk</h2>
            <span className="risk__note">
              {total} activities · {customised} customised — risk drives the approval policy
            </span>
          </div>
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder="Search activities or services"
            ariaLabel="Search activities"
          />
        </div>

        {error && (
          <p className="risk__msg risk__msg--error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="risk__msg risk__msg--ok" role="status">
            {notice}
          </p>
        )}

        {manifests.map((m) => {
          const meta = getServiceMeta(m.service);
          const ops = q
            ? m.operations.filter(
                (o) =>
                  o.title.toLowerCase().includes(q) ||
                  o.id.includes(q) ||
                  m.service.includes(q) ||
                  meta.displayName.toLowerCase().includes(q),
              )
            : m.operations;
          if (q && ops.length === 0) return null;
          return (
            <section className="risk__group" key={m.service}>
              <div className="risk__group-head">
                <ServiceIcon slug={m.service} size={22} />
                <span className="risk__group-name">{meta.displayName}</span>
                <span className="risk__group-count">{ops.length}</span>
              </div>
              <ul className="risk__ops">
                {ops.map((op) => {
                  const eff = state.overrides[op.id] ?? op.riskFloor;
                  const overridden = state.overrides[op.id] !== undefined;
                  const disabled = state.disabledOps.includes(op.id);
                  return (
                    <li
                      className={disabled ? 'risk__op risk__op--disabled' : 'risk__op'}
                      key={op.id}
                    >
                      <div className="risk__op-id">
                        <MacdTag macd={op.macd} />
                        <span className="risk__op-title">{op.title}</span>
                        {disabled && <span className="risk__op-off">disabled</span>}
                      </div>
                      <div className="risk__op-controls">
                        <button
                          type="button"
                          className="risk__toggle"
                          aria-pressed={!disabled}
                          disabled={busy}
                          onClick={() => toggleDisabled(op, disabled)}
                          title={disabled ? 'Enable this activity' : 'Disable this activity'}
                        >
                          {disabled ? 'Enable' : 'Disable'}
                        </button>
                        <div className="risk__seg" role="group" aria-label={`Risk for ${op.title}`}>
                          {RISKS.map((r) => (
                            <button
                              key={r}
                              type="button"
                              aria-pressed={eff === r}
                              disabled={busy}
                              className={
                                eff === r
                                  ? `risk__seg-btn risk__seg-btn--${r.toLowerCase()} is-on`
                                  : 'risk__seg-btn'
                              }
                              onClick={() => change(op, r)}
                            >
                              {RISK_LABEL[r]}
                            </button>
                          ))}
                        </div>
                        {overridden ? (
                          <button
                            type="button"
                            className="risk__reset"
                            disabled={busy}
                            onClick={() => reset(op)}
                          >
                            Reset
                          </button>
                        ) : (
                          <span className="risk__is-default">default</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </GateFieldset>
    </div>
  );
}

export default RiskAdmin;
