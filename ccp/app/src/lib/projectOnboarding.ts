import type {
  PrescanReportWire,
  ProjectDataVersion,
  ProjectDataVersions,
  RegisterProjectInput,
  RepoRef,
  ServerProject,
  UploadTokenMint,
} from '@/lib/httpApi';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/session';

/**
 * The demo stand-in for ccp-api's /projects registry + onboarding trust
 * ladder — so the Admin → Projects wizard is fully walkable in a mock build
 * against this browser's own registry, with the SAME fail-closed rules the
 * server enforces:
 *
 *   - the status ladder only moves forward (draft → pending-trust → trusted →
 *     ready); re-aiming a trusted/ready project means deregister + re-onboard;
 *   - the uploaded prescan-report bytes must hash (sha-256) to the
 *     trust request's fingerprint — recomputed here at upload AND re-checked
 *     at trust, exactly like the server;
 *   - a reject verdict can never be trusted, full stop.
 *
 * Two deliberate divergences, both the same kind of collapse: (1) trust/
 * deregister/activate apply IMMEDIATELY here, where the server answers 202
 * and waits for a second admin's ack — the same collapse every other local
 * write in this app makes (riskFlow/settingsFlow/policyFlow local branches
 * all return `{applied:true}`); the real two-admin envelope only exists
 * server-side. (2) minting an upload key immediately stages one sample data
 * version — this browser's registry has no repo CI talking to it, so the demo
 * stands in for that job (see the CI data lane section below). The FIRST
 * activation flipping a trusted project ready (go-live, artifacts from the
 * stored digests) is NOT a divergence any more — the server does exactly that
 * on the activation ack (routes/projectData.ts); only the envelope collapses
 * here, per (1). Each write records a local audit entry, the way lib/settings'
 * own writers do.
 *
 * Storage: one GLOBAL key (not project-scoped — this is the registry OF
 * projects), localStorage with the usual in-memory fallback. Validation
 * mirrors routes/projects.ts' shapes; the region check here is structural
 * (a well-formed region code) where the server pins an explicit allowlist.
 */

const STORE_KEY = 'ccp.projects.v1';
const memory = new Map<string, string>();

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return memory.get(STORE_KEY) ?? null;
  }
}
function writeRaw(value: string): void {
  try {
    localStorage.setItem(STORE_KEY, value);
  } catch {
    memory.set(STORE_KEY, value);
  }
}

/** One stored data version — the wire shape minus `status`, which is derived
 * at read time from the project's `dataActive` pointer (exactly how
 * routes/projectData.ts projects its rows). */
type StoredDataVersion = Omit<ProjectDataVersion, 'status'>;

/** The non-secret record of a minted upload key. The server keeps only an
 * argon2id hash of the secret; this demo keeps nothing of it either — the
 * clear token is returned once at mint and never stored readable. */
interface StoredUploadToken {
  tokenId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

/** The stored record: the public projection plus the raw report bytes the
 * trust step re-verifies (the server keeps those bytes too — `rawReport` —
 * and never serves them; listLocalProjects strips them the same way), the
 * upload-token rows, and the CI data-version rows behind the versions list.
 * An INTERSECTION (not `extends`) because {@link ServerProject} is a
 * provider-discriminated union — the extras ride on either arm. */
type StoredExtras = {
  rawReport?: string;
  uploadTokens?: StoredUploadToken[];
  dataVersions?: StoredDataVersion[];
};
type StoredProject = ServerProject & StoredExtras;

function load(): StoredProject[] {
  const raw = readRaw();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredProject[]) : [];
  } catch {
    return [];
  }
}
function save(projects: StoredProject[]): void {
  writeRaw(JSON.stringify(projects));
}

/* ── validation (mirrors routes/projects.ts) ─────────────────────────────────── */

const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
/** One GitLab group/subgroup path segment (groups may nest: `platform/infra`). */
const GITLAB_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const ACCOUNT_ID = /^\d{12}$/;
/** Structural region-code check (e.g. two-letter area, dashed words, digit).
 * The server refuses anything off its explicit allowlist; this demo check
 * refuses malformed strings without duplicating that list into the app. */
const REGION_CODE = /^[a-z]{2}(-[a-z]+)+-\d$/;
/** Git object id: 7–64 lowercase hex (short sha through sha256-repo full sha). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
/** An Azure identifier GUID (subscription id / tenant id): 8-4-4-4-12 hex. */
const AZURE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Structural azure-location check (one lowercase word, e.g. `southeastasia`,
 * `eastus2`). The server pins the explicit AZURE_LOCATION_ALLOWLIST; this demo
 * check refuses malformed strings without duplicating that list into the app —
 * the same structural-vs-allowlist split {@link REGION_CODE} makes for aws. */
