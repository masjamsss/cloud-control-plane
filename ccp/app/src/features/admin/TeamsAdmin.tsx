import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { Team } from '@/types';
import { manifests } from '@/data/manifests';
import { getServiceMeta } from '@/lib/serviceMeta';
import { getCurrentUser } from '@/lib/session';
import { recordAudit } from '@/lib/audit';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { memberCount } from '@/lib/teams';
import { authClient } from '@/lib/api';
import {
  createTeamVia,
  deleteTeamVia,
  loadTeams,
  renameTeamVia,
  toggleServiceVia,
} from './teamsFlow';
import { SearchBar } from '@/components/SearchBar';
import { AdvisoryControl, SERVER_MODE, useServerInfo } from '@/components/AdvisoryGate';
import './teams-admin.css';

const ALL_SERVICES = manifests
  .map((m) => ({ slug: m.service, name: getServiceMeta(m.service).displayName }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function TeamsAdmin(): JSX.Element {
  const { can } = useServerInfo();
  const authoritative = can('teams');
  // Mode honesty: lib/teams genuinely works locally (team → service ownership
  // drives the whole demo catalog), so in a mock build these controls stay
  // LIVE against this browser's demo teams instead of rendering dead behind a
  // jargon tooltip.
  const demo = SERVER_MODE === 'mock';
  const [teams, setTeams] = useState<Team[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = (): void => {
    void loadTeams(authoritative, authClient)
      .then((list) => {
        setLoadError(null);
        setTeams(list);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Could not load teams.');
      });
  };
  // Re-fetch whenever the backing store flips (e.g. api mode resolves after
  // the initial mock-shaped render) so the list never gets stuck on the wrong
  // source of truth.
  useEffect(refresh, [authoritative]);

  /** Who (else) owns a service, from the ALREADY-LOADED team list — never a
   * fresh lib/teams read. In api mode `teams` came from the server; re-reading
   * lib/teams here instead would silently reseed and consult a disconnected
   * local store (lesson repeated at read granularity, not just writes). */
  function ownerOf(serviceSlug: string): Team | undefined {
    return teams.find((t) => t.serviceSlugs.includes(serviceSlug));
  }

  const body = (
    <>
      <CreateTeam authoritative={authoritative} onCreated={refresh} />

      <section className="teams__section" aria-labelledby="teams-list">
        <div className="teams__section-head">
          <h2 className="teams__section-title" id="teams-list">
            Teams
          </h2>
          <span className="teams__section-note">
            {teams.length} total · a service belongs to one team
          </span>
        </div>

        {loadError && (
          <p className="teams__msg teams__msg--error" role="alert">
            {loadError}
          </p>
        )}

        <div className="teams__list">
          {teams.map((t) => (
            <TeamCard
              key={t.id}
              team={t}
              authoritative={authoritative}
              ownerOf={ownerOf}
              onChange={refresh}
            />
          ))}
        </div>
      </section>
    </>
  );

  // Mock build: live against the local store. Api build: the arming rule,
  // unchanged (dark until ccp-api serves the flow).
  return (
    <div className="teams">
      {demo ? body : <AdvisoryControl authoritative={authoritative}>{body}</AdvisoryControl>}
    </div>
  );
}

/* ── Create ─────────────────────────────────────────────────────────────────── */

function CreateTeam({
  authoritative,
  onCreated,
}: {
  authoritative: boolean;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const t = await createTeamVia(authoritative, authClient, name);
      // The server records its OWN audit entry for this write (admin.ts's
      // team-create action) — recording a second, local one would just be
      // dead weight nobody reads (api mode's Audit History reads the server).
      if (!authoritative) recordAudit(getCurrentUser().id, 'Created team', t.name);
      setNotice(`Created “${t.name}”. Assign its services below.`);
      setName('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the team.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="teams__section" aria-labelledby="create-team">
      <div className="teams__section-head">
        <h2 className="teams__section-title" id="create-team">
          Create a team
        </h2>
        <span className="teams__section-note">Then assign the services it owns</span>
      </div>
      <form className="teams__create" onSubmit={(e) => void onSubmit(e)} noValidate>
        <input
          className="teams__create-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Team name"
          aria-label="New team name"
          disabled={busy}
        />
        <button className="teams__create-btn" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create team'}
        </button>
      </form>
      {error && (
        <p className="teams__msg teams__msg--error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="teams__msg teams__msg--ok" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

/* ── One team ───────────────────────────────────────────────────────────────── */

function TeamCard({
  team,
  authoritative,
  ownerOf,
  onChange,
}: {
  team: Team;
  authoritative: boolean;
  ownerOf: (serviceSlug: string) => Team | undefined;
  onChange: () => void;
}): JSX.Element {
  const [editingServices, setEditingServices] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(team.name);
  const [query, setQuery] = useState('');
  const q = useDebouncedValue(query.trim().toLowerCase(), 200);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const members = memberCount(team.id);
  const owned = new Set(team.serviceSlugs);
  const shown = q
    ? ALL_SERVICES.filter((s) => s.name.toLowerCase().includes(q) || s.slug.includes(q))
    : ALL_SERVICES;

  /** Runs a write; returns whether it succeeded so a caller can decide what to
   * do next (e.g. only close the rename form once the write actually lands). */
  async function act(
    fn: () => Promise<void>,
    audit?: { action: string; summary: string },
  ): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      await fn();
      // See CreateTeam's note: the server audits its own writes, so a local
      // entry is recorded only when the write itself was local (mock mode).
      if (audit && !authoritative) recordAudit(getCurrentUser().id, audit.action, audit.summary);
      onChange();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the change.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="team">
      <div className="team__head">
        {renaming ? (
          <form
            className="team__rename"
            onSubmit={(e) => {
              e.preventDefault();
              // Only close the form on success — with a real network round-trip
              // (api mode) closing eagerly would hide the form, and any
              // rejection, before the answer even comes back; on failure it
              // stays open (with the error) so the name can be corrected and resubmitted.
              void act(() => renameTeamVia(authoritative, authClient, team.id, nameDraft), {
                action: 'Renamed team',
                summary: `${team.name} → ${nameDraft.trim()}`,
              }).then((ok) => {
                if (ok) setRenaming(false);
              });
            }}
          >
            <input
              className="team__rename-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              aria-label="Team name"
              disabled={busy}
              autoFocus
            />
            <button className="team__btn team__btn--primary" type="submit" disabled={busy}>
              Save
            </button>
            <button
              className="team__btn"
              type="button"
              disabled={busy}
              onClick={() => {
                setRenaming(false);
                setNameDraft(team.name);
                setError(null);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <div className="team__id">
              <h3 className="team__name">{team.name}</h3>
              <span className="team__meta">
                {team.serviceSlugs.length} service{team.serviceSlugs.length === 1 ? '' : 's'} ·{' '}
                {members} member{members === 1 ? '' : 's'}
              </span>
            </div>
            <div className="team__actions">
              <button
                className="team__btn"
                type="button"
                aria-expanded={editingServices}
                disabled={busy}
                onClick={() => setEditingServices((v) => !v)}
              >
                {editingServices ? 'Done' : 'Edit services'}
              </button>
              <button
                className="team__btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setRenaming(true);
                  setNameDraft(team.name);
                }}
              >
                Rename
              </button>
              <button
                className="team__btn team__btn--danger"
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(() => deleteTeamVia(authoritative, authClient, team.id), {
                    action: 'Deleted team',
                    summary: team.name,
                  })
                }
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </>
        )}
      </div>

      {team.serviceSlugs.length > 0 ? (
        <div className="team__chips">
          {team.serviceSlugs
            .map((s) => getServiceMeta(s).displayName)
            .sort((a, b) => a.localeCompare(b))
            .map((name) => (
              <span className="team__chip" key={name}>
                {name}
              </span>
            ))}
        </div>
      ) : (
        <p className="team__none">
          No services yet — assign some so this team’s requesters have something to change.
        </p>
      )}

      {error && (
        <p className="teams__msg teams__msg--error" role="alert">
          {error}
        </p>
      )}

      {editingServices && (
        <div className="team__editor">
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder="Search services"
            ariaLabel="Search services to assign"
            count={q ? `${shown.length} of ${ALL_SERVICES.length}` : undefined}
          />
          <ul className="team__services">
            {shown.map((svc) => {
              const owner = ownerOf(svc.slug);
              const mine = owned.has(svc.slug);
              const elsewhere = owner && owner.id !== team.id ? owner.name : null;
              return (
                <li key={svc.slug} className="team__service">
                  <label className="team__service-label">
                    <input
                      type="checkbox"
                      className="team__checkbox"
                      checked={mine}
                      disabled={busy}
                      onChange={() =>
                        void act(
                          () => toggleServiceVia(authoritative, authClient, team, svc.slug),
                          {
                            action: mine ? 'Unassigned service' : 'Assigned service',
                            summary: `${svc.name} ${mine ? 'from' : 'to'} ${team.name}`,
                          },
                        )
                      }
                    />
                    <span className="team__service-name">{svc.name}</span>
                    {elsewhere && <span className="team__service-owner">{elsewhere}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

export default TeamsAdmin;
