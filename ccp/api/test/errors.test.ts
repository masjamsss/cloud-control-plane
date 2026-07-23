import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { ERRORS, apiError, type ErrorCode } from '../src/errors';

function appForCode(code: ErrorCode): Hono {
  const app = new Hono();
  app.get('/', (c) => apiError(c, code));
  return app;
}

const CODES = Object.keys(ERRORS) as ErrorCode[];

describe('§8 error taxonomy', () => {
  it('has exactly the spec §8 codes at the spec statuses', () => {
    const byStatus: Record<number, Set<string>> = {};
    for (const [code, { status }] of Object.entries(ERRORS)) {
      (byStatus[status] ??= new Set()).add(code);
    }
    expect(byStatus[401]).toEqual(
      new Set([
        'NO_SESSION',
        'SESSION_EXPIRED',
        'SESSION_INVALIDATED',
        'BAD_CREDENTIALS',
        'TOTP_REQUIRED',
        'UPLOAD_TOKEN_INVALID', // CI data-upload lane — one generic refusal, no enumeration
      ]),
    );
    expect(byStatus[403]).toEqual(
      new Set([
        'FORBIDDEN_ROLE',
        'NOT_ADMIN',
        'SELF_APPROVAL',
        'SELF_ACK',
        'SELF_DELETE', // account delete — the acting admin may never remove themselves
        'TEAM_SCOPE',
        'PROJECT_SCOPE', // account↔project binding (0014 dim-5 finding #1)
        'ENGINEER_REVIEW_REQUIRED', // exposure review-tier enforcement (0014 dim-1 finding 4.2)
        'WRONG_APPROVAL_LEVEL', // 0037 two-level ladder: the next step's role gate
        'PASSWORD_CHANGE_REQUIRED',
        'MISSING_CLIENT_HEADER',
        'CONTROL_SCOPE', // data-birth spec §5 — the reserved `@control` scope is not an estate
        'REAUTH_REQUIRED', // ADR-0026 — sensitive self-service without a fresh (<=10m) re-auth elevation
      ]),
    );
    expect(byStatus[409]).toEqual(
      new Set([
        'ALREADY_APPROVED',
        'STATE_CONFLICT',
        'STALE_PROPOSAL',
        'CHAIN_CONTENTION',
        'DUPLICATE_USERNAME',
        'DUPLICATE_TEAM',
        'TEAM_NOT_EMPTY',
        'BACKEND_NOT_EMPTY',
        'DUPLICATE_PROJECT', // 0033 §3.2 — projects registry
        'DRIFT_PROPOSAL_STALE', // drift-portal spec §4.3 — proposal not from the latest report / already submitted
        'INSTANCE_STALE', // ADR-0023 — instance-identity version guard lost a race (PUT /admin/instance)
      ]),
    );
    expect(byStatus[422]).toEqual(
      new Set([
        'VALIDATION_FAILED',
        'REPLACE_CONFIRMATION_REQUIRED', // forces-replace lane — typed confirmation required
        'OP_DISABLED',
        'PARAM_OUT_OF_BOUNDS',
        'LAST_LEAD_GUARD',
        'POLICY_OUT_OF_RANGE',
        'SCHEDULE_INVALID', // 0024 §2.1 V2/V5 — malformed schedule
        'SCHEDULE_TOO_SOON', // 0024 §2.1 V3
        'SCHEDULE_TOO_FAR', // 0024 §2.1 V4
        'SCHEDULE_STALE_APPROVAL', // 0024 §2.4 — rewindow refuses a >30d-old approval
        'PRESCAN_SHA_MISMATCH', // 0033 §3.2 — the upload must hash to the CLI's binding
        'TRUST_VERDICT_NOT_CLEAN', // 0033 §3.2 — a reject verdict never reaches a trust ack
        'DATA_DIGEST_MISMATCH', // data upload — the bundle must hash to the digests it claims
        'DRIFT_NOT_ADOPTABLE', // drift-portal spec §4.3/§8 — re-derived eligibility refused (enforcement point 2)
        'DRIFT_PROPOSAL_REQUIRED', // drift-portal spec §4.3/§8 — direct POST /requests closed for system-drift-*
        'LAST_FACTOR', // ADR-0024 clause 5 — removing the last TOTP device while needsTotp is true
        'DEVICE_LIMIT', // ADR-0024 clause 1 — self-service device add refused at the 5-device cap
      ]),
    );
    expect(byStatus[413]).toEqual(new Set(['UPLOAD_TOO_LARGE'])); // data upload — explicit size cap
    expect(byStatus[423]).toEqual(new Set(['ACCOUNT_LOCKED', 'GLOBAL_FREEZE']));
    expect(byStatus[429]).toEqual(new Set(['RATE_LIMITED', 'LOGIN_BACKOFF']));
  });

  it('BAD_CREDENTIALS.reason is exactly the generic no-enumeration string', () => {
    expect(ERRORS.BAD_CREDENTIALS.reason).toBe('Wrong username or password.');
  });

  it('every code returns its status and {code, reason} body; every 429 sets Retry-After', async () => {
    for (const code of CODES) {
      const { status, reason } = ERRORS[code];
      const res = await appForCode(code).request('/');
      expect(res.status, code).toBe(status);
      const body = (await res.json()) as { code: string; reason: string };
      expect(body.code, code).toBe(code);
      expect(body.reason, code).toBe(reason);
      if (status === 429) {
        expect(res.headers.get('Retry-After'), code).toBeTruthy();
      }
    }
  });

  it('423 carries details.until in the body; 429 Retry-After derives from until', async () => {
    const app = new Hono();
    const until = new Date(Date.now() + 120_000).toISOString();
    app.get('/locked', (c) => apiError(c, 'ACCOUNT_LOCKED', { until }));
    app.get('/backoff', (c) => apiError(c, 'LOGIN_BACKOFF', { until }));

    const r1 = await app.request('/locked');
    expect(r1.status).toBe(423);
    expect(((await r1.json()) as { details: unknown }).details).toEqual({ until });

    const r2 = await app.request('/backoff');
    expect(r2.status).toBe(429);
    const ra = Number(r2.headers.get('Retry-After'));
    expect(ra).toBeGreaterThan(100);
    expect(ra).toBeLessThanOrEqual(120);
  });
});
