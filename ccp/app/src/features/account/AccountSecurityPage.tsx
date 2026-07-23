import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { HttpApiClient, OwnSessionRow, TotpEnrollmentOffer } from '@/lib/httpApi';
import { authClient } from '@/lib/api';
import { consumeRecoveryLoginFlag, isApiMode } from '@/lib/apiSession';
import { useCurrentUser } from '@/lib/session';
import { MAX_TOTP_DEVICES, MIN_PASSWORD } from '@/lib/accounts';
import { formatProjectTime } from '@/lib/datetime';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import '@/features/auth/login.css';
import { TotpQr } from '@/features/auth/TotpQr';
import { parseOtpauthSecret } from '@/features/auth/authFlow';
import { ChangePasswordFields } from '@/features/auth/ChangePasswordFields';
import { RecoveryCodesCeremony } from '@/features/auth/RecoveryCodesCeremony';
import {
  beginAddDeviceVia,
  changeOwnPasswordVia,
  confirmAddDeviceVia,
  loadDevicesVia,
  loadRecoveryStatusVia,
  loadSessionsVia,
  regenerateRecoveryCodesVia,
  removeDeviceVia,
  revokeOtherSessionsVia,
  revokeSessionVia,
  type DeviceRow,
  type RecoveryStatusView,
  type SessionsView,
} from './accountFlow';
import { useReauthGate } from './ReauthDialog';
import './account.css';

/**
 * The standing "Account & security" page (route `/p/:projectId/account`) —
 * reached from the account menu, open to every signed-in person regardless
 * of role: change your own password, manage your own authenticator devices,
 * your own recovery codes, and your own active sessions. Nothing here can
 * touch anyone else's account or any admin-only setting; every action below
 * operates on the signed-in id only. A fresh confirmation ("re-auth") is
 * demanded before any device/codes/session change takes effect — one shared
 * dialog (useReauthGate) covers every card.
 */
export function AccountSecurityPage(): JSX.Element {
  const user = useCurrentUser();
  const id = user.id;
  const authoritative = isApiMode;
  const client = authClient;

  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatusView | null>(null);
  const [sessions, setSessions] = useState<SessionsView | null>(null);
  const [ceremonyCodes, setCeremonyCodes] = useState<string[] | null>(null);
  // Read once at mount, then forgotten — the nudge shows at most once per
  // sign-in (see lib/apiSession.ts's consumeRecoveryLoginFlag doc).
  const [showRecoveryBanner] = useState(() => consumeRecoveryLoginFlag());

  const refreshDevices = useCallback(() => {
    void loadDevicesVia(authoritative, client, id).then(setDevices);
  }, [authoritative, client, id]);
  const refreshRecovery = useCallback(() => {
    void loadRecoveryStatusVia(authoritative, client, id).then(setRecovery);
  }, [authoritative, client, id]);
  const refreshSessions = useCallback(() => {
    void loadSessionsVia(authoritative, client, id).then(setSessions);
  }, [authoritative, client, id]);

  useEffect(() => {
    refreshDevices();
    refreshRecovery();
    refreshSessions();
  }, [refreshDevices, refreshRecovery, refreshSessions]);

  const hasDevices = (devices?.length ?? 0) > 0;
  const { withReauth, dialog } = useReauthGate(
    authoritative,
    client,
    id,
    authoritative && hasDevices,
  );

  function onCodesIssued(codes: string[]): void {
    setCeremonyCodes(codes);
    refreshRecovery();
  }

  return (
    <div className="acct-page">
      <header className="acct-page__head">
        <p className="page-eyebrow">Identity</p>
        <h1 className="acct-page__title">Account & security</h1>
        <p className="acct-page__subtitle">
          Manage your own password, authenticator devices, recovery codes, and signed-in sessions.
        </p>
      </header>

      {showRecoveryBanner && (
        <p className="acct-banner" role="status">
          You signed in with a recovery code — review your devices below, and add a replacement if
          you lost one for good.
        </p>
      )}

      <div className="acct-grid">
        <PasswordCard authoritative={authoritative} client={client} id={id} />
        <DevicesCard
          authoritative={authoritative}
          client={client}
          id={id}
          devices={devices}
          onRefresh={refreshDevices}
          withReauth={withReauth}
          onCodesIssued={onCodesIssued}
        />
        <RecoveryCodesCard
          authoritative={authoritative}
          client={client}
          id={id}
          status={recovery}
          hasDevices={hasDevices}
          onRefresh={refreshRecovery}
          withReauth={withReauth}
          onCodesIssued={onCodesIssued}
        />
        <SessionsCard
          client={client}
          view={sessions}
          onRefresh={refreshSessions}
          withReauth={withReauth}
          revokeOthers={() => revokeOtherSessionsVia(authoritative, client, id)}
        />
      </div>

      {ceremonyCodes && (
        <div className="acct-modal__backdrop">
          <div
            className="acct-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Save your recovery codes"
          >
            <h2 className="acct-modal__title">Save your recovery codes</h2>
            <RecoveryCodesCeremony
              codes={ceremonyCodes}
              onContinue={() => setCeremonyCodes(null)}
            />
          </div>
        </div>
      )}

      {dialog}
    </div>
  );
}

