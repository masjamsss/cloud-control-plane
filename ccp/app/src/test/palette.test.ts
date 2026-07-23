import { describe, expect, it } from 'vitest';
import type {
  ChangeRequest,
  InventoryResource,
  ManifestOperation,
  ServiceManifest,
  User,
} from '@/types';
import { minQueryToShowResources, resourceToPaletteItem } from '@/components/CommandPalette';
import { manifests as realManifests } from '@/data/manifests';
import { providerOfType } from '@/lib/providerDisplay';
import {
  buildPaletteSections,
  estimateMountedRowCount,
  filterPaletteSections,
  firstSelectableRowIndex,
  flattenPaletteSections,
  isSelectableRow,
  lastSelectableRowIndex,
  matchesPaletteQuery,
  nextSelectableRowIndex,
  PALETTE_HEADER_PX,
  PALETTE_OVERSCAN,
  PALETTE_ROW_PX,
  shouldShowResources,
  type PaletteEntry,
  type PaletteEntryRow,
  type PaletteRow,
} from '@/lib/palette';

/**
 * Task 2: the command palette extends over requests and estate resources. The
 * Resources group is gated behind a minimum query length so 1,300+ inventory
 * items never mount at dialog-open time (cmdk handles the actual fuzzy match
 * once mounted) — these tests cover the pure pieces of that: the resource →
 * palette-item mapping, and the gate constant itself.
 */

function resource(overrides: Partial<InventoryResource> = {}): InventoryResource {
  return {
    address: 'aws_ebs_volume.app01_sdd',
    resourceType: 'aws_ebs_volume',
    service: 'ebs',
    attributes: {},
    ...overrides,
  };
}

describe('resourceToPaletteItem — pure mapping from an estate resource to a palette entry', () => {
  it('case 1 (named): label is the resource name', () => {
    const item = resourceToPaletteItem(resource({ name: 'app01_sdd' }));
    expect(item.label).toBe('app01_sdd');
    expect(item.keywords).toContain('app01_sdd');
  });

  it('case 2 (unnamed → address): label falls back to the Terraform address', () => {
    const item = resourceToPaletteItem(resource({ name: undefined }));
    expect(item.label).toBe('aws_ebs_volume.app01_sdd');
  });

  it('case 3 (service route): resources have no detail page, so `to` is the service console', () => {
    const item = resourceToPaletteItem(resource({ service: 'ebs' }));
    expect(item.to).toBe('/services/ebs');
  });
});

describe('minQueryToShowResources — the mount gate for the Resources group', () => {
  it('is exactly 2 characters', () => {
    expect(minQueryToShowResources).toBe(2);
  });
});

/**
 * 0008 §4 Task 4 — "palette scale fixes". cmdk's own README documents
 * `shouldFilter={false}` + externally-filtered items as the supported way
 * to combine it with virtualization; everything below is that external
 * filter/rank/window layer, kept DOM-free (this app has no jsdom/RTL) so it
 * is unit-testable on its own — CommandPalette.tsx is a thin consumer.
 */

function fixtureUser(overrides: Partial<User> = {}): User {
  return { id: 'u1', name: 'Test User', role: 'requester', teamId: 't1', ...overrides };
}

function fixtureOp(overrides: Partial<ManifestOperation> = {}): ManifestOperation {
  return {
    id: 'fixture-op',
    service: 'fixture',
    macd: 'Change',
    codemodOp: 'set_attribute',
    title: 'Fixture operation',
    description: 'A fixture operation for palette tests.',
    target: { resourceType: 'aws_fixture_resource' },
    params: [],
    riskFloor: 'LOW',
    reversible: true,
    downtime: 'none',
    exposure: 'l1_self_service',
    forcesReplace: false,
    autoEligible: false,
    terraformCapability: 'fixture',
    group: 'connectivity-access',
    ...overrides,
  };
}

function fixtureManifest(overrides: Partial<ServiceManifest> = {}): ServiceManifest {
  return {
    service: 'fixture',
    scope: 'estate',
    resourceTypes: ['aws_fixture_resource'],
    summary: 'Fixture service',
    operations: [],
    ...overrides,
  };
}

function fixtureRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'req-1',
    requester: 'u1',
    service: 'fixture',
    operationId: 'fixture-op',
    macd: 'Change',
    targetAddress: 'aws_fixture_resource.x',
    params: {},
    justification: 'because',
    exposure: 'l1_self_service',
    risk: 'LOW',
    status: 'AWAITING_CODE_REVIEW',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

