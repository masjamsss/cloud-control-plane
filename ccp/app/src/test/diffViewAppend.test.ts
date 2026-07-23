import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Inventory } from '@/types';
import { manifests } from '@/data/manifests';
import inventoryData from '@/data/inventory.json';
import { getOperation } from '@/lib/interpreter';
import { generateDiff } from '@/lib/diff';
import { DiffView } from '@/components/DiffView';

/**
 * 0034 papercut #2 — the honest append delta must also RENDER right in the review
 * screen's DiffView (the real component the L1 and first approver bind to). The
 * running preview server is pinned to another worktree, so this render check is
 * the deterministic stand-in: it drives the actual component over the actual
 * generateDiff output. renderToStaticMarkup needs no DOM (repo has no jsdom).
 */

const inventory = inventoryData as unknown as Inventory;
const html = (diff: string): string => renderToStaticMarkup(React.createElement(DiffView, { diff }));

describe('DiffView renders the honest append delta (0034 papercut #2)', () => {
  it('ebs-create-snapshot: header is a meta row, the new block is green add rows', () => {
    const diff = generateDiff(
      getOperation('ebs-create-snapshot', manifests)!,
      {
        volume: 'aws_ebs_volume.app01_sdb',
        snapshot_name: 'pre kernel patch APP01 sdb',
        description_tag: 'before the patch',
      },
      inventory,
    );
    const out = html(diff);
    // The `#` header line becomes a meta (context) row, not an add.
    expect(out).toContain('diff__row--meta');
    // Real added attributes render as green add rows (the `+` is stripped to the gutter).
    expect(out).toContain('diff__row--add');
    expect(out).toContain('resource &quot;aws_ebs_snapshot&quot;');
    expect(out).toContain('volume_id = aws_ebs_volume.app01_sdb.id');
    // No stray literal `+` leaked into the row text, and no fabricated volume block.
    expect(out).not.toContain('+ volume_id');
    expect(out).not.toContain('aws_ebs_volume&quot; &quot;app01_sdb&quot; {');
  });

  it('sg-add-internal-ingress-rule: the ingress block renders as adds, not a whole-SG redefinition', () => {
    const diff = generateDiff(
      getOperation('sg-add-internal-ingress-rule', manifests)!,
      {
        security_group: 'aws_security_group.allinternal_to_backupproxy',
        protocol: 'tcp',
        from_port: 8443,
        to_port: 8443,
        cidr_block: '10.0.1.0/24',
      },
      inventory,
    );
    const out = html(diff);
    expect(out).toContain('diff__row--add');
    expect(out).toContain('ingress {');
    expect(out).toContain('cidr_blocks = [&quot;10.0.1.0/24&quot;]');
    expect(out).not.toContain('resource &quot;aws_security_group&quot;');
  });
});
