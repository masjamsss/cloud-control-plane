/**
 * Estate denylist loader — the ONE place the app's genericity guards
 * (verify-source-genericity.ts, verify-manifest-safety.ts) get the estate-specific
 * terms and account ids they scan for.
 *
 * The real values are NEVER committed. They live only in the untracked, gitignored
 * `.estate-denylist.json` at the repo root — the same file `scripts/publish-gate.sh`
 * reads for its own exact-match checks (so there is a single source of truth). The
 * committed built-in below is EMPTY, which is exactly right for the public product:
 * a generic tool has no estate vocabulary to catch. The private deployment's CI
 * materializes the file (path overridable via `ESTATE_DENYLIST_FILE`) so the guards
 * keep full strength there; a fresh public checkout scans with an empty term set.
 *
 * The scan functions take the resolved denylist as a plain parameter so unit tests
 * inject synthetic terms and prove the guard still catches them — without naming any
 * real estate value in test source.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EstateDenylist {
  /** Estate terms, matched on a word boundary, case-insensitively. */
  readonly estateTerms: readonly string[];
  /** Estate AWS account id(s) — bare literals (they appear inside ARNs). */
  readonly accountIds: readonly string[];
  /** Estate region code(s) — bare literals (e.g. an `ap-…` region). */
  readonly region: readonly string[];
  /** Brand literal(s) — the vendor/company name a generic build must never hardcode.
   *  Matched word-bounded, case-sensitive (see scanBrandText). Empty in the public build. */
  readonly brand: readonly string[];
}

/** The committed public built-in: empty of every real value. */
export const BUILTIN_ESTATE_DENYLIST: EstateDenylist = {
  estateTerms: [],
  accountIds: [],
  region: [],
  brand: [],
};

/** Repo root, from this file at `<root>/ccp/app/scripts/lib/`. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Resolve the estate denylist: `ESTATE_DENYLIST_FILE` (or `<root>/.estate-denylist.json`)
 * merged over the empty built-in. Absent or unreadable file → the empty built-in
 * (the public/CI default). Never throws; unknown JSON shapes degrade to empty arrays.
 */
export function loadEstateDenylist(): EstateDenylist {
  const path = process.env.ESTATE_DENYLIST_FILE ?? join(REPO_ROOT, '.estate-denylist.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const asStrings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return {
      estateTerms: asStrings(raw.estateTerms),
      accountIds: asStrings(raw.accountIds),
      region: asStrings(raw.region),
      brand: asStrings(raw.brand),
    };
  } catch {
    return BUILTIN_ESTATE_DENYLIST;
  }
}

/** Regex-escape a literal so account ids etc. are matched verbatim. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
