import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { changeOwnPassword, ensureSeeded, MIN_PASSWORD } from '@/lib/accounts';
import { currentUser, isAuthenticated, login, signOut } from '@/lib/auth';
import { authClient } from '@/lib/api';
import { isApiMode } from '@/lib/apiSession';
import {
  apiLogin,
  completeChangePassword,
  completeEnrollTotp,
  completeRecoveryLogin,
  completeVerifyTotp,
  hydrateApiSession,
  isValidTotpCode,
  parseOtpauthSecret,
} from './authFlow';
import { TotpQr } from './TotpQr';
import { ChangePasswordFields } from './ChangePasswordFields';
import { RecoveryCodesCeremony } from './RecoveryCodesCeremony';
import { useInstanceIdentity } from '@/lib/instanceIdentity';
import './login.css';

/**
 * The single shared sign-in. Role comes from the account; the app routes each
 * person to what their role can see. Fail-closed generic error.
 *
 * Two backends, one form. In MOCK mode the bootstrap Lead is seeded (ensureSeeded)
 * and identity is the local PBKDF2 session (lib/auth). In API mode (VITE_API_BASE
 * set) the form drives a real ccp-api cookie session instead — login, then the
 * mandatory TOTP enrol/verify interstitial for a privileged account, mirrored into
 * the app via the api-session bridge. The forced-password-change interstitial is
 * the pattern the TOTP screens follow.
 */
