import type { JSX } from 'react';
import { QRCodeSVG } from 'qrcode.react';

export interface TotpQrProps {
  /** The `otpauth://` enrolment URI the server returned alongside the setup key. */
  value: string;
}

/**
 * A scannable TOTP enrolment QR, rendered next to the existing setup-key text
 * (LoginPage keeps that as the manual/accessible fallback — this is additive,
 * never a replacement). Fully OFFLINE and CSP-safe by construction: qrcode.react
 * encodes the QR and paints it as inline SVG entirely in the browser (its QR
 * math is the vendored Nayuki `qrcodegen` reference encoder — no network I/O
 * anywhere in the library), so this works air-gapped and under a strict CSP
 * with no external host allowed. Never point this at a remote QR-image service.
 *
 * The panel is an EXPLICIT white quiet zone, independent of the active
 * theme/palette: `--surface-1` inverts to a dark tone in dark mode
 * (src/styles/tokens.css), and a scanner needs a light background + dark
 * modules regardless — reusing the themed surface token here would render an
 * unscannable dark-on-dark code in dark mode. `marginSize={4}` is the QR
 * spec's own quiet-zone width (modules), on top of the panel's own padding.
 */
export function TotpQr({ value }: TotpQrProps): JSX.Element {
  return (
    <div className="login__qr-panel">
      <QRCodeSVG
        value={value}
        size={176}
        level="M"
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#111111"
        role="img"
        aria-label="Two-factor setup QR code"
        className="login__qr-svg"
      />
    </div>
  );
}

export default TotpQr;