/* ── Password card ─────────────────────────────────────────────────────────── */

interface PasswordCardProps {
  authoritative: boolean;
  client: HttpApiClient | null;
  id: string;
}

/**
 * No re-auth gate on top of this one — proving the CURRENT password is
 * exactly what re-authentication would check, so asking twice would be
 * redundant friction.
 */
function PasswordCard({ authoritative, client, id }: PasswordCardProps): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signOutOtherDevices, setSignOutOtherDevices] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (newPassword.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Choose a password different from your current one.');
      return;
    }
    setSubmitting(true);
    const outcome = await changeOwnPasswordVia(
      authoritative,
      client,
      id,
      currentPassword,
      newPassword,
      signOutOtherDevices,
    );
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.reason);
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setSuccess(
      signOutOtherDevices
        ? 'Password changed — your other devices were signed out.'
        : 'Password changed.',
    );
  }

  return (
    <Card title="Password" className="acct-card">
      <form className="login__form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <ChangePasswordFields
          idPrefix="acct-pw"
          showCurrentPassword
          currentPassword={currentPassword}
          onCurrentPasswordChange={setCurrentPassword}
          newPassword={newPassword}
          onNewPasswordChange={setNewPassword}
          confirmPassword={confirmPassword}
          onConfirmPasswordChange={setConfirmPassword}
          showKeepOtherSessions
          signOutOtherDevices={signOutOtherDevices}
          onSignOutOtherDevicesChange={setSignOutOtherDevices}
          submitting={submitting}
          invalid={error !== null}
        />
        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p className="acct-success" role="status">
            {success}
          </p>
        )}
        <Button
          type="submit"
          disabled={
            submitting ||
            currentPassword.length === 0 ||
            newPassword.length === 0 ||
            confirmPassword.length === 0
          }
        >
          {submitting ? 'Saving…' : 'Change password'}
        </Button>
      </form>
    </Card>
  );
}

/* ── Devices card ──────────────────────────────────────────────────────────── */

interface DevicesCardProps {
  authoritative: boolean;
  client: HttpApiClient | null;
  id: string;
  devices: DeviceRow[] | null;
  onRefresh: () => void;
  withReauth: <T>(action: () => Promise<T>) => Promise<T>;
  onCodesIssued: (codes: string[]) => void;
}

