import type { Inventory, ManifestOperation } from '@/types';
import { redactHcl } from '@/lib/redact';
import { renderHclSkeleton, isAppendOp, renderAppendDelta } from '@/lib/hclSkeleton';

function localName(address: string): string {
  return address.split('.')[1] ?? 'target';
}

/** Attribute names to treat as sensitive for this operation (params flagged
 * `sensitive` in the manifest), so their values are masked in the rendered diff. */
function sensitiveAttrsOf(op: ManifestOperation): string[] {
  return op.params
    .filter((p) => p.sensitive)
    .map((p) => p.name.replace(/^new_/, '').replace(/^target_/, ''))
    .concat(op.params.filter((p) => p.sensitive).map((p) => p.name));
}

/**
 * A deterministic, human-readable MOCK of the Terraform diff catalogctl would
 * emit. This is what the reviewer sees alongside the plain-English summary; the
 * real codemod output swaps in behind this exact function later.
 */
export function generateDiff(
  op: ManifestOperation,
  values: Record<string, unknown>,
  inventory: Inventory,
): string {
  // Elaboration baselines: the artifact a reviewer binds to is the DRAFT
  // skeleton, never a fabricated one-attribute diff (the old
  // `+ purpose = "…"` was not real Terraform). Rendered here so the review
  // step, the submit-time pin, and the queue/detail fallback all carry the
  // same bytes through the existing pinnedDiff path.
  if (op.draftSkeleton) {
    return renderHclSkeleton(op, values);
  }
  // Append-class Add ops (append_block / append_foreach_entry / append_list_entry
  // / set_association_attribute) render the REAL addition — the appended block or
  // entry with the operator's picked values and references — never the whole
  // target resource and never an empty `{ }`. The fabricating
  // fallback below is kept only for in-place set_attribute / Change / Delete /
  // Move ops.
  if (isAppendOp(op)) {
    return renderAppendDelta(op, values);
  }
  // Remove-class Delete ops (remove_foreach_entry — a tag/map-entry removal)
  // render the REAL removal — the entry taken out, named by its own params —
  // never the whole target resource. Mirrors the isAppendOp branch above for
  // the opposite direction (LD-1: a tag REMOVAL was rendering as "destroy one
  // host" because this branch didn't exist and fell into the fabricating
  // fallback below, whose `- resource "<target>" { … }` open line reads as
  // terminating the whole resource).
  if (isRemoveOp(op)) {
    return renderRemoveDelta(op, values);
  }
  // Sub-block-scoped remove_block/append_block ops (a tag, an ingress rule, a
  // WAF rule, a policy attachment, a dead-letter-queue config…) render the
  // REAL sub-block change — never the whole target resource. Round 2 of the
  // review-artifact-truthfulness fix: the remove_block counterpart of the
  // isAppendOp branch above, plus the one append_block gap isAppendOp's
  // macd:"Add" gate leaves open (autoscaling-start-instance-refresh,
  // eventbridge-set-target-dead-letter-queue — both macd "Change"). Genuine
  // whole-resource create/destroy ops (ebs-delete-volume, sns-delete-topic,
  // secretsmanager-schedule-deletion, …) are NOT matched here —
  // isSubBlockOp/isWholeResourceRemoveBlockOp disambiguate by target shape,
  // mirroring lib/actionPicker.ts's isProvisionAdd (see their docstrings) —
  // and fall through to the fabricating fallback below unmodified, which is
  // exactly correct for them: the whole resource really is being destroyed.
  if (isSubBlockOp(op)) {
    return renderSubBlockDelta(op, values);
  }
  const targetParam = op.params.find((p) => p.source === 'inventory');
  const address = targetParam ? String(values[targetParam.name] ?? '') : '';
  const resource = inventory.resources.find((r) => r.address === address);
  const rt = op.target.resourceType;
  const sym = op.macd === 'Add' ? '+' : op.macd === 'Delete' ? '-' : '~';

  const lines: string[] = [
    `# ${op.terraformCapability}  (${op.macd})`,
    `${sym} resource "${rt}" "${localName(address)}" {`,
  ];

  for (const p of op.params) {
    if (p.source === 'inventory') continue;
    const v = values[p.name];
    if (v === undefined || v === '') continue;
    const attr = p.name.replace(/^new_/, '').replace(/^target_/, '');
    const current = resource?.attributes[attr];
    if (op.macd === 'Delete') {
      lines.push(`  - ${p.name} = ${JSON.stringify(v)}`);
    } else if (current !== undefined && p.name.startsWith('new_')) {
      lines.push(`  ~ ${attr} = ${JSON.stringify(current)} -> ${JSON.stringify(v)}`);
    } else {
      lines.push(`  ${sym} ${p.name} = ${JSON.stringify(v)}`);
    }
  }

  lines.push('}');
  // Never render an unredacted secret: mask secret-named/secret-shaped values
  // and anything the manifest marks sensitive before the diff reaches the UI.
  return redactHcl(lines.join('\n'), { sensitiveAttrs: sensitiveAttrsOf(op) });
}

