import { defaultFilter } from 'cmdk';
import type { InventoryResource, ManifestOperation, OpGroup } from '@/types';
import { OP_GROUPS } from '@/types/manifestSchema';

/**
 * Pure data layer for the scoped action picker (the ≤5-pinned
 * ResourceRow menu + the cmdk picker it opens onto "All actions… (N)").
 * Nothing here touches the DOM; ActionPicker.tsx and ResourceRow.tsx are thin
 * consumers so the grouping/pinning/href rules are testable without mounting
 * either component (this app has no jsdom/RTL — see src/test/setup.ts).
 */

/** Display labels for the 8 fixed groups, in their canonical order. */
export const GROUP_LABELS: Record<OpGroup, string> = {
  'scale-performance': 'Scale & performance',
  'availability-lifecycle': 'Availability & lifecycle',
  'connectivity-access': 'Connectivity & access',
  'protection-backup': 'Protection & backup',
  'monitoring-alarms': 'Monitoring & alarms',
  'tags-naming': 'Tags & naming',
  'danger-zone': 'Danger zone',
  create: 'Create',
};

/**
 * The 7 Change/Delete/Move groups (everything but "create"), in the fixed
 * display order. "create" is macd:"Add"-exclusive (lint-enforced in
 * opTaxonomy.test.ts) — its provision ops are served by a service's "Add new"
 * grid, never per-resource. The resource picker DOES surface a "create" bucket,
 * but only for the Add ops that operate on the resource (see PICKER_GROUPS /
 * isResourceScopedAdd) — provision creates never reach it.
 */
export const RESOURCE_ACTION_GROUPS: OpGroup[] = OP_GROUPS.filter((g) => g !== 'create');

/**
 * Group order for a RESOURCE's picker. "create" LEADS — the resource-scoped
 * Add ops (snapshot this volume, add an ingress rule, tag this key) are the
 * constructive actions this surface exists to make findable —
 * then the seven Change/Delete/Move groups in their fixed order.
 * A resource type rarely fills all eight; groupScopedActions/presentGroups drop
 * the empty ones, so a set with no scoped Add (e.g. a pure Change/Delete/Move
 * type) shows no "create" bucket and reads exactly as it did.
 */
export const PICKER_GROUPS: OpGroup[] = ['create', ...RESOURCE_ACTION_GROUPS];

/**
 * A NON-Add op (Change/Delete/Move) always belongs on its target resource's
 * scoped menu/picker. Equivalent to `op.group !== 'create'` (the two are
 * lint-proven identical in opTaxonomy.test.ts). The complementary question —
 * WHICH Add ops also belong on a resource's menu — is answered by
 * isResourceScopedAdd below; the two are combined in ServiceConsole.actionsFor.
 * Kept a pure `macd` predicate (and its contract unchanged: false for every
 * Add) so its call sites and tests are undisturbed by the Add-scoping work.
 */
export function isScopedAction(op: Pick<ManifestOperation, 'macd'>): boolean {
  return op.macd !== 'Add';
}

/**
 * The "Add new" grid split: an Add op PROVISIONS when it
 * stands up a new top-level resource; it ATTACHES/ANNOTATES when it writes
 * into a resource that already exists (tag entries, rules, list entries,
 * associations). Before the split, "Add a tag to an instance" rendered
 * beside "Provision a new EC2 instance" as equal cards.
 *
 * Deterministic from the op's own codemod + target shape — no display table:
 *   - instantiate_module      → a new resource, always.
 *   - create_resource         → a new resource, always (the resource-create
 *                               baselines that the verb now AUTHORS at EOF of the
 *                               service file; the provision-class successor to
 *                               instantiate_module for these ops).
 *   - append_block            → new only when the synthesized block IS a
 *                               resource: no target.block (the block is the
 *                               target type itself), a block naming a
 *                               resource type (`aws_…` — the snapshot ops'
 *                               sibling-resource shape), or a `.tf` file
 *                               target (new top-level blocks). A lower-case
 *                               nested block (ingress, rule, route…) writes
 *                               into an existing resource.
 *   - append_foreach_entry    → new only with no target.block (each entry is
 *                               its own resource instance — the mount-target
 *                               shape); a named block (tags, static_routes…)
 *                               is an entry in an existing resource's map.
 *   - everything else (list entries, association/attribute sets) annotates.
 */
export function isProvisionAdd(
  op: Pick<ManifestOperation, 'macd' | 'codemodOp' | 'target'>,
): boolean {
  if (op.macd !== 'Add') return false;
  if (op.codemodOp === 'instantiate_module' || op.codemodOp === 'create_resource') return true;
  const block = op.target.block;
  if (op.codemodOp === 'append_block') {
    return block === undefined || block.startsWith('aws_') || block.includes('.tf');
  }
  if (op.codemodOp === 'append_foreach_entry') return block === undefined;
  return false;
}

