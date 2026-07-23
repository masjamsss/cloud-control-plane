import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ManifestOperation } from '@/types';
import {
  ReplaceConfirmGate,
  isReplaceOp,
  replaceConfirmMet,
} from '@/features/request/ReplaceConfirmGate';

/**
 * The destroy-and-recreate danger gate on the review page. It must: appear ONLY for a
 * forces-replace op; show what is destroyed/recreated using the shared consequence table;
 * demand the exact resource name; and state the two-approval requirement. The submit gate
 * (replaceConfirmMet) matches the same binding the server + executor enforce.
 */

const base = {
  service: 'ebs',
  macd: 'Change',
  codemodOp: 'set_attribute',
  riskFloor: 'HIGH',
  reversible: false,
  downtime: 'stop-start',
  exposure: 'engineer_only',
  autoEligible: false,
  terraformCapability: '~ update',
  group: 'change',
  title: 'Toggle encryption',
  description: 'fixture',
  params: [
    { name: 'volume', label: 'Volume', type: 'string', source: 'inventory', required: true },
  ],
} as const;

function op(overrides: Partial<ManifestOperation> = {}): ManifestOperation {
  return {
    ...base,
    id: 'ebs-set-encrypted',
    forcesReplace: true,
    target: { resourceType: 'aws_ebs_volume' },
    ...overrides,
  } as unknown as ManifestOperation;
}

const ADDR = 'aws_ebs_volume.app01';

describe('replaceConfirmMet — the submit binding', () => {
  it('a non-forces-replace op is always allowed (no confirmation needed)', () => {
    const plain = op({ forcesReplace: false });
    expect(replaceConfirmMet(plain, ADDR, '')).toBe(true);
    expect(isReplaceOp(plain)).toBe(false);
  });

  it('a forces-replace op requires an EXACT match to the target address', () => {
    const replace = op();
    expect(isReplaceOp(replace)).toBe(true);
    expect(replaceConfirmMet(replace, ADDR, '')).toBe(false);
    expect(replaceConfirmMet(replace, ADDR, 'aws_ebs_volume.other')).toBe(false);
    expect(replaceConfirmMet(replace, ADDR, ADDR)).toBe(true);
    expect(replaceConfirmMet(replace, ADDR, `  ${ADDR}  `)).toBe(true); // trims surrounding space
    expect(replaceConfirmMet(replace, '', '')).toBe(false); // no target ⇒ never satisfied
  });
});

describe('ReplaceConfirmGate — the danger panel', () => {
  it('renders nothing for a normal op', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReplaceConfirmGate, {
        op: op({ forcesReplace: false }),
        targetAddress: ADDR,
        value: '',
        onChange: () => {},
      }),
    );
    expect(html).toBe('');
  });

  it('a curated type shows the danger warning, the address, the consequence + data badge, and two approvals', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReplaceConfirmGate, {
        op: op(),
        targetAddress: ADDR,
        value: '',
        onChange: () => {},
      }),
    );
    expect(html).toContain('Danger');
    expect(html).toContain('destroys and recreates');
    expect(html).toContain(ADDR); // the exact resource being replaced
    expect(html).toContain('Data inside is destroyed'); // aws_ebs_volume.destroysData
    expect(html).toContain('two senior approvals');
    expect(html).toContain('rq-danger__input'); // the typed-confirmation field exists
    expect(html).toContain('type its name exactly');
  });

  it('an uncurated type still shows a generic destroy+recreate warning + the confirm field', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReplaceConfirmGate, {
        op: op({ target: { resourceType: 'aws_route53_zone' } }),
        targetAddress: 'aws_route53_zone.main',
        value: '',
        onChange: () => {},
      }),
    );
    expect(html).toContain('Danger');
    expect(html).toContain('torn down'); // the generic fallback copy
    expect(html).toContain('two senior approvals');
    expect(html).toContain('rq-danger__input');
  });

  it('marks the field invalid while the typed value does not match, valid once it does', () => {
    const mismatch = renderToStaticMarkup(
      React.createElement(ReplaceConfirmGate, {
        op: op(),
        targetAddress: ADDR,
        value: 'aws_ebs_volume.wrong',
        onChange: () => {},
      }),
    );
    expect(mismatch).toContain('aria-invalid="true"');
    expect(mismatch).toContain('does not match');

    const ok = renderToStaticMarkup(
      React.createElement(ReplaceConfirmGate, {
        op: op(),
        targetAddress: ADDR,
        value: ADDR,
        onChange: () => {},
      }),
    );
    expect(ok).toContain('aria-invalid="false"');
    expect(ok).toContain('the name matches');
  });
});
