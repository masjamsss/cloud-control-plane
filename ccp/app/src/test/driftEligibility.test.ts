import { describe, expect, it } from 'vitest';
import {
  classifyDrift,
  normalizeSegments,
  pathExpressible,
  type ClassifiableVerdict,
} from '@/lib/driftEligibility';

/**
 * Direct unit coverage for the two pieces of the drift-audit fix program
 * this app owns independently of the shared cross-language fixture
 * (tools/catalogctl/testdata/driftpropose/eligibility-cases.json):
 *
 *  - F7: Object.hasOwn prototype-safety (the fixture's own `hostile-class-
 *    proto` case is Lane A's to land; this file proves the app's behavior
 *    regardless of when that lands — see driftEligibilityParity.test.ts for
 *    the byte-for-byte cross-language proof once it does).
 *  - F8 / addendum A4: normalizeSegments + pathExpressible(path,
 *    pathSegments?) — the structured-path expressibility contract.
 *
 * Also locks in the reason-string enrichment (plan §2) and the documented,
 * deliberate deviation from the plan's byte-pinned text for three classes
 * (D3/D3b/D7) whose literal notes conflict with this app's own
 * copy-quality gates (src/test/copyLint.test.ts) — see the block comment on
 * KNOWN_CLASSES in lib/driftEligibility.ts for the full rationale. D4
 * (`oob_deletion`) no longer belongs to that deviation set: the drift
 * restore tranche (L29) retired its note entirely in favor of a dedicated
 * branch — see the "restore" describe block below, pinned against the
 * shared fixture's `oob-deletion-*` cases.
 */

function baseAdoptEligible(overrides: Partial<ClassifiableVerdict> = {}): ClassifiableVerdict {
  return {
    class: 'benign_inplace',
    riskTier: 'low',
    actions: ['update'],
    forceNewAttrs: [],
    driftEvidence: true,
    securityHits: [],
    changedAttrs: [{ path: 'tags.Owner', sensitive: false, liveJson: 'a', codeJson: 'b' }],
    ...overrides,
  };
}

describe('F7 — Object.hasOwn prototype-safety', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'class %j never resolves through the prototype chain — always ungenerable, never adopt',
    (hostileClass) => {
      const v = baseAdoptEligible({ class: hostileClass });
      const result = classifyDrift(v);
      expect(result.bucket).toBe('ungenerable');
      expect(result.reason).toBe(
        `unknown class ${JSON.stringify(hostileClass)} — fail-closed, needs-human (the eleven-class D1-D11 enum is closed)`,
      );
    },
  );

  it('a real, known class is unaffected by the hasOwn change', () => {
    expect(classifyDrift(baseAdoptEligible()).bucket).toBe('adopt');
  });
});

describe('normalizeSegments', () => {
  it('absent pathSegments is LEGACY', () => {
    expect(normalizeSegments(undefined)).toEqual({ kind: 'legacy' });
  });

  it('a well-formed array of strings/non-negative integers is SEGMENTS', () => {
    expect(normalizeSegments(['tags', 'kubernetes.io/role/elb'])).toEqual({
      kind: 'segments',
      segments: ['tags', 'kubernetes.io/role/elb'],
    });
    expect(normalizeSegments(['metadata_options', 0, 'http_tokens'])).toEqual({
      kind: 'segments',
      segments: ['metadata_options', 0, 'http_tokens'],
    });
  });

  it.each([
    ['not an array', 'a string'],
    ['an empty array', []],
    ['a negative index', ['ingress', -1, 'cidr_blocks']],
    ['a fractional number', ['tags', 1.5]],
    ['a boolean element', ['tags', true]],
    ['an object element', ['tags', {}]],
    ['null', null],
  ])('%s is MALFORMED', (_label, value) => {
    expect(normalizeSegments(value)).toEqual({ kind: 'malformed' });
  });
});

