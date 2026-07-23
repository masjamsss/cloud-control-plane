import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { parseManifests } from '@/types/manifestSchema';
import bootstrapIam from '@/data/projects/bootstrap/manifests/iam.json';
import bootstrapKms from '@/data/projects/bootstrap/manifests/kms.json';
import bootstrapS3 from '@/data/projects/bootstrap/manifests/s3.json';
import type { ManifestOperation, ManifestParam, ServiceManifest } from '@/types';

/**
 * Verb-shape lints (0031 S4 + L1) — two exit-0 mis-edit classes the census
 * exposed, made mechanical so they can never be re-authored:
 *
 *   1. S4 — a `remove_block` op whose macd is NOT "Delete" removes a NESTED
 *      block (a sub-setting), so it must carry a non-empty `target.path`.
 *      Without one the verb takes the whole-resource removal path: measured,
 *      `eventbridge-remove-target-dead-letter-queue` (macd "Change") deleted
 *      the ENTIRE aws_cloudwatch_event_target at exit 0 while its title
 *      promised to remove only the DLQ sub-block. A Change-labelled op must
 *      never be able to destroy the resource it claims to edit.
 *
 *   2. L1 — `set_attribute` writes only the FIRST value-provider param
 *      (catalogctl valueParam); every additional value param validates,
 *      shows up in the request evidence, and never reaches HCL. Measured:
 *      s3-set-public-access-block wrote 1 of 4 public-access flags. Any op
 *      that names several values must use the all-or-nothing `set_attributes`
 *      verb (or a foreach/discriminator shape) — or carry a documented
 *      exception below while it waits on a missing verb capability.
 *
 * Both catalogs (main + the bootstrap project's vendored set) are linted,
 * same as opTaxonomy.
 */

const bootstrapManifests = parseManifests([bootstrapIam, bootstrapKms, bootstrapS3]);

function allOps(ms: ServiceManifest[]): ManifestOperation[] {
  return ms.flatMap((m) => m.operations);
}

const catalogs: [string, ManifestOperation[]][] = [
  ['main catalog', allOps(manifests)],
  ['bootstrap project catalog', allOps(bootstrapManifests)],
];

/** Mirror of catalogctl's isValueProvider (internal/edit/value.go): a param
 * that WRITES a value — reference-role or any non-inventory source; selector
 * and discriminator params only pick a block/attr and never write. */
export function isValueProvider(p: ManifestParam): boolean {
  if (p.role === 'selector' || p.role === 'discriminator') return false;
  return p.role === 'reference' || p.source !== 'inventory';
}

/**
 * Ops that still declare >1 value provider on `set_attribute`, each waiting
 * on a verb capability that does not exist yet. Every entry documents why it
 * is not silently unsafe TODAY; the stale-guard below fails the moment an
 * entry stops matching, so this table can only shrink honestly.
 * forcesReplace:true ops are out of scope by construction — the executor
 * refuses FORCES_REPLACE before any transformer runs (edit.go), so their
 * extra params can never be silently dropped.
 */
const MULTI_VALUE_EXCEPTIONS: Record<string, string> = {
  'sns-set-delivery-retry-policy':
    'composes two numbers into the delivery_policy JSON document — needs a template-materializer verb; ' +
    'as authored it errors loudly pre-write (exit 1 "param is not a map" via the map-merge target), never a partial write',
  'vpn-rotate-tunnel-psk':
    'needs a secret-resolution seam (the written value must be a Secrets Manager reference, not the literal secret name); ' +
    'as authored it writes a phantom tunnel-number attribute that terraform validate rejects in the PR lane — loud-but-broken, ' +
    'and engineer-only exposure means every run is reviewed',
};

