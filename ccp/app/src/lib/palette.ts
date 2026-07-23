import type {
  ChangeRequest,
  InventoryResource,
  ManifestOperation,
  ServiceManifest,
  User,
} from '@/types';
import { getSettings } from '@/lib/settings';
import { getServiceMeta } from '@/lib/serviceMeta';
import { catalogServiceKey } from '@/lib/catalog';
import { AZURE_SERVICES } from '@/lib/azureServiceMap';
import { AWS_SERVICES } from '@/lib/awsServiceMap';
import { providerOfType, type CloudProvider } from '@/lib/providerDisplay';
import { getOperation } from '@/lib/interpreter';
import { beyondCatalogTitle, isBeyondCatalogRequest } from '@/lib/beyondCatalog';
import { provisionRequestTitle } from '@/lib/providerCatalog';
import { BOUNDARY_PAGE_PATH, boundaryItems } from '@/lib/boundary';
import { getInstanceIdentity } from '@/lib/instanceIdentity';

/**
 * Pure data layer for the global command palette.
 * CommandPalette.tsx used to hand cmdk ~712+ Command.Item
 * children and let its built-in shouldFilter mount-everything-then-hide
 * behavior do the searching; cmdk itself documents this doesn't scale
 * (virtualization requires `shouldFilter={false}` + externally-filtered
 * items — see cmdk's README "Or disable filtering and sorting entirely").
 * Everything here is DOM-free so it is directly testable (this app has no
 * jsdom/RTL — see src/test/setup.ts) and is exactly what CommandPalette.tsx
 * feeds into one @tanstack/react-virtual instance over the whole list.
 */

/* ── Nav ──────────────────────────────────────────────────────────────────── */

export interface NavItem {
  to: string;
  label: string;
}

export function navItemsFor(user: User): NavItem[] {
  const items: NavItem[] = [
    { to: '/', label: 'Home — services' },
    { to: '/requests', label: 'My requests' },
  ];
  if (user.role === 'approver' || user.role === 'lead')
    items.push({ to: '/approvals', label: 'Approvals' });
  if (user.role === 'lead') {
    items.push({ to: '/dashboard', label: 'Dashboard' });
    items.push({ to: '/admin', label: 'Admin' });
  }
  return items;
}

/* ── Resources — unchanged contract from the pre-Task-4 palette ────────────── */

/**
 * Minimum characters typed before the Resources section is even built. The
 * estate inventory runs to 1,000+ items; gating construction (not just
 * display) keeps a short/empty query cheap regardless of estate size.
 */
export const minQueryToShowResources = 2;

/**
 * Whether the Resources section should be materialized for a given query —
 * the single source of truth for the {@link minQueryToShowResources} gate.
 * Pulled out to a named predicate so the expensive *build* stage
 * can depend on this boolean instead of the raw query string: the caller
 * feeds it the deferred query, so `buildPaletteSections` only re-runs when
 * the gate actually flips, not on every keystroke (see CommandPalette.tsx).
 */
export function shouldShowResources(query: string): boolean {
  return query.trim().length >= minQueryToShowResources;
}

export interface ResourcePaletteItem {
  label: string;
  keywords: string;
  to: string;
}

/**
 * Pure — an estate resource has no detail page of its own, so every resource
 * routes to its service console. Exported for testing without mounting the
 * dialog (kept byte-identical to the pre-Task-4 version — palette.test.ts's
 * existing cases must keep passing unchanged).
 */
export function resourceToPaletteItem(r: InventoryResource): ResourcePaletteItem {
  return {
    label: r.name ?? r.address,
    keywords: [r.name, r.address, r.resourceType, r.service].filter(Boolean).join(' '),
    to: `/services/${r.service ?? ''}`,
  };
}

/** A short, glanceable id fragment — full UUIDs are too long for a one-line item. */
function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 8);
}

/** "AWAITING_CODE_REVIEW" → "awaiting code review" — quiet secondary text. */
function humanizeStatus(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ');
}

/* ── Flat entry/row model ────────────────────────────────────────────────── */

export type PaletteEntryKind = 'nav' | 'service' | 'op' | 'request' | 'resource' | 'action';

export interface PaletteEntry {
  kind: PaletteEntryKind;
  /** Stable id — also the cmdk Command.Item `value` once shouldFilter is
   * manual, so it must be unique across the WHOLE palette, not just its section. */
  id: string;
  title: string;
  /** Secondary, right-aligned text (service name, status, resource type…). */
  hint?: string;
  /** Short leading glyph/monogram/id fragment, when the entry has one. */
  mono?: string;
  /** Lowercased haystack this entry matches against — see matchesPaletteQuery. */
  searchText: string;
  to: string;
  /** Set only for kind:"op" — lets the row renderer show the OpChips risk/
   * exposure row without a second lookup back into the manifests. */
  op?: ManifestOperation;
}

