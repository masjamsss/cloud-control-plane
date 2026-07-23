import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { parseManifests } from '@/types/manifestSchema';
import { opHeadline, opTextLayers } from '@/lib/opText';
import { OpDescription, type OpDescriptionVariant } from '@/components/OpDescription';

/**
 * The inverted operation headline: the AWS Management Console field NAME
 * (`consoleLabel`, falling back to `title`) leads, and the plain `summary` +
 * technical `description` are demoted into ONE folded "What this does" toggle
 * beneath it. Four surfaces (schema / headline / fold / render), all proven
 * without a DOM — renderToStaticMarkup, the repo's jsdom-free UI test style.
 */

const allOps = manifests.flatMap((m) => m.operations);

/* ── (1) Schema — accepts + length-validates the optional consoleLabel ─────── */

// A real shipped op, deep-cloned, so parseManifests exercises the FULL
// ManifestOperation schema rather than a hand-rolled partial.
const baseOp = JSON.parse(
  JSON.stringify(allOps.find((o) => o.id === 'ec2-toggle-termination-protection')),
) as Record<string, unknown>;

function wrap(op: Record<string, unknown>): unknown[] {
  return [
    {
      service: 'test',
      scope: 'estate',
      resourceTypes: ['aws_instance'],
      summary: 'Test manifest.',
      operations: [op],
    },
  ];
}
function withConsoleLabel(consoleLabel: unknown): Record<string, unknown> {
  return { ...baseOp, consoleLabel };
}
function withoutConsoleLabel(): Record<string, unknown> {
  const op = { ...baseOp };
  delete op.consoleLabel;
  return op;
}

describe('manifest schema — optional operation consoleLabel', () => {
  it('accepts an op with an AWS-console field label', () => {
    expect(() => parseManifests(wrap(withConsoleLabel('Instance type')))).not.toThrow();
  });

  it('accepts an op with no consoleLabel at all (optional/additive)', () => {
    expect(() => parseManifests(wrap(withoutConsoleLabel()))).not.toThrow();
  });

  it('accepts a consoleLabel at the 60-char cap', () => {
    expect(() => parseManifests(wrap(withConsoleLabel('x'.repeat(60))))).not.toThrow();
  });

  it('rejects a consoleLabel over the 60-char cap', () => {
    expect(() => parseManifests(wrap(withConsoleLabel('x'.repeat(61))))).toThrow();
  });

  it('rejects an empty consoleLabel (a blank label is a content bug)', () => {
    expect(() => parseManifests(wrap(withConsoleLabel('')))).toThrow();
  });

  it('the bundled catalog validates with the curated consoleLabels in place', () => {
    // The core manifests already carry consoleLabels on their console-mapped ops;
    // a full parse proves the schema addition did not break the shipped catalog.
    expect(() => parseManifests(JSON.parse(JSON.stringify(manifests)))).not.toThrow();
  });
});

/* ── (2) Headline — consoleLabel leads, title is the fallback ──────────────── */

describe('opHeadline — AWS console name leads, title fallback', () => {
  it('consoleLabel present → it IS the headline', () => {
    expect(opHeadline({ consoleLabel: 'Instance type', title: 'Resize an EC2 instance' })).toBe(
      'Instance type',
    );
  });

  it('consoleLabel absent → the op title is the headline (fallback integrity)', () => {
    expect(opHeadline({ title: 'Resize an EC2 instance' })).toBe('Resize an EC2 instance');
  });

  it('a blank / whitespace-only consoleLabel fails closed to the title', () => {
    expect(opHeadline({ consoleLabel: '   ', title: 'Resize an EC2 instance' })).toBe(
      'Resize an EC2 instance',
    );
  });

  it('trims surrounding whitespace on a real consoleLabel', () => {
    expect(opHeadline({ consoleLabel: '  Instance type  ', title: 't' })).toBe('Instance type');
  });
});

/* ── (3) Fold — one disclosure body: plain summary, then technical detail ──── */

describe('opTextLayers — headline + folded summary/description', () => {
  it('consoleLabel present → headline = consoleLabel, summary + description demoted', () => {
    expect(
      opTextLayers({
        consoleLabel: 'Instance type',
        title: 'Resize an EC2 instance',
        summary: 'Change the size of this server.',
        description: 'Set instance_type.',
      }),
    ).toEqual({
      headline: 'Instance type',
      summary: 'Change the size of this server.',
      technicalDetail: 'Set instance_type.',
    });
  });

  it('consoleLabel absent → headline = title, same folded body (fallback)', () => {
    expect(
      opTextLayers({
        title: 'Resize an EC2 instance',
        summary: 'Change the size of this server.',
        description: 'Set instance_type.',
      }),
    ).toEqual({
      headline: 'Resize an EC2 instance',
      summary: 'Change the size of this server.',
      technicalDetail: 'Set instance_type.',
    });
  });

  it('summary absent → only the description sits in the disclosure', () => {
    expect(opTextLayers({ title: 'T', description: 'Set foo_bar.' })).toEqual({
      headline: 'T',
      technicalDetail: 'Set foo_bar.',
    });
  });

  it('description identical to summary → it is not repeated in the body', () => {
    const layers = opTextLayers({ title: 'T', summary: 'Same line.', description: 'Same line.' });
    expect(layers.summary).toBe('Same line.');
    expect(layers.technicalDetail).toBeUndefined();
  });

  it('blank summary / description fail closed to absent', () => {
    const blank = opTextLayers({ title: 'T', summary: '  ', description: '  ' });
    expect(blank).toEqual({ headline: 'T' });
  });
});