/**
 * Whether an Add op OPERATES ON a specific existing resource — and so belongs
 * in that resource's Actions menu, pre-scoped to it ("snapshot this disk",
 * "add a firewall rule", "attach a
 * certificate" were unfindable because every Add was excluded from the
 * resource menu). The complement of isScopedAction for macd:"Add" ops; the two
 * are OR-ed in ServiceConsole.actionsFor. Provision creates are deliberately
 * NOT resource-scoped — they stand up a brand-new top-level resource and stay
 * in the service-level "Add new" grid (the Provision/Annotate split).
 *
 * The split (isProvisionAdd) alone is too coarse for this decision: it flags
 * the sibling-resource creates (the snapshot pattern) as "provision" even
 * though they anchor on an existing resource. So:
 *   - Every attach/annotate Add (!isProvisionAdd) is resource-scoped: it writes
 *     a tag, a rule, a list entry, a nested block, or an association INTO an
 *     existing resource of op.target.resourceType (sg add-rule → each SG;
 *     cert/listener tag → each listener; lifecycle rule → each bucket-config).
 *   - PLUS the sibling-resource creates: an append_block that synthesizes a NEW
 *     resource block of a DIFFERENT aws_ type, anchored on the existing
 *     op.target.resourceType it references — snapshot a volume/instance, enable
 *     replication on a bucket, add a studio user-profile to a domain. Here
 *     target.resourceType is the operated-on resource, not the created type.
 *   - A block whose type EQUALS op.target.resourceType (sns subscription, secret
 *     rotation) provisions a fresh instance of the SAME type, so it is NOT
 *     resource-scoped; nor is any create_resource / instantiate_module, any
 *     block-less/`.tf` append_block, or a per-entry mount-target create.
 *
 * Pre-fill is automatic once an op reaches actionsFor: actionHref appends
 * `?target=<address>`, and RequestForm.seedValues writes that into the op's
 * source:"inventory" param (every op here carries one — the operated-on
 * resource) — the SAME path the scoped Change ops already use.
 */
export function isResourceScopedAdd(
  op: Pick<ManifestOperation, 'macd' | 'codemodOp' | 'target'>,
): boolean {
  if (op.macd !== 'Add') return false;
  if (!isProvisionAdd(op)) return true;
  if (op.codemodOp === 'append_block') {
    const block = op.target.block;
    if (block !== undefined && block.startsWith('aws_')) {
      // The synthesized block may carry a `.<name>` label (e.g.
      // "aws_secretsmanager_secret_rotation.<name>"); the resource TYPE is the
      // leading segment. Anchored on a DIFFERENT existing type ⇒ resource-scoped.
      const blockType = block.split('.')[0];
      return blockType !== op.target.resourceType;
    }
  }
  return false;
}

export interface OpGroupBucket {
  group: OpGroup;
  label: string;
  ops: ManifestOperation[];
}

/**
 * Bucket a resource type's scoped ops into the fixed PICKER_GROUPS order,
 * dropping groups with nothing in them (a resource type rarely has ops in all
 * 8 — most have a handful). The "create" bucket holds this resource's
 * resource-scoped Add ops (isResourceScopedAdd); the seven others hold its
 * Change/Delete/Move ops. Danger-zone ops (Delete, Move, destructive
 * forcesReplace Change) are bucketed exactly like every other group — findable
 * under their own header, never specially hidden or reordered — the "never
 * one-click" rule is enforced upstream by pinnedActions() below, not by
 * omission here.
 */
export function groupScopedActions(ops: ManifestOperation[]): OpGroupBucket[] {
  const buckets: OpGroupBucket[] = [];
  for (const group of PICKER_GROUPS) {
    const inGroup = ops.filter((op) => op.group === group);
    if (inGroup.length > 0) buckets.push({ group, label: GROUP_LABELS[group], ops: inGroup });
  }
  return buckets;
}

/**
 * Groups actually present among a resource type's ops, in fixed PICKER_GROUPS
 * order. Drives the picker's empty-search state ("teaches the taxonomy"):
 * only categories that exist for THIS resource are listed
 * (including "create" when it carries resource-scoped Add ops), never the full
 * global 8 when most would be empty shells.
 */
export function presentGroups(ops: ManifestOperation[]): OpGroup[] {
  const present = new Set(ops.map((op) => op.group));
  return PICKER_GROUPS.filter((g) => present.has(g));
}