describe("buildPaletteSections — the palette's section/entry model", () => {
  it('always includes Go to, Services, Operations, Resources, and Actions, in that order', () => {
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: [],
      resources: [],
      myRequests: [],
      showResources: false,
    });
    expect(sections.map((s) => s.id)).toEqual(['nav', 'services', 'ops', 'resources', 'actions']);
  });

  it('inserts "My requests" between Operations and Resources, only when there are any', () => {
    const withReq = buildPaletteSections({
      user: fixtureUser(),
      manifests: [],
      resources: [],
      myRequests: [fixtureRequest()],
      showResources: false,
    });
    expect(withReq.map((s) => s.id)).toEqual([
      'nav',
      'services',
      'ops',
      'requests',
      'resources',
      'actions',
    ]);
  });

  it('Resources entries are empty when showResources is false, present when true (0025 RX-1: the caller now passes this boolean, not the raw query)', () => {
    const resource: InventoryResource = {
      address: 'aws_ebs_volume.x',
      resourceType: 'aws_ebs_volume',
      service: 'ebs',
      attributes: {},
    };
    const below = buildPaletteSections({
      user: fixtureUser(),
      manifests: [],
      resources: [resource],
      myRequests: [],
      showResources: false,
    });
    const at = buildPaletteSections({
      user: fixtureUser(),
      manifests: [],
      resources: [resource],
      myRequests: [],
      showResources: true,
    });
    expect(below.find((s) => s.id === 'resources')!.entries).toHaveLength(0);
    expect(at.find((s) => s.id === 'resources')!.entries).toHaveLength(1);
  });

  it('op entries carry the source ManifestOperation, for the row-level OpChips', () => {
    const m = fixtureManifest({ operations: [fixtureOp({ id: 'x', riskFloor: 'HIGH' })] });
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: [m],
      resources: [],
      myRequests: [],
      showResources: false,
    });
    const opEntry = sections.find((s) => s.id === 'ops')!.entries[0]!;
    expect(opEntry.op?.id).toBe('x');
    expect(opEntry.op?.riskFloor).toBe('HIGH');
  });

  it('disabled ops are excluded from the Operations section (unchanged rule, carried into Task 4)', () => {
    // isOpDisabled reads admin settings from localStorage — with none set,
    // every fixture op is enabled, so this documents the call is still made
    // (a regression that dropped the isOpDisabled filter would only show up
    // once an op is actually disabled, which is exercised by settings.test.ts).
    const m = fixtureManifest({ operations: [fixtureOp({ id: 'enabled-op' })] });
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: [m],
      resources: [],
      myRequests: [],
      showResources: false,
    });
    expect(sections.find((s) => s.id === 'ops')!.entries.map((e) => e.id)).toEqual([
      'op:enabled-op',
    ]);
  });
});

describe('Services section browses at portal parity — 155 named azure services, 156 named aws (full provisionable coverage incl. op-less)', () => {
  function servicesFor(provider: 'aws' | 'azure') {
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: realManifests,
      resources: [],
      myRequests: [],
      showResources: false,
      provider,
    });
    return sections.find((s) => s.id === 'services')!.entries;
  }

  it('an azure-scoped palette surfaces all 155 NAMED azure services incl. op-less (not the 16 manifest slugs)', () => {
    const services = servicesFor('azure');
    expect(services).toHaveLength(155);
    // Named services, keyed by their tile slug — vm/sql/cosmos, never azure-compute.
    expect(services.some((e) => e.id === 'service:vm')).toBe(true);
    expect(services.some((e) => e.id === 'service:sql')).toBe(true);
    expect(services.some((e) => e.id === 'service:cosmos')).toBe(true);
    expect(services.some((e) => e.id === 'service:azure-compute')).toBe(false);
    // Each entry routes to its named-service tile.
    const vm = services.find((e) => e.id === 'service:vm')!;
    expect(vm.title).toBe('Virtual Machines');
    expect(vm.to).toBe('/services/vm');
  });

  it('an aws-scoped palette surfaces all 156 NAMED aws services incl. op-less (not the 57 manifest slugs)', () => {
    const services = servicesFor('aws');
    expect(services).toHaveLength(156);
    expect(services.some((e) => e.id === 'service:ec2')).toBe(true);
    expect(services.some((e) => e.id === 'service:s3')).toBe(true);
    // A long-tail named service, and NOT its family manifest slug.
    expect(services.some((e) => e.id === 'service:athena')).toBe(true);
    expect(services.some((e) => e.id === 'service:aws-analytics')).toBe(false);
  });
});

