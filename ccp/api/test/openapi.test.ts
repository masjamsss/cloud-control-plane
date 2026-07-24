import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const yaml = readFileSync(new URL('../openapi/ccp-api.yaml', import.meta.url), 'utf8');

describe('OpenAPI contract (spec §3, extracted verbatim)', () => {
  it('is OpenAPI 3.1.0 with the required top-level sections and security scheme', () => {
    expect(yaml.startsWith('openapi: 3.1.0')).toBe(true);
    for (const key of ['info:', 'servers:', 'security:', 'components:', 'paths:']) expect(yaml).toContain(`\n${key}`);
    expect(yaml).toContain('name: ccp_session');
    expect(yaml).toContain('X-Ccp-Client');
  });

  it('every ApiClient method maps to a path present in the contract (spec §3 mapping)', () => {
    // listManifests, getInventory, listRequests/pending/all, getRequest, submitRequest,
    // approveRequest, rejectRequest — plus the auth/admin/migrate surface.
    for (const p of [
      '/catalog/manifests:',
      '/catalog/inventory:',
      '/requests:',
      '/requests/{id}:',
      '/requests/{id}/approve:',
      '/requests/{id}/reject:',
      '/auth/login:',
      '/auth/totp:',
      '/auth/me:',
      '/auth/change-password:',
      '/admin/policy:',
      '/admin/config-changes/{id}/ack:',
      '/admin/migrate/v1:',
    ]) {
      expect(yaml, p).toContain(p);
    }
  });

  it('encodes the scope enum and the identity-free submit rule', () => {
    expect(yaml).toContain('enum: [mine, pending, all]');
    expect(yaml).toContain('SubmitDraft');
  });

  it('0021 F6/G7: the three previously-shipped-but-undocumented endpoints are now declared', () => {
    for (const p of ['/auth/totp/enroll:', '/admin/accounts/{id}/reset-totp:', '/admin/accounts/{id}/revoke-sessions:']) {
      expect(yaml, p).toContain(p);
    }
  });

  it('0021 G1/G5: the new cancel and feasibility endpoints this lane introduced are declared', () => {
    for (const p of ['/requests/{id}/cancel:', '/requests/{id}/feasibility:']) {
      expect(yaml, p).toContain(p);
    }
    expect(yaml).toContain('Feasibility:');
    expect(yaml).toContain('interimProfileWillApply');
  });

  it('0024 T-S2: SubmitDraft.schedule documents the V1-V6 validation rules', () => {
    expect(yaml).toContain('SCHEDULE_INVALID');
    expect(yaml).toContain('SCHEDULE_TOO_SOON');
    expect(yaml).toContain('SCHEDULE_TOO_FAR');
    expect(yaml).toContain('endAt');
  });

  it('0024 T-S3/T-S4: WINDOW_EXPIRED, held_frozen, and the new rewindow verb are declared', () => {
    expect(yaml).toContain('WINDOW_EXPIRED');
    expect(yaml).toContain('held_frozen');
    expect(yaml, '/requests/{id}/rewindow:').toContain('/requests/{id}/rewindow:');
    expect(yaml).toContain('SCHEDULE_STALE_APPROVAL');
    expect(yaml).toContain('REWINDOW_FORBIDDEN');
  });

  it('0024 §2.5/C5: cancel documents its widened valid-state set', () => {
    expect(yaml).toContain('AWAITING_DEPLOY_APPROVAL (before OR during its maintenance');
  });

  it('0033 A12/P6: the link-pr verb is declared with its body and refusal semantics', () => {
    expect(yaml, '/requests/{id}/link-pr:').toContain('/requests/{id}/link-pr:');
    expect(yaml).toContain('prUrl');
    expect(yaml).toContain('pr_linked');
    expect(yaml).toContain('request-link-pr');
  });

  it('0033 §3.2 (W5/N2): the projects registry + trust surface is declared, fail-closed semantics included', () => {
    for (const p of ['/projects:', '/projects/{id}:', '/projects/{id}/trust-request:', '/projects/{id}/trust:']) {
      expect(yaml, p).toContain(p);
    }
    // the retired single-lead go-live lane must NOT come back: the first data
    // activation's 2-admin ack is the ONE transition to ready
    expect(yaml).not.toContain('/projects/{id}/complete');
    // the artifact schemas and the binding/verdict refusals
    expect(yaml).toContain('PrescanReport');
    expect(yaml).toContain('PRESCAN_SHA_MISMATCH');
    expect(yaml).toContain('TRUST_VERDICT_NOT_CLEAN');
    expect(yaml).toContain('DUPLICATE_PROJECT');
    // dual-control kinds for trust + deregister ride the standing PendingConfigChange machinery
    expect(yaml).toContain('project-trust');
    expect(yaml).toContain('project-deregister');
    expect(yaml).toContain('Trusted repo for onboarding');
    // status ladder + ready-only routability are contract text, not implementation trivia
    expect(yaml).toContain('enum: [draft, pending-trust, trusted, ready]');
    // security review: GET /projects is two-tier — the thin ProjectSummary for
    // any session, the rich Project only for lead+isAdmin.
    expect(yaml).toContain('ProjectSummary');
    expect(yaml).toContain('TWO-TIER');
  });

  it('easy-first-import spec §3 A-ii/A-iii (Phase 1): the onboard-token mint/revoke paths and the trust-request Bearer alternative are declared', () => {
    for (const p of ['/projects/{id}/onboard-tokens:', '/projects/{id}/onboard-tokens/{tokenId}:']) {
      expect(yaml, p).toContain(p);
    }
    expect(yaml).toContain('onboard-token-mint');
    expect(yaml).toContain('onboard-token-revoke');
    expect(yaml).toContain('ONBOARD_TOKEN_INVALID');
    // the Bearer lane is documented on the SAME existing trust-request path — no new route for it
    const trustRequestBlock = yaml.slice(yaml.indexOf('\n  /projects/{id}/trust-request:'), yaml.indexOf('\n  /projects/{id}/trust:'));
    expect(trustRequestBlock).toContain('Bearer');
    expect(trustRequestBlock).toContain('onboard-token:<tokenId>');
  });

  it('OOB provisioning-import spec §6/WI-S6: the import flavor is declared on the existing submit route — no new route', () => {
    // No new path — the whole feature rides the EXISTING submit route (spec §6/§11: "no new routes").
    expect(yaml, '/projects/{id}/drift/proposals/{digest}/submit:').toContain('/projects/{id}/drift/proposals/{digest}/submit:');
    expect(yaml).toContain('enum: [adopt, revert, import, restore]');
    expect(yaml).toContain('DriftImportProposalPayload');
    expect(yaml).toContain('CCP_DRIFT_IMPORT');
    expect(yaml).toContain('import+import');
    // the pinned params contract named verbatim (spec §6's audit-F1(a) import member)
    expect(yaml).toContain('{finding, importPayload, diff:null, proposalDigest, reportVersion}');
  });

  it('L29 (register 0009, 2026-07-20-drift-restore-tranche.md §2.5): the restore flavor is declared on the existing submit route — no new route', () => {
    // No new path — restore, like import before it, rides the EXISTING submit route.
    expect(yaml, '/projects/{id}/drift/proposals/{digest}/submit:').toContain('/projects/{id}/drift/proposals/{digest}/submit:');
    expect(yaml).toContain('enum: [adopt, revert, import, restore]');
    expect(yaml).toContain('CCP_DRIFT_RESTORE');
    expect(yaml).toContain('restore+restore');
  });

  it('ADR-0023: the instance-identity routes are declared — unauthenticated read, admin-global write', () => {
    for (const p of ['/instance:', '/admin/instance:']) {
      expect(yaml, p).toContain(p);
    }
    expect(yaml).toContain('instance-identity-change');
    expect(yaml).toContain('INSTANCE_STALE');
    // The read is unauthenticated (pre-auth login-page render) — pinned distinct
    // from the merely-per-route `security: []` on /auth/login and /auth/totp*.
    const instanceBlock = yaml.slice(yaml.indexOf('\n  /instance:'), yaml.indexOf('\n  /admin/instance:'));
    expect(instanceBlock).toContain('security: []');
  });
});
