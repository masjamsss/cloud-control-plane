#!/usr/bin/env node
// Derive per-named-service AWS tiles from the manifest ops — the AWS twin of
// gen-azure-service-tiles.mjs. Each aws_* type maps to a portal-recognizable
// SERVICE (e.g. every aws_glue_* → "Glue", every aws_lb* → "Load Balancing"),
// so the catalog browses ~150 AWS services (console parity) instead of the
// ~45 manifest files, WITHOUT splitting those files — catalog.ts groups by
// awsServiceOf(type). Output: the namedService map + a serviceMeta fragment
// (display name + category + monogram) for every named service that has ops.
// The service taxonomy (classify) is shared with gen-aws-tag-catalog.mjs via
// scripts/lib/awsServices.mjs (the AWS analog of the Azure capability ledger).
//
// Run: node scripts/gen-aws-service-tiles.mjs   (run gen-aws-tag-catalog.mjs FIRST
// so the aws-<family>.json comprehensive-tag manifests exist to be classified).
import fs from 'node:fs';
import path from 'node:path';
import { SERVICES, classify } from './lib/awsServices.mjs';

const MDIR = 'src/data/manifests';
// Every AWS manifest = a *.json that is NOT an azure-* family file. The new
// aws-<family>.json comprehensive-tag manifests start with "aws-" and ARE
// included; the curated per-service files (ec2.json, s3.json, …) are too.
const awsFiles = fs
  .readdirSync(MDIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('azure-'));

/** The anchor prefix for a slug — the FIRST curated rule (array order) that
 * yields it, i.e. its most representative resource-type family. Used to pick a
 * service's primaryType (the type its "Provision" deep-link opens). */
function anchorFor(slug) {
  for (const [prefix, s] of SERVICES) if (s === slug) return prefix;
  return null;
}

/**
 * A handful of marquee services where the generic anchor heuristic below would
 * pick a secondary resource (e.g. s3 → an s3control bucket before the plain
 * bucket, rds → a proxy before an instance). Curated so the "Provision <service>"
 * deep-link lands on the type a requester expects. Each MUST be a provisionable
 * type for its service (asserted at emit time).
 */
const PRIMARY_OVERRIDE = {
  s3: 'aws_s3_bucket',
  rds: 'aws_db_instance',
  eks: 'aws_eks_cluster',
  elasticache: 'aws_elasticache_cluster',
};

/** The representative provisionable type for a service — the type its Provision
 * deep-link opens. Prefer the curated override, else the provisionable type
 * closest to the service anchor (exact match, then anchor-prefixed), tie-broken
 * toward the most top-level (fewest segments), then shortest, then alphabetical.
 * Undefined when the service has NO provisionable type (an ops-only service —
 * it keeps its ops and simply shows no Provision action). */
function pickPrimaryType(slug, provTypes) {
  if (PRIMARY_OVERRIDE[slug] && provTypes.includes(PRIMARY_OVERRIDE[slug])) return PRIMARY_OVERRIDE[slug];
  if (provTypes.length === 0) return undefined;
  const anchor = anchorFor(slug);
  const rank = (t) => {
    if (!anchor) return 3;
    if (t === anchor) return 0;
    if (t.startsWith(anchor + '_')) return 1;
    if (t.startsWith(anchor)) return 2;
    return 3;
  };
  return provTypes.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const sa = a.split('_').length, sb = b.split('_').length;
    if (sa !== sb) return sa - sb;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : 1;
  })[0];
}

// The authoritative provisionable-type set (schema-derived) — the union with the
// op-target types below is what "full coverage" classifies. Each provisionable
// type is what the generic /provision form can actually stand up.
const CATALOG = JSON.parse(fs.readFileSync('src/data/provision-catalog.json', 'utf8'));
const provTypes = new Set(CATALOG.aws.map((e) => e.resourceType));

// walk the UNION of op-target types and provisionable types → the named service.
// svc[slug] tracks whether the service has any op (ops>0) and which of its types
// are provisionable (for primaryType). typeMap covers the whole union so
// awsServiceOf resolves every aws type the app can browse OR provision.
const svcOps = {};
const typeMap = {};
const opTypes = new Set();
for (const f of awsFiles) {
  const m = JSON.parse(fs.readFileSync(path.join(MDIR, f), 'utf8'));
  for (const op of m.operations ?? []) opTypes.add(op.target.resourceType);
}
for (const t of new Set([...opTypes, ...provTypes])) {
  const c = classify(t); // total for aws — always resolves
  const s = (svcOps[c.slug] ??= { name: c.name, category: c.category, types: new Set(), provTypes: [], ops: 0 });
  s.types.add(t);
  if (opTypes.has(t)) s.ops++;
  if (provTypes.has(t)) s.provTypes.push(t);
  typeMap[t] = c.slug;
}
for (const s of Object.keys(svcOps)) svcOps[s].primaryType = pickPrimaryType(s, svcOps[s].provTypes);

