import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { OP_GROUPS, parseManifests } from '@/types/manifestSchema';
import bootstrapIam from '@/data/projects/bootstrap/manifests/iam.json';
import bootstrapKms from '@/data/projects/bootstrap/manifests/kms.json';
import bootstrapS3 from '@/data/projects/bootstrap/manifests/s3.json';
import type { ManifestOperation, ServiceManifest } from '@/types';

/**
 * 0008 §3 — lint-enforced rules for the binding action-picker taxonomy, run
 * against every bundled catalog (the 680-op estate manifests AND the
 * bootstrap sandbox project's own vendored manifests — both are validated by
 * the same required `group` schema, so both must obey the same rules):
 *
 *   - every op has exactly one valid group, and "create" is exclusive to
 *     macd:"Add" ops (§3 bucket 8: "82 Add — ... never per-resource").
 *   - both Move ops live in Danger zone — the orphan-menu bug (§1: "The 2
 *     Move ops are unreachable from any console surface") is fixed by
 *     construction once this holds.
 *   - `pinned` is FORBIDDEN on Delete/Move/engineer_only/forcesReplace ops —
 *     dangerous ops stay findable via search, never one-click.
 *   - `pinned` is an integer in [1,5].
 *   - at most 5 ops are pinned per resourceType (the ResourceRow shortlist
 *     size the whole feature is built around).
 */

function allOps(ms: ServiceManifest[]): ManifestOperation[] {
  return ms.flatMap((m) => m.operations);
}

const bootstrapManifests = parseManifests([bootstrapIam, bootstrapKms, bootstrapS3]);

const catalogs: [string, ManifestOperation[]][] = [
  ['main catalog (680 ops)', allOps(manifests)],
  ['bootstrap project catalog', allOps(bootstrapManifests)],
];

describe.each(catalogs)('0008 §3 op taxonomy — %s', (_label, ops) => {
  it('every op has exactly one valid group', () => {
    for (const op of ops) {
      expect(OP_GROUPS as readonly string[], op.id).toContain(op.group);
    }
  });

  it('"create" is exclusive to macd:"Add" ops', () => {
    for (const op of ops) {
      if (op.macd === 'Add') {
        expect(op.group, `${op.id}: Add op must be group "create"`).toBe('create');
      } else {
        expect(op.group, `${op.id}: only Add ops may be group "create"`).not.toBe('create');
      }
    }
  });

  it('every Move op is in Danger zone (the orphan-menu bug, fixed by construction)', () => {
    const moveOps = ops.filter((o) => o.macd === 'Move');
    for (const op of moveOps) {
      expect(op.group, `${op.id}: Move ops must be group "danger-zone"`).toBe('danger-zone');
    }
  });

  it('pinned is forbidden on Delete ops', () => {
    for (const op of ops.filter((o) => o.macd === 'Delete')) {
      expect(op.pinned, `${op.id}: Delete op must not be pinned`).toBeUndefined();
    }
  });

  it('pinned is forbidden on Move ops', () => {
    for (const op of ops.filter((o) => o.macd === 'Move')) {
      expect(op.pinned, `${op.id}: Move op must not be pinned`).toBeUndefined();
    }
  });

  it('pinned is forbidden on engineer_only ops', () => {
    for (const op of ops.filter((o) => o.exposure === 'engineer_only')) {
      expect(op.pinned, `${op.id}: engineer_only op must not be pinned`).toBeUndefined();
    }
  });

  it('pinned is forbidden on forcesReplace ops', () => {
    for (const op of ops.filter((o) => o.forcesReplace)) {
      expect(op.pinned, `${op.id}: forcesReplace op must not be pinned`).toBeUndefined();
    }
  });

  it('pinned, when present, is an integer in [1,5]', () => {
    for (const op of ops) {
      if (op.pinned === undefined) continue;
      expect(Number.isInteger(op.pinned), `${op.id}: pinned must be an integer`).toBe(true);
      expect(op.pinned, `${op.id}: pinned must be >= 1`).toBeGreaterThanOrEqual(1);
      expect(op.pinned, `${op.id}: pinned must be <= 5`).toBeLessThanOrEqual(5);
    }
  });

  it('at most 5 ops are pinned per resourceType', () => {
    const countByResourceType = new Map<string, number>();
    for (const op of ops) {
      if (op.pinned === undefined) continue;
      const rt = op.target.resourceType;
      countByResourceType.set(rt, (countByResourceType.get(rt) ?? 0) + 1);
    }
    for (const [resourceType, count] of countByResourceType) {
      expect(count, `${resourceType}: at most 5 ops may be pinned`).toBeLessThanOrEqual(5);
    }
  });
});

