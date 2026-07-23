import { useState } from 'react';
import type { JSX } from 'react';
import './login.css';
import './recovery-codes.css';

export interface RecoveryCodesCeremonyProps {
  /** The plaintext codes, shown exactly once — neither this component nor
   * anything that handed it these codes keeps them around after this render;
   * closing or navigating away loses them for good (by design — only a hash
   * is ever kept). */
  codes: string[];
  /** Filename for the downloaded copy, no extension (".txt" is appended). */
  downloadName?: string;
  onContinue: () => void;
  continueLabel?: string;
}

/**
 * The one-time recovery-code save ceremony: shown right after the first
 * authenticator device is confirmed (forced first sign-in, or a later
 * standing add-device that happens to be the account's first), and again
 * whenever the whole set is deliberately regenerated. Ten single-use codes —
 * each one signs a person in exactly once if every enrolled device is lost —
 * a plain download plus an explicit "I saved these" acknowledgement before
 * the caller lets the person move on. Pure/prop-driven, shared between the
 * sign-in page's forced flow and the standing Account page.
 */
export function RecoveryCodesCeremony({
  codes,
  downloadName = 'recovery-codes',
  onContinue,
  continueLabel = 'Continue',
}: RecoveryCodesCeremonyProps): JSX.Element {
  const [saved, setSaved] = useState(false);

  function download(): void {
    const body = `${codes.join('\n')}\n`;
    const blob = new Blob([body], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${downloadName}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="codes-ceremony">
      <p className="login__hint">
        Save these somewhere safe — each one signs you in exactly once if you lose every
        authenticator device. They are shown only this once.
      </p>
      <ul className="codes-ceremony__grid">
        {codes.map((code) => (
          <li key={code} className="codes-ceremony__code">
            {code}
          </li>
        ))}
      </ul>
      <button type="button" className="login__link codes-ceremony__download" onClick={download}>
        Download as a text file
      </button>
      <label className="login__checkbox-row" htmlFor="codes-ceremony-saved">
        <input
          id="codes-ceremony-saved"
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I've saved these codes somewhere safe
      </label>
      <button className="login__submit" type="button" disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </button>
    </div>
  );
}

export default RecoveryCodesCeremony;
