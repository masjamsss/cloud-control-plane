import type {
  AdminWriteOutcome,
  HttpApiClient,
  PrescanFinding,
  PrescanReportWire,
  ProjectDataVersion,
  ProjectDataVersions,
  RegisterProjectInput,
  RepoRef,
  ServerProject,
  ServerProjectStatus,
  TrustRequestUpload,
  UploadTokenMint,
} from '@/lib/httpApi';
import { ApiRefusalError, projectRepoLabel } from '@/lib/httpApi';
import {
  activateLocalProjectData,
  archiveLocalProject,
  deregisterLocalProject,
  listLocalProjectDataVersions,
  listLocalProjects,
  mintLocalUploadToken,
  proposeLocalProjectTrust,
  registerLocalProject,
  revokeLocalUploadToken,
  unarchiveLocalProject,
  uploadLocalTrustRequest,
} from '@/lib/projectOnboarding';
import { projectCalendarAgeDays } from '@/lib/datetime';

/**
 * Pure logic for the Admin → Projects onboarding wizard. React-free so
 * every parse/derive rule is unit-testable without mounting the component (this
 * repo has no jsdom — see test/standalone.test.ts).
 *
 * The artifact parsers accept EXACTLY what `catalogctl onboard` writes — the
 * paste-box's old expected shape (`{verdict, findings}` inside
 * trust-request.json) never matched the real artifact; the real
 * pair is a trust-request TRIPLE plus a separate prescan-report file, and the
 * two are parsed separately here. Both fail soft (null) — user-pasted JSON must
 * never throw into the UI.
 */

/** The REAL trust-request.json schema — the three keys onboard.go writes. */
export interface TrustRequestSummary {
  repo: string;
  commitSha: string;
  prescanSha256: string;
}

export function summarizeTrustRequest(json: unknown): TrustRequestSummary | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const { repo, commitSha, prescanSha256 } = json as Record<string, unknown>;
  if (typeof repo !== 'string' || repo.trim().length === 0) return null;
  if (typeof commitSha !== 'string' || commitSha.trim().length === 0) return null;
  if (typeof prescanSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prescanSha256)) return null;
  return { repo, commitSha, prescanSha256 };
}

/** The census rows the wizard's review step renders alongside the verdict. */
export interface PrescanCensus {
  resourceBlocks: number;
  moduleBlocks: number;
  tfJsonFiles: number;
  fmtDirtyFiles: number;
  providerPins: Record<string, string>;
}

export interface PrescanReportSummary {
  repo: string;
  verdict: 'clean' | 'reject';
  findings: PrescanFinding[];
  census: PrescanCensus;
}

function isFinding(v: unknown): v is PrescanFinding {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const { code, file, line } = v as Record<string, unknown>;
  return typeof code === 'string' && typeof file === 'string' && typeof line === 'number';
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function summarizePrescanReport(json: unknown): PrescanReportSummary | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.repo !== 'string' || o.repo.trim().length === 0) return null;
  if (o.verdict !== 'clean' && o.verdict !== 'reject') return null;
  if (!Array.isArray(o.findings) || !o.findings.every(isFinding)) return null;
  if (![o.resourceBlocks, o.moduleBlocks, o.tfJsonFiles, o.fmtDirtyFiles].every(isCount))
    return null;
  if (!o.providerPins || typeof o.providerPins !== 'object' || Array.isArray(o.providerPins))
    return null;
  const pins: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.providerPins as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    pins[k] = v;
  }
  // The producer's invariant: findings exist iff the verdict is reject. A
  // hand-edited "clean" report with findings must not render a clean badge.
  if ((o.verdict === 'clean') !== (o.findings.length === 0)) return null;
  return {
    repo: o.repo,
    verdict: o.verdict,
    findings: o.findings as PrescanFinding[],
    census: {
      resourceBlocks: o.resourceBlocks as number,
      moduleBlocks: o.moduleBlocks as number,
      tfJsonFiles: o.tfJsonFiles as number,
      fmtDirtyFiles: o.fmtDirtyFiles as number,
      providerPins: pins,
    },
  };
}

