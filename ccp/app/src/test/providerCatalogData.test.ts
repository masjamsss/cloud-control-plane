import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { providerOfType, type CloudProvider } from '@/lib/providerDisplay';
import { SERVICE_META } from '@/lib/providerCatalogGen';
import { AZURE_SERVICES } from '@/lib/azureServiceMap';
import type { CatalogIndex, CatalogServiceChunk } from '@/lib/providerCatalog';

/**
 * Invariants over the COMMITTED generated catalogs (src/data/provider-catalog
 * for aws, src/data/provider-catalog-azure for azure): comprehensive coverage
 * (this is the whole provider, not the estate's own services), index↔chunk
 * agreement, no computed-only outputs leaking in as inputs, and the hybrid
 * guarantee — every resource type the hand-authored manifests know is present
 * in its provider's generated catalog too.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

interface Tree {
  provider: CloudProvider;
  dir: string;
  providerName: string;
  version: string;
  minServices: number;
  minTypes: number;
}

const TREES: Tree[] = [
  {
    provider: 'aws',
    dir: 'provider-catalog',
    providerName: 'hashicorp/aws',
    version: '6.53.0',
    minServices: 150,
    minTypes: 1500,
  },
  {
    provider: 'azure',
    dir: 'provider-catalog-azure',
    providerName: 'hashicorp/azurerm',
    version: '4.81.0',
    minServices: 150,
    minTypes: 1000,
  },
];

function dataDir(tree: Tree): string {
  return join(HERE, '..', 'data', tree.dir);
}
function loadIndex(tree: Tree): CatalogIndex {
  return JSON.parse(readFileSync(join(dataDir(tree), 'index.json'), 'utf8')) as CatalogIndex;
}
function loadChunk(tree: Tree, slug: string): CatalogServiceChunk {
  return JSON.parse(
    readFileSync(join(dataDir(tree), 'services', `${slug}.json`), 'utf8'),
  ) as CatalogServiceChunk;
}

describe.each(TREES)('provider catalog data ($provider) — comprehensive, consistent', (tree) => {
  const index = loadIndex(tree);
  const chunkFiles = readdirSync(join(dataDir(tree), 'services')).filter((f) => f.endsWith('.json'));

  it('covers the whole provider (name, version, service + type floor)', () => {
    expect(index.provider).toBe(tree.providerName);
    expect(index.providerVersion).toBe(tree.version);
    expect(index.services.length).toBeGreaterThanOrEqual(tree.minServices);
    const typeCount = index.services.reduce((n, s) => n + s.types.length, 0);
    expect(typeCount).toBeGreaterThanOrEqual(tree.minTypes);
  });

  it('every index service has exactly one chunk file, and no orphans exist', () => {
    const slugs = index.services.map((s) => s.slug).sort();
    const files = chunkFiles.map((f) => f.replace(/\.json$/, '')).sort();
    expect(files).toEqual(slugs);
  });

  it('every service names exactly one primary type, present in its own chunk', () => {
    for (const service of index.services) {
      const primaries = service.types.filter((t) => t.primary === 1);
      expect(primaries, service.slug).toHaveLength(1);
      const chunk = loadChunk(tree, service.slug);
      expect(Object.keys(chunk.types).sort()).toEqual(service.types.map((t) => t.t).sort());
    }
  });

  it('curated services carry a real category; only the uncurated long tail is "Everything else"', () => {
    const categories = new Set(index.services.map((s) => s.category));
    expect(categories.size).toBeGreaterThanOrEqual(10);
    // The exhaustive provision catalog covers the whole provider, so a long tail
    // of child sub-resources the curated tile browse doesn't name lands in
    // "Everything else" (azure has ~73 such services; aws currently has none).
    // That bucket must hold ONLY uncurated slugs — no browse-curated service
    // ever falls through into it.
    const curated: Record<string, unknown> = tree.provider === 'azure' ? AZURE_SERVICES : SERVICE_META;
    for (const s of index.services) {
      if (s.category === 'Everything else') {
        expect(s.slug in curated, `${s.slug} is curated but landed in "Everything else"`).toBe(
          false,
        );
      }
    }
  });
});

describe('aws catalog spot-checks', () => {
  const AWS = TREES[0]!;

  it('SQS ships its queue with real fillable parameters and no outputs', () => {
    const sqs = loadChunk(AWS, 'sqs');
    const queue = sqs.types['aws_sqs_queue'];
    expect(queue).toBeTruthy();
    const names = queue!.attrs.map((a) => a.n);
    expect(names).toContain('delay_seconds');
    expect(names).toContain('fifo_queue');
    // Outputs must never render as inputs.
    expect(names).not.toContain('arn');
    expect(names).not.toContain('id');
    expect(names).not.toContain('url');
  });

  it('the giant recursive schemas stay bounded (depth cap works)', () => {
    for (const slug of ['waf', 'quicksight']) {
      const bytes = readFileSync(join(dataDir(AWS), 'services', `${slug}.json`), 'utf8').length;
      expect(bytes, slug).toBeLessThan(200_000);
    }
  });
});

describe('azure catalog spot-checks', () => {
  const AZURE = TREES[1]!;

  it('the container registry ships its fillable parameters and no outputs', () => {
    const acr = loadChunk(AZURE, 'acr');
    const registry = acr.types['azurerm_container_registry'];
    expect(registry).toBeTruthy();
    const names = registry!.attrs.map((a) => a.n);
    expect(names).toContain('name');
    expect(names).toContain('sku');
    // Computed-only outputs must never render as inputs.
    expect(names).not.toContain('login_server');
    expect(names).not.toContain('admin_password');
  });
});

describe('hybrid guarantee — manifests ↔ catalog (per provider)', () => {
  it('every resource type the manifests know exists in its provider catalog', () => {
    const catalogTypes: Record<CloudProvider, Set<string>> = { aws: new Set(), azure: new Set() };
    for (const tree of TREES) {
      const index = loadIndex(tree);
      for (const service of index.services)
        for (const t of service.types) catalogTypes[tree.provider].add(t.t);
    }
    const missing: string[] = [];
    for (const manifest of manifests) {
      for (const rt of manifest.resourceTypes) {
        if (!catalogTypes[providerOfType(rt)].has(rt)) missing.push(`${manifest.service}: ${rt}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
