import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, FormEvent, JSX } from 'react';
import type { ProjectConfig } from '@/types/project';
import { listProjects } from '@/lib/projectRegistry';
import { authClient } from '@/lib/api';
import type {
  OnboardTokenMint,
  ProjectDataVersion,
  ProjectDataVersions,
  ServerProject,
  UploadTokenMint,
} from '@/lib/httpApi';
import { formatProjectTime } from '@/lib/datetime';
import { getInstanceIdentity } from '@/lib/instanceIdentity';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { GateFieldset, SERVER_MODE, useServerInfo } from '@/components/AdvisoryGate';
import {
  activatedAgeLabel,
  activateProjectDataVia,
  archiveProjectVia,
  ciProvenanceLabel,
  dataCountsLabel,
  deregisterProjectVia,
  groupDataVersions,
  listProjectDataVersionsVia,
  loadServerProjectsVia,
  mintOnboardTokenVia,
  mintUploadTokenVia,
  onboardCommand,
  onboardDispatchUrl,
  projectCloudLabel,
  projectIdentityRows,
  proposeTrustVia,
  readArtifactFile,
  refusalCopy,
  registerProjectVia,
  REPO_HOST_CHOICES,
  repoHostLabel,
  repoLabel,
  repoRefFromForm,
  revokeOnboardTokenVia,
  revokeUploadTokenVia,
  staleDataNotice,
  statusLabel,
  summarizeTrustRequest,
  summarizePrescanReport,
  summaryFromWire,
  trustControlRenders,
  unarchiveProjectVia,
  uploadedByLabel,
  uploadTrustRequestVia,
  type PrescanReportSummary,
  type RepoHostChoice,
} from './projectsFlow';
import {
  GITHUB_CI_PATH,
  GITHUB_ONBOARD_CI_PATH,
  GITLAB_CI_PATH,
  GITLAB_ONBOARD_CI_PATH,
  githubDataWorkflow,
  githubOnboardWorkflow,
  gitlabDataPipeline,
  gitlabOnboardPipeline,
  ONBOARD_KEY_SECRET,
  PROJECT_ID_VAR,
  UPLOAD_KEY_SECRET,
  SERVER_URL_VAR,
} from './ciTemplates';
import './projects-admin.css';

/**
 * Admin → Projects: the guided onboarding wizard — a button-and-file-picker
 * path, not a paste-JSON chore. Five steps, driven by the server-side status
 * ladder:
 *
 *   1  Add the project           → POST /projects (draft); the repo field is
 *                                  host-aware (GitHub / GitLab / self-hosted)
 *   2  Scan the repo locally     → copy-paste `catalogctl onboard`, then PICK
 *                                  the two files it wrote (paste stays as a
 *                                  fallback) — the picker reads exact bytes,
 *                                  so a truncated paste can't break the
 *                                  fingerprint check
 *   3  Review & trust            → verdict + findings + census from the
 *                                  SERVER's stored report; the trust decision
 *                                  still needs a second admin (Pending
 *                                  changes) — never one keystroke
 *   4  Connect the repo's CI     → commit a ready-made CI file (GitHub or
 *                                  GitLab tab) and mint an upload key for it;
 *                                  from then on the repo's own CI regenerates
 *                                  and uploads the project data
 *   5  Review & activate data    → CI uploads land STAGED with server-verified
 *                                  digests (no human ever types one); one
 *                                  Activate button, through the same two-admin
 *                                  envelope — the control plane then serves
 *                                  that data for the project, no rebuild. The
 *                                  FIRST activation is the go-live: its ack
 *                                  also flips the project ready (selectable,
 *                                  bindable), so the wizard has no dead end
 *
 * The scan stays a local CLI run on purpose: it needs the repo checkout and a
 * terraform binary, and it refuses to run with cloud credentials in the
 * environment. The server never checks out repos and never runs terraform — it
 * verifies and records. Reading the findings stays deliberately manual: no
 * report on file means no trust control, and a reject verdict means no trust
 * control, full stop.
 *
 * Mode honesty: a mock build walks the SAME five steps against
 * lib/projectOnboarding — this browser's demo registry, with the same
 * fail-closed ladder and sha binding — so nothing here is dead without a
 * server. An api build keeps the arming rule (dark until ccp-api serves
 * the projects flow), and its trust/activate/deregister keep the real
 * two-admin envelope.
 */

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

/** Which source filled an artifact slot — the status line names the file. */
type ArtifactSource = { kind: 'file'; name: string } | { kind: 'paste' } | null;

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      className="projadmin__copy"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => {
            /* clipboard unavailable — the command is selectable text */
          });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function CommandBlock({ command, copyLabel }: { command: string; copyLabel: string }): JSX.Element {
  return (
    <div className="projadmin__command">
      <code className="projadmin__command-text">{command}</code>
      <CopyButton text={command} label={copyLabel} />
    </div>
  );
}

function StepHeading({
  n,
  title,
  state,
}: {
  n: number;
  title: string;
  state?: 'done' | 'active';
}): JSX.Element {
  return (
    <span className="projadmin__step-head">
      <span
        className={`projadmin__step-no${state === 'done' ? ' projadmin__step-no--done' : ''}`}
        aria-hidden="true"
      >
        {state === 'done' ? '✓' : n}
      </span>
      <span>{title}</span>
      {state === 'done' && <Badge color="ok">Done</Badge>}
    </span>
  );
}

/** Verdict + findings + census — one render whether the report came from a
 * local file/paste or from the server's stored copy. */