/** Shape a server-stored report onto the same summary the local parse yields,
 * so the review step renders one way regardless of where the report came from. */
export function summaryFromWire(report: PrescanReportWire): PrescanReportSummary {
  return {
    repo: report.repo,
    verdict: report.verdict,
    findings: report.findings,
    census: {
      resourceBlocks: report.resourceBlocks,
      moduleBlocks: report.moduleBlocks,
      tfJsonFiles: report.tfJsonFiles,
      fmtDirtyFiles: report.fmtDirtyFiles,
      providerPins: report.providerPins,
    },
  };
}

/** The inverse of {@link summaryFromWire} — flatten a validated summary back
 * onto the wire shape the registry stores (the demo store keeps the same
 * projection the server serves). */
export function wireFromSummary(s: PrescanReportSummary): PrescanReportWire {
  return {
    repo: s.repo,
    verdict: s.verdict,
    findings: s.findings,
    resourceBlocks: s.census.resourceBlocks,
    moduleBlocks: s.census.moduleBlocks,
    tfJsonFiles: s.census.tfJsonFiles,
    fmtDirtyFiles: s.census.fmtDirtyFiles,
    providerPins: s.census.providerPins,
  };
}

/**
 * THE FAIL-CLOSED RENDER RULE (deliberately manual review): the trust control
 * exists only for a present report whose verdict is clean. No report ⇒ no
 * button; reject ⇒ no button, full stop. The server refuses anyway
 * (TRUST_VERDICT_NOT_CLEAN) — this keeps the UI honest about it.
 */
export function trustControlRenders(report: PrescanReportSummary | null | undefined): boolean {
  return report?.verdict === 'clean';
}

/* ── step 1: the host-aware repo field ──────────────────────────────────────── */

/** The three choices the host toggle offers. Self-hosted GitLab is `gitlab`
 * plus a server address on the wire ({@link RepoRef}). */
export type RepoHostChoice = 'github' | 'gitlab' | 'gitlab-self-hosted';

export const REPO_HOST_CHOICES: ReadonlyArray<{ value: RepoHostChoice; label: string }> = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'gitlab-self-hosted', label: 'Self-hosted GitLab' },
];

/** Build the wire {@link RepoRef} from the form's four fields. Fail-soft with
 * a plain reason — the register call itself re-validates either way. */
export function repoRefFromForm(input: {
  host: RepoHostChoice;
  baseUrl: string;
  owner: string;
  name: string;
}): { ok: true; repo: RepoRef } | { ok: false; reason: string } {
  const owner = input.owner.trim();
  const name = input.name.trim();
  if (owner.length === 0) return { ok: false, reason: 'Name the repository owner or group.' };
  if (name.length === 0) return { ok: false, reason: 'Name the repository.' };
  if (input.host === 'github') return { ok: true, repo: { host: 'github', owner, name } };
  if (input.host === 'gitlab') return { ok: true, repo: { host: 'gitlab', owner, name } };
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  let parsed: URL | null = null;
  try {
    parsed = new URL(baseUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'Enter your GitLab server’s full https address, like a browser shows it.',
    };
  }
  return { ok: true, repo: { host: 'gitlab', baseUrl, owner, name } };
}

/** "owner/name" for a registry card — prefers the host-agnostic record and
 * falls back to the legacy github mirror for projects predating it (both are
 * optional on the wire; {@link projectRepoLabel} owns the fallback order). */
export function repoLabel(p: Pick<ServerProject, 'repo' | 'github'>): string {
  return projectRepoLabel(p);
}

/** Plain cloud label for a project — "AWS" or "Azure". Reads `p.provider ??
 * 'aws'` so a legacy aws row (no provider key) reads "AWS" exactly as before. */
export function projectCloudLabel(p: { provider?: 'aws' | 'azure' }): string {
  return (p.provider ?? 'aws') === 'azure' ? 'Azure' : 'AWS';
}

/** The provider-discriminated identity rows a registry card shows: an aws
 * project renders Account + Region; an azure project renders Subscription +
 * Tenant + Location (0039 S1). Narrows on the `provider` discriminant, so every
 * legacy aws project (no provider key) renders exactly the two rows it did
 * before this seam. */