describe.each(catalogs)(
  'S4 lint — Change-labelled remove_block is nested-scoped — %s',
  (_l, ops) => {
    it('every non-Delete remove_block op carries a non-empty target.path', () => {
      const offenders = ops
        .filter((o) => o.codemodOp === 'remove_block' && o.macd !== 'Delete')
        .filter((o) => (o.target.path?.length ?? 0) === 0)
        .map(
          (o) =>
            `${o.id} (macd ${o.macd}): remove_block without target.path removes the WHOLE resource`,
        );
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  },
);

describe('S4 lint — the measured op is pinned to the surgical shape', () => {
  it('eventbridge-remove-target-dead-letter-queue removes exactly the dead_letter_config sub-block', () => {
    const op = allOps(manifests).find(
      (o) => o.id === 'eventbridge-remove-target-dead-letter-queue',
    )!;
    expect(op.macd).toBe('Change');
    expect(op.codemodOp).toBe('remove_block');
    expect(op.target.path).toEqual(['dead_letter_config']);
    // The safety fields the fix deliberately did NOT move.
    expect(op.exposure).toBe('l1_with_guardrails');
    expect(op.riskFloor).toBe('MEDIUM');
    expect(op.forcesReplace).toBe(false);
  });
});

describe.each(catalogs)(
  'L1 lint — multi-value set_attribute is a partial write — %s',
  (_l, ops) => {
    it('no executable set_attribute op declares more than one value provider', () => {
      const offenders = ops
        .filter((o) => o.codemodOp === 'set_attribute' && o.forcesReplace === false)
        .filter((o) => o.params.filter(isValueProvider).length > 1)
        .filter((o) => !(o.id in MULTI_VALUE_EXCEPTIONS))
        .map(
          (o) =>
            `${o.id}: ${o.params.filter(isValueProvider).length} value providers on set_attribute — ` +
            'only the first is ever written; re-verb to set_attributes or add a documented exception',
        );
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  },
);

describe('L1 lint — the exception table can only shrink honestly', () => {
  it('every exception still names a live multi-value set_attribute op', () => {
    const ops = allOps(manifests);
    const stale = Object.keys(MULTI_VALUE_EXCEPTIONS).filter((id) => {
      const op = ops.find((o) => o.id === id);
      return (
        !op ||
        op.codemodOp !== 'set_attribute' ||
        op.forcesReplace !== false ||
        op.params.filter(isValueProvider).length <= 1
      );
    });
    expect(stale, `stale exception entries (remove them): ${stale.join(', ')}`).toEqual([]);
  });
});

/* ── L2 lint — bounds.semantic is prose, not enforcement (0031 §5.2) ─────── */

/**
 * catalogctl's Go Bounds struct has no Semantic field and the SPA only acts
 * on /cidr/i-matching semantics, so a `semantic` string with no machine bound
 * beside it is a promise the machine never keeps (measured: the 0.0.0.0/0
 * world-open ingress at exit 0, F1). Rule: on a VALUE-WRITING param (anything
 * not inventory-sourced — inventory params are locators whose "must exist in
 * the estate" semantics ARE machine-enforced by the executor's locate step
 * and the picker's enumSource), a `semantic` must be accompanied by at least
 * one machine-enforced bound. And no pattern may carry an any-non-space
 * alternative (`|[^\s]+`) — the ssm-parameter "pointer, never a literal
 * secret" pattern was a tautology that accepted any pasted secret.
 */
const MACHINE_BOUNDS = [
  'allowlist',
  'min',
  'max',
  'minItems',
  'maxItems',
  'maxLength',
  'pattern',
  'growOnly',
  'cidrPolicy',
  'maxPrefixLen',
] as const;

describe.each(catalogs)('L2 lint — semantic prose needs a machine bound — %s', (_l, ops) => {
  it('every semantic on a value-writing param is accompanied by a machine bound', () => {
    const offenders: string[] = [];
    for (const op of ops) {
      for (const p of op.params) {
        if (!p.bounds?.semantic || p.source === 'inventory') continue;
        const hasMachine = MACHINE_BOUNDS.some(
          (k) => (p.bounds as Record<string, unknown>)[k] !== undefined,
        );
        if (!hasMachine)
          offenders.push(`${op.id}.${p.name}: semantic-only bounds (unenforced prose)`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no pattern contains a tautological any-non-space alternative', () => {
    const offenders: string[] = [];
    for (const op of ops) {
      for (const p of op.params) {
        if (p.bounds?.pattern?.includes('|[^\\s]+')) {
          offenders.push(
            `${op.id}.${p.name}: pattern ${p.bounds.pattern} accepts any non-space string`,
          );
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every bounds.pattern compiles as a regular expression', () => {
    const offenders: string[] = [];
    for (const op of ops) {
      for (const p of op.params) {
        if (!p.bounds?.pattern) continue;
        try {
          new RegExp(p.bounds.pattern);
        } catch (e) {
          offenders.push(`${op.id}.${p.name}: ${String(e)}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