const AZURE_LOCATION = /^[a-z]{3,40}[0-9]{0,2}$/;

export class ProjectOnboardingError extends Error {}

function fail(reason: string): never {
  throw new ProjectOnboardingError(reason);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nowIso(): string {
  return new Date().toISOString();
}

function actorId(): string {
  return getCurrentUser().id;
}

/** A stored version row with its `status` derived from the active pointer —
 * the same projection routes/projectData.ts serves. */
function publicVersion(v: StoredDataVersion, activeVersion: number | undefined): ProjectDataVersion {
  return { ...v, status: v.version === activeVersion ? 'active' : 'staged' };
}

/** The public projection — the raw report bytes, the token rows, and the
 * version rows never leave the store (the wire serves versions only through
 * {@link listLocalProjectDataVersions}, exactly like `GET /projects/:id/data`). */
function publicProject(p: StoredProject): ServerProject {
  const { rawReport: _raw, uploadTokens: _tokens, dataVersions: _versions, ...rest } = p;
  return rest;
}

/* ── reads ───────────────────────────────────────────────────────────────────── */

export function listLocalProjects(): ServerProject[] {
  return load().map(publicProject);
}

/* ── the ladder ──────────────────────────────────────────────────────────────── */

/** Shape-check a host-agnostic repo record, mirroring the register endpoint's
 * rules: GitHub owners are single segments; GitLab groups may nest; a
 * self-hosted GitLab must be named by an https address. */
function validateRepoRef(repo: RepoRef): RepoRef {
  const owner = repo.owner.trim();
  const name = repo.name.trim();
  if (repo.host !== 'github' && repo.host !== 'gitlab') fail('Pick where the code lives.');
  if (!GITHUB_REPO.test(name)) fail('That does not look like a repository name.');
  if (repo.host === 'github') {
    if (repo.baseUrl !== undefined) fail('A GitHub repository needs no server address.');
    if (!GITHUB_OWNER.test(owner)) fail('That does not look like a GitHub owner.');
    return { host: 'github', owner, name };
  }
  if (owner.length === 0 || !owner.split('/').every((seg) => GITLAB_SEGMENT.test(seg))) {
    fail('That does not look like a GitLab group (subgroups join with a slash).');
  }
  let baseUrl: string | undefined;
  if (repo.baseUrl !== undefined) {
    const trimmed = repo.baseUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      fail('The GitLab server address must be a full web address, like a browser shows it.');
    }
    if (parsed.protocol !== 'https:') fail('The GitLab server address must start with https.');
    baseUrl = trimmed.replace(/\/+$/, '');
  }
  return { host: 'gitlab', ...(baseUrl !== undefined ? { baseUrl } : {}), owner, name };
}

/** Step 1 — register a draft. A draft grants nothing. Mirrors the register
 * endpoint's rules: send EXACTLY ONE repo shape — the host-agnostic `repo`
 * (canonical) or the legacy `github` pair — and the stored `github` mirror
 * exists only when the host really is github (never a lie for gitlab). The
 * IDENTITY is provider-discriminated, validated the SAME structural way the
 * server pins an allowlist (mirroring routes/projects.ts' superRefine): an aws
 * input needs a 12-digit accountId + a region code; an azure input needs
 * subscription/tenant GUIDs + a location. An aws row omits `provider` (absence
 * = aws, the wire convention), so it stays byte-identical to before this seam. */
