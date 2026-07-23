import type { InventoryResource } from '@/types';
import type { BlockSource } from '@/lib/blockSource';
import { humanizeAttr } from '@/lib/chipLabel';
import { stripProviderPrefix } from '@/lib/providerDisplay';

/**
 * Console-style resource grouping: ONE list entry per logical resource, with
 * the Terraform-side config shreds rolled up underneath it.
 *
 * Terraform splits one console object across several resource types — a
 * single S3 bucket is an aws_s3_bucket PLUS its aws_s3_bucket_policy,
 * aws_s3_bucket_versioning, aws_s3_bucket_server_side_encryption_configuration
 * and friends. The service console used to list each of those types as a
 * sibling top-level group, so one bucket showed up five times (operator
 * verdict, 2026-07-17: list the bucket once, drill in for the rest — like the
 * AWS console). This module decides, from data alone, which types are
 * CONFIG-OF-A-PARENT types and which instance each entry belongs to.
 *
 * A type C on a service page is a child of type P (both in the page's
 * resourceTypes) under one of two arms:
 *
 *   ARM 1 — provider naming. The AWS provider names split-out config
 *   resources by suffixing the parent type: aws_s3_bucket_policy,
 *   aws_iam_role_policy_attachment. So: P + "_" is a prefix of C (the longest
 *   such P wins — listener_rule belongs to listener, not lb), AND at least
 *   one C instance's committed source actually references a P instance's
 *   address. The reference requirement keeps name-adjacent PEERS apart:
 *   aws_lb_target_group and aws_vpc_endpoint carry their parent-ish type in
 *   the name but never reference one, and both have their own console page.
 *
 *   ARM 2 — importer naming. Some children carry no type-name hint at all
 *   (aws_volume_attachment → aws_ebs_volume, aws_kms_alias → aws_kms_key,
 *   aws_cloudwatch_event_target → aws_cloudwatch_event_rule). For these:
 *   EVERY C instance references some P instance (a child of this kind cannot
 *   exist without its parent argument, so full coverage is the containment
 *   signal — optional associations like network-ACL↔subnet at 3/6 or
 *   instance↔key-pair at 9/204 never reach it), AND at least one C instance
 *   also shares its exact Terraform name with the P instance it references
 *   (this estate names such children after their parent), AND exactly one P
 *   qualifies. Requiring all three biases toward the safe failure: a missed
 *   rollup stays a flat, honest list; a false rollup would hide a real
 *   resource under an unrelated one.
 *
 * "References" means the committed HCL block contains the parent's address as
 * a whole traversal token — the same rule as lib/dependents.ts. That catches
 * both real references (`rule = aws_cloudwatch_event_rule.x.name`) and this
 * estate's literal-plus-comment style (`volume_id = "vol-…" #
 * aws_ebs_volume.x`), while a human comment like `# vpc-note` matches nothing.
 *
 * Instance level: a child entry rolls under the ONE P instance it references.
 * No referenced parent in the baseline, or more than one → the entry stays at
 * the top level in its own type group, flagged, never dropped.
 *
 * Everything here is pure and synchronous over already-loaded data — the
 * callers fetch the block corpus (blockSource.allBlockSources()) and pass it
 * in, so the rules are unit-testable without the app shell.
 */

/**
 * Every `type.name` traversal token in a block's source. Maximal-munch: the
 * name segment consumes the whole identifier, so `aws_lb.app` inside
 * `aws_lb.app_https_443` is never produced (the same no-substring guarantee
 * dependents.ts gets from its lookahead). The lookbehind rejects a preceding
 * identifier char or `.`, so `module.m.aws_x.y` and `data.aws_x.y` never
 * yield the managed-resource form `aws_x.y`. Callers filter by set
 * membership against real inventory addresses, so extra non-address tokens
 * (`amazonaws.com`) are harmless.
 */
const ADDRESS_TOKEN = /(?<![\w.])[a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_-]*(?![\w-])/g;

export function extractAddressTokens(source: string): Set<string> {
  return new Set(source.match(ADDRESS_TOKEN) ?? []);
}

/** The Terraform NAME segment of an address (`aws_s3_bucket.logs` → `logs`). */
function tfName(address: string): string {
  const i = address.indexOf('.');
  return i === -1 ? address : address.slice(i + 1);
}

/**
 * The child-type → parent-type verdicts for one service page (the two-arm
 * rule above). Types with no instances get no verdict — there is no evidence
 * to roll them up, and an empty group renders the same either way.
 */