/**
 * True for a Delete op whose diff renders as a REMOVE delta: one entry taken
 * out of an existing map/foreach attribute (a tag, a WAF IP-set CIDR, an NACL
 * rule…), never the whole target resource. The mirror of `isAppendOp` for the
 * opposite direction. A Change/Move use of the SAME codemod (dynamodb-remove-tag,
 * efs-remove-tag — both MACD "Change") already renders correctly through the
 * generic `~`-prefixed fallback below and is deliberately left alone; only the
 * genuine MACD "Delete" removals fell into the fabricating `-`-prefixed branch.
 */
export function isRemoveOp(op: ManifestOperation): boolean {
  return op.macd === 'Delete' && op.codemodOp === 'remove_foreach_entry';
}

/**
 * Render the honest delta for a `remove_foreach_entry` Delete op: the
 * specific entry being taken out, named by the op's own non-inventory
 * param(s) — a tag key, a WAF CIDR, an NACL rule number — never the whole
 * target resource (the fabricating fallback opened with
 * `- resource "<target>" { … }`, which read as *terminating the instance* for
 * what is really a metadata-only removal). Values are shown exactly as
 * submitted; nothing is invented — the inventory does not track live
 * tag/entry values, so no "current value" is ever claimed.
 */
function renderRemoveDelta(op: ManifestOperation, values: Record<string, unknown>): string {
  const targetParam = op.params.find((p) => p.source === 'inventory');
  const address = targetParam ? String(values[targetParam.name] ?? '') : '';
  const block = op.target.block ?? op.target.resourceType;
  const lines: string[] = [];
  for (const p of op.params) {
    if (p === targetParam) continue;
    const v = values[p.name];
    if (v === undefined || v === '') continue;
    lines.push(`- ${p.name} = ${JSON.stringify(v)}`);
  }
  const header = `# ${op.terraformCapability}  (${op.macd}) — removes a ${block} entry from ${address}`;
  return redactHcl([header, ...lines].join('\n'), { sensitiveAttrs: sensitiveAttrsOf(op) });
}

/**
 * True for a `remove_block` op whose target is the picked resource ITSELF —
 * the whole thing appearing/disappearing — never a block living INSIDE a
 * resource that persists. The remove-direction counterpart of the
 * create/destroy-vs-sub-block ambiguity lib/actionPicker.ts's isProvisionAdd
 * already resolves for the append direction (re-derived here, not imported,
 * so this module's classification of its OWN diff output stays
 * self-contained — diff.ts has no dependency on actionPicker.ts today).
 *
 * Two signals, cross-checked against every remove_block op in both the main
 * and bootstrap catalogs (40 + 5 ops; 33 + 4 genuinely whole-resource):
 *
 *   1. MACD alone is dispositive for every macd but "Delete": a "Change" op
 *      cannot be a whole-resource destroy by definition — Change means the
 *      resource exists both before AND after (verbShape.test.ts already
 *      lints exactly this invariant: "every non-Delete remove_block op
 *      carries a non-empty target.path"). This is what catches
 *      eventbridge-remove-target-dead-letter-queue (macd "Change").
 *   2. For the macd "Delete" case, target SHAPE decides: a non-empty
 *      target.path always descends INTO the located resource (autoscaling
 *      "tag", security-group "ingress", WAF "rule" — never resource-shaped);
 *      a target.block naming the resource type itself (the "aws_" provider
 *      prefix — sns-delete-topic, secretsmanager-schedule-deletion,
 *      secretsmanager-disable-rotation, config-remove-managed-rule) or a
 *      `.tf` file target (autoscaling-delete-scaling-policy) names the
 *      picked resource ITSELF, so it stays a genuine whole-resource destroy
 *      even though `block` happens to be set; an absent block is the plain
 *      bare-resourceType case (ebs-delete-volume, cloudwatch-delete-alarm,
 *      acm-delete-certificate, …); any OTHER block value is a plain
 *      lower-case nested-block name (policy_attachment, selection_tag,
 *      condition) — the interior of the picked resource, which persists.
 */
