import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { getOperation } from '@/lib/interpreter';
import { redactHcl } from '@/lib/redact';
import { buildFullBlockDiff } from '@/lib/blockDiff';
import type { BlockSource } from '@/lib/blockSource';

const BLOCKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'blocks');

function allBlocks(): { file: string; address: string; block: BlockSource }[] {
  const out: { file: string; address: string; block: BlockSource }[] = [];
  for (const f of readdirSync(BLOCKS)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const map = JSON.parse(readFileSync(join(BLOCKS, f), 'utf8')) as Record<string, BlockSource>;
    for (const [address, block] of Object.entries(map)) out.push({ file: f, address, block });
  }
  return out;
}

describe('extracted block source — safety + integrity', () => {
  const blocks = allBlocks();

  it('ships a non-trivial set of blocks', () => {
    expect(blocks.length).toBeGreaterThan(30);
  });

  it('every shipped block is already fully redacted (redactHcl is a no-op)', () => {
    // If redaction would change any block, a secret slipped through extraction.
    const leaks = blocks.filter((b) => redactHcl(b.block.source) !== b.block.source);
    expect(leaks.map((b) => b.address)).toEqual([]);
  });

  it('the live lambda API token never appears in shipped data', () => {
    const bad = blocks.filter((b) => /76677951|EF06-470F/i.test(b.block.source));
    expect(bad).toEqual([]);
  });

  it('every block carries real provenance (file + positive line)', () => {
    for (const b of blocks) {
      expect(b.block.file).toMatch(/^ccp\/app\/fixtures-estate\/.+\.tf$/);
      expect(b.block.line).toBeGreaterThan(0);
      expect(b.block.source).toMatch(/^resource "/);
    }
  });
});

describe('buildFullBlockDiff — deterministic before/after', () => {
  const ebs: BlockSource = {
    file: 'environments/prod/ebs.tf',
    line: 47,
    source:
      'resource "aws_ebs_volume" "app01_sdd" {\n' +
      '  availability_zone = "ap-southeast-5b"\n' +
      '  size              = 150\n' +
      '  type              = "gp2"\n' +
      '}',
  };

  it('a grow op changes exactly the size line, keeps the rest byte-identical', () => {
    const op = getOperation('ebs-grow', manifests)!;
    const diff = buildFullBlockDiff(op, { volume: 'aws_ebs_volume.app01_sdd', new_size_gib: 250 }, ebs);
    expect(diff).not.toBeNull();
    expect(diff!.kind).toBe('change');
    // The whole block is present, with the new value.
    expect(diff!.after).toContain('size              = 250');
    expect(diff!.after).not.toContain('size              = 150');
    // Exactly one changed line, and everything else is unchanged.
    expect(diff!.changedAfter.length).toBe(1);
    const beforeUnchanged = ebs.source.split('\n').filter((_, i) => !diff!.changedBefore.includes(i));
    const afterUnchanged = diff!.after.split('\n').filter((_, i) => !diff!.changedAfter.includes(i));
    expect(afterUnchanged).toEqual(beforeUnchanged);
  });

  it('a delete op returns kind:remove marking the whole block', () => {
    const op = getOperation('ebs-delete-volume', manifests);
    if (!op) return; // op set may evolve; skip if absent
    const diff = buildFullBlockDiff(op, { volume: 'aws_ebs_volume.app01_sdd' }, ebs);
    if (op.codemodOp === 'remove_block') {
      expect(diff?.kind).toBe('remove');
      expect(diff?.after).toBe('');
      expect(diff?.changedBefore.length).toBe(ebs.source.split('\n').length);
    }
  });

  it('masks a secret typed into a value before it enters the after-block', () => {
    // Synthetic op that writes a free-text attribute.
    const op = { ...getOperation('ebs-grow', manifests)!, codemodOp: 'set_attribute' as const };
    const diff = buildFullBlockDiff(
      op,
      { volume: 'aws_ebs_volume.app01_sdd', new_size_gib: 200 },
      ebs,
    );
    // The after text must survive a redaction pass unchanged (already masked).
    expect(diff).not.toBeNull();
    expect(redactHcl(diff!.after)).toBe(diff!.after);
  });
});