const slugs = Object.keys(svcOps).sort();
const withOps = slugs.filter((s) => svcOps[s].ops > 0);
const opless = slugs.filter((s) => svcOps[s].ops === 0);
const noPrimary = slugs.filter((s) => !svcOps[s].primaryType);
console.log(`NAMED SERVICES: ${slugs.length}  (full provisionable coverage — union of ops + provision catalog, ${SERVICES.length} taxonomy rules)`);
console.log(`  with ops: ${withOps.length}   op-less (Provision-only): ${opless.length}`);
console.log(`  services with no provisionable type (no Provision action): ${noPrimary.length}  [${noPrimary.join(', ')}]`);
const byCat = {};
for (const s of slugs) (byCat[svcOps[s].category] ??= []).push(s);
for (const [cat, list] of Object.entries(byCat).sort()) console.log(`  ${cat}: ${list.length}`);

// Assert every override actually points at a provisionable type of its service.
for (const [slug, type] of Object.entries(PRIMARY_OVERRIDE)) {
  if (svcOps[slug] && svcOps[slug].primaryType !== type) {
    throw new Error(`PRIMARY_OVERRIDE[${slug}]=${type} is not a provisionable type of that service`);
  }
}

fs.writeFileSync(process.argv[2] || '/tmp/aws-service-tiles.json',
  JSON.stringify({ services: Object.fromEntries(slugs.map((s) => [s, { ...svcOps[s], types: [...svcOps[s].types] }])), typeMap }, null, 1));
console.log(`\nwrote service+typeMap → ${process.argv[2] || '/tmp/aws-service-tiles.json'}`);

// a 2–3 char monogram for the icon-tile fallback (used when no curated glyph)
function monogram(name) {
  const words = name.replace(/[()]/g, '').split(/\s+/).filter((w) => !/^(for|the|of|and|&|2\.0|on)$/i.test(w));
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}
// emit the committed TS data module the catalog + serviceMeta import from.
// primaryType is the type the service's "Provision" deep-link opens; it is
// omitted for the few services with no provisionable type (they keep their ops).
const entries = slugs.map((s) => {
  const v = svcOps[s];
  const primary = v.primaryType ? `, primaryType: '${v.primaryType}'` : '';
  return `  '${s}': { displayName: ${JSON.stringify(v.name)}, category: ${JSON.stringify(v.category)}, monogram: '${monogram(v.name)}'${primary} },`;
});
const typeEntries = Object.keys(typeMap).sort().map((t) => `  '${t}': '${typeMap[t]}',`);
const ts = `// GENERATED by scripts/gen-aws-service-tiles.mjs — do not hand-edit.
// Maps every provisionable aws_* type (the union of catalog-op targets AND the
// schema-derived provision catalog) to a console-recognizable SERVICE, so the
// catalog browses all ${slugs.length} AWS services (full provisionable coverage:
// ${withOps.length} with ops + ${opless.length} Provision-only) rather than the ~${awsFiles.length} manifest files.
// Regenerate when AWS ops or the provision catalog change:
//   node scripts/gen-aws-service-tiles.mjs
// \`category\` is the console grouping label; serviceMeta maps it to the app Category.
// \`primaryType\` is the representative provisionable type a service's Provision
// deep-link opens (/provision?type=…); absent when the service has no
// provisionable type (an ops-only service shows no Provision action).

export interface AwsServiceDef { displayName: string; category: string; monogram: string; primaryType?: string; }

/** Named AWS service → its display metadata (${slugs.length} services). */
export const AWS_SERVICES: Record<string, AwsServiceDef> = {
${entries.join('\n')}
};

/** aws resource type → the named AWS service it belongs to. */
export const AWS_TYPE_SERVICE: Record<string, string> = {
${typeEntries.join('\n')}
};

/** The named AWS service for a resource type, or undefined for a non-aws type. */
export function awsServiceOf(resourceType: string): string | undefined {
  return AWS_TYPE_SERVICE[resourceType];
}
`;
fs.writeFileSync('src/lib/awsServiceMap.ts', ts);
console.log(`wrote src/lib/awsServiceMap.ts (${slugs.length} services, ${Object.keys(typeMap).length} type mappings)`);
