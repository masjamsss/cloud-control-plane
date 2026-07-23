import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import {
  DEFAULT_POLICY,
  MAX_APPROVALS,
  MIN_APPROVALS,
  type ApprovalPolicy,
} from '@/lib/policy';
import { getCurrentUser } from '@/lib/session';
import { recordAudit } from '@/lib/audit';
import { isApiMode } from '@/lib/apiSession';
import { authClient } from '@/lib/api';
import { eligibleApproverCount, maxSatisfiableApprovals } from '@/lib/quorum';
import { describeConfigWrite, loadPolicyVia, localPolicyState, savePolicyVia } from './policyFlow';
import { GateFieldset, SERVER_MODE, useServerInfo } from '@/components/AdvisoryGate';
import './policy-admin.css';

const TIERS: { key: keyof ApprovalPolicy; label: string; hint: string }[] = [
  { key: 'low', label: 'Low risk', hint: 'bounded, reversible, low blast radius' },
  { key: 'medium', label: 'Medium risk', hint: 'stateful / downtime / security-adjacent' },
  { key: 'high', label: 'High risk', hint: 'security exposure or irreversible' },
];

function Stepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
}): JSX.Element {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper__btn"
        aria-label={`Decrease ${label}`}
        disabled={value <= MIN_APPROVALS}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="stepper__value" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="stepper__btn"
        aria-label={`Increase ${label}`}
        disabled={value >= MAX_APPROVALS}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

export function ApprovalPolicyAdmin(): JSX.Element {
  const { can } = useServerInfo();
  // Server-backed since ccp-api serves GET/PUT /admin/policy (policyFlow.ts).
  const authoritative = can('policy');
  // Mode honesty: the local policy store genuinely works in a mock build — the
  // mock submit/approve paths read it for every request's approval count — so
  // these steppers stay LIVE against this browser's demo policy. An api build
  // keeps the arming rule unchanged.
  const demo = SERVER_MODE === 'mock';
  // Synchronous local snapshot first (a mock build's — and a server render's —
  // truth on first paint, as always); the effect below swaps in the server's
  // policy the moment the flow resolves authoritative.
  const [p, setP] = useState<ApprovalPolicy>(() => localPolicyState().policy);
  const [saved, setSaved] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    void loadPolicyVia(authoritative, authClient)
      .then((state) => setP(state.policy))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load the approval policy.');
      });
  };
  // Re-fetch whenever the backing store flips (api mode resolves after the
  // initial render) — the TeamsAdmin/UsersAdmin pattern at read granularity.
  useEffect(refresh, [authoritative]);

  function set(key: keyof ApprovalPolicy, v: number): void {
    setP((prev) => ({ ...prev, [key]: Math.max(MIN_APPROVALS, Math.min(MAX_APPROVALS, v)) }));
    setSaved(false);
    setNotice(null);
  }

  async function apply(next: ApprovalPolicy, appliedLabel: string): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const outcome = await savePolicyVia(authoritative, authClient, next);
      // The server audits its own policy-change; a local entry only for a local write.
      if (!authoritative) {
        recordAudit(
          getCurrentUser().id,
          'Updated approval policy',
          `low ${next.low} · medium ${next.medium} · high ${next.high} · delete ≥ ${next.deleteMin}`,
        );
      }
      setNotice(describeConfigWrite(outcome, appliedLabel));
      setSaved(true);
      // Re-read the source of truth: an applied write echoes back; a 202
      // (dual-controlled downgrade) reverts the steppers to the still-current
      // policy instead of showing numbers that are not actually in force.
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the policy.');
    } finally {
      setBusy(false);
    }
  }

  const effective = (tier: number): { change: number; del: number } => ({
    change: tier,
    del: Math.max(tier, p.deleteMin),
  });

  return (
    <div className="policy">
      <GateFieldset disabled={!authoritative && !demo}>
        <section className="policy__section">
          <div className="policy__section-head">
            <h2 className="policy__section-title">Approvals by risk</h2>
            <span className="policy__section-note">
              Every tier needs at least one — nothing auto-applies
            </span>
          </div>

          <div className="policy__tiers">
            {TIERS.map((t) => (
              <div className="policy__tier" key={t.key}>
                <div className="policy__tier-id">
                  <span className="policy__tier-label">{t.label}</span>
                  <span className="policy__tier-hint">{t.hint}</span>
                </div>
                <Stepper
                  value={p[t.key]}
                  label={`${t.label} approvals`}
                  onChange={(v) => set(t.key, v)}
                />
                <span className="policy__tier-unit">approval{p[t.key] === 1 ? '' : 's'}</span>
              </div>
            ))}

            <div className="policy__tier policy__tier--floor">
              <div className="policy__tier-id">
                <span className="policy__tier-label">Delete floor</span>
                <span className="policy__tier-hint">
                  a delete needs at least this many, whatever its risk
                </span>
              </div>
              <Stepper
                value={p.deleteMin}
                label="Delete floor approvals"
                onChange={(v) => set('deleteMin', v)}
              />
              <span className="policy__tier-unit">approval{p.deleteMin === 1 ? '' : 's'}</span>
            </div>
          </div>
        </section>

        <section className="policy__section">
          <div className="policy__section-head">
            <h2 className="policy__section-title">Effective requirement</h2>
            <span className="policy__section-note">
              What a request will need under these settings
            </span>
          </div>
          <table className="policy__preview">
            <thead>
              <tr>
                <th scope="col">Risk</th>
                <th scope="col">Change / Add / Move</th>
                <th scope="col">Delete</th>
              </tr>
            </thead>
            <tbody>
              {TIERS.map((t) => {
                const e = effective(p[t.key]);
                return (
                  <tr key={t.key}>
                    <td>{t.label}</td>
                    <td className="policy__num">
                      {e.change} approval{e.change === 1 ? '' : 's'}
                    </td>
                    <td className="policy__num">
                      {e.del} approval{e.del === 1 ? '' : 's'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Local-directory quorum math is ground truth only in mock mode (the
              directory IS the server there). In api-mode the localStorage
              directory is empty/stale, so this alert would fire permanently and
              wrongly — the server's per-request feasibility is the
              honest signal there. Same gating as ReviewStep's quorumNote. */}
          {isApiMode
            ? null
            : (() => {
            const eligible = eligibleApproverCount();
            const maxSat = maxSatisfiableApprovals(eligible);
            const highest = Math.max(
              ...TIERS.map((t) => {
                const e = effective(p[t.key]);
                return Math.max(e.change, e.del);
              }),
            );
            if (highest <= maxSat) return null;
            return (
              <p className="policy__warn" role="alert">
                With {eligible} eligible approver{eligible === 1 ? '' : 's'} enrolled, a request can
                reach at most <strong>{maxSat}</strong> approval{maxSat === 1 ? '' : 's'}. Tiers
                that require more cannot be satisfied — enrol another Approver under Admin → Users,
                or run the single-approver interim profile deliberately.
              </p>
            );
          })()}
        </section>

        {/* Lowering a tier is dual-controlled server-side: it lands as a
            proposal under Pending changes until a second admin acks it. */}
        <div className="policy__bar">
          <button
            className="policy__save"
            type="button"
            onClick={() => void apply(p, 'Policy saved')}
            disabled={saved || busy}
          >
            {busy ? 'Saving…' : saved ? 'Saved' : 'Save policy'}
          </button>
          <button
            className="policy__reset"
            type="button"
            disabled={busy}
            onClick={() => void apply({ ...DEFAULT_POLICY }, 'Policy reset to defaults')}
          >
            Reset to defaults
          </button>
        </div>
        {error && (
          <p className="policy__warn" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="policy__notice" role="status">
            {notice}
          </p>
        )}
      </GateFieldset>
    </div>
  );
}

export default ApprovalPolicyAdmin;
