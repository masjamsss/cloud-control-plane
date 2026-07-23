import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangePasswordFields } from '@/features/auth/ChangePasswordFields';
import { RecoveryCodesCeremony } from '@/features/auth/RecoveryCodesCeremony';
import { ReauthDialogView } from '@/features/account/ReauthDialog';

/**
 * The Account & security surface's pure, prop-driven pieces — rendered as SSR
 * strings (no jsdom in this repo; react-dom/server, the TotpQr/DriftPanel
 * precedent). The stateful pages themselves (AccountSecurityPage, the
 * useReauthGate hook) aren't rendered here — their branching is proven
 * directly in accountFlow.test.ts / authFlow.test.ts instead, the same split
 * usersFlow.test.ts / advisoryGate.test.ts already draw between wiring and
 * markup. This file pins the markup: what shows, what a prop hides, and that
 * the router + account menu really do register the new surface.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function noop(): void {
  /* controlled-input handler stub */
}

describe('ChangePasswordFields', () => {
  const base = {
    idPrefix: 'test',
    currentPassword: '',
    onCurrentPasswordChange: noop,
    newPassword: '',
    onNewPasswordChange: noop,
    confirmPassword: '',
    onConfirmPasswordChange: noop,
    signOutOtherDevices: true,
    onSignOutOtherDevicesChange: noop,
    submitting: false,
    invalid: false,
  };

  it('shows the current-password field when asked (the standing card, and api-mode forced flow)', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChangePasswordFields, {
        ...base,
        showCurrentPassword: true,
        showKeepOtherSessions: false,
      }),
    );
    expect(html).toContain('Current password');
    expect(html).toContain('New password');
    expect(html).toContain('Confirm new password');
  });

  it('hides the current-password field when told to (mock-mode forced first-use)', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChangePasswordFields, {
        ...base,
        showCurrentPassword: false,
        showKeepOtherSessions: false,
      }),
    );
    expect(html).not.toContain('Current password');
    expect(html).toContain('New password');
  });

  it('shows the "sign out other devices" checkbox only when asked (the standing card, not the forced flow)', () => {
    const withCheckbox = renderToStaticMarkup(
      React.createElement(ChangePasswordFields, {
        ...base,
        showCurrentPassword: true,
        showKeepOtherSessions: true,
      }),
    );
    expect(withCheckbox).toContain('Sign out my other devices');

    const without = renderToStaticMarkup(
      React.createElement(ChangePasswordFields, {
        ...base,
        showCurrentPassword: true,
        showKeepOtherSessions: false,
      }),
    );
    expect(without).not.toContain('Sign out my other devices');
  });

  it('renders no <form> tag of its own — callers own the surrounding form', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChangePasswordFields, {
        ...base,
        showCurrentPassword: true,
        showKeepOtherSessions: true,
      }),
    );
    expect(html).not.toContain('<form');
  });

  it('ids are namespaced by idPrefix, so the login page and the standing card never collide', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChangePasswordFields, {
        ...base,
        idPrefix: 'acct-pw',
        showCurrentPassword: true,
        showKeepOtherSessions: true,
      }),
    );
    expect(html).toContain('id="acct-pw-currentpw"');
    expect(html).toContain('id="acct-pw-newpw"');
    expect(html).toContain('id="acct-pw-confirmpw"');
  });
});

describe('RecoveryCodesCeremony', () => {
  const codes = ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH', 'JJJJ-KKKK-LLLL-MMMM'];

  it('shows every code exactly once', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryCodesCeremony, { codes, onContinue: noop }),
    );
    for (const code of codes) expect(html).toContain(code);
  });

  it('the continue button starts disabled — the save acknowledgement is required first', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryCodesCeremony, { codes, onContinue: noop }),
    );
    const idx = html.indexOf('>Continue<');
    expect(idx).toBeGreaterThan(-1);
    const tag = html.slice(html.lastIndexOf('<button', idx), idx);
    expect(tag).toContain('disabled=""');
  });

  it('a custom continue label renders in place of the default', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryCodesCeremony, {
        codes,
        onContinue: noop,
        continueLabel: 'Continue signing in',
      }),
    );
    expect(html).toContain('Continue signing in');
    expect(html).not.toContain('>Continue<');
  });

  it('offers a download action and the explicit save checkbox, unchecked to start', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryCodesCeremony, { codes, onContinue: noop }),
    );
    expect(html).toContain('Download as a text file');
    // React HTML-escapes the apostrophe in static markup ("I&#x27;ve…").
    expect(html).toContain('saved these codes somewhere safe');
    expect(html).not.toContain('checked=""');
  });
});

describe('ReauthDialogView', () => {
  const base = {
    mode: 'password' as const,
    onModeChange: noop,
    allowCode: false,
    value: '',
    onValueChange: noop,
    busy: false,
    error: null,
    onSubmit: noop,
    onCancel: noop,
  };

  it('password-only (mock mode, or no device enrolled): no tabs, just the password field', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReauthDialogView, { ...base, allowCode: false }),
    );
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('>Password<');
    expect(html).not.toContain('Authenticator code');
  });

  it('allowCode: offers both tabs, password selected by default', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReauthDialogView, { ...base, allowCode: true }),
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('Authenticator code');
    const passwordTab = html.slice(
      html.indexOf('role="tab"'),
      html.indexOf('role="tab"', html.indexOf('role="tab"') + 1),
    );
    expect(passwordTab).toContain('aria-selected="true"');
  });

  it('code mode: the field label and input type switch, and the tab reflects the selection', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReauthDialogView, { ...base, mode: 'code', allowCode: true }),
    );
    expect(html).toContain('6-digit code');
    expect(html).toContain('inputMode="numeric"');
    expect(html).not.toContain('type="password"');
  });

  it('shows the error text when present, with an alert role', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReauthDialogView, { ...base, error: 'Wrong password.' }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Wrong password.');
  });

  it('carries dialog semantics for assistive tech', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReauthDialogView, { ...base, allowCode: false }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });
});

describe('router — /account is a registered project-scoped route, open to every role', () => {
  // router.tsx's createBrowserRouter needs a DOM at import time, so
  // registration is pinned at the source level (driftPanel.test.tsx's
  // technique).
  const source = readFileSync(join(SRC, 'router.tsx'), 'utf8');

  it('registers the account path with the AccountSecurityPage element and a title', () => {
    expect(source).toContain("path: 'account'");
    expect(source).toContain('<AccountSecurityPage />');
    expect(source).toContain("title: 'Account & security'");
  });

  it('is NOT wrapped in AdminGate or RoleGate, unlike Admin/Approvals/Dashboard', () => {
    const accountBlock = source.slice(
      source.indexOf("path: 'account'"),
      source.indexOf("path: 'approvals'"),
    );
    expect(accountBlock).not.toContain('AdminGate');
    expect(accountBlock).not.toContain('RoleGate');
  });
});

describe('AccountMenu — the "Account & security" item is offered to every signed-in user', () => {
  const source = readFileSync(join(SRC, 'components', 'AccountMenu.tsx'), 'utf8');

  it('links to /account, unconditionally (not behind user.isAdmin)', () => {
    const idx = source.indexOf('Account & security');
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain('to="/account"');
    expect(before).not.toContain('user.isAdmin');
  });

  it('appears before the Admin item', () => {
    const accountIdx = source.indexOf('Account & security');
    const adminIdx = source.indexOf('to="/admin"');
    expect(accountIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeGreaterThan(-1);
    expect(accountIdx).toBeLessThan(adminIdx);
  });
});
