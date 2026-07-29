/**
 * The store's deep clone.
 *
 * Store items are JSON VALUES by contract: FileStore round-trips the whole store
 * through `JSON.stringify`/`JSON.parse` on every snapshot and every boot, so any
 * value that does not survive that round trip (a Map, a Set, a class instance, a
 * cycle) is already corrupt the moment the process restarts. That contract makes
 * the general-purpose `structuredClone` — which pays for cycle tracking, transfer
 * lists and the full structured-clone algorithm on every call — the wrong tool:
 * measured on this store's item shapes it costs ~4.2 µs/item against ~0.4 µs for
 * the JSON-value clone below, and the store clones on EVERY read, every write and
 * every snapshot. That 10x is the difference between a list endpoint that scales
 * and one that does not.
 *
 * `Date` is handled explicitly rather than silently flattened to `{}`: nothing in
 * the schema stores one (timestamps are ISO strings — see `clock.ts`), but a
 * silent corruption is a worse failure than a one-branch check that costs nothing.
 */

/** Deep-clone a JSON value. Objects/arrays are copied; primitives are returned as-is. */
export function cloneValue<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const n = new Array(v.length);
    for (let i = 0; i < v.length; i++) n[i] = cloneValue(v[i]);
    return n as unknown as T;
  }
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Object.keys, not for..in: own enumerable properties only, matching what
  // JSON.stringify persists — an inherited property would not survive a restart.
  for (const k of Object.keys(src)) out[k] = cloneValue(src[k]);
  return out as unknown as T;
}

/**
 * Deep VALUE equality over the same JSON-value domain `cloneValue` copies (API-17).
 *
 * The store's `ifEquals` compared with `!==`, which is reference identity for objects.
 * Every guard shipped today happens to be a scalar or `undefined`, so nothing was broken —
 * but the store hands out CLONES, so the first caller to guard on an object or array would
 * get a condition that can NEVER pass: it compares its own copy against the store's
 * original. `domain/settlement.ts` already writes exactly that shape
 * (`ifEquals: {attr:'roles', value: account.roles}`), and it works only because the legacy
 * rows it targets have no `roles` map — the day one does, the settlement would fail every
 * attempt with a condition that looks like contention.
 *
 * A silently-impossible guard is the worst kind: it does not fail loudly, it just refuses
 * forever, and DynamoDB — which compares attribute VALUES — would have accepted it. Value
 * equality is what the seam promised.
 *
 * Key ORDER is deliberately not significant: DynamoDB compares maps by content, and
 * `JSON.parse` of a FileStore snapshot need not preserve insertion order. Comparing
 * serialized forms instead would make equality depend on how a caller happened to build
 * its object literal.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true; // fast path; also covers both-undefined and both-null
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // NaN is not a JSON value, so `===` is the whole story for primitives here.
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const aIsArr = Array.isArray(a);
  if (aIsArr !== Array.isArray(b)) return false;
  if (aIsArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!deepEquals(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const xk = Object.keys(x);
  const yk = Object.keys(y);
  if (xk.length !== yk.length) return false;
  for (const k of xk) {
    // `{a: undefined}` vs `{}` differ in key count above, so an explicit-undefined
    // property is NOT equal to an absent one — matching DynamoDB, where an attribute
    // set to null and an attribute that does not exist are different things.
    if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
    if (!deepEquals(x[k], y[k])) return false;
  }
  return true;
}