export interface PaletteSection {
  id: string;
  heading: string;
  entries: PaletteEntry[];
}

export interface PaletteHeaderRow {
  kind: 'header';
  id: string;
  label: string;
}

/** An entry row, tagged with the section it belongs to. */
export type PaletteEntryRow = PaletteEntry & { sectionId: string };

export type PaletteRow = PaletteHeaderRow | PaletteEntryRow;

const norm = (s: string): string => s.toLowerCase();

export interface BuildPaletteSectionsInput {
  user: User;
  manifests: ServiceManifest[];
  resources: InventoryResource[];
  myRequests: ChangeRequest[];
  /** Active project's cloud provider — scopes services+ops to that provider
   * (0039 auto-wire), mirroring the service catalog's filter. Omit for the
   * full unscoped catalog (the pre-0039 behavior). */
  provider?: CloudProvider;
  /** Whether to materialize the Resources section — see {@link shouldShowResources}.
   * A boolean, not the raw query string: the caller memoizes this build on
   * `[user, manifests, resources, myRequests, showResources]`, so retyping
   * within the same show/hide state (the overwhelming majority of keystrokes)
   * never re-runs this function at all (was previously keyed off
   * the query string itself, rebuilding all ~680 ops on every keystroke). */
  showResources: boolean;
}

/**
 * Build every section's full entry list (before filtering by search text —
 * that is {@link filterPaletteSections}'s job, run separately at deferred
 * priority by CommandPalette.tsx). Resources are only materialized when the
 * caller says so ({@link shouldShowResources}) — gating construction, not
 * just rendering, is what keeps a short/empty query cheap against a
 * 1,000+ resource estate.
 *
 * Disabled-ops settings are read exactly ONCE per call here,
 * not once per operation (was: 680 `getSettings()` calls — each a fresh
 * localStorage read + JSON.parse + clamp — every time this ran).
 */