export function isWholeResourceRemoveBlockOp(op: ManifestOperation): boolean {
  if (op.codemodOp !== 'remove_block') return false;
  if (op.macd !== 'Delete') return false;
  if ((op.target.path?.length ?? 0) > 0) return false;
  const block = op.target.block;
  if (block === undefined) return true;
  return block.startsWith('aws_') || block.includes('.tf');
}

/**
 * True for a remove_block/append_block op that edits a SUB-BLOCK of a
 * resource that exists both before and after — never the whole resource —
 * so it needs the honest small-delta rendering (renderSubBlockDelta) instead
 * of falling into the fabricating fallback below. The remaining half of the
 * class #116 fixed for remove_foreach_entry/append_foreach_entry
 * (isRemoveOp/isAppendOp above): those two codemods can ALSO be a genuine
 * whole-resource create/destroy (an EBS snapshot append; ebs-delete-volume's
 * full teardown via remove_block), which is exactly why #116 deliberately
 * left append_block/remove_block MACD-keyed and out of isAttributeLevelOp's
 * ATTRIBUTE_LEVEL_CODEMODS set below — this function (and
 * isWholeResourceRemoveBlockOp above) is the disambiguation that work called
 * "out of scope", scoped here to the rendered diff TEXT only.
 *
 *   - remove_block: a sub-block whenever it is NOT whole-resource-shaped
 *     (isWholeResourceRemoveBlockOp above) — covers autoscaling-remove-tag,
 *     sg-remove-ingress-rule, waf-delete-rule, iam-detach-managed-policy,
 *     eventbridge-remove-target-dead-letter-queue, and their siblings
 *     (backup-remove-selection-tag, backup-remove-selection-condition).
 *   - append_block: already fully handled by isAppendOp/renderAppendDelta
 *     above for every macd:"Add" instance (including its own resource-vs-
 *     sub-block split, via hclSkeleton.ts's appendShapeKind); the only gap is
 *     a macd OTHER than "Add" (autoscaling-start-instance-refresh,
 *     eventbridge-set-target-dead-letter-queue — both "Change" today), which
 *     can never be whole-resource for the same reason macd "Change" can't
 *     for remove_block, so no target-shape check is needed here.
 */
export function isSubBlockOp(op: ManifestOperation): boolean {
  if (op.codemodOp === 'remove_block') return !isWholeResourceRemoveBlockOp(op);
  if (op.codemodOp === 'append_block') return op.macd !== 'Add';
  return false;
}

/**
 * The human name of the sub-block a remove_block/append_block op edits —
 * `target.block`, else the last segment of `target.path`, else null when the
 * manifest carries neither (eventbridge-set-target-dead-letter-queue is the
 * one op in the whole catalog with no hint at all; its own
 * terraformCapability label, always rendered in the header, names it
 * instead). Never `target.resourceType` — that would just repeat the address
 * already named right after it, and read as naming the whole resource, the
 * exact fabrication this function exists to avoid.
 */
function subBlockName(op: ManifestOperation): string | null {
  return op.target.block ?? op.target.path?.[op.target.path.length - 1] ?? null;
}

/**
 * Render the honest delta for a sub-block-scoped remove_block/append_block
 * op (isSubBlockOp): the specific rule/CIDR/policy/target being removed or
 * added, named by the op's own params — never the whole target resource
 * (the fabricating fallback below opens with `- resource "<target>" { … }` /
 * `~ resource "<target>" { … }`, which reads as the WHOLE resource being
 * destroyed or redefined for what is really a scoped edit to one of its
 * sub-blocks — e.g. sg-remove-ingress-rule closing one inbound rule used to
 * read as tearing down the entire security group). Mirrors renderRemoveDelta
 * above: a header naming what's changing, then each non-inventory param as
 * one line. `-` for remove_block (the block goes away); `+` for append_block
 * (every remaining instance here carries macd "Change", not "Add" — see
 * isSubBlockOp — but attaching a new sub-block onto a resource that already
 * exists is still an addition of the block itself). Values are shown exactly
 * as submitted; nothing is invented.
 */