describe('shouldShowResources — the single source of truth for the Resources-section gate (0025 RX-1)', () => {
  it('is false below minQueryToShowResources, true at/above it', () => {
    expect(shouldShowResources('')).toBe(false);
    expect(shouldShowResources('a')).toBe(false);
    expect(shouldShowResources('ab')).toBe(true);
    expect(shouldShowResources('abc')).toBe(true);
  });

  it('trims whitespace before measuring length, like the pre-RX-1 inline check did', () => {
    expect(shouldShowResources('  a  ')).toBe(false);
    expect(shouldShowResources('  ab  ')).toBe(true);
  });
});

describe("matchesPaletteQuery — the manual filter cmdk's own scorer is replaced with", () => {
  const entry: PaletteEntry = {
    kind: 'op',
    id: 'op:x',
    title: 'Resize an instance',
    searchText: 'op resize an instance ec2 ec2-resize',
    to: '/services/ec2/ec2-resize',
  };

  it('empty query matches everything', () => {
    expect(matchesPaletteQuery(entry, '')).toBe(true);
    expect(matchesPaletteQuery(entry, '   ')).toBe(true);
  });

  it('matches a case-insensitive substring of the search haystack', () => {
    expect(matchesPaletteQuery(entry, 'RESIZE')).toBe(true);
    expect(matchesPaletteQuery(entry, 'ec2-resize')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesPaletteQuery(entry, 'delete')).toBe(false);
  });
});

describe('filterPaletteSections — drops sections with no matches, keeps the rest', () => {
  const sections = [
    {
      id: 'nav',
      heading: 'Go to',
      entries: [
        { kind: 'nav', id: 'nav:1', title: 'Home', searchText: 'home', to: '/' } as PaletteEntry,
      ],
    },
    {
      id: 'ops',
      heading: 'Operations',
      entries: [
        { kind: 'op', id: 'op:1', title: 'Reboot', searchText: 'reboot', to: '/x' } as PaletteEntry,
      ],
    },
  ];

  it('empty query returns every non-empty section unchanged', () => {
    expect(filterPaletteSections(sections, '')).toEqual(sections);
  });

  it('a query matching only one section drops the other entirely', () => {
    const filtered = filterPaletteSections(sections, 'reboot');
    expect(filtered.map((s) => s.id)).toEqual(['ops']);
  });

  it('a query matching nothing returns no sections', () => {
    expect(filterPaletteSections(sections, 'zzz-no-match')).toEqual([]);
  });
});

