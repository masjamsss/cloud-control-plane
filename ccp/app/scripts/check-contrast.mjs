#!/usr/bin/env node
// WCAG contrast gate for the Cloud Control Plane design tokens (0005: UIUX-3, UI S4 dark theme;
// ADR-0014: per-user palettes multiply the AA surface — every palette × theme
// must pass, not just the two base LIGHT/DARK blocks).
// Parses src/styles/tokens.css and asserts the declared token pairs meet AA in
// EVERY palette, in BOTH themes. Text pairs must be >= 4.5:1; non-text
// (borders) >= 3.0:1. Exits 1 on any fail.
//
// S-02 (UX audit, 2026-07-21): this file also runs a second, independent
// check — a grep-lint for `var(--undeclared)` custom-property references
// (see "Undeclared custom-property lint" below). That gap is what let F-05
// ship (`color-mix(in srgb, var(--crit) 8%, var(--surface))` — `--surface`
// was never declared, so the color-mix silently collapsed to nothing at
// computed-value time; the WCAG pair checks above never even saw it, because
// an undefined var never reaches a declared PAIR to check).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8');

const PALETTES = ['bordeaux', 'ink', 'teal', 'slate', 'mono'];
const DEFAULT_PALETTE = 'bordeaux'; // carried by :root itself — no data-palette block

/** Extract the body of a `<selector> { ... }` block (first match). The regex
 * requires the selector to be followed by (optional whitespace then) `{`, so
 * `:root[data-theme='dark']` never accidentally matches the START of
 * `:root[data-theme='dark'][data-palette='…']` (that selector has more
 * attribute-selector text before its own `{`, not whitespace). */