export function LoginPage(): JSX.Element {
  const identity = useInstanceIdentity();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Forced first-use password change (seed Lead / admin reset): holds the account id.
  const [mustChangeId, setMustChangeId] = useState<string | null>(null);
  // Api-mode only: the current (temporary) password the server re-verifies before
  // the change. Seeded from the just-typed login password on the fresh-login/TOTP
  // paths; typed by hand on a cold reload (where it isn't in memory). Mock mode
  // reuses the `password` field from its login step instead.
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Api-mode second factor: a mandatory interstitial before a full session opens.
  // 'recovery' is a THIRD way to clear this same gate — someone who lost every
  // enrolled device, reached from a link on the 'verify' screen.
  const [totpStep, setTotpStep] = useState<'enroll' | 'verify' | 'recovery' | null>(null);
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  // The one-time save ceremony for a freshly issued recovery-code set — shown
  // right after the account's FIRST device is confirmed, before whatever
  // would otherwise come next (the forced password change, or home).
  const [recoveryCodesToShow, setRecoveryCodesToShow] = useState<string[] | null>(null);
  const [postCodesTarget, setPostCodesTarget] = useState<
    { kind: 'home' } | { kind: 'change-password'; id: string; username: string } | null
  >(null);
  const userRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    if (isApiMode && authClient) {
      // Api mode: adopt an existing server cookie if there is one; no local seeding.
      void hydrateApiSession(authClient).then((res) => {
        if (!alive) return;
        setReady(true);
        if (!res.live) return;
        // A live session still pinned to a temporary password must land on the
        // forced-change screen HERE — not navigate('/'), which RequireAuth
        // bounces straight back to /login, looping the hydrate forever (the
        // go-live blocker: the first admin could never get in). currentPassword
        // stays empty on this cold-reload path, so the screen asks for it.
        if (res.step === 'change-password') {
          setUsername(res.result.user.username);
          setMustChangeId(res.result.user.id);
          return;
        }
        navigate('/', { replace: true });
      });
    } else {
      void ensureSeeded().finally(() => {
        if (alive) setReady(true);
      });
    }
    return () => {
      alive = false;
    };
  }, [navigate]);

  useEffect(() => {
    if (ready) userRef.current?.focus();
  }, [ready]);

  // Mock mode only: if we arrive already signed in but pinned to a temporary
  // password (e.g. bounced here by RequireAuth), drop into the set-password step.
  // Api-mode password/TOTP steps are driven by the server login response instead.
  useEffect(() => {
    if (isApiMode) return;
    const u = currentUser();
    if (u?.mustChangePassword) {
      setMustChangeId(u.id);
      setUsername(u.username);
    }
  }, []);

  // Already fully signed in (and not mid-interstitial) → go home.
  if (
    isAuthenticated() &&
    !currentUser()?.mustChangePassword &&
    !mustChangeId &&
    !totpStep &&
    !recoveryCodesToShow
  ) {
    return <Navigate to="/" replace />;
  }

  const canSubmit = ready && !submitting && username.trim().length > 0 && password.length > 0;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);

    if (isApiMode && authClient) {
      const out = await apiLogin(authClient, username, password);
      if (!out.ok) {
        setSubmitting(false);
        setError(out.reason);
        setPassword('');
        return;
      }
      switch (out.step) {
        case 'done':
          navigate('/', { replace: true });
          return;
        case 'enroll-totp':
          setEnrollment(out.result.totpEnrollment ?? null);
          setTotpStep('enroll');
          setTotpCode('');
          setSubmitting(false);
          return;
        case 'verify-totp':
          setTotpStep('verify');
          setTotpCode('');
          setSubmitting(false);
          return;
        case 'change-password':
        default:
          // Temporary password, no TOTP gate first (a plain account): drop into
          // the forced-change screen. Seed the current password from what was
          // just typed so the user need not re-enter it. No session opens until
          // the change succeeds (apiLogin left the bridge empty for this step).
          // `default` is unreachable (AuthStep is closed and fully handled) but
          // stays here as the fail-closed catch — an unknown step never falls
          // through to open a session.
          setCurrentPassword(password);
          setMustChangeId(out.result.user.id);
          setSubmitting(false);
          return;
      }
    }

    const res = await login(username, password);
    if (res.ok) {
      if (res.mustChangePassword) {
        // Signed in, but pinned to the set-password step before any route opens.
        setMustChangeId(res.user.id);
        setSubmitting(false);
        return;
      }
      navigate('/', { replace: true });
      return;
    }
    setSubmitting(false);
    setError(res.reason);
    setPassword('');
  }

  /**
   * The outcome shared by every way of clearing the TOTP gate (enrol, verify,
   * recovery): if a fresh recovery-code set came back — only ever on the
   * account's very FIRST device — interpose the one-time save ceremony before
   * whatever would otherwise come next; otherwise if the account is still on
   * a temporary password, hand off to the forced-change screen (enrolling
   * beats the password gate in the first-login order); otherwise go home.
   */
  function afterTotpGateCleared(result: {
    user: { id: string; username: string };
    mustChangePassword: boolean;
    recoveryCodes?: string[];
  }): void {
    setTotpStep(null);
    setEnrollment(null);
    setTotpCode('');
    setRecoveryCode('');
    if (result.recoveryCodes && result.recoveryCodes.length > 0) {
      setRecoveryCodesToShow(result.recoveryCodes);
      setPostCodesTarget(
        result.mustChangePassword
          ? { kind: 'change-password', id: result.user.id, username: result.user.username }
          : { kind: 'home' },
      );
      setSubmitting(false);
      return;
    }
    if (result.mustChangePassword) {
      // TOTP is satisfied and a full session is now mirrored — but the account
      // is STILL on its temporary password (the first-login order: enrol beats
      // the password gate). Hand off to the forced-change screen instead of
      // navigating home, which RequireAuth would bounce back to /login (loop).
      setCurrentPassword(password);
      setMustChangeId(result.user.id);
      setUsername(result.user.username);
      setSubmitting(false);
      return;
    }
    navigate('/', { replace: true });
  }

  async function onSubmitTotp(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!isApiMode || !authClient || (totpStep !== 'enroll' && totpStep !== 'verify')) return;
    setError(null);
    if (!isValidTotpCode(totpCode)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setSubmitting(true);
    const out =
      totpStep === 'enroll'
        ? await completeEnrollTotp(authClient, totpCode)
        : await completeVerifyTotp(authClient, totpCode);
    if (out.ok) {
      afterTotpGateCleared(out.result);
      return;
    }
    setSubmitting(false);
    setError(out.reason);
    setTotpCode('');
  }

  async function onSubmitRecovery(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!isApiMode || !authClient || totpStep !== 'recovery') return;
    setError(null);
    setSubmitting(true);
    const out = await completeRecoveryLogin(authClient, recoveryCode);
    if (out.ok) {
      afterTotpGateCleared(out.result);
      return;
    }
    setSubmitting(false);
    setError(out.reason);
    setRecoveryCode('');
  }

  function cancelTotp(): void {
    // Abandon the pre-session: kill the server cookie and reset to the sign-in form.
    void authClient?.logout();
    signOut();
    setTotpStep(null);
    setEnrollment(null);
    setTotpCode('');
    setRecoveryCode('');
    setPassword('');
    setError(null);
  }

  /** The recovery-code save ceremony's "I saved these, continue" — routes to
   * whichever step {@link afterTotpGateCleared} decided came next. */
  function continueAfterCodes(): void {
    const target = postCodesTarget;
    setRecoveryCodesToShow(null);
    setPostCodesTarget(null);
    if (!target || target.kind === 'home') {
      navigate('/', { replace: true });
      return;
    }
    setCurrentPassword(password);
    setMustChangeId(target.id);
    setUsername(target.username);
  }

  async function onSetPassword(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!mustChangeId) return;
    setError(null);
    if (newPassword.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }

    if (isApiMode && authClient) {
      // Api mode: the server re-verifies the current password, clears the flag,
      // and re-mints the session. completeChangePassword mirrors the now-unblocked
      // account into the bridge, so navigating home passes RequireAuth cleanly.
      if (currentPassword.length === 0) {
        setError('Enter your current (temporary) password.');
        return;
      }
      if (newPassword === currentPassword) {
        setError('Choose a password different from the temporary one.');
        return;
      }
      setSubmitting(true);
      const out = await completeChangePassword(authClient, currentPassword, newPassword);
      if (out.ok) {
        navigate('/', { replace: true });
        return;
      }
      setSubmitting(false);
      setError(out.reason);
      return;
    }

    if (newPassword === password) {
      setError('Choose a password different from the temporary one.');
      return;
    }
    setSubmitting(true);
    try {
      // Mock mode now verifies the current password too — `password` holds
      // what was typed at the login step moments earlier (or, on a
      // cold-reload edge case, is empty and this simply fails with the same
      // generic reason below).
      await changeOwnPassword(mustChangeId, password, newPassword);
      navigate('/', { replace: true });
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : 'That password could not be set.');
    }
  }

  function cancelSetPassword(): void {
    signOut();
    setMustChangeId(null);
    setCurrentPassword('');
    setPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  }

  return (
    <div className="login">
      <div className="login__panel">
        <div className="login__brand">
          <span className="login__mark" aria-hidden="true">
            ◆
          </span>
          <span className="login__wordmark">{identity.name}</span>
        </div>

        {recoveryCodesToShow ? (
          <>
            <h1 className="login__title">Save your recovery codes</h1>
            <RecoveryCodesCeremony codes={recoveryCodesToShow} onContinue={continueAfterCodes} />
          </>
        ) : totpStep === 'recovery' ? (
          <>
            <h1 className="login__title">Enter a recovery code</h1>
            <p className="login__sub">
              Use one of the one-time codes you saved when you set up two-factor authentication.
              Each code works only once.
            </p>

            <form className="login__form" onSubmit={onSubmitRecovery} noValidate>
              <div className="login__field">
                <label className="login__label" htmlFor="login-recovery">
                  Recovery code
                </label>
                <input
                  id="login-recovery"
                  className="login__input"
                  type="text"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  value={recoveryCode}
                  disabled={submitting}
                  aria-invalid={error !== null}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  autoFocus
                />
              </div>
              {error && (
                <p className="login__error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="login__submit"
                type="submit"
                disabled={submitting || recoveryCode.trim().length === 0}
              >
                {submitting ? 'Verifying…' : 'Verify & sign in'}
              </button>
              <button
                className="login__link"
                type="button"
                onClick={() => {
                  setTotpStep('verify');
                  setRecoveryCode('');
                  setError(null);
                }}
              >
                Enter an authenticator code instead
              </button>
              <button className="login__link" type="button" onClick={cancelTotp}>
                Cancel
              </button>
            </form>
          </>
        ) : totpStep ? (
          <>
            <h1 className="login__title">
              {totpStep === 'enroll' ? 'Set up two-factor authentication' : 'Enter your code'}
            </h1>
            <p className="login__sub">
              {totpStep === 'enroll'
                ? 'Your role requires a second factor. Add this secret to an authenticator app, then enter the 6-digit code it shows.'
                : 'Open your authenticator app and enter the current 6-digit code to finish signing in.'}
            </p>

            {totpStep === 'enroll' && enrollment && <TotpEnrollFields enrollment={enrollment} />}

            <form className="login__form" onSubmit={onSubmitTotp} noValidate>
              <div className="login__field">
                <label className="login__label" htmlFor="login-totp">
                  6-digit code
                </label>
                <input
                  id="login-totp"
                  className="login__input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={6}
                  value={totpCode}
                  disabled={submitting}
                  aria-invalid={error !== null}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                />
              </div>
              {error && (
                <p className="login__error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="login__submit"
                type="submit"
                disabled={submitting || !isValidTotpCode(totpCode)}
              >
                {submitting
                  ? 'Verifying…'
                  : totpStep === 'enroll'
                    ? 'Verify & finish setup'
                    : 'Verify & sign in'}
              </button>
              {totpStep === 'verify' && (
                <button
                  className="login__link"
                  type="button"
                  onClick={() => {
                    setTotpStep('recovery');
                    setTotpCode('');
                    setError(null);
                  }}
                >
                  Use a recovery code instead
                </button>
              )}
              <button className="login__link" type="button" onClick={cancelTotp}>
                Cancel
              </button>
            </form>
          </>
        ) : mustChangeId ? (
          <>
            <h1 className="login__title">Set a new password</h1>
            <p className="login__sub">
              This account is using a temporary password. Choose a new one to continue.
            </p>
            <form className="login__form" onSubmit={onSetPassword} noValidate>
              <ChangePasswordFields
                idPrefix="login"
                showCurrentPassword={isApiMode}
                currentPassword={currentPassword}
                onCurrentPasswordChange={setCurrentPassword}
                newPassword={newPassword}
                onNewPasswordChange={setNewPassword}
                confirmPassword={confirmPassword}
                onConfirmPasswordChange={setConfirmPassword}
                showKeepOtherSessions={false}
                signOutOtherDevices
                onSignOutOtherDevicesChange={() => {}}
                submitting={submitting}
                invalid={error !== null}
              />
              {error && (
                <p className="login__error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="login__submit"
                type="submit"
                disabled={
                  submitting ||
                  newPassword.length === 0 ||
                  confirmPassword.length === 0 ||
                  (isApiMode && currentPassword.length === 0)
                }
              >
                {submitting ? 'Saving…' : 'Set password & continue'}
              </button>
              <button className="login__link" type="button" onClick={cancelSetPassword}>
                Cancel
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="login__title">Sign in</h1>
            <p className="login__sub">
              Change cloud infrastructure through reviewed forms. Use your {identity.name} account — no
              GitHub needed.
            </p>

            <form className="login__form" onSubmit={onSubmit} noValidate>
              <div className="login__field">
                <label className="login__label" htmlFor="login-username">
                  Username
                </label>
                <input
                  id="login-username"
                  ref={userRef}
                  className="login__input"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={username}
                  disabled={!ready || submitting}
                  aria-invalid={error !== null}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>

              <div className="login__field">
                <label className="login__label" htmlFor="login-password">
                  Password
                </label>
                <input
                  id="login-password"
                  className="login__input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={!ready || submitting}
                  aria-invalid={error !== null}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              {error && (
                <p className="login__error" role="alert">
                  {error}
                </p>
              )}

              <button className="login__submit" type="submit" disabled={!canSubmit}>
                {submitting ? 'Signing in…' : ready ? 'Sign in' : 'Preparing…'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export interface TotpEnrollFieldsProps {
  enrollment: { secret: string; otpauthUri: string };
}

/**
 * The enrolment body: a scannable QR above the existing setup-key text — the
 * QR is additive, the key + otpauth URI stay as the accessibility/copy-paste
 * fallback (a screen reader, or an authenticator app with no camera, has no
 * use for the QR). Factored out of {@link LoginPage} so it renders — and is
 * unit-tested — standalone: LoginPage itself needs a Router (useNavigate) and
 * reaches this step only through interactive state this repo's static-render
 * tests (no jsdom) can't drive, but this fragment takes `enrollment` as a
 * plain prop and needs neither.
 */
export function TotpEnrollFields({ enrollment }: TotpEnrollFieldsProps): JSX.Element {
  return (
    <div className="login__totp-enroll">
      <p className="login__hint login__qr-caption">Scan this with your authenticator app:</p>
      <TotpQr value={enrollment.otpauthUri} />
      <span className="login__label" id="totp-secret-label">
        Setup key
      </span>
      <code className="login__secret" aria-labelledby="totp-secret-label">
        {parseOtpauthSecret(enrollment.otpauthUri) ?? enrollment.secret}
      </code>
      <p className="login__hint">
        Or add this URI to your app: <span className="login__otpauth">{enrollment.otpauthUri}</span>
      </p>
    </div>
  );
}

export default LoginPage;
