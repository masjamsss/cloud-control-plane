import type {
  ChangeRequest,
  ChangeSetDraft,
  Inventory,
  RiskFloor,
  Role,
  Schedule,
  ServiceManifest,
  User,
} from '@/types';
import type {
  ApiClient,
  DriftCheckResult,
  DriftGenerateResult,
  MutationResult,
  SubmitResult,
} from '@/lib/api';
import type { DriftProposal, DriftReport, DriftStatus } from '@/types/drift';
import { noCapabilities, type ServerInfo } from '@/lib/serverInfo';
import { currentProjectId, SAMPLE_ESTATE_ID } from '@/lib/projectScope';
import { parseManifests } from '@/types/manifestSchema';
import { manifests as bundledManifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';

/**
 * The real ccp-api client (the ADVISORY → AUTHORITATIVE flip). It
 * implements the SAME {@link ApiClient} seam the mock does, but every governed
 * operation goes to ccp-api over `fetch`, where the actor is derived from the
 * session cookie (never a client-supplied id) and separation-of-duties, freeze,
 * disabled-ops and param bounds are re-enforced server-side. The error taxonomy
 * (`{code, reason}`) maps back onto {@link MutationResult}/{@link SubmitResult}.
 *
 * The session cookie is httpOnly, so this client never reads or writes it: it
 * relies on `credentials:'include'` and lets the browser carry it. Under test a
 * cookie-jar `fetch` is injected via {@link HttpApiOptions.fetch} to emulate that.
 *
 * The two read-only catalog surfaces (`listManifests`/`getInventory`) resolve
 * per account: the SAMPLE estate ({@link SAMPLE_ESTATE_ID} — never a runtime
 * default, only served once explicitly loaded) stays build-time (deterministic,
 * the same data the mock uses), while every other account — which, post
 * data-birth, is every REAL onboarded estate — reads ccp-api's data plane
 * (`GET /projects/:id/manifests|inventory` — the ACTIVE uploaded version) so
 * onboarding an account needs no vendor-and-rebuild step; any miss falls back
 * to the injected vendored-or-empty resolver. The request lifecycle + admin
 * surfaces hit the server as before.
 */

// CSRF client header (ccp-api middleware/session.ts: X-Ccp-Client const).
const CLIENT_HEADER = 'x-ccp-client';
const CLIENT_VALUE = 'ccp-spa';
// Acting-account header (ccp-api middleware/session.ts: withProject). Every
// call names the account (project) it acts on — without it the server resolves
// the reserved control-plane scope, and a multi-account deployment would
// silently read/write the wrong tenant if this were guessed. Sent ONLY once
// the app's active project scope (lib/projectScope) actually holds one — a
// pre-estate call (login, and anything before an estate is selected/active)
// carries NO header at all, exactly like an inert control-plane client is
// meant to (data-birth spec) — never a bogus/leftover scope. A per-call
// override serves the few admin reads that deliberately look at another
// account (e.g. that account's team list).
const PROJECT_HEADER = 'x-ccp-project';

export interface HttpApiOptions {
  /**
   * The network primitive. Defaults to the global `fetch`, which — together with
   * `credentials:'include'` — carries the httpOnly session cookie in a browser.
   * Tests inject a cookie-jar wrapper so the same flow works under Node.
   */
  fetch?: typeof fetch;
  /** Project-scoped catalog getters injected by the selector; default to bundled. */
  getManifests?: () => ServiceManifest[];
  getInventory?: () => Inventory;
}

/**
 * One per-account role binding, as ccp-api serializes it: the value half of
 * the `roles` map, keyed by an account id (project id) or `'*'` (all accounts).
 */
export interface RoleScopeBinding {
  role: Role;
  teamId?: string;
}

/** The public account projection ccp-api returns from the auth routes.
 * `role`/`teamId` are RESOLVED for the acting account (the project header this
 * client sent); `roles` is the authoritative per-account map behind them. */
export interface AuthAccount {
  id: string;
  username: string;
  displayName: string;
  role: string;
  teamId: string;
  /** The per-account role map: `{ [accountId | '*']: { role, teamId? } }`. */
  roles?: Record<string, RoleScopeBinding>;
  status: 'active' | 'disabled';
  isAdmin: boolean;
  mustChangePassword: boolean;
  totpEnrolled: boolean;
}

export interface AuthResult {
  user: AuthAccount;
  mustChangePassword: boolean;
  sessionExpiresAt?: string;
  /** Present exactly once, on whichever response completes the account's
   * FIRST device enrolment (forced first-login `enrollTotp`, or the
   * standing self-service `confirmAddTotpDevice`). Show the one-time save
   * ceremony, then never again. */
  recoveryCodes?: string[];
  /** True when this full session was opened via the recovery-code login door
   * — the Account page banners "you signed in with a recovery code, review
   * your devices" on the next render. */
  recoveryLogin?: boolean;
}

export interface LoginResult extends AuthResult {
  /** True for approver/lead/admin — a TOTP step must complete before a full session. */
  totpRequired?: boolean;
  /** Present on first login for a not-yet-enrolled privileged account. */
  totpEnrollment?: TotpEnrollmentOffer;
}

/** The QR/setup-key material for a fresh TOTP secret — shared shape between
 * first-login enrolment (`LoginResult.totpEnrollment`) and the standing
 * self-service "begin add device" step. */
export interface TotpEnrollmentOffer {
  secret: string;
  otpauthUri: string;
}

/** `GET /auth/totp-devices` row — never secretEnc. */
export interface TotpDeviceWire {
  id: string;
  name: string;
  enrolledAt: string;
  lastUsedAt?: string;
}

/** `POST /auth/totp-devices/confirm` response. */
export interface TotpDeviceConfirmResult {
  id: string;
  name: string;
  enrolledAt: string;
  /** Present ONLY when this was the account's first device. */
  recoveryCodes?: string[];
}

/** `GET /auth/recovery-codes` — counts only, ever. */
export interface RecoveryCodesStatus {
  remaining: number;
  generatedAt?: string;
}

/** `POST /auth/recovery-codes/regenerate` — the fresh set, shown once. */
export interface RecoveryCodesRegenerateResult {
  codes: string[];
  generatedAt: string;
}

/** `GET /auth/sessions` row — `id` is the stored sha256 of the token
 * (never the token itself); `current` marks the caller's own session. */
export interface OwnSessionRow {
  id: string;
  issuedAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** `POST /auth/reauth` success. */
export interface ReauthResult {
  ok: true;
  reauthAt: string;
}

/** admin.ts teams routes' response projection (id/name/serviceSlugs — no PK/SK/version). */
export interface AdminTeam {
  id: string;
  name: string;
  serviceSlugs: string[];
}

/** The hash-chained entry projection `auditQuery.ts#toAuditEntry` serves. */
export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  interimProfile?: boolean;
  prevHash: string;
  hash: string;
}

/** `GET /admin/audit` — newest-first page; `cursor` is present only when more remain. */
export interface AuditPage {
  items: AuditEntry[];
  cursor?: string;
}

/** `domain/audit.ts#verifyChain`'s result: 0 intact · 1 broken · 2 head mismatch. */
export interface AuditChainVerification {
  code: 0 | 1 | 2;
  badUlid?: string;
  message: string;
}

/** `GET /admin/audit/export` — the whole chain as a self-verifying evidence document. */
export interface AuditExport {
  projectId: string;
  head: string;
  count: number;
  verified: boolean;
  verification: AuditChainVerification;
  entries: AuditEntry[];
}

/** `GET /requests/:id/feasibility`'s response — LIVE-recomputed
 * quorum feasibility: always answers "what would approve() need/see RIGHT
 * NOW," unlike the submit-time snapshot fields already carried on
 * ChangeRequest itself (`eligibleApprovers`/`feasible`/`interimProfileWillApply`
 * — see types/request.ts). The approver directory can change after submit;
 * this is how a detail view stays honest about that. */
export interface RequestFeasibility {
  requestId: string;
  status: string;
  approvals: number;
  approvalsRequired: number;
  eligibleApprovers: number;
  feasible: boolean;
  interimProfileWillApply: boolean;
}

export interface TotpResetResult {
  ok: true;
  totpReset: true;
  sessionsRevoked: number;
}

export interface SessionRevokeResult {
  ok: true;
  sessionsRevoked: number;
}

/** `DELETE /admin/accounts/:id` — permanent removal; live sessions die with it. */
export interface AccountDeleteResult {
  ok: true;
  deleted: true;
  sessionsRevoked: number;
}

/** admin.ts's `GET/POST /accounts` PublicAccount projection — credential
 * material never serializes (auth/account.ts's `publicAccount` doctrine).
 * `role`/`teamId` are the scalars RESOLVED for the acting account (back-compat
 * for single-account readers); `roles` is the authoritative per-account map. */
export interface AdminAccount {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  teamId: string;
  /** The per-account role map: `{ [accountId | '*']: { role, teamId? } }`. */
  roles?: Record<string, RoleScopeBinding>;
  status: 'active' | 'disabled';
  isAdmin: boolean;
  mustChangePassword: boolean;
  totpEnrolled: boolean;
  /** Admin-set 2FA override. `undefined` = use the role default;
   * the Users screen renders the effective value and lets an admin pin it. */
  totpRequired?: boolean;
  createdAt: string;
  createdBy: string;
}

export interface CreateAccountInput {
  username: string;
  displayName: string;
  role: Role;
  teamId: string;
  password: string;
}

/**
 * Every account write below is dual-controlled server-side: a
 * TIGHTENING change (e.g. disabling an account, a plain-requester enrol/reset)
 * applies immediately; a LOOSENING one (granting/touching a senior role,
 * re-enabling an account, resetting an approver/lead's password) instead
 * creates a PendingConfigChange a SECOND distinct admin must ack. `applied:false`
 * carries that pending change's id so the caller can say so honestly — never
 * claiming an immediate success that didn't actually happen yet.
 */
export type AdminWriteOutcome = { applied: true } | { applied: false; pendingId: string };

/** `GET /admin/policy`'s response: the approval policy plus its guard version
 * (0 until the first write creates the POLICY item — see api loadPolicy). */
export interface AdminPolicy {
  low: number;
  medium: number;
  high: number;
  deleteMin: number;
  version: number;
}

/**
 * `GET /admin/settings`'s response — the four keys the server reads back
 * (routes/admin.ts). Every value is stored opaquely (`SettingItem.value:
 * unknown`) and a never-written key serializes as absent, so each field is
 * optional and typed unknown; features/admin/settingsFlow.ts decodes them
 * defensively into the app's view shapes.
 */
export interface AdminSettingsWire {
  'freeze.global'?: unknown;
  'catalog.disabled-ops'?: unknown;
  'rate.limits'?: unknown;
  'allowlist.restrictions'?: unknown;
}

/**
 * The PendingConfigChange projection every dual-control surface serves
 * (`publicPendingChange` — `apply` is stripped server-side so stashed
 * credential material can never round-trip into a response). Statuses beyond
 * PENDING appear only on the item a decision endpoint returns; the
 * `GET /admin/config-changes` list is pending-only (the GSI drops decided items).
 */
export interface ServerPendingChange {
  id: string;
  kind: string;
  before: unknown;
  after: unknown;
  targetKey: string;
  proposedBy: string;
  proposedAt: string;
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED';
  expiresAt: string;
  ackBy?: string;
  ackAt?: string;
}

export type CreateAccountOutcome =
  { applied: true; account: AdminAccount } | { applied: false; pendingId: string };

/* ── projects registry + onboarding trust surface (ccp-api /projects) ──── */

/** One prescan finding, exactly as `catalogctl onboard` reports it. */
export interface PrescanFinding {
  code: string;
  file: string;
  line: number;
}

/** The parsed `prescan-report.json` ccp-api stores at upload and serves
 * back — the wizard renders the SERVER's copy, never a client-side re-parse. */
export interface PrescanReportWire {
  repo: string;
  verdict: 'clean' | 'reject';
  findings: PrescanFinding[];
  resourceBlocks: number;
  moduleBlocks: number;
  tfJsonFiles: number;
  fmtDirtyFiles: number;
  providerPins: Record<string, string>;
}

export type ServerProjectStatus = 'draft' | 'pending-trust' | 'trusted' | 'ready';

/**
 * CI-run provenance recorded on a trust-request uploaded through the
 * pre-trust onboarding-token lane (design:
 * docs/superpowers/specs/2026-07-24-easy-first-import.md, option A) —
 * present only when the estate's own CI workflow uploaded the scan
 * artifacts (the wizard's "Run in the repo's CI" tab). Absent on every
 * session-uploaded ("Run locally") row, and on every row written before this
 * field existed. The wizard renders it in step 3 as a link so the two
 * reviewing admins can cross-check it against the repo's own Actions/pipeline
 * log — it is provenance for the human review, never a substitute for it.
 */
export interface CiProvenanceWire {
  host: 'github' | 'gitlab';
  runUrl: string;
}

/**
 * HOST-AGNOSTIC repo reference — the migration target for the GitHub-only
 * `github` pair. `baseUrl` only for a self-hosted forge; `owner` may carry
 * `/`-separated group segments (GitLab subgroups).
 */
export interface RepoRef {
  host: 'github' | 'gitlab';
  /** Self-hosted GitLab server address (absent = github.com / gitlab.com). */
  baseUrl?: string;
  /** Repository owner (GitHub) or group — GitLab groups may nest (`a/b`). */
  owner: string;
  name: string;
}

/**
 * A refusal from the projects surface, carrying the server's raw `code`
 * alongside the reason so the wizard can render one plain sentence naming the
 * fix and who does it (features/admin/projectsFlow.ts `refusalCopy`). Extends
 * Error, so every existing `e.message` reader keeps working unchanged.
 */
export class ApiRefusalError extends Error {
  readonly code: string;
  constructor(code: string, reason: string) {
    super(reason);
    this.name = 'ApiRefusalError';
    this.code = code;
  }
}

/**
 * The registry projection `GET /projects` serves. TWO-TIER (security review):
 * a lead+isAdmin caller receives the rich shape (every field below); any other
 * bound session receives ONLY `{id, name, github?, repo, accountId, region,
 * status, trust?, archived?}` — so `createdBy`/`createdAt`/`trustRequest`/
 * `artifacts`/`dataActive` are optional here, absent on the thin tier. The
 * wizard runs admin-gated, so it always gets the rich shape. The raw uploaded
 * report bytes never serialize on either tier.
 *
 * REPO SHAPES DURING MIGRATION: `repo` is always served (derived for a legacy
 * github-only row); the legacy `github` mirror is present ONLY when the host
 * really is github — a GitLab project has no `github` field. Read repos through
 * {@link projectRepoLabel} or `repo`, never `github` directly.
 */
export interface ServerProjectBase {
  id: string;
  name: string;
  /** Legacy mirror — present only when `repo.host === 'github'`. */
  github?: { owner: string; repo: string };
  /** The canonical host-agnostic repo reference (always served). */
  repo?: RepoRef;
  status: ServerProjectStatus;
  /** Rich tier only (lead+isAdmin) — absent on the any-session summary. */
  createdBy?: string;
  /** Rich tier only (lead+isAdmin) — absent on the any-session summary. */
  createdAt?: string;
  trustRequest?: {
    repo: string;
    commitSha: string;
    prescanSha256: string;
    uploadedBy: string;
    uploadedAt: string;
    report: PrescanReportWire;
    /** Present only when the estate's own CI uploaded this artifact pair
     * (see {@link CiProvenanceWire}) — absent for a session/local upload. */
    ci?: CiProvenanceWire;
  };
  trust?: { trustedBy: string; trustedAt: string; preScanReportSha256: string; commitSha: string };
  /** The go-live digest record — written by the FIRST data activation's ack
   * (server-computed digests of the activated version) or the manual complete
   * lane. `manifestsSha256` present iff the recorded version carried manifests. */
  artifacts?: {
    inventorySha256: string;
    blocksSha256: string;
    manifestsSha256?: string;
    recordedBy: string;
    recordedAt: string;
  };
  /** The ACTIVE served-data version pointer (rich tier; written only by the
   * dual-controlled activate flow). Absent = the api serves nothing for it. */
  dataActive?: { version: number; activatedBy: string; activatedAt: string };
  /** Archived: not routable, not served, refuses uploads. Both tiers. */
  archived?: { archivedBy: string; archivedAt: string };
}

/** An AWS registered project — identity is `accountId` + `region`. `provider` is
 * omitted (the wire convention: an aws row never carries it) or 'aws', so every
 * project registered before the azure seam is byte-identical to this arm. */
export interface ServerProjectAws extends ServerProjectBase {
  provider?: 'aws';
  accountId: string;
  region: string;
}

/** An Azure registered project (0039 S1) — identity is the subscription/tenant
 * GUIDs + location, IN PLACE OF accountId/region. `provider: 'azure'` is the
 * discriminant. */
export interface ServerProjectAzure extends ServerProjectBase {
  provider: 'azure';
  subscriptionId: string;
  tenantId: string;
  location: string;
}

/**
 * The registry projection `GET /projects` serves — PROVIDER-DISCRIMINATED (0039
 * S1): an aws project carries `accountId`/`region` (no `provider` key), an azure
 * project carries `provider:'azure'` + subscription/tenant/location. TWO-TIER
 * (security review): a lead+isAdmin caller receives the rich shape (every field
 * on {@link ServerProjectBase}); any other bound session receives ONLY
 * `{id, name, github?, repo, <identity>, status, trust?, archived?}` — so
 * `createdBy`/`createdAt`/`trustRequest`/`artifacts`/`dataActive` are absent on
 * the thin tier. The wizard runs admin-gated, so it always gets the rich shape.
 * The raw uploaded report bytes never serialize on either tier.
 *
 * REPO SHAPES DURING MIGRATION: `repo` is always served (derived for a legacy
 * github-only row); the legacy `github` mirror is present ONLY when the host
 * really is github — a GitLab project has no `github` field. Read repos through
 * {@link projectRepoLabel} or `repo`, never `github` directly.
 */
export type ServerProject = ServerProjectAws | ServerProjectAzure;

/** The `owner/name` label for a project row, whichever repo shape it carries. */
export function projectRepoLabel(p: Pick<ServerProjectBase, 'github' | 'repo'>): string {
  if (p.repo) return `${p.repo.owner}/${p.repo.name}`;
  if (p.github) return `${p.github.owner}/${p.github.repo}`;
  return '';
}

/** The repo + naming half shared by both provider shapes. Send exactly ONE
 * repo shape — the legacy github pair or the host-agnostic `repo` (the server
 * refuses both-or-neither with 422). */
export interface RegisterProjectBase {
  id: string;
  name: string;
  github?: { owner: string; repo: string };
  repo?: RepoRef;
}

/** AWS register input — `provider` omitted (the wire convention) or 'aws'. */
export interface RegisterProjectAwsInput extends RegisterProjectBase {
  provider?: 'aws';
  accountId: string;
  region: string;
}

/** Azure register input — the subscription/tenant/location identity triple in
 * place of accountId/region (0039 S1). */
export interface RegisterProjectAzureInput extends RegisterProjectBase {
  provider: 'azure';
  subscriptionId: string;
  tenantId: string;
  location: string;
}

/** PROVIDER-DISCRIMINATED register input (0039 S1): an aws body carries
 * accountId/region (and no `provider` key); an azure body carries `provider:
 * 'azure'` + subscriptionId/tenantId/location. The aws shape is byte-identical
 * to every pre-azure caller. */
export type RegisterProjectInput = RegisterProjectAwsInput | RegisterProjectAzureInput;

/* ── the per-account data plane (upload tokens → CI upload → activate → serve) ── */

/** `POST /projects/:id/upload-tokens` — the clear token is shown exactly once. */
export interface UploadTokenMint {
  tokenId: string;
  token: string;
  expiresAt: string;
}

/**
 * `POST /projects/:id/onboard-tokens` — the clear token is shown exactly
 * once, same shape and same one-time-reveal UX as {@link UploadTokenMint},
 * but a SEPARATE credential: legal to mint only while draft/pending-trust
 * (the exact inverse of the upload token's trusted/ready gate), and it
 * authorizes exactly one verb — the Bearer lane on
 * `PUT /projects/:id/trust-request`. Never interchangeable with an upload
 * token; the two never share a key namespace server-side (I10).
 */
export interface OnboardTokenMint {
  tokenId: string;
  token: string;
  expiresAt: string;
}

/** sha256 over the CANONICAL JSON (recursive key-sorted, no whitespace) of each
 * bundle part. `manifestsSha256` present iff the version carried manifests. */
export interface ProjectDataDigestsWire {
  inventorySha256: string;
  blocksSha256: string;
  manifestsSha256?: string;
}

/** One uploaded served-data version's metadata (content stays on the api host). */
export interface ProjectDataVersion {
  version: number;
  status: 'staged' | 'active';
  uploadedAt: string;
  /** `upload-token:<tokenId>` — this lane is CI, never a user. */
  uploadedVia: string;
  /** Digests of the STORED (post server-side redaction) content — what is served. */
  digests: ProjectDataDigestsWire;
  /** Digests the uploader claimed (verified). Differ from `digests` only when
   * server-side redaction masked something the upload had not. */
  uploadDigests: ProjectDataDigestsWire;
  counts: { resources: number; blockAddresses: number; blockChunks: number; manifests: number };
  chunks: string[];
  warnings: string[];
  sourceCommit?: string;
  generatedAt?: string | null;
  providerPins?: Record<string, string>;
}

/** `GET /projects/:id/data` — staged + active versions and the active pointer. */
export interface ProjectDataVersions {
  activeVersion?: number;
  versions: ProjectDataVersion[];
}

/** The artifact pair PUT /projects/:id/trust-request uploads: the parsed
 * trust-request triple plus the RAW prescan-report.json text — the server
 * recomputes sha256 over those exact bytes, so they are never re-serialized
 * client-side. */
export interface TrustRequestUpload {
  trustRequest: { repo: string; commitSha: string; prescanSha256: string };
  prescanReport: string;
}

/**
 * The concrete HTTP client: the {@link ApiClient} surface plus the session
 * lifecycle (login / TOTP / me / logout) the cookie flow needs. The app's mock
 * fulfils identity via `lib/auth`; against a real backend it lives server-side and
 * is driven through these methods.
 */
export interface HttpApiClient extends ApiClient {
  login(username: string, password: string): Promise<LoginResult>;
  completeTotp(code: string): Promise<AuthResult>;
  enrollTotp(code: string): Promise<AuthResult>;
  /**
   * POST /auth/totp/recovery — recovery-code login: another way to satisfy
   * the SAME pending-TOTP pre-session `completeTotp` upgrades, not a new
   * door. Success burns one code and mints a full session
   * (`result.recoveryLogin === true`); failure throws generically (no
   * enumeration) and counts toward the same lockout as a bad password.
   */
  completeTotpRecovery(code: string): Promise<AuthResult>;
  /**
   * POST /auth/change-password — the actor replaces their OWN (temporary)
   * password. The server verifies `currentPassword`, clears
   * `mustChangePassword`, and re-mints the session at a new version (so the old
   * cookie 401s), returning the now-unblocked account. This is the ONLY way a
   * first-login/admin-reset account clears the flag: while it is set, the
   * password gate 403s every non-auth route, so there is no other reachable
   * surface to change it from. `keepOtherSessions` (default false; the
   * standing Account page's card checks it BY DEFAULT true): false
   * invalidates every other session (today's behavior); true keeps them alive.
   */
  changePassword(
    currentPassword: string,
    newPassword: string,
    keepOtherSessions?: boolean,
  ): Promise<AuthResult>;
  me(): Promise<AuthResult | null>;
  logout(): Promise<void>;

  /**
   * The re-authentication gate. Exactly one of `{password}` or `{code}` (a
   * live TOTP code from any enrolled device; a recovery code is NEVER
   * accepted here — break-glass is login-only). Success stamps a fresh
   * elevation on the CURRENT session, valid 10 minutes; every ⚿-marked
   * method below refuses `403 REAUTH_REQUIRED` without a fresh one — the
   * caller catches that with a shared client-side helper and retries.
   */
  reauth(input: { password: string } | { code: string }): Promise<ReauthResult>;

  /**
   * Multi-device TOTP self-service. `listTotpDevices` is a plain read; the
   * other three are ⚿ re-auth-gated. `beginAddTotpDevice` mints a secret
   * held server-side and returns the SAME QR/setup-key shape first-login
   * enrolment uses; `confirmAddTotpDevice` verifies a live code and names
   * the device — the account's FIRST device auto-issues recovery codes,
   * carried once in the result; `removeTotpDevice` refuses `LAST_FACTOR`
   * while `needsTotp` is true for the account.
   */
  listTotpDevices(): Promise<TotpDeviceWire[]>;
  beginAddTotpDevice(): Promise<TotpEnrollmentOffer>;
  confirmAddTotpDevice(code: string, name: string): Promise<TotpDeviceConfirmResult>;
  removeTotpDevice(id: string): Promise<void>;

  /**
   * Recovery codes self-service. `getRecoveryCodesStatus` is a plain read
   * (counts only, ever — never the codes). `regenerateRecoveryCodes` is ⚿
   * re-auth-gated, replaces the WHOLE set, and returns the 10 fresh
   * plaintext codes exactly once; refused `TOTP_REQUIRED` when no device is
   * enrolled (codes exist only while 2FA is active).
   */
  getRecoveryCodesStatus(): Promise<RecoveryCodesStatus>;
  regenerateRecoveryCodes(): Promise<RecoveryCodesRegenerateResult>;

  /**
   * Active sessions self-service. `listOwnSessions` is a plain read.
   * `revokeOwnSession`/`revokeOwnOtherSessions` are ⚿ re-auth-gated;
   * revoking the CURRENT session is sign-out (the cookie then resolves to
   * nothing); revoking "others" never bumps sessionVersion (the keeper
   * survives).
   */
  listOwnSessions(): Promise<OwnSessionRow[]>;
  revokeOwnSession(id: string): Promise<void>;
  revokeOwnOtherSessions(): Promise<{ revoked: number }>;

  /**
   * Cooling-off — no mock equivalent, ever: the mock has
   * no cooling-off state machine to cancel and no eligibility directory to
   * recompute feasibility from (mock-mode keeps lib/quorum.ts's local
   * estimate instead — see lib/requestFeasibility.ts for the api-mode
   * honesty rule). That's why these live only here, not on the base
   * {@link ApiClient} every mock/http client shares.
   */

  /** POST /requests/:id/cancel. Reuses {@link MutationResult}'s exact shape —
   * cancelling is, structurally, exactly the same kind of action as
   * approve/reject: ok:true → the updated (CANCELLED) ChangeRequest; ok:false
   * → a reason plus the raw code (`CANCEL_FORBIDDEN` — neither the
   * requester nor a Lead/admin; `STATE_CONFLICT` — not a cancellable status,
   * which includes an already-elapsed cooling/maintenance window a lazy
   * settle hasn't caught up with yet — widened this beyond just
   * APPROVED_COOLING). */
  cancelRequest(id: string): Promise<MutationResult>;
  /**
   * POST /requests/:id/rewindow — no mock equivalent either, same
   * "no window-enforcement state machine" posture as cancel above. ok:false
   * carries the raw code: `REWINDOW_FORBIDDEN` (neither the requester nor a
   * Lead/admin), `STATE_CONFLICT` (not WINDOW_EXPIRED, and not an
   * AWAITING_DEPLOY_APPROVAL request whose window hasn't opened yet — refuses a
   * request that's currently open, still pre-quorum, or schedule.kind:'now'),
   * `SCHEDULE_INVALID`/`SCHEDULE_TOO_SOON`/`SCHEDULE_TOO_FAR` (the same
   * rules submit enforces), `SCHEDULE_STALE_APPROVAL` (last approval >30d old).
   */
  rewindowRequest(id: string, input: { at: string; endAt?: string }): Promise<MutationResult>;
  /** GET /requests/:id/feasibility — LIVE-recomputed. Undefined
   * for an id ccp-api doesn't recognize (404), matching getRequest(). */
  getRequestFeasibility(id: string): Promise<RequestFeasibility | undefined>;
  /**
   * POST /requests/:id/link-pr — record the fulfilling engineering PR on a
   * request (the NEEDS_ENGINEER loop closer; also serves the Stage-2 PR
   * lane). Lead-only server-side; no mock equivalent — the mock fabricates
   * its own PR numbers at submit and has no engineer authoring loop to link
   * back from, the same "no mock equivalent" posture as cancel/rewindow.
   * ok:false carries the raw code (FORBIDDEN_ROLE / STATE_CONFLICT /
   * VALIDATION_FAILED). prNumber derives server-side from a /pull/{n} tail
   * when omitted.
   */
  linkRequestPr(id: string, input: { prUrl: string; prNumber?: number }): Promise<MutationResult>;

  /** Admin — audit: reads ccp-api's hash-chained log directly. */
  listAuditEntries(opts?: { limit?: number; cursor?: string }): Promise<AuditPage>;
  exportAudit(): Promise<AuditExport>;

  /** Admin — teams CRUD, now authoritative server-side (admin.ts teams routes).
   * Teams are PER ACCOUNT: the list is the acting account's by default, and
   * `opts.projectId` reads another account's list (for the role-assignment
   * panel's team picker, which scopes teams to the chosen account). */
  listAdminTeams(opts?: { projectId?: string }): Promise<AdminTeam[]>;
  createAdminTeam(name: string, serviceSlugs?: string[]): Promise<AdminTeam>;
  renameAdminTeam(id: string, name: string): Promise<AdminTeam>;
  setAdminTeamServices(id: string, serviceSlugs: string[]): Promise<AdminTeam>;
  deleteAdminTeam(id: string): Promise<void>;

  /**
   * Admin — the accounts CRUD surface (B1). List/enrol/
   * role/team/status/password-reset are ALL authoritative server-side now
   * (admin.ts's /accounts routes). The one account-mutating control that stays
   * localStorage-only is the isAdmin grant/revoke toggle — UsersAdmin.tsx keeps
   * that hardcoded-advisory on purpose (not part of this slice).
   */
  listAdminAccounts(): Promise<AdminAccount[]>;
  createAdminAccount(input: CreateAccountInput): Promise<CreateAccountOutcome>;
  /**
   * The per-account role verbs (admin.ts PatchBody — `setRole`/`setTeam`/
   * `revoke`). Each targets ONE registered account (project); the server refuses
   * `'*'` (an all-accounts role is set up at first install, never granted here)
   * and enforces dual-control on a grant/raise to approver or lead (202 →
   * `{applied:false, pendingId}`), the per-account last-lead guard, and
   * never-whole-map writes. `setAccountRoleOn` with a `teamId` sets both at once;
   * without one it keeps the account's existing team on that scope.
   */
  setAccountRoleOn(
    id: string,
    projectId: string,
    role: Role,
    teamId?: string,
  ): Promise<AdminWriteOutcome>;
  setAccountTeamOn(id: string, projectId: string, teamId: string): Promise<AdminWriteOutcome>;
  revokeAccountRoleOn(id: string, projectId: string): Promise<AdminWriteOutcome>;
  /** Single-account back-compat: the same verbs, aimed at the ACTIVE account —
   * kept so a surface that still thinks in one scalar role keeps working. */
  setAccountRole(id: string, role: Role): Promise<AdminWriteOutcome>;
  setAccountTeam(id: string, teamId: string): Promise<AdminWriteOutcome>;
  setAccountStatus(id: string, status: 'active' | 'disabled'): Promise<AdminWriteOutcome>;
  resetAccountPassword(id: string, newPassword: string): Promise<AdminWriteOutcome>;
  /** PATCH /admin/accounts/:id { totpRequired } — pins the 2FA
   * requirement true/false for any account. Applies immediately + is audited
   * server-side (no role floor); goes through the shared account-PATCH branch. */
  setAccountTotpRequired(id: string, required: boolean): Promise<AdminWriteOutcome>;
  /** PATCH /admin/accounts/:id { displayName } — rename. A non-authorization
   * field: the server applies it immediately (audited) and refuses any body
   * that bundles it with a verb or another field (one change per request). */
  renameAccount(id: string, displayName: string): Promise<AdminWriteOutcome>;
  /** DELETE /admin/accounts/:id — PERMANENT (Disable is the reversible option).
   * Server-side fail-closed guards refuse deleting yourself, the last active
   * admin, and the last active lead of any project; live sessions are killed. */
  deleteAccount(id: string): Promise<AccountDeleteResult>;

  /** Admin — targeted account-security actions with no local equivalent at all
   * (TOTP enrolment / live sessions aren't modeled in mock mode). */
  resetAccountTotp(id: string): Promise<TotpResetResult>;
  revokeAccountSessions(id: string): Promise<SessionRevokeResult>;

  /**
   * The instance display identity. `getInstance` has NO mock
   * equivalent (mock mode never resolves it — lib/instanceIdentity.ts stays
   * on the baked brand.ts default there, the standalone-parity invariant),
   * same "no local store" posture as cancelRequest/rewindowRequest above.
   * `setInstance` is ALWAYS immediate (never dual-control — routes/instance.ts
   * server-side), so it returns the server's own echoed identity directly
   * rather than the pending-capable {@link AdminWriteOutcome} every other admin write here
   * uses.
   */
  getInstance(): Promise<{ name: string | null; tagline: string | null }>;
  setInstance(input: {
    name: string;
    tagline: string;
  }): Promise<{ name: string; tagline: string; version: number }>;

  /**
   * Admin — the five estate-governance flows (approval policy, settings incl.
   * the change-freeze and allowlist restrictions, per-op risk overrides,
   * catalog enable/disable, and the dual-control queue itself). All served by
   * ccp-api's routes/admin.ts and dual-controlled: a tightening
   * write applies immediately (200), a loosening one returns 202 with the
   * PendingConfigChange a SECOND distinct admin must ack — surfaced as
   * {@link AdminWriteOutcome} so the UI never claims an un-applied success.
   */
  getAdminPolicy(): Promise<AdminPolicy>;
  putAdminPolicy(policy: {
    low: number;
    medium: number;
    high: number;
    deleteMin: number;
  }): Promise<AdminWriteOutcome>;
  getAdminSettings(): Promise<AdminSettingsWire>;
  putAdminSetting(key: string, value: unknown): Promise<AdminWriteOutcome>;
  /** `GET /admin/risk` — the applied overrides map (`{opId: risk}`). */
  listAdminRiskOverrides(): Promise<Record<string, RiskFloor>>;
  setAdminRiskOverride(opId: string, risk: RiskFloor): Promise<AdminWriteOutcome>;
  clearAdminRiskOverride(opId: string): Promise<AdminWriteOutcome>;
  /** `PUT /admin/catalog/:opId` — disable applies now; re-enable → 202. */
  setAdminCatalogEnabled(opId: string, enabled: boolean): Promise<AdminWriteOutcome>;
  listAdminConfigChanges(): Promise<ServerPendingChange[]>;
  ackAdminConfigChange(id: string): Promise<ServerPendingChange>;
  rejectAdminConfigChange(id: string): Promise<ServerPendingChange>;

  /**
   * Admin — the projects registry + onboarding trust surface (ccp-api
   * /projects). Fail-closed by construction server-side: the status
   * ladder only moves forward, the upload is sha-verified against the CLI's
   * binding, a reject verdict can never be trusted, and trust/deregister are
   * ALWAYS dual-controlled (202 → {@link AdminWriteOutcome} pending) — the UI
   * can never claim an un-acked trust as applied.
   */
  listServerProjects(): Promise<ServerProject[]>;
  registerProject(input: RegisterProjectInput): Promise<ServerProject>;
  uploadProjectTrustRequest(id: string, input: TrustRequestUpload): Promise<ServerProject>;
  /** POST /projects/:id/trust — always 202 (a second admin acks via the
   * dual-control queue), surfaced as `{applied:false, pendingId}`. */
  proposeProjectTrust(
    id: string,
    input: { commitSha: string; prescanSha256: string },
  ): Promise<AdminWriteOutcome>;
  /** DELETE /projects/:id — always 202 (two-admin envelope). */
  deregisterProject(id: string): Promise<AdminWriteOutcome>;

  /**
   * The PRE-TRUST onboarding-token lane — mint/revoke the narrow,
   * short-lived credential the estate's own CI uses to PUT the first scan's
   * artifacts straight to
   * `PUT /projects/:id/trust-request`, no laptop and no paste. Mint is legal
   * only while draft/pending-trust; a trusted/ready/archived project refuses
   * (`STATE_CONFLICT`). A SEPARATE credential from {@link mintUploadToken} —
   * never interchangeable, never shown twice.
   */
  mintOnboardToken(projectId: string, opts?: { ttlMinutes?: number }): Promise<OnboardTokenMint>;
  revokeOnboardToken(projectId: string, tokenId: string): Promise<void>;

  /**
   * The per-account DATA plane (the app-rebuild killer): mint/revoke the CI
   * upload token, list the staged+active versions, activate one (ALWAYS a
   * two-admin envelope → `{applied:false, pendingId}`), and archive/unarchive
   * the account (archive applies immediately — tightening; unarchive is the
   * 2-admin loosening). The CI upload itself (`PUT /projects/:id/data`) is
   * deliberately NOT here: it authenticates with the upload token, not a
   * session, and is driven by the account's pipeline — never this SPA.
   */
  mintUploadToken(projectId: string, opts?: { ttlMinutes?: number }): Promise<UploadTokenMint>;
  revokeUploadToken(projectId: string, tokenId: string): Promise<void>;
  listProjectDataVersions(projectId: string): Promise<ProjectDataVersions>;
  activateProjectData(projectId: string, version: number): Promise<AdminWriteOutcome>;
  archiveProject(id: string): Promise<void>;
  unarchiveProject(id: string): Promise<AdminWriteOutcome>;

  /**
   * The serve-reads behind the runtime catalog (also used internally by
   * `listManifests`/`getInventory` for a non-default account in api mode).
   * Each returns null when the account has no ACTIVE data (404) — the caller
   * falls back to its vendored-or-empty resolution, never another estate's.
   */
  getProjectManifests(id: string): Promise<unknown[] | null>;
  getProjectInventory(id: string): Promise<Inventory | null>;
  getProjectBlocksChunk(id: string, chunk: string): Promise<Record<string, unknown> | null>;
}

/** Bucket a taxonomy code into the narrow {@link SubmitResult} code set. */
function submitCodeFor(code: string): 'FROZEN' | 'OP_DISABLED' | 'OUT_OF_BOUNDS' | 'FORBIDDEN' {
  switch (code) {
    case 'GLOBAL_FREEZE':
      return 'FROZEN';
    case 'OP_DISABLED':
      return 'OP_DISABLED';
    case 'PARAM_OUT_OF_BOUNDS':
      return 'OUT_OF_BOUNDS';
    default:
      return 'FORBIDDEN';
  }
}

/**
 * Build a client bound to `baseUrl` (e.g. '' for same-origin, or an absolute
 * origin in dev). Every request URL is `baseUrl` + a fixed ccp-api path — this
 * client never targets any other host (the standalone invariant asserts it).
 */
export function createHttpApiClient(baseUrl: string, opts?: HttpApiOptions): HttpApiClient {
  const doFetch: typeof fetch = opts?.fetch ?? globalThis.fetch.bind(globalThis);
  const resolveManifests = opts?.getManifests ?? ((): ServiceManifest[] => bundledManifests);
  const resolveInventory =
    opts?.getInventory ?? ((): Inventory => inventoryData as unknown as Inventory);

  async function request(
    path: string,
    init: RequestInit = {},
    opts: { projectId?: string } = {},
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    // CSRF: business/admin mutations must carry the client header (harmless on /auth).
    if (method !== 'GET' && method !== 'HEAD') headers.set(CLIENT_HEADER, CLIENT_VALUE);
    // Acting account: a call that HAS one names the account it acts on, read
    // from the app's active project scope at call time (a per-call override
    // serves the cross-account admin reads). A call with none — login, and
    // anything else before an estate is selected/active — sends NO header at
    // all: asserting a scope nobody chose would be a bogus/leftover one (this
    // used to be a hardcoded sample-estate id sent on every request, login
    // included, which a store with no such estate rightly 422s). The server's own
    // header-less default (the reserved control-plane scope) applies instead.
    const scope = opts.projectId ?? currentProjectId();
    if (scope) headers.set(PROJECT_HEADER, scope);
    if (init.body != null && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json');
    return doFetch(`${baseUrl}${path}`, { ...init, headers, credentials: 'include' });
  }

  async function readError(res: Response): Promise<{ code: string; reason: string }> {
    const body = (await res.json().catch(() => null)) as { code?: string; reason?: string } | null;
    return {
      code: body?.code ?? 'INTERNAL',
      reason: body?.reason ?? 'Something went wrong. Please try again.',
    };
  }

  /** The projects surface throws {@link ApiRefusalError} (code + reason) so
   * the wizard can map each refusal onto one plain fix-sentence. Other
   * surfaces keep throwing plain Error — their callers read `.message` only. */
  async function throwRefusal(res: Response): Promise<never> {
    const { code, reason } = await readError(res);
    throw new ApiRefusalError(code, reason);
  }

  async function items(scope: 'mine' | 'pending' | 'all'): Promise<ChangeRequest[]> {
    const res = await request(`/requests?scope=${scope}`);
    if (!res.ok) throw new Error((await readError(res)).reason);
    return ((await res.json()) as { items: ChangeRequest[] }).items;
  }

  /** Map a dual-controlled write's response onto {@link AdminWriteOutcome}:
   * 202 → proposed (carrying the PendingConfigChange id), any other 2xx →
   * applied, error → the reason thrown. Every write below shares this
   * one branch so no caller can mistake a proposal for an applied change. */
  async function writeOutcome(res: Response): Promise<AdminWriteOutcome> {
    if (res.status === 202) {
      const pending = (await res.json()) as { id: string };
      return { applied: false, pendingId: pending.id };
    }
    if (!res.ok) throw new Error((await readError(res)).reason);
    return { applied: true };
  }

  /** Shared PATCH /admin/accounts/:id — every field (role/team/status) goes
   * through the SAME endpoint and the SAME 200-applied/202-pending branch
   * (admin.ts's single PatchBody handler), so set-role/set-team/set-status
   * share this one helper rather than three near-duplicate request bodies. */
  async function patchAccount(
    id: string,
    body: Record<string, unknown>,
  ): Promise<AdminWriteOutcome> {
    return writeOutcome(
      await request(`/admin/accounts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    );
  }

  const client: HttpApiClient = {
    async serverInfo(): Promise<ServerInfo> {
      // Authoritative backend. Every gated flow is now served: audit (read +
      // export), teams (full CRUD), users (accounts CRUD + TOTP reset/session
      // revoke), policy, risk (overrides + catalog enable/disable), settings
      // (freeze, allowlist restrictions, rate limits), pendingChanges (the
      // dual-control queue), and — since ccp-api grew its /projects
      // registry + trust surface and this client carries each call
      // below — projects too. (per-flow honesty: a flag flips true
      // ONLY for a flow whose write/read reaches the server, never as a
      // blanket "backend is real".)
      return {
        mode: 'api',
        capabilities: {
          ...noCapabilities(),
          audit: true,
          teams: true,
          users: true,
          policy: true,
          risk: true,
          settings: true,
          pendingChanges: true,
          projects: true,
        },
      };
    },

    // THE SERVE-READ (the app-rebuild killer): every REAL account's catalog
    // comes from ccp-api's data plane at runtime — no vendoring, no
    // rebuild; this is now true of the first onboarded estate too, not just
    // the Nth. The SAMPLE keeps its build-time bundle (served only once
    // explicitly loaded — never a runtime default a blank install falls
    // into), and any miss (no active data yet, a network error, malformed
    // data) falls back to the injected resolver — the vendored-or-EMPTY
    // rule, never another estate's.
    async listManifests(): Promise<ServiceManifest[]> {
      const id = currentProjectId();
      if (id === SAMPLE_ESTATE_ID) return resolveManifests();
      try {
        const served = await client.getProjectManifests(id);
        if (served !== null) return parseManifests(served);
      } catch {
        // fall through to the local resolution (fail closed, still usable)
      }
      return resolveManifests();
    },

    async getInventory(): Promise<Inventory> {
      const id = currentProjectId();
      if (id === SAMPLE_ESTATE_ID) return resolveInventory();
      try {
        const served = await client.getProjectInventory(id);
        if (served !== null) return served;
      } catch {
        // fall through to the local resolution (fail closed, still usable)
      }
      return resolveInventory();
    },

    /**
     * `GET /projects/:id/drift` — the active project's latest published
     * drift snapshot, already role-projected server-side. `connected:false`
     * (drift unarmed, or nothing ever published) and any non-2xx/network
     * failure both map to `null` — this seam has no error variant; a
     * caller that can't reach the endpoint renders exactly the same
     * honest "not connected" state as a deployment that never armed it
     * (never partially rendered, never a fabricated "clean").
     *
     * `body.report` carries the out-of-band provisioning spec's additive
     * `sweep` section and `counts.unmanaged` verbatim whenever the server
     * sends them — no field-by-field mapping needed here (the wire body is
     * cast straight to {@link DriftReport}, which is additive-typed for
     * exactly this reason): an older api that predates the sweep simply
     * omits the key, and DriftPanel/the unmanaged-resources section already
     * render that absence as "not swept," never as "swept clean." The same
     * pass-through carries `proposals[]`, which may now include
     * `flavor: 'import'` or `flavor: 'restore'` (drift restore tranche,
     * L29) rows.
     */
    async getDriftStatus(): Promise<DriftStatus | null> {
      try {
        const res = await request(`/projects/${encodeURIComponent(currentProjectId())}/drift`);
        if (!res.ok) return null;
        const body = (await res.json()) as {
          connected?: boolean;
          report?: DriftReport;
          proposals?: DriftProposal[];
        };
        if (!body.connected || !body.report) return null;
        // proposals is approver+ only server-side (absent entirely for a
        // Requester) — carried through exactly as received, never defaulted
        // to an empty array (presence follows duty).
        return {
          report: body.report,
          ...(body.proposals !== undefined ? { proposals: body.proposals } : {}),
        };
      } catch {
        return null;
      }
    },

    /**
     * `POST /projects/:id/drift/proposals/:digest/submit` — the ONLY door
     * into a drift request, for all four flavors (adopt, revert, import,
     * and now restore — no new route: both the out-of-band provisioning
     * spec's import flavor and the drift restore tranche's restore flavor
     * (L29) ride this exact same endpoint, distinguished purely by the
     * digest's own pinned `flavor`). Identity-free body (justification/
     * schedule/alsoDigests only): the server builds params entirely from the
     * pinned proposal, re-derives eligibility from the STORED report, and
     * refuses a stale/already-submitted/non-open proposal (or, for import/
     * restore, a disarmed `CCP_DRIFT_IMPORT`/`CCP_DRIFT_RESTORE`,
     * surfaced through the same `DRIFT_DISARMED` code every other disarmed
     * drift action uses). Same {@link SubmitResult} mapping as
     * {@link submitRequest}.
     */
    async submitDriftProposal(
      digest: string,
      input: { justification: string; schedule: Schedule; alsoDigests?: string[] },
    ): Promise<SubmitResult> {
      const res = await request(
        `/projects/${encodeURIComponent(currentProjectId())}/drift/proposals/${encodeURIComponent(digest)}/submit`,
        {
          method: 'POST',
          body: JSON.stringify({
            justification: input.justification,
            schedule: input.schedule,
            ...(input.alsoDigests && input.alsoDigests.length > 0
              ? { alsoDigests: input.alsoDigests }
              : {}),
          }),
        },
      );
      if (res.status === 201) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason } = await readError(res);
      return { ok: false, code: submitCodeFor(code), reason };
    },

    /**
     * `POST /projects/:id/drift/check` — "Start drift check" (spec
     * addendum A7 / plan B1). 202 acknowledges the trigger; the report
     * itself lands later through the normal ingest PUT. Any other status
     * (disarmed, another check in flight, frozen, wrong role) carries the
     * server's own reason — surfaced RAW (not bucketed through
     * {@link submitCodeFor}, whose FROZEN/OP_DISABLED/OUT_OF_BOUNDS/FORBIDDEN
     * taxonomy is for request submission, not this trigger) so the caller
     * can branch on the exact code, e.g. `DRIFT_DISARMED`, to render a
     * standing disabled-with-reason state.
     */
    async startDriftCheck(projectId: string): Promise<DriftCheckResult> {
      const res = await request(
        `/projects/${encodeURIComponent(projectId)}/drift/check`,
        { method: 'POST' },
        { projectId },
      );
      if (res.status === 202) {
        const body = (await res.json()) as { requested: boolean; at: string };
        return { ok: true, at: body.at };
      }
      const { code, reason } = await readError(res);
      return { ok: false, code, reason };
    },

    /**
     * `POST /projects/:id/drift/generate` — "Fix the drift"'s generation
     * refresh (spec addendum A7 / plan B2). Same 202-acknowledges,
     * raw-code-on-failure shape as {@link startDriftCheck} — re-fetch
     * {@link getDriftStatus} to see the refreshed `proposals[]`.
     */
    async generateDriftProposals(projectId: string): Promise<DriftGenerateResult> {
      const res = await request(
        `/projects/${encodeURIComponent(projectId)}/drift/generate`,
        { method: 'POST' },
        { projectId },
      );
      if (res.status === 202) {
        const body = (await res.json()) as { scheduled: boolean; reportVersion: number };
        return { ok: true, reportVersion: body.reportVersion };
      }
      const { code, reason } = await readError(res);
      return { ok: false, code, reason };
    },

    /**
     * `POST /projects/:id/drift/security/:digest/legitimize` — C2, the
     * legitimize front door (spec addendum A6). `digest` is the row's open
     * revert proposal digest; identity-free body (justification/schedule
     * only, mirroring {@link submitDriftProposal}). 201 creates the normal
     * NEEDS_ENGINEER request; same {@link SubmitResult} mapping as every
     * other submit path.
     */
    async legitimizeDriftSecurity(
      digest: string,
      input: { justification: string; schedule: Schedule },
    ): Promise<SubmitResult> {
      const res = await request(
        `/projects/${encodeURIComponent(currentProjectId())}/drift/security/${encodeURIComponent(digest)}/legitimize`,
        {
          method: 'POST',
          body: JSON.stringify({ justification: input.justification, schedule: input.schedule }),
        },
      );
      if (res.status === 201) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason } = await readError(res);
      return { ok: false, code: submitCodeFor(code), reason };
    },

    // The server derives the collection from the session; the identity arg is
    // ignored (a client can never assert whose requests it sees).
    async listRequests(_user: string): Promise<ChangeRequest[]> {
      return items('mine');
    },

    async listPendingApprovals(_user: User): Promise<ChangeRequest[]> {
      return items('pending');
    },

    async listAllRequests(): Promise<ChangeRequest[]> {
      return items('all');
    },

    async getRequest(id: string): Promise<ChangeRequest | undefined> {
      const res = await request(`/requests/${encodeURIComponent(id)}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as ChangeRequest;
    },

    async submitRequest(draft: ChangeRequest): Promise<SubmitResult> {
      // Identity-free body: the server sets requester/teamId/risk from the session
      // and re-validates params, so we send only the drafted intent.
      const res = await request(`/requests`, {
        method: 'POST',
        body: JSON.stringify({
          operationId: draft.operationId,
          targetAddress: draft.targetAddress,
          params: draft.params,
          justification: draft.justification,
          schedule: draft.schedule ?? { kind: 'now' },
          // Forces-replace confirmed-override: sent only when the requester typed it (the
          // server requires it == targetAddress for a forcesReplace op, ignores it otherwise).
          ...(draft.replaceConfirmation ? { replaceConfirmation: draft.replaceConfirmation } : {}),
        }),
      });
      if (res.status === 201) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason } = await readError(res);
      return { ok: false, code: submitCodeFor(code), reason };
    },

    async submitChangeSet(draft: ChangeSetDraft): Promise<SubmitResult> {
      // Identity-free change-set body: the server sets requester and computes the combined
      // requirement, validating EVERY item atomically (rejecting the whole set on the first
      // failure). The endpoint is the SAME POST /requests — it accepts either the single-op
      // shape or an `items` array; we send the array (with a shared justification + schedule).
      const res = await request(`/requests`, {
        method: 'POST',
        body: JSON.stringify({
          items: draft.items.map((it) => ({
            operationId: it.operationId,
            targetAddress: it.targetAddress,
            params: it.params,
            ...(it.replaceConfirmation ? { replaceConfirmation: it.replaceConfirmation } : {}),
          })),
          justification: draft.justification,
          schedule: draft.schedule ?? { kind: 'now' },
        }),
      });
      if (res.status === 201) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason } = await readError(res);
      return { ok: false, code: submitCodeFor(code), reason };
    },

    async approveRequest(id: string): Promise<MutationResult> {
      const res = await request(`/requests/${encodeURIComponent(id)}/approve`, { method: 'POST' });
      if (res.ok) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason } = await readError(res);
      return { ok: false, reason, code };
    },

    async rejectRequest(id: string, reason?: string): Promise<MutationResult> {
      const res = await request(`/requests/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: JSON.stringify(reason != null ? { reason } : {}),
      });
      if (res.ok) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason: rejectReason } = await readError(res);
      return { ok: false, reason: rejectReason, code };
    },

    async cancelRequest(id: string): Promise<MutationResult> {
      const res = await request(`/requests/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (res.ok) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason } = await readError(res);
      return { ok: false, reason, code };
    },

    async rewindowRequest(
      id: string,
      input: { at: string; endAt?: string },
    ): Promise<MutationResult> {
      const res = await request(`/requests/${encodeURIComponent(id)}/rewindow`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (res.ok) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason } = await readError(res);
      return { ok: false, reason, code };
    },

    async linkRequestPr(
      id: string,
      input: { prUrl: string; prNumber?: number },
    ): Promise<MutationResult> {
      const res = await request(`/requests/${encodeURIComponent(id)}/link-pr`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (res.ok) return { ok: true, request: (await res.json()) as ChangeRequest };
      const { code, reason } = await readError(res);
      return { ok: false, reason, code };
    },

    async getRequestFeasibility(id: string): Promise<RequestFeasibility | undefined> {
      const res = await request(`/requests/${encodeURIComponent(id)}/feasibility`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as RequestFeasibility;
    },

    async login(username: string, password: string): Promise<LoginResult> {
      const res = await request(`/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as LoginResult;
    },

    async completeTotp(code: string): Promise<AuthResult> {
      const res = await request(`/auth/totp`, { method: 'POST', body: JSON.stringify({ code }) });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AuthResult;
    },

    async enrollTotp(code: string): Promise<AuthResult> {
      const res = await request(`/auth/totp/enroll`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AuthResult;
    },

    async completeTotpRecovery(code: string): Promise<AuthResult> {
      const res = await request(`/auth/totp/recovery`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as AuthResult;
    },

    async changePassword(
      currentPassword: string,
      newPassword: string,
      keepOtherSessions?: boolean,
    ): Promise<AuthResult> {
      const res = await request(`/auth/change-password`, {
        method: 'POST',
        body: JSON.stringify({
          currentPassword,
          newPassword,
          ...(keepOtherSessions !== undefined ? { keepOtherSessions } : {}),
        }),
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AuthResult;
    },

    async me(): Promise<AuthResult | null> {
      const res = await request(`/auth/me`);
      if (res.status === 401) return null;
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AuthResult;
    },

    async logout(): Promise<void> {
      await request(`/auth/logout`, { method: 'POST' });
    },

    /* ── the re-authentication gate ────────────────────────────────────────────── */

    async reauth(input: { password: string } | { code: string }): Promise<ReauthResult> {
      const res = await request(`/auth/reauth`, { method: 'POST', body: JSON.stringify(input) });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as ReauthResult;
    },

    /* ── multi-device TOTP self-service ───────────────────────────────────────── */

    async listTotpDevices(): Promise<TotpDeviceWire[]> {
      const res = await request(`/auth/totp-devices`);
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as TotpDeviceWire[];
    },

    async beginAddTotpDevice(): Promise<TotpEnrollmentOffer> {
      const res = await request(`/auth/totp-devices`, { method: 'POST', body: JSON.stringify({}) });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as TotpEnrollmentOffer;
    },

    async confirmAddTotpDevice(code: string, name: string): Promise<TotpDeviceConfirmResult> {
      const res = await request(`/auth/totp-devices/confirm`, {
        method: 'POST',
        body: JSON.stringify({ code, name }),
      });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as TotpDeviceConfirmResult;
    },

    async removeTotpDevice(id: string): Promise<void> {
      const res = await request(`/auth/totp-devices/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) await throwRefusal(res);
    },

    /* ── recovery codes self-service ──────────────────────────────────────────── */

    async getRecoveryCodesStatus(): Promise<RecoveryCodesStatus> {
      const res = await request(`/auth/recovery-codes`);
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as RecoveryCodesStatus;
    },

    async regenerateRecoveryCodes(): Promise<RecoveryCodesRegenerateResult> {
      const res = await request(`/auth/recovery-codes/regenerate`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as RecoveryCodesRegenerateResult;
    },

    /* ── active sessions self-service ─────────────────────────────────────────── */

    async listOwnSessions(): Promise<OwnSessionRow[]> {
      const res = await request(`/auth/sessions`);
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as OwnSessionRow[];
    },

    async revokeOwnSession(id: string): Promise<void> {
      const res = await request(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) await throwRefusal(res);
    },

    async revokeOwnOtherSessions(): Promise<{ revoked: number }> {
      const res = await request(`/auth/sessions/revoke-others`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) await throwRefusal(res);
      const body = (await res.json()) as { ok: true; revoked: number };
      return { revoked: body.revoked };
    },

    /* ── admin: audit (read-only — GET /admin/audit[/export]) ──────────────────── */

    async listAuditEntries(opts: { limit?: number; cursor?: string } = {}): Promise<AuditPage> {
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
      const qs = params.toString();
      const res = await request(`/admin/audit${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AuditPage;
    },

    async exportAudit(): Promise<AuditExport> {
      const res = await request(`/admin/audit/export`);
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AuditExport;
    },

    /* ── admin: teams CRUD ───────────────────────────────────────────────────── */

    async listAdminTeams(opts: { projectId?: string } = {}): Promise<AdminTeam[]> {
      // Teams are per account: an explicit projectId reads the CHOSEN account's
      // list (the assignment panel's team picker); default = the active account.
      const res = await request(`/admin/teams`, {}, { projectId: opts.projectId });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AdminTeam[];
    },

    async createAdminTeam(name: string, serviceSlugs?: string[]): Promise<AdminTeam> {
      const res = await request(`/admin/teams`, {
        method: 'POST',
        body: JSON.stringify(serviceSlugs ? { name, serviceSlugs } : { name }),
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AdminTeam;
    },

    async renameAdminTeam(id: string, name: string): Promise<AdminTeam> {
      const res = await request(`/admin/teams/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AdminTeam;
    },

    async setAdminTeamServices(id: string, serviceSlugs: string[]): Promise<AdminTeam> {
      const res = await request(`/admin/teams/${encodeURIComponent(id)}/services`, {
        method: 'PUT',
        body: JSON.stringify({ serviceSlugs }),
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AdminTeam;
    },

    async deleteAdminTeam(id: string): Promise<void> {
      const res = await request(`/admin/teams/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await readError(res)).reason);
    },

    /* ── admin: accounts CRUD (B1) ───────────────────────────────────────────── */

    async listAdminAccounts(): Promise<AdminAccount[]> {
      const res = await request(`/admin/accounts`);
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AdminAccount[];
    },

    async createAdminAccount(input: CreateAccountInput): Promise<CreateAccountOutcome> {
      const res = await request(`/admin/accounts`, { method: 'POST', body: JSON.stringify(input) });
      if (res.status === 202) {
        const pending = (await res.json()) as { id: string };
        return { applied: false, pendingId: pending.id };
      }
      if (!res.ok) throw new Error((await readError(res)).reason);
      return { applied: true, account: (await res.json()) as AdminAccount };
    },

    /* ── per-account role verbs (multi-account role + scope assignment) ─────── */
    // The server's PATCH body is VERBS, never a whole-map or bare-scalar write
    // (admin.ts PatchBody): each call names the ONE account (project) it touches.

    async setAccountRoleOn(
      id: string,
      projectId: string,
      role: Role,
      teamId?: string,
    ): Promise<AdminWriteOutcome> {
      return patchAccount(id, {
        setRole: { projectId, role, ...(teamId !== undefined ? { teamId } : {}) },
      });
    },

    async setAccountTeamOn(
      id: string,
      projectId: string,
      teamId: string,
    ): Promise<AdminWriteOutcome> {
      return patchAccount(id, { setTeam: { projectId, teamId } });
    },

    async revokeAccountRoleOn(id: string, projectId: string): Promise<AdminWriteOutcome> {
      return patchAccount(id, { revoke: { projectId } });
    },

    // Single-account back-compat: the same verbs aimed at the ACTIVE account.
    // (The server no longer accepts a bare `{role}`/`{teamId}` body at all.)
    async setAccountRole(id: string, role: Role): Promise<AdminWriteOutcome> {
      return client.setAccountRoleOn(id, currentProjectId(), role);
    },

    async setAccountTeam(id: string, teamId: string): Promise<AdminWriteOutcome> {
      return client.setAccountTeamOn(id, currentProjectId(), teamId);
    },

    async setAccountStatus(id: string, status: 'active' | 'disabled'): Promise<AdminWriteOutcome> {
      return patchAccount(id, { status });
    },

    async setAccountTotpRequired(id: string, required: boolean): Promise<AdminWriteOutcome> {
      return patchAccount(id, { totpRequired: required });
    },

    async renameAccount(id: string, displayName: string): Promise<AdminWriteOutcome> {
      return patchAccount(id, { displayName });
    },

    async deleteAccount(id: string): Promise<AccountDeleteResult> {
      const res = await request(`/admin/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AccountDeleteResult;
    },

    async resetAccountPassword(id: string, newPassword: string): Promise<AdminWriteOutcome> {
      return writeOutcome(
        await request(`/admin/accounts/${encodeURIComponent(id)}/reset-password`, {
          method: 'POST',
          body: JSON.stringify({ newPassword }),
        }),
      );
    },

    /* ── admin: targeted account-security actions ───────────────────────────── */

    async resetAccountTotp(id: string): Promise<TotpResetResult> {
      const res = await request(`/admin/accounts/${encodeURIComponent(id)}/reset-totp`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as TotpResetResult;
    },

    async revokeAccountSessions(id: string): Promise<SessionRevokeResult> {
      const res = await request(`/admin/accounts/${encodeURIComponent(id)}/revoke-sessions`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as SessionRevokeResult;
    },

    /* ── instance identity (GET /instance, PUT /admin/instance) ──────────────── */

    async getInstance(): Promise<{ name: string | null; tagline: string | null }> {
      const res = await request('/instance');
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as { name: string | null; tagline: string | null };
    },

    async setInstance(input: {
      name: string;
      tagline: string;
    }): Promise<{ name: string; tagline: string; version: number }> {
      const res = await request('/admin/instance', { method: 'PUT', body: JSON.stringify(input) });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as { name: string; tagline: string; version: number };
    },

    /* ── admin: approval policy (GET/PUT /admin/policy) ──────────────────────── */

    async getAdminPolicy(): Promise<AdminPolicy> {
      const res = await request(`/admin/policy`);
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AdminPolicy;
    },

    async putAdminPolicy(policy: {
      low: number;
      medium: number;
      high: number;
      deleteMin: number;
    }): Promise<AdminWriteOutcome> {
      return writeOutcome(
        await request(`/admin/policy`, { method: 'PUT', body: JSON.stringify(policy) }),
      );
    },

    /* ── admin: settings (GET /admin/settings, PUT /admin/settings/:key) ─────── */

    async getAdminSettings(): Promise<AdminSettingsWire> {
      const res = await request(`/admin/settings`);
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as AdminSettingsWire;
    },

    async putAdminSetting(key: string, value: unknown): Promise<AdminWriteOutcome> {
      return writeOutcome(
        await request(`/admin/settings/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: JSON.stringify({ value }),
        }),
      );
    },

    /* ── admin: risk overrides (GET /admin/risk, PUT/DELETE /admin/risk/:opId) ─ */

    async listAdminRiskOverrides(): Promise<Record<string, RiskFloor>> {
      const res = await request(`/admin/risk`);
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as Record<string, RiskFloor>;
    },

    async setAdminRiskOverride(opId: string, risk: RiskFloor): Promise<AdminWriteOutcome> {
      return writeOutcome(
        await request(`/admin/risk/${encodeURIComponent(opId)}`, {
          method: 'PUT',
          body: JSON.stringify({ risk }),
        }),
      );
    },

    async clearAdminRiskOverride(opId: string): Promise<AdminWriteOutcome> {
      return writeOutcome(
        await request(`/admin/risk/${encodeURIComponent(opId)}`, { method: 'DELETE' }),
      );
    },

    /* ── admin: catalog enable/disable (PUT /admin/catalog/:opId) ────────────── */

    async setAdminCatalogEnabled(opId: string, enabled: boolean): Promise<AdminWriteOutcome> {
      return writeOutcome(
        await request(`/admin/catalog/${encodeURIComponent(opId)}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled }),
        }),
      );
    },

    /* ── admin: the dual-control queue (GET/ack/reject /admin/config-changes) ── */

    async listAdminConfigChanges(): Promise<ServerPendingChange[]> {
      const res = await request(`/admin/config-changes`);
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as ServerPendingChange[];
    },

    async ackAdminConfigChange(id: string): Promise<ServerPendingChange> {
      const res = await request(`/admin/config-changes/${encodeURIComponent(id)}/ack`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as ServerPendingChange;
    },

    async rejectAdminConfigChange(id: string): Promise<ServerPendingChange> {
      const res = await request(`/admin/config-changes/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error((await readError(res)).reason);
      return (await res.json()) as ServerPendingChange;
    },

    /* ── projects registry + onboarding trust surface (/projects) ────────────── */

    async listServerProjects(): Promise<ServerProject[]> {
      const res = await request(`/projects`);
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as ServerProject[];
    },

    async registerProject(input: RegisterProjectInput): Promise<ServerProject> {
      const res = await request(`/projects`, { method: 'POST', body: JSON.stringify(input) });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as ServerProject;
    },

    async uploadProjectTrustRequest(id: string, input: TrustRequestUpload): Promise<ServerProject> {
      const res = await request(`/projects/${encodeURIComponent(id)}/trust-request`, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as ServerProject;
    },

    async proposeProjectTrust(
      id: string,
      input: { commitSha: string; prescanSha256: string },
    ): Promise<AdminWriteOutcome> {
      const res = await request(`/projects/${encodeURIComponent(id)}/trust`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!res.ok) await throwRefusal(res);
      return writeOutcome(res);
    },

    async deregisterProject(id: string): Promise<AdminWriteOutcome> {
      const res = await request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) await throwRefusal(res);
      return writeOutcome(res);
    },

    /* ── the pre-trust onboarding-token lane (mint/revoke only — the token's
     * OWN upload happens from the estate's CI, never from this SPA) ────────── */

    async mintOnboardToken(
      projectId: string,
      opts?: { ttlMinutes?: number },
    ): Promise<OnboardTokenMint> {
      const res = await request(`/projects/${encodeURIComponent(projectId)}/onboard-tokens`, {
        method: 'POST',
        body: JSON.stringify(opts?.ttlMinutes !== undefined ? { ttlMinutes: opts.ttlMinutes } : {}),
      });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as OnboardTokenMint;
    },

    async revokeOnboardToken(projectId: string, tokenId: string): Promise<void> {
      const res = await request(
        `/projects/${encodeURIComponent(projectId)}/onboard-tokens/${encodeURIComponent(tokenId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) await throwRefusal(res);
    },

    /* ── the per-account data plane (upload tokens / versions / activate) ──────
     * The endpoints and shapes are the backend's (routes/projectData.ts);
     * refusals throw {@link ApiRefusalError} so the wizard maps codes onto
     * plain fix-sentences — the message stays the server's reason either way. */

    async mintUploadToken(
      projectId: string,
      opts?: { ttlMinutes?: number },
    ): Promise<UploadTokenMint> {
      const res = await request(`/projects/${encodeURIComponent(projectId)}/upload-tokens`, {
        method: 'POST',
        body: JSON.stringify(opts?.ttlMinutes !== undefined ? { ttlMinutes: opts.ttlMinutes } : {}),
      });
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as UploadTokenMint;
    },

    async revokeUploadToken(projectId: string, tokenId: string): Promise<void> {
      const res = await request(
        `/projects/${encodeURIComponent(projectId)}/upload-tokens/${encodeURIComponent(tokenId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) await throwRefusal(res);
    },

    async listProjectDataVersions(projectId: string): Promise<ProjectDataVersions> {
      const res = await request(`/projects/${encodeURIComponent(projectId)}/data`);
      if (!res.ok) await throwRefusal(res);
      return (await res.json()) as ProjectDataVersions;
    },

    async activateProjectData(projectId: string, version: number): Promise<AdminWriteOutcome> {
      const res = await request(
        `/projects/${encodeURIComponent(projectId)}/data/${encodeURIComponent(String(version))}/activate`,
        { method: 'POST' },
      );
      if (!res.ok) await throwRefusal(res);
      return writeOutcome(res);
    },

    async archiveProject(id: string): Promise<void> {
      const res = await request(`/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' });
      if (!res.ok) await throwRefusal(res);
    },

    async unarchiveProject(id: string): Promise<AdminWriteOutcome> {
      const res = await request(`/projects/${encodeURIComponent(id)}/unarchive`, {
        method: 'POST',
      });
      if (!res.ok) await throwRefusal(res);
      return writeOutcome(res);
    },

    /* ── the serve-reads (active data only; null = nothing served) ───────────── */

    async getProjectManifests(id: string): Promise<unknown[] | null> {
      const res = await request(`/projects/${encodeURIComponent(id)}/manifests`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error((await readError(res)).reason);
      const body = (await res.json()) as unknown;
      return Array.isArray(body) ? body : null;
    },

    async getProjectInventory(id: string): Promise<Inventory | null> {
      const res = await request(`/projects/${encodeURIComponent(id)}/inventory`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error((await readError(res)).reason);
      const body = (await res.json()) as { resources?: unknown };
      // Fail closed on junk: a served inventory must at least carry a resources
      // array — anything else falls back to the caller's local resolution.
      return body !== null && typeof body === 'object' && Array.isArray(body.resources)
        ? (body as unknown as Inventory)
        : null;
    },

    async getProjectBlocksChunk(
      id: string,
      chunk: string,
    ): Promise<Record<string, unknown> | null> {
      const res = await request(
        `/projects/${encodeURIComponent(id)}/blocks/${encodeURIComponent(chunk)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error((await readError(res)).reason);
      const body = (await res.json()) as unknown;
      return body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    },
  };

  return client;
}
