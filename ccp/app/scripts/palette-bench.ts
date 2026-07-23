/**
 * Per-keystroke JS cost of the palette pipeline over the real bundled data —
 * exactly the work CommandPalette runs inside render per keystroke (0025 §5.2).
 *
 * Run: `cd ccp/app && npx vite-node scripts/palette-bench.ts`
 *
 * After RX-1's two-stage memo split, `buildPaletteSections` no longer depends
 * on `query` for section *construction* — only `filterPaletteSections` +
 * `flattenPaletteSections` do (the deferred-query stage). So this script
 * times both stages separately: the one-off build (should stay flat,
 * independent of query) and the per-keystroke filter+flatten stage (the
 * number that must drop under RX-1's p50 < 2 ms target).
 */
import { performance } from 'node:perf_hooks';
import {
  buildPaletteSections,
  filterPaletteSections,
  flattenPaletteSections,
  shouldShowResources,
} from '@/lib/palette';
import { manifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';
import type { Inventory, User } from '@/types';

const inventory = inventoryData as unknown as Inventory;
const user = { id: 'bench', name: 'Bench', role: 'lead', teamId: 'platform', isAdmin: false } as unknown as User;

/** Full pipeline (build + filter + flatten) — what CommandPalette ran pre-RX-1,
 * every keystroke, before the section-build memo was split from the query. */
function keystrokeFull(query: string): number {
  const t0 = performance.now();
  const sections = buildPaletteSections({
    user,
    manifests,
    resources: inventory.resources,
    myRequests: [],
    showResources: shouldShowResources(query),
  });
  flattenPaletteSections(filterPaletteSections(sections, query));
  return performance.now() - t0;
}

/** Build stage only — section construction (680 ops incl. isOpDisabled, plus
 * resources once the query clears the 2-char gate). Post-RX-1 this runs once
 * per [user, manifests, resources, myRequests, showResources] change, NOT
 * per keystroke. */
function buildStage(query: string): number {
  const t0 = performance.now();
  buildPaletteSections({
    user,
    manifests,
    resources: inventory.resources,
    myRequests: [],
    showResources: shouldShowResources(query),
  });
  return performance.now() - t0;
}

/** Filter+flatten stage only, over an already-built section list — this is
 * the per-keystroke stage post-RX-1 (runs at useDeferredValue priority). */
function filterStage(sections: ReturnType<typeof buildPaletteSections>, query: string): number {
  const t0 = performance.now();
  flattenPaletteSections(filterPaletteSections(sections, query));
  return performance.now() - t0;
}

function percentiles(samples: number[]): { p50: number; p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length * 0.5)]!, p95: s[Math.floor(s.length * 0.95)]! };
}

function bench(label: string, query: string, iters = 50): void {
  for (let i = 0; i < 10; i++) keystrokeFull(query); // warm-up
  const s = Array.from({ length: iters }, () => keystrokeFull(query));
  const { p50, p95 } = percentiles(s);
  console.log(`${label.padEnd(34)} p50 ${p50.toFixed(2)} ms · p95 ${p95.toFixed(2)} ms`);
}

function benchSplit(label: string, query: string, iters = 50): void {
  for (let i = 0; i < 10; i++) {
    buildStage(query);
  }
  const builds = Array.from({ length: iters }, () => buildStage(query));
  const { p50: buildP50, p95: buildP95 } = percentiles(builds);

  const built = buildPaletteSections({
    user,
    manifests,
    resources: inventory.resources,
    myRequests: [],
    showResources: shouldShowResources(query),
  });
  for (let i = 0; i < 10; i++) filterStage(built, query); // warm-up
  const filters = Array.from({ length: iters }, () => filterStage(built, query));
  const { p50: filterP50, p95: filterP95 } = percentiles(filters);

  console.log(
    `${label.padEnd(34)} build p50 ${buildP50.toFixed(2)} ms · p95 ${buildP95.toFixed(2)} ms` +
      `  |  filter+flatten p50 ${filterP50.toFixed(2)} ms · p95 ${filterP95.toFixed(2)} ms`,
  );
}

console.log('--- full pipeline (build + filter + flatten), one call per keystroke --- ');
bench('empty query', '');
bench('1 char "e"', 'e');
bench('2 chars "ec" (resources built)', 'ec');
bench('3 chars "ec2"', 'ec2');
bench('2 chars "aw" (broad)', 'aw');
bench('no-match 8 chars', 'zzzzzzzz');

console.log('\n--- split stages (build once vs. filter+flatten per keystroke) ---');
benchSplit('empty query', '');
benchSplit('1 char "e"', 'e');
benchSplit('2 chars "ec" (resources built)', 'ec');
benchSplit('3 chars "ec2"', 'ec2');
benchSplit('2 chars "aw" (broad)', 'aw');
benchSplit('no-match 8 chars', 'zzzzzzzz');