/* ── Hollow-create lint (0033 §1.4 — task A1) ─────────────────────────────── */

/**
 * The exact 0033 rule: any op with `group:"create"` and
 * `codemodOp:"instantiate_module"` must have ≥3 non-const params or carry a
 * non-empty `decisions[]` — a create that captures neither a real
 * specification nor a declared engineer-decision list is a hollow create,
 * and hollow creates are CI-red instead of a product-review finding.
 */
export function isHollowCreate(
  op: Pick<ManifestOperation, 'group' | 'codemodOp' | 'params' | 'decisions'>,
): boolean {
  if (op.group !== 'create' || op.codemodOp !== 'instantiate_module') return false;
  const nonConst = op.params.filter((p) => p.role !== 'const').length;
  const hasDecisions = (op.decisions?.length ?? 0) > 0;
  return nonConst < 3 && !hasDecisions;
}

describe.each(catalogs)('hollow-create lint — %s', (_label, ops) => {
  it('every instantiate-class create carries a real schema or a decisions checklist', () => {
    const offenders = ops
      .filter(isHollowCreate)
      .map(
        (op) =>
          `${op.id}: ${op.params.filter((p) => p.role !== 'const').length} non-const params, no decisions[]`,
      );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('hollow-create lint — the rule itself', () => {
  type LintOp = Pick<ManifestOperation, 'group' | 'codemodOp' | 'params' | 'decisions'>;
  const param = (name: string, role?: 'const'): ManifestOperation['params'][number] => ({
    name,
    label: name,
    type: 'string',
    source: 'user_input',
    required: true,
    ...(role ? { role } : {}),
  });
  const hollow: LintOp = {
    group: 'create',
    codemodOp: 'instantiate_module',
    params: [param('purpose')],
  };

  it('goes red on a 1-param instantiate create with no decisions', () => {
    expect(isHollowCreate(hollow)).toBe(true);
  });

  it('a declared decisions checklist satisfies it', () => {
    expect(isHollowCreate({ ...hollow, decisions: ['Engineer designs the rest'] })).toBe(false);
  });

  it('an empty decisions array does NOT satisfy it', () => {
    expect(isHollowCreate({ ...hollow, decisions: [] })).toBe(true);
  });

  it('three or more non-const params satisfy it (const params do not count)', () => {
    expect(isHollowCreate({ ...hollow, params: [param('a'), param('b'), param('c')] })).toBe(false);
    expect(
      isHollowCreate({ ...hollow, params: [param('a'), param('b'), param('c', 'const')] }),
    ).toBe(true);
  });

  it('non-instantiate creates and Change ops are out of scope', () => {
    expect(isHollowCreate({ ...hollow, codemodOp: 'append_block' })).toBe(false);
    expect(isHollowCreate({ ...hollow, group: 'scale-performance' })).toBe(false);
  });
});

describe('0008 §3 op taxonomy — main catalog specifics', () => {
  const ops = allOps(manifests);

  it('has exactly 2 Move ops, matching the decision doc\'s measured count', () => {
    expect(ops.filter((o) => o.macd === 'Move')).toHaveLength(2);
  });

  it('every one of the 8 groups is used at least once', () => {
    const used = new Set(ops.map((o) => o.group));
    for (const g of OP_GROUPS) {
      expect(used.has(g), `group "${g}" is never used by any op`).toBe(true);
    }
  });

  it('at least one op is pinned (the picker has something to shortlist)', () => {
    expect(ops.some((o) => o.pinned !== undefined)).toBe(true);
  });
});