describe('pathExpressible(path, pathSegments?)', () => {
  it('LEGACY (pathSegments absent) matches the pre-F8 display-path rule exactly', () => {
    expect(pathExpressible('tags.Owner')).toBe(true);
    expect(pathExpressible('instance_type')).toBe(true);
    expect(pathExpressible('root_block_device.ebs.volume_size')).toBe(false); // 3 dot-parts
    expect(pathExpressible('ingress[0].cidr_blocks')).toBe(false); // brackets
    expect(pathExpressible('')).toBe(false);
  });

  it('[s] scalar is expressible', () => {
    expect(pathExpressible('instance_type', ['instance_type'])).toBe(true);
  });

  it('[s, s] map key is expressible for ANY key bytes — dotted, slashed, spaced', () => {
    expect(pathExpressible('tags.a', ['tags', 'a'])).toBe(true);
    expect(pathExpressible('x', ['tags', 'kubernetes.io/role/elb'])).toBe(true);
    expect(pathExpressible('x', ['tags', 'Cost Center'])).toBe(true);
  });

  it('[s, 0, s] single-instance nested-block leaf is expressible; any other index is not', () => {
    expect(pathExpressible('x', ['metadata_options', 0, 'http_tokens'])).toBe(true);
    expect(pathExpressible('x', ['metadata_options', 1, 'http_tokens'])).toBe(false);
  });

  it('4+ segments and malformed segments are never expressible', () => {
    expect(pathExpressible('x', ['a', 'b', 'c', 'd'])).toBe(false);
    expect(pathExpressible('x', 'not-an-array')).toBe(false);
    expect(pathExpressible('x', [])).toBe(false);
  });

  it('a dotted tag key is refused under LEGACY but adopt-eligible once pathSegments is present — the F8 unlock', () => {
    const legacyPath = 'tags.kubernetes.io/role/elb';
    expect(pathExpressible(legacyPath)).toBe(false); // mis-split by the dot rule
    expect(pathExpressible(legacyPath, ['tags', 'kubernetes.io/role/elb'])).toBe(true);
  });
});

describe('classifyDrift — pathSegments flow through to the adopt-eligibility check', () => {
  it('a dotted tag key with structured segments is adopt-eligible end to end', () => {
    const v = baseAdoptEligible({
      changedAttrs: [
        {
          path: 'tags.kubernetes.io/role/elb',
          sensitive: false,
          liveJson: 'owned',
          codeJson: 'shared',
          pathSegments: ['tags', 'kubernetes.io/role/elb'],
        },
      ],
    });
    expect(classifyDrift(v)).toEqual({ bucket: 'adopt', reason: 'benign in-place drift — adopt-eligible' });
  });

  it('a repeated-block shape (index 1) is refused, never guessed', () => {
    const v = baseAdoptEligible({
      changedAttrs: [
        {
          path: 'ingress[1].cidr_blocks',
          sensitive: false,
          liveJson: ['10.0.0.0/16'],
          codeJson: ['10.0.1.0/24'],
          pathSegments: ['ingress', 1, 'cidr_blocks'],
        },
      ],
    });
    expect(classifyDrift(v).bucket).toBe('ungenerable');
  });
});

/* ── Reason-string enrichment (plan §2) — locks in the exact behavior,
   including the documented deviation for D3/D3b/D7 ── */

// oob_deletion is deliberately EXCLUDED here (unlike security_posture, which
// never belonged in this list either): the drift restore tranche (L29) gave
// it its own dedicated branch in classifyDrift, BEFORE the generic
// per-class message this describe block pins — see the "restore" describe
// block below for oob_deletion's own reason-string coverage.
const NON_BENIGN_CLASSES = [
  'replacement_forcenew',
  'replacement_risk',
  'legit_churn',
  'provider_noise',
  'state_anomaly',
  'moved_refactor',
  'unapplied_config',
  'churn_absorbed',
];

describe('reason-string enrichment — every non-benign known class', () => {
  it.each(NON_BENIGN_CLASSES)('class %j is ungenerable with the "is not auto-generable in v1" prefix', (cls) => {
    const v = baseAdoptEligible({ class: cls });
    const result = classifyDrift(v);
    expect(result.bucket).toBe('ungenerable');
    expect(result.reason.startsWith(`class ${JSON.stringify(cls)} is not auto-generable in v1 — `)).toBe(true);
  });

  it('NONE of the enriched notes contain the banned section-sign or a bare 00NN-shaped proposal/register reference — this app\'s own copy-quality gate (copyLint.test.ts) bans both in rendered strings, so this mirrors that rule at the source', () => {
    const sectionSign = /§/;
    const proposalRef = /\b00\d{2}[a-z]?\b|\bADR-\d+/i;
    for (const cls of NON_BENIGN_CLASSES) {
      const { reason } = classifyDrift(baseAdoptEligible({ class: cls }));
      expect(reason, `${cls}: ${reason}`).not.toMatch(sectionSign);
      expect(reason, `${cls}: ${reason}`).not.toMatch(proposalRef);
    }
  });

  it('legit_churn/state_anomaly/moved_refactor/unapplied_config/churn_absorbed are byte-identical to the plan (no deviation needed)', () => {
    expect(classifyDrift(baseAdoptEligible({ class: 'legit_churn' })).reason).toBe(
      'class "legit_churn" is not auto-generable in v1 — ignore_changes + registry row — an engineer PR per runbook D6',
    );
    expect(classifyDrift(baseAdoptEligible({ class: 'state_anomaly' })).reason).toBe(
      'class "state_anomaly" is not auto-generable in v1 — state surgery per docs/runbooks/state-recovery.md (runbook D8)',
    );
    expect(classifyDrift(baseAdoptEligible({ class: 'moved_refactor' })).reason).toBe(
      'class "moved_refactor" is not auto-generable in v1 — verify the moved{} no-op per runbook D9',
    );
    expect(classifyDrift(baseAdoptEligible({ class: 'unapplied_config' })).reason).toBe(
      'class "unapplied_config" is not auto-generable in v1 — merged code awaiting the normal apply lane (runbook D10) — not console drift',
    );
    expect(classifyDrift(baseAdoptEligible({ class: 'churn_absorbed' })).reason).toBe(
      'class "churn_absorbed" is not auto-generable in v1 — already absorbed by an existing ignore_changes (runbook D11)',
    );
  });
});

