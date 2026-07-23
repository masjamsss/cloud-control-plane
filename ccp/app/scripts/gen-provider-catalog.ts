/**
 * Generate the bundled provision catalog from a provider's FULL schema dump.
 * The transform itself is pure and lives in src/lib/providerCatalogGen.ts
 * (unit-tested on fixtures); this CLI only reads the dump, writes the output
 * tree, and prints a census.
 *
 *   npm run gen:provider-catalog -- <schema.json> [aws|azure]
 *
 * AWS (default) — the input is `terraform providers schema -json` for the
 * PINNED provider version (6.53.0 — the same tag tools/schemadump reflects).
 * That raw dump is ~18 MB and is NOT committed; regenerate it with:
 *
 *   mkdir -p /tmp/aws-schema && cd /tmp/aws-schema
 *   printf 'terraform {\n required_providers {\n  aws = { source = "hashicorp/aws", version = "6.53.0" }\n }\n}\n' > main.tf
 *   terraform init -input=false
 *   terraform providers schema -json > aws-full-schema.json
 *   # then, from ccp/app:
 *   npm run gen:provider-catalog -- /tmp/aws-schema/aws-full-schema.json aws
 *
 * AZURE (0039) — the input is the COMMITTED azurerm schemadump
 * (tools/schemadump/azurerm-v4.81.0-schema.json, a compile-and-reflect shape);
 * azurermSchemaToRaw lifts it into the same RawProviderSchemas the aws path
 * consumes. From ccp/app:
 *
 *   npm run gen:provider-catalog -- ../../tools/schemadump/azurerm-v4.81.0-schema.json azure
 *
 * The OUTPUT is committed under src/data/provider-catalog/ (aws) or
 * src/data/provider-catalog-azure/ (azure): a small index (every service + its
 * resource types) and one per-service chunk the app lazy-loads on demand,
 * mirroring how the block-source corpus ships (src/lib/blockSource.ts).
 * Minified like the block chunks — generated data, reviewed via this generator,
 * not read as prose.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  azurermSchemaToRaw,
  buildCatalog,
  type AzurermSchemaDump,
  type RawProviderSchemas,
} from '../src/lib/providerCatalogGen';
import type { CloudProvider } from '../src/lib/providerDisplay';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const inputArg = process.argv[2];
  const provider = (process.argv[3] as CloudProvider) ?? 'aws';
  if (!inputArg || (provider !== 'aws' && provider !== 'azure')) {
    console.error('usage: vite-node scripts/gen-provider-catalog.ts <schema.json> [aws|azure]');
    console.error('(see the header of this script for how to produce each schema dump)');
    process.exit(2);
  }
  const outDir = join(
    APP,
    'src',
    'data',
    provider === 'azure' ? 'provider-catalog-azure' : 'provider-catalog',
  );

  const inputPath = resolve(inputArg);
  const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
  const raw: RawProviderSchemas =
    provider === 'azure'
      ? azurermSchemaToRaw(parsed as AzurermSchemaDump)
      : (parsed as RawProviderSchemas);
  const { index, chunks } = buildCatalog(raw, provider);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'services'), { recursive: true });
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));
  let bytes = 0;
  for (const [slug, chunk] of chunks) {
    const text = JSON.stringify(chunk);
    bytes += text.length;
    writeFileSync(join(outDir, 'services', `${slug}.json`), text);
  }

  const typeCount = index.services.reduce((n, s) => n + s.types.length, 0);
  const categories = new Set(index.services.map((s) => s.category));
  console.log(
    `provider-catalog (${provider}): ${index.services.length} services · ${typeCount} resource types · ` +
      `${categories.size} categories · chunks ${(bytes / 1024 / 1024).toFixed(1)} MB ` +
      `(provider ${index.provider} v${index.providerVersion})`,
  );
}

main();
