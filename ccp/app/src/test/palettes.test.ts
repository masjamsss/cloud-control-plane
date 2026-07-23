import { beforeEach, describe, expect, it } from 'vitest';
import {
  PALETTES,
  PALETTE_LABELS,
  applyPalette,
  getPalette,
  setPalette,
  type Palette,
} from '@/lib/palettes';

/**
 * ADR-0014 per-user palette axis (bordeaux default since the XL revision). Mirrors src/lib/theme.ts's store pattern
 * exactly (localStorage try/catch + a `data-*` attribute on <html>, default
 * value = attribute absent). There is no existing theme.test.ts to copy from
 * (this app has no jsdom/RTL — src/test/setup.ts), so applyPalette is
 * exercised against a tiny local `document.documentElement` stub, the same
 * "keep it DOM-free except for one narrow escape hatch" spirit src/lib/palette.ts
 * (the unrelated command-palette data layer) documents for this codebase.
 *
 * Named `palettes.ts`/`palettes.test.ts` (plural) rather than the singular
 * `palette.ts` the plan drafted — `src/lib/palette.ts` and
 * `src/test/palette.test.ts` already exist and are the command-palette
 * (Cmd-K search) data layer, an unrelated feature. Reusing that name would
 * either collide or force unrelated color-theme code into that module.
 */

const KEY = 'ccp.palette.v1';

/** Minimal fake standing in for `document.documentElement` — only the
 * attribute methods applyPalette actually calls. */
class FakeElement {
  private attrs = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) ?? null) : null;
  }
}

function docEl(): FakeElement {
  return (globalThis as unknown as { document: { documentElement: FakeElement } }).document
    .documentElement;
}

beforeEach(() => {
  localStorage.removeItem(KEY);
  (globalThis as unknown as { document: { documentElement: FakeElement } }).document = {
    documentElement: new FakeElement(),
  };
});

describe('PALETTES / PALETTE_LABELS', () => {
  it('exposes exactly the five palettes, bordeaux (the default) first', () => {
    expect(PALETTES).toEqual(['bordeaux', 'ink', 'teal', 'slate', 'mono']);
  });

  it('every palette has a human label', () => {
    for (const p of PALETTES) expect(PALETTE_LABELS[p]).toEqual(expect.any(String));
    expect(PALETTE_LABELS.ink).toBe('Ink navy');
  });
});

describe('getPalette', () => {
  it('defaults to "bordeaux" when nothing is stored', () => {
    expect(getPalette()).toBe('bordeaux');
  });

  it('falls back to "bordeaux" on an invalid/corrupted stored value', () => {
    localStorage.setItem(KEY, 'neon-cyberpunk');
    expect(getPalette()).toBe('bordeaux');
  });
});

describe('setPalette / getPalette — round trip', () => {
  it.each(PALETTES)('round-trips %s through localStorage', (p: Palette) => {
    setPalette(p);
    expect(getPalette()).toBe(p);
  });
});

describe('applyPalette — data-palette attribute on <html>', () => {
  it('a non-default palette sets data-palette to its name', () => {
    applyPalette('teal');
    expect(docEl().getAttribute('data-palette')).toBe('teal');
  });

  it('every non-default palette round-trips through the attribute', () => {
    for (const p of PALETTES.filter((x) => x !== 'bordeaux')) {
      applyPalette(p);
      expect(docEl().getAttribute('data-palette')).toBe(p);
    }
  });

  it('"bordeaux" (the default) removes the attribute — mirrors light theme = no data-theme', () => {
    applyPalette('teal');
    expect(docEl().getAttribute('data-palette')).toBe('teal');
    applyPalette('bordeaux');
    expect(docEl().getAttribute('data-palette')).toBeNull();
  });

  it('"ink" is a real palette now — it SETS the attribute', () => {
    applyPalette('ink');
    expect(docEl().getAttribute('data-palette')).toBe('ink');
  });
});

describe('setPalette — persists AND applies', () => {
  it('writes localStorage and toggles the attribute in one call', () => {
    setPalette('slate');
    expect(getPalette()).toBe('slate');
    expect(docEl().getAttribute('data-palette')).toBe('slate');
  });

  it('switching back to "bordeaux" clears a previously-set attribute', () => {
    setPalette('mono');
    expect(docEl().getAttribute('data-palette')).toBe('mono');
    setPalette('bordeaux');
    expect(docEl().getAttribute('data-palette')).toBeNull();
    expect(getPalette()).toBe('bordeaux');
  });

  it("index.html's first-paint allowlist stays in sync with PALETTES", async () => {
    // The inline script keeps its own literal allowlist (it runs before any
    // module loads). A palette added to PALETTES but not to index.html would
    // silently flash the default palette on every load — fail loudly here instead.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../index.html'),
      'utf8',
    );
    for (const p of PALETTES.filter((x) => x !== 'bordeaux')) {
      expect(html, `index.html first-paint script is missing palette '${p}'`).toContain(`'${p}'`);
    }
  });
});