function ReportView({ report }: { report: PrescanReportSummary }): JSX.Element {
  const pins = Object.entries(report.census.providerPins);
  return (
    <div className="projadmin__report">
      <p className="projadmin__verdict-line">
        <span>Scan verdict for </span>
        <code>{report.repo}</code>
        <Badge color={report.verdict === 'clean' ? 'ok' : 'crit'}>
          {report.verdict === 'clean' ? 'Clean' : 'Rejected'}
        </Badge>
      </p>

      {report.findings.length > 0 && (
        <div className="projadmin__table-wrap">
          <table className="projadmin__findings">
            <caption className="projadmin__findings-caption">
              {report.findings.length} finding{report.findings.length > 1 ? 's' : ''} — each one
              names a construct the scan refuses to import
            </caption>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">File</th>
                <th scope="col">Line</th>
              </tr>
            </thead>
            <tbody>
              {report.findings.map((f, i) => (
                <tr key={`${f.file}-${f.line}-${i}`}>
                  <td>
                    <code>{f.code}</code>
                  </td>
                  <td>
                    <code>{f.file}</code>
                  </td>
                  <td>{f.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="projadmin__census">
        <div className="projadmin__meta-row">
          <dt>Resource blocks</dt>
          <dd>{report.census.resourceBlocks}</dd>
        </div>
        <div className="projadmin__meta-row">
          <dt>Modules</dt>
          <dd>
            {report.census.moduleBlocks}
            {report.census.moduleBlocks > 0 ? ' — resources behind modules are not imported' : ''}
          </dd>
        </div>
        <div className="projadmin__meta-row">
          <dt>JSON-syntax files</dt>
          <dd>{report.census.tfJsonFiles}</dd>
        </div>
        <div className="projadmin__meta-row">
          <dt>Unformatted files</dt>
          <dd>
            {report.census.fmtDirtyFiles}
            {report.census.fmtDirtyFiles > 0
              ? ' — fix with a one-time terraform fmt pull request'
              : ''}
          </dd>
        </div>
        {pins.length > 0 && (
          <div className="projadmin__meta-row">
            <dt>Provider pins</dt>
            <dd>
              {pins.map(([name, pin]) => (
                <code key={name} className="projadmin__pin">
                  {name} {pin}
                </code>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** One uploaded data version: what it is, from where, how big, verified. */
function DataVersionCard({
  version,
  tone,
  action,
}: {
  version: ProjectDataVersion;
  tone: 'staged' | 'active' | 'prior';
  action?: JSX.Element;
}): JSX.Element {
  // The server may mask values at storage time; when it did, the stored
  // digests differ from what the upload claimed — worth one honest line.
  const redacted =
    version.digests.inventorySha256 !== version.uploadDigests.inventorySha256 ||
    version.digests.blocksSha256 !== version.uploadDigests.blocksSha256;
  return (
    <div className={`projadmin__version projadmin__version--${tone}`}>
      <p className="projadmin__version-line">
        <span>
          Upload #{version.version}
          {version.sourceCommit ? (
            <>
              {' '}
              from commit <code>{version.sourceCommit.slice(0, 8)}</code>
            </>
          ) : null}
          , received {formatProjectTime(version.uploadedAt)} — {dataCountsLabel(version)}
        </span>
        {tone === 'active' && <Badge color="ok">Active</Badge>}
        {tone === 'staged' && <Badge color="brass">Staged</Badge>}
      </p>
      {version.warnings.length > 0 && (
        <ul className="projadmin__version-warnings">
          {version.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <p className="projadmin__hint">
        Digests computed and checked by the server over the uploaded files — nothing to type.
        {redacted ? ' The server masked some values at storage time (secret redaction).' : ''}
      </p>
      {action}
    </div>
  );
}

export function ProjectsAdmin(): JSX.Element {
  const { can } = useServerInfo();
  const authoritative = can('projects');
  // Mode honesty: the demo registry (lib/projectOnboarding) genuinely walks
  // the whole ladder locally, so the wizard stays LIVE in a mock build.
  const demo = SERVER_MODE === 'mock';
  // Where wizard writes can land: the server (authoritative) or the demo
  // registry. In an api build still resolving/unserved, neither — the safe default.
  const writable = authoritative || demo;

  const [buildProjects, setBuildProjects] = useState<ProjectConfig[]>([]);
  const [registry, setRegistry] = useState<ServerProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Step 1 — add form (host-aware repo field + provider-discriminated identity)
  const [form, setForm] = useState({
    id: '',
    name: '',
    host: 'github' as RepoHostChoice,
    baseUrl: '',
    owner: '',
    repoName: '',
    // Which cloud — absence would mean aws, but the form is explicit so the
    // identity fields below can switch (aws: accountId/region · azure:
    // subscription/tenant/location). Default 'aws' keeps the aws path unchanged.
    provider: 'aws' as 'aws' | 'azure',
    accountId: '',
    region: '',
    subscriptionId: '',
    tenantId: '',
    location: '',
  });
  // Step 2 — which method tab is showing, the two scan artifacts (filled by
  // the file picker, or pasted, for the "Run locally" tab), and the one-time
  // onboarding-token reveal (the "Run in the repo's CI" tab)
  const [scanMethod, setScanMethod] = useState<'ci' | 'local'>('ci');
  const [trustReqText, setTrustReqText] = useState('');
  const [reportText, setReportText] = useState('');
  const [trustReqSource, setTrustReqSource] = useState<ArtifactSource>(null);
  const [reportSource, setReportSource] = useState<ArtifactSource>(null);
  const [mintedOnboard, setMintedOnboard] = useState<OnboardTokenMint | null>(null);
  // Step 2 CI tab + step 4 — CI host tab (shared: one repo, one host) + the
  // one-time upload-key reveal
  const [ciTab, setCiTab] = useState<'github' | 'gitlab'>('github');
  const [minted, setMinted] = useState<UploadTokenMint | null>(null);
  // Step 5 + lifecycle — the selected project's uploaded data versions
  const [versions, setVersions] = useState<ProjectDataVersions | null>(null);

  useEffect(() => {
    let alive = true;
    void listProjects().then((list) => {
      if (alive) setBuildProjects(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!authoritative && !demo) return undefined;
    let alive = true;
    void loadServerProjectsVia(authoritative, authClient)
      .then((list) => {
        if (alive) setRegistry(list);
      })
      .catch(() => {
        /* the registry list stays empty; writes surface their own errors */
      });
    return () => {
      alive = false;
    };
    // `demo` is a static build fact — only `authoritative` can flip after mount.
  }, [authoritative, demo]);

  const selected = registry.find((p) => p.id === selectedId) ?? null;
  const selectedStatus = selected?.status;
  const dataStepLive =
    selected != null &&
    !selected.archived &&
    (selectedStatus === 'trusted' || selectedStatus === 'ready');

  // The selected project's data versions (step 5 + the history drawer).
  useEffect(() => {
    if (!dataStepLive || !selectedId || !writable) {
      setVersions(null);
      return undefined;
    }
    let alive = true;
    void listProjectDataVersionsVia(authoritative, authClient, selectedId)
      .then((v) => {
        if (alive) setVersions(v);
      })
      .catch(() => {
        /* the panel renders its empty state; writes surface their own errors */
      });
    return () => {
      alive = false;
    };
  }, [dataStepLive, selectedId, authoritative, writable]);

  // A newly selected project starts on its own repo's tab, with any previous
  // one-time key/token reveal gone (each belongs to the project it was
  // minted for).
  useEffect(() => {
    setMinted(null);
    setMintedOnboard(null);
    setCiTab(selected?.repo?.host === 'gitlab' ? 'gitlab' : 'github');
    // Only the identity matters — repo host is fixed at registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const parsedTrustReq = useMemo(() => {
    if (trustReqText.trim().length === 0) return null;
    try {
      return summarizeTrustRequest(JSON.parse(trustReqText));
    } catch {
      return null;
    }
  }, [trustReqText]);

  const parsedReport = useMemo(() => {
    if (reportText.trim().length === 0) return null;
    try {
      return summarizePrescanReport(JSON.parse(reportText));
    } catch {
      return null;
    }
  }, [reportText]);

  async function refresh(selectId?: string): Promise<void> {
    const list = await loadServerProjectsVia(authoritative, authClient);
    setRegistry(list);
    if (selectId) setSelectedId(selectId);
  }

  async function refreshVersions(id: string): Promise<void> {
    setVersions(await listProjectDataVersionsVia(authoritative, authClient, id));
  }

  function run(action: () => Promise<Notice>): void {
    setNotice(null);
    void action()
      .then(setNotice)
      .catch((e: unknown) => setNotice({ kind: 'error', text: refusalCopy(e) }));
  }

  function onRegister(e: FormEvent): void {
    e.preventDefault();
    run(async () => {
      const repo = repoRefFromForm({
        host: form.host,
        baseUrl: form.baseUrl,
        owner: form.owner,
        name: form.repoName,
      });
      if (!repo.ok) throw new Error(repo.reason);
      // EXACTLY ONE repo shape — the server refuses a body carrying both the
      // host-agnostic record and the legacy github pair (it derives the
      // mirror itself when the host is github). The IDENTITY half is
      // provider-discriminated: an azure subscription sends its subscription/
      // tenant/location triple, an aws account sends accountId/region.
      const base = { id: form.id.trim(), name: form.name.trim(), repo: repo.repo };
      const created = await registerProjectVia(
        authoritative,
        authClient,
        form.provider === 'azure'
          ? {
              ...base,
              provider: 'azure',
              subscriptionId: form.subscriptionId.trim(),
              tenantId: form.tenantId.trim(),
              location: form.location.trim(),
            }
          : { ...base, accountId: form.accountId.trim(), region: form.region.trim() },
      );
      await refresh(created.id);
      setForm({
        id: '',
        name: '',
        host: 'github',
        baseUrl: '',
        owner: '',
        repoName: '',
        provider: 'aws',
        accountId: '',
        region: '',
        subscriptionId: '',
        tenantId: '',
        location: '',
      });
      return {
        kind: 'ok',
        text: `Registered ${created.id} as a draft — next, scan the repo (step 2).`,
      };
    });
  }

  function onPickArtifact(which: 'trust' | 'report') {
    return (e: ChangeEvent<HTMLInputElement>): void => {
      const file = e.target.files?.[0];
      if (!file) return;
      void readArtifactFile(file).then((read) => {
        if (!read.ok) {
          setNotice({ kind: 'error', text: read.reason });
          return;
        }
        setNotice(null);
        if (which === 'trust') {
          setTrustReqText(read.text);
          setTrustReqSource({ kind: 'file', name: file.name });
        } else {
          setReportText(read.text);
          setReportSource({ kind: 'file', name: file.name });
        }
      });
    };
  }

  function onUpload(): void {
    run(async () => {
      if (!selected) throw new Error('Select a registered project first.');
      if (!parsedTrustReq) throw new Error('Pick a valid trust-request.json first.');
      // The report text is sent VERBATIM — both backends hash those exact
      // bytes against the trust request's binding, so it is never re-serialized here.
      const updated = await uploadTrustRequestVia(authoritative, authClient, selected.id, {
        trustRequest: parsedTrustReq,
        prescanReport: reportText,
      });
      await refresh(updated.id);
      setTrustReqText('');
      setReportText('');
      setTrustReqSource(null);
      setReportSource(null);
      return {
        kind: 'ok',
        text: 'Scan files uploaded and verified — review the verdict below (step 3).',
      };
    });
  }

  function onMintOnboardToken(): void {
    run(async () => {
      if (!selected) throw new Error('Select a registered project first.');
      const mint = await mintOnboardTokenVia(authoritative, authClient, selected.id);
      setMintedOnboard(mint);
      await refresh(selected.id);
      return {
        kind: 'ok',
        text: `Onboarding token minted — paste it into the repo’s CI secret ${ONBOARD_KEY_SECRET} now; it is not shown again.`,
      };
    });
  }

  function onRevokeOnboardToken(): void {
    run(async () => {
      // The server never lists tokens back (only their argon2id hashes exist
      // server-side), so revoke targets the token THIS session just minted.
      if (!selected || !mintedOnboard) throw new Error('Mint a token first — revoke targets it.');
      await revokeOnboardTokenVia(authoritative, authClient, selected.id, mintedOnboard.tokenId);
      setMintedOnboard(null);
      return {
        kind: 'ok',
        text: 'Onboarding token revoked — the repo’s CI can no longer upload with it.',
      };
    });
  }

  /** A plain, read-only recheck of the registry — the CI tab's upload
   * happens outside this browser tab entirely, so there is nothing else here
   * to poll it automatically. */
  function onCheckForUpload(): void {
    run(async () => {
      if (!selected) throw new Error('Select a registered project first.');
      await refresh(selected.id);
      return {
        kind: 'ok',
        text: 'Refreshed — once the workflow finishes, the uploaded scan appears for review below (step 3).',
      };
    });
  }

  function onTrust(): void {
    run(async () => {
      if (!selected?.trustRequest) throw new Error('Upload the scan files first.');
      const outcome = await proposeTrustVia(authoritative, authClient, selected.id, {
        commitSha: selected.trustRequest.commitSha,
        prescanSha256: selected.trustRequest.prescanSha256,
      });
      await refresh(selected.id);
      return outcome.applied
        ? { kind: 'ok', text: 'Trust recorded — next, connect the repo’s CI (step 4).' }
        : {
            kind: 'ok',
            text: 'Trust decision recorded — a second admin must confirm it under Pending changes before it applies.',
          };
    });
  }

  function onMintKey(): void {
    run(async () => {
      if (!selected) throw new Error('Select a registered project first.');
      const mint = await mintUploadTokenVia(authoritative, authClient, selected.id);
      setMinted(mint);
      await refresh(selected.id);
      if (dataStepLive) await refreshVersions(selected.id);
      return {
        kind: 'ok',
        text: `Upload key minted — paste it into the repo’s CI secret ${UPLOAD_KEY_SECRET} now; it is not shown again.`,
      };
    });
  }

  function onRevokeKey(): void {
    run(async () => {
      // The server never lists keys back (only their argon2id hashes exist
      // server-side), so revoke targets the key THIS session just minted.
      if (!selected || !minted) throw new Error('Mint a key first — revoke targets it.');
      await revokeUploadTokenVia(authoritative, authClient, selected.id, minted.tokenId);
      setMinted(null);
      await refresh(selected.id);
      return {
        kind: 'ok',
        text: 'Upload key revoked — the repo’s CI can no longer upload with it.',
      };
    });
  }

  function onActivate(version: number): void {
    run(async () => {
      if (!selected) throw new Error('Select a registered project first.');
      // Captured BEFORE the write: on the server's 202 path nothing has applied
      // yet, so a pre-click status of 'trusted' means this is the project's
      // FIRST activation — the one whose confirmation takes it live.
      const firstActivation = selected.status !== 'ready';
      const outcome = await activateProjectDataVia(authoritative, authClient, selected.id, version);
      await refresh(selected.id);
      await refreshVersions(selected.id);
      if (outcome.applied) {
        return {
          kind: 'ok',
          text: `Upload #${version} is the active data for ${selected.id} — onboarding is complete.`,
        };
      }
      // Honest 202 copy: nothing is live yet. Only the second admin's
      // confirmation makes the data serve — and, on the first activation,
      // takes the project live in the switcher.
      return {
        kind: 'ok',
        text: firstActivation
          ? 'Activation proposed — once a second admin confirms it under Pending changes, the data goes live and the project becomes selectable.'
          : 'Activation recorded — a second admin must confirm it under Pending changes before the data goes live.',
      };
    });
  }

  function onArchiveToggle(p: ServerProject): void {
    run(async () => {
      const outcome = p.archived
        ? await unarchiveProjectVia(authoritative, authClient, p.id)
        : await archiveProjectVia(authoritative, authClient, p.id);
      await refresh();
      if (outcome.applied) {
        return {
          kind: 'ok',
          text: p.archived
            ? `${p.id} is back — requests can target it again.`
            : `${p.id} is archived — it leaves the switcher and no requests can target it. Restore it here any time.`,
        };
      }
      return {
        kind: 'ok',
        text: 'Recorded — a second admin must confirm it under Pending changes.',
      };
    });
  }

  function onDeregister(): void {
    run(async () => {
      if (!selected) throw new Error('Select a registered project first.');
      const outcome = await deregisterProjectVia(authoritative, authClient, selected.id);
      await refresh();
      return outcome.applied
        ? { kind: 'ok', text: 'Project removed.' }
        : {
            kind: 'ok',
            text: 'Removal recorded — a second admin must confirm it under Pending changes.',
          };
    });
  }

  const serverReport = selected?.trustRequest
    ? summaryFromWire(selected.trustRequest.report)
    : null;

  // The active / newer-staged / earlier split of the server's versions list.
  const grouped = versions ? groupDataVersions(versions) : null;
  // Any upload at all proves the repo's CI is connected and talking.
  const hasUploads = (versions?.versions.length ?? 0) > 0;

  // One file text serves every project — the project id rides the repo-side
  // CI variable, so nothing project-specific is baked into the file.
  const ciFileName = ciTab === 'github' ? GITHUB_CI_PATH : GITLAB_CI_PATH;
  const ciFileBody = ciTab === 'github' ? githubDataWorkflow() : gitlabDataPipeline();

  // Step 2's "Run in the repo's CI" tab — the one-shot onboarding workflow
  // (same host tab as step 4, since a repo has exactly one host) and the
  // deep link to its dispatch page, known once step 1's repo is on record.
  const onboardFileName = ciTab === 'github' ? GITHUB_ONBOARD_CI_PATH : GITLAB_ONBOARD_CI_PATH;
  const onboardFileBody = ciTab === 'github' ? githubOnboardWorkflow() : gitlabOnboardPipeline();
  const dispatchUrl = onboardDispatchUrl(selected?.repo);

  const artifactStatus = (
    source: ArtifactSource,
    parsedOk: boolean,
    emptyText: string,
  ): JSX.Element | null => {
    if (source === null) return <p className="projadmin__hint">{emptyText}</p>;
    if (!parsedOk) return null; // the per-field error line below says what's wrong
    return (
      <p className="projadmin__msg projadmin__msg--ok">
        {source.kind === 'file'
          ? `Read ${source.name} exactly as the scan wrote it.`
          : 'Using the pasted contents.'}
      </p>
    );
  };

  return (
    <div className="projadmin">
      {/* ── The five steps, always visible — onboarding is a path, not a hunt ── */}
      <section className="projadmin__section" aria-labelledby="projadmin-how">
        <div className="projadmin__section-head">
          <h2 className="projadmin__section-title" id="projadmin-how">
            How a project joins {getInstanceIdentity().name}
          </h2>
        </div>
        <ol className="projadmin__how">
          <li>
            Add the project — name, where the code lives, and the cloud identity: an AWS account and
            region, or an Azure subscription, tenant and location.
          </li>
          <li>
            Scan the repository — the repo&apos;s own CI can run the one-shot first scan and send it
            here itself (recommended, no laptop), or run <code>catalogctl onboard</code> locally and
            pick the two files it writes.
          </li>
          <li>
            Review the scan verdict and findings, then trust the commit — a person reads them, and a
            second admin confirms the decision.
          </li>
          <li>
            Connect the repository&apos;s CI: commit the ready-made CI file and give it an upload
            key. From then on the repo sends fresh project data itself.
          </li>
          <li>
            Review the uploaded data and activate it — a second admin confirms, and the control
            plane serves that data for the project. No digests to type; the server checks them.
          </li>
        </ol>
      </section>

      {notice && (
        <p
          className={`projadmin__msg${notice.kind === 'error' ? ' projadmin__msg--error' : ' projadmin__msg--ok'}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      {/* ── Registry ─────────────────────────────────────────────────────────── */}
      <section className="projadmin__section" aria-labelledby="projadmin-registry">
        <div className="projadmin__section-head">
          <h2 className="projadmin__section-title" id="projadmin-registry">
            Registered projects
          </h2>
          <span className="projadmin__section-note">{registry.length} registered</span>
        </div>
        {registry.length === 0 ? (
          <p className="projadmin__lead">
            {writable
              ? 'Nothing registered yet — add the first project below.'
              : 'The registry lives on ccp-api. Add and manage projects here once it is connected.'}
          </p>
        ) : (
          <div className="projadmin__list">
            {registry.map((p) => {
              const stale = staleDataNotice(p.dataActive?.activatedAt);
              const age = activatedAgeLabel(p.dataActive?.activatedAt);
              return (
                <Card
                  key={p.id}
                  title={p.name}
                  actions={
                    p.archived ? (
                      <Badge color="muted">Archived</Badge>
                    ) : (
                      <Badge color={p.status === 'ready' ? 'ok' : 'muted'}>
                        {statusLabel(p.status)}
                      </Badge>
                    )
                  }
                >
                  <dl className="projadmin__meta">
                    <div className="projadmin__meta-row">
                      <dt>Repo</dt>
                      <dd title={repoHostLabel(p)}>{repoLabel(p)}</dd>
                    </div>
                    <div className="projadmin__meta-row">
                      <dt>Code lives on</dt>
                      <dd>{repoHostLabel(p)}</dd>
                    </div>
                    <div className="projadmin__meta-row">
                      <dt>Cloud</dt>
                      <dd>{projectCloudLabel(p)}</dd>
                    </div>
                    {projectIdentityRows(p).map((row) => (
                      <div className="projadmin__meta-row" key={row.label}>
                        <dt>{row.label}</dt>
                        <dd className={row.mono ? 'projadmin__mono' : undefined}>{row.value}</dd>
                      </div>
                    ))}
                    {p.dataActive && (
                      <div className="projadmin__meta-row">
                        <dt>Data</dt>
                        <dd>
                          Serving upload #{p.dataActive.version}
                          {age ? ` · activated ${age}` : ''}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {stale && !p.archived && (
                    <p className="projadmin__msg projadmin__msg--warn">{stale}</p>
                  )}
                  <div className="projadmin__card-actions">
                    <Button
                      variant={selectedId === p.id ? 'primary' : 'ghost'}
                      onClick={() => setSelectedId(p.id)}
                    >
                      {selectedId === p.id ? 'Selected' : 'Open wizard'}
                    </Button>
                    <GateFieldset disabled={!writable}>
                      <Button variant="ghost" onClick={() => onArchiveToggle(p)}>
                        {p.archived ? 'Restore' : 'Archive'}
                      </Button>
                    </GateFieldset>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {selected?.archived && (
        <p className="projadmin__msg projadmin__msg--warn" role="status">
          {selected.name} is archived — it is hidden from the switcher and nothing can change it.
          Restore it above to continue.
        </p>
      )}

      {/* ── Step 1 — add ─────────────────────────────────────────────────────── */}
      <section className="projadmin__section" aria-labelledby="projadmin-add">
        <div className="projadmin__section-head">
          <h2 className="projadmin__section-title" id="projadmin-add">
            <StepHeading n={1} title="Add a project" />
          </h2>
        </div>
        <p className="projadmin__lead">
          Registers a draft. A draft grants nothing — no requests can target it until the whole path
          below is walked.
        </p>
        <GateFieldset disabled={!writable}>
          <form className="projadmin__form" onSubmit={onRegister} noValidate>
            {/* A labelled radiogroup, not a nested <fieldset> — a fieldset in
                this tree is the advisory gate's disabled fingerprint (see
                test/advisoryGate.test.ts) and means something else here. */}
            <div className="projadmin__hostset">
              <p className="projadmin__label" id="projadmin-host-label">
                Where does the code live?
              </p>
              <div
                className="projadmin__hosttoggle"
                role="radiogroup"
                aria-labelledby="projadmin-host-label"
              >
                {REPO_HOST_CHOICES.map((choice) => (
                  <label
                    key={choice.value}
                    className={`projadmin__hostopt${form.host === choice.value ? ' projadmin__hostopt--on' : ''}`}
                  >
                    <input
                      type="radio"
                      name="proj-host"
                      value={choice.value}
                      checked={form.host === choice.value}
                      onChange={() => setForm({ ...form, host: choice.value })}
                    />
                    <span>{choice.label}</span>
                  </label>
                ))}
              </div>
            </div>
            {/* Which cloud — switches the identity fields below (AWS account +
                region · Azure subscription + tenant + location). */}
            <div className="projadmin__hostset">
              <p className="projadmin__label" id="projadmin-cloud-label">
                Which cloud is this estate on?
              </p>
              <div
                className="projadmin__hosttoggle"
                role="radiogroup"
                aria-labelledby="projadmin-cloud-label"
              >
                {(['aws', 'azure'] as const).map((cloud) => (
                  <label
                    key={cloud}
                    className={`projadmin__hostopt${form.provider === cloud ? ' projadmin__hostopt--on' : ''}`}
                  >
                    <input
                      type="radio"
                      name="proj-provider"
                      value={cloud}
                      checked={form.provider === cloud}
                      onChange={() => setForm({ ...form, provider: cloud })}
                    />
                    <span>{cloud === 'aws' ? 'AWS' : 'Azure'}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="projadmin__form-grid">
              {form.host === 'gitlab-self-hosted' && (
                <div className="projadmin__field">
                  <label className="projadmin__label" htmlFor="proj-baseurl">
                    GitLab server address
                  </label>
                  <input
                    id="proj-baseurl"
                    className="projadmin__input"
                    value={form.baseUrl}
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                    placeholder="https://gitlab.example.com"
                    inputMode="url"
                    spellCheck={false}
                  />
                  <p className="projadmin__hint">
                    The address you open in a browser — it must start with https.
                  </p>
                </div>
              )}
              <div className="projadmin__field">
                <label className="projadmin__label" htmlFor="proj-owner">
                  Repository owner or group
                </label>
                <input
                  id="proj-owner"
                  className="projadmin__input"
                  value={form.owner}
                  onChange={(e) => setForm({ ...form, owner: e.target.value })}
                  placeholder={form.host === 'github' ? 'acme-co' : 'platform/infrastructure'}
                  spellCheck={false}
                />
                {form.host !== 'github' && (
                  <p className="projadmin__hint">Subgroups join with a slash.</p>
                )}
              </div>
              <div className="projadmin__field">
                <label className="projadmin__label" htmlFor="proj-repo">
                  Repository
                </label>
                <input
                  id="proj-repo"
                  className="projadmin__input"
                  value={form.repoName}
                  onChange={(e) => setForm({ ...form, repoName: e.target.value })}
                  placeholder="terraform-acme"
                  spellCheck={false}
                />
              </div>
              <div className="projadmin__field">
                <label className="projadmin__label" htmlFor="proj-id">
                  Project id
                </label>
                <input
                  id="proj-id"
                  className="projadmin__input"
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  placeholder="acme"
                  spellCheck={false}
                />
                <p className="projadmin__hint">
                  Short lowercase slug — it becomes the switcher entry.
                </p>
              </div>
              <div className="projadmin__field">
                <label className="projadmin__label" htmlFor="proj-name">
                  Display name
                </label>
                <input
                  id="proj-name"
                  className="projadmin__input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Acme estate"
                />
              </div>
              {form.provider === 'aws' ? (
                <>
                  <div className="projadmin__field">
                    <label className="projadmin__label" htmlFor="proj-account">
                      AWS account id
                    </label>
                    <input
                      id="proj-account"
                      className="projadmin__input"
                      value={form.accountId}
                      onChange={(e) => setForm({ ...form, accountId: e.target.value })}
                      placeholder="123456789012"
                      inputMode="numeric"
                      spellCheck={false}
                    />
                    <p className="projadmin__hint">Twelve digits.</p>
                  </div>
                  <div className="projadmin__field">
                    <label className="projadmin__label" htmlFor="proj-region">
                      AWS region
                    </label>
                    <input
                      id="proj-region"
                      className="projadmin__input"
                      value={form.region}
                      onChange={(e) => setForm({ ...form, region: e.target.value })}
                      placeholder="ap-southeast-1"
                      spellCheck={false}
                    />
                    <p className="projadmin__hint">
                      A standard region code — anything else is refused.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="projadmin__field">
                    <label className="projadmin__label" htmlFor="proj-subscription">
                      Azure subscription id
                    </label>
                    <input
                      id="proj-subscription"
                      className="projadmin__input"
                      value={form.subscriptionId}
                      onChange={(e) => setForm({ ...form, subscriptionId: e.target.value })}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      spellCheck={false}
                    />
                    <p className="projadmin__hint">The subscription GUID (8-4-4-4-12).</p>
                  </div>
                  <div className="projadmin__field">
                    <label className="projadmin__label" htmlFor="proj-tenant">
                      Azure tenant id
                    </label>
                    <input
                      id="proj-tenant"
                      className="projadmin__input"
                      value={form.tenantId}
                      onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      spellCheck={false}
                    />
                    <p className="projadmin__hint">The directory (tenant) GUID.</p>
                  </div>
                  <div className="projadmin__field">
                    <label className="projadmin__label" htmlFor="proj-location">
                      Azure default location
                    </label>
                    <input
                      id="proj-location"
                      className="projadmin__input"
                      value={form.location}
                      onChange={(e) => setForm({ ...form, location: e.target.value })}
                      placeholder="southeastasia"
                      spellCheck={false}
                    />
                    <p className="projadmin__hint">
                      A standard Azure location — anything else is refused.
                    </p>
                  </div>
                </>
              )}
            </div>
            <div className="projadmin__form-actions">
              <Button variant="primary" type="submit">
                Register draft project
              </Button>
            </div>
          </form>
        </GateFieldset>
      </section>

      {/* ── Step 2 — get the first scan into the wizard ──────────────────────── */}
      <section className="projadmin__section" aria-labelledby="projadmin-scan">
        <div className="projadmin__section-head">
          <h2 className="projadmin__section-title" id="projadmin-scan">
            <StepHeading
              n={2}
              title="Scan the repo"
              state={selected && selected.status !== 'draft' ? 'done' : undefined}
            />
          </h2>
        </div>
        <p className="projadmin__lead">
          The scan only reads the repository&apos;s Terraform — nothing executes, and this server
          never checks out repositories or runs terraform itself. Run it in the repo&apos;s own CI
          (no laptop, recommended) or on your own machine.
        </p>

        <div className="projadmin__tabs" role="tablist" aria-label="How to run the first scan">
          {(['ci', 'local'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`projadmin-scantab-${tab}`}
              aria-selected={scanMethod === tab}
              aria-controls="projadmin-scanpanel"
              tabIndex={scanMethod === tab ? 0 : -1}
              className={`projadmin__tab${scanMethod === tab ? ' projadmin__tab--active' : ''}`}
              onClick={() => setScanMethod(tab)}
            >
              {tab === 'ci' ? "Run in the repo's CI (recommended)" : 'Run locally'}
            </button>
          ))}
        </div>

        <div
          id="projadmin-scanpanel"
          role="tabpanel"
          aria-labelledby={`projadmin-scantab-${scanMethod}`}
        >
          {scanMethod === 'ci' ? (
            <>
              <p className="projadmin__lead">
                A one-shot workflow scans the repository where its own code already lives, then
                sends the two files here itself — nothing to copy by hand. It only reads the code
                (no terraform, no cloud credentials), and it can ship in the same pull request as
                the recurring data-lane file from step 4.
              </p>

              <div className="projadmin__tabs" role="tablist" aria-label="CI host">
                {(['github', 'gitlab'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    id={`projadmin-onboardhosttab-${tab}`}
                    aria-selected={ciTab === tab}
                    aria-controls="projadmin-onboardhostpanel"
                    tabIndex={ciTab === tab ? 0 : -1}
                    className={`projadmin__tab${ciTab === tab ? ' projadmin__tab--active' : ''}`}
                    onClick={() => setCiTab(tab)}
                  >
                    {tab === 'github' ? 'GitHub' : 'GitLab'}
                  </button>
                ))}
              </div>
              <div
                id="projadmin-onboardhostpanel"
                role="tabpanel"
                aria-labelledby={`projadmin-onboardhosttab-${ciTab}`}
                className="projadmin__cipanel"
              >
                <ol className="projadmin__how">
                  <li>
                    Commit this file to the repository as <code>{onboardFileName}</code>
                    {ciTab === 'gitlab'
                      ? ' and include it from the repository’s .gitlab-ci.yml'
                      : ''}
                    .
                  </li>
                  <li>
                    Mint an onboarding token below and save it in the repository&apos;s CI as the
                    secret <code>{ONBOARD_KEY_SECRET}</code>.
                  </li>
                  <li>
                    Next to it, set two CI variables: <code>{SERVER_URL_VAR}</code> — this control
                    plane&apos;s address — and <code>{PROJECT_ID_VAR}</code> ={' '}
                    <code>{selected?.id ?? '<project-id>'}</code>.
                  </li>
                  <li>
                    {ciTab === 'github'
                      ? 'Open the workflow and click "Run workflow".'
                      : 'Open "Run pipeline" on the default branch, then click the play button on the ccp-onboard job.'}{' '}
                    The two files land here on their own — check back, or use the button below.
                  </li>
                </ol>
                <div className="projadmin__cifile">
                  <div className="projadmin__cifile-head">
                    <code className="projadmin__cifile-name">{onboardFileName}</code>
                    <CopyButton
                      text={onboardFileBody}
                      label={`Copy the ${ciTab === 'github' ? 'GitHub' : 'GitLab'} onboarding workflow file`}
                    />
                  </div>
                  <pre className="projadmin__cifile-body">
                    <code>{onboardFileBody}</code>
                  </pre>
                </div>
                {dispatchUrl && (
                  <div className="projadmin__form-actions">
                    <a
                      className="ui-btn ui-btn--primary"
                      href={dispatchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {ciTab === 'github'
                        ? 'Open “Run workflow” on GitHub ↗'
                        : 'Open “Run pipeline” on GitLab ↗'}
                    </a>
                  </div>
                )}
                {!dispatchUrl && (
                  <p className="projadmin__hint">
                    Select a registered project above to get its dispatch link.
                  </p>
                )}
              </div>

              <div className="projadmin__trust-action">
                <h3 className="projadmin__subtitle">Onboarding token</h3>
                {mintedOnboard ? (
                  <p className="projadmin__lead">
                    Token <code>{mintedOnboard.tokenId}</code> was just minted — it is shown below
                    exactly once.
                  </p>
                ) : (
                  <p className="projadmin__lead">
                    A token is shown exactly once, at mint — the server keeps no readable copy. It
                    is narrow on purpose: it only works before this project is trusted, and it can
                    only upload this one project&apos;s scan — nothing else.
                  </p>
                )}
                <GateFieldset disabled={!writable}>
                  <div className="projadmin__form-actions">
                    <Button variant="primary" onClick={onMintOnboardToken} disabled={!selected}>
                      Mint onboarding token
                    </Button>
                    {mintedOnboard && (
                      <Button variant="danger" onClick={onRevokeOnboardToken}>
                        Revoke this token
                      </Button>
                    )}
                  </div>
                </GateFieldset>
                {!selected && writable && (
                  <p className="projadmin__hint">
                    Select a registered project above to mint a token for it.
                  </p>
                )}
                {mintedOnboard && (
                  <div className="projadmin__token" role="status">
                    <p className="projadmin__token-note">
                      This token is shown once — paste it into the repo&apos;s CI secret{' '}
                      <code>{ONBOARD_KEY_SECRET}</code> now.
                    </p>
                    <CommandBlock
                      command={mintedOnboard.token}
                      copyLabel="Copy the onboarding token"
                    />
                    <p className="projadmin__hint">
                      Valid until {formatProjectTime(mintedOnboard.expiresAt)}. If it leaks, revoke
                      it here while this page is open and mint a new one.
                    </p>
                  </div>
                )}
                {selected && (
                  <div className="projadmin__form-actions">
                    <Button variant="ghost" onClick={onCheckForUpload}>
                      Check for the uploaded scan
                    </Button>
                  </div>
                )}
              </div>

              <p className="projadmin__hint">
                Control plane unreachable from that runner (air-gapped estate)? The workflow still
                keeps the two files as a downloadable run artifact — switch to the{' '}
                <strong>Run locally</strong> tab and pick them from there.
              </p>
            </>
          ) : (
            <>
              <p className="projadmin__lead">
                Run this where your repository checkout and the terraform binary live. The scan is
                local on purpose: it refuses to run with cloud credentials in the environment. Kept
                for air-gapped estates with no usable CI.
              </p>
              <CommandBlock
                command={onboardCommand(selected?.id ?? '<project-id>')}
                copyLabel="Copy the onboarding scan command"
              />
              <p className="projadmin__lead">
                The run stops at the trust gate and writes two files into <code>out/</code>. Pick
                each one here — the picker reads the file&apos;s exact bytes, which the server
                checks against the fingerprint in the trust request.
              </p>

              <div className="projadmin__paste-grid">
                <div className="projadmin__filefield">
                  <label className="projadmin__paste-label" htmlFor="projadmin-file-tr">
                    trust-request.json
                  </label>
                  <input
                    id="projadmin-file-tr"
                    className="projadmin__file"
                    type="file"
                    accept=".json,application/json"
                    onChange={onPickArtifact('trust')}
                  />
                  {artifactStatus(
                    trustReqSource,
                    parsedTrustReq !== null,
                    'Pick the trust-request.json the scan wrote.',
                  )}
                  {trustReqText.trim().length > 0 && (
                    <p
                      className={`projadmin__msg${parsedTrustReq ? '' : ' projadmin__msg--error'}`}
                      role={parsedTrustReq ? undefined : 'alert'}
                    >
                      {parsedTrustReq
                        ? `Commit ${parsedTrustReq.commitSha.slice(0, 12)} of ${parsedTrustReq.repo}.`
                        : 'Not a trust-request.json — expected the three fields repo, commitSha and prescanSha256.'}
                    </p>
                  )}
                </div>
                <div className="projadmin__filefield">
                  <label className="projadmin__paste-label" htmlFor="projadmin-file-rep">
                    prescan-report.json
                  </label>
                  <input
                    id="projadmin-file-rep"
                    className="projadmin__file"
                    type="file"
                    accept=".json,application/json"
                    onChange={onPickArtifact('report')}
                  />
                  {artifactStatus(
                    reportSource,
                    parsedReport !== null,
                    'Pick the prescan-report.json the scan wrote.',
                  )}
                  {reportText.trim().length > 0 && !parsedReport && (
                    <p className="projadmin__msg projadmin__msg--error" role="alert">
                      Not a prescan-report.json — pick the whole file the scan wrote.
                    </p>
                  )}
                </div>
              </div>

              <details className="projadmin__fallback">
                <summary>Paste the file contents instead</summary>
                <p className="projadmin__hint">
                  If you can&apos;t pick files from here, paste each file&apos;s full contents
                  exactly as written — a shortened paste fails the fingerprint check.
                </p>
                <div className="projadmin__paste-grid">
                  <div>
                    <label className="projadmin__paste-label" htmlFor="projadmin-paste-tr">
                      trust-request.json
                    </label>
                    <textarea
                      id="projadmin-paste-tr"
                      className="projadmin__paste"
                      value={trustReqText}
                      onChange={(e) => {
                        setTrustReqText(e.target.value);
                        setTrustReqSource({ kind: 'paste' });
                      }}
                      placeholder='{"repo": "...", "commitSha": "...", "prescanSha256": "..."}'
                      rows={5}
                      spellCheck={false}
                    />
                  </div>
                  <div>
                    <label className="projadmin__paste-label" htmlFor="projadmin-paste-rep">
                      prescan-report.json
                    </label>
                    <textarea
                      id="projadmin-paste-rep"
                      className="projadmin__paste"
                      value={reportText}
                      onChange={(e) => {
                        setReportText(e.target.value);
                        setReportSource({ kind: 'paste' });
                      }}
                      placeholder='{"repo": "...", "verdict": "clean", "findings": [], ...}'
                      rows={5}
                      spellCheck={false}
                    />
                  </div>
                </div>
              </details>

              {parsedReport && <ReportView report={parsedReport} />}

              <GateFieldset disabled={!writable}>
                <div className="projadmin__form-actions">
                  <Button
                    variant="primary"
                    onClick={onUpload}
                    disabled={!selected || !parsedTrustReq || !parsedReport}
                  >
                    Upload scan files
                  </Button>
                  {!selected && writable && (
                    <p className="projadmin__hint">
                      Select a registered project above to upload for it.
                    </p>
                  )}
                </div>
              </GateFieldset>
            </>
          )}
        </div>
      </section>

      {/* ── Step 3 — review & trust ──────────────────────────────────────────── */}
      {selected &&
        !selected.archived &&
        serverReport &&
        selected.status === 'pending-trust' &&
        selected.trustRequest && (
          <section className="projadmin__section" aria-labelledby="projadmin-review">
            <div className="projadmin__section-head">
              <h2 className="projadmin__section-title" id="projadmin-review">
                <StepHeading n={3} title="Review & trust" />
              </h2>
            </div>
            <p className="projadmin__lead">
              Uploaded by {uploadedByLabel(selected.trustRequest.uploadedBy)}
              {selected.trustRequest.ci && (
                <>
                  {' '}
                  —{' '}
                  <a
                    href={selected.trustRequest.ci.runUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {ciProvenanceLabel(selected.trustRequest.ci)} ↗
                  </a>
                </>
              )}
              . Read the verdict and every finding — this review is a human decision and stays one.
              {selected.trustRequest.ci &&
                ' Cross-check the run above against the repository’s own Actions or pipeline log before trusting it.'}
            </p>
            <ReportView report={serverReport} />

            {trustControlRenders(serverReport) ? (
              <div className="projadmin__trust-action">
                <h3 className="projadmin__subtitle">Trust this commit</h3>
                <dl className="projadmin__meta projadmin__meta--wide">
                  <div className="projadmin__meta-row">
                    <dt>Commit</dt>
                    <dd className="projadmin__mono">{selected.trustRequest.commitSha}</dd>
                  </div>
                  <div className="projadmin__meta-row">
                    <dt>Report fingerprint</dt>
                    <dd className="projadmin__mono">{selected.trustRequest.prescanSha256}</dd>
                  </div>
                </dl>
                <GateFieldset disabled={!writable}>
                  <Button variant="primary" onClick={onTrust}>
                    Trust this commit
                  </Button>
                </GateFieldset>
                {!demo && (
                  <p className="projadmin__hint">
                    Recording the decision needs a second admin&apos;s confirmation under Pending
                    changes before anything applies.
                  </p>
                )}
              </div>
            ) : (
              <p className="projadmin__msg projadmin__msg--error" role="alert">
                The scan rejected this repository, so there is nothing to trust — fix the findings,
                commit, and run the scan again. This is a full stop by design.
              </p>
            )}
          </section>
        )}

      {/* ── Step 4 — connect the repo's CI ───────────────────────────────────── */}
      {selected && !selected.archived && dataStepLive && (
        <section className="projadmin__section" aria-labelledby="projadmin-ci">
          <div className="projadmin__section-head">
            <h2 className="projadmin__section-title" id="projadmin-ci">
              <StepHeading
                n={4}
                title="Connect the repo's CI"
                state={hasUploads || selected.status === 'ready' ? 'done' : undefined}
              />
            </h2>
          </div>
          <p className="projadmin__lead">
            The commit is trusted. From here the repository keeps its own data fresh: commit the CI
            file below, then give the job an upload key. On every merge it regenerates the project
            data and uploads it here, where it waits as staged data until step 5.
          </p>

          <div className="projadmin__tabs" role="tablist" aria-label="CI host">
            {(['github', 'gitlab'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`projadmin-citab-${tab}`}
                aria-selected={ciTab === tab}
                aria-controls="projadmin-cipanel"
                tabIndex={ciTab === tab ? 0 : -1}
                className={`projadmin__tab${ciTab === tab ? ' projadmin__tab--active' : ''}`}
                onClick={() => setCiTab(tab)}
              >
                {tab === 'github' ? 'GitHub' : 'GitLab'}
              </button>
            ))}
          </div>
          <div
            id="projadmin-cipanel"
            role="tabpanel"
            aria-labelledby={`projadmin-citab-${ciTab}`}
            className="projadmin__cipanel"
          >
            <ol className="projadmin__how">
              <li>
                Commit this file to the repository as <code>{ciFileName}</code>
                {ciTab === 'gitlab' ? ' and include it from the repository’s .gitlab-ci.yml' : ''}.
              </li>
              <li>
                Mint an upload key below and save it in the repository&apos;s CI as the secret{' '}
                <code>{UPLOAD_KEY_SECRET}</code>.
              </li>
              <li>
                Next to it, set two CI variables: <code>{SERVER_URL_VAR}</code> — this control
                plane&apos;s address — and <code>{PROJECT_ID_VAR}</code> ={' '}
                <code>{selected.id}</code>.
              </li>
              <li>Merge — the job runs and the uploaded data appears in step 5.</li>
            </ol>
            <div className="projadmin__cifile">
              <div className="projadmin__cifile-head">
                <code className="projadmin__cifile-name">{ciFileName}</code>
                <CopyButton
                  text={ciFileBody}
                  label={`Copy the ${ciTab === 'github' ? 'GitHub' : 'GitLab'} CI file`}
                />
              </div>
              <pre className="projadmin__cifile-body">
                <code>{ciFileBody}</code>
              </pre>
            </div>
          </div>

          <div className="projadmin__trust-action">
            <h3 className="projadmin__subtitle">Upload key</h3>
            {minted ? (
              <p className="projadmin__lead">
                Key <code>{minted.tokenId}</code> was just minted — it is shown below exactly once.
              </p>
            ) : (
              <p className="projadmin__lead">
                A key is shown exactly once, at mint — the server keeps no readable copy, so this
                page cannot list keys later. Each key expires on its own (a day by default); to
                rotate one, mint a new key and update the repo&apos;s CI secret.
              </p>
            )}
            <GateFieldset disabled={!writable}>
              <div className="projadmin__form-actions">
                <Button variant="primary" onClick={onMintKey}>
                  Mint upload key
                </Button>
                {minted && (
                  <Button variant="danger" onClick={onRevokeKey}>
                    Revoke this key
                  </Button>
                )}
              </div>
            </GateFieldset>
            {minted && (
              <div className="projadmin__token" role="status">
                <p className="projadmin__token-note">
                  This key is shown once — paste it into the repo&apos;s CI secret{' '}
                  <code>{UPLOAD_KEY_SECRET}</code> now.
                </p>
                <CommandBlock command={minted.token} copyLabel="Copy the upload key" />
                <p className="projadmin__hint">
                  Valid until {formatProjectTime(minted.expiresAt)}. If it leaks, revoke it here
                  while this page is open and mint a new one.
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Step 5 — review & activate data ──────────────────────────────────── */}
      {selected && !selected.archived && dataStepLive && (
        <section className="projadmin__section" aria-labelledby="projadmin-data">
          <div className="projadmin__section-head">
            <h2 className="projadmin__section-title" id="projadmin-data">
              <StepHeading
                n={5}
                title="Review & activate data"
                state={selected.status === 'ready' ? 'done' : undefined}
              />
            </h2>
          </div>
          <p className="projadmin__lead">
            Uploads from the repo&apos;s CI wait here as staged data — nothing goes live on its own.
            Activating switches the project to that version
            {demo ? '.' : ', after a second admin confirms.'} The server has already checked each
            upload&apos;s digests, so there is nothing to type.
            {selected.status !== 'ready' &&
              ' The first activation also takes the project live: it becomes selectable in the switcher.'}
          </p>

          {grouped && grouped.staged.length > 0 ? (
            <div className="projadmin__versions">
              {grouped.staged.map((v) => (
                <DataVersionCard
                  key={v.version}
                  version={v}
                  tone="staged"
                  action={
                    <GateFieldset disabled={!writable}>
                      <div className="projadmin__form-actions">
                        <Button variant="primary" onClick={() => onActivate(v.version)}>
                          Activate this data
                        </Button>
                      </div>
                    </GateFieldset>
                  }
                />
              ))}
            </div>
          ) : (
            <p className="projadmin__lead">
              Nothing staged right now — the repo&apos;s CI sends data here on its next merge (or
              run the job by hand from the repository).
            </p>
          )}

          {grouped?.active && (
            <div className="projadmin__versions">
              <DataVersionCard version={grouped.active} tone="active" />
            </div>
          )}

          {grouped && grouped.earlier.length > 0 && (
            <details className="projadmin__fallback">
              <summary>
                Version history ({grouped.earlier.length} earlier{' '}
                {grouped.earlier.length === 1 ? 'version' : 'versions'})
              </summary>
              <div className="projadmin__versions">
                {grouped.earlier.map((v) => (
                  <DataVersionCard
                    key={v.version}
                    version={v}
                    tone="prior"
                    action={
                      <GateFieldset disabled={!writable}>
                        <div className="projadmin__form-actions">
                          <Button variant="ghost" onClick={() => onActivate(v.version)}>
                            Make this the active data again
                          </Button>
                        </div>
                      </GateFieldset>
                    }
                  />
                ))}
              </div>
            </details>
          )}

          {selected.status === 'ready' && (
            <p className="projadmin__lead">
              {demo
                ? `${selected.name} is ready — onboarding is complete.`
                : `${selected.name} is ready — it appears in the project switcher, and accounts can now be bound to it.`}
            </p>
          )}

          <div className="projadmin__trust-action">
            <GateFieldset disabled={!writable}>
              <Button variant="danger" onClick={onDeregister}>
                Deregister this project
              </Button>
            </GateFieldset>
            {!demo && (
              <p className="projadmin__hint">
                Removal also needs a second admin&apos;s confirmation.
              </p>
            )}
          </div>
        </section>
      )}

      {/* ── What this build serves (vendored data artifacts) ─────────────────── */}
      <section className="projadmin__section" aria-labelledby="projadmin-build">
        <div className="projadmin__section-head">
          <h2 className="projadmin__section-title" id="projadmin-build">
            Data served by this build
          </h2>
          <span className="projadmin__section-note">{buildProjects.length} total</span>
        </div>
        <p className="projadmin__lead">
          Catalog and inventory data ship inside the app build — the bundled default plus anything
          vendored by the data pull request. The registry above records digests of that data; it
          never serves the files.
        </p>
        <div className="projadmin__list">
          {buildProjects.map((p) => (
            <Card key={p.id} title={p.name}>
              <dl className="projadmin__meta">
                <div className="projadmin__meta-row">
                  <dt>Repo</dt>
                  <dd>
                    {p.github.owner}/{p.github.repo}
                  </dd>
                </div>
                <div className="projadmin__meta-row">
                  <dt>Region</dt>
                  <dd>{p.region}</dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

export default ProjectsAdmin;