export function childTypeVerdicts(
  types: string[],
  resources: InventoryResource[],
  blocks: Record<string, BlockSource>,
): Map<string, string> {
  const pageTypes = new Set(types);
  const byType = new Map<string, InventoryResource[]>();
  for (const t of types) byType.set(t, []);
  for (const r of resources) {
    if (pageTypes.has(r.resourceType)) byType.get(r.resourceType)!.push(r);
  }
  const addressesOf = new Map<string, Set<string>>();
  for (const t of types) addressesOf.set(t, new Set(byType.get(t)!.map((r) => r.address)));

  const tokensCache = new Map<string, Set<string>>();
  const tokensOf = (address: string): Set<string> => {
    let tokens = tokensCache.get(address);
    if (!tokens) {
      tokens = extractAddressTokens(blocks[address]?.source ?? '');
      tokensCache.set(address, tokens);
    }
    return tokens;
  };
  const referencesType = (c: InventoryResource, parentType: string): boolean => {
    const parents = addressesOf.get(parentType)!;
    for (const token of tokensOf(c.address)) if (parents.has(token)) return true;
    return false;
  };

  const verdicts = new Map<string, string>();

  // Arm 1 — provider naming (longest referenced prefix parent wins). Strict
  // prefixes cannot cycle: a child type is always strictly longer than its
  // parent type.
  for (const c of types) {
    const instances = byType.get(c)!;
    if (instances.length === 0) continue;
    const prefixParents = types
      .filter((p) => p !== c && c.startsWith(p + '_'))
      .sort((a, b) => b.length - a.length);
    for (const p of prefixParents) {
      if (instances.some((inst) => referencesType(inst, p))) {
        verdicts.set(c, p);
        break;
      }
    }
  }

  // Arm 2 — importer naming, for types arm 1 left alone.
  for (const c of types) {
    if (verdicts.has(c)) continue;
    const instances = byType.get(c)!;
    if (instances.length === 0) continue;
    const qualifying: string[] = [];
    for (const p of types) {
      if (p === c) continue;
      if (!instances.every((inst) => referencesType(inst, p))) continue;
      const parentAddresses = addressesOf.get(p)!;
      const nameMatch = instances.some((inst) => {
        for (const token of tokensOf(inst.address)) {
          if (parentAddresses.has(token) && tfName(token) === tfName(inst.address)) return true;
        }
        return false;
      });
      if (nameMatch) qualifying.push(p);
    }
    if (qualifying.length === 1) verdicts.set(c, qualifying[0]!);
  }

  // A verdict chain must stay a DAG (render walks it). Arm-1 edges cannot
  // cycle; drop any arm-2 edge that closes a loop.
  for (const [c] of verdicts) {
    const seen = new Set<string>([c]);
    let cur = verdicts.get(c);
    while (cur !== undefined) {
      if (seen.has(cur)) {
        verdicts.delete(c);
        break;
      }
      seen.add(cur);
      cur = verdicts.get(cur);
    }
  }

  return verdicts;
}

/** Why a child-type entry is listed at the top level instead of rolled up. */
export type OrphanReason = 'no-parent' | 'many-parents';

export interface FamilyRow {
  resource: InventoryResource;
  /** Everything rolled up under this row — direct children first, then
   * theirs (a load balancer row carries its listeners AND their rules). */
  children: InventoryResource[];
  /** Present only on a child-type entry that could not be joined. */
  orphan?: OrphanReason;
}

export interface FamilyGroup {
  resourceType: string;
  /** True when this type rolls under a parent — the group then holds ONLY
   * the entries that could not be joined (and is omitted when none). */
  childType: boolean;
  rows: FamilyRow[];
}

export interface ResourceFamilies {
  groups: FamilyGroup[];
  /** Parent address → its DIRECT children (the detail page's sections). */
  childrenOf: Map<string, InventoryResource[]>;
  /** Child address → the parent resource it rolls under. */
  parentOf: Map<string, InventoryResource>;
  /** Child-type → parent-type verdicts (for labels). */
  childTypes: Map<string, string>;
  /** Entries not listed at the top level because they live under a parent. */
  rolledUpCount: number;
}

/**
 * The whole page model: top-level groups in the manifest's type order (child
 * types surface only their unjoined entries), plus the parent/child indexes
 * the rows and the detail page render from.
 */
