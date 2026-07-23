import { describe, expect, it } from 'vitest';
import {
  BANNED_UI_PHRASES,
  scanBannerText,
  scanBannerTree,
  scanBrandText,
  scanBrandTree,
  scanText,
  scanTree,
  SRC_DIR,
} from '../../scripts/verify-source-genericity';

/**
 * Unit coverage for the source-genericity gate (scripts/verify-source-genericity.ts),
 * wired into `npm run verify:safety`. Proves the scanner catches the two headline
 * leaks (a planted `§` and a planted estate term), respects word boundaries so it does
 * not fire on innocent look-alikes, and — the standing regression lock — passes
 * on the actual cleaned source tree. Its second lock — the demo-mode banner gate
 * — is covered in its own describe block below.
 */
describe('source-genericity gate — scanText (pure)', () => {
  // A SYNTHETIC denylist so these tests prove the scanner catches estate terms and
  // account ids without ever naming a real estate value in committed test source.
  // Real terms live only in the untracked .estate-denylist.json; the public built-in
  // is empty. See scripts/lib/estateDenylist.ts.
  const SYNTH = {
    estateTerms: ['ACMEWIDGET', 'FOOCORP'],
    accountIds: ['999999999999'],
    region: [],
    brand: [],
  } as const;

  it('catches a planted § in a source line (generic notation — always on)', () => {
    const hits = scanText('  // dual-controlled server-side (§6): it lands as...');
    expect(hits.map((h) => h.match)).toContain('§');
    expect(hits[0]!.line).toBe(1);
  });

  it('catches a planted estate term from the denylist — word-boundary, case-insensitive', () => {
    expect(
      scanText('// Daily recovery points for the ACMEWIDGET estate', SYNTH).some((h) => h.match === 'ACMEWIDGET'),
    ).toBe(true);
    // lower-case is caught too (case-insensitive)
    expect(scanText('const x = 1; // per acmewidget policy', SYNTH).length).toBeGreaterThan(0);
  });

  it('catches every denylist estate term, the account id, and (built-in) ADR references', () => {
    expect(scanText('// FOOCORP window for this estate', SYNTH).some((h) => h.match === 'FOOCORP')).toBe(true);
    expect(scanText('arn:aws:kms:ap-southeast-5:999999999999:key/x', SYNTH).some((h) => h.match === '999999999999')).toBe(true);
    // ADR notation is a generic, always-present arm — no denylist needed.
    expect(scanText('// Display-only by design (ADR-0011)').some((h) => /^ADR-0011$/i.test(h.match))).toBe(true);
  });

  it('does NOT fire on innocent look-alikes (word boundary guards substrings)', () => {
    // The estate term inside a larger word, and "section"/"adr" as plain prose — none match.
    expect(scanText('const tree = mkACMEWIDGETling(); // it can disappoint', SYNTH)).toEqual([]);
    expect(scanText('// see section 6, adr guidance, paragraph two', SYNTH)).toEqual([]);
  });

  it('the public built-in denylist is empty — a plain estate word never fires without one', () => {
    // A fresh public checkout has no estate vocabulary to catch; only generic § / ADR
    // notation fires. The private deployment materializes .estate-denylist.json for strength.
    expect(scanText('// Daily recovery points for the ACMEWIDGET estate')).toEqual([]);
    expect(scanText('  // server-side (§6)').some((h) => h.match === '§')).toBe(true);
  });
});

describe('source-genericity gate — the tree is actually clean', () => {
  it('passes on the cleaned source tree — zero violations across scanned app source', () => {
    const violations = scanTree(SRC_DIR);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

describe('demo-mode banner gate — scanBannerText (pure)', () => {
  it('catches each fingerprint phrase, case-insensitively', () => {
    expect(scanBannerText('  <p>Demo mode — connect ccp-api to do things.</p>').map((h) => h.match))
      .toEqual(expect.arrayContaining(['Demo mode', 'connect ccp-api']));
    // lower-case is caught too (a sneaky re-add can't dodge it by re-casing)
    expect(scanBannerText('// requires ccp-api before this arms').some((h) => h.match === 'Requires ccp-api')).toBe(true);
    expect(scanBannerText("throw new Error('Requires ccp-api and a project.')").some((h) => h.match === 'Requires ccp-api')).toBe(true);
    // reports the line number
    expect(scanBannerText('ok\nDemo mode here')[0]!.line).toBe(2);
  });

  it('does NOT fire on the bare ccp-api token or an innocent "demo" word', () => {
    // These appear in dozens of legitimate comments/copy strings — never banned.
    expect(scanBannerText('// ccp-api serves GET /admin/policy once connected')).toEqual([]);
    expect(scanBannerText("'Creates an account on ccp-api they can sign in with'")).toEqual([]);
    expect(scanBannerText('const demo = SERVER_MODE === "mock"; // demo teams, demo catalog')).toEqual([]);
  });

  it('every banned phrase is a plain, non-empty string', () => {
    for (const p of BANNED_UI_PHRASES) expect(typeof p === 'string' && p.length > 0).toBe(true);
  });
});

describe('demo-mode banner gate — the tree is actually clean', () => {
  it('no banner phrase survives in shipped source — zero violations', () => {
    const violations = scanBannerTree(SRC_DIR);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

describe('brand-literal ratchet — scanBrandText (pure) (ADR-0023 §7)', () => {
  // Synthetic brand term — the real one lives only in the untracked .estate-denylist.json.
  const BRAND = ['Examplecorp'];

  it('catches a configured brand literal, word-bounded', () => {
    expect(scanBrandText('// this is an Examplecorp product', BRAND).some((h) => h.match === 'Examplecorp')).toBe(true);
    expect(scanBrandText('const s = "Examplecorp Cloud Control Plane";', BRAND).some((h) => h.match === 'Examplecorp')).toBe(true);
  });

  it('empty brand (the public built-in) matches nothing', () => {
    expect(scanBrandText('// Examplecorp is ignored when no brand is configured')).toEqual([]);
  });

  it('is CASE-SENSITIVE — a different-case token never fires', () => {
    expect(scanBrandText('// examplecorp is not a match; only the exact-case token is', BRAND)).toEqual([]);
  });

  it('does NOT fire on the code identifiers — CCP, CCP_*, ccp-api (no boundary inside the token)', () => {
    expect(scanBrandText('export const CCP_TOTP_KEY = process.env.CCP_TOTP_KEY;', BRAND)).toEqual([]);
    expect(scanBrandText('// see ccp-api and the CCP dir layout', BRAND)).toEqual([]);
    expect(scanBrandText("const globalName = '__CCP_PROJECT__';", BRAND)).toEqual([]);
  });

  it('reports the line number', () => {
    expect(scanBrandText('ok\n// Examplecorp here', BRAND)[0]!.line).toBe(2);
  });
});

describe('brand-literal ratchet — the tree is actually clean', () => {
  it('no configured brand survives in shipped source — zero violations (empty public built-in; real brand only in the untracked denylist)', () => {
    const violations = scanBrandTree(SRC_DIR);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
