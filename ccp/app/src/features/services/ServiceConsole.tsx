import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Inventory, InventoryResource, ManifestOperation, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId, useProject } from '@/lib/ProjectContext';
import { allBlockSources, type BlockSource } from '@/lib/blockSource';
import { buildResourceFamilies, summarizeChildren, type FamilyRow } from '@/lib/resourceFamily';
import { isOpDisabled, useSettings } from '@/lib/settings';
import { useCurrentUser } from '@/lib/session';
import { canRequest } from '@/lib/permissions';
import { resolveRisk } from '@/lib/riskOverrides';
import { getServiceMeta, hasServiceMeta, primaryTypeFor } from '@/lib/serviceMeta';
import { provisionPathFor } from '@/lib/providerCatalog';
import { catalogServiceKey } from '@/lib/catalog';
import { useTeams } from '@/lib/teams';
import { isProvisionAdd, isResourceScopedAdd, isScopedAction } from '@/lib/actionPicker';
import {
  allSelected,
  deselectAll,
  isBulkableAction,
  selectAll,
  toggleSelection,
} from '@/lib/changeSet';
import { projectCalendarAgeDays } from '@/lib/datetime';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { ServiceIcon } from '@/components/ServiceIcon';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { Badge } from '@/components/ui/Badge';
import { ActionPicker } from '@/components/ActionPicker';
import { OpDescription } from '@/components/OpDescription';
import { BulkActionBar } from './BulkActionBar';
import { opHeadline } from '@/lib/opText';
import { stripProviderPrefix } from '@/lib/providerDisplay';
import { OrientationNote } from './OrientationNote';
import { ResourceRow } from './ResourceRow';
import { VirtualRows } from './VirtualRows';
import './console.css';