export function registerLocalProject(input: RegisterProjectInput): ServerProject {
  const id = input.id.trim();
  const name = input.name.trim();
  if (!PROJECT_ID.test(id)) {
    fail('Project id must be a short lowercase slug (letters, numbers, dashes).');
  }
  if (name.length < 2 || name.length > 100) fail('Display name must be 2–100 characters.');
  if ((input.github !== undefined) === (input.repo !== undefined)) {
    fail('Name the repository exactly one way — the repo record or the legacy GitHub pair.');
  }
  const repo = validateRepoRef(
    input.repo ?? { host: 'github', owner: input.github!.owner, name: input.github!.repo },
  );
  const projects = load();
  if (projects.some((p) => p.id === id)) fail('A project with this id already exists.');
  const common = {
    id,
    name,
    ...(repo.host === 'github' ? { github: { owner: repo.owner, repo: repo.name } } : {}),
    repo,
    status: 'draft' as const,
    createdBy: actorId(),
    createdAt: nowIso(),
  };
  let project: StoredProject;
  if (input.provider === 'azure') {
    const subscriptionId = input.subscriptionId.trim();
    const tenantId = input.tenantId.trim();
    const location = input.location.trim();
    if (!AZURE_GUID.test(subscriptionId)) {
      fail('Azure subscription id must be a GUID (8-4-4-4-12 hex).');
    }
    if (!AZURE_GUID.test(tenantId)) fail('Azure tenant id must be a GUID (8-4-4-4-12 hex).');
    if (!AZURE_LOCATION.test(location)) fail('That does not look like an Azure location.');
    project = { ...common, provider: 'azure', subscriptionId, tenantId, location };
  } else {
    const accountId = input.accountId.trim();
    const region = input.region.trim();
    if (!ACCOUNT_ID.test(accountId)) fail('AWS account id must be exactly twelve digits.');
    if (!REGION_CODE.test(region)) fail('That does not look like an AWS region code.');
    project = { ...common, accountId, region };
  }
  projects.push(project);
  save(projects);
  recordAudit(actorId(), 'Registered project', `${id} (${repo.owner}/${repo.name})`);
  return publicProject(project);
}

/** Step 2 — record the scan artifacts. THE BINDING: the report bytes must
 * hash to the trust request's fingerprint, or the upload is refused. */
export async function uploadLocalTrustRequest(
  id: string,
  trustRequest: { repo: string; commitSha: string; prescanSha256: string },
  rawReport: string,
  report: PrescanReportWire,
): Promise<ServerProject> {
  if (!COMMIT_SHA.test(trustRequest.commitSha)) fail('That does not look like a commit id.');
  if (!SHA256_HEX.test(trustRequest.prescanSha256)) {
    fail('The trust request does not carry a valid report fingerprint.');
  }
  const projects = load();
  const project = projects.find((p) => p.id === id);
  if (!project) fail('No such project.');
  if (project.archived) fail('This project is archived — restore it first.');
  // Only a not-yet-trusted project accepts (re-)uploads — re-aiming a trusted
  // or ready project's binding would invalidate a recorded human decision.
  if (project.status !== 'draft' && project.status !== 'pending-trust') {
    fail('This project is already trusted — deregister it and onboard again to re-scan.');
  }
  const computed = await sha256Hex(rawReport);
  if (computed !== trustRequest.prescanSha256) {
    fail(
      'The report does not match the fingerprint in the trust request — paste both files exactly as the scan wrote them.',
    );
  }
  if (report.repo !== trustRequest.repo) {
    fail('The trust request and the scan report name different repositories.');
  }
  project.status = 'pending-trust';
  project.trustRequest = {
    repo: trustRequest.repo,
    commitSha: trustRequest.commitSha,
    prescanSha256: trustRequest.prescanSha256,
    uploadedBy: actorId(),
    uploadedAt: nowIso(),
    report,
  };
  project.rawReport = rawReport;
  save(projects);
  recordAudit(
    actorId(),
    'Uploaded onboarding scan',
    `${id} @ ${trustRequest.commitSha.slice(0, 12)}`,
  );
  return publicProject(project);
}

/** Step 4 — trust the scanned commit. Fail-closed: pending-trust only, the
 * caller's commit/fingerprint must match the stored binding, the stored bytes
 * must still hash to it, and a reject verdict never gets trusted. */
export async function proposeLocalProjectTrust(
  id: string,
  input: { commitSha: string; prescanSha256: string },
): Promise<ServerProject> {
  const projects = load();
  const project = projects.find((p) => p.id === id);
  if (!project) fail('No such project.');
  if (project.archived) fail('This project is archived — restore it first.');
  const tr = project.trustRequest;
  if (project.status !== 'pending-trust' || !tr) fail('Upload the scan artifacts first.');
  if (input.commitSha !== tr.commitSha || input.prescanSha256 !== tr.prescanSha256) {
    fail('The trust decision does not match the uploaded scan.');
  }
  if (
    project.rawReport === undefined ||
    (await sha256Hex(project.rawReport)) !== tr.prescanSha256
  ) {
    fail('The stored report no longer matches its fingerprint — upload the scan again.');
  }
  if (tr.report.verdict !== 'clean') {
    fail('The scan rejected this repository, so there is nothing to trust.');
  }
  project.status = 'trusted';
  project.trust = {
    trustedBy: actorId(),
    trustedAt: nowIso(),
    preScanReportSha256: tr.prescanSha256,
    commitSha: tr.commitSha,
  };
  save(projects);
  recordAudit(actorId(), 'Trusted repo for onboarding', `${id} @ ${tr.commitSha.slice(0, 12)}`);
  return publicProject(project);
}

