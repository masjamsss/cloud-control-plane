import { useRef, useState } from 'react';
import type { JSX } from 'react';
import type { HttpApiClient } from '@/lib/httpApi';
import '@/features/auth/login.css';
import { isReauthError, reauthVia } from './accountFlow';
import './reauth-dialog.css';

type ReauthMode = 'password' | 'code';

export interface ReauthGate {
  /**
   * Wrap any ⚿-gated call: run it, and if it refuses for lack of a fresh
   * elevation, open the "confirm it's you" dialog, wait for the person to
   * prove it's them, then retry the SAME call once more. A cancelled dialog
   * re-throws the ORIGINAL refusal unchanged; any other failure was never
   * this gate's to catch and passes straight through, no dialog shown.
   */
  withReauth: <T>(action: () => Promise<T>) => Promise<T>;
  /** Mount this once anywhere in the page — renders nothing until
   * `withReauth` needs it. */
  dialog: JSX.Element | null;
}

/**
 * Owns the elevation dialog every sensitive account action can hit. One
 * instance per page is enough (only one elevation is ever in flight at a
 * time) — every card shares it via the returned `withReauth`. `allowCode`
 * offers the "authenticator code" tab alongside password — the caller passes
 * true only in api mode once the account holds at least one device; the mock
 * backend has no real secret to check a code against, and an account with no
 * device has no code to offer either way.
 */
export function useReauthGate(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  allowCode: boolean,
): ReauthGate {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ReauthMode>('password');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  function openDialog(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setMode('password');
      setValue('');
      setError(null);
      setOpen(true);
    });
  }

  function settle(ok: boolean): void {
    setOpen(false);
    setBusy(false);
    setValue('');
    const resolve = pending.current;
    pending.current = null;
    resolve?.(ok);
  }

  async function submit(): Promise<void> {
    if (value.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const ok = await reauthVia(
      authoritative,
      client,
      id,
      mode === 'password' ? { password: value } : { code: value },
    );
    if (ok) {
      settle(true);
      return;
    }
    setBusy(false);
    setValue('');
    setError(mode === 'password' ? 'Wrong password.' : 'That code was not accepted.');
  }

  async function withReauth<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (err) {
      if (!isReauthError(err)) throw err;
      const elevated = await openDialog();
      if (!elevated) throw err;
      return action();
    }
  }

  const dialog = open ? (
    <ReauthDialogView
      mode={mode}
      onModeChange={setMode}
      allowCode={allowCode}
      value={value}
      onValueChange={setValue}
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { withReauth, dialog };
}

export interface ReauthDialogViewProps {
  mode: ReauthMode;
  onModeChange: (mode: ReauthMode) => void;
  allowCode: boolean;
  value: string;
  onValueChange: (value: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
}

/** The dialog body itself — pure/prop-driven, split out so it only exists in
 * the tree while actually open, and exported so it renders (and is tested)
 * standalone without the stateful hook around it. */
export function ReauthDialogView({
  mode,
  onModeChange,
  allowCode,
  value,
  onValueChange,
  busy,
  error,
  onSubmit,
  onCancel,
}: ReauthDialogViewProps): JSX.Element {
  return (
    <div className="reauth-dialog__backdrop" onClick={onCancel}>
      <div
        className="reauth-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm it's you"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="reauth-dialog__title">Confirm it's you</h2>
        <p className="reauth-dialog__sub">
          This is a sensitive action. Enter your password
          {allowCode ? ', or a current code from your authenticator app,' : ''} to continue.
        </p>

        {allowCode && (
          <div className="reauth-dialog__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'password'}
              className={`reauth-dialog__tab${mode === 'password' ? ' reauth-dialog__tab--active' : ''}`}
              onClick={() => onModeChange('password')}
            >
              Password
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'code'}
              className={`reauth-dialog__tab${mode === 'code' ? ' reauth-dialog__tab--active' : ''}`}
              onClick={() => onModeChange('code')}
            >
              Authenticator code
            </button>
          </div>
        )}

        <form
          className="login__form"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          noValidate
        >
          <div className="login__field">
            <label className="login__label" htmlFor="reauth-value">
              {mode === 'password' ? 'Password' : '6-digit code'}
            </label>
            <input
              id="reauth-value"
              className="login__input"
              type={mode === 'password' ? 'password' : 'text'}
              inputMode={mode === 'code' ? 'numeric' : undefined}
              autoComplete={mode === 'password' ? 'current-password' : 'one-time-code'}
              maxLength={mode === 'code' ? 6 : undefined}
              value={value}
              disabled={busy}
              aria-invalid={error !== null}
              onChange={(e) =>
                onValueChange(mode === 'code' ? e.target.value.replace(/\D/g, '') : e.target.value)
              }
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
            disabled={busy || value.trim().length === 0}
          >
            {busy ? 'Confirming…' : 'Confirm'}
          </button>
          <button className="login__link" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}
