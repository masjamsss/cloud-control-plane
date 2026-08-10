import type { JSX } from 'react';
import './DiffView.css';

export interface DiffViewProps {
  /** A unified-ish diff string from lib/diff.generateDiff. */
  diff: string;
}

type RowKind = 'add' | 'del' | 'ctx' | 'meta';
interface Row {
  kind: RowKind;
  text: string;
}

/**
 * Split a generated Terraform diff into GitHub-style add/remove rows. A
 * Terraform in-place line (`~ attr = OLD -> NEW`) is expanded into a red
 * removal (OLD) and a green addition (NEW), like a real code review.
 */
function toRows(diff: string): Row[] {
  const rows: Row[] = [];
  for (const line of diff.split('\n')) {
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);

    if (trimmed.startsWith('#')) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (trimmed.startsWith('~') && trimmed.includes(' -> ')) {
      const body = trimmed.slice(1).trim(); // "attr = OLD -> NEW"
      // UI-8 — was `body.split(' -> ')`, which splits on EVERY occurrence. Both
      // sides are always `JSON.stringify(...)` output (lib/diff.ts's only emitter
      // of this shape), so an old value that itself contains " -> " (a tag, a
      // description — requester/estate data, not under this app's control) made
      // the split yield 3+ parts: `parts[0]` truncated the old value at the FIRST
      // arrow, `parts[1]` showed a fragment of the old value's remainder, and the
      // REAL new value was silently dropped. `generateDiff` always writes the new
      // value LAST on the line, so the boundary between old and new is the FINAL
      // " -> " — splitting there is correct even when the old value embeds one.
      // (The symmetric case — a NEW value that itself contains " -> " — is not
      // resolvable by any delimiter-based split; that needs generateDiff to emit
      // structured old/new instead of a re-parsed string, the recommendation's
      // own "better" alternative, out of this fix's proportionate scope.)
      const arrow = body.lastIndexOf(' -> ');
      const lhs = arrow >= 0 ? body.slice(0, arrow) : body;
      const rhs = arrow >= 0 ? body.slice(arrow + ' -> '.length) : '';
      const eq = lhs.indexOf('=');
      const attr = eq >= 0 ? lhs.slice(0, eq + 1) : lhs;
      const oldVal = eq >= 0 ? lhs.slice(eq + 1).trim() : '';
      rows.push({ kind: 'del', text: `${indent}${attr} ${oldVal}`.trimEnd() });
      rows.push({ kind: 'add', text: `${indent}${attr} ${rhs.trim()}`.trimEnd() });
      continue;
    }
    if (trimmed.startsWith('+')) {
      rows.push({ kind: 'add', text: indent + trimmed.slice(1).trim() });
      continue;
    }
    if (trimmed.startsWith('-')) {
      rows.push({ kind: 'del', text: indent + trimmed.slice(1).trim() });
      continue;
    }
    if (trimmed.startsWith('~')) {
      rows.push({ kind: 'ctx', text: indent + trimmed.slice(1).trim() });
      continue;
    }
    rows.push({ kind: 'ctx', text: line });
  }
  return rows;
}

function gutter(kind: RowKind): string {
  if (kind === 'add') return '+';
  if (kind === 'del') return '-';
  return ' ';
}

export function DiffView({ diff }: DiffViewProps): JSX.Element {
  const rows = toRows(diff);
  return (
    <div className="diff" role="figure" aria-label="Generated Terraform diff">
      <pre className="diff__body">
        {rows.map((r, i) => (
          <div key={i} className={`diff__row diff__row--${r.kind}`}>
            <span className="diff__gutter" aria-hidden="true">
              {gutter(r.kind)}
            </span>
            <span className="diff__text">{r.text}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