/* ── the CI data lane (upload key → staged versions → activate) ──────────────
 *
 * Against a real server, the repo's OWN CI generates the project data and
 * uploads it with a minted key; uploads land STAGED and an admin activates a
 * version (two-admin envelope). This browser's registry has no CI talking to
 * it, so the demo stands in for that job: minting a key immediately stages
 * one sample version derived from the trusted scan — the same kind of
 * deliberate collapse as immediate-apply trust above. The wire shapes are the
 * server's own (routes/projectData.ts): a version row carries the digests the
 * server computed, the counts, and `upload-token:<id>` provenance; the list is
 * `{activeVersion?, versions[]}` with `status` derived from the pointer.
 */

function mustFind(projects: StoredProject[], id: string): StoredProject {
  const project = projects.find((p) => p.id === id);
  if (!project) fail('No such project.');
  return project;
}

function notArchived(project: StoredProject): void {
  if (project.archived) fail('This project is archived — restore it first.');
}

/** Token lifetime — the server's default (24 h; CI mints fresh ones). */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The demo's stand-in for the repo's CI upload: one staged version derived
 * deterministically from the trusted scan's census, in the server's own row
 * shape (digests over the "uploaded" content, counts, provenance). */
async function demoStagedVersion(
  project: StoredProject,
  tokenId: string,
): Promise<StoredDataVersion> {
  const census = project.trustRequest?.report;
  const sourceCommit =
    project.trust?.commitSha ?? project.trustRequest?.commitSha ?? randomHex(20);
  const version = Math.max(0, ...(project.dataVersions ?? []).map((v) => v.version)) + 1;
  const warnings: string[] = [];
  if ((census?.fmtDirtyFiles ?? 0) > 0) {
    warnings.push(`${census?.fmtDirtyFiles} files are not terraform-formatted`);
  }
  if ((census?.moduleBlocks ?? 0) > 0) {
    warnings.push(`${census?.moduleBlocks} module blocks — resources behind modules are not imported`);
  }
  const digest = async (kind: string): Promise<string> =>
    sha256Hex(`${project.id}:${version}:${sourceCommit}:${kind}`);
  const digests = {
    inventorySha256: await digest('inventory'),
    blocksSha256: await digest('blocks'),
    manifestsSha256: await digest('manifests'),
  };
  return {
    version,
    uploadedAt: nowIso(),
    uploadedVia: `upload-token:${tokenId}`,
    // The server stores what it computed over the (redacted) content next to
    // what the uploader claimed; the demo's sample never diverges.
    digests,
    uploadDigests: { ...digests },
    counts: {
      resources: census?.resourceBlocks ?? 0,
      blockAddresses: Math.max(0, (census?.resourceBlocks ?? 0) - (census?.moduleBlocks ?? 0)),
      blockChunks: 1,
      manifests: 1,
    },
    chunks: ['main'],
    warnings,
    sourceCommit,
    generatedAt: nowIso(),
    ...(census?.providerPins ? { providerPins: census.providerPins } : {}),
  };
}

/** Mint a CI upload key — returned ONCE, never stored readable. Like the
 * server, minting adds a key (it does not silently kill earlier ones);
 * rotation is mint-new + revoke-old, and every key expires on its own. */
export async function mintLocalUploadToken(id: string): Promise<UploadTokenMint> {
  const projects = load();
  const project = mustFind(projects, id);
  notArchived(project);
  if (project.status !== 'trusted' && project.status !== 'ready') {
    fail('Trust the scanned commit before connecting the repo’s CI.');
  }
  const tokenId = randomHex(8);
  const token = `${tokenId}.${randomHex(24)}`;
  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
  project.uploadTokens = [
    ...(project.uploadTokens ?? []),
    { tokenId, createdBy: actorId(), createdAt: nowIso(), expiresAt },
  ];
  // The demo's CI stand-in: stage one version if nothing is staged yet.
  const activeVersion = project.dataActive?.version;
  const hasStaged = (project.dataVersions ?? []).some((v) => v.version !== activeVersion);
  if (!hasStaged) {
    project.dataVersions = [
      ...(project.dataVersions ?? []),
      await demoStagedVersion(project, tokenId),
    ];
  }
  save(projects);
  recordAudit(actorId(), 'Minted a data upload key', `${id} (key ${tokenId})`);
  return { tokenId, token, expiresAt };
}

