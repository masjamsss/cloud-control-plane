import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { Role, Team } from '@/types';
import { ROLE_LABEL } from '@/types';
import { getCurrentUser } from '@/lib/session';
import { getTeams } from '@/lib/teams';
import { getProject } from '@/lib/project';
import { findRegisteredProject } from '@/lib/projectRegistry';
import { currentProjectId, SAMPLE_ESTATE_ID } from '@/lib/projectScope';
import { recordAudit } from '@/lib/audit';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { authClient } from '@/lib/api';
import type { AdminWriteOutcome } from '@/lib/httpApi';
import { MIN_PASSWORD, type Account } from '@/lib/accounts';
import {
  ALL_ACCOUNTS_LABEL,
  ALL_ACCOUNTS_NOTE,
  ALL_ACCOUNTS_SCOPE,
  addAssignmentVia,
  assignmentsOf,
  blockedRemoveReason,
  deleteAccountVia,
  describeAccountDelete,
  describeAccountWrite,
  describeSessionsRevoked,
  describeTotpReset,
  effectiveTotpRequired,
  enrollVia,
  isSeniorRole,
  loadAccountsVia,
  loadAssignableScopesVia,
  loadTeamsForScopeVia,
  needsTotpDowngradeConfirm,
  removeAssignmentVia,
  renameAccountVia,
  resetAccountPasswordVia,
  resetAccountTotpVia,
  revokeAccountSessionsVia,
  scopeLabelFor,
  setAccountRoleVia,
  setAccountStatusVia,
  setAccountTeamVia,
  setAccountTotpRequiredVia,
  type Assignment,
  type ScopeOption,
} from './usersFlow';
import { SearchBar } from '@/components/SearchBar';
import {
  ADVISORY_NOTE,
  AdvisoryControl,
  SERVER_MODE,
  useServerInfo,
} from '@/components/AdvisoryGate';
import './users.css';

/** The one plain-language label for the display-only Admin column (admin is a
 * grantable capability, and granting/revoking it is a
 * dual-controlled change made outside this screen — deliberately not a
 * control here). Exported so a test can pin the exact wording. */
export const ADMIN_CAPABILITY_NOTE =
  // Rendered copy stays plain (copyLint) — admin is a capability, not the Lead role.
  'Shows who holds the admin capability. Granting or revoking it is a dual-controlled change made outside this screen.';

/** The warning shown before an admin turns 2FA OFF for a privileged account
 * (approver/lead/admin) — a security downgrade. Plain language per the operator
 * copy rule. Exported so a test can pin the exact wording. */
export const TOTP_DOWNGRADE_WARNING =
  'This account has elevated access. Turning off two-factor authentication (2FA) is a security downgrade — they would then sign in with a password only. Turn it off anyway?';

/** The VISIBLE caption under the display-only Admin switch, so the reason it
 * never arms is on the screen itself (a tooltip on a disabled control is
 * invisible on touch). Exported so a test can pin the exact wording. */
export const ADMIN_TOGGLE_CAPTION = 'Granted by two admins, not here';

/** Why the Delete action is disabled on your own row. Matches the server's
 * refusal word for word, so the up-front reason and the guard agree. */
export const SELF_DELETE_NOTE = 'You cannot delete your own account. Ask another admin to do it.';

/** The plain either/or shown in the delete confirm, so an operator always sees
 * the reversible option next to the permanent one. */
export const DELETE_VS_DISABLE_NOTE =
  'Disable is temporary — the account can be switched back on later. Delete is permanent — the account is removed for good.';

const ROLES: Role[] = ['requester', 'approver', 'lead'];

/** The acting account (id + name) as a scope option, resolved PURELY from the
 * ambient project scope — no ProjectContext needed, so UsersAdmin renders in the
 * repo's provider-free component tests the same way it does under the router. */
function activeScope(): ScopeOption {
  const id = currentProjectId();
  const cfg = id === SAMPLE_ESTATE_ID ? getProject() : findRegisteredProject(id);
  return { id, name: cfg?.name ?? id };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.charAt(0) ?? '?';
  const b = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (a + b).toUpperCase();
}
function teamName(teams: Team[], id: string): string {
  return teams.find((t) => t.id === id)?.name ?? '—';
}
function matches(a: Account, q: string, teams: Team[]): boolean {
  const s = q.toLowerCase();
  return (
    a.displayName.toLowerCase().includes(s) ||
    a.username.toLowerCase().includes(s) ||
    ROLE_LABEL[a.role].toLowerCase().includes(s) ||
    teamName(teams, a.teamId).toLowerCase().includes(s)
  );
}

