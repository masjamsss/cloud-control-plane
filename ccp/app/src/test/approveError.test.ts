import { describe, expect, it } from 'vitest';
import { describeApproveError } from '@/features/approvals/approveError';

/**
 * 0021 G3 fold-in: TOTP_ENROLLMENT_REQUIRED must never fail silently — this
 * proves the exact, actionable copy ApprovalsQueue surfaces (sign out/back
 * in, since TOTP enrolment is a login-time interstitial in this app, not a
 * settings page — see features/auth/LoginPage.tsx), and that every other
 * code (or no code at all, e.g. a mock-mode rejection) passes the server's
 * own reason through unchanged.
 */

describe('describeApproveError', () => {
  it('TOTP_ENROLLMENT_REQUIRED gets a clear, actionable message — not the generic server reason verbatim', () => {
    const msg = describeApproveError({
      ok: false,
      code: 'TOTP_ENROLLMENT_REQUIRED',
      reason: 'Approval requires an enrolled authenticator on your account.',
    });
    expect(msg).not.toBe('Approval requires an enrolled authenticator on your account.');
    expect(msg).toMatch(/sign out/i);
    expect(msg).toMatch(/sign back in/i);
    expect(msg).toMatch(/two-factor/i);
  });

  it('every other code passes the server reason through unchanged', () => {
    expect(
      describeApproveError({
        ok: false,
        code: 'ENGINEER_REVIEW_REQUIRED',
        reason: 'This change needs an engineer-tier review; only a Lead can approve it.',
      }),
    ).toBe('This change needs an engineer-tier review; only a Lead can approve it.');

    expect(
      describeApproveError({ ok: false, code: 'ALREADY_APPROVED', reason: 'You have already approved this request.' }),
    ).toBe('You have already approved this request.');
  });

  it('no code at all (e.g. a mock-mode rejection) passes the reason through unchanged', () => {
    expect(describeApproveError({ ok: false, reason: 'Only approvers and leads can approve.' })).toBe(
      'Only approvers and leads can approve.',
    );
  });
});