/**
 * The ≤5 "Common" shortlist for a resource type's Actions menu,
 * ordered by pinned rank ascending. `pinned` is already lint-enforced
 * (opTaxonomy.test.ts) to be an integer in [1,5], at most 5 per resourceType,
 * and never present on Delete/Move/engineer_only/forcesReplace ops — the
 * slice(0, 5) here is a defensive mirror of that invariant, not its primary
 * enforcement, so the UI can never one-click a dangerous op even if the data
 * layer's guarantee were ever violated.
 */
export function pinnedActions(ops: ManifestOperation[]): ManifestOperation[] {
  return ops
    .filter((op) => op.pinned !== undefined)
    .sort((a, b) => (a.pinned ?? 0) - (b.pinned ?? 0))
    .slice(0, 5);
}

/**
 * How many items ResourceRow's Actions menu renders when there is at least
 * one scoped op: the pinned shortlist (≤5) plus exactly one "All actions…
 * (N)" item — replacement for the old flat, unbounded list
 * (42 items for aws_dlm_lifecycle_policy). Always ≤6 by construction, since
 * pinnedActions() is capped at 5. Meaningful only when ops.length > 0 —
 * ResourceRow renders a plain "Read-only" label instead of a menu when there
 * are none, never an empty menu.
 */
export function menuItemCount(ops: ManifestOperation[]): number {
  return pinnedActions(ops).length + 1;
}

/**
 * The request-form URL for one op on one resource — `?target=<address>` is
 * the same shape RequestForm already reads (seedValues). One function so the
 * pinned ResourceRow shortlist and the scoped picker's Enter-to-navigate
 * compute the identical href/navigate target ("a pinned op
 * navigates identically to before").
 */
export function actionHref(
  serviceSlug: string,
  op: Pick<ManifestOperation, 'id'>,
  resource: Pick<InventoryResource, 'address'>,
): string {
  return `/services/${serviceSlug}/${op.id}?target=${encodeURIComponent(resource.address)}`;
}

/* ── Search filtering (LD-3) ──────────────────────────────────────────────
 * cmdk's default scoring concatenates an item's `value` + every `keywords`
 * entry into ONE string and scores that whole blob against the query
 * (the `command-score` library it ships as `defaultFilter`). ActionPicker
 * fed it `[title, description, id, summary?]` — with a resource type's full
 * prose description (and optional summary) folded in alongside the short
 * title, a real multi-word query barely narrows the list: a sufficiently
 * long paragraph tends to contain SOME scattered subsequence match for
 * common words, so most of a resource type's ~40 ops stay "matched" (just
 * weakly), and an unrelated op whose description happens to echo more of the
 * query can outrank the op whose TITLE is the actual answer.
 *
 * filterAction scores each field independently — still via cmdk's own
 * `defaultFilter`, so single-character/prefix behavior is unchanged — then
 * weights a title or id match at full strength and a description/summary
 * match at a fraction of it, and keeps the best of the four. Calibrated
 * against the real EC2 instance action set (~39 ops): a description/summary
 * match at MATCH_THRESHOLD or above is a genuine word/phrase hit; below it
 * is background noise from a query's letters merely occurring somewhere in
 * a paragraph (cross-title contamination across every op's own title as a
 * query is ~0 at this floor). A query with no real relationship to any
 * field scores 0 on all four and stays 0 — cmdk's "No actions match" empty
 * state, which already worked, is unaffected.
 */
const TITLE_WEIGHT = 1;
const ID_WEIGHT = 0.85;
const DESCRIPTION_WEIGHT = 0.35;
const SUMMARY_WEIGHT = 0.35;
/** Below this, a description/summary's fuzzy echo of the query is treated as
 * noise, not a match — see the module note above. */
const MATCH_THRESHOLD = 0.15;

/**
 * ActionPicker's cmdk `filter` prop. `itemId` is cmdk's own `value` (the
 * picker sets `Command.Item value={op.id}`); `keywords` is always
 * `[op.title, op.description, op.summary?]`, in that fixed order —
 * ActionPicker.tsx builds it, this function's positional destructure
 * depends on it, and actionPicker.test.ts pins the contract.
 */
export function filterAction(itemId: string, search: string, keywords: string[] = []): number {
  if (!search) return 1;
  const [title = '', description = '', summary = ''] = keywords;
  const score = Math.max(
    defaultFilter(title, search) * TITLE_WEIGHT,
    defaultFilter(itemId, search) * ID_WEIGHT,
    description ? defaultFilter(description, search) * DESCRIPTION_WEIGHT : 0,
    summary ? defaultFilter(summary, search) * SUMMARY_WEIGHT : 0,
  );
  return score >= MATCH_THRESHOLD ? score : 0;
}
