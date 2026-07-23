/**
 * One-shot generator for the W3 baseline skeleton goldens
 * (src/test/fixtures/skeletons/baselines/*.golden.tf). Run manually when a
 * baseline's normative shape changes, inspect the diff, commit the goldens:
 *
 *   npx vite-node scripts/dev-gen-baseline-goldens.ts
 *
 * The goldens are byte-pinned by src/test/baselineSkeletons.test.ts — this
 * script exists so a conscious regeneration is one command and the diff is
 * reviewable, never silent (the same discipline as the catalogctl golden
 * corpus).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifests } from '../src/data/manifests';
import { renderHclSkeleton } from '../src/lib/hclSkeleton';
import {
  BASELINE_VALUES,
  BASELINE_VARIANTS,
} from '../src/test/fixtures/skeletons/baselines/values';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'test',
  'fixtures',
  'skeletons',
  'baselines',
);

function opById(id: string) {
  const op = manifests.flatMap((m) => m.operations).find((o) => o.id === id);
  if (!op) throw new Error(`op ${id} not in catalog`);
  return op;
}

mkdirSync(OUT, { recursive: true });

for (const [id, values] of Object.entries(BASELINE_VALUES)) {
  const text = renderHclSkeleton(opById(id), values, { requestId: 'REQ-W3' });
  writeFileSync(join(OUT, `${id}.golden.tf`), `${text}\n`);
  console.log(`wrote ${id}.golden.tf`);
}
for (const [name, values] of Object.entries(BASELINE_VARIANTS)) {
  const id = name.split('--')[0]!;
  const text = renderHclSkeleton(opById(id), values, { requestId: 'REQ-W3' });
  writeFileSync(join(OUT, `${name}.golden.tf`), `${text}\n`);
  console.log(`wrote ${name}.golden.tf`);
}
