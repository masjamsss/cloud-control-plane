import { useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getCurrentUser } from '@/lib/session';
import { recordAudit } from '@/lib/audit';
import {
  type ChannelEvent,
  type ChannelKind,
  type Limits,
  LIMITS_BOUNDS,
  addMaintenanceWindow,
  addNotificationChannel,
  getLimits,
  getMaintenanceWindows,
  getNotificationChannels,
  removeMaintenanceWindow,
  removeNotificationChannel,
  setLimits,
} from '@/lib/settings';
import { getProject } from '@/lib/project';
import { authClient } from '@/lib/api';
import {
  loadSettingsVia,
  localSettingsView,
  setFreezeVia,
  setRateLimitsVia,
  type SettingsView,
} from './settingsFlow';
import { describeConfigWrite } from './policyFlow';
import { GateFieldset, SERVER_MODE, useServerInfo } from '@/components/AdvisoryGate';
import { AllowlistAdmin } from './AllowlistAdmin';
import { InstanceIdentityEditor } from './InstanceIdentityEditor';
import './settings-admin.css';

const CHANNEL_KIND_LABEL: Record<ChannelKind, string> = {
  email: 'Email',
  'chat-webhook': 'Chat webhook',
};
const CHANNEL_EVENTS: ChannelEvent[] = ['submitted', 'approved', 'rejected', 'applied'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Best-effort plain-English preview of a handful of common 5-field cron
 * expressions (Task 3, 6-admin-complete-control). Anything it doesn't
 * recognize falls back to the raw expression, verbatim — no cron dep.
 */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const isNum = (s: string): boolean => /^\d+$/.test(s);
  const pad = (s: string): string => s.padStart(2, '0');

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'Every minute';
  if (isNum(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every hour, at minute ${min}`;
  }
  if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && dow === '*') {
    return `Every day at ${pad(hour)}:${pad(min)}`;
  }
  if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    return `Every ${DOW_NAMES[Number(dow)]} at ${pad(hour)}:${pad(min)}`;
  }
  if (isNum(min) && isNum(hour) && isNum(dom) && mon === '*' && dow === '*') {
    return `On day ${dom} of every month at ${pad(hour)}:${pad(min)}`;
  }
  return expr;
}

/**
 * Global settings — the "variables a leader may change at any time".
 * Server-backed since ccp-api serves GET /admin/settings + PUT
 * /admin/settings/:key (settingsFlow.ts): the change-freeze, allowlist
 * restrictions, and the server-enforced rate limits read and write the
 * server's truth, dual-controlled (freeze ON applies now; lifting a
 * freeze or widening an allowlist waits for a second admin). Notification
 * channels and maintenance windows have no server surface yet: advisory in an
 * api build, live against the local store in a mock build (LocalOnlySection).
 */
export function SettingsAdmin(): JSX.Element {
  const { can } = useServerInfo();
  const authoritative = can('settings');
  // Mode honesty: the local settings store genuinely works in a mock build —
  // the mock submit gate enforces the freeze (lib/api), the pickers narrow on
  // the allowlist overrides, and the limits clamp locally — so every section
  // stays LIVE against this browser's demo settings. An api build keeps the
  // arming rule unchanged (dark until ccp-api serves the flow).
  const demo = SERVER_MODE === 'mock';
  // Synchronous local snapshot first (mock/server-render truth on first
  // paint); the effect swaps in the server's settings once authoritative.
  const [view, setView] = useState<SettingsView>(localSettingsView);
  const [freezeNotice, setFreezeNotice] = useState<string | null>(null);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [freezeBusy, setFreezeBusy] = useState(false);

  const refresh = (): void => {
    void loadSettingsVia(authoritative, authClient)
      .then(setView)
      .catch((err: unknown) => {
        setFreezeError(err instanceof Error ? err.message : 'Could not load settings.');
      });
  };
  useEffect(refresh, [authoritative]);

  const frozen = view.changeFreeze;
  const disabledCount = view.disabledOps.length;

  async function toggleFreeze(): Promise<void> {
    const next = !frozen;
    setFreezeError(null);
    setFreezeNotice(null);
    setFreezeBusy(true);
    try {
      const outcome = await setFreezeVia(authoritative, authClient, next);
      // The server audits its own setting-change; a local entry only for a local write.
      if (!authoritative) {
        recordAudit(
          getCurrentUser().id,
          next ? 'Froze change requests' : 'Lifted change freeze',
          next
            ? 'No new requests may be submitted until lifted'
            : 'New requests may be submitted again',
        );
      }
      setFreezeNotice(
        describeConfigWrite(outcome, next ? 'Estate frozen — new requests are blocked' : 'Freeze lifted'),
      );
      refresh(); // a 202 (lifting) leaves the estate frozen — re-read the truth
    } catch (err) {
      setFreezeError(err instanceof Error ? err.message : 'Could not change the freeze.');
    } finally {
      setFreezeBusy(false);
    }
  }

  return (
    <div className="settings">
      <section className="settings__section">
        <div className="settings__section-head">
          <h2 className="settings__section-title">Instance identity</h2>
          <span className="settings__section-note">
            The name and tagline shown across the app and on the sign-in screen
          </span>
        </div>
        <InstanceIdentityEditor authoritative={authoritative} />
      </section>

      <section className="settings__section">
        <div className="settings__section-head">
          <h2 className="settings__section-title">Change freeze</h2>
          <span className="settings__section-note">Pause all new change requests estate-wide</span>
        </div>
        <GateFieldset disabled={!authoritative && !demo}>
          <div className={frozen ? 'settings__freeze settings__freeze--on' : 'settings__freeze'}>
            <div className="settings__freeze-body">
              <span className="settings__freeze-state">
                {frozen ? 'Frozen — new requests are blocked' : 'Open — requests may be submitted'}
              </span>
              <span className="settings__freeze-hint">
                {demo
                  ? 'Freezing and lifting take effect immediately for requests made in this browser.'
                  : 'Freezing takes effect immediately. Lifting a freeze needs a second admin’s acknowledgement under Pending changes.'}
              </span>
            </div>
            <button
              type="button"
              className="settings__freeze-toggle"
              aria-pressed={frozen}
              disabled={freezeBusy}
              onClick={() => void toggleFreeze()}
            >
              {frozen ? 'Lift freeze' : 'Freeze changes'}
            </button>
          </div>
          {freezeError && (
            <p className="settings__msg settings__msg--error" role="alert">
              {freezeError}
            </p>
          )}
          {freezeNotice && (
            <p className="settings__msg settings__msg--ok" role="status">
              {freezeNotice}
            </p>
          )}
        </GateFieldset>
      </section>

      <section className="settings__section">
        <div className="settings__section-head">
          <h2 className="settings__section-title">Disabled activities</h2>
          <span className="settings__section-note">Operations an admin has switched off</span>
        </div>
        <p className="settings__summary">
          {disabledCount === 0
            ? 'No activities are disabled — every operation in the catalog is available.'
            : `${disabledCount} ${disabledCount === 1 ? 'activity is' : 'activities are'} currently disabled and hidden from the catalog.`}{' '}
          Manage them under <Link to="/admin/risk">Activity risk</Link>.
        </p>
      </section>

      <section className="settings__section">
        <div className="settings__section-head">
          <h2 className="settings__section-title">Allowlist restrictions</h2>
          <span className="settings__section-note">
            Narrow which values L1 may pick — never widens beyond the Terraform
          </span>
        </div>
        <GateFieldset disabled={!authoritative && !demo}>
          <AllowlistAdmin
            authoritative={authoritative}
            overrides={view.allowlistOverrides}
            onChanged={refresh}
          />
        </GateFieldset>
      </section>

      <section className="settings__section">
        <div className="settings__section-head">
          <h2 className="settings__section-title">Notification channels</h2>
          <span className="settings__section-note">
            Where approvals and status changes are echoed, beyond the in-app bell
          </span>
        </div>
        <LocalOnlySection reason={NOTIFICATIONS_OFF_REASON}>
          <NotificationChannelsEditor />
        </LocalOnlySection>
      </section>

      <section className="settings__section">
        <div className="settings__section-head">
          <h2 className="settings__section-title">Maintenance windows</h2>
          <span className="settings__section-note">
            Recurring windows worth flagging — informational until ccp-api enforces them
          </span>
        </div>
        <LocalOnlySection reason={MAINTENANCE_OFF_REASON}>
          <MaintenanceWindowsEditor />
        </LocalOnlySection>
      </section>

      <section className="settings__section">
        <div className="settings__section-head">
          <h2 className="settings__section-title">Limits</h2>
          <span className="settings__section-note">
            Estate-wide session and submission guardrails
          </span>
        </div>
        <GateFieldset disabled={!authoritative && !demo}>
          <LimitsEditor
            authoritative={authoritative}
            rateLimits={view.rateLimits}
            onChanged={refresh}
          />
        </GateFieldset>
      </section>
    </div>
  );
}

export default SettingsAdmin;

/** Why the notification-channels editor stays off in a connected build —
 * SPECIFIC plain words, not the generic advisory line: an operator kept
 * hitting a switch that "cannot enable" with no reason on screen. Exported so
 * a test can pin the wording. */
export const NOTIFICATIONS_OFF_REASON =
  "Email and chat channels can't be turned on yet — the server doesn't send messages to them. Approvals and status changes still notify in the app's bell.";

/** Same rule for the maintenance-windows editor. Exported for the same test pin. */
export const MAINTENANCE_OFF_REASON =
  "Recurring maintenance windows can't be turned on yet — the server doesn't enforce them. A change request can still be scheduled into a window when it is submitted.";

/**
 * Sections with NO server surface at all (notification channels, maintenance
 * windows): a mock build renders them LIVE — their editors read and write the
 * local settings store, which IS the source of truth there (the bell reads the
 * channels; the windows render where flagged). An api build renders them
 * disabled with a SPECIFIC plain-language reason (`reason`) — ccp-api
 * serves the settings flow, but not THESE settings, and arming them on
 * `can('settings')` would forge authority for writes that still land only in
 * localStorage (the inverted-gate trap). The generic advisory line used to sit
 * here; it read like a bug ("why can this never be enabled?"), so each section
 * now says exactly what is missing.
 * Module-scope (not defined inside SettingsAdmin) so its identity is stable
 * across renders and the editors' form state survives a parent re-render.
 */
function LocalOnlySection({ reason, children }: { reason: string; children: ReactNode }): JSX.Element {
  if (SERVER_MODE === 'mock') return <>{children}</>;
  return (
    <fieldset disabled className="advisory-gate">
      <p className="advisory-gate__note" role="note">
        {reason}
      </p>
      {children}
    </fieldset>
  );
}

/* ── Notification channels ─────────────────────────────────────────────────── */

function NotificationChannelsEditor(): JSX.Element {
  const [, setTick] = useState(0);
  const refresh = (): void => setTick((t) => t + 1);
  const channels = getNotificationChannels();

  const [kind, setKind] = useState<ChannelKind>('email');
  const [target, setTarget] = useState('');
  const [events, setEvents] = useState<Set<ChannelEvent>>(new Set(CHANNEL_EVENTS));
  const [error, setError] = useState<string | null>(null);

  function toggleEvent(ev: ChannelEvent): void {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);
    const trimmed = target.trim();
    if (!trimmed) {
      setError('Enter a target address or URL.');
      return;
    }
    const pattern = kind === 'email' ? EMAIL_RE : URL_RE;
    if (!pattern.test(trimmed)) {
      setError(kind === 'email' ? 'Enter a valid email address.' : 'Enter a valid https:// URL.');
      return;
    }
    // addNotificationChannel already records its own audit entry (lib/settings.ts).
    addNotificationChannel({ kind, target: trimmed, events: [...events] });
    setTarget('');
    refresh();
  }

  function remove(id: string): void {
    removeNotificationChannel(id);
    refresh();
  }

  return (
    <div className="notif-admin">
      <form className="notif-admin__form" onSubmit={onSubmit} noValidate>
        <div className="notif-admin__row">
          <select
            className="notif-admin__select"
            value={kind}
            onChange={(e) => setKind(e.target.value as ChannelKind)}
            aria-label="Channel kind"
          >
            <option value="email">Email</option>
            <option value="chat-webhook">Chat webhook</option>
          </select>
          <input
            className="notif-admin__input"
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={kind === 'email' ? 'oncall@example.com' : 'https://hooks.example/…'}
            aria-label="Channel target"
          />
          <button type="submit" className="notif-admin__add">
            Add channel
          </button>
        </div>
        <div className="notif-admin__events" role="group" aria-label="Notify on">
          {CHANNEL_EVENTS.map((ev) => (
            <label key={ev} className="notif-admin__event">
              <input type="checkbox" checked={events.has(ev)} onChange={() => toggleEvent(ev)} />
              {ev}
            </label>
          ))}
        </div>
        {error && (
          <p className="settings__msg settings__msg--error" role="alert">
            {error}
          </p>
        )}
      </form>

      {channels.length === 0 ? (
        <p className="settings__summary">No channels — approvals notify in-app only.</p>
      ) : (
        <ul className="notif-admin__list">
          {channels.map((c) => (
            <li key={c.id} className="notif-admin__item">
              <div className="notif-admin__item-body">
                <span className="notif-admin__kind">{CHANNEL_KIND_LABEL[c.kind]}</span>
                <span className="notif-admin__target">{c.target}</span>
                <span className="notif-admin__item-events">
                  {c.events.length > 0 ? c.events.join(', ') : 'no events selected'}
                </span>
              </div>
              <button type="button" className="notif-admin__remove" onClick={() => remove(c.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Maintenance windows ───────────────────────────────────────────────────── */

function MaintenanceWindowsEditor(): JSX.Element {
  const [, setTick] = useState(0);
  const refresh = (): void => setTick((t) => t + 1);
  const windows = getMaintenanceWindows();

  const [label, setLabel] = useState('');
  const [cron, setCron] = useState('');
  const [tz, setTz] = useState(() => getProject().timezone || 'UTC');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);
    if (!label.trim() || !cron.trim()) {
      setError('Enter a label and a cron expression.');
      return;
    }
    addMaintenanceWindow({
      label: label.trim(),
      cron: cron.trim(),
      tz: tz.trim() || getProject().timezone || 'UTC',
    });
    setLabel('');
    setCron('');
    refresh();
  }

  function remove(id: string): void {
    removeMaintenanceWindow(id);
    refresh();
  }

  return (
    <div className="mw-admin">
      <form className="mw-admin__form" onSubmit={onSubmit} noValidate>
        <div className="mw-admin__row">
          <input
            className="mw-admin__input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Month-end close)"
            aria-label="Window label"
          />
          <input
            className="mw-admin__input mw-admin__input--cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 2 * * *"
            aria-label="Cron expression"
          />
          <input
            className="mw-admin__input mw-admin__input--tz"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            aria-label="Time zone"
          />
          <button type="submit" className="mw-admin__add">
            Add window
          </button>
        </div>
        {cron.trim() && <p className="mw-admin__preview">{describeCron(cron.trim())}</p>}
        {error && (
          <p className="settings__msg settings__msg--error" role="alert">
            {error}
          </p>
        )}
      </form>

      {windows.length === 0 ? (
        <p className="settings__summary">No maintenance windows configured.</p>
      ) : (
        <ul className="mw-admin__list">
          {windows.map((w) => (
            <li key={w.id} className="mw-admin__item">
              <div className="mw-admin__item-body">
                <span className="mw-admin__label">{w.label}</span>
                <span className="mw-admin__cron">{w.cron}</span>
                <span className="mw-admin__tz">{w.tz}</span>
                <span className="mw-admin__item-preview">{describeCron(w.cron)}</span>
              </div>
              <button type="button" className="mw-admin__remove" onClick={() => remove(w.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Limits ─────────────────────────────────────────────────────────────────── */

const LIMIT_FIELDS: { key: keyof Limits; label: string; suffix: string }[] = [
  { key: 'sessionAbsoluteHours', label: 'Session absolute limit', suffix: 'hours' },
  { key: 'sessionIdleMinutes', label: 'Session idle timeout', suffix: 'minutes' },
  { key: 'submissionsPerHour', label: 'Submissions per hour', suffix: '/ hour' },
  { key: 'maxOpenPerUser', label: 'Max open requests per user', suffix: 'requests' },
];

/** The two limits ccp-api actually reads back and enforces
 * (middleware/rateLimit.ts via SETTING#rate.limits). */
const RATE_FIELDS: { key: 'submissionsPerHour' | 'maxOpenPerUser'; label: string; suffix: string }[] = [
  { key: 'submissionsPerHour', label: 'Submissions per hour', suffix: '/ hour' },
  { key: 'maxOpenPerUser', label: 'Max open requests per user', suffix: 'requests' },
];

function LimitsEditor({
  authoritative,
  rateLimits,
  onChanged,
}: {
  authoritative: boolean;
  rateLimits: { submissionsPerHour: number; maxOpenPerUser: number };
  onChanged: () => void;
}): JSX.Element {
  // Local (mock/demo) drafts carry all four fields; the server path edits and
  // persists only the pair ccp-api enforces — session lifetimes are fixed
  // server-side (12 h absolute · 30 m idle), so offering steppers for them
  // against a real backend would be authority theater.
  const [draft, setDraft] = useState<Limits>(() => ({ ...getLimits(), ...rateLimits }));
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft((prev) => ({ ...prev, ...rateLimits }));
  }, [rateLimits]);

  function change(key: keyof Limits, value: string): void {
    const n = Number(value);
    setDraft((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : prev[key] }));
    setSaved(null);
  }

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (authoritative) {
        const outcome = await setRateLimitsVia(authoritative, authClient, {
          submissionsPerHour: draft.submissionsPerHour,
          maxOpenPerUser: draft.maxOpenPerUser,
        });
        setSaved(describeConfigWrite(outcome, 'Limits saved'));
      } else {
        // Local editor carries all four fields (the session pair only exists
        // locally); setLimits clamps and records its own audit entry.
        setDraft(setLimits(draft).limits);
        setSaved('Saved.');
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the limits.');
    } finally {
      setBusy(false);
    }
  }

  const fields = authoritative ? RATE_FIELDS : LIMIT_FIELDS;

  return (
    <form className="limits-admin" onSubmit={(e) => void save(e)}>
      {authoritative && (
        <p className="settings__summary">
          Session lifetimes are fixed by ccp-api (12&nbsp;h absolute · 30&nbsp;m idle). The
          two limits below are read back and enforced by the server on every submission.
        </p>
      )}
      <div className="limits-admin__grid">
        {fields.map((f) => {
          const [min, max] = LIMITS_BOUNDS[f.key];
          return (
            <label key={f.key} className="limits-admin__field">
              <span className="limits-admin__label">{f.label}</span>
              <div className="limits-admin__input-row">
                <input
                  type="number"
                  className="limits-admin__input"
                  min={min}
                  max={max}
                  value={draft[f.key]}
                  onChange={(e) => change(f.key, e.target.value)}
                />
                <span className="limits-admin__suffix">{f.suffix}</span>
              </div>
              <span className="limits-admin__bounds">
                {min}–{max}
              </span>
            </label>
          );
        })}
      </div>
      <div className="limits-admin__actions">
        <button type="submit" className="limits-admin__save" disabled={busy}>
          {busy ? 'Saving…' : 'Save limits'}
        </button>
        {error && (
          <span className="settings__msg settings__msg--error" role="alert">
            {error}
          </span>
        )}
        {saved && !error && (
          <span className="settings__msg settings__msg--ok" role="status">
            {saved}
          </span>
        )}
      </div>
    </form>
  );
}