/** Revoke a CI upload key by its id — a tightening change, applies immediately. */
export function revokeLocalUploadToken(id: string, tokenId: string): void {
  const projects = load();
  const project = mustFind(projects, id);
  const rows = project.uploadTokens ?? [];
  if (!rows.some((t) => t.tokenId === tokenId)) {
    fail('No such upload key on this project — it may already be revoked.');
  }
  project.uploadTokens = rows.filter((t) => t.tokenId !== tokenId);
  save(projects);
  recordAudit(actorId(), 'Revoked a data upload key', `${id} (key ${tokenId})`);
}

/** `GET /projects/:id/data`, locally: the active pointer + every uploaded
 * version row, each with `status` derived from that pointer. */
export function listLocalProjectDataVersions(id: string): ProjectDataVersions {
  const project = mustFind(load(), id);
  const activeVersion = project.dataActive?.version;
  return {
    ...(activeVersion !== undefined ? { activeVersion } : {}),
    versions: (project.dataVersions ?? []).map((v) => publicVersion(v, activeVersion)),
  };
}

/** Activate one uploaded version (a staged one, or an earlier one from the
 * history drawer). Moves the `dataActive` pointer the way the server's ack
 * does; the digests recorded are the SERVER's own computation over the
 * uploaded bytes — no human ever types one. The FIRST activation is the
 * go-live, exactly like the server's ack: the project flips ready (selectable)
 * and its artifacts record derives from the stored digests, `manifestsSha256`
 * present iff the version carried manifests. A re-activation only swaps the
 * pointer — the go-live record stays. (What collapses locally is only the
 * two-admin envelope; see the module doc.) */
export function activateLocalProjectData(id: string, version: number): ServerProject {
  const projects = load();
  const project = mustFind(projects, id);
  notArchived(project);
  if (project.status !== 'trusted' && project.status !== 'ready') {
    fail('Trust the scanned commit before activating data.');
  }
  if (project.dataActive?.version === version) {
    fail('This version is already the active one.');
  }
  const target = (project.dataVersions ?? []).find((v) => v.version === version);
  if (!target) fail('No such data version on this project — reload the list.');
  project.dataActive = { version, activatedBy: actorId(), activatedAt: nowIso() };
  if (project.status !== 'ready') {
    project.status = 'ready';
    project.artifacts = {
      inventorySha256: target.digests.inventorySha256,
      blocksSha256: target.digests.blocksSha256,
      ...(target.digests.manifestsSha256 !== undefined
        ? { manifestsSha256: target.digests.manifestsSha256 }
        : {}),
      recordedBy: actorId(),
      recordedAt: nowIso(),
    };
  }
  save(projects);
  recordAudit(
    actorId(),
    'Activated project data',
    `${id} v${version} @ ${(target.sourceCommit ?? 'unknown').slice(0, 12)}`,
  );
  return publicProject(project);
}

/** Retire a project from the switcher (no requests can target it). The
 * status ladder is untouched — restore puts it back exactly where it was. */
export function archiveLocalProject(id: string): ServerProject {
  const projects = load();
  const project = mustFind(projects, id);
  if (project.archived) fail('This project is already archived.');
  project.archived = { archivedBy: actorId(), archivedAt: nowIso() };
  save(projects);
  recordAudit(actorId(), 'Archived project', id);
  return publicProject(project);
}

export function unarchiveLocalProject(id: string): ServerProject {
  const projects = load();
  const project = mustFind(projects, id);
  if (!project.archived) fail('This project is not archived.');
  delete project.archived;
  save(projects);
  recordAudit(actorId(), 'Restored project from archive', id);
  return publicProject(project);
}

/** Remove a project from the registry (any status). */
export function deregisterLocalProject(id: string): void {
  const projects = load();
  const project = projects.find((p) => p.id === id);
  if (!project) fail('No such project.');
  save(projects.filter((p) => p.id !== id));
  recordAudit(actorId(), 'Removed project', id);
}

/** Test-only reset. */
export function resetLocalProjectsForTests(): void {
  writeRaw('[]');
}
