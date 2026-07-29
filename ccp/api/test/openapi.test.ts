import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';

const SPEC_URL = new URL('../openapi/ccp-api.yaml', import.meta.url);

// L-10 / DOC-4: a measurement against a missing input is not a weak result, it is a
// FABRICATED one — `grep` on a path that does not exist returns 0 for every needle, and
// an audit of this very file once concluded fourteen error codes were absent because of
// it. So the contract's existence is asserted BEFORE anything is read from it: a spec
// that has been moved or renamed must fail this suite loudly, never pass it vacuously.
if (!existsSync(SPEC_URL)) throw new Error(`OpenAPI contract not found at ${SPEC_URL.pathname} — parity cannot be measured`);
const yaml = readFileSync(SPEC_URL, 'utf8');

/**
 * DOC-1/DOC-2 — the real parity check.
 *
 * What this replaced: a hand-written list of path strings asserted to be PRESENT in the
 * YAML. That test could only ever fail in one direction, and it failed in the wrong one —
 * it pinned `/catalog/manifests` and `/catalog/inventory`, two paths that were declared in
 * the contract and served by no route in `ccp/api/src`, so CI actively defended the
 * phantoms: deleting them from the spec broke the build. Meanwhile seven genuinely shipped
 * routes were missing from the contract and the test was structurally incapable of noticing.
 *
 * What replaces it: enumerate the LIVE Hono route table and the contract's declared
 * operations and diff them BOTH ways. A path in the spec that no route serves fails; a
 * route the spec does not declare fails. There is no list to keep in sync, so the check
 * cannot rot into agreeing with itself.
 */

