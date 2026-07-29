import { describe, expect, it } from 'vitest';
import type { ServiceManifest } from '@/types';
import { catalogServiceKey, manifestForServiceSlug } from '@/lib/catalog';

/**
 * UI-2 — resource drill-in dead-ended for every "named service".
 *
 * `ServiceConsole` groups ops and resources under named-service slugs via
 * `catalogServiceKey`, so a slug like `vm`, `sql` or `aks` is real to the browse tile and
 * to every `ResourceRow` link — while no manifest FILE carries that name. `ResourceDetail`
 * resolved with a literal `manifests.find(m => m.service === slug)` and therefore rendered
 * "No service named “vm”" on arrival. The audit measured 194 named services with ops but
 * no literal manifest slug, and all 16 azure-fixture services broken.
 *
 * The property being pinned is **agreement**: the drill-in must resolve a slug the same way
 * the list that linked to it does. Both callers now share one function, and the last test
 * here is the one that matters — for every slug the console can group, the resolver must
 * return something.
 */

function op(resourceType: string, id = `op-${resourceType}`) {
  return {
    id,
    title: id,
    description: '',
    macd: 'Change',
    exposure: 'l1_self_service',
    target: { resourceType },
    params: [],
  } as unknown as ServiceManifest['operations'][number];
}

function manifest(service: string, types: string[], summary = ''): ServiceManifest {
  return {
    service,
    scope: 'estate',
    summary: summary || service,
    operations: types.map((t) => op(t)),
    resourceTypes: types,
  } as unknown as ServiceManifest;
}

describe('a named-service slug resolves to a manifest (UI-2)', () => {
  it('THE DEFECT: a slug with no manifest FILE still resolves, via the ops that key to it', () => {
    // `azurerm_linux_virtual_machine` keys to the named service "vm"; the manifest file is
    // called something else. A literal find returns undefined and the page dead-ends.
    const ms = [manifest('azure-compute', ['azurerm_linux_virtual_machine'])];
    const slug = catalogServiceKey('azurerm_linux_virtual_machine', 'azure-compute');
    expect(slug, 'precondition: this type groups under a NAMED slug').not.toBe('azure-compute');

    expect(ms.find((m) => m.service === slug), 'the old literal lookup finds nothing').toBeUndefined();
    const got = manifestForServiceSlug(ms, slug);
    expect(got, 'the drill-in must resolve what the list linked to').toBeDefined();
    expect(got?.service).toBe(slug);
    expect(got?.operations.length).toBeGreaterThan(0);
  });

  it('gathers ops across MULTIPLE manifests that key to the same slug', () => {
    // A curated slug collects family ops from other files too, so the drill-in shows the
    // same op set the browse tile counted — not just one manifest's contribution.
    const a = manifest('azure-compute', ['azurerm_linux_virtual_machine']);
    const b = manifest('azure-tags', ['azurerm_linux_virtual_machine']);
    const slug = catalogServiceKey('azurerm_linux_virtual_machine', 'azure-compute');
    expect(manifestForServiceSlug([a, b], slug)?.operations).toHaveLength(2);
  });

  it('resolves a bare manifest slug navigated directly', () => {
    // No op keys to "lonely", so there are no contributions — the literal manifest is the
    // right answer, and dropping that branch would break every real manifest slug.
    const ms = [manifest('lonely', [])];
    expect(manifestForServiceSlug(ms, 'lonely')?.service).toBe('lonely');
  });

  it('returns undefined for a slug that names nothing at all', () => {
    // A genuine "no such service" must stay reportable — the fix must not invent a
    // manifest for a typo'd URL, which would turn a clear error into an empty page.
    expect(manifestForServiceSlug([manifest('a', [])], 'nonexistent')).toBeUndefined();
  });

  it('picks the dominant manifest for the scope/summary base', () => {
    const big = manifest('big', ['azurerm_linux_virtual_machine']);
    big.operations = [op('azurerm_linux_virtual_machine', 'x1'), op('azurerm_linux_virtual_machine', 'x2')];
    const small = manifest('small', ['azurerm_linux_virtual_machine']);
    const slug = catalogServiceKey('azurerm_linux_virtual_machine', 'big');
    const got = manifestForServiceSlug([small, big], slug);
    // `summary` comes from the dominant file — the synthesized manifest overrides
    // `service` with the slug, so summary is what identifies which file supplied the base.
    expect(got?.summary).toBe('big');
    expect(got?.operations).toHaveLength(3);
  });

  it('AGREEMENT: every slug the console can group resolves — none dead-ends', async () => {
    // The property the finding is actually about, over the real bundled catalog rather
    // than a fixture. Any slug a ResourceRow can link to must resolve, or that row is a
    // dead end exactly as before.
    const { manifests } = (await import('@/data/manifests')) as { manifests: ServiceManifest[] };
    const slugs = new Set<string>();
    for (const m of manifests) {
      for (const o of m.operations) slugs.add(catalogServiceKey(o.target.resourceType, m.service));
    }
    expect(slugs.size).toBeGreaterThan(50);

    const dead = [...slugs].filter((s) => manifestForServiceSlug(manifests, s) === undefined);
    expect(dead, `slugs the console groups but the drill-in cannot resolve: ${dead.slice(0, 10).join(', ')}`).toEqual([]);
  });
});
