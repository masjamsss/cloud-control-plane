import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { CatalogIndex } from '@/lib/providerCatalog';
import { groupProviderServices, serviceMatches } from '@/lib/providerCatalog';
import { useSettings } from '@/lib/settings';

/**
 * STEP 1 of "What do you need?" — the SERVICE-CENTRIC provision catalog:
 * one "Provision a new …" card per AWS SERVICE the pinned Terraform provider
 * supports (every service, generated from the provider's own schema — not
 * just the services this estate already runs), grouped by plain categories.
 * A card opens the service's provision page, where a hand-authored estate
 * form is preferred when one exists and a schema-generated form covers
 * everything else. The free-text tail survives below for anything that is
 * genuinely not an AWS resource.
 *
 * Granular add/change actions (tags, rules, attachments…) deliberately do
 * NOT appear here any more — they live on the service consoles and resource
 * pages they operate on.
 *
 * OP-5: this page used to sell only the provision path — the describe-it
 * escape hatch (the "Anything else" tail button, still below) was the last
 * thing on a ~7,600px catalog with no mention anywhere above it. The intro
 * now says the option exists, and a persistent anchor right under it (never
 * gated on the search query or the provider index having loaded) puts the
 * SAME `onPickTail` action above the fold, before the tile grid.
 */
export function ProvisionCatalog({
  index,
  onPickTail,
}: {
  index: CatalogIndex | null;
  onPickTail: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  // LD-4: reuses the same subscribed settings snapshot every other submit
  // surface reads (lib/settings.ts) — AppShell's banner already says the
  // estate is frozen; this is the more specific "you're about to spend time
  // on a form that can't submit yet" notice right at the entry to this one.
  const frozen = useSettings().changeFreeze;

  const groups = useMemo(() => (index ? groupProviderServices(index) : []), [index]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return groups;
    return groups
      .map((g) => ({ category: g.category, services: g.services.filter((s) => serviceMatches(s, q)) }))
      .filter((g) => g.services.length > 0);
  }, [groups, query]);

  const totalServices = index?.services.length ?? 0;
  const totalTypes = useMemo(
    () => (index ? index.services.reduce((n, s) => n + s.types.length, 0) : 0),
    [index],
  );

  return (
    <div className="bc-chooser">
      <p className="rq-desc">
        Every AWS service the platform can provision, straight from its Terraform provider —
        not just what this estate already runs. Pick a service to see what you can stand up and
        every parameter it takes. Nothing applies without review and approval. Not an AWS
        resource, or not on this list at all? Describe it instead — see below.
      </p>

      {frozen && (
        <p className="bc-frozen-notice" role="note">
          Change requests are frozen by an administrator right now. You can still fill this out,
          but it won’t submit until the freeze is lifted.
        </p>
      )}

      {/* OP-5: the persistent escape hatch, above the fold and independent of
          the search query or how many services have loaded — the same
          onPickTail the "Anything else" card at the foot of the list also
          uses, so both routes land in the identical describe-it form. */}
      <button type="button" className="bc-describe-anchor" onClick={onPickTail}>
        Can’t find it? Describe it instead →
      </button>

      {index && (
        <div className="pv-meta">
          {totalServices} services · {totalTypes.toLocaleString()} resource types · provider
          version {index.providerVersion}
        </div>
      )}

      <div className="catalog__search pv-search">
        <span className="catalog__search-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          type="search"
          className="catalog__search-input"
          placeholder="Search services and resource types"
          aria-label="Search services and resource types"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {index === null ? (
        <p className="catalog__empty">Loading the service list…</p>
      ) : visibleGroups.length === 0 ? (
        <p className="catalog__empty">No services match “{query.trim()}”.</p>
      ) : (
        visibleGroups.map((group) => (
          <section key={group.category} className="bc-chooser__section">
            <h2 className="bc-chooser__category">
              {group.category}
              <span className="pv-count"> · {group.services.length}</span>
            </h2>
            <div className="console__add-grid">
              {group.services.map((service) => (
                <Link key={service.slug} className="console__add-card" to={`/provision/${service.slug}`}>
                  <span className="console__add-glyph" aria-hidden="true">
                    +
                  </span>
                  <span className="console__add-body">
                    <span className="console__add-title">Provision a new {service.name} resource</span>
                    <span className="console__add-desc">
                      {service.types.length === 1 && service.types[0]
                        ? service.types[0].label
                        : `${service.types.length} kinds of resource to choose from`}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}

      <section className="bc-chooser__section">
        <h2 className="bc-chooser__category">Anything else</h2>
        <button type="button" className="console__add-card bc-chooser__tail" onClick={onPickTail}>
          <span className="console__add-glyph" aria-hidden="true">
            ?
          </span>
          <span className="console__add-body">
            <span className="console__add-title">Something that isn’t on this list</span>
            <span className="console__add-desc">
              Describe it in a structured request — it routes to an engineer with the same
              approvals as everything else.
            </span>
          </span>
        </button>
      </section>
    </div>
  );
}