/* ── (4) Render — the demoted explanation beneath the surface's name ───────── */

/** The roomy surfaces (form, detail) render a single COLLAPSED "What this does"
 *  disclosure. The compact card renders the plain summary one-liner ONLY. */
const ROOMY: Array<'form' | 'detail'> = ['form', 'detail'];
/** The <details> class per roomy surface (OpDescription puts the surface tech
 *  class on the disclosure itself). */
const TECH_CLASS: Record<'form' | 'detail', string> = {
  form: 'rq-tech',
  detail: 'ap__detail-tech',
};

function render(
  op: { consoleLabel?: string; title: string; summary?: string; description: string },
  variant: OpDescriptionVariant,
): string {
  return renderToStaticMarkup(React.createElement(OpDescription, { op, variant }));
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('OpDescription — roomy surfaces (form, detail): one folded toggle', () => {
  const OP = {
    consoleLabel: 'Instance type',
    title: 'Resize an EC2 instance',
    summary: 'Change the size of this server.',
    description: 'Set instance_type.',
  };

  for (const variant of ROOMY) {
    it(`[${variant}] summary + description fold into ONE collapsed "What this does" toggle`, () => {
      const html = render(OP, variant);
      // The AWS name is the SURFACE's headline element — OpDescription renders only
      // the demoted explanation, so the name never appears in its output.
      expect(html).not.toContain('Instance type');
      expect(html).not.toContain('Resize an EC2 instance');
      // A single disclosure carrying both the plain summary and the technical line.
      expect(html).toContain('<details');
      expect(occurrences(html, '<details')).toBe(1); // never two stacked disclosures
      expect(html).toContain(TECH_CLASS[variant]);
      expect(html).toContain('op-tech__label');
      expect(html).toContain('What this does');
      expect(html).toContain('op-tech__body');
      expect(html).toContain('Change the size of this server.'); // plain summary, in the body
      expect(html).toContain('op-tech__detail');
      expect(html).toContain('Set instance_type.'); // technical description, beneath it
      // Collapsed by DEFAULT — the component never force-opens the <details>.
      expect(html).not.toMatch(/<details[^>]*\sopen[\s/>]/);
    });

    it(`[${variant}] no summary and no distinct description → nothing renders`, () => {
      // A label-only op (name says it all) collapses to an empty OpDescription; the
      // surface's AWS-name headline stands alone.
      const html = render(
        { consoleLabel: 'IOPS', title: 'Set provisioned IOPS', description: '' },
        variant,
      );
      expect(html).toBe('');
    });

    it(`[${variant}] summary-less op still folds its description into the toggle`, () => {
      const html = render({ title: 'Set provisioned IOPS', description: 'Set iops.' }, variant);
      expect(html).toContain('<details');
      expect(html).toContain('What this does');
      expect(html).toContain('Set iops.');
      expect(occurrences(html, 'Set iops.')).toBe(1);
    });
  }
});

describe('OpDescription — compact card: plain summary one-liner ONLY', () => {
  const OP = {
    consoleLabel: 'Instance type',
    title: 'Resize an EC2 instance',
    summary: 'Change the size of this server.',
    description: 'Set instance_type.',
  };

  it('summary present → the plain summary alone; no toggle, no technical detail, no name', () => {
    const html = render(OP, 'card');
    expect(html).toContain('Change the size of this server.'); // the plain summary line
    expect(html).toContain('console__add-desc');
    // The card can host no interactive <details>; the AWS name is the card's own
    // title element; the technical description lives on the op's page.
    expect(html).not.toContain('<details');
    expect(html).not.toContain('What this does');
    expect(html).not.toContain('Set instance_type.');
    expect(html).not.toContain('Instance type');
  });

  it('summary absent → nothing renders (the card title carries the name)', () => {
    const html = render({ title: 'Set provisioned IOPS', description: 'Set iops.' }, 'card');
    expect(html).toBe('');
  });
});

/* ── (5) Proven on the real shipped ops ────────────────────────────────────── */

describe('OpDescription / opHeadline — real shipped ops', () => {
  const byId = (id: string) => allOps.find((o) => o.id === id)!;

  it('(a) an op WITH a consoleLabel leads with it; its summary is demoted into the toggle', () => {
    const op = byId('ec2-resize');
    expect(op.consoleLabel).toBe('Instance type');
    // Headline is the AWS name…
    expect(opHeadline(op)).toBe('Instance type');
    // …and the plain summary is no longer the headline — it sits inside the toggle.
    const html = render(op, 'detail');
    expect(html).toContain('<details');
    expect(html).toContain('What this does');
    expect(html).toContain(op.summary!); // plain summary, in the body
    expect(html).toContain('op-tech__detail'); // the technical description beneath it
    expect(html).not.toContain('Instance type'); // OpDescription never renders the name
  });

  it('(b) a consoleLabel-less op falls back to its title as the headline (tail-service integrity)', () => {
    // Most tail-service ops carry no consoleLabel; a real one proves the fallback.
    const op = byId('lambda-set-layer-skip-destroy');
    expect(op.consoleLabel).toBeUndefined();
    expect(opHeadline(op)).toBe(op.title);
  });
});