export function projectIdentityRows(
  p: ServerProject,
): ReadonlyArray<{ label: string; value: string; mono?: boolean }> {
  if (p.provider === 'azure') {
    return [
      { label: 'Subscription', value: p.subscriptionId, mono: true },
      { label: 'Tenant', value: p.tenantId, mono: true },
      { label: 'Location', value: p.location },
    ];
  }
  return [
    { label: 'Account', value: p.accountId, mono: true },
    { label: 'Region', value: p.region },
  ];
}

/** Plain words for where the code lives: "GitHub", "GitLab", or the
 * self-hosted server's own hostname (the most recognisable name it has). */
export function repoHostLabel(p: Pick<ServerProject, 'repo'>): string {
  if (!p.repo || p.repo.host === 'github') return 'GitHub';
  if (p.repo.baseUrl === undefined) return 'GitLab';
  try {
    return `GitLab at ${new URL(p.repo.baseUrl).hostname}`;
  } catch {
    return 'GitLab';
  }
}

/* ── step 2: reading the scan artifacts from files ──────────────────────────── */

/** The structural slice of a browser `File` this flow needs — a plain object
 * satisfies it under Node, so the byte-exactness rule is unit-testable. */
export interface ArtifactFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Scan artifacts are small JSON files; anything bigger is the wrong file. */
export const ARTIFACT_FILE_MAX_BYTES = 1_000_000;

/**
 * Read a picked artifact file's EXACT bytes as text — the point of the file
 * picker: the server hashes the report's bytes against the trust request's
 * fingerprint, and a clipboard round-trip (the old paste box) could truncate
 * or re-wrap them. `ignoreBOM:true` keeps a leading BOM byte-faithful and
 * `fatal:true` refuses a file that is not UTF-8 text, instead of silently
 * substituting characters and breaking the fingerprint anyway.
 */
export async function readArtifactFile(
  file: ArtifactFile,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (file.size > ARTIFACT_FILE_MAX_BYTES) {
    return { ok: false, reason: `${file.name} is too big to be a scan artifact — pick the JSON file the scan wrote.` };
  }
  try {
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, reason: `${file.name} is not a text file — pick the JSON file the scan wrote.` };
  }
}

/** The copy-paste command for the local scan (step 2). The scan runs where the
 * checkout and terraform binary live — never on the api host. */
export function onboardCommand(projectId: string): string {
  return `catalogctl onboard <path-to-your-checkout> --project-id ${projectId} --out out/`;
}

/** The post-trust re-run — the CLI's own commit gate. The connected CI job
 * (step 4) runs this for you; kept for a person driving it by hand. */
export function trustedRerunCommand(projectId: string, commitSha: string): string {
  return `catalogctl onboard <path-to-your-checkout> --project-id ${projectId} --trusted-commit ${commitSha} --out out/`;
}

/* ── step 5 + lifecycle: data versions, freshness ───────────────────────────── */

/** The counts half of a data-version line: "128 resources, 96 block sources"
 * — from the server-computed `counts` (blockAddresses = the block sources). */
export function dataCountsLabel(v: Pick<ProjectDataVersion, 'counts'>): string {
  const { resources, blockAddresses } = v.counts;
  const r = `${resources} ${resources === 1 ? 'resource' : 'resources'}`;
  const b = `${blockAddresses} ${blockAddresses === 1 ? 'block source' : 'block sources'}`;
  return `${r}, ${b}`;
}

/**
 * Split the server's `{activeVersion?, versions[]}` into what the wizard
 * renders: the active version, the staged uploads NEWER than it (the step-5
 * activate list), and the EARLIER versions (the history drawer — the server
 * keeps every uploaded row and any of them can be made active again). Each
 * bucket is newest-first.
 */
