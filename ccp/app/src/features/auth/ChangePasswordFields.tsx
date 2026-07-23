import type { JSX } from 'react';
import './login.css';

/**
 * The password-change field group, shared by two very different screens: the
 * forced first-use interstitial on the sign-in page, and the standing
 * "Change password" card on the Account & security page. Both collect the
 * same three values (current password, new password, confirm) the same way —
 * this component owns only the fields themselves, fully controlled by the
 * caller, so each screen keeps its own surrounding form, submit button(s) and
 * error placement exactly as before. Renders no <form> tag of its own.
 *
 * `showCurrentPassword` is false only for mock mode's forced first-use screen,
 * which already knows the current (temporary) password from the login step
 * moments earlier and never asks the person to retype it. Every other case —
 * every api-mode screen, and the standing card in either mode — shows it.
 *
 * `showKeepOtherSessions` is true only on the standing card: a forced change
 * always signs every other session out (the temporary credential was known to
 * someone else), so that screen never offers the choice.
 */
export interface ChangePasswordFieldsProps {
  idPrefix: string;
  showCurrentPassword: boolean;
  currentPassword: string;
  onCurrentPasswordChange: (value: string) => void;
  newPassword: string;
  onNewPasswordChange: (value: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (value: string) => void;
  showKeepOtherSessions: boolean;
  /** Checked = sign the other devices out (the safe default). Unchecked = keep
   * them signed in. The caller inverts this to the server's `keepOtherSessions`
   * flag at submit time — this prop is the checkbox's own on-screen state. */
  signOutOtherDevices: boolean;
  onSignOutOtherDevicesChange: (value: boolean) => void;
  submitting: boolean;
  invalid: boolean;
}

export function ChangePasswordFields({
  idPrefix,
  showCurrentPassword,
  currentPassword,
  onCurrentPasswordChange,
  newPassword,
  onNewPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  showKeepOtherSessions,
  signOutOtherDevices,
  onSignOutOtherDevicesChange,
  submitting,
  invalid,
}: ChangePasswordFieldsProps): JSX.Element {
  return (
    <>
      {showCurrentPassword && (
        <div className="login__field">
          <label className="login__label" htmlFor={`${idPrefix}-currentpw`}>
            Current password
          </label>
          <input
            id={`${idPrefix}-currentpw`}
            className="login__input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            disabled={submitting}
            aria-invalid={invalid}
            onChange={(e) => onCurrentPasswordChange(e.target.value)}
          />
        </div>
      )}
      <div className="login__field">
        <label className="login__label" htmlFor={`${idPrefix}-newpw`}>
          New password
        </label>
        <input
          id={`${idPrefix}-newpw`}
          className="login__input"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          disabled={submitting}
          aria-invalid={invalid}
          onChange={(e) => onNewPasswordChange(e.target.value)}
        />
      </div>
      <div className="login__field">
        <label className="login__label" htmlFor={`${idPrefix}-confirmpw`}>
          Confirm new password
        </label>
        <input
          id={`${idPrefix}-confirmpw`}
          className="login__input"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          disabled={submitting}
          aria-invalid={invalid}
          onChange={(e) => onConfirmPasswordChange(e.target.value)}
        />
      </div>
      {showKeepOtherSessions && (
        <label className="login__checkbox-row" htmlFor={`${idPrefix}-signout-others`}>
          <input
            id={`${idPrefix}-signout-others`}
            type="checkbox"
            checked={signOutOtherDevices}
            disabled={submitting}
            onChange={(e) => onSignOutOtherDevicesChange(e.target.checked)}
          />
          Sign out my other devices
        </label>
      )}
    </>
  );
}

export default ChangePasswordFields;