function renderSubBlockDelta(op: ManifestOperation, values: Record<string, unknown>): string {
  const targetParam = op.params.find((p) => p.source === 'inventory');
  const address = targetParam ? String(values[targetParam.name] ?? '') : '';
  const isRemove = op.codemodOp === 'remove_block';
  const sym = isRemove ? '-' : '+';
  const name = subBlockName(op);
  const what = name ? `the ${name} block` : 'a block';
  const preposition = isRemove ? 'from' : 'to';
  const lines: string[] = [];
  for (const p of op.params) {
    if (p === targetParam) continue;
    const v = values[p.name];
    if (v === undefined || v === '') continue;
    lines.push(`${sym} ${p.name} = ${JSON.stringify(v)}`);
  }
  const verb = isRemove ? 'removes' : 'adds';
  const header = `# ${op.terraformCapability}  (${op.macd}) — ${verb} ${what} ${preposition} ${address}`;
  return redactHcl([header, ...lines].join('\n'), { sensitiveAttrs: sensitiveAttrsOf(op) });
}

/**
 * Codemods that always mutate ONE existing attribute/entry on a resource that
 * already exists before AND after the change — never a whole resource
 * appearing or disappearing — regardless of which MACD label the op happens
 * to carry (an Add/Delete "tag add"/"tag remove" is still just an update).
 * Cross-checked against every (codemodOp, macd) pair actually used across the
 * catalog: `set_attribute` / `set_attributes` / `swap_child_block` are always
 * MACD "Change" already (this changes nothing for them); `append_foreach_entry`
 * / `append_list_entry` (Add) and `remove_foreach_entry` / `remove_list_entry`
 * (Delete) are the ones that were mis-keyed off MACD alone (OP-3 / LD-1);
 * `set_association_attribute` carries exactly one MACD "Add" instance
 * (acm-attach-sni-certificate) that had the same bug.
 *
 * `append_block` / `remove_block` are deliberately EXCLUDED: depending on the
 * op they can be a genuine whole-resource create/destroy (an EBS snapshot, a
 * full teardown via `ebs-delete-volume`) as well as a sub-block edit, and
 * disambiguating those two shapes is out of scope here — those codemods keep
 * the MACD-keyed behavior they already had. `create_resource` /
 * `instantiate_module` (always whole-resource Add) are excluded for the same
 * reason: they are already correctly "create" and must stay that way.
 * (Round 2 of review-artifact-truthfulness DOES disambiguate these two shapes
 * for the rendered diff TEXT — see isSubBlockOp / isWholeResourceRemoveBlockOp
 * below — but leaves this Set and the plan-action classifier it feeds
 * untouched: mockPlanSummaryFor lives in lib/api.ts, out of that round's
 * write-set, so the "delete"/"create" plan-action label for a sub-block
 * remove_block/append_block op is a follow-up, not fixed here.)
 *
 * Used by `mockPlanSummaryFor` (lib/api.ts) to key the plan action off
 * whole-resource-vs-attribute instead of MACD alone.
 */
const ATTRIBUTE_LEVEL_CODEMODS = new Set<string>([
  'append_foreach_entry',
  'remove_foreach_entry',
  'append_list_entry',
  'remove_list_entry',
  'set_attribute',
  'set_attributes',
  'set_association_attribute',
  'moved_block',
  'swap_child_block',
]);

/** True when `op` can never create or destroy a whole resource — see {@link ATTRIBUTE_LEVEL_CODEMODS}. */
export function isAttributeLevelOp(op: ManifestOperation): boolean {
  return ATTRIBUTE_LEVEL_CODEMODS.has(op.codemodOp);
}

/** One-line plain-English summary of what a request changes. */
export function plainSummary(
  op: ManifestOperation,
  values: Record<string, unknown>,
  inventory: Inventory,
): string {
  const targetParam = op.params.find((p) => p.source === 'inventory');
  const address = targetParam ? String(values[targetParam.name] ?? '') : '';
  const resource = inventory.resources.find((r) => r.address === address);
  const name = resource?.name ?? address ?? 'a new resource';
  const verb =
    op.macd === 'Add'
      ? 'Add'
      : op.macd === 'Delete'
        ? 'Delete'
        : op.macd === 'Move'
          ? 'Move'
          : 'Change';
  return `${verb}: ${op.title.toLowerCase()} on ${name}.`;
}
