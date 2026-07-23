import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HttpApiClient } from '@/lib/httpApi';
import {
  effectiveTotpRequired,
  isPrivilegedAccount,
  needsTotpDowngradeConfirm,
  setAccountTotpRequiredVia,
} from '@/features/admin/usersFlow';
import { AccountRow, TOTP_DOWNGRADE_WARNING, enrolledNotice } from '@/features/admin/UsersAdmin';
import { enroll, getAccount, resetStoreForTests, type Account } from '@/lib/accounts';
import type { Team } from '@/types';

/**
 * Feature A (proposal 0037 §2), app side — the admin-controlled per-user 2FA
 * requirement. The pure rule mirrors the server's `needsTotp`; the UI adds the
 * one thing the server deliberately does NOT enforce — a warning + explicit
 * confirm before an admin turns 2FA OFF for a privileged account (a security
 * downgrade). The server permits + audits that either way; this is the safety
 * net. No jsdom in this repo, so the guard-rail LOGIC is proven as pure
 * functions and the control's armed/disabled shape via a static render (the same
 * technique advisoryGate.test.ts uses for the rest of AccountRow).
 */

/* ── the pure rule + guard-rail decision ───────────────────────────────────── */

describe('effectiveTotpRequired — the app mirror of the server rule', () => {
  it('uses the role default when there is no explicit override', () => {
    expect(effectiveTotpRequired({ role: 'requester' })).toBe(false);
    expect(effectiveTotpRequired({ role: 'approver' })).toBe(true);
    expect(effectiveTotpRequired({ role: 'lead' })).toBe(true);
    expect(effectiveTotpRequired({ role: 'requester', isAdmin: true })).toBe(true);
  });

  it('an explicit override wins in both directions', () => {
    expect(effectiveTotpRequired({ role: 'requester', totpRequired: true })).toBe(true);
    expect(effectiveTotpRequired({ role: 'lead', totpRequired: false })).toBe(false);
    expect(effectiveTotpRequired({ role: 'requester', isAdmin: true, totpRequired: false })).toBe(false);
  });
});

describe('isPrivilegedAccount', () => {
  it('true for approver/lead/admin, false for a plain requester', () => {
    expect(isPrivilegedAccount({ role: 'requester' })).toBe(false);
    expect(isPrivilegedAccount({ role: 'approver' })).toBe(true);
    expect(isPrivilegedAccount({ role: 'lead' })).toBe(true);
    expect(isPrivilegedAccount({ role: 'requester', isAdmin: true })).toBe(true);
  });
});

describe('needsTotpDowngradeConfirm — the UI-only guard rail', () => {
  it('turning 2FA OFF for a privileged account demands the warning + confirm', () => {
    expect(needsTotpDowngradeConfirm({ role: 'lead' }, false)).toBe(true);
    expect(needsTotpDowngradeConfirm({ role: 'approver' }, false)).toBe(true);
    expect(needsTotpDowngradeConfirm({ role: 'requester', isAdmin: true }, false)).toBe(true);
  });

  it('no confirm when turning it ON, or turning it off for a plain requester', () => {
    expect(needsTotpDowngradeConfirm({ role: 'lead' }, true)).toBe(false);
    expect(needsTotpDowngradeConfirm({ role: 'requester' }, false)).toBe(false);
    expect(needsTotpDowngradeConfirm({ role: 'requester' }, true)).toBe(false);
  });
});

/* ── the wired write (server PATCH when authoritative, else the demo store) ── */

function spy<T extends unknown[], R>(impl: (...a: T) => R): ((...a: T) => R) & { calls: T[] } {
  const fn = (...a: T): R => {
    fn.calls.push(a);
    return impl(...a);
  };
  fn.calls = [] as T[];
  return fn;
}
function clientWith(over: Partial<HttpApiClient>): HttpApiClient {
  return over as unknown as HttpApiClient;
}

