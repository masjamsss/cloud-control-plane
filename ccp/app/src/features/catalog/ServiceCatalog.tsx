import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { Inventory, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { attempt } from '@/lib/asyncGuard';
import { LoadError } from '@/components/LoadError';
import { deriveServiceCatalog, type ServiceSummary } from '@/lib/catalog';
import { useActiveProjectId, useProject } from '@/lib/ProjectContext';
import { useCurrentUser } from '@/lib/session';
import { teamFor } from '@/lib/permissions';
import { useTeams } from '@/lib/teams';
import { ServiceCard } from './ServiceCard';
import { CategoryNav, type CategoryNavItem } from './CategoryNav';
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

/** The section's DOM id — the jump-rail chip's scroll target. Categories are a
 * closed, human-authored set (lib/serviceMeta CATEGORY_ORDER), so a plain
 * slug is stable and collision-free. Exported for the gate in
 * src/test/catalogNav.test.tsx: a collision between two categories would point
 * both their chips at the same section, which nothing else would catch. */
export function sectionId(category: string): string {
  return `cat-${category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}`;
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
  // Two narrowing filters over the same browse (never a hiding rule — both
  // default off, and the count line below always says what is being withheld).
  // "Your team" answers the question this landing screen gets asked most, and
  // could not be asked before: of 156 browsable services, which ones are mine?
  const [teamOnly, setTeamOnly] = useState(false);
  const [withResourcesOnly, setWithResourcesOnly] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
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
    setLoadError(null);
    // FE-2/UI-1: both calls throw in api mode, and `manifests === null` is the
    // LOADING sentinel — so a rejected fetch left "Loading services…" on the
    // catalog for ever. Fetched together rather than as two independent `.then`s:
    // a half-loaded catalog (services with no inventory) renders wrong counts,
    // which is worse than saying plainly that it could not load.
    void attempt(() => Promise.all([api.listManifests(), api.getInventory()])).then((outcome) => {
      if (!alive) return;
      if (!outcome.ok) {
        setLoadError(outcome.reason);
        return;
      }
      const [m, inv] = outcome.value;
      setManifests(m);
      setInventory(inv);
    });
    return () => {
      alive = false;
    };
  }, [projectId, reloadToken]);

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
    if (q.length === 0 && !teamOnly && !withResourcesOnly) return groups;
    return groups
      .map((group) => ({
        category: group.category,
        services: group.services.filter(
          (s) =>
            (q.length === 0 || matchesQuery(s, q)) &&
            (!teamOnly || yourTeamSlugs.has(s.service)) &&
            (!withResourcesOnly || s.counts.resources > 0),
        ),
      }))
      .filter((group) => group.services.length > 0);
  }, [groups, query, teamOnly, withResourcesOnly, yourTeamSlugs]);

  const hasResults = visibleGroups.length > 0;
  const narrowed = query.trim().length > 0 || teamOnly || withResourcesOnly;

  // The jump rail's chips, and the count line beside them — both read off the
  // SAME visibleGroups the sections render, so filtering can never leave a chip
  // pointing at a section that isn't there.
  const navItems = useMemo<CategoryNavItem[]>(
    () =>
      visibleGroups.map((group) => ({
        id: sectionId(group.category),
        label: group.category,
        count: group.services.length,
      })),
    [visibleGroups],
  );
  const shownServices = useMemo(
    () => visibleGroups.reduce((n, g) => n + g.services.length, 0),
    [visibleGroups],
  );

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

  const clearAll = useCallback(() => {
    setQuery('');
    setTeamOnly(false);
    setWithResourcesOnly(false);
  }, []);

  // The sticky control bar's real height, published to CSS as --catalog-stick:
  // what every section's scroll-margin-top clears, and where the sticky
  // category rail parks. Measured rather than hardcoded because the bar reflows
  // at several widths (the count line wraps below the filters, then the search
  // takes a row of its own) — a static value is right at exactly one of them and
  // hides a heading under the chrome at the others. A ResizeObserver also keeps
  // it correct for anything a static breakpoint can't know about: the user's
  // font size, a longer translated filter label, or a control added here later.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const bar = controlsRef.current;
    if (!root || !bar || typeof ResizeObserver === 'undefined') return;
    const apply = (): void => {
      // + the 60px app bar the control bar pins under, + 8px so a heading
      // clears its bottom rule rather than touching it.
      root.style.setProperty('--catalog-stick', `${Math.round(bar.offsetHeight) + 68}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [hasResults]);

  return (
    <div className="catalog" ref={rootRef}>
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

      <div
        className="catalog__controls"
        role="group"
        aria-label="Catalog controls"
        ref={controlsRef}
      >
        <div className="catalog__controls-row">
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

          <div className="catalog__filters">
            {yourTeamSlugs.size > 0 && (
              <button
                type="button"
                className={`catalog__filter${teamOnly ? ' catalog__filter--on' : ''}`}
                aria-pressed={teamOnly}
                onClick={() => setTeamOnly((on) => !on)}
              >
                Your team
              </button>
            )}
            <button
              type="button"
              className={`catalog__filter${withResourcesOnly ? ' catalog__filter--on' : ''}`}
              aria-pressed={withResourcesOnly}
              onClick={() => setWithResourcesOnly((on) => !on)}
            >
              With resources
            </button>
            {narrowed && (
              <button type="button" className="catalog__clear" onClick={clearAll}>
                Clear
              </button>
            )}
          </div>

          {/* Polite, not assertive: the count updates on every keystroke, and an
              assertive region would interrupt the screen-reader user mid-word. */}
          <p className="catalog__count" aria-live="polite">
            {manifests === null
              ? ''
              : `${shownServices} of ${totalServices} ${totalServices === 1 ? 'service' : 'services'}`}
          </p>
        </div>

        {hasResults && <CategoryNav items={navItems} />}
      </div>

      {loadError !== null ? (
        <LoadError
          message={loadError}
          what="the service catalog"
          onRetry={() => setReloadToken((n) => n + 1)}
        />
      ) : manifests === null ? (
        <p className="catalog__empty">Loading services…</p>
      ) : manifests.length === 0 ? (
        <p className="catalog__empty">This account’s data hasn’t been loaded yet.</p>
      ) : !hasResults ? (
        <div className="catalog__empty">
          <p className="catalog__empty-line">
            {query.trim().length > 0
              ? `No services or operations match “${query.trim()}”.`
              : 'No services match the filters you have on.'}
          </p>
          <button type="button" className="catalog__filter" onClick={clearAll}>
            Clear search and filters
          </button>
        </div>
      ) : (
        visibleGroups.map((group, idx) => {
          const groupResources = group.services.reduce((n, s) => n + s.counts.resources, 0);
          return (
            <section
              key={group.category}
              id={sectionId(group.category)}
              className="catalog__section"
            >
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
