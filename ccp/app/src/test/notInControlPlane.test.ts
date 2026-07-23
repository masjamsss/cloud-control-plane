import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { User } from '@/types';
import { BOUNDARY_PAGE_PATH, boundaryItems } from '@/lib/boundary';
import { NotInControlPlane } from '@/features/help/NotInControlPlane';
import {
  buildPaletteSections,
  filterPaletteSections,
  type PaletteEntryRow,
  flattenPaletteSections,
} from '@/lib/palette';
import { APP_NAME } from '@/brand';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The out-of-tool boundary (0034 §1.12 / Part 3): work that is real but not
 * a Terraform change gets a named, honest page — and the palette must carry
 * an operator there from ticket words ("reboot", "run backup now",
 * "restore") instead of answering with silence. Static content + palette
 * entries; no network, no model.
 */

describe('NotInControlPlane — the boundary page content', () => {
  const html = renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(NotInControlPlane)),
  );

  it('renders every boundary item with its why and its runbook/console path', () => {
    for (const item of boundaryItems()) {
      expect(html).toContain(item.title);
      expect(html).toContain(item.why);
      expect(html).toContain(item.where);
    }
  });

  it('names the boundary honestly in the page header', () => {
    expect(html).toContain(`Work that lives outside ${APP_NAME}`);
    expect(html).toContain('never');
  });

  it('offers the nearest served path where one exists (snapshot, EBS grow, request-new)', () => {
    expect(html).toContain('/services/rds/rds-create-manual-snapshot');
    expect(html).toContain('/services/ebs');
    expect(html).toContain('/services/request-new');
  });

  it('keeps operator-plain copy — no internal notation, no snake_case tokens', () => {
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).not.toMatch(/§/);
    expect(text).not.toMatch(/[A-Za-z0-9]_[A-Za-z0-9]/);
  });
});

describe('palette — ticket words resolve to the boundary page, never to silence', () => {
  const user: User = { id: 'u1', name: 'Test User', role: 'requester', teamId: 't1' };

  function search(query: string): PaletteEntryRow[] {
    const sections = buildPaletteSections({
      user,
      manifests: [],
      resources: [],
      myRequests: [],
      showResources: false,
    });
    return flattenPaletteSections(filterPaletteSections(sections, query)).filter(
      (r): r is PaletteEntryRow => r.kind !== 'header',
    );
  }

  it.each([
    ['reboot', 'boundary:power'],
    ['shutdown', 'boundary:power'],
    ['run backup now', 'boundary:backup-now'],
    ['backup now', 'boundary:backup-now'],
    ['restore', 'boundary:restore'],
    ['os patch', 'boundary:os-work'],
    ['register target', 'boundary:lb-targets'],
    ['golden image', 'boundary:image'],
  ])('"%s" finds %s, routed to the boundary page', (query, entryId) => {
    const rows = search(query);
    const hit = rows.find((r) => r.id === entryId);
    expect(hit, `no palette row ${entryId} for "${query}"`).toBeDefined();
    expect(hit!.to).toBe(BOUNDARY_PAGE_PATH);
  });

  it('boundary rows say where they lead ("outside <instance name>" hint), one per boundary item', () => {
    const rows = search('outside ccp');
    const boundaryRows = rows.filter((r) => r.id.startsWith('boundary:'));
    expect(boundaryRows).toHaveLength(boundaryItems().length);
    for (const row of boundaryRows) expect(row.hint).toBe(`outside ${APP_NAME}`);
  });

  it('the existing "Request something new…" action still leads the Actions section', () => {
    const sections = buildPaletteSections({
      user,
      manifests: [],
      resources: [],
      myRequests: [],
      showResources: false,
    });
    const actions = sections.find((s) => s.id === 'actions')!;
    expect(actions.entries[0]!.id).toBe('action:request-new');
  });
});

describe('router — the boundary page is a registered project-scoped route', () => {
  // router.tsx's createBrowserRouter needs a DOM at import time (see
  // lib/legacyRoute.ts), so registration is pinned at the source level —
  // same mechanical file-scan style as copyLint.
  const source = readFileSync(join(SRC, 'router.tsx'), 'utf8');

  it('registers the not-in-control-plane path with the NotInControlPlane element', () => {
    expect(source).toContain("path: 'not-in-control-plane'");
    expect(source).toContain('<NotInControlPlane />');
  });

  it('BOUNDARY_PAGE_PATH matches the registered route', () => {
    expect(BOUNDARY_PAGE_PATH).toBe('/not-in-control-plane');
  });
});
