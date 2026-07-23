import type { BlockSource } from '@/lib/blockSource';

/**
 * Committed-Terraform addresses that REFERENCE `address` — e.g. the
 * aws_volume_attachment and aws_instance wired to an aws_ebs_volume that a plan
 * is about to destroy-and-recreate. Pure and synchronous over an already-loaded
 * corpus (blockSource.allBlockSources()); PlanSummaryPanel runs it for every
 * destructive address so a reviewer sees what else moves inside the replacement.
 *
 * A reference is the address as a whole HCL traversal token — `TYPE.NAME`,
 * optionally followed by `.attr` or `[idx]` — never a substring of a longer
 * name (`aws_x.y` must not match `aws_x.y2`), and never a module-scoped
 * homonym (`module.m.aws_x.y` is a different address). The target's own block
 * is excluded: its source spells the type and name as separate quoted strings
 * (`resource "aws_x" "y"`), so it cannot match the dotted form anyway.
 */
export function findDependents(address: string, blocks: Record<string, BlockSource>): string[] {
  const ref = referenceRegex(address);
  if (!ref) return [];
  const out: string[] = [];
  for (const [addr, block] of Object.entries(blocks)) {
    if (addr === address) continue;
    if (ref.test(block.source)) out.push(addr);
  }
  return out.sort();
}

/** A regex matching `address` as a whole traversal reference, or null for an
 * empty address. The lookbehind rejects a preceding identifier or `.` char (so
 * it is a token start, not a suffix / module-scoped homonym); the lookahead
 * rejects a following identifier char (so NAME is not a prefix of a longer
 * NAME) while allowing a real `.attr` / `[idx]` access to follow. */
function referenceRegex(address: string): RegExp | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.])${escaped}(?![\\w])`);
}
