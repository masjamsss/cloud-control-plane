import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanTopLevelBlocks, lineStartDepths } from '@/lib/hclScan';

/**
 * Style-independence proof for the block scanner: five adversarial fixtures
 * (formatting chaos, string/interpolation hell, heredoc torture, comment tricks,
 * CRLF) each carry a hand-verified ground truth. The scanner must get the exact
 * count, the exact addresses in order, byte-exact probe sources, and correct
 * start lines — no matter the coding style.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hcl-styles');

interface Expected {
  blockCount: number;
  addresses: string[];
  probes: { address: string; exactSource: string }[];
}

const cases = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.tf'))
  .map((f) => ({
    name: basename(f, '.tf'),
    src: readFileSync(join(FIXTURES, f), 'utf8'),
    expected: JSON.parse(
      readFileSync(join(FIXTURES, `${basename(f, '.tf')}.expected.json`), 'utf8'),
    ) as Expected,
  }));

describe('scanTopLevelBlocks — coding-style independence', () => {
  it('has all five fixture cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const c of cases) {
    describe(`fixture: ${c.name}`, () => {
      const blocks = scanTopLevelBlocks(c.src);

      it('finds exactly the real blocks (decoys excluded)', () => {
        expect(blocks.map((b) => `${b.type}.${b.name}`)).toEqual(c.expected.addresses);
        expect(blocks.length).toBe(c.expected.blockCount);
      });

      it('probe blocks are byte-exact', () => {
        for (const probe of c.expected.probes) {
          const found = blocks.find((b) => `${b.type}.${b.name}` === probe.address);
          expect(found, probe.address).toBeDefined();
          expect(c.src.slice(found!.start, found!.end)).toBe(probe.exactSource);
        }
      });

      it('start lines point at the header line', () => {
        const lines = c.src.split('\n');
        for (const b of blocks) {
          const headerLine = lines[b.startLine - 1] ?? '';
          expect(headerLine, `${b.type}.${b.name} @ line ${b.startLine}`).toMatch(
            new RegExp(`resource\\s+"${b.type}"`),
          );
        }
      });
    });
  }
});

describe('lineStartDepths — indentation-independent attribute location', () => {
  it('reports depth 1 for top-level attrs regardless of indent style', () => {
    const tabBlock = 'resource "a" "b" {\n\tinstance_type = "x"\n\ttags = {\n\t\tk = "v"\n\t}\n}';
    const depths = lineStartDepths(tabBlock);
    // line 0 header=0, line 1 attr=1, line 2 tags=1, line 3 nested=2, line 4 close=2→ starts at 2, line 5 final close starts at 1
    expect(depths[1]).toBe(1);
    expect(depths[2]).toBe(1);
    expect(depths[3]).toBe(2);
  });

  it('marks lines that start inside strings/heredocs as non-editable (-1)', () => {
    const block = 'resource "a" "b" {\n  content = <<EOF\n{\n}\nEOF\n}';
    const depths = lineStartDepths(block);
    expect(depths[2]).toBe(-1); // inside heredoc
    expect(depths[3]).toBe(-1);
  });
});
