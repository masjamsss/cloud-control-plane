/**
 * Source-genericity gate: fail the build if estate-specific terms or internal
 * spec/ADR notation leak into hand-authored app source, so the product reads as
 * a generic, account-agnostic tool. Sibling to the ForceNew gate
 * (verify-manifest-safety.ts); both are wired into `npm run verify:safety`.
 *
 * It ALSO carries a second, independent lock: the demo-/mock-mode banner gate.
 * The app runs standalone without a backend (mock mode), but the operator ships
 * LIVE and wants NO "demo mode" nag anywhere. The banner UI was removed; this
 * gate fails the build if any of its fingerprint phrases — "Demo mode",
 * "connect ccp-api", "Requires ccp-api" (case-insensitive) — reappears
 * in shipped source, so it can never creep back in via a new component or copy
 * string.
 *
 * A THIRD, independent lock (ADR-0023, added once the generic-branding sweep
 * landed): the brand-literal ratchet. Once instance identity is
 * operator-settable (brand.ts / lib/instanceIdentity.ts), a hardcoded brand
 * name in shipped source is always a regression — either a leftover display
 * string that skipped the seam, or fresh copy that reintroduced one. The brand
 * term(s) come from the resolved denylist's `brand` field (empty in the public
 * built-in; real only in the untracked .estate-denylist.json), matched
 * case-sensitive and word-bounded so code identifiers like `CCP`/`CCP_*`/`ccp-api`
 * (no boundary inside the token) stay untouched — those are out of scope.
 *
 * Scans *.ts / *.tsx under src/, EXCLUDING two top-level trees:
 *   · src/test/**  — test scaffolding and fixtures (intentionally estate-flavored
 *                    demo data; never shipped as product copy).
 *   · src/data/**  — generated + per-account DATA: the inventory (inventory.json
 *                    and blocks/ — the spec's named "per-account inventory"),
 *                    the catalog manifests, and the bundled project config. This
 *                    data is legitimately account-specific and is not product
 *                    source, so it is out of this gate's scope.
 * Known limits, accepted (2026-07-22-ccp-generic-branding.md §7): this gate
 * scans neither index.html nor *.css — those few surfaces were swept once
 * (G1) and carry no ratchet.
 *
 * Forbidden, per line:
 *   · estate terms from the resolved denylist — word-boundary matched,
 *     case-insensitive (empty in the committed public built-in; real only in
 *     the untracked .estate-denylist.json — see ./lib/estateDenylist.ts);
 *   · estate account id(s) from that same denylist (literal);
 *   · notation — the section sign `§` and `ADR-0NNN` references;
 *   · demo-mode banner phrases — see BANNED_UI_PHRASES below (case-insensitive);
 *   · brand literal(s) from the denylist's `brand` field — word-bounded, case-sensitive.
 * Bare proposal numbers are deliberately NOT included (too false-positive-prone).
 *
 * FAIL -> exit 1 (CI-blocking). Run: vite-node scripts/verify-source-genericity.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_ESTATE_DENYLIST,
  escapeRegExp,
  loadEstateDenylist,
  type EstateDenylist,
} from './lib/estateDenylist';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = join(APP, 'src');

// Estate terms and account ids are NOT hardcoded here — they come from the resolved
// denylist (empty in the committed built-in; real only in the untracked
// .estate-denylist.json). See ./lib/estateDenylist.ts.

/** Top-level dirs under src/ that this gate does not scan (see module header). */
export const EXCLUDED_TOP_DIRS = new Set(['test', 'data']);

/**
 * Demo-/mock-mode banner fingerprint phrases. Matched case-insensitively as
 * plain substrings — NOT the bare token `ccp-api`, which appears in dozens
 * of legitimate comments and copy strings; only these exact banner phrases are
 * banned. If any appears in shipped source the banner nag is creeping back and
 * the build must fail.
 */
export const BANNED_UI_PHRASES = [
  'Demo mode',
  'connect ccp-api',
  'Requires ccp-api',
] as const;

export interface Violation {
  file: string;
  line: number;
  match: string;
}

/**
 * Every forbidden token on every line of `text`, in order. Pure — no I/O — so a
 * unit test can plant a term and assert it is caught without touching the tree.
 */
export function scanText(
  text: string,
  denylist: EstateDenylist = BUILTIN_ESTATE_DENYLIST,
): Array<{ line: number; match: string }> {
  // Fresh regex per call so there is no cross-call `lastIndex` state. Estate terms
  // (word-bounded) and account ids come from the resolved `denylist` — empty in the
  // committed built-in, real only in the untracked .estate-denylist.json. The `§` and
  // `ADR-0NNN` notation arms are generic and always present. `i` makes the estate
  // terms case-insensitive (harmless on the uppercase notation arms).
  const arms: string[] = [];
  if (denylist.estateTerms.length) {
    arms.push(String.raw`\b(?:${denylist.estateTerms.join('|')})\b`);
  }
  for (const id of denylist.accountIds) arms.push(escapeRegExp(id));
  arms.push('§', String.raw`ADR-0\d+`);
  const re = new RegExp(arms.join('|'), 'gi');
  const out: Array<{ line: number; match: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(re)) out.push({ line: i + 1, match: m[0] });
  }
  return out;
}

