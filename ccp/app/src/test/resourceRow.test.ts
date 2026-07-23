import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Inventory, InventoryResource, ManifestOperation } from '@/types';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import { isResourceScopedAdd, isScopedAction } from '@/lib/actionPicker';
import { ResourceRow } from '@/features/services/ResourceRow';

/**
 * 0034 Addendum D17 acceptance, exercised on the rendered card itself (no
 * jsdom — renderToStaticMarkup): in the default card state no raw snake_case
 * identifier and no full ARN is *visible*. Two deliberate scopings, both from
 * the same Addendum text:
 *
 *   1. The Terraform address line (`rr__addr`) is the sanctioned technical
 *      layer — D17 keeps it "as the secondary mono line" by name — so the
 *      visible-text assertion strips exactly that one element.
 *   2. String attribute VALUES are estate data (a security group description
 *      like "AZURE_TO_AWS_SG" is the operator's searchable truth) and render
 *      verbatim; what the card OWNS — the primary label, every chip label,
 *      and ARN display — is what is held snake-free/ARN-free here, across
 *      the entire bundled estate.
 */

const inventory = inventoryData as unknown as Inventory;
const SNAKE = /[A-Za-z0-9]_[A-Za-z0-9]/;

function render(resource: InventoryResource): string {
  // actions: [] renders the read-only card (no menu). The row's main area is now
  // a Link to the resource detail page, so a MemoryRouter is provided; the
  // default card state under test is otherwise the same.
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ResourceRow, {
        serviceSlug: resource.service ?? 'svc',
        resource,
        actions: [],
        onOpenPicker: () => undefined,
      }),
    ),
  );
}

/** The card's visible text, minus the sanctioned mono address line. Tags are
 * dropped WITH their attributes, so hover titles (the full-ARN layer) do not
 * count as visible — exactly the "default card state" the Addendum means. */
function visibleText(html: string): string {
  return html.replace(/<div class="rr__addr">.*?<\/div>/, '').replace(/<[^>]*>/g, ' ');
}

function primaryLabel(html: string): string {
  const m = html.match(/<div class="rr__name">(.*?)<\/div>/);
  return m?.[1] ?? '';
}

describe('ResourceRow — the owner’s Lambda card, before/after (D17)', () => {
  const lambda = inventory.resources.find(
    (r) => r.address === 'aws_lambda_function.webhook',
  );

  it('the fixture still exists in the bundled estate', () => {
    expect(lambda).toBeDefined();
  });

  it('primary label is humanized; the tf address stays as the secondary mono line', () => {
    const html = render(lambda!);
    expect(primaryLabel(html)).toBe('ticket-webhook');
    expect(html).toContain('<div class="rr__addr">aws_lambda_function.webhook</div>');
  });

  it('chips read Memory 256 MB / Timeout 60 s, with the role ARN as its tail', () => {
    const html = render(lambda!);
    expect(html).toContain('Memory');
    expect(html).toContain('256 MB');
    expect(html).toContain('Timeout');
    expect(html).toContain('60 s');
    expect(html).toContain('lambda-execution-role');
    // The chip labels of the screenshot are gone from the visible card…
    expect(visibleText(html)).not.toContain('memory_size');
    expect(visibleText(html)).not.toContain('timeout 60');
  });

  it('the full ARN survives only as hover title, never as visible text', () => {
    const html = render(lambda!);
    expect(html).toContain('title="arn:aws:iam:');
    expect(visibleText(html)).not.toContain('arn:aws:iam:');
  });
});

describe('ResourceRow — D17 acceptance across the entire bundled estate', () => {
  it('scans the bundled sample estate (sanity)', () => {
    expect(inventory.resources.length).toBeGreaterThan(0);
  });

  it('no full ARN is visible in any default card state', () => {
    const offenders: string[] = [];
    for (const r of inventory.resources) {
      if (/\barn:/.test(visibleText(render(r)))) offenders.push(r.address);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no primary label carries a snake_case token', () => {
    const offenders: string[] = [];
    for (const r of inventory.resources) {
      const label = primaryLabel(render(r));
      if (SNAKE.test(label)) offenders.push(`${r.address}: ${label}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no chip LABEL carries a snake_case token (values are estate data and render verbatim)', () => {
    const offenders: string[] = [];
    for (const r of inventory.resources) {
      const html = render(r);
      for (const m of html.matchAll(/<dt class="rr__chip-k">(.*?)<\/dt>/g)) {
        if (SNAKE.test(m[1]!)) offenders.push(`${r.address}: ${m[1]!}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * 0034 papercut #3 — a resource whose ONLY action is a resource-scoped Add now
 * renders an Actions menu instead of the "Read-only" label. aws_key_pair is the
 * real estate's clean witness: it has zero Change/Delete/Move ops (so the row
 * was "Read-only"), and exactly one scoped Add (ec2-add-key-pair-tag), so the
 * combined actionsFor list — computed here with the SAME predicate the console
 * uses — is non-empty and the row flips to a menu. The menu's items live in a
 * Radix portal (not in static markup); the observable, portal-free change is
 * the trigger itself, which is precisely the papercut ("no actions surface").
 */
describe('ResourceRow — a scoped Add flips a Read-only row to an Actions menu (0034 #3)', () => {
  const allOps = manifests.flatMap((m) => m.operations);
  const scopedFor = (rt: string): ManifestOperation[] =>
    allOps.filter(
      (op) => op.target.resourceType === rt && (isScopedAction(op) || isResourceScopedAdd(op)),
    );
  const keyPair = inventory.resources.find((r) => r.resourceType === 'aws_key_pair');

  const renderWith = (resource: InventoryResource, actions: ManifestOperation[]): string =>
    renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(ResourceRow, {
          serviceSlug: 'ec2',
          resource,
          actions,
          onOpenPicker: () => undefined,
        }),
      ),
    );

  it('aws_key_pair exists in the estate and its only scoped action is the tag Add', () => {
    expect(keyPair).toBeDefined();
    const scoped = scopedFor('aws_key_pair');
    expect(scoped.map((o) => o.id)).toEqual(['ec2-add-key-pair-tag']);
    // and it is a resource-scoped Add, not a Change/Delete/Move op
    expect(scoped.every((o) => o.macd === 'Add')).toBe(true);
  });

  it('with no actions the card is Read-only; with the scoped Add it shows an Actions menu', () => {
    const readOnly = renderWith(keyPair!, []);
    expect(readOnly).toContain('Read-only');
    expect(readOnly).not.toContain('rr__menu-btn');

    const withAdd = renderWith(keyPair!, scopedFor('aws_key_pair'));
    expect(withAdd).not.toContain('Read-only');
    expect(withAdd).toContain('rr__menu-btn'); // the "Actions ▾" trigger renders
    expect(withAdd).toContain('Actions');
  });
});