function DevicesCard({
  authoritative,
  client,
  id,
  devices,
  onRefresh,
  withReauth,
  onCodesIssued,
}: DevicesCardProps): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [offer, setOffer] = useState<TotpEnrollmentOffer | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const atCap = (devices?.length ?? 0) >= MAX_TOTP_DEVICES;

  async function startAdd(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await withReauth(() => beginAddDeviceVia(authoritative, client, id));
      setOffer(result);
      setName('');
      setCode('');
      setAdding(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start adding a device.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmAdd(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await withReauth(() =>
        confirmAddDeviceVia(authoritative, client, id, code, name),
      );
      setAdding(false);
      setOffer(null);
      setName('');
      setCode('');
      onRefresh();
      if (result.recoveryCodes && result.recoveryCodes.length > 0)
        onCodesIssued(result.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  function cancelAdd(): void {
    setAdding(false);
    setOffer(null);
    setError(null);
    setName('');
    setCode('');
  }

  async function remove(deviceId: string): Promise<void> {
    setRemoveError(null);
    setRemovingId(deviceId);
    try {
      await withReauth(() => removeDeviceVia(authoritative, client, id, deviceId));
      onRefresh();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Could not remove that device.');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card title="Authenticator devices" className="acct-card">
      {devices === null ? (
        <p className="acct-fact">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="acct-fact">No authenticator devices yet.</p>
      ) : (
        <ul className="acct-list">
          {devices.map((d) => (
            <li key={d.id} className="acct-list__row">
              <div>
                <p className="acct-list__label">{d.name}</p>
                <p className="acct-hint">
                  Added {formatProjectTime(d.enrolledAt)}
                  {d.lastUsedAt ? ` · last used ${formatProjectTime(d.lastUsedAt)}` : ''}
                </p>
              </div>
              <Button
                variant="danger"
                onClick={() => void remove(d.id)}
                disabled={removingId === d.id}
              >
                {removingId === d.id ? 'Removing…' : 'Remove'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {removeError && (
        <p className="login__error" role="alert">
          {removeError}
        </p>
      )}

      {adding && offer ? (
        <form className="acct-add-device" onSubmit={(e) => void confirmAdd(e)} noValidate>
          <p className="login__hint login__qr-caption">Scan this with your authenticator app:</p>
          <TotpQr value={offer.otpauthUri} />
          <span className="login__label" id="acct-device-secret-label">
            Setup key
          </span>
          <code className="login__secret" aria-labelledby="acct-device-secret-label">
            {parseOtpauthSecret(offer.otpauthUri) ?? offer.secret}
          </code>

          <div className="login__field">
            <label className="login__label" htmlFor="acct-device-name">
              Device name
            </label>
            <input
              id="acct-device-name"
              className="login__input"
              type="text"
              maxLength={40}
              value={name}
              disabled={busy}
              placeholder="e.g. Work phone"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="login__field">
            <label className="login__label" htmlFor="acct-device-code">
              6-digit code
            </label>
            <input
              id="acct-device-code"
              className="login__input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          {error && (
            <p className="login__error" role="alert">
              {error}
            </p>
          )}
          <div className="acct-actions">
            <Button type="submit" disabled={busy || name.trim().length === 0 || code.length !== 6}>
              {busy ? 'Confirming…' : 'Confirm & add device'}
            </Button>
            <Button variant="ghost" type="button" onClick={cancelAdd} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="acct-actions">
          <Button variant="ghost" onClick={() => void startAdd()} disabled={busy || atCap}>
            {busy ? 'Starting…' : 'Add a device'}
          </Button>
          {atCap && (
            <p className="acct-hint">
              You already have {MAX_TOTP_DEVICES} devices — remove one to add another.
            </p>
          )}
          {!atCap && devices && devices.length === 1 && (
            <p className="acct-hint">
              This is your only device — removing it may be blocked if two-factor authentication is
              required for your role.
            </p>
          )}
          {!adding && error && (
            <p className="login__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

/* ── Recovery codes card ───────────────────────────────────────────────────── */

interface RecoveryCodesCardProps {
  authoritative: boolean;
  client: HttpApiClient | null;
  id: string;
  status: RecoveryStatusView | null;
  hasDevices: boolean;
  onRefresh: () => void;
  withReauth: <T>(action: () => Promise<T>) => Promise<T>;
  onCodesIssued: (codes: string[]) => void;
}

function RecoveryCodesCard({
  authoritative,
  client,
  id,
  status,
  hasDevices,
  onRefresh,
  withReauth,
  onCodesIssued,
}: RecoveryCodesCardProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function regenerate(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await withReauth(() => regenerateRecoveryCodesVia(authoritative, client, id));
      onRefresh();
      onCodesIssued(result.codes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not regenerate recovery codes.');
    } finally {
      setBusy(false);
    }
  }

  const remaining = status?.remaining ?? 0;
  const low = hasDevices && remaining > 0 && remaining <= 3;

  return (
    <Card
      title="Recovery codes"
      className="acct-card"
      actions={low ? <Badge color="warn">Only {remaining} left</Badge> : undefined}
    >
      <p className="acct-hint">
        One-time codes you can use to sign in if you lose every authenticator device. Each one works
        exactly once.
      </p>
      {status === null ? (
        <p className="acct-fact">Loading…</p>
      ) : status.generatedAt ? (
        <p className="acct-fact">
          {remaining} unused code{remaining === 1 ? '' : 's'}, generated{' '}
          {formatProjectTime(status.generatedAt)}.
        </p>
      ) : (
        <p className="acct-fact">No recovery codes yet.</p>
      )}
      {error && (
        <p className="login__error" role="alert">
          {error}
        </p>
      )}
      <div className="acct-actions">
        <Button variant="ghost" onClick={() => void regenerate()} disabled={busy || !hasDevices}>
          {busy ? 'Generating…' : status?.generatedAt ? 'Regenerate codes' : 'Generate codes'}
        </Button>
        {!hasDevices && (
          <p className="acct-hint">
            Set up an authenticator device first — recovery codes only exist while two-factor
            authentication is active.
          </p>
        )}
      </div>
    </Card>
  );
}

/* ── Sessions card ─────────────────────────────────────────────────────────── */

interface SessionsCardProps {
  client: HttpApiClient | null;
  view: SessionsView | null;
  onRefresh: () => void;
  withReauth: <T>(action: () => Promise<T>) => Promise<T>;
  revokeOthers: () => Promise<{ revoked: number }>;
}

function SessionsCard({
  client,
  view,
  onRefresh,
  withReauth,
  revokeOthers,
}: SessionsCardProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRevokeOthers(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await withReauth(revokeOthers);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign out other sessions.');
    } finally {
      setBusy(false);
    }
  }

  async function onRevokeOne(sessionId: string): Promise<void> {
    if (!client) return;
    setError(null);
    setBusyId(sessionId);
    try {
      await withReauth(() => revokeSessionVia(client, sessionId));
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign out that session.');
    } finally {
      setBusyId(null);
    }
  }

  const otherRows: OwnSessionRow[] =
    view?.kind === 'rows' ? view.rows.filter((r) => !r.current) : [];
  const nothingElseToSignOut =
    view?.kind === 'rows' ? otherRows.length === 0 : (view?.otherSessions ?? 0) === 0;

  return (
    <Card title="Active sessions" className="acct-card">
      {view === null ? (
        <p className="acct-fact">Loading…</p>
      ) : view.kind === 'rows' ? (
        <ul className="acct-list">
          {view.rows.map((row) => (
            <li key={row.id} className="acct-list__row">
              <div>
                <p className="acct-list__label">
                  {row.current ? 'This device' : 'Another session'}
                </p>
                <p className="acct-hint">
                  Signed in {formatProjectTime(row.issuedAt)} · last seen{' '}
                  {formatProjectTime(row.lastSeenAt)}
                </p>
              </div>
              {!row.current && (
                <Button
                  variant="ghost"
                  onClick={() => void onRevokeOne(row.id)}
                  disabled={busyId === row.id}
                >
                  {busyId === row.id ? 'Signing out…' : 'Sign out'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="acct-fact">
          This device
          {view.otherSessions > 0
            ? ` + ${view.otherSessions} other session${view.otherSessions === 1 ? '' : 's'}`
            : ''}
          .
        </p>
      )}
      {error && (
        <p className="login__error" role="alert">
          {error}
        </p>
      )}
      <div className="acct-actions">
        <Button
          variant="ghost"
          onClick={() => void onRevokeOthers()}
          disabled={busy || nothingElseToSignOut}
        >
          {busy ? 'Signing out…' : 'Sign out other sessions'}
        </Button>
      </div>
    </Card>
  );
}

export default AccountSecurityPage;
