/**
 * Palette selection — per-user selectable palettes, layered under the
 * light/dark theme axis. Persisted locally and applied by toggling
 * `data-palette="<name>"` on <html> — a
 * palette redefines only the accent + neutral surface/text token VALUES in
 * styles/tokens.css, so no component CSS is palette-aware. First-paint is
 * handled by a tiny inline script in index.html to avoid a flash; this
 * module drives the runtime change. Mirrors src/lib/theme.ts's store
 * pattern exactly (same localStorage try/catch, same "default = attribute
 * absent" convention — 'bordeaux' is the default palette (see the design
 * records under docs/), so it never sets `data-palette` at all, the same
 * way light theme never sets `data-theme`; every other palette, including
 * 'ink', sets the attribute).
 *
 * Named `palettes.ts` (plural) — NOT `palette.ts`. That name is already
 * taken by src/lib/palette.ts, the unrelated command-palette (Cmd-K search)
 * data layer.
 */
const KEY = 'ccp.palette.v1';

export const PALETTES = ['bordeaux', 'ink', 'teal', 'slate', 'mono'] as const;

/** The palette `:root` carries when no attribute is set. */
export const DEFAULT_PALETTE = 'bordeaux' as const;
export type Palette = (typeof PALETTES)[number];

export const PALETTE_LABELS: Record<Palette, string> = {
  ink: 'Ink navy',
  bordeaux: 'Bordeaux',
  teal: 'Teal',
  slate: 'Slate',
  mono: 'Mono',
};

export function isPalette(value: string | null): value is Palette {
  return value !== null && (PALETTES as readonly string[]).includes(value);
}

export function getPalette(): Palette {
  try {
    const stored = localStorage.getItem(KEY);
    return isPalette(stored) ? stored : DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

export function applyPalette(palette: Palette): void {
  const el = document.documentElement;
  if (palette === DEFAULT_PALETTE) el.removeAttribute('data-palette');
  else el.setAttribute('data-palette', palette);
}

export function setPalette(palette: Palette): void {
  try {
    localStorage.setItem(KEY, palette);
  } catch {
    /* ignore — falls back to session default */
  }
  applyPalette(palette);
}
