import type { MutationResult } from '@/lib/api';

/**
 * Approve-failure copy (approveTotpGuard.test.ts's
 * belt-and-braces check). The server's TOTP_ENROLLMENT_REQUIRED reason
 * ("Approval requires an enrolled authenticator on your account.") is
 * honest but not actionable — it never says HOW. This adds the one path
 * this app actually has: TOTP enrolment is a login-time interstitial
 * (features/auth/LoginPage.tsx's `totpStep === 'enroll'`), not a settings
 * page reachable while already signed in — so the fix is signing out and
 * back in. Pure, so the exact copy is unit-testable without mounting
 * ApprovalsQueue (this repo has no jsdom — test/standalone.test.ts).
 */
export function describeApproveError(result: Extract<MutationResult, { ok: false }>): string {
  if (result.code === 'TOTP_ENROLLMENT_REQUIRED') {
    return (
      'Approving requires two-factor authentication on your account, and none is enrolled yet. ' +
      'Sign out and sign back in — you will be prompted to set one up — then try approving again.'
    );
  }
  return result.reason;
}