/* ── L29 (drift restore tranche): oob_deletion's own dedicated branch —
   pinned byte-for-byte against the shared fixture's four `oob-deletion-*`
   cases (tools/catalogctl/testdata/driftpropose/eligibility-cases.json),
   this app's own copy of that proof lives in
   driftEligibilityParity.test.ts; this file locks in the SAME behavior
   directly, one condition at a time, so a regression here fails close to
   the code that would cause it. ── */

function oobDeletionVerdict(overrides: Partial<ClassifiableVerdict> = {}): ClassifiableVerdict {
  return {
    class: 'oob_deletion',
    riskTier: 'high',
    actions: ['create'],
    forceNewAttrs: [],
    driftEvidence: true,
    securityHits: [],
    changedAttrs: [],
    ...overrides,
  };
}

describe('classifyDrift — restore (drift restore tranche, L29, oob_deletion)', () => {
  it('actions [create] + driftEvidence true + no securityHits ⇒ restore, byte-pinned reason', () => {
    expect(classifyDrift(oobDeletionVerdict())).toEqual({
      bucket: 'restore',
      reason: 'out-of-band deletion — restore-eligible (re-assert code; the plan re-creates the deleted resource)',
    });
  });

  it('actions not exactly [create] ⇒ ungenerable, the restore-specific reason (never the generic per-class message)', () => {
    const v = oobDeletionVerdict({ actions: ['update'] });
    expect(classifyDrift(v)).toEqual({
      bucket: 'ungenerable',
      reason:
        'oob_deletion drift with actions [update] (not a pure create) — not mechanically restorable, human decision required (runbook D4)',
    });
  });

  it('no drift evidence ⇒ ungenerable, reusing the byte-pinned D10 reason verbatim', () => {
    const v = oobDeletionVerdict({ driftEvidence: false });
    expect(classifyDrift(v)).toEqual({
      bucket: 'ungenerable',
      reason: 'no drift evidence — unapplied config, not drift (see runbook D10)',
    });
  });

  it('wrong actions is checked BEFORE missing evidence — both wrong ⇒ the sharper actions reason wins', () => {
    const v = oobDeletionVerdict({ actions: ['update'], driftEvidence: false });
    expect(classifyDrift(v).reason).toContain('not a pure create');
  });

  it('a forged securityHits row on an oob_deletion verdict routes to the UNCONDITIONAL security-posture branch, never restore — enforcement point 1, re-asserted client-side (an honest classifier can never emit this: changedAttrs is structurally [] on a pure create)', () => {
    const forged = oobDeletionVerdict({ securityHits: [{ path: 'traffic_type', why: 'forged' }] });
    expect(classifyDrift(forged)).toEqual({
      bucket: 'ungenerable',
      reason:
        'security-posture drift with actions [create] (not a pure in-place update) — not mechanically revertible, human decision required (runbook D2)',
    });
  });

  it('the KNOWN_CLASSES oob_deletion note is retired — no oob_deletion reason string ever reads as the generic "is not auto-generable in v1" message', () => {
    for (const overrides of [{}, { actions: ['update'] }, { driftEvidence: false }]) {
      const { reason } = classifyDrift(oobDeletionVerdict(overrides));
      expect(reason).not.toContain('is not auto-generable in v1');
    }
  });

  it('none of the restore-branch reason strings contain the banned section-sign or a bare proposal/register reference', () => {
    const sectionSign = /§/;
    const proposalRef = /\b00\d{2}[a-z]?\b|\bADR-\d+/i;
    const cases = [
      oobDeletionVerdict(),
      oobDeletionVerdict({ actions: ['update'] }),
      oobDeletionVerdict({ driftEvidence: false }),
      oobDeletionVerdict({ securityHits: [{ path: 'traffic_type', why: 'forged' }] }),
    ];
    for (const v of cases) {
      const { reason } = classifyDrift(v);
      expect(reason, reason).not.toMatch(sectionSign);
      expect(reason, reason).not.toMatch(proposalRef);
    }
  });
});
