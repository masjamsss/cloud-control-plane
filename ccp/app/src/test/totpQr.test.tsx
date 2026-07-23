import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TotpQr } from '@/features/auth/TotpQr';
import { TotpEnrollFields } from '@/features/auth/LoginPage';

/**
 * The TOTP enrolment QR (offline, client-side SVG — qrcode.react). No jsdom in
 * this repo, so these are static renders (react-dom/server), the same
 * technique totpRequired.test.ts/advisoryGate.test.ts use for the rest of the
 * auth/admin UI.
 *
 * RFC_SECRET is the RFC 6238 Appendix B published test key (base32 of
 * "12345678901234567890") — the same generic, non-estate secret
 * authFlow.test.ts already uses; the otpauth URI shape mirrors what the real
 * server actually mints (ccp/api/src/auth/totp.ts's otpauthUri() is
 * otplib's authenticator.keyuri(username, issuer, secret) — a standard
 * label/secret/issuer/digits otpauth://totp/ URI), so this is a realistic
 * enrolment payload, not a placeholder shape.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const URI = `otpauth://totp/Cloud%20Control%20Plane:putra?secret=${RFC_SECRET}&issuer=Cloud%20Control%20Plane&digits=6`;

/** Opening tag carrying a unique attribute marker (mirrors totpRequired.test.ts / advisoryGate.test.ts). */
function tagFor(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  expect(idx, `marker ${marker} not found in:\n${html}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', idx), html.indexOf('>', idx) + 1);
}

describe('TotpQr — offline, client-side inline SVG', () => {
  it('renders an <svg> carrying the accessible label', () => {
    const html = renderToStaticMarkup(React.createElement(TotpQr, { value: URI }));
    const tag = tagFor(html, 'aria-label="Two-factor setup QR code"');
    expect(tag.startsWith('<svg')).toBe(true);
    expect(tag).toContain('role="img"');
  });

  it('paints on an explicit white quiet zone with dark modules — scannable in every theme', () => {
    const html = renderToStaticMarkup(React.createElement(TotpQr, { value: URI }));
    // Fixed colors, not theme tokens: a scanner needs light bg + dark fg regardless
    // of the app's active theme/palette (dark theme inverts --surface-1 — tokens.css).
    expect(html).toContain('fill="#ffffff"');
    expect(html).toContain('fill="#111111"');
  });

  it('really encodes the given otpauth URI — two different values render two different codes', () => {
    const a = renderToStaticMarkup(React.createElement(TotpQr, { value: URI }));
    const otherUri = `otpauth://totp/Cloud%20Control%20Plane:sari?secret=${RFC_SECRET}&issuer=Cloud%20Control%20Plane&digits=6`;
    const b = renderToStaticMarkup(React.createElement(TotpQr, { value: otherUri }));
    expect(a).not.toBe(b);
  });

  it('never renders a network reference — no http(s) scheme anywhere in the markup', () => {
    const html = renderToStaticMarkup(React.createElement(TotpQr, { value: URI }));
    expect(html).not.toMatch(/https?:\/\//i);
  });
});

describe('TotpEnrollFields — the enrolment screen renders the QR AND keeps the setup-key fallback', () => {
  const enrollment = { secret: RFC_SECRET, otpauthUri: URI };

  it('renders the QR', () => {
    const html = renderToStaticMarkup(React.createElement(TotpEnrollFields, { enrollment }));
    const tag = tagFor(html, 'aria-label="Two-factor setup QR code"');
    expect(tag.startsWith('<svg')).toBe(true);
  });

  it('still shows the setup key + otpauth URI as the manual/accessible fallback, in the SAME render', () => {
    const html = renderToStaticMarkup(React.createElement(TotpEnrollFields, { enrollment }));
    expect(html).toContain('Setup key');
    // parseOtpauthSecret(enrollment.otpauthUri) resolves to RFC_SECRET here, so this
    // also proves the <code> fallback still renders the parsed setup key.
    expect(html).toContain(RFC_SECRET);
    expect(html).toContain('Or add this URI to your app');
    expect(html).toContain('aria-labelledby="totp-secret-label"');
    expect(html).toContain('id="totp-secret-label"');
  });

  it('carries no external network reference anywhere on the composed screen', () => {
    const html = renderToStaticMarkup(React.createElement(TotpEnrollFields, { enrollment }));
    // otpauth:// is expected (the manual-fallback text); http(s) never is.
    expect(html).not.toMatch(/https?:\/\//i);
  });
});