/**
 * Every demo-mode banner phrase on every line of `text`, case-insensitive. Pure
 * (no I/O) so a unit test can plant a phrase and assert it is caught. Plain
 * substring match — reports the canonical {@link BANNED_UI_PHRASES} entry, not
 * whatever casing the source used.
 */
export function scanBannerText(text: string): Array<{ line: number; match: string }> {
  const out: Array<{ line: number; match: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hay = lines[i]!.toLowerCase();
    for (const phrase of BANNED_UI_PHRASES) {
      if (hay.includes(phrase.toLowerCase())) out.push({ line: i + 1, match: phrase });
    }
  }
  return out;
}

/**
 * Every hardcoded brand literal on every line of `text` (ADR-0023 §7) — a SEPARATE
 * scan from {@link scanText} because this one is deliberately CASE-SENSITIVE
 * (estate terms above are case-insensitive; the brand ratchet must not flag
 * incidental lowercase substrings) while still word-bounded, so `CCP`,
 * `CCP_*`, `ccp-api` (no boundary inside the token) stay untouched. The brand
 * term(s) come from the resolved denylist's `brand` field — empty in the public
 * built-in, so this matches nothing there; real only in the untracked
 * .estate-denylist.json. Pure (no I/O) — same doctrine as scanText/scanBannerText.
 */
export function scanBrandText(
  text: string,
  brand: readonly string[] = BUILTIN_ESTATE_DENYLIST.brand,
): Array<{ line: number; match: string }> {
  const out: Array<{ line: number; match: string }> = [];
  if (brand.length === 0) return out;
  const re = new RegExp(String.raw`\b(?:${brand.map(escapeRegExp).join('|')})\b`, 'g');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(re)) out.push({ line: i + 1, match: m[0] });
  }
  return out;
}

/** All `*.ts` / `*.tsx` files under `srcDir`, skipping the excluded top-level trees. */
export function collectSourceFiles(srcDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, atTop: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (atTop && EXCLUDED_TOP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), false);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(srcDir, true);
  return out;
}

/** Scan the whole source tree; returns every violation (empty when clean). */
export function scanTree(
  srcDir: string,
  denylist: EstateDenylist = BUILTIN_ESTATE_DENYLIST,
): Violation[] {
  const out: Violation[] = [];
  for (const file of collectSourceFiles(srcDir)) {
    const rel = relative(srcDir, file);
    for (const { line, match } of scanText(readFileSync(file, 'utf8'), denylist)) {
      out.push({ file: rel, line, match });
    }
  }
  return out;
}

/** Scan the whole source tree for demo-mode banner phrases; empty when clean. */
export function scanBannerTree(srcDir: string): Violation[] {
  const out: Violation[] = [];
  for (const file of collectSourceFiles(srcDir)) {
    const rel = relative(srcDir, file);
    for (const { line, match } of scanBannerText(readFileSync(file, 'utf8'))) {
      out.push({ file: rel, line, match });
    }
  }
  return out;
}

/** Scan the whole source tree for the brand-literal ratchet; empty when clean. */
export function scanBrandTree(
  srcDir: string,
  denylist: EstateDenylist = BUILTIN_ESTATE_DENYLIST,
): Violation[] {
  const out: Violation[] = [];
  for (const file of collectSourceFiles(srcDir)) {
    const rel = relative(srcDir, file);
    for (const { line, match } of scanBrandText(readFileSync(file, 'utf8'), denylist.brand)) {
      out.push({ file: rel, line, match });
    }
  }
  return out;
}

function main(): void {
  const estate = scanTree(SRC_DIR, loadEstateDenylist());
  for (const v of estate) {
    console.error(`FAIL ${v.file}:${v.line} — estate term / notation: "${v.match}"`);
  }
  const banner = scanBannerTree(SRC_DIR);
  for (const v of banner) {
    console.error(`FAIL ${v.file}:${v.line} — demo-mode banner phrase: "${v.match}"`);
  }
  const brand = scanBrandTree(SRC_DIR, loadEstateDenylist());
  for (const v of brand) {
    console.error(`FAIL ${v.file}:${v.line} — brand literal (ADR-0023 — read the instance identity through brand.ts/lib/instanceIdentity.ts instead): "${v.match}"`);
  }
  const scope = `(scanned *.ts/*.tsx under src/, excluding ${[...EXCLUDED_TOP_DIRS].join(' + ')}/)`;
  console.log(
    `source-genericity: ${estate.length} estate + ${banner.length} banner + ${brand.length} brand violation(s) ${scope}`,
  );
  if (estate.length + banner.length + brand.length > 0) process.exit(1);
}

// vite-node runs the module directly; vitest sets VITEST in its worker, so an
// `import { scanText }` in a test never triggers the FS walk / exit(1).
if (!process.env.VITEST) main();
