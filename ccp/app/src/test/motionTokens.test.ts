import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokensCss = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');

const MOTION_TOKENS = [
  '--dur-fast',
  '--dur-base',
  '--dur-slow',
  '--dur-shimmer',
  '--ease-standard',
  '--ease-emphasized',
];

describe('motion tokens', () => {
  it('defines the full motion ramp in tokens.css', () => {
    for (const token of MOTION_TOKENS) {
      expect(tokensCss, `${token} missing from tokens.css`).toContain(`${token}:`);
    }
  });
});

const TOKENS_PATH = join(SRC, 'styles/tokens.css');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith('.css') && p !== TOKENS_PATH) out.push(p);
  }
  return out;
}

// A raw timing or easing literal that should instead be a token.
const RAW_TIMING = /\b\d*\.?\d+m?s\b|cubic-bezier\s*\(|\b(?:ease(?:-in)?(?:-out)?|linear|steps)\b/;

/** Return offending `transition`/`animation` (shorthand or longhand) declarations in a stylesheet. */
function offenders(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip block comments
  const bad: string[] = [];
  const re = /(transition|animation)(?:-(?:duration|delay|timing-function))?\s*:\s*([^;{}]+)[;}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const value = m[2]!.replace(/!important/g, '').trim();
    // Allowed: the reduced-motion opt-out (`none`) and the fixed reduced-motion
    // reset (`0.01ms`) — the latter is used only by the global
    // prefers-reduced-motion backstop in styles/global.css, an intentional
    // accessibility reset that is deliberately NOT part of the tokenized motion
    // language. Everything else must reference a --dur-*/--ease-* token.
    if (value === 'none' || value === '0.01ms') continue;
    const withoutVars = value.replace(/var\([^)]*\)/g, ''); // token refs are fine
    if (RAW_TIMING.test(withoutVars)) bad.push(`${m[1]}: ${value.replace(/\s+/g, ' ')}`);
  }
  return bad;
}

describe('motion tokens — no hardcoded timings', () => {
  it('every transition/animation uses var(--dur-*)/var(--ease-*)', () => {
    const violations: Record<string, string[]> = {};
    for (const file of cssFiles(SRC)) {
      const bad = offenders(readFileSync(file, 'utf8'));
      if (bad.length) violations[relative(SRC, file)] = bad;
    }
    expect(violations).toEqual({});
  });

  it('detects reintroduced hardcoded timings (shorthand and longhand)', () => {
    // shorthand offender
    expect(offenders('a { transition: color 150ms ease; }')).toHaveLength(1);
    // longhand offenders (the blind spot this fix closes)
    expect(offenders('a { transition-duration: 300ms; }')).toHaveLength(1);
    expect(offenders('a { animation-delay: 0.2s; }')).toHaveLength(1);
    expect(offenders('a { transition-timing-function: ease-in-out; }')).toHaveLength(1);
    // tokenized declarations are clean
    expect(offenders('a { transition: color var(--dur-fast) var(--ease-standard); }')).toHaveLength(0);
    // reduced-motion opt-out and the global backstop reset are allowed
    expect(offenders('a { transition: none; }')).toHaveLength(0);
    expect(offenders('a { transition-duration: 0.01ms !important; }')).toHaveLength(0);
  });
});