export function buildPaletteSections({
  user,
  manifests: allManifests,
  resources,
  myRequests,
  showResources,
  provider,
}: BuildPaletteSectionsInput): PaletteSection[] {
  const disabledOps = new Set(getSettings().disabledOps);
  // Provider scoping (0039 auto-wire): the palette, like the service catalog
  // (deriveServiceCatalog), shows only the ACTIVE project's provider's services —
  // an aws project's palette never surfaces azurerm ops and vice versa. A manifest's
  // provider is its first resourceType's (single-provider is gate-enforced). Omitting
  // `provider` (undefined) keeps the whole catalog, the pre-scoping behavior.
  const manifests = provider
    ? allManifests.filter((m) => providerOfType(m.resourceTypes?.[0] ?? '') === provider)
    : allManifests;

  const nav: PaletteEntry[] = navItemsFor(user).map((n) => ({
    kind: 'nav',
    id: `nav:${n.to}`,
    title: n.label,
    searchText: norm(`nav ${n.label}`),
    to: n.to,
  }));

  // Services browse at portal parity (mirrors deriveServiceCatalog): one entry
  // per NAMED service (catalogServiceKey), so an azure project surfaces its ~135
  // service tiles and an aws project its 30 — never one-per-manifest for azure.
  // Keys are collected in first-seen order across the provider-scoped ops.
  const serviceKeys: string[] = [];
  const seenServiceKeys = new Set<string>();
  for (const m of manifests) {
    for (const op of m.operations) {
      const key = catalogServiceKey(op.target.resourceType, m.service);
      if (seenServiceKeys.has(key)) continue;
      seenServiceKeys.add(key);
      serviceKeys.push(key);
    }
  }
  // Op-less services — in the provider's tile map but with no catalogued op — so
  // the palette matches the browse (every provisionable service is searchable);
  // their /services/<slug> console renders the Provision CTA. Unscoped = both clouds.
  const opLessMaps =
    provider === 'azure'
      ? [AZURE_SERVICES]
      : provider === 'aws'
        ? [AWS_SERVICES]
        : [AZURE_SERVICES, AWS_SERVICES];
  for (const map of opLessMaps) {
    for (const key of Object.keys(map)) {
      if (seenServiceKeys.has(key)) continue;
      seenServiceKeys.add(key);
      serviceKeys.push(key);
    }
  }
  const services: PaletteEntry[] = serviceKeys.map((key) => {
    const meta = getServiceMeta(key, provider);
    return {
      kind: 'service',
      id: `service:${key}`,
      title: meta.displayName,
      hint: key,
      mono: meta.monogram,
      searchText: norm(`service ${meta.displayName} ${key}`),
      to: `/services/${key}`,
    };
  });

  const ops: PaletteEntry[] = manifests.flatMap((m) => {
    const meta = getServiceMeta(m.service, provider);
    return m.operations
      .filter((op) => !disabledOps.has(op.id))
      .map((op): PaletteEntry => ({
        kind: 'op',
        id: `op:${op.id}`,
        title: op.title,
        hint: meta.displayName,
        // Ticket vocabulary: an op's manifest `keywords`
        // ("disk full", "open port") join its haystack so tickets' words find
        // ops whose titles speak Terraform.
        searchText: norm(
          `op ${op.title} ${meta.displayName} ${op.id} ${(op.keywords ?? []).join(' ')}`,
        ),
        to: `/services/${m.service}/${op.id}`,
        op,
      }));
  });

  const requests: PaletteEntry[] = myRequests.map((r) => {
    const op = getOperation(r.operationId, manifests);
    const title = isBeyondCatalogRequest(r)
      ? beyondCatalogTitle(r)
      : (op?.title ?? provisionRequestTitle(r));
    return {
      kind: 'request',
      id: `request:${r.id}`,
      title,
      hint: humanizeStatus(r.status),
      mono: shortId(r.id),
      searchText: norm(`request ${title} ${r.id} ${r.status}`),
      to: `/requests/${r.id}`,
    };
  });

  const resourceEntries: PaletteEntry[] = showResources
    ? resources.map((r) => {
        const item = resourceToPaletteItem(r);
        // Secondary line = the tf ADDRESS when the row is named:
        // three volumes of one host share a name and resourceType,
        // so a `resourceType`-only hint collapses them into identical,
        // unpickable rows — the address (`aws_ebs_volume.app01_sdb`) is the
        // disambiguator and already carries the type in its prefix. When the
        // resource is unnamed the title already IS the address, so fall back to
        // the resourceType to avoid printing the address twice.
        const named = item.label !== r.address;
        return {
          kind: 'resource',
          id: `resource:${r.address}`,
          title: item.label,
          hint: named ? r.address : r.resourceType,
          searchText: norm(`resource ${item.keywords}`),
          to: item.to,
        };
      })
    : [];

  const actions: PaletteEntry[] = [
    {
      kind: 'action',
      id: 'action:request-new',
      title: 'Request something new…',
      mono: '+',
      searchText: 'action request something new beyond catalog uncatalogued',
      to: '/services/request-new',
    },
    // The out-of-tool boundary: ticket words with no Terraform
    // answer — "reboot", "run backup now", "restore" — must resolve to the
    // honest boundary page, never to silence. One entry per boundary item so
    // the row an operator lands on names their exact ticket shape.
    ...boundaryItems().map((item): PaletteEntry => ({
      kind: 'action',
      id: `boundary:${item.id}`,
      title: item.title,
      hint: `outside ${getInstanceIdentity().name}`,
      searchText: norm(`outside ccp boundary ${item.title} ${item.searchTerms}`),
      to: BOUNDARY_PAGE_PATH,
    })),
  ];

  const sections: PaletteSection[] = [
    { id: 'nav', heading: 'Go to', entries: nav },
    { id: 'services', heading: 'Services', entries: services },
    { id: 'ops', heading: 'Operations', entries: ops },
  ];
  if (requests.length > 0)
    sections.push({ id: 'requests', heading: 'My requests', entries: requests });
  sections.push({ id: 'resources', heading: 'Resources', entries: resourceEntries });
  sections.push({ id: 'actions', heading: 'Actions', entries: actions });
  return sections;
}

/**
 * Case-insensitive substring match against an entry's search haystack — a
 * plain, deterministic replacement for cmdk's built-in fuzzy scorer, run by
 * US so a virtualized subset never needs the full catalog mounted to filter
 * it (cmdk's own scorer requires every candidate Item mounted in the DOM).
 */
export function matchesPaletteQuery(entry: PaletteEntry, query: string): boolean {
  const q = norm(query.trim());
  if (q.length === 0) return true;
  return norm(entry.searchText).includes(q);
}

/**
 * An op that matches the query through an EXPLICIT ticket keyword outranks one
 * that matches only incidentally (its title happens to share a word). Ticket
 * vocabulary is authored on the op it should surface ("parameter group" →
 * rds-change-parameter-group), so a generic auto-wired op that merely contains
 * the words ("Tag a DB parameter group") must not crowd it out of the top
 * results. Returns 0 for a keyword hit, 1 otherwise; non-op entries are always 1
 * (unaffected). The 354 aws / 282 azure tag ops carry no keywords, so this only
 * ever lifts a curated ticket op above the tag tail that shadowed it.
 */
function keywordMatchRank(entry: PaletteEntry, normalizedQuery: string): number {
  const kws = entry.op?.keywords;
  if (kws && kws.some((k) => norm(k).includes(normalizedQuery))) return 0;
  return 1;
}