describe('flattenPaletteSections — one header row per non-empty section, then its entries', () => {
  it('empty sections contribute no header row', () => {
    const rows = flattenPaletteSections([
      { id: 'a', heading: 'A', entries: [] },
      {
        id: 'b',
        heading: 'B',
        entries: [{ kind: 'nav', id: 'x', title: 'X', searchText: 'x', to: '/x' }],
      },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['header:b', 'x']);
  });

  it('preserves section order and entry order within each section', () => {
    const rows = flattenPaletteSections([
      {
        id: 'a',
        heading: 'A',
        entries: [
          { kind: 'nav', id: 'a1', title: 'A1', searchText: 'a1', to: '/a1' },
          { kind: 'nav', id: 'a2', title: 'A2', searchText: 'a2', to: '/a2' },
        ],
      },
      {
        id: 'b',
        heading: 'B',
        entries: [{ kind: 'nav', id: 'b1', title: 'B1', searchText: 'b1', to: '/b1' }],
      },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['header:a', 'a1', 'a2', 'header:b', 'b1']);
  });
});

describe('isSelectableRow / row navigation — pure, DOM-free keyboard nav for the virtualized list', () => {
  const rows: PaletteRow[] = [
    { kind: 'header', id: 'h1', label: 'Section 1' },
    { kind: 'nav', id: 'a', title: 'A', searchText: 'a', to: '/a', sectionId: 's1' },
    { kind: 'nav', id: 'b', title: 'B', searchText: 'b', to: '/b', sectionId: 's1' },
    { kind: 'header', id: 'h2', label: 'Section 2' },
    { kind: 'nav', id: 'c', title: 'C', searchText: 'c', to: '/c', sectionId: 's2' },
  ];

  it('isSelectableRow is false for headers, true for entries', () => {
    expect(isSelectableRow(rows[0]!)).toBe(false);
    expect(isSelectableRow(rows[1]!)).toBe(true);
  });

  it('firstSelectableRowIndex skips a leading header', () => {
    expect(firstSelectableRowIndex(rows)).toBe(1); // 'a'
  });

  it('lastSelectableRowIndex finds the trailing entry past the last header', () => {
    expect(lastSelectableRowIndex(rows)).toBe(4); // 'c'
  });

  it('firstSelectableRowIndex/lastSelectableRowIndex return -1 for an all-header list', () => {
    const headersOnly: PaletteRow[] = [{ kind: 'header', id: 'h', label: 'Empty' }];
    expect(firstSelectableRowIndex(headersOnly)).toBe(-1);
    expect(lastSelectableRowIndex(headersOnly)).toBe(-1);
  });

  it('nextSelectableRowIndex(+1) skips the header between sections', () => {
    expect(nextSelectableRowIndex(rows, 2, 1)).toBe(4); // 'b' -> skip h2 -> 'c'
  });

  it('nextSelectableRowIndex(-1) skips a header going backward too', () => {
    expect(nextSelectableRowIndex(rows, 4, -1)).toBe(2); // 'c' -> skip h2 -> 'b'
  });

  it("clamps at the end — no wraparound (matches this app's cmdk usage, which never sets loop)", () => {
    expect(nextSelectableRowIndex(rows, 4, 1)).toBe(4); // already last selectable row
  });

  it('clamps at the start — no wraparound', () => {
    expect(nextSelectableRowIndex(rows, 1, -1)).toBe(1); // already first selectable row
  });
});

describe('op-intent search resolves to the OP row itself, never only a service card', () => {
  it('a query matching an operation\'s id yields an "op" row', () => {
    const m = fixtureManifest({
      service: 'ec2',
      operations: [fixtureOp({ id: 'ec2-reboot-instance', title: 'Reboot the instance' })],
    });
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: [m],
      resources: [],
      myRequests: [],
      showResources: shouldShowResources('reboot'),
    });
    const rows = flattenPaletteSections(filterPaletteSections(sections, 'reboot'));
    const opRows = rows.filter((r): r is PaletteEntryRow & { kind: 'op' } => r.kind === 'op');
    expect(opRows).toHaveLength(1);
    expect(opRows[0]!.title).toBe('Reboot the instance');
  });

  it('does not require a service-name match — the op is reachable purely on its own title', () => {
    // getServiceMeta('ec2') resolves to display name "EC2" — "reboot" appears
    // nowhere in "EC2"/"ec2", so this specifically proves the op is NOT
    // riding along on a Services-section match.
    const m = fixtureManifest({
      service: 'ec2',
      operations: [fixtureOp({ id: 'ec2-reboot-instance', title: 'Reboot the instance' })],
    });
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: [m],
      resources: [],
      myRequests: [],
      showResources: shouldShowResources('reboot'),
    });
    const filtered = filterPaletteSections(sections, 'reboot');
    expect(filtered.find((s) => s.id === 'services')).toBeUndefined();
    expect(filtered.find((s) => s.id === 'ops')).toBeDefined();
  });

  it('holds against the real multi-provider catalog too (ec2-resize, not the EC2 service card)', () => {
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: realManifests,
      resources: [],
      myRequests: [],
      showResources: shouldShowResources('ec2-resize'),
    });
    const rows = flattenPaletteSections(filterPaletteSections(sections, 'ec2-resize'));
    const opRows = rows.filter((r): r is PaletteEntryRow & { kind: 'op' } => r.kind === 'op');
    expect(opRows.some((r) => r.id === 'op:ec2-resize')).toBe(true);
  });
});

