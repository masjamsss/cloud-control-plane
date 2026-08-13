import type { ManifestOperation } from '@/types';

/**
 * ARCH-5 — the two catalogs, and the rule that keeps them from disagreeing silently.
 *
 * There are two manifest sets in a deployed system:
 *
 *   1. the **image-bundled** catalog (`ccp/app/src/data/manifests/*.json`, vendored into
 *      the api image) — what `manifests.ts#getOperation` resolves, and therefore what
 *      submit validates, what the approval ladder is derived from, and what the
 *      replace-confirmation requirement comes from;
 *   2. the **per-project uploaded** set, staged by the estate's CI, dual-control-activated
 *      and served by `GET /projects/:id/manifests` — what the SPA builds its forms from
 *      for every real onboarded estate (`app/src/lib/httpApi.ts`).
 *
 * Nothing compared them, so they could disagree in either direction with no signal: an op
 * offered by the form and refused by the server, bounds rendered that are not the bounds
 * enforced, an approval count shown that is not the count required.
 *
 * ## The authority decision
 *
 * **The bundled catalog is authoritative for every submit-time decision. The uploaded set
 * is a presentation artifact.** Written up in `ccp/docs/DOMAIN-MODEL.md` § "Catalog
 * authority"; the reason, in one sentence, is that an uploaded manifest's governance
 * fields have never been validated by anything — `domain/projectData.ts`'s `UploadManifest`
 * validates operations as `{ id: string }` `.passthrough()`, so `exposure`, `riskFloor`
 * and `forcesReplace` ride through unread — while the bundled catalog's same fields are
 * gate-enforced in CI, and `verify:safety`'s ForceNew gate is specifically what makes
 * `forcesReplace:false` a checked statement rather than a claim.
 *
 * This is why the finding's first recommendation ("resolve submit-time operations from the
 * acting project's active manifest version") is **rejected**: `domain/requirement.ts`
 * derives the approval ladder from `op.exposure`, and `routes/requests.ts` demands the
 * typed replace-confirmation from `op.forcesReplace`. Resolving from the uploaded set moves
 * both onto unvalidated, tenant-supplied data — a governance escalation wearing the costume
 * of a lookup change. It is L-27's shape exactly: the thing being made per-tenant carried
 * more than an identifier.
 *
 * ## Why authority alone is not the fix
 *
 * Deciding who wins does not tell the requester anything. Pre-fix, a requester whose form
 * offered a 30,000 GiB volume got `PARAM_OUT_OF_BOUNDS` — a refusal that blames them for a
 * value their own screen said was allowed, with nothing anywhere naming the real cause.
 * So the skew is now **detected and refused**, per item, naming the operation and the
 * diverging fields.
 *
 * ## The comparison is subtractive, and that is deliberate (L-25)
 *
 * A list of "the fields that matter" would be correct today and wrong the first time the
 * manifest type grows — and it would grow silently, because a new governance field nobody
 * added to the list simply would not be compared. So the rule is inverted: **everything is
 * compared except a small, named set of presentation fields.** A field added to
 * `ManifestOperation` tomorrow is compared by default. The failure direction of forgetting
 * is a refusal to submit, which is loud and safe, rather than an unchecked divergence.
 */

/**
 * Operation fields that are prose or display ordering only — an estate may legitimately
 * word these differently for its own operators without changing what the server enforces.
 *
 * Everything absent from this set is compared, including fields like `decisions` and
 * `draftSkeleton` that look presentational: they shape what an engineer actually receives
 * on the request, so a divergence there is a real disagreement about the change.
 */
export const PRESENTATION_OP_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'summary',
  'consoleLabel',
  'description',
  'pinned',
  'keywords',
]);

/** Param fields that are prose or renderer hints only. Same rule as above. */
export const PRESENTATION_PARAM_FIELDS: ReadonlySet<string> = new Set([
  'label',
  'help',
  'sensitive',
  'group',
  'tier',
  'uiWidget',
]);

/** Order-insensitive structural equality — manifests are JSON, so this is enough. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

function compareFields(
  bundled: Record<string, unknown>,
  served: Record<string, unknown>,
  presentation: ReadonlySet<string>,
  prefix: string,
): string[] {
  const out: string[] = [];
  // The union of both sides' keys, so a field PRESENT only on the served side counts as a
  // divergence. A served op carrying an extra enforcement-shaped key is exactly the case
  // that must not pass quietly.
  const keys = new Set([...Object.keys(bundled), ...Object.keys(served)]);
  for (const k of keys) {
    if (presentation.has(k)) continue;
    if (k === 'params') continue; // compared per-param by the caller
    if (!deepEqual(bundled[k], served[k])) out.push(`${prefix}${k}`);
  }
  return out;
}

/**
 * The field paths on which two definitions of the SAME operation id disagree, ignoring
 * presentation. Empty means the served definition enforces exactly what the bundled one
 * does, and the form the requester filled in was built from the same rules the server
 * applies.
 *
 * Pure: no store, no fs, no clock. `served` is untrusted JSON, so it is taken as `unknown`
 * and never assumed to have any particular shape.
 */
export function operationSkew(bundled: ManifestOperation, served: unknown): string[] {
  if (served === null || typeof served !== 'object' || Array.isArray(served)) {
    // A served entry that is not even an object cannot be shown to agree. Fail closed.
    return ['<malformed served operation>'];
  }
  const s = served as Record<string, unknown>;
  const b = bundled as unknown as Record<string, unknown>;
  const fields = compareFields(b, s, PRESENTATION_OP_FIELDS, '');

  // Params are compared BY NAME, not by position: reordering a form's fields is a
  // presentation choice, but a param appearing on one side only, or the same param
  // carrying different bounds, is not.
  const bParams = Array.isArray(b.params) ? (b.params as Record<string, unknown>[]) : [];
  const sParams = Array.isArray(s.params) ? (s.params as Record<string, unknown>[]) : [];
  const byName = (list: Record<string, unknown>[]): Map<string, Record<string, unknown>> => {
    const m = new Map<string, Record<string, unknown>>();
    for (const p of list) {
      if (p !== null && typeof p === 'object' && typeof p.name === 'string') m.set(p.name, p);
    }
    return m;
  };
  const bMap = byName(bParams);
  const sMap = byName(sParams);
  // A malformed param (no string `name`) is invisible to `byName`, which would let it slip
  // through as "no divergence". Count instead, and treat a count mismatch as divergence.
  if (bMap.size !== bParams.length || sMap.size !== sParams.length) {
    fields.push('params.<malformed>');
  }
  for (const name of new Set([...bMap.keys(), ...sMap.keys()])) {
    const bp = bMap.get(name);
    const sp = sMap.get(name);
    if (!bp || !sp) {
      fields.push(`params.${name}`);
      continue;
    }
    fields.push(...compareFields(bp, sp, PRESENTATION_PARAM_FIELDS, `params.${name}.`));
  }
  return fields.sort();
}