/**
 * Filter every section's entries by the query, dropping sections left with
 * no matches — cmdk's own Command.Group does the equivalent (auto-hide via
 * the `hidden` attribute) when it owns filtering; here WE own it, so we drop
 * the section outright rather than render an empty header. Within a section the
 * surviving entries are STABLE-sorted so explicit ticket-keyword matches lead
 * (see {@link keywordMatchRank}); Array.prototype.sort is stable, so entries
 * that tie on rank keep their original manifest/op order.
 */
export function filterPaletteSections(sections: PaletteSection[], query: string): PaletteSection[] {
  if (query.trim().length === 0) return sections.filter((s) => s.entries.length > 0);
  const q = norm(query.trim());
  return sections
    .map((s) => ({
      ...s,
      entries: s.entries
        .filter((e) => matchesPaletteQuery(e, query))
        .sort((a, b) => keywordMatchRank(a, q) - keywordMatchRank(b, q)),
    }))
    .filter((s) => s.entries.length > 0);
}

/**
 * Flatten sections into the single row list a single virtualizer windows
 * uniformly: one header row per non-empty section, followed by its entry
 * rows. Group headers are no longer real `Command.Group` elements (those
 * can't be safely windowed — see CommandPalette.tsx) but plain rows the
 * virtualizer treats like any other.
 */
export function flattenPaletteSections(sections: PaletteSection[]): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    rows.push({ kind: 'header', id: `header:${section.id}`, label: section.heading });
    for (const entry of section.entries) rows.push({ ...entry, sectionId: section.id });
  }
  return rows;
}

/** True for a row an operator can land on with the keyboard or pointer. A
 * type predicate (not just boolean) so callers narrow PaletteRow down to
 * PaletteEntryRow — e.g. safely reading `.to` — in the same `if`. */
export function isSelectableRow(row: PaletteRow): row is PaletteEntryRow {
  return row.kind !== 'header';
}

/**
 * Next selectable row index from `from`, skipping header rows, clamped at
 * the list's ends (no wraparound — matches this app's existing cmdk usage,
 * which never sets `loop`). Pure and DOM-free so the virtualized palette's
 * arrow-key handling — which react-virtual's windowing requires the
 * component to own itself, since only a slice of rows is ever mounted — is
 * unit-testable without a single mounted node.
 */
export function nextSelectableRowIndex(rows: PaletteRow[], from: number, delta: 1 | -1): number {
  let i = from + delta;
  while (i >= 0 && i < rows.length && !isSelectableRow(rows[i]!)) i += delta;
  if (i < 0 || i >= rows.length) return from;
  return i;
}

/** The first selectable row's index, or -1 if the list has none. */
export function firstSelectableRowIndex(rows: PaletteRow[]): number {
  return rows.findIndex(isSelectableRow);
}

/** The last selectable row's index, or -1 if the list has none — backs the
 * palette's Home/End handling the same way firstSelectableRowIndex backs
 * the initial highlight (native cmdk Home/End reads mounted DOM order,
 * which only sees the current virtualized window — see CommandPalette.tsx). */
export function lastSelectableRowIndex(rows: PaletteRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isSelectableRow(rows[i]!)) return i;
  }
  return -1;
}

/* ── Virtualization bounds (the "<100 mounted rows" claim) ─────────────────── */

/** Estimated row height in px — plain single-line entries. */
export const PALETTE_ROW_PX = 40;
/** Estimated header row height in px — shorter, matches .cmdp__group heading. */
export const PALETTE_HEADER_PX = 32;
/** Rows kept mounted beyond the visible viewport on each side, for smooth
 * keyboard nav and scrolling. Configured on the SAME useVirtualizer call in
 * CommandPalette.tsx that this constant documents. */
export const PALETTE_OVERSCAN = 12;

/**
 * The number of rows @tanstack/react-virtual will actually mount for a list
 * of `total` rows, given a viewport height and the palette's row/overscan
 * configuration — i.e. an upper bound that does NOT grow with catalog size.
 * Mirrors
 * react-virtual's own windowing formula (rows implied by the viewport, plus
 * overscan on both sides), clamped to `total` once the list fits on one
 * screen. Not a reimplementation of the library — a documented, testable
 * restatement of the same formula using the same constants the component
 * configures useVirtualizer with, so a future change that blows the bound
 * (e.g. an accidentally huge overscan) fails this test, not just a user's
 * scroll-jank report.
 */
export function estimateMountedRowCount(
  total: number,
  viewportPx: number,
  rowPx: number,
  overscan: number,
): number {
  const visible = Math.ceil(viewportPx / rowPx);
  return Math.min(total, visible + overscan * 2);
}