export function groupDataVersions(v: ProjectDataVersions): {
  active?: ProjectDataVersion;
  staged: ProjectDataVersion[];
  earlier: ProjectDataVersion[];
} {
  const byNewest = [...v.versions].sort((a, b) => b.version - a.version);
  const active = byNewest.find(
    (x) => x.status === 'active' || (v.activeVersion !== undefined && x.version === v.activeVersion),
  );
  const rest = byNewest.filter((x) => x !== active);
  return {
    ...(active ? { active } : {}),
    staged: rest.filter((x) => active === undefined || x.version > active.version),
    earlier: rest.filter((x) => active !== undefined && x.version < active.version),
  };
}

/** Relative-age copy on the estate's calendar — same idiom as the approvals
 * queue and the catalog vintage line ("today" / "1 day old" / "N days old"). */
export function dataAgeLabel(
  iso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const days = projectCalendarAgeDays(iso ?? undefined, now);
  if (days === null) return null;
  return days === 0 ? 'today' : days === 1 ? '1 day old' : `${days} days old`;
}

/** "today" / "1 day ago" / "N days ago" — for the "activated …" phrasing on
 * the registry card's data line. */
export function activatedAgeLabel(
  iso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const days = projectCalendarAgeDays(iso ?? undefined, now);
  if (days === null) return null;
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
}

/** After this many calendar days without newly activated data, the list says so. */
export const STALE_DATA_DAYS = 30;

/** Plain honest staleness line for the registry card, or null while fresh.
 * Fed by `dataActive.activatedAt` — the one data fact the registry row
 * carries; the per-version detail (commit, generation time) lives in step 5. */
export function staleDataNotice(
  activatedAt: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const days = projectCalendarAgeDays(activatedAt ?? undefined, now);
  if (days === null || days < STALE_DATA_DAYS) return null;
  return `No new data activated in ${days} days — check the repo’s CI job for a fresher upload.`;
}

/* ── failure copy ───────────────────────────────────────────────────────────── */

/**
 * One plain sentence per server refusal code, naming the fix and WHO does it
 * (a person on a terminal / your second admin / the repo's CI). Codes come
 * through {@link ApiRefusalError} from the projects surface; anything unmapped
 * falls back to the server's own reason — never a raw code on screen.
 */
export const REFUSAL_COPY: Readonly<Record<string, string>> = {
  DUPLICATE_PROJECT: 'A project with this id already exists — pick a different id.',
  VALIDATION_FAILED: 'The server refused one of the fields — fix the highlighted value and try again.',
  PRESCAN_SHA_MISMATCH:
    'The report does not match the fingerprint in the trust request — a person on a terminal must re-run the scan and upload the fresh pair.',
  TRUST_VERDICT_NOT_CLEAN:
    'The scan rejected this repository, so there is nothing to trust — a person on a terminal must fix the findings, commit, and scan again.',
  STATE_CONFLICT: 'This project has moved on since you loaded the page — reload to see where it is.',
  NOT_FOUND: 'The server does not know this — it may have been removed or renamed; reload the list.',
  FORBIDDEN: 'Your session may not do this — an admin has to.',
  DATA_DIGEST_MISMATCH:
    'The uploaded data does not match its own fingerprints — the repo’s CI must regenerate and upload it again.',
};

/** Render an error from the projects surface as its one plain fix-sentence
 * (mapped by code), or fall back to the message it already carries. */