describe('estimateMountedRowCount — palette DOM node count stays bounded (0008 §4 Task 4)', () => {
  it("mirrors react-virtual's windowing formula: visible rows + overscan on both sides, clamped to total", () => {
    expect(estimateMountedRowCount(1000, 400, 40, 10)).toBe(30); // ceil(400/40)=10, +2*10=30
    expect(estimateMountedRowCount(5, 400, 40, 10)).toBe(5); // fewer rows than fit on screen — clamped
  });

  it('stays under 100 for the real multi-provider catalog with NO resources shown', () => {
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: realManifests,
      resources: [],
      myRequests: [],
      showResources: false,
    });
    const rows = flattenPaletteSections(filterPaletteSections(sections, ''));
    expect(rows.length).toBeGreaterThan(700); // the ~712-723 item scale the decision doc measured
    const mounted = estimateMountedRowCount(rows.length, 446, PALETTE_ROW_PX, PALETTE_OVERSCAN);
    expect(mounted).toBeLessThan(100);
  });

  it('stays under 100 even with a 1,300-resource estate and a 2-char query showing them all', () => {
    const resources: InventoryResource[] = Array.from({ length: 1300 }, (_, i) => ({
      address: `aws_ebs_volume.vol_${i}`,
      resourceType: 'aws_ebs_volume',
      service: 'ebs',
      attributes: {},
    }));
    const sections = buildPaletteSections({
      user: fixtureUser(),
      manifests: realManifests,
      resources,
      myRequests: [],
      showResources: shouldShowResources('vo'), // >= minQueryToShowResources, matches every synthetic resource
    });
    const rows = flattenPaletteSections(filterPaletteSections(sections, 'vo'));
    expect(rows.length).toBeGreaterThan(1300); // 1,300 resources + whatever else still matches "vo"
    const mounted = estimateMountedRowCount(rows.length, 446, PALETTE_ROW_PX, PALETTE_OVERSCAN);
    expect(mounted).toBeLessThan(100);
  });

  it('the header row estimate is smaller than the item row estimate (shorter row, still bounded)', () => {
    expect(PALETTE_HEADER_PX).toBeLessThan(PALETTE_ROW_PX);
  });
});

/**
 * 0034 D6/G12 — ticket vocabulary. Tickets say "disk full", not "Grow an EBS
 * volume"; every manifest `keywords` phrase is a Part-1 scenario trigger and
 * must surface its op among the FIRST THREE op matches in the palette. Driven
 * from the manifest data itself so every future keyword is automatically held
 * to the same contract — a keyword that stops finding its op fails here, not
 * in an operator's 3 AM search.
 */
describe('ticket-vocabulary keywords find their op in the palette top 3 (0034 D6)', () => {
  const keywordOps = realManifests
    .flatMap((m) => m.operations)
    .filter(
      (op): op is ManifestOperation & { keywords: string[] } =>
        Array.isArray(op.keywords) && op.keywords.length > 0,
    );

  it('the core catalog carries a real keyword corpus (sanity)', () => {
    expect(keywordOps.length).toBeGreaterThanOrEqual(60);
  });

  // The palette is provider-scoped (0039 auto-wire): an aws project's palette shows
  // only aws ops, an azure project's only azurerm ops. So each provider's keyword
  // vocabulary is checked against ITS OWN scoped palette — the 282 auto-wired azure
  // tag ops (carrying no keywords) can never dilute an aws ticket phrase's ranking,
  // and each provider's keyword ops still resolve inside their own catalog.
  it.each(['aws', 'azure'] as const)(
    'every %s keyword phrase resolves to its op within the first 3 op matches (provider-scoped palette)',
    (provider) => {
      const sections = buildPaletteSections({
        user: fixtureUser(),
        manifests: realManifests,
        resources: [],
        myRequests: [],
        showResources: false,
        provider,
      });
      const providerOps = keywordOps.filter(
        (op) => providerOfType(op.target.resourceType) === provider,
      );
      const failures: string[] = [];
      for (const op of providerOps) {
        for (const phrase of op.keywords) {
          const rows = flattenPaletteSections(filterPaletteSections(sections, phrase));
          const opRows = rows.filter((r): r is PaletteEntryRow => r.kind === 'op');
          const rank = opRows.findIndex((r) => r.id === `op:${op.id}`);
          if (rank === -1 || rank >= 3) {
            const ahead = opRows.slice(0, 3).map((r) => r.id.replace(/^op:/, ''));
            failures.push(
              `"${phrase}" → ${op.id} ranked ${rank === -1 ? 'NOT FOUND' : rank + 1}; top: ${ahead.join(', ')}`,
            );
          }
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    },
  );
});
