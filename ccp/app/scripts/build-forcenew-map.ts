/**
 * OFFLINE map builder for the ForceNew gate (0020, replacing the 0006-era
 * network scraper; per-provider since 0039 F2b). Source of truth: the
 * compiled-and-reflected provider schema dump under tools/schemadump/ (0013d
 * G0 — aws-v6.53.0-schema.json, azurerm-v4.81.0-schema.json) — never the
 * provider docs, never grep over Go text. For every attribute path an
 * in-scope catalog op writes (per extractOpAttrs, the same function the gate
 * uses), record a verdict with re-verifiable provenance:
 *
 *   exact walk        → verdict is the chain-OR of force_new down the path
 *   leaf-suffix rescue→ (capability-derived keys only) OR over every match
 *   no match          → 'unresolved' + reason; fail-closed — the gate WARNs
 *                       until a human adjudication covers the key
 *
 * The map is rebuilt FROM SCRATCH each run (stale keys pruned) so its keys are
 * exactly the current catalog's needs. Structural keys (target.path + attr)
 * are exact-only: they address where the executor writes, so a miss means the
 * declared write is not a schema attribute at all — that is adjudication
 * territory, not something to force-fit. Run:
 *   npx vite-node scripts/build-forcenew-map.ts [--provider aws|azure]
 *
 * --provider (default aws, 0039 F2b) selects the dump, the pinned tag, and the
 * output file: aws -> forcenew-map.json (unchanged), azure -> forcenew-map-
 * azure.json. Ops are ALSO scoped to that provider's own resourceType prefix
 * (providerOfType) — an azure run only ever considers azurerm_* ops, so today
 * (zero azurerm_ ops in the catalog — Lane G lands the first fixture) it
 * writes an empty map. That is correct, not a bug: every azurerm type outside
 * the F1 dump's 12 spike types stays unresolved -> the verify gate treats it
 * as ForceNew (fail-closed) the moment an op DOES reference it.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDER_TAGS,
  extractOpAttrs,
  resolveAttrPath,
  collectSuffixMatches,
  type ForceNewProvider,
  type DumpFile,
  type MapEntry,
  type OpLike,
} from './lib/forcenewShared';
import { providerOfType } from '../src/lib/providerDisplay';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = join(APP, 'src/data/manifests');

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const providerArg = arg('--provider', 'aws');
if (providerArg !== 'aws' && providerArg !== 'azure') {
  console.error(`FATAL: --provider must be aws|azure, got "${providerArg}"`);
  process.exit(1);
}
const PROVIDER = providerArg as ForceNewProvider;
const PROVIDER_TAG = PROVIDER_TAGS[PROVIDER];

// The schemadump filename prefix is the provider's OWN short name
// (hashicorp/azurerm's resources are azurerm_*, not azure_*) — distinct from
// the app's CloudProvider token used for --provider/MAP_PATH selection.
const DUMP_FILE_PREFIX: Record<ForceNewProvider, string> = { aws: 'aws', azure: 'azurerm' };
const DUMP_REL = `tools/schemadump/${DUMP_FILE_PREFIX[PROVIDER]}-${PROVIDER_TAG}-schema.json`;
const DUMP_PATH = join(APP, '../..', DUMP_REL);
const MAP_PATH = join(APP, `src/data/forcenew-map${PROVIDER === 'azure' ? '-azure' : ''}.json`);

interface GateOp extends OpLike {
  id: string;
  forcesReplace: boolean;
}

function main(): void {
  const GZ_PATH = `${DUMP_PATH}.gz`;
  if (!existsSync(DUMP_PATH) && !existsSync(GZ_PATH)) {
    // Fail-closed: no guessing without a reflected schema (0039 global rule 2).
    console.error(`FATAL: schemadump not found at ${DUMP_PATH}(.gz) — run tools/schemadump/gen.sh first`);
    process.exit(1);
  }
  // The aws dump is committed gzipped (93MB → 2MB); read raw if present, else gunzip.
  const dumpRaw = existsSync(DUMP_PATH)
    ? readFileSync(DUMP_PATH, 'utf8')
    : gunzipSync(readFileSync(GZ_PATH)).toString('utf8');
  const dump = JSON.parse(dumpRaw) as DumpFile;
  const dumpTag = dump.metadata?.provider_tag ?? '';
  if (dumpTag !== PROVIDER_TAG) {
    // Never mix verdicts across provider versions — regenerate the dump first.
    console.error(`FATAL: schemadump tag ${dumpTag} != pinned ${PROVIDER_TAG}`);
    process.exit(1);
  }

  const ops: GateOp[] = [];
  for (const f of readdirSync(MANIFESTS).filter((f) => f.endsWith('.json'))) {
    const m = JSON.parse(readFileSync(join(MANIFESTS, f), 'utf8')) as { operations?: GateOp[] };
    for (const op of m.operations ?? []) {
      if (providerOfType(op.target.resourceType) === PROVIDER) ops.push(op);
    }
  }

  // Needed keys — same scope rule as the gate. Track deriving ops (for the
  // adjudication trail) and whether any derivation is capability-sourced
  // (only those are eligible for the leaf-suffix rescue).
  interface Need {
    resourceType: string;
    attrPath: string;
    suffixEligible: boolean;
    ops: string[];
  }
  const needed = new Map<string, Need>();
  for (const op of ops) {
    if (!['set_attribute', 'set_association_attribute'].includes(op.codemodOp)) continue;
    if (op.forcesReplace !== false) continue;
    const ex = extractOpAttrs(op);
    if (ex.kind !== 'attrs') continue;
    for (const a of ex.attrs) {
      const key = `${op.target.resourceType}.${a.path}`;
      const n = needed.get(key) ?? {
        resourceType: op.target.resourceType,
        attrPath: a.path,
        suffixEligible: false,
        ops: [],
      };
      n.suffixEligible = n.suffixEligible || a.source === 'capability';
      if (!n.ops.includes(op.id)) n.ops.push(op.id);
      needed.set(key, n);
    }
  }

  const map: Record<string, MapEntry> = {};
  const unresolved: { key: string; note: string; ops: string[] }[] = [];
  const counts = { force_new: 0, in_place: 0, unresolved: 0 };

  for (const key of [...needed.keys()].sort()) {
    const { resourceType, attrPath, suffixEligible, ops: opIds } = needed.get(key)!;
    const res = dump.resources[resourceType];
    let entry: MapEntry;
    if (!res) {
      entry = {
        verdict: 'unresolved',
        file: '',
        tag: PROVIDER_TAG,
        note: 'resource_not_in_schemadump — add to tools/schemadump/types.txt and regenerate',
      };
    } else if (res.framework_unreflected) {
      entry = {
        verdict: 'unresolved',
        file: '',
        tag: PROVIDER_TAG,
        note: 'framework_unreflected — ForceNew UNKNOWN, fail-closed (0013d §6.4); adjudicate',
      };
    } else {
      const exact = resolveAttrPath(res, attrPath);
      if (exact) {
        entry = {
          verdict: exact.forceNew ? 'force_new' : 'in_place',
          file: DUMP_REL,
          tag: PROVIDER_TAG,
          path: `exact: ${exact.nodePath}`,
        };
      } else {
        const matches = suffixEligible ? collectSuffixMatches(res, attrPath) : [];
        if (matches.length > 0) {
          entry = {
            verdict: matches.some((m) => m.forceNew) ? 'force_new' : 'in_place',
            file: DUMP_REL,
            tag: PROVIDER_TAG,
            path: `suffix-match: ${matches.map((m) => m.nodePath).join(' | ')}`,
          };
        } else {
          entry = {
            verdict: 'unresolved',
            file: '',
            tag: PROVIDER_TAG,
            note: `not_in_reflected_schema${res.has_customize_diff ? ' (resource has CustomizeDiff)' : ''} — synthetic param or manifest gap; adjudicate`,
          };
        }
      }
    }
    map[key] = entry;
    counts[entry.verdict]++;
    if (entry.verdict === 'unresolved')
      unresolved.push({ key, note: entry.note ?? '', ops: opIds });
  }

  writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
  console.log(`map written (${PROVIDER}): ${Object.keys(map).length} keys — ${JSON.stringify(counts)}`);
  if (unresolved.length > 0) {
    const adjFile = PROVIDER === 'azure' ? 'forcenew-adjudications-azure.json' : 'forcenew-adjudications.json';
    console.log(`\nunresolved (need adjudication in ${adjFile}):`);
    for (const u of unresolved)
      console.log(`  ${u.key}\n    ${u.note}\n    ops: ${u.ops.join(', ')}`);
  }
}

main();
