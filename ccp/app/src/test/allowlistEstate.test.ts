import { describe, expect, it } from 'vitest';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import type { Inventory, ManifestOperation, ManifestParam } from '@/types';

/**
 * allowlist-covers-estate lint (0034 D1/G3) — an allowlist must never drift
 * away from the estate it governs.
 *
 * The defect class this makes mechanical: `ec2-resize` shipped an
 * r6i/m6i/c6i allowlist while the estate ran zero hosts in those families —
 * every real resize ticket dead-ended into "the size I need isn't offered"
 * (0034 S7). The same drift hit `rds-modify-instance-class` (omitted the
 * current db.t3.xlarge) and `rds-change-parameter-group` (omitted the current
 * default.postgres16) — S20/S22.
 *
 * Rule: for every Change op whose allowlisted param edits an attribute the
 * inventory carries for the op's target resource type, every DISTINCT current
 * estate value of that attribute must appear in the allowlist. The attribute
 * a param edits follows the executor's own resolution (manifests.AttrFor,
 * mirrored in scripts/lib/forcenewShared.ts): explicit `attr` wins, else the
 * param name with the `new_` prefix stripped.
 *
 * Deliberate one-direction ops are the ONLY sanctioned exception: an op that
 * exists to move resources OFF a value (gp2→gp3 migration, TLS-policy
 * modernization) must not offer that value as a destination. Each exclusion
 * is declared below with its reason, and a stale-entry guard fails when an
 * exclusion stops matching reality — the table can only ever shrink honestly.
 */

const inventory = inventoryData as unknown as Inventory;

/** Sanctioned current-value exclusions — one-direction ops only. */
const DIRECTIONAL_EXCLUSIONS: {
  opId: string;
  param: string;
  value: string;
  reason: string;
}[] = [
  {
    opId: 'ebs-gp2-to-gp3',
    param: 'target_type',
    value: 'gp2',
    reason:
      'one-direction migration: gp2 is the source fleet (323 volumes), never a destination — moving back to gp2 is not offered',
  },
  {
    opId: 'acm-lb-listener-set-tls-policy',
    param: 'tls_policy',
    value: 'ELBSecurityPolicy-2016-08',
    reason:
      'one-direction modernization: the op exists to move listeners off the 2016 policy (0034 S42); offering it as a destination would defeat the compliance ticket',
  },
];

/** The attribute a param writes — the executor's AttrFor resolution. */
function attrFor(p: ManifestParam): string {
  return p.attr ?? p.name.replace(/^new_/, '');
}

interface Finding {
  opId: string;
  param: string;
  attr: string;
  resourceType: string;
  rows: number;
  missing: string[];
}

/** Every (Change op, allowlisted param) pair whose attr the inventory carries. */
function auditAllowlists(): { findings: Finding[]; auditedPairs: number } {
  const byType = new Map<string, Record<string, unknown>[]>();
  for (const r of inventory.resources) {
    const list = byType.get(r.resourceType) ?? [];
    list.push(r.attributes as Record<string, unknown>);
    byType.set(r.resourceType, list);
  }

  const findings: Finding[] = [];
  let auditedPairs = 0;
  const ops: ManifestOperation[] = manifests.flatMap((m) => m.operations);
  for (const op of ops) {
    if (op.macd !== 'Change') continue;
    const rows = byType.get(op.target.resourceType) ?? [];
    if (rows.length === 0) continue;
    for (const p of op.params) {
      const allowlist = p.bounds?.allowlist;
      if (!allowlist || allowlist.length === 0) continue;
      const attr = attrFor(p);
      const carried = rows.filter((a) => a[attr] !== undefined);
      if (carried.length === 0) continue; // attribute not enumerable from inventory
      auditedPairs += 1;
      const allowed = new Set(allowlist.map((v) => String(v)));
      const excluded = new Set(
        DIRECTIONAL_EXCLUSIONS.filter((e) => e.opId === op.id && e.param === p.name).map(
          (e) => e.value,
        ),
      );
      const missing = [...new Set(carried.map((a) => String(a[attr])))].filter(
        (v) => !allowed.has(v) && !excluded.has(v),
      );
      if (missing.length > 0) {
        findings.push({
          opId: op.id,
          param: p.name,
          attr,
          resourceType: op.target.resourceType,
          rows: carried.length,
          missing: missing.sort(),
        });
      }
    }
  }
  return { findings, auditedPairs };
}

const audit = auditAllowlists();

describe('allowlist-covers-estate (0034 D1) — Change-op allowlists include every current estate value', () => {
  it('audits a real slice of the catalog (sanity — the attr derivation still finds enumerable pairs)', () => {
    // ec2-resize instance_type, rds instance_class/parameter_group, the ebs
    // volume-type migration and the boolean toggles all qualify today.
    expect(audit.auditedPairs).toBeGreaterThanOrEqual(5);
  });

  it('no allowlist omits a value the estate currently runs', () => {
    const table = audit.findings.map(
      (f) =>
        `${f.opId} · param ${f.param} → ${f.resourceType}.${f.attr} (${f.rows} estate rows): missing ${f.missing.join(', ')}`,
    );
    expect(table, `allowlist drift:\n${table.join('\n')}`).toEqual([]);
  });

  it('every directional exclusion still matches a live op/param and a live estate value (no stale entries)', () => {
    const ops = new Map(manifests.flatMap((m) => m.operations).map((o) => [o.id, o] as const));
    const byType = new Map<string, Record<string, unknown>[]>();
    for (const r of inventory.resources) {
      const list = byType.get(r.resourceType) ?? [];
      list.push(r.attributes as Record<string, unknown>);
      byType.set(r.resourceType, list);
    }
    const stale: string[] = [];
    for (const e of DIRECTIONAL_EXCLUSIONS) {
      const op = ops.get(e.opId);
      const p = op?.params.find((x) => x.name === e.param);
      if (!op || !p) {
        stale.push(`${e.opId}/${e.param}: op or param no longer exists`);
        continue;
      }
      if (p.bounds?.allowlist?.map(String).includes(e.value)) {
        stale.push(`${e.opId}/${e.param}: ${e.value} is now IN the allowlist — exclusion is dead`);
      }
      const attr = attrFor(p);
      const values = new Set(
        (byType.get(op.target.resourceType) ?? [])
          .filter((a) => a[attr] !== undefined)
          .map((a) => String(a[attr])),
      );
      if (!values.has(e.value)) {
        stale.push(
          `${e.opId}/${e.param}: the estate no longer runs ${e.value} — exclusion is dead`,
        );
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('ec2-resize offers the family and size of every running host (0034 S7 acceptance)', () => {
    const op = manifests.flatMap((m) => m.operations).find((o) => o.id === 'ec2-resize');
    expect(op).toBeDefined();
    const allowed = new Set(
      (op!.params.find((p) => p.name === 'new_instance_type')?.bounds?.allowlist ?? []).map(String),
    );
    const running = new Set(
      inventory.resources
        .filter((r) => r.resourceType === 'aws_instance')
        .map((r) => String((r.attributes as Record<string, unknown>).instance_type)),
    );
    const uncovered = [...running].filter((t) => !allowed.has(t)).sort();
    expect(uncovered, `running sizes missing from ec2-resize: ${uncovered.join(', ')}`).toEqual([]);
  });
});
