import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiffView } from '@/components/DiffView';

/**
 * UI-8 — `~ attr = JSON.stringify(old) -> JSON.stringify(new)` change lines are
 * re-parsed by `body.split(' -> ')`. If the OLD value itself contains the literal
 * substring `" -> "` (a description, a tag, a name — all requester/estate data,
 * never under this app's control), a naive split yields 3+ parts: the removal
 * shows a truncated old value, the addition shows a FRAGMENT of the old value,
 * and the real new value is silently dropped. `generateDiff` always writes the
 * new value LAST on the line, so splitting on the FINAL " -> " is correct even
 * when the old value embeds one — these tests drive DiffView directly with a
 * synthetic diff string (not `generateDiff`) so the pathological shape is exact
 * and doesn't depend on finding a real op/value pair that happens to produce it.
 */

const html = (diff: string): string =>
  renderToStaticMarkup(React.createElement(DiffView, { diff }));

describe('DiffView — change-line arrow splitting (UI-8)', () => {
  it('an old value containing " -> " does not truncate the removal or drop the addition', () => {
    // old = 'before -> after' (itself a legal, if pathological, string value);
    // new = 'clean'. A first-occurrence split would show del="before" and
    // add="after" (a FRAGMENT of the old value) — the real new value ('clean')
    // would never appear anywhere in the rendered output.
    const diff = `# op (Change)\n~ resource "aws_instance" "web" {\n  ~ description = "before -> after" -> "clean"\n}`;
    const out = html(diff);
    expect(out).toContain('diff__row--del');
    expect(out).toContain('diff__row--add');
    // The FULL old value survives in the removal row, arrow and all.
    expect(out).toMatch(/description = &quot;before -&gt; after&quot;[^<]*<\/span>\s*<\/div>/);
    // The real new value appears — the exact failure mode being fixed is that it
    // was silently dropped entirely.
    expect(out).toContain('clean');
    // The addition row is the new value alone, not a fragment of the old one
    // ("after" must not appear as a standalone addition row).
    const addRowTexts = [...out.matchAll(/diff__row--add">[^]*?diff__text">([^<]*)</g)].map(
      (m) => m[1] ?? '',
    );
    expect(addRowTexts.some((t) => t.includes('clean'))).toBe(true);
    expect(addRowTexts.some((t) => t === 'description = "after"')).toBe(false);
  });

  it('the ordinary case (no embedded arrow) is unaffected', () => {
    const diff = `~ resource "aws_instance" "web" {\n  ~ instance_type = "t3.micro" -> "t3.small"\n}`;
    const out = html(diff);
    expect(out).toContain('instance_type = &quot;t3.micro&quot;');
    expect(out).toContain('instance_type = &quot;t3.small&quot;');
  });
});