function block(selectorRe) {
  const m = css.match(new RegExp(`${selectorRe}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`block ${selectorRe} not found`);
  return m[1];
}

/** Escape a literal string for embedding in a RegExp (palette names are plain
 * identifiers, but this keeps the selector-building honest either way). */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse every `--token: #hex;` declaration in a block body into a lookup map.
 * Non-hex declarations (var() aliases, shadows, etc.) are irrelevant here and
 * simply don't match. */
function parseTokens(body) {
  const tokens = {};
  const re = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g;
  let m;
  while ((m = re.exec(body))) tokens[m[1]] = m[2];
  return tokens;
}

/** Overlay `overrides` onto `base` — a palette/dark-palette block only
 * declares what it changes; everything else falls through to the base set,
 * mirroring how the CSS cascade actually resolves the same element. */
function overlay(base, overrides) {
  return { ...base, ...overrides };
}

const LIGHT = parseTokens(block(":root(?!\\[)")); // `:root {` not `:root[...]`
const DARK = parseTokens(block(":root\\[data-theme='dark'\\](?!\\[)"));

const LIGHT_PALETTE_OVERRIDES = {};
const DARK_PALETTE_OVERRIDES = {};
for (const p of PALETTES) {
  if (p === DEFAULT_PALETTE) {
    LIGHT_PALETTE_OVERRIDES[p] = {};
    DARK_PALETTE_OVERRIDES[p] = {};
    continue;
  }
  LIGHT_PALETTE_OVERRIDES[p] = parseTokens(block(`:root\\[data-palette='${esc(p)}'\\]`));
  DARK_PALETTE_OVERRIDES[p] = parseTokens(
    block(`:root\\[data-theme='dark'\\]\\[data-palette='${esc(p)}'\\]`),
  );
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lin(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function lum([r, g, b]) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a, b) {
  const la = lum(rgb(a));
  const lb = lum(rgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
// color-mix(in srgb, fg p%, bg) — channel-wise, matches how a tinted badge reads.
function mix(fg, bg, p) {
  const a = rgb(fg);
  const b = rgb(bg);
  const c = a.map((x, i) => Math.round(x * p + b[i] * (1 - p)));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** The full pair suite, run for every palette in every theme. */
function fullChecks(t) {
  const surface = t['surface-1'];
  const surface2 = t['surface-2'];
  const surface3 = t['surface-3'];
  const canvas = t['bg-canvas'];
  return [
    ['text-primary on surface', t['text-primary'], surface, 4.5],
    ['text-primary on canvas', t['text-primary'], canvas, 4.5],
    ['text-secondary on surface', t['text-secondary'], surface, 4.5],
    ['text-muted on surface', t['text-muted'], surface, 4.5],
    ['text-muted on canvas', t['text-muted'], canvas, 4.5],
    ['text-faint on surface', t['text-faint'], surface, 4.5],
    ['text-faint on canvas', t['text-faint'], canvas, 4.5],
    // F-09: surface-2/surface-3 are where table heads, chips and code panes
    // actually live (dashboard/drift/admin tables, ApprovalLadder's segment
    // chrome, console group counts) — the pair list above never tested
    // either background, so a token could be AA on canvas/surface-1 and
    // still fail everywhere it's actually used. Every text tone is now
    // checked against every surface step.
    ['text-primary on surface-2', t['text-primary'], surface2, 4.5],
    ['text-primary on surface-3', t['text-primary'], surface3, 4.5],
    ['text-secondary on surface-2', t['text-secondary'], surface2, 4.5],
    ['text-secondary on surface-3', t['text-secondary'], surface3, 4.5],
    ['text-muted on surface-2', t['text-muted'], surface2, 4.5],
    ['text-muted on surface-3', t['text-muted'], surface3, 4.5],
    ['text-faint on surface-2', t['text-faint'], surface2, 4.5],
    ['text-faint on surface-3', t['text-faint'], surface3, 4.5],
    ['risk-low badge text', t['risk-low'], mix(t['risk-low'], surface, 0.12), 4.5],
    ['risk-med badge text', t['risk-med'], mix(t['risk-med'], surface, 0.12), 4.5],
    ['risk-high badge text', t['risk-high'], mix(t['risk-high'], surface, 0.12), 4.5],
    ['field-border on surface', t['field-border'], surface, 3.0],
    ['accent-ink on accent', t['accent-ink'], t['accent'], 4.5],
    ['accent text on accent-soft', t['accent'], t['accent-soft'], 4.5],
    ['accent text on canvas', t['accent'], canvas, 4.5],
  ];
}

/** The reduced suite for a DARK palette block: only the accent family
 * actually changes there (neutrals are inherited, already verified by the
 * base DARK run), so only the accent-dependent pairs are re-checked. */
function accentChecks(t) {
  return [
    ['accent-ink on accent', t['accent-ink'], t['accent'], 4.5],
    ['accent text on accent-soft', t['accent'], t['accent-soft'], 4.5],
    ['accent text on canvas', t['accent'], t['bg-canvas'], 4.5],
  ];
}

function run(label, checks) {
  let failed = 0;
  console.log(`\nWCAG contrast — ${label}\n`);
  for (const [name, fg, bg, min] of checks) {
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) failed += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${r.toFixed(2)}:1  (need ${min})  ${fg} on ${bg}`,
    );
  }
  return failed;
}

let failed = 0;

// Base LIGHT / DARK (the default palette — no data-palette attribute).
const inkLightFailed = run(`LIGHT theme (${DEFAULT_PALETTE}/default)`, fullChecks(LIGHT));
const inkDarkFailed = run(`DARK theme (${DEFAULT_PALETTE}/default)`, fullChecks(DARK));
failed += inkLightFailed + inkDarkFailed;

// Every other palette, light + dark.
const summary = [[`${DEFAULT_PALETTE} (default)`, inkLightFailed, inkDarkFailed]];
for (const p of PALETTES) {
  if (p === DEFAULT_PALETTE) continue;
  const lightFailed = run(
    `LIGHT theme — palette '${p}'`,
    fullChecks(overlay(LIGHT, LIGHT_PALETTE_OVERRIDES[p])),
  );
  const darkFailed = run(
    `DARK theme — palette '${p}'`,
    accentChecks(overlay(DARK, DARK_PALETTE_OVERRIDES[p])),
  );
  failed += lightFailed + darkFailed;
  summary.push([p, lightFailed, darkFailed]);
}

console.log('\nPer-palette summary\n');
console.log('palette'.padEnd(12), 'light', 'dark');
for (const [p, l, d] of summary) {
  console.log(p.padEnd(12), l === 0 ? 'PASS ' : `FAIL(${l})`, d === 0 ? 'PASS' : `FAIL(${d})`);
}

console.log(`\n${failed === 0 ? 'All pairs pass, every palette, both themes.' : `${failed} pair(s) fail.`}`);

/* ============================================================================
 * S-02 — undeclared custom-property lint. A trivial grep-lint over every
 * stylesheet in src/: collect every `--name:` DECLARATION (tokens.css's
 * root/palette/dark blocks, plus any component-local custom property, e.g.
 * svc-icon.css's `--svc-hue`), then flag any `var(--name)` REFERENCE whose
 * name was never declared anywhere. This is exactly the F-05 class of bug —
 * a var() with no declared source silently resolves to nothing at
 * computed-value time — and it is invisible to the pair checks above (they
 * only ever see PAIRS someone remembered to declare).
 *
 * Two deliberate exemptions, so this stays a lint on real bugs, not noise:
 *   - `var(--name, fallback)` (two-argument form) is CSS-spec-safe by
 *     construction — an unset `--name` cleanly resolves to the fallback, so
 *     it is never "undeclared" in the way F-05 was (no fallback at all).
 *   - `--radix-*` custom properties are injected by the Radix UI portal
 *     primitives at runtime (e.g. transform-origin for the open animation) —
 *     never declared in this app's own CSS by design.
 * ============================================================================ */
const SRC_DIR = join(root, 'src');

function collectCssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectCssFiles(full));
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/**
 * Pre-existing gaps outside this lane's write-set (found when this lint was
 * added) — named explicitly rather than silently ignored, so they stay
 * visible until their owning area fixes them. Delete an entry here the same
 * commit its bug is fixed; do not add to this list to silence a NEW finding.
 */
const KNOWN_UNDECLARED = new Set([]);

const cssFiles = collectCssFiles(SRC_DIR);
const declared = new Set();
for (const file of cssFiles) {
  const text = readFileSync(file, 'utf8');
  const declRe = /(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g;
  let m;
  while ((m = declRe.exec(text))) declared.add(m[2]);
}

const undeclared = [];
const seen = new Set();
for (const file of cssFiles) {
  const text = readFileSync(file, 'utf8');
  const relPath = relative(root, file);
  // Capture the property name plus the very next significant character:
  // ',' means a fallback argument follows (safe — skip); ')' means a bare
  // reference with no fallback (must resolve to a real declaration).
  const varRe = /var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g;
  let m;
  while ((m = varRe.exec(text))) {
    const [, name, next] = m;
    if (next === ',') continue;
    if (name.startsWith('--radix-')) continue;
    if (declared.has(name)) continue;
    const key = `${name}@${relPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    undeclared.push({ name, file: relPath, key });
  }
}

const newUndeclared = undeclared.filter((u) => !KNOWN_UNDECLARED.has(u.key));
const staleAllowlist = [...KNOWN_UNDECLARED].filter(
  (k) => !undeclared.some((u) => u.key === k),
);

console.log(`\nUndeclared custom-property lint (${cssFiles.length} stylesheets scanned)\n`);
if (undeclared.length === 0) {
  console.log('PASS  every var(--…) reference (no-fallback form) resolves to a declared custom property');
} else {
  for (const u of undeclared) {
    const known = KNOWN_UNDECLARED.has(u.key);
    console.log(`${known ? 'KNOWN' : 'FAIL '}  ${u.name}  referenced in ${u.file} but never declared`);
  }
}
if (staleAllowlist.length > 0) {
  console.log('\nStale allowlist entries (fixed — delete from KNOWN_UNDECLARED):');
  for (const k of staleAllowlist) console.log(`  ${k}`);
}
const lintFailed = newUndeclared.length + staleAllowlist.length;
console.log(
  lintFailed === 0
    ? '\nUndeclared-custom-property lint: PASS'
    : `\nUndeclared-custom-property lint: ${lintFailed} issue(s) — see above.`,
);

const totalFailed = failed + lintFailed;
process.exit(totalFailed === 0 ? 0 : 1);
