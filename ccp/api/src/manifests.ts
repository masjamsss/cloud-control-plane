import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isParamActive } from '@app-lib/dependsOn';
import type { ManifestOperation, ManifestParam, ServiceManifest } from '@/types';
import { SYSTEM_OPERATIONS } from './domain/systemOps';

/**
 * The server validates submits against the SAME bundled manifests the SPA renders.
 * We read the JSON off disk (not via the app's import.meta.glob index) so
 * there is zero app coupling. `loadManifests(dir)` lets tests inject a fixture dir.
 */

const DEFAULT_DIR = fileURLToPath(new URL('../../app/src/data/manifests', import.meta.url));

export function loadManifests(dir: string): ServiceManifest[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ServiceManifest);
}

let _cache: ServiceManifest[] | null = null;
export function getManifests(): ServiceManifest[] {
  return (_cache ??= loadManifests(DEFAULT_DIR));
}
/** Test hook: inject a manifest set (or reset with null). */
export function __setManifests(m: ServiceManifest[] | null): void {
  _cache = m;
}

export function getOperation(operationId: string, manifests: ServiceManifest[] = getManifests()): ManifestOperation | undefined {
  for (const m of manifests) {
    const op = m.operations.find((o) => o.id === operationId);
    if (op) return op;
  }
  // The drift system ops (WI-6) are estate-generic and NOT loaded off disk —
  // resolvable regardless of which manifest set was passed/injected, exactly
  // like a real catalog op everywhere downstream (ladder derivation, risk
  // resolution), but refused by the normal submit lane (routes/requests.ts).
  return SYSTEM_OPERATIONS.find((o) => o.id === operationId);
}

export type ParamCheck = { ok: true } | { ok: false; code: 'VALIDATION_FAILED' | 'PARAM_OUT_OF_BOUNDS' };

/** Re-validate submitted params against the manifest bounds server-side. */
export function validateParams(op: ManifestOperation, params: Record<string, unknown>): ParamCheck {
  for (const p of op.params) {
    // An INACTIVE dependsOn param is ignored: never required, its
    // bounds never applied to whatever value may have been submitted for it.
    // Same shared predicate the SPA renders and validates by (@app-lib/
    // dependsOn) — one rule, both sides; active params validate exactly as
    // before, so nothing here is weakened.
    if (!isParamActive(p, params)) continue;
    const val = params[p.name];
    // An empty ARRAY counts as absent, mirroring the client: a
    // required list with no entries is VALIDATION_FAILED, and an optional
    // list left empty never trips its minItems bound.
    if (val === undefined || val === null || (Array.isArray(val) && val.length === 0)) {
      if (p.required) return { ok: false, code: 'VALIDATION_FAILED' };
      continue;
    }
    // A repeated (list/set) block param submits an ARRAY OF INSTANCE RECORDS, not a
    // scalar/list/map — it must NOT route through paramOutOfBounds, whose array→object
    // recursion would misread the param's instance-count maxItems as each record's
    // field-count bound and false-reject a valid submission. Server twin of the app's
    // interpreter validateParams repeated branch.
    const bad = p.repeated ? repeatedOutOfBounds(p, val) : paramOutOfBounds(p, val);
    if (bad) return { ok: false, code: 'PARAM_OUT_OF_BOUNDS' };
  }
  return { ok: true };
}

/**
 * A repeated block param submits an array of instance records — one object per block
 * instance, keyed by sub-field names. Validate the instance COUNT against the param's
 * minItems/maxItems, then every active sub-field of every instance against ITS OWN
 * bounds (recursing for a nested repeated sub-block). This mirrors the app-side rule so
 * the form and the server never disagree on a repeated submission.
 */
function repeatedOutOfBounds(p: ManifestParam, val: unknown): boolean {
  if (!Array.isArray(val)) return true; // a repeated param must submit an array of records
  const b = p.bounds;
  if (b?.minItems !== undefined && val.length < b.minItems) return true;
  if (b?.maxItems !== undefined && val.length > b.maxItems) return true;
  const fields = p.repeated?.fields ?? [];
  for (const instance of val) {
    if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) return true;
    const rec = instance as Record<string, unknown>;
    for (const f of fields) {
      if (!isParamActive(f, rec)) continue;
      const fv = rec[f.name];
      if (fv === undefined || fv === null || (Array.isArray(fv) && fv.length === 0)) {
        if (f.required) return true;
        continue;
      }
      if (f.repeated ? repeatedOutOfBounds(f, fv) : paramOutOfBounds(f, fv)) return true;
    }
  }
  return false;
}

function paramOutOfBounds(p: ManifestParam, val: unknown): boolean {
  const b = p.bounds;
  if (!b) return false;
  // List values (the multi-select picker submits real arrays):
  // item-count bounds on the array itself, then every scalar bound applied
  // per item — the server-side twin of checkBounds' array branch.
  if (Array.isArray(val)) {
    if (b.minItems !== undefined && val.length < b.minItems) return true;
    if (b.maxItems !== undefined && val.length > b.maxItems) return true;
    return val.some((item) => paramOutOfBounds(p, item));
  }
  // Map values: bound every key AND value — the server twin of checkBounds'
  // map branch. Without this a map skips the string-guarded pattern check below
  // and is accepted unvalidated (a tag map with illegal chars would pass).
  if (val !== null && typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    if (b.minItems !== undefined && entries.length < b.minItems) return true;
    if (b.maxItems !== undefined && entries.length > b.maxItems) return true;
    // Azure tag names are case-insensitive — two keys that case-fold together (Owner
    // and owner) collide into one tag; the catalogctl executor refuses it, so the
    // server twin must too (an object cannot hold two byte-equal keys, so a repeated
    // fold always means two distinct spellings of the same tag).
    if (b.semantic === 'azure_tag_map') {
      const folds = new Set<string>();
      for (const k of Object.keys(val as Record<string, unknown>)) {
        const fold = k.toLowerCase();
        if (folds.has(fold)) return true;
        folds.add(fold);
      }
    }
    return entries.some(([k, v]) => paramOutOfBounds(p, k) || paramOutOfBounds(p, v));
  }
  if (b.allowlist && !b.allowlist.includes(val as string | number | boolean)) return true;
  if (typeof val === 'number') {
    if (b.min !== undefined && val < b.min) return true;
    if (b.max !== undefined && val > b.max) return true;
  }
  if (typeof val === 'string') {
    if (b.maxLength !== undefined && val.length > b.maxLength) return true;
    if (b.pattern !== undefined && !new RegExp(b.pattern).test(val)) return true;
  }
  return false;
}
