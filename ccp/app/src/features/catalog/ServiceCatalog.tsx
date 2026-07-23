import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { Inventory, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { deriveServiceCatalog, type ServiceSummary } from '@/lib/catalog';
import { useActiveProjectId, useProject } from '@/lib/ProjectContext';
import { useCurrentUser } from '@/lib/session';
import { teamFor } from '@/lib/permissions';
import { useTeams } from '@/lib/teams';
import { ServiceCard } from './ServiceCard';
import './catalog.css';

function matchesQuery(summary: ServiceSummary, q: string): boolean {
  if (summary.meta.displayName.toLowerCase().includes(q)) return true;
  if (summary.service.toLowerCase().includes(q)) return true;
  return summary.operations.some(
    (op) =>
      op.title.toLowerCase().includes(q) ||
      op.id.toLowerCase().includes(q) ||
      op.description.toLowerCase().includes(q) ||
      (op.summary?.toLowerCase().includes(q) ?? false),
  );
}

export function ServiceCatalog(): JSX.Element {
  // Pilot: React Compiler, annotation mode. ServiceCatalog is the
  // operator's landing screen — three chained useMemo derivations
  // (groups/yourTeamSlugs/visibleGroups) recompute by hand today; no
  // render-phase side effects (useCurrentUser/useTeams are the
  // subscribed store hooks, not raw module-state reads), so it's safe for
  // the compiler to take over wholesale.
  'use memo';
  // null = not loaded yet (distinct from a loaded-but-empty catalog, which is
  // what a project with no vendored data now honestly returns — see api.ts).
  const [manifests, setManifests] = useState<ServiceManifest[] | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [query, setQuery] = useState('');
  const projectId = useActiveProjectId();
  // The active project's CLOUD provider (0039 S1 lane L) — an absent field
  // means aws, the same wire convention every provider-aware seam reads (see
  // lib/beyondCatalog.ts). Manifests are shared across projects on differing
  // providers, so the catalog must only ever offer THIS project's provider's
  // services.
  const provider = useProject().provider ?? 'aws';

  useEffect(() => {
    let alive = true;
    // Back to the loading state first, so a project switch never leaves the
    // previous project's catalog on screen while the new fetch is in flight.
    setManifests(null);
    setInventory(null);
    void api.listManifests().then((m) => {
      if (alive) setManifests(m);
    });
    void api.getInventory().then((inv) => {
      if (alive) setInventory(inv);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const groups = useMemo(
    () => deriveServiceCatalog(manifests ?? [], inventory ?? undefined, provider),
    [manifests, inventory, provider],
  );

  // Services owned by the signed-in user's team get a calm "your team" chip.
  // Others stay fully browsable — the console never hides a service.
  // User/teams are now live (useCurrentUser/useTeams), and this memo's
  // dependency array names them — previously `[]` cached this ONCE per mount,
  // so an admin moving you to another team (or re-assigning your team's
  // services) only ever showed up after a full remount.
  const user = useCurrentUser();
  const teams = useTeams();
  const yourTeamSlugs = useMemo(() => {
    const team = teamFor(user, teams);
    return new Set(team?.serviceSlugs ?? []);
  }, [user, teams]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return groups;
    return groups
      .map((group) => ({
        category: group.category,
        services: group.services.filter((s) => matchesQuery(s, q)),
      }))
      .filter((group) => group.services.length > 0);
  }, [groups, query]);

  const hasResults = visibleGroups.length > 0;

  // Header meta (Ledger "data authority" line, top-right of the page head):
  // only what this page already has on hand — total live resources and
  // service count across the WHOLE catalog (unaffected by the search query
  // below it). The mockup's other two lines ("N awaiting your approval",
  // "baseline N days old") need data this page doesn't fetch — approvals
  // queue depth, baseline staleness — so per the plan's data-authority rule
  // they're omitted here rather than plumbed in for one screen.
  const totalResources = useMemo(
    () => groups.reduce((n, g) => n + g.services.reduce((m, s) => m + s.counts.resources, 0), 0),
    [groups],
  );
  const totalServices = useMemo(() => groups.reduce((n, g) => n + g.services.length, 0), [groups]);

  return (
    <div className="catalog">
      <header className="catalog__head">
        <div className="catalog__head-main">
          <p className="page-eyebrow">Infrastructure control</p>
          <h1 className="catalog__title">Change your infrastructure</h1>
          <p className="catalog__sub">
            Pick a service, see its resources, and request a change. No code to write — and nothing
            applies until a senior reviews and approves it.
          </p>
        </div>
        {totalServices > 0 && (
          <div className="catalog__headmeta">
            {totalResources.toLocaleString()} <b>resources</b> · {totalServices}{' '}
            {totalServices === 1 ? 'service' : 'services'}
          </div>
        )}
      </header>

      <div className="catalog__controls" role="group" aria-label="Catalog controls">
        <div className="catalog__search">
          <span className="catalog__search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            className="catalog__search-input"
            placeholder="Search services and operations"
            aria-label="Search services and operations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {manifests === null ? (
        <p className="catalog__empty">Loading services…</p>
      ) : manifests.length === 0 ? (
        <p className="catalog__empty">This account’s data hasn’t been loaded yet.</p>
      ) : !hasResults ? (
        <p className="catalog__empty">No services or operations match “{query.trim()}”.</p>
      ) : (
        visibleGroups.map((group, idx) => {
          const groupResources = group.services.reduce((n, s) => n + s.counts.resources, 0);
          return (
            <section key={group.category} className="catalog__section">
              <div className="catalog__rail">
                <div className="catalog__secnum" aria-hidden="true">
                  {String(idx + 1).padStart(2, '0')}
                </div>
                <h2 className="catalog__secname">{group.category}</h2>
                <div className="catalog__seccount">
                  {group.services.length} {group.services.length === 1 ? 'service' : 'services'} ·{' '}
                  {groupResources.toLocaleString()}{' '}
                  {groupResources === 1 ? 'resource' : 'resources'}
                </div>
              </div>
              <div className="catalog__rows">
                {group.services.map((summary) => (
                  <ServiceCard
                    key={summary.service}
                    summary={summary}
                    yourTeam={yourTeamSlugs.has(summary.service)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}

      {/* The escape hatch beyond the curated tiles, always reachable (even a
          dead-end search leaves a way forward) and unaffected by the query above,
          since it is not part of the manifest catalog it searches over: the
          "What do you need?" chooser — provision ANY provisionable resource type
          (drafts a reviewed create) or describe something genuinely new. */}
      <section className="catalog__more">
        <Link to="/services/request-new" className="console__add-card">
          <span className="console__add-glyph" aria-hidden="true">
            +
          </span>
          <span className="console__add-body">
            <span className="console__add-title">Provision or request something new</span>
            <span className="console__add-desc">
              Need a resource type the tiles above don’t cover, or a whole service with no Terraform
              resource yet? Pick any provisionable type or describe it — it drafts a reviewed create
              (or routes to an engineer), with the same approvals.
            </span>
          </span>
        </Link>
      </section>
    </div>
  );
}
