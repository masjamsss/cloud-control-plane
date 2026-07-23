#!/usr/bin/env node
// plan-summary.mjs — `terraform show -json tfplan` → the structured Cloud Control Plane
// plan summary (0035 Docket B, visibility slice).
//
// ZERO runtime dependencies ON PURPOSE: terraform.yml's plan job runs this
// with the runner's own `node` — no `npm ci`, no vite-node, nothing added to
// the plan job's critical path. The pure function `summarizePlan` is imported
// and fixture-tested by src/test/planSummary.test.ts, and its output shape is
// pinned to the shared zod contract in src/lib/planSummary.ts (the same shape
// ccp-api validates on POST /requests/:id/plan-summary).
//
// Redaction is the parser's job, not the api's: values Terraform marks
// sensitive render as "(sensitive)" and never leave the runner; values unknown
// until apply render as "(known after apply)".
//
// CLI:
//   node plan-summary.mjs <plan.json> [--run-url <url>]   → summary JSON on stdout

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Caps mirrored from src/lib/planSummary.ts's zod bounds (parser stays under
 * them so a legitimate plan can never be refused by the api for size). */
const MAX_RESOURCE_CHANGES = 300;
const MAX_ATTR_CHANGES = 60;
const MAX_FORCED_BY = 30;
const MAX_VALUE_CHARS = 120;

/** terraform's `actions` array → our single verb. */
function mapActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const set = new Set(actions);
  if (set.has('read')) return null; // data-source reads are not estate changes
  if (set.has('create') && set.has('delete')) return 'replace'; // either order
  if (set.has('no-op')) return 'no-op';
  if (set.has('create')) return 'create';
  if (set.has('delete')) return 'delete';
  if (set.has('update')) return 'update';
  return null;
}

/** One replace_paths entry (an array of string/int steps) → a dotted attr. */
function pathToAttr(path) {
  if (!Array.isArray(path)) return String(path);
  return path
    .map((step, i) => (typeof step === 'number' ? `[${step}]` : i === 0 ? String(step) : `.${step}`))
    .join('');
}

/** Is this attribute marked sensitive? `marks` is terraform's before_sensitive/
 * after_sensitive: `true` (everything), an object keyed like the value, or absent. */
function isSensitive(marks, key) {
  if (marks === true) return true;
  if (marks && typeof marks === 'object') return Boolean(marks[key]);
  return false;
}

/** Render one attribute value for humans: sensitive → redacted, unknown →
 * "(known after apply)", null → "(none)", strings verbatim, rest JSON. */
function renderValue(value, { sensitive = false, unknown = false } = {}) {
  if (sensitive) return '(sensitive)';
  if (unknown) return '(known after apply)';
  if (value === null || value === undefined) return '(none)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}

/** Top-level attribute diffs for an update/replace. Deterministic: keys sorted. */
function attrChanges(change) {
  const before = change.before && typeof change.before === 'object' ? change.before : {};
  const after = change.after && typeof change.after === 'object' ? change.after : {};
  const afterUnknown = change.after_unknown && typeof change.after_unknown === 'object' ? change.after_unknown : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(afterUnknown)])].sort();
  const out = [];
  for (const key of keys) {
    if (out.length >= MAX_ATTR_CHANGES) break;
    const unknownAfter = Boolean(afterUnknown[key]);
    const beforeSensitive = isSensitive(change.before_sensitive, key);
    const afterSensitive = isSensitive(change.after_sensitive, key);
    // Unchanged? Compare the raw values — but a value becoming unknown IS a change.
    const same = !unknownAfter && JSON.stringify(before[key]) === JSON.stringify(after[key]);
    if (same) continue;
    out.push({
      attr: key,
      before: renderValue(before[key], { sensitive: beforeSensitive }),
      after: renderValue(after[key], { sensitive: afterSensitive, unknown: unknownAfter }),
    });
  }
  return out;
}

/**
 * The pure function: parsed `terraform show -json` output → the summary shape
 * of src/lib/planSummary.ts (`{resourceChanges, counts}`). Deterministic —
 * same plan JSON, byte-identical summary (addresses sorted, attrs sorted).
 */
export function summarizePlan(plan) {
  const counts = { create: 0, update: 0, replace: 0, delete: 0, noop: 0 };
  const resourceChanges = [];
  const rcs = plan && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];

  for (const rc of rcs) {
    if (!rc || typeof rc !== 'object') continue;
    if (rc.mode !== undefined && rc.mode !== 'managed') continue; // skip data sources
    const change = rc.change && typeof rc.change === 'object' ? rc.change : {};
    const action = mapActions(change.actions);
    if (action === null) continue;
    if (action === 'no-op') {
      counts.noop += 1;
      continue; // counted, never listed — keeps a whole-estate plan bounded
    }
    counts[action] += 1;

    const entry = {
      address: String(rc.address ?? ''),
      type: String(rc.type ?? String(rc.address ?? '').split('.')[0] ?? ''),
      action,
    };
    if (action === 'replace' && Array.isArray(change.replace_paths)) {
      const forcedBy = change.replace_paths.slice(0, MAX_FORCED_BY).map(pathToAttr);
      if (forcedBy.length > 0) entry.forcedBy = forcedBy;
    }
    if (action === 'update' || action === 'replace') {
      const changed = attrChanges(change);
      if (changed.length > 0) entry.changed = changed;
    }
    resourceChanges.push(entry);
  }

  resourceChanges.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { resourceChanges: resourceChanges.slice(0, MAX_RESOURCE_CHANGES), counts };
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

function main(argv) {
  const args = argv.slice(2);
  const runUrlIdx = args.indexOf('--run-url');
  const runUrl = runUrlIdx >= 0 ? args[runUrlIdx + 1] : undefined;
  const positional = args.filter((a, i) => a !== '--run-url' && i !== runUrlIdx + 1);
  const file = positional[0];
  if (!file) {
    process.stderr.write('usage: plan-summary.mjs <plan.json> [--run-url <url>]\n');
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const summary = summarizePlan(plan);
  if (runUrl) summary.runUrl = runUrl;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

// Run main() only when invoked directly (`node plan-summary.mjs …`), never on
// import — vitest imports summarizePlan without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
