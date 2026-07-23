import type { ManifestOperation } from '@/types';
import { redactHcl } from '@/lib/redact';
import { lineStartDepths } from '@/lib/hclScan';
import type { BlockSource } from '@/lib/blockSource';
import { isWholeResourceRemoveBlockOp } from '@/lib/diff';

/**
 * Build the full-block before/after view for a request:
 * the ENTIRE resource block the L1 is changing, not just the changed attribute.
 *
 * Deterministic, TypeScript-only, and INDENTATION-INDEPENDENT: it locates the
 * top-level (depth-1) attribute line via the shared HCL tokenizer's depth map —
 * so tabs, any indent width, or aligned `=` all work — and replaces (or inserts,
 * matching the block's own indent) that line. A genuine whole-resource
 * remove_block op (isWholeResourceRemoveBlockOp — ebs-delete-volume,
 * sns-delete-topic, cloudwatch-delete-alarm, …) marks the WHOLE block as
 * deleted. A remove_block op scoped to a SUB-BLOCK inside a resource that
 * persists (a tag, an ingress rule, a policy attachment —
 * sg-remove-ingress-rule, iam-detach-managed-policy, autoscaling-remove-tag,
 * …) is NOT expressible as a faithful transform here — the exact matching
 * nested instance among possibly several same-named siblings can't be
 * reliably located from the op's params alone — and returns null rather than
 * risk marking the wrong lines: never a guessed partial edit, and never the
 * fabricated "whole resource gone" this branch used to render for it before
 * round 2 of the review-artifact-truthfulness fix (#116 fixed the mirror bug
 * for remove_foreach_entry/append_foreach_entry in lib/diff.ts). Op kinds it
 * cannot transform faithfully return null and the caller falls back to the
 * parameter diff (lib/diff.ts's generateDiff, which renders the honest
 * sub-block delta for exactly this case) — honest degradation, never a
 * guessed block.
 */
export interface FullBlockDiff {
  kind: 'change' | 'remove';
  file: string;
  line: number;
  before: string;
  /** After text; for kind:'remove' this is empty (whole block removed). */
  after: string;
  /** 0-based indices of changed lines, in the BEFORE text's line numbering. */
  changedBefore: number[];
  /** 0-based indices of changed lines, in the AFTER text's line numbering. */
  changedAfter: number[];
}

/** Manifest params whose names differ from the real HCL attribute (the
 * build-inventory RENAME table, reversed). Keyed by resource type. */
const PARAM_TO_HCL_ATTR: Record<string, Record<string, string>> = {
  aws_ebs_volume: { size_gib: 'size' },
};

/** The real HCL attribute a manifest param maps to. */
function hclAttrOf(paramName: string, resourceType: string): string {
  const stripped = paramName.replace(/^new_/, '').replace(/^target_/, '');
  return PARAM_TO_HCL_ATTR[resourceType]?.[stripped] ?? stripped;
}

/** Render a form value as HCL. */
function hclValue(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

const ATTR_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The indent unit used by a block's top-level attributes (any width/char), so
 * an inserted line matches the block's own style. Defaults to two spaces. */
function inferIndent(lines: string[], depths: number[]): string {
  for (let i = 1; i < lines.length; i += 1) {
    if (depths[i] === 1) {
      const ws = /^([ \t]+)/.exec(lines[i]!);
      if (ws) return ws[1]!;
    }
  }
  return '  ';
}

/**
 * Replace (or insert) one TOP-LEVEL attribute of the block, indentation-
 * independent. The attribute line is found by the tokenizer's depth map (depth 1
 * = a direct child of the resource block), so tabs/aligned `=`/any indent width
 * all work. Alignment and any trailing comment are preserved.
 */
function setAttribute(
  lines: string[],
  attr: string,
  value: unknown,
): { lines: string[]; changed: number[]; insertedAt: number | null } {
  if (!ATTR_ID.test(attr)) return { lines, changed: [], insertedAt: null };
  const depths = lineStartDepths(lines.join('\n'));
  const re = new RegExp(`^(\\s*)(${attr})(\\s*=\\s*)(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    if (depths[i] !== 1) continue; // only direct children of this block
    const m = re.exec(lines[i]!);
    if (m) {
      const [, indent, key, eq, rest] = m;
      const comment = /\s(#|\/\/).*$/.exec(rest!)?.[0] ?? '';
      const next = `${indent}${key}${eq}${hclValue(value)}${comment}`;
      if (next === lines[i]) return { lines, changed: [], insertedAt: null };
      const out = [...lines];
      out[i] = next;
      return { lines: out, changed: [i], insertedAt: null };
    }
  }
  // Attribute absent → insert right after the opening line, in the block's indent.
  const out = [...lines];
  out.splice(1, 0, `${inferIndent(lines, depths)}${attr} = ${hclValue(value)}`);
  return { lines: out, changed: [1], insertedAt: 1 };
}

/**
 * The full-block diff for an operation, or null when this op kind can't be
 * rendered as a faithful block transform (caller falls back to the param diff).
 */
export function buildFullBlockDiff(
  op: ManifestOperation,
  values: Record<string, unknown>,
  block: BlockSource,
): FullBlockDiff | null {
  const before = block.source;

  if (op.codemodOp === 'remove_block') {
    // Sub-block-scoped (a tag, an ingress rule, a policy attachment, …): the
    // resource itself persists, so it is never faithfully expressed as "the
    // whole block gone" — honest degrade to the parameter diff instead of
    // marking every line of the (unrelated, much larger) enclosing resource
    // as deleted. See isWholeResourceRemoveBlockOp's docstring for the full
    // whole-resource-vs-sub-block signal.
    if (!isWholeResourceRemoveBlockOp(op)) return null;
    const count = before.split('\n').length;
    return {
      kind: 'remove',
      file: block.file,
      line: block.line,
      before,
      after: '',
      changedBefore: Array.from({ length: count }, (_, i) => i),
      changedAfter: [],
    };
  }

  if (op.codemodOp !== 'set_attribute' && op.codemodOp !== 'set_association_attribute') {
    return null;
  }

  let lines = before.split('\n');
  const changedBefore: number[] = [];
  const changedAfter: number[] = [];
  let inserted = 0;

  for (const p of op.params) {
    if (p.source === 'inventory') continue; // the target picker, not a change
    const v = values[p.name];
    if (v === undefined || v === '') continue;
    const attr = hclAttrOf(p.name, op.target.resourceType);
    const res = setAttribute(lines, attr, v);
    if (res.changed.length > 0) {
      const at = res.changed[0]!;
      if (res.insertedAt !== null) {
        changedAfter.push(at);
        inserted += 1;
      } else {
        changedBefore.push(at - inserted); // map back to before-numbering
        changedAfter.push(at);
      }
      lines = res.lines;
    }
  }

  if (changedAfter.length === 0) return null; // nothing we could express

  // The user's typed values may themselves be secrets — mask the after text with
  // the same rules the before text already went through at generation time.
  const after = redactHcl(lines.join('\n'), {
    sensitiveAttrs: op.params
      .filter((p) => p.sensitive)
      .map((p) => hclAttrOf(p.name, op.target.resourceType)),
  });

  return {
    kind: 'change',
    file: block.file,
    line: block.line,
    before,
    after,
    changedBefore,
    changedAfter,
  };
}
