/**
 * Style-independent HCL scanning — the single source of truth used by both the
 * block extractor (scripts/extract-blocks.ts, run under Node) and the in-app
 * block transform (lib/blockDiff.ts).
 *
 * This is a character-walk tokenizer, not a line-regex scanner: it tracks
 * strings (with `${…}` / `%{…}` template nesting and `\` escapes, `$${`/`%%{`
 * escapes), heredocs (`<<TERM` / `<<-TERM`, whole-word terminator), line
 * comments (`#`, `//`), block comments (`/* … *\/`), and global brace depth in
 * code context — so ANY legal coding style scans identically: tabs, any indent,
 * one-line blocks, CRLF, decoy `resource` text inside comments/strings/heredocs.
 *
 * Known, documented limits (fail-safe: a block is missed, never mis-sliced):
 * - comments BETWEEN a block's header tokens (`resource /*x*\/ "a" "b" {`);
 * - heredocs nested inside `${…}` templates.
 */

export interface ScannedBlock {
  /** e.g. "aws_instance" */
  type: string;
  /** e.g. "app01" */
  name: string;
  /** byte offset of the `r` of `resource` */
  start: number;
  /** byte offset just past the matching `}` */
  end: number;
  /** 1-based line of the header */
  startLine: number;
}

const HEADER = /^resource[ \t]+"([^"]+)"[ \t]+"([^"]+)"[ \t]*\{/;
const HEREDOC = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/;

/** Consume a double-quoted string starting at `i` (the opening quote).
 * Handles \-escapes and ${…} / %{…} templates (which may nest strings).
 * Returns the index just past the closing quote. */
function skipString(src: string, i: number): number {
  const n = src.length;
  i += 1; // past opening quote
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if ((c === '$' || c === '%') && src[i + 1] === '{') {
      if (src[i - 1] === c) {
        // `$${` / `%%{` — escaped, not a template
        i += 2;
        continue;
      }
      i = skipTemplate(src, i + 2); // past `${`
      continue;
    }
    i += 1;
  }
  return n;
}

/** Consume a `${…}`/`%{…}` template body starting just past the `{`.
 * Templates are expression context: braces count, strings may nest.
 * Returns the index just past the matching `}`. */
function skipTemplate(src: string, i: number): number {
  const n = src.length;
  let depth = 1;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return n;
}

/** Consume a heredoc starting at `i` (the first `<`). Returns index just past
 * the terminator (end of the terminator word), or `n`. Line counting is the
 * caller's job — this returns how many newlines it consumed via out-param. */
function skipHeredoc(src: string, i: number): { end: number; newlines: number } {
  const n = src.length;
  const m = HEREDOC.exec(src.slice(i, i + 64));
  if (!m) return { end: i + 1, newlines: 0 };
  const term = m[1]!;
  let j = i + m[0].length;
  let newlines = 0;
  // advance to end of the opener line
  while (j < n && src[j] !== '\n') j += 1;
  while (j < n) {
    // j is at a newline: start of a candidate line
    newlines += 1;
    j += 1;
    let k = j;
    while (k < n && (src[k] === ' ' || src[k] === '\t')) k += 1;
    if (
      src.startsWith(term, k) &&
      (k + term.length >= n || src[k + term.length] === '\n' || src[k + term.length] === '\r')
    ) {
      return { end: k + term.length, newlines };
    }
    while (j < n && src[j] !== '\n') j += 1;
  }
  return { end: n, newlines };
}

/**
 * Scan a whole file: every top-level `resource` block, style-independent.
 * Non-resource top-level blocks (data/module/locals/…) are consumed as plain
 * code and never extracted; nested or commented/quoted decoys never match.
 */
export function scanTopLevelBlocks(src: string): ScannedBlock[] {
  const n = src.length;
  const blocks: ScannedBlock[] = [];
  let depth = 0;
  let line = 1;
  let atLineStart = true; // only whitespace seen since the last newline (code ctx)
  let current: { type: string; name: string; start: number; startLine: number } | null = null;
  let i = 0;

  while (i < n) {
    const c = src[i];

    if (c === '\n') {
      line += 1;
      atLineStart = true;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      continue;
    }

    // Comments — consumed entirely; never affect depth or headers.
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      atLineStart = false;
      continue;
    }

    // Strings and heredocs — consumed entirely.
    if (c === '"') {
      const end = skipString(src, i);
      for (let k = i; k < end; k += 1) if (src[k] === '\n') line += 1;
      i = end;
      atLineStart = false;
      continue;
    }
    if (c === '<' && src[i + 1] === '<') {
      const { end, newlines } = skipHeredoc(src, i);
      line += newlines;
      i = end;
      atLineStart = false;
      continue;
    }

    // Header detection: only in code, at depth 0, first code token on its line.
    if (depth === 0 && atLineStart && c === 'r') {
      const m = HEADER.exec(src.slice(i, i + 300));
      if (m) {
        current = { type: m[1]!, name: m[2]!, start: i, startLine: line };
        depth = 1;
        i += m[0].length; // consumes through the `{`
        atLineStart = false;
        continue;
      }
    }

    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0 && current) {
        blocks.push({ ...current, end: i + 1 });
        current = null;
      }
      if (depth < 0) depth = 0; // stray close (illegal HCL) — fail safe
    }

    atLineStart = false;
    i += 1;
  }

  return blocks;
}

/**
 * Depth at the START of each line of a block's source (line 0 = the header).
 * Lines that begin inside a string/heredoc/comment report -1 (not editable).
 * Used by blockDiff to find top-level (depth-1) attribute lines regardless of
 * indentation style.
 */
export function lineStartDepths(blockSource: string): number[] {
  const n = blockSource.length;
  const depths: number[] = [0];
  let depth = 0;
  let i = 0;

  while (i < n) {
    const c = blockSource[i];
    if (c === '\n') {
      depths.push(depth);
      i += 1;
      continue;
    }
    if (c === '#' || (c === '/' && blockSource[i + 1] === '/')) {
      while (i < n && blockSource[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && blockSource[i + 1] === '*') {
      i += 2;
      while (i < n && !(blockSource[i] === '*' && blockSource[i + 1] === '/')) {
        if (blockSource[i] === '\n') {
          depths.push(-1);
        }
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      const end = skipString(blockSource, i);
      for (let k = i; k < end; k += 1) if (blockSource[k] === '\n') depths.push(-1);
      i = end;
      continue;
    }
    if (c === '<' && blockSource[i + 1] === '<') {
      const { end, newlines } = skipHeredoc(blockSource, i);
      for (let k = 0; k < newlines; k += 1) depths.push(-1);
      i = end;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }

  return depths;
}