describe('setAccountTotpRequiredVia', () => {
  it('authoritative: calls client.setAccountTotpRequired(id, required) verbatim and returns its outcome', async () => {
    const setAccountTotpRequired = spy(async () => ({ applied: true as const }));
    const out = await setAccountTotpRequiredVia(true, clientWith({ setAccountTotpRequired }), 'lina', false);
    expect(setAccountTotpRequired.calls).toEqual([['lina', false]]);
    expect(out).toEqual({ applied: true });
  });

  it('propagates a server rejection (the caller surfaces its reason)', async () => {
    const setAccountTotpRequired = spy(async () => {
      throw new Error('No such account.');
    });
    await expect(
      setAccountTotpRequiredVia(true, clientWith({ setAccountTotpRequired }), 'ghost', true),
    ).rejects.toThrow('No such account.');
  });

  it('not authoritative: pins the requirement on the demo account store — the server is never called', async () => {
    resetStoreForTests();
    const setAccountTotpRequired = spy(async (): Promise<{ applied: true }> => {
      throw new Error('server must not be called when not authoritative');
    });
    await enroll(
      { username: 'lina', displayName: 'Lina', role: 'lead', teamId: 'platform', password: 'satu-dua-tiga-empat' },
      'system',
    );
    // A lead defaults to required; pin it OFF and the persisted account must say so.
    const out = await setAccountTotpRequiredVia(false, clientWith({ setAccountTotpRequired }), 'lina', false);
    expect(setAccountTotpRequired.calls).toEqual([]);
    expect(out).toEqual({ applied: true });
    const stored = getAccount('lina');
    expect(stored?.totpRequired).toBe(false);
    expect(effectiveTotpRequired(stored!)).toBe(false);
    // …and back ON, so the toggle round-trips against real local state.
    await setAccountTotpRequiredVia(false, null, 'lina', true);
    expect(getAccount('lina')?.totpRequired).toBe(true);
  });
});

/* ── the control's static shape (armed/disabled, effective value) ──────────── */

const teams: Team[] = [{ id: 'platform', name: 'Platform', serviceSlugs: [] }];
const lead: Account = {
  id: 'lina',
  username: 'lina',
  displayName: 'Lina',
  role: 'lead',
  teamId: 'platform',
  passwordHash: '',
  salt: '',
  iterations: 0,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'system',
};
const requester: Account = { ...lead, id: 'sari', username: 'sari', displayName: 'Sari', role: 'requester' };

function row(account: Account, authoritative: boolean, demo = false): string {
  return renderToStaticMarkup(
    React.createElement(
      'table',
      null,
      React.createElement(
        'tbody',
        null,
        React.createElement(AccountRow, { account, isMe: false, teams, authoritative, demo, onChange: () => {} }),
      ),
    ),
  );
}
/** Opening tag carrying a unique attribute marker (mirrors advisoryGate.test.ts). */
function tagFor(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  expect(idx, `marker ${marker} not found in:\n${html}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', idx), html.indexOf('>', idx) + 1);
}

describe('AccountRow — the 2FA control', () => {
  it('shows the EFFECTIVE requirement: Required for a privileged account, Not required for a requester', () => {
    expect(row(lead, true)).toContain('>Required<');
    expect(row(requester, true)).toContain('>Not required<');
  });

  it('an explicit override overrides the role default in the label', () => {
    expect(row({ ...requester, totpRequired: true }, true)).toContain('>Required<');
    expect(row({ ...lead, totpRequired: false }, true)).toContain('>Not required<');
  });

  it('arms on authoritative in an api build: disabled until the server serves users', () => {
    expect(tagFor(row(lead, false), 'aria-label="Two-factor authentication for Lina"')).toContain('disabled');
    expect(tagFor(row(lead, true), 'aria-label="Two-factor authentication for Lina"')).not.toContain('disabled');
  });

  it('demo build: LIVE against the demo account store — no dead toggle without a backend', () => {
    const tag = tagFor(row(lead, false, true), 'aria-label="Two-factor authentication for Lina"');
    expect(tag).not.toContain('disabled');
  });

  it('shows whether an authenticator app is connected, so a TOTP reset visibly changes the row', () => {
    expect(row({ ...lead, totpEnrolled: true }, true)).toContain('app connected');
    expect(row(lead, true)).not.toContain('app connected');
  });
});

describe('TOTP_DOWNGRADE_WARNING — plain-language copy (operator rule)', () => {
  it('names 2FA and the downgrade, with no internal notation', () => {
    expect(TOTP_DOWNGRADE_WARNING).toContain('two-factor authentication (2FA)');
    expect(TOTP_DOWNGRADE_WARNING.toLowerCase()).toContain('downgrade');
    expect(TOTP_DOWNGRADE_WARNING).not.toContain('§');
    expect(TOTP_DOWNGRADE_WARNING).not.toMatch(/ADR-|00\d{2}/);
  });
});

describe('enrolledNotice — OP-2 handover guidance on the enrol form', () => {
  it('names the enrolled account and says how the password moves + that it must be rotated', () => {
    const notice = enrolledNotice('Raka', 'raka');
    expect(notice).toContain('Enrolled Raka (@raka).');
    // The two things OP-2 found missing: how the admin-chosen password
    // reaches the teammate, and that they cannot keep using it forever.
    expect(notice.toLowerCase()).toContain('share the starting password');
    expect(notice.toLowerCase()).toMatch(/set a new (one|password)/);
  });

  it('carries no internal notation (operator copy rule)', () => {
    const notice = enrolledNotice('Raka', 'raka');
    expect(notice).not.toContain('§');
    expect(notice).not.toMatch(/ADR-|00\d{2}/);
  });
});