/** Every `METHOD /path` the assembled app actually serves, in OpenAPI path syntax. */
function servedOperations(): Set<string> {
  const app = createApp(new MemoryStore());
  const ops = new Set<string>();
  for (const r of (app as unknown as { routes: Array<{ method: string; path: string }> }).routes) {
    if (r.method === 'ALL') continue; // middleware, not an operation
    ops.add(`${r.method} ${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
  }
  return ops;
}

/** Every `METHOD /path` the contract declares under `paths:`. */
function declaredOperations(): Set<string> {
  const lines = yaml.split('\n');
  const start = lines.indexOf('paths:');
  if (start < 0) throw new Error('contract has no top-level `paths:` key');
  const ops = new Set<string>();
  let current = '';
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const path = /^ {2}(\/\S*?):(\s|$)/.exec(line);
    if (path?.[1] !== undefined) {
      current = path[1];
      continue;
    }
    const verb = /^ {4}(get|post|put|patch|delete|head|options):/.exec(line);
    if (verb?.[1] !== undefined && current) ops.add(`${verb[1].toUpperCase()} ${current}`);
  }
  return ops;
}

describe('OpenAPI ↔ route-table parity (DOC-1, DOC-2)', () => {
  // L-10's cheapest check, made permanent: run the parser against a value we KNOW must
  // hit. If either extractor silently returns nothing — a renamed file, a reformatted
  // YAML block, a Hono upgrade that drops `.routes` — the diffs below would come out
  // empty and read as PERFECT PARITY. This is the assertion that makes that impossible.
  it('both extractors find a known-present operation (a broken extractor must not read as parity)', () => {
    expect(declaredOperations().size).toBeGreaterThan(50);
    expect(servedOperations().size).toBeGreaterThan(50);
    expect([...declaredOperations()]).toContain('POST /auth/login');
    expect([...servedOperations()]).toContain('POST /auth/login');
  });

  it('declares no path the API does not serve (no phantom endpoints)', () => {
    const served = servedOperations();
    const phantoms = [...declaredOperations()].filter((op) => !served.has(op)).sort();
    expect(phantoms, 'declared in ccp-api.yaml but served by no route — a generated client would 404').toEqual([]);
  });

  it('declares every path the API serves (no undocumented routes)', () => {
    const declared = declaredOperations();
    const undocumented = [...servedOperations()].filter((op) => !declared.has(op)).sort();
    expect(undocumented, 'served by ccp/api/src but absent from ccp-api.yaml — the contract understates the mutation surface').toEqual([]);
  });
});

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
    //
    // DOC-1: '/catalog/manifests:' and '/catalog/inventory:' USED TO BE PINNED HERE. They
    // were never served (there is no /catalog route group in ccp/api/src) and the SPA has
    // never called them — it reads the project-scoped paths asserted just below, which the
    // contract already declared. Pinning them here is what made the phantoms load-bearing.
    for (const p of [
      '/projects/{id}/manifests:',
      '/projects/{id}/inventory:',
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

  it('DOC-3: servers list only base paths this repo actually deploys — never /v2', () => {
    // The app mounts at the ROOT (src/index.ts#createApp); the SPA builds `${baseUrl}${path}`
    // with no /v2 segment; the shipped nginx block (ccp/docs/go-live.md) exposes the api under
    // /api and STRIPS that prefix before forwarding. Nothing in the repo ever answers on /v2,
    // so a client generated from a /v2 base 404s on every topology.
    const servers = yaml.slice(yaml.indexOf('\nservers:'), yaml.indexOf('\nsecurity:'));
    expect(servers).toContain('url: /,');
    expect(servers).toContain('url: /api,');
    // Scoped to the declaration, not the whole file: the comment above `servers:` names /v2
    // to explain why it is gone, and a test that forbade the string outright would forbid
    // ever writing down the reason.
    expect(servers).not.toContain('url: /v2');
  });

  it('DOC-2: the apply bundle — the most privileged verb on the requests surface — is fully described', () => {
    // It was documented NOWHERE: not this contract, not API-SPEC.md's endpoint table, not
    // PERMISSIONS.md's matrix. A reader must be able to find its auth tier and every refusal
    // without reading requests.ts.
    const apply = yaml.slice(yaml.indexOf('\n  /requests/{id}/apply:'), yaml.indexOf('\n  # DOC-1:'));
    expect(apply).not.toBe('');
    for (const code of ['BUNDLE_DISARMED', 'APPLY_FORBIDDEN', 'BUNDLE_RUNNING', 'STATE_CONFLICT', 'GLOBAL_FREEZE']) {
      expect(apply, code).toContain(code);
    }
    expect(apply).toContain('AWAITING_DEPLOY_APPROVAL');
    expect(apply).toContain('BundleOutcome');
  });

  it('DOC-2/DOC-4 residue: the codes the docs claimed this contract pinned are now actually in it', () => {
    // DOC-4 re-measured errors.ts's transcription claim against the REAL contract and found
    // exactly two codes genuinely absent (DUPLICATE_TEAM, ENGINEER_REVIEW_REQUIRED), plus
    // BAD_CREDENTIALS missing despite both errors.ts and ERROR-STATES.md asserting the spec
    // pinned its reason. Two of those three are now declared on the routes that emit them.
    expect(yaml).toContain('BAD_CREDENTIALS');
    expect(yaml).toContain('DUPLICATE_TEAM');
    // The no-enumeration property is the WHOLE point of BAD_CREDENTIALS having one reason.
    expect(yaml).toContain('Wrong username or password.');
    // ENGINEER_REVIEW_REQUIRED is deliberately NOT here: it is defined in errors.ts and
    // emitted by nothing (the engineer-tier gate emits WRONG_APPROVAL_LEVEL instead), so
    // declaring it would document a response the API cannot return — the same defect as
    // the /catalog phantoms DOC-1 removed. If it ever starts being emitted, this flips.
    expect(yaml).not.toContain('ENGINEER_REVIEW_REQUIRED');
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

  it('ADR-0033: both halves of the server-side scan lane are declared — operator and worker', () => {
    for (const p of [
      '/projects/{id}/scan-jobs:',
      '/projects/{id}/scan-jobs/latest:',
      '/scan-jobs/claim:', // the worker's machine lane — deliberately NOT under /projects
      '/scan-jobs/{jobId}/status:',
    ]) {
      expect(yaml, p).toContain(p);
    }
    // The refusals a reader must be able to find without reading the code.
    for (const code of ['SCANNER_DISABLED', 'SCAN_TARGET_REFUSED', 'SCANNER_KEY_INVALID']) {
      expect(yaml, code).toContain(code);
    }
    // The properties that make the worker lane safe are DOCUMENTED, not merely
    // implemented — an operator auditing the contract can see them here.
    const claimBlock = yaml.slice(yaml.indexOf('\n  /scan-jobs/claim:'), yaml.indexOf('\n  /scan-jobs/{jobId}/status:'));
    expect(claimBlock).toContain('THE WORKER NEVER CHOOSES ITS TARGET');
    expect(claimBlock).toContain('compare-and-swap');
    expect(claimBlock).toContain("'204': { description: Nothing queued }");
  });
});