export function UsersAdmin(): JSX.Element {
  const me = getCurrentUser();
  const teams = getTeams();
  const activeProject: ScopeOption = activeScope();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [scopes, setScopes] = useState<ScopeOption[]>([activeProject]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { can } = useServerInfo();
  // `users` covers the FULL accounts CRUD surface (enrol / role / team /
  // status / password-reset), alongside the reset-TOTP + revoke-sessions
  // slice it already carried. The ONE row control that stays hardcoded
  // `disabled` regardless of this flag is the isAdmin toggle — no server
  // flow will ever arm it via this page.
  const authoritative = can('users');
  // Mode honesty: a mock build's accounts store genuinely supports the WHOLE
  // row locally — enrol / role / team / status / password, and (via the demo
  // security state on lib/accounts) the 2FA requirement, TOTP reset, and
  // session revoke — so every control WORKS in a mock build against this
  // browser's demo accounts instead of rendering dead. The one exception in
  // EITHER mode is the isAdmin toggle (display-only by design, see below).
  const demo = SERVER_MODE === 'mock';

  const refresh = (): void => {
    void loadAccountsVia(authoritative, authClient)
      .then((list) => {
        setLoadError(null);
        setAccounts(list);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Could not load accounts.');
      });
  };
  // Re-fetch whenever the backing store flips (e.g. api mode resolves after
  // the initial mock-shaped render) so the list never gets stuck on the wrong
  // source of truth — teamsFlow's TeamsAdmin.tsx established this exact
  // pattern (repeated at read granularity, not just writes).
  useEffect(refresh, [authoritative]);

  // The accounts an admin can assign a role ON (the scope dropdown's options):
  // every registered, ready account in api mode, just the acting account in
  // demo. Loaded once per mode/active-account and passed to every row's panel.
  useEffect(() => {
    let alive = true;
    void loadAssignableScopesVia(authoritative, authClient, activeProject)
      .then((list) => {
        if (alive) setScopes(list);
      })
      .catch(() => {
        if (alive) setScopes([activeProject]); // fail closed to the acting account only
      });
    return () => {
      alive = false;
    };
    // activeProject is derived fresh each render; key on its id (stable identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authoritative, activeProject.id]);

  const [query, setQuery] = useState('');
  const q = useDebouncedValue(query.trim(), 200);
  const shown = q ? accounts.filter((a) => matches(a, q, teams)) : accounts;

  return (
    <div className="users">
      {demo ? (
        <EnrollForm authoritative={authoritative} onEnrolled={refresh} byId={me.id} teams={teams} />
      ) : (
        <AdvisoryControl authoritative={authoritative}>
          <EnrollForm
            authoritative={authoritative}
            onEnrolled={refresh}
            byId={me.id}
            teams={teams}
          />
        </AdvisoryControl>
      )}

      <section className="users__section" aria-labelledby="users-list">
        <div className="users__section-head users__section-head--tools">
          <h2 className="users__section-title" id="users-list">
            Accounts
          </h2>
          <span className="users__section-note">{accounts.length} total</span>
          {accounts.length > 6 && (
            <div className="users__search">
              <SearchBar
                value={query}
                onChange={setQuery}
                placeholder="Search name, username, role, team"
                ariaLabel="Search accounts"
                count={q ? `${shown.length} of ${accounts.length}` : undefined}
              />
            </div>
          )}
        </div>

        <p className="users__advisory" role="note">
          {ADMIN_CAPABILITY_NOTE}
        </p>

        {loadError && (
          <p className="users__msg users__msg--error" role="alert">
            {loadError}
          </p>
        )}

        <div className="users__table-wrap">
          <table className="users__table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Username</th>
                <th scope="col">Roles &amp; accounts</th>
                <th scope="col">Status</th>
                <th scope="col">Admin</th>
                <th scope="col">2FA</th>
                <th scope="col" className="users__col-actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <AccountRow
                  key={a.id}
                  account={a}
                  isMe={a.id === me.id}
                  teams={teams}
                  scopes={scopes}
                  accounts={accounts}
                  activeProject={activeProject}
                  authoritative={authoritative}
                  demo={demo}
                  onChange={refresh}
                />
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="users__empty">
                    No accounts match “{q}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ── Enrol form (inline, not a modal) ───────────────────────────────────────── */

/**
 * The success notice after a LIVE enrolment (never the pending-dual-control
 * one). OP-2: the admin just typed this teammate's starting password and,
 * before this line, nothing on screen said how it should reach them or that
 * they'd ever be asked to change it — a locally-enrolled account skipped the
 * forced-rotation interstitial entirely, so the admin permanently knew a live
 * credential. Both backends now set `mustChangePassword: true` on enrol (the
 * mock's `lib/accounts.ts#enroll` matches the server's `admin.ts` route), so
 * this sentence is true whichever one just answered. Exported so a test can
 * pin the exact wording.
 */
export function enrolledNotice(displayName: string, username: string): string {
  return `Enrolled ${displayName} (@${username}). Share the starting password with them directly — they’ll be asked to set a new one the first time they sign in.`;
}

function EnrollForm({
  authoritative,
  onEnrolled,
  byId,
  teams,
}: {
  authoritative: boolean;
  onEnrolled: () => void;
  byId: string;
  teams: Team[];
}): JSX.Element {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRoleField] = useState<Role>('requester');
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await enrollVia(authoritative, authClient, { displayName, username, role, teamId, password }, byId);
      if (result.applied) {
        // The server audits its own enrol (admin.ts's account-enroll action) —
        // a local entry is recorded only when the write itself was local
        // (mock mode); api mode's Audit History already shows the real one.
        if (!authoritative) {
          recordAudit(
            byId,
            'Enrolled user',
            `${result.account.displayName} (@${result.account.username}) — ${ROLE_LABEL[role]}, ${teamName(teams, teamId)}`,
          );
        }
        setNotice(enrolledNotice(result.account.displayName, result.account.username));
      } else {
        setNotice(`Enrolment of @${username.trim().toLowerCase()} proposed — pending a second admin's approval.`);
      }
      setDisplayName('');
      setUsername('');
      setPassword('');
      setRoleField('requester');
      onEnrolled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enrol this user.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="users__section" aria-labelledby="enrol-heading">
      <div className="users__section-head">
        <h2 className="users__section-title" id="enrol-heading">
          Enrol a user
        </h2>
        <span className="users__section-note">
          {authoritative
            ? 'Creates an account on ccp-api they can sign in with'
            : 'Creates a demo account in this browser they can sign in with'}
        </span>
      </div>

      <form className="enrol" onSubmit={onSubmit} noValidate>
        <div className="enrol__grid">
          <div className="enrol__field">
            <label className="enrol__label" htmlFor="enrol-name">
              Display name
            </label>
            <input
              id="enrol-name"
              className="enrol__input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="enrol__field">
            <label className="enrol__label" htmlFor="enrol-username">
              Username
            </label>
            <input
              id="enrol-username"
              className="enrol__input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="lowercase handle"
            />
          </div>

          <div className="enrol__field">
            <label className="enrol__label" htmlFor="enrol-role">
              Role
            </label>
            <select
              id="enrol-role"
              className="enrol__input"
              value={role}
              onChange={(e) => setRoleField(e.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>

          <div className="enrol__field">
            <label className="enrol__label" htmlFor="enrol-team">
              Team
            </label>
            <select
              id="enrol-team"
              className="enrol__input"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="enrol__field">
            <label className="enrol__label" htmlFor="enrol-password">
              Starting password
            </label>
            <input
              id="enrol-password"
              className="enrol__input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={`at least ${MIN_PASSWORD} characters`}
            />
          </div>

          <div className="enrol__actions">
            <button className="enrol__submit" type="submit" disabled={busy}>
              {busy ? 'Enrolling…' : 'Enrol user'}
            </button>
          </div>
        </div>

        {error && (
          <p className="enrol__msg enrol__msg--error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="enrol__msg enrol__msg--ok" role="status">
            {notice}
          </p>
        )}
      </form>
    </section>
  );
}

/* ── One account row (role/team reassignment + inline reset-password) ───────── */

export function AccountRow({
  account,
  isMe,
  teams,
  scopes = [],
  accounts = [],
  activeProject,
  authoritative,
  demo = false,
  onChange,
}: {
  account: Account;
  isMe: boolean;
  teams: Team[];
  /** The accounts an admin can assign this user a role on (the scope dropdown's
   * options) — api mode's registered accounts, or just the acting account in
   * demo. Empty when the panel is rendered without a resolved scope set. */
  scopes?: ScopeOption[];
  /** EVERY listed user (not just the shown/filtered ones) — the assignment
   * panel counts leads per account across the whole directory so a blocked
   * Remove can say WHY up front (the last-lead rule). Empty = skip the
   * up-front reason and let the server's guard answer. */
  accounts?: Account[];
  /** The acting account (id + name), used to label a demo/legacy single-scope
   * row. Defaults to the ambient project scope so a bare render still works. */
  activeProject?: ScopeOption;
  /** True once ccp-api serves the accounts CRUD surface (`can('users')`) —
   * arms every control in this row EXCEPT the isAdmin toggle, which stays
   * hardcoded `disabled` regardless (lib/serverInfo.ts's per-flow note: no
   * server flow will ever arm admin-grant/revoke via this page). */
  authoritative: boolean;
  /** Mock build (mode honesty): the accounts store works locally — including
   * the demo security state behind the 2FA toggle, Reset TOTP, and Revoke
   * sessions — so EVERY row control stays LIVE against this browser's demo
   * data. The isAdmin toggle stays display-only in every mode. */
  demo?: boolean;
  onChange: () => void;
}): JSX.Element {
  const active: ScopeOption = activeProject ?? { id: currentProjectId(), name: currentProjectId() };
  // Where account writes can land: the server (authoritative) or the local
  // demo store (demo). In an api build still resolving/unserved, neither —
  // the safe default.
  const canWrite = authoritative || demo;
  const [assigning, setAssigning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(account.displayName);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totpBusy, setTotpBusy] = useState(false);
  const [sessionsBusy, setSessionsBusy] = useState(false);
  // 2FA requirement: the toggle reflects the EFFECTIVE value, and a
  // pending "turn 2FA off for a privileged account" awaits an explicit confirm.
  const [confirm2faOff, setConfirm2faOff] = useState(false);
  const totpRequired = effectiveTotpRequired(account);

  /** Runs a dual-control-aware write (role/team/status share this one path) —
   * mirrors teamsFlow's TeamCard `act()` helper. A LOCAL write also gets a
   * local audit entry; a SERVER write is already audited server-side
   * (admin.ts), so a second local entry there would just be dead weight
   * nobody reads in api mode's Audit History. */
  async function guarded(
    fn: () => Promise<AdminWriteOutcome>,
    appliedLabel: string,
    audit?: { action: string; summary: string },
  ): Promise<void> {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const result = await fn();
      if (audit && !authoritative) recordAudit(getCurrentUser().id, audit.action, audit.summary);
      setNote(describeAccountWrite(result, appliedLabel));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the change.');
      onChange(); // revert the control to the persisted value
    } finally {
      setBusy(false);
    }
  }

  /** Open ONE inline panel (rename/delete/reset/roles) and close the others,
   * so the subrow never stacks two forms. */
  function openPanel(which: 'rename' | 'delete' | 'reset' | 'roles' | null): void {
    setRenaming(which === 'rename');
    setDeleting(which === 'delete');
    setResetting(which === 'reset');
    setAssigning(which === 'roles');
    setError(null);
    setNote(null);
    if (which === 'rename') setNewName(account.displayName);
    if (which === 'delete') setConfirmName('');
  }

  async function doReset(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await resetAccountPasswordVia(authoritative, authClient, account.id, pw);
      if (!authoritative) recordAudit(getCurrentUser().id, 'Reset password', `@${account.username}`);
      setResetting(false);
      setPw('');
      setNote(describeAccountWrite(result, 'Password reset'));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  async function doRename(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      setError('Enter a display name.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await renameAccountVia(authoritative, authClient, account.id, name);
      if (!authoritative) {
        recordAudit(getCurrentUser().id, 'Renamed user', `@${account.username}: ${account.displayName} → ${name}`);
      }
      setRenaming(false);
      setNote(describeAccountWrite(result, `Renamed to ${name}`));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename this user.');
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (confirmName.trim() !== account.username) return; // the typed confirm gates the submit
    setError(null);
    setBusy(true);
    try {
      const result = await deleteAccountVia(authoritative, authClient, account.id, getCurrentUser().id);
      if (!authoritative) recordAudit(getCurrentUser().id, 'Deleted account', `@${account.username}`);
      setDeleting(false);
      setNote(describeAccountDelete(account.username, result));
      onChange(); // the refreshed list no longer contains this row
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this account.');
    } finally {
      setBusy(false);
    }
  }

  /* ── The two account-security actions (server route, or the demo state) ───── */

  async function onResetTotp(): Promise<void> {
    setError(null);
    setNote(null);
    setTotpBusy(true);
    try {
      const result = await resetAccountTotpVia(authoritative, authClient, account.id);
      // The server audits its own totp-reset; a local entry only for a local write.
      if (!authoritative) recordAudit(getCurrentUser().id, 'Reset TOTP', `@${account.username}`);
      setNote(describeTotpReset(result));
      onChange(); // the row's "app connected" state just changed
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset TOTP.');
    } finally {
      setTotpBusy(false);
    }
  }

  async function onRevokeSessions(): Promise<void> {
    setError(null);
    setNote(null);
    setSessionsBusy(true);
    try {
      const result = await revokeAccountSessionsVia(authoritative, authClient, account.id);
      // The server audits its own sessions-revoke; a local entry only for a local write.
      if (!authoritative) recordAudit(getCurrentUser().id, 'Revoked sessions', `@${account.username}`);
      setNote(describeSessionsRevoked(result));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke sessions.');
    } finally {
      setSessionsBusy(false);
    }
  }

  /* ── 2FA requirement: full control, with a downgrade safety net ────── */

  /** Flip the effective requirement. Turning it OFF for a privileged account is a
   * security downgrade, so we surface the warning + confirm first rather than
   * writing straight away; every other flip (incl. turning it ON) applies now.
   * The server permits + audits either direction regardless — this gate is UI-only. */
  function onToggle2fa(): void {
    const next = !totpRequired;
    if (needsTotpDowngradeConfirm(account, next)) {
      setError(null);
      setNote(null);
      setConfirm2faOff(true);
      return;
    }
    void apply2fa(next);
  }

  async function apply2fa(next: boolean): Promise<void> {
    setConfirm2faOff(false);
    await guarded(
      () => setAccountTotpRequiredVia(authoritative, authClient, account.id, next),
      next ? 'Two-factor authentication set to required' : 'Two-factor authentication set to not required',
      {
        action: 'Set 2FA requirement',
        summary: `@${account.username} → ${next ? 'required' : 'not required'}`,
      },
    );
  }

  return (
    <>
      <tr className={account.status === 'disabled' ? 'users__row users__row--off' : 'users__row'}>
        <td>
          <span className="users__name">
            <span className="users__avatar" aria-hidden="true">
              {initials(account.displayName)}
            </span>
            <span className="users__name-text">
              {account.displayName}
              {isMe && <span className="users__you">you</span>}
            </span>
          </span>
        </td>
        <td className="users__mono">@{account.username}</td>
        <td>
          {demo ? (
            /* Demo (mock build): the local accounts store is SINGLE-ACCOUNT, so
               it keeps the plain role + team dropdowns — there is no per-account
               model to assign scopes against. Api mode (below) gets the real
               multi-account role + scope assignment panel. */
            <div className="users__scopes-demo">
              <select
                className="users__cell-select"
                aria-label={`Role for ${account.displayName}`}
                value={account.role}
                disabled={isMe || !canWrite || busy}
                title={isMe ? 'Another Lead must change your role' : canWrite ? undefined : ADVISORY_NOTE}
                onChange={(e) => {
                  const next = e.target.value as Role;
                  void guarded(() => setAccountRoleVia(authoritative, authClient, account.id, next), 'Role updated', {
                    action: 'Changed role',
                    summary: `@${account.username} → ${ROLE_LABEL[next]}`,
                  });
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <select
                className="users__cell-select"
                aria-label={`Team for ${account.displayName}`}
                value={account.teamId}
                disabled={!canWrite || busy}
                title={canWrite ? undefined : ADVISORY_NOTE}
                onChange={(e) => {
                  const next = e.target.value;
                  void guarded(() => setAccountTeamVia(authoritative, authClient, account.id, next), 'Team updated', {
                    action: 'Changed team',
                    summary: `@${account.username} → ${teamName(teams, next)}`,
                  });
                }}
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="users__scopes">
              <AssignmentSummary
                assignments={assignmentsOf(account, active.id)}
                scopes={scopes}
              />
              <button
                type="button"
                className="users__action users__manage"
                aria-expanded={assigning}
                disabled={isMe || !canWrite || busy}
                title={
                  isMe
                    ? 'Another Lead must change your roles'
                    : canWrite
                      ? undefined
                      : ADVISORY_NOTE
                }
                onClick={() => openPanel(assigning ? null : 'roles')}
              >
                Manage roles
              </button>
            </div>
          )}
        </td>
        <td>
          <span
            className={
              account.status === 'active'
                ? 'users__status users__status--on'
                : 'users__status users__status--off'
            }
          >
            {account.status === 'active' ? 'Active' : 'Disabled'}
          </span>
        </td>
        <td>
          {/* Display-only by design: granting/revoking the admin
              capability is a dual-controlled change made outside this screen,
              so this toggle never arms — in either mode. The reason is VISIBLE
              (the caption below), not just a hover title — a disabled switch
              with a tooltip reads as broken, and tooltips never show on touch. */}
          <div className="users__admin">
            <label
              className={'users__toggle' + (account.isAdmin ? ' is-on' : '')}
              title={ADMIN_CAPABILITY_NOTE}
            >
              <input
                type="checkbox"
                className="users__toggle-input"
                checked={account.isAdmin === true}
                disabled
                readOnly
                aria-label={`Admin capability for ${account.displayName}`}
              />
              <span className="users__toggle-track" aria-hidden="true" />
            </label>
            <span className="users__admin-caption">{ADMIN_TOGGLE_CAPTION}</span>
          </div>
        </td>
        <td>
          {/* Admin-controlled 2FA requirement. The toggle reflects the
              EFFECTIVE value; turning it OFF for a privileged account trips the
              downgrade warning below before it takes effect. Writes reach
              ccp-api when authoritative, else the demo account store —
              live in both, like the rest of the row. */}
          <div className="users__2fa">
            <label
              className={'users__toggle' + (totpRequired ? ' is-on' : '')}
              title={canWrite ? undefined : ADVISORY_NOTE}
            >
              <input
                type="checkbox"
                className="users__toggle-input"
                checked={totpRequired}
                disabled={!canWrite || busy}
                aria-label={`Two-factor authentication for ${account.displayName}`}
                onChange={onToggle2fa}
              />
              <span className="users__toggle-track" aria-hidden="true" />
            </label>
            <span className="users__2fa-label">
              {totpRequired ? 'Required' : 'Not required'}
              {account.totpEnrolled === true ? ' · app connected' : ''}
            </span>
          </div>
        </td>
        <td className="users__col-actions">
          <div className="users__actions">
            <button
              type="button"
              className="users__action"
              aria-expanded={renaming}
              disabled={!canWrite || busy}
              title={canWrite ? 'Change the display name' : ADVISORY_NOTE}
              onClick={() => openPanel(renaming ? null : 'rename')}
            >
              Rename
            </button>
            <button
              type="button"
              className="users__action"
              aria-expanded={resetting}
              disabled={!canWrite || busy}
              title={canWrite ? undefined : ADVISORY_NOTE}
              onClick={() => openPanel(resetting ? null : 'reset')}
            >
              Reset password
            </button>
            {/* Reset 2FA / Revoke sessions: ccp-api's account-security
                routes when authoritative, else the demo security state on the
                local account store — live in both. In an api build the
                advisory title applies until the flow is served. */}
            <button
              type="button"
              className="users__action"
              disabled={!canWrite || totpBusy}
              title={canWrite ? undefined : ADVISORY_NOTE}
              onClick={() => void onResetTotp()}
            >
              {totpBusy ? 'Resetting…' : 'Reset 2FA'}
            </button>
            <button
              type="button"
              className="users__action"
              disabled={!canWrite || sessionsBusy}
              title={canWrite ? undefined : ADVISORY_NOTE}
              onClick={() => void onRevokeSessions()}
            >
              {sessionsBusy ? 'Revoking…' : 'Revoke sessions'}
            </button>
            <button
              type="button"
              className="users__action"
              disabled={!canWrite || busy}
              title={
                canWrite
                  ? account.status === 'active'
                    ? 'Temporary — the account can be switched back on later'
                    : 'Switch the account back on'
                  : ADVISORY_NOTE
              }
              onClick={() =>
                void guarded(
                  () =>
                    setAccountStatusVia(
                      authoritative,
                      authClient,
                      account.id,
                      account.status === 'active' ? 'disabled' : 'active',
                    ),
                  account.status === 'active' ? 'Disabled' : 'Enabled',
                  {
                    action: account.status === 'active' ? 'Disabled account' : 'Enabled account',
                    summary: `@${account.username}`,
                  },
                )
              }
            >
              {account.status === 'active' ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              className="users__action users__action--danger"
              aria-expanded={deleting}
              disabled={isMe || !canWrite || busy}
              title={
                isMe
                  ? SELF_DELETE_NOTE
                  : canWrite
                    ? 'Permanent — the account is removed for good'
                    : ADVISORY_NOTE
              }
              onClick={() => openPanel(deleting ? null : 'delete')}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>

      {(assigning || resetting || renaming || deleting || confirm2faOff || error || note) && (
        <tr className="users__subrow">
          <td colSpan={7}>
            {assigning && !demo && (
              <AssignmentPanel
                account={account}
                assignments={assignmentsOf(account, active.id)}
                scopes={scopes}
                accounts={accounts}
                authoritative={authoritative}
                onDone={() => {
                  onChange();
                }}
              />
            )}
            {renaming && (
              <form className="users__reset" onSubmit={doRename}>
                <label className="users__reset-label" htmlFor={`rename-${account.id}`}>
                  New display name for @{account.username}
                </label>
                <input
                  id={`rename-${account.id}`}
                  className="users__reset-input"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={80}
                  autoComplete="off"
                  disabled={busy}
                />
                <button className="users__reset-save" type="submit" disabled={busy || newName.trim().length === 0}>
                  {busy ? 'Saving…' : 'Save name'}
                </button>
                <button
                  className="users__reset-cancel"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRenaming(false);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </form>
            )}
            {deleting && (
              <form className="users__reset users__delete" onSubmit={doDelete}>
                <p className="users__delete-warn" role="alert">
                  {DELETE_VS_DISABLE_NOTE}
                </p>
                <label className="users__reset-label" htmlFor={`delete-${account.id}`}>
                  Type {account.username} to confirm the permanent delete
                </label>
                <input
                  id={`delete-${account.id}`}
                  className="users__reset-input"
                  type="text"
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  placeholder={account.username}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                />
                <button
                  className="users__reset-save users__reset-save--danger"
                  type="submit"
                  disabled={busy || confirmName.trim() !== account.username}
                >
                  {busy ? 'Deleting…' : 'Delete for good'}
                </button>
                <button
                  className="users__reset-cancel"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDeleting(false);
                    setConfirmName('');
                    setError(null);
                  }}
                >
                  Keep the account
                </button>
              </form>
            )}
            {confirm2faOff && (
              <div className="users__reset" role="alert">
                <span className="users__msg users__msg--error">{TOTP_DOWNGRADE_WARNING}</span>
                <button
                  type="button"
                  className="users__reset-save"
                  disabled={busy}
                  onClick={() => void apply2fa(false)}
                >
                  Turn off 2FA
                </button>
                <button
                  type="button"
                  className="users__reset-cancel"
                  disabled={busy}
                  onClick={() => setConfirm2faOff(false)}
                >
                  Keep 2FA on
                </button>
              </div>
            )}
            {resetting && (
              <form className="users__reset" onSubmit={doReset}>
                <label className="users__reset-label" htmlFor={`reset-${account.id}`}>
                  New password for @{account.username}
                </label>
                <input
                  id={`reset-${account.id}`}
                  className="users__reset-input"
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  autoComplete="new-password"
                  placeholder={`at least ${MIN_PASSWORD} characters`}
                  disabled={busy}
                />
                <button className="users__reset-save" type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button
                  className="users__reset-cancel"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setResetting(false);
                    setPw('');
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </form>
            )}
            {error && (
              <p className="users__msg users__msg--error" role="alert">
                {error}
              </p>
            )}
            {note && !resetting && (
              <p className="users__msg users__msg--ok" role="status">
                {note}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Roles & accounts: the multi-account assignment surface ──────────────────── */

/** The compact, always-visible summary in the row: every (role, scope) the user
 * holds, in plain words. "scope" reads as the account the role covers. */
function AssignmentSummary({
  assignments,
  scopes,
}: {
  assignments: Assignment[];
  scopes: ScopeOption[];
}): JSX.Element {
  if (assignments.length === 0) {
    return <span className="users__scope-empty">No roles yet</span>;
  }
  return (
    <ul className="users__scope-list">
      {assignments.map((a) => (
        <li key={a.scope} className="users__scope-chip">
          <span className="users__scope-role">{ROLE_LABEL[a.role]}</span>
          <span className="users__scope-sep"> on </span>
          <span className="users__scope-name">{scopeLabelFor(a.scope, scopes)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The role + scope assignment panel (api mode). Lists the user's CURRENT
 * assignments — each an account + role (+ team) with a Remove — and an Add
 * control that grants a role on a chosen account (or, read-only, shows the
 * all-accounts binding). Every write goes through the server's per-account
 * verbs; a grant/raise to approver or lead surfaces "pending a second admin's
 * approval" (dual-control), while a requester grant, a team change, and a revoke
 * apply immediately.
 */
export function AssignmentPanel({
  account,
  assignments,
  scopes,
  accounts = [],
  authoritative,
  onDone,
}: {
  account: Account;
  assignments: Assignment[];
  scopes: ScopeOption[];
  /** The whole user directory — lets a blocked Remove say why up front
   * (the per-account last-lead rule needs to count every other lead). */
  accounts?: Account[];
  authoritative: boolean;
  onDone: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [addScope, setAddScope] = useState<string>(scopes[0]?.id ?? '');
  const [addRole, setAddRole] = useState<Role>('requester');
  const [scopeTeams, setScopeTeams] = useState<Team[]>([]);
  const [addTeam, setAddTeam] = useState<string>('');

  const wildcardChosen = addScope === ALL_ACCOUNTS_SCOPE;
  const alreadyHas = new Set(assignments.map((a) => a.scope));

  // Teams are PER account: reload the chosen account's team list whenever the
  // scope changes, and default the team to that account's first. The wildcard
  // has no team dimension (and can't be granted here anyway).
  useEffect(() => {
    let alive = true;
    if (wildcardChosen) {
      setScopeTeams([]);
      setAddTeam('');
      return;
    }
    void loadTeamsForScopeVia(authoritative, authClient, addScope)
      .then((list) => {
        if (!alive) return;
        setScopeTeams(list);
        setAddTeam(list[0]?.id ?? '');
      })
      .catch(() => {
        if (alive) setScopeTeams([]);
      });
    return () => {
      alive = false;
    };
  }, [authoritative, addScope, wildcardChosen]);

  async function run(fn: () => Promise<AdminWriteOutcome>, appliedLabel: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await fn();
      setNote(describeAccountWrite(result, appliedLabel));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the change.');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  function onAdd(): void {
    if (wildcardChosen) {
      setError(ALL_ACCOUNTS_NOTE);
      return;
    }
    const teamId = scopeTeams.length > 0 ? addTeam : undefined;
    const scopeName = scopeLabelFor(addScope, scopes);
    void run(
      () => addAssignmentVia(authoritative, authClient, account.id, addScope, addRole, teamId),
      `${ROLE_LABEL[addRole]} on ${scopeName}`,
    );
  }

  function onRemove(scope: string): void {
    void run(
      () => removeAssignmentVia(authoritative, authClient, account.id, scope),
      `Removed the role on ${scopeLabelFor(scope, scopes)}`,
    );
  }

  return (
    <div className="assign" role="group" aria-label={`Roles and accounts for ${account.displayName}`}>
      <div className="assign__block">
        <h3 className="assign__title">Current roles</h3>
        {assignments.length === 0 ? (
          <p className="assign__empty">This user has no roles yet.</p>
        ) : (
          <ul className="assign__list">
            {assignments.map((a) => {
              // Blocked removals stay VISIBLE — a disabled Remove with the
              // plain reason beside it, never a silently dead (or missing)
              // control. The server enforces the same rules regardless.
              const blocked = blockedRemoveReason(account, a, accounts, scopes);
              return (
                <li key={a.scope} className="assign__item">
                  <span className="assign__item-scope">{scopeLabelFor(a.scope, scopes)}</span>
                  <span className="assign__item-role">{ROLE_LABEL[a.role]}</span>
                  {a.teamId ? <span className="assign__item-team">{a.teamId} team</span> : <span />}
                  {blocked ? (
                    <>
                      <button type="button" className="assign__remove" disabled title={blocked}>
                        Remove
                      </button>
                      <span className="assign__item-note" role="note">
                        {blocked}
                      </span>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="assign__remove"
                      disabled={busy}
                      onClick={() => onRemove(a.scope)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="assign__block">
        <h3 className="assign__title">Add a role</h3>
        <div className="assign__grid">
          <label className="assign__field">
            <span className="assign__label">Account (scope)</span>
            <select
              className="assign__input"
              value={addScope}
              disabled={busy}
              aria-label={`Account to assign for ${account.displayName}`}
              onChange={(e) => setAddScope(e.target.value)}
            >
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value={ALL_ACCOUNTS_SCOPE}>{ALL_ACCOUNTS_LABEL}</option>
            </select>
          </label>

          <label className="assign__field">
            <span className="assign__label">Role</span>
            <select
              className="assign__input"
              value={addRole}
              disabled={busy || wildcardChosen}
              aria-label={`Role to assign for ${account.displayName}`}
              onChange={(e) => setAddRole(e.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>

          <label className="assign__field">
            <span className="assign__label">Team</span>
            <select
              className="assign__input"
              value={addTeam}
              disabled={busy || wildcardChosen || scopeTeams.length === 0}
              aria-label={`Team to assign for ${account.displayName}`}
              onChange={(e) => setAddTeam(e.target.value)}
            >
              {scopeTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <div className="assign__actions">
            <button
              type="button"
              className="assign__add-btn"
              disabled={busy || wildcardChosen}
              onClick={onAdd}
            >
              {alreadyHas.has(addScope) ? 'Update role' : 'Add assignment'}
            </button>
          </div>
        </div>

        {wildcardChosen && (
          <p className="assign__hint" role="note">
            {ALL_ACCOUNTS_NOTE}
          </p>
        )}
        {!wildcardChosen && isSeniorRole(addRole) && (
          <p className="assign__hint" role="note">
            Granting {ROLE_LABEL[addRole]} needs a second admin&apos;s approval before it takes effect.
          </p>
        )}
      </div>

      {error && (
        <p className="users__msg users__msg--error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="users__msg users__msg--ok" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

export default UsersAdmin;