/** Human-friendly label for an AWS resource type (aws_db_instance → Db Instance). */
function humanizeType(resourceType: string): string {
  return stripProviderPrefix(resourceType)
    .split('_')
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Rows shown per type before the "Show all" control appears. */
const GROUP_CAP = 20;

/** Beyond this many rows, an expanded group is windowed instead of fully rendered. */
const VIRTUAL_THRESHOLD = 40;

/** Case-insensitive match across a resource's name, address, and setting values. */
function matchResource(r: InventoryResource, q: string): boolean {
  const s = q.toLowerCase();
  if ((r.name ?? '').toLowerCase().includes(s)) return true;
  if (r.address.toLowerCase().includes(s)) return true;
  return Object.values(r.attributes).some((v) => String(v).toLowerCase().includes(s));
}

/** A row matches when the resource itself does, or anything rolled up under it
 * does — filtering by "versioning" or a policy's setting still finds the bucket. */
function matchRow(row: FamilyRow, q: string): boolean {
  return matchResource(row.resource, q) || row.children.some((c) => matchResource(c, q));
}

/**
 * Bundle-data vintage line: this list is a build-time
 * snapshot, not a live read, and the standing "Live from the Terraform
 * baseline" label claimed otherwise even while it was five days stale. An
 * unqualified "live" is banned for snapshot data — this
 * can only ever claim its own capture vintage, never present-tense currency.
 */
export function formatVintage(inventory: Inventory): string {
  if (!inventory.generatedAt) return 'Baseline (vintage unknown — not built from a git checkout)';
  const sha = inventory.sourceCommit ? ` · ${inventory.sourceCommit.slice(0, 7)}` : '';
  return `Baseline as of ${inventory.generatedAt}${sha}`;
}

/**
 * Days after which the vintage chip turns warning-toned. The number comes
 * from the incident the vintage line exists to remember: the
 * committed inventory once ran five days stale, undetected, while labeled
 * "Live". The CI freshness gate should make any staleness impossible on a
 * healthy pipeline — so an age at or past the incident's own measure is
 * exactly when an operator should stop trusting "current" and say so.
 */
export const BASELINE_STALE_DAYS = 5;

export interface VintageAge {
  /** Relative-age copy: "updated today" / "1 day old" / "N days old". */
  label: string;
  /** True at/past {@link BASELINE_STALE_DAYS} — renders warning-toned. */
  stale: boolean;
}

/**
 * Relative age of the baseline snapshot: render-time
 * computed from `generatedAt`, no timers (the cooling panel's standing
 * doctrine). Days are counted on the project's own calendar (its configured
 * timezone), not the viewer's, via
 * projectCalendarAgeDays. Null when the bundle carries no vintage — the
 * vintage line already states that case honestly, and a chip must never
 * fabricate an age it doesn't have.
 */
export function vintageAge(inventory: Inventory, now: Date = new Date()): VintageAge | null {
  const days = projectCalendarAgeDays(inventory.generatedAt ?? undefined, now);
  if (days === null) return null;
  const label = days === 0 ? 'updated today' : days === 1 ? '1 day old' : `${days} days old`;
  return { label, stale: days >= BASELINE_STALE_DAYS };
}

export function ServiceConsole(): JSX.Element {
  const { service } = useParams<{ service: string }>();
  const slug = service ?? '';

  // null = not loaded yet (distinct from a loaded-but-empty catalog, which is
  // what a project with no vendored data now honestly returns — see api.ts).
  const [manifests, setManifests] = useState<ServiceManifest[] | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const projectId = useActiveProjectId();

  // The committed HCL corpus — the rollup's join evidence (which config entry
  // references which parent). Bundled chunks, no network; on any load failure
  // the empty corpus degrades to the flat one-group-per-type list, never an
  // error state.
  const [blocks, setBlocks] = useState<Record<string, BlockSource> | null>(null);

  useEffect(() => {
    let alive = true;
    // Back to the loading state first, so a project switch never leaves the
    // previous project's resources on screen while the new fetch is in flight.
    setManifests(null);
    setInventory(null);
    setBlocks(null);
    void api.listManifests().then((m) => {
      if (alive) setManifests(m);
    });
    void api.getInventory().then((inv) => {
      if (alive) setInventory(inv);
    });
    void allBlockSources().then(
      (b) => {
        if (alive) setBlocks(b);
      },
      () => {
        if (alive) setBlocks({});
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId]);

  const manifest = useMemo(() => {
    const all = manifests ?? [];
    // A real manifest slug (every AWS service, and legacy azure-* keys) resolves
    // directly. A portal-parity NAMED service (e.g. "vm", "sql") has no manifest
    // of its own — synthesize one from the ops whose catalogServiceKey is this
    // slug, across the (already provider-filtered) manifests, so its console
    // renders exactly the ops the browse tile grouped under it.
    // Gather EVERY op whose catalogServiceKey is this slug, across all manifests —
    // for a curated slug (e.g. ec2) this now includes the family tag-ops that key
    // to it from other files, not just its own manifest, so the console op set
    // matches the browse tile's count. contributions===0 means either an op-less
    // named service (→ undefined, so the Provision CTA renders) or a bare manifest
    // slug navigated directly (→ its manifest).
    const contributions = all
      .map((m) => ({
        m,
        ops: m.operations.filter(
          (op) => catalogServiceKey(op.target.resourceType, m.service) === slug,
        ),
      }))
      .filter((c) => c.ops.length > 0);
    if (contributions.length === 0) return all.find((m) => m.service === slug);
    // dominant manifest = the file contributing the most ops (its scope/summary base)
    const dominant = contributions.reduce((a, b) => (b.ops.length > a.ops.length ? b : a));
    const operations = contributions.flatMap((c) => c.ops);
    const resourceTypes = [...new Set(operations.map((op) => op.target.resourceType))];
    return { ...dominant.m, service: slug, operations, resourceTypes };
  }, [manifests, slug]);
  // The active project's provider disambiguates the three slugs both clouds name
  // ('batch','dms','resource-groups') so this console shows the same identity its
  // browse tile did (getServiceMeta docblock); harmless for every other slug.
  const provider = useProject().provider ?? 'aws';
  const meta = getServiceMeta(slug, provider);
  // The representative provisionable type this service's "Provision" action
  // deep-links to (/provision/<service>?type=…). Present for all but the few
  // services with no provisionable type at all (ops-only — no Provision action).
  const provisionType = primaryTypeFor(slug, provider);
  // Live — an admin freeze/disable elsewhere (this tab or another)
  // re-derives mayRequest/actionsFor/addOps without a navigation. `settings`
  // itself isn't read below (isOpDisabled() still does that, from the same
  // cache) — it's a memo dependency so a settings change actually invalidates
  // these memos, exactly like the palette build stage (CommandPalette.tsx).
  const user = useCurrentUser();
  const teams = useTeams();
  const settings = useSettings();
  const mayRequest = canRequest(user, slug, teams);

  /**
   * Actions available on a given resource type, feeding both the ResourceRow
   * shortlist and the scoped picker it opens (admin-disabled operations are
   * hidden from both). Two families, both scoped by target.resourceType:
   *   - every Change/Delete/Move op (isScopedAction) — Move was folded in
   *     when the 2 Move ops were orphaned from every console
   *     surface;
   *   - the Add ops that OPERATE ON this resource (isResourceScopedAdd) —
   *     papercut #3: "snapshot this disk" / "add a firewall rule" /
   *     "attach a certificate" were unfindable from the resource itself.
   * Provision creates (a new top-level resource) are excluded here and stay in
   * the service-level "Add new" grid below. Pre-fill is automatic: actionHref
   * threads `?target=<address>` into the op's source:"inventory" param, the
   * same path the Change ops use.
   */
  const actionsFor = useMemo(() => {
    return (resourceType: string): ManifestOperation[] =>
      (manifest?.operations ?? []).filter(
        (op) =>
          op.target.resourceType === resourceType &&
          (isScopedAction(op) || isResourceScopedAdd(op)) &&
          !isOpDisabled(op.id),
      );
  }, [manifest, settings]);

  // The scoped picker is ONE shared instance (not one per ResourceRow — a
  // group can render hundreds via VirtualRows), lifted here and opened by
  // whichever row's "All actions…" was clicked.
  const [pickerTarget, setPickerTarget] = useState<{
    resource: InventoryResource;
    actions: ManifestOperation[];
  } | null>(null);
  const openPicker = (resource: InventoryResource, actions: ManifestOperation[]): void =>
    setPickerTarget({ resource, actions });

  /** This service's Add ops, split for the "Add new" section (0034 A8/P3):
   * real provisioning baselines first, attach-and-annotate adds (tags, rules,
   * entries into existing resources) below — never mixed as equal cards. */
  const addOps = useMemo(
    () => (manifest?.operations ?? []).filter((op) => op.macd === 'Add' && !isOpDisabled(op.id)),
    [manifest, settings],
  );
  const provisionOps = useMemo(() => addOps.filter((op) => isProvisionAdd(op)), [addOps]);
  const annotateOps = useMemo(() => addOps.filter((op) => !isProvisionAdd(op)), [addOps]);
  // A with-ops service ALSO gains the generic "Provision <service>" action —
  // but only when it has NO curated create op of its own (else that curated
  // create IS its provision path) and it has a provisionable type to deep-link.
  // This closes the gap for services whose ops are all change/delete, so every
  // service with a provisionable type has a reachable Provision action.
  const showGenericProvision = provisionOps.length === 0 && !!provisionType;

  /**
   * Inventory resources this service manages, console-style: one group per
   * LOGICAL resource type, with Terraform's split-out config types rolled up
   * under their parent rows (lib/resourceFamily.ts holds the rule). A config
   * entry whose parent can't be pinned down stays visible in its own group.
   */
  const families = useMemo(() => {
    if (!manifest || !inventory || !blocks) return null;
    return buildResourceFamilies(manifest.resourceTypes, inventory.resources, blocks);
  }, [manifest, inventory, blocks]);
  const groups = families?.groups ?? [];

  const listedCount = useMemo(() => groups.reduce((n, g) => n + g.rows.length, 0), [groups]);
  const rolledUpCount = families?.rolledUpCount ?? 0;

  // Bulk multi-select (Phase B). Selection is by resource address; a bulk action applies to
  // exactly ONE resource type (an op targets one type), so the bar only offers actions when
  // the selection is a single type. Read-only viewers (mayRequest=false) never see checkboxes,
  // so they can never assemble a change they cannot submit.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (address: string): void => setSelected((s) => toggleSelection(s, address));
  const selectedResources = useMemo(() => {
    if (selected.size === 0 || !inventory) return [];
    const byAddr = new Map(inventory.resources.map((r) => [r.address, r]));
    return [...selected]
      .map((a) => byAddr.get(a))
      .filter((r): r is InventoryResource => r !== undefined);
  }, [selected, inventory]);
  const selectedTypes = useMemo(
    () => [...new Set(selectedResources.map((r) => r.resourceType))],
    [selectedResources],
  );
  const bulkActions = useMemo(() => {
    if (selectedTypes.length !== 1) return [];
    return actionsFor(selectedTypes[0]!).filter(isBulkableAction);
  }, [selectedTypes, actionsFor]);
  const rowSelection = mayRequest
    ? { isSelected: (a: string): boolean => selected.has(a), onToggle: toggleSelect }
    : undefined;

  const [query, setQuery] = useState('');
  // Keep the filter input responsive at estate scale: typing updates `query`
  // immediately, but the (up to ~1,300-resource) filter recomputes off a deferred
  // value so keystrokes never block paint.
  const deferredQuery = useDeferredValue(query);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (t: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const q = deferredQuery.trim();
  const isStale = query.trim() !== q;
  const noMatches = q.length > 0 && groups.every((g) => g.rows.every((row) => !matchRow(row, q)));

  const crumbs = [{ label: 'Catalog', to: '/' }, { label: meta.displayName }];

  if (manifests !== null && manifests.length === 0) {
    return (
      <div className="console">
        <Breadcrumbs items={crumbs} />
        <div className="console__empty">This account’s data hasn’t been loaded yet.</div>
      </div>
    );
  }

  if (manifests !== null && !manifest) {
    // A KNOWN named service with no catalogued op (the long tail full coverage
    // adds) is NOT an error: render its identity + a direct "Provision <service>"
    // call-to-action into the generic provision form, never a dead "no service"
    // state. Only a genuinely unknown slug falls through to that.
    if (hasServiceMeta(slug)) {
      return (
        <div className="console">
          <Breadcrumbs items={crumbs} />
          <header className="console__header">
            <div className="console__head-main">
              <div className="console__head-top">
                <ServiceIcon slug={slug} size={32} />
                <h1 className="console__title">{meta.displayName}</h1>
              </div>
              <p className="console__summary">
                No catalogued changes for {meta.displayName} yet — you can still provision a new
                one.
              </p>
            </div>
          </header>

          <section className="console__section" aria-labelledby="add-new">
            <div className="console__section-head">
              <h2 className="console__section-title" id="add-new">
                Add new
              </h2>
              <span className="console__section-note">Provision a new {meta.displayName}</span>
            </div>
            {provisionType ? (
              <div className="console__add-grid" aria-labelledby="add-new">
                <Link className="console__add-card" to={provisionPathFor(provisionType)}>
                  <span className="console__add-glyph" aria-hidden="true">
                    +
                  </span>
                  <span className="console__add-body">
                    <span className="console__add-title">Provision a new {meta.displayName}</span>
                    <span className="console__add-desc">
                      Drafts a reviewed create for an engineer to complete — same approvals, nothing
                      applies on its own.
                    </span>
                  </span>
                </Link>
              </div>
            ) : (
              <p className="console__readonly" role="note">
                {meta.displayName} has no provisionable resource type. To request something here,{' '}
                <Link to="/services/request-new">describe what you need</Link>.
              </p>
            )}
          </section>
        </div>
      );
    }
    return (
      <div className="console">
        <Breadcrumbs items={crumbs} />
        <div className="console__empty">No service named “{slug}”.</div>
      </div>
    );
  }

  if (!manifest || !inventory || !families) {
    return (
      <div className="console">
        <Breadcrumbs items={crumbs} />
        <div className="console__loading">Loading service…</div>
      </div>
    );
  }

  // Render-time age, no timers — recomputed on any re-render, which is
  // exactly as fresh as a snapshot's age ever needs to be.
  const age = vintageAge(inventory);

  return (
    <div className="console">
      <Breadcrumbs items={crumbs} />

      <header className="console__header">
        <div className="console__head-main">
          <p className="page-eyebrow">{meta.category}</p>
          <div className="console__head-top">
            <ServiceIcon slug={slug} size={32} />
            <h1 className="console__title">{meta.displayName}</h1>
          </div>
          <p className="console__summary">{manifest.summary}</p>
        </div>
        {/* Data-authority header meta (Ledger contract #4) — the baseline's own
            vintage/freshness (unchanged logic, just relocated from the
            "Your resources" section note below it) plus the estate total,
            mirroring catalog.css's .catalog__headmeta treatment. */}
        <div className="console__headmeta">
          {formatVintage(inventory)}
          {age && (
            <>
              {' '}
              <Badge
                color={age.stale ? 'warn' : 'muted'}
                title={
                  age.stale
                    ? 'This snapshot is older than the pipeline should ever leave it — changes merged since may not appear here yet.'
                    : undefined
                }
              >
                {age.label}
              </Badge>
            </>
          )}
          <br />
          <b>{listedCount.toLocaleString()}</b>{' '}
          {rolledUpCount > 0
            ? `listed · ${rolledUpCount.toLocaleString()} more shown with the resource they belong to`
            : listedCount === 1
              ? 'resource total'
              : 'resources total'}
        </div>
      </header>

      {/* D16: the one-line task header — every service page states its next
          step before anything else (rendered above "Your resources"). */}
      <OrientationNote />

      {/* Task 4: same-page anchors, visible only when there is more than one
          section to jump between — "Your resources" always exists, so this
          gates on "Add new" existing too. */}
      {addOps.length > 0 && (
        <nav className="console__subnav" aria-label="Sections on this page">
          <a href="#your-resources" className="console__subnav-link">
            Your resources
          </a>
          <a href="#add-new" className="console__subnav-link">
            Add new
          </a>
        </nav>
      )}

      {!mayRequest && (
        <p className="console__readonly" role="note">
          You’re browsing {meta.displayName}. Requests here are handled by another team, so you can
          look but not submit. Your team’s services are available from the Catalog.
        </p>
      )}

      <section className="console__section" aria-labelledby="your-resources">
        <div className="console__section-head console__section-head--tools">
          <h2 className="console__section-title" id="your-resources">
            Your resources
          </h2>
          {listedCount + rolledUpCount > GROUP_CAP && (
            <div className="console__filter">
              <span className="console__filter-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                type="search"
                className="console__filter-input"
                placeholder="Filter by name, id, or setting"
                aria-label="Filter resources"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className={isStale ? 'console__groups console__groups--stale' : 'console__groups'}>
          {groups.map((group) => {
            const filtered = q ? group.rows.filter((row) => matchRow(row, q)) : group.rows;
            // While filtering, hide types with no match rather than showing an empty shell.
            if (q && filtered.length === 0) return null;
            const isOpen = expanded.has(group.resourceType);
            const visible = isOpen ? filtered : filtered.slice(0, GROUP_CAP);
            const countLabel = q
              ? `${filtered.length.toLocaleString()} of ${group.rows.length.toLocaleString()}`
              : group.rows.length.toLocaleString();

            const groupAddresses = filtered.map((row) => row.resource.address);
            const groupAllSelected = allSelected(selected, groupAddresses);

            return (
              <div className="console__group" key={group.resourceType}>
                <div className="console__group-head">
                  {rowSelection && filtered.length > 0 && (
                    <label
                      className="console__group-select"
                      title={`Select all ${humanizeType(group.resourceType)} for a bulk change`}
                    >
                      <input
                        type="checkbox"
                        className="console__group-select-box"
                        checked={groupAllSelected}
                        aria-label={`Select all ${humanizeType(group.resourceType)} for a bulk change`}
                        onChange={() =>
                          setSelected((s) =>
                            groupAllSelected
                              ? deselectAll(s, groupAddresses)
                              : selectAll(s, groupAddresses),
                          )
                        }
                      />
                    </label>
                  )}
                  <span className="console__group-title">{humanizeType(group.resourceType)}</span>
                  <span className="console__group-count">{countLabel}</span>
                </div>

                {group.childType && (
                  <p className="console__group-note" role="note">
                    These normally appear with the resource they configure — these entries couldn’t
                    be matched to exactly one resource in this baseline, so they’re listed on their
                    own.
                  </p>
                )}

                {group.rows.length === 0 ? (
                  <div className="console__group-empty">
                    No {humanizeType(group.resourceType)} resources in the baseline yet.
                  </div>
                ) : (
                  <>
                    <div className="console__rows" id={`rows-${group.resourceType}`}>
                      {isOpen && filtered.length > VIRTUAL_THRESHOLD ? (
                        // Windowed once expanded past the threshold (UIUX-4).
                        <VirtualRows
                          rows={filtered}
                          serviceSlug={slug}
                          actionsFor={actionsFor}
                          onOpenPicker={openPicker}
                          selection={rowSelection}
                        />
                      ) : (
                        visible.map((row) => (
                          <ResourceRow
                            key={row.resource.address}
                            serviceSlug={slug}
                            resource={row.resource}
                            actions={actionsFor(row.resource.resourceType)}
                            childSummary={summarizeChildren(
                              row.children,
                              row.resource.resourceType,
                            )}
                            onOpenPicker={openPicker}
                            selection={
                              rowSelection
                                ? {
                                    selected: selected.has(row.resource.address),
                                    onToggle: toggleSelect,
                                  }
                                : undefined
                            }
                          />
                        ))
                      )}
                    </div>
                    {filtered.length > GROUP_CAP && (
                      <button
                        type="button"
                        className="console__group-more"
                        aria-expanded={isOpen}
                        aria-controls={`rows-${group.resourceType}`}
                        onClick={() => toggleExpand(group.resourceType)}
                      >
                        {isOpen ? 'Show fewer' : `Show all ${filtered.length.toLocaleString()}`}
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {noMatches && <div className="console__group-empty">No resources match “{q}”.</div>}
        </div>

        {rowSelection && (
          <BulkActionBar
            serviceSlug={slug}
            selectedAddresses={selectedResources.map((r) => r.address)}
            selectedTypes={selectedTypes}
            actions={bulkActions}
            onClear={() => setSelected(new Set())}
          />
        )}
      </section>

      {(addOps.length > 0 || showGenericProvision) && (
        <section className="console__section" aria-labelledby="add-new">
          <div className="console__section-head">
            <h2 className="console__section-title" id="add-new">
              Add new
            </h2>
            <span className="console__section-note">
              {provisionOps.length > 0 || showGenericProvision
                ? `Provision a new resource in ${meta.displayName}`
                : `Add to existing ${meta.displayName} resources`}
            </span>
          </div>

          {provisionOps.length > 0 && (
            <>
              {annotateOps.length > 0 && (
                <h3 className="console__add-subtitle" id="add-provision">
                  Provision
                </h3>
              )}
              <div
                className="console__add-grid"
                aria-labelledby={annotateOps.length > 0 ? 'add-provision' : 'add-new'}
              >
                {provisionOps.map((op) => (
                  <Link
                    key={op.id}
                    className="console__add-card"
                    to={'/services/' + slug + '/' + op.id}
                  >
                    <span className="console__add-glyph" aria-hidden="true">
                      +
                    </span>
                    <span className="console__add-body">
                      <span className="console__add-title">{opHeadline(op)}</span>
                      <OpDescription op={op} variant="card" />
                    </span>
                    <RiskBadge risk={resolveRisk(op)} />
                  </Link>
                ))}
              </div>
            </>
          )}

          {annotateOps.length > 0 && (
            <>
              {provisionOps.length > 0 && (
                <h3 className="console__add-subtitle" id="add-annotate">
                  Attach &amp; annotate
                </h3>
              )}
              <div
                className="console__add-grid"
                aria-labelledby={provisionOps.length > 0 ? 'add-annotate' : 'add-new'}
              >
                {annotateOps.map((op) => (
                  <Link
                    key={op.id}
                    className="console__add-card"
                    to={'/services/' + slug + '/' + op.id}
                  >
                    <span className="console__add-glyph" aria-hidden="true">
                      +
                    </span>
                    <span className="console__add-body">
                      <span className="console__add-title">{opHeadline(op)}</span>
                      <OpDescription op={op} variant="card" />
                    </span>
                    <RiskBadge risk={resolveRisk(op)} />
                  </Link>
                ))}
              </div>
            </>
          )}

          {/* The generic provision action — a with-ops service with no curated
              create still deep-links into the provision form for its type. */}
          {showGenericProvision && provisionType && (
            <div className="console__add-grid" aria-labelledby="add-new">
              <Link className="console__add-card" to={provisionPathFor(provisionType)}>
                <span className="console__add-glyph" aria-hidden="true">
                  +
                </span>
                <span className="console__add-body">
                  <span className="console__add-title">Provision a new {meta.displayName}</span>
                  <span className="console__add-desc">
                    Drafts a reviewed create for an engineer to complete — same approvals, nothing
                    applies on its own.
                  </span>
                </span>
              </Link>
            </div>
          )}
        </section>
      )}

      {pickerTarget && (
        <ActionPicker
          open
          onOpenChange={(next) => {
            if (!next) setPickerTarget(null);
          }}
          serviceSlug={slug}
          resource={pickerTarget.resource}
          actions={pickerTarget.actions}
        />
      )}
    </div>
  );
}

export default ServiceConsole;