export function refusalCopy(e: unknown): string {
  if (e instanceof ApiRefusalError && REFUSAL_COPY[e.code] !== undefined) {
    return REFUSAL_COPY[e.code]!;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/**
 * Which wizard step a project is on, from its server status. 1 = add (no
 * project yet) · 2 = scan + upload the two files · 3 = review verdict, then
 * trust (the control renders only via {@link trustControlRenders}) · 4 =
 * connect the repo's CI (step 5, activate, renders alongside once data is
 * staged) · 'done' = ready, lifecycle controls only.
 */
export type WizardStep = 1 | 2 | 3 | 4 | 'done';

export function stepForStatus(status: ServerProjectStatus | undefined): WizardStep {
  switch (status) {
    case 'draft':
      return 2;
    case 'pending-trust':
      return 3;
    case 'trusted':
      return 4;
    case 'ready':
      return 'done';
    default:
      return 1;
  }
}

/** Plain-language status words for the registry cards (raw enum never renders). */
export function statusLabel(status: ServerProjectStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft — awaiting scan';
    case 'pending-trust':
      return 'Scan uploaded — awaiting review';
    case 'trusted':
      return 'Trusted — connect the repo’s CI';
    case 'ready':
      return 'Ready';
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Client-side pre-check of the three CI digests (server re-validates). */
export function digestsValid(d: {
  inventorySha256: string;
  blocksSha256: string;
  manifestsSha256: string;
}): boolean {
  return [d.inventorySha256, d.blocksSha256, d.manifestsSha256].every((s) =>
    SHA256_HEX.test(s.trim()),
  );
}

/* ── ADVISORY → AUTHORITATIVE branch (pattern; see teamsFlow.ts) ─────────────
 *
 * Every wizard write routes to ccp-api's /projects surface when
 * `authoritative` (exactly `can('projects')`), else to lib/projectOnboarding —
 * the demo registry with the same fail-closed ladder — so the wizard is fully
 * walkable in a mock build. The two dual-controlled server writes (trust,
 * deregister — always 202 + a second admin's ack) apply immediately in the
 * local branch, the same collapse every other local admin write makes.
 */

export async function loadServerProjectsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
): Promise<ServerProject[]> {
  if (authoritative && client) return client.listServerProjects();
  return listLocalProjects();
}

export async function registerProjectVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  input: RegisterProjectInput,
): Promise<ServerProject> {
  if (authoritative && client) return client.registerProject(input);
  return registerLocalProject(input);
}

/** Upload the scan pair. The local branch validates the raw report text with
 * the SAME parser the paste boxes use, then hands the store the verbatim
 * bytes (the sha binding is recomputed over exactly those). */
export async function uploadTrustRequestVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  input: TrustRequestUpload,
): Promise<ServerProject> {
  if (authoritative && client) return client.uploadProjectTrustRequest(id, input);
  let reportJson: unknown;
  try {
    reportJson = JSON.parse(input.prescanReport);
  } catch {
    throw new Error('Not a prescan-report.json — paste the whole file the scan wrote.');
  }
  const summary = summarizePrescanReport(reportJson);
  if (!summary) throw new Error('Not a prescan-report.json — paste the whole file the scan wrote.');
  return uploadLocalTrustRequest(id, input.trustRequest, input.prescanReport, wireFromSummary(summary));
}

export async function proposeTrustVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  input: { commitSha: string; prescanSha256: string },
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.proposeProjectTrust(id, input);
  await proposeLocalProjectTrust(id, input);
  return { applied: true };
}

export async function deregisterProjectVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.deregisterProject(id);
  deregisterLocalProject(id);
  return { applied: true };
}

/* ── the CI data lane (mint key → CI uploads staged versions → activate) ───── */

export async function mintUploadTokenVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<UploadTokenMint> {
  if (authoritative && client) return client.mintUploadToken(id);
  return mintLocalUploadToken(id);
}

export async function revokeUploadTokenVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  tokenId: string,
): Promise<void> {
  if (authoritative && client) return client.revokeUploadToken(id, tokenId);
  revokeLocalUploadToken(id, tokenId);
}

export async function listProjectDataVersionsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<ProjectDataVersions> {
  if (authoritative && client) return client.listProjectDataVersions(id);
  return listLocalProjectDataVersions(id);
}

/** Activate one uploaded version. Server-side this is ALWAYS 202 — a second
 * admin acks under Pending changes, and the FIRST activation's ack is the
 * go-live (the project flips ready: selectable, bindable). The local branch
 * makes the same immediate-apply collapse as trust/deregister above. */
export async function activateProjectDataVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  version: number,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.activateProjectData(id, version);
  activateLocalProjectData(id, version);
  return { applied: true };
}

/** Archive is a TIGHTENING change on both backends — it applies immediately
 * (the server returns a plain 200, no envelope), hence always `{applied:true}`. */
export async function archiveProjectVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) {
    await client.archiveProject(id);
    return { applied: true };
  }
  archiveLocalProject(id);
  return { applied: true };
}

export async function unarchiveProjectVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.unarchiveProject(id);
  unarchiveLocalProject(id);
  return { applied: true };
}