export function buildResourceFamilies(
  types: string[],
  resources: InventoryResource[],
  blocks: Record<string, BlockSource>,
): ResourceFamilies {
  const pageTypes = new Set(types);
  const byType = new Map<string, InventoryResource[]>();
  for (const t of types) byType.set(t, []);
  const byAddress = new Map<string, InventoryResource>();
  for (const r of resources) {
    if (!pageTypes.has(r.resourceType)) continue;
    byType.get(r.resourceType)!.push(r);
    byAddress.set(r.address, r);
  }

  const childTypes = childTypeVerdicts(types, resources, blocks);

  const childrenOf = new Map<string, InventoryResource[]>();
  const parentOf = new Map<string, InventoryResource>();
  const orphanReason = new Map<string, OrphanReason>();

  for (const [childType, parentType] of childTypes) {
    const parentAddresses = new Set(byType.get(parentType)!.map((r) => r.address));
    for (const c of byType.get(childType)!) {
      const tokens = extractAddressTokens(blocks[c.address]?.source ?? '');
      const referenced = [...tokens].filter((t) => parentAddresses.has(t));
      if (referenced.length === 1) {
        const parent = byAddress.get(referenced[0]!)!;
        parentOf.set(c.address, parent);
        const siblings = childrenOf.get(parent.address);
        if (siblings) siblings.push(c);
        else childrenOf.set(parent.address, [c]);
      } else {
        orphanReason.set(c.address, referenced.length === 0 ? 'no-parent' : 'many-parents');
      }
    }
  }

  /** Depth-first rollup: each direct child, then everything under it. The
   * seen-set is belt-and-braces — verdicts are already a DAG. */
  const descendants = (address: string, seen: Set<string>): InventoryResource[] => {
    const direct = childrenOf.get(address) ?? [];
    const out: InventoryResource[] = [];
    for (const child of direct) {
      if (seen.has(child.address)) continue;
      seen.add(child.address);
      out.push(child, ...descendants(child.address, seen));
    }
    return out;
  };

  const groups: FamilyGroup[] = [];
  for (const t of types) {
    const instances = byType.get(t)!;
    if (!childTypes.has(t)) {
      groups.push({
        resourceType: t,
        childType: false,
        rows: instances.map((r) => ({
          resource: r,
          children: descendants(r.address, new Set([r.address])),
        })),
      });
      continue;
    }
    const orphans = instances.filter((r) => orphanReason.has(r.address));
    if (orphans.length === 0) continue;
    groups.push({
      resourceType: t,
      childType: true,
      rows: orphans.map((r) => ({
        resource: r,
        children: descendants(r.address, new Set([r.address])),
        orphan: orphanReason.get(r.address),
      })),
    });
  }

  return { groups, childrenOf, parentOf, childTypes, rolledUpCount: parentOf.size };
}

/**
 * The operator label for a child type, shortened inside its parent's context:
 * aws_s3_bucket_versioning under aws_s3_bucket reads "Versioning";
 * aws_volume_attachment (no shared prefix) reads "Volume attachment".
 * humanizeAttr keeps acronyms right and the result snake_case-free.
 */
export function childTypeLabel(childType: string, parentType?: string): string {
  if (parentType !== undefined && childType.startsWith(parentType + '_')) {
    return humanizeAttr(childType.slice(parentType.length + 1));
  }
  return humanizeAttr(stripProviderPrefix(childType));
}

export interface ChildSummaryEntry {
  resourceType: string;
  label: string;
  count: number;
}

export interface ChildGroup {
  resourceType: string;
  label: string;
  children: InventoryResource[];
}

/** Direct children grouped per type with their in-context labels — the detail
 * page's "attached configuration" sections. First-seen order. */
export function groupChildren(children: InventoryResource[], parentType: string): ChildGroup[] {
  const groups: ChildGroup[] = [];
  const byType = new Map<string, ChildGroup>();
  for (const c of children) {
    let group = byType.get(c.resourceType);
    if (!group) {
      group = {
        resourceType: c.resourceType,
        label: childTypeLabel(c.resourceType, parentType),
        children: [],
      };
      byType.set(c.resourceType, group);
      groups.push(group);
    }
    group.children.push(c);
  }
  return groups;
}

/** Rolled-up children aggregated per type, for the row's one-line summary
 * ("Versioning · Policy · Public access block"). First-seen order. */
export function summarizeChildren(
  children: InventoryResource[],
  parentType: string,
): ChildSummaryEntry[] {
  const entries: ChildSummaryEntry[] = [];
  const byType = new Map<string, ChildSummaryEntry>();
  for (const c of children) {
    const existing = byType.get(c.resourceType);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const entry = {
      resourceType: c.resourceType,
      label: childTypeLabel(c.resourceType, parentType),
      count: 1,
    };
    byType.set(c.resourceType, entry);
    entries.push(entry);
  }
  return entries;
}
